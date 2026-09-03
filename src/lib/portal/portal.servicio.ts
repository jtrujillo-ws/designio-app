import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { ErrorAutorizacion, exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import {
  ROLES_AUDITORIA,
  type AbrirHilo,
  type Comentar,
  type ComentarioDeHilo,
  type EventoAuditoria,
  type HiloDeObjeto,
  type ObjetoCitable,
  type PaginaAuditoria,
  type ReferenciaObjeto,
  type ResolverHilo,
} from './portal.schemas';

/**
 * Portal de comentarios (RF-01.5) y auditoría consultable (RF-01.6). Capa 1: RLS — los
 * hilos los lee todo miembro y los abre y comenta cualquier miembro HUMANO (el portal es
 * el canal del cliente: sponsor y stakeholder incluidos), resolverlos es de curadores,
 * los comentarios son append-only y la auditoría solo la leen admin-cliente y
 * lead-boutique. Capa 2: estado ACTUAL de la cuenta en toda operación (el JWT vive 7
 * días) y el re-check del rol que consulta la auditoría, para responder con un motivo en
 * vez de una lista vacía.
 */

export class ErrorPortal extends Error {}

export const HILOS_POR_CONSULTA = 100;
export const COMENTARIOS_POR_HILO = 100;
export const PAGINA_AUDITORIA = 50;

/**
 * Abrir hilo = hilo + su primer comentario (RF-01.5). Son DOS sentencias, no una con
 * CTEs como el resto del repo: el WITH CHECK del comentario exige que su hilo esté
 * abierto y las sub-sentencias de un WITH comparten snapshot — no verían el hilo recién
 * insertado por su hermana. No hay deriva de atribución por separarlas: el rol auditado
 * no lo elige el caller, lo fija la política del comentario en el mismo snapshot que
 * autoriza el insert.
 */
export async function abrirHilo(
  actorId: string,
  entrada: AbrirHilo,
): Promise<{ hiloId: string; comentarioId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const { tipo, id } = entrada.objeto;
    let hiloId: string;
    try {
      // El arco exclusivo viaja explícito (una columna por tipo): sin identificadores
      // dinámicos y con la FK compuesta de cada padre rechazando el objeto ajeno.
      const [hilo] = await tx`
        insert into hilo_comentario
          (workspace_id, reto_id, proyecto_id, gate_id, evidencia_id, design_version_id,
           abierto_por)
        values (${entrada.workspaceId},
                ${tipo === 'reto' ? id : null},
                ${tipo === 'proyecto' ? id : null},
                ${tipo === 'gate_instancia' ? id : null},
                ${tipo === 'evidencia' ? id : null},
                ${tipo === 'design_version' ? id : null},
                ${actorId})
        returning id`;
      hiloId = hilo!.id as string;
    } catch (e) {
      throw traducirEscritura(e, 'Tu rol no abre hilos en el portal de este workspace');
    }
    try {
      const [comentario] = await tx`
        insert into comentario (workspace_id, hilo_id, cuerpo, autor_id, autor_rol)
        select ${entrada.workspaceId}, ${hiloId}, ${entrada.cuerpo}, ${actorId},
               workspace_role(${actorId}, ${entrada.workspaceId})
        returning id`;
      return { hiloId, comentarioId: comentario!.id as string };
    } catch (e) {
      throw traducirEscritura(e, 'Tu rol no comenta en el portal de este workspace');
    }
  });
}

/** Candado consultivo por hilo: comentar y resolver deben serializarse entre sí — bajo
 * READ COMMITTED cada sentencia decisora lee un snapshot que no ve el write concurrente
 * de la otra, así que sin él podrían commitear juntos un hilo resuelto con un comentario
 * posterior. Lo toman ambos lados ANTES de su sentencia decisora; para las escrituras
 * por SQL directo (que no pasan por aquí) el guard de fila de la base repite el veredicto. */
async function bloquearHilo(tx: TransactionSql, hiloId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:hilo:' || ${hiloId}, 42))`;
}

export async function comentar(
  actorId: string,
  entrada: Comentar,
): Promise<{ comentarioId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Candado ANTES de leer: así el estado leído para el mensaje ya es el definitivo.
    await bloquearHilo(tx, entrada.hiloId);
    const [hilo] = await tx`select estado from hilo_comentario
      where id = ${entrada.hiloId} and workspace_id = ${entrada.workspaceId}`;
    // El pre-chequeo existe por el MENSAJE: un WITH CHECK violado aborta la transacción
    // y ya no deja diagnosticar nada después.
    if (!hilo) throw new ErrorPortal('El hilo no existe en este workspace');
    if ((hilo.estado as string) === 'resuelto') {
      throw new ErrorPortal(
        'El hilo está resuelto: un curador debe reabrirlo para seguir la conversación',
      );
    }
    try {
      const [fila] = await tx`
        insert into comentario (workspace_id, hilo_id, cuerpo, autor_id, autor_rol)
        select ${entrada.workspaceId}, ${entrada.hiloId}, ${entrada.cuerpo}, ${actorId},
               workspace_role(${actorId}, ${entrada.workspaceId})
        returning id`;
      return { comentarioId: fila!.id as string };
    } catch (e) {
      throw traducirEscritura(e, 'Tu rol no comenta en el portal de este workspace');
    }
  });
}

/** Resolver o reabrir (RF-01.5): la transición es la sentencia decisora — 0 filas
 * significa que el hilo no existe, ya estaba en ese estado o quien lo pide no es curador,
 * y el diagnóstico posterior dice cuál de las tres. El sello (quién y cuándo) lo pone el
 * guard de la base, no este servicio: ni por SQL directo se atribuye a otra persona. */
export async function resolverHilo(actorId: string, entrada: ResolverHilo): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const pedido = entrada.accion === 'resolver' ? 'resuelto' : 'abierto';
    const previo = entrada.accion === 'resolver' ? 'abierto' : 'resuelto';
    await bloquearHilo(tx, entrada.hiloId);
    const filas = await tx`
      update hilo_comentario set estado = ${pedido}
      where id = ${entrada.hiloId} and workspace_id = ${entrada.workspaceId}
        and estado = ${previo}`;
    if (filas.count === 0) {
      const [hilo] = await tx`select estado from hilo_comentario
        where id = ${entrada.hiloId} and workspace_id = ${entrada.workspaceId}`;
      if (!hilo) throw new ErrorPortal('El hilo no existe en este workspace');
      if ((hilo.estado as string) === pedido) {
        throw new ErrorPortal(
          pedido === 'resuelto' ? 'El hilo ya estaba resuelto' : 'El hilo ya estaba abierto',
        );
      }
      throw new ErrorPortal('Solo lead-boutique o diseñador resuelven o reabren hilos');
    }
  });
}

/** Hilos de los objetos que una pantalla presenta, en UNA sentencia (un snapshot, orden
 * estable). El nombre del autor sale de `miembro` y no de `usuario`: la RLS de usuario
 * solo muestra la fila propia — un join directo dejaría todos los comentarios sin firma. */
export async function hilosDeObjetos(
  actorId: string,
  workspaceId: string,
  objetos: ReferenciaObjeto[],
): Promise<{ hilos: HiloDeObjeto[]; hayMas: boolean }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`
      select h.id, h.objeto_tipo, h.objeto_id, h.estado,
             h.creado_en::text as creado_en, h.resuelto_en::text as resuelto_en,
             ma.nombre as abierto_por_nombre, mr.nombre as resuelto_por_nombre,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                   'id', c.id, 'cuerpo', c.cuerpo,
                   'autorNombre', coalesce(mc.nombre, 'Miembro retirado'),
                   'autorRol', c.autor_rol, 'creadoEn', c.creado_en::text)
                 order by c.creado_en, c.id)
               from (select cc.id, cc.cuerpo, cc.autor_id, cc.autor_rol, cc.creado_en
                     from comentario cc
                     where cc.hilo_id = h.id and cc.workspace_id = h.workspace_id
                     order by cc.creado_en, cc.id
                     limit ${COMENTARIOS_POR_HILO + 1}) c
               left join miembro mc
                 on mc.workspace_id = h.workspace_id and mc.usuario_id = c.autor_id
             ), '[]'::jsonb) as comentarios
      from hilo_comentario h
      join jsonb_to_recordset(${tx.json(objetos)}) as r(tipo text, id uuid)
        on r.tipo = h.objeto_tipo and r.id = h.objeto_id
      left join miembro ma on ma.workspace_id = h.workspace_id and ma.usuario_id = h.abierto_por
      left join miembro mr on mr.workspace_id = h.workspace_id and mr.usuario_id = h.resuelto_por
      where h.workspace_id = ${workspaceId}
      order by h.creado_en desc, h.id desc
      limit ${HILOS_POR_CONSULTA + 1}`;

    return {
      hilos: filas.slice(0, HILOS_POR_CONSULTA).map((f) => {
        const todos = f.comentarios as ComentarioDeHilo[];
        return {
          id: f.id as string,
          objetoTipo: f.objeto_tipo as ObjetoCitable,
          objetoId: f.objeto_id as string,
          estado: f.estado as HiloDeObjeto['estado'],
          creadoEn: f.creado_en as string,
          abiertoPorNombre: (f.abierto_por_nombre as string | null) ?? 'Miembro retirado',
          resueltoPorNombre: f.resuelto_por_nombre as string | null,
          resueltoEn: f.resuelto_en as string | null,
          comentarios: todos.slice(0, COMENTARIOS_POR_HILO),
          hayMasComentarios: todos.length > COMENTARIOS_POR_HILO,
        };
      }),
      hayMas: filas.length > HILOS_POR_CONSULTA,
    };
  });
}

/**
 * Auditoría del workspace (RF-01.6): los eventos append-only con su actor y rol, filtrables
 * por tipo y paginados por keyset (creado_en, id) — estable ante los eventos que siguen
 * llegando mientras se pagina, a diferencia de un offset. El cursor viaja como id y su
 * (creado_en, id) se resuelve en la base.
 */
export async function listarAuditoria(
  actorId: string,
  workspaceId: string,
  filtro: { tipo?: string; antesDe?: string },
): Promise<PaginaAuditoria> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Capa 2 con MOTIVO: la RLS ya devolvería cero filas a los demás roles, pero una
    // lista vacía y «no te corresponde» no son lo mismo para quien mira la pantalla.
    const [quien] = await tx`select workspace_role(${actorId}, ${workspaceId}) as rol`;
    const rol = (quien?.rol ?? null) as string | null;
    if (!rol || !(ROLES_AUDITORIA as readonly string[]).includes(rol)) {
      throw new ErrorAutorizacion(
        'La auditoría del workspace la consultan el admin del cliente y el lead de la boutique',
      );
    }

    const filas = await tx`
      select e.id, e.tipo, e.payload::text as payload, e.actor_id, e.actor_rol,
             e.creado_en::text as creado_en, m.nombre as actor_nombre
      from evento_dominio e
      left join miembro m on m.workspace_id = e.workspace_id and m.usuario_id = e.actor_id
      where e.workspace_id = ${workspaceId}
        ${filtro.tipo ? tx`and e.tipo = ${filtro.tipo}` : tx``}
        ${filtro.antesDe
          ? tx`and (e.creado_en, e.id) < (select e2.creado_en, e2.id from evento_dominio e2
                where e2.id = ${filtro.antesDe} and e2.workspace_id = ${workspaceId})`
          : tx``}
      order by e.creado_en desc, e.id desc
      limit ${PAGINA_AUDITORIA + 1}`;

    // El catálogo de tipos solo en la primera página: es para poblar el filtro, no para
    // repetirlo en cada scroll.
    const tipos = filtro.antesDe
      ? []
      : (
          await tx`select distinct tipo from evento_dominio
            where workspace_id = ${workspaceId} order by tipo`
        ).map((f) => f.tipo as string);

    return {
      eventos: filas.slice(0, PAGINA_AUDITORIA).map(
        (f): EventoAuditoria => ({
          id: f.id as string,
          tipo: f.tipo as string,
          payload: f.payload as string,
          actorId: f.actor_id as string | null,
          actorNombre: f.actor_nombre as string | null,
          actorRol: f.actor_rol as string | null,
          creadoEn: f.creado_en as string,
        }),
      ),
      hayMas: filas.length > PAGINA_AUDITORIA,
      tipos,
    };
  });
}

/** Traduce los rechazos de la base al contrato del módulo. El guard de fila habla ANTES
 * que el WITH CHECK (P0001) cuando una resolución concurrente ya commiteó. */
function traducirEscritura(e: unknown, mensajeRol: string): unknown {
  const err = e as { code?: string; message?: string };
  if (err.code === 'P0001' && err.message?.includes('resuelto')) {
    return new ErrorPortal('El hilo se resolvió mientras escribías: pide reabrirlo');
  }
  if (err.code === '42501') return new ErrorPortal(mensajeRol);
  // FK compuesta: el objeto comentado no existe en ESTE workspace (o no existe).
  if (err.code === '23503') return new ErrorPortal('El objeto comentado no existe en este workspace');
  if (err.code === '23514') return new ErrorPortal('El comentario supera los límites permitidos');
  return e;
}
