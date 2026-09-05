import type { CSSProperties, ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { Destino } from '@/lib/destinos';

/**
 * Navegar a un `Destino`. El reparto por `to` no es adorno: el router tipa los `params` por
 * ruta, así que un destino con parámetros no se puede pasar a ciegas. `ws` viaja solo
 * (retainSearchParams en /_autenticada), como en cualquier Link interno.
 */
export function navegarA(navigate: ReturnType<typeof useNavigate>, destino: Destino) {
  switch (destino.to) {
    case '/proyecto/$proyectoId':
    case '/journey/$journeyId':
    case '/design-version/$designVersionId':
      return navigate({ to: destino.to, params: destino.params });
    default:
      return navigate({ to: destino.to });
  }
}

/** El `Link` que corresponde a un destino, con el mismo reparto que `navegarA`. */
export function EnlaceA({
  destino,
  style,
  children,
  ...resto
}: {
  destino: Destino;
  style?: CSSProperties;
  children: ReactNode;
  'aria-label'?: string;
  title?: string;
}) {
  switch (destino.to) {
    case '/proyecto/$proyectoId':
    case '/journey/$journeyId':
    case '/design-version/$designVersionId':
      return (
        <Link to={destino.to} params={destino.params} style={style} {...resto}>
          {children}
        </Link>
      );
    default:
      return (
        <Link to={destino.to} style={style} {...resto}>
          {children}
        </Link>
      );
  }
}
