import { z } from 'zod';

/**
 * CTX-02 — Insight: interpretación cuyas afirmaciones se sostienen con citas
 * verificables (RF-03.9, I3). Lo que NO se puede sostener se marca como hipótesis: el
 * método no prohíbe extrapolar, prohíbe disfrazar la extrapolación de hallazgo.
 */

export const ESTADOS_INSIGHT = ['propuesto', 'validado'] as const;
export type EstadoInsight = (typeof ESTADOS_INSIGHT)[number];

export const CrearInsightSchema = z.object({
  workspaceId: z.string().uuid(),
  titulo: z.string().trim().min(1, 'El título es obligatorio').max(300),
  resumen: z.string().trim().max(4000).default(''),
});
export type CrearInsight = z.infer<typeof CrearInsightSchema>;

export const AgregarAfirmacionSchema = z.object({
  workspaceId: z.string().uuid(),
  insightId: z.string().uuid(),
  texto: z.string().trim().min(1, 'La afirmación es obligatoria').max(2000),
  esHipotesis: z.boolean().default(false),
});
export type AgregarAfirmacion = z.infer<typeof AgregarAfirmacionSchema>;

export const AgregarCitaSchema = z.object({
  workspaceId: z.string().uuid(),
  afirmacionId: z.string().uuid(),
  evidenciaId: z.string().uuid(),
  fragmento: z.string().trim().min(1, 'El fragmento citado es obligatorio').max(2000),
  /** Página, párrafo o marca de tiempo. OBLIGATORIA: una cita sin localización lleva al
   * documento, no al punto — y entonces no es una cita, es una referencia. */
  localizacion: z
    .string()
    .trim()
    .min(1, 'La localización es obligatoria: página, párrafo o marca de tiempo')
    .max(200),
});
export type AgregarCita = z.infer<typeof AgregarCitaSchema>;

export const RegistrarContradiccionSchema = z.object({
  workspaceId: z.string().uuid(),
  insightId: z.string().uuid(),
  evidenciaId: z.string().uuid(),
  descripcion: z.string().trim().min(1, 'Explica la contradicción').max(2000),
});
export type RegistrarContradiccion = z.infer<typeof RegistrarContradiccionSchema>;

export const ValidarInsightSchema = z.object({
  workspaceId: z.string().uuid(),
  insightId: z.string().uuid(),
});

/** Un insight concreto: el que se vino a ver con `destacar` y no cabe en la primera página. */
export const InsightInputSchema = z.object({
  workspaceId: z.string().uuid(),
  insightId: z.string().uuid(),
});

export const InsightsInputSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Keyset: el par (creado_en, id) de la última fila mostrada. Sin él, primera página. */
  cursor: z
    .object({ creadoEn: z.string(), id: z.string().uuid() })
    .nullable()
    .default(null),
});

/** Proyecciones de lectura. */
export type CitaDeAfirmacion = {
  id: string;
  evidenciaId: string;
  evidenciaTitulo: string;
  fragmento: string;
  localizacion: string;
  /**
   * Si la evidencia citada SIGUE teniendo derechos vigentes para el ámbito cliente. Una
   * cita nace con ellos —`evidencia_citable_guard` lo exige— pero los derechos se revocan
   * y caducan, y validar es irreversible: desde `20260902310000` el guard de validación
   * comprueba vigencia y no existencia, así que la pantalla tiene que mirar lo mismo o
   * estaría ofreciendo un botón que la base rechaza.
   */
  usable: boolean;
  /** Qué dimensión falta, para nombrarla en vez de decir «bloqueada» (SYS-14). */
  motivoBloqueo: string | null;
};

export type AfirmacionDeInsight = {
  id: string;
  orden: number;
  texto: string;
  esHipotesis: boolean;
  citas: CitaDeAfirmacion[];
};

export type ContradiccionDeInsight = {
  id: string;
  evidenciaId: string;
  evidenciaTitulo: string;
  descripcion: string;
};

export type InsightCompleto = {
  id: string;
  titulo: string;
  resumen: string;
  estado: EstadoInsight;
  validadoEn: string | null;
  afirmaciones: AfirmacionDeInsight[];
  contradicciones: ContradiccionDeInsight[];
};

/**
 * Fila del picker de objetos citables (checklist de un gate, RF-04.5). Un insight validado
 * es inmutable, pero su respaldo NO: los derechos de la evidencia que lo sostiene se
 * revocan y caducan, y entonces el gate deja de poder aprobarse citándolo.
 *
 * `citable` reproduce ese predicado —el mismo que evalúa el guard de suficiencia al
 * aprobar— para que la app y la base no digan cosas distintas sobre la misma regla. El
 * bloqueo REAL sigue viviendo en la base; esto solo lo hace legible antes de elegir, en
 * vez de después de que el gate lo rechace.
 */
export type InsightCitable = {
  id: string;
  titulo: string;
  citable: boolean;
  /** Por qué NO, nombrando la afirmación que se quedó sin respaldo; null cuando sí. */
  motivoBloqueo: string | null;
};
