import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { puedeEditarSegmentos, type CrearSegmento, type EditarSegmento } from './segmento.schemas';

/**
 * Escrituras sobre la taxonomía del cliente (RF-01.7): dar de alta un segmento y editar su
 * nombre o definición.
 *
 * Capa 1: las políticas `segmento_insert` / `segmento_update` de la base — solo el lead o el
 * admin del cliente escriben, y solo nombre y definición (migración 20260905110000). Capa 2:
 * estado de cuenta, el mismo ROL re-comprobado aquí para dar un mensaje claro en vez de un
 * 42501 seco, y el nombre único por workspace, que la base no impone. Cada escritura deja
 * su evento en `evento_dominio` en LA MISMA sentencia, con el rol que la autorizó.
 *
 * No hay borrado: un segmento lo citan evidencia congelada y arquetipos con veredicto, y el
 * rol de aplicación no tiene DELETE sobre la tabla. Renombrar sí se permite —el nombre es un
 * rótulo, la identidad es el id—, y la evidencia conserva en su jsonb el snapshot con el que
 * se curó.
 */

export class ErrorSegmento extends Error {}

/**
 * El rol del actor en el workspace, si puede editar la taxonomía; si no, error claro. Es el
 * re-check de capa 2: la política de la base rechazaría igual, pero con un 42501 que no dice
 * quién sí puede.
 */
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
    // la comprobación de arriba en esta misma transacción. Bajo RLS el insert devuelve su
    // fila o lanza (42501 si la política no lo deja): no hay «cero filas» que contemplar.
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
    return { segmentoId: fila!.id as string };
  });
}

export async function editarSegmento(actorId: string, entrada: EditarSegmento): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const rol = await rolQueEdita(tx, actorId, entrada.workspaceId);
    await exigirNombreLibre(tx, entrada.workspaceId, entrada.nombre, entrada.segmentoId);
    // El nombre anterior viaja en el evento: renombrar un eje de medición es un cambio que
    // quien lea la auditoría tiene que poder seguir sin reconstruir la historia a mano.
    //
    // `for update` en esa lectura, y no es cosmética: dos ediciones concurrentes del mismo
    // segmento pasan las dos el candado de nombre (son nombres distintos) y, sin el candado
    // de fila, la segunda leería el nombre viejo y lo registraría como «anterior» de un
    // cambio que en realidad partió del que dejó la primera: la cadena de la auditoría
    // quedaría rota. Con él, la segunda espera a que la primera confirme y, bajo READ
    // COMMITTED, relee la versión que acaba de quedar: old => n1 | n1 => n2.
    const filas = await tx`
      with anterior as (
        select id, nombre from segmento
        where id = ${entrada.segmentoId} and workspace_id = ${entrada.workspaceId}
        for update
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
