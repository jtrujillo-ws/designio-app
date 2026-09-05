import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import {
  TOPE_POR_SECCION,
  type ArquetipoEnMemoria,
  type DecisionEnMemoria,
  type InsightEnMemoria,
  type MemoriaDelWorkspace,
  type RetoCandidatoEnMemoria,
  type RetoCerradoEnMemoria,
  type SegmentoEnMemoria,
  type TotalesDeMemoria,
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
 *
 * Las siete van en un `Promise.all` sobre la misma `tx`: postgres.js las canaliza por la
 * conexión de la transacción en vez de esperar siete viajes en serie, y el snapshot de
 * REPEATABLE READ —que se toma en la primera sentencia de la transacción, la comprobación
 * de cuenta— sigue siendo uno para todas. Es lo mismo que hace el panel de AI con sus
 * candidatas.
 *
 * Cada lista trae como mucho TOPE_POR_SECCION filas, de la más reciente a la más antigua,
 * y la séptima sentencia cuenta cuántas hay de verdad por sección (count sobre la misma
 * foto, barato: son índices por workspace). La pantalla recorta con el total en la mano en
 * vez de fingir que la lista es entera.
 */
export async function construirMemoria(
  tx: TransactionSql,
  workspaceId: string,
  workspaceNombre: string,
): Promise<MemoriaDelWorkspace> {
  const [segmentos, arquetipos, insights, decisiones, retosCerrados, retosCandidatos, totales] =
    await Promise.all([
      // Con el conteo REAL de arquetipos de cada segmento: la lista de arquetipos de abajo
      // viene recortada al tope y un segmento antiguo puede quedarse sin ninguno de los
      // suyos en ella; sin este número la tarjeta del segmento mentiría. Y recortada al
      // tope también ella, del más reciente al más antiguo: es una tarjeta por segmento y
      // un count por tarjeta, y sin cota el SSR crecía con la taxonomía entera.
      tx<SegmentoEnMemoria[]>`
        select s.id, s.nombre, s.definicion,
               (select count(*)::int from arquetipo_segmento asg
                 where asg.segmento_id = s.id and asg.workspace_id = s.workspace_id)
                 as "totalArquetipos"
        from segmento s
        where s.workspace_id = ${workspaceId}
        order by s.creado_en desc, s.id
        limit ${TOPE_POR_SECCION}`,

      // El arquetipo con el reto donde nació y el primer proyecto de ese reto (el mismo
      // criterio que el buscador: por código, con desempate por id). Un reto sin proyecto —
      // un candidato, o uno activado a mano— deja el enlace en null y la pantalla lo dice.
      tx<ArquetipoEnMemoria[]>`
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
        order by a.creado_en desc, a.id
        limit ${TOPE_POR_SECCION}`,

      // Solo validados: es el mismo filtro que exige registrarDecision para enlazar un
      // insight. Un insight propuesto no ha pasado por nadie y no puede pre-poblar nada.
      //
      // Y con su respaldo VIVO: `validado` es inmutable, los derechos de la evidencia citada
      // no. El predicado no se reproduce aquí —se INVOCA `razonamiento_sin_respaldo_visible`,
      // la misma función que consulta el guard de suficiencia y que usa el picker de
      // insights— y el motivo llega ya redactado, nombrando la afirmación exacta.
      tx<InsightEnMemoria[]>`
        select i.id, i.titulo, i.resumen, to_char(i.validado_en, 'YYYY-MM-DD') as "validadoEn",
               razonamiento_sin_respaldo_visible(i.workspace_id, array[i.id], array[]::uuid[],
                                                 array[]::uuid[]) as "sinRespaldo"
        from insight i
        where i.workspace_id = ${workspaceId} and i.estado = 'validado'
        order by i.validado_en desc, i.id
        limit ${TOPE_POR_SECCION}`,

      // Solo vigentes: una decisión `en-revision` fue cuestionada por una reapertura (SYS-10)
      // y hasta que el lead la revalide no es memoria, es una pregunta abierta. Y `vigente`
      // tampoco garantiza la cadena: su insight puede haber perdido el respaldo. Misma
      // función que la proyección de gobernanza, con la decisión en su argumento.
      tx<DecisionEnMemoria[]>`
        select d.id, d.tipo, d.titulo, d.fundamento, g.numero as "gateNumero",
               to_char(d.decidido_en, 'YYYY-MM-DD') as "decididoEn",
               json_build_object('id', p.id, 'codigo', p.codigo, 'titulo', p.titulo) as proyecto,
               razonamiento_sin_respaldo_visible(d.workspace_id, array[]::uuid[], array[d.id],
                                                 array[]::uuid[]) as "sinRespaldo"
        from decision d
        join gate_instancia g on g.id = d.gate_id and g.workspace_id = d.workspace_id
        join proyecto p on p.id = d.proyecto_id and p.workspace_id = d.workspace_id
        where d.workspace_id = ${workspaceId} and d.estado = 'vigente'
        order by d.decidido_en desc, d.id
        limit ${TOPE_POR_SECCION}`,

      // El veredicto sale del outcome review COMPLETADO (es quien lo dicta y quien escribe
      // reto.veredicto en la misma sentencia); el de la fila del reto es el respaldo para el
      // caso en que el review se dictó por vía administrativa. Un reto cerrado antes de que
      // existiera el post mortem se queda con null, y así se enseña.
      //
      // Los ARCHIVADOS también son memoria: `cerrado → archivado` es una transición legal y
      // `reto_veredicto_solo_cerrado` conserva el veredicto en el archivado —archivar ordena
      // el árbol, no borra lo que se aprendió—. Lo que NO entra es el archivado que nunca
      // tuvo review ni veredicto: ése se archivó sin haber medido nada (un candidato o un
      // reto abandonado) y no dejó aprendizaje que conservar.
      tx<RetoCerradoEnMemoria[]>`
        select r.id, r.codigo, r.titulo, r.estado,
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
        where r.workspace_id = ${workspaceId}
          and r.estado in ('cerrado', 'archivado')
          and (r.estado = 'cerrado' or orv.id is not null or r.veredicto is not null)
        order by orv.completado_en desc nulls last, r.creado_en desc, r.id
        limit ${TOPE_POR_SECCION}`,

      // Los candidatos que dejó un post mortem: el backlog que el ciclo anterior propuso. Los
      // de otros orígenes (petición del cliente, hallazgo de medición) son pipeline, no memoria.
      tx<RetoCandidatoEnMemoria[]>`
        select id, codigo, titulo, descripcion, metrica_objetivo as "metricaObjetivo"
        from reto
        where workspace_id = ${workspaceId} and estado = 'candidato' and origen = 'post-mortem'
        order by creado_en desc, id
        limit ${TOPE_POR_SECCION}`,

      // Los totales, con EXACTAMENTE los mismos predicados que las listas: si divergieran,
      // la pantalla diría «50 de N» con una N que no es la de esa lista.
      tx<TotalesDeMemoria[]>`
        select
          (select count(*)::int from segmento s where s.workspace_id = ${workspaceId})
            as segmentos,
          (select count(*)::int from arquetipo a where a.workspace_id = ${workspaceId})
            as arquetipos,
          (select count(*)::int from arquetipo a
            where a.workspace_id = ${workspaceId}
              and not exists (select 1 from arquetipo_segmento asg
                where asg.arquetipo_id = a.id and asg.workspace_id = a.workspace_id))
            as "arquetiposSinSegmento",
          (select count(*)::int from insight i
            where i.workspace_id = ${workspaceId} and i.estado = 'validado') as insights,
          (select count(*)::int from decision d
            where d.workspace_id = ${workspaceId} and d.estado = 'vigente') as decisiones,
          (select count(*)::int from reto r
            left join outcome_review orv on orv.reto_id = r.id and orv.workspace_id = r.workspace_id
              and orv.estado = 'completado'
            where r.workspace_id = ${workspaceId}
              and r.estado in ('cerrado', 'archivado')
              and (r.estado = 'cerrado' or orv.id is not null or r.veredicto is not null))
            as "retosCerrados",
          (select count(*)::int from reto r
            where r.workspace_id = ${workspaceId} and r.estado = 'candidato'
              and r.origen = 'post-mortem') as "retosCandidatos"`,
    ]);

  return {
    workspaceId,
    workspaceNombre,
    segmentos: [...segmentos],
    arquetipos: [...arquetipos],
    insights: [...insights],
    decisiones: [...decisiones],
    retosCerrados: [...retosCerrados],
    retosCandidatos: [...retosCandidatos],
    // La fila de totales existe siempre (son subselects escalares); el `??` es para el tipo.
    totales: totales[0] ?? {
      segmentos: 0,
      arquetipos: 0,
      arquetiposSinSegmento: 0,
      insights: 0,
      decisiones: 0,
      retosCerrados: 0,
      retosCandidatos: 0,
    },
  };
}
