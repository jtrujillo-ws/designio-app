import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import type { ArbolWorkspace, ServicioArbol } from './arbol.schemas';

/**
 * Construye la proyección del árbol (RF-02.1/02.2) en UNA sola sentencia (json_agg
 * anidado): un único snapshot — sin carreras entre lecturas bajo READ COMMITTED — y
 * orden estable con desempate por id. Corre DENTRO de una transacción con contexto
 * RLS; el filtro explícito por workspace_id es la capa 2.
 */
export async function construirArbol(
  tx: TransactionSql,
  workspaceId: string,
  workspaceNombre: string,
): Promise<ArbolWorkspace> {
  const [fila] = await tx`
    select coalesce(json_agg(servicio_json order by creado_en, id), '[]'::json) as servicios
    from (
      select s.creado_en, s.id, json_build_object(
        'id', s.id,
        'nombre', s.nombre,
        'estado', s.estado,
        'retos', coalesce((
          select json_agg(json_build_object(
            'id', r.id,
            'codigo', r.codigo,
            'titulo', r.titulo,
            'estado', r.estado,
            'origen', r.origen,
            'metricaObjetivo', r.metrica_objetivo,
            'proyectos', coalesce((
              select json_agg(json_build_object(
                'id', p.id, 'codigo', p.codigo, 'titulo', p.titulo, 'estado', p.estado
              ) order by p.codigo, p.id)
              from proyecto p
              where p.reto_id = r.id and p.workspace_id = ${workspaceId}
            ), '[]'::json)
          ) order by r.codigo, r.id)
          from reto r
          where r.servicio_ancla_id = s.id and r.workspace_id = ${workspaceId}
        ), '[]'::json),
        'retosQueAfectan', coalesce((
          select json_agg(json_build_object(
            'id', r2.id, 'codigo', r2.codigo, 'titulo', r2.titulo
          ) order by r2.codigo, r2.id)
          from reto_servicio_afectado ra
          join reto r2 on r2.id = ra.reto_id and r2.workspace_id = ra.workspace_id
          where ra.servicio_id = s.id
            and ra.workspace_id = ${workspaceId}
            -- Si una arista «afecta» duplicara el ancla, la proyección NO la duplica
            -- (criterio de aceptación 1 de SPEC-02); la función de escritura futura
            -- rechazará crearla.
            and ra.servicio_id <> r2.servicio_ancla_id
        ), '[]'::json)
      ) as servicio_json
      from servicio s
      where s.workspace_id = ${workspaceId}
    ) sub`;

  return {
    workspaceId,
    workspaceNombre,
    servicios: (fila?.servicios ?? []) as ServicioArbol[],
  };
}
