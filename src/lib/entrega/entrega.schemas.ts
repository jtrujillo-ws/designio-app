import { z } from 'zod';

/** CTX-05 Entrega y Estado Efectivo — releases parciales y desviaciones con razón (ADR-0004). */

export const EstadoReleaseSchema = z.enum(['planificado', 'desplegado', 'verificado']);
export type EstadoRelease = z.infer<typeof EstadoReleaseSchema>;

export const ReleaseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  codigo: z.string().regex(/^RL-\d+$/),
  designVersionId: z.string().uuid(),
  /** Parcialidad explícita (SYS-06): qué elementos de la DV incluye este release. */
  elementosIncluidosIds: z.array(z.string().uuid()).min(1),
  estado: EstadoReleaseSchema,
  desplegadoEn: z.coerce.date().nullable(),
});
export type Release = z.infer<typeof ReleaseSchema>;

export const DesviacionSchema = z.object({
  elementoId: z.string().uuid(),
  queQuedoDistinto: z.string().min(1),
  /** SYS-07: toda desviación registra razón no vacía. */
  razon: z.string().min(1),
});
export type Desviacion = z.infer<typeof DesviacionSchema>;

export const EffectiveStateSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  codigo: z.string().regex(/^ES-\d+$/),
  releaseId: z.string().uuid(),
  constatadoEn: z.coerce.date(),
  desviaciones: z.array(DesviacionSchema).default([]),
});
export type EffectiveState = z.infer<typeof EffectiveStateSchema>;
