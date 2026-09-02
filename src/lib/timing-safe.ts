import './server-only';
import { createHash, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/**
 * Comparación en tiempo constante para secretos (crons, API keys, tokens de capacidad).
 * Se hashea a longitud fija primero para que longitudes distintas no filtren información.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return nodeTimingSafeEqual(ha, hb);
}
