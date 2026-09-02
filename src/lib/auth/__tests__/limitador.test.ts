import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  descontarIntento,
  permitirIntento,
  registrarExito,
  reiniciarLimitador,
  tamanoLimitador,
} from '@/lib/auth/limitador.server';

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

  it('descontar un intento legítimo no consume cupo, pero no lava los fallos acumulados', () => {
    // Muchos éxitos seguidos desde una misma IP: nunca se bloquea.
    for (let i = 0; i < 50; i++) {
      expect(permitirIntento('ip', 30)).toBe(true);
      descontarIntento('ip');
    }
    // Fallos acumulados + un éxito: el éxito descuenta UNO, no borra la ventana.
    for (let i = 0; i < 29; i++) permitirIntento('ip2', 30);
    permitirIntento('ip2', 30); // intento 30 (el "éxito")
    descontarIntento('ip2'); // queda en 29
    expect(permitirIntento('ip2', 30)).toBe(true); // 30
    expect(permitirIntento('ip2', 30)).toBe(false); // 31: bloqueado
  });

  it('la cota de memoria es dura: el spam de claves únicas expulsa las más viejas', () => {
    for (let i = 0; i < 10_050; i++) permitirIntento(`clave-${i}`, 3);
    expect(tamanoLimitador()).toBeLessThanOrEqual(10_000);
    // Las claves recientes siguen contando normalmente.
    expect(permitirIntento('clave-10049', 3)).toBe(true);
  });
});
