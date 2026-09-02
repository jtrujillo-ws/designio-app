import { z } from 'zod';
import { VeredictoSchema } from '@/lib/metodo/metodo.schemas';

/** CTX-06 Medición e Impacto — Metric Registry, snapshots append-only y outcome review (ADR-0007). */

export const EntradaKPISchema = z.object({
  id: z.string().uuid(),
  criterioId: z.string().uuid(),
  kpi: z.string().min(1),
  definicion: z.string().min(1),
  propietarioDelDato: z.string().min(1).describe('Persona del cliente responsable de aportarlo'),
  fuente: z.string().min(1),
  dimensiones: z.array(z.string()).default([]),
  frecuencia: z.enum(['semanal', 'mensual', 'trimestral', 'única']),
  dashboardExternoUrl: z.string().url().nullable(),
});
export type EntradaKPI = z.infer<typeof EntradaKPISchema>;

export const SnapshotSchema = z.object({
  id: z.string().uuid(),
  entradaKpiId: z.string().uuid(),
  valor: z.number(),
  fecha: z.coerce.date(),
  origen: z.enum(['formulario', 'csv']),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const OutcomeReviewSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
  veredicto: VeredictoSchema,
  /** SYS-24: sin causalidad automática — contribución/asociación salvo flag experimental. */
  disenoExperimentalSuficiente: z.boolean().default(false),
  contribucion: z.string().min(1),
  factoresExternos: z.array(z.string()).default([]),
  aprendizajes: z.array(z.string()).default([]),
  retosCandidatosIds: z.array(z.string().uuid()).default([]),
  completadoEn: z.coerce.date(),
});
export type OutcomeReview = z.infer<typeof OutcomeReviewSchema>;
