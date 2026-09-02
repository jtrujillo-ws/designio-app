import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { usuarioActual } from '@/lib/auth/auth.functions';

/**
 * Layout guard: todo lo que cuelga de aquí exige sesión. El guard resuelve el usuario
 * (con sus membresías) una vez y lo publica en el contexto del router; las server
 * functions re-validan identidad por su cuenta — esto protege navegación, no datos.
 */
export const Route = createFileRoute('/_autenticada')({
  beforeLoad: async () => {
    const usuario = await usuarioActual();
    if (!usuario) throw redirect({ to: '/login' });
    return { usuario };
  },
  component: Outlet,
});
