import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';
import {
  ValorMetricoSchema,
  type CargarCsv,
  type CompletarReview,
  type CrearEntrada,
  type EditarEntrada,
  type FilaRechazada,
  type ResultadoCriterioEntrada,
  type RegistrarSnapshot,
  type SeguimientoDeImpacto,
} from './medicion.schemas';

/**
 * Medición temporal de impacto (SPEC-07, ADR-0007): Metric Registry 1:1 con el reto que
 * se firma en G6 (SYS-22), snapshots append-only por formulario o CSV (SYS-23), lectura
 * por criterio contra la línea base, y outcome review con veredicto del catálogo cerrado
 * que cierra el reto y el proyecto (SYS-24, SYS-08).
 *
 * Capa 1: RLS — la firma es del rol aprobador de G6, el registry firmado queda congelado,
 * el snapshot solo entra con contrato firmado y reto en medición (y lo carga un curador o
 * el PROPIETARIO DEL DATO), y el review no se abre antes de cerrar la ventana. Capa 2:
 * estado de cuenta en toda operación, candados donde hay carrera, y el diagnóstico de por
 * qué NO se pudo firmar/completar, que es la mitad útil del producto.
 *
 * Lo que este slice NO hace, a propósito: redactar el post-mortem con AI (SPEC-08 — aquí
 * la narrativa es humana) y anclar la serie a fechas de release (SPEC-06).
 */

export class ErrorMedicion extends Error {}

/** Corte de la serie por entrada: una lectura no es un data warehouse. */
export const SNAPSHOTS_POR_ENTRADA = 500;

/** Tope de filas por carga CSV: la ingesta es manual y acotada (ADR-0007, decisión 4). */
export const MAX_FILAS_CSV = 500;

/** Candado por reto — MISMO espacio de nombres que el método (metodo.servicio): cerrar
 * el reto y aceptar snapshots deben serializarse entre sí. Sin él, bajo READ COMMITTED
 * un snapshot podría pasar su política («reto en medición») y commitear DESPUÉS del
 * cierre, escribiendo sobre un objeto cerrado (SYS-08). */
async function bloquearReto(tx: TransactionSql, retoId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`;
}

/** Candado por registry: editar entradas y FIRMAR se excluyen igual que marcar checklist
 * y aprobar el gate — la firma congela exactamente lo que estaba escrito. */
async function bloquearRegistry(tx: TransactionSql, registryId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:registry:' || ${registryId}, 42))`;
}

/** Traduce el raise de un guard (P0001) al contrato del módulo; deja pasar lo demás. */
function comoErrorDeDominio(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code === 'P0001' && err.message) throw new ErrorMedicion(err.message);
  throw e;
}

/** Un INSERT que la política rechaza NO devuelve cero filas: aborta la transacción con
 * 42501. Por eso el diagnóstico rico de esos caminos corre en una transacción NUEVA de
 * solo lectura (dentro de la abortada, cualquier consulta ya fallaría con 25P02). */
function esRechazoDePolitica(e: unknown): boolean {
  return (e as { code?: string }).code === '42501';
}

/** El reto dueño de una entrada KPI (inmutable: leerlo antes del candado no abre carrera). */
async function retoDeEntrada(
  tx: TransactionSql,
  workspaceId: string,
  entradaId: string,
): Promise<string> {
  const [fila] = await tx`
    select r.reto_id from entrada_kpi e
    join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
    where e.id = ${entradaId} and e.workspace_id = ${workspaceId}`;
  if (!fila) throw new ErrorMedicion('La entrada KPI no existe en este workspace');
  return fila.reto_id as string;
}

/** Abre el contrato de medición del reto (RF-07.1). 1:1 por unique: dos aperturas
 * concurrentes no crean dos registries — la segunda choca y se traduce. */
export async function abrirRegistry(
  actorId: string,
  entrada: { workspaceId: string; retoId: string },
): Promise<{ registryId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let fila;
    try {
      // UNA sentencia: registry y evento comparten snapshot y el rol auditado es el que
      // autorizó el insert (misma disciplina que el resto de los módulos).
      [fila] = await tx`
        with quien as (
          select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
        ),
        nuevo as (
          insert into metric_registry (workspace_id, reto_id, creado_por)
          values (${entrada.workspaceId}, ${entrada.retoId}, ${actorId})
          returning id
        ),
        evento as (
          insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
          select ${entrada.workspaceId}, 'MetricRegistryAbierto',
            jsonb_build_object('registryId', nuevo.id, 'retoId', ${entrada.retoId}::uuid),
            ${actorId}, quien.rol
          from nuevo, quien
        )
        select id from nuevo`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') throw new ErrorMedicion('Este reto ya tiene su Metric Registry');
      if (code === '23503') throw new ErrorMedicion('El reto no existe en este workspace');
      if (esRechazoDePolitica(e)) {
        throw new ErrorMedicion('El registry se abre sobre un reto activo y lo abren lead o diseñador');
      }
      throw e;
    }
    return { registryId: fila!.id as string };
  });
}

export async function agregarEntrada(
  actorId: string,
  entrada: CrearEntrada,
): Promise<{ entradaId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Serializa contra la firma: sin el candado, este insert y una firma concurrente
    // podrían commitear juntos y congelar una entrada que nadie revisó.
    await bloquearRegistry(tx, entrada.registryId);
    let fila;
    try {
      [fila] = await tx`
        insert into entrada_kpi (workspace_id, registry_id, criterio_id, nombre, definicion,
          fuente, dimensiones, propietario_miembro_id, frecuencia, dashboard_url,
          linea_base_valor, linea_base_fecha, ventana_inicio, fecha_post_mortem, creado_por)
        values (${entrada.workspaceId}, ${entrada.registryId}, ${entrada.criterioId},
          ${entrada.nombre}, ${entrada.definicion}, ${entrada.fuente}, ${entrada.dimensiones},
          ${entrada.propietarioMiembroId}, ${entrada.frecuencia}, ${entrada.dashboardUrl},
          ${entrada.lineaBaseValor}, ${entrada.lineaBaseFecha}, ${entrada.ventanaInicio},
          ${entrada.fechaPostMortem}, ${actorId})
        returning id`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') throw new ErrorMedicion('Ya hay un KPI con ese nombre en el registry');
      if (code === '23503') {
        throw new ErrorMedicion('El registry, el criterio o el propietario no existen aquí');
      }
      if (code === '42501') {
        throw new ErrorMedicion(
          'El registry está firmado, el criterio no es de este reto o no puedes editarlo',
        );
      }
      throw e;
    }
    if (!fila) throw new ErrorMedicion('El registry está firmado o no puedes editarlo');
    return { entradaId: fila.id as string };
  });
}

/** Corrige una entrada mientras el registry es borrador (después la política la congela:
 * 0 filas). Es el camino de reparación — una entrada incompleta bloquea la firma. */
export async function editarEntrada(actorId: string, entrada: EditarEntrada): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [dueno] = await tx`select registry_id from entrada_kpi
      where id = ${entrada.entradaId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) throw new ErrorMedicion('La entrada KPI no existe en este workspace');
    await bloquearRegistry(tx, dueno.registry_id as string);
    let filas;
    try {
      filas = await tx`
        update entrada_kpi
        set nombre = ${entrada.nombre}, definicion = ${entrada.definicion},
            fuente = ${entrada.fuente}, dimensiones = ${entrada.dimensiones},
            propietario_miembro_id = ${entrada.propietarioMiembroId},
            frecuencia = ${entrada.frecuencia}, dashboard_url = ${entrada.dashboardUrl},
            linea_base_valor = ${entrada.lineaBaseValor},
            linea_base_fecha = ${entrada.lineaBaseFecha},
            ventana_inicio = ${entrada.ventanaInicio},
            fecha_post_mortem = ${entrada.fechaPostMortem}
        where id = ${entrada.entradaId} and workspace_id = ${entrada.workspaceId}`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') throw new ErrorMedicion('Ya hay un KPI con ese nombre en el registry');
      if (code === '23503') throw new ErrorMedicion('El propietario del dato no es miembro de este workspace');
      throw e;
    }
    if (filas.count === 0) {
      throw new ErrorMedicion('El registry está firmado o no puedes editarlo');
    }
  });
}

/**
 * Firmar el registry (SYS-22): la política exige el rol aprobador de G6 con G0-G5
 * aprobados y G6 pendiente; el guard de la base exige el CONTENIDO (cada criterio con su
 * KPI, cada entrada completa y el post-mortem previsto tras el cierre de la ventana).
 * 0 filas = bloqueado por la política; el diagnóstico dice cuál de las dos razones fue.
 */
export async function firmarRegistry(
  actorId: string,
  entrada: { workspaceId: string; registryId: string },
): Promise<{ entradas: number }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearRegistry(tx, entrada.registryId);
    let firmado;
    try {
      // El sello temporal lo pone el guard (la base), no el caller: `firmado_en` ni
      // siquiera está en el grant del rol de app, así que aquí solo se pide la firma.
      firmado = await tx`
        update metric_registry
        set estado = 'firmado', firmado_por = ${actorId}
        where id = ${entrada.registryId} and workspace_id = ${entrada.workspaceId}
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (firmado!.length === 0) {
      throw new ErrorMedicion(await diagnosticoDeFirma(tx, entrada.workspaceId, entrada.registryId));
    }
    const [conteo] = await tx`select count(*)::int as n from entrada_kpi
      where registry_id = ${entrada.registryId} and workspace_id = ${entrada.workspaceId}`;
    return { entradas: conteo!.n as number };
  });
}

/** Por qué NO se pudo firmar: read-only, corre tras el update fallido (el guard habla
 * del contenido; esto, de la posición en el método y del rol). */
async function diagnosticoDeFirma(
  tx: TransactionSql,
  workspaceId: string,
  registryId: string,
): Promise<string> {
  const [registry] = await tx`
    select r.estado, r.reto_id from metric_registry r
    where r.id = ${registryId} and r.workspace_id = ${workspaceId}`;
  if (!registry) return 'El registry no existe en este workspace';
  if (registry.estado === 'firmado') return 'El Metric Registry ya está firmado';

  const [g6] = await tx`
    select g.estado, g.rol_aprobador from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = ${registry.reto_id as string} and p.workspace_id = ${workspaceId}
      and g.numero = 6`;
  if (!g6) return 'El reto no tiene proyecto con método instanciado: no hay G6 que firmar';
  if (g6.estado === 'aprobado') return 'El G6 ya fue aprobado: el registry debió firmarse antes';

  const anteriores = await tx`
    select g.numero from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = ${registry.reto_id as string} and p.workspace_id = ${workspaceId}
      and g.numero < 6 and g.estado <> 'aprobado'
    order by g.numero`;
  if (anteriores.length > 0) {
    const lista = anteriores.map((g) => `G${g.numero as number}`).join(', ');
    return `El registry se firma EN G6: faltan los gates anteriores (${lista})`;
  }
  return `Solo el rol ${g6.rol_aprobador as string} firma el Metric Registry en G6`;
}

/**
 * Abrir la medición (RF-07.6): el reto pasa a «en medición» y su proyecto también. El
 * guard de transición del reto exige el registry FIRMADO (SYS-22) y la política, el rol
 * que opera el método. Los dos movimientos van en la misma transacción: un reto midiendo
 * con el proyecto todavía «activo» sería un tablero que miente.
 */
export async function abrirMedicion(
  actorId: string,
  entrada: { workspaceId: string; retoId: string },
): Promise<{ proyectos: number }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearReto(tx, entrada.retoId);
    let abierto;
    try {
      abierto = await tx`
        update reto set estado = 'en-medicion'
        where id = ${entrada.retoId} and workspace_id = ${entrada.workspaceId}
          and estado = 'activo'
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (abierto!.length === 0) {
      throw new ErrorMedicion('El reto no existe, no está activo o no puedes abrir su medición');
    }
    // El G6 aprobado es la señal de que el plan de implementación está acordado: medir
    // antes sería medir un plan que aún puede cambiar.
    const [g6] = await tx`
      select count(*) filter (where g.estado = 'aprobado')::int as aprobados
      from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      where p.reto_id = ${entrada.retoId} and p.workspace_id = ${entrada.workspaceId}
        and g.numero = 6`;
    if ((g6!.aprobados as number) === 0) {
      throw new ErrorMedicion('Abrir la medición exige el G6 aprobado (plan de implementación)');
    }
    let movidos;
    try {
      movidos = await tx`
        update proyecto set estado = 'en-medicion'
        where reto_id = ${entrada.retoId} and workspace_id = ${entrada.workspaceId}
          and estado in ('activo', 'en-implementacion')`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    // Los dos movimientos son uno solo: si ningún proyecto entró en medición (todos
    // pausados o ya cerrados), el reto tampoco — se revierte la transacción completa.
    if (movidos!.count === 0) {
      throw new ErrorMedicion(
        'Ningún proyecto del reto puede pasar a medición (revisa si está pausado o cerrado)',
      );
    }
    return { proyectos: movidos!.count };
  });
}

/** Único mensaje de las tres condiciones que la política del snapshot exige a la vez
 * (SYS-22/23): decir cuál falló sería contar el estado del reto a quien no lo lee. */
const RECHAZO_SNAPSHOT =
  'No puedes cargar snapshots: exige registry firmado, reto en medición y ser curador o propietario del dato';

/** Snapshot por formulario (RF-07.3): append-only, con fecha CALENDÁRICA y origen. */
export async function registrarSnapshot(
  actorId: string,
  entrada: RegistrarSnapshot,
): Promise<{ snapshotId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const retoId = await retoDeEntrada(tx, entrada.workspaceId, entrada.entradaId);
    await bloquearReto(tx, retoId);
    let fila;
    try {
      // UNA sentencia: snapshot y evento comparten snapshot de transacción y el rol
      // auditado es el que autorizó el insert.
      [fila] = await tx`
        with quien as (
          select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
        ),
        nuevo as (
          insert into snapshot (workspace_id, entrada_kpi_id, valor, fecha, origen, nota, creado_por)
          values (${entrada.workspaceId}, ${entrada.entradaId}, ${entrada.valor}::numeric,
                  ${entrada.fecha}::date, 'formulario', ${entrada.nota}, ${actorId})
          returning id
        ),
        evento as (
          insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
          select ${entrada.workspaceId}, 'SnapshotRegistrado',
            jsonb_build_object('snapshotId', nuevo.id, 'entradaId', ${entrada.entradaId}::uuid,
                               'fecha', ${entrada.fecha}::text, 'origen', 'formulario'),
            ${actorId}, quien.rol
          from nuevo, quien
        )
        select id from nuevo`;
    } catch (e) {
      if (esRechazoDePolitica(e)) throw new ErrorMedicion(RECHAZO_SNAPSHOT);
      throw e;
    }
    return { snapshotId: fila!.id as string };
  });
}

/**
 * Carga por CSV pegado (RF-07.3, criterio de aceptación 1): una fila inválida se rechaza
 * CON motivo accionable y las válidas entran; nada se sobreescribe jamás (SYS-23).
 * Formato por línea: `fecha,valor[,nota]` con separador `,`, `;` o tabulador; la fecha
 * es calendárica AAAA-MM-DD y el valor usa punto decimal. Una cabecera `fecha,...` se
 * ignora — es lo que exporta cualquier hoja de cálculo.
 */
export async function cargarSnapshotsCsv(
  actorId: string,
  entrada: CargarCsv,
): Promise<{ insertados: number; rechazadas: FilaRechazada[] }> {
  const { validas, rechazadas } = parsearCsv(entrada.csv);
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const retoId = await retoDeEntrada(tx, entrada.workspaceId, entrada.entradaId);
    await bloquearReto(tx, retoId);
    if (validas.length === 0) {
      // Sin filas válidas no hay escritura, pero el diagnóstico sí importa: la pantalla
      // muestra por qué se rechazó cada línea.
      return { insertados: 0, rechazadas };
    }
    let insertadas;
    try {
      // Todas las filas válidas en UNA sentencia: la carga es atómica (o entra la tanda
      // completa o ninguna), que es lo que «nada se sobreescribe» exige de una corrección.
      insertadas = await tx`
        insert into snapshot (workspace_id, entrada_kpi_id, valor, fecha, origen, nota, creado_por)
        select ${entrada.workspaceId}, ${entrada.entradaId}, f.valor::numeric, f.fecha::date,
               'csv', f.nota, ${actorId}
        from jsonb_to_recordset(${tx.json(validas)}) as f(fecha text, valor text, nota text)
        returning id`;
    } catch (e) {
      if (esRechazoDePolitica(e)) throw new ErrorMedicion(RECHAZO_SNAPSHOT);
      throw e;
    }
    const [quien] = await tx`select workspace_role(${actorId}, ${entrada.workspaceId}) as rol`;
    // Un evento por CARGA, no por fila: la decisión auditable es «alguien cargó esta
    // tanda por CSV»; cada snapshot ya es una fila inmutable con su autor y su fecha.
    await tx`
      insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (${entrada.workspaceId}, 'SnapshotsCargados',
        ${tx.json({
          entradaId: entrada.entradaId,
          origen: 'csv',
          insertados: insertadas.length,
          rechazadas: rechazadas.length,
        })},
        ${actorId}, ${quien!.rol as string})`;
    return { insertados: insertadas.length, rechazadas };
  });
}

/** Parseo puro del CSV pegado (sin base): separa filas válidas de rechazadas con motivo. */
export function parsearCsv(csv: string): {
  validas: { fecha: string; valor: string; nota: string }[];
  rechazadas: FilaRechazada[];
} {
  const validas: { fecha: string; valor: string; nota: string }[] = [];
  const rechazadas: FilaRechazada[] = [];
  const lineas = csv.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const cruda = lineas[i] ?? '';
    const linea = cruda.trim();
    if (linea === '') continue;
    const partes = linea.split(/[;,\t]/);
    const fecha = (partes[0] ?? '').trim();
    // Cabecera de hoja de cálculo: se salta sin contarla como rechazo.
    if (i === 0 && fecha.toLowerCase() === 'fecha') continue;
    const valor = (partes[1] ?? '').trim();
    const nota = partes.slice(2).join(' ').trim().slice(0, 500);
    if (validas.length >= MAX_FILAS_CSV) {
      rechazadas.push({
        linea: i + 1,
        contenido: linea.slice(0, 120),
        motivo: `Se aceptan hasta ${MAX_FILAS_CSV} filas por carga`,
      });
      continue;
    }
    const fechaOk = FechaCalendarioSchema.safeParse(fecha);
    if (!fechaOk.success) {
      rechazadas.push({
        linea: i + 1,
        contenido: linea.slice(0, 120),
        motivo: fecha === '' ? 'Falta la fecha (AAAA-MM-DD)' : `Fecha inválida: «${fecha}»`,
      });
      continue;
    }
    const valorOk = ValorMetricoSchema.safeParse(valor);
    if (!valorOk.success) {
      rechazadas.push({
        linea: i + 1,
        contenido: linea.slice(0, 120),
        motivo:
          valor === '' ? 'Falta el valor' : `Valor no numérico: «${valor}» (usa punto decimal)`,
      });
      continue;
    }
    validas.push({ fecha: fechaOk.data, valor: valorOk.data, nota });
  }
  return { validas, rechazadas };
}

/** Abrir el outcome review (RF-07.7): la política solo lo permite con la ventana del
 * ÚLTIMO criterio cerrada. 0 filas → el diagnóstico dice cuánto falta. */
export async function abrirOutcomeReview(
  actorId: string,
  entrada: { workspaceId: string; retoId: string },
): Promise<{ reviewId: string }> {
  try {
    return await conUsuario(actorId, async (tx) => {
      await exigirCuentaActiva(tx, actorId);
      const [fila] = await tx`
        insert into outcome_review (workspace_id, reto_id, creado_por)
        values (${entrada.workspaceId}, ${entrada.retoId}, ${actorId})
        returning id`;
      return { reviewId: fila!.id as string };
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23505') throw new ErrorMedicion('Este reto ya tiene su outcome review');
    if (code === '23503') throw new ErrorMedicion('El reto no existe en este workspace');
    if (!esRechazoDePolitica(e)) throw e;
    // Transacción NUEVA de solo lectura: la anterior quedó abortada por el rechazo, y
    // «cuánto falta para el post-mortem» es justo lo que el usuario necesita saber.
    throw new ErrorMedicion(
      await conUsuario(actorId, async (tx) => {
        await exigirCuentaActiva(tx, actorId);
        return diagnosticoDeReview(tx, entrada.workspaceId, entrada.retoId);
      }),
    );
  }
}

/** Por qué el review no se habilita todavía: ventanas abiertas, registry sin firmar o
 * medición sin abrir (RF-07.7 en lenguaje del usuario). */
async function diagnosticoDeReview(
  tx: TransactionSql,
  workspaceId: string,
  retoId: string,
): Promise<string> {
  const [reto] = await tx`select estado from reto
    where id = ${retoId} and workspace_id = ${workspaceId}`;
  if (!reto) return 'El reto no existe en este workspace';
  const [registry] = await tx`select estado from metric_registry
    where reto_id = ${retoId} and workspace_id = ${workspaceId}`;
  if (!registry) return 'El reto no tiene Metric Registry: no hay nada que revisar';
  if (registry.estado !== 'firmado') return 'El Metric Registry aún no está firmado (SYS-22)';
  if (reto.estado !== 'en-medicion') {
    return `El outcome review se abre con el reto en medición (ahora: ${reto.estado as string})`;
  }
  const abiertas = await tx`
    select e.nombre, (e.ventana_inicio + c.ventana_dias) - current_date as faltan
    from entrada_kpi e
    join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
    join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
    where r.reto_id = ${retoId} and r.workspace_id = ${workspaceId}
      and (e.ventana_inicio is null or c.ventana_dias is null
           or e.ventana_inicio + c.ventana_dias > current_date)
    order by e.nombre`;
  if (abiertas.length > 0) {
    const lista = abiertas
      .map(
        (a) =>
          `«${a.nombre as string}»${a.faltan === null ? ' (sin ventana)' : ` (faltan ${a.faltan as number} días)`}`,
      )
      .join(', ');
    return `El outcome review se habilita al cerrar la ventana del último criterio: ${lista}`;
  }
  return 'Solo el lead-boutique abre el outcome review';
}

/** Resultado de un criterio dentro del review (RF-07.8): apunta a un snapshot REAL de la
 * serie de ese criterio o declara por qué no hay dato. Idempotente por criterio. */
const RECHAZO_RESULTADO =
  'El review ya está completado, el snapshot no es de este criterio o no puedes redactarlo';

export async function registrarResultado(
  actorId: string,
  entrada: ResultadoCriterioEntrada,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El upsert lo hace explícito el ON CONFLICT: escribir dos veces el resultado de un
    // criterio es corregir el borrador, no duplicarlo.
    let filas;
    try {
      filas = await tx`
        insert into resultado_criterio (workspace_id, review_id, criterio_id, snapshot_final_id,
                                        lectura, sin_datos_motivo)
        values (${entrada.workspaceId}, ${entrada.reviewId}, ${entrada.criterioId},
                ${entrada.snapshotFinalId}, ${entrada.lectura}, ${entrada.sinDatosMotivo})
        on conflict (review_id, criterio_id) do update
          set snapshot_final_id = excluded.snapshot_final_id,
              lectura = excluded.lectura,
              sin_datos_motivo = excluded.sin_datos_motivo
        returning id`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23503') throw new ErrorMedicion('El review, el criterio o el snapshot no existen aquí');
      if (code === '23514') {
        throw new ErrorMedicion('Sin snapshot final hay que escribir por qué no hay dato');
      }
      // El snapshot final de OTRO criterio, el review ya completado o el rol equivocado:
      // los tres los rechaza la política con el mismo código.
      if (esRechazoDePolitica(e)) throw new ErrorMedicion(RECHAZO_RESULTADO);
      throw e;
    }
    if (filas.length === 0) throw new ErrorMedicion(RECHAZO_RESULTADO);
  });
}

/**
 * Completar el outcome review (RF-07.8/07.10): la MISMA sentencia registra el veredicto
 * del catálogo cerrado y la firma; el guard de la base exige resultado por criterio,
 * ventanas cerradas y coherencia del veredicto con los datos, y aplica los efectos
 * inseparables — reto cerrado CON veredicto y proyecto cerrado inmutable (SYS-08).
 */
export async function completarOutcomeReview(
  actorId: string,
  entrada: CompletarReview,
): Promise<{ veredicto: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [dueno] = await tx`select reto_id, estado from outcome_review
      where id = ${entrada.reviewId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) throw new ErrorMedicion('El outcome review no existe en este workspace');
    if (dueno.estado === 'completado') throw new ErrorMedicion('El outcome review ya está completado');
    // Mismo candado que los snapshots: cerrar el reto y aceptar datos no se entrecruzan.
    await bloquearReto(tx, dueno.reto_id as string);
    let completado;
    try {
      completado = await tx`
        update outcome_review
        set estado = 'completado', veredicto = ${entrada.veredicto},
            contribucion = ${entrada.contribucion},
            factores_externos = ${entrada.factoresExternos},
            hipotesis_abiertas = ${entrada.hipotesisAbiertas},
            aprendizajes = ${entrada.aprendizajes},
            diseno_experimental_suficiente = ${entrada.disenoExperimentalSuficiente},
            diseno_experimental_justificacion = ${entrada.disenoExperimentalJustificacion},
            completado_por = ${actorId}, completado_en = now()
        where id = ${entrada.reviewId} and workspace_id = ${entrada.workspaceId}
          and estado = 'borrador'
        returning veredicto`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23514') {
        throw new ErrorMedicion('Declarar diseño experimental suficiente exige justificarlo (SYS-24)');
      }
      if (esRechazoDePolitica(e)) {
        throw new ErrorMedicion('Solo el lead-boutique completa el outcome review');
      }
      comoErrorDeDominio(e);
    }
    if (completado!.length === 0) {
      throw new ErrorMedicion('El outcome review ya está completado o no puedes completarlo');
    }
    return { veredicto: completado![0]!.veredicto as string };
  });
}

/**
 * Seguimiento de impacto del proyecto (RF-07.5/07.6): registry con sus entradas, serie de
 * snapshots contra la línea base y el objetivo, días restantes de ventana y estado
 * «esperado / recibido / vencido» derivado de la frecuencia comprometida (RF-07.4). Una
 * sola sentencia: un snapshot, orden estable, sin lecturas incoherentes entre bloques.
 */
export async function seguimientoDeImpacto(
  actorId: string,
  workspaceId: string,
  proyectoId: string,
): Promise<SeguimientoDeImpacto | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await tx`
      select r.id as reto_id, r.codigo as reto_codigo, r.estado as reto_estado,
        r.veredicto as reto_veredicto, p.estado as proyecto_estado,
        case when mr.id is null then null else jsonb_build_object(
          'id', mr.id, 'estado', mr.estado, 'firmadoEn', mr.firmado_en::text) end as registry,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', e.id, 'criterioId', e.criterio_id, 'criterioKpi', c.kpi,
            'criterioObjetivo', c.objetivo, 'criterioVentanaDias', c.ventana_dias,
            'nombre', e.nombre, 'definicion', e.definicion, 'fuente', e.fuente,
            'dimensiones', e.dimensiones,
            'propietarioMiembroId', e.propietario_miembro_id, 'propietarioNombre', m.nombre,
            'soyPropietario', coalesce(m.usuario_id = ${actorId}::uuid, false),
            'frecuencia', e.frecuencia, 'dashboardUrl', e.dashboard_url,
            'lineaBaseValor', e.linea_base_valor::text,
            'lineaBaseFecha', e.linea_base_fecha::text,
            'ventanaInicio', e.ventana_inicio::text,
            'ventanaFin', (e.ventana_inicio + c.ventana_dias)::text,
            'fechaPostMortem', e.fecha_post_mortem::text,
            'diasRestantes', (e.ventana_inicio + c.ventana_dias) - current_date,
            'ultimaFecha', ult.fecha::text,
            -- RF-07.4 sobre el DATO: el estado sale de la cadencia comprometida y de la
            -- última recepción, no de una marca que alguien pone a mano.
            'estadoSnapshot', case
              when e.ventana_inicio is null or c.ventana_dias is null then 'esperado'
              when cad.dias is null then
                case when ult.fecha is not null then 'recibido'
                     when e.ventana_inicio + c.ventana_dias < current_date then 'vencido'
                     else 'esperado' end
              when ult.fecha is null then
                case when e.ventana_inicio + cad.dias < current_date then 'vencido'
                     else 'esperado' end
              when ult.fecha + cad.dias < current_date then 'vencido'
              else 'recibido' end,
            'snapshots', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', s.id, 'valor', s.valor::text, 'fecha', s.fecha::text,
                'origen', s.origen, 'nota', s.nota) order by s.fecha, s.creado_en)
              from (select * from snapshot s2
                    where s2.entrada_kpi_id = e.id and s2.workspace_id = e.workspace_id
                    order by s2.fecha desc, s2.creado_en desc
                    limit ${SNAPSHOTS_POR_ENTRADA}) s), '[]'::jsonb))
            order by e.nombre)
          from entrada_kpi e
          join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
          left join miembro m on m.id = e.propietario_miembro_id and m.workspace_id = e.workspace_id
          left join lateral (select max(s.fecha) as fecha from snapshot s
            where s.entrada_kpi_id = e.id and s.workspace_id = e.workspace_id) ult on true
          cross join lateral (select case e.frecuencia
            when 'semanal' then 7 when 'mensual' then 30 when 'trimestral' then 90 end as dias) cad
          where e.registry_id = mr.id and e.workspace_id = mr.workspace_id), '[]'::jsonb) as entradas,
        coalesce((
          select jsonb_agg(jsonb_build_object('id', c.id, 'kpi', c.kpi) order by c.creado_en, c.id)
          from criterio_exito c
          where c.reto_id = r.id and c.workspace_id = r.workspace_id
            and not exists (select 1 from entrada_kpi e
              where e.criterio_id = c.id and e.workspace_id = c.workspace_id)), '[]'::jsonb)
          as criterios_sin_entrada,
        coalesce((
          select jsonb_agg(jsonb_build_object('id', m2.id, 'nombre', m2.nombre, 'rol', m2.rol)
            order by m2.nombre)
          from miembro m2 where m2.workspace_id = r.workspace_id), '[]'::jsonb) as miembros,
        case when orv.id is null then null else jsonb_build_object(
          'id', orv.id, 'estado', orv.estado, 'veredicto', orv.veredicto,
          'contribucion', orv.contribucion, 'factoresExternos', orv.factores_externos,
          'hipotesisAbiertas', orv.hipotesis_abiertas, 'aprendizajes', orv.aprendizajes,
          'disenoExperimentalSuficiente', orv.diseno_experimental_suficiente,
          'disenoExperimentalJustificacion', orv.diseno_experimental_justificacion,
          'completadoEn', orv.completado_en::text,
          'resultados', coalesce((
            select jsonb_agg(jsonb_build_object(
              'criterioId', rc.criterio_id, 'criterioKpi', c2.kpi,
              'snapshotFinalId', rc.snapshot_final_id, 'valorFinal', s3.valor::text,
              'fechaFinal', s3.fecha::text, 'lectura', rc.lectura,
              'sinDatosMotivo', rc.sin_datos_motivo) order by c2.kpi)
            from resultado_criterio rc
            join criterio_exito c2 on c2.id = rc.criterio_id and c2.workspace_id = rc.workspace_id
            left join snapshot s3 on s3.id = rc.snapshot_final_id and s3.workspace_id = rc.workspace_id
            where rc.review_id = orv.id and rc.workspace_id = orv.workspace_id), '[]'::jsonb))
          end as review
      from proyecto p
      join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id
      left join metric_registry mr on mr.reto_id = r.id and mr.workspace_id = r.workspace_id
      left join outcome_review orv on orv.reto_id = r.id and orv.workspace_id = r.workspace_id
      where p.id = ${proyectoId} and p.workspace_id = ${workspaceId}`;
    if (!fila) return null;
    return {
      retoId: fila.reto_id as string,
      retoCodigo: fila.reto_codigo as string,
      retoEstado: fila.reto_estado as string,
      retoVeredicto: fila.reto_veredicto as SeguimientoDeImpacto['retoVeredicto'],
      proyectoEstado: fila.proyecto_estado as string,
      registry: fila.registry as SeguimientoDeImpacto['registry'],
      entradas: fila.entradas as SeguimientoDeImpacto['entradas'],
      criteriosSinEntrada: fila.criterios_sin_entrada as SeguimientoDeImpacto['criteriosSinEntrada'],
      miembros: fila.miembros as SeguimientoDeImpacto['miembros'],
      review: fila.review as SeguimientoDeImpacto['review'],
    };
  });
}
