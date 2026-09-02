import { z } from 'zod';

/** CTX-04 Diseño del Servicio — grafo tipado del journey y design versions (ADR-0006). */

export const TipoNodoSchema = z.enum([
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
]);
export type TipoNodo = z.infer<typeof TipoNodoSchema>;

export const TipoAristaSchema = z.enum([
  'transicion',
  'pertenece-a',
  'ocurre-en',
  'participa',
  'soporta',
  'evidencia-de',
  'mide',
  'afecta',
  'siente',
]);
export type TipoArista = z.infer<typeof TipoAristaSchema>;

export const EstadoDesignVersionSchema = z.enum(['borrador', 'aprobada', 'superada']);
export type EstadoDesignVersion = z.infer<typeof EstadoDesignVersionSchema>;

export const ElementoDeCambioSchema = z.object({
  id: z.string().uuid(),
  tipo: z.string().min(1),
  descripcion: z.string().min(1),
  nodoIds: z.array(z.string().uuid()).default([]),
  decisionIds: z.array(z.string().uuid()).default([]),
});
export type ElementoDeCambio = z.infer<typeof ElementoDeCambioSchema>;

export const DesignVersionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  codigo: z.string().regex(/^DV-\d+$/),
  estado: EstadoDesignVersionSchema,
  elementos: z.array(ElementoDeCambioSchema).min(1),
  aprobadaPorId: z.string().uuid().nullable(),
  aprobadaEn: z.coerce.date().nullable(),
});
export type DesignVersion = z.infer<typeof DesignVersionSchema>;
