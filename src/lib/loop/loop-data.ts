import type { JourneyN } from '@/components/ui/JourneyBadge';
import type { Destino } from '@/lib/destinos';

/**
 * El catálogo de los siete journeys del método (prediseño §19): qué es cada uno, qué
 * etapas y gates cubre, quién responde y dónde se trabaja en la plataforma. Es texto fijo
 * del método, no estado: el estado (hecho / en curso / próximo) se DERIVA de los gates del
 * proyecto en `loop-estado`.
 */
export type JourneyLoop = {
  j: JourneyN;
  titulo: string;
  /** Título de una palabra para la tarjeta estrecha y la barra del arco. */
  corto: string;
  /** Etapas y gates que cubre, en mono: «Etapa 7 · G7». */
  meta: string;
  /** Qué ocurre en este journey, para el spotlight cuando está en curso. */
  descripcion: string;
  rol: string;
  /** Dónde se HACE este journey hoy en la plataforma: la tarjeta abre esa pantalla. */
  pantalla: PantallaDeJourney;
};

/**
 * Las pantallas que existen para trabajar cada journey. No es una ruta sino un nombre,
 * porque la que necesita un id (el proyecto) solo se resuelve con el árbol del workspace
 * delante: ver `destinoDeJourney`.
 */
export type PantallaDeJourney = 'importacion' | 'proyecto' | 'insights' | 'design-versions';

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

export const JOURNEYS_DEL_LOOP: JourneyLoop[] = [
  {
    j: 1,
    titulo: 'Arranque en frío',
    corto: 'arranque',
    meta: 'Importación · curaduría',
    descripcion:
      'El material del cliente entra por la bandeja y alguien lo cura: nada es evidencia hasta que una persona lo aprueba con sus cinco dimensiones.',
    rol: 'Lead + admin cliente',
    pantalla: 'importacion',
  },
  {
    j: 2,
    titulo: 'Formulación del reto',
    corto: 'reto',
    meta: 'Etapa 0 · G0',
    descripcion:
      'El reto se formula con criterios de éxito medibles, línea base y ventana. G0 los congela: a partir de ahí se mide contra ellos.',
    rol: 'Sponsor aprueba',
    pantalla: 'proyecto',
  },
  {
    j: 3,
    titulo: 'Investigación y entendimiento',
    corto: 'investigación',
    meta: 'Etapas 1–2 · G1 G2',
    descripcion:
      'Se investiga y se sostienen insights con citas verificables sobre evidencia con derechos vigentes. G2 certifica que hay entendimiento suficiente.',
    rol: 'Diseñadores + stakeholders',
    pantalla: 'insights',
  },
  {
    j: 4,
    titulo: 'Conceptualización y exploración',
    corto: 'conceptos',
    meta: 'Etapas 3–4 · G3 G4',
    descripcion:
      'De los insights salen preguntas, conceptos y pruebas. Las decisiones quedan enlazadas a lo que las fundamenta.',
    rol: 'Sponsor + equipo',
    pantalla: 'proyecto',
  },
  {
    j: 5,
    titulo: 'Detalle y plan',
    corto: 'detalle',
    meta: 'Etapas 5–6 · G5 G6',
    descripcion:
      'La design version detalla el cambio y el diff contra el estado actual; el plan firma el Metric Registry en G6 antes de tocar nada.',
    rol: 'Sponsor + dueño del dato',
    pantalla: 'design-versions',
  },
  {
    j: 6,
    titulo: 'Implementación y medición',
    corto: 'implementación',
    meta: 'Etapa 7 · G7',
    descripcion:
      'Los releases salen y se constata qué quedó funcionando de verdad: el effective state del servicio. G7 no pasa con elementos en estado desconocido.',
    rol: 'Equipo cliente + dueño del dato',
    pantalla: 'design-versions',
  },
  {
    j: 7,
    titulo: 'Post mortem y continuidad',
    corto: 'post mortem',
    meta: 'Veredicto · suscripción',
    descripcion:
      'Con la serie de métricas leída, el outcome review dicta veredicto y deja los retos candidatos del siguiente ciclo.',
    rol: 'Sponsor decide',
    pantalla: 'proyecto',
  },
];

/** Por su número, no por posición: el catálogo cubre los siete, pero no depende de su orden. */
const POR_NUMERO = new Map(JOURNEYS_DEL_LOOP.map((jl) => [jl.j, jl]));

export function journeyDelLoop(j: JourneyN): JourneyLoop {
  const jl = POR_NUMERO.get(j);
  if (!jl) throw new Error(`El catálogo del loop no tiene el journey J${j}`);
  return jl;
}
