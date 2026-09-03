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

/** Enlazar el to-be prometido por «se puede enlazar después». El journey es OBLIGATORIO:
 * la operación existe para poner el enlace que falta, y desenlazar solo devolvería el
 * borrador al estado que esto vino a arreglar. */
export const EnlazarJourneySchema = z.object({
  workspaceId: z.string().uuid(),
  designVersionId: z.string().uuid(),
  journeyId: z.string().uuid(),
});
export type EnlazarJourney = z.infer<typeof EnlazarJourneySchema>;

/** Declarar (o corregir) a qué versión aprobada sucede este borrador. Admite null: si el
 * servicio no tiene ninguna aprobada, «no supera a ninguna» es la respuesta correcta y
 * tiene que poder volver a serlo tras un error. */
export const DeclararSuperaASchema = z.object({
  workspaceId: z.string().uuid(),
  designVersionId: z.string().uuid(),
  superaA: z.string().uuid().nullable(),
});
export type DeclararSuperaA = z.infer<typeof DeclararSuperaASchema>;

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

export const DesignVersionsInputSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Id de la última design version ya vista: el keyset resuelve su `(creado_en, id)` en
   * la base. */
  cursor: z.string().uuid().nullable().default(null),
});

/** El servicio cuya versión aprobada vigente se busca. Va por servicio y no por página
 * porque el candidato a suceder (SYS-05) tiene que estar SIEMPRE disponible, viva su fila
 * donde viva en la lista. */
export const VersionAprobadaInputSchema = z.object({
  workspaceId: z.string().uuid(),
  servicioId: z.string().uuid(),
});

export const ProyectosCertificadosInputSchema = z.object({
  workspaceId: z.string().uuid(),
});

// ── Proyecciones de lectura ──

export type ElementoDeCambio = {
  id: string;
  tipo: TipoElemento;
  operacion: Operacion;
  titulo: string;
  detalle: string;
  nodoId: string | null;
  nodoEtiqueta: string | null;
  /** La identidad de catálogo del nodo, cuando el nodo la tiene: es por donde el diff
   * reconoce el mismo elemento lógico entre design versions (ver ConstatacionDelServicio). */
  catalogoId: string | null;
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

/**
 * Una constatación del servicio, con la IDENTIDAD del elemento sobre el que cayó y la
 * operación que declaraba (RF-06.6). Las tres claves van juntas porque la identidad
 * lógica de un elemento de cambio no es su fila: cada design version que vuelve a tocar
 * la misma cosa crea un `elemento_cambio` nuevo, con id nuevo. Lo estable es, por orden:
 *
 *  1. `catalogoId` — el catálogo del servicio (SPEC-05) le da identidad a lo que se
 *     repite entre journeys: un touchpoint, un canal, un actor o un sistema son LOS
 *     MISMOS en el as-is, en el to-be de este ciclo y en el del siguiente, y sobreviven
 *     a un renombre. Es la identidad de verdad, y ya está en el esquema: el elemento la
 *     alcanza por su nodo. Darle al elemento de cambio una identidad propia y paralela
 *     sería tener dos identidades para la misma cosa — justo lo que el catálogo vino a
 *     evitar.
 *  2. `nodoId` — para los tipos que NO tienen catálogo (un paso, una fricción): existen
 *     dentro de su journey, y el journey de trabajo sigue vivo entre ciclos (RF-05.8),
 *     así que el nodo aguanta mientras el grafo sea el mismo.
 *  3. el título normalizado — para los elementos sin nodo. Es un apaño y se sabe: dos
 *     elementos distintos pueden compartir título. Se prefiere a no emparejar nada,
 *     pero es la razón por la que enlazar el nodo importa.
 */
export type ConstatacionDelServicio = {
  elementoId: string;
  titulo: string;
  nodoId: string | null;
  catalogoId: string | null;
  operacion: Operacion;
  resultado: ResultadoConstatacion;
};

/** Un elemento del effective state VIGENTE (RF-06.10): el resultado de plegar la historia
 * de constataciones por identidad lógica. Misma forma que la constatación que lo dejó
 * así, a propósito — es exactamente esa fila la que describe cómo quedó. */
export type ElementoVigente = ConstatacionDelServicio;

export type EstadoEfectivoVigente = {
  id: string;
  codigo: string;
  constatadoEn: string;
  designVersionCodigo: string;
  /** La HISTORIA del servicio en orden cronológico, no el estado: el estado es su
   * pliegue (`plegarEstadoVigente` en entrega.diff.ts). Viaja entera porque el pliegue
   * necesita la identidad lógica, que se define del lado que también empareja el diff. */
  constataciones: ConstatacionDelServicio[];
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
  /** Los to-be del servicio que este borrador puede enlazar (mismo predicado que el
   * guard): si nació sin journey, es por aquí por donde se le pone. */
  journeysEnlazables: { id: string; nombre: string }[];
  /** Las versiones aprobadas del MISMO servicio a las que este borrador puede suceder.
   * Como mucho hay una (SYS-05), pero la lista deja que la pantalla ofrezca exactamente
   * lo que el guard acepta en vez de suponerlo. */
  superables: { id: string; codigo: string; titulo: string }[];
  /** Si el proyecto sigue respondiendo por esta versión ante sus gates: es lo que la base
   * usa para decidir si admite plan y alcance, y no es lo mismo que estar aprobada — una
   * versión superada desde OTRO proyecto sigue a cargo del suyo. */
  aCargoDelProyecto: boolean;
  /** Por qué G7 está bloqueado en el proyecto de esta design version, o null si no lo está.
   * Lo dice la misma función que lo rechaza (`g7_motivo_de_bloqueo`): el tablero no vuelve
   * a redactar el predicado, que es como se le acabó quedando una rama corta. */
  bloqueoDeG7: string | null;
  /** El gate del proyecto que ya certificó y por tanto impide aprobar design versions
   * nuevas aquí (6 o 7), o null. El ciclo siguiente de ese servicio va en otro proyecto. */
  proyectoCertificadoPor: number | null;
  decisionesDelProyecto: { id: string; titulo: string }[];
  insightsValidados: { id: string; titulo: string }[];
  vigente: EstadoEfectivoVigente;
};

export type ResumenDesignVersion = {
  id: string;
  codigo: string;
  titulo: string;
  estado: EstadoDesignVersion;
  /** Por ID y no solo por nombre: quien filtra por servicio —el selector de «supera a»,
   * que solo puede ofrecer versiones del MISMO servicio— no puede hacerlo comparando
   * cadenas. */
  servicioId: string;
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
