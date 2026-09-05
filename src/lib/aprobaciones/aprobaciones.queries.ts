import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { ROLES_DERECHOS } from '@/lib/evidencia/evidencia.schemas';
import type { AprobacionPendiente } from '@/lib/loop/loop.schemas';
import {
  ROLES_APRUEBAN_DESIGN_VERSION,
  ROLES_VALIDAN_INSIGHT,
  type DerechoPendiente,
  type DesignVersionPendiente,
  type InsightPendiente,
  type PendientesDelRol,
} from './aprobaciones.schemas';

/**
 * Lo que el rol de quien mira puede decidir ahora en un workspace. Es UNA fuente para dos
 * lectores: la pantalla de aprobaciones (las filas) y el resumen del loop (solo el conteo,
 * para el contador del lateral). Las dos leen bajo el contexto RLS del usuario —cada tabla
 * tiene su política de lectura por membresía— y el filtro por workspace_id es la capa 2,
 * como en el árbol.
 *
 * El rol NO viaja desde el cliente: cada consulta lo pregunta a la base con
 * `workspace_role(actor, workspace)`, que es la misma función que usan las políticas que
 * luego aceptan o rechazan la decisión. Así una clase que el rol no puede decidir viene
 * vacía por construcción, y no por un `if` que alguien tenga que recordar en la UI.
 */

/**
 * Gates ABIERTOS (el primero pendiente de su proyecto) con el checklist entero decidido y
 * no vacío: dejaron de ser trabajo y esperan a su aprobador. Un checklist vacío no es
 * suficiencia (mismo criterio que el guard de la base), así que no cuenta. Cada fila dice
 * además si el aprobador es QUIEN MIRA: la pantalla del proyecto solo deja aprobar cuando
 * el rol coincide, y «Te toca a ti» no puede contar como propia una aprobación que espera
 * al sponsor —por eso el resumen del loop lee TODAS y esta proyección se queda las suyas—.
 * La suficiencia completa (criterios de G0, registry de G6, decisiones en revisión…) la
 * juzga la base al aprobar: aquí solo se cuenta lo que dejó de ser trabajo.
 */
export async function gatesQueEsperanAprobador(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
): Promise<AprobacionPendiente[]> {
  const filas = await tx`
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
  return filas.map((f) => ({
    gateId: f.id as string,
    numero: f.numero as number,
    rolAprobador: f.rol_aprobador as AprobacionPendiente['rolAprobador'],
    esMia: (f.es_mia as boolean | null) === true,
    proyectoId: f.proyecto_id as string,
    proyectoCodigo: f.proyecto_codigo as string,
    retoCodigo: f.reto_codigo as string,
  }));
}

/**
 * Las tres decisiones que no son gates, ya filtradas por el rol de quien mira. Van
 * separadas de los gates porque el resumen del loop lee los gates aparte (necesita también
 * los que esperan a OTRO rol) y no debe leerlos dos veces en la misma transacción.
 */
export async function otrosPendientesDelRol(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
): Promise<Pick<PendientesDelRol, 'derechos' | 'insights' | 'designVersions'>> {
  // Derechos sin decidir. Se listan por evidencia con su fuente, que es cómo la pantalla
  // de evidencia los nombra; los más antiguos primero, porque son los que más esperan.
  const filasDerechos = await tx`
    select d.evidencia_id, e.titulo, f.titulo as fuente_titulo, d.creado_en
    from derecho_uso d
    join evidencia e on e.id = d.evidencia_id and e.workspace_id = d.workspace_id
    join fuente f on f.id = e.fuente_id and f.workspace_id = e.workspace_id
    where d.workspace_id = ${workspaceId}
      and d.estado = 'pendiente'
      and workspace_role(${actorId}, ${workspaceId}) = any(${[...ROLES_DERECHOS]})
    order by d.creado_en, d.id`;
  const derechos: DerechoPendiente[] = filasDerechos.map((f) => ({
    evidenciaId: f.evidencia_id as string,
    titulo: f.titulo as string,
    fuenteTitulo: f.fuente_titulo as string,
    creadoEn: (f.creado_en as Date).toISOString(),
  }));

  // Insights propuestos, con la cuenta de afirmaciones sin cita: es exactamente lo que
  // `insight_validar_guard` rechaza (toda afirmación no-hipótesis exige cita), así que la
  // fila puede decir si la validación va a pasar o si antes falta trabajo.
  const filasInsights = await tx`
    select i.id, i.titulo, i.creado_en,
      (select count(*)::int from afirmacion a
        where a.insight_id = i.id and a.workspace_id = i.workspace_id) as afirmaciones,
      (select count(*)::int from afirmacion a
        where a.insight_id = i.id and a.workspace_id = i.workspace_id
          and not a.es_hipotesis
          and not exists (select 1 from cita c
            where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id)) as sin_cita
    from insight i
    where i.workspace_id = ${workspaceId}
      and i.estado = 'propuesto'
      and workspace_role(${actorId}, ${workspaceId}) = any(${[...ROLES_VALIDAN_INSIGHT]})
    order by i.creado_en, i.id`;
  const insights: InsightPendiente[] = filasInsights.map((f) => ({
    insightId: f.id as string,
    titulo: f.titulo as string,
    afirmaciones: f.afirmaciones as number,
    afirmacionesSinCita: f.sin_cita as number,
    creadoEn: (f.creado_en as Date).toISOString(),
  }));

  // Design versions en borrador, con las dos condiciones que su pantalla exige antes de
  // dejar aprobar (journey to-be enlazado, algún elemento de cambio). Se listan aunque
  // les falte una: la versión sigue esperando al lead, que es quien puede resolverlo.
  const filasDv = await tx`
    select dv.id, dv.codigo, dv.titulo, dv.creado_en, p.codigo as proyecto_codigo,
      dv.journey_id is not null as journey_enlazado,
      exists (select 1 from elemento_cambio ec
        where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id) as con_elementos
    from design_version dv
    join proyecto p on p.id = dv.proyecto_id and p.workspace_id = dv.workspace_id
    where dv.workspace_id = ${workspaceId}
      and dv.estado = 'borrador'
      and workspace_role(${actorId}, ${workspaceId}) = any(${[...ROLES_APRUEBAN_DESIGN_VERSION]})
    order by dv.creado_en, dv.id`;
  const designVersions: DesignVersionPendiente[] = filasDv.map((f) => ({
    designVersionId: f.id as string,
    codigo: f.codigo as string,
    titulo: f.titulo as string,
    proyectoCodigo: f.proyecto_codigo as string,
    journeyEnlazado: f.journey_enlazado as boolean,
    conElementos: f.con_elementos as boolean,
    creadoEn: (f.creado_en as Date).toISOString(),
  }));

  return { derechos, insights, designVersions };
}

/** Las cuatro clases juntas, dentro de una transacción con contexto RLS ya abierta. */
export async function pendientesEnWorkspace(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
): Promise<PendientesDelRol> {
  const gates = await gatesQueEsperanAprobador(tx, actorId, workspaceId);
  const otros = await otrosPendientesDelRol(tx, actorId, workspaceId);
  return {
    workspaceId,
    // Solo los que esperan a QUIEN MIRA: la pantalla lista decisiones propias.
    gates: gates
      .filter((g) => g.esMia)
      .map(({ gateId, numero, rolAprobador, proyectoId, proyectoCodigo, retoCodigo }) => ({
        gateId,
        numero,
        rolAprobador,
        proyectoId,
        proyectoCodigo,
        retoCodigo,
      })),
    ...otros,
  };
}

/**
 * Para un usuario autenticado: capa 2 de cuenta activa y RLS en la misma transacción.
 * REPEATABLE READ por la misma razón que el resumen del loop: son varias sentencias y un
 * workspace puede desaparecer entre una y otra por disposición acordada.
 */
export async function pendientesParaUsuario(
  actorId: string,
  workspaceId: string,
): Promise<PendientesDelRol> {
  return conUsuario(
    actorId,
    async (tx) => {
      await exigirCuentaActiva(tx, actorId);
      return pendientesEnWorkspace(tx, actorId, workspaceId);
    },
    { aislamiento: 'repeatable read' },
  );
}
