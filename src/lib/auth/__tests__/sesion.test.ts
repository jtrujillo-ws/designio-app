import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { firmarSesion, usuarioIdDeSesion } from '@/lib/auth/sesion.server';

// secreto() lee el env EN CADA LLAMADA, así que fijarlo aquí gobierna todos los tests.
const SECRETO = 'secreto-de-test';
process.env.JWT_SECRET = SECRETO;

const USUARIO = '11111111-1111-1111-1111-111111111111';

async function tokenManual(opciones: {
  exp: number;
  clave?: string;
  emisor?: string | null;
  audiencia?: string | null;
}): Promise<string> {
  // Por defecto replica los claims de producción para que cada test aísle UNA causa de rechazo.
  const jwt = new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(USUARIO);
  if (opciones.emisor !== null) jwt.setIssuer(opciones.emisor ?? 'designio');
  if (opciones.audiencia !== null) jwt.setAudience(opciones.audiencia ?? 'designio:sesion');
  return jwt.setExpirationTime(opciones.exp).sign(new TextEncoder().encode(opciones.clave ?? SECRETO));
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
    // La manipulación toca el PRIMER carácter de la firma, no el último, y el motivo es
    // que el último no sirve para esto: una firma HS256 son 32 bytes = 256 bits, y su
    // base64url son 43 caracteres = 258 bits, así que del carácter final solo cuentan 4
    // bits y los otros 2 se descartan al decodificar. Medido: para CADA token hay 3
    // caracteres finales ALTERNATIVOS que decodifican a la misma firma y verifican igual.
    // Con la versión anterior —sustituir los dos últimos por 'xx'— el token manipulado
    // seguía siendo válido cuando el penúltimo carácter ya era 'x' y el último caía en su
    // clase de equivalencia: ~1 de cada 1024 ejecuciones. Se vio en CI.
    //
    // En el primer carácter los seis bits son significativos, así que cambiarlo cambia la
    // firma SIEMPRE. Y se elige un sustituto distinto del original para que la
    // manipulación no pueda ser la identidad.
    const [cabecera, cuerpo, firma] = token.split('.');
    const otro = firma!.startsWith('A') ? 'B' : 'A';
    expect(
      await usuarioIdDeSesion(`${cabecera}.${cuerpo}.${otro}${firma!.slice(1)}`),
    ).toBeNull();
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

  it('confusión de tokens: mismo secreto pero sin la audiencia/emisor de sesión → null', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    // Un futuro token de recovery/capacidad firmado con el MISMO JWT_SECRET no debe valer como sesión.
    expect(await usuarioIdDeSesion(await tokenManual({ exp, audiencia: null, emisor: null }))).toBeNull();
    expect(await usuarioIdDeSesion(await tokenManual({ exp, audiencia: 'designio:recovery' }))).toBeNull();
    expect(await usuarioIdDeSesion(await tokenManual({ exp, emisor: 'otro-emisor' }))).toBeNull();
  });
});
