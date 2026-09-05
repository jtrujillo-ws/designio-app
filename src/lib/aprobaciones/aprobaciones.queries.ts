import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import {
  criteriosCompletos,
  faltaParaAprobarGate,
  type CriterioDeReto,
  type GateDeProyecto,
} from '@/lib/metodo/metodo.schemas';
import {
  clasesDelRol,
  type ClasePendiente,
  type ConteoDePendientes,
  type DerechoPendiente,
  type DesignVersionPendiente,
  type GateAbierto,
  type GatePendiente,
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
 * El rol NO viaja desde el cliente: se le pregunta UNA vez a la base (`workspace_role`, la
 * misma función que usan las políticas que luego aceptan o rechazan la decisión) y de ahí
 * salen dos cosas: qué clases consultar siquiera —un sponsor no valida insights, así que
 * no se cuenta nada suyo— y de qué gates es aprobador.
 */

/** El rol del actor en el workspace, según la base; '' si no es miembro. */
export async function rolEnWorkspace(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
): Promise<string> {
  const [fila] = await tx`select workspace_role(${actorId}, ${workspaceId}) as rol`;
  return (fila?.rol as string | null) ?? '';
}

/**
 * El gate ABIERTO (primero pendiente) de cada proyecto del workspace, con su checklist y
 * con las entradas que `faltaParaAprobarGate` pide: es el MISMO predicado que decide el
 * botón en la pantalla del proyecto, con los mismos datos que ella le da (checklist con
 * decisiones en revisión, gates anteriores, criterios del reto para G0, registry del reto
 * para G6, arquetipos en hipótesis para G2, estado del proyecto). Un predicado propio aquí
 * —«checklist decidido» a secas— listaba gates que la base iba a rechazar.
 *
 * Trae TODOS los abiertos, sean de quien sean: el resumen del loop nombra también los que
 * esperan a otro rol («G5 espera al sponsor»). Quien mira se queda los suyos por `esMia`.
 * Son pocas filas —una por proyecto con gates pendientes—, y las proyecciones de checklist
 * y criterios copian la forma de `proyectoDelMetodo` para que el predicado reciba lo mismo.
 */
export async function gatesAbiertos(
  tx: TransactionSql,
  rol: string,
  workspaceId: string,
): Promise<GateAbierto[]> {
  const filas = await tx`
    select g.id, g.numero, g.rol_aprobador, g.estado, g.aprobado_en::text as aprobado_en,
      p.id as proyecto_id, p.codigo as proyecto_codigo, p.estado as proyecto_estado,
      r.codigo as reto_codigo,
      coalesce((select jsonb_agg(jsonb_build_object(
          'id', ci.id, 'orden', ci.orden, 'texto', ci.texto, 'estado', ci.estado,
          'objetoClase', case
            when ci.evidencia_id is not null then 'evidencia'
            when ci.insight_id is not null then 'insight'
            when ci.decision_id is not null then 'decision' end,
          'objetoId', coalesce(ci.evidencia_id, ci.insight_id, ci.decision_id),
          'objetoTitulo', coalesce(ev.titulo, ins.titulo, dec.titulo),
          'decisionEnRevision', (dec.id is not null and dec.estado <> 'vigente'),
          'naJustificacion', ci.na_justificacion)
          order by ci.orden)
        from checklist_item ci
        left join evidencia ev on ev.id = ci.evidencia_id and ev.workspace_id = ci.workspace_id
        left join insight ins on ins.id = ci.insight_id and ins.workspace_id = ci.workspace_id
        left join decision dec on dec.id = ci.decision_id and dec.workspace_id = ci.workspace_id
        where ci.gate_id = g.id and ci.workspace_id = g.workspace_id), '[]'::jsonb) as items,
      not exists (select 1 from gate_instancia g2
        where g2.proyecto_id = g.proyecto_id and g2.workspace_id = g.workspace_id
          and g2.numero < g.numero and g2.estado <> 'aprobado') as anteriores_aprobados,
      coalesce((select jsonb_agg(jsonb_build_object(
          'id', c.id, 'kpi', c.kpi, 'definicion', c.definicion,
          'lineaBaseValor', c.linea_base_valor, 'lineaBaseFecha', c.linea_base_fecha::text,
          'lineaBasePlan', c.linea_base_plan, 'objetivo', c.objetivo,
          'ventanaDias', c.ventana_dias, 'fechaPostMortem', c.fecha_post_mortem::text)
          order by c.creado_en, c.id)
        from criterio_exito c
        where c.reto_id = r.id and c.workspace_id = r.workspace_id), '[]'::jsonb) as criterios,
      exists (select 1 from metric_registry mr
        where mr.reto_id = r.id and mr.workspace_id = r.workspace_id
          and mr.estado = 'firmado') as registry_firmado,
      (select count(*)::int from arquetipo a
        where a.reto_id = r.id and a.workspace_id = r.workspace_id
          and a.estado = 'hipotesis') as arquetipos_sin_veredicto
    from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id
    where g.workspace_id = ${workspaceId}
      and g.estado = 'pendiente'
      and g.numero = (select min(g2.numero) from gate_instancia g2
        where g2.proyecto_id = g.proyecto_id and g2.workspace_id = g.workspace_id
          and g2.estado = 'pendiente')
    order by r.codigo, r.id, p.codigo, p.id, g.numero`;
  return filas.map((f) => ({
    gate: {
      id: f.id as string,
      numero: f.numero as number,
      rolAprobador: f.rol_aprobador as GateDeProyecto['rolAprobador'],
      estado: f.estado as GateDeProyecto['estado'],
      aprobadoEn: (f.aprobado_en as string | null) ?? null,
      items: f.items as GateDeProyecto['items'],
    },
    esMia: (f.rol_aprobador as string) === rol,
    proyectoId: f.proyecto_id as string,
    proyectoCodigo: f.proyecto_codigo as string,
    retoCodigo: f.reto_codigo as string,
    contexto: {
      anterioresAprobados: f.anteriores_aprobados as boolean,
      criteriosListosG0: criteriosCompletos(f.criterios as CriterioDeReto[]),
      registryFirmadoG6: f.registry_firmado as boolean,
      arquetiposSinVeredicto: f.arquetipos_sin_veredicto as number,
      proyectoEstado: f.proyecto_estado as string,
    },
  }));
}

/** Los gates abiertos que esperan a QUIEN MIRA, con lo que les falta según el predicado. */
export function gatesDelRol(abiertos: GateAbierto[]): GatePendiente[] {
  return abiertos
    .filter((g) => g.esMia)
    .map((g) => ({
      gateId: g.gate.id,
      numero: g.gate.numero,
      rolAprobador: g.gate.rolAprobador,
      proyectoId: g.proyectoId,
      proyectoCodigo: g.proyectoCodigo,
      retoCodigo: g.retoCodigo,
      falta: faltaParaAprobarGate(g.gate, g.contexto),
    }));
}

/**
 * Las tres decisiones que no son gates, solo de las clases pedidas: quien llama ya sabe qué
 * decide el rol (`clasesDelRol`), y una clase que no le toca no se consulta. Van separadas
 * de los gates porque el resumen del loop lee los gates aparte y no debe leerlos dos veces.
 */
export async function otrosPendientes(
  tx: TransactionSql,
  workspaceId: string,
  clases: readonly ClasePendiente[],
): Promise<Pick<PendientesDelRol, 'derechos' | 'insights' | 'designVersions'>> {
  // Derechos sin decidir. Se listan por evidencia con su fuente, que es cómo la pantalla
  // de evidencia los nombra; los más antiguos primero, porque son los que más esperan.
  const filasDerechos = clases.includes('derecho')
    ? await tx`
      select d.evidencia_id, e.titulo, f.titulo as fuente_titulo, d.creado_en
      from derecho_uso d
      join evidencia e on e.id = d.evidencia_id and e.workspace_id = d.workspace_id
      join fuente f on f.id = e.fuente_id and f.workspace_id = e.workspace_id
      where d.workspace_id = ${workspaceId} and d.estado = 'pendiente'
      order by d.creado_en, d.id`
    : [];
  const derechos: DerechoPendiente[] = filasDerechos.map((f) => ({
    evidenciaId: f.evidencia_id as string,
    titulo: f.titulo as string,
    fuenteTitulo: f.fuente_titulo as string,
    creadoEn: (f.creado_en as Date).toISOString(),
  }));

  // Insights propuestos, con la cuenta de afirmaciones sin RESPALDO: no-hipótesis sin
  // ninguna cita cuya evidencia tenga derechos vigentes para el ámbito cliente. Es el
  // predicado de `insight_validar_guard` (desde 20260902310000), invocando el mismo
  // `evidencia_usable` que él: una cita que existe pero cuya evidencia perdió los derechos
  // ya no sostiene nada, y contarla habría prometido una validación que la base rechaza.
  const filasInsights = clases.includes('insight')
    ? await tx`
      select i.id, i.titulo, i.creado_en,
        (select count(*)::int from afirmacion a
          where a.insight_id = i.id and a.workspace_id = i.workspace_id) as afirmaciones,
        (select count(*)::int from afirmacion a
          where a.insight_id = i.id and a.workspace_id = i.workspace_id
            and not a.es_hipotesis
            and not exists (select 1 from cita c
              where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
                and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'))) as sin_respaldo
      from insight i
      where i.workspace_id = ${workspaceId} and i.estado = 'propuesto'
      order by i.creado_en, i.id`
    : [];
  const insights: InsightPendiente[] = filasInsights.map((f) => ({
    insightId: f.id as string,
    titulo: f.titulo as string,
    afirmaciones: f.afirmaciones as number,
    afirmacionesSinRespaldo: f.sin_respaldo as number,
    creadoEn: (f.creado_en as Date).toISOString(),
  }));

  // Design versions en borrador, con las dos condiciones que su pantalla exige antes de
  // dejar aprobar (journey to-be enlazado, algún elemento de cambio). Se listan aunque
  // les falte una: la versión sigue esperando al lead, que es quien puede resolverlo.
  // Fuera quedan los borradores de un proyecto que YA certificó G6/G7: su pantalla no deja
  // aprobarlos (la certificación no se deshace, SPEC-04) y tampoco se borran ni se mueven,
  // así que no son una decisión pendiente sino un resto —contarlos dejaba el contador del
  // lateral encendido para siempre—. Se pregunta a la MISMA función que usa el guard.
  const filasDv = clases.includes('design-version')
    ? await tx`
      select dv.id, dv.codigo, dv.titulo, dv.creado_en, p.codigo as proyecto_codigo,
        dv.journey_id is not null as journey_enlazado,
        exists (select 1 from elemento_cambio ec
          where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id) as con_elementos
      from design_version dv
      join proyecto p on p.id = dv.proyecto_id and p.workspace_id = dv.workspace_id
      where dv.workspace_id = ${workspaceId} and dv.estado = 'borrador'
        and gate_certificado_del_proyecto(dv.proyecto_id, dv.workspace_id) is null
      order by dv.creado_en, dv.id`
    : [];
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

/**
 * Solo el CONTEO de las tres clases que no son gates, en una sentencia de escalares: es lo
 * que el resumen del loop necesita para el contador del lateral, y materializar las filas
 * —con sus joins y sus subconsultas por insight— para quedarse con `.length` en cada carga
 * de /app era pagar la pantalla entera sin abrirla. Las clases que el rol no decide van a
 * cero sin consultarse. Los predicados son los MISMOS que arriba: cambiar uno sin el otro
 * dejaría al contador diciendo un número que la pantalla no enseña, y el test de igualdad
 * contador-pantalla existe para eso.
 */
export async function conteoDeOtrosPendientes(
  tx: TransactionSql,
  workspaceId: string,
  clases: readonly ClasePendiente[],
): Promise<Pick<ConteoDePendientes['porClase'], 'derecho' | 'insight' | 'design-version'>> {
  if (!['derecho', 'insight', 'design-version'].some((c) => clases.includes(c as ClasePendiente))) {
    return { derecho: 0, insight: 0, 'design-version': 0 };
  }
  const [fila] = await tx`select
    ${
      clases.includes('derecho')
        ? tx`(select count(*)::int from derecho_uso d
            where d.workspace_id = ${workspaceId} and d.estado = 'pendiente')`
        : tx`0::int`
    } as derechos,
    ${
      clases.includes('insight')
        ? tx`(select count(*)::int from insight i
            where i.workspace_id = ${workspaceId} and i.estado = 'propuesto')`
        : tx`0::int`
    } as insights,
    ${
      clases.includes('design-version')
        ? tx`(select count(*)::int from design_version dv
            where dv.workspace_id = ${workspaceId} and dv.estado = 'borrador'
              and gate_certificado_del_proyecto(dv.proyecto_id, dv.workspace_id) is null)`
        : tx`0::int`
    } as design_versions`;
  return {
    derecho: fila!.derechos as number,
    insight: fila!.insights as number,
    'design-version': fila!.design_versions as number,
  };
}

/** Las cuatro clases juntas, dentro de una transacción con contexto RLS ya abierta. */
export async function pendientesEnWorkspace(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
): Promise<PendientesDelRol> {
  const rol = await rolEnWorkspace(tx, actorId, workspaceId);
  const clases = clasesDelRol(rol);
  const gates = clases.includes('gate')
    ? gatesDelRol(await gatesAbiertos(tx, rol, workspaceId))
    : [];
  const otros = await otrosPendientes(tx, workspaceId, clases);
  return { workspaceId, gates, ...otros };
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
