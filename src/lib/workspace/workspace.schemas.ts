import { z } from 'zod';

/** CTX-01 Workspace e Identidad — vocabulario canónico del modelo de dominio (docs/01-ddd). */

export const RolSchema = z.enum([
  'sponsor',
  'stakeholder',
  'admin-cliente',
  'lead-boutique',
  'disenador',
  'agente-ai',
]);
export type Rol = z.infer<typeof RolSchema>;

/**
 * Los roles del lado CLIENTE (§13.2): la organización que aporta el dato y firma los
 * gates que le tocan. Los otros dos roles humanos son la boutique que la acompaña, y
 * `agente-ai` no es una persona. Esta partición no es cosmética: RF-07.1 exige que el
 * propietario del dato del Metric Registry sea una persona del cliente, y la base lo
 * impone (política de `entrada_kpi` y guard de la firma) con la misma lista. Aquí vive el
 * espejo de cliente: informa el selector, no autoriza nada.
 */
export const ROLES_CLIENTE = ['sponsor', 'stakeholder', 'admin-cliente'] as const;
export type RolCliente = (typeof ROLES_CLIENTE)[number];

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  nombre: z.string().min(1),
  creadoEn: z.coerce.date(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const MiembroSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  nombre: z.string().min(1),
  email: z.string().email(),
  rol: RolSchema,
});
export type Miembro = z.infer<typeof MiembroSchema>;

export const SegmentoSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  nombre: z.string().min(1),
  definicion: z.string().default(''),
});
export type Segmento = z.infer<typeof SegmentoSchema>;

/** Evento de dominio: auditoría append-only y fuente de proyecciones (SYS-13 de eventos). */
export const EventoDominioSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  tipo: z.string().min(1),
  payload: z.record(z.unknown()),
  actorId: z.string().uuid().nullable(),
  actorRol: RolSchema.nullable(),
  creadoEn: z.coerce.date(),
});
export type EventoDominio = z.infer<typeof EventoDominioSchema>;
