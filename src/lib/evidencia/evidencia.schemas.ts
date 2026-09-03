import { z } from 'zod';
import {
  bytesDeBase64,
  FORMATOS_PERMITIDOS,
  MAX_ARCHIVO_BYTES,
  validarTextoImportado,
} from './sanitizacion';

/** CTX-02 Evidencia y Conocimiento — cinco dimensiones (ADR-0010) y citas verificables. */

/** Fecha CALENDÁRICA pura (AAAA-MM-DD, sin huso): codificarla como instante corre el
 * día en husos extremos (p. ej. mediodía UTC ya es mañana en UTC+13/14) — se persiste
 * y viaja como texto y solo se interpreta como día. */
export const FechaCalendarioSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD')
  .refine(
    (f) => {
      // Comparación por componentes: el parser ISO de V8 RUEDA los desbordes
      // (2026-02-30 → 2 de marzo) en vez de rechazarlos.
      const [a, m, d] = f.split('-').map(Number);
      const fecha = new Date(Date.UTC(a!, m! - 1, d!));
      return (
        fecha.getUTCFullYear() === a && fecha.getUTCMonth() === m! - 1 && fecha.getUTCDate() === d
      );
    },
    { message: 'Fecha inválida' },
  );

export const DimensionesEvidenciaSchema = z.object({
  proveniencia: z.object({
    tipoFuente: z.string().min(1),
    fecha: FechaCalendarioSchema,
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

/** Quiénes deciden la curaduría (RF-03.4): compartido entre el re-check del servicio
 * y la UI, que solo muestra los controles de decisión a estos roles. */
export const ROLES_CURADORES = ['lead-boutique', 'disenador'] as const;

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

/** Texto de terceros: se acepta CRUDO (sin normalizar ni recortar — la fidelidad de las
 * citas depende de que los offsets no cambien) pero se RECHAZA si trae controles o
 * overrides bidi. Mismo predicado que el CHECK `texto_importado_limpio` de la base. */
const TextoImportado = z.string().superRefine((valor, ctx) => {
  const v = validarTextoImportado(valor);
  if (!v.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: v.motivo });
});

/** RF-03.1/03.2: el contenido es texto NO confiable — acotado aquí y en el esquema SQL.
 * Se importa texto pegado, una referencia al original, o ambos: al menos uno. */
export const CrearItemImportacionSchema = z
  .object({
    workspaceId: z.string().uuid(),
    titulo: TextoImportado.pipe(z.string().trim().min(1, 'El título es obligatorio').max(300)),
    contenido: TextoImportado.pipe(z.string().max(100_000, 'Máximo 100k caracteres')).default(''),
    tipoFuente: z.enum(TIPOS_FUENTE),
    referencia: TextoImportado.pipe(z.string().trim().max(2000)).default(''),
  })
  .refine((d) => d.contenido.trim().length > 0 || d.referencia.length > 0, {
    message: 'Pega el contenido o indica al menos la referencia del original',
    path: ['contenido'],
  });
export type CrearItemImportacion = z.infer<typeof CrearItemImportacionSchema>;

/**
 * Lo que el CURADOR completa al aprobar (RF-03.4/03.5): el servicio compone con esto
 * las cinco dimensiones completas (proveniencia sale del propio item; lineage es null
 * porque la importación manual no pasó por ninguna transformación AI).
 */
export const DimensionesCuraduriaSchema = z.object({
  fecha: FechaCalendarioSchema,
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

export const BandejaInputSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Cursor: id del último pendiente devuelto — el server resuelve su (creado_en, id)
   * con precisión exacta y pide los más antiguos (keyset estable ante inserciones). */
  antesDe: z.string().uuid().optional(),
  /** El mismo cursor para el historial de decididas, sobre `(decidido_en, id)`. Existe
   * porque un item rechazado conserva sus archivos y no aparece en ninguna otra pantalla:
   * sin recorrer el historial entero, esos originales no tenían camino. */
  antesDeDecidida: z.string().uuid().optional(),
});

export const ItemInputSchema = z.object({
  workspaceId: z.string().uuid(),
  itemId: z.string().uuid(),
});

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
  /** Adjuntos del material (RF-03.1): metadatos; los bytes se piden uno a uno. */
  archivos: ArchivoAdjunto[];
};

// ── Archivos adjuntos del material importado (RF-03.1, RF-09.8) ──

/** Metadatos del adjunto. Los bytes NUNCA viajan en un listado: se piden por id. */
export type ArchivoAdjunto = {
  id: string;
  nombre: string;
  tipoMime: string;
  bytes: number;
  /** Hash del original, calculado por la base (columna generada): identidad verificable
   * del archivo, y lo que publica el manifiesto de exportación (RF-01.8). */
  sha256: string;
  creadoEn: string;
};

/** El adjunto viaja base64 dentro del payload JSON: el tope se comprueba ANTES de
 * decodificar (un payload gigante se corta en el borde, no tras reservar la memoria). */
export const AdjuntarArchivoSchema = z.object({
  workspaceId: z.string().uuid(),
  itemId: z.string().uuid(),
  nombre: z.string().min(1).max(200),
  tipoMime: z.string().refine((t) => t in FORMATOS_PERMITIDOS, 'Formato de archivo no permitido'),
  contenidoBase64: z
    .string()
    .min(1, 'El archivo está vacío')
    .refine(
      (b) => bytesDeBase64(b) <= MAX_ARCHIVO_BYTES,
      `El archivo supera ${MAX_ARCHIVO_BYTES / 1024 / 1024} MB`,
    ),
});
export type AdjuntarArchivo = z.infer<typeof AdjuntarArchivoSchema>;

export const ArchivoInputSchema = z.object({
  workspaceId: z.string().uuid(),
  archivoId: z.string().uuid(),
});

// ── Derechos de uso (RF-03.10, SYS-14) ──

/** Orden total: interno ⊂ cliente ⊂ publico. Citar en un gate (portal, con el cliente
 * delante) exige `cliente`; un entregable exportado, también. */
export const AMBITOS_USO = ['interno', 'cliente', 'publico'] as const;
export type AmbitoUso = (typeof AMBITOS_USO)[number];

export const ETIQUETA_AMBITO: Record<AmbitoUso, string> = {
  interno: 'Solo interno (boutique)',
  cliente: 'Cliente (portal y entregables)',
  publico: 'Público (difusión)',
};

export const ESTADOS_DERECHOS = ['pendiente', 'concedido', 'denegado'] as const;
export type EstadoDerechos = (typeof ESTADOS_DERECHOS)[number];

/** Quiénes deciden derechos: quien opera el engagement y sostiene los consentimientos
 * (lead-boutique) y quien administra los datos del cliente (admin-cliente, RF-01.4).
 * Un diseñador cura evidencia pero NO concede derechos: es un acto contractual. */
export const ROLES_DERECHOS = ['lead-boutique', 'admin-cliente'] as const;

/**
 * Decisión de derechos. `base` es obligatoria en ambos sentidos: una concesión sin
 * respaldo documental no es un derecho, y una denegación sin motivo no se puede explicar
 * (SYS-14 exige que el bloqueo diga qué falta). Denegar no tiene ámbito ni vigencia.
 */
export const DecidirDerechosSchema = z
  .object({
    workspaceId: z.string().uuid(),
    evidenciaId: z.string().uuid(),
    decision: z.enum(['concedido', 'denegado']),
    ambito: z.enum(AMBITOS_USO).default('interno'),
    base: z
      .string()
      .trim()
      .min(1, 'Indica qué respalda la decisión (consentimiento, cláusula o motivo)')
      .max(500),
    /** Caducidad del permiso; fecha calendárica pura o sin vencimiento. */
    venceEn: FechaCalendarioSchema.nullable().default(null),
  })
  .refine((d) => d.decision === 'concedido' || (d.ambito === 'interno' && d.venceEn === null), {
    message: 'Una denegación no lleva ámbito ni vigencia',
    path: ['ambito'],
  });
export type DecidirDerechos = z.infer<typeof DecidirDerechosSchema>;

/** Fila del picker de citas (checklists del método, RF-04.6): además del título trae si
 * puede citarse y, si no, por qué — la UI deshabilita lo bloqueado con su explicación en
 * vez de dejar que el usuario descubra el error al guardar. El bloqueo REAL lo impone la
 * base (guard `checklist_item_derechos`); esto solo lo hace legible. */
export type EvidenciaCitable = {
  id: string;
  titulo: string;
  citable: boolean;
  motivoBloqueo: string | null;
};

/** Evidencia con su estado de derechos VIVO (no el snapshot congelado del jsonb) y sus
 * adjuntos: es la fila de la pantalla de derechos y del picker de citas. */
export type EvidenciaConDerechos = {
  id: string;
  titulo: string;
  resumen: string;
  esEstadoActual: boolean;
  creadoEn: string;
  derechos: {
    estado: EstadoDerechos;
    ambito: AmbitoUso;
    base: string;
    venceEn: string | null;
    decididoEn: string | null;
  };
  /** true si puede citarse en el portal (ámbito cliente, vigente). */
  citable: boolean;
  /** Por qué NO, con la dimensión que falta; null cuando sí se puede. */
  motivoBloqueo: string | null;
  archivos: ArchivoAdjunto[];
};

/**
 * Rótulo de una opción BLOQUEADA en cualquier picker de objetos citables (SYS-14: se
 * bloquea *explicando*, y el criterio de aceptación 3 pide nombrar **la dimensión que
 * falta**).
 *
 * El motivo manda, y el prefijo fijo desapareció por eso. Los cuatro pickers escribían
 * «— sin derechos: » delante del motivo, lo cual es cierto para la evidencia pero no para
 * todo lo que se ofrece: el picker del checklist también deshabilita DECISIONES por estar
 * `en-revision` tras una reapertura (SYS-10), y salía «sin derechos: está en revisión…».
 * Decir la dimensión equivocada es peor que no decir ninguna, porque manda a reparar
 * donde no hay nada roto.
 *
 * Los motivos que llegan ya son frases completas y se leen solas —«derechos pendientes:
 * …», «los derechos vencieron el …», «su respaldo perdió los derechos: …», «está en
 * revisión tras una reapertura…»— porque los redacta quien conoce la causa: la base en
 * `evidencia_motivo_bloqueo`, o el servicio que evalúa la cadena.
 *
 * El texto de reserva sí nombra los derechos, y es correcto ahí: `motivoBloqueo` es null
 * cuando `evidencia_motivo_bloqueo` calla a propósito —el pre-chequeo anti-oráculo de
 * 20260902190000 devuelve null a quien no es miembro del workspace— y ese caso solo se
 * alcanza por la vía de los derechos.
 *
 * Vive aquí, y no repetido en cada pantalla, porque era literalmente el mismo literal
 * copiado cuatro veces «para que no se separen»: una función no se separa sola.
 */
export function etiquetaObjetoBloqueado(
  titulo: string,
  // `undefined` además de `null` porque el picker del checklist compone objetos de tres
  // clases y el campo llega opcional; ausente y nulo significan aquí lo mismo (no hay
  // motivo que dar), y distinguirlos obligaría a cada llamante a normalizarlo.
  motivoBloqueo: string | null | undefined,
): string {
  return `${titulo} — ${motivoBloqueo ?? 'sin derechos: faltan derechos de uso para el ámbito cliente'}`;
}
