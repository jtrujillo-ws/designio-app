import { createFileRoute } from '@tanstack/react-router';
import { LoopScreen } from '@/components/loop/LoopScreen';

/**
 * Pantalla principal del workspace: el loop del método J1–J7.
 * Datos estáticos del ejemplo §19 por ahora; el estado real se derivará de los
 * gates del reto activo cuando aterricen los módulos de método (SPEC-04).
 */
export const Route = createFileRoute('/_autenticada/app')({
  component: PantallaApp,
});

function PantallaApp() {
  const { usuario } = Route.useRouteContext();
  return <LoopScreen usuario={usuario} />;
}
