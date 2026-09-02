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

/**
 * Invitación (RF-01.2/01.4): alta o reutilización del usuario + membresía + auditoría, en una
 * transacción. Capa 2: re-check explícito del rol del actor; capa 1: la política de INSERT de
 * miembro rechaza el mismo intento aunque la capa 2 fallara.
 */
export async function crearInvitacion(
  actorId: string,
  entrada: InvitarMiembro,
): Promise<{ usuarioId: string; requiereActivacion: boolean; token: string | null }> {
  const { token, tokenHash } = generarTokenInvitacion();
  const expira = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const resultado = await conUsuario(actorId, async (tx) => {
    const [actor] = await tx`select workspace_role(${actorId}, ${entrada.workspaceId}) as rol`;
    const rolActor = (actor?.rol ?? null) as string | null;
    if (!rolActor || !ROLES_QUE_INVITAN.includes(rolActor)) {
      throw new ErrorAutorizacion('Solo lead-boutique o admin-cliente pueden invitar miembros');
    }

    const [prep] = await tx`
      select usuario_id, requiere_activacion
      from preparar_invitacion(${entrada.email}, ${entrada.nombre}, ${tokenHash}, ${expira})`;
    const usuarioId = prep!.usuario_id as string;
    const requiereActivacion = prep!.requiere_activacion as boolean;

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

    return { usuarioId, requiereActivacion };
  });

  return { ...resultado, token: resultado.requiereActivacion ? token : null };
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
