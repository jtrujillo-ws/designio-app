import { z } from 'zod';

/** CTX-03 Método y Gobernanza — estados y objetos canónicos (I1: no se renombran). */

export const EstadoRetoSchema = z.enum(['candidato', 'activo', 'en medición', 'cerrado', 'archivado']);
export type EstadoReto = z.infer<typeof EstadoRetoSchema>;

export const VeredictoSchema = z.enum(['logrado', 'parcialmente logrado', 'no logrado', 'no concluyente']);
export type Veredicto = z.infer<typeof VeredictoSchema>;

export const EstadoProyectoSchema = z.enum(['activo', 'en implementación', 'en medición', 'cerrado']);
export type EstadoProyecto = z.infer<typeof EstadoProyectoSchema>;

export const PerfilProyectoSchema = z.enum(['rápido', 'estándar', 'profundo']);
export type PerfilProyecto = z.infer<typeof PerfilProyectoSchema>;

export const GateSchema = z.enum(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
export type Gate = z.infer<typeof GateSchema>;

export const CriterioDeExitoSchema = z.object({
  id: z.string().uuid(),
  kpi: z.string().min(1),
  definicion: z.string().min(1),
  lineaBase: z.object({ valor: z.number(), fecha: z.coerce.date() }).nullable(),
  objetivo: z.number(),
  /** Ventana de medición propia por criterio (SYS-22): días desde el primer release. */
  ventanaDias: z.number().int().positive(),
  fechaPostMortemPrevista: z.coerce.date().nullable(),
});
export type CriterioDeExito = z.infer<typeof CriterioDeExitoSchema>;

export const RetoSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  codigo: z.string().regex(/^R-\d{2,}$/),
  titulo: z.string().min(1),
  estado: EstadoRetoSchema,
  veredicto: VeredictoSchema.nullable(),
  servicioAnclaId: z.string().uuid(),
  serviciosAfectadosIds: z.array(z.string().uuid()),
  criterios: z.array(CriterioDeExitoSchema),
});
export type Reto = z.infer<typeof RetoSchema>;
