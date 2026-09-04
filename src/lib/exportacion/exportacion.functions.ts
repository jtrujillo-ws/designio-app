import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import { ExportarSchema } from './exportacion.schemas';
import { ErrorExportacion, exportarWorkspace } from './exportacion.servicio';

/**
 * Exportación como MUTACIÓN (POST) y no como loader: no es una lectura de pantalla — deja
 * un registro de auditoría en la base (RF-01.8 «ejecución registrada») y por eso no debe
 * dispararse sola al navegar ni repetirse con cada invalidación del router.
 */
export const exportarWorkspaceFn = createServerFn({ method: 'POST' })
  .inputValidator(ExportarSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      return { ok: true as const, exportacion: await exportarWorkspace(actorId, data) };
    } catch (e) {
      if (e instanceof ErrorExportacion || e instanceof ErrorAutorizacion) {
        return { ok: false as const, error: e.message };
      }
      // Por lo mismo que en el servicio: el rechazo por CUENTA trae su propio motivo, y el
      // mensaje de permiso manda a mirar donde no es.
      const err = e as { code?: string; message?: string };
      if (err.code === 'DS005' && err.message) {
        return { ok: false as const, error: err.message };
      }
      if (err.code === '42501') {
        return { ok: false as const, error: 'Sin permiso para exportar este workspace' };
      }
      throw e;
    }
  });
