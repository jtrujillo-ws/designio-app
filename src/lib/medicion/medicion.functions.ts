import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  CargarCsvSchema,
  CompletarReviewSchema,
  CrearEntradaSchema,
  EditarEntradaSchema,
  RegistrarSnapshotSchema,
  RegistryInputSchema,
  ResultadoCriterioSchema,
  RetoInputSchema,
  SeguimientoInputSchema,
} from './medicion.schemas';
import {
  abrirMedicion,
  abrirOutcomeReview,
  abrirRegistry,
  agregarEntrada,
  cargarSnapshotsCsv,
  completarOutcomeReview,
  editarEntrada,
  ErrorMedicion,
  firmarRegistry,
  registrarResultado,
  pausarProyecto,
  retomarProyecto,
  registrarSnapshot,
  seguimientoDeImpacto,
} from './medicion.servicio';

/** Server functions de la medición. Mutaciones con contrato uniforme {ok, …}; el loader
 * devuelve null ante una cuenta desactivada con sesión viva. */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorMedicion) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const err = e as { code?: string };
  if (err.code === '23505') return 'Ese valor ya existe en el workspace';
  if (err.code === '23503') return 'Alguna referencia no existe en este workspace';
  if (err.code === '23514') return 'Los datos no cumplen una regla del dominio';
  if (err.code === '42501') return 'Sin permiso para esta acción en el workspace';
  return null;
}

export const seguimientoDelProyecto = createServerFn({ method: 'GET' })
  .inputValidator(SeguimientoInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await seguimientoDeImpacto(usuarioId, data.workspaceId, data.proyectoId);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const abrirRegistryDeReto = createServerFn({ method: 'POST' })
  .inputValidator(RetoInputSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await abrirRegistry(actorId, data);
      return { ok: true as const, registryId: r.registryId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const agregarEntradaKpi = createServerFn({ method: 'POST' })
  .inputValidator(CrearEntradaSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await agregarEntrada(actorId, data);
      return { ok: true as const, entradaId: r.entradaId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const editarEntradaKpi = createServerFn({ method: 'POST' })
  .inputValidator(EditarEntradaSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await editarEntrada(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const firmarMetricRegistry = createServerFn({ method: 'POST' })
  .inputValidator(RegistryInputSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await firmarRegistry(actorId, data);
      return { ok: true as const, entradas: r.entradas };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const abrirMedicionDelReto = createServerFn({ method: 'POST' })
  .inputValidator(RetoInputSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await abrirMedicion(actorId, data);
      return { ok: true as const, proyectos: r.proyectos };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const pausarProyectoDelReto = createServerFn({ method: 'POST' })
  .inputValidator(SeguimientoInputSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await pausarProyecto(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const retomarProyectoDelReto = createServerFn({ method: 'POST' })
  .inputValidator(SeguimientoInputSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await retomarProyecto(actorId, data);
      return { ok: true as const, estado: r.estado };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const cargarSnapshotDeFormulario = createServerFn({ method: 'POST' })
  .inputValidator(RegistrarSnapshotSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await registrarSnapshot(actorId, data);
      return { ok: true as const, snapshotId: r.snapshotId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const cargarSnapshotsPegados = createServerFn({ method: 'POST' })
  .inputValidator(CargarCsvSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await cargarSnapshotsCsv(actorId, data);
      // Éxito PARCIAL: las filas válidas entraron y las rechazadas vuelven con su motivo
      // (criterio de aceptación 1) — no es un error, es el resultado de la carga.
      // `csvRestante` es el texto que queda por reintentar —cabecera y filas rechazadas—,
      // construido donde viven las reglas del parseo. Dejar el CSV entero en la pantalla
      // invitaba a reenviar filas que ya habían entrado.
      return {
        ok: true as const,
        insertados: r.insertados,
        rechazadas: r.rechazadas,
        csvRestante: r.csvRestante,
      };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const abrirReviewDelReto = createServerFn({ method: 'POST' })
  .inputValidator(RetoInputSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await abrirOutcomeReview(actorId, data);
      return { ok: true as const, reviewId: r.reviewId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const guardarResultadoDeCriterio = createServerFn({ method: 'POST' })
  .inputValidator(ResultadoCriterioSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await registrarResultado(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const completarReviewDelReto = createServerFn({ method: 'POST' })
  .inputValidator(CompletarReviewSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await completarOutcomeReview(actorId, data);
      return { ok: true as const, veredicto: r.veredicto };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
