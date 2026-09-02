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
    if (ventanas.size >= MAX_CLAVES) recortar(ahora);
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

/**
 * Descuenta UN intento que resultó legítimo: los éxitos no consumen cupo (una IP
 * compartida con muchos logins válidos nunca se bloquea), pero un solo éxito tampoco
 * "lava" la ventana entera — los fallos acumulados siguen contando.
 */
export function descontarIntento(clave: string): void {
  const v = ventanas.get(clave);
  if (v) v.cuenta = Math.max(0, v.cuenta - 1);
}

/** La cota de memoria es DURA: si tras purgar lo vencido el Map sigue lleno (spam de
 * claves únicas dentro de la misma ventana), se expulsan las entradas más viejas en
 * orden de inserción. Proteger la memoria gana; el límite de las claves expulsadas se
 * degrada bajo ese ataque concreto. */
function recortar(ahora: number): void {
  for (const [k, v] of ventanas) {
    if (ahora - v.abreEn >= VENTANA_MS) ventanas.delete(k);
  }
  if (ventanas.size >= MAX_CLAVES) {
    let sobrantes = ventanas.size - MAX_CLAVES + 1;
    for (const k of ventanas.keys()) {
      if (sobrantes <= 0) break;
      ventanas.delete(k);
      sobrantes -= 1;
    }
  }
}

/** Solo para tests. */
export function tamanoLimitador(): number {
  return ventanas.size;
}

/** Solo para tests. */
export function reiniciarLimitador(): void {
  ventanas.clear();
}
