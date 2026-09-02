import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import appCss from '@/styles/app.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      // El token de invitación viaja en la URL (/invitacion/$token): ningún recurso
      // de terceros (fuentes, etc.) debe recibirla como Referer.
      { name: 'referrer', content: 'same-origin' },
      { title: 'Designio' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="es">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
