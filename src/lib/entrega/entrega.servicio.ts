import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import type {
  AgregarElemento,
  AprobarDesignVersion,
  AsignarElemento,
  Constatar,
  CrearDesignVersion,
  DesignVersionCompleta,
  DesplegarRelease,
  EditarElemento,
  EnlazarJourney,
  PlanificarRelease,
  ResumenDesignVersion,
  TableroConciliacion,
} from './entrega.schemas';

/**
 * Trazabilidad y objetos de resultado (SPEC-06). Capa 1: RLS — miembros leen la cadena
 * completa (es lo que el cliente audita) y el lead la opera; las transiciones las exige
 * el WITH CHECK de cada política y los efectos viven en los guards, así que el SQL crudo
 * produce los mismos eventos y sellos. Capa 2: estado de cuenta en toda operación,
 * candados donde dos escrituras sobre filas DISTINTAS se invalidan, y traducción de los
 * guards al contrato de la app.
 *
 * SYS-05 vive en el modelo: un índice único parcial garantiza como mucho UNA design
 * version aprobada por servicio, así que «aprobar DV-2 sin superar a DV-1» no es un
 * camino mal implementado — es una fila que la base rechaza.
 *
 * El diff NO se almacena (RF-06.2): `designVersionCompleta` trae la design version y el
 * effective state vigente EN UNA SENTENCIA, y `calcularDiff` los contrasta. Así el diff
 * y el tablero no pueden discrepar por haber leído estados distintos.
 */

export class ErrorEntrega extends Error {}

/**
 * Traduce el error de Postgres al contrato del módulo. `sinPermiso` es el mensaje del
 * 42501: una política de INSERT que no se cumple lo LANZA (a diferencia de un UPDATE,
 * que simplemente no alcanza la fila), y el motivo real depende de la operación —
 * «la DV ya está aprobada» y «no eres el lead» llegan aquí como el mismo código.
 */
function comoErrorDeDominio(e: unknown, sinPermiso?: string): never {
  const err = e as { code?: string; message?: string; constraint_name?: string };
  if (err.code === 'P0001' && err.message) throw new ErrorEntrega(err.message);
  if (err.code === '23505' && err.constraint_name === 'design_version_vigente_uniq') {
    throw new ErrorEntrega(
      'Este servicio ya tiene una design version aprobada: la nueva debe declarar a cuál supera (SYS-05)',
    );
  }
  if (err.code === '23505' && err.constraint_name === 'design_version_sucesion_uniq') {
    throw new ErrorEntrega('Esa design version ya fue superada por otra');
  }
  if (err.code === '23505' && err.constraint_name === 'release_elemento_pkey') {
    throw new ErrorEntrega('Ese elemento ya está incluido en un release (SYS-06: exactamente uno)');
  }
  if (err.code === '23505') throw new ErrorEntrega('Ese registro ya existe');
  if (err.code === '23503') throw new ErrorEntrega('Alguna referencia no existe en este workspace');
  if (err.code === '23514') {
    throw new ErrorEntrega('El registro no cumple las reglas del dominio (¿desviación sin razón?)');
  }
  if (err.code === '42501') {
    throw new ErrorEntrega(sinPermiso ?? 'No puedes operar la entrega de este workspace');
  }
  throw e;
}

/**
 * Candado por SERVICIO para las aprobaciones de design version. Dos aprobaciones
 * concurrentes tocan filas distintas (cada una la suya y la que supera), así que ninguna
 * política ve a la otra: una política es un predicado sobre un snapshot, no un candado.
 * El índice único parcial las atraparía, pero con un error de constraint en vez de un
 * mensaje; el candado las serializa y la segunda ve el estado real.
 */
async function bloquearServicio(tx: TransactionSql, servicioId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:design-version:' || ${servicioId}, 42))`;
}

/**
 * Candado por DESIGN VERSION: serializa aprobar contra TODA mutación de sus elementos.
 *
 * El recurso en disputa es la VERSIÓN, no el elemento, y por eso la clave es su id: dos
 * elementos distintos de la misma versión también compiten entre sí (comparten el
 * `max(orden) + 1`) y, sobre todo, compiten contra la aprobación que los congela.
 * Nombrarlo por el elemento no serializaría ninguna de las dos cosas.
 *
 * Por qué hace falta en los dos lados: aprobar y editar un elemento escriben filas
 * DISTINTAS —design_version y elemento_cambio—, así que el candado de fila que Postgres
 * pone solo protege a quien toca la misma. `enlazarJourney`, por ejemplo, no necesita
 * nada de esto: escribe la propia fila de la design version y el candado de fila lo
 * serializa contra la aprobación por construcción. El elemento no. Y la política del
 * elemento («su design version está en borrador») es un predicado sobre un snapshot: bajo
 * READ COMMITTED la aprobación aún sin commitear no se ve, las dos transacciones pasan sus
 * chequeos y la versión aprobada acaba con un cambio posterior a su congelación.
 *
 * Tampoco vale `select … for update` sobre la design version desde el lado del elemento:
 * bajo RLS ese bloqueo exige además pasar el USING de alguna política de UPDATE de
 * design_version, que no es una condición que el editor de elementos deba cumplir — la
 * autorización para editar un elemento no puede depender de si puedes escribir su padre.
 *
 * Orden de adquisición: design version → servicio (en `aprobarDesignVersion`), y nunca
 * junto al candado de release, que vive en el otro extremo de la cadena. Sin pares
 * cruzados no hay ciclo posible.
 */
async function bloquearDesignVersion(tx: TransactionSql, designVersionId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:dv-elemento:' || ${designVersionId}, 42))`;
}

/**
 * Candado por RELEASE. Lo toman los cuatro caminos que deciden sobre el mismo estado: el
 * despliegue, la constatación y las dos escrituras del ALCANCE (asignar y desasignar).
 *
 * El alcance y el despliegue se invalidan mutuamente aunque escriban tablas distintas
 * —release_elemento y release—, así que el candado de fila no los toca: sin esto, dos
 * transacciones ven el release 'planificado' a la vez y commitean las dos. El resultado
 * es un elemento que entra DESPUÉS del despliegue (y queda constatable sin haber salido),
 * o el último elemento saliendo justo cuando el guard acaba de comprobar que el alcance no
 * estaba vacío: un release desplegado que no declara nada, contra SYS-06.
 */
async function bloquearRelease(tx: TransactionSql, releaseId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:release:' || ${releaseId}, 42))`;
}

/** Los códigos DV-n / RL-n / ES-n son max+1 por workspace: dos altas concurrentes leerían
 * el mismo máximo y chocarían contra la unique. Un candado por serie los serializa. */
async function bloquearSerie(tx: TransactionSql, serie: string, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:codigo-' || ${serie} || ':' || ${workspaceId}, 42))`;
}

// ══ Design version ══

export async function crearDesignVersion(
  actorId: string,
  entrada: CrearDesignVersion,
): Promise<{ designVersionId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearSerie(tx, 'dv', entrada.workspaceId);
    let fila;
    try {
      // Una sentencia: el código se calcula, la fila nace en borrador y el evento lo pone
      // el trigger de alta con el rol del MISMO snapshot que autorizó el insert.
      [fila] = await tx`
        insert into design_version (workspace_id, proyecto_id, servicio_id, journey_id,
                                    codigo, titulo, resumen, supera_a, creado_por)
        select ${entrada.workspaceId}, ${entrada.proyectoId}, ${entrada.servicioId},
          ${entrada.journeyId},
          'DV-' || (coalesce((select max(substring(dv.codigo from 4)::int)
            from design_version dv where dv.workspace_id = ${entrada.workspaceId}), 0) + 1),
          ${entrada.titulo}, ${entrada.resumen}, ${entrada.superaA}, ${actorId}
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e, 'Solo los curadores crean design versions en este workspace');
    }
    if (!fila) throw new ErrorEntrega('No puedes crear design versions en este workspace');
    return { designVersionId: fila.id as string };
  });
}

/**
 * Enlazar (o reenlazar) el journey to-be de un BORRADOR. El formulario de alta ofrece
 * «se puede enlazar después» porque el modelo lo permite —la DV puede abrirse antes de
 * que el to-be exista—, y sin esta operación esa opción dejaba el borrador muerto: no se
 * puede aprobar sin grafo que congelar, y no hay DELETE sobre design_version.
 *
 * Ni el estado ni el rol se validan aquí: la política solo alcanza borradores y solo a
 * curadores, y el grant por columna hace que este UPDATE no pueda tocar nada más. Lo
 * único que hace el servicio es traducir «no alcanzó ninguna fila» al motivo real.
 */
export async function enlazarJourney(actorId: string, entrada: EnlazarJourney): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let filas;
    try {
      filas = await tx`
        update design_version set journey_id = ${entrada.journeyId}
        where id = ${entrada.designVersionId} and workspace_id = ${entrada.workspaceId}`;
    } catch (e) {
      comoErrorDeDominio(e, 'Solo los curadores enlazan el journey de un borrador');
    }
    // Sobre una DV aprobada no se llega aquí: el guard de transición aborta antes con la
    // inmutabilidad de SYS-05. Cero filas es «no existe, o no puedes enlazarla».
    if (filas!.count === 0) {
      throw new ErrorEntrega(
        'La design version no existe en este workspace, o no puedes enlazar su journey',
      );
    }
  });
}

export async function agregarElemento(
  actorId: string,
  entrada: AgregarElemento,
): Promise<{ elementoId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El candado hace dos trabajos: el orden es un max()+1 (dos altas concurrentes leerían
    // el mismo máximo y nacerían empatadas) y, sobre todo, serializa contra la aprobación
    // que congela esta design version.
    await bloquearDesignVersion(tx, entrada.designVersionId);
    let fila;
    try {
      [fila] = await tx`
        insert into elemento_cambio (workspace_id, design_version_id, tipo, operacion,
                                     titulo, detalle, nodo_id, orden, creado_por)
        select ${entrada.workspaceId}, ${entrada.designVersionId}, ${entrada.tipo},
          ${entrada.operacion}, ${entrada.titulo}, ${entrada.detalle}, ${entrada.nodoId},
          coalesce((select max(orden) + 1 from elemento_cambio ec
            where ec.design_version_id = ${entrada.designVersionId}
              and ec.workspace_id = ${entrada.workspaceId}), 0),
          ${actorId}
        returning id`;
    } catch (e) {
      comoErrorDeDominio(
        e,
        'La design version ya está aprobada y es inmutable (SYS-05), o no puedes editarla',
      );
    }
    if (!fila) {
      throw new ErrorEntrega('La design version no existe o ya está aprobada (SYS-05)');
    }
    const elementoId = fila.id as string;
    // Los motivos van en sentencias APARTE: las sub-sentencias de un WITH comparten
    // snapshot y no verían la fila hermana recién insertada.
    await enlazarMotivos(tx, actorId, entrada.workspaceId, elementoId, entrada);
    return { elementoId };
  });
}

async function enlazarMotivos(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  elementoId: string,
  entrada: { decisionIds: string[]; insightIds: string[] },
): Promise<void> {
  const decisiones = [...new Set(entrada.decisionIds)];
  const insights = [...new Set(entrada.insightIds)];
  try {
    if (decisiones.length > 0) {
      const filas = await tx`
        insert into elemento_decision (elemento_id, decision_id, workspace_id, creado_por)
        select ${elementoId}, d.sid::uuid, ${workspaceId}, ${actorId}
        from jsonb_array_elements_text(${tx.json(decisiones)}) d(sid)
        returning decision_id`;
      if (filas.length !== decisiones.length) {
        throw new ErrorEntrega('Alguna decisión citada no quedó enlazada');
      }
    }
    if (insights.length > 0) {
      const filas = await tx`
        insert into elemento_insight (elemento_id, insight_id, workspace_id, creado_por)
        select ${elementoId}, i.sid::uuid, ${workspaceId}, ${actorId}
        from jsonb_array_elements_text(${tx.json(insights)}) i(sid)
        returning insight_id`;
      if (filas.length !== insights.length) {
        throw new ErrorEntrega('Algún insight citado no quedó enlazado');
      }
    }
  } catch (e) {
    if (e instanceof ErrorEntrega) throw e;
    comoErrorDeDominio(e, 'No puedes citar motivos sobre una design version aprobada');
  }
}

/**
 * Resuelve la design version de un elemento y toma su candado. El id resuelto es ESTABLE
 * sin necesidad de re-comprobarlo después: `design_version_id` está fuera del grant de
 * columna de elemento_cambio, así que un elemento no puede mudarse de versión entre la
 * lectura y el candado — el grant mínimo cierra la ventana que si no habría que vigilar.
 */
async function bloquearVersionDelElemento(
  tx: TransactionSql,
  workspaceId: string,
  elementoId: string,
): Promise<void> {
  const [fila] = await tx`select design_version_id from elemento_cambio
    where id = ${elementoId} and workspace_id = ${workspaceId}`;
  if (!fila) throw new ErrorEntrega('Ese elemento de cambio no existe en este workspace');
  await bloquearDesignVersion(tx, fila.design_version_id as string);
}

export async function editarElemento(actorId: string, entrada: EditarElemento): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearVersionDelElemento(tx, entrada.workspaceId, entrada.elementoId);
    let filas;
    try {
      filas = await tx`
        update elemento_cambio
        set tipo = ${entrada.tipo}, operacion = ${entrada.operacion},
            titulo = ${entrada.titulo}, detalle = ${entrada.detalle}, nodo_id = ${entrada.nodoId}
        where id = ${entrada.elementoId} and workspace_id = ${entrada.workspaceId}`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    // Criterio de aceptación 1: sobre una DV aprobada la política no alcanza la fila, así
    // que el update no toca nada. El mensaje ofrece la salida real: una versión nueva.
    if (filas!.count === 0) {
      throw new ErrorEntrega(
        'La design version está aprobada y es inmutable (SYS-05): crea una versión nueva que la supere',
      );
    }
  });
}

export async function borrarElemento(
  actorId: string,
  workspaceId: string,
  elementoId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearVersionDelElemento(tx, workspaceId, elementoId);
    // Los motivos se van con el elemento: dejarlos sería dejar enlaces al vacío. Las FKs
    // no tienen cascade a propósito (borrar en cadena por accidente es peor que fallar).
    await tx`delete from elemento_decision
      where elemento_id = ${elementoId} and workspace_id = ${workspaceId}`;
    await tx`delete from elemento_insight
      where elemento_id = ${elementoId} and workspace_id = ${workspaceId}`;
    const filas = await tx`delete from elemento_cambio
      where id = ${elementoId} and workspace_id = ${workspaceId}`;
    if (filas.count === 0) {
      throw new ErrorEntrega(
        'La design version está aprobada y es inmutable (SYS-05): crea una versión nueva que la supere',
      );
    }
  });
}

/**
 * Aprobar (RF-06.3, SYS-05). Tres efectos INSEPARABLES en una transacción:
 *  1. la design version anterior del servicio pasa a 'superada',
 *  2. se congela el snapshot del grafo to-be —mismo contenido que `congelarSnapshot`
 *     de SPEC-05, replicado aquí porque aquella abre su propia transacción y esto tiene
 *     que ser atómico con la aprobación—,
 *  3. la design version pasa a 'aprobada' apuntando a ese snapshot.
 *
 * El orden importa: el índice único parcial no admite dos aprobadas del mismo servicio,
 * así que la anterior se marca superada ANTES.
 */
export async function aprobarDesignVersion(
  actorId: string,
  entrada: AprobarDesignVersion,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El candado va ANTES de leer, y no después como el del servicio: lo que se lee aquí
    // —el estado, el journey que se va a congelar— es lo que las mutaciones de elementos
    // pueden estar cambiando ahora mismo. Leer primero y bloquear después dejaría decidir
    // sobre una foto vieja, que es justo lo que este candado viene a impedir.
    await bloquearDesignVersion(tx, entrada.designVersionId);
    const [dv] = await tx`
      select id, servicio_id, journey_id, supera_a, estado, codigo
      from design_version
      where id = ${entrada.designVersionId} and workspace_id = ${entrada.workspaceId}`;
    if (!dv) throw new ErrorEntrega('La design version no existe en este workspace');
    if (dv.estado !== 'borrador') {
      throw new ErrorEntrega('Esta design version ya no está en borrador');
    }
    if (!dv.journey_id) {
      throw new ErrorEntrega(
        'Aprobar congela el snapshot del to-be: enlaza el journey to-be del servicio antes de aprobar',
      );
    }
    await bloquearServicio(tx, dv.servicio_id as string);

    try {
      if (dv.supera_a) {
        const superada = await tx`
          update design_version set estado = 'superada'
          where id = ${dv.supera_a as string} and workspace_id = ${entrada.workspaceId}
            and estado = 'aprobada'`;
        if (superada.count === 0) {
          throw new ErrorEntrega(
            'La design version a la que esta supera ya no está aprobada: revisa la cadena de versiones',
          );
        }
      }

      // Snapshot del grafo to-be: nodos, aristas y la evidencia enlazada. Sin la
      // evidencia, el snapshot no podría decir qué sostenía cada paso cuando se aprobó,
      // que es justo lo que se le pedirá al auditarlo (RF-05.8).
      const [snap] = await tx`
        insert into journey_snapshot (workspace_id, journey_id, motivo, grafo, congelado_por)
        select ${entrada.workspaceId}, j.id,
          coalesce(nullif(${entrada.motivo}, ''), 'Aprobación de ' || ${dv.codigo as string}),
          jsonb_build_object(
            -- MISMO orden total que congelarSnapshot (SPEC-05): el orden se reinicia por
            -- tipo y por fase, así que ordenar solo por él deja empates y el array sale
            -- distinto en cada congelación. Aquí importa el doble, porque son dos caminos
            -- que producen el MISMO registro: si discreparan, dos snapshots del mismo
            -- grafo se compararían como si el grafo hubiera cambiado.
            'nodos', coalesce((select jsonb_agg(to_jsonb(n) order by n.tipo, n.orden, n.id)
              from journey_nodo n
              where n.journey_id = j.id and n.workspace_id = j.workspace_id), '[]'::jsonb),
            'aristas', coalesce((select jsonb_agg(to_jsonb(a) order by a.creado_en, a.id)
              from journey_arista a
              where a.journey_id = j.id and a.workspace_id = j.workspace_id), '[]'::jsonb),
            'evidencias', coalesce((select jsonb_agg(jsonb_build_object(
                'nodoId', ne.nodo_id, 'evidenciaId', ne.evidencia_id,
                'evidenciaTitulo', e.titulo)
                order by ne.creado_en, ne.nodo_id, ne.evidencia_id)
              from journey_nodo_evidencia ne
              join journey_nodo n2 on n2.id = ne.nodo_id and n2.workspace_id = ne.workspace_id
              join evidencia e on e.id = ne.evidencia_id and e.workspace_id = ne.workspace_id
              where n2.journey_id = j.id and ne.workspace_id = j.workspace_id), '[]'::jsonb)
          ),
          ${actorId}
        from journey j
        where j.id = ${dv.journey_id as string} and j.workspace_id = ${entrada.workspaceId}
        returning id`;
      if (!snap) {
        throw new ErrorEntrega('No puedes congelar el grafo de este workspace');
      }

      const aprobada = await tx`
        update design_version
        set estado = 'aprobada', aprobada_por = ${actorId}, snapshot_id = ${snap.id as string}
        where id = ${entrada.designVersionId} and workspace_id = ${entrada.workspaceId}`;
      if (aprobada.count === 0) {
        throw new ErrorEntrega('Solo el lead de la boutique aprueba una design version');
      }
    } catch (e) {
      if (e instanceof ErrorEntrega) throw e;
      comoErrorDeDominio(e);
    }
  });
}

// ══ Releases (RF-06.4/06.5) ══

export async function planificarRelease(
  actorId: string,
  entrada: PlanificarRelease,
): Promise<{ releaseId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearSerie(tx, 'rl', entrada.workspaceId);
    let fila;
    try {
      fila = (
        await tx`
        insert into release (workspace_id, design_version_id, codigo, titulo, responsable,
                             fecha_objetivo, creado_por)
        select ${entrada.workspaceId}, ${entrada.designVersionId},
          'RL-' || (coalesce((select max(substring(r.codigo from 4)::int)
            from release r where r.workspace_id = ${entrada.workspaceId}), 0) + 1),
          ${entrada.titulo}, ${entrada.responsable}, ${entrada.fechaObjetivo}::date, ${actorId}
        returning id`
      )[0];
    } catch (e) {
      comoErrorDeDominio(
        e,
        'Un release solo cuelga de una design version APROBADA (SYS-06), y solo lo planifica el lead',
      );
    }
    if (!fila) {
      throw new ErrorEntrega(
        'Un release solo cuelga de una design version APROBADA (SYS-06), y solo lo planifica el lead',
      );
    }
    const releaseId = fila.id as string;
    // Sentencia aparte: la del release y la de sus elementos no pueden compartir WITH
    // (la segunda no vería la fila que la primera acaba de insertar).
    if (entrada.elementos.length > 0) {
      await asignarElementosAlRelease(tx, actorId, entrada.workspaceId, releaseId, entrada.elementos);
    }
    return { releaseId };
  });
}

async function asignarElementosAlRelease(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  releaseId: string,
  elementos: { elementoId: string; razon: string }[],
): Promise<void> {
  // Declarar el alcance compite con desplegar: los dos deciden sobre el mismo release
  // escribiendo tablas distintas. En `planificarRelease` el candado no tiene contendiente
  // —el release acaba de nacer y su id no es visible para nadie más—, pero tomarlo aquí
  // y no en cada llamador es lo que garantiza que ningún camino al alcance se lo salte.
  await bloquearRelease(tx, releaseId);
  try {
    const filas = await tx`
      insert into release_elemento (elemento_id, release_id, workspace_id, razon, creado_por)
      select (e->>'elementoId')::uuid, ${releaseId}, ${workspaceId},
        coalesce(e->>'razon', ''), ${actorId}
      from jsonb_array_elements(${tx.json(elementos)}) e
      returning elemento_id`;
    if (filas.length !== elementos.length) {
      throw new ErrorEntrega('Algún elemento no quedó incluido en el release');
    }
  } catch (e) {
    if (e instanceof ErrorEntrega) throw e;
    comoErrorDeDominio(
      e,
      'El alcance se declara mientras el release está planificado, y lo declara el lead',
    );
  }
}

export async function asignarElemento(actorId: string, entrada: AsignarElemento): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await asignarElementosAlRelease(tx, actorId, entrada.workspaceId, entrada.releaseId, [
      { elementoId: entrada.elementoId, razon: entrada.razon },
    ]);
  });
}

export async function desasignarElemento(
  actorId: string,
  workspaceId: string,
  elementoId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El release al que sacar el elemento hay que resolverlo para poder bloquearlo, y a
    // diferencia del `design_version_id` de un elemento este SÍ puede cambiar: reasignar
    // es borrar y volver a insertar. Por eso el DELETE repite el release resuelto — si
    // otra transacción lo movió mientras esperábamos, no borramos bajo el candado
    // equivocado: no borramos nada y lo decimos.
    const [asignacion] = await tx`select release_id from release_elemento
      where elemento_id = ${elementoId} and workspace_id = ${workspaceId}`;
    if (!asignacion) {
      throw new ErrorEntrega('Ese elemento no está asignado a ningún release');
    }
    const releaseId = asignacion.release_id as string;
    await bloquearRelease(tx, releaseId);
    const filas = await tx`delete from release_elemento
      where elemento_id = ${elementoId} and workspace_id = ${workspaceId}
        and release_id = ${releaseId}`;
    if (filas.count === 0) {
      throw new ErrorEntrega('Ese elemento no está asignado, o su release ya salió (alcance fijo)');
    }
  });
}

export async function desplegarRelease(
  actorId: string,
  entrada: DesplegarRelease,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearRelease(tx, entrada.releaseId);
    let filas;
    try {
      filas = await tx`
        update release
        set estado = 'desplegado', desplegado_en = ${entrada.desplegadoEn}::date
        where id = ${entrada.releaseId} and workspace_id = ${entrada.workspaceId}`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (filas!.count === 0) {
      throw new ErrorEntrega('El release no existe, ya salió, o no puedes registrarlo');
    }
  });
}

/**
 * Constatar (RF-06.6): el effective state con una constatación POR ELEMENTO del release
 * y el release a 'verificado'. Tres sentencias en una transacción y en este orden: las
 * políticas de effective_state y constatacion exigen el release DESPLEGADO, y el guard
 * de verificación exige que todos los elementos estén ya constatados.
 *
 * SYS-07 no se valida aquí: lo impone el CHECK de la tabla. Un servicio que valide lo
 * mismo que la base añade un segundo lugar donde la regla puede quedarse vieja.
 */
export async function constatarEffectiveState(
  actorId: string,
  entrada: Constatar,
): Promise<{ effectiveStateId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearRelease(tx, entrada.releaseId);
    await bloquearSerie(tx, 'es', entrada.workspaceId);
    let es;
    try {
      [es] = await tx`
        insert into effective_state (workspace_id, servicio_id, release_id, codigo, resumen,
                                     constatado_por, constatado_en)
        select ${entrada.workspaceId}, dv.servicio_id, r.id,
          'ES-' || (coalesce((select max(substring(x.codigo from 4)::int)
            from effective_state x where x.workspace_id = ${entrada.workspaceId}), 0) + 1),
          ${entrada.resumen}, ${actorId}, ${entrada.constatadoEn}::date
        from release r
        join design_version dv on dv.id = r.design_version_id and dv.workspace_id = r.workspace_id
        where r.id = ${entrada.releaseId} and r.workspace_id = ${entrada.workspaceId}
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e, 'Solo se constata un release DESPLEGADO, y solo lo hace el lead');
    }
    if (!es) {
      throw new ErrorEntrega('Solo se constata un release DESPLEGADO, y solo lo hace el lead');
    }
    const effectiveStateId = es.id as string;

    try {
      const filas = await tx`
        insert into constatacion (workspace_id, effective_state_id, elemento_id, resultado,
                                  que_quedo_distinto, razon, creado_por)
        select ${entrada.workspaceId}, ${effectiveStateId}, (c->>'elementoId')::uuid,
          c->>'resultado', coalesce(c->>'queQuedoDistinto', ''), coalesce(c->>'razon', ''),
          ${actorId}
        from jsonb_array_elements(${tx.json(entrada.constataciones)}) c
        returning elemento_id`;
      if (filas.length !== entrada.constataciones.length) {
        throw new ErrorEntrega('Alguna constatación no quedó registrada');
      }
      const verificado = await tx`
        update release set estado = 'verificado'
        where id = ${entrada.releaseId} and workspace_id = ${entrada.workspaceId}`;
      if (verificado.count === 0) {
        throw new ErrorEntrega('No se pudo verificar el release');
      }
    } catch (e) {
      if (e instanceof ErrorEntrega) throw e;
      comoErrorDeDominio(e, 'No puedes constatar este release');
    }
    return { effectiveStateId };
  });
}

// ══ Lecturas ══

/** La design version ENTERA en una sentencia, incluido el effective state vigente contra
 * el que se calcula el diff: el diagrama, el diff y el tablero derivan del MISMO estado,
 * así que no puede pasar que uno muestre un elemento que otro ya no ve. */
export async function designVersionCompleta(
  actorId: string,
  workspaceId: string,
  designVersionId: string,
): Promise<DesignVersionCompleta | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await tx`
      select dv.id, dv.codigo, dv.titulo, dv.resumen, dv.estado,
        dv.servicio_id, s.nombre as servicio_nombre,
        dv.proyecto_id, p.codigo as proyecto_codigo,
        dv.journey_id, j.nombre as journey_nombre, dv.snapshot_id,
        to_char(dv.aprobada_en, 'YYYY-MM-DD') as aprobada_en,
        (select jsonb_build_object('id', a.id, 'codigo', a.codigo)
          from design_version a
          where a.id = dv.supera_a and a.workspace_id = dv.workspace_id) as supera_a,
        (select jsonb_build_object('id', b.id, 'codigo', b.codigo)
          from design_version b
          where b.supera_a = dv.id and b.workspace_id = dv.workspace_id
            and b.estado <> 'borrador') as superada_por,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', ec.id, 'tipo', ec.tipo, 'operacion', ec.operacion, 'titulo', ec.titulo,
            'detalle', ec.detalle, 'nodoId', ec.nodo_id, 'orden', ec.orden,
            'nodoEtiqueta', (select n.etiqueta from journey_nodo n
              where n.id = ec.nodo_id and n.workspace_id = ec.workspace_id),
            -- La identidad ESTABLE del elemento (SPEC-05): el catálogo del servicio es lo
            -- único que sobrevive a un journey nuevo y a un renombre. El diff empareja
            -- por aquí antes que por nodo o por título.
            'catalogoId', (select n.catalogo_id from journey_nodo n
              where n.id = ec.nodo_id and n.workspace_id = ec.workspace_id),
            'decisiones', coalesce((
              select jsonb_agg(jsonb_build_object('id', d.id, 'titulo', d.titulo) order by d.titulo)
              from elemento_decision ed
              join decision d on d.id = ed.decision_id and d.workspace_id = ed.workspace_id
              where ed.elemento_id = ec.id and ed.workspace_id = ec.workspace_id), '[]'::jsonb),
            'insights', coalesce((
              select jsonb_agg(jsonb_build_object('id', i.id, 'titulo', i.titulo) order by i.titulo)
              from elemento_insight ei
              join insight i on i.id = ei.insight_id and i.workspace_id = ei.workspace_id
              where ei.elemento_id = ec.id and ei.workspace_id = ec.workspace_id), '[]'::jsonb))
            order by ec.orden, ec.creado_en)
          from elemento_cambio ec
          where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id
        ), '[]'::jsonb) as elementos,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', r.id, 'codigo', r.codigo, 'titulo', r.titulo,
            'responsable', r.responsable,
            'fechaObjetivo', to_char(r.fecha_objetivo, 'YYYY-MM-DD'),
            'estado', r.estado,
            'desplegadoEn', to_char(r.desplegado_en, 'YYYY-MM-DD'),
            'elementos', coalesce((
              select jsonb_agg(jsonb_build_object('elementoId', re.elemento_id, 'razon', re.razon)
                order by re.creado_en)
              from release_elemento re
              where re.release_id = r.id and re.workspace_id = r.workspace_id), '[]'::jsonb),
            'effectiveState', (
              select jsonb_build_object('id', es.id, 'codigo', es.codigo, 'resumen', es.resumen,
                'constatadoEn', to_char(es.constatado_en, 'YYYY-MM-DD'),
                'constataciones', coalesce((
                  select jsonb_agg(jsonb_build_object('elementoId', c.elemento_id,
                    'resultado', c.resultado, 'queQuedoDistinto', c.que_quedo_distinto,
                    'razon', c.razon) order by c.creado_en)
                  from constatacion c
                  where c.effective_state_id = es.id and c.workspace_id = es.workspace_id), '[]'::jsonb))
              from effective_state es
              where es.release_id = r.id and es.workspace_id = r.workspace_id))
            order by r.codigo)
          from release r
          where r.design_version_id = dv.id and r.workspace_id = dv.workspace_id
        ), '[]'::jsonb) as releases,
        coalesce((
          select jsonb_agg(jsonb_build_object('id', n.id, 'tipo', n.tipo, 'etiqueta', n.etiqueta)
            order by n.tipo, n.orden)
          from journey_nodo n
          where n.journey_id = dv.journey_id and n.workspace_id = dv.workspace_id
        ), '[]'::jsonb) as nodos_del_journey,
        -- Los journeys que el borrador PUEDE enlazar: exactamente el predicado que exige
        -- design_version_journey_guard, para que el selector no ofrezca nada que el
        -- endpoint vaya a rechazar.
        coalesce((
          select jsonb_agg(jsonb_build_object('id', j2.id, 'nombre', j2.nombre)
            order by j2.creado_en desc)
          from journey j2
          where j2.workspace_id = dv.workspace_id and j2.servicio_id = dv.servicio_id
            and j2.tipo = 'to-be'
            and (j2.proyecto_id is null or j2.proyecto_id = dv.proyecto_id)
        ), '[]'::jsonb) as journeys_enlazables,
        coalesce((
          select jsonb_agg(jsonb_build_object('id', d.id, 'titulo', d.titulo) order by d.decidido_en)
          from decision d
          where d.proyecto_id = dv.proyecto_id and d.workspace_id = dv.workspace_id
        ), '[]'::jsonb) as decisiones_del_proyecto,
        coalesce((
          select jsonb_agg(jsonb_build_object('id', i.id, 'titulo', i.titulo) order by i.titulo)
          from insight i
          where i.workspace_id = dv.workspace_id and i.estado = 'validado'
        ), '[]'::jsonb) as insights_validados,
        -- RF-06.10 + RF-06.2: el estado efectivo vigente del servicio, EXCLUYENDO lo que
        -- esta misma design version produjo (compararla consigo misma no es un diff).
        -- El ancla es la última constatación verificada; el contenido, la HISTORIA de
        -- constataciones del servicio en orden cronológico (un servicio con varios
        -- releases tiene su estado repartido entre ellos, y quedarse solo con el último
        -- ES perdería lo anterior).
        --
        -- Lo que viaja es la historia, no el estado: el estado vigente es su PLIEGUE por
        -- identidad lógica, y ese pliegue vive en entrega.diff.ts —donde está definida
        -- la identidad (la función «clave»)— para que los dos lados del diff no puedan usar
        -- criterios distintos. Aquí solo se garantiza el ORDEN, que es lo que el pliegue
        -- necesita y lo que a este jsonb_agg le faltaba.
        --
        -- Sin el «distinct on (c.elemento_id)» de antes: no colapsaba nada. Un elemento va a
        -- como mucho un release (PK de release_elemento), un release se constata una vez
        -- (unique de effective_state.release_id) y la constatación es única por
        -- (effective_state, elemento) — o sea, una fila de elemento_cambio tiene como
        -- mucho UNA constatación en toda su vida. Deduplicar por su id parecía colapsar
        -- historia y no colapsaba ninguna.
        (select jsonb_build_object(
            'id', v.id, 'codigo', v.codigo,
            'constatadoEn', to_char(v.constatado_en, 'YYYY-MM-DD'),
            'designVersionCodigo', v.dv_codigo,
            'constataciones', coalesce((
              select jsonb_agg(jsonb_build_object('elementoId', u.elemento_id,
                'titulo', u.titulo, 'nodoId', u.nodo_id, 'catalogoId', u.catalogo_id,
                'operacion', u.operacion, 'resultado', u.resultado)
                order by u.constatado_en, u.es_creado_en, u.orden, u.elemento_creado_en)
              from (
                select c.elemento_id, ec2.titulo, ec2.nodo_id, n2.catalogo_id,
                  ec2.operacion, c.resultado, es2.constatado_en,
                  es2.creado_en as es_creado_en, ec2.orden,
                  ec2.creado_en as elemento_creado_en
                from constatacion c
                join effective_state es2 on es2.id = c.effective_state_id
                  and es2.workspace_id = c.workspace_id
                join release r2 on r2.id = es2.release_id and r2.workspace_id = es2.workspace_id
                join elemento_cambio ec2 on ec2.id = c.elemento_id
                  and ec2.workspace_id = c.workspace_id
                left join journey_nodo n2 on n2.id = ec2.nodo_id
                  and n2.workspace_id = ec2.workspace_id
                where es2.servicio_id = dv.servicio_id and es2.workspace_id = dv.workspace_id
                  and r2.design_version_id <> dv.id and r2.estado = 'verificado'
              ) u), '[]'::jsonb))
          from (
            select es3.id, es3.codigo, es3.constatado_en, dv3.codigo as dv_codigo
            from effective_state es3
            join release r3 on r3.id = es3.release_id and r3.workspace_id = es3.workspace_id
            join design_version dv3 on dv3.id = r3.design_version_id
              and dv3.workspace_id = r3.workspace_id
            where es3.servicio_id = dv.servicio_id and es3.workspace_id = dv.workspace_id
              and r3.design_version_id <> dv.id and r3.estado = 'verificado'
            order by es3.constatado_en desc, es3.creado_en desc
            limit 1
          ) v) as vigente
      from design_version dv
      join servicio s on s.id = dv.servicio_id and s.workspace_id = dv.workspace_id
      join proyecto p on p.id = dv.proyecto_id and p.workspace_id = dv.workspace_id
      left join journey j on j.id = dv.journey_id and j.workspace_id = dv.workspace_id
      where dv.id = ${designVersionId} and dv.workspace_id = ${workspaceId}`;
    if (!fila) return null;
    return {
      id: fila.id as string,
      codigo: fila.codigo as string,
      titulo: fila.titulo as string,
      resumen: fila.resumen as string,
      estado: fila.estado as DesignVersionCompleta['estado'],
      servicioId: fila.servicio_id as string,
      servicioNombre: fila.servicio_nombre as string,
      proyectoId: fila.proyecto_id as string,
      proyectoCodigo: fila.proyecto_codigo as string,
      journeyId: (fila.journey_id as string | null) ?? null,
      journeyNombre: (fila.journey_nombre as string | null) ?? null,
      snapshotId: (fila.snapshot_id as string | null) ?? null,
      aprobadaEn: (fila.aprobada_en as string | null) ?? null,
      superaA: (fila.supera_a as DesignVersionCompleta['superaA']) ?? null,
      superadaPor: (fila.superada_por as DesignVersionCompleta['superadaPor']) ?? null,
      elementos: fila.elementos as DesignVersionCompleta['elementos'],
      releases: fila.releases as DesignVersionCompleta['releases'],
      nodosDelJourney: fila.nodos_del_journey as DesignVersionCompleta['nodosDelJourney'],
      journeysEnlazables: fila.journeys_enlazables as DesignVersionCompleta['journeysEnlazables'],
      decisionesDelProyecto:
        fila.decisiones_del_proyecto as DesignVersionCompleta['decisionesDelProyecto'],
      insightsValidados: fila.insights_validados as DesignVersionCompleta['insightsValidados'],
      vigente: (fila.vigente as DesignVersionCompleta['vigente']) ?? null,
    };
  });
}

export async function designVersionsDelWorkspace(
  actorId: string,
  workspaceId: string,
): Promise<ResumenDesignVersion[]> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`
      select dv.id, dv.codigo, dv.titulo, dv.estado,
        dv.servicio_id, s.nombre as servicio_nombre,
        p.codigo as proyecto_codigo,
        to_char(dv.aprobada_en, 'YYYY-MM-DD') as aprobada_en,
        (select count(*)::int from elemento_cambio ec
          where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id) as elementos,
        (select count(*)::int from release r
          where r.design_version_id = dv.id and r.workspace_id = dv.workspace_id) as releases
      from design_version dv
      join servicio s on s.id = dv.servicio_id and s.workspace_id = dv.workspace_id
      join proyecto p on p.id = dv.proyecto_id and p.workspace_id = dv.workspace_id
      where dv.workspace_id = ${workspaceId}
      order by dv.creado_en desc
      limit 200`;
    return filas.map((f) => ({
      id: f.id as string,
      codigo: f.codigo as string,
      titulo: f.titulo as string,
      estado: f.estado as ResumenDesignVersion['estado'],
      servicioId: f.servicio_id as string,
      servicioNombre: f.servicio_nombre as string,
      proyectoCodigo: f.proyecto_codigo as string,
      elementos: f.elementos as number,
      releases: f.releases as number,
      aprobadaEn: (f.aprobada_en as string | null) ?? null,
    }));
  });
}

/**
 * El tablero de conciliación (RF-06.7): elemento por elemento, dónde está en la cadena.
 * El CASE es el mismo predicado que bloquea G7 en `gate_aprobar_suficiencia_guard` — la
 * base decide, esto lo EXPLICA antes de que el lead se estrelle contra el gate.
 */
export async function tableroDeConciliacion(
  actorId: string,
  workspaceId: string,
  designVersionId: string,
): Promise<TableroConciliacion | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [dv] = await tx`select id, codigo from design_version
      where id = ${designVersionId} and workspace_id = ${workspaceId}`;
    if (!dv) return null;
    const filas = await tx`
      select ec.id, ec.titulo, ec.tipo, ec.operacion,
        r.codigo as release_codigo, r.responsable as release_responsable,
        to_char(r.fecha_objetivo, 'YYYY-MM-DD') as release_fecha,
        coalesce(re.razon, '') as razon_asignacion,
        coalesce(c.que_quedo_distinto, '') as que_quedo_distinto,
        coalesce(c.razon, '') as razon_desviacion,
        case
          when c.resultado = 'como-aprobado' then 'constatado'
          when c.resultado = 'desviado' then 'desviado'
          when c.resultado = 'no-implementado' then 'no-implementado'
          when r.estado in ('desplegado', 'verificado') then 'desplegado'
          when r.id is not null then 'en-release'
          else 'aprobado'
        end as estado
      from elemento_cambio ec
      left join release_elemento re
        on re.elemento_id = ec.id and re.workspace_id = ec.workspace_id
      left join release r on r.id = re.release_id and r.workspace_id = re.workspace_id
      -- Solo cuenta la constatación de un release VERIFICADO: es el mismo umbral que usa
      -- el guard de G7, y así el tablero nunca dice «constatado» donde el gate ve un hueco.
      left join effective_state es
        on es.release_id = r.id and es.workspace_id = r.workspace_id and r.estado = 'verificado'
      left join constatacion c
        on c.effective_state_id = es.id and c.elemento_id = ec.id
          and c.workspace_id = ec.workspace_id
      where ec.design_version_id = ${designVersionId} and ec.workspace_id = ${workspaceId}
      order by ec.orden, ec.creado_en`;
    return {
      designVersionId: dv.id as string,
      designVersionCodigo: dv.codigo as string,
      filas: filas.map((f) => ({
        elementoId: f.id as string,
        elementoTitulo: f.titulo as string,
        tipo: f.tipo as TableroConciliacion['filas'][number]['tipo'],
        operacion: f.operacion as TableroConciliacion['filas'][number]['operacion'],
        estado: f.estado as TableroConciliacion['filas'][number]['estado'],
        releaseCodigo: (f.release_codigo as string | null) ?? null,
        releaseResponsable: (f.release_responsable as string | null) ?? null,
        releaseFecha: (f.release_fecha as string | null) ?? null,
        razonAsignacion: f.razon_asignacion as string,
        queQuedoDistinto: f.que_quedo_distinto as string,
        razonDesviacion: f.razon_desviacion as string,
      })),
    };
  });
}

export type CadenaDeRelease = {
  releaseId: string;
  codigo: string;
  /** §19.7 / criterio de aceptación 5: qué pasos del journey afectó este release. */
  pasos: { nodoId: string; tipo: string; etiqueta: string; elementoTitulo: string }[];
  /** El otro sentido de RF-06.9: del resultado hacia atrás, hasta las citas. */
  citas: {
    evidenciaId: string;
    evidenciaTitulo: string;
    fragmento: string;
    localizacion: string;
    insightTitulo: string;
  }[];
};

/**
 * Navegación bidireccional de la cadena (RF-06.9) anclada en el release: hacia adelante,
 * qué nodos del grafo tocó; hacia atrás, hasta las citas que sostienen las decisiones e
 * insights que motivaron sus elementos. Una sola sentencia porque las dos direcciones
 * son la misma pregunta desde extremos opuestos y tienen que cuadrar.
 */
export async function cadenaDeRelease(
  actorId: string,
  workspaceId: string,
  releaseId: string,
): Promise<CadenaDeRelease | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await tx`
      select r.id, r.codigo,
        coalesce((
          select jsonb_agg(distinct jsonb_build_object(
            'nodoId', n.id, 'tipo', n.tipo, 'etiqueta', n.etiqueta,
            'elementoTitulo', ec.titulo))
          from release_elemento re
          join elemento_cambio ec on ec.id = re.elemento_id and ec.workspace_id = re.workspace_id
          join journey_nodo n on n.id = ec.nodo_id and n.workspace_id = ec.workspace_id
          where re.release_id = r.id and re.workspace_id = r.workspace_id
        ), '[]'::jsonb) as pasos,
        coalesce((
          select jsonb_agg(distinct jsonb_build_object(
            'evidenciaId', e.id, 'evidenciaTitulo', e.titulo, 'fragmento', ci.fragmento,
            'localizacion', ci.localizacion, 'insightTitulo', i.titulo))
          from release_elemento re
          join elemento_cambio ec on ec.id = re.elemento_id and ec.workspace_id = re.workspace_id
          -- Los dos caminos de la cadena hasta el insight: el elemento lo cita directo,
          -- o lo cita la decisión que lo motivó.
          join insight i on i.workspace_id = ec.workspace_id and (
            exists (select 1 from elemento_insight ei
              where ei.elemento_id = ec.id and ei.insight_id = i.id
                and ei.workspace_id = ec.workspace_id)
            or exists (select 1 from elemento_decision ed
              join decision_insight di on di.decision_id = ed.decision_id
                and di.workspace_id = ed.workspace_id
              where ed.elemento_id = ec.id and di.insight_id = i.id
                and ed.workspace_id = ec.workspace_id))
          join afirmacion af on af.insight_id = i.id and af.workspace_id = i.workspace_id
          join cita ci on ci.afirmacion_id = af.id and ci.workspace_id = af.workspace_id
          join evidencia e on e.id = ci.evidencia_id and e.workspace_id = ci.workspace_id
          where re.release_id = r.id and re.workspace_id = r.workspace_id
        ), '[]'::jsonb) as citas
      from release r
      where r.id = ${releaseId} and r.workspace_id = ${workspaceId}`;
    if (!fila) return null;
    return {
      releaseId: fila.id as string,
      codigo: fila.codigo as string,
      pasos: fila.pasos as CadenaDeRelease['pasos'],
      citas: fila.citas as CadenaDeRelease['citas'],
    };
  });
}
