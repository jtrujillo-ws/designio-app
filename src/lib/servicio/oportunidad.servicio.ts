import '@/lib/server-only';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import type {
  CrearOportunidad,
  DecidirOportunidad,
  EnlazarInsight,
  OportunidadDelPortafolio,
  PriorizarOportunidad,
  RetoConPortafolio,
} from './oportunidad.schemas';

/**
 * El portafolio de oportunidades del reto (CTX-04, etapa 3).
 *
 * Capa 1: RLS y guards — quién propone, quién decide, qué se puede enlazar y hasta cuándo.
 * Capa 2: estado de cuenta en toda operación y traducción de los guards al contrato del
 * módulo. Las reglas duras —la traza mínima de SYS-15, que el enlace sea a un insight
 * VALIDADO, que aprobar re-compruebe los derechos— viven en la base, no aquí: así también
 * las respeta cualquier escritura por SQL directo, que es el escritor que de verdad hay que
 * cerrar.
 */

export class ErrorOportunidad extends Error {}

/** Traduce el raise del guard (P0001) y el de los derechos (DR001) al contrato del módulo.
 * DR001 lo levanta `razonamiento_usable_guard` cuando el razonamiento de la HMW dejó de
 * sostenerse entre enlazar y aprobar: su mensaje ya nombra la afirmación y la dimensión que
 * falta, así que dejarlo pasar sin traducir sería devolver un 500 opaco sobre un caso que el
 * usuario puede resolver. */
function comoErrorDeDominio(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if ((err.code === 'P0001' || err.code === 'DR001') && err.message) {
    throw new ErrorOportunidad(err.message);
  }
  throw e;
}

/**
 * NO hay candado en este módulo, y es deliberado. Toda escritura del portafolio pasa por
 * `b_candado_del_reto`, que toma `designio:reto:` —la misma clave que toma
 * `gate_aprobar_suficiencia_guard` al firmar G3— antes de que corra ningún guard de fila.
 * Un candado aquí, además, tendría que ser el MISMO o crearía un segundo orden: la primera
 * versión de este módulo tomaba uno por oportunidad, y con esa clave el borrado de un enlace
 * y la aprobación de G3 no se veían — cada uno bloqueaba lo suyo, los dos pasaban su
 * comprobación y los dos commiteaban, dejando G3 firmado sobre una oportunidad viva sin
 * traza. Serializar en la base cubre además a quien escribe por SQL directo, que es el
 * escritor que esto existe para cerrar.
 */
export async function crearOportunidad(
  actorId: string,
  entrada: CrearOportunidad,
): Promise<{ oportunidadId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let fila;
    try {
      // El evento de auditoría NO se escribe aquí: lo escribe `oportunidad_auditoria`, un
      // trigger, para que también deje rastro quien entra por la superficie SQL concedida
      // (RF-01.6). Escribirlo en los dos sitios dejaría DOS filas por una acción hecha desde
      // la app y una por la misma acción hecha por SQL, y entonces el archivo no permite
      // contar nada. Mismo motivo en las otras cuatro escrituras de este módulo.
      [fila] = await tx`
        insert into oportunidad
          (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
        values (${entrada.workspaceId}, ${entrada.retoId}, ${entrada.pregunta},
                ${entrada.prioridad}, ${entrada.prioridadRazon}, ${actorId})
        returning id`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      // WITH CHECK (42501): no eres quien propone, o el G3 de este reto ya se aprobó y la
      // etapa no está reabierta — añadir al portafolio que G3 aprobó es lo que cierra.
      if (code === '42501') {
        throw new ErrorOportunidad(
          'No puedes proponer oportunidades en ese reto: o no es tu rol, o su G3 ya está aprobado y la etapa 3 no está reabierta',
        );
      }
      // unique (reto_id, pregunta): la misma HMW dos veces reparte el mismo voto dos veces.
      if (code === '23505') {
        throw new ErrorOportunidad('Ese reto ya tiene una oportunidad con esa misma pregunta');
      }
      comoErrorDeDominio(e);
    }
    if (!fila) {
      throw new ErrorOportunidad('No se pudo crear la oportunidad');
    }
    return { oportunidadId: fila.id as string };
  });
}

export async function enlazarInsight(actorId: string, entrada: EnlazarInsight): Promise<void> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    try {
      const filas = await tx`
        insert into oportunidad_insight (oportunidad_id, insight_id, workspace_id)
        values (${entrada.oportunidadId}, ${entrada.insightId}, ${entrada.workspaceId})
        returning oportunidad_id`;
      if (filas.length === 0) {
        throw new ErrorOportunidad('No se pudo enlazar el insight');
      }
    } catch (e) {
      if (e instanceof ErrorOportunidad) throw e;
      const code = (e as { code?: string }).code;
      // WITH CHECK (42501): el insight no está validado, la oportunidad ya se decidió, o no
      // es tu rol. Se dicen los tres porque desde fuera son indistinguibles y el que casi
      // siempre pasa —el insight sin validar— tiene arreglo a mano.
      if (code === '42501') {
        throw new ErrorOportunidad(
          'No se pudo enlazar: el insight tiene que estar validado, la oportunidad tiene que seguir por decidir, y enlazar es cosa del lead o del diseñador',
        );
      }
      if (code === '23505') {
        throw new ErrorOportunidad('Ese insight ya está enlazado a esta oportunidad');
      }
      comoErrorDeDominio(e);
    }
  });
}

export async function desenlazarInsight(actorId: string, entrada: EnlazarInsight): Promise<void> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`
      delete from oportunidad_insight
      where oportunidad_id = ${entrada.oportunidadId}
        and insight_id = ${entrada.insightId}
        and workspace_id = ${entrada.workspaceId}
      returning oportunidad_id`;
    // Un DELETE que no borra nada por la política es indistinguible de uno que no encuentra
    // la fila, y las dos respuestas son la misma para quien llama: sigue enlazado o no
    // estaba. No se inventa una diferencia que la base no da.
    if (filas.length === 0) {
      throw new ErrorOportunidad(
        'No se pudo desenlazar: ese insight no está enlazado, o la oportunidad ya se decidió',
      );
    }
  });
}

export async function priorizarOportunidad(
  actorId: string,
  entrada: PriorizarOportunidad,
): Promise<void> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`
      update oportunidad
      set prioridad = ${entrada.prioridad}, prioridad_razon = ${entrada.prioridadRazon}
      where id = ${entrada.oportunidadId} and workspace_id = ${entrada.workspaceId}
      returning id`;
    if (filas.length === 0) {
      throw new ErrorOportunidad(
        'No se pudo repriorizar: la oportunidad no existe, ya se decidió, o no es tu rol',
      );
    }
  });
}

export async function decidirOportunidad(
  actorId: string,
  entrada: DecidirOportunidad,
): Promise<void> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let fila;
    try {
      // `decidido_por` y `decidido_en` NO se escriben aquí aunque el grant los incluya: los
      // pone el guard, que es lo que impide atribuir un veredicto a otro o fecharlo fuera de
      // su momento. Están en el grant porque el guard escribe a través de la misma
      // superficie, no para que los use quien llama.
      [fila] = await tx`
        update oportunidad
        set estado = ${entrada.estado}, veredicto_razon = ${entrada.veredictoRazon}
        where id = ${entrada.oportunidadId} and workspace_id = ${entrada.workspaceId}
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (!fila) {
      throw new ErrorOportunidad(
        'No se pudo decidir: la oportunidad no existe, ya se decidió, o no es tu rol',
      );
    }
  });
}

/**
 * El portafolio del workspace, agrupado por reto y con la traza dentro.
 *
 * Va agrupado y no por reto suelto porque así se usa: el portafolio de la etapa 3 se juzga
 * mirando el reto entero, y una pantalla que pidiera reto a reto obligaría a elegir antes de
 * ver. Dentro de cada reto, orden por prioridad y, a igualdad, por antigüedad: dos HMW con el
 * mismo número no se reordenan solas entre recargas.
 */
export async function portafolioDelWorkspace(
  actorId: string,
  workspaceId: string,
): Promise<RetoConPortafolio[]> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`
      select r.id, r.codigo, r.titulo,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                 'id', o.id, 'retoId', o.reto_id, 'pregunta', o.pregunta,
                 'prioridad', o.prioridad, 'prioridadRazon', o.prioridad_razon,
                 'estado', o.estado, 'veredictoRazon', o.veredicto_razon,
                 'decididoEn', o.decidido_en,
                 'insights', coalesce((
                   select jsonb_agg(jsonb_build_object('id', i.id, 'titulo', i.titulo)
                                    order by i.titulo, i.id)
                     from oportunidad_insight oi
                     join insight i on i.id = oi.insight_id and i.workspace_id = oi.workspace_id
                    where oi.oportunidad_id = o.id and oi.workspace_id = o.workspace_id),
                   '[]'::jsonb))
                 order by o.prioridad desc, o.creado_en asc, o.id asc)
                 from oportunidad o
                where o.reto_id = r.id and o.workspace_id = r.workspace_id),
               '[]'::jsonb) as oportunidades
        from reto r
       where r.workspace_id = ${workspaceId}
       order by r.codigo asc, r.id asc`;
    return filas.map((f) => ({
      retoId: f.id as string,
      codigo: f.codigo as string,
      titulo: f.titulo as string,
      oportunidades: f.oportunidades as OportunidadDelPortafolio[],
    }));
  });
}

/**
 * Los insights que se pueden enlazar: los VALIDADOS del workspace.
 *
 * La lista no es un adorno del formulario: la política de `oportunidad_insight` solo admite
 * validados, así que ofrecer los propuestos sería ofrecer un botón que siempre falla. El
 * filtro se escribe aquí PORQUE la política lo exige, no en vez de que lo exija.
 */
export async function insightsEnlazables(
  actorId: string,
  workspaceId: string,
): Promise<{ id: string; titulo: string }[]> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`
      select id, titulo from insight
       where workspace_id = ${workspaceId} and estado = 'validado'
       order by titulo asc, id asc`;
    return filas.map((f) => ({ id: f.id as string, titulo: f.titulo as string }));
  });
}
