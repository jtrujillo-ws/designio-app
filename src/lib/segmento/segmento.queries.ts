import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import type { SegmentoConCobertura } from './segmento.schemas';

/**
 * Segmentos del workspace para un usuario autenticado: re-check del estado ACTUAL de la
 * cuenta (capa 2) y proyección en la MISMA transacción. REPEATABLE READ por la misma razón
 * que el árbol: es una lectura de varias tablas y, desde la disposición acordada, un
 * workspace puede vaciarse a mitad de camino; la instantánea única evita entregar una foto
 * que no existió nunca. No escribe nada, así que no choca con la doctrina de aislamiento.
 */
export async function segmentosParaUsuario(
  usuarioId: string,
  workspaceId: string,
): Promise<SegmentoConCobertura[]> {
  return conUsuario(
    usuarioId,
    async (tx) => {
      await exigirCuentaActiva(tx, usuarioId);
      return listarSegmentos(tx, workspaceId);
    },
    { aislamiento: 'repeatable read' },
  );
}

/**
 * Los segmentos con su cobertura de research (RF-01.7, prediseño §4.1) en UNA sentencia:
 * por cada uno, los arquetipos que lo mapean (con estado, reto y el proyecto del reto a
 * donde enlazar) y cuántas evidencias lo citan. Corre DENTRO de una transacción con
 * contexto RLS; el filtro explícito por workspace_id es la capa 2, como en el árbol.
 *
 * Orden de alta con desempate por id, como el árbol: la taxonomía se lee en el orden en
 * que el cliente la fue definiendo, no por alfabeto.
 */
export async function listarSegmentos(
  tx: TransactionSql,
  workspaceId: string,
): Promise<SegmentoConCobertura[]> {
  const [fila] = await tx`
    select coalesce(json_agg(segmento_json order by creado_en, id), '[]'::json) as segmentos
    from (
      select s.creado_en, s.id, json_build_object(
        'id', s.id,
        'nombre', s.nombre,
        'definicion', s.definicion,
        'creadoEn', to_char(s.creado_en, 'YYYY-MM-DD'),
        'arquetipos', coalesce((
          select json_agg(json_build_object(
            'id', a.id,
            'nombre', a.nombre,
            'estado', a.estado,
            'retoCodigo', r.codigo,
            'proyectoId', pr.id,
            'proyectoCodigo', pr.codigo
          ) order by r.codigo, a.nombre, a.id)
          from arquetipo_segmento asg
          join arquetipo a on a.id = asg.arquetipo_id and a.workspace_id = asg.workspace_id
          join reto r on r.id = a.reto_id and r.workspace_id = a.workspace_id
          -- El proyecto al que enlaza el arquetipo: el primero del reto por código, el mismo
          -- criterio que usa el buscador para llevar de un reto a su proyecto.
          left join lateral (
            select p.id, p.codigo from proyecto p
            where p.reto_id = r.id and p.workspace_id = r.workspace_id
            order by p.codigo, p.id limit 1
          ) pr on true
          where asg.segmento_id = s.id and asg.workspace_id = ${workspaceId}
        ), '[]'::json),
        'evidencias', (
          select count(*)::int from evidencia_segmento es
          where es.segmento_id = s.id and es.workspace_id = ${workspaceId}
        )
      ) as segmento_json
      from segmento s
      where s.workspace_id = ${workspaceId}
    ) sub`;
  return (fila?.segmentos ?? []) as SegmentoConCobertura[];
}
