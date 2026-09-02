import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  AbrirHiloSchema,
  AuditoriaInputSchema,
  ComentarSchema,
  HilosInputSchema,
  ResolverHiloSchema,
} from './portal.schemas';
import {
  abrirHilo,
  comentar,
  ErrorPortal,
  hilosDeObjetos,
  listarAuditoria,
  resolverHilo,
} from './portal.servicio';

/** Server functions del portal y de la auditoría. Mutaciones con contrato uniforme
 * {ok, …}; los loaders devuelven null ante ErrorAutorizacion (cuenta desactivada con JWT
 * vigente, o rol sin acceso a la auditoría). */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorPortal) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const code = (e as { code?: string }).code;
  if (code === '42501') return 'Sin permiso para esta acción en el workspace';
  if (code === '23503') return 'Alguna referencia no existe en este workspace';
  if (code === '23514') return 'El comentario supera los límites permitidos';
  return null;
}

/** Hilos de los objetos que la pantalla presenta (proyecto y sus gates, hoy). */
export const hilosDelPortal = createServerFn({ method: 'GET' })
  .inputValidator(HilosInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await hilosDeObjetos(usuarioId, data.workspaceId, data.objetos);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

/** Auditoría del workspace: null si el rol no la consulta (RF-01.6) o la cuenta ya no
 * está activa — la pantalla explica cuál de las dos con el rol del contexto. */
export const auditoriaDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(AuditoriaInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      const pagina = await listarAuditoria(usuarioId, data.workspaceId, {
        tipo: data.tipo,
        antesDe: data.antesDe,
      });
      return { workspaceId: data.workspaceId, ...pagina };
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const abrirHiloDelPortal = createServerFn({ method: 'POST' })
  .inputValidator(AbrirHiloSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await abrirHilo(actorId, data);
      return { ok: true as const, hiloId: r.hiloId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const comentarEnHilo = createServerFn({ method: 'POST' })
  .inputValidator(ComentarSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await comentar(actorId, data);
      return { ok: true as const, comentarioId: r.comentarioId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const resolverHiloDelPortal = createServerFn({ method: 'POST' })
  .inputValidator(ResolverHiloSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await resolverHilo(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
