import { z } from 'zod';
import type { Destino } from '@/lib/destinos';
import { ROLES_DERECHOS } from '@/lib/evidencia/evidencia.schemas';
import type { AprobacionPendiente } from '@/lib/loop/loop.schemas';

/**
 * Aprobaciones pendientes: lo que el rol de quien mira puede aprobar o decidir AHORA en el
 * workspace, agrupado por clase. Módulo compartido client/server: contratos, tipos y
 * funciones puras; la lectura vive en `aprobaciones.queries.ts`.
 *
 * Hasta aquí la fila «Aprobaciones» del lateral era un atajo al proyecto del primer gate
 * que esperaba, porque no había pantalla. Esta proyección la sustituye y la AMPLÍA: un gate
 * es la aprobación más visible del método, pero no la única decisión que espera a un rol
 * —los derechos de uso los concede alguien, un insight lo valida alguien, una design version
 * la aprueba alguien— y ninguna de esas tres se contaba en ningún sitio.
 */

export const AprobacionesInputSchema = z.object({ workspaceId: z.string().uuid() });
export type AprobacionesInput = z.infer<typeof AprobacionesInputSchema>;

/** Las clases de decisión, en el orden en que la pantalla las enseña: el método primero. */
export const CLASES_PENDIENTES = ['gate', 'derecho', 'insight', 'design-version'] as const;
export type ClasePendiente = (typeof CLASES_PENDIENTES)[number];

export const ETIQUETA_CLASE_PENDIENTE: Record<ClasePendiente, string> = {
  gate: 'Gates del método',
  derecho: 'Derechos de uso',
  insight: 'Insights propuestos',
  'design-version': 'Design versions en borrador',
};

/** Qué acto espera en cada clase, dicho como lo entiende quien decide. */
export const ACTO_DE_CLASE: Record<ClasePendiente, string> = {
  gate: 'Gates abiertos con el checklist decidido: esperan tu aprobación',
  derecho: 'Evidencia curada cuyos derechos nadie ha concedido ni denegado todavía',
  insight: 'Insights que alguien propuso y esperan que los valides',
  'design-version': 'Design versions en borrador: aprobarlas congela su snapshot',
};

/**
 * Quién decide en cada clase. Son ESPEJOS de las políticas de la base, que es quien lo
 * impone (`gate_update_aprobar`, `derecho_update_decision`, `insight_validar`,
 * `design_version_aprobar`): aquí sirven para saber, sin consultar nada, qué clases aplican
 * al rol y cuáles no hay que enseñar. Un gate lo aprueba el rol que su instancia nombra
 * (`rol_aprobador`), y ése solo puede ser uno de estos dos.
 */
export const ROLES_APROBADORES_DE_GATE = ['sponsor', 'lead-boutique'] as const;
export const ROLES_VALIDAN_INSIGHT = ['lead-boutique', 'disenador'] as const;
/** Aprobar congela el to-be y supera la versión anterior: es un acto del lead, no del
 * sponsor —el sponsor aprueba el GATE que certifica la versión (G5/G6), no la versión—. */
export const ROLES_APRUEBAN_DESIGN_VERSION = ['lead-boutique'] as const;

export const ROLES_POR_CLASE: Record<ClasePendiente, readonly string[]> = {
  gate: ROLES_APROBADORES_DE_GATE,
  derecho: ROLES_DERECHOS,
  insight: ROLES_VALIDAN_INSIGHT,
  'design-version': ROLES_APRUEBAN_DESIGN_VERSION,
};

/** Las clases en las que el rol decide algo, en el orden de la pantalla. Vacío para un
 * stakeholder: mira, comenta, pero no aprueba nada. */
export function clasesDelRol(rol: string): ClasePendiente[] {
  return CLASES_PENDIENTES.filter((clase) => ROLES_POR_CLASE[clase].includes(rol));
}

/** Un derecho de uso sin decidir: la evidencia existe pero no se cita ni sale en entregables. */
export type DerechoPendiente = {
  evidenciaId: string;
  titulo: string;
  fuenteTitulo: string;
  creadoEn: string;
};

/** Un insight propuesto. `afirmacionesSinCita` avisa de lo que el guard de validación va a
 * rechazar (toda afirmación no-hipótesis exige cita): la decisión espera, pero puede que
 * antes falte trabajo, y decirlo evita un viaje en vano. */
export type InsightPendiente = {
  insightId: string;
  titulo: string;
  afirmaciones: number;
  afirmacionesSinCita: number;
  creadoEn: string;
};

/** Una design version en borrador. Aprobarla exige journey to-be enlazado y al menos un
 * elemento de cambio (las mismas condiciones que deshabilitan el botón en su pantalla). */
export type DesignVersionPendiente = {
  designVersionId: string;
  codigo: string;
  titulo: string;
  proyectoCodigo: string;
  journeyEnlazado: boolean;
  conElementos: boolean;
  creadoEn: string;
};

/** Un gate que espera a QUIEN MIRA: es la misma fila del resumen del loop, ya filtrada. */
export type GatePendiente = Omit<AprobacionPendiente, 'esMia'>;

/** Todo lo que el rol puede decidir ahora. Una clase que no aplica al rol viene vacía, igual
 * que una que aplica y no tiene nada: distinguirlas es cosa de `clasesDelRol`. */
export type PendientesDelRol = {
  workspaceId: string;
  gates: GatePendiente[];
  derechos: DerechoPendiente[];
  insights: InsightPendiente[];
  designVersions: DesignVersionPendiente[];
};

/** El total y el reparto por clase: lo que el contador del lateral y la cabecera dicen. */
export type ConteoDePendientes = {
  total: number;
  porClase: Record<ClasePendiente, number>;
};

export function contarPendientes(p: Omit<PendientesDelRol, 'workspaceId'>): ConteoDePendientes {
  const porClase: Record<ClasePendiente, number> = {
    gate: p.gates.length,
    derecho: p.derechos.length,
    insight: p.insights.length,
    'design-version': p.designVersions.length,
  };
  return {
    total: porClase.gate + porClase.derecho + porClase.insight + porClase['design-version'],
    porClase,
  };
}

/**
 * A qué pantalla se decide cada cosa. Un gate se aprueba en su proyecto; derechos e
 * insights, en sus listas con el elemento destacado (es donde están los controles); una
 * design version, en su pantalla propia.
 */
export function destinoDeGate(g: GatePendiente): Destino {
  return { to: '/proyecto/$proyectoId', params: { proyectoId: g.proyectoId } };
}
export function destinoDeDerecho(d: DerechoPendiente): Destino {
  return { to: '/evidencia', search: { destacar: d.evidenciaId } };
}
export function destinoDeInsight(i: InsightPendiente): Destino {
  return { to: '/insights', search: { destacar: i.insightId } };
}
export function destinoDeDesignVersion(dv: DesignVersionPendiente): Destino {
  return {
    to: '/design-version/$designVersionId',
    params: { designVersionId: dv.designVersionId },
  };
}

/** «1 pendiente» / «3 pendientes»: la concordancia en un sitio, no en cada rótulo. */
export function etiquetaDePendientes(n: number): string {
  return `${n} ${n === 1 ? 'pendiente' : 'pendientes'}`;
}
