import '@/lib/server-only';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import type { CrearServicio } from './arbol.schemas';

/**
 * Escrituras del árbol (SPEC-02). Hoy, una: dar de alta un servicio, que es donde el árbol
 * nace (ADR-0002). Capa 1: la política `servicio_insert` (rol, autoría, estado). Capa 2:
 * estado de cuenta y las validaciones de dominio de este módulo, con el evento y su rol
 * auditado en LA MISMA sentencia que el alta.
 */

export class ErrorArbol extends Error {}

export async function crearServicio(
  actorId: string,
  entrada: CrearServicio,
): Promise<{ servicioId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Dos servicios con el mismo nombre en un workspace son el mismo árbol con dos entradas
    // iguales: nadie sabe cuál abrir. La base no lo prohíbe (podría haber datos así de
    // antes), pero la app no fabrica uno más. La comparación ignora mayúsculas porque
    // «Apertura de cuenta» y «apertura de cuenta» tampoco se distinguen al leer.
    //
    // La comprobación va detrás de un candado por (workspace, nombre normalizado) que dura la
    // transacción: sin él, dos altas simultáneas del mismo nombre pasan las dos el SELECT
    // antes de que ninguna inserte, y nacen dos servicios y dos eventos. No es un índice
    // único porque la historia puede traer duplicados de antes de esta regla y una migración
    // que no pudiera crearlo dejaría la regla sin dueño; el candado gobierna lo que la app
    // crea desde hoy, que es exactamente lo que esta función promete.
    await tx`select pg_advisory_xact_lock(
      hashtextextended('designio:servicio-nombre:' || ${entrada.workspaceId} || ':' || lower(${entrada.nombre}), 42))`;
    const [repetido] = await tx`select 1 from servicio
      where workspace_id = ${entrada.workspaceId} and lower(nombre) = lower(${entrada.nombre})
      limit 1`;
    if (repetido) throw new ErrorArbol('Ya hay un servicio con ese nombre en este workspace');

    // UNA sentencia: servicio + evento comparten snapshot, y el rol auditado es el que
    // autorizó el insert (misma disciplina que el alta de retos).
    const [fila] = await tx`
      with quien as (
        select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
      ),
      nuevo as (
        insert into servicio (workspace_id, nombre, descripcion, creado_por)
        values (${entrada.workspaceId}, ${entrada.nombre}, ${entrada.descripcion}, ${actorId})
        returning id
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${entrada.workspaceId}, 'ServicioCreado',
               jsonb_build_object('servicioId', nuevo.id, 'nombre', ${entrada.nombre}::text),
               ${actorId}, quien.rol
        from nuevo, quien
      )
      select nuevo.id from nuevo`;
    return { servicioId: fila!.id as string };
  });
}
