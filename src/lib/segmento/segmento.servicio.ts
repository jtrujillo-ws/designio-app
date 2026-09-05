import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { puedeEditarSegmentos, type CrearSegmento, type EditarSegmento } from './segmento.schemas';

/**
 * Escrituras sobre la taxonomía del cliente (RF-01.7): dar de alta un segmento y editar su
 * nombre o definición.
 *
 * Capa 1: la política `segmento_todo` — membresía, nada más. Capa 2, y aquí vive la regla
 * de negocio: estado de cuenta, el ROL que puede reescribir la taxonomía (lead o admin del
 * cliente; ver ROLES_EDITAN_SEGMENTOS), y el nombre único por workspace. Cada escritura deja
 * su evento en `evento_dominio` en LA MISMA sentencia, con el rol que la autorizó.
 *
 * No hay borrado: un segmento lo citan evidencia congelada y arquetipos con veredicto, y las
 * FKs compuestas lo impiden a propósito (ver la migración de evidencia). Renombrar sí se
 * permite —el nombre es un rótulo, la identidad es el id—, y la evidencia conserva en su
 * jsonb el snapshot con el que se curó.
 */

export class ErrorSegmento extends Error {}

/** El rol del actor en el workspace, si puede editar la taxonomía; si no, error claro. */
async function rolQueEdita(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
): Promise<string> {
  const [fila] = await tx`select workspace_role(${actorId}, ${workspaceId}) as rol`;
  const rol = (fila?.rol ?? null) as string | null;
  if (!rol || !puedeEditarSegmentos(rol)) {
    throw new ErrorSegmento(
      'Solo el lead de la boutique o el admin del cliente definen segmentos en este workspace',
    );
  }
  return rol;
}

/**
 * Dos segmentos con el mismo nombre en un workspace son dos ejes que miden lo mismo y nadie
 * sabe cuál elegir al mapear un arquetipo. La base no lo impone (la tabla es de las primeras
 * del esquema y podría haber datos así de antes), así que se impone aquí, ignorando
 * mayúsculas porque «Pymes» y «pymes» tampoco se distinguen al leer.
 *
 * La comprobación va detrás de un candado por (workspace, nombre normalizado) que dura la
 * transacción: sin él, dos escrituras simultáneas del mismo nombre pasan las dos el SELECT
 * antes de que ninguna escriba. Mismo patrón —y misma razón para no usar un índice único—
 * que el alta de servicios.
 */
async function exigirNombreLibre(
  tx: TransactionSql,
  workspaceId: string,
  nombre: string,
  excluirId?: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:segmento-nombre:' || ${workspaceId} || ':' || lower(${nombre}), 42))`;
  const [repetido] = await tx`select 1 from segmento
    where workspace_id = ${workspaceId} and lower(nombre) = lower(${nombre})
      and id is distinct from ${excluirId ?? null}::uuid
    limit 1`;
  if (repetido) throw new ErrorSegmento('Ya hay un segmento con ese nombre en este workspace');
}

export async function crearSegmento(
  actorId: string,
  entrada: CrearSegmento,
): Promise<{ segmentoId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const rol = await rolQueEdita(tx, actorId, entrada.workspaceId);
    await exigirNombreLibre(tx, entrada.workspaceId, entrada.nombre);
    // UNA sentencia: segmento + evento comparten snapshot, y el rol auditado es el que pasó
    // la comprobación de arriba en esta misma transacción.
    const [fila] = await tx`
      with nuevo as (
        insert into segmento (workspace_id, nombre, definicion)
        values (${entrada.workspaceId}, ${entrada.nombre}, ${entrada.definicion})
        returning id
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${entrada.workspaceId}, 'SegmentoDefinido',
               jsonb_build_object('segmentoId', nuevo.id, 'nombre', ${entrada.nombre}::text),
               ${actorId}, ${rol}::text
        from nuevo
      )
      select nuevo.id from nuevo`;
    if (!fila) throw new ErrorSegmento('No puedes definir segmentos en este workspace');
    return { segmentoId: fila.id as string };
  });
}

export async function editarSegmento(actorId: string, entrada: EditarSegmento): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const rol = await rolQueEdita(tx, actorId, entrada.workspaceId);
    await exigirNombreLibre(tx, entrada.workspaceId, entrada.nombre, entrada.segmentoId);
    // El nombre anterior viaja en el evento: renombrar un eje de medición es un cambio que
    // quien lea la auditoría tiene que poder seguir sin reconstruir la historia a mano.
    const filas = await tx`
      with anterior as (
        select id, nombre from segmento
        where id = ${entrada.segmentoId} and workspace_id = ${entrada.workspaceId}
      ),
      upd as (
        update segmento s set nombre = ${entrada.nombre}, definicion = ${entrada.definicion}
        from anterior where s.id = anterior.id
        returning s.id
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${entrada.workspaceId}, 'SegmentoEditado',
               jsonb_build_object('segmentoId', upd.id, 'nombre', ${entrada.nombre}::text,
                                  'nombreAnterior', anterior.nombre),
               ${actorId}, ${rol}::text
        from upd, anterior
      )
      select id from upd`;
    if (filas.length === 0) throw new ErrorSegmento('El segmento no existe en este workspace');
  });
}
