import '@/lib/server-only';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { TIPOS_CON_CATALOGO } from './journey.schemas';
import type {
  AgregarArista,
  AgregarNodo,
  CrearJourney,
  EditarNodo,
  JourneyCompleto,
  ResumenJourney,
} from './journey.schemas';

/**
 * Journeys como grafo tipado (SPEC-05). Capa 1: RLS — miembros leen (el journey es el
 * lenguaje común con el cliente) y curadores escriben; los guards de la base impiden que
 * una arista o una fase crucen de journey (las FKs compuestas garantizan el workspace,
 * no el journey) y que los extremos de una arista no encajen con su tipo.
 * Capa 2: estado de cuenta en toda operación y traducción de guards al contrato.
 *
 * El grafo de trabajo NO se cierra al congelar (RF-05.8): lo inmutable es el snapshot.
 *
 * El grafo se lee ENTERO en una sentencia: las vistas (Mermaid, tabla, carriles) y la
 * validación son funciones puras sobre esa proyección, así que todas ven exactamente el
 * mismo estado — no puede pasar que el diagrama muestre un paso que la validación ya no
 * ve.
 */

export class ErrorJourney extends Error {}

function comoErrorDeDominio(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code === 'P0001' && err.message) throw new ErrorJourney(err.message);
  if (err.code === '23503') throw new ErrorJourney('Alguna referencia no existe en este workspace');
  if (err.code === '23505') throw new ErrorJourney('Ese elemento ya existe en el journey');
  if (err.code === '42501') throw new ErrorJourney('No puedes editar el grafo de este workspace');
  throw e;
}

export async function crearJourney(
  actorId: string,
  entrada: CrearJourney,
): Promise<{ journeyId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let fila;
    try {
      [fila] = await tx`
        with quien as (
          select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
        ),
        nuevo as (
          insert into journey (workspace_id, servicio_id, reto_id, tipo, nombre,
                               descripcion, creado_por)
          values (${entrada.workspaceId}, ${entrada.servicioId}, ${entrada.retoId},
                  ${entrada.tipo}, ${entrada.nombre}, ${entrada.descripcion}, ${actorId})
          returning id
        ),
        evento as (
          insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
          select ${entrada.workspaceId}, 'JourneyCreado',
            jsonb_build_object('journeyId', nuevo.id, 'tipo', ${entrada.tipo}::text,
                               'nombre', ${entrada.nombre}::text),
            ${actorId}, quien.rol
          from nuevo, quien
        )
        select id from nuevo`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (!fila) throw new ErrorJourney('No puedes crear journeys en este workspace');
    return { journeyId: fila.id as string };
  });
}

export async function agregarNodo(
  actorId: string,
  entrada: AgregarNodo,
): Promise<{ nodoId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El orden es un max()+1: dos altas concurrentes del mismo tipo leerían el mismo
    // máximo y nacerían empatadas. El candado por (journey, tipo) las serializa —
    // mismo espacio de nombres que los del método. Es de transacción: se suelta al
    // commit y no bloquea altas de otro journey ni de otro tipo.
    await tx`select pg_advisory_xact_lock(
      hashtextextended('designio:journey-orden:' || ${entrada.journeyId} || ':' || ${entrada.tipo}, 42))`;
    // Los tipos que son entidades del workspace se cuelgan del catálogo: si ya existe
    // uno con ese nombre se REUSA, y así el mismo sistema en el as-is y en el to-be es
    // el mismo objeto. El upsert va en su propia sentencia porque la del nodo necesita
    // ver la fila (las sub-consultas de un WITH comparten snapshot y no la verían).
    let catalogoId: string | null = null;
    if (TIPOS_CON_CATALOGO.includes(entrada.tipo)) {
      try {
        const [cat] = await tx`
          with existente as (
            select id from catalogo_journey
            where workspace_id = ${entrada.workspaceId} and tipo = ${entrada.tipo}
              and nombre = ${entrada.etiqueta}
          ),
          nueva as (
            insert into catalogo_journey (workspace_id, tipo, nombre, creado_por)
            select ${entrada.workspaceId}, ${entrada.tipo}, ${entrada.etiqueta}, ${actorId}
            where not exists (select 1 from existente)
            returning id
          )
          select id from existente union all select id from nueva`;
        if (!cat) throw new ErrorJourney('No puedes crear elementos de catálogo en este workspace');
        catalogoId = cat.id as string;
      } catch (e) {
        if (e instanceof ErrorJourney) throw e;
        comoErrorDeDominio(e);
      }
    }
    let fila;
    try {
      [fila] = await tx`
        insert into journey_nodo (workspace_id, journey_id, tipo, etiqueta, detalle,
                                  fase_id, orden, responsable, catalogo_id, creado_por)
        select ${entrada.workspaceId}, ${entrada.journeyId}, ${entrada.tipo},
          ${entrada.etiqueta}, ${entrada.detalle}, ${entrada.faseId},
          coalesce((select max(orden) + 1 from journey_nodo n
            where n.journey_id = ${entrada.journeyId}
              and n.workspace_id = ${entrada.workspaceId}
              and n.tipo = ${entrada.tipo}), 0),
          ${entrada.responsable}, ${catalogoId}, ${actorId}
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (!fila) throw new ErrorJourney('El journey no existe o no puedes editarlo');
    return { nodoId: fila.id as string };
  });
}

export async function editarNodo(actorId: string, entrada: EditarNodo): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let filas;
    try {
      // Renombrar una entidad la renombra EN TODAS PARTES: es lo que se gana al darle
      // identidad. El catálogo se actualiza en la misma transacción que el nodo.
      await tx`
        update catalogo_journey c
        set nombre = ${entrada.etiqueta}
        from journey_nodo n
        where n.id = ${entrada.nodoId} and n.workspace_id = ${entrada.workspaceId}
          and c.id = n.catalogo_id and c.workspace_id = n.workspace_id`;
      filas = await tx`
        update journey_nodo
        set etiqueta = ${entrada.etiqueta}, detalle = ${entrada.detalle},
            fase_id = ${entrada.faseId}, orden = ${entrada.orden},
            responsable = ${entrada.responsable}
        where id = ${entrada.nodoId} and workspace_id = ${entrada.workspaceId}`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (filas!.count === 0) {
      throw new ErrorJourney('El nodo no existe o no puedes editarlo');
    }
  });
}

export async function borrarNodo(
  actorId: string,
  workspaceId: string,
  nodoId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Las aristas y los enlaces de evidencia del nodo se van con él: dejarlos sería
    // dejar flechas que apuntan al vacío. Se borran explícitamente porque las FKs no
    // tienen cascade (borrar en cascada por accidente es peor que fallar).
    await tx`delete from journey_arista
      where workspace_id = ${workspaceId} and (origen_id = ${nodoId} or destino_id = ${nodoId})`;
    await tx`delete from journey_nodo_evidencia
      where workspace_id = ${workspaceId} and nodo_id = ${nodoId}`;
    // Los nodos que colgaban de esta fase quedan sueltos (la validación los reporta),
    // que es más honesto que borrarlos en cadena sin que nadie lo pidiera.
    await tx`update journey_nodo set fase_id = null
      where workspace_id = ${workspaceId} and fase_id = ${nodoId}`;
    const filas = await tx`delete from journey_nodo
      where id = ${nodoId} and workspace_id = ${workspaceId}`;
    if (filas.count === 0) {
      throw new ErrorJourney('El nodo no existe o no puedes borrarlo');
    }
  });
}

export async function agregarArista(
  actorId: string,
  entrada: AgregarArista,
): Promise<{ aristaId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let fila;
    try {
      [fila] = await tx`
        insert into journey_arista (workspace_id, journey_id, origen_id, destino_id,
                                    tipo, condicion, creado_por)
        values (${entrada.workspaceId}, ${entrada.journeyId}, ${entrada.origenId},
                ${entrada.destinoId}, ${entrada.tipo}, ${entrada.condicion}, ${actorId})
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (!fila) throw new ErrorJourney('El journey no existe o no puedes editarlo');
    return { aristaId: fila.id as string };
  });
}

export async function borrarArista(
  actorId: string,
  workspaceId: string,
  aristaId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`delete from journey_arista
      where id = ${aristaId} and workspace_id = ${workspaceId}`;
    if (filas.count === 0) {
      throw new ErrorJourney('La arista no existe o no puedes borrarla');
    }
  });
}

export async function enlazarEvidenciaANodo(
  actorId: string,
  workspaceId: string,
  nodoId: string,
  evidenciaId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    try {
      const filas = await tx`
        insert into journey_nodo_evidencia (nodo_id, evidencia_id, workspace_id, creado_por)
        values (${nodoId}, ${evidenciaId}, ${workspaceId}, ${actorId})
        returning nodo_id`;
      if (filas.length === 0) {
        throw new ErrorJourney('No puedes enlazar evidencia en este workspace');
      }
    } catch (e) {
      if (e instanceof ErrorJourney) throw e;
      comoErrorDeDominio(e);
    }
  });
}

/** Quitar un enlace de evidencia (RF-05.9): enlazar mal es un error corriente, y sin
 * esta operación la única salida era borrar el nodo entero y perder sus aristas. La
 * migración ya concedía el delete y auditaba el desenlace; faltaba la puerta. */
export async function desenlazarEvidenciaDeNodo(
  actorId: string,
  workspaceId: string,
  nodoId: string,
  evidenciaId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`delete from journey_nodo_evidencia
      where nodo_id = ${nodoId} and evidencia_id = ${evidenciaId}
        and workspace_id = ${workspaceId}`;
    if (filas.count === 0) {
      throw new ErrorJourney('Ese enlace no existe o no puedes quitarlo');
    }
  });
}

/**
 * Congelar un snapshot (RF-05.8, SYS-05): serializa el grafo COMPLETO —nodos, aristas y
 * los enlaces de evidencia— en un registro inmutable. Sin la evidencia, el snapshot no
 * podría reconstruir qué sostenía cada paso cuando se aprobó, que es justo lo que se le
 * pedirá al auditarlo.
 *
 * NO cierra el journey. RF-05.8 es explícito: «el grafo de trabajo continúa editable
 * para el ciclo siguiente». Lo inmutable es el snapshot; el journey es el modelo vivo.
 */
export async function congelarSnapshot(
  actorId: string,
  workspaceId: string,
  journeyId: string,
  motivo: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let filas;
    try {
      filas = await tx`
      with quien as (
        select workspace_role(${actorId}, ${workspaceId}) as rol
      ),
      grafo as (
        select jsonb_build_object(
          'nodos', coalesce((select jsonb_agg(to_jsonb(n) order by n.orden)
            from journey_nodo n
            where n.journey_id = ${journeyId} and n.workspace_id = ${workspaceId}), '[]'::jsonb),
          'aristas', coalesce((select jsonb_agg(to_jsonb(a) order by a.creado_en)
            from journey_arista a
            where a.journey_id = ${journeyId} and a.workspace_id = ${workspaceId}), '[]'::jsonb),
          -- La cadena de evidencia va DENTRO del snapshot: un grafo aprobado que no
          -- puede decir qué sostenía cada paso no sirve para auditarlo después.
          'evidencias', coalesce((select jsonb_agg(jsonb_build_object(
              'nodoId', ne.nodo_id, 'evidenciaId', ne.evidencia_id,
              'evidenciaTitulo', e.titulo) order by ne.creado_en)
            from journey_nodo_evidencia ne
            join journey_nodo n2 on n2.id = ne.nodo_id and n2.workspace_id = ne.workspace_id
            join evidencia e on e.id = ne.evidencia_id and e.workspace_id = ne.workspace_id
            where n2.journey_id = ${journeyId} and ne.workspace_id = ${workspaceId}), '[]'::jsonb)
        ) as contenido
      ),
      vivo as (
        select j.id from journey j
        where j.id = ${journeyId} and j.workspace_id = ${workspaceId}
      ),
      snap as (
        insert into journey_snapshot (workspace_id, journey_id, motivo, grafo, congelado_por)
        select ${workspaceId}, vivo.id, ${motivo}, grafo.contenido, ${actorId}
        from vivo, grafo
        returning id
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${workspaceId}, 'JourneySnapshotCongelado',
          jsonb_build_object('journeyId', ${journeyId}::uuid, 'snapshotId', snap.id),
          ${actorId}, quien.rol
        from snap, quien
      )
      select id from snap`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (filas!.length === 0) {
      throw new ErrorJourney('El journey no existe o no puedes congelar su grafo');
    }
  });
}

/** El grafo COMPLETO en una sentencia: todas las vistas derivan del mismo snapshot. */
export async function journeyCompleto(
  actorId: string,
  workspaceId: string,
  journeyId: string,
): Promise<JourneyCompleto | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await tx`
      select j.id, j.servicio_id, s.nombre as servicio_nombre, j.reto_id, j.tipo,
        j.nombre, j.descripcion,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', n.id, 'tipo', n.tipo, 'etiqueta', n.etiqueta, 'detalle', n.detalle,
            'faseId', n.fase_id, 'orden', n.orden, 'responsable', n.responsable,
            'catalogoId', n.catalogo_id,
            'evidencias', coalesce((
              select jsonb_agg(jsonb_build_object('id', e.id, 'titulo', e.titulo)
                order by e.titulo)
              from journey_nodo_evidencia ne
              join evidencia e on e.id = ne.evidencia_id and e.workspace_id = ne.workspace_id
              where ne.nodo_id = n.id and ne.workspace_id = n.workspace_id
            ), '[]'::jsonb))
            order by n.tipo, n.orden)
          from journey_nodo n
          where n.journey_id = j.id and n.workspace_id = j.workspace_id
        ), '[]'::jsonb) as nodos,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', a.id, 'origenId', a.origen_id, 'destinoId', a.destino_id,
            'tipo', a.tipo, 'condicion', a.condicion)
            order by a.creado_en)
          from journey_arista a
          where a.journey_id = j.id and a.workspace_id = j.workspace_id
        ), '[]'::jsonb) as aristas,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', sn.id, 'motivo', sn.motivo,
            'congeladoEn', to_char(sn.congelado_en, 'YYYY-MM-DD'))
            order by sn.congelado_en desc)
          from journey_snapshot sn
          where sn.journey_id = j.id and sn.workspace_id = j.workspace_id
        ), '[]'::jsonb) as snapshots
      from journey j
      join servicio s on s.id = j.servicio_id and s.workspace_id = j.workspace_id
      where j.id = ${journeyId} and j.workspace_id = ${workspaceId}`;
    if (!fila) return null;
    return {
      id: fila.id as string,
      servicioId: fila.servicio_id as string,
      servicioNombre: fila.servicio_nombre as string,
      retoId: (fila.reto_id as string | null) ?? null,
      tipo: fila.tipo as JourneyCompleto['tipo'],
      nombre: fila.nombre as string,
      descripcion: fila.descripcion as string,
      nodos: fila.nodos as JourneyCompleto['nodos'],
      aristas: fila.aristas as JourneyCompleto['aristas'],
      snapshots: fila.snapshots as JourneyCompleto['snapshots'],
    };
  });
}

export async function journeysDelWorkspace(
  actorId: string,
  workspaceId: string,
): Promise<ResumenJourney[]> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`
      select j.id, j.nombre, j.tipo, s.nombre as servicio_nombre,
        (select count(*)::int from journey_nodo n
          where n.journey_id = j.id and n.workspace_id = j.workspace_id) as nodos,
        (select count(*)::int from journey_snapshot sn
          where sn.journey_id = j.id and sn.workspace_id = j.workspace_id) as snapshots
      from journey j
      join servicio s on s.id = j.servicio_id and s.workspace_id = j.workspace_id
      where j.workspace_id = ${workspaceId}
      order by j.creado_en desc
      limit 200`;
    return filas.map((f) => ({
      id: f.id as string,
      nombre: f.nombre as string,
      tipo: f.tipo as ResumenJourney['tipo'],
      servicioNombre: f.servicio_nombre as string,
      nodos: f.nodos as number,
      snapshots: f.snapshots as number,
    }));
  });
}
