import { z } from 'zod';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';
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
  /** Fecha del DATO, calendárica: un snapshot con huso rueda el día y falsea la serie. */
  fecha: FechaCalendarioSchema,
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

// ── Contratos ejecutables de SPEC-07 (entradas de server functions y proyecciones de ──
// ── la pantalla; los catálogos en base viajan como slugs y la UI muestra su etiqueta) ──

export const FRECUENCIAS = ['semanal', 'mensual', 'trimestral', 'unica'] as const;
export type Frecuencia = (typeof FRECUENCIAS)[number];

export const ETIQUETA_FRECUENCIA: Record<Frecuencia, string> = {
  semanal: 'Semanal',
  mensual: 'Mensual',
  trimestral: 'Trimestral',
  unica: 'Única',
};

/** Cadencia comprometida en días: de ella sale «esperado / recibido / vencido»
 * (RF-07.4). Espejo EXACTO del CASE de la proyección — la única fuente de verdad del
 * estado es el servidor; esto documenta y etiqueta. `unica` no tiene cadencia. */
export const CADENCIA_DIAS: Record<Frecuencia, number | null> = {
  semanal: 7,
  mensual: 30,
  trimestral: 90,
  unica: null,
};

export const ESTADOS_SNAPSHOT = ['esperado', 'recibido', 'vencido'] as const;
export type EstadoSnapshot = (typeof ESTADOS_SNAPSHOT)[number];

export const ORIGENES_SNAPSHOT = ['formulario', 'csv'] as const;
export type OrigenSnapshot = (typeof ORIGENES_SNAPSHOT)[number];

/** Catálogo CERRADO del veredicto (SYS-24) tal como se codifica en base. El vocabulario
 * canónico del dominio vive en VeredictoSchema; estos son sus slugs. */
export const VEREDICTOS = [
  'logrado',
  'parcialmente-logrado',
  'no-logrado',
  'no-concluyente',
] as const;
export type VeredictoSlug = (typeof VEREDICTOS)[number];

export const ETIQUETA_VEREDICTO: Record<VeredictoSlug, string> = {
  logrado: 'Logrado',
  'parcialmente-logrado': 'Parcialmente logrado',
  'no-logrado': 'No logrado',
  'no-concluyente': 'No concluyente',
};

/** Valor de un KPI: viaja como TEXTO y se almacena numeric. No es un `number` de JS
 * porque el binario flotante redondea (0.1 + 0.2) y aquí se compara contra la línea
 * base de un contrato firmado; la base hace la aritmética exacta. */
export const ValorMetricoSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, 'Valor numérico (usa punto decimal)')
  .max(40);

export const RetoInputSchema = z.object({
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
});

export const SeguimientoInputSchema = z.object({
  workspaceId: z.string().uuid(),
  proyectoId: z.string().uuid(),
});

/** Campos de la entrada KPI (RF-07.1). Se aceptan INCOMPLETOS mientras el registry es
 * borrador: la completitud la exige la firma (SYS-22), igual que G0 con los criterios. */
const CamposEntradaSchema = z.object({
  workspaceId: z.string().uuid(),
  nombre: z.string().trim().min(1, 'El nombre del KPI es obligatorio').max(200),
  definicion: z.string().trim().max(2000).default(''),
  fuente: z.string().trim().max(300).default(''),
  dimensiones: z.string().trim().max(300).default(''),
  propietarioMiembroId: z.string().uuid().nullable().default(null),
  frecuencia: z.enum(FRECUENCIAS),
  dashboardUrl: z
    .union([z.literal(''), z.string().trim().url('Enlace de dashboard inválido').max(2000)])
    .default(''),
  lineaBaseValor: ValorMetricoSchema.nullable().default(null),
  lineaBaseFecha: FechaCalendarioSchema.nullable().default(null),
  ventanaInicio: FechaCalendarioSchema.nullable().default(null),
  fechaPostMortem: FechaCalendarioSchema.nullable().default(null),
});

export const CrearEntradaSchema = CamposEntradaSchema.extend({
  registryId: z.string().uuid(),
  criterioId: z.string().uuid(),
});
export type CrearEntrada = z.infer<typeof CrearEntradaSchema>;

/** Editar la entrada completa mientras el registry es borrador. Registry y criterio no
 * se editan: son la IDENTIDAD del compromiso (mover un KPI de criterio sería otro KPI). */
export const EditarEntradaSchema = CamposEntradaSchema.extend({
  entradaId: z.string().uuid(),
});
export type EditarEntrada = z.infer<typeof EditarEntradaSchema>;

export const RegistryInputSchema = z.object({
  workspaceId: z.string().uuid(),
  registryId: z.string().uuid(),
});

export const RegistrarSnapshotSchema = z.object({
  workspaceId: z.string().uuid(),
  entradaId: z.string().uuid(),
  valor: ValorMetricoSchema,
  fecha: FechaCalendarioSchema,
  /** Corregir es un snapshot NUEVO (SYS-23): la nota dice qué corrige. */
  nota: z.string().trim().max(500).default(''),
});
export type RegistrarSnapshot = z.infer<typeof RegistrarSnapshotSchema>;

export const CargarCsvSchema = z.object({
  workspaceId: z.string().uuid(),
  entradaId: z.string().uuid(),
  csv: z.string().max(100_000, 'Máximo 100k caracteres'),
});
export type CargarCsv = z.infer<typeof CargarCsvSchema>;

/** Fila rechazada del CSV con mensaje ACCIONABLE (criterio de aceptación 1): número de
 * línea del texto pegado, contenido y motivo. Nada se sobreescribe por una fila mala. */
export type FilaRechazada = { linea: number; contenido: string; motivo: string };

export const ResultadoCriterioSchema = z
  .object({
    workspaceId: z.string().uuid(),
    reviewId: z.string().uuid(),
    criterioId: z.string().uuid(),
    /** El valor final APUNTA a un snapshot real de la serie: no se teclea. */
    snapshotFinalId: z.string().uuid().nullable().default(null),
    lectura: z.string().trim().max(4000).default(''),
    sinDatosMotivo: z.string().trim().max(1000).default(''),
  })
  .refine((d) => d.snapshotFinalId !== null || d.sinDatosMotivo !== '', {
    message: 'Elige el snapshot final o escribe por qué no hay dato',
    path: ['sinDatosMotivo'],
  });
export type ResultadoCriterioEntrada = z.infer<typeof ResultadoCriterioSchema>;

export const CompletarReviewSchema = z
  .object({
    workspaceId: z.string().uuid(),
    reviewId: z.string().uuid(),
    veredicto: z.enum(VEREDICTOS),
    contribucion: z
      .string()
      .trim()
      .min(1, 'Escribe la contribución del rediseño y lo que no puede atribuírsele')
      .max(8000),
    factoresExternos: z.string().trim().max(8000).default(''),
    hipotesisAbiertas: z.string().trim().max(8000).default(''),
    aprendizajes: z.string().trim().max(8000).default(''),
    /** RF-07.9: el lenguaje causal NO es el default; se habilita explícitamente. */
    disenoExperimentalSuficiente: z.boolean().default(false),
    disenoExperimentalJustificacion: z.string().trim().max(4000).default(''),
  })
  .refine((d) => !d.disenoExperimentalSuficiente || d.disenoExperimentalJustificacion !== '', {
    message: 'Declarar diseño experimental suficiente exige justificarlo (SYS-24)',
    path: ['disenoExperimentalJustificacion'],
  });
export type CompletarReview = z.infer<typeof CompletarReviewSchema>;

// ── Proyección de lectura del seguimiento de impacto (vive DENTRO del proyecto: RF-07.6) ──

export type SnapshotDeEntrada = {
  id: string;
  valor: string;
  fecha: string;
  origen: OrigenSnapshot;
  nota: string;
};

export type EntradaDeRegistry = {
  id: string;
  criterioId: string;
  criterioKpi: string;
  criterioObjetivo: string;
  criterioVentanaDias: number | null;
  nombre: string;
  definicion: string;
  fuente: string;
  dimensiones: string;
  propietarioMiembroId: string | null;
  propietarioNombre: string | null;
  /** El propietario del dato carga snapshots aunque no sea de la boutique (RF-07.4). */
  soyPropietario: boolean;
  frecuencia: Frecuencia;
  dashboardUrl: string;
  lineaBaseValor: string | null;
  lineaBaseFecha: string | null;
  ventanaInicio: string | null;
  ventanaFin: string | null;
  fechaPostMortem: string | null;
  /** Negativo o cero: la ventana de este criterio ya cerró. */
  diasRestantes: number | null;
  ultimaFecha: string | null;
  estadoSnapshot: EstadoSnapshot;
  snapshots: SnapshotDeEntrada[];
};

export type ResultadoDeCriterio = {
  criterioId: string;
  criterioKpi: string;
  snapshotFinalId: string | null;
  valorFinal: string | null;
  fechaFinal: string | null;
  lectura: string;
  sinDatosMotivo: string;
};

export type OutcomeReviewDeReto = {
  id: string;
  estado: 'borrador' | 'completado';
  veredicto: VeredictoSlug | null;
  contribucion: string;
  factoresExternos: string;
  hipotesisAbiertas: string;
  aprendizajes: string;
  disenoExperimentalSuficiente: boolean;
  disenoExperimentalJustificacion: string;
  completadoEn: string | null;
  resultados: ResultadoDeCriterio[];
};

export type SeguimientoDeImpacto = {
  retoId: string;
  retoCodigo: string;
  retoEstado: string;
  retoVeredicto: VeredictoSlug | null;
  proyectoEstado: string;
  registry: { id: string; estado: 'borrador' | 'firmado'; firmadoEn: string | null } | null;
  entradas: EntradaDeRegistry[];
  /** Criterios del reto sin KPI que los responda: la firma los exige (SYS-22). */
  criteriosSinEntrada: { id: string; kpi: string }[];
  /** Miembros del workspace: entre ellos se elige el propietario del dato. */
  miembros: { id: string; nombre: string; rol: string }[];
  review: OutcomeReviewDeReto | null;
};

/** El outcome review se habilita al cerrar la ventana del ÚLTIMO criterio (RF-07.7).
 * Espejo cliente del predicado de la política: informa la pantalla, no autoriza nada. */
export function ventanasCerradas(entradas: EntradaDeRegistry[]): boolean {
  return (
    entradas.length > 0 && entradas.every((e) => e.diasRestantes !== null && e.diasRestantes <= 0)
  );
}
