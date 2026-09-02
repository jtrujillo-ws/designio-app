import '@/lib/server-only';

/**
 * Limitador de intentos en memoria, ventana fija de 15 min POR INSTANCIA.
 * Fricción MVP contra fuerza bruta online en login/activación (límite fail-safe:
 * sin dependencias, sin configuración que pueda desactivarlo); un límite compartido
 * entre instancias llegará con infraestructura si el piloto lo exige.
 */

const VENTANA_MS = 15 * 60 * 1000;
const MAX_CLAVES = 10_000; // cota de memoria; al superarla se purgan ventanas vencidas

type Ventana = { cuenta: number; abreEn: number };

const ventanas = new Map<string, Ventana>();

/** true si el intento está permitido; sigue contando aunque ya esté bloqueado. */
export function permitirIntento(clave: string, maximo: number): boolean {
  const ahora = Date.now();
  const v = ventanas.get(clave);
  if (!v || ahora - v.abreEn >= VENTANA_MS) {
    if (ventanas.size >= MAX_CLAVES) purgar(ahora);
    ventanas.set(clave, { cuenta: 1, abreEn: ahora });
    return true;
  }
  v.cuenta += 1;
  return v.cuenta <= maximo;
}

/** Un login correcto limpia la ventana de esa clave (no castiga al dueño legítimo). */
export function registrarExito(clave: string): void {
  ventanas.delete(clave);
}

function purgar(ahora: number): void {
  for (const [k, v] of ventanas) {
    if (ahora - v.abreEn >= VENTANA_MS) ventanas.delete(k);
  }
}

/** Solo para tests. */
export function reiniciarLimitador(): void {
  ventanas.clear();
}
