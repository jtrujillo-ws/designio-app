import '@/lib/server-only';
import Anthropic from '@anthropic-ai/sdk';
import {
  MODELO_FALLBACK,
  MODELO_PRIMARIO,
  MOTIVO_ESQUEMA,
  motivoDeFalloProveedor,
  TIMEOUT_PROVEEDOR_MS,
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

export type ResultadoProveedor =
  | { ok: true; datos: unknown; modelo: string; latenciaMs: number }
  | { ok: false; motivo: string };

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
  return { keyWorkspace: null, keyEntorno: process.env.ANTHROPIC_API_KEY ?? null };
}

/** ¿Conviene reintentar con el modelo de respaldo? Solo cuando el fallo es del modelo o
 * de la capacidad del proveedor, nunca cuando es de la petición o de la credencial. */
function degradaModelo(e: unknown): boolean {
  const status = (e as { status?: unknown }).status;
  return typeof status === 'number' && (status === 404 || status >= 500);
}

async function unaLlamada(
  key: string,
  modelo: string,
  capacidad: CapacidadActiva,
  sistema: string,
  usuario: string,
): Promise<unknown> {
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
  // Una negativa del proveedor es una respuesta válida a nivel HTTP: se trata como
  // «sin propuesta», jamás como un objeto vacío que alguien pudiera aceptar.
  if (respuesta.stop_reason === 'refusal') {
    throw Object.assign(new Error('refusal'), { status: 422 });
  }
  const texto = respuesta.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  return JSON.parse(texto);
}

export async function generarConProveedor(entrada: {
  key: string;
  capacidad: CapacidadActiva;
  sistema: string;
  usuario: string;
}): Promise<ResultadoProveedor> {
  const inicio = Date.now();
  for (const [indice, modelo] of [MODELO_PRIMARIO, MODELO_FALLBACK].entries()) {
    try {
      const datos = await unaLlamada(
        entrada.key,
        modelo,
        entrada.capacidad,
        entrada.sistema,
        entrada.usuario,
      );
      return { ok: true, datos, modelo, latenciaMs: Date.now() - inicio };
    } catch (e) {
      // JSON ilegible: el modelo respondió pero fuera de contrato. No se reintenta con
      // otro modelo (no es indisponibilidad) y la propuesta se descarta entera.
      if (e instanceof SyntaxError) return { ok: false, motivo: MOTIVO_ESQUEMA };
      if (indice === 0 && degradaModelo(e)) continue;
      return { ok: false, motivo: motivoDeFalloProveedor(e) };
    }
  }
  // Inalcanzable (el bucle siempre retorna), pero el contrato se mantiene sin excepción.
  return { ok: false, motivo: motivoDeFalloProveedor(null) };
}
