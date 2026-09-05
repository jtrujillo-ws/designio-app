import { createFileRoute } from '@tanstack/react-router';
import { LoopScreen, LoopSkeleton } from '@/components/loop/LoopScreen';
import { arbolDelWorkspace } from '@/lib/arbol/arbol.functions';
import { resumenDelLoop } from '@/lib/loop/loop.functions';

/**
 * Pantalla principal del workspace: el loop del método J1–J7 sobre el árbol real
 * (Cliente → Servicios → Retos → Proyectos, proyección de SPEC-02). El estado de los
 * journeys se deriva de los gates del proyecto actual (SPEC-04) en el resumen del loop,
 * que trae además lo que espera a alguien, el release vivo y las métricas del reto.
 */
export const Route = createFileRoute('/_autenticada/app')({
  // El árbol y el resumen son del workspace ACTIVO: el loader reacciona al cambio de `ws`.
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    if (!workspaceId) return { arbol: null, resumen: null };
    // Las dos proyecciones eligen «el primer servicio» con el mismo orden, así que pueden
    // pedirse a la vez sin que una tenga que esperar a la otra para saber de qué hablar.
    const [arbol, resumen] = await Promise.all([
      arbolDelWorkspace({ data: { workspaceId } }),
      resumenDelLoop({ data: { workspaceId } }),
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
