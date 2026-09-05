import '@/lib/server-only';
import { jwtVerify, SignJWT } from 'jose';
import { ErrorConfiguracion } from '@/lib/configuracion.server';

/**
 * Sesión = JWT HS256 en cookie httpOnly (auth nativa del diseño técnico; sin estado en DB).
 * Módulo puro (sin dependencias del framework) para poder testearlo aislado; la lectura
 * y escritura de la cookie viven en guardia.server.ts / auth.functions.ts.
 */

export const COOKIE_SESION = 'designio_sesion';
export const DURACION_SESION_S = 60 * 60 * 24 * 7; // 7 días

// El mismo JWT_SECRET firmará después recovery y tokens de capacidad (.env.local.example):
// emisor + audiencia fijan el PROPÓSITO del token para que un token de otro tipo jamás
// valide como sesión (confusión de tokens).
const EMISOR = 'designio';
const AUDIENCIA_SESION = 'designio:sesion';

let avisoDevDado = false;

function secreto(): Uint8Array {
  let s = process.env.JWT_SECRET;
  if (!s) {
    // Mismo contrato que APP_DB_PASSWORD: default SOLO de desarrollo; en producción se aborta.
    // Ojo: Vite inlinea NODE_ENV=production al compilar, así que el build de producción
    // SIEMPRE exige JWT_SECRET; el fallback solo existe para vite dev y los tests.
    if (process.env.NODE_ENV === 'production') {
      throw new ErrorConfiguracion('Falta JWT_SECRET: en producción las sesiones no pueden firmarse con la clave de desarrollo');
    }
    if (!avisoDevDado) {
      console.warn('JWT_SECRET no definido: usando la clave de DESARROLLO para firmar sesiones');
      avisoDevDado = true;
    }
    s = 'designio_jwt_dev';
  }
  return new TextEncoder().encode(s);
}

export async function firmarSesion(usuarioId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(usuarioId)
    .setIssuer(EMISOR)
    .setAudience(AUDIENCIA_SESION)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + DURACION_SESION_S)
    .sign(secreto());
}

/** Devuelve el usuario de un token de sesión, o null si falta, es inválido o expiró. */
export async function usuarioIdDeSesion(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  // Fuera del try: que falte JWT_SECRET es un error de configuración y debe tronar
  // ruidosamente, no disfrazarse de "sesión inválida" con un redirect silencioso.
  const clave = secreto();
  try {
    const { payload } = await jwtVerify(token, clave, {
      algorithms: ['HS256'],
      issuer: EMISOR,
      audience: AUDIENCIA_SESION,
    });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
