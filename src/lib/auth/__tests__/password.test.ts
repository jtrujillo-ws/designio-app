import { describe, expect, it } from 'vitest';
import { PasswordNuevaSchema } from '@/lib/auth/auth.schemas';
import {
  generarTokenInvitacion,
  hashPassword,
  hashTokenInvitacion,
  verificarPassword,
} from '@/lib/auth/password.server';

describe('password y tokens de invitación', () => {
  it('hash bcrypt: verifica la password correcta y rechaza la incorrecta', async () => {
    const h = await hashPassword('UnaClaveLarga1');
    expect(h.startsWith('$2')).toBe(true);
    expect(await verificarPassword('UnaClaveLarga1', h)).toBe(true);
    expect(await verificarPassword('OtraClaveDistinta', h)).toBe(false);
  });

  it('dos hashes de la misma password difieren (salt por hash)', async () => {
    const [a, b] = await Promise.all([hashPassword('x'.repeat(12)), hashPassword('x'.repeat(12))]);
    expect(a).not.toBe(b);
  });

  it('la política rechaza contraseñas que bcrypt truncaría (>72 bytes, en BYTES no caracteres)', () => {
    expect(PasswordNuevaSchema.safeParse('x'.repeat(72)).success).toBe(true);
    expect(PasswordNuevaSchema.safeParse('x'.repeat(73)).success).toBe(false);
    // Unicode llega al límite con muchos menos "caracteres": 25 emojis = 100 bytes.
    expect(PasswordNuevaSchema.safeParse('😀'.repeat(25)).success).toBe(false);
  });

  it('tokens de invitación: aleatorios, con hash SHA-256 determinista', () => {
    const a = generarTokenInvitacion();
    const b = generarTokenInvitacion();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hashTokenInvitacion(a.token));
    expect(a.tokenHash).toHaveLength(64);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
