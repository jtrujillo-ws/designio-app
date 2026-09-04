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

/**
 * Política de modelos centralizada en CÓDIGO, no en env vars (diseño técnico): primario y
 * fallback por superficie; la degradación de modelo ocurre una sola vez por operación.
 *
 * El par es el que fija el diseño técnico, en sus dos secciones. Este slice había puesto otro
 * —uno más capaz de primario, y de fallback el que el documento nombra de primario— sin
 * decirlo en ninguna parte, y un par documentado que nadie usa es peor que cualquiera de los
 * dos: el siguiente que lea el diseño para calcular costes se equivoca, y el fallback
 * declarado no se ejercita jamás.
 *
 * Se alinea el CÓDIGO al documento, y no al revés, por lo que dice el propio documento sobre
 * la asignación por capacidad: «codificación/extracción pueden usar el modelo más rápido
 * disponible; síntesis (insights, revisores, post mortem) el más capaz». Las dos capacidades
 * que este slice implementa —CI (extracción) y C0 (encuadre)— son de la primera familia, así
 * que el primario les toca por regla escrita, no por criterio de nadie.
 *
 * El fallback es para `model-unavailable`, no para ahorrar: se degrada a otro modelo cuando
 * el primero no está, y que cueste algo más por token es normal — lo que se compra es
 * disponibilidad.
 */
export const MODELO_PRIMARIO = 'claude-sonnet-5';
export const MODELO_FALLBACK = 'claude-sonnet-4-6';

/**
 * RESPALDO del presupuesto AI diario, no el presupuesto de nadie (RF-08.5, diseño técnico ·
 * «cuota diaria de llamadas AI»): corte SUAVE — al agotarse se pausan las capacidades AI,
 * jamás un flujo de negocio.
 *
 * El cupo que manda es el del WORKSPACE (`workspace.limite_llamadas_ai_dia`), y esta
 * constante rige solo donde no hay uno pactado o el que hay no es un entero positivo. La
 * distinción no es cosmética: mientras las dos llamadas vivas le pasaban esta constante a
 * `evaluarCapacidadAI`, el parámetro `limiteDiario` existía sin que nada lo alimentara y
 * «presupuesto por workspace» era una afirmación que el código no ataba. Un respaldo que se
 * usa siempre es un valor por defecto silencioso, que es justo lo que no puede ser.
 *
 * La unidad es la LLAMADA ATENDIDA por el proveedor, no la propuesta persistida, porque el
 * tope acota lo que se PAGA y no lo que se produce. Contando propuestas, una negativa del
 * proveedor o una salida fuera de contrato —dos llamadas facturadas de las que no nace
 * nada— dejaban el contador intacto: con un material que el modelo rechaza siempre, se
 * podía reintentar sin fin gastando sin tope. Y es la misma magnitud que suma el reporte de
 * costos sobre `llamada_ai`: el número que frena y el número que informa son uno.
 */
export const LIMITE_LLAMADAS_DIA = 60;

/**
 * Cuántas llamadas al proveedor puede llegar a costar UNA generación: el intento primario y,
 * si el modelo no está, el de respaldo. Vive aquí y no en el servicio porque es política —la
 * misma familia que el par de modelos y el tope diario— y porque el cupo mínimo que tiene
 * sentido pactar se deriva de ella: un workspace con menos huecos que esto nunca podría
 * generar nada, y su CHECK en la base lo impide.
 */
export const INTENTOS_POR_GENERACION = 2;

/**
 * Tarifa del proveedor en USD por millón de tokens, por modelo de la política. Vive en
 * código junto a la política de modelos y no en la base: el coste se calcula con el
 * precio VIGENTE al generar y se persiste con la propuesta, así que una tarifa nueva no
 * reescribe el histórico. Un modelo sin tarifa conocida no inventa un coste: devuelve
 * null y el panel dice «sin tarifa registrada» en vez de un número falso.
 */
export const TARIFA_USD_POR_MTOK: Record<string, { entrada: number; salida: number }> = {
  // Tarifas de primera parte vigentes para ESTOS dos modelos. Se mueven con el par: si
  // alguna vez cambia la política, estas dos filas cambian con ella o el reporte de costos
  // empieza a mentir en silencio (un modelo sin tarifa devuelve null, que al menos se ve).
  [MODELO_PRIMARIO]: { entrada: 2, salida: 10 },
  [MODELO_FALLBACK]: { entrada: 3, salida: 15 },
};

/**
 * Cómo terminó UN intento contra el proveedor. Es el vocabulario que comparten el
 * adaptador, el servicio y el CHECK de `llamada_ai`: una sola lista, o el libro de costos
 * acabaría con valores que nadie sabe leer.
 *
 * `salida-valida` es «contenido que pasó el esquema de la capacidad»; los otros tres son
 * intentos de los que no puede nacer nada, y se distinguen porque son gastos y problemas
 * distintos: una negativa se revisa, un formato roto se investiga, un timeout se reintenta.
 *
 * Son los DESENLACES, y desde el libro anticipado el CHECK de `llamada_ai` admite uno más:
 * `despachada`, el estado con el que la línea nace antes de salir. Deliberadamente NO está en
 * esta lista, porque no es algo que un intento pueda devolver —el adaptador nunca lo produce—
 * y meterlo aquí obligaría a todo consumidor de `ResultadoIntento` a tratar un caso imposible.
 * Lo que sí hay que saber al leer `llamada_ai.resultado` es que su dominio es esta lista MÁS
 * `despachada`, y eso lo dice `ESTADOS_LLAMADA`.
 */
export const RESULTADOS_INTENTO = [
  'salida-valida',
  'rechazo-proveedor',
  'fuera-de-contrato',
  'sin-respuesta',
] as const;
export type ResultadoIntento = (typeof RESULTADOS_INTENTO)[number];

/**
 * El dominio COMPLETO de `llamada_ai.resultado`: los cuatro desenlaces más `despachada`, que
 * es el estado en el que una línea espera su cierre. Es lo que hay que recorrer para pintar o
 * clasificar filas leídas de la tabla; `RESULTADOS_INTENTO` es lo que puede devolver un
 * intento, que es un conjunto más pequeño. Separarlos evita las dos mitades del error:
 * olvidar las líneas en vuelo al leer, y tener que tratar un caso imposible al escribir.
 */
export const ESTADOS_LLAMADA = ['despachada', ...RESULTADOS_INTENTO] as const;
export type EstadoLlamada = (typeof ESTADOS_LLAMADA)[number];

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

/** Cuántos decimales tiene de verdad un coste: los que persiste `llamada_ai.costo_usd`
 * (`numeric(12,6)`) y a los que redondea `costoDeUso`. Vive aquí, pegado a quien calcula,
 * para que la pantalla no pueda enseñar menos precisión de la que hay sin que se vea. */
const DECIMALES_COSTE = 6;

/** El coste de una llamada, escrito con la precisión que tiene. La pantalla lo mostraba con
 * `toFixed(4)`, que convierte un coste real de `$0.00004` en `$0.0000`: decía «gratis» sobre
 * algo que se paga, y mentía en la dirección que ESCONDE el problema — mil llamadas
 * invisibles son los céntimos que un presupuesto por workspace (RF-09.12) existe justo para
 * ver venir, y el mismo número que el reporte de costes suma.
 *
 * Sin ceros de relleno más allá de los dos habituales, para que un coste normal se lea de un
 * vistazo. Y la regla que no se negocia: un valor distinto de cero JAMÁS se presenta como
 * cero — si cayera por debajo de lo representable, se dice con esas palabras. */
export function formatearCosteUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  const recortado = usd.toFixed(DECIMALES_COSTE).replace(/0+$/, '').replace(/\.$/, '');
  if (Number(recortado) === 0) return `< $${(10 ** -DECIMALES_COSTE).toFixed(DECIMALES_COSTE)}`;
  const decimales = recortado.split('.')[1]?.length ?? 0;
  return `$${decimales >= 2 ? recortado : Number(recortado).toFixed(2)}`;
}

/** El proveedor no puede colgar una pantalla: pasado este techo la llamada se aborta y
 * la capacidad se reporta como no disponible en esta operación. */
export const TIMEOUT_PROVEEDOR_MS = 25_000;

/**
 * Cuánto vale lo último que se supo del proveedor (RF-09.11). Pasada esta ventana, una
 * caída observada deja de decir nada del presente: nadie puede saber que un tercero SIGUE
 * caído sin volver a llamarlo, así que la señal CADUCA por tiempo y no porque alguien se
 * acuerde de limpiarla.
 *
 * Y de ahí sale la decisión que más importa de este arreglo: la señal NO se cachea en el
 * proceso. Un estado de salud en memoria es estado compartido entre peticiones —hay varios
 * workspaces en el mismo proceso y varios procesos sirviendo el mismo workspace—, así que
 * habría que decidir su ventana, su aislamiento por inquilino y su purga, y un interruptor
 * pegado en «caído» apagaría la capacidad de todos sin que nadie lo hubiera decidido: peor
 * que el defecto que arregla. Aquí se DERIVA de `llamada_ai`, que es un hecho que produce la
 * propia base, lleva `workspace_id` y lleva su reloj — el aislamiento y la caducidad no hay
 * que construirlos, ya están.
 */
export const VENTANA_SALUD_PROVEEDOR_MS = 5 * 60_000;

export type EstadoCapacidadAI = {
  /**
   * Hay CREDENCIAL y hay PRESUPUESTO, que es todo lo que este proceso puede establecer por
   * sí mismo. No dice que el proveedor esté vivo: lo único que lo demuestra es llamarlo, y
   * prometerlo aquí sería una afirmación que nada ata. La salud observada viaja aparte, en
   * `proveedorResponde`, justamente para no meter en un mismo booleano un hecho local y una
   * conjetura sobre un tercero.
   */
  disponible: boolean;
  /** Vacío si está disponible; si no, el porqué en lenguaje de la UI (nunca un stack). */
  motivo: string;
  origenKey: OrigenKey | null;
  modelo: string;
  /** Llamadas al proveedor ATENDIDAS hoy por este workspace: lo que se ha pagado, que es
   * lo que el tope acota. */
  llamadasHoy: number;
  limiteDiario: number;
  /**
   * Lo último que se supo del proveedor dentro de `VENTANA_SALUD_PROVEEDOR_MS`: `false`
   * cuando el intento más reciente de este workspace se quedó SIN RESPUESTA (timeout o
   * 5xx). No apaga la capacidad a propósito —ver `advertencia`—.
   */
  proveedorResponde: boolean;
  /** Vacío si el proveedor responde; si no, qué se observó y qué puede hacerse ahora. */
  advertencia: string;
};

const COLA_MANUAL = 'Todo el flujo sigue disponible a mano.';

/** «hace 40 s» / «hace 3 min»: una antigüedad que se lee, no un número de ms en pantalla. */
function minutosLegibles(ms: number): string {
  const seg = Math.round(ms / 1000);
  return seg < 60 ? `${seg} s` : `${Math.round(seg / 60)} min`;
}

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
  /** Llamadas ATENDIDAS hoy: gasto consumado. Es también el número que se muestra. */
  llamadasHoy?: number;
  /**
   * Huecos apartados por generaciones EN CURSO. Viajan aparte del gasto y no sumados por el
   * llamante, porque son dos números con dos propósitos: los dos deciden, pero solo el gasto
   * se enseña. Sumarlos antes de entrar hacía que el motivo citara el total —«61/60», un
   * cociente por encima del 100%— justo encima de la tarjeta que mostraba «59/60».
   */
  reservadas?: number;
  limiteDiario?: number;
  /** Cuántas llamadas puede llegar a hacer la generación que se está admitiendo (primario
   * y, si cae, respaldo). El panel no pasa ninguna: pregunta por el estado, no pide hueco.
   * Sin esto, «queda 1 y la generación puede gastar 2» pasaba el chequeo. */
  unidades?: number;
  /**
   * Hace cuántos ms se observó la última caída del proveedor en este workspace, y solo si
   * ese fue además el intento MÁS RECIENTE. `null` cuando el último intento sí obtuvo
   * respuesta —una llamada buena posterior borra la caída al instante, sin purga— o cuando
   * no hay intentos que mirar.
   */
  ultimaCaidaHaceMs?: number | null;
}): EstadoCapacidadAI {
  const limite =
    Number.isInteger(entrada.limiteDiario) && (entrada.limiteDiario as number) > 0
      ? (entrada.limiteDiario as number)
      : LIMITE_LLAMADAS_DIA;
  const atendidas = Number.isFinite(entrada.llamadasHoy) ? Math.max(0, entrada.llamadasHoy!) : 0;
  const reservadas = Number.isFinite(entrada.reservadas) ? Math.max(0, entrada.reservadas!) : 0;
  // Lo comprometido: lo que ya se pagó más lo que otros tienen apartado. Decide, pero no se
  // muestra —el número de la tarjeta sigue siendo el gasto—.
  const comprometidas = atendidas + reservadas;
  /** «59» o «59 atendidas y 2 en curso»: el motivo nunca enseña un total que contradiga la
   * tarjeta, y cuando hay reservas dice de dónde sale la diferencia en vez de esconderla. */
  const desglose = reservadas > 0 ? `${atendidas} atendidas y ${reservadas} en curso` : `${atendidas}`;
  const piden =
    Number.isInteger(entrada.unidades) && (entrada.unidades as number) > 0
      ? (entrada.unidades as number)
      : 1;

  const delWorkspace = (entrada.keyWorkspace ?? '').trim();
  const delEntorno = (entrada.keyEntorno ?? '').trim();
  const origenKey: OrigenKey | null = delWorkspace ? 'workspace' : delEntorno ? 'entorno' : null;

  // La caída solo cuenta si es RECIENTE y si el dato es utilizable: un número negativo,
  // NaN o infinito no describe ninguna observación, y ante la duda se dice que el proveedor
  // responde. La dirección conservadora aquí es la contraria a la del presupuesto —un falso
  // «responde» cuesta un reintento fallido, un falso «caído» apaga la capacidad sin que
  // nadie lo haya decidido—, y ése es justo el interruptor pegado que no puede existir.
  const caidaMs = entrada.ultimaCaidaHaceMs;
  const proveedorResponde = !(
    typeof caidaMs === 'number' &&
    Number.isFinite(caidaMs) &&
    caidaMs >= 0 &&
    caidaMs <= VENTANA_SALUD_PROVEEDOR_MS
  );
  const advertencia = proveedorResponde
    ? ''
    : `El proveedor AI no respondió al último intento (hace ${minutosLegibles(caidaMs as number)}). ` +
      `Puedes reintentar —quizá ya se haya recuperado— o seguir a mano: ${COLA_MANUAL}`;

  const base = {
    modelo: MODELO_PRIMARIO,
    llamadasHoy: atendidas,
    limiteDiario: limite,
    proveedorResponde,
    advertencia,
  };

  if (!origenKey) {
    return {
      ...base,
      disponible: false,
      origenKey: null,
      motivo: `Capacidad AI apagada: este despliegue no tiene credencial del proveedor configurada. ${COLA_MANUAL}`,
    };
  }
  if (comprometidas >= limite) {
    return {
      ...base,
      disponible: false,
      origenKey,
      motivo: `Presupuesto AI del workspace agotado por hoy (${desglose}, de ${limite} llamadas al proveedor). Las capacidades AI quedan en pausa hasta mañana. ${COLA_MANUAL}`,
    };
  }
  if (comprometidas + piden > limite) {
    return {
      ...base,
      disponible: false,
      origenKey,
      motivo: `El presupuesto AI de hoy no alcanza para esta generación: quedan ${limite - comprometidas} llamadas de ${limite} y esta puede gastar hasta ${piden}. ${COLA_MANUAL}`,
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
