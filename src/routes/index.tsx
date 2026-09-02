import { createFileRoute, redirect } from '@tanstack/react-router';

/** La raíz siempre entra al workspace; el guard de /_autenticada manda a /login si no hay sesión. */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/app' });
  },
});
