import '@/lib/server-only';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { ContenidoRevisionSimuladaSchema } from '@/lib/ai/ai.contenido';
import { escribirRevisionSimulada } from '@/lib/ai/ai.servicio';
import { z } from 'zod';
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

/**
 * ESCRIBIR UNA REVISIÓN SIMULADA A MANO (SYS-21).
 *
 * La paridad manual no es un extra de C4: es la condición que SYS-21 le pone a toda capacidad
 * —«caída del proveedor AI ⇒ los flujos manuales equivalentes están siempre presentes»— y el
 * criterio 3 de SPEC-08 la lleva a CI. Sus cinco hermanas ya la tienen en su propio servicio de
 * dominio (`insight.servicio.ts`, `medicion.servicio.ts`, `oportunidad.servicio.ts`); las
 * concesiones de la base y las políticas de C4 estaban escritas para admitirla —el sello de
 * procedencia se queda en null para siempre— pero nadie podía ejercerlas desde la pantalla.
 *
 * El CONTENIDO se valida con el MISMO esquema que gobierna lo que devuelve el proveedor, no con
 * una copia: lo que hace legítima a una revisión —hallazgos que citan o se marcan como
 * hipótesis, preguntas que nacen de un hallazgo, nada de agregados sintéticos— no depende de
 * quién la escribió. Una segunda escritura de esas reglas sería una segunda cosa que mantener,
 * y este PR ya ha pagado esa cuenta cuatro veces.
 *
 * VIVE EN EL SERVICIO y no en el fichero de esquemas de gobernanza, y eso lo dijo el guardián
 * del bundle: `ai.contenido` lleva el marcador de solo-servidor, y los esquemas de gobernanza
 * los importa la pantalla. El cliente no necesita el validador —arma el objeto y llama a la
 * server function—; el validador corre donde tiene que correr.
 *
 * Lo único que sobra es `confianzaPropuesta`: eso es lo que el modelo dice de SU salida, y
 * quien escribe a mano no propone nada — materializa directamente. No se puede quitar con
 * `.omit()` porque el esquema compartido lleva un `superRefine` de objeto —el que comprueba que
 * el índice de cada pregunta apunta dentro de la lista de hallazgos— y eso lo convierte en un
 * `ZodEffects`, que ya no expone la forma. Y ese refinamiento es justo el que hay que conservar.
 *
 * Así que el campo se RELLENA antes de validar, con un valor que nadie lee: la materialización
 * escribe síntesis, hallazgos, citas y preguntas, y la confianza vive en la propuesta, que aquí
 * no existe. El contrato sigue siendo uno.
 */
export const EscribirRevisionAManoSchema = z.object({
  workspaceId: z.string().uuid(),
  conceptoId: z.string().uuid(),
  contenido: z
    .preprocess(
      (v) => (typeof v === 'object' && v !== null ? { confianzaPropuesta: 'media', ...v } : v),
      ContenidoRevisionSimuladaSchema,
    )
    /*
     * UN PASAJE POR DOCUMENTO Y HALLAZGO, y esto SÍ es propio de la ruta manual.
     *
     * El enlace materializado tiene clave primaria `(hallazgo_id, evidencia_id)`: dos citas del
     * mismo documento en el mismo hallazgo son una sola fila, y se guarda el pasaje de la
     * primera. Para una revisión PROPUESTA eso no pierde nada —el contenido de la propuesta es
     * inmutable por SYS-17 y las lleva todas, y el guard de materialización cuenta enlaces
     * contra documentos DISTINTOS justo por esto—. Una revisión escrita a mano no tiene ese
     * respaldo: el segundo pasaje se escribía, se mandaba, y desaparecía en el refresco.
     *
     * Medido antes de cerrarlo, con dos fragmentos de la misma entrevista:
     *
     *   CITAS QUE SOBREVIVEN: [{ fragmento: 'No entrego la cédula', … }]   ← sólo la primera
     *
     * Hasta la ronda anterior era un límite que nadie podía tocar, porque el formulario sólo
     * ofrecía UNA cita por hallazgo; volverlas repetibles convirtió un empobrecimiento acotado
     * en una pérdida silenciosa y alcanzable. Así que el contrato de esta ruta pide lo que esta
     * ruta puede guardar: un documento por hallazgo. La alternativa —que el enlace admita varias
     * filas por documento— rehace la clave primaria y con ella la comprobación del sello, que
     * hoy es correcta; queda dicha aquí por si el límite llega a apretar.
     *
     * Va aquí y no en el contrato compartido a propósito: aquél gobierna también lo que el
     * proveedor puede devolver, y para él las dos citas siguen siendo legítimas.
     */
    .superRefine((c, ctx) => {
      c.hallazgos.forEach((h, i) => {
        const documentos = h.citas.map((x) => x.evidenciaId);
        if (new Set(documentos).size !== documentos.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['hallazgos', i, 'citas'],
            message:
              'un hallazgo escrito a mano cita cada documento UNA vez: el enlace guarda un pasaje por documento, y una revisión sin propuesta detrás no tiene de dónde recuperar los demás — elige el pasaje que mejor lo sostiene, o abre otro hallazgo',
          });
        }
      });
    }),
});
/*
 * El TIPO deja fuera `confianzaPropuesta` aunque el validador la rellene: `z.infer` describe lo
 * que sale del esquema, y lo que hace falta aquí es lo que hay que META. Sin esto, el compilador
 * pediría a quien escribe a mano un campo que el propio esquema se inventa.
 */
export type EscribirRevisionAMano = Omit<
  z.infer<typeof EscribirRevisionAManoSchema>,
  'contenido'
> & {
  contenido: Omit<z.infer<typeof EscribirRevisionAManoSchema>['contenido'], 'confianzaPropuesta'>;
};

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
            /*
             * Con «citable», que es lo que hace que el formulario manual no dependa del selector
             * general de evidencias. Aquél se corta en las 200 más recientes del workspace, así
             * que una lente sostenida por documentos más antiguos daba una intersección VACÍA y
             * quien escribía a mano no podía citar nada — con la única salida aparente de
             * marcar el hallazgo como hipótesis, o sea mentir sobre su clase.
             *
             * Aquí no hay corte: esta lista es la del arquetipo, entera. Y el permiso se
             * pregunta donde vive, para que la pantalla ofrezca lo que de verdad se puede citar.
             */
            'evidencias', coalesce((
              select jsonb_agg(jsonb_build_object('id', e.id, 'titulo', e.titulo,
                       'citable', evidencia_usable(e.id, e.workspace_id, 'cliente'))
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
        --
        -- Y CON SUS REVISIONES SIMULADAS ACEPTADAS DENTRO. Iban a ninguna parte: C4 las
        -- escribía y el panel de propuestas solo pinta lo que sigue en «estado = propuesta»,
        -- así que en cuanto se aceptaban desaparecían de la única pantalla que las mostraba.
        -- Las preguntas de test son lo único que una simulación le entrega a la etapa 4
        -- (RF-08.2), y quien decide el pasa/muere es exactamente quien tiene que leerlas.
        --
        -- Va en la MISMA sentencia que los conceptos por lo de siempre: quien elige el concepto
        -- y quien lee sus revisiones tienen que mirar la misma foto.
        coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', c.id, 'titulo', c.titulo, 'estado', c.estado,
                   'revisiones', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'id', r.id,
                              'arquetipoNombre', a.nombre,
                              'arquetipoEstado', a.estado,
                              'sintesis', r.sintesis,
                              'propuestaAiId', r.propuesta_ai_id,
                              'hallazgos', coalesce((
                                select jsonb_agg(jsonb_build_object(
                                         'id', h.id, 'titulo', h.titulo,
                                         'descripcion', h.descripcion,
                                         'esHipotesis', h.es_hipotesis,
                                         -- EL FRAGMENTO Y DÓNDE, no solo el título.
                                         --
                                         -- La tarjeta de la propuesta pendiente enseña «cita»
                                         -- entera; al aceptar solo quedaba «se apoya en <doc>»,
                                         -- y con eso quien firma el pasa/muere no puede ver qué
                                         -- pasaje sostiene el hallazgo. El enlace materializado
                                         -- no lo guarda —«hallazgo_simulado_evidencia» son tres
                                         -- uuid— y encima colapsa dos citas del mismo documento
                                         -- por su clave primaria: el testimonio vive en el
                                         -- «contenido» de la propuesta, inmutable por SYS-17,
                                         -- así que es de ahí de donde se lee.
                                         --
                                         -- «orden» ES el índice del hallazgo en ese contenido
                                         -- (lo escribe la materialización), que es lo que
                                         -- permite bajar al array de citas del hallazgo justo.
                                         'citas', coalesce(
                                           (select jsonb_agg(jsonb_build_object(
                                                     'evidenciaTitulo', e2.titulo,
                                                     -- El pasaje SÓLO si el documento sigue
                                                     -- pudiendo citarse. Ver «citable».
                                                     'fragmento', case when evidencia_usable(
                                                         (x ->> 'evidenciaId')::uuid,
                                                         p2.workspace_id, 'cliente')
                                                       then x ->> 'fragmento' end,
                                                     'localizacion', case when evidencia_usable(
                                                         (x ->> 'evidenciaId')::uuid,
                                                         p2.workspace_id, 'cliente')
                                                       then x ->> 'localizacion' end,
                                                     'citable', evidencia_usable(
                                                       (x ->> 'evidenciaId')::uuid,
                                                       p2.workspace_id, 'cliente'))
                                                   order by ord)
                                              from propuesta_ai p2
                                              cross join lateral jsonb_array_elements(
                                                coalesce(p2.contenido -> 'hallazgos' -> h.orden
                                                           -> 'citas', '[]'::jsonb))
                                                with ordinality as t(x, ord)
                                              left join evidencia e2
                                                on e2.id = (x ->> 'evidenciaId')::uuid
                                               and e2.workspace_id = p2.workspace_id
                                             where p2.id = r.propuesta_ai_id
                                               and p2.workspace_id = r.workspace_id
                                               -- Y SOLO LAS QUE SIGUEN ENLAZADAS. El contenido
                                               -- es inmutable (SYS-17) y por eso guarda el
                                               -- pasaje, pero no es la lista viva: quitar una
                                               -- cita de una revisión aceptada —el borrado del
                                               -- enlace SÍ está concedido, y es lo que se hace
                                               -- cuando su derecho se retira— no lo toca. Sin
                                               -- este cruce, el pasaje retirado se seguía
                                               -- enseñando como sostén actual delante de quien
                                               -- firma el pasa/muere.
                                               and exists (
                                                 select 1 from hallazgo_simulado_evidencia hv
                                                  where hv.hallazgo_id = h.id
                                                    and hv.workspace_id = h.workspace_id
                                                    and hv.evidencia_id
                                                          = (x ->> 'evidenciaId')::uuid)),
                                           -- Y la escrita a mano (SYS-21), que no tiene
                                           -- propuesta detrás: el enlace es todo lo que hay, y
                                           -- por eso el enlace GUARDA el pasaje. Antes esta
                                           -- rama lo daba por perdido —«fragmento null»— y la
                                           -- cita quedaba reducida al título del documento en
                                           -- cuanto se refrescaba: lo contrastable, que es para
                                           -- lo que existe una cita, se borraba solo.
                                           --
                                           -- Con la misma puerta que la otra rama: el pasaje
                                           -- sólo si el documento sigue pudiendo citarse.
                                           (select jsonb_agg(jsonb_build_object(
                                                     'evidenciaTitulo', e.titulo,
                                                     'fragmento', case when evidencia_usable(
                                                         he.evidencia_id, he.workspace_id,
                                                         'cliente')
                                                       then he.fragmento end,
                                                     'localizacion', case when evidencia_usable(
                                                         he.evidencia_id, he.workspace_id,
                                                         'cliente')
                                                       then he.localizacion end,
                                                     'citable', evidencia_usable(
                                                       he.evidencia_id, he.workspace_id, 'cliente'))
                                                   order by e.titulo)
                                              from hallazgo_simulado_evidencia he
                                              join evidencia e on e.id = he.evidencia_id
                                               and e.workspace_id = he.workspace_id
                                             where he.hallazgo_id = h.id
                                               and he.workspace_id = h.workspace_id),
                                           '[]'::jsonb))
                                       order by h.orden)
                                from hallazgo_simulado h
                                where h.revision_id = r.id and h.workspace_id = r.workspace_id
                              ), '[]'::jsonb),
                              'preguntas', coalesce((
                                select jsonb_agg(jsonb_build_object(
                                         'id', q.id, 'pregunta', q.pregunta,
                                         'escenario', q.escenario,
                                         -- Puede ser null, y por eso no va en jsonb_strip_nulls
                                         -- ni en un coalesce: «de ningún hallazgo» es un valor.
                                         'hallazgoId', q.hallazgo_id)
                                       order by q.orden)
                                from pregunta_de_test q
                                where q.revision_id = r.id and q.workspace_id = r.workspace_id
                              ), '[]'::jsonb))
                            order by a.nombre)
                     from revision_simulada r
                     join arquetipo a on a.id = r.arquetipo_id and a.workspace_id = r.workspace_id
                     where r.concepto_id = c.id and r.workspace_id = c.workspace_id
                   ), '[]'::jsonb))
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

/**
 * ESCRIBIR UNA REVISIÓN SIMULADA A MANO — la paridad que SYS-21 exige para C4.
 *
 * «Caída del proveedor AI ⇒ los flujos manuales equivalentes están siempre presentes», y el
 * criterio 3 de SPEC-08 lo lleva a CI. Las cinco capacidades hermanas ya tenían su ruta manual
 * en su propio servicio de dominio; C4 era la única cuyas tablas sólo escribía la
 * materialización, así que las concesiones y las políticas que la base tiene puestas para
 * admitir una revisión a mano —el sello de procedencia en null para siempre— no las podía
 * ejercer nadie desde la pantalla.
 *
 * Escribe por la MISMA función que la aceptación de una propuesta, no por una copia: lo que
 * hace legítima a una revisión no depende de quién la escribió. Lo que no comparten es lo que
 * de verdad las distingue — aquélla compara el veredicto y la huella del material y estampa el
 * sello; ésta no tiene material que comparar y su sello se queda en null.
 *
 * Todo lo demás lo sigue diciendo la base, y por eso no se repite aquí: que el concepto siga
 * siendo candidato y su etapa abierta, que la lente sea un arquetipo NO REFUTADO del reto del
 * concepto, que una lente lea un concepto una sola vez, que cada hallazgo afirmativo cite
 * evidencia utilizable de esa lente, y que la revisión no nazca vacía.
 */
export async function escribirRevisionAMano(
  actorId: string,
  entrada: EscribirRevisionAMano,
): Promise<{ revisionId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    try {
      const revisionId = await escribirRevisionSimulada(
        tx,
        actorId,
        entrada.workspaceId,
        entrada.conceptoId,
        entrada.contenido,
      );
      return { revisionId };
    } catch (e) {
      const code = (e as { code?: string }).code;
      // 23505: `unique (concepto_id, arquetipo_id)` — esa lente ya leyó este concepto (SYS-20).
      if (code === '23505') {
        throw new ErrorGobernanza(
          'Esa lente ya tiene una revisión de este concepto: de un arquetipo hay una sola lectura por concepto (SYS-20). Bórrala y escribe la buena, o elige otra lente',
        );
      }
      // 42501: la política de inserción — o no curas, o el concepto ya no es candidato, o su
      // etapa cerró, o el arquetipo no es una lente vigente de su reto.
      if (code === '42501') {
        throw new ErrorGobernanza(
          'No puedes escribir esa revisión: o no eres curador, o el concepto ya no es candidato, o su etapa 4 está cerrada, o esa lente no es un arquetipo vigente del reto del concepto',
        );
      }
      throw e;
    }
  });
}

/**
 * Y BORRARLA, que es la otra mitad de la ruta manual — y la que el propio mensaje de error
 * prometía sin que existiera.
 *
 * «Corregir una revisión es borrarla y escribir la buena» es la decisión que este módulo tomó
 * cuando le puso a `revision_simulada` una política de DELETE y ningún UPDATE: las hojas son
 * inmutables a propósito, y una errata o una pregunta que sobra no se editan, se rehacen. Sin
 * una función que ejerza ese DELETE, la primera revisión escrita a mano era irreversible desde
 * la aplicación — y `unique (concepto_id, arquetipo_id)` impedía además escribir la sustituta.
 *
 * Lo que se puede borrar lo sigue diciendo la base, no esta función: mientras el concepto sea
 * candidato y su etapa siga abierta. Una revisión SELLADA por una propuesta también se borra —
 * es como se corrige lo aceptado, y su trigger suelta el puntero de la propuesta—, y el hecho
 * no se pierde: vive en `evento_dominio`.
 */
export async function borrarRevisionAMano(
  actorId: string,
  entrada: { workspaceId: string; revisionId: string },
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`delete from revision_simulada
      where id = ${entrada.revisionId} and workspace_id = ${entrada.workspaceId}
      returning id`;
    if (filas.length === 0) {
      throw new ErrorGobernanza(
        'No puedes borrar esa revisión: o no eres curador, o el concepto ya no es candidato, o su etapa 4 está cerrada — una vez firmado el pasa/muere, lo que se leyó para decidir se queda',
      );
    }
  });
}
