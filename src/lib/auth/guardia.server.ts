import '@/lib/server-only';
import { getCookie } from '@tanstack/react-start/server';
import { COOKIE_SESION, usuarioIdDeSesion } from './sesion.server';

/** Guardia de server functions: resuelve la identidad del request desde la cookie de sesión. */

export async function usuarioIdDeRequest(): Promise<string | null> {
  return usuarioIdDeSesion(getCookie(COOKIE_SESION));
}

/** Para server functions protegidas: identidad o error (capa previa a conUsuario/RLS). */
export async function requerirUsuarioId(): Promise<string> {
  const id = await usuarioIdDeRequest();
  if (!id) throw new Error('No autenticado');
  return id;
}
