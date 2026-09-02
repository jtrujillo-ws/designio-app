import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  AgregarAfirmacionSchema,
  AgregarCitaSchema,
  CrearInsightSchema,
  InsightsInputSchema,
  RegistrarContradiccionSchema,
  ValidarInsightSchema,
} from './insight.schemas';
import {
  agregarAfirmacion,
  agregarCita,
  crearInsight,
  ErrorInsight,
  insightsCitables,
  insightsDelWorkspace,
  registrarContradiccion,
  validarInsight,
} from './insight.servicio';

/** Server functions de insights. Mutaciones con contrato uniforme {ok, …}; el loader
 * devuelve null si la cuenta dejó de estar activa (igual que si no hubiera sesión). */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorInsight) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const err = e as { code?: string };
  if (err.code === '23505') return 'Ese elemento ya existe';
  if (err.code === '23503') return 'Alguna referencia no existe en este workspace';
  if (err.code === '42501') return 'Sin permiso para esta acción en el workspace';
  return null;
}

export const insightsDelEspacio = createServerFn({ method: 'GET' })
  .inputValidator(InsightsInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await insightsDelWorkspace(usuarioId, data.workspaceId, data.cursor);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return { insights: [], siguiente: null };
      throw e;
    }
  });

/** Proyección mínima para pickers: sin ella la pantalla del proyecto arrastraría toda
 * la ficha de cada insight solo para pintar un `<option>`. */
export const insightsParaCitar = createServerFn({ method: 'GET' })
  .inputValidator(InsightsInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await insightsCitables(usuarioId, data.workspaceId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return { insights: [], hayMas: false };
      throw e;
    }
  });

export const proponerInsight = createServerFn({ method: 'POST' })
  .inputValidator(CrearInsightSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearInsight(actorId, data);
      return { ok: true as const, insightId: r.insightId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const afirmarEnInsight = createServerFn({ method: 'POST' })
  .inputValidator(AgregarAfirmacionSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await agregarAfirmacion(actorId, data);
      return { ok: true as const, afirmacionId: r.afirmacionId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const citarEvidencia = createServerFn({ method: 'POST' })
  .inputValidator(AgregarCitaSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await agregarCita(actorId, data);
      return { ok: true as const, citaId: r.citaId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const anotarContradiccion = createServerFn({ method: 'POST' })
  .inputValidator(RegistrarContradiccionSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await registrarContradiccion(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const validarInsightPropuesto = createServerFn({ method: 'POST' })
  .inputValidator(ValidarInsightSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await validarInsight(actorId, data.workspaceId, data.insightId);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
