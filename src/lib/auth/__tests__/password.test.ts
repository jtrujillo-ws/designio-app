import { describe, expect, it } from 'vitest';
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

  it('tokens de invitación: aleatorios, con hash SHA-256 determinista', () => {
    const a = generarTokenInvitacion();
    const b = generarTokenInvitacion();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hashTokenInvitacion(a.token));
    expect(a.tokenHash).toHaveLength(64);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
