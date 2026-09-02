import { createServerFn } from '@tanstack/react-start';
import { deleteCookie, setCookie } from '@tanstack/react-start/server';
import { requerirUsuarioId, usuarioIdDeRequest } from './guardia.server';
import { EstablecerPasswordSchema, InvitarMiembroSchema, LoginSchema } from './auth.schemas';
import {
  activarConToken,
  autenticar,
  crearInvitacion,
  ErrorAutorizacion,
  usuarioConMembresias,
} from './auth.servicio';
import { COOKIE_SESION, DURACION_SESION_S, firmarSesion } from './sesion.server';

/** Server functions de auth. Convención dura: este módulo solo exporta server functions. */

async function fijarCookieSesion(usuarioId: string): Promise<void> {
  setCookie(COOKIE_SESION, await firmarSesion(usuarioId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: DURACION_SESION_S,
  });
}

export const iniciarSesion = createServerFn({ method: 'POST' })
  .inputValidator(LoginSchema)
  .handler(async ({ data }) => {
    const usuario = await autenticar(data.email, data.password);
    if (!usuario) {
      // Fallo de dominio, no de transporte: mismo mensaje exista o no la cuenta.
      return { ok: false as const, error: 'Correo o contraseña incorrectos' };
    }
    await fijarCookieSesion(usuario.id);
    return { ok: true as const, usuario };
  });

export const cerrarSesion = createServerFn({ method: 'POST' }).handler(async () => {
  deleteCookie(COOKIE_SESION, { path: '/' });
  return { ok: true as const };
});

/** Usuario de la sesión actual (o null): lo usan los guards de rutas y la topbar. */
export const usuarioActual = createServerFn({ method: 'GET' }).handler(async () => {
  const usuarioId = await usuarioIdDeRequest();
  if (!usuarioId) return null;
  return usuarioConMembresias(usuarioId);
});

export const establecerPassword = createServerFn({ method: 'POST' })
  .inputValidator(EstablecerPasswordSchema)
  .handler(async ({ data }) => {
    const usuario = await activarConToken(data.token, data.password);
    if (!usuario) {
      return { ok: false as const, error: 'La invitación no es válida o ya expiró' };
    }
    await fijarCookieSesion(usuario.id);
    return { ok: true as const, usuario };
  });

export const invitarMiembro = createServerFn({ method: 'POST' })
  .inputValidator(InvitarMiembroSchema)
  .handler(async ({ data }) => {
    const actorId = await requerirUsuarioId();
    try {
      const r = await crearInvitacion(actorId, data);
      // MVP sin correo saliente: el enlace se entrega a quien invita para compartirlo
      // (el envío por email llega con el portal completo de SPEC-01).
      return {
        ok: true as const,
        requiereActivacion: r.requiereActivacion,
        enlace: r.token ? `/invitacion/${r.token}` : null,
      };
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return { ok: false as const, error: e.message };
      const code = (e as { code?: string }).code;
      if (code === '23505') return { ok: false as const, error: 'Esa persona ya es miembro del workspace' };
      if (code === '42501') return { ok: false as const, error: 'Sin permiso para invitar en este workspace' };
      throw e;
    }
  });
