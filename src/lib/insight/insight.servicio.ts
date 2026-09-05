import '@/lib/server-only';
import type { Row, TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import type {
  AgregarAfirmacion,
  AgregarCita,
  CrearInsight,
  InsightCitable,
  InsightCompleto,
  RegistrarContradiccion,
} from './insight.schemas';

/**
 * Insights (SPEC-03, RF-03.9): afirmaciones sostenidas por citas verificables, con las
 * contradicciones a la vista. Capa 1: RLS — curadores proponen, un insight validado es
 * inmutable, y CUALQUIER miembro puede registrar una contradicción (que el stakeholder
 * pueda decir «esto no cuadra» es el punto del portal). Capa 2: estado de cuenta en
 * toda operación y traducción de los guards al contrato del módulo.
 *
 * La regla dura —toda afirmación no-hipótesis exige ≥1 cita para validar— vive en un
 * guard de la base, no aquí: así también la respeta cualquier escritura por SQL directo.
 */

export class ErrorInsight extends Error {}

/** Página de la lista completa: la pantalla los muestra con citas y contradicciones, así
 * que traerlos todos de golpe cargaría el razonamiento entero del workspace. Se pagina
 * por keyset (creado_en, id) para que «cargar más» no salte ni repita filas — y para que
 * un insight viejo NO quede fuera de alcance para siempre, que es lo que hacía el corte
 * duro anterior: sin él no se podía ni citarlo, ni validarlo, ni contradecirlo. */
export const PAGINA_INSIGHTS = 50;

/** El picker del gate se recorta aparte: es otra consulta y otro tamaño. */
const INSIGHTS_PICKER = 200;

/** Traduce el raise del guard (P0001) al contrato del módulo; deja pasar lo demás. */
function comoErrorDeDominio(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code === 'P0001' && err.message) {
    throw new ErrorInsight(err.message);
  }
  // DR001 es el errcode propio de los derechos, y desde 20260902310000 también lo levanta
  // el guard de VALIDACIÓN: validar es irreversible, así que se comprueba ahí que las
  // citas siguen sirviendo y no solo que existen. Sin esta rama el mensaje —que ya trae la
  // afirmación exacta y la dimensión que falta— salía como error de servidor sin traducir,
  // que es justo lo que SYS-14 prohíbe. El traductor es un consumidor de pleno derecho de
  // cada restricción nueva.
  if (err.code === 'DR001' && err.message) {
    throw new ErrorInsight(err.message);
  }
  throw e;
}

export async function crearInsight(
  actorId: string,
  entrada: CrearInsight,
): Promise<{ insightId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // UNA sentencia: el insight y su evento comparten snapshot, y el rol auditado es el
    // que autorizó el insert (misma disciplina que el resto de los módulos).
    const [fila] = await tx`
      with quien as (
        select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
      ),
      nuevo as (
        insert into insight (workspace_id, titulo, resumen, creado_por)
        values (${entrada.workspaceId}, ${entrada.titulo}, ${entrada.resumen}, ${actorId})
        returning id
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${entrada.workspaceId}, 'InsightPropuesto',
          jsonb_build_object('insightId', nuevo.id, 'titulo', ${entrada.titulo}::text),
          ${actorId}, quien.rol
        from nuevo, quien
      )
      select id from nuevo`;
    return { insightId: fila!.id as string };
  });
}

/** Candado por insight: serializa escribir su contenido contra validarlo. Sin él, una
 * afirmación sin cita puede entrar mientras otra transacción valida —ambas ven el estado
 * 'propuesto' commiteado, tocan filas distintas y las dos pasan— y queda un insight
 * validado e inmutable con una afirmación que nadie sostuvo. Mismo espacio de nombres
 * que los candados del método. */
async function candadoDeInsight(tx: TransactionSql, insightId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:insight:' || ${insightId}, 42))`;
}

export async function agregarAfirmacion(
  actorId: string,
  entrada: AgregarAfirmacion,
): Promise<{ afirmacionId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await candadoDeInsight(tx, entrada.insightId);
    // El orden se calcula en la MISMA sentencia que inserta: dos afirmaciones
    // concurrentes chocarían contra unique (insight_id, orden) en vez de pisarse, y el
    // reintento del usuario es correcto porque el orden es presentacional.
    let fila;
    try {
      fila = (
        await tx`
        insert into afirmacion (workspace_id, insight_id, orden, texto, es_hipotesis)
        select ${entrada.workspaceId}, ${entrada.insightId},
          coalesce((select max(orden) + 1 from afirmacion a
            where a.insight_id = ${entrada.insightId}
              and a.workspace_id = ${entrada.workspaceId}), 0),
          ${entrada.texto}, ${entrada.esHipotesis}
        returning id`
      )[0];
    } catch (e) {
      const code = (e as { code?: string }).code;
      // WITH CHECK (42501): el insight ya está validado — o quien escribe no cura.
      if (code === '42501') {
        throw new ErrorInsight('El insight no existe, ya fue validado o no puedes editarlo');
      }
      // Dos afirmaciones simultáneas compiten por el mismo orden (unique gate/orden):
      // chocan en vez de pisarse, y reintentar es correcto porque el orden es
      // presentacional. El mensaje invita a eso en vez de exponer el 23505.
      if (code === '23505') {
        throw new ErrorInsight('Otra afirmación se agregó al mismo tiempo: intenta de nuevo');
      }
      throw e;
    }
    if (!fila) {
      throw new ErrorInsight('El insight no existe, ya fue validado o no puedes editarlo');
    }
    return { afirmacionId: fila.id as string };
  });
}

export async function agregarCita(
  actorId: string,
  entrada: AgregarCita,
): Promise<{ citaId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Mismo candado que agregarAfirmacion y validarInsight: lo que cuenta el guard de
    // validación son las afirmaciones SIN cita, así que citar también entra en la cola.
    const [duena] = await tx`select insight_id from afirmacion
      where id = ${entrada.afirmacionId} and workspace_id = ${entrada.workspaceId}`;
    if (duena) await candadoDeInsight(tx, duena.insight_id as string);
    let fila;
    try {
      [fila] = await tx`
        insert into cita (workspace_id, afirmacion_id, evidencia_id, fragmento,
                          localizacion, creado_por)
        values (${entrada.workspaceId}, ${entrada.afirmacionId}, ${entrada.evidenciaId},
                ${entrada.fragmento}, ${entrada.localizacion}, ${actorId})
        returning id`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      // DR001: el guard de derechos cortó la CITA — la evidencia no tiene derechos
      // vigentes para el ámbito «cliente» (RF-03.10, SYS-14). Citar aquí es tan
      // definitivo como citar en un gate: la cita COPIA el fragmento del original y es
      // lo que después valida el insight, que es inmutable. El mensaje ya trae la
      // dimensión que falta y se propaga tal cual, que es lo que la spec pide mostrar.
      if (code === 'DR001') {
        throw new ErrorInsight((e as { message?: string }).message ?? 'Derechos insuficientes');
      }
      // FK compuesta: la evidencia citada no es de este workspace (o no existe).
      if (code === '23503') {
        throw new ErrorInsight('La evidencia citada no existe en este workspace');
      }
      // WITH CHECK (42501): el insight de esa afirmación ya está validado.
      if (code === '42501') {
        throw new ErrorInsight('La afirmación no existe, su insight ya fue validado o no puedes citarla');
      }
      throw e;
    }
    if (!fila) {
      throw new ErrorInsight('La afirmación no existe, su insight ya fue validado o no puedes citarla');
    }
    return { citaId: fila.id as string };
  });
}

export async function registrarContradiccion(
  actorId: string,
  entrada: RegistrarContradiccion,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    try {
      const filas = await tx`
        with quien as (
          select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
        ),
        nueva as (
          insert into contradiccion (workspace_id, insight_id, evidencia_id, descripcion, creado_por)
          values (${entrada.workspaceId}, ${entrada.insightId}, ${entrada.evidenciaId},
                  ${entrada.descripcion}, ${actorId})
          returning id
        ),
        evento as (
          insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
          select ${entrada.workspaceId}, 'ContradiccionDetectada',
            jsonb_build_object('insightId', ${entrada.insightId}::uuid,
                               'evidenciaId', ${entrada.evidenciaId}::uuid,
                               'contradiccionId', nueva.id),
            ${actorId}, quien.rol
          from nueva, quien
        )
        select id from nueva`;
      if (filas.length === 0) {
        throw new ErrorInsight('No puedes registrar contradicciones en este workspace');
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new ErrorInsight('Esa contradicción ya está registrada para este insight');
      }
      if (code === '23503') {
        throw new ErrorInsight('El insight o la evidencia no existen en este workspace');
      }
      throw e;
    }
  });
}

/** Validar: la transición decisora. El guard verifica que toda afirmación no marcada
 * como hipótesis tenga al menos una cita, y sella la fecha. */
export async function validarInsight(
  actorId: string,
  workspaceId: string,
  insightId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El mismo candado que toma agregarAfirmacion: el guard de validación cuenta las
    // afirmaciones sin cita, y esa cuenta tiene que ser la definitiva.
    await candadoDeInsight(tx, insightId);
    let filas;
    try {
      filas = await tx`
        update insight
        set estado = 'validado', validado_por = ${actorId}, validado_en = now()
        where id = ${insightId} and workspace_id = ${workspaceId}`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (filas!.count === 0) {
      throw new ErrorInsight('El insight no existe, ya está validado o no puedes validarlo');
    }
  });
}

/**
 * Insights validados (id y título) para enlazar desde checklists y decisiones: lectura
 * mínima bajo RLS + capa 2. Deliberadamente NO reusa la proyección completa — quien
 * puebla un picker no necesita afirmaciones ni citas, y traerlas convertiría cada
 * visita al proyecto en una descarga del razonamiento entero del workspace.
 *
 * hayMas avisa que la lista está recortada a los más recientes, igual que el picker de
 * evidencias: un picker que oculta opciones sin decirlo bloquea al usuario sin pistas.
 */
export async function insightsCitables(
  actorId: string,
  workspaceId: string,
): Promise<{ insights: InsightCitable[]; hayMas: boolean }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Un insight validado es inmutable, pero su RESPALDO no: los derechos de la evidencia
    // citada se revocan y caducan. El guard de suficiencia lo comprueba al aprobar el
    // gate, así que ofrecerlo aquí como si nada dejaba al usuario eligiendo una opción
    // que la base iba a rechazar después, sin decirle por qué. El predicado es el MISMO
    // que evalúa ese guard, y desde 20260902350000 no se reproduce: se INVOCA
    // `razonamiento_sin_respaldo`, que es la función que el propio guard consulta antes de
    // levantar. El motivo viene ya redactado y nombra la afirmación concreta — un motivo
    // genérico no dice qué reparar.
    const filas = await tx`select i.id, i.titulo,
        razonamiento_sin_respaldo_visible(i.workspace_id, array[i.id], array[]::uuid[],
                                  array[]::uuid[]) as sin_respaldo
      from insight i
      where i.workspace_id = ${workspaceId} and i.estado = 'validado'
      order by i.validado_en desc nulls last, i.creado_en desc, i.id desc
      limit ${INSIGHTS_PICKER + 1}`;
    return {
      insights: filas.slice(0, INSIGHTS_PICKER).map((f) => {
        // El motivo lo compone la BASE, con la misma redacción con la que el guard
        // levanta: recomponerlo aquí volvería a dejar dos textos para la misma regla, y ya
        // se ha visto lo que pasa cuando divergen.
        const sinRespaldo = f.sin_respaldo as string | null;
        return {
          id: f.id as string,
          titulo: f.titulo as string,
          citable: sinRespaldo === null,
          motivoBloqueo: sinRespaldo === null ? null : `su respaldo ${sinRespaldo}`,
        };
      }),
      hayMas: filas.length > INSIGHTS_PICKER,
    };
  });
}

/** Los insights del workspace con sus afirmaciones, citas y contradicciones, en UNA
 * sentencia (un snapshot, orden estable): la ficha completa no puede mostrar citas de
 * un estado y contradicciones de otro. */
export async function insightsDelWorkspace(
  actorId: string,
  workspaceId: string,
  cursor?: { creadoEn: string; id: string } | null,
): Promise<{ insights: InsightCompleto[]; siguiente: { creadoEn: string; id: string } | null }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await filasDeInsights(tx, workspaceId, { cursor, limite: PAGINA_INSIGHTS + 1 });
    const pagina = filas.slice(0, PAGINA_INSIGHTS);
    const ultima = pagina[pagina.length - 1];
    return {
      insights: pagina.map(comoInsightCompleto),
      // El cursor es el par completo (creado_en, id): dos insights del mismo instante
      // no harían saltar ni repetir la página siguiente.
      siguiente:
        filas.length > PAGINA_INSIGHTS && ultima
          ? { creadoEn: (ultima.creado_en as Date).toISOString(), id: ultima.id as string }
          : null,
    };
  });
}

/**
 * UN insight completo, por id: la misma ficha que la lista, para el que se vino a ver con
 * `destacar` y no está en la primera página (keyset de los más recientes; lo que más
 * espera validación es lo más antiguo). null si no existe o RLS no lo enseña —la pantalla
 * no distingue los dos casos, y no debe—.
 */
export async function insightDelWorkspace(
  actorId: string,
  workspaceId: string,
  insightId: string,
): Promise<InsightCompleto | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await filasDeInsights(tx, workspaceId, { soloId: insightId, limite: 1 });
    return fila ? comoInsightCompleto(fila) : null;
  });
}

function comoInsightCompleto(f: Row): InsightCompleto {
  return {
    id: f.id as string,
    titulo: f.titulo as string,
    resumen: f.resumen as string,
    estado: f.estado as InsightCompleto['estado'],
    validadoEn: (f.validado_en as string | null) ?? null,
    afirmaciones: f.afirmaciones as InsightCompleto['afirmaciones'],
    contradicciones: f.contradicciones as InsightCompleto['contradicciones'],
  };
}

/** La ficha completa, compartida por la lista paginada y por la lectura por id. */
async function filasDeInsights(
  tx: TransactionSql,
  workspaceId: string,
  filtro: { cursor?: { creadoEn: string; id: string } | null; soloId?: string; limite: number },
) {
  const { cursor } = filtro;
  return tx`
      select i.id, i.titulo, i.resumen, i.estado,
        to_char(i.validado_en, 'YYYY-MM-DD') as validado_en,
        coalesce((
          select jsonb_agg(af order by af.orden)
          from (
            select a.id, a.orden, a.texto, a.es_hipotesis as "esHipotesis",
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'id', c.id, 'evidenciaId', c.evidencia_id,
                  'evidenciaTitulo', e.titulo, 'fragmento', c.fragmento,
                  'localizacion', c.localizacion,
                  -- Se INVOCA el predicado de la base, no se reproduce: es el mismo que el
                  -- guard de validación (desde 20260902310000) y el de suficiencia del
                  -- gate. Una cita nace con derechos vigentes pero los derechos se revocan
                  -- y caducan, así que «tiene cita» dejó de ser «tiene respaldo».
                  'usable', evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'),
                  'motivoBloqueo',
                    evidencia_motivo_bloqueo(c.evidencia_id, c.workspace_id, 'cliente'))
                  order by c.creado_en)
                from cita c
                join evidencia e on e.id = c.evidencia_id and e.workspace_id = c.workspace_id
                where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
              ), '[]'::jsonb) as citas
            from afirmacion a
            where a.insight_id = i.id and a.workspace_id = i.workspace_id
          ) af
        ), '[]'::jsonb) as afirmaciones,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', x.id, 'evidenciaId', x.evidencia_id,
            'evidenciaTitulo', e2.titulo, 'descripcion', x.descripcion)
            order by x.creado_en)
          from contradiccion x
          join evidencia e2 on e2.id = x.evidencia_id and e2.workspace_id = x.workspace_id
          where x.insight_id = i.id and x.workspace_id = i.workspace_id
        ), '[]'::jsonb) as contradicciones
        , i.creado_en
      from insight i
      where i.workspace_id = ${workspaceId}
        -- El filtro por id va DENTRO de la única sentencia, como el cursor, y no como un
        -- fragmento condicional: la ficha se lee en un solo momento, y el censo de
        -- proyecciones de solo lectura (disposicion.test) cuenta cada plantilla como una
        -- sentencia más, así que un fragmento la haría pasar por lectura de varios momentos.
        and (${filtro.soloId ?? null}::uuid is null or i.id = ${filtro.soloId ?? null}::uuid)
        and (${cursor?.creadoEn ?? null}::timestamptz is null
             or (i.creado_en, i.id) < (${cursor?.creadoEn ?? null}::timestamptz,
                                       ${cursor?.id ?? null}::uuid))
      order by i.creado_en desc, i.id desc
      limit ${filtro.limite}`;
}
