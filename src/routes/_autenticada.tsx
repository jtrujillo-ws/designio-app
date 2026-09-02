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

/**
 * Cambiar de workspace REMONTA todo lo que cuelga de aquí, y esa es la única razón de que
 * este componente exista en vez de usar `Outlet` a secas.
 *
 * Cambiar de workspace es `navigate({ to: '.', search })` sobre la MISMA ruta: React no
 * desmonta nada, así que los loaders se rehacen con el `ws` nuevo mientras todo el
 * `useState` de la pantalla sobrevive al workspace del que hablaba. Eso no es una
 * incomodidad de refresco: es estado de un cliente pintado o enviado bajo otro. Ya se ha
 * cobrado tres piezas en pantallas distintas —un aviso del workspace anterior leído sobre
 * el de al lado, un id de ancla que ya no está en la lista, y una paginación que mezcla la
 * primera página nueva con el cursor de la vieja y se queda muda porque ese cursor no
 * existe aquí—, y las tres son la misma: identidad de abajo cambiada, estado de arriba
 * intacto.
 *
 * La `key` es la membresía RESUELTA, no el `ws` crudo: `membresiaActivaDe` cae a la
 * primera membresía cuando el parámetro falta o no corresponde, así que entrar sin `ws` y
 * luego fijarlo explícitamente al MISMO workspace no debe remontar nada — no ha cambiado
 * el workspace, solo cómo se escribe en la URL.
 *
 * Se pone aquí, en el layout, y no en cada pantalla: una `key` por ruta es una promesa que
 * hay que acordarse de repetir en la siguiente que se escriba, y ya hay siete pantallas
 * vivas con estado propio. Aquí no hay nada que recordar — la pantalla que se añada mañana
 * nace protegida.
 */
function LayoutPorWorkspace() {
  const { membresiaActiva } = Route.useRouteContext();
  return <Outlet key={membresiaActiva?.workspaceId ?? 'sin-workspace'} />;
}

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
  component: LayoutPorWorkspace,
});
