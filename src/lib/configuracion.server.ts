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
 * Quien la lanza dice QUÉ falta —el nombre de la variable, nunca su valor— y ese mensaje es
 * lo único que se registra. Quien la atiende tampoco lo reenvía al navegador: la pantalla de
 * login es pública. Al visitante se le dice que no es culpa suya y que reintentar no sirve.
 *
 * NO lleva `cause`, y eso es una decisión medida, no una omisión. La causa de un DSN que no
 * parsea es el error del propio parser, y ese error PUEDE llevar dentro la cadena de conexión
 * entera. Medido con varias formas rotas de la misma cadena:
 *
 *   postgres://usuario:CLAVE@${…} / 5432/base   →  «<redacted> cannot be parsed as a URL.»
 *   host=interno user=usuario password=CLAVE    →  «"host=interno user=usuario password=CLAVE"
 *                                                    cannot be parsed as a URL.»
 *
 * La primera la redacta el runtime porque reconoce la forma de una URL con credenciales; la
 * segunda —un DSN de libpq, que es de lo más plausible que alguien pegue en la variable— sale
 * ENTERA. Confiar en esa heurística sería apostar la contraseña de la base a que el valor mal
 * puesto se parezca a una URL. `serve.ts` ya suprime este mismo error por lo mismo; sin este
 * corte, el registro del despliegue habría publicado lo que aquel se calla.
 *
 * El precio es no saber por qué no parseaba. Es barato: el mensaje ya dice qué variable es y
 * qué forma se espera, que es lo que necesita quien va a arreglarla.
 */
export class ErrorConfiguracion extends Error {
  constructor(mensaje: string) {
    super(mensaje);
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
 * Deja el motivo en el registro del servidor, que es donde sirve — y SOLO el motivo.
 *
 * Se imprime el mensaje del `ErrorConfiguracion` y nada más: ni su `cause` (no lo lleva, por
 * lo dicho arriba) ni la traza, que arrastraría el mismo valor. Un error de otra clase se
 * anota por su nombre, sin mensaje: no hay forma de saber si el suyo lleva un secreto dentro,
 * y un registro de despliegue es persistente.
 */
export function anotarFalloDeConfiguracion(donde: string, e: unknown): void {
  const detalle =
    e instanceof ErrorConfiguracion
      ? e.message
      : `error de clase ${e instanceof Error ? e.name : typeof e} (mensaje no registrado: podría llevar el valor mal puesto)`;
  console.error(`[configuración] ${donde}: ${detalle}`);
}
