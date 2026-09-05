import { z } from 'zod';
import type { Destino } from '@/lib/destinos';
import { tieneBidiOControles } from '@/lib/evidencia/sanitizacion';

/**
 * Segmentos transversales del cliente (RF-01.7, prediseño §4.1): la clasificación ESTABLE
 * de sus usuarios, a nivel de cliente y no de reto. Son el eje por el que se planifica la
 * cobertura de research y se leen las métricas; los arquetipos (por reto) se mapean a uno o
 * más de ellos y la evidencia los cita como una de sus dimensiones. Módulo compartido
 * client/server: solo contratos, tipos y funciones puras.
 */

/**
 * Quiénes definen y editan segmentos: el lead de la boutique, que opera el workspace, y el
 * admin del cliente, que es dueño de su taxonomía. La AUTORIDAD son las políticas
 * `segmento_insert` / `segmento_update` de la base (migración 20260905110000); esta lista es
 * su espejo, compartido entre la pantalla —que solo ofrece el control a estos roles— y el
 * re-check del servicio, que da un mensaje claro antes de que la política rechace en seco.
 * Un diseñador o un sponsor pueden leerlos y referenciarlos, no reescribir la taxonomía con
 * la que el cliente mide.
 */
export const ROLES_EDITAN_SEGMENTOS = ['lead-boutique', 'admin-cliente'] as const;

/** ¿Este rol puede dar de alta o editar segmentos? Lo usan la pantalla y el servicio. */
export function puedeEditarSegmentos(rol: string): boolean {
  return (ROLES_EDITAN_SEGMENTOS as readonly string[]).includes(rol);
}

export const SegmentosInputSchema = z.object({ workspaceId: z.string().uuid() });

// Los mismos límites que un servicio: un nombre es un rótulo, una definición es un párrafo.
// Sin controles bidireccionales ni caracteres de control: con un override BIDI dos
// segmentos distintos se pintan iguales y la unicidad por `lower()` no los distingue, y un
// nombre que se lee distinto de lo guardado es exactamente lo que un eje de medición no
// puede ser. Mismo predicado que rechaza el material importado.
const NombreSchema = z
  .string()
  .trim()
  .min(1, 'El nombre es obligatorio')
  .max(120, 'Máximo 120 caracteres')
  .refine((n) => !tieneBidiOControles(n), {
    message: 'El nombre no puede llevar caracteres de control ni controles bidireccionales',
  });
const DefinicionSchema = z.string().trim().max(2000, 'Máximo 2000 caracteres').default('');

export const CrearSegmentoSchema = z.object({
  workspaceId: z.string().uuid(),
  nombre: NombreSchema,
  definicion: DefinicionSchema,
});
export type CrearSegmento = z.infer<typeof CrearSegmentoSchema>;

export const EditarSegmentoSchema = CrearSegmentoSchema.extend({
  segmentoId: z.string().uuid(),
});
export type EditarSegmento = z.infer<typeof EditarSegmentoSchema>;

export const ESTADOS_ARQUETIPO = ['hipotesis', 'confirmado', 'refutado'] as const;
export type EstadoArquetipo = (typeof ESTADOS_ARQUETIPO)[number];

export const ETIQUETA_ESTADO_ARQUETIPO: Record<EstadoArquetipo, string> = {
  hipotesis: 'hipótesis',
  confirmado: 'confirmado',
  refutado: 'refutado',
};

/** Un arquetipo que se mapea al segmento, con el reto donde nació y su proyecto si lo hay. */
export type ArquetipoDeSegmento = {
  id: string;
  nombre: string;
  estado: EstadoArquetipo;
  retoCodigo: string;
  /** El primer proyecto del reto (por código): a donde se enlaza. Null si el reto no tiene. */
  proyectoId: string | null;
  proyectoCodigo: string | null;
};

/**
 * Un segmento con su cobertura de research en la forma mínima: qué arquetipos lo mapean (y
 * en qué estado está cada uno) y cuántas evidencias lo citan. Es lo que la pantalla lista.
 */
export type SegmentoConCobertura = {
  id: string;
  nombre: string;
  definicion: string;
  /** Fecha de alta (YYYY-MM-DD): la lista va en este orden, y la fecha lo hace visible. */
  creadoEn: string;
  arquetipos: ArquetipoDeSegmento[];
  evidencias: number;
};

/** Cuántos arquetipos hay en cada estado (siempre las tres claves, aunque valgan cero). */
export function conteoPorEstado(
  arquetipos: readonly ArquetipoDeSegmento[],
): Record<EstadoArquetipo, number> {
  const conteo: Record<EstadoArquetipo, number> = { hipotesis: 0, confirmado: 0, refutado: 0 };
  for (const a of arquetipos) conteo[a.estado] += 1;
  return conteo;
}

/** «1 segmento», «2 segmentos»: el número y su sustantivo, concordados. */
export function plural(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * La cobertura del segmento en una frase: «2 arquetipos (1 confirmado, 1 hipótesis) · 3
 * evidencias». Un segmento sin nada lo dice en vez de enseñar ceros: ese es justo el hueco
 * que la pantalla existe para hacer visible.
 */
export function resumenDeCobertura(
  segmento: Pick<SegmentoConCobertura, 'arquetipos' | 'evidencias'>,
): string {
  if (segmento.arquetipos.length === 0 && segmento.evidencias === 0) {
    return 'Sin arquetipos ni evidencia todavía';
  }
  const partes: string[] = [];
  if (segmento.arquetipos.length > 0) {
    const conteo = conteoPorEstado(segmento.arquetipos);
    const detalle = ESTADOS_ARQUETIPO.filter((e) => conteo[e] > 0)
      .map((e) => `${conteo[e]} ${ETIQUETA_ESTADO_ARQUETIPO[e]}`)
      .join(', ');
    partes.push(`${plural(segmento.arquetipos.length, 'arquetipo', 'arquetipos')} (${detalle})`);
  } else {
    partes.push('Sin arquetipos');
  }
  partes.push(
    segmento.evidencias > 0
      ? plural(segmento.evidencias, 'evidencia', 'evidencias')
      : 'Sin evidencia',
  );
  return partes.join(' · ');
}

/** A dónde lleva un arquetipo: al proyecto de su reto. Sin proyecto no hay destino. */
export function destinoDeArquetipo(arquetipo: ArquetipoDeSegmento): Destino | null {
  return arquetipo.proyectoId
    ? { to: '/proyecto/$proyectoId', params: { proyectoId: arquetipo.proyectoId } }
    : null;
}

/**
 * La MISMA regla de unicidad que aplica el servicio (`lower(nombre)` por workspace), para
 * que la pantalla pueda decirlo antes del viaje. `excluirId` es el segmento que se está
 * editando: conservar su propio nombre no es repetirlo.
 */
export function nombreYaUsado(
  nombre: string,
  segmentos: readonly Pick<SegmentoConCobertura, 'id' | 'nombre'>[],
  excluirId?: string,
): boolean {
  const buscado = nombre.trim().toLowerCase();
  return segmentos.some((s) => s.id !== excluirId && s.nombre.trim().toLowerCase() === buscado);
}
