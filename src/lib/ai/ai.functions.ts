import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  CorridaEvalInputSchema,
  GenerarPropuestasSchema,
  PropuestasInputSchema,
  RegistrarConsentimientoSchema,
  RevisarPropuestaSchema,
} from './ai.schemas';
import { correrEvalDeGrounding, informeDeGrounding } from './ai.evals';
import {
  aceptarPropuesta,
  ErrorAI,
  generarPropuestas,
  panelPropuestas,
  rechazarPropuesta,
  registrarConsentimiento,
} from './ai.servicio';

/** Server functions del pipeline PropuestaAI. Mutaciones con contrato uniforme {ok, …};
 * el loader lanza hacia el error boundary del router salvo por autorización.
 *
 * Degradación segura (SYS-21): que la AI esté apagada NO es un error de estas funciones.
 * El loader devuelve el panel igual —con la bandera de estado— y generar devuelve
 * {ok:false, error} con el motivo; ninguna pantalla se rompe ni ningún gate se bloquea. */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorAI) return e.message;
  // Cuenta desactivada con JWT aún vigente (capa 2 del servicio).
  if (e instanceof ErrorAutorizacion) return e.message;
  const code = (e as { code?: string }).code;
  if (code === '42501') return 'Sin permiso para esta acción en el workspace';
  if (code === '23503') return 'Alguna referencia no existe en este workspace';
  if (code === '23514') return 'La propuesta no cumple las reglas del pipeline AI';
  return null;
}

export const propuestasDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(PropuestasInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await panelPropuestas(usuarioId, data.workspaceId, data.busqueda);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const generarPropuestasAI = createServerFn({ method: 'POST' })
  .inputValidator(GenerarPropuestasSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await generarPropuestas(actorId, data);
      return { ok: true as const, generadas: r.generadas };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const aceptarPropuestaAI = createServerFn({ method: 'POST' })
  .inputValidator(RevisarPropuestaSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await aceptarPropuesta(actorId, data);
      return { ok: true as const, estado: r.estado, objetoId: r.objetoId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

/** RF-09.5: capturar el consentimiento es un paso PREVIO al procesamiento, con su propia
 * mutación — no un campo que se rellena al aceptar lo que la AI ya produjo. */
export const registrarConsentimientoAI = createServerFn({ method: 'POST' })
  .inputValidator(RegistrarConsentimientoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      // La versión y si autoriza el procesamiento externo vuelven a la pantalla: un
      // registro que NO lo cubre es válido y queda anotado, pero no desbloquea la
      // generación — decirlo evita que alguien crea que ya puede pedir la propuesta.
      const r = await registrarConsentimiento(actorId, data);
      return { ok: true as const, version: r.version, autorizaExterno: r.autorizaExterno };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const rechazarPropuestaAI = createServerFn({ method: 'POST' })
  .inputValidator(RevisarPropuestaSchema.omit({ correccion: true }))
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await rechazarPropuesta(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

/**
 * RF-08.7 — el informe de grounding, y correr una eval.
 *
 * Dos funciones y no una: LEER el informe es de quien audita y no escribe nada; CORRER una
 * eval escribe un hecho fechado en el workspace y es de quien lo lleva. Con una sola,
 * cualquiera que abriera la pantalla habría dejado una corrida en la tabla — y una serie
 * histórica que se llena sola al mirarla no compara nada.
 *
 * El error del rol vuelve como `{ok:false, error}` y no como excepción, por la misma razón que
 * el resto del pipeline: la pantalla dice qué falta en vez de romperse.
 */
export const informeDeGroundingDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(CorridaEvalInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await informeDeGrounding(usuarioId, data.workspaceId);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente, o rol sin permiso: sin datos. La pantalla
      // distingue «no te corresponde» de «aún no hay corridas» por otra vía, porque un
      // informe vacío y una puerta cerrada no se parecen en nada para quien mira.
      if (e instanceof ErrorAutorizacion || e instanceof ErrorAI) return null;
      throw e;
    }
  });

export const correrEvalDeGroundingDelWorkspace = createServerFn({ method: 'POST' })
  .inputValidator(CorridaEvalInputSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      return { ok: true as const, informe: await correrEvalDeGrounding(actorId, data.workspaceId) };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
