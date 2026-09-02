import { z } from 'zod';
import type { EstadoArquetipo } from '@/lib/metodo/gobernanza.schemas';

/**
 * CTX-04 — Journey y blueprint como grafo tipado (ADR-0006, §10). La taxonomía es
 * cerrada a propósito: es lo que hace comparables los journeys entre retos y clientes,
 * y lo que permite preguntar «qué sistemas soportan este paso» en vez de mirar flechas.
 *
 * Módulo compartido (servidor + UI + render): sin imports de servidor.
 */

export const TIPOS_NODO = [
  'fase',
  'paso',
  'touchpoint',
  'canal',
  'actor',
  'arquetipo',
  'sistema',
  'accion-frontstage',
  'accion-backstage',
  'emocion',
  'friccion',
  'oportunidad',
  'decision',
] as const;
export type TipoNodo = (typeof TIPOS_NODO)[number];

export const ETIQUETA_TIPO_NODO: Record<TipoNodo, string> = {
  fase: 'Fase',
  paso: 'Paso',
  touchpoint: 'Touchpoint',
  canal: 'Canal',
  actor: 'Actor',
  arquetipo: 'Arquetipo',
  sistema: 'Sistema',
  'accion-frontstage': 'Acción frontstage',
  'accion-backstage': 'Acción backstage',
  emocion: 'Emoción',
  friccion: 'Fricción',
  oportunidad: 'Oportunidad',
  decision: 'Decisión',
};

export const TIPOS_ARISTA = [
  'transicion',
  'dependencia',
  'ocurre-en',
  'participa',
  'soporta',
  'duele',
] as const;
export type TipoArista = (typeof TIPOS_ARISTA)[number];

export const ETIQUETA_TIPO_ARISTA: Record<TipoArista, string> = {
  transicion: 'transición',
  dependencia: 'depende de',
  'ocurre-en': 'ocurre en',
  participa: 'participa en',
  soporta: 'soporta',
  duele: 'duele en',
};

/** Qué extremos admite cada tipo: el mismo contrato que impone el guard de la base,
 * aquí para que el formulario no ofrezca pares que el servidor va a rechazar. Nunca es
 * la autoridad — solo evita el viaje. */
export const EXTREMOS_ARISTA: Record<TipoArista, { origen: TipoNodo[]; destino: TipoNodo[] }> = {
  transicion: { origen: ['paso', 'decision'], destino: ['paso', 'decision'] },
  dependencia: {
    origen: ['paso', 'accion-frontstage', 'accion-backstage', 'sistema', 'oportunidad'],
    destino: ['paso', 'accion-frontstage', 'accion-backstage', 'sistema', 'friccion'],
  },
  'ocurre-en': { origen: ['paso', 'accion-frontstage'], destino: ['canal', 'touchpoint'] },
  participa: {
    origen: ['actor', 'arquetipo'],
    destino: ['paso', 'accion-frontstage', 'accion-backstage'],
  },
  soporta: {
    origen: ['sistema', 'accion-backstage'],
    destino: ['paso', 'accion-frontstage', 'accion-backstage'],
  },
  duele: { origen: ['friccion', 'emocion'], destino: ['paso', 'accion-frontstage', 'touchpoint', 'canal'] },
};

export const TIPOS_JOURNEY = ['as-is', 'to-be'] as const;
export type TipoJourney = (typeof TIPOS_JOURNEY)[number];

// ── Contratos de entrada ──

export const CrearJourneySchema = z.object({
  workspaceId: z.string().uuid(),
  servicioId: z.string().uuid(),
  retoId: z.string().uuid().nullable().default(null),
  proyectoId: z.string().uuid().nullable().default(null),
  tipo: z.enum(TIPOS_JOURNEY),
  nombre: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
  descripcion: z.string().trim().max(2000).default(''),
});
export type CrearJourney = z.infer<typeof CrearJourneySchema>;

export const AgregarNodoSchema = z.object({
  workspaceId: z.string().uuid(),
  journeyId: z.string().uuid(),
  tipo: z.enum(TIPOS_NODO),
  etiqueta: z.string().trim().min(1, 'La etiqueta es obligatoria').max(200),
  /** Obligatorio y solo para tipo 'arquetipo': el nodo referencia al arquetipo curado
   * del reto, nunca una copia con su propio nombre. */
  arquetipoId: z.string().uuid().nullable().default(null),
  detalle: z.string().trim().max(2000).default(''),
  faseId: z.string().uuid().nullable().default(null),
  responsable: z.string().trim().max(200).default(''),
});
export type AgregarNodo = z.infer<typeof AgregarNodoSchema>;

export const EditarNodoSchema = z.object({
  workspaceId: z.string().uuid(),
  nodoId: z.string().uuid(),
  etiqueta: z.string().trim().min(1, 'La etiqueta es obligatoria').max(200),
  detalle: z.string().trim().max(2000).default(''),
  faseId: z.string().uuid().nullable().default(null),
  responsable: z.string().trim().max(200).default(''),
  orden: z.number().int().min(0).max(9999),
});
export type EditarNodo = z.infer<typeof EditarNodoSchema>;

export const BorrarNodoSchema = z.object({
  workspaceId: z.string().uuid(),
  nodoId: z.string().uuid(),
});

export const AgregarAristaSchema = z.object({
  workspaceId: z.string().uuid(),
  journeyId: z.string().uuid(),
  origenId: z.string().uuid(),
  destinoId: z.string().uuid(),
  tipo: z.enum(TIPOS_ARISTA),
  condicion: z.string().trim().max(200).default(''),
});
export type AgregarArista = z.infer<typeof AgregarAristaSchema>;

export const EditarAristaSchema = z.object({
  workspaceId: z.string().uuid(),
  aristaId: z.string().uuid(),
  tipo: z.enum(TIPOS_ARISTA),
  condicion: z.string().trim().max(200).default(''),
});
export type EditarArista = z.infer<typeof EditarAristaSchema>;

export const BorrarAristaSchema = z.object({
  workspaceId: z.string().uuid(),
  aristaId: z.string().uuid(),
});

export const EnlazarEvidenciaNodoSchema = z.object({
  workspaceId: z.string().uuid(),
  nodoId: z.string().uuid(),
  evidenciaId: z.string().uuid(),
});

export const CongelarJourneySchema = z.object({
  workspaceId: z.string().uuid(),
  journeyId: z.string().uuid(),
  motivo: z.string().trim().max(500).default(''),
});

export const JourneyInputSchema = z.object({
  workspaceId: z.string().uuid(),
  journeyId: z.string().uuid(),
});

export const JourneysInputSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Id del último journey ya visto: el keyset resuelve su `(creado_en, id)` en la base. */
  cursor: z.string().uuid().nullable().default(null),
});

// ── Proyecciones de lectura ──

/** Los tipos que son entidades DEL SERVICIO y por tanto llevan identidad de catálogo:
 * el mismo sistema aparece en el as-is y en el to-be del servicio, y renombrarlo debe
 * renombrarlo en los dos. Un paso o una fricción viven dentro de su journey y no se
 * comparten. El arquetipo va aparte: ya es un objeto curado del reto (SPEC-04.11) y el
 * nodo apunta a ÉL, no a una copia. */
export const TIPOS_CON_CATALOGO: TipoNodo[] = ['touchpoint', 'canal', 'actor', 'sistema'];

export type NodoDeJourney = {
  id: string;
  tipo: TipoNodo;
  etiqueta: string;
  /** Id de catálogo cuando el tipo lo lleva: es lo que permite preguntar «qué pasos de
   * qué journeys dependen de este sistema» sin comparar cadenas. */
  catalogoId: string | null;
  /** Solo en los nodos de tipo arquetipo: el id del arquetipo CURADO del reto. */
  arquetipoId: string | null;
  /** Y su estado de gobernanza en este momento. Referenciar en vez de copiar sirve
   * justamente para esto: un arquetipo refutado después de entrar al grafo se ve desde
   * el grafo, y la validación lo reporta. */
  arquetipoEstado: EstadoArquetipo | null;
  detalle: string;
  faseId: string | null;
  orden: number;
  responsable: string;
  evidencias: { id: string; titulo: string }[];
};

export type AristaDeJourney = {
  id: string;
  origenId: string;
  destinoId: string;
  tipo: TipoArista;
  condicion: string;
};

export type JourneyCompleto = {
  id: string;
  servicioId: string;
  servicioNombre: string;
  retoId: string | null;
  proyectoId: string | null;
  tipo: TipoJourney;
  nombre: string;
  descripcion: string;
  nodos: NodoDeJourney[];
  aristas: AristaDeJourney[];
  snapshots: { id: string; motivo: string; congeladoEn: string }[];
  /** Los arquetipos del reto del journey: lo que un nodo de ese tipo puede referenciar.
   * Vienen con su estado porque un refutado no se puede añadir pero sí puede estar ya
   * puesto, y la pantalla tiene que poder decirlo. */
  arquetipos: { id: string; nombre: string; estado: EstadoArquetipo }[];
};

export type ResumenJourney = {
  id: string;
  nombre: string;
  tipo: TipoJourney;
  /** El servicio por ID y no solo por nombre: quien filtra journeys por servicio (la
   * design version, que cambia UNO) no puede hacerlo comparando cadenas. */
  servicioId: string;
  servicioNombre: string;
  nodos: number;
  /** Cuántos snapshots congelados lleva: la historia de lo aprobado sobre este grafo. */
  snapshots: number;
};

/** Severidad de una señal de validación: el hueco que impide decidir vs. el que
 * conviene resolver. Ninguna bloquea por sí sola — el gate decide (I2). */
export type SeveridadSenal = 'alta' | 'media';

export type SenalValidacion = {
  codigo:
    | 'paso-sin-evidencia'
    | 'paso-inalcanzable'
    | 'paso-sin-salida'
    | 'frontstage-sin-soporte'
    | 'sin-responsable'
    | 'huerfano-de-fase'
    | 'arquetipo-refutado'
    | 'sin-entrada'
    | 'sin-final';
  severidad: SeveridadSenal;
  nodoId: string;
  etiqueta: string;
  mensaje: string;
};
