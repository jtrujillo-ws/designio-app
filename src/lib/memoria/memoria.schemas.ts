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

/**
 * Cuántas filas trae cada sección, de la más reciente a la más antigua. La biblioteca
 * ORIENTA: sin tope, la carga y el SSR de la pantalla crecían con la vida entera del
 * workspace (la ruta de insights pagina a 50 por lo mismo). La lista completa vive en la
 * pantalla dueña de cada pieza, y la sección dice cuántas hay en total y dónde verlas.
 */
export const TOPE_POR_SECCION = 50;

export type SegmentoEnMemoria = {
  id: string;
  nombre: string;
  definicion: string;
  /**
   * Cuántos arquetipos tiene DE VERDAD (count sobre el mapeo, en la misma foto). La lista
   * de arquetipos viene recortada al tope global, así que un segmento antiguo puede llegar
   * sin ninguno de los suyos: con este número la tarjeta dice «se muestran 0 de 3» en vez
   * de mentir con «sin arquetipos».
   */
  totalArquetipos: number;
};

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

/**
 * Un insight validado es inmutable, pero su RESPALDO no: los derechos de la evidencia que
 * cita se revocan y caducan. `sinRespaldo` es el motivo, ya redactado por la base con la
 * misma función que consulta el guard de suficiencia (`razonamiento_sin_respaldo_visible`),
 * o null si se puede seguir citando. La biblioteca lo enseña marcado, no lo esconde: que
 * el cliente sepa que lo supo y que hoy no puede apoyarse en ello es memoria también.
 */
export type InsightEnMemoria = {
  id: string;
  titulo: string;
  resumen: string;
  validadoEn: string;
  sinRespaldo: string | null;
};

export type DecisionEnMemoria = {
  id: string;
  tipo: TipoDecision;
  titulo: string;
  fundamento: string;
  gateNumero: number;
  decididoEn: string;
  proyecto: { id: string; codigo: string; titulo: string };
  /** Igual que en el insight: `vigente` habla de reaperturas, no de si su cadena sigue viva. */
  sinRespaldo: string | null;
};

export type RetoCerradoEnMemoria = {
  id: string;
  codigo: string;
  titulo: string;
  /**
   * `cerrado → archivado` es una transición legal y el veredicto viaja con el reto
   * archivado (`reto_veredicto_solo_cerrado` lo admite en ambos): archivar ordena el
   * árbol, no borra lo que se aprendió. Se dice cuál es para que el lector lo sepa.
   */
  estado: 'cerrado' | 'archivado';
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
  /**
   * Los segmentos del workspace, tengan o no arquetipos —un segmento sin memoria también
   * se dice—, recortados al tope como todo lo demás (una tarjeta por segmento en el SSR
   * crecía sin límite); `totales.segmentos` dice cuántos hay y la lista entera vive en
   * /segmentos.
   */
  segmentos: SegmentoEnMemoria[];
  arquetipos: ArquetipoEnMemoria[];
  /** Solo `validado`: un insight propuesto todavía no es memoria, es una conversación. */
  insights: InsightEnMemoria[];
  /** Solo `vigente`: una decisión en revisión está cuestionada y no debe citarse como sabida. */
  decisiones: DecisionEnMemoria[];
  /** Cerrados con veredicto, y archivados que lo tuvieron: ver `RetoCerradoEnMemoria.estado`. */
  retosCerrados: RetoCerradoEnMemoria[];
  /** Candidatos con origen `post-mortem`: los que el ciclo anterior dejó propuestos. */
  retosCandidatos: RetoCandidatoEnMemoria[];
  /**
   * Cuántas hay DE VERDAD por sección (count en la misma foto), tengan o no sitio en la
   * lista: cada lista trae como mucho TOPE_POR_SECCION y el total es lo que la pantalla
   * dice cuando recortó.
   */
  totales: TotalesDeMemoria;
};

export type TotalesDeMemoria = {
  /** Cuántos segmentos hay; `segmentos` trae como mucho el tope. */
  segmentos: number;
  arquetipos: number;
  /** Los que no declararon segmento: el total del grupo «sin segmento», por la misma razón. */
  arquetiposSinSegmento: number;
  insights: number;
  decisiones: number;
  retosCerrados: number;
  retosCandidatos: number;
};

/**
 * En qué orden se leen los arquetipos de un segmento: primero lo que se sabe (confirmado),
 * luego lo que está por resolver, y al final lo que la evidencia descartó — que se conserva
 * porque refutar también es aprender, pero no encabeza la lista.
 */
const ORDEN_ESTADO: Record<EstadoArquetipo, number> = { confirmado: 0, hipotesis: 1, refutado: 2 };

/**
 * De qué habla un grupo: de un segmento MOSTRADO, de los arquetipos cuyo mapeo apunta solo
 * a segmentos que el tope de segmentos dejó fuera, o de los que no declararon ninguno. Los
 * dos últimos no son lo mismo y no se mezclan: «sin segmento declarado» sobre un arquetipo
 * que sí lo tiene —solo que su segmento no cupo— es falso.
 */
export type ClaseDeGrupo = 'segmento' | 'fuera-de-los-mostrados' | 'sin-segmento';

export type GrupoDeSegmento = {
  clase: ClaseDeGrupo;
  /** El segmento cuando `clase` es 'segmento'; null en los otros dos. */
  segmento: SegmentoEnMemoria | null;
  /** Los que se ENSEÑAN: los que sobrevivieron al tope global y son de este segmento. */
  arquetipos: ArquetipoEnMemoria[];
  /** Los que HAY: si es mayor que los mostrados, el tope dejó fuera alguno de este grupo. */
  total: number;
};

/**
 * Los arquetipos agrupados por segmento, en el orden de los segmentos. Es la vista que pide
 * §4.1: «arquetipos históricos POR SEGMENTO como hipótesis a confirmar o refutar». El mapeo
 * es n:m, así que un arquetipo mapeado a dos segmentos aparece en los dos — es la misma
 * fila, no una copia, y quien mira el segmento «pymes» tiene que encontrarlo ahí aunque
 * también sea de «independientes». Los segmentos sin arquetipos se conservan (vacíos) y los
 * arquetipos sin segmento van en un grupo final que solo existe si hay alguno.
 *
 * Cada grupo lleva su TOTAL real, que no se deriva de la lista: `arquetipos` ya viene
 * recortada al tope global, así que un segmento cuyos arquetipos son todos más antiguos que
 * los 50 más recientes llega aquí sin ninguno y, sin el total, la pantalla diría que no
 * tiene. `sinSegmento` es el total de los que no declararon segmento, por lo mismo.
 *
 * Y `segmentos` también viene recortada al tope, así que «no está en ningún segmento
 * mostrado» no significa «no tiene segmento»: `segmentoIds` trae el mapeo ENTERO desde la
 * base, y con él se separan tres casos —mapeado a algún segmento mostrado (va en ese
 * grupo), mapeado solo a segmentos fuera de los mostrados (grupo aparte, que remite a la
 * pantalla de segmentos), y sin mapeo alguno (el único que es «sin segmento declarado»)—.
 */
export function agruparArquetiposPorSegmento(
  segmentos: SegmentoEnMemoria[],
  arquetipos: ArquetipoEnMemoria[],
  sinSegmento = 0,
): GrupoDeSegmento[] {
  const ordenados = [...arquetipos].sort(
    (a, b) =>
      ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado] ||
      a.nombre.localeCompare(b.nombre, 'es') ||
      a.id.localeCompare(b.id),
  );
  const grupos: GrupoDeSegmento[] = segmentos.map((segmento) => {
    const propios = ordenados.filter((a) => a.segmentoIds.includes(segmento.id));
    // El count manda; el máximo es solo la red por si llegara una lista más larga que él.
    return {
      clase: 'segmento',
      segmento,
      arquetipos: propios,
      total: Math.max(segmento.totalArquetipos, propios.length),
    };
  });
  const mostrados = new Set(segmentos.map((s) => s.id));
  // Con mapeo, pero a ninguno de los segmentos mostrados: tienen segmento, solo que el
  // suyo no cupo. Se listan tal cual llegan; su total es lo que se enseña, porque contar
  // «los que solo están en segmentos no mostrados» costaría lo que el tope ahorra.
  const fuera = ordenados.filter(
    (a) => a.segmentoIds.length > 0 && !a.segmentoIds.some((id) => mostrados.has(id)),
  );
  if (fuera.length > 0) {
    grupos.push({
      clase: 'fuera-de-los-mostrados',
      segmento: null,
      arquetipos: fuera,
      total: fuera.length,
    });
  }
  // Sin mapeo alguno: los únicos «sin segmento declarado». El grupo existe si HAY alguno,
  // se enseñe o no: los que el tope dejó fuera también son memoria y hay que decir que están.
  const sueltos = ordenados.filter((a) => a.segmentoIds.length === 0);
  const totalSueltos = Math.max(sinSegmento, sueltos.length);
  if (totalSueltos > 0) {
    grupos.push({
      clase: 'sin-segmento',
      segmento: null,
      arquetipos: sueltos,
      total: totalSueltos,
    });
  }
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

/** La memoria está vacía cuando ninguna sección tiene nada: el workspace todavía no ha cerrado un ciclo.
 * Los segmentos no cuentan —son taxonomía, no lo aprendido—, así que su total no se mira. */
export function memoriaVacia(m: MemoriaDelWorkspace): boolean {
  const t = m.totales;
  return (
    t.arquetipos === 0 &&
    t.insights === 0 &&
    t.decisiones === 0 &&
    t.retosCerrados === 0 &&
    t.retosCandidatos === 0
  );
}

/**
 * La cabecera de insights y decisiones: el total real y, de los ENSEÑADOS, cuántos siguen
 * con respaldo vivo y cuántos no — porque un insight cuya evidencia perdió los derechos no
 * es memoria UTILIZABLE aunque siga validado.
 *
 * El desglose es de los mostrados y solo de ellos: el predicado (`razonamiento_sin_respaldo
 * _visible`) corre por fila, y evaluarlo sobre el workspace entero es justo el coste que el
 * tope evita. Por eso, cuando el tope recortó, la cabecera lo DICE —«de los 50 mostrados:
 * …»— en vez de poner un desglose de 50 filas al lado de un total de 53 como si fueran del
 * mismo conjunto. Sin recorte, mostrados y total coinciden y no hace falta aclararlo.
 */
export function resumenDeRespaldo(
  items: { sinRespaldo: string | null }[],
  total: number,
  singular: string,
  plural: string,
): string {
  if (total === 0) return `0 ${plural}`;
  const sinRespaldo = items.filter((i) => i.sinRespaldo !== null).length;
  const desglose = `${items.length - sinRespaldo} con respaldo · ${sinRespaldo} sin respaldo vivo`;
  const ambito =
    total > items.length
      ? items.length === 1
        ? 'del mostrado: '
        : `de los ${items.length} mostrados: `
      : '';
  return `${total} ${total === 1 ? singular : plural} · ${ambito}${desglose}`;
}

/**
 * La cabecera de un grupo de segmento: cuántos se enseñan de cuántos hay. Nunca dice «sin
 * arquetipos» cuando los hay y el tope los dejó fuera.
 */
export function cabeceraDeGrupo(g: GrupoDeSegmento): string {
  if (g.total === 0) return 'sin arquetipos todavía';
  if (g.total > g.arquetipos.length) {
    return `se muestran ${g.arquetipos.length} de ${g.total} (los más recientes)`;
  }
  return `${g.total} ${g.total === 1 ? 'arquetipo' : 'arquetipos'}`;
}

/**
 * Lo que la sección dice cuando el tope la recortó, o null si enseña todo. Nombra la
 * pantalla donde está la lista completa: un «hay más» sin a dónde ir es un callejón.
 */
export function notaDeRecorte(mostrados: number, total: number, donde: string): string | null {
  if (total <= mostrados) return null;
  return `Se muestran ${mostrados === 1 ? 'el más reciente' : `los ${mostrados} más recientes`} de ${total}; la lista completa está en ${donde}.`;
}
