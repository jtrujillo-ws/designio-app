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
};

export const LOOP_BANCO_ANDINO: JourneyLoop[] = [
  {
    j: 1,
    titulo: 'Arranque en frío',
    meta: 'Importación y curaduría · servicio con estado actual',
    rol: 'Lead + admin cliente',
    estado: 'hecho',
  },
  {
    j: 2,
    titulo: 'Formulación del reto',
    meta: 'Etapa 0 · criterios con ventanas · G0',
    rol: 'Sponsor aprueba',
    estado: 'hecho',
  },
  {
    j: 3,
    titulo: 'Investigación y entendimiento',
    meta: 'Etapas 1–2 · evidencia, insights · G1 G2',
    rol: 'Diseñadores + stakeholders',
    estado: 'hecho',
  },
  {
    j: 4,
    titulo: 'Conceptualización y exploración',
    meta: 'Etapas 3–4 · HMW, conceptos, tests · G3 G4',
    rol: 'Sponsor + equipo',
    estado: 'hecho',
  },
  {
    j: 5,
    titulo: 'Detalle y plan',
    meta: 'Etapas 5–6 · design version, diff · G5 G6',
    rol: 'Sponsor + dueño del dato',
    estado: 'hecho',
  },
  {
    j: 6,
    titulo: 'Implementación y medición',
    meta: 'Etapa 7 · releases, effective state · G7',
    rol: 'Equipo cliente + dueño del dato',
    estado: 'en curso',
  },
  {
    j: 7,
    titulo: 'Post mortem y continuidad',
    meta: 'Outcome review · veredicto · suscripción',
    rol: 'Sponsor decide',
    estado: 'próximo',
  },
];
