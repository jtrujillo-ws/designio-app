import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId } from '@/lib/auth/guardia.server';
import { ResumenLoopInputSchema } from './loop.schemas';
import { resumenParaUsuario } from './loop.queries';

/**
 * Resumen del loop de un servicio (la pantalla Loop lo lee junto al árbol). La lógica vive
 * en `resumenParaUsuario` (testeable sin framework): capa 2 de estado de cuenta incluida.
 */
export const resumenDelLoop = createServerFn({ method: 'GET' })
  .inputValidator(ResumenLoopInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await resumenParaUsuario(usuarioId, data.workspaceId, data.servicioId);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });
