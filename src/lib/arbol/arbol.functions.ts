import { createServerFn } from '@tanstack/react-start';
import { conUsuario } from '@/lib/db';
import { requerirUsuarioId } from '@/lib/auth/guardia.server';
import { ArbolInputSchema } from './arbol.schemas';
import { construirArbol } from './arbol.queries';

/**
 * Árbol de navegación del workspace (proyección de lectura, SPEC-02), en UNA
 * transacción: la membresía se resuelve bajo el propio RLS del usuario (la política de
 * workspace solo muestra los suyos — capa 1 y capa 2 a la vez) y el árbol se proyecta
 * en el mismo snapshot. Sin workspaceId explícito usa el primer workspace del usuario
 * ORDENADO POR NOMBRE (el mismo criterio que usuarioConMembresias/topbar).
 */
export const arbolDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(ArbolInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();

    return conUsuario(usuarioId, async (tx) => {
      const destino = data?.workspaceId
        ? await tx`select id, nombre from workspace where id = ${data.workspaceId}`
        : await tx`select w.id, w.nombre from workspace w
            join miembro m on m.workspace_id = w.id and m.usuario_id = ${usuarioId}
            order by w.nombre limit 1`;

      const ws = destino[0];
      if (!ws) {
        if (data?.workspaceId) throw new Error('Sin membresía en ese workspace');
        return null; // usuario sin workspaces todavía
      }
      return construirArbol(tx, ws.id as string, ws.nombre as string);
    });
  });
