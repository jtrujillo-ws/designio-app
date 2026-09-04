import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import { EjecutarDisposicionSchema, RegistrarAcuerdoSchema } from './disposicion.schemas';
import {
  ErrorDisposicion,
  ejecutarDisposicion,
  panelDisposicion,
  registrarAcuerdo,
} from './disposicion.servicio';
import { z } from 'zod';

function motivo(e: unknown): string | null {
  if (e instanceof ErrorDisposicion || e instanceof ErrorAutorizacion) return e.message;
  if ((e as { code?: string }).code === '42501') {
    return 'No tienes permiso para disponer de este workspace';
  }
  return null;
}

export const panelDisposicionFn = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ workspaceId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      return { ok: true as const, panel: await panelDisposicion(actorId, data.workspaceId) };
    } catch (e) {
      const m = motivo(e);
      if (m) return { ok: false as const, error: m };
      throw e;
    }
  });

export const registrarAcuerdoFn = createServerFn({ method: 'POST' })
  .inputValidator(RegistrarAcuerdoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      return { ok: true as const, acuerdo: await registrarAcuerdo(actorId, data) };
    } catch (e) {
      const m = motivo(e);
      if (m) return { ok: false as const, error: m };
      throw e;
    }
  });

/**
 * Ejecutar es una MUTACIÓN (POST) y nunca un loader, y aquí eso importa más que en ninguna
 * otra pantalla: un loader se dispara al navegar y se repite con cada invalidación del router.
 * Esta operación destruye un workspace entero y no tiene vuelta.
 */
export const ejecutarDisposicionFn = createServerFn({ method: 'POST' })
  .inputValidator(EjecutarDisposicionSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      return { ok: true as const, constancia: await ejecutarDisposicion(actorId, data) };
    } catch (e) {
      const m = motivo(e);
      if (m) return { ok: false as const, error: m };
      throw e;
    }
  });
