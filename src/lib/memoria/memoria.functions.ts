import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId } from '@/lib/auth/guardia.server';
import { MemoriaInputSchema } from './memoria.schemas';
import { memoriaParaUsuario } from './memoria.queries';

/**
 * La memoria del workspace para la Biblioteca del cliente (proyección de lectura, CTX-01).
 * La lógica vive en memoriaParaUsuario (testeable sin framework): capa 2 de estado de
 * cuenta incluida.
 */
export const memoriaDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(MemoriaInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await memoriaParaUsuario(usuarioId, data.workspaceId);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });
