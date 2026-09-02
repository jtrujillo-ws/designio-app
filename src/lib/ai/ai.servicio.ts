import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { DimensionesEvidenciaSchema, ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import { bloquearReto } from '@/lib/metodo/metodo.servicio';
import { evaluarCapacidadAI, LIMITE_PROPUESTAS_DIA } from './ai.degradacion';
import {
  fidelidadDeCitas,
  materialDeItem,
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
  type RegistrarConsentimiento,
  type RevisarPropuesta,
} from './ai.schemas';
import {
  credencialesAI,
  generarConProveedor,
  type ResultadoProveedor,
} from './proveedor.server';

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

/** Cuántas propuestas puede llegar a PERSISTIR una generación de cada capacidad: el techo
 * que admite su esquema (no el que se le pide al modelo, que puede devolver de más). Es
 * lo que se aparta del presupuesto antes de llamar al proveedor. */
const UNIDADES_POR_CAPACIDAD: Record<CapacidadActiva, number> = { CI: 1, C0: 4 };

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

/**
 * Presupuesto AI del workspace (RF-08.5): propuestas generadas hoy. Es un corte SUAVE y
 * por eso se cuenta lo PERSISTIDO —una llamada fallida no consume presupuesto— con el día
 * del servidor, que es también el que usa el reporte de costos.
 *
 * `reservadas` son las generaciones EN CURSO (huecos apartados antes de llamar al
 * proveedor): cuentan para admitir una generación nueva, porque si no, N curadores
 * simultáneos leen todos el mismo «quedan sitios» y todos escriben. No cuentan para el
 * número que pinta el panel, que informa de lo realmente gastado hoy.
 */
async function presupuestoDeHoy(
  tx: TransactionSql,
  workspaceId: string,
): Promise<{ persistidas: number; reservadas: number }> {
  const [fila] = await tx`select
      (select count(*) from propuesta_ai
        where workspace_id = ${workspaceId} and creado_en >= date_trunc('day', now()))::int
        as persistidas,
      (select coalesce(sum(unidades), 0) from reserva_ai
        where workspace_id = ${workspaceId} and creado_en > now() - reserva_ai_ventana())::int
        as reservadas`;
  return {
    persistidas: (fila?.persistidas ?? 0) as number,
    reservadas: (fila?.reservadas ?? 0) as number,
  };
}

async function estadoCapacidad(tx: TransactionSql, workspaceId: string) {
  const { keyWorkspace, keyEntorno } = credencialesAI();
  const { persistidas } = await presupuestoDeHoy(tx, workspaceId);
  return evaluarCapacidadAI({
    keyWorkspace,
    keyEntorno,
    propuestasHoy: persistidas,
    limiteDiario: LIMITE_PROPUESTAS_DIA,
  });
}

/** Candado del presupuesto AI de un workspace. Apartar el hueco y consumirlo ocurren en
 * transacciones DISTINTAS (la llamada al proveedor va entre medias, fuera de toda
 * transacción), así que los dos lados lo toman: una consulta es un predicado sobre un
 * snapshot, no un candado — mismo contrato que `bloquearReto`. */
async function bloquearPresupuesto(tx: TransactionSql, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:presupuesto-ai:' || ${workspaceId}, 42))`;
}

function filaDePanel(f: Record<string, unknown>): PropuestaEnPanel {
  const contenido = f.contenido as ContenidoPropuesta;
  const original = f.contenido_original as ContenidoPropuesta;
  // El material se compone IGUAL que al construir el prompt —ficha incluida y con el
  // delimitador neutralizado—: la fidelidad se mide contra lo que el modelo leyó, no
  // contra el texto crudo de la base. Una sola definición, dos usos.
  const material =
    f.item_id === null
      ? ''
      : materialDeItem({
          titulo: (f.item_titulo as string | null) ?? '',
          tipoFuente: (f.item_tipo_fuente as string | null) ?? '',
          referencia: (f.item_referencia as string | null) ?? '',
          contenido: (f.item_contenido as string | null) ?? '',
        }).texto;
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
    costoUsd: f.costo_usd === null || f.costo_usd === undefined ? null : Number(f.costo_usd),
    creadoEn: (f.creado_en as Date).toISOString(),
    revisadaEn: f.revisada_en ? (f.revisada_en as Date).toISOString() : null,
  };
}

/**
 * Proyección del panel de revisión. El `material` que viaja para medir la fidelidad de
 * las citas está acotado EXACTAMENTE al que entró al prompt (MAX_MATERIAL): medir contra
 * más texto del que el modelo vio daría un grounding falsamente bueno.
 *
 * Pendientes y decididas se consultan por SEPARADO, cada una con su corte. Con un único
 * límite antes de partir por estado, 150 decisiones nuevas dejaban fuera una propuesta
 * pendiente antigua: invisible en el panel y, como la generación excluye su item por el
 * `not exists`, imposible de revisar o rechazar por ningún camino. Y las pendientes van
 * de la MÁS ANTIGUA a la más nueva: una cola de revisión se drena por el frente, así que
 * el recorte cae siempre sobre lo recién llegado, que se ve en la siguiente pasada.
 */
export async function panelPropuestas(
  actorId: string,
  workspaceId: string,
): Promise<PanelPropuestas> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const ai = await estadoCapacidad(tx, workspaceId);

    // Fragmentos compartidos: dos consultas con la MISMA proyección no pueden divergir.
    const columnas = tx`p.id, p.capacidad, p.destino, p.estado, p.es_simulacion, p.confianza,
             p.contenido, p.contenido_original, p.item_id, p.reto_id,
             p.modelo, p.prompt_version, p.origen_key, p.alcance_resumen, p.latencia_ms,
             p.costo_usd, p.creado_en, p.revisada_en,
             coalesce(i.titulo, r.codigo || ' ' || r.titulo) as ancla_titulo,
             coalesce(i.estado = 'pendiente', true) as ancla_disponible,
             i.titulo as item_titulo, i.tipo_fuente as item_tipo_fuente,
             i.referencia as item_referencia,
             left(coalesce(i.contenido, ''), ${MAX_MATERIAL}) as item_contenido`;
    const origen = tx`from propuesta_ai p
      left join item_importacion i
        on i.id = p.item_id and i.workspace_id = p.workspace_id
      left join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id`;

    // Se pide una fila de más para saber si el corte dejó algo fuera (mismo truco que la
    // bandeja): el panel lo dice en vez de fingir que eso es todo.
    const pendientes = await tx`select ${columnas} ${origen}
      where p.workspace_id = ${workspaceId} and p.estado = 'propuesta'
      order by p.creado_en asc, p.id asc
      limit ${PAGINA_PENDIENTES + 1}`;
    const decididas = await tx`select ${columnas} ${origen}
      where p.workspace_id = ${workspaceId} and p.estado <> 'propuesta'
      order by p.creado_en desc, p.id desc
      limit ${DECIDIDAS_RECIENTES + 1}`;

    // Anclas ofrecibles a la generación. Un item con propuesta pendiente no se vuelve a
    // ofrecer: pedir otra quemaría presupuesto sobre algo que ya espera revisión humana.
    // Los que exigen consentimiento se ofrecen igual, MARCADOS: la pantalla explica qué
    // falta y deja registrarlo, que es más útil que esconder el item sin decir por qué.
    const items = await tx`
      select i.id, i.titulo,
             tipo_fuente_exige_consentimiento(i.tipo_fuente)
               and not exists (select 1 from consentimiento_item c
                 where c.item_id = i.id and c.workspace_id = i.workspace_id
                   and c.procesamiento_externo) as consentimiento_pendiente
      from item_importacion i
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
      pendientes: pendientes.slice(0, PAGINA_PENDIENTES).map(filaDePanel),
      decididas: decididas.slice(0, DECIDIDAS_RECIENTES).map(filaDePanel),
      hayMasPendientes: pendientes.length > PAGINA_PENDIENTES,
      hayMasDecididas: decididas.length > DECIDIDAS_RECIENTES,
      itemsPendientes: items.map((i) => ({
        id: i.id as string,
        titulo: i.titulo as string,
        consentimientoPendiente: i.consentimiento_pendiente as boolean,
      })),
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
  /** Hueco del presupuesto apartado para esta generación: se consume al persistir y se
   * libera si la generación no llega a nacer. */
  reservaId: string;
  unidades: number;
};

/**
 * Lee el alcance delimitado del ancla, comprueba que se PUEDA procesar (capacidad
 * encendida, consentimiento registrado si el material es de personas) y aparta el hueco
 * del presupuesto.
 *
 * Deliberadamente en su propia transacción, corta: la llamada al proveedor ocurre FUERA
 * de cualquier transacción — un tercero lento no puede retener una conexión de la base.
 * Justo por eso el chequeo del presupuesto no bastaba: entre este commit y el insert
 * final pasa la llamada entera, y sin dejar nada apartado todos los curadores que miran
 * a la vez ven el mismo hueco libre.
 */
async function prepararAlcance(actorId: string, entrada: GenerarPropuestas): Promise<Alcance> {
  const unidades = UNIDADES_POR_CAPACIDAD[entrada.capacidad];
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId);

    const { keyWorkspace, keyEntorno } = credencialesAI();
    let sistema: string;
    let prompt: { usuario: string; alcanceResumen: string };

    if (entrada.capacidad === 'CI') {
      const [item] = await tx`select titulo, tipo_fuente, referencia, contenido,
          tipo_fuente_exige_consentimiento(tipo_fuente)
            and not exists (select 1 from consentimiento_item c
              where c.item_id = item_importacion.id
                and c.workspace_id = item_importacion.workspace_id
                and c.procesamiento_externo) as falta_consentimiento
        from item_importacion
        where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
          and estado = 'pendiente'`;
      if (!item) throw new ErrorAI('El item no existe en este workspace o ya fue curado');
      // RF-09.5: ANTES de construir el prompt, no al aceptar la propuesta. Aquí es donde
      // se evita de verdad que el material de una persona salga hacia el proveedor; el
      // guard de `propuesta_ai` es el suelo que impide que exista una propuesta así.
      if (item.falta_consentimiento as boolean) {
        throw new ErrorAI(
          'Ese material es de personas: registra el consentimiento para procesarlo con un proveedor externo antes de pedir una propuesta (RF-09.5)',
        );
      }
      const [pendiente] = await tx`select 1 as hay from propuesta_ai
        where item_id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
          and estado = 'propuesta' limit 1`;
      if (pendiente) {
        throw new ErrorAI('Ese item ya tiene una propuesta pendiente: revísala antes de pedir otra');
      }
      sistema = SISTEMA_EXTRACCION;
      prompt = promptExtraccion({
        titulo: item.titulo as string,
        tipoFuente: item.tipo_fuente as string,
        referencia: item.referencia as string,
        contenido: item.contenido as string,
      });
    } else {
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
      sistema = SISTEMA_CRITERIOS;
      prompt = promptCriterios({
        codigo: reto.codigo as string,
        titulo: reto.titulo as string,
        descripcion: reto.descripcion as string,
        metricaObjetivo: reto.metrica_objetivo as string,
        cuantos: CRITERIOS_POR_GENERACION,
      });
    }

    // ── Reserva del hueco, bajo candado del workspace ──
    await bloquearPresupuesto(tx, entrada.workspaceId);
    // Recolección de basura de reservas caducadas (proceso muerto a mitad de llamada):
    // bajo el mismo candado, así que limpiar y apartar son atómicos entre sí.
    await tx`delete from reserva_ai
      where workspace_id = ${entrada.workspaceId}
        and creado_en <= now() - reserva_ai_ventana()`;

    if (entrada.capacidad === 'CI') {
      const [enCurso] = await tx`select 1 as hay from reserva_ai
        where workspace_id = ${entrada.workspaceId} and item_id = ${entrada.anclaId}`;
      if (enCurso) {
        throw new ErrorAI(
          'Ese item ya tiene una generación AI en curso: espera a que termine antes de pedir otra',
        );
      }
    }

    const { persistidas, reservadas } = await presupuestoDeHoy(tx, entrada.workspaceId);
    const ai = evaluarCapacidadAI({
      keyWorkspace,
      keyEntorno,
      propuestasHoy: persistidas + reservadas,
      limiteDiario: LIMITE_PROPUESTAS_DIA,
      unidades,
    });
    if (!ai.disponible || !ai.origenKey) throw new ErrorAI(ai.motivo);
    const key = (ai.origenKey === 'workspace' ? keyWorkspace : keyEntorno)!;

    let reserva;
    try {
      [reserva] = await tx`insert into reserva_ai
        (workspace_id, capacidad, item_id, unidades, creado_por)
        values (${entrada.workspaceId}, ${entrada.capacidad},
                ${entrada.capacidad === 'CI' ? entrada.anclaId : null}, ${unidades}, ${actorId})
        returning id`;
    } catch (e) {
      // El índice único de la reserva por item: el candado ya serializa a los curadores,
      // así que aquí solo se llega por un camino que no pasara por él.
      if ((e as { code?: string }).code === '23505') {
        throw new ErrorAI('Ese item ya tiene una generación AI en curso: espera a que termine');
      }
      throw e;
    }

    return {
      sistema,
      usuario: prompt.usuario,
      alcanceResumen: prompt.alcanceResumen,
      origenKey: ai.origenKey,
      key,
      reservaId: reserva!.id as string,
      unidades,
    };
  });
}

/** Devuelve el hueco al presupuesto cuando la generación no llegó a persistir: una
 * llamada fallida no consume presupuesto (y no hay que esperar a que la reserva caduque
 * para volver a intentarlo sobre el mismo item). Idempotente. */
async function liberarReserva(
  actorId: string,
  workspaceId: string,
  reservaId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearPresupuesto(tx, workspaceId);
    await tx`delete from reserva_ai where id = ${reservaId} and workspace_id = ${workspaceId}`;
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
  try {
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
    return await persistirPropuestas(actorId, entrada, alcance, respuesta, contenidos);
  } catch (e) {
    // Nada nació: el hueco vuelve al presupuesto en el acto. Si la transacción de arriba
    // ya lo había consumido y luego falló, su rollback lo repuso — y este delete lo
    // vuelve a quitar, que es lo correcto: sigue sin haber propuestas.
    await liberarReserva(actorId, entrada.workspaceId, alcance.reservaId).catch(() => {});
    throw e;
  }
}

/** Persiste el lote consumiendo la reserva EN LA MISMA transacción (RF-09.12): el hueco
 * apartado y las filas que lo ocupan nacen o no nacen juntos. */
async function persistirPropuestas(
  actorId: string,
  entrada: GenerarPropuestas,
  alcance: Alcance,
  respuesta: Extract<ResultadoProveedor, { ok: true }>,
  contenidos: ContenidoPropuesta[],
): Promise<{ generadas: number }> {
  // Agrupa las propuestas de ESTA llamada: su uso y su coste son de la llamada, no de
  // cada fila, y el reporte de costos suma por llamada distinta (RF-09.14).
  const llamadaId = crypto.randomUUID();
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearPresupuesto(tx, entrada.workspaceId);

    const consumida = await tx`delete from reserva_ai
      where id = ${alcance.reservaId} and workspace_id = ${entrada.workspaceId}
      returning unidades`;
    const apartadas = consumida.length > 0 ? Number(consumida[0]!.unidades) : 0;
    // La reserva caducó (proveedor lentísimo, proceso reiniciado): sin ella este insert
    // volvería a ser el chequeo obsoleto que dejaba pasar a todos, así que se re-comprueba
    // el presupuesto con el estado de AHORA antes de escribir nada.
    if (contenidos.length > apartadas) {
      const { keyWorkspace, keyEntorno } = credencialesAI();
      const { persistidas, reservadas } = await presupuestoDeHoy(tx, entrada.workspaceId);
      const ai = evaluarCapacidadAI({
        keyWorkspace,
        keyEntorno,
        propuestasHoy: persistidas + reservadas,
        limiteDiario: LIMITE_PROPUESTAS_DIA,
        unidades: contenidos.length,
      });
      if (!ai.disponible) throw new ErrorAI(ai.motivo);
    }

    const destino = DESTINO_DE_CAPACIDAD[entrada.capacidad];
    // UNA sentencia para el lote entero: el evento PropuestaAIGenerada de cada fila lo
    // emite el guard DENTRO de este insert, así que el rol auditado es exactamente el que
    // autorizó la escritura (mismo snapshot).
    try {
      const filas = await tx`
      insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, reto_id, contenido, contenido_original,
         modelo, prompt_version, alcance_resumen, latencia_ms, origen_key, llamada_id,
         tokens_entrada, tokens_salida, costo_usd, creado_por)
      select ${entrada.workspaceId}, ${entrada.capacidad}, ${destino},
             ${entrada.capacidad === 'CI' ? entrada.anclaId : null},
             ${entrada.capacidad === 'C0' ? entrada.anclaId : null},
             c.contenido, c.contenido,
             ${respuesta.modelo}, ${PROMPT_VERSION}, ${alcance.alcanceResumen},
             ${respuesta.latenciaMs}, ${alcance.origenKey}, ${llamadaId},
             ${respuesta.uso?.entrada ?? null}, ${respuesta.uso?.salida ?? null},
             ${respuesta.uso?.costoUsd ?? null}, ${actorId}
      from jsonb_array_elements(${tx.json(contenidos)}) as c(contenido)
      returning id`;
      return { generadas: filas.length };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // El índice único parcial: otra generación se adelantó con este item. Es el suelo
      // que garantiza UNA sola propuesta pendiente aunque nadie viera a nadie.
      if (err.code === '23505') {
        throw new ErrorAI(
          'Ese item ya tiene una propuesta pendiente: otra generación se adelantó y esta se descarta',
        );
      }
      // El guard del consentimiento (RF-09.5): el servicio ya lo comprobó antes de
      // construir el prompt, así que aquí solo llega por carrera o por SQL crudo.
      if (err.code === 'P0001' && err.message?.includes('consentimiento')) {
        throw new ErrorAI(
          'Ese material exige consentimiento registrado para procesamiento externo (RF-09.5)',
        );
      }
      throw e;
    }
  });
}

/**
 * Registra el consentimiento de las personas sobre el material de un item (RF-09.5),
 * ANTES de procesarlo. No lo propone ni lo infiere la AI: lo declara la persona que
 * condujo la investigación, y queda atribuido por la política.
 *
 * Es append-only: no hay grant de UPDATE ni de DELETE sobre la tabla, así que un
 * consentimiento registrado no se puede reescribir ni borrar desde la app. Una revocación
 * futura (RF-09.4) será su propio objeto, no una edición de este.
 */
export async function registrarConsentimiento(
  actorId: string,
  entrada: RegistrarConsentimiento,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId);
    const [item] = await tx`select 1 as hay from item_importacion
      where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId}`;
    if (!item) throw new ErrorAI('El item no existe en este workspace');
    try {
      await tx`insert into consentimiento_item
        (item_id, workspace_id, alcance, procesamiento_externo, registrado_por)
        values (${entrada.itemId}, ${entrada.workspaceId}, ${entrada.alcance},
                ${entrada.procesamientoExterno}, ${actorId})`;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ErrorAI('Ese item ya tiene consentimiento registrado: no se reescribe');
      }
      throw e;
    }
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
  // El consentimiento se registró ANTES de procesar (RF-09.5) o no se registró: la
  // evidencia dice cuál de las dos, y no lo decide ni lo propone la AI.
  const [consentimiento] = await tx`select 1 as hay from consentimiento_item
    where item_id = ${p.itemId} and workspace_id = ${workspaceId}`;

  const dimensiones = DimensionesEvidenciaSchema.parse({
    proveniencia: {
      tipoFuente: item.tipo_fuente as string,
      fecha: c.fecha,
      localizacion: item.referencia as string,
    },
    metodo: { recoleccion: c.recoleccion, derivada: c.derivada, segmentoIds: [] },
    calidad: { confianza: c.confianza, corroboraIds: [], contradiceIds: [] },
    // Los DERECHOS no los propone la AI: el consentimiento se captura antes de procesar
    // (RF-09.5) y jamás se infiere de un texto. Aquí solo se COPIA lo que quedó
    // registrado sobre el item — antes nacía siempre en falso, lo que obligaba a
    // reparar a mano una evidencia cuyo consentimiento sí constaba.
    derechos: {
      consentimiento: Boolean(consentimiento),
      confidencialidad: c.confidencialidad,
    },
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
