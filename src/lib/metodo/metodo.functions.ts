import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  ActivarRetoSchema,
  AprobarGateSchema,
  CrearRetoSchema,
  CriterioSchema,
  MarcarItemSchema,
  ProyectoInputSchema,
} from './metodo.schemas';
import {
  activarReto,
  agregarCriterio,
  aprobarGate,
  crearReto,
  ErrorMetodo,
  marcarItem,
  proyectoMetodo,
} from './metodo.servicio';

/** Server functions del método. Mutaciones con contrato uniforme {ok, …}; el loader
 * lanza hacia el error boundary del router. */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorMetodo) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const err = e as { code?: string; constraint_name?: string };
  if (err.code === '23505') return 'Ese código ya existe en el workspace';
  if (err.code === '23503') return 'Alguna referencia no existe en este workspace';
  if (err.code === '42501') return 'Sin permiso para esta acción en el workspace';
  return null;
}

export const proyectoDelMetodo = createServerFn({ method: 'GET' })
  .inputValidator(ProyectoInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await proyectoMetodo(usuarioId, data.workspaceId, data.proyectoId);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const crearRetoCandidato = createServerFn({ method: 'POST' })
  .inputValidator(CrearRetoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearReto(actorId, data);
      return { ok: true as const, retoId: r.retoId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const definirCriterio = createServerFn({ method: 'POST' })
  .inputValidator(CriterioSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await agregarCriterio(actorId, data);
      return { ok: true as const, criterioId: r.criterioId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const activarRetoConPerfil = createServerFn({ method: 'POST' })
  .inputValidator(ActivarRetoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await activarReto(actorId, data);
      return { ok: true as const, proyectoId: r.proyectoId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const marcarItemDeChecklist = createServerFn({ method: 'POST' })
  .inputValidator(MarcarItemSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await marcarItem(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const aprobarGateDeProyecto = createServerFn({ method: 'POST' })
  .inputValidator(AprobarGateSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await aprobarGate(actorId, data);
      return { ok: true as const, numero: r.numero };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
