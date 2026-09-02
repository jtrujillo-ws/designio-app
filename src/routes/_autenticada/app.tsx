import { createFileRoute } from '@tanstack/react-router';
import { LoopScreen } from '@/components/loop/LoopScreen';
import { arbolDelWorkspace } from '@/lib/arbol/arbol.functions';

/**
 * Pantalla principal del workspace: el loop del método J1–J7 sobre el árbol real
 * (Cliente → Servicios → Retos → Proyectos, proyección de SPEC-02). El estado de los
 * journeys sigue siendo el del ejemplo §19 hasta que aterricen los gates (SPEC-04).
 */
export const Route = createFileRoute('/_autenticada/app')({
  loader: () => arbolDelWorkspace(),
  component: PantallaApp,
});

function PantallaApp() {
  const { usuario } = Route.useRouteContext();
  const arbol = Route.useLoaderData();
  return <LoopScreen usuario={usuario} arbol={arbol} />;
}
