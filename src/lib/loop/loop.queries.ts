import '@/lib/server-only';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import { proyectoActualDe } from './loop-estado';
import type {
  AprobacionPendiente,
  GatesDeProyecto,
  MetricasDelReto,
  ReleaseDelServicio,
  ResumenDelLoop,
} from './loop.schemas';

/**
 * La proyección de la pantalla Loop: un vistazo a dónde está el método en un servicio.
 * Se lee ENTERA bajo el contexto RLS del usuario —cada tabla que toca tiene su política de
 * lectura por membresía— y el filtro explícito por workspace es la capa 2, como en el árbol.
 *
 * REPEATABLE READ por la misma razón que el árbol y la bandeja: es una lectura de varias
 * sentencias, y desde que existe la disposición acordada un workspace puede desaparecer
 * entre una y otra; con una instantánea por sentencia, la respuesta podía mezclar dos
 * momentos. No escribe nada, así que no choca con la doctrina de aislamiento de la base.
 */
export async function resumenParaUsuario(
  actorId: string,
  workspaceId: string,
  servicioId?: string,
): Promise<ResumenDelLoop> {
  return conUsuario(
    actorId,
    async (tx) => {
      await exigirCuentaActiva(tx, actorId);

      // El servicio del que habla la pantalla: el pedido si es de este workspace (la RLS no
      // enseña los ajenos), y si no el primero con el MISMO orden que usa el árbol (creado_en,
      // id). La pantalla se cae al primero exactamente igual, así que hablan del mismo.
      const [svc] = await tx`select id from servicio
        where workspace_id = ${workspaceId}
        order by (id = ${servicioId ?? null}::uuid) desc nulls last, creado_en, id
        limit 1`;
      const sid = (svc?.id as string | undefined) ?? null;

      const [base] = await tx`select
        exists (select 1 from evidencia where workspace_id = ${workspaceId}) as hay_evidencia,
        (select count(*)::int from item_importacion
          where workspace_id = ${workspaceId} and estado = 'pendiente') as importacion_pendientes`;

      // Los gates de TODOS los proyectos del workspace: el lateral pinta cada reto con el
      // journey donde está su proyecto, y para eso necesita los de los otros servicios también.
      // El orden es el del árbol (reto por código, proyecto por código) para que «el primer
      // proyecto del servicio» sea el mismo aquí y allí.
      const filasProyectos = await tx`
        select p.id, p.codigo, r.id as reto_id, r.codigo as reto_codigo, r.estado as reto_estado,
          r.servicio_ancla_id as servicio_id,
          coalesce(array_agg(g.numero order by g.numero) filter (where g.numero is not null),
            '{}'::int[]) as aprobados,
          -- Mide y alguna ventana sigue abierta: el mismo predicado con el que la política
          -- del outcome review (review_insert) rechaza abrirlo todavía.
          (r.estado = 'en-medicion' and exists (select 1 from entrada_kpi e
            join metric_registry mr on mr.id = e.registry_id and mr.workspace_id = e.workspace_id
            join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
            where mr.reto_id = r.id and mr.workspace_id = r.workspace_id
              and ventana_de_medicion_abierta(e.ventana_inicio, c.ventana_dias))) as medicion_abierta,
          exists (select 1 from outcome_review o
            where o.reto_id = r.id and o.workspace_id = r.workspace_id
              and o.estado = 'completado') as review_completado
        from proyecto p
        join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id
        left join gate_instancia g
          on g.proyecto_id = p.id and g.workspace_id = p.workspace_id and g.estado = 'aprobado'
        where p.workspace_id = ${workspaceId}
        group by p.id, p.codigo, r.id, r.codigo, r.estado, r.servicio_ancla_id, r.workspace_id
        order by r.codigo, r.id, p.codigo, p.id`;
      const proyectos: GatesDeProyecto[] = filasProyectos.map((f) => ({
        proyectoId: f.id as string,
        proyectoCodigo: f.codigo as string,
        retoId: f.reto_id as string,
        retoCodigo: f.reto_codigo as string,
        retoEstado: f.reto_estado as string,
        servicioId: f.servicio_id as string,
        aprobados: f.aprobados as number[],
        medicionAbierta: f.medicion_abierta as boolean,
        reviewCompletado: f.review_completado as boolean,
      }));

      // Gate ABIERTO (el primero pendiente de su proyecto) con el checklist entero decidido y
      // no vacío: dejó de ser trabajo y espera a su aprobador. Un checklist vacío no es
      // suficiencia (mismo criterio que el guard de la base), así que no cuenta. Cada fila
      // dice además si el aprobador es QUIEN MIRA: la pantalla del proyecto solo deja aprobar
      // cuando el rol coincide, y «Te toca a ti» no puede contar como propia una aprobación
      // que espera al sponsor.
      const filasAprobaciones = await tx`
        select g.id, g.numero, g.rol_aprobador, p.id as proyecto_id, p.codigo as proyecto_codigo,
          r.codigo as reto_codigo,
          g.rol_aprobador = workspace_role(${actorId}, ${workspaceId}) as es_mia
        from gate_instancia g
        join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
        join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id
        where g.workspace_id = ${workspaceId}
          and g.estado = 'pendiente'
          and g.numero = (select min(g2.numero) from gate_instancia g2
            where g2.proyecto_id = g.proyecto_id and g2.workspace_id = g.workspace_id
              and g2.estado = 'pendiente')
          and exists (select 1 from checklist_item ci
            where ci.gate_id = g.id and ci.workspace_id = g.workspace_id)
          and not exists (select 1 from checklist_item ci
            where ci.gate_id = g.id and ci.workspace_id = g.workspace_id
              and ci.estado = 'pendiente')
        order by r.codigo, r.id, p.codigo, p.id, g.numero`;
      const aprobaciones: AprobacionPendiente[] = filasAprobaciones.map((f) => ({
        gateId: f.id as string,
        numero: f.numero as number,
        rolAprobador: f.rol_aprobador as AprobacionPendiente['rolAprobador'],
        esMia: (f.es_mia as boolean | null) === true,
        proyectoId: f.proyecto_id as string,
        proyectoCodigo: f.proyecto_codigo as string,
        retoCodigo: f.reto_codigo as string,
      }));

      // El release más avanzado del servicio: uno que ya salió antes que uno planificado, y
      // entre los que salieron, el último. Los días vivos los cuenta el calendario de la
      // base (`fecha_de_la_base`), no el reloj del navegador: es la misma doctrina que la
      // medición, donde el «hoy» que juzga es el de quien decide.
      const [rel] = sid
        ? await tx`
          select rl.id, rl.codigo, rl.titulo, rl.estado,
            dv.id as dv_id, dv.codigo as dv_codigo,
            case when rl.desplegado_en is null then null
              else (fecha_de_la_base() - rl.desplegado_en)::int end as dias_vivo
          from release rl
          join design_version dv
            on dv.id = rl.design_version_id and dv.workspace_id = rl.workspace_id
          where rl.workspace_id = ${workspaceId} and dv.servicio_id = ${sid}
          order by (rl.estado <> 'planificado') desc, rl.desplegado_en desc nulls last,
            rl.creado_en desc, rl.id desc
          limit 1`
        : [];
      const release: ReleaseDelServicio | null = rel
        ? {
            id: rel.id as string,
            codigo: rel.codigo as string,
            titulo: rel.titulo as string,
            estado: rel.estado as ReleaseDelServicio['estado'],
            designVersionId: rel.dv_id as string,
            designVersionCodigo: rel.dv_codigo as string,
            diasVivo: rel.dias_vivo as number | null,
          }
        : null;

      // El Metric Registry del reto del proyecto ACTUAL del servicio, elegido con la misma
      // regla que la pantalla (proyectoActualDe). Sin registry no hay métricas que decir.
      const proyectoActual = sid
        ? proyectoActualDe(proyectos.filter((p) => p.servicioId === sid))
        : null;
      const [met] = proyectoActual
        ? await tx`
          select mr.estado,
            (select count(*)::int from entrada_kpi e
              where e.registry_id = mr.id and e.workspace_id = mr.workspace_id) as total,
            (select count(*)::int from entrada_kpi e
              where e.registry_id = mr.id and e.workspace_id = mr.workspace_id
                and exists (select 1 from snapshot s
                  where s.entrada_kpi_id = e.id and s.workspace_id = e.workspace_id)) as listas,
            -- Las entregas que ESPERAN a quien mira: entradas cuyo snapshot está pendiente o
            -- vencido según su cadencia, y que él puede cargar (curador o propietario del
            -- dato de esa entrada: el predicado de la política del snapshot). Solo con el reto
            -- en medición y la ventana abierta —fuera de eso la política rechaza la carga—, y
            -- con el MISMO juicio por entrada que hace la pantalla del proyecto (estadoSnapshot
            -- en medicion.servicio): «nunca tuvo snapshot» no es la pregunta, porque un KPI
            -- semanal con una lectura puede llevar tres entregas de retraso.
            (select count(*)::int from entrada_kpi e
              join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
              join reto r on r.id = mr.reto_id and r.workspace_id = mr.workspace_id
              left join miembro m
                on m.id = e.propietario_miembro_id and m.workspace_id = e.workspace_id
              left join lateral (select max(s.fecha) as fecha from snapshot s
                where s.entrada_kpi_id = e.id and s.workspace_id = e.workspace_id) ult on true
              where e.registry_id = mr.id and e.workspace_id = mr.workspace_id
                and mr.estado = 'firmado' and r.estado = 'en-medicion'
                and (workspace_role(${actorId}, ${workspaceId}) = any(${[...ROLES_CURADORES]})
                  or m.usuario_id = ${actorId})
                and case
                  -- Sin ventana no hay cadencia que juzgar: espera mientras no llegue nada.
                  when e.ventana_inicio is null or c.ventana_dias is null then ult.fecha is null
                  -- Ventana que aún no empezó: la política del snapshot exige fecha >= inicio
                  -- y <= hoy, así que no hay fecha válida que cargar. Todavía no es tarea.
                  when e.ventana_inicio > fecha_de_la_base() then false
                  -- Ventana cerrada: estado terminal, ya nadie puede aportar.
                  when not ventana_de_medicion_abierta(e.ventana_inicio, c.ventana_dias) then false
                  -- Abierta: vencida si falta alguna entrega prometida hasta ayer…
                  when cadencia_incumplida(e.id, e.workspace_id, e.ventana_inicio,
                         e.frecuencia, fecha_de_la_base() - 1) then true
                  -- …recibida si ya hay dato, y esperada si todavía no.
                  else ult.fecha is null end) as entregas_pendientes_mias,
            (select jsonb_build_object(
                'nombre', e.nombre,
                'lineaBase', e.linea_base_valor::text,
                'objetivo', c.objetivo,
                'actual', (select s.valor::text from snapshot s
                  where s.entrada_kpi_id = e.id and s.workspace_id = e.workspace_id
                  order by s.fecha desc, s.creado_en desc, s.id desc limit 1))
              from entrada_kpi e
              join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
              where e.registry_id = mr.id and e.workspace_id = mr.workspace_id
              order by e.creado_en, e.id limit 1) as primaria
          from metric_registry mr
          where mr.reto_id = ${proyectoActual.retoId} and mr.workspace_id = ${workspaceId}`
        : [];
      const metricas: MetricasDelReto | null = met
        ? {
            registryFirmado: met.estado === 'firmado',
            listas: met.listas as number,
            total: met.total as number,
            entregasPendientesMias: met.entregas_pendientes_mias as number,
            primaria: (met.primaria as MetricasDelReto['primaria']) ?? null,
          }
        : null;

      return {
        workspaceId,
        servicioId: sid,
        hayEvidencia: base!.hay_evidencia as boolean,
        importacionPendientes: base!.importacion_pendientes as number,
        proyectos,
        aprobaciones,
        release,
        metricas,
      };
    },
    { aislamiento: 'repeatable read' },
  );
}
