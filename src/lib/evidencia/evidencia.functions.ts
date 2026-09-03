import { createServerFn } from '@tanstack/react-start';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { requerirUsuarioId, usuarioIdDeRequest } from '@/lib/auth/guardia.server';
import {
  AdjuntarArchivoSchema,
  AprobarItemSchema,
  ArchivoInputSchema,
  BandejaInputSchema,
  CrearItemImportacionSchema,
  DecidirDerechosSchema,
  ItemInputSchema,
  RechazarItemSchema,
} from './evidencia.schemas';
import {
  adjuntarArchivo,
  aprobarItem,
  archivoParaDescarga,
  contenidoDeItem,
  crearItem,
  decidirDerechos,
  eliminarArchivo,
  ErrorCuraduria,
  listarBandeja,
  listarEvidencias,
  listarEvidenciaConDerechos,
  rechazarItem,
} from './evidencia.servicio';

/** Server functions de la bandeja de importación. Mutaciones con contrato uniforme {ok, …};
 * la lectura (loader) lanza, alimentando el redirect/error boundary del router. */

function mensajeDe(e: unknown): string | null {
  if (e instanceof ErrorCuraduria) return e.message;
  // Cuenta desactivada con JWT aún vigente (capa 2 del servicio).
  if (e instanceof ErrorAutorizacion) return e.message;
  const code = (e as { code?: string }).code;
  if (code === '42501') return 'Sin permiso para esta acción en el workspace';
  // AD003: aprobar un material heredado con texto sucio copiaría ese metadato al título de
  // la fuente y de la evidencia, donde no hay guard. El mensaje viene de la base y dice qué
  // hacer (rechazarlo y reimportar), así que se propaga tal cual.
  if (code === 'AD003') return (e as { message?: string }).message ?? null;
  // CHECK del esquema: es la última barrera y por eso su mensaje distingue de qué se
  // trata — el nombre del constraint dice si falló el bound del texto, el formato del
  // adjunto, su tamaño, su nombre o la coherencia entre extensión y formato.
  //
  // Este traductor es un CONSUMIDOR de cada restricción que se añade: un CHECK nuevo sin su
  // rama aquí cae en el genérico, y el genérico MIENTE — decía «supera los límites» cuando
  // lo que fallaba era que la extensión no casaba con el formato verificado. La base
  // rechaza bien y el producto explica mal, que es la versión suave del mismo defecto que
  // este slice persigue. Al añadir una restricción hay que pasar por aquí.
  if (code === '23514') {
    const constraint = (e as { constraint_name?: string }).constraint_name ?? '';
    if (constraint.startsWith('item_') && constraint.includes('limpi')) {
      return 'El material contiene caracteres de control o de dirección que no se aceptan';
    }
    if (constraint === 'archivo_tipo_permitido') return 'Formato de archivo no permitido';
    if (constraint === 'archivo_tamano') return 'El archivo está vacío o supera el tamaño máximo';
    if (constraint === 'archivo_nombre_seguro') return 'El nombre del archivo no es válido';
    if (constraint === 'archivo_extension_del_formato') {
      return 'La extensión del archivo no corresponde al formato verificado por sus bytes';
    }
    return 'El contenido supera los límites permitidos';
  }
  return null;
}

/** Bandeja del workspace indicado (el loader lo toma del contexto del guard: la
 * primera membresía — sin re-derivarlo aquí). RLS deja vacía la de un workspace ajeno. */
export const bandejaDeImportacion = createServerFn({ method: 'GET' })
  .inputValidator(BandejaInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      const bandeja = await listarBandeja(
        usuarioId,
        data.workspaceId,
        data.antesDe,
        data.antesDeDecidida,
      );
      return { workspaceId: data.workspaceId, ...bandeja };
    } catch (e) {
      // Cuenta desactivada con JWT aún vigente: sin datos, como si no hubiera sesión.
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

/** Contenido completo de un item para inspección previa a la decisión (RF-03.3). */
export const contenidoDeItemImportacion = createServerFn({ method: 'GET' })
  .inputValidator(ItemInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return { contenido: await contenidoDeItem(usuarioId, data.workspaceId, data.itemId) };
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

/** Evidencias del workspace para pickers de módulos citantes (checklists del método). */
export const evidenciasDelWorkspace = createServerFn({ method: 'GET' })
  .inputValidator(BandejaInputSchema.pick({ workspaceId: true }))
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await listarEvidencias(usuarioId, data.workspaceId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const crearItemImportacion = createServerFn({ method: 'POST' })
  .inputValidator(CrearItemImportacionSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await crearItem(actorId, data);
      return { ok: true as const, itemId: r.itemId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const aprobarItemImportacion = createServerFn({ method: 'POST' })
  .inputValidator(AprobarItemSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      const r = await aprobarItem(actorId, data);
      return { ok: true as const, evidenciaId: r.evidenciaId };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const rechazarItemImportacion = createServerFn({ method: 'POST' })
  .inputValidator(RechazarItemSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await rechazarItem(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

// ── Evidencia con derechos y adjuntos (RF-03.10, RF-03.1) ──

/** Evidencia del workspace con sus derechos VIVOS, su motivo de bloqueo y sus adjuntos.
 * `antesDe` es el cursor keyset (id de la última fila devuelta): toda la evidencia del
 * workspace tiene que ser alcanzable desde la pantalla que concede y revoca derechos. */
export const evidenciaConDerechos = createServerFn({ method: 'GET' })
  .inputValidator(BandejaInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      const datos = await listarEvidenciaConDerechos(usuarioId, data.workspaceId, data.antesDe);
      return { workspaceId: data.workspaceId, ...datos };
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const adjuntarArchivoAItem = createServerFn({ method: 'POST' })
  .inputValidator(AdjuntarArchivoSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      return { ok: true as const, ...(await adjuntarArchivo(actorId, data)) };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

export const retirarArchivoDeItem = createServerFn({ method: 'POST' })
  .inputValidator(ArchivoInputSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await eliminarArchivo(actorId, data.workspaceId, data.archivoId);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });

/** Bytes del adjunto en base64: el cliente los convierte en Blob para descargar o
 * previsualizar. No se expone una ruta HTTP de binarios — el acceso pasa por el mismo
 * camino (sesión → RLS) que el resto de los datos. */
export const contenidoDeArchivo = createServerFn({ method: 'GET' })
  .inputValidator(ArchivoInputSchema)
  .handler(async ({ data }) => {
    const usuarioId = await requerirUsuarioId();
    try {
      return await archivoParaDescarga(usuarioId, data.workspaceId, data.archivoId);
    } catch (e) {
      if (e instanceof ErrorAutorizacion) return null;
      throw e;
    }
  });

export const decidirDerechosDeEvidencia = createServerFn({ method: 'POST' })
  .inputValidator(DecidirDerechosSchema)
  .handler(async ({ data }) => {
    const actorId = await usuarioIdDeRequest();
    if (!actorId) return { ok: false as const, error: 'Tu sesión expiró: vuelve a entrar' };
    try {
      await decidirDerechos(actorId, data);
      return { ok: true as const };
    } catch (e) {
      const mensaje = mensajeDe(e);
      if (mensaje) return { ok: false as const, error: mensaje };
      throw e;
    }
  });
