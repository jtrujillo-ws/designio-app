import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { checklistParaPerfil, ETAPAS_CANONICAS, rolAprobadorDeGate } from './metodo.plantillas';
import type {
  ActivarReto,
  AprobarGate,
  CrearReto,
  CriterioEntrada,
  EditarCriterio,
  MarcarItem,
  ProyectoMetodo,
} from './metodo.schemas';

/**
 * Método como código (SPEC-04, slice 1): retos con criterios, activación → proyecto con
 * perfil, etapas canónicas y gates con checklist y aprobación por rol. Capa 1: RLS
 * (transiciones exigidas por política, aprobado inmutable, checklist congelado con el
 * gate). Capa 2: estado de cuenta + validaciones de dominio de este módulo, con las
 * decisiones y su rol auditado en LA MISMA sentencia que las ejecuta.
 */

export class ErrorMetodo extends Error {}

export async function crearReto(actorId: string, entrada: CrearReto): Promise<{ retoId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El ancla no se duplica como afectado; la relación «afecta» es adicional (RF-04.1).
    const afectados = [...new Set(entrada.serviciosAfectados)].filter(
      (s) => s !== entrada.servicioAnclaId,
    );
    // UNA sentencia: reto + aristas + evento comparten snapshot y el rol auditado es el
    // que autorizó el insert (misma disciplina que la bandeja de importación).
    const [fila] = await tx`
      with quien as (
        select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
      ),
      nuevo as (
        insert into reto (workspace_id, servicio_ancla_id, codigo, titulo, descripcion,
                          estado, origen, metrica_objetivo, creado_por)
        values (${entrada.workspaceId}, ${entrada.servicioAnclaId}, ${entrada.codigo},
                ${entrada.titulo}, ${entrada.descripcion}, 'candidato', ${entrada.origen},
                ${entrada.metricaObjetivo}, ${actorId})
        returning id
      ),
      aristas as (
        insert into reto_servicio_afectado (reto_id, servicio_id, workspace_id, creado_por)
        select nuevo.id, s.id, ${entrada.workspaceId}, ${actorId}
        from nuevo, jsonb_array_elements_text(${tx.json(afectados)}) afectado(sid)
        join servicio s on s.id = afectado.sid::uuid and s.workspace_id = ${entrada.workspaceId}
        returning servicio_id
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${entrada.workspaceId}, 'RetoCreado',
               jsonb_build_object('retoId', nuevo.id, 'codigo', ${entrada.codigo}::text,
                                  'origen', ${entrada.origen}::text),
               ${actorId}, quien.rol
        from nuevo, quien
      )
      select nuevo.id, (select count(*)::int from aristas) as enlazadas from nuevo`;
    // El join contra servicio filtra ids ajenos o inexistentes: si el conteo no cuadra,
    // la relación «afecta» prometida NO quedó registrada — se revierte, no se calla.
    if ((fila!.enlazadas as number) !== afectados.length) {
      throw new ErrorMetodo('Algún servicio afectado no existe en este workspace');
    }
    return { retoId: fila!.id as string };
  });
}

export async function agregarCriterio(
  actorId: string,
  entrada: CriterioEntrada,
): Promise<{ criterioId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Serializa contra la decisión de G0: sin el candado, este insert y una aprobación
    // concurrente podrían commitear juntos y congelar un criterio incompleto. El
    // evento CriterioDefinido lo emite el guard de la transición.
    await bloquearReto(tx, entrada.retoId);
    let fila;
    try {
      [fila] = await tx`
        insert into criterio_exito (workspace_id, reto_id, kpi, definicion, linea_base_valor,
                                    linea_base_fecha, linea_base_plan, objetivo, ventana_dias,
                                    fecha_post_mortem, creado_por)
        values (${entrada.workspaceId}, ${entrada.retoId}, ${entrada.kpi}, ${entrada.definicion},
                ${entrada.lineaBaseValor}, ${entrada.lineaBaseFecha}, ${entrada.lineaBasePlan},
                ${entrada.objetivo}, ${entrada.ventanaDias}, ${entrada.fechaPostMortem}, ${actorId})
        returning id`;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // El guard habla ANTES que el WITH CHECK (P0001): traducirlo al contrato.
      if (err.code === 'P0001' && err.message?.includes('congelados')) {
        throw new ErrorMetodo('Los criterios están congelados: el G0 del reto ya fue aprobado');
      }
      throw e;
    }
    return { criterioId: fila!.id as string };
  });
}

/** Editar un criterio completo ANTES de que el G0 del reto se apruebe (después la
 * política lo congela — 0 filas aquí). Es el camino de reparación de borradores: un
 * criterio incompleto bloquea G0 y agregar otros completos no lo desbloquea. */
export async function editarCriterio(actorId: string, entrada: EditarCriterio): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [dueno] = await tx`select reto_id from criterio_exito
      where id = ${entrada.criterioId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) {
      throw new ErrorMetodo('El criterio no existe en este workspace');
    }
    // Mismo candado que agregarCriterio: editar y decidir G0 no pueden entrecruzarse.
    // El evento CriterioEditado lo emite el guard de la transición.
    await bloquearReto(tx, dueno.reto_id as string);
    const filas = await tx`
      update criterio_exito
      set kpi = ${entrada.kpi}, definicion = ${entrada.definicion},
          linea_base_valor = ${entrada.lineaBaseValor},
          linea_base_fecha = ${entrada.lineaBaseFecha},
          linea_base_plan = ${entrada.lineaBasePlan},
          objetivo = ${entrada.objetivo}, ventana_dias = ${entrada.ventanaDias},
          fecha_post_mortem = ${entrada.fechaPostMortem}
      where id = ${entrada.criterioId} and workspace_id = ${entrada.workspaceId}`;
    if (filas.count === 0) {
      throw new ErrorMetodo(
        'El criterio está congelado por un G0 aprobado o no puedes editarlo',
      );
    }
  });
}

/**
 * Activar el reto abre el proyecto con su perfil (RF-04.3): etapas 0-7 canónicas, gates
 * G0-G7 con su rol aprobador y el checklist de suficiencia sembrado según perfil. La
 * transición candidato→activo es la sentencia decisora (0 filas = no era candidato, no
 * existe o el actor no es lead) y de su snapshot sale el rol auditado.
 */
export async function activarReto(
  actorId: string,
  entrada: ActivarReto,
): Promise<{ proyectoId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);

    const activado = await tx`
      update reto set estado = 'activo'
      where id = ${entrada.retoId} and workspace_id = ${entrada.workspaceId}
        and estado = 'candidato'
      returning workspace_role(${actorId}, workspace_id) as rol`;
    if (activado.length === 0) {
      throw new ErrorMetodo('El reto no existe, no está en candidato o no puedes activarlo');
    }
    const rol = activado[0]!.rol as string;

    const [proyecto] = await tx`
      insert into proyecto (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${entrada.workspaceId}, ${entrada.retoId}, ${entrada.proyectoCodigo},
              ${entrada.proyectoTitulo}, 'activo', ${entrada.perfil}, ${actorId})
      returning id`;
    const proyectoId = proyecto!.id as string;

    const etapas = ETAPAS_CANONICAS.map((nombre, numero) => ({ numero, nombre }));
    await tx`
      insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre)
      select ${entrada.workspaceId}, ${proyectoId}, e.numero, e.nombre
      from jsonb_to_recordset(${tx.json(etapas)}) as e(numero int, nombre text)`;

    const gates = etapas.map(({ numero }) => ({ numero, rol: rolAprobadorDeGate(numero) }));
    await tx`
      insert into gate_instancia (workspace_id, proyecto_id, numero, rol_aprobador)
      select ${entrada.workspaceId}, ${proyectoId}, g.numero, g.rol
      from jsonb_to_recordset(${tx.json(gates)}) as g(numero int, rol text)`;

    const items = gates.flatMap(({ numero }) =>
      checklistParaPerfil(numero, entrada.perfil).map((texto, orden) => ({
        gate: numero,
        orden,
        texto,
      })),
    );
    await tx`
      insert into checklist_item (workspace_id, gate_id, orden, texto)
      select ${entrada.workspaceId}, g.id, i.orden, i.texto
      from jsonb_to_recordset(${tx.json(items)}) as i(gate int, orden int, texto text)
      join gate_instancia g
        on g.proyecto_id = ${proyectoId} and g.workspace_id = ${entrada.workspaceId}
       and g.numero = i.gate`;

    await tx`
      insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (${entrada.workspaceId}, 'RetoActivado',
        ${tx.json({ retoId: entrada.retoId, proyectoId, perfil: entrada.perfil })},
        ${actorId}, ${rol})`;

    return { proyectoId };
  });
}

/** Candado consultivo transaccional por gate: marcar checklist y aprobar el gate deben
 * serializarse entre sí — bajo READ COMMITTED cada sentencia decisora lee un snapshot
 * que no ve el write concurrente de la otra y ninguna bloquea a la otra por filas, así
 * que sin el candado podrían commitear un gate aprobado con un ítem devuelto a
 * pendiente. Tomado ANTES de la sentencia decisora en ambos lados, la que llega segunda
 * arranca su snapshot con el resultado de la primera ya confirmado. */
async function bloquearGate(tx: TransactionSql, gateId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:gate:' || ${gateId}, 42))`;
}

/** Candado por reto: los criterios se congelan cuando CUALQUIER G0 del reto se aprueba,
 * así que mutar criterios y decidir un G0 deben serializarse a nivel de reto (misma
 * carrera de snapshots que marcar↔aprobar). Toda operación que tome ambos candados los
 * toma en este orden — reto y DESPUÉS gate — y cualquier servicio futuro que edite
 * criterios debe tomar este candado antes de su sentencia decisora.
 *
 * Se EXPORTA porque ya no es solo del método: desde SPEC-06, quitarle el release a un
 * elemento tiene que serializarse contra la aprobación de G6 (lo que el gate certificó
 * sigue siendo cierto), y `entrega.servicio` lo toma para eso. El nombre del candado tiene
 * que ser el mismo en los dos lados o no hay serialización ninguna, así que se comparte la
 * función en vez de repetir la cadena — es el primero de los dos que toma `aprobarGate`,
 * de modo que quien lo tome no puede adelantarse a una aprobación en curso. */
export async function bloquearReto(tx: TransactionSql, retoId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`;
}

/** Marca un ítem del checklist (RF-04.6): cumplido con evidencia real, pendiente, o N/A
 * (la política exige que quien lo marca TENGA el rol aprobador del gate y quede como su
 * aprobador). Un ítem ya en N/A solo lo revierte ese mismo rol — un curador no deshace la
 * decisión — y al revertirlo el evento conserva quién lo había aprobado y con qué
 * justificación. Un gate aprobado congela su checklist (la política de UPDATE no lo
 * alcanza). */
export async function marcarItem(actorId: string, entrada: MarcarItem): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const a = entrada.accion;

    const [dueno] = await tx`select gate_id from checklist_item
      where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) {
      throw new ErrorMetodo('El ítem no existe, su gate ya fue aprobado o no puedes marcarlo');
    }
    await bloquearGate(tx, dueno.gate_id as string);

    let filas;
    try {
      // El evento ItemMarcado (con lo previo) lo emite el guard de la transición
      // DENTRO de este UPDATE — también para SQL directo, mismo snapshot y rol.
      // Cumplir cita EXACTAMENTE un objeto real (RF-04.5): la clase decide en cuál de
      // las tres columnas aterriza el enlace; las otras dos quedan nulas (el CHECK de
      // la tabla exige num_nonnulls = 1, así que un bug aquí revienta, no se cuela).
      const cumplido = a.tipo === 'cumplido' ? a : null;
      filas = await tx`
        update checklist_item
        set estado = ${a.tipo},
            evidencia_id = ${cumplido?.objetoClase === 'evidencia' ? cumplido.objetoId : null},
            insight_id = ${cumplido?.objetoClase === 'insight' ? cumplido.objetoId : null},
            decision_id = ${cumplido?.objetoClase === 'decision' ? cumplido.objetoId : null},
            na_justificacion = ${a.tipo === 'na' ? a.justificacion : ''},
            na_aprobado_por = ${a.tipo === 'na' ? actorId : null}
        where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId}`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      // WITH CHECK violado (42501): rol insuficiente para la transición pedida.
      if (code === '42501' && a.tipo === 'na') {
        throw new ErrorMetodo('Solo el rol aprobador del gate marca N/A');
      }
      if (code === '42501') {
        throw new ErrorMetodo('Solo lead o diseñador marcan cumplido/pendiente');
      }
      // FK compuesta (23503): el objeto citado no existe en este workspace.
      if (code === '23503') {
        throw new ErrorMetodo('El objeto enlazado no existe en este workspace');
      }
      // Guard de la base (P0001): la decisión citada es de otro proyecto.
      if (code === 'P0001' && (e as { message?: string }).message) {
        throw new ErrorMetodo((e as { message: string }).message);
      }
      throw e;
    }
    if (filas.count === 0) {
      throw new ErrorMetodo('El ítem no existe, su gate ya fue aprobado o no puedes marcarlo');
    }
  });
}

/**
 * Aprobar un gate (RF-04.7): la MISMA sentencia exige rol aprobador (política), checklist
 * sin pendientes y — para G0 — criterios presentes y completos (definición, objetivo,
 * ventana y línea base con valor y fecha, o plan — SYS-22). 0 filas = bloqueado; el
 * diagnóstico posterior lista qué faltó. Los candados de reto y gate (en ese orden) serializan esta decisión contra
 * agregarCriterio y marcarItem.
 */
export async function aprobarGate(
  actorId: string,
  entrada: AprobarGate,
): Promise<{ numero: number }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // proyecto_id y reto_id son inmutables: leerlos antes del candado no abre carrera.
    const [pertenece] = await tx`
      select p.reto_id from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      where g.id = ${entrada.gateId} and g.workspace_id = ${entrada.workspaceId}`;
    if (!pertenece) {
      throw new ErrorMetodo(await diagnosticoDeGate(tx, entrada.workspaceId, entrada.gateId));
    }
    await bloquearReto(tx, pertenece.reto_id as string);
    await bloquearGate(tx, entrada.gateId);

    const aprobado = await tx`
      update gate_instancia g
      set estado = 'aprobado', aprobado_por = ${actorId}, aprobado_en = now()
      where g.id = ${entrada.gateId} and g.workspace_id = ${entrada.workspaceId}
        and g.estado = 'pendiente'
        and not exists (select 1 from checklist_item ci
          where ci.gate_id = g.id and ci.workspace_id = g.workspace_id
            and ci.estado = 'pendiente')
        and exists (select 1 from checklist_item ci
          where ci.gate_id = g.id and ci.workspace_id = g.workspace_id)
        and not exists (select 1 from gate_instancia g2
          where g2.proyecto_id = g.proyecto_id and g2.workspace_id = g.workspace_id
            and g2.numero < g.numero and g2.estado <> 'aprobado')
        and (g.numero <> 0 or exists (select 1
          from criterio_exito c
          join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
          where c.reto_id = p.reto_id and c.workspace_id = g.workspace_id))
        and (g.numero <> 0 or not exists (select 1
          from criterio_exito c
          join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
          where c.reto_id = p.reto_id and c.workspace_id = g.workspace_id
            and (c.ventana_dias is null
                 or btrim(c.kpi) = '' or btrim(c.definicion) = '' or btrim(c.objetivo) = ''
                 or ((nullif(btrim(c.linea_base_valor), '') is null or c.linea_base_fecha is null)
                     and btrim(c.linea_base_plan) = ''))))
      returning g.numero`;

    if (aprobado.length === 0) {
      throw new ErrorMetodo(await diagnosticoDeGate(tx, entrada.workspaceId, entrada.gateId));
    }
    // La etapa completada (RF-04.4) y el evento GateAprobado los aplica el guard de la
    // transición DENTRO del propio UPDATE — inseparables también para SQL directo.
    return { numero: aprobado[0]!.numero as number };
  });
}

/** Por qué NO se aprobó: pendientes del checklist y, en G0, criterios incompletos
 * (RF-04.8 sin AI: el reporte "qué falta" nace de los datos; el asistente llega con
 * SPEC-08 y jamás aprobará — SYS-18). Solo para mensajes: corre tras el update fallido. */
async function diagnosticoDeGate(
  tx: TransactionSql,
  workspaceId: string,
  gateId: string,
): Promise<string> {
  const [gate] = await tx`
    select g.numero, g.estado, g.rol_aprobador, g.proyecto_id
    from gate_instancia g
    where g.id = ${gateId} and g.workspace_id = ${workspaceId}`;
  if (!gate) return 'El gate no existe en este workspace';
  if (gate.estado === 'aprobado') return 'El gate ya está aprobado';

  const pendientes = await tx`
    select texto from checklist_item
    where gate_id = ${gateId} and workspace_id = ${workspaceId} and estado = 'pendiente'
    order by orden`;
  if (pendientes.length > 0) {
    const lista = pendientes.map((p) => `«${p.texto as string}»`).join(', ');
    return `Checklist con pendientes: ${lista}`;
  }
  const [conItems] = await tx`
    select count(*)::int as n from checklist_item
    where gate_id = ${gateId} and workspace_id = ${workspaceId}`;
  if ((conItems!.n as number) === 0) {
    return 'El gate no tiene checklist instanciado: un checklist vacío no es suficiencia';
  }

  const anteriores = await tx`
    select g2.numero from gate_instancia g2
    where g2.proyecto_id = ${gate.proyecto_id as string} and g2.workspace_id = ${workspaceId}
      and g2.numero < ${gate.numero as number} and g2.estado <> 'aprobado'
    order by g2.numero`;
  if (anteriores.length > 0) {
    const lista = anteriores.map((g2) => `G${g2.numero as number}`).join(', ');
    return `Los gates anteriores deben aprobarse primero (pendientes: ${lista})`;
  }

  if ((gate.numero as number) === 0) {
    // Criterio completo (SYS-22) = definición + objetivo + ventana + línea base
    // REGISTRADA (valor Y fecha: sin fecha no hay punto de partida temporal) o plan.
    // btrim en todos los textos: whitespace no es contenido, ni siquiera por SQL directo.
    const incompletos = await tx`
      select c.kpi, (c.ventana_dias is null) as sin_ventana,
             (btrim(c.kpi) = '') as sin_kpi,
             (btrim(c.definicion) = '') as sin_definicion,
             (btrim(c.objetivo) = '') as sin_objetivo,
             ((nullif(btrim(c.linea_base_valor), '') is null or c.linea_base_fecha is null)
              and btrim(c.linea_base_plan) = '') as sin_base
      from criterio_exito c
      join proyecto p on p.id = ${gate.proyecto_id as string} and p.workspace_id = ${workspaceId}
      where c.reto_id = p.reto_id and c.workspace_id = ${workspaceId}
        and (c.ventana_dias is null
             or btrim(c.kpi) = '' or btrim(c.definicion) = '' or btrim(c.objetivo) = ''
             or ((nullif(btrim(c.linea_base_valor), '') is null or c.linea_base_fecha is null)
                 and btrim(c.linea_base_plan) = ''))`;
    if (incompletos.length > 0) {
      const lista = incompletos
        .map(
          (c) =>
            `«${c.kpi as string}» (${[
              c.sin_kpi ? 'sin KPI' : null,
              c.sin_definicion ? 'sin definición' : null,
              c.sin_objetivo ? 'sin objetivo' : null,
              c.sin_ventana ? 'sin ventana' : null,
              c.sin_base ? 'sin línea base completa (valor y fecha) ni plan' : null,
            ]
              .filter(Boolean)
              .join(' y ')})`,
        )
        .join(', ');
      return `G0 exige criterios completos (SYS-22): ${lista}`;
    }
    const [alguno] = await tx`
      select 1 as hay from criterio_exito c
      join proyecto p on p.id = ${gate.proyecto_id as string} and p.workspace_id = ${workspaceId}
      where c.reto_id = p.reto_id and c.workspace_id = ${workspaceId} limit 1`;
    if (!alguno) return 'G0 exige al menos un criterio de éxito definido (SYS-22)';
  }

  return `Solo el rol ${gate.rol_aprobador as string} puede aprobar este gate`;
}

/** Proyección de la pantalla del proyecto en UNA sentencia (un snapshot, orden estable). */
export async function proyectoMetodo(
  actorId: string,
  workspaceId: string,
  proyectoId: string,
): Promise<ProyectoMetodo | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await tx`
      select p.id, p.codigo, p.titulo, p.estado, p.perfil,
        (select to_jsonb(r) || jsonb_build_object('criterios', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', c.id, 'kpi', c.kpi, 'definicion', c.definicion,
              'lineaBaseValor', c.linea_base_valor, 'lineaBaseFecha', c.linea_base_fecha::text,
              'lineaBasePlan', c.linea_base_plan, 'objetivo', c.objetivo,
              'ventanaDias', c.ventana_dias, 'fechaPostMortem', c.fecha_post_mortem::text)
              order by c.creado_en, c.id)
            from criterio_exito c
            where c.reto_id = r.id and c.workspace_id = p.workspace_id), '[]'::jsonb))
          from (select r0.id, r0.codigo, r0.titulo, r0.estado from reto r0
                where r0.id = p.reto_id and r0.workspace_id = p.workspace_id) r
        ) as reto,
        coalesce((select jsonb_agg(jsonb_build_object(
            'id', e.id, 'numero', e.numero, 'nombre', e.nombre, 'estado', e.estado)
            order by e.numero)
          from etapa_instancia e
          where e.proyecto_id = p.id and e.workspace_id = p.workspace_id), '[]'::jsonb) as etapas,
        coalesce((select jsonb_agg(jsonb_build_object(
            'id', g.id, 'numero', g.numero, 'rolAprobador', g.rol_aprobador,
            'estado', g.estado, 'aprobadoEn', g.aprobado_en::text,
            'items', coalesce((select jsonb_agg(jsonb_build_object(
                'id', ci.id, 'orden', ci.orden, 'texto', ci.texto, 'estado', ci.estado,
                -- Un ítem cumplido cita exactamente un objeto (CHECK de la tabla): la
                -- clase y el título salen del que esté enlazado, sin ambigüedad.
                'objetoClase', case
                  when ci.evidencia_id is not null then 'evidencia'
                  when ci.insight_id is not null then 'insight'
                  when ci.decision_id is not null then 'decision' end,
                'objetoId', coalesce(ci.evidencia_id, ci.insight_id, ci.decision_id),
                'objetoTitulo', coalesce(ev.titulo, ins.titulo, dec.titulo),
                'naJustificacion', ci.na_justificacion)
                order by ci.orden)
              from checklist_item ci
              left join evidencia ev
                on ev.id = ci.evidencia_id and ev.workspace_id = ci.workspace_id
              left join insight ins
                on ins.id = ci.insight_id and ins.workspace_id = ci.workspace_id
              left join decision dec
                on dec.id = ci.decision_id and dec.workspace_id = ci.workspace_id
              where ci.gate_id = g.id and ci.workspace_id = g.workspace_id), '[]'::jsonb))
            order by g.numero)
          from gate_instancia g
          where g.proyecto_id = p.id and g.workspace_id = p.workspace_id), '[]'::jsonb) as gates
      from proyecto p
      where p.id = ${proyectoId} and p.workspace_id = ${workspaceId}`;
    if (!fila) return null;
    const reto = fila.reto as {
      id: string;
      codigo: string;
      titulo: string;
      estado: string;
      criterios: ProyectoMetodo['reto']['criterios'];
    };
    return {
      id: fila.id as string,
      codigo: fila.codigo as string,
      titulo: fila.titulo as string,
      estado: fila.estado as string,
      perfil: fila.perfil as ProyectoMetodo['perfil'],
      reto,
      etapas: fila.etapas as ProyectoMetodo['etapas'],
      gates: fila.gates as ProyectoMetodo['gates'],
    };
  });
}
