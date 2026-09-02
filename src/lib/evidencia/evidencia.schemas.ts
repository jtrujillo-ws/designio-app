import { z } from 'zod';

/** CTX-02 Evidencia y Conocimiento — cinco dimensiones (ADR-0010) y citas verificables. */

export const DimensionesEvidenciaSchema = z.object({
  proveniencia: z.object({
    tipoFuente: z.string().min(1),
    fecha: z.coerce.date(),
    localizacion: z.string().default(''),
  }),
  metodo: z.object({
    recoleccion: z.string().min(1),
    derivada: z.boolean(),
    segmentoIds: z.array(z.string().uuid()).default([]),
  }),
  calidad: z.object({
    confianza: z.enum(['alta', 'media', 'baja']),
    corroboraIds: z.array(z.string().uuid()).default([]),
    contradiceIds: z.array(z.string().uuid()).default([]),
  }),
  derechos: z.object({
    consentimiento: z.boolean(),
    confidencialidad: z.enum(['interna', 'cliente', 'restringida']),
  }),
  lineage: z
    .object({ modelo: z.string(), promptVersion: z.string() })
    .nullable()
    .describe('Solo cuando una transformación AI la tocó (SYS-19)'),
});
export type DimensionesEvidencia = z.infer<typeof DimensionesEvidenciaSchema>;

export const CitaSchema = z.object({
  evidenciaId: z.string().uuid(),
  fragmento: z.string().min(1),
  localizacion: z.string().min(1).describe('Página/párrafo u offset temporal exacto'),
});
export type Cita = z.infer<typeof CitaSchema>;

export const InsightSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  codigo: z.string().regex(/^I-\d{2,}$/),
  afirmacion: z.string().min(1),
  citas: z.array(CitaSchema).min(1),
  contradicciones: z.array(z.string().uuid()).default([]),
  estado: z.enum(['propuesto', 'validado', 'descartado']),
});
export type Insight = z.infer<typeof InsightSchema>;
