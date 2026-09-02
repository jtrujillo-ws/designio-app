import { createFileRoute, Outlet, redirect, retainSearchParams } from '@tanstack/react-router';
import { usuarioActual } from '@/lib/auth/auth.functions';
import { membresiaActivaDe, wsDeBusqueda } from '@/lib/auth/workspace-activo';

/**
 * Layout guard: todo lo que cuelga de aquí exige sesión. El guard resuelve el usuario
 * (con sus membresías) una vez y lo publica en el contexto del router; las server
 * functions re-validan identidad por su cuenta — esto protege navegación, no datos.
 *
 * `ws` es el workspace activo de la navegación (deep-linkeable y pegajoso en todos
 * los Links internos vía retainSearchParams): las pantallas leen `membresiaActiva`
 * del contexto en lugar de asumir la primera membresía.
 */
export const Route = createFileRoute('/_autenticada')({
  validateSearch: (search: Record<string, unknown>): { ws?: string } => {
    const ws = wsDeBusqueda(search.ws);
    // Propiedad AUSENTE (no undefined): así `search` es opcional para quien navega
    // sin workspace explícito (login → /app, links del árbol, etc.).
    return ws ? { ws } : {};
  },
  search: { middlewares: [retainSearchParams(['ws'])] },
  beforeLoad: async ({ search }) => {
    const usuario = await usuarioActual();
    if (!usuario) throw redirect({ to: '/login' });
    return { usuario, membresiaActiva: membresiaActivaDe(usuario.membresias, search.ws) };
  },
  component: Outlet,
});
