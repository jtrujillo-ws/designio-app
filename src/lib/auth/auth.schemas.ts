import { z } from 'zod';

/**
 * Contratos del flujo de auth (SPEC-01). Módulo compartido client/server:
 * aquí no puede haber secretos ni acceso a datos.
 */

/** RF-01.2: roles invitables de la matriz; agente-ai existe solo para actores de plataforma. */
export const ROLES_INVITABLES = [
  'sponsor',
  'stakeholder',
  'admin-cliente',
  'lead-boutique',
  'disenador',
] as const;

export type RolInvitable = (typeof ROLES_INVITABLES)[number];

export const ETIQUETA_ROL: Record<string, string> = {
  sponsor: 'Sponsor',
  stakeholder: 'Stakeholder',
  'admin-cliente': 'Admin cliente',
  'lead-boutique': 'Lead boutique',
  disenador: 'Diseñador',
  'agente-ai': 'Agente AI',
};

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Correo inválido'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
});

/** Política de contraseñas en UN lugar: el schema es la autoridad; la UI deriva de aquí. */
export const PASSWORD_MIN = 10;
/** bcrypt solo usa los primeros 72 BYTES: aceptar más truncaría en silencio y dos
 * contraseñas distintas con el mismo prefijo autenticarían igual. */
export const PASSWORD_MAX_BYTES = 72;

export const PasswordNuevaSchema = z
  .string()
  .min(PASSWORD_MIN, `La contraseña necesita al menos ${PASSWORD_MIN} caracteres`)
  .refine((p) => new TextEncoder().encode(p).length <= PASSWORD_MAX_BYTES, {
    message: `Máximo ${PASSWORD_MAX_BYTES} bytes (límite de bcrypt): usa una contraseña más corta`,
  });

export const EstablecerPasswordSchema = z.object({
  token: z.string().min(1),
  password: PasswordNuevaSchema,
});

export const InvitarMiembroSchema = z.object({
  workspaceId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email('Correo inválido'),
  nombre: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
  rol: z.enum(ROLES_INVITABLES),
});

export type Login = z.infer<typeof LoginSchema>;
export type EstablecerPassword = z.infer<typeof EstablecerPasswordSchema>;
export type InvitarMiembro = z.infer<typeof InvitarMiembroSchema>;
