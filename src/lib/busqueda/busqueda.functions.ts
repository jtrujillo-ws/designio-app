import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId } from '@/lib/auth/guardia.server';
import { BusquedaInputSchema } from './busqueda.schemas';
import { buscarParaUsuario } from './busqueda.queries';

/** Búsqueda del workspace para el buscador de la barra superior. La lógica vive en las queries. */
export const buscarEnElWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(BusquedaInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await buscarParaUsuario(usuarioId, data.workspaceId, data.texto);
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return { resultados: [], hayMas: false };
      throw e;
    }
  });
