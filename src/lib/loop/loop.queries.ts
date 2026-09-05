import '@/lib/server-only';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
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

      // El servicio del que habla la pantalla: el pedido, o el primero con el MISMO orden que
      // usa el árbol (creado_en, id). Si los dos eligieran por criterios distintos, el lateral
      // y la cabecera hablarían de servicios diferentes.
      const [svc] = servicioId
        ? await tx`select id from servicio where id = ${servicioId} and workspace_id = ${workspaceId}`
        : await tx`select id from servicio where workspace_id = ${workspaceId}
            order by creado_en, id limit 1`;
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
        select p.id, p.codigo, r.id as reto_id, r.codigo as reto_codigo,
          r.servicio_ancla_id as servicio_id,
          coalesce((select array_agg(g.numero order by g.numero)
            from gate_instancia g
            where g.proyecto_id = p.id and g.workspace_id = p.workspace_id
              and g.estado = 'aprobado'), '{}'::int[]) as aprobados,
          exists (select 1 from outcome_review o
            where o.reto_id = r.id and o.workspace_id = r.workspace_id
              and o.estado = 'completado') as review_completado
        from proyecto p
        join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id
        where p.workspace_id = ${workspaceId}
        order by r.codigo, r.id, p.codigo, p.id`;
      const proyectos: GatesDeProyecto[] = filasProyectos.map((f) => ({
        proyectoId: f.id as string,
        proyectoCodigo: f.codigo as string,
        retoId: f.reto_id as string,
        retoCodigo: f.reto_codigo as string,
        servicioId: f.servicio_id as string,
        aprobados: f.aprobados as number[],
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

      // El Metric Registry del reto del proyecto ACTUAL del servicio (el primero, con el
      // criterio de arriba). Sin registry no hay métricas que decir, y la pantalla lo dice.
      const proyectoActual = sid ? proyectos.find((p) => p.servicioId === sid) : undefined;
      const [met] = proyectoActual
        ? await tx`
          select mr.estado,
            (select count(*)::int from entrada_kpi e
              where e.registry_id = mr.id and e.workspace_id = mr.workspace_id) as total,
            (select count(*)::int from entrada_kpi e
              where e.registry_id = mr.id and e.workspace_id = mr.workspace_id
                and exists (select 1 from snapshot s
                  where s.entrada_kpi_id = e.id and s.workspace_id = e.workspace_id)) as listas,
            -- Las que faltan Y puede cargar quien mira: la política del snapshot exige ser
            -- curador o el propietario del dato de ESA entrada (medicion.servicio), así que
            -- una entrada de otro propietario no es tarea suya.
            (select count(*)::int from entrada_kpi e
              left join miembro m
                on m.id = e.propietario_miembro_id and m.workspace_id = e.workspace_id
              where e.registry_id = mr.id and e.workspace_id = mr.workspace_id
                and not exists (select 1 from snapshot s
                  where s.entrada_kpi_id = e.id and s.workspace_id = e.workspace_id)
                and (workspace_role(${actorId}, ${workspaceId}) = any(${[...ROLES_CURADORES]})
                  or m.usuario_id = ${actorId})) as sin_snapshot_mias,
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
            sinSnapshotMias: met.sin_snapshot_mias as number,
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
