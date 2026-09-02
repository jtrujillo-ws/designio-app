import { z } from 'zod';

/**
 * CTX-04/CTX-05 — Los cuatro objetos de resultado (SPEC-06, ADR-0004): design version
 * con elementos de cambio, releases parciales, effective state con desviaciones y la
 * conciliación de la etapa 7.
 *
 * Módulo compartido (servidor + UI + funciones puras): sin imports de servidor.
 *
 * El diff NO aparece aquí como objeto persistible a propósito (RF-06.2): se calcula en
 * `entrega.diff.ts` contra el effective state vigente del servicio.
 */

// ── Design version ──

export const ESTADOS_DESIGN_VERSION = ['borrador', 'aprobada', 'superada'] as const;
export type EstadoDesignVersion = (typeof ESTADOS_DESIGN_VERSION)[number];

/** Los tipos de elemento que §3.2 enumera. Cerrado a propósito: es lo que hace
 * comparables los diffs entre retos y clientes (misma doctrina que la taxonomía del
 * grafo). Inventar uno exige migración. */
export const TIPOS_ELEMENTO = [
  'touchpoint',
  'proceso-backstage',
  'canal',
  'politica',
  'sistema',
  'paso',
  'rol',
] as const;
export type TipoElemento = (typeof TIPOS_ELEMENTO)[number];

export const ETIQUETA_TIPO_ELEMENTO: Record<TipoElemento, string> = {
  touchpoint: 'Touchpoint',
  'proceso-backstage': 'Proceso backstage',
  canal: 'Canal',
  politica: 'Política',
  sistema: 'Sistema',
  paso: 'Paso',
  rol: 'Rol',
};

/** Lo que el autor DECLARA hacer con el elemento. El diff contrasta esta declaración
 * contra el estado efectivo vigente: por eso se guarda la declaración, no el veredicto. */
export const OPERACIONES = ['agrega', 'modifica', 'retira'] as const;
export type Operacion = (typeof OPERACIONES)[number];

export const ETIQUETA_OPERACION: Record<Operacion, string> = {
  agrega: 'agrega',
  modifica: 'modifica',
  retira: 'retira',
};

// ── Release y effective state (vocabulario canónico del prediseño: RL-n, ES-n) ──

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
  desplegadoEn: z.string().nullable(),
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
  constatadoEn: z.string(),
  desviaciones: z.array(DesviacionSchema).default([]),
});
export type EffectiveState = z.infer<typeof EffectiveStateSchema>;

/** Cómo quedó un elemento tras el despliegue (RF-06.6). Los dos últimos son desviación:
 * llevan «qué quedó distinto» y razón obligatorios (SYS-07, impuesto por CHECK). */
export const RESULTADOS_CONSTATACION = ['como-aprobado', 'desviado', 'no-implementado'] as const;
export type ResultadoConstatacion = (typeof RESULTADOS_CONSTATACION)[number];

export const ETIQUETA_RESULTADO: Record<ResultadoConstatacion, string> = {
  'como-aprobado': 'como se aprobó',
  desviado: 'desviado',
  'no-implementado': 'no implementado',
};

// ── Contratos de entrada ──

/** Fecha calendárica: `date` en SQL, texto YYYY-MM-DD en TypeScript. */
const FechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha con formato YYYY-MM-DD');

export const CrearDesignVersionSchema = z.object({
  workspaceId: z.string().uuid(),
  proyectoId: z.string().uuid(),
  servicioId: z.string().uuid(),
  journeyId: z.string().uuid().nullable().default(null),
  titulo: z.string().trim().min(1, 'El título es obligatorio').max(200),
  resumen: z.string().trim().max(2000).default(''),
  /** A qué design version aprobada reemplaza (SYS-05). Null en la primera del servicio. */
  superaA: z.string().uuid().nullable().default(null),
});
export type CrearDesignVersion = z.infer<typeof CrearDesignVersionSchema>;

export const AgregarElementoSchema = z.object({
  workspaceId: z.string().uuid(),
  designVersionId: z.string().uuid(),
  tipo: z.enum(TIPOS_ELEMENTO),
  operacion: z.enum(OPERACIONES),
  titulo: z.string().trim().min(1, 'El título es obligatorio').max(200),
  detalle: z.string().trim().max(2000).default(''),
  nodoId: z.string().uuid().nullable().default(null),
  decisionIds: z.array(z.string().uuid()).max(20).default([]),
  insightIds: z.array(z.string().uuid()).max(20).default([]),
});
export type AgregarElemento = z.infer<typeof AgregarElementoSchema>;

export const EditarElementoSchema = z.object({
  workspaceId: z.string().uuid(),
  elementoId: z.string().uuid(),
  tipo: z.enum(TIPOS_ELEMENTO),
  operacion: z.enum(OPERACIONES),
  titulo: z.string().trim().min(1, 'El título es obligatorio').max(200),
  detalle: z.string().trim().max(2000).default(''),
  nodoId: z.string().uuid().nullable().default(null),
});
export type EditarElemento = z.infer<typeof EditarElementoSchema>;

export const BorrarElementoSchema = z.object({
  workspaceId: z.string().uuid(),
  elementoId: z.string().uuid(),
});

export const AprobarDesignVersionSchema = z.object({
  workspaceId: z.string().uuid(),
  designVersionId: z.string().uuid(),
  motivo: z.string().trim().max(500).default(''),
});
export type AprobarDesignVersion = z.infer<typeof AprobarDesignVersionSchema>;

export const PlanificarReleaseSchema = z.object({
  workspaceId: z.string().uuid(),
  designVersionId: z.string().uuid(),
  titulo: z.string().trim().min(1, 'El título es obligatorio').max(200),
  responsable: z.string().trim().min(1, 'El dueño del release es obligatorio').max(200),
  fechaObjetivo: FechaSchema,
  /** Parcialidad explícita: cada elemento con la razón de caer en ESTE release. */
  elementos: z
    .array(
      z.object({
        elementoId: z.string().uuid(),
        razon: z.string().trim().max(500).default(''),
      }),
    )
    .max(200)
    .default([]),
});
export type PlanificarRelease = z.infer<typeof PlanificarReleaseSchema>;

export const AsignarElementoSchema = z.object({
  workspaceId: z.string().uuid(),
  releaseId: z.string().uuid(),
  elementoId: z.string().uuid(),
  razon: z.string().trim().max(500).default(''),
});
export type AsignarElemento = z.infer<typeof AsignarElementoSchema>;

export const DesasignarElementoSchema = z.object({
  workspaceId: z.string().uuid(),
  elementoId: z.string().uuid(),
});

export const DesplegarReleaseSchema = z.object({
  workspaceId: z.string().uuid(),
  releaseId: z.string().uuid(),
  desplegadoEn: FechaSchema,
});
export type DesplegarRelease = z.infer<typeof DesplegarReleaseSchema>;

export const ConstatarSchema = z.object({
  workspaceId: z.string().uuid(),
  releaseId: z.string().uuid(),
  constatadoEn: FechaSchema,
  resumen: z.string().trim().max(2000).default(''),
  constataciones: z
    .array(
      z.object({
        elementoId: z.string().uuid(),
        resultado: z.enum(RESULTADOS_CONSTATACION),
        queQuedoDistinto: z.string().trim().max(2000).default(''),
        razon: z.string().trim().max(2000).default(''),
      }),
    )
    .min(1, 'Constatar exige al menos un elemento'),
});
export type Constatar = z.infer<typeof ConstatarSchema>;

export const DesignVersionInputSchema = z.object({
  workspaceId: z.string().uuid(),
  designVersionId: z.string().uuid(),
});

export const ReleaseInputSchema = z.object({
  workspaceId: z.string().uuid(),
  releaseId: z.string().uuid(),
});

export const WorkspaceInputSchema = z.object({ workspaceId: z.string().uuid() });

// ── Proyecciones de lectura ──

export type ElementoDeCambio = {
  id: string;
  tipo: TipoElemento;
  operacion: Operacion;
  titulo: string;
  detalle: string;
  nodoId: string | null;
  nodoEtiqueta: string | null;
  orden: number;
  decisiones: { id: string; titulo: string }[];
  insights: { id: string; titulo: string }[];
};

export type ReleaseDeDesignVersion = {
  id: string;
  codigo: string;
  titulo: string;
  responsable: string;
  fechaObjetivo: string;
  estado: EstadoRelease;
  desplegadoEn: string | null;
  elementos: { elementoId: string; razon: string }[];
  effectiveState: {
    id: string;
    codigo: string;
    resumen: string;
    constatadoEn: string;
    constataciones: {
      elementoId: string;
      resultado: ResultadoConstatacion;
      queQuedoDistinto: string;
      razon: string;
    }[];
  } | null;
};

/** Lo que el effective state VIGENTE del servicio dice de cada elemento ya constatado
 * (RF-06.10). Es el lado derecho del diff. */
export type ElementoVigente = {
  elementoId: string;
  titulo: string;
  nodoId: string | null;
  resultado: ResultadoConstatacion;
};

export type EstadoEfectivoVigente = {
  id: string;
  codigo: string;
  constatadoEn: string;
  designVersionCodigo: string;
  elementos: ElementoVigente[];
} | null;

export type DesignVersionCompleta = {
  id: string;
  codigo: string;
  titulo: string;
  resumen: string;
  estado: EstadoDesignVersion;
  servicioId: string;
  servicioNombre: string;
  proyectoId: string;
  proyectoCodigo: string;
  journeyId: string | null;
  journeyNombre: string | null;
  snapshotId: string | null;
  aprobadaEn: string | null;
  superaA: { id: string; codigo: string } | null;
  superadaPor: { id: string; codigo: string } | null;
  elementos: ElementoDeCambio[];
  releases: ReleaseDeDesignVersion[];
  /** Nodos del journey to-be, para enlazar elementos sin salir de la pantalla. */
  nodosDelJourney: { id: string; tipo: string; etiqueta: string }[];
  decisionesDelProyecto: { id: string; titulo: string }[];
  insightsValidados: { id: string; titulo: string }[];
  vigente: EstadoEfectivoVigente;
};

export type ResumenDesignVersion = {
  id: string;
  codigo: string;
  titulo: string;
  estado: EstadoDesignVersion;
  servicioNombre: string;
  proyectoCodigo: string;
  elementos: number;
  releases: number;
  aprobadaEn: string | null;
};

// ── Conciliación (RF-06.7) ──

/** Los estados del tablero, en el orden de la cadena. Los tres primeros son
 * DESCONOCIDOS: nadie ha constatado cómo quedó el elemento. Los tres últimos son
 * conocidos — incluido 'no-implementado', que es una respuesta honesta y no un hueco. */
export const ESTADOS_CONCILIACION = [
  'aprobado',
  'en-release',
  'desplegado',
  'constatado',
  'desviado',
  'no-implementado',
] as const;
export type EstadoConciliacion = (typeof ESTADOS_CONCILIACION)[number];

export const ETIQUETA_CONCILIACION: Record<EstadoConciliacion, string> = {
  aprobado: 'aprobado, sin release',
  'en-release': 'incluido en release',
  desplegado: 'desplegado, sin constatar',
  constatado: 'constatado',
  desviado: 'desviado',
  'no-implementado': 'no implementado',
};

/** Un elemento en estado desconocido bloquea G7 (RF-06.7, criterio de aceptación 4).
 * La misma regla vive en `gate_aprobar_suficiencia_guard`: aquí, para explicar por qué
 * el gate no va a pasar antes de intentarlo. */
export const ESTADOS_CONOCIDOS: readonly EstadoConciliacion[] = [
  'constatado',
  'desviado',
  'no-implementado',
];

export type FilaConciliacion = {
  elementoId: string;
  elementoTitulo: string;
  tipo: TipoElemento;
  operacion: Operacion;
  estado: EstadoConciliacion;
  releaseCodigo: string | null;
  releaseResponsable: string | null;
  releaseFecha: string | null;
  razonAsignacion: string;
  queQuedoDistinto: string;
  razonDesviacion: string;
};

export type TableroConciliacion = {
  designVersionId: string;
  designVersionCodigo: string;
  filas: FilaConciliacion[];
};
