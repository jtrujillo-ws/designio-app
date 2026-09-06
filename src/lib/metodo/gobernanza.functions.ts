import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import { ProyectoInputSchema } from './metodo.schemas';
import {
  ApoyarArquetipoSchema,
  CrearArquetipoSchema,
  ReabrirEtapaSchema,
  RegistrarDecisionSchema,
  RevalidarDecisionSchema,
  VeredictoArquetipoSchema,
} from './gobernanza.schemas';
import {
  apoyarArquetipo,
  crearArquetipo,
  darVeredictoArquetipo,
  ErrorGobernanza,
  escribirRevisionAMano,
  EscribirRevisionAManoSchema,
  gobernanzaDeProyecto,
  reabrirEtapa,
  registrarDecision,
  revalidarDecision,
} from './gobernanza.servicio';

/** Server functions de gobernanza (decisiones, arquetipos, reaperturas). */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorGobernanza) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const err = e as { code?: string };
  if (err.code === '23505') return 'Ese elemento ya existe';
  if (err.code === '23503') return 'Alguna referencia no existe en este workspace';
  if (err.code === '42501') return 'Sin permiso para esta acción en el workspace';
  return null;
}

export const gobernanzaDelProyecto = createServerFn({ method: 'GET' })
  .inputValidator(ProyectoInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await gobernanzaDeProyecto(usuarioId, data.workspaceId, data.proyectoId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const aprobarDecision = createServerFn({ method: 'POST' })
  .inputValidator(RegistrarDecisionSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await registrarDecision(actorId, data);
      return { ok: true as const, decisionId: r.decisionId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const revalidarDecisionRevisada = createServerFn({ method: 'POST' })
  .inputValidator(RevalidarDecisionSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await revalidarDecision(actorId, data.workspaceId, data.decisionId);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const definirArquetipo = createServerFn({ method: 'POST' })
  .inputValidator(CrearArquetipoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearArquetipo(actorId, data);
      return { ok: true as const, arquetipoId: r.arquetipoId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const enlazarEvidenciaArquetipo = createServerFn({ method: 'POST' })
  .inputValidator(ApoyarArquetipoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await apoyarArquetipo(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const veredictoDeArquetipo = createServerFn({ method: 'POST' })
  .inputValidator(VeredictoArquetipoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await darVeredictoArquetipo(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const reabrirEtapaDelProyecto = createServerFn({ method: 'POST' })
  .inputValidator(ReabrirEtapaSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await reabrirEtapa(actorId, data);
      return { ok: true as const, decisionesMarcadas: r.decisionesMarcadas };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

/**
 * La ruta manual de C4 (SYS-21): escribir la revisión simulada sin pasar por el proveedor.
 *
 * El validador es el mismo esquema que gobierna lo que devuelve el modelo, así que un mensaje
 * de error aquí es el mismo que allí. Lo que la base rechace —lente refutada, concepto ya
 * decidido, lente que ya leyó este concepto— vuelve traducido por `ErrorGobernanza`.
 */
export const escribirRevisionSimuladaAMano = createServerFn({ method: 'POST' })
  .inputValidator(EscribirRevisionAManoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await escribirRevisionAMano(actorId, data);
      return { ok: true as const, revisionId: r.revisionId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
