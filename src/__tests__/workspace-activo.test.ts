import { describe, expect, it } from 'vitest';
import { membresiaActivaDe, wsDeBusqueda } from '@/lib/auth/workspace-activo';

/**
 * Resolución del workspace activo de navegación: `ws` elige, lo malformado se ignora
 * y sin coincidencia gobierna la primera membresía. (La autorización real no depende
 * de esto: las server functions re-validan contra RLS.)
 */
describe('workspace activo (navegación multi-membresía)', () => {
  const a = { workspaceId: '11111111-1111-4111-8111-111111111111', nombre: 'A' };
  const b = { workspaceId: '22222222-2222-4222-8222-222222222222', nombre: 'B' };

  it('wsDeBusqueda solo acepta uuids bien formados', () => {
    expect(wsDeBusqueda(a.workspaceId)).toBe(a.workspaceId);
    expect(wsDeBusqueda('no-es-uuid')).toBeUndefined();
    expect(wsDeBusqueda('')).toBeUndefined();
    expect(wsDeBusqueda(42)).toBeUndefined();
    expect(wsDeBusqueda(undefined)).toBeUndefined();
    // Casi-uuid: un carácter fuera del alfabeto hex no pasa.
    expect(wsDeBusqueda('11111111-1111-4111-8111-11111111111z')).toBeUndefined();
  });

  it('membresiaActivaDe elige la pedida y se cae a la primera si no corresponde', () => {
    expect(membresiaActivaDe([a, b], b.workspaceId)).toBe(b);
    expect(membresiaActivaDe([a, b], undefined)).toBe(a);
    // Un ws de OTRO usuario (o inventado) no elige nada: gobierna la primera.
    expect(membresiaActivaDe([a, b], '33333333-3333-4333-8333-333333333333')).toBe(a);
    expect(membresiaActivaDe([], a.workspaceId)).toBeUndefined();
  });
});
