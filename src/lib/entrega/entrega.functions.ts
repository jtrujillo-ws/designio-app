import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  AgregarElementoSchema,
  AprobarDesignVersionSchema,
  AsignarElementoSchema,
  BorrarElementoSchema,
  ConstatarSchema,
  CrearDesignVersionSchema,
  DesasignarElementoSchema,
  DesignVersionInputSchema,
  DesplegarReleaseSchema,
  EditarElementoSchema,
  PlanificarReleaseSchema,
  ReleaseInputSchema,
  WorkspaceInputSchema,
} from './entrega.schemas';
import {
  agregarElemento,
  aprobarDesignVersion,
  asignarElemento,
  borrarElemento,
  cadenaDeRelease,
  constatarEffectiveState,
  crearDesignVersion,
  designVersionCompleta,
  designVersionsDelWorkspace,
  desasignarElemento,
  desplegarRelease,
  editarElemento,
  ErrorEntrega,
  planificarRelease,
  tableroDeConciliacion,
} from './entrega.servicio';

/** Server functions de la cadena de resultado. Mutaciones con contrato uniforme
 * {ok, …}; los loaders devuelven null cuando la cuenta ya no puede leer, para que la
 * pantalla se comporte como si el objeto no existiera en vez de reventar. */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorEntrega) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const err = e as { code?: string };
  if (err.code === '23505') return 'Ese registro ya existe';
  if (err.code === '23503') return 'Alguna referencia no existe en este workspace';
  if (err.code === '23514') return 'El registro no cumple las reglas del dominio';
  if (err.code === '42501') return 'Sin permiso para esta acción en el workspace';
  return null;
}

export const designVersionDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(DesignVersionInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await designVersionCompleta(usuarioId, data.workspaceId, data.designVersionId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const listaDeDesignVersions = createServerFn({ method: 'GET' })
  .inputValidator(WorkspaceInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await designVersionsDelWorkspace(usuarioId, data.workspaceId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return [];
      throw e;
    }
  });

export const conciliacionDeDesignVersion = createServerFn({ method: 'GET' })
  .inputValidator(DesignVersionInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await tableroDeConciliacion(usuarioId, data.workspaceId, data.designVersionId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

/** RF-06.9: la cadena en los dos sentidos desde un release. */
export const cadenaDelRelease = createServerFn({ method: 'GET' })
  .inputValidator(ReleaseInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await cadenaDeRelease(usuarioId, data.workspaceId, data.releaseId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const crearDesignVersionDelProyecto = createServerFn({ method: 'POST' })
  .inputValidator(CrearDesignVersionSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearDesignVersion(actorId, data);
      return { ok: true as const, designVersionId: r.designVersionId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const agregarElementoDeCambio = createServerFn({ method: 'POST' })
  .inputValidator(AgregarElementoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await agregarElemento(actorId, data);
      return { ok: true as const, elementoId: r.elementoId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const editarElementoDeCambio = createServerFn({ method: 'POST' })
  .inputValidator(EditarElementoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await editarElemento(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const borrarElementoDeCambio = createServerFn({ method: 'POST' })
  .inputValidator(BorrarElementoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await borrarElemento(actorId, data.workspaceId, data.elementoId);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const aprobarYCongelarDesignVersion = createServerFn({ method: 'POST' })
  .inputValidator(AprobarDesignVersionSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await aprobarDesignVersion(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const planificarReleaseDeDesignVersion = createServerFn({ method: 'POST' })
  .inputValidator(PlanificarReleaseSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await planificarRelease(actorId, data);
      return { ok: true as const, releaseId: r.releaseId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const asignarElementoARelease = createServerFn({ method: 'POST' })
  .inputValidator(AsignarElementoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await asignarElemento(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const quitarElementoDeRelease = createServerFn({ method: 'POST' })
  .inputValidator(DesasignarElementoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await desasignarElemento(actorId, data.workspaceId, data.elementoId);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const registrarDespliegue = createServerFn({ method: 'POST' })
  .inputValidator(DesplegarReleaseSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await desplegarRelease(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const constatarReleaseDesplegado = createServerFn({ method: 'POST' })
  .inputValidator(ConstatarSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await constatarEffectiveState(actorId, data);
      return { ok: true as const, effectiveStateId: r.effectiveStateId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
