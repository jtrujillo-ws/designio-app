import type { OrigenKey } from './ai.schemas';

/**
 * Degradación segura (SPEC-09 RF-09.11, SYS-21, I4): la ausencia de AI —sin credencial,
 * proveedor caído, lento o con el presupuesto agotado— APAGA la capacidad con un mensaje
 * claro y no rompe nada más. Todo lo demás de la aplicación sigue funcionando y toda
 * operación de negocio tiene su camino manual equivalente.
 *
 * Módulo PURO a propósito (sin imports de servidor ni del SDK): la propiedad más
 * importante del slice —«no lanza nunca»— se prueba sin base de datos y sin proveedor.
 * La clasificación de fallos mira la FORMA del error (status/name), no su clase, para no
 * arrastrar el SDK hasta aquí.
 */

/** Política de modelos centralizada en CÓDIGO, no en env vars (diseño técnico): primario
 * y fallback por superficie; la degradación de modelo ocurre una sola vez por operación. */
export const MODELO_PRIMARIO = 'claude-opus-5';
export const MODELO_FALLBACK = 'claude-sonnet-5';

/** Presupuesto AI por workspace (RF-08.5): corte SUAVE — al agotarse se pausan las
 * capacidades AI, jamás un flujo de negocio. Un valor inválido cae al default y nunca
 * desactiva el tope. */
export const LIMITE_PROPUESTAS_DIA = 60;

/**
 * Tarifa del proveedor en USD por millón de tokens, por modelo de la política. Vive en
 * código junto a la política de modelos y no en la base: el coste se calcula con el
 * precio VIGENTE al generar y se persiste con la propuesta, así que una tarifa nueva no
 * reescribe el histórico. Un modelo sin tarifa conocida no inventa un coste: devuelve
 * null y el panel dice «sin tarifa registrada» en vez de un número falso.
 */
export const TARIFA_USD_POR_MTOK: Record<string, { entrada: number; salida: number }> = {
  [MODELO_PRIMARIO]: { entrada: 5, salida: 25 },
  [MODELO_FALLBACK]: { entrada: 2, salida: 10 },
};

/**
 * Cómo terminó UN intento contra el proveedor. Es el vocabulario que comparten el
 * adaptador, el servicio y el CHECK de `llamada_ai`: una sola lista, o el libro de costos
 * acabaría con valores que nadie sabe leer.
 *
 * `salida-valida` es «contenido que pasó el esquema de la capacidad»; los otros tres son
 * intentos de los que no puede nacer nada, y se distinguen porque son gastos y problemas
 * distintos: una negativa se revisa, un formato roto se investiga, un timeout se reintenta.
 */
export const RESULTADOS_INTENTO = [
  'salida-valida',
  'rechazo-proveedor',
  'fuera-de-contrato',
  'sin-respuesta',
] as const;
export type ResultadoIntento = (typeof RESULTADOS_INTENTO)[number];

/** Uso de UNA llamada tal como lo devuelve el proveedor. */
export type UsoTokens = {
  entrada: number;
  salida: number;
  /** Escritura de caché (~1,25×) y lectura de caché (~0,1×): hoy no se cachea, pero el
   * coste se calcula con la fórmula completa para que activar el cacheo no exija
   * reabrir esto ni deje el histórico mal contado. */
  cacheEscritura?: number;
  cacheLectura?: number;
};

/** Coste en USD de una llamada, redondeado al micro-dólar (la precisión que persiste la
 * columna). Sin tarifa para ese modelo → null. */
export function costoDeUso(modelo: string, uso: UsoTokens): number | null {
  const tarifa = TARIFA_USD_POR_MTOK[modelo];
  if (!tarifa) return null;
  const entrada =
    uso.entrada + (uso.cacheEscritura ?? 0) * 1.25 + (uso.cacheLectura ?? 0) * 0.1;
  const usd = (entrada * tarifa.entrada + uso.salida * tarifa.salida) / 1_000_000;
  return Math.round(Math.max(0, usd) * 1_000_000) / 1_000_000;
}

/** El proveedor no puede colgar una pantalla: pasado este techo la llamada se aborta y
 * la capacidad se reporta como no disponible en esta operación. */
export const TIMEOUT_PROVEEDOR_MS = 25_000;

export type EstadoCapacidadAI = {
  disponible: boolean;
  /** Vacío si está disponible; si no, el porqué en lenguaje de la UI (nunca un stack). */
  motivo: string;
  origenKey: OrigenKey | null;
  modelo: string;
  propuestasHoy: number;
  limiteDiario: number;
};

const COLA_MANUAL = 'Todo el flujo sigue disponible a mano.';

/**
 * Estado de la capacidad AI para un workspace. Nunca lanza: en el peor de los casos
 * devuelve «apagada» con su motivo, que es exactamente lo que la UI necesita pintar.
 *
 * BYOAI (diseño técnico · Proveedores y BYOAI): la key del workspace gana a la del
 * entorno y el lineage registra cuál sirvió. Hoy el resolver de servidor solo entrega la
 * del entorno —guardar la credencial de un cliente en una columna legible bajo RLS
 * contradiría RF-09.6 (secretos en secret manager)—, pero la precedencia vive aquí para
 * que enchufar el secret manager no toque ni esta lógica ni el esquema.
 */
export function evaluarCapacidadAI(entrada: {
  keyWorkspace?: string | null;
  keyEntorno?: string | null;
  propuestasHoy?: number;
  limiteDiario?: number;
  /** Cuántas propuestas puede llegar a persistir la generación que se está admitiendo
   * (el techo de la capacidad). El panel no pasa ninguna: pregunta por el estado, no
   * pide hueco. Sin esto, «queda 1 y la generación produce 4» pasaba el chequeo. */
  unidades?: number;
}): EstadoCapacidadAI {
  const limite =
    Number.isInteger(entrada.limiteDiario) && (entrada.limiteDiario as number) > 0
      ? (entrada.limiteDiario as number)
      : LIMITE_PROPUESTAS_DIA;
  const usadas = Number.isFinite(entrada.propuestasHoy) ? Math.max(0, entrada.propuestasHoy!) : 0;
  const piden =
    Number.isInteger(entrada.unidades) && (entrada.unidades as number) > 0
      ? (entrada.unidades as number)
      : 1;

  const delWorkspace = (entrada.keyWorkspace ?? '').trim();
  const delEntorno = (entrada.keyEntorno ?? '').trim();
  const origenKey: OrigenKey | null = delWorkspace ? 'workspace' : delEntorno ? 'entorno' : null;

  const base = { modelo: MODELO_PRIMARIO, propuestasHoy: usadas, limiteDiario: limite };

  if (!origenKey) {
    return {
      ...base,
      disponible: false,
      origenKey: null,
      motivo: `Capacidad AI apagada: este despliegue no tiene credencial del proveedor configurada. ${COLA_MANUAL}`,
    };
  }
  if (usadas >= limite) {
    return {
      ...base,
      disponible: false,
      origenKey,
      motivo: `Presupuesto AI del workspace agotado por hoy (${usadas}/${limite} propuestas). Las capacidades AI quedan en pausa hasta mañana. ${COLA_MANUAL}`,
    };
  }
  if (usadas + piden > limite) {
    return {
      ...base,
      disponible: false,
      origenKey,
      motivo: `El presupuesto AI de hoy no alcanza para esta generación: quedan ${limite - usadas} de ${limite} propuestas y esta puede producir hasta ${piden}. ${COLA_MANUAL}`,
    };
  }
  return { ...base, disponible: true, origenKey, motivo: '' };
}

/**
 * Traduce un fallo del proveedor a un mensaje accionable. No lanza, no filtra cuerpos de
 * respuesta ni credenciales, y siempre recuerda que el camino manual sigue abierto.
 */
export function motivoDeFalloProveedor(e: unknown): string {
  const err = (e ?? {}) as { status?: unknown; name?: unknown; message?: unknown };
  const nombre = typeof err.name === 'string' ? err.name : '';
  const status = typeof err.status === 'number' ? err.status : null;

  if (/abort|timeout/i.test(nombre) || (typeof err.message === 'string' && /timeout/i.test(err.message))) {
    return `El proveedor AI no respondió a tiempo (${Math.round(TIMEOUT_PROVEEDOR_MS / 1000)} s). ${COLA_MANUAL}`;
  }
  if (status === 401 || status === 403) {
    return `El proveedor AI rechazó la credencial configurada. ${COLA_MANUAL}`;
  }
  if (status === 429) {
    return `El proveedor AI está limitando las llamadas ahora mismo. ${COLA_MANUAL}`;
  }
  if (status !== null && status >= 500) {
    return `El proveedor AI no está disponible en este momento. ${COLA_MANUAL}`;
  }
  if (status !== null && status >= 400) {
    return `El proveedor AI rechazó la petición (${status}). ${COLA_MANUAL}`;
  }
  if (/connection|network|fetch/i.test(nombre)) {
    return `No se pudo alcanzar al proveedor AI. ${COLA_MANUAL}`;
  }
  return `No se pudo generar la propuesta con AI. ${COLA_MANUAL}`;
}

/** El proveedor devolvió algo que no cumple el esquema de la capacidad: se descarta
 * entera (una propuesta a medias no es revisable) y se dice sin jerga. */
export const MOTIVO_ESQUEMA = `La respuesta del proveedor AI no cumplió el formato esperado y se descartó. ${COLA_MANUAL}`;

/** El proveedor ATENDIÓ la llamada y se negó a producir contenido (`stop_reason` de
 * negativa). No es indisponibilidad ni una petición mal formada: es una respuesta, con su
 * uso facturado, y llamarla por su nombre evita leerla como un fallo transitorio que
 * conviene reintentar — reintentar una negativa solo gasta el presupuesto otra vez. */
export const MOTIVO_RECHAZO = `El proveedor AI se negó a procesar este material. ${COLA_MANUAL}`;
