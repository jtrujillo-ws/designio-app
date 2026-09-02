import { z } from 'zod';

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

export const JourneysInputSchema = z.object({ workspaceId: z.string().uuid() });

// ── Proyecciones de lectura ──

/** Los tipos que SON entidades del workspace y por tanto llevan identidad de catálogo:
 * el mismo sistema aparece en el as-is y en el to-be, y renombrarlo debe renombrarlo en
 * los dos. Un paso o una fricción viven dentro de su journey y no se comparten. */
export const TIPOS_CON_CATALOGO: TipoNodo[] = [
  'touchpoint',
  'canal',
  'actor',
  'arquetipo',
  'sistema',
];

export type NodoDeJourney = {
  id: string;
  tipo: TipoNodo;
  etiqueta: string;
  /** Id de catálogo cuando el tipo lo lleva: es lo que permite preguntar «qué pasos de
   * qué journeys dependen de este sistema» sin comparar cadenas. */
  catalogoId: string | null;
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
  tipo: TipoJourney;
  nombre: string;
  descripcion: string;
  nodos: NodoDeJourney[];
  aristas: AristaDeJourney[];
  snapshots: { id: string; motivo: string; congeladoEn: string }[];
};

export type ResumenJourney = {
  id: string;
  nombre: string;
  tipo: TipoJourney;
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
    | 'huerfano-de-fase';
  severidad: SeveridadSenal;
  nodoId: string;
  etiqueta: string;
  mensaje: string;
};
