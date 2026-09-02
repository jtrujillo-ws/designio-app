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

// ── Bandeja de importación (SPEC-03, MVP manual: texto pegado o referencia) ──

export const TIPOS_FUENTE = [
  'documento',
  'entrevista',
  'observacion',
  'dataset',
  'enlace',
  'nota',
] as const;
export type TipoFuente = (typeof TIPOS_FUENTE)[number];

export const ETIQUETA_TIPO_FUENTE: Record<TipoFuente, string> = {
  documento: 'Documento',
  entrevista: 'Entrevista',
  observacion: 'Observación',
  dataset: 'Dataset',
  enlace: 'Enlace',
  nota: 'Nota',
};

/** RF-03.1/03.2: el contenido es texto NO confiable — acotado aquí y en el esquema SQL. */
export const CrearItemImportacionSchema = z.object({
  workspaceId: z.string().uuid(),
  titulo: z.string().trim().min(1, 'El título es obligatorio').max(300),
  contenido: z.string().min(1, 'Pega el contenido a importar').max(100_000, 'Máximo 100k caracteres'),
  tipoFuente: z.enum(TIPOS_FUENTE),
  referencia: z.string().trim().max(2000).default(''),
});
export type CrearItemImportacion = z.infer<typeof CrearItemImportacionSchema>;

/**
 * Lo que el CURADOR completa al aprobar (RF-03.4/03.5): el servicio compone con esto
 * las cinco dimensiones completas (proveniencia sale del propio item; lineage es null
 * porque la importación manual no pasó por ninguna transformación AI).
 */
export const DimensionesCuraduriaSchema = z.object({
  fecha: z.coerce.date(),
  recoleccion: z.string().trim().min(1, 'Describe cómo se recolectó').max(300),
  derivada: z.boolean().default(false),
  confianza: z.enum(['alta', 'media', 'baja']),
  consentimiento: z.boolean().default(false),
  confidencialidad: z.enum(['interna', 'cliente', 'restringida']),
  segmentoIds: z.array(z.string().uuid()).default([]),
});
export type DimensionesCuraduria = z.infer<typeof DimensionesCuraduriaSchema>;

export const AprobarItemSchema = z.object({
  workspaceId: z.string().uuid(),
  itemId: z.string().uuid(),
  esEstadoActual: z.boolean().default(false),
  resumen: z.string().trim().max(2000).default(''),
  dimensiones: DimensionesCuraduriaSchema,
});
export type AprobarItem = z.infer<typeof AprobarItemSchema>;

export const RechazarItemSchema = z.object({
  workspaceId: z.string().uuid(),
  itemId: z.string().uuid(),
});
export type RechazarItem = z.infer<typeof RechazarItemSchema>;

export const BandejaInputSchema = z.object({ workspaceId: z.string().uuid() });

/** Fila de la bandeja tal como la ve la UI (el contenido viaja como extracto acotado). */
export type ItemBandeja = {
  id: string;
  titulo: string;
  tipoFuente: TipoFuente;
  referencia: string;
  estado: 'pendiente' | 'aprobado' | 'rechazado';
  extracto: string;
  /** true si el contenido completo es más largo que el extracto (la UI muestra la elipsis). */
  truncado: boolean;
  creadoEn: string;
  decididoEn: string | null;
};
