import '@/lib/server-only';
import Anthropic from '@anthropic-ai/sdk';
import {
  costoDeUso,
  MODELO_FALLBACK,
  MODELO_PRIMARIO,
  MOTIVO_ESQUEMA,
  MOTIVO_RECHAZO,
  motivoDeFalloProveedor,
  TIMEOUT_PROVEEDOR_MS,
  type ResultadoIntento,
  type UsoTokens,
} from './ai.degradacion';
import { ESQUEMA_SALIDA } from './ai.prompts';
import type { CapacidadActiva } from './ai.schemas';

/**
 * Adaptador del proveedor AI (SDK de Anthropic). Su contrato es el que sostiene toda la
 * degradación segura (SYS-21): **esta función no lanza nunca**. Devuelve la salida
 * estructurada o un motivo legible; quien la llama decide qué hacer, y nada del resto de
 * la aplicación depende de que el proveedor esté vivo.
 *
 * Tres decisiones que acotan el daño de un proveedor lento o caído:
 *  · timeout duro por llamada (una pantalla no se cuelga esperando a un tercero);
 *  · `maxRetries: 0` — el SDK no reintenta por su cuenta, porque el peor caso sería
 *    timeout × (reintentos+1) y aquí hay un humano esperando;
 *  · una sola degradación de modelo por operación (primario → fallback), como fija la
 *    política de modelos del diseño técnico.
 */

/** Lo que costó la llamada, medido y no estimado: el `usage` de la respuesta más el
 * coste derivado con la tarifa del modelo que respondió. Es el ÚNICO momento en que este
 * dato existe —descartarlo aquí dejaba el `costoUsd` del lineage imposible de poblar
 * para siempre (RF-09.14)—, así que sube con el resultado hasta la propuesta. */
export type UsoLlamada = UsoTokens & { costoUsd: number | null };

/** Por qué no hay contenido utilizable. Distingue las llamadas que el proveedor SÍ atendió
 * —y por tanto cobró— de las que ni siquiera llegaron a respuesta: son gastos distintos y
 * problemas distintos (una negativa se revisa, un timeout se reintenta). */
export type MotivoSinSalida = Exclude<ResultadoIntento, 'salida-valida'>;

/**
 * UN intento contra el proveedor: un modelo, una petición, un desenlace. Una operación de
 * generación puede tener dos (primario y, si el primero cae por indisponibilidad, respaldo),
 * y **cada uno es una llamada real** con su propia latencia y su propio uso.
 */
export type IntentoProveedor = {
  modelo: string;
  resultado: ResultadoIntento;
  /** Vacío solo cuando el intento dio salida válida. */
  motivo: string;
  /** De ESE intento, no acumulada: si la latencia del respaldo incluyera la espera del
   * primario, la latencia por modelo mediría otra cosa. */
  latenciaMs: number;
  uso: UsoLlamada | null;
};

/**
 * Resultado de una operación de generación. `intentos` los lleva SIEMPRE y en orden: una
 * degradación de modelo son dos llamadas al proveedor, las dos ocurrieron y las dos tienen
 * que poder anotarse. Quedarse solo con la última borraba del libro el fallo del primario y
 * dejaba una sola fila cuya latencia sumaba los dos intentos — la tasa de error y la
 * latencia por modelo (RF-09.14) medían algo que no pasó.
 *
 * Cuando `ok`, el último intento es el que dio la salida válida (y su `modelo` es el que
 * firma el lineage de las propuestas).
 */
export type ResultadoProveedor =
  | { ok: true; datos: unknown; intentos: IntentoProveedor[] }
  | { ok: false; motivo: string; intentos: IntentoProveedor[] };

/** Techo de salida: los contenidos de este slice son fichas pequeñas y estructuradas;
 * un techo alto solo compraría latencia y coste. */
const MAX_TOKENS = 8000;

/**
 * BYOAI (RF-09.9): la credencial del workspace gana a la del entorno y el lineage
 * registra cuál sirvió. Hoy solo se resuelve la del entorno — guardar la API key de un
 * cliente en una columna legible bajo RLS contradiría RF-09.6 (secretos en un secret
 * manager), así que el almacenamiento por workspace espera a esa integración y no se
 * finge una lectura que no existe. Cuando llegue, esta función pasa a recibir el
 * workspace y resolver su key aquí: ni el esquema (`origen_key` ya distingue ambos
 * orígenes) ni la precedencia (evaluarCapacidadAI) ni la UI cambian.
 */
export function credencialesAI(): {
  keyWorkspace: string | null;
  keyEntorno: string | null;
} {
  // El trim va AQUÍ y no en cada uso: si evaluarCapacidadAI recortara y el llamador no,
  // una key con un salto de línea al final se reportaría disponible y el proveedor la
  // rechazaría con 401. Una sola lectura, una sola forma.
  const entorno = process.env.ANTHROPIC_API_KEY?.trim();
  return { keyWorkspace: null, keyEntorno: entorno ? entorno : null };
}

/** ¿Conviene reintentar con el modelo de respaldo? Solo cuando el fallo es del modelo o
 * de la capacidad del proveedor, nunca cuando es de la petición o de la credencial. */
function degradaModelo(e: unknown): boolean {
  const status = (e as { status?: unknown }).status;
  return typeof status === 'number' && (status === 404 || status >= 500);
}

/** Un contador de tokens del proveedor, saneado: lo que se persiste como uso tiene que
 * ser un entero no negativo o nada — un campo ausente o raro no se cuela como 0 real. */
function contador(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0
    ? Math.round(valor)
    : null;
}

function usoDeRespuesta(modelo: string, usage: unknown): UsoLlamada | null {
  const u = (usage ?? {}) as Record<string, unknown>;
  const entrada = contador(u.input_tokens);
  const salida = contador(u.output_tokens);
  if (entrada === null || salida === null) return null;
  const uso: UsoTokens = {
    entrada,
    salida,
    cacheEscritura: contador(u.cache_creation_input_tokens) ?? 0,
    cacheLectura: contador(u.cache_read_input_tokens) ?? 0,
  };
  return { ...uso, costoUsd: costoDeUso(modelo, uso) };
}

async function unaLlamada(
  key: string,
  modelo: string,
  capacidad: CapacidadActiva,
  sistema: string,
  usuario: string,
): Promise<{ datos: unknown; uso: UsoLlamada | null }> {
  const cliente = new Anthropic({
    apiKey: key,
    timeout: TIMEOUT_PROVEEDOR_MS,
    maxRetries: 0,
  });
  const respuesta = await cliente.messages.create({
    model: modelo,
    max_tokens: MAX_TOKENS,
    system: sistema,
    messages: [{ role: 'user', content: usuario }],
    // Salida estructurada validada dos veces: por el proveedor contra este JSON Schema y
    // por Zod al persistir. El esquema es un artefacto versionado (ai.prompts.ts).
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: ESQUEMA_SALIDA[capacidad] },
    },
  });
  // El uso se lee lo PRIMERO, antes de cualquier rama que pueda salir por excepción: la
  // llamada ya está hecha y facturada aunque el contenido no sirva, y este es el único
  // instante en que el dato existe. Leerlo después de decidir si hay propuesta era
  // perderlo exactamente en los casos que hay que auditar.
  const uso = usoDeRespuesta(modelo, respuesta.usage);
  // Una negativa del proveedor es una respuesta válida a nivel HTTP: se trata como
  // «sin propuesta», jamás como un objeto vacío que alguien pudiera aceptar. Viaja con su
  // uso a cuestas para que el libro de llamadas la anote igual.
  if (respuesta.stop_reason === 'refusal') {
    throw Object.assign(new Error('refusal'), { status: 422, uso, causa: 'rechazo-proveedor' });
  }
  const texto = respuesta.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  try {
    // El uso viaja CON los datos: quedarse solo con el texto era tirar el único dato de
    // coste que el proveedor da, y ningún cálculo posterior podía reconstruirlo.
    return { datos: JSON.parse(texto), uso };
  } catch (e) {
    // Un JSON ilegible también se pagó: el error se re-lanza con el uso pegado en vez de
    // dejar que la excepción se lleve por delante la única medida del gasto.
    throw Object.assign(e as SyntaxError, { uso });
  }
}

/** Rescata el uso que una excepción trae pegado (negativa del proveedor, JSON ilegible).
 * Un fallo sin respuesta —timeout, 5xx, red— no trae ninguno: ahí el gasto es desconocido
 * y se anota como tal, que no es lo mismo que cero. */
function usoDelError(e: unknown): UsoLlamada | null {
  const uso = (e as { uso?: unknown }).uso;
  return uso && typeof uso === 'object' ? (uso as UsoLlamada) : null;
}

function causaDelError(e: unknown): MotivoSinSalida {
  if (e instanceof SyntaxError) return 'fuera-de-contrato';
  const causa = (e as { causa?: unknown }).causa;
  return causa === 'rechazo-proveedor' ? 'rechazo-proveedor' : 'sin-respuesta';
}

export async function generarConProveedor(entrada: {
  key: string;
  capacidad: CapacidadActiva;
  sistema: string;
  usuario: string;
}): Promise<ResultadoProveedor> {
  // Cada intento se anota antes de decidir si hay otro: una degradación de modelo son DOS
  // llamadas al proveedor, y la del primario existió aunque no sirviera. Devolver solo la
  // última la borraba del libro y dejaba una latencia que sumaba las dos.
  const intentos: IntentoProveedor[] = [];
  for (const [indice, modelo] of [MODELO_PRIMARIO, MODELO_FALLBACK].entries()) {
    const inicio = Date.now();
    try {
      const { datos, uso } = await unaLlamada(
        entrada.key,
        modelo,
        entrada.capacidad,
        entrada.sistema,
        entrada.usuario,
      );
      intentos.push({
        modelo,
        resultado: 'salida-valida',
        motivo: '',
        latenciaMs: Date.now() - inicio,
        uso,
      });
      return { ok: true, datos, intentos };
    } catch (e) {
      const causa = causaDelError(e);
      // Una negativa se cuenta como lo que es. `motivoDeFalloProveedor` la traduciría por
      // su status HTTP («rechazó la petición (422)»), que suena a error nuestro y a algo
      // que se arregla reintentando.
      const motivo =
        causa === 'fuera-de-contrato'
          ? MOTIVO_ESQUEMA
          : causa === 'rechazo-proveedor'
            ? MOTIVO_RECHAZO
            : motivoDeFalloProveedor(e);
      intentos.push({
        modelo,
        resultado: causa,
        motivo,
        latenciaMs: Date.now() - inicio,
        uso: usoDelError(e),
      });
      // JSON ilegible: el modelo respondió pero fuera de contrato. No se reintenta con otro
      // modelo (no es indisponibilidad) y la propuesta se descarta entera.
      if (causa === 'fuera-de-contrato') return { ok: false, motivo, intentos };
      if (indice === 0 && degradaModelo(e)) continue;
      return { ok: false, motivo, intentos };
    }
  }
  // Inalcanzable (el bucle siempre retorna), pero el contrato se mantiene sin excepción:
  // los intentos ya anotados viajan igual.
  return { ok: false, motivo: motivoDeFalloProveedor(null), intentos };
}
