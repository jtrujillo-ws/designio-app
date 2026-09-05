import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  CrearSegmentoSchema,
  EditarSegmentoSchema,
  SegmentosInputSchema,
} from './segmento.schemas';
import { segmentosParaUsuario } from './segmento.queries';
import { crearSegmento, editarSegmento, ErrorSegmento } from './segmento.servicio';

/**
 * Segmentos del workspace con su cobertura de research (RF-01.7). La lógica vive en las
 * queries (testeable sin framework): capa 2 de estado de cuenta incluida.
 */
export const segmentosDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(SegmentosInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await segmentosParaUsuario(usuarioId, data.workspaceId);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorSegmento) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const err = e as { code?: string; message?: string };
  if (err.code === '42501') return 'Sin permiso para escribir segmentos en este workspace';
  // Workspace archivado o borrado por disposición acordada: la base lo rechaza con DS001 y
  // un mensaje que ya dice qué pasó y cuándo; se entrega tal cual en vez de inventar otro.
  if (err.code === 'DS001' && err.message) return err.message;
  return null;
}

/** Alta de un segmento. Contrato uniforme {ok, …} como el resto de mutaciones. */
export const crearSegmentoDelWorkspace = createServerFn({ method: 'POST' })
  .inputValidator(CrearSegmentoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearSegmento(actorId, data);
      return { ok: true as const, segmentoId: r.segmentoId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

/** Edición de nombre y definición de un segmento existente. */
export const editarSegmentoDelWorkspace = createServerFn({ method: 'POST' })
  .inputValidator(EditarSegmentoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await editarSegmento(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
