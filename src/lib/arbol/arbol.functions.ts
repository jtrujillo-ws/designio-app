import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId } from '@/lib/auth/guardia.server';
import { ArbolInputSchema } from './arbol.schemas';
import { arbolParaUsuario } from './arbol.queries';

/**
 * Árbol de navegación del workspace (proyección de lectura, SPEC-02). La lógica vive
 * en arbolParaUsuario (testeable sin framework): capa 2 de estado de cuenta incluida.
 */
export const arbolDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(ArbolInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await arbolParaUsuario(usuarioId, data?.workspaceId);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });
