import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import { ArbolInputSchema, CrearServicioSchema } from './arbol.schemas';
import { arbolParaUsuario } from './arbol.queries';
import { crearServicio, ErrorArbol } from './arbol.servicio';

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

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorArbol) return e.message;
  if (e instanceof ErrorAutorizacion) return e.message;
  const err = e as { code?: string; message?: string };
  if (err.code === '42501') return 'Sin permiso para dar de alta servicios en este workspace';
  // Workspace archivado o borrado por disposición acordada: la base lo rechaza con DS001 y
  // un mensaje que ya dice qué pasó y cuándo; se entrega tal cual en vez de inventar otro.
  if (err.code === 'DS001' && err.message) return err.message;
  return null;
}

/** Alta de un servicio (SPEC-02, ADR-0002). Contrato uniforme {ok, …} como el resto de mutaciones. */
export const crearServicioDelWorkspace = createServerFn({ method: 'POST' })
  .inputValidator(CrearServicioSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearServicio(actorId, data);
      return { ok: true as const, servicioId: r.servicioId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
