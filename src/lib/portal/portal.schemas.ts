import { z } from 'zod';

/**
 * Contratos del portal (SPEC-01, RF-01.5) y de la auditoría consultable (RF-01.6).
 * Módulo compartido client/server: aquí no puede haber secretos ni acceso a datos.
 */

/** Objetos presentables que YA existen en el modelo y admiten hilo (RF-01.5). Los
 * nombres son los de las tablas padre porque el arco de FKs compuestas del hilo no
 * admite otros: design version y post mortem entran cuando lleguen con sus specs. */
export const OBJETOS_CITABLES = ['reto', 'proyecto', 'gate_instancia', 'evidencia'] as const;
export type ObjetoCitable = (typeof OBJETOS_CITABLES)[number];

export const ETIQUETA_OBJETO: Record<ObjetoCitable, string> = {
  reto: 'Reto',
  proyecto: 'Proyecto',
  gate_instancia: 'Gate',
  evidencia: 'Evidencia',
};

/** RF-01.6: quiénes consultan la auditoría — el admin del cliente (dueño de los datos)
 * y el lead de la boutique (operador del engagement). La UI deriva de aquí; la autoridad
 * es la política RLS de evento_dominio, que para los demás roles devuelve cero filas. */
export const ROLES_AUDITORIA = ['admin-cliente', 'lead-boutique'] as const;

/** Mismo bound que el CHECK de la tabla: el schema recorta y la base protege el SQL directo. */
export const CUERPO_MAX = 5000;

const CuerpoSchema = z
  .string()
  .trim()
  .min(1, 'El comentario no puede estar vacío')
  .max(CUERPO_MAX, `Máximo ${CUERPO_MAX} caracteres`);

export const ReferenciaObjetoSchema = z.object({
  tipo: z.enum(OBJETOS_CITABLES),
  id: z.string().uuid(),
});
export type ReferenciaObjeto = z.infer<typeof ReferenciaObjetoSchema>;

/** Abrir un hilo es indivisible de su primer comentario: un hilo vacío no dice nada
 * (y la base lo rechaza al commit). */
export const AbrirHiloSchema = z.object({
  workspaceId: z.string().uuid(),
  objeto: ReferenciaObjetoSchema,
  cuerpo: CuerpoSchema,
});
export type AbrirHilo = z.infer<typeof AbrirHiloSchema>;

export const ComentarSchema = z.object({
  workspaceId: z.string().uuid(),
  hiloId: z.string().uuid(),
  cuerpo: CuerpoSchema,
});
export type Comentar = z.infer<typeof ComentarSchema>;

export const ResolverHiloSchema = z.object({
  workspaceId: z.string().uuid(),
  hiloId: z.string().uuid(),
  accion: z.enum(['resolver', 'reabrir']),
});
export type ResolverHilo = z.infer<typeof ResolverHiloSchema>;

/** Los hilos de los objetos que una pantalla presenta, en UNA consulta (un snapshot):
 * la pantalla del método pide el proyecto y sus ocho gates de una vez. */
export const HilosInputSchema = z.object({
  workspaceId: z.string().uuid(),
  objetos: z.array(ReferenciaObjetoSchema).min(1).max(50),
});

export const AuditoriaInputSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Filtro por tipo de evento; ausente = todos. */
  tipo: z.string().trim().max(100).optional(),
  /** Cursor keyset: id del último evento devuelto — el server resuelve su (creado_en, id)
   * con la precisión de la base (serializar el timestamp perdería microsegundos y
   * saltaría o repetiría filas). */
  antesDe: z.string().uuid().optional(),
});

/** Comentario tal como lo ve el portal: identidad, ROL CONGELADO y timestamp (RF-01.5). */
export type ComentarioDeHilo = {
  id: string;
  cuerpo: string;
  autorNombre: string;
  autorRol: string;
  creadoEn: string;
};

export type HiloDeObjeto = {
  id: string;
  objetoTipo: ObjetoCitable;
  objetoId: string;
  estado: 'abierto' | 'resuelto';
  creadoEn: string;
  abiertoPorNombre: string;
  resueltoPorNombre: string | null;
  resueltoEn: string | null;
  comentarios: ComentarioDeHilo[];
  /** true si el hilo tiene más comentarios de los que caben en la proyección. */
  hayMasComentarios: boolean;
};

export type EventoAuditoria = {
  id: string;
  tipo: string;
  /** El payload es jsonb de forma LIBRE (cada evento trae lo suyo) y viaja como texto
   * JSON: la auditoría lo muestra verbatim, y así ninguna forma arbitraria rompe el
   * contrato serializable de la server function. Quien necesite estructura lo parsea. */
  payload: string;
  /** null = evento del sistema (sin actor humano); con actor pero sin nombre = quien lo
   * hizo ya no es miembro del workspace. El rol CONGELADO del evento sigue diciendo con
   * qué autoridad se hizo. */
  actorId: string | null;
  actorNombre: string | null;
  actorRol: string | null;
  creadoEn: string;
};

export type PaginaAuditoria = {
  eventos: EventoAuditoria[];
  hayMas: boolean;
  /** Tipos presentes en el workspace para el filtro (solo en la primera página). */
  tipos: string[];
};
