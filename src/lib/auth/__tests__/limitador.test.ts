import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permitirIntento, registrarExito, reiniciarLimitador } from '@/lib/auth/limitador.server';

describe('limitador de intentos (ventana fija en memoria)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reiniciarLimitador();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('permite hasta el máximo y bloquea el siguiente', () => {
    for (let i = 0; i < 3; i++) expect(permitirIntento('k', 3)).toBe(true);
    expect(permitirIntento('k', 3)).toBe(false);
  });

  it('las claves son independientes', () => {
    for (let i = 0; i < 3; i++) permitirIntento('a', 3);
    expect(permitirIntento('a', 3)).toBe(false);
    expect(permitirIntento('b', 3)).toBe(true);
  });

  it('la ventana expira a los 15 minutos', () => {
    for (let i = 0; i < 4; i++) permitirIntento('k', 3);
    expect(permitirIntento('k', 3)).toBe(false);
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(permitirIntento('k', 3)).toBe(true);
  });

  it('un éxito limpia la ventana de esa clave (no castiga al dueño legítimo)', () => {
    for (let i = 0; i < 3; i++) permitirIntento('k', 3);
    registrarExito('k');
    expect(permitirIntento('k', 3)).toBe(true);
  });
});
