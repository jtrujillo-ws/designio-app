import './server-only';

/**
 * El despliegue no está en condiciones de atender esto, y REINTENTAR NO LO ARREGLA.
 *
 * Es una clase y no un mensaje a propósito. La distinción que hace falta —«esto es tuyo,
 * corrígelo» contra «esto es del servidor, avisa a quien lo administra»— no se puede sacar
 * del texto de un `Error`: las variables ausentes, el DSN que no parsea y la clave de firma
 * que falta la escriben tres módulos distintos, con tres redacciones, y una cuarta llegará.
 * Comparar cadenas para clasificarlas es el mismo vicio que este repositorio ya pagó en el
 * censo del calendario: un guardián de forma sujeta la SINTAXIS; la semántica la sujeta el
 * TIPO.
 *
 * Quien la lanza dice QUÉ falta, con detalle, para el registro del servidor. Quien la
 * atiende NO reenvía ese detalle al navegador: la pantalla de login es pública y el detalle
 * nombra variables de entorno —y a veces lleva dentro una cadena de conexión con su
 * contraseña—. Al visitante se le dice que no es culpa suya y que reintentar no sirve; el
 * porqué se queda en el log, que es donde lo puede leer quien puede arreglarlo.
 */
export class ErrorConfiguracion extends Error {
  constructor(mensaje: string, opciones?: { cause?: unknown }) {
    super(mensaje, opciones);
    this.name = 'ErrorConfiguracion';
  }
}

/**
 * Lo que se le dice al visitante. Sin detalles y sin «intenta de nuevo», que era la mentira:
 * un reintento sobre un despliegue mal configurado no puede funcionar nunca, y quien lo lee
 * revisa su contraseña —o la cambia— buscando una culpa que no tiene.
 */
export const ERROR_CONFIGURACION_VISIBLE =
  'El servidor no puede completar el inicio de sesión por un fallo de configuración del despliegue. ' +
  'No es tu contraseña y reintentar no lo arregla: avisa a quien administra la instalación.';

/**
 * Cómo termina un intento de ENTRAR cuando no entra.
 *
 * `reintentable` es el dato que faltaba. La pantalla trataba dos desenlaces —entró, o el
 * visitante se equivocó— y hay tres: el tercero es del despliegue, no suyo. Sin distinguirlo,
 * todo fallo acababa en «intenta de nuevo», que sobre un servidor mal configurado es una
 * instrucción que no puede funcionar nunca.
 */
export type FalloDeEntrada = { ok: false; error: string; reintentable: boolean };

/** Un fallo del visitante: credenciales que no valen, cupo gastado, invitación caducada.
 * Volver a intentarlo es exactamente lo que hay que hacer. */
export const falloDeDominio = (error: string): FalloDeEntrada => ({
  ok: false,
  error,
  reintentable: true,
});

/**
 * Traduce un fallo de CONFIGURACIÓN a lo que la pantalla puede enseñar; devuelve `null` si el
 * error no es de esa clase, para que quien llama lo relance.
 *
 * Se decide por el TIPO y no por el texto, y devolver `null` en vez de tragárselo todo es la
 * otra mitad de lo mismo: un fallo que nadie ha clasificado tiene que verse como lo que es.
 * Disfrazarlo del tercer desenlace sería el vicio contrario al que esto corrige.
 */
export function respuestaDeConfiguracion(donde: string, e: unknown): FalloDeEntrada | null {
  if (!(e instanceof ErrorConfiguracion)) return null;
  anotarFalloDeConfiguracion(donde, e);
  return { ok: false, error: ERROR_CONFIGURACION_VISIBLE, reintentable: false };
}

/**
 * Deja el motivo REAL en el registro del servidor, que es donde sirve.
 *
 * `console.error` y no el mensaje de vuelta, por lo dicho arriba. El detalle se imprime
 * entero —incluida la causa— porque el log del servidor ya es un sitio de confianza: es el
 * mismo criterio con el que `serve.ts` decide qué puede escribir y qué no.
 */
export function anotarFalloDeConfiguracion(donde: string, e: unknown): void {
  const detalle = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`[configuración] ${donde}: ${detalle}`);
  if (e instanceof Error && e.cause) console.error('[configuración] causa:', e.cause);
}
