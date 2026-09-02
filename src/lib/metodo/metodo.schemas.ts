import { z } from 'zod';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';
import { PERFILES } from './metodo.plantillas';

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

// ── Contratos ejecutables del slice 1 de SPEC-04 (entradas de server functions y ──
// ── proyecciones de la pantalla del proyecto; los estados en base viajan como slugs) ──

export const CrearRetoSchema = z.object({
  workspaceId: z.string().uuid(),
  servicioAnclaId: z.string().uuid(),
  codigo: z
    .string()
    .trim()
    .regex(/^R-\d{2,}$/, 'Código con forma R-NN'),
  titulo: z.string().trim().min(1, 'El título es obligatorio').max(300),
  descripcion: z.string().trim().max(5000).default(''),
  origen: z.enum(['post-mortem', 'hallazgo-medicion', 'peticion-cliente']),
  metricaObjetivo: z.string().trim().max(200).default(''),
  serviciosAfectados: z.array(z.string().uuid()).max(20).default([]),
});
export type CrearReto = z.infer<typeof CrearRetoSchema>;

export const CriterioSchema = z.object({
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
  kpi: z.string().trim().min(1, 'El KPI es obligatorio').max(200),
  definicion: z.string().trim().max(2000).default(''),
  lineaBaseValor: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .default(null)
    // '' cuenta como AUSENTE: G0 exige línea base REGISTRADA o plan (SYS-22) y un
    // string vacío no es ninguna de las dos.
    .transform((v) => (v === '' ? null : v)),
  lineaBaseFecha: FechaCalendarioSchema.nullable().default(null),
  lineaBasePlan: z.string().trim().max(1000).default(''),
  objetivo: z.string().trim().max(200).default(''),
  ventanaDias: z.number().int().positive().max(3650).nullable().default(null),
  fechaPostMortem: FechaCalendarioSchema.nullable().default(null),
});
export type CriterioEntrada = z.infer<typeof CriterioSchema>;

export const ActivarRetoSchema = z.object({
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
  perfil: z.enum(PERFILES),
  proyectoCodigo: z
    .string()
    .trim()
    .regex(/^P-\d{2,}$/, 'Código con forma P-NN'),
  proyectoTitulo: z.string().trim().min(1, 'El título es obligatorio').max(300),
});
export type ActivarReto = z.infer<typeof ActivarRetoSchema>;

export const ProyectoInputSchema = z.object({
  workspaceId: z.string().uuid(),
  proyectoId: z.string().uuid(),
});

export const MarcarItemSchema = z.object({
  workspaceId: z.string().uuid(),
  itemId: z.string().uuid(),
  accion: z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('cumplido'), evidenciaId: z.string().uuid() }),
    z.object({ tipo: z.literal('pendiente') }),
    z.object({ tipo: z.literal('na'), justificacion: z.string().trim().min(1).max(2000) }),
  ]),
});
export type MarcarItem = z.infer<typeof MarcarItemSchema>;

export const AprobarGateSchema = z.object({
  workspaceId: z.string().uuid(),
  gateId: z.string().uuid(),
});
export type AprobarGate = z.infer<typeof AprobarGateSchema>;

/** Proyección de la pantalla del proyecto: método completo de un vistazo. */
export type ItemDeGate = {
  id: string;
  orden: number;
  texto: string;
  estado: 'pendiente' | 'cumplido' | 'na';
  evidenciaId: string | null;
  evidenciaTitulo: string | null;
  naJustificacion: string;
};

export type GateDeProyecto = {
  id: string;
  numero: number;
  rolAprobador: 'sponsor' | 'lead-boutique';
  estado: 'pendiente' | 'aprobado';
  aprobadoEn: string | null;
  items: ItemDeGate[];
};

export type EtapaDeProyecto = {
  id: string;
  numero: number;
  nombre: string;
  estado: 'pendiente' | 'en-curso' | 'completada';
};

export type CriterioDeReto = {
  id: string;
  kpi: string;
  definicion: string;
  lineaBaseValor: string | null;
  lineaBaseFecha: string | null;
  lineaBasePlan: string;
  objetivo: string;
  ventanaDias: number | null;
  fechaPostMortem: string | null;
};

export type ProyectoMetodo = {
  id: string;
  codigo: string;
  titulo: string;
  estado: string;
  perfil: 'rapido' | 'estandar' | 'profundo';
  reto: {
    id: string;
    codigo: string;
    titulo: string;
    estado: string;
    criterios: CriterioDeReto[];
  };
  etapas: EtapaDeProyecto[];
  gates: GateDeProyecto[];
};
