import '@/lib/server-only';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

/** Credenciales (diseño técnico · Seguridad): bcrypt para passwords; los tokens de
 * invitación viajan en la URL y en la base solo vive su hash SHA-256. */

const COSTO_BCRYPT = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COSTO_BCRYPT);
}

export async function verificarPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generarTokenInvitacion(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashTokenInvitacion(token) };
}

export function hashTokenInvitacion(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
