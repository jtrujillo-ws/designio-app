import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId } from '@/lib/auth/guardia.server';
import { AprobacionesInputSchema } from './aprobaciones.schemas';
import { pendientesParaUsuario } from './aprobaciones.queries';

/**
 * Aprobaciones pendientes del rol de quien mira (la pantalla /aprobaciones). La lógica vive
 * en `pendientesParaUsuario` (testeable sin framework): capa 2 de estado de cuenta incluida.
 */
export const aprobacionesPendientes = createServerFn({ method: 'GET' })
  .inputValidator(AprobacionesInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await pendientesParaUsuario(usuarioId, data.workspaceId);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });
