import { createServerFn } from '@tanstack/react-start';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  AprobarItemSchema,
  BandejaInputSchema,
  CrearItemImportacionSchema,
  RechazarItemSchema,
} from './evidencia.schemas';
import { aprobarItem, crearItem, ErrorCuraduria, listarBandeja, rechazarItem } from './evidencia.servicio';

/** Server functions de la bandeja de importación. Mutaciones con contrato uniforme {ok, …};
 * la lectura (loader) lanza, alimentando el redirect/error boundary del router. */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorCuraduria) return e.message;
  const code = (e as { code?: string }).code;
  if (code === '42501') return 'Sin permiso para esta acción en el workspace';
  if (code === '23514') return 'El contenido supera los límites permitidos';
  return null;
}

/** Bandeja del workspace indicado (el loader lo toma del contexto del guard: la
 * primera membresía — sin re-derivarlo aquí). RLS deja vacía la de un workspace ajeno. */
export const bandejaDeImportacion = createServerFn({ method: 'GET' })
  .inputValidator(BandejaInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    return { workspaceId: data.workspaceId, items: await listarBandeja(usuarioId, data.workspaceId) };
  });

export const crearItemImportacion = createServerFn({ method: 'POST' })
  .inputValidator(CrearItemImportacionSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearItem(actorId, data);
      return { ok: true as const, itemId: r.itemId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const aprobarItemImportacion = createServerFn({ method: 'POST' })
  .inputValidator(AprobarItemSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await aprobarItem(actorId, data);
      return { ok: true as const, evidenciaId: r.evidenciaId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const rechazarItemImportacion = createServerFn({ method: 'POST' })
  .inputValidator(RechazarItemSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await rechazarItem(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
