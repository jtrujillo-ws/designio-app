import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import {
  MAX_POR_CLASE,
  MAX_RESULTADOS,
  conDestino,
  patronDeBusqueda,
  type FilaBusqueda,
  type ResultadoBusqueda,
} from './busqueda.schemas';

/** Búsqueda para un usuario autenticado: capa 2 de cuenta activa y RLS en la misma transacción. */
export async function buscarParaUsuario(
  usuarioId: string,
  workspaceId: string,
  texto: string,
): Promise<{ resultados: ResultadoBusqueda[]; hayMas: boolean }> {
  return conUsuario(usuarioId, async (tx) => {
    await exigirCuentaActiva(tx, usuarioId);
    return buscarEnWorkspace(tx, workspaceId, texto);
  });
}

/**
 * Una sola sentencia sobre las siete clases con pantalla: título (y código, donde lo hay)
 * por ILIKE, con tope por clase para que cien evidencias no tapen el único proyecto que
 * casa. Corre DENTRO de una transacción con contexto RLS; el filtro por workspace_id es la
 * capa 2, como en el árbol. El orden de clases es el de CLASES_BUSCABLES (el del árbol), y
 * dentro de cada clase el título, con desempate por id para que sea estable.
 */
export async function buscarEnWorkspace(
  tx: TransactionSql,
  workspaceId: string,
  texto: string,
): Promise<{ resultados: ResultadoBusqueda[]; hayMas: boolean }> {
  const patron = patronDeBusqueda(texto);
  const filas = await tx<FilaBusqueda[]>`
    select clase, id, codigo, titulo, detalle, ref_id as "refId"
    from (
      select u.*, row_number() over (partition by u.clase order by u.titulo, u.id) as n
      from (
        select 'servicio'::text as clase, s.id, null::text as codigo, s.nombre as titulo,
               s.estado as detalle, null::uuid as ref_id
        from servicio s
        where s.workspace_id = ${workspaceId} and s.nombre ilike ${patron}
        union all
        select 'reto', r.id, r.codigo, r.titulo, r.estado,
               (select p.id from proyecto p
                 where p.reto_id = r.id and p.workspace_id = r.workspace_id
                 order by p.codigo, p.id limit 1)
        from reto r
        where r.workspace_id = ${workspaceId} and (r.codigo || ' ' || r.titulo) ilike ${patron}
        union all
        select 'proyecto', p.id, p.codigo, p.titulo, p.estado, null
        from proyecto p
        where p.workspace_id = ${workspaceId} and (p.codigo || ' ' || p.titulo) ilike ${patron}
        union all
        select 'journey', j.id, null, j.nombre, j.tipo, null
        from journey j
        where j.workspace_id = ${workspaceId} and j.nombre ilike ${patron}
        union all
        select 'design-version', dv.id, dv.codigo, dv.titulo, dv.estado, null
        from design_version dv
        where dv.workspace_id = ${workspaceId}
          and (coalesce(dv.codigo, '') || ' ' || dv.titulo) ilike ${patron}
        union all
        select 'evidencia', e.id, null, e.titulo,
               case when e.es_estado_actual then 'estado actual' else '' end, null
        from evidencia e
        where e.workspace_id = ${workspaceId} and e.titulo ilike ${patron}
        union all
        select 'insight', i.id, null, i.titulo, i.estado, null
        from insight i
        where i.workspace_id = ${workspaceId} and i.titulo ilike ${patron}
      ) u
    ) numeradas
    where n <= ${MAX_POR_CLASE}
    order by case clase
               when 'servicio' then 1 when 'reto' then 2 when 'proyecto' then 3
               when 'journey' then 4 when 'design-version' then 5
               when 'evidencia' then 6 else 7 end,
             titulo, id
    limit ${MAX_RESULTADOS + 1}`;
  const hayMas = filas.length > MAX_RESULTADOS;
  return { resultados: conDestino(filas.slice(0, MAX_RESULTADOS)), hayMas };
}
