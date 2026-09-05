import type { JourneyN } from '@/components/ui/JourneyBadge';
import type { RetoArbol } from '@/lib/arbol/arbol.schemas';
import type { GatesDeProyecto } from './loop.schemas';

/**
 * El estado del loop J1–J7 se DERIVA de los gates G0–G7 del proyecto (SPEC-04): no se
 * declara a mano ni se guarda en ninguna tabla. Es la regla que `loop-data` dejó escrita
 * como deuda mientras los gates no existían; existen desde SPEC-04, así que se salda aquí,
 * en una función pura que un test puede recorrer entera.
 *
 * Cada journey cubre gates concretos:
 *   J1 arranque en frío       → no tiene gate: está hecho cuando hay evidencia curada
 *                                (o cuando algún gate ya se aprobó: sin arranque no hay G0).
 *   J2 formulación del reto   → G0
 *   J3 investigación          → G1 G2
 *   J4 conceptualización      → G3 G4
 *   J5 detalle y plan         → G5 G6
 *   J6 implementación         → G7
 *   J7 post mortem            → outcome review completado.
 * El primer journey no hecho es el que está en curso; los de después, próximos.
 */

export type EstadoJourney = 'hecho' | 'en curso' | 'próximo';

export type EstadoDelLoop = {
  journeys: Record<JourneyN, EstadoJourney>;
  /** null cuando el loop está cerrado entero (los siete hechos). */
  enCurso: JourneyN | null;
  /** El primer gate no aprobado (0–7); null si están los ocho. */
  gateAbierto: number | null;
  cerrados: number;
};

export const GATES_POR_JOURNEY: Record<JourneyN, readonly number[]> = {
  1: [],
  2: [0],
  3: [1, 2],
  4: [3, 4],
  5: [5, 6],
  6: [7],
  7: [],
};

export const JOURNEYS: readonly JourneyN[] = [1, 2, 3, 4, 5, 6, 7];

export type EntradaDelLoop = {
  hayEvidencia: boolean;
  gatesAprobados: readonly number[];
  reviewCompletado: boolean;
};

export function estadoDelLoop(entrada: EntradaDelLoop): EstadoDelLoop {
  const aprobados = new Set(entrada.gatesAprobados);
  const hecho = (j: JourneyN): boolean => {
    // El arranque en frío está hecho cuando hay evidencia curada… o cuando algún gate ya se
    // aprobó: nadie pasa G0 sin haber arrancado, y un workspace cuyo checklist se decidió
    // entero por N/A no puede quedarse en «J1 en curso» con G5 abierto al lado.
    if (j === 1) return entrada.hayEvidencia || aprobados.size > 0;
    if (j === 7) return entrada.reviewCompletado;
    return GATES_POR_JOURNEY[j].every((g) => aprobados.has(g));
  };
  const journeys = {} as Record<JourneyN, EstadoJourney>;
  let enCurso: JourneyN | null = null;
  let cerrados = 0;
  for (const j of JOURNEYS) {
    if (enCurso === null && hecho(j)) {
      journeys[j] = 'hecho';
      cerrados += 1;
    } else if (enCurso === null) {
      journeys[j] = 'en curso';
      enCurso = j;
    } else {
      journeys[j] = 'próximo';
    }
  }
  let gateAbierto: number | null = null;
  for (let g = 0; g <= 7; g += 1) {
    if (!aprobados.has(g)) {
      gateAbierto = g;
      break;
    }
  }
  return { journeys, enCurso, gateAbierto, cerrados };
}

/** El loop de un proyecto concreto, o el de un servicio SIN proyecto (solo J1 puede estar hecho). */
export function loopDeProyecto(
  proyecto: Pick<GatesDeProyecto, 'aprobados' | 'reviewCompletado'> | null,
  hayEvidencia: boolean,
): EstadoDelLoop {
  return estadoDelLoop({
    hayEvidencia,
    gatesAprobados: proyecto?.aprobados ?? [],
    reviewCompletado: proyecto?.reviewCompletado ?? false,
  });
}

/**
 * Cómo se marca un reto en el árbol del lateral: el color del journey donde está y un
 * sufijo mono. Un reto con proyecto está donde esté su proyecto; uno activo sin proyecto
 * todavía se está formulando (J2); un candidato nacido del post mortem aún no existe
 * formalmente y se pinta punteado con el color de J7.
 */
export type MarcaDeReto = { j: JourneyN; punteado: boolean; sufijo: string };

export function marcaDeReto(
  reto: Pick<RetoArbol, 'estado' | 'origen' | 'proyectos'>,
  proyectos: ReadonlyMap<string, GatesDeProyecto>,
  hayEvidencia: boolean,
): MarcaDeReto {
  const proyecto = reto.proyectos[0] ? proyectos.get(reto.proyectos[0].id) : undefined;
  if (proyecto) {
    const loop = loopDeProyecto(proyecto, hayEvidencia);
    return loop.enCurso
      ? { j: loop.enCurso, punteado: false, sufijo: `J${loop.enCurso}` }
      : { j: 7, punteado: false, sufijo: 'cerrado' };
  }
  if (reto.estado === 'candidato' && reto.origen === 'post-mortem') {
    return { j: 7, punteado: true, sufijo: '—' };
  }
  return { j: 2, punteado: false, sufijo: 'J2' };
}
