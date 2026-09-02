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
