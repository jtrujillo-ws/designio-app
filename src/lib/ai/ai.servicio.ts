import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { DimensionesEvidenciaSchema, ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import { bloquearReto } from '@/lib/metodo/metodo.servicio';
import { evaluarCapacidadAI, LIMITE_PROPUESTAS_DIA } from './ai.degradacion';
import {
  fidelidadDeCitas,
  MAX_MATERIAL,
  PROMPT_VERSION,
  promptCriterios,
  promptExtraccion,
  SISTEMA_CRITERIOS,
  SISTEMA_EXTRACCION,
} from './ai.prompts';
import {
  ContenidoCriterioSchema,
  ContenidoExtraccionSchema,
  DESTINO_DE_CAPACIDAD,
  parsearContenido,
  type CapacidadActiva,
  type ContenidoCriterio,
  type ContenidoExtraccion,
  type ContenidoPropuesta,
  type GenerarPropuestas,
  type OrigenKey,
  type PanelPropuestas,
  type PropuestaEnPanel,
  type RevisarPropuesta,
} from './ai.schemas';
import { credencialesAI, generarConProveedor } from './proveedor.server';

/**
 * Pipeline único PropuestaAI (SPEC-08, ADR-0012/I4). La AI **propone**; el objeto real
 * del dominio nace solo cuando un humano acepta, en la MISMA transacción y firmado por
 * él (SYS-19). Capa 1: RLS —atribución en la política, transición exigida por WITH CHECK,
 * decidida = inmutable, materialización verificada por constraint diferido—. Capa 2: este
 * módulo (estado de la cuenta, rol curador, presupuesto, validación del contenido).
 *
 * Degradación segura (SYS-21): ninguna función de aquí lanza por culpa del proveedor. Sin
 * credencial, con el presupuesto agotado o con el proveedor caído, generar devuelve un
 * error de dominio con su motivo y **todo lo demás sigue en pie** — listar y revisar
 * propuestas ya existentes funciona con la AI apagada, y la curaduría manual de la
 * bandeja y la definición manual de criterios nunca dependieron de ella.
 */

export class ErrorAI extends Error {}

const PAGINA_PENDIENTES = 100;
const DECIDIDAS_RECIENTES = 50;
/** Cuántos criterios se le piden a C0 de una vez: revisión por elemento, lote pequeño. */
const CRITERIOS_POR_GENERACION = 3;

/** Capa 2: re-check explícito del rol curador (la política RLS es la capa 1). Los mismos
 * que curan la bandeja (RF-03.4) piden y revisan propuestas; `agente-ai` no aparece por
 * ningún lado — no es un actor que cure ni apruebe (SYS-18). */
async function rolCurador(tx: TransactionSql, actorId: string, workspaceId: string): Promise<void> {
  const [fila] = await tx`select workspace_role(${actorId}, ${workspaceId}) as rol`;
  const rol = (fila?.rol ?? null) as string | null;
  if (!rol || !(ROLES_CURADORES as readonly string[]).includes(rol)) {
    throw new ErrorAI('Solo lead-boutique o diseñador pueden pedir y revisar propuestas AI');
  }
}

/** Presupuesto AI del workspace (RF-08.5): propuestas generadas hoy. Es un corte SUAVE
 * y por eso se cuenta lo PERSISTIDO —una llamada fallida no consume presupuesto— con el
 * día del servidor, que es también el que usa el reporte de costos. */
async function propuestasDeHoy(tx: TransactionSql, workspaceId: string): Promise<number> {
  const [fila] = await tx`select count(*)::int as n from propuesta_ai
    where workspace_id = ${workspaceId} and creado_en >= date_trunc('day', now())`;
  return (fila?.n ?? 0) as number;
}

async function estadoCapacidad(tx: TransactionSql, workspaceId: string) {
  const { keyWorkspace, keyEntorno } = credencialesAI();
  return evaluarCapacidadAI({
    keyWorkspace,
    keyEntorno,
    propuestasHoy: await propuestasDeHoy(tx, workspaceId),
    limiteDiario: LIMITE_PROPUESTAS_DIA,
  });
}

function filaDePanel(f: Record<string, unknown>): PropuestaEnPanel {
  const contenido = f.contenido as ContenidoPropuesta;
  const original = f.contenido_original as ContenidoPropuesta;
  const material = (f.material as string | null) ?? '';
  const citas = 'citas' in contenido ? contenido.citas : [];
  return {
    id: f.id as string,
    capacidad: f.capacidad as PropuestaEnPanel['capacidad'],
    destino: f.destino as PropuestaEnPanel['destino'],
    estado: f.estado as PropuestaEnPanel['estado'],
    esSimulacion: f.es_simulacion as boolean,
    confianza: f.confianza === null ? null : Number(f.confianza),
    contenido,
    // El original solo viaja cuando difiere: una corrección nunca oculta lo que la AI
    // había dicho de verdad (SYS-17).
    contenidoOriginal: JSON.stringify(contenido) === JSON.stringify(original) ? null : original,
    citas: citas.map((c) => ({
      fragmento: c.fragmento,
      localizacion: c.localizacion,
      fiel: fidelidadDeCitas(material, [c]).fieles === 1,
    })),
    anclaTitulo: (f.ancla_titulo as string | null) ?? '',
    anclaId: ((f.item_id ?? f.reto_id) as string | null) ?? '',
    anclaDisponible: (f.ancla_disponible as boolean | null) ?? true,
    modelo: f.modelo as string,
    promptVersion: f.prompt_version as string,
    origenKey: f.origen_key as OrigenKey,
    alcanceResumen: f.alcance_resumen as string,
    latenciaMs: f.latencia_ms === null ? null : Number(f.latencia_ms),
    creadoEn: (f.creado_en as Date).toISOString(),
    revisadaEn: f.revisada_en ? (f.revisada_en as Date).toISOString() : null,
  };
}

/**
 * Proyección del panel de revisión. El `material` que viaja para medir la fidelidad de
 * las citas está acotado EXACTAMENTE al que entró al prompt (MAX_MATERIAL): medir contra
 * más texto del que el modelo vio daría un grounding falsamente bueno.
 */
export async function panelPropuestas(
  actorId: string,
  workspaceId: string,
): Promise<PanelPropuestas> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const ai = await estadoCapacidad(tx, workspaceId);

    const filas = await tx`
      select p.id, p.capacidad, p.destino, p.estado, p.es_simulacion, p.confianza,
             p.contenido, p.contenido_original, p.item_id, p.reto_id,
             p.modelo, p.prompt_version, p.origen_key, p.alcance_resumen, p.latencia_ms,
             p.creado_en, p.revisada_en,
             coalesce(i.titulo, r.codigo || ' ' || r.titulo) as ancla_titulo,
             coalesce(i.estado = 'pendiente', true) as ancla_disponible,
             left(coalesce(i.contenido, ''), ${MAX_MATERIAL}) as material
      from propuesta_ai p
      left join item_importacion i
        on i.id = p.item_id and i.workspace_id = p.workspace_id
      left join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id
      where p.workspace_id = ${workspaceId}
      order by p.creado_en desc, p.id desc
      limit ${PAGINA_PENDIENTES + DECIDIDAS_RECIENTES}`;

    const todas = filas.map(filaDePanel);

    // Anclas ofrecibles a la generación. Un item con propuesta pendiente no se vuelve a
    // ofrecer: pedir otra quemaría presupuesto sobre algo que ya espera revisión humana.
    const items = await tx`
      select i.id, i.titulo from item_importacion i
      where i.workspace_id = ${workspaceId} and i.estado = 'pendiente'
        and not exists (select 1 from propuesta_ai p
          where p.item_id = i.id and p.workspace_id = i.workspace_id and p.estado = 'propuesta')
      order by i.creado_en desc
      limit 50`;
    // Retos con criterios aún abiertos: con un G0 aprobado están congelados (SYS-22) y
    // proponer criterios para ellos sería ofrecer una acción que la base va a rechazar.
    const retos = await tx`
      select r.id, r.codigo || ' ' || r.titulo as titulo from reto r
      where r.workspace_id = ${workspaceId} and r.estado in ('candidato', 'activo')
        and not exists (select 1 from gate_instancia g
          join proyecto pr on pr.id = g.proyecto_id and pr.workspace_id = g.workspace_id
          where pr.reto_id = r.id and pr.workspace_id = r.workspace_id
            and g.numero = 0 and g.estado = 'aprobado')
      order by r.codigo
      limit 50`;

    return {
      workspaceId,
      ai: {
        disponible: ai.disponible,
        motivo: ai.motivo,
        modelo: ai.modelo,
        propuestasHoy: ai.propuestasHoy,
        limiteDiario: ai.limiteDiario,
      },
      pendientes: todas.filter((p) => p.estado === 'propuesta').slice(0, PAGINA_PENDIENTES),
      decididas: todas.filter((p) => p.estado !== 'propuesta').slice(0, DECIDIDAS_RECIENTES),
      itemsPendientes: items.map((i) => ({ id: i.id as string, titulo: i.titulo as string })),
      retosAbiertos: retos.map((r) => ({ id: r.id as string, titulo: r.titulo as string })),
    };
  });
}

type Alcance = {
  sistema: string;
  usuario: string;
  alcanceResumen: string;
  origenKey: OrigenKey;
  key: string;
};

/** Lee el alcance delimitado del ancla y comprueba que la capacidad esté encendida.
 * Deliberadamente en su propia transacción, corta: la llamada al proveedor ocurre FUERA
 * de cualquier transacción — un tercero lento no puede retener una conexión de la base. */
async function prepararAlcance(
  actorId: string,
  entrada: GenerarPropuestas,
): Promise<Alcance> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId);

    const ai = await estadoCapacidad(tx, entrada.workspaceId);
    const { keyWorkspace, keyEntorno } = credencialesAI();
    if (!ai.disponible || !ai.origenKey) throw new ErrorAI(ai.motivo);
    const key = (ai.origenKey === 'workspace' ? keyWorkspace : keyEntorno)!;

    if (entrada.capacidad === 'CI') {
      const [item] = await tx`select titulo, tipo_fuente, referencia, contenido
        from item_importacion
        where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
          and estado = 'pendiente'`;
      if (!item) throw new ErrorAI('El item no existe en este workspace o ya fue curado');
      const [pendiente] = await tx`select 1 as hay from propuesta_ai
        where item_id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
          and estado = 'propuesta' limit 1`;
      if (pendiente) {
        throw new ErrorAI('Ese item ya tiene una propuesta pendiente: revísala antes de pedir otra');
      }
      const p = promptExtraccion({
        titulo: item.titulo as string,
        tipoFuente: item.tipo_fuente as string,
        referencia: item.referencia as string,
        contenido: item.contenido as string,
      });
      return {
        sistema: SISTEMA_EXTRACCION,
        usuario: p.usuario,
        alcanceResumen: p.alcanceResumen,
        origenKey: ai.origenKey,
        key,
      };
    }

    const [reto] = await tx`select codigo, titulo, descripcion, metrica_objetivo
      from reto where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
        and estado in ('candidato', 'activo')`;
    if (!reto) throw new ErrorAI('El reto no existe en este workspace o ya no admite criterios');
    // El congelado de criterios lo impone la política de criterio_exito; anticiparlo aquí
    // evita quemar presupuesto en una propuesta que nadie podría aceptar.
    const [congelado] = await tx`select 1 as hay from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      where p.reto_id = ${entrada.anclaId} and p.workspace_id = ${entrada.workspaceId}
        and g.numero = 0 and g.estado = 'aprobado' limit 1`;
    if (congelado) {
      throw new ErrorAI('El G0 de ese reto ya fue aprobado: sus criterios están congelados');
    }
    const p = promptCriterios({
      codigo: reto.codigo as string,
      titulo: reto.titulo as string,
      descripcion: reto.descripcion as string,
      metricaObjetivo: reto.metrica_objetivo as string,
      cuantos: CRITERIOS_POR_GENERACION,
    });
    return {
      sistema: SISTEMA_CRITERIOS,
      usuario: p.usuario,
      alcanceResumen: p.alcanceResumen,
      origenKey: ai.origenKey,
      key,
    };
  });
}

/** Valida la salida cruda del proveedor contra el esquema de la capacidad. Una salida
 * fuera de contrato se descarta ENTERA: media propuesta no es revisable. */
function contenidosValidos(capacidad: CapacidadActiva, datos: unknown): ContenidoPropuesta[] {
  if (capacidad === 'CI') return [ContenidoExtraccionSchema.parse(datos)];
  const lote = (datos ?? {}) as { criterios?: unknown };
  return ContenidoCriterioSchema.array().min(1).max(4).parse(lote.criterios);
}

/**
 * Genera propuestas para un ancla (RF-08.1). Nada del dominio cambia aquí: solo nacen
 * filas de `propuesta_ai` en estado `propuesta`, con su lineage completo (SYS-19).
 * Devuelve cuántas quedaron pendientes de revisión humana.
 */
export async function generarPropuestas(
  actorId: string,
  entrada: GenerarPropuestas,
): Promise<{ generadas: number }> {
  const alcance = await prepararAlcance(actorId, entrada);

  const respuesta = await generarConProveedor({
    key: alcance.key,
    capacidad: entrada.capacidad,
    sistema: alcance.sistema,
    usuario: alcance.usuario,
  });
  if (!respuesta.ok) throw new ErrorAI(respuesta.motivo);

  let contenidos: ContenidoPropuesta[];
  try {
    contenidos = contenidosValidos(entrada.capacidad, respuesta.datos);
  } catch {
    throw new ErrorAI(
      'La respuesta del proveedor AI no cumplió el esquema de la capacidad y se descartó. Todo el flujo sigue disponible a mano.',
    );
  }

  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const destino = DESTINO_DE_CAPACIDAD[entrada.capacidad];
    // UNA sentencia para el lote entero: el evento PropuestaAIGenerada de cada fila lo
    // emite el guard DENTRO de este insert, así que el rol auditado es exactamente el que
    // autorizó la escritura (mismo snapshot).
    const filas = await tx`
      insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, reto_id, contenido, contenido_original,
         modelo, prompt_version, alcance_resumen, latencia_ms, origen_key, creado_por)
      select ${entrada.workspaceId}, ${entrada.capacidad}, ${destino},
             ${entrada.capacidad === 'CI' ? entrada.anclaId : null},
             ${entrada.capacidad === 'C0' ? entrada.anclaId : null},
             c.contenido, c.contenido,
             ${respuesta.modelo}, ${PROMPT_VERSION}, ${alcance.alcanceResumen},
             ${respuesta.latenciaMs}, ${alcance.origenKey}, ${actorId}
      from jsonb_array_elements(${tx.json(contenidos)}) as c(contenido)
      returning id`;
    return { generadas: filas.length };
  });
}

/** Datos mínimos de la propuesta que se está revisando. */
type PropuestaEnRevision = {
  capacidad: CapacidadActiva;
  destino: 'evidencia' | 'criterio-exito';
  itemId: string | null;
  retoId: string | null;
  contenido: ContenidoPropuesta;
  modelo: string;
  promptVersion: string;
};

async function leerParaRevisar(
  tx: TransactionSql,
  workspaceId: string,
  propuestaId: string,
): Promise<PropuestaEnRevision> {
  const [p] = await tx`select capacidad, destino, item_id, reto_id, contenido, modelo,
      prompt_version, estado
    from propuesta_ai where id = ${propuestaId} and workspace_id = ${workspaceId}`;
  if (!p) throw new ErrorAI('La propuesta no existe en este workspace');
  if ((p.estado as string) !== 'propuesta') {
    throw new ErrorAI('Esa propuesta ya fue revisada: las decisiones son inmutables');
  }
  return {
    capacidad: p.capacidad as CapacidadActiva,
    destino: p.destino as PropuestaEnRevision['destino'],
    itemId: p.item_id as string | null,
    retoId: p.reto_id as string | null,
    contenido: p.contenido as ContenidoPropuesta,
    modelo: p.modelo as string,
    promptVersion: p.prompt_version as string,
  };
}

/**
 * Aceptar (o corregir y aceptar) una propuesta: **la materialización y el sello de la
 * propuesta ocurren en la misma transacción**, y el objeto queda firmado por quien acepta
 * — la política exige `creado_por = app_user_id()` y el constraint diferido comprueba que
 * el objeto materializado sea el del ancla y lleve esa firma (SYS-19).
 *
 * Corregir conserva siempre el original (SYS-17) y deja su propio evento; una corrección
 * idéntica al original no es una corrección y se registra como aceptación literal.
 */
export async function aceptarPropuesta(
  actorId: string,
  entrada: RevisarPropuesta,
): Promise<{ estado: 'aceptada' | 'corregida'; objetoId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId);
    const p = await leerParaRevisar(tx, entrada.workspaceId, entrada.propuestaId);

    let contenido = p.contenido;
    if (entrada.correccion) {
      try {
        contenido = parsearContenido(p.capacidad, entrada.correccion);
      } catch {
        throw new ErrorAI('La corrección no cumple el formato de la capacidad');
      }
    }
    // El destino y la forma del contenido van atados por el CHECK de la tabla y por el
    // esquema de la capacidad; el narrowing lo hace explícito para el compilador.
    const objetoId =
      p.destino === 'evidencia'
        ? await materializarEvidencia(
            tx,
            actorId,
            entrada.workspaceId,
            p,
            contenido as ContenidoExtraccion,
          )
        : await materializarCriterio(
            tx,
            actorId,
            entrada.workspaceId,
            p,
            contenido as ContenidoCriterio,
          );

    // Corregida o aceptada lo decide la BASE comparando jsonb con jsonb: normaliza claves
    // y espacios, así que un reordenamiento del round-trip por Zod no se contabiliza como
    // corrección humana (y el guard, que compara igual, no ve una contradicción).
    const [sellada] = await tx`
      update propuesta_ai
      set estado = case when contenido is distinct from ${tx.json(contenido)}::jsonb
                        then 'corregida' else 'aceptada' end,
          contenido = ${tx.json(contenido)}::jsonb,
          revisada_por = ${actorId},
          evidencia_id = ${p.destino === 'evidencia' ? objetoId : null},
          criterio_id = ${p.destino === 'criterio-exito' ? objetoId : null}
      where id = ${entrada.propuestaId} and workspace_id = ${entrada.workspaceId}
        and estado = 'propuesta'
      returning estado`;
    if (!sellada) {
      throw new ErrorAI('Esa propuesta ya fue revisada por otra persona');
    }
    return { estado: sellada.estado as 'aceptada' | 'corregida', objetoId };
  });
}

/** CI: la aceptación ES la curaduría (SYS-16). Crea fuente + evidencia con las cinco
 * dimensiones y sella el item de la bandeja con esa evidencia; si otro curador lo decidió
 * a mano mientras tanto, el update afecta 0 filas y toda la transacción se revierte. */
async function materializarEvidencia(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  p: PropuestaEnRevision,
  c: ContenidoExtraccion,
): Promise<string> {
  const [item] = await tx`select titulo, tipo_fuente, referencia from item_importacion
    where id = ${p.itemId} and workspace_id = ${workspaceId} and estado = 'pendiente'`;
  if (!item) throw new ErrorAI('El item de la bandeja ya fue curado o no existe');

  const dimensiones = DimensionesEvidenciaSchema.parse({
    proveniencia: {
      tipoFuente: item.tipo_fuente as string,
      fecha: c.fecha,
      localizacion: item.referencia as string,
    },
    metodo: { recoleccion: c.recoleccion, derivada: c.derivada, segmentoIds: [] },
    calidad: { confianza: c.confianza, corroboraIds: [], contradiceIds: [] },
    // Los DERECHOS no los propone la AI: el consentimiento de las personas se captura
    // antes de procesar (RF-09.5) y jamás se infiere de un texto. Nace en falso; para
    // una evidencia con consentimiento registrado está el camino manual de la bandeja.
    derechos: { consentimiento: false, confidencialidad: c.confidencialidad },
    // SYS-19: esta evidencia SÍ pasó por una transformación AI y lo dice para siempre.
    // Las citas literales viven en la propuesta aceptada, que queda enlazada a esta fila.
    lineage: { modelo: p.modelo, promptVersion: p.promptVersion },
  });

  const [fuente] = await tx`insert into fuente (workspace_id, tipo, titulo, referencia, creado_por)
    values (${workspaceId}, ${item.tipo_fuente as string}, ${item.titulo as string},
            ${item.referencia as string}, ${actorId})
    returning id`;
  const [evidencia] = await tx`insert into evidencia
    (workspace_id, fuente_id, titulo, resumen, dimensiones, es_estado_actual, creado_por)
    values (${workspaceId}, ${fuente!.id as string}, ${c.titulo}, ${c.resumen},
            ${tx.json(dimensiones)}, ${c.esEstadoActual}, ${actorId})
    returning id`;
  const evidenciaId = evidencia!.id as string;

  const selladas = await tx`update item_importacion
    set estado = 'aprobado', decidido_por = ${actorId}, decidido_en = now(),
        evidencia_id = ${evidenciaId}
    where id = ${p.itemId} and workspace_id = ${workspaceId} and estado = 'pendiente'
    returning workspace_role(${actorId}, ${workspaceId}) as rol`;
  if (selladas.length === 0) throw new ErrorAI('El item ya fue decidido por otra persona');
  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (${workspaceId}, 'EvidenciaCurada',
      ${tx.json({ itemId: p.itemId, evidenciaId, origen: 'propuesta-ai' })},
      ${actorId}, ${selladas[0]!.rol as string})`;
  return evidenciaId;
}

/** C0: el criterio nace bajo el reto de la propuesta, firmado por quien acepta y SIN
 * línea base inventada (solo el plan para obtenerla — SYS-22 exige valor+fecha o plan). */
async function materializarCriterio(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  p: PropuestaEnRevision,
  c: ContenidoCriterio,
): Promise<string> {
  // Mismo candado que agregarCriterio: mutar criterios y decidir un G0 no pueden
  // entrecruzarse (contrato documentado en metodo.servicio.ts).
  await bloquearReto(tx, p.retoId!);
  try {
    const [criterio] = await tx`insert into criterio_exito
      (workspace_id, reto_id, kpi, definicion, linea_base_valor, linea_base_fecha,
       linea_base_plan, objetivo, ventana_dias, fecha_post_mortem, creado_por)
      values (${workspaceId}, ${p.retoId}, ${c.kpi}, ${c.definicion}, null, null,
              ${c.lineaBasePlan}, ${c.objetivo}, ${c.ventanaDias}, null, ${actorId})
      returning id`;
    return criterio!.id as string;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    // El guard de criterio_exito habla antes que el WITH CHECK (P0001); la política
    // responde 42501. En ambos casos el motivo es el mismo para quien revisa.
    if (
      (err.code === 'P0001' && err.message?.includes('congelados')) ||
      err.code === '42501'
    ) {
      throw new ErrorAI('El G0 del reto ya fue aprobado: los criterios están congelados');
    }
    throw e;
  }
}

/** Rechazar no toca el dominio: el item de la bandeja sigue pendiente de curaduría manual
 * y el reto sigue admitiendo criterios a mano (paridad manual, SYS-21). La propuesta se
 * conserva íntegra como insumo de las métricas de grounding (SYS-17). */
export async function rechazarPropuesta(
  actorId: string,
  entrada: { workspaceId: string; propuestaId: string },
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId);
    const filas = await tx`update propuesta_ai
      set estado = 'rechazada', revisada_por = ${actorId}
      where id = ${entrada.propuestaId} and workspace_id = ${entrada.workspaceId}
        and estado = 'propuesta'`;
    if (filas.count === 0) {
      throw new ErrorAI('La propuesta no existe o ya fue revisada');
    }
  });
}
