import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import type {
  ArquetipoEnMemoria,
  DecisionEnMemoria,
  InsightEnMemoria,
  MemoriaDelWorkspace,
  RetoCandidatoEnMemoria,
  RetoCerradoEnMemoria,
  SegmentoEnMemoria,
} from './memoria.schemas';

/**
 * La memoria del workspace para un usuario autenticado: re-check del estado ACTUAL de la
 * cuenta (capa 2 — el JWT vive 7 días y las server functions son invocables directo; la
 * RLS valida membresía, no usuario.estado) y proyección en la MISMA transacción. Si el
 * workspace no es visible (sin membresía), la RLS no devuelve su fila y aquí se responde
 * null: la pantalla lo dice, no lo inventa.
 */
/*
 * REPEATABLE READ, por la misma razón que el árbol: es una proyección de SOLO LECTURA con
 * varias sentencias sobre seis tablas distintas, y desde que existe la disposición
 * acordada los datos de un workspace pueden desaparecer entre una y otra. Bajo READ
 * COMMITTED cada sentencia toma su instantánea, así que la biblioteca podía enseñar un
 * arquetipo cuyo reto ya no está, o decisiones de un workspace cuyos insights se fueron
 * en la sentencia siguiente. Lo que llega a la pantalla debe ser UNA foto del workspace —
 * y aquí, además, esa foto es literalmente lo que se le dice al cliente que sabe.
 *
 * No choca con la doctrina de aislamiento del esquema (READ COMMITTED para quien escribe y
 * relee tras un candado): aquí no se escribe nada.
 */
export async function memoriaParaUsuario(
  usuarioId: string,
  workspaceId: string,
): Promise<MemoriaDelWorkspace | null> {
  return conUsuario(
    usuarioId,
    async (tx) => {
      await exigirCuentaActiva(tx, usuarioId);
      const [ws] = await tx`select id, nombre from workspace where id = ${workspaceId}`;
      if (!ws) return null;
      return construirMemoria(tx, ws.id as string, ws.nombre as string);
    },
    { aislamiento: 'repeatable read' },
  );
}

/**
 * Construye la proyección. Corre DENTRO de una transacción con contexto RLS (capa 1); el
 * filtro explícito por workspace_id en cada sentencia es la capa 2, como en el árbol. Cada
 * sección es una sentencia con orden estable (desempate por id): son seis lecturas
 * independientes y no hay ganancia en trenzarlas en un solo json_agg.
 */
export async function construirMemoria(
  tx: TransactionSql,
  workspaceId: string,
  workspaceNombre: string,
): Promise<MemoriaDelWorkspace> {
  const segmentos = await tx<SegmentoEnMemoria[]>`
    select id, nombre, definicion
    from segmento
    where workspace_id = ${workspaceId}
    order by nombre, id`;

  // El arquetipo con el reto donde nació y el primer proyecto de ese reto (el mismo
  // criterio que el buscador: por código, con desempate por id). Un reto sin proyecto —
  // un candidato, o uno activado a mano— deja el enlace en null y la pantalla lo dice.
  const arquetipos = await tx<ArquetipoEnMemoria[]>`
    select a.id, a.nombre, a.definicion, a.estado, a.veredicto_razon as "veredictoRazon",
           json_build_object('id', r.id, 'codigo', r.codigo, 'titulo', r.titulo,
                             'estado', r.estado) as reto,
           case when pr.id is null then null
                else json_build_object('id', pr.id, 'codigo', pr.codigo) end as proyecto,
           coalesce((
             select json_agg(s.id order by s.nombre, s.id)
             from arquetipo_segmento asg
             join segmento s on s.id = asg.segmento_id and s.workspace_id = asg.workspace_id
             where asg.arquetipo_id = a.id and asg.workspace_id = a.workspace_id
           ), '[]'::json) as "segmentoIds"
    from arquetipo a
    join reto r on r.id = a.reto_id and r.workspace_id = a.workspace_id
    left join lateral (
      select p.id, p.codigo from proyecto p
      where p.reto_id = r.id and p.workspace_id = r.workspace_id
      order by p.codigo, p.id limit 1
    ) pr on true
    where a.workspace_id = ${workspaceId}
    order by r.codigo, a.nombre, a.id`;

  // Solo validados: es el mismo filtro que exige registrarDecision para enlazar un
  // insight. Un insight propuesto no ha pasado por nadie y no puede pre-poblar nada.
  const insights = await tx<InsightEnMemoria[]>`
    select id, titulo, resumen, to_char(validado_en, 'YYYY-MM-DD') as "validadoEn"
    from insight
    where workspace_id = ${workspaceId} and estado = 'validado'
    order by validado_en desc, id`;

  // Solo vigentes: una decisión `en-revision` fue cuestionada por una reapertura (SYS-10)
  // y hasta que el lead la revalide no es memoria, es una pregunta abierta.
  const decisiones = await tx<DecisionEnMemoria[]>`
    select d.id, d.tipo, d.titulo, d.fundamento, g.numero as "gateNumero",
           to_char(d.decidido_en, 'YYYY-MM-DD') as "decididoEn",
           json_build_object('id', p.id, 'codigo', p.codigo, 'titulo', p.titulo) as proyecto
    from decision d
    join gate_instancia g on g.id = d.gate_id and g.workspace_id = d.workspace_id
    join proyecto p on p.id = d.proyecto_id and p.workspace_id = d.workspace_id
    where d.workspace_id = ${workspaceId} and d.estado = 'vigente'
    order by d.decidido_en desc, d.id`;

  // El veredicto sale del outcome review COMPLETADO (es quien lo dicta y quien escribe
  // reto.veredicto en la misma sentencia); el de la fila del reto es el respaldo para el
  // caso en que el review se dictó por vía administrativa. Un reto cerrado antes de que
  // existiera el post mortem se queda con null, y así se enseña.
  const retosCerrados = await tx<RetoCerradoEnMemoria[]>`
    select r.id, r.codigo, r.titulo,
           coalesce(orv.veredicto, r.veredicto) as veredicto,
           coalesce(orv.contribucion, '') as contribucion,
           coalesce(orv.aprendizajes, '') as aprendizajes,
           to_char(orv.completado_en, 'YYYY-MM-DD') as "cerradoEn",
           case when pr.id is null then null
                else json_build_object('id', pr.id, 'codigo', pr.codigo) end as proyecto
    from reto r
    left join outcome_review orv on orv.reto_id = r.id and orv.workspace_id = r.workspace_id
      and orv.estado = 'completado'
    left join lateral (
      select p.id, p.codigo from proyecto p
      where p.reto_id = r.id and p.workspace_id = r.workspace_id
      order by p.codigo, p.id limit 1
    ) pr on true
    where r.workspace_id = ${workspaceId} and r.estado = 'cerrado'
    order by orv.completado_en desc nulls last, r.codigo, r.id`;

  // Los candidatos que dejó un post mortem: el backlog que el ciclo anterior propuso. Los
  // de otros orígenes (petición del cliente, hallazgo de medición) son pipeline, no memoria.
  const retosCandidatos = await tx<RetoCandidatoEnMemoria[]>`
    select id, codigo, titulo, descripcion, metrica_objetivo as "metricaObjetivo"
    from reto
    where workspace_id = ${workspaceId} and estado = 'candidato' and origen = 'post-mortem'
    order by codigo, id`;

  return {
    workspaceId,
    workspaceNombre,
    segmentos: [...segmentos],
    arquetipos: [...arquetipos],
    insights: [...insights],
    decisiones: [...decisiones],
    retosCerrados: [...retosCerrados],
    retosCandidatos: [...retosCandidatos],
  };
}
