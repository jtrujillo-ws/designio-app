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
  it('la identidad resuelta es lo que la `key` del layout puede usar sin remontar de más', () => {
    // Es la propiedad de la que depende `LayoutPorWorkspace`: la `key` se saca de la
    // membresía RESUELTA, no del `ws` crudo. Entrar sin parámetro y después fijarlo
    // explícitamente al MISMO workspace tiene que dar la misma identidad — si la `key`
    // fuera el parámetro, ese paso remontaría la pantalla y tiraría lo que el usuario
    // estuviera escribiendo, sin haber cambiado de workspace.
    expect(membresiaActivaDe([a, b], undefined)?.workspaceId).toBe(
      membresiaActivaDe([a, b], a.workspaceId)?.workspaceId,
    );
    // Y un `ws` que no corresponde a ninguna membresía tampoco cambia la identidad: cae a
    // la primera, así que tampoco debe remontar.
    expect(membresiaActivaDe([a, b], '33333333-3333-4333-8333-333333333333')?.workspaceId).toBe(
      membresiaActivaDe([a, b], undefined)?.workspaceId,
    );
    // Cambiar de verdad de workspace SÍ cambia la identidad: es el caso que debe remontar.
    expect(membresiaActivaDe([a, b], b.workspaceId)?.workspaceId).not.toBe(
      membresiaActivaDe([a, b], a.workspaceId)?.workspaceId,
    );
  });
});
