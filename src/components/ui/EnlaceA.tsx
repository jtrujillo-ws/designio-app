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
    case '/evidencia':
    case '/insights':
      return navigate({ to: destino.to, search: destino.search ?? {} });
    default:
      return navigate({ to: destino.to });
  }
}

/** Lo que una fila de resultados o una tarjeta necesitan poder poner sobre el enlace. */
type PropsDeEnlace = {
  style?: CSSProperties;
  children: ReactNode;
  id?: string;
  role?: 'option';
  'aria-selected'?: boolean;
  'aria-label'?: string;
  title?: string;
  onMouseEnter?: () => void;
};

/** El `Link` que corresponde a un destino, con el mismo reparto que `navegarA`. */
export function EnlaceA({ destino, children, ...resto }: { destino: Destino } & PropsDeEnlace) {
  switch (destino.to) {
    case '/proyecto/$proyectoId':
    case '/journey/$journeyId':
    case '/design-version/$designVersionId':
      return (
        <Link to={destino.to} params={destino.params} {...resto}>
          {children}
        </Link>
      );
    case '/evidencia':
    case '/insights':
      return (
        <Link to={destino.to} search={destino.search ?? {}} {...resto}>
          {children}
        </Link>
      );
    default:
      return (
        <Link to={destino.to} {...resto}>
          {children}
        </Link>
      );
  }
}
