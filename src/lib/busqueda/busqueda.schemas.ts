import { z } from 'zod';
import type { Destino } from '@/lib/destinos';

/**
 * Búsqueda del workspace: lo que el buscador de la barra superior manda y recibe. Módulo
 * compartido client/server: solo tipos, contratos y funciones puras.
 */

/** Por debajo de esto no se consulta: una letra casa con todo y no ayuda a nadie. */
export const MIN_CARACTERES = 2;
export const MAX_CARACTERES = 100;
/** Tope por clase y tope total: el buscador orienta, no lista. */
export const MAX_POR_CLASE = 5;
export const MAX_RESULTADOS = 20;

export const BusquedaInputSchema = z.object({
  workspaceId: z.string().uuid(),
  texto: z.string().trim().min(MIN_CARACTERES).max(MAX_CARACTERES),
});

/** Lo que se busca, en el orden en que se enseña: primero el árbol, luego lo que cuelga de él. */
export const CLASES_BUSCABLES = [
  'servicio',
  'reto',
  'proyecto',
  'journey',
  'design-version',
  'evidencia',
  'insight',
] as const;
export type ClaseBuscable = (typeof CLASES_BUSCABLES)[number];

export const ETIQUETA_CLASE: Record<ClaseBuscable, string> = {
  servicio: 'Servicio',
  reto: 'Reto',
  proyecto: 'Proyecto',
  journey: 'Journey',
  'design-version': 'Design version',
  evidencia: 'Evidencia',
  insight: 'Insight',
};

/** Una fila tal como sale de la base, antes de decidir a dónde lleva. */
export type FilaBusqueda = {
  clase: ClaseBuscable;
  id: string;
  codigo: string | null;
  titulo: string;
  /** Estado o tipo, según la clase: lo que ayuda a distinguir dos títulos iguales. */
  detalle: string;
  /** Para un reto, su primer proyecto (si tiene): es la pantalla que lo abre. */
  refId: string | null;
  /** Y el código de ese proyecto, que es lo que hay que decir en el pie: «Proyecto P-01». */
  refCodigo: string | null;
};

export type ResultadoBusqueda = FilaBusqueda & { destino: Destino };

/**
 * `texto` como patrón ILIKE: los comodines del propio texto van escapados, porque quien
 * escribe «100%» busca eso y no «cualquier cosa que empiece por 100». Es LA regla de escape
 * de la app: la búsqueda de anclas del módulo AI la usa también, para que no diverjan.
 */
export function patronDeBusqueda(texto: string): string {
  return `%${texto.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * A qué pantalla abre cada resultado. No todo tiene pantalla propia: un reto se abre por su
 * proyecto y, si no tiene, por el árbol del loop donde figura; evidencias e insights abren
 * su lista con el elemento destacado, que es donde se leen. Es una función y no una columna
 * para que la base no tenga que saber de rutas.
 */
export function destinoDeResultado(fila: FilaBusqueda): Destino {
  switch (fila.clase) {
    case 'servicio':
      return { to: '/app' };
    case 'reto':
      return fila.refId
        ? { to: '/proyecto/$proyectoId', params: { proyectoId: fila.refId } }
        : { to: '/app' };
    case 'proyecto':
      return { to: '/proyecto/$proyectoId', params: { proyectoId: fila.id } };
    case 'journey':
      return { to: '/journey/$journeyId', params: { journeyId: fila.id } };
    case 'design-version':
      return { to: '/design-version/$designVersionId', params: { designVersionId: fila.id } };
    case 'evidencia':
      return { to: '/evidencia', search: { destacar: fila.id } };
    case 'insight':
      return { to: '/insights', search: { destacar: fila.id } };
  }
}

export function conDestino(filas: FilaBusqueda[]): ResultadoBusqueda[] {
  return filas.map((fila) => ({ ...fila, destino: destinoDeResultado(fila) }));
}

/** El código con el que se nombra la pantalla destino: el del propio resultado, o el del proyecto que abre un reto. */
export function codigoDelDestino(r: ResultadoBusqueda): string | undefined {
  return (r.clase === 'reto' ? r.refCodigo : r.codigo) ?? undefined;
}
