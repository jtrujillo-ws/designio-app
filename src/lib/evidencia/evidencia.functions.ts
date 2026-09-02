import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  AprobarItemSchema,
  BandejaInputSchema,
  CrearItemImportacionSchema,
  ItemInputSchema,
  RechazarItemSchema,
} from './evidencia.schemas';
import {
  aprobarItem,
  contenidoDeItem,
  crearItem,
  ErrorCuraduria,
  listarBandeja,
  listarEvidencias,
  rechazarItem,
} from './evidencia.servicio';

/** Server functions de la bandeja de importación. Mutaciones con contrato uniforme {ok, …};
 * la lectura (loader) lanza, alimentando el redirect/error boundary del router. */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorCuraduria) return e.message;
  // Cuenta desactivada con JWT aún vigente (capa 2 del servicio).
  if (e instanceof ErrorAutorizacion) return e.message;
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
    try {
      const bandeja = await listarBandeja(usuarioId, data.workspaceId, data.antesDe);
      return { workspaceId: data.workspaceId, ...bandeja };
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

/** Contenido completo de un item para inspección previa a la decisión (RF-03.3). */
export const contenidoDeItemImportacion = createServerFn({ method: 'GET' })
  .inputValidator(ItemInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return { contenido: await contenidoDeItem(usuarioId, data.workspaceId, data.itemId) };
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

/** Evidencias del workspace para pickers de módulos citantes (checklists del método). */
export const evidenciasDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(BandejaInputSchema.pick({ workspaceId: true }))
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await listarEvidencias(usuarioId, data.workspaceId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
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
