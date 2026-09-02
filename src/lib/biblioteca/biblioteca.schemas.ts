import { z } from 'zod';

/**
 * CTX-07 Biblioteca General — SOLO conocimiento metodológico de la boutique (ADR-0008).
 * Sin workspaceId a propósito: este contexto vive fuera de los workspaces de clientes
 * y no admite referencias entrantes desde ellos (SYS-03).
 */
export const ContenidoMetodologicoSchema = z.object({
  id: z.string().uuid(),
  titulo: z.string().min(1),
  tipo: z.enum(['método', 'guía', 'plantilla', 'taxonomía', 'checklist-gate']),
  version: z.string().min(1),
  cuerpo: z.string().default(''),
});
export type ContenidoMetodologico = z.infer<typeof ContenidoMetodologicoSchema>;
