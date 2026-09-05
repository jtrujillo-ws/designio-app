import { createFileRoute } from '@tanstack/react-router';
import { LoopScreen, LoopSkeleton } from '@/components/loop/LoopScreen';
import { arbolDelWorkspace } from '@/lib/arbol/arbol.functions';
import { resumenDelLoop } from '@/lib/loop/loop.functions';
import { wsDeBusqueda } from '@/lib/auth/workspace-activo';

/**
 * Pantalla principal del workspace: el loop del método J1–J7 sobre el árbol real
 * (Cliente → Servicios → Retos → Proyectos, proyección de SPEC-02). El estado de los
 * journeys se deriva de los gates del proyecto actual (SPEC-04) en el resumen del loop,
 * que trae además lo que espera a alguien, el release vivo y las métricas del reto.
 */
export const Route = createFileRoute('/_autenticada/app')({
  // El servicio seleccionado es estado de la RUTA (`?servicio=`), no de la UI: se comparte,
  // se recarga y sobrevive a la navegación. Solo cuenta un uuid bien formado; si no es de
  // este workspace, la proyección se cae al primero y la pantalla también.
  validateSearch: (search: Record<string, unknown>): { servicio?: string } => {
    const servicio = wsDeBusqueda(search.servicio);
    return servicio ? { servicio } : {};
  },
  // El árbol y el resumen son del workspace ACTIVO y del servicio pedido: el loader
  // reacciona a los dos.
  loaderDeps: ({ search }) => ({ ws: search.ws, servicio: search.servicio }),
  loader: async ({ context, deps }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    if (!workspaceId) return { arbol: null, resumen: null };
    // Las dos proyecciones eligen el servicio con la misma regla (el pedido, o el primero
    // con el mismo orden), así que pueden pedirse a la vez.
    const [arbol, resumen] = await Promise.all([
      arbolDelWorkspace({ data: { workspaceId } }),
      resumenDelLoop({ data: { workspaceId, servicioId: deps.servicio } }),
    ]);
    return { arbol, resumen };
  },
  pendingComponent: LoopSkeleton,
  component: PantallaApp,
});

function PantallaApp() {
  const { usuario, membresiaActiva } = Route.useRouteContext();
  const { arbol, resumen } = Route.useLoaderData();
  return (
    <LoopScreen
      usuario={usuario}
      membresiaActiva={membresiaActiva}
      arbol={arbol}
      resumen={resumen}
    />
  );
}
