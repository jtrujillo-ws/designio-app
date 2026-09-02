import { createServerFn } from '@tanstack/react-start';
import { deleteCookie, getRequestIP, setCookie } from '@tanstack/react-start/server';
import { usuarioIdDeRequest } from './guardia.server';
import {
  EstablecerPasswordSchema,
  InvitarMiembroSchema,
  LoginSchema,
  MiembrosInputSchema,
} from './auth.schemas';
import {
  activarConToken,
  autenticar,
  crearInvitacion,
  ErrorAutorizacion,
  ErrorInvitacion,
  listarMiembros,
  usuarioConMembresias,
} from './auth.servicio';
import { descontarIntento, permitirIntento, registrarExito } from './limitador.server';
import { COOKIE_SESION, DURACION_SESION_S, firmarSesion } from './sesion.server';

/** Server functions de auth. Convención dura: este módulo solo exporta server functions. */

const ERROR_LIMITE = 'Demasiados intentos; espera unos minutos e intenta de nuevo';

async function fijarCookieSesion(usuarioId: string): Promise<void> {
  setCookie(COOKIE_SESION, await firmarSesion(usuarioId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: DURACION_SESION_S,
  });
}

function ipDelRequest(): string {
  return getRequestIP({ xForwardedFor: true }) ?? 'desconocida';
}

export const iniciarSesion = createServerFn({ method: 'POST' })
  .inputValidator(LoginSchema)
  .handler(async ({ data }) => {
    // Fricción anti fuerza bruta (por cuenta y por origen); el email ya viene normalizado.
    // Sin short-circuit: AMBOS contadores avanzan en cada intento — insistir sobre una
    // cuenta ya bloqueada también gasta el cupo de la IP.
    const clavePorEmail = `login:email:${data.email}`;
    const clavePorIp = `login:ip:${ipDelRequest()}`;
    const permitidoEmail = permitirIntento(clavePorEmail, 10);
    const permitidoIp = permitirIntento(clavePorIp, 30);
    if (!permitidoEmail || !permitidoIp) {
      return { ok: false as const, error: ERROR_LIMITE };
    }
    const usuario = await autenticar(data.email, data.password);
    if (!usuario) {
      // Fallo de dominio, no de transporte: mismo mensaje exista o no la cuenta.
      return { ok: false as const, error: 'Correo o contraseña incorrectos' };
    }
    // El éxito limpia la ventana de la cuenta y se descuenta del cupo de la IP:
    // una oficina tras un NAT con muchos logins válidos jamás se bloquea, pero un
    // atacante no puede lavar sus fallos acumulados con un login propio.
    registrarExito(clavePorEmail);
    descontarIntento(clavePorIp);
    await fijarCookieSesion(usuario.id);
    return { ok: true as const, usuario };
  });

export const cerrarSesion = createServerFn({ method: 'POST' }).handler(async () => {
  deleteCookie(COOKIE_SESION, { path: '/' });
  return { ok: true as const };
});

/** Usuario de la sesión actual (o null): lo usan los guards de rutas y la topbar. */
export const usuarioActual = createServerFn({ method: 'GET' }).handler(async () => {
  const usuarioId = await usuarioIdDeRequest();
  if (!usuarioId) return null;
  return usuarioConMembresias(usuarioId);
});

export const establecerPassword = createServerFn({ method: 'POST' })
  .inputValidator(EstablecerPasswordSchema)
  .handler(async ({ data }) => {
    // El token es aleatorio de 256 bits; el límite aquí evita gasto de CPU (bcrypt) al azar.
    const clavePorIp = `activar:ip:${ipDelRequest()}`;
    if (!permitirIntento(clavePorIp, 30)) {
      return { ok: false as const, error: ERROR_LIMITE };
    }
    const usuario = await activarConToken(data.token, data.password);
    if (!usuario) {
      return { ok: false as const, error: 'La invitación no es válida o ya expiró' };
    }
    // Las activaciones válidas no consumen cupo (misma lógica que el login).
    descontarIntento(clavePorIp);
    await fijarCookieSesion(usuario.id);
    return { ok: true as const, usuario };
  });

/** Miembros del workspace para la pantalla Personas (el loader pasa el workspace del guard). */
export const miembrosDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(MiembrosInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await usuarioIdDeRequest();
    if (!usuarioId) return null;
    return listarMiembros(usuarioId, data.workspaceId);
  });

export const invitarMiembro = createServerFn({ method: 'POST' })
  .inputValidator(InvitarMiembroSchema)
  .handler(async ({ data }) => {
    // Contrato uniforme de las MUTACIONES: siempre {ok, ...} — sin sesión incluido
    // (en loaders/guards de ruta sí se lanza: ahí el throw alimenta el redirect).
    const actorId = await usuarioIdDeRequest();
    if (!actorId) {
      return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    }
    try {
      const r = await crearInvitacion(actorId, data);
      // MVP sin correo saliente: cuando esta llamada emite un enlace, se le entrega a quien
      // invita para compartirlo (el envío por email llega con el portal completo de SPEC-01).
      const detalle = r.token
        ? r.reemision
          ? 'Invitación re-emitida: comparte el enlace nuevo (el anterior quedó invalidado)'
          : 'Invitación creada: comparte el enlace para que active su cuenta'
        : r.requiereActivacion
          ? 'Su cuenta está pendiente de activar por una invitación de otro workspace; verá este workspace al activarla'
          : 'Ya tiene cuenta activa: el workspace le queda disponible de inmediato';
      return {
        ok: true as const,
        requiereActivacion: r.requiereActivacion,
        enlace: r.token ? `/invitacion/${r.token}` : null,
        detalle,
      };
    } catch (e) {
      if (e instanceof ErrorAutorizacion || e instanceof ErrorInvitacion) {
        return { ok: false as const, error: e.message };
      }
      const err = e as { code?: string; constraint_name?: string };
      if (err.code === '23505') {
        // Carrera restante: dos invitaciones simultáneas. La constraint dice cuál fue.
        return err.constraint_name === 'usuario_email_unico'
          ? { ok: false as const, error: 'Dos invitaciones simultáneas para ese correo; intenta de nuevo' }
          : { ok: false as const, error: 'Esa persona ya es miembro del workspace' };
      }
      if (err.code === '42501') {
        return { ok: false as const, error: 'Sin permiso para invitar en este workspace' };
      }
      throw e;
    }
  });
