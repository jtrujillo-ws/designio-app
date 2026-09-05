import type { EstadoChip } from '@/components/ui/Chip';
import type { JourneyN } from '@/components/ui/JourneyBadge';

/**
 * Datos estáticos del ejemplo Banco Andino (prediseño §19) para la pantalla Loop.
 * En producción este estado se deriva de los gates G0–G7 del reto activo (SPEC-04).
 */
export type JourneyLoop = {
  j: JourneyN;
  titulo: string;
  meta: string;
  rol: string;
  estado: EstadoChip;
  /** Dónde se HACE este journey hoy en la plataforma: la tarjeta abre esa pantalla. */
  pantalla: PantallaDeJourney;
};

/**
 * Las pantallas que existen para trabajar cada journey. No es una ruta sino un nombre,
 * porque la que necesita un id (el proyecto) solo se resuelve con el árbol del workspace
 * delante: ver `destinoDeJourney`.
 */
export type PantallaDeJourney = 'importacion' | 'proyecto' | 'insights' | 'design-versions';

/** Un destino navegable de la app, listo para `Link` o `navigate`. */
export type Destino =
  | { to: '/importacion' }
  | { to: '/insights' }
  | { to: '/journeys' }
  | { to: '/design-versions' }
  | { to: '/proyecto/$proyectoId'; params: { proyectoId: string } };

/** Etiqueta corta de a dónde lleva un destino, para decirlo en la tarjeta antes de hacer clic. */
export function etiquetaDeDestino(destino: Destino, proyectoCodigo?: string): string {
  switch (destino.to) {
    case '/importacion':
      return 'Bandeja de importación';
    case '/insights':
      return 'Insights y citas';
    case '/journeys':
      return 'Journeys y blueprints';
    case '/design-versions':
      return 'Design versions y releases';
    case '/proyecto/$proyectoId':
      return proyectoCodigo ? `Proyecto ${proyectoCodigo}` : 'Proyecto';
  }
}

/**
 * A qué pantalla abre la tarjeta de un journey. Devuelve null cuando la pantalla es la del
 * proyecto y el servicio aún no tiene ninguno: entonces la tarjeta no puede enlazar a nada y
 * lo dice, en lugar de fingir un enlace (las tarjetas nacieron como `div` mudos y la queja
 * fue exactamente esa: nada de lo que se ve permite entrar ni revisar).
 */
export function destinoDeJourney(
  pantalla: PantallaDeJourney,
  proyectoId: string | null,
): Destino | null {
  switch (pantalla) {
    case 'importacion':
      return { to: '/importacion' };
    case 'insights':
      return { to: '/insights' };
    case 'design-versions':
      return { to: '/design-versions' };
    case 'proyecto':
      return proyectoId ? { to: '/proyecto/$proyectoId', params: { proyectoId } } : null;
  }
}

export const LOOP_BANCO_ANDINO: JourneyLoop[] = [
  {
    j: 1,
    titulo: 'Arranque en frío',
    meta: 'Importación y curaduría · servicio con estado actual',
    rol: 'Lead + admin cliente',
    estado: 'hecho',
    pantalla: 'importacion',
  },
  {
    j: 2,
    titulo: 'Formulación del reto',
    meta: 'Etapa 0 · criterios con ventanas · G0',
    rol: 'Sponsor aprueba',
    estado: 'hecho',
    pantalla: 'proyecto',
  },
  {
    j: 3,
    titulo: 'Investigación y entendimiento',
    meta: 'Etapas 1–2 · evidencia, insights · G1 G2',
    rol: 'Diseñadores + stakeholders',
    estado: 'hecho',
    pantalla: 'insights',
  },
  {
    j: 4,
    titulo: 'Conceptualización y exploración',
    meta: 'Etapas 3–4 · HMW, conceptos, tests · G3 G4',
    rol: 'Sponsor + equipo',
    estado: 'hecho',
    pantalla: 'proyecto',
  },
  {
    j: 5,
    titulo: 'Detalle y plan',
    meta: 'Etapas 5–6 · design version, diff · G5 G6',
    rol: 'Sponsor + dueño del dato',
    estado: 'hecho',
    pantalla: 'design-versions',
  },
  {
    j: 6,
    titulo: 'Implementación y medición',
    meta: 'Etapa 7 · releases, effective state · G7',
    rol: 'Equipo cliente + dueño del dato',
    estado: 'en curso',
    pantalla: 'design-versions',
  },
  {
    j: 7,
    titulo: 'Post mortem y continuidad',
    meta: 'Outcome review · veredicto · suscripción',
    rol: 'Sponsor decide',
    estado: 'próximo',
    pantalla: 'proyecto',
  },
];
