import { createServerFn } from '@tanstack/react-start';
import { conUsuario } from '@/lib/db';
import { requerirUsuarioId } from '@/lib/auth/guardia.server';
import { usuarioConMembresias } from '@/lib/auth/auth.servicio';
import { ArbolInputSchema } from './arbol.schemas';
import { construirArbol } from './arbol.queries';

/**
 * Árbol de navegación del workspace (proyección de lectura, SPEC-02).
 * Sin workspaceId explícito usa la primera membresía del usuario; con uno, verifica la
 * membresía (capa 2) antes de proyectar bajo el contexto RLS del usuario (capa 1).
 */
export const arbolDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(ArbolInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    const perfil = await usuarioConMembresias(usuarioId);
    if (!perfil || perfil.membresias.length === 0) return null;

    const workspaceId = data?.workspaceId ?? perfil.membresias[0]!.workspaceId;
    const membresia = perfil.membresias.find((m) => m.workspaceId === workspaceId);
    if (!membresia) throw new Error('Sin membresía en ese workspace');

    return conUsuario(usuarioId, (tx) =>
      construirArbol(tx, workspaceId, membresia.workspaceNombre),
    );
  });
