/**
 * Workspace activo de la navegación (multi-membresía): el parámetro de búsqueda `ws`
 * elige entre las membresías del usuario, viaja pegado a toda la navegación interna
 * (retainSearchParams en el layout autenticado) y es deep-linkeable; si falta o no
 * corresponde a una membresía del usuario, se cae a la primera (orden por nombre).
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
