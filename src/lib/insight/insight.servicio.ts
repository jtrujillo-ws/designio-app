import '@/lib/server-only';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import type {
  AgregarAfirmacion,
  AgregarCita,
  CrearInsight,
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

/** Corte de la lista: la pantalla los muestra completos (con citas) y el picker del
 * gate solo necesita los recientes. Sin corte, un workspace con historia cargaría todo
 * su razonamiento en cada visita a la pantalla del proyecto. */
export const INSIGHTS_LISTA = 200;

/** Traduce el raise del guard (P0001) al contrato del módulo; deja pasar lo demás. */
function comoErrorDeDominio(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code === 'P0001' && err.message) {
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

export async function agregarAfirmacion(
  actorId: string,
  entrada: AgregarAfirmacion,
): Promise<{ afirmacionId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
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

/** Los insights del workspace con sus afirmaciones, citas y contradicciones, en UNA
 * sentencia (un snapshot, orden estable): la ficha completa no puede mostrar citas de
 * un estado y contradicciones de otro. */
export async function insightsDelWorkspace(
  actorId: string,
  workspaceId: string,
): Promise<InsightCompleto[]> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`
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
                  'localizacion', c.localizacion) order by c.creado_en)
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
      from insight i
      where i.workspace_id = ${workspaceId}
      order by i.creado_en desc
      limit ${INSIGHTS_LISTA}`;
    return filas.map((f) => ({
      id: f.id as string,
      titulo: f.titulo as string,
      resumen: f.resumen as string,
      estado: f.estado as InsightCompleto['estado'],
      validadoEn: (f.validado_en as string | null) ?? null,
      afirmaciones: f.afirmaciones as InsightCompleto['afirmaciones'],
      contradicciones: f.contradicciones as InsightCompleto['contradicciones'],
    }));
  });
}
