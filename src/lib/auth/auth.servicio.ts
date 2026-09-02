import '@/lib/server-only';
import { conUsuario, sql } from '@/lib/db';
import type { InvitarMiembro } from './auth.schemas';
import {
  generarTokenInvitacion,
  hashPassword,
  hashTokenInvitacion,
  verificarPassword,
} from './password.server';

/**
 * Lógica de auth contra la base (testeable sin framework). El rol de aplicación no escribe
 * `usuario` directamente: login/invitación/activación pasan por las funciones SECURITY
 * DEFINER de la migración de auth; el resto corre bajo conUsuario (RLS).
 */

export type UsuarioSesion = { id: string; email: string; nombre: string };

export type MembresiaUsuario = { workspaceId: string; workspaceNombre: string; rol: string };

export class ErrorAutorizacion extends Error {}

/** Fallo de dominio en la invitación (p. ej. ya es miembro): mensaje apto para la UI. */
export class ErrorInvitacion extends Error {}

const ROLES_QUE_INVITAN = ['lead-boutique', 'admin-cliente'];

// Rama "usuario no existe / sin password": comparar contra un hash real de costo idéntico
// para no filtrar existencia de cuentas por timing.
let hashSenuelo: string | undefined;
async function compararConSenuelo(password: string): Promise<void> {
  hashSenuelo ??= await hashPassword('designio-senuelo-sin-cuenta');
  await verificarPassword(password, hashSenuelo);
}

/** Login: null si el email no existe, no está activo o la password no coincide. */
export async function autenticar(email: string, password: string): Promise<UsuarioSesion | null> {
  const [u] = await sql()`select * from usuario_para_login(${email})`;
  if (!u || !u.password_hash || u.estado !== 'activo') {
    await compararConSenuelo(password);
    return null;
  }
  const ok = await verificarPassword(password, u.password_hash as string);
  if (!ok) return null;
  return { id: u.id as string, email: u.email as string, nombre: u.nombre as string };
}

/** Perfil + membresías del usuario autenticado (bajo su propio contexto RLS). */
export async function usuarioConMembresias(
  usuarioId: string,
): Promise<(UsuarioSesion & { membresias: MembresiaUsuario[] }) | null> {
  return conUsuario(usuarioId, async (tx) => {
    const [u] = await tx`
      select id, email, nombre from usuario where id = ${usuarioId} and estado = 'activo'`;
    if (!u) return null;
    const filas = await tx`
      select m.workspace_id, w.nombre as workspace_nombre, m.rol
      from miembro m
      join workspace w on w.id = m.workspace_id
      where m.usuario_id = ${usuarioId}
      order by w.nombre`;
    return {
      id: u.id as string,
      email: u.email as string,
      nombre: u.nombre as string,
      membresias: filas.map((f) => ({
        workspaceId: f.workspace_id as string,
        workspaceNombre: f.workspace_nombre as string,
        rol: f.rol as string,
      })),
    };
  });
}

export type ResultadoInvitacion = {
  usuarioId: string;
  /** true mientras la cuenta global siga pendiente de que su dueño la active. */
  requiereActivacion: boolean;
  /** Enlace emitido en ESTA llamada; null si el token pendiente pertenece a otro workspace
   * (que la cuenta esté pendiente no da derecho a reclamarla) o si la cuenta ya está activa. */
  token: string | null;
  /** true si la persona ya era miembro y esto fue una re-emisión del enlace. */
  reemision: boolean;
};

/**
 * Miembros del workspace con el estado de su cuenta global (pantalla Personas, RF-01.4).
 * El estado sale de estados_de_miembros (SECURITY DEFINER): la RLS de usuario solo
 * muestra la fila propia — un join directo dejaría la lista en un solo miembro.
 */
export async function listarMiembros(
  actorId: string,
  workspaceId: string,
): Promise<import('./auth.schemas').MiembroDeLista[]> {
  return conUsuario(actorId, async (tx) => {
    const filas = await tx`
      select m.nombre, m.email, m.rol, e.estado
      from miembro m
      join estados_de_miembros(${workspaceId}) e on e.usuario_id = m.usuario_id
      where m.workspace_id = ${workspaceId}
      order by m.nombre`;
    return filas.map((f) => ({
      nombre: f.nombre as string,
      email: f.email as string,
      rol: f.rol as string,
      estado: f.estado as string,
    }));
  });
}

/**
 * Invitación (RF-01.2/01.4) en una transacción, con doble capa: re-check explícito del rol
 * del actor (capa 2) + política RLS de INSERT de miembro y autorización interna de
 * preparar_invitacion (capa 1). El token solo lo recibe el workspace que lo ORIGINÓ:
 * invitar un email pendiente de otro workspace agrega la membresía sin token (anti-takeover
 * cross-tenant) y sin pisar el enlace original. Re-invitar a un miembro propio aún pendiente
 * re-emite el enlace (recupera invitaciones perdidas o vencidas).
 */
export async function crearInvitacion(
  actorId: string,
  entrada: InvitarMiembro,
): Promise<ResultadoInvitacion> {
  const { token, tokenHash } = generarTokenInvitacion();
  const expira = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const resultado = await conUsuario(actorId, async (tx) => {
    // El JWT vive 7 días: una cuenta desactivada a mitad de sesión no debe seguir
    // mutando. Las mutaciones re-verifican el estado ACTUAL contra la base (la fila
    // propia es visible bajo RLS), no solo el sub del token.
    const [cuenta] = await tx`select estado from usuario where id = ${actorId}`;
    if ((cuenta?.estado as string | undefined) !== 'activo') {
      throw new ErrorAutorizacion('Tu cuenta no está activa');
    }
    const [actor] = await tx`select workspace_role(${actorId}, ${entrada.workspaceId}) as rol`;
    const rolActor = (actor?.rol ?? null) as string | null;
    if (!rolActor || !ROLES_QUE_INVITAN.includes(rolActor)) {
      throw new ErrorAutorizacion('Solo lead-boutique o admin-cliente pueden invitar miembros');
    }

    const [prep] = await tx`
      select usuario_id, requiere_activacion, token_emitido
      from preparar_invitacion(${entrada.email}, ${entrada.nombre}, ${tokenHash}, ${expira}, ${entrada.workspaceId})`;
    const usuarioId = prep!.usuario_id as string;
    const requiereActivacion = prep!.requiere_activacion as boolean;
    const tokenEmitido = prep!.token_emitido as boolean;

    const [yaMiembro] = await tx`
      select 1 as existe from miembro
      where workspace_id = ${entrada.workspaceId} and usuario_id = ${usuarioId}`;

    if (yaMiembro) {
      if (!tokenEmitido) {
        throw new ErrorInvitacion('Esa persona ya es miembro del workspace');
      }
      // Re-emisión: mismo miembro pendiente, enlace nuevo (el anterior queda invalidado).
      await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        values (${entrada.workspaceId}, 'InvitacionReemitida',
          ${tx.json({ email: entrada.email })}, ${actorId}, ${rolActor})`;
      return { usuarioId, requiereActivacion, tokenEmitido, reemision: true };
    }

    await tx`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${entrada.workspaceId}, ${usuarioId}, ${entrada.nombre}, ${entrada.email}, ${entrada.rol})`;

    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (
        ${entrada.workspaceId},
        'MiembroInvitado',
        ${tx.json({ email: entrada.email, rol: entrada.rol, requiereActivacion })},
        ${actorId},
        ${rolActor}
      )`;

    return { usuarioId, requiereActivacion, tokenEmitido, reemision: false };
  });

  return {
    usuarioId: resultado.usuarioId,
    requiereActivacion: resultado.requiereActivacion,
    token: resultado.tokenEmitido ? token : null,
    reemision: resultado.reemision,
  };
}

/** Consume un token de invitación vigente y deja la cuenta activa con esa password. */
export async function activarConToken(
  token: string,
  password: string,
): Promise<UsuarioSesion | null> {
  const tokenHash = hashTokenInvitacion(token);
  const passwordHash = await hashPassword(password);
  const [u] = await sql()`select * from activar_usuario_con_token(${tokenHash}, ${passwordHash})`;
  if (!u) return null;
  return { id: u.id as string, email: u.email as string, nombre: u.nombre as string };
}
