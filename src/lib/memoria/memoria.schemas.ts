import { z } from 'zod';
import type { Destino } from '@/lib/destinos';
import type { VeredictoSlug } from '@/lib/medicion/medicion.schemas';
import type { EstadoArquetipo, TipoDecision } from '@/lib/metodo/gobernanza.schemas';

/**
 * La memoria del workspace, tal como la lee la Biblioteca del cliente (CTX-01, §4.1 y
 * §11 del prediseño). No es un almacén aparte: es una PROYECCIÓN de lectura sobre lo que
 * el workspace ya sabe —arquetipos por segmento como hipótesis a confirmar o refutar en
 * retos nuevos, insights validados, decisiones vigentes y retos cerrados con su
 * veredicto— que es lo que pre-puebla la etapa 0 del siguiente reto. Nada de esto se
 * escribe aquí: cada objeto tiene su módulo dueño y su pantalla.
 *
 * No confundir con `src/lib/biblioteca/` (CTX-07): esa es la biblioteca GENERAL de la
 * boutique, conocimiento metodológico sin workspace. Ésta es la del cliente y vive
 * dentro de su workspace, bajo su RLS.
 *
 * Módulo compartido client/server: solo tipos, contratos y funciones puras.
 */

export const MemoriaInputSchema = z.object({ workspaceId: z.string().uuid() });

export type SegmentoEnMemoria = { id: string; nombre: string; definicion: string };

/** Un arquetipo tal como la biblioteca lo conserva: con su veredicto y con el reto que lo hizo nacer. */
export type ArquetipoEnMemoria = {
  id: string;
  nombre: string;
  definicion: string;
  estado: EstadoArquetipo;
  veredictoRazon: string;
  /** El reto donde nació: un arquetipo es un perfil emergente de la evidencia de ESE reto. */
  reto: { id: string; codigo: string; titulo: string; estado: string };
  /** Su primer proyecto, si lo hay: es la pantalla donde se lee la gobernanza del arquetipo. */
  proyecto: { id: string; codigo: string } | null;
  /** El mapeo n:m a segmentos (RF-04.11). Vacío = arquetipo sin segmento declarado. */
  segmentoIds: string[];
};

export type InsightEnMemoria = {
  id: string;
  titulo: string;
  resumen: string;
  validadoEn: string;
};

export type DecisionEnMemoria = {
  id: string;
  tipo: TipoDecision;
  titulo: string;
  fundamento: string;
  gateNumero: number;
  decididoEn: string;
  proyecto: { id: string; codigo: string; titulo: string };
};

export type RetoCerradoEnMemoria = {
  id: string;
  codigo: string;
  titulo: string;
  /**
   * El veredicto del outcome review. Null en los retos cerrados antes de que existiera el
   * post mortem (la migración de medición NO les inventa uno): la biblioteca lo dice tal
   * cual, porque «sin veredicto» es un dato y «no concluyente» sería una fabricación.
   */
  veredicto: VeredictoSlug | null;
  contribucion: string;
  aprendizajes: string;
  cerradoEn: string | null;
  proyecto: { id: string; codigo: string } | null;
};

export type RetoCandidatoEnMemoria = {
  id: string;
  codigo: string;
  titulo: string;
  descripcion: string;
  metricaObjetivo: string;
};

export type MemoriaDelWorkspace = {
  workspaceId: string;
  workspaceNombre: string;
  /** Todos los segmentos del workspace, tengan o no arquetipos: un segmento sin memoria también se dice. */
  segmentos: SegmentoEnMemoria[];
  arquetipos: ArquetipoEnMemoria[];
  /** Solo `validado`: un insight propuesto todavía no es memoria, es una conversación. */
  insights: InsightEnMemoria[];
  /** Solo `vigente`: una decisión en revisión está cuestionada y no debe citarse como sabida. */
  decisiones: DecisionEnMemoria[];
  retosCerrados: RetoCerradoEnMemoria[];
  /** Candidatos con origen `post-mortem`: los que el ciclo anterior dejó propuestos. */
  retosCandidatos: RetoCandidatoEnMemoria[];
};

export const ETIQUETA_ESTADO_ARQUETIPO: Record<EstadoArquetipo, string> = {
  hipotesis: 'Hipótesis',
  confirmado: 'Confirmado',
  refutado: 'Refutado',
};

/**
 * En qué orden se leen los arquetipos de un segmento: primero lo que se sabe (confirmado),
 * luego lo que está por resolver, y al final lo que la evidencia descartó — que se conserva
 * porque refutar también es aprender, pero no encabeza la lista.
 */
const ORDEN_ESTADO: Record<EstadoArquetipo, number> = { confirmado: 0, hipotesis: 1, refutado: 2 };

export type GrupoDeSegmento = {
  /** Null para los arquetipos que no declararon segmento: se enseñan aparte, no se pierden. */
  segmento: SegmentoEnMemoria | null;
  arquetipos: ArquetipoEnMemoria[];
};

/**
 * Los arquetipos agrupados por segmento, en el orden de los segmentos. Es la vista que pide
 * §4.1: «arquetipos históricos POR SEGMENTO como hipótesis a confirmar o refutar». El mapeo
 * es n:m, así que un arquetipo mapeado a dos segmentos aparece en los dos — es la misma
 * fila, no una copia, y quien mira el segmento «pymes» tiene que encontrarlo ahí aunque
 * también sea de «independientes». Los segmentos sin arquetipos se conservan (vacíos) y los
 * arquetipos sin segmento van en un grupo final que solo existe si hay alguno.
 */
export function agruparArquetiposPorSegmento(
  segmentos: SegmentoEnMemoria[],
  arquetipos: ArquetipoEnMemoria[],
): GrupoDeSegmento[] {
  const ordenados = [...arquetipos].sort(
    (a, b) =>
      ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado] ||
      a.nombre.localeCompare(b.nombre, 'es') ||
      a.id.localeCompare(b.id),
  );
  const grupos: GrupoDeSegmento[] = segmentos.map((segmento) => ({
    segmento,
    arquetipos: ordenados.filter((a) => a.segmentoIds.includes(segmento.id)),
  }));
  // Sin segmento «conocido»: incluye el caso de un id que ya no corresponde a ningún
  // segmento del workspace, que de otro modo desaparecería de la pantalla en silencio.
  const conocidos = new Set(segmentos.map((s) => s.id));
  const sueltos = ordenados.filter((a) => !a.segmentoIds.some((id) => conocidos.has(id)));
  if (sueltos.length > 0) grupos.push({ segmento: null, arquetipos: sueltos });
  return grupos;
}

/** Cuántos arquetipos hay en cada estado: el resumen de cabecera de la sección. */
export function resumenDeArquetipos(
  arquetipos: ArquetipoEnMemoria[],
): Record<EstadoArquetipo, number> {
  const resumen: Record<EstadoArquetipo, number> = { hipotesis: 0, confirmado: 0, refutado: 0 };
  for (const a of arquetipos) resumen[a.estado] += 1;
  return resumen;
}

/** A dónde abre un arquetipo: al proyecto de su reto, que es donde vive su gobernanza. Sin proyecto no hay pantalla. */
export function destinoDelArquetipo(a: ArquetipoEnMemoria): Destino | null {
  return a.proyecto ? { to: '/proyecto/$proyectoId', params: { proyectoId: a.proyecto.id } } : null;
}

export function destinoDelInsight(i: InsightEnMemoria): Destino {
  return { to: '/insights', search: { destacar: i.id } };
}

export function destinoDeLaDecision(d: DecisionEnMemoria): Destino {
  return { to: '/proyecto/$proyectoId', params: { proyectoId: d.proyecto.id } };
}

export function destinoDelRetoCerrado(r: RetoCerradoEnMemoria): Destino | null {
  return r.proyecto ? { to: '/proyecto/$proyectoId', params: { proyectoId: r.proyecto.id } } : null;
}

/** La memoria está vacía cuando ninguna sección tiene nada: el workspace todavía no ha cerrado un ciclo. */
export function memoriaVacia(m: MemoriaDelWorkspace): boolean {
  return (
    m.arquetipos.length === 0 &&
    m.insights.length === 0 &&
    m.decisiones.length === 0 &&
    m.retosCerrados.length === 0 &&
    m.retosCandidatos.length === 0
  );
}

/** «1 insight», «3 insights»: el conteo de cabecera de cada sección, sin plural roto. */
export function conteo(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
