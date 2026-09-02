import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { firmarSesion, usuarioIdDeSesion } from '@/lib/auth/sesion.server';

// secreto() lee el env EN CADA LLAMADA, así que fijarlo aquí gobierna todos los tests.
const SECRETO = 'secreto-de-test';
process.env.JWT_SECRET = SECRETO;

const USUARIO = '11111111-1111-1111-1111-111111111111';

async function tokenManual(opciones: { exp: number; clave?: string }): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USUARIO)
    .setExpirationTime(opciones.exp)
    .sign(new TextEncoder().encode(opciones.clave ?? SECRETO));
}

describe('sesión JWT', () => {
  it('roundtrip: firmar → verificar devuelve el usuario', async () => {
    const token = await firmarSesion(USUARIO);
    expect(await usuarioIdDeSesion(token)).toBe(USUARIO);
  });

  it('token ausente, corrupto o manipulado → null', async () => {
    expect(await usuarioIdDeSesion(undefined)).toBeNull();
    expect(await usuarioIdDeSesion('basura.no.jwt')).toBeNull();
    const token = await firmarSesion(USUARIO);
    expect(await usuarioIdDeSesion(`${token.slice(0, -2)}xx`)).toBeNull();
  });

  it('token expirado → null', async () => {
    const vencido = await tokenManual({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await usuarioIdDeSesion(vencido)).toBeNull();
  });

  it('token firmado con otra clave → null', async () => {
    const ajeno = await tokenManual({
      exp: Math.floor(Date.now() / 1000) + 3600,
      clave: 'otra-clave-cualquiera',
    });
    expect(await usuarioIdDeSesion(ajeno)).toBeNull();
  });
});
