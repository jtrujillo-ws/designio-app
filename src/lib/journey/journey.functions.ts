import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  AgregarAristaSchema,
  AgregarNodoSchema,
  BorrarAristaSchema,
  BorrarNodoSchema,
  CongelarJourneySchema,
  CrearJourneySchema,
  EditarNodoSchema,
  EnlazarEvidenciaNodoSchema,
  JourneyInputSchema,
  JourneysInputSchema,
} from './journey.schemas';
import {
  agregarArista,
  agregarNodo,
  borrarArista,
  borrarNodo,
  congelarJourney,
  crearJourney,
  editarNodo,
  enlazarEvidenciaANodo,
  ErrorJourney,
  journeyCompleto,
  journeysDelWorkspace,
} from './journey.servicio';

/** Server functions del journey. Mutaciones con contrato uniforme {ok, …}; los loaders
 * devuelven null cuando la cuenta ya no puede leer, para que la pantalla se comporte
 * como si el objeto no existiera en vez de reventar. */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorJourney) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const err = e as { code?: string };
  if (err.code === '23505') return 'Esa relación ya existe en el journey';
  if (err.code === '23503') return 'Alguna referencia no existe en este workspace';
  if (err.code === '23514') return 'El elemento no cumple las reglas del grafo';
  if (err.code === '42501') return 'Sin permiso para esta acción en el workspace';
  return null;
}

export const journeyDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(JourneyInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await journeyCompleto(usuarioId, data.workspaceId, data.journeyId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const listaDeJourneys = createServerFn({ method: 'GET' })
  .inputValidator(JourneysInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await journeysDelWorkspace(usuarioId, data.workspaceId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return [];
      throw e;
    }
  });

export const crearJourneyDeServicio = createServerFn({ method: 'POST' })
  .inputValidator(CrearJourneySchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearJourney(actorId, data);
      return { ok: true as const, journeyId: r.journeyId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const agregarNodoAlJourney = createServerFn({ method: 'POST' })
  .inputValidator(AgregarNodoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await agregarNodo(actorId, data);
      return { ok: true as const, nodoId: r.nodoId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const editarNodoDelJourney = createServerFn({ method: 'POST' })
  .inputValidator(EditarNodoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await editarNodo(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const borrarNodoDelJourney = createServerFn({ method: 'POST' })
  .inputValidator(BorrarNodoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await borrarNodo(actorId, data.workspaceId, data.nodoId);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const agregarAristaAlJourney = createServerFn({ method: 'POST' })
  .inputValidator(AgregarAristaSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await agregarArista(actorId, data);
      return { ok: true as const, aristaId: r.aristaId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const borrarAristaDelJourney = createServerFn({ method: 'POST' })
  .inputValidator(BorrarAristaSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await borrarArista(actorId, data.workspaceId, data.aristaId);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const enlazarEvidenciaAlNodo = createServerFn({ method: 'POST' })
  .inputValidator(EnlazarEvidenciaNodoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await enlazarEvidenciaANodo(actorId, data.workspaceId, data.nodoId, data.evidenciaId);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const congelarJourneyDelWorkspace = createServerFn({ method: 'POST' })
  .inputValidator(CongelarJourneySchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await congelarJourney(actorId, data.workspaceId, data.journeyId, data.motivo);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
