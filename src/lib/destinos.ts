/**
 * Un destino navegable de la app, listo para `Link` o `navigate` (ver `EnlaceA`). Es un
 * nombre de ruta con sus parámetros y nada más: quien lo produce (una tarjeta del loop, un
 * resultado de búsqueda) no necesita saber cómo se navega, y quien navega no necesita saber
 * de dónde salió. Módulo compartido client/server: solo tipos y funciones puras.
 *
 * Las listas (evidencia, insights) admiten `destacar`: el id del elemento que se fue a
 * buscar. Sin él, «abrir la lista» desde un resultado dejaba al usuario en la primera página
 * sin ninguna pista de dónde estaba lo que encontró.
 */
export type Destino =
  | { to: '/app' }
  | { to: '/importacion' }
  | { to: '/evidencia'; search?: { destacar: string } }
  | { to: '/insights'; search?: { destacar: string } }
  | { to: '/journeys' }
  | { to: '/design-versions' }
  | { to: '/proyecto/$proyectoId'; params: { proyectoId: string } }
  | { to: '/journey/$journeyId'; params: { journeyId: string } }
  | { to: '/design-version/$designVersionId'; params: { designVersionId: string } };

/** Cómo se llama la pantalla a la que lleva un destino, para decirlo antes de hacer clic. */
export function etiquetaDeDestino(destino: Destino, codigo?: string): string {
  switch (destino.to) {
    case '/app':
      return 'Loop del método';
    case '/importacion':
      return 'Bandeja de importación';
    case '/evidencia':
      return 'Evidencia y derechos de uso';
    case '/insights':
      return 'Insights y citas';
    case '/journeys':
      return 'Journeys y blueprints';
    case '/design-versions':
      return 'Design versions y releases';
    case '/proyecto/$proyectoId':
      return codigo ? `Proyecto ${codigo}` : 'Proyecto';
    case '/journey/$journeyId':
      return codigo ? `Journey ${codigo}` : 'Journey';
    case '/design-version/$designVersionId':
      return codigo ? `Design version ${codigo}` : 'Design version';
  }
}
