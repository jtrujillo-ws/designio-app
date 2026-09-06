import '@/lib/server-only';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import type {
  CrearArquetipo,
  GobernanzaDeProyecto,
  ReabrirEtapa,
  RegistrarDecision,
  VeredictoArquetipo,
} from './gobernanza.schemas';

type ApoyarArquetipoEntrada = { workspaceId: string; arquetipoId: string; evidenciaId: string };

/**
 * Gobernanza del método (SPEC-04): decisiones, arquetipos y reaperturas.
 *
 * Capa 1: RLS — el lead registra decisiones y reaperturas (opera el método), los
 * curadores definen arquetipos, y los guards de la base exigen lo que no puede quedar
 * en manos del servicio (un arquetipo confirmado SIN evidencia es la persona inventada
 * que el método existe para evitar).
 * Capa 2: estado de cuenta en toda operación y las reglas de este módulo — sobre todo
 * la que hace trazable una decisión: al menos un insight que la sostenga, enlazado en
 * la MISMA sentencia que la registra (nunca una decisión huérfana a medio camino).
 */

export class ErrorGobernanza extends Error {}

export async function registrarDecision(
  actorId: string,
  entrada: RegistrarDecision,
): Promise<{ decisionId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const insightIds = [...new Set(entrada.insightIds)];
    // UNA sentencia: la decisión, sus enlaces a insights y el evento comparten snapshot.
    // El join contra insight filtra ids ajenos o inexistentes; si el conteo no cuadra,
    // la cadena prometida NO quedó registrada y se revierte todo (nunca una decisión
    // que dice apoyarse en cinco insights y solo enlaza tres).
    const [fila] = await tx`
      with quien as (
        select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
      ),
      destino as (
        select g.id as gate_id, g.numero, g.proyecto_id
        from gate_instancia g
        where g.id = ${entrada.gateId} and g.workspace_id = ${entrada.workspaceId}
      ),
      nueva as (
        insert into decision (workspace_id, proyecto_id, gate_id, tipo, titulo,
                              fundamento, decidido_por, concepto_id)
        select ${entrada.workspaceId}, destino.proyecto_id, destino.gate_id,
               ${entrada.tipo}, ${entrada.titulo}, ${entrada.fundamento}, ${actorId},
               ${entrada.conceptoId ?? null}
        from destino
        returning id
      ),
      enlaces as (
        insert into decision_insight (decision_id, insight_id, workspace_id)
        select nueva.id, i.id, ${entrada.workspaceId}
        from nueva
        join insight i on i.workspace_id = ${entrada.workspaceId}
          and i.id = any(${insightIds}::uuid[])
          -- Solo VALIDADOS: el picker ya los filtra, pero el endpoint acepta uuids
          -- arbitrarios y una decisión apoyada en un insight propuesto sería una
          -- decisión sin cadena. Los que no cuadren hacen fallar el conteo de abajo.
          and i.estado = 'validado'
        returning insight_id
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${entrada.workspaceId}, 'DecisionAprobada',
          jsonb_build_object('decisionId', nueva.id, 'gateId', ${entrada.gateId}::uuid,
                             'tipo', ${entrada.tipo}::text, 'titulo', ${entrada.titulo}::text,
                             -- El evento dice SOBRE QUÉ se decidió, no solo de qué clase era.
                             -- Sin esto, la auditoría de un pasa/muere no llega al concepto.
                             'conceptoId', ${entrada.conceptoId ?? null}::uuid),
          ${actorId}, quien.rol
        from nueva, quien
      )
      select nueva.id, (select count(*)::int from enlaces) as enlazados from nueva`;
    if (!fila) {
      throw new ErrorGobernanza('El gate no existe en este workspace o no puedes decidir en él');
    }
    if ((fila.enlazados as number) !== insightIds.length) {
      throw new ErrorGobernanza(
        'Algún insight enlazado no existe en este workspace o todavía no está validado',
      );
    }
    return { decisionId: fila.id as string };
  });
}

/** Devolver a 'vigente' una decisión revisada tras una reapertura: el lead confirma que
 * sigue en pie con el contexto nuevo. La decisión no se reescribe — solo su estado. */
export async function revalidarDecision(
  actorId: string,
  workspaceId: string,
  decisionId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`
      with quien as (
        select workspace_role(${actorId}, ${workspaceId}) as rol
      ),
      upd as (
        update decision set estado = 'vigente'
        where id = ${decisionId} and workspace_id = ${workspaceId} and estado = 'en-revision'
        returning id
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${workspaceId}, 'DecisionRevalidada',
          jsonb_build_object('decisionId', upd.id), ${actorId}, quien.rol
        from upd, quien
      )
      select id from upd`;
    if (filas.length === 0) {
      throw new ErrorGobernanza('La decisión no existe, no está en revisión o no puedes revalidarla');
    }
  });
}

export async function crearArquetipo(
  actorId: string,
  entrada: CrearArquetipo,
): Promise<{ arquetipoId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // MISMO candado por reto que toma aprobarGate. Sin él, dar de alta una hipótesis y
    // aprobar G2 se cruzan: cada una ve el estado commiteado por la otra, tocan filas
    // distintas y ambas confirman — volviendo a dejar un G2 aprobado con un arquetipo
    // sin resolver, que es justo lo que la política nueva intenta impedir.
    await tx`select pg_advisory_xact_lock(
      hashtextextended('designio:reto:' || ${entrada.retoId}, 42))`;
    const segmentoIds = [...new Set(entrada.segmentoIds)];
    let fila;
    try {
      // Mismo contrato que la decisión: los segmentos prometidos se enlazan aquí o no
      // se enlazan (el mapeo n:m de RF-04.11 no puede quedar a medias).
      [fila] = await tx`
        with quien as (
          select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
        ),
        nuevo as (
          insert into arquetipo (workspace_id, reto_id, nombre, definicion, creado_por)
          values (${entrada.workspaceId}, ${entrada.retoId}, ${entrada.nombre},
                  ${entrada.definicion}, ${actorId})
          returning id
        ),
        mapeo as (
          insert into arquetipo_segmento (arquetipo_id, segmento_id, workspace_id)
          select nuevo.id, s.id, ${entrada.workspaceId}
          from nuevo
          join segmento s on s.workspace_id = ${entrada.workspaceId}
            and s.id = any(${segmentoIds}::uuid[])
          returning segmento_id
        ),
        evento as (
          insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
          select ${entrada.workspaceId}, 'ArquetipoDefinido',
            jsonb_build_object('arquetipoId', nuevo.id, 'retoId', ${entrada.retoId}::uuid,
                               'nombre', ${entrada.nombre}::text),
            ${actorId}, quien.rol
          from nuevo, quien
        )
        select nuevo.id, (select count(*)::int from mapeo) as mapeados from nuevo`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new ErrorGobernanza('Ya existe un arquetipo con ese nombre en el reto');
      }
      if (code === '23503') {
        throw new ErrorGobernanza('El reto no existe en este workspace');
      }
      // WITH CHECK (42501): o no curas, o el G2 del reto ya se aprobó y agregar una
      // hipótesis ahora la dejaría sin resolver para siempre.
      if (code === '42501') {
        throw new ErrorGobernanza(
          'No puedes definir arquetipos: o no eres curador, o el G2 del reto ya está ' +
            'aprobado (reabre la etapa 2 para agregar uno nuevo)',
        );
      }
      throw e;
    }
    if (!fila) {
      throw new ErrorGobernanza('No puedes definir arquetipos en este workspace');
    }
    if ((fila.mapeados as number) !== segmentoIds.length) {
      throw new ErrorGobernanza('Algún segmento no existe en este workspace');
    }
    return { arquetipoId: fila.id as string };
  });
}

/** Enlazar la evidencia que sostiene al arquetipo. Aditivo: quitar apoyo a un
 * arquetipo ya confirmado sería reescribir la razón por la que se confirmó. */
export async function apoyarArquetipo(
  actorId: string,
  entrada: ApoyarArquetipoEntrada,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    try {
      const filas = await tx`
        insert into arquetipo_evidencia (arquetipo_id, evidencia_id, workspace_id)
        values (${entrada.arquetipoId}, ${entrada.evidenciaId}, ${entrada.workspaceId})
        returning arquetipo_id`;
      if (filas.length === 0) {
        throw new ErrorGobernanza('No puedes enlazar evidencia a arquetipos en este workspace');
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new ErrorGobernanza('Esa evidencia ya sostiene este arquetipo');
      }
      if (code === '23503') {
        throw new ErrorGobernanza('El arquetipo o la evidencia no existen en este workspace');
      }
      throw e;
    }
  });
}

/** Confirmar o refutar: el arquetipo deja de ser hipótesis. Confirmar SIN evidencia lo
 * rechaza el guard de la base; la razón la exige el CHECK de la tabla. */
export async function darVeredictoArquetipo(
  actorId: string,
  entrada: VeredictoArquetipo,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let filas;
    try {
      filas = await tx`
        update arquetipo set estado = ${entrada.estado}, veredicto_razon = ${entrada.razon}
        where id = ${entrada.arquetipoId} and workspace_id = ${entrada.workspaceId}`;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'P0001' && err.message) {
        throw new ErrorGobernanza(err.message);
      }
      throw e;
    }
    if (filas!.count === 0) {
      throw new ErrorGobernanza('El arquetipo no existe, ya tiene veredicto o no puedes darlo');
    }
  });
}

/**
 * Reabrir una etapa (RF-04.9, SYS-10): registra el motivo, devuelve la etapa a curso y
 * marca EN REVISIÓN las decisiones AFECTADAS.
 *
 * «Afectadas» se computa, no se supone. Si la reapertura declara qué insights
 * cambiaron, solo entran en revisión las decisiones de ese gate en adelante que se
 * apoyan en alguno de ellos — que es lo que pide la spec y lo único que hace la marca
 * creíble. Si no declara ninguno, se marcan todas las de esa etapa hacia adelante: la
 * reapertura está diciendo que se movió el suelo entero, no que no se sabe. El alcance
 * elegido queda grabado en la fila, así que el tablero no confunde una cosa con la otra.
 *
 * Lo que NO hace, deliberadamente: desaprobar el gate. Una aprobación es un hecho
 * histórico con fecha y firma; la reapertura no lo borra, lo cuestiona. El tablero
 * muestra ambas cosas a la vez, que es exactamente la verdad del proyecto.
 *
 * Tampoco toma candado contra aprobarGate, y es intencional: si una aprobación entra
 * mientras se reabre, su decisión se registra DESPUÉS con el contexto nuevo — no queda
 * marcada, y es correcto que no lo esté. La reapertura cuestiona lo decidido ANTES,
 * no lo que se decide sabiendo que la etapa se reabrió.
 *
 * Sí lo toma, en cambio, contra el CIERRE del proyecto: ahí no hay lectura razonable del
 * entrecruce — un proyecto cerrado es historia inmutable (SYS-08) y reabrirle una etapa
 * después no cuestiona nada, corrompe.
 */
export async function reabrirEtapa(
  actorId: string,
  entrada: ReabrirEtapa,
): Promise<{ decisionesMarcadas: number }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // MISMO candado por reto que toma la completación del outcome review, que es quien
    // cierra el proyecto. Sin él los dos caminos tocan filas distintas y no se ven: la
    // completación cierra el proyecto y commitea, y esta reapertura —que ya evaluó su
    // predicado «el proyecto no está cerrado» contra el snapshot anterior— commitea
    // después una etapa `en-curso` y decisiones `en-revision` sobre lo que ya es
    // historia. `proyecto.reto_id` es inmutable: leerlo antes del candado no abre carrera.
    const [dueno] = await tx`select reto_id from proyecto
      where id = ${entrada.proyectoId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) throw new ErrorGobernanza('El proyecto no existe en este workspace');
    await tx`select pg_advisory_xact_lock(
      hashtextextended('designio:reto:' || ${dueno.reto_id as string}, 42))`;
    const insightIds = [...new Set(entrada.insightIds)];
    let fila;
    /*
     * El evento `EtapaReabierta` NO se emite aquí: lo emite el guard diferido de
     * `reapertura_etapa`, para que también lo produzca el SQL directo. Es la misma regla que
     * el resto del esquema —un evento en el servicio es una promesa; uno en el trigger es una
     * propiedad—, y aquí se volvió urgente cuando esa fila pasó a gobernar la salida de
     * 'completada': un registro sin rastro abría todas las ventanas del ciclo sin que
     * constara quién. Con el evento se fue el CTE `quien`, que solo existía para ponerle el
     * rol al actor.
     */
    try {
      [fila] = await tx`
        with declarados as (
          -- Los insights que existen DE VERDAD en el workspace: si el conteo no cuadra
          -- con lo pedido, la declaración era falsa y abajo se revierte todo.
          select i.id from insight i
          where i.workspace_id = ${entrada.workspaceId}
            and i.id = any(${insightIds}::uuid[])
        ),
        marcadas as (
          update decision d set estado = 'en-revision'
          from gate_instancia g
          where d.gate_id = g.id and d.workspace_id = g.workspace_id
            and d.proyecto_id = ${entrada.proyectoId}
            and d.workspace_id = ${entrada.workspaceId}
            and g.numero >= ${entrada.etapaNumero}
            and d.estado = 'vigente'
            and (
              cardinality(${insightIds}::uuid[]) = 0
              or exists (select 1 from decision_insight di
                where di.decision_id = d.id and di.workspace_id = d.workspace_id
                  and di.insight_id = any(${insightIds}::uuid[]))
            )
          returning d.id
        ),
        etapa as (
          update etapa_instancia set estado = 'en-curso'
          where proyecto_id = ${entrada.proyectoId} and workspace_id = ${entrada.workspaceId}
            and numero = ${entrada.etapaNumero}
          returning id
        ),
        registro as (
          insert into reapertura_etapa (workspace_id, proyecto_id, etapa_numero, motivo,
                                        alcance, decisiones_marcadas, reabierto_por)
          select ${entrada.workspaceId}, ${entrada.proyectoId}, ${entrada.etapaNumero},
                 ${entrada.motivo},
                 case when cardinality(${insightIds}::uuid[]) = 0
                      then 'etapa-completa' else 'declarado' end,
                 (select count(*)::int from marcadas), ${actorId}
          from etapa
          returning id
        ),
        cambios as (
          insert into reapertura_insight (reapertura_id, insight_id, workspace_id)
          select registro.id, declarados.id, ${entrada.workspaceId}
          from registro, declarados
          returning insight_id
        )
        select registro.id, (select count(*)::int from marcadas) as marcadas,
          (select count(*)::int from cambios) as declarados
        from registro`;
    } catch (e) {
      // El guard de la base habla ANTES que el WITH CHECK y con el motivo concreto (el
      // proyecto cerró mientras esto esperaba el candado): se traduce al contrato.
      const err = e as { code?: string; message?: string };
      if (err.code === 'P0001' && err.message) throw new ErrorGobernanza(err.message);
      throw e;
    }
    if (!fila) {
      throw new ErrorGobernanza('El proyecto o la etapa no existen, o no puedes reabrirla');
    }
    if ((fila.declarados as number) !== insightIds.length) {
      throw new ErrorGobernanza('Algún insight declarado no existe en este workspace');
    }
    return { decisionesMarcadas: fila.marcadas as number };
  });
}

/** Decisiones, arquetipos y reaperturas del proyecto en UNA sentencia. */
export async function gobernanzaDeProyecto(
  actorId: string,
  workspaceId: string,
  proyectoId: string,
): Promise<GobernanzaDeProyecto | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await tx`
      select
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', d.id, 'gateNumero', g.numero, 'tipo', d.tipo, 'titulo', d.titulo,
            'fundamento', d.fundamento, 'estado', d.estado,
            'decididoEn', to_char(d.decidido_en, 'YYYY-MM-DD'),
            'insights', coalesce((
              select jsonb_agg(jsonb_build_object('id', i.id, 'titulo', i.titulo)
                order by i.titulo)
              from decision_insight di
              join insight i on i.id = di.insight_id and i.workspace_id = di.workspace_id
              where di.decision_id = d.id and di.workspace_id = d.workspace_id
            ), '[]'::jsonb),
            -- Por qué NO se puede citar esta decisión, o null. NO se reproduce aquí: se
            -- INVOCA razonamiento_sin_respaldo, la misma función que consulta el guard de
            -- suficiencia antes de levantar. Este espejo estuvo escrito a mano y con las
            -- tres comprobaciones repartidas en dos campos, y así fue como el selector de
            -- la design version —copiado de éste— se quedó con una sola: mientras el
            -- predicado viva dentro de un guard que lanza excepciones, quien quiera
            -- mirarlo antes no tiene más remedio que reescribirlo. El motivo viene ya
            -- redactado y nombra el objeto exacto, que es lo que hay que reparar.
            'sinRespaldo', razonamiento_sin_respaldo_visible(
              d.workspace_id, array[]::uuid[], array[d.id], array[]::uuid[]))

            order by g.numero, d.decidido_en)
          from decision d
          join gate_instancia g on g.id = d.gate_id and g.workspace_id = d.workspace_id
          where d.proyecto_id = p.id and d.workspace_id = p.workspace_id
        ), '[]'::jsonb) as decisiones,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', a.id, 'nombre', a.nombre, 'definicion', a.definicion,
            'estado', a.estado, 'veredictoRazon', a.veredicto_razon,
            'segmentos', coalesce((
              select jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre)
                order by s.nombre)
              from arquetipo_segmento asg
              join segmento s on s.id = asg.segmento_id and s.workspace_id = asg.workspace_id
              where asg.arquetipo_id = a.id and asg.workspace_id = a.workspace_id
            ), '[]'::jsonb),
            'evidencias', coalesce((
              select jsonb_agg(jsonb_build_object('id', e.id, 'titulo', e.titulo)
                order by e.titulo)
              from arquetipo_evidencia ae
              join evidencia e on e.id = ae.evidencia_id and e.workspace_id = ae.workspace_id
              where ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
            ), '[]'::jsonb))
            order by a.nombre)
          from arquetipo a
          where a.reto_id = p.reto_id and a.workspace_id = p.workspace_id
        ), '[]'::jsonb) as arquetipos,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', r.id, 'etapaNumero', r.etapa_numero, 'motivo', r.motivo,
            'alcance', r.alcance,
            'decisionesMarcadas', r.decisiones_marcadas,
            'insights', coalesce((
              select jsonb_agg(jsonb_build_object('id', i2.id, 'titulo', i2.titulo)
                order by i2.titulo)
              from reapertura_insight ri
              join insight i2 on i2.id = ri.insight_id and i2.workspace_id = ri.workspace_id
              where ri.reapertura_id = r.id and ri.workspace_id = r.workspace_id
            ), '[]'::jsonb),
            'reabiertoEn', to_char(r.reabierto_en, 'YYYY-MM-DD'))
            order by r.reabierto_en desc)
          from reapertura_etapa r
          where r.proyecto_id = p.id and r.workspace_id = p.workspace_id
        ), '[]'::jsonb) as reaperturas,
        coalesce((
          select jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre) order by s.nombre)
          from segmento s where s.workspace_id = p.workspace_id
        ), '[]'::jsonb) as segmentos_disponibles,
        -- Los CONCEPTOS del reto, que es sobre lo que decide un pasa/muere (RF-04.10). Van en
        -- la misma sentencia y no en una consulta aparte por lo de siempre: el formulario que
        -- los ofrece y la validación que los exige tienen que mirar la misma foto, o la
        -- pantalla ofrece uno que el endpoint ya no admite.
        --
        -- TODOS, no solo los candidatos: la lista es el selector de «sobre qué decido», y una
        -- decisión pasa/muere se registra JUNTO con el veredicto del concepto o justo después
        -- —son dos escrituras del mismo acto—, así que filtrar por «candidato» dejaría fuera
        -- exactamente el caso normal. Cuál de ellos tiene ya su decisión lo dice la pantalla
        -- con lo que ya tiene: «decisiones» trae su «conceptoId».
        coalesce((
          select jsonb_agg(jsonb_build_object('id', c.id, 'titulo', c.titulo,
                                              'estado', c.estado)
                   order by c.titulo)
          from concepto c
          where c.reto_id = p.reto_id and c.workspace_id = p.workspace_id
        ), '[]'::jsonb) as conceptos
      from proyecto p
      where p.id = ${proyectoId} and p.workspace_id = ${workspaceId}`;
    if (!fila) return null;
    return {
      decisiones: fila.decisiones as GobernanzaDeProyecto['decisiones'],
      arquetipos: fila.arquetipos as GobernanzaDeProyecto['arquetipos'],
      reaperturas: fila.reaperturas as GobernanzaDeProyecto['reaperturas'],
      segmentosDisponibles: fila.segmentos_disponibles as GobernanzaDeProyecto['segmentosDisponibles'],
      conceptos: fila.conceptos as GobernanzaDeProyecto['conceptos'],
    };
  });
}
