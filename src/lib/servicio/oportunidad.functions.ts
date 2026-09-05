import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  CrearOportunidadSchema,
  DecidirOportunidadSchema,
  EnlazarInsightSchema,
  PortafolioInputSchema,
  PriorizarOportunidadSchema,
} from './oportunidad.schemas';
import {
  crearOportunidad,
  decidirOportunidad,
  desenlazarInsight,
  enlazarInsight,
  ErrorOportunidad,
  insightsEnlazables,
  portafolioDelWorkspace,
  priorizarOportunidad,
} from './oportunidad.servicio';

/** Server functions del portafolio de oportunidades. Mutaciones con el contrato uniforme
 * {ok, …}; los loaders devuelven vacío si la cuenta dejó de estar activa (igual que si no
 * hubiera sesión). */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorOportunidad) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const err = e as { code?: string };
  if (err.code === '23505') return 'Ese elemento ya existe';
  if (err.code === '23503') return 'Alguna referencia no existe en este workspace';
  if (err.code === '42501') return 'Sin permiso para esta acción en el workspace';
  return null;
}

export const portafolioDelEspacio = createServerFn({ method: 'GET' })
  .inputValidator(PortafolioInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return { retos: await portafolioDelWorkspace(usuarioId, data.workspaceId) };
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return { retos: [] };
      throw e;
    }
  });

export const insightsParaTrazar = createServerFn({ method: 'GET' })
  .inputValidator(PortafolioInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return { insights: await insightsEnlazables(usuarioId, data.workspaceId) };
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return { insights: [] };
      throw e;
    }
  });

export const proponerOportunidad = createServerFn({ method: 'POST' })
  .inputValidator(CrearOportunidadSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearOportunidad(actorId, data);
      return { ok: true as const, oportunidadId: r.oportunidadId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const trazarInsight = createServerFn({ method: 'POST' })
  .inputValidator(EnlazarInsightSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await enlazarInsight(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const destrazarInsight = createServerFn({ method: 'POST' })
  .inputValidator(EnlazarInsightSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await desenlazarInsight(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const repriorizarOportunidad = createServerFn({ method: 'POST' })
  .inputValidator(PriorizarOportunidadSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await priorizarOportunidad(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const dictarVeredictoDeOportunidad = createServerFn({ method: 'POST' })
  .inputValidator(DecidirOportunidadSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await decidirOportunidad(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
