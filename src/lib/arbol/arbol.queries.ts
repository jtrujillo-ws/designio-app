import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import type { ArbolWorkspace, ServicioArbol } from './arbol.schemas';

/**
 * Árbol para un usuario autenticado: re-check del estado ACTUAL de la cuenta (capa 2 —
 * el JWT vive 7 días y las server functions son invocables directo; la RLS valida
 * membresía, no usuario.estado), y membresía + proyección en la MISMA transacción.
 * Sin workspaceId usa el primer workspace del usuario ordenado por nombre (el mismo
 * criterio que usuarioConMembresias/topbar).
 */
  /*
   * REPEATABLE READ: es una proyección de SOLO LECTURA con varias sentencias, y desde que
   * existe la disposición acordada los datos de un workspace pueden desaparecer entre una y
   * otra. Bajo READ COMMITTED cada sentencia toma su instantánea, así que la respuesta podía
   * mezclar dos momentos —y con la membresía ya borrada, la mitad tardía vuelve VACÍA por RLS,
   * no corta—. Lo que llega a la pantalla no es entonces un estado incompleto: es uno que no
   * ha existido nunca.
   *
   * No choca con la doctrina de aislamiento del esquema, que exige READ COMMITTED a las
   * transacciones que ESCRIBEN y releen tras un candado: aquí no se escribe nada.
   */
export async function arbolParaUsuario(
  usuarioId: string,
  workspaceId?: string,
): Promise<ArbolWorkspace | null> {
  return conUsuario(usuarioId, async (tx) => {
    await exigirCuentaActiva(tx, usuarioId);
    const destino = workspaceId
      ? await tx`select id, nombre from workspace where id = ${workspaceId}`
      : await tx`select w.id, w.nombre from workspace w
          join miembro m on m.workspace_id = w.id and m.usuario_id = ${usuarioId}
          order by w.nombre limit 1`;

    const ws = destino[0];
    if (!ws) {
      if (workspaceId) throw new Error('Sin membresía en ese workspace');
      return null; // usuario sin workspaces todavía
    }
    return construirArbol(tx, ws.id as string, ws.nombre as string);
  }, { aislamiento: 'repeatable read' });
}

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
        -- El estado OPERATIVO del servicio (RF-06.10): la última constatación que dejaron sus
        -- releases verificados. Es lo que el servicio hace hoy, y es distinto de s.estado,
        -- que es su estado de gestión. Sin esto, el dato que SPEC-06 produce solo existía en
        -- el detalle de una design version: para verlo había que saber ya cuál mirar.
        --
        -- CUÁL es el vigente lo decide la misma función que usa ese detalle, no una consulta
        -- parecida: dos lecturas del estado de un servicio que se eligen por separado acaban
        -- enseñando estados distintos del mismo servicio. Aquí no se excluye ninguna design
        -- version —el árbol mira el servicio entero—, así que el tercer argumento va nulo.
        'estadoEfectivo', (
          select json_build_object(
            'codigo', es.codigo,
            'constatadoEn', to_char(es.constatado_en, 'YYYY-MM-DD'),
            'designVersionCodigo', dv.codigo,
            'resumen', es.resumen)
          from effective_state es
          join release r on r.id = es.release_id and r.workspace_id = es.workspace_id
          join design_version dv on dv.id = r.design_version_id and dv.workspace_id = r.workspace_id
          where es.id = effective_state_vigente_del_servicio(s.id, ${workspaceId})
        ),
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
