import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  GenerarPropuestasSchema,
  PropuestasInputSchema,
  RevisarPropuestaSchema,
} from './ai.schemas';
import {
  aceptarPropuesta,
  ErrorAI,
  generarPropuestas,
  panelPropuestas,
  rechazarPropuesta,
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
      return await panelPropuestas(usuarioId, data.workspaceId);
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
