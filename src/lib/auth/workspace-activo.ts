/**
 * Workspace activo de la navegación (multi-membresía): el parámetro de búsqueda `ws`
 * elige entre las membresías del usuario, viaja pegado a toda la navegación interna
 * (retainSearchParams en el layout autenticado) y es deep-linkeable; si falta o no
 * corresponde a una membresía del usuario, se cae a la PRIMERA del arreglo recibido
 * (esta función no ordena: usuarioConMembresias las entrega ordenadas por nombre).
 *
 * Solo informa NAVEGACIÓN: cada server function re-valida el workspaceId recibido
 * contra la membresía real vía RLS — un `ws` forjado solo produce pantallas vacías.
 *
 * Módulo compartido (rutas + UI): sin imports de servidor.
 */

const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normaliza el valor crudo del search param: solo un uuid bien formado cuenta. */
export function wsDeBusqueda(valor: unknown): string | undefined {
  return typeof valor === 'string' && ES_UUID.test(valor) ? valor : undefined;
}

/** La membresía que gobierna la sesión de navegación: la pedida por `ws` o la primera. */
export function membresiaActivaDe<M extends { workspaceId: string }>(
  membresias: readonly M[],
  ws: string | undefined,
): M | undefined {
  return membresias.find((m) => m.workspaceId === ws) ?? membresias[0];
}

/**
 * Si la dirección pedía un workspace que NO es ninguno de los tuyos, y por tanto el activo lo
 * eligió la caída de arriba y no quien navega.
 *
 * La caída es la conducta correcta para navegar —entrar por un enlace viejo no debería dejarte
 * en una pantalla vacía— pero es SILENCIOSA, y hay una pantalla donde el silencio no vale: la
 * de la disposición. Recargar después de borrar el workspace que iba en la URL te deja en otro,
 * con el mismo aspecto y los mismos botones, y uno de esos botones destruye. Que la pantalla
 * pueda decirlo depende de poder preguntarlo, y eso se pregunta aquí.
 *
 * Con CERO membresías no hay sustitución que avisar: no se cayó a ninguna parte, y de eso ya
 * habla la pantalla por su cuenta.
 */
export function elWorkspacePedidoNoEsElActivo<M extends { workspaceId: string }>(
  membresias: readonly M[],
  ws: string | undefined,
): boolean {
  return ws !== undefined && membresias.length > 0 && !membresias.some((m) => m.workspaceId === ws);
}
