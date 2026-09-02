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
  'pertenece-a',
  'ocurre-en',
  'participa',
  'soporta',
  'duele',
] as const;
export type TipoArista = (typeof TIPOS_ARISTA)[number];

export const ETIQUETA_TIPO_ARISTA: Record<TipoArista, string> = {
  transicion: 'transición',
  'pertenece-a': 'pertenece a',
  'ocurre-en': 'ocurre en',
  participa: 'participa en',
  soporta: 'soporta',
  duele: 'duele en',
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

export type NodoDeJourney = {
  id: string;
  tipo: TipoNodo;
  etiqueta: string;
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
  estado: 'borrador' | 'congelado';
  nodos: NodoDeJourney[];
  aristas: AristaDeJourney[];
  snapshots: { id: string; motivo: string; congeladoEn: string }[];
};

export type ResumenJourney = {
  id: string;
  nombre: string;
  tipo: TipoJourney;
  estado: 'borrador' | 'congelado';
  servicioNombre: string;
  nodos: number;
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
