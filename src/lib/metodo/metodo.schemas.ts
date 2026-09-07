import { z } from 'zod';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';
import { PERFILES } from './metodo.plantillas';

/** CTX-03 Método y Gobernanza — estados y objetos canónicos (I1: no se renombran). */

export const EstadoRetoSchema = z.enum(['candidato', 'activo', 'en medición', 'cerrado', 'archivado']);
export type EstadoReto = z.infer<typeof EstadoRetoSchema>;

export const VeredictoSchema = z.enum(['logrado', 'parcialmente logrado', 'no logrado', 'no concluyente']);
export type Veredicto = z.infer<typeof VeredictoSchema>;

export const EstadoProyectoSchema = z.enum(['activo', 'en implementación', 'en medición', 'cerrado']);
export type EstadoProyecto = z.infer<typeof EstadoProyectoSchema>;

export const PerfilProyectoSchema = z.enum(['rápido', 'estándar', 'profundo']);
export type PerfilProyecto = z.infer<typeof PerfilProyectoSchema>;

export const GateSchema = z.enum(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
export type Gate = z.infer<typeof GateSchema>;

export const CriterioDeExitoSchema = z.object({
  id: z.string().uuid(),
  kpi: z.string().min(1),
  definicion: z.string().min(1),
  lineaBase: z.object({ valor: z.number(), fecha: z.coerce.date() }).nullable(),
  objetivo: z.number(),
  /** Ventana de medición propia por criterio (SYS-22): días desde el primer release. */
  ventanaDias: z.number().int().positive(),
  fechaPostMortemPrevista: z.coerce.date().nullable(),
});
export type CriterioDeExito = z.infer<typeof CriterioDeExitoSchema>;

export const RetoSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  codigo: z.string().regex(/^R-\d{2,}$/),
  titulo: z.string().min(1),
  estado: EstadoRetoSchema,
  veredicto: VeredictoSchema.nullable(),
  servicioAnclaId: z.string().uuid(),
  serviciosAfectadosIds: z.array(z.string().uuid()),
  criterios: z.array(CriterioDeExitoSchema),
});
export type Reto = z.infer<typeof RetoSchema>;

// ── Contratos ejecutables del slice 1 de SPEC-04 (entradas de server functions y ──
// ── proyecciones de la pantalla del proyecto; los estados en base viajan como slugs) ──

export const CrearRetoSchema = z.object({
  workspaceId: z.string().uuid(),
  servicioAnclaId: z.string().uuid(),
  codigo: z
    .string()
    .trim()
    .regex(/^R-\d{2,}$/, 'Código con forma R-NN'),
  titulo: z.string().trim().min(1, 'El título es obligatorio').max(300),
  descripcion: z.string().trim().max(5000).default(''),
  origen: z.enum(['post-mortem', 'hallazgo-medicion', 'peticion-cliente']),
  metricaObjetivo: z.string().trim().max(200).default(''),
  serviciosAfectados: z.array(z.string().uuid()).max(20).default([]),
});
export type CrearReto = z.infer<typeof CrearRetoSchema>;

export const CriterioSchema = z.object({
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
  kpi: z.string().trim().min(1, 'El KPI es obligatorio').max(200),
  definicion: z.string().trim().max(2000).default(''),
  lineaBaseValor: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .default(null)
    // '' cuenta como AUSENTE: G0 exige línea base REGISTRADA o plan (SYS-22) y un
    // string vacío no es ninguna de las dos.
    .transform((v) => (v === '' ? null : v)),
  lineaBaseFecha: FechaCalendarioSchema.nullable().default(null),
  lineaBasePlan: z.string().trim().max(1000).default(''),
  objetivo: z.string().trim().max(200).default(''),
  ventanaDias: z.number().int().positive().max(3650).nullable().default(null),
  fechaPostMortem: FechaCalendarioSchema.nullable().default(null),
});
export type CriterioEntrada = z.infer<typeof CriterioSchema>;

/** Edición completa de un criterio ANTES de aprobar el G0 del reto (después está
 * congelado): es el camino de reparación de borradores — un criterio incompleto
 * bloquea G0 y agregar otros completos no lo desbloquea. */
export const EditarCriterioSchema = CriterioSchema.omit({ retoId: true }).extend({
  criterioId: z.string().uuid(),
});
export type EditarCriterio = z.infer<typeof EditarCriterioSchema>;

export const ActivarRetoSchema = z.object({
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
  perfil: z.enum(PERFILES),
  proyectoCodigo: z
    .string()
    .trim()
    .regex(/^P-\d{2,}$/, 'Código con forma P-NN'),
  proyectoTitulo: z.string().trim().min(1, 'El título es obligatorio').max(300),
});
export type ActivarReto = z.infer<typeof ActivarRetoSchema>;

export const ProyectoInputSchema = z.object({
  workspaceId: z.string().uuid(),
  proyectoId: z.string().uuid(),
});

/** Los objetos REALES que un ítem puede citar (RF-04.5): nada de casillas sueltas. */
export const CLASES_OBJETO_CITABLE = ['evidencia', 'insight', 'decision'] as const;
export type ClaseObjetoCitable = (typeof CLASES_OBJETO_CITABLE)[number];

export const ETIQUETA_CLASE_OBJETO: Record<ClaseObjetoCitable, string> = {
  evidencia: 'Evidencia',
  insight: 'Insight',
  decision: 'Decisión',
};

export const MarcarItemSchema = z.object({
  workspaceId: z.string().uuid(),
  itemId: z.string().uuid(),
  accion: z.discriminatedUnion('tipo', [
    z.object({
      tipo: z.literal('cumplido'),
      objetoClase: z.enum(CLASES_OBJETO_CITABLE),
      objetoId: z.string().uuid(),
    }),
    z.object({ tipo: z.literal('pendiente') }),
    z.object({ tipo: z.literal('na'), justificacion: z.string().trim().min(1).max(2000) }),
  ]),
});
export type MarcarItem = z.infer<typeof MarcarItemSchema>;

export const AprobarGateSchema = z.object({
  workspaceId: z.string().uuid(),
  gateId: z.string().uuid(),
});
export type AprobarGate = z.infer<typeof AprobarGateSchema>;

/** Proyección de la pantalla del proyecto: método completo de un vistazo. */
export type ItemDeGate = {
  id: string;
  orden: number;
  texto: string;
  estado: 'pendiente' | 'cumplido' | 'na';
  /** El objeto real que lo cumple: su clase gobierna cómo se lee el enlace. */
  objetoClase: ClaseObjetoCitable | null;
  objetoId: string | null;
  objetoTitulo: string | null;
  /** Su decisión pasó a «en revisión» por una reapertura: cumplido deja de contar como
   * suficiencia (RF-04.9) y el guard rechaza la aprobación del gate entero. */
  decisionEnRevision: boolean;
  naJustificacion: string;
};

export type GateDeProyecto = {
  id: string;
  numero: number;
  rolAprobador: 'sponsor' | 'lead-boutique';
  estado: 'pendiente' | 'aprobado';
  aprobadoEn: string | null;
  items: ItemDeGate[];
};

export type EtapaDeProyecto = {
  id: string;
  numero: number;
  nombre: string;
  estado: 'pendiente' | 'en-curso' | 'completada';
};

export type CriterioDeReto = {
  id: string;
  kpi: string;
  definicion: string;
  lineaBaseValor: string | null;
  lineaBaseFecha: string | null;
  lineaBasePlan: string;
  objetivo: string;
  ventanaDias: number | null;
  fechaPostMortem: string | null;
};

export type ProyectoMetodo = {
  id: string;
  codigo: string;
  titulo: string;
  estado: string;
  perfil: 'rapido' | 'estandar' | 'profundo';
  reto: {
    id: string;
    codigo: string;
    titulo: string;
    estado: string;
    criterios: CriterioDeReto[];
    /**
     * Si el reto ya no admite tocar sus criterios, contestado por la BASE.
     *
     * No es un espejo: `reto_criterios_congelados` son DOS condiciones —el G0 que certificó
     * estos criterios y el Metric Registry firmado— y la segunda no se puede deducir de nada
     * que esta pantalla traiga. Un espejo cliente habría ofrecido el formulario a un reto con
     * el registry firmado para que la política lo rechazara. Lo IMPONE la política y lo
     * ANTICIPA esto, y los dos llaman a la misma función.
     */
    criteriosCongelados: boolean;
  };
  etapas: EtapaDeProyecto[];
  gates: GateDeProyecto[];
};

/**
 * Qué le falta a un gate para poder APROBARSE, con el motivo que lo dice.
 *
 * Un botón habilitado es una promesa de que el envío tiene sentido, y el de aprobar el gate
 * la rompía: su `disabled` miraba solo si había una petición en curso. La etiqueta de al lado
 * SÍ sabía cuatro de las razones —ítems pendientes, gates anteriores, criterios de G0, el
 * registry de G6— pero era otra expresión, escrita a mano en el JSX; así que la pantalla
 * decía «Esperando los gates anteriores» con el botón encendido debajo. Dos condiciones
 * parecidas para la misma pregunta son dos verdades, y la de la etiqueta no apagaba nada.
 *
 * Aquí se responde UNA vez y de aquí salen las dos: la etiqueta es el primer motivo y el
 * botón se apaga si hay alguno. Vive en el módulo y no dentro del componente por el mismo
 * motivo que sus hermanos de `medicion.schemas`: lo que la pantalla decide a mano es lo que
 * ningún test alcanza.
 *
 * Espeja las DOS superficies que rechazan esta escritura, que es la lección de esta noche:
 * `gate_aprobar_suficiencia_guard` (checklist, gates anteriores, G0, G2, G6) y
 * `proyecto_a_implementacion_tras_g6_guard`, que rechaza aprobar G6 con el proyecto parado
 * porque su efecto —meterlo en implementación— solo alcanza a un proyecto 'activo'. Esa
 * última no la sabía ni la etiqueta.
 */
export function faltaParaAprobarGate(
  gate: GateDeProyecto,
  contexto: {
    anterioresAprobados: boolean;
    criteriosListosG0: boolean;
    registryFirmadoG6: boolean;
    arquetiposSinVeredicto: number;
    proyectoEstado: string;
  },
): string[] {
  if (gate.estado === 'aprobado') return [];
  const falta: string[] = [];
  const pendientes = gate.items.filter((i) => i.estado === 'pendiente').length;
  if (gate.items.length === 0) {
    falta.push('el gate no tiene checklist instanciado');
  } else if (pendientes > 0) {
    falta.push(`${pendientes} pendientes`);
  }
  // Un ítem cumplido cuya decisión volvió a revisión no cuenta como suficiencia (RF-04.9).
  const enRevision = gate.items.filter((i) => i.estado === 'cumplido' && i.decisionEnRevision);
  if (enRevision.length > 0) {
    falta.push(`${enRevision.length} ítems con decisiones en revisión`);
  }
  if (!contexto.anterioresAprobados) falta.push('Esperando los gates anteriores');
  if (gate.numero === 0 && !contexto.criteriosListosG0) {
    falta.push('Faltan criterios completos (SYS-22)');
  }
  if (gate.numero === 2 && contexto.arquetiposSinVeredicto > 0) {
    falta.push(`${contexto.arquetiposSinVeredicto} arquetipos sin confirmar ni refutar`);
  }
  if (gate.numero === 6 && !contexto.registryFirmadoG6) {
    falta.push('Falta firmar el Metric Registry (SYS-22)');
  }
  // §7: aprobar G6 mete el proyecto en implementación, y ese efecto solo alcanza a un
  // proyecto 'activo'. Con el proyecto parado el guard rechaza la aprobación ENTERA —no la
  // deja pasar sin efecto—, así que ofrecerla es prometer algo que la base ya negó.
  if (gate.numero === 6 && contexto.proyectoEstado !== 'activo') {
    falta.push('El proyecto no está activo: retómalo antes, porque aprobar el plan lo pone en implementación (§7)');
  }
  return falta;
}

/**
 * Qué le falta a UN criterio para que G0 pueda aprobarse (SYS-22).
 *
 * Vivía dentro de la pantalla del proyecto como un `criteriosCompletos` privado que solo
 * sabía decir sí o no, y por el mismo motivo que `faltaParaAprobarGate`: lo que la pantalla
 * decide a mano es lo que ningún test alcanza. En cuanto los criterios se pueden escribir a
 * mano hacen falta las DOS lecturas —la etiqueta de G0, que pregunta por el reto entero, y el
 * reparo de cada fila, que es lo que dice al que rellena qué le queda—, así que se contesta
 * una vez aquí y de aquí salen las dos.
 *
 * Espeja el predicado de `gate_aprobar_suficiencia_guard`: la exigencia real vive en el
 * servidor y en la política, y esto solo la dice ANTES para que nadie llegue a G0 y descubra
 * allí que su criterio no servía.
 */
export function faltaEnCriterio(c: CriterioDeReto): string[] {
  const falta: string[] = [];
  if (c.kpi.trim() === '') falta.push('el KPI');
  if (c.definicion.trim() === '') falta.push('la definición');
  if (c.objetivo.trim() === '') falta.push('el objetivo');
  if (c.ventanaDias === null) falta.push('la ventana de medición');
  // La línea base se acredita de DOS formas y basta una: un valor CON su fecha, o un plan
  // para registrarla (SYS-22). Un valor sin fecha no es ninguna de las dos.
  const conValor = (c.lineaBaseValor ?? '').trim() !== '' && c.lineaBaseFecha !== null;
  if (!conValor && c.lineaBasePlan.trim() === '') {
    falta.push('la línea base: un valor con su fecha, o un plan para registrarla');
  }
  return falta;
}

/** Y el reto entero: sin criterios, o con uno incompleto, G0 no se aprueba. */
export function criteriosCompletos(criterios: CriterioDeReto[]): boolean {
  return criterios.length > 0 && criterios.every((c) => faltaEnCriterio(c).length === 0);
}

/** Los roles que las políticas `criterio_insert` y `criterio_update` aceptan. */
export const ROLES_DEFINEN_CRITERIOS = ['lead-boutique', 'disenador'];

/**
 * Por qué NO se pueden definir ni editar criterios ahora, o `null` si sí se puede.
 *
 * Espeja las DOS superficies que rechazan esta escritura, que es la lección repetida de este
 * repositorio: la política —`workspace_role(…) in ('lead-boutique', 'disenador')`— y
 * `reto_criterios_congelados`, que cierra la puerta cuando el G0 certifica los criterios o
 * cuando el Metric Registry se firma. Ofrecer el formulario sin mirar las dos sería prometer
 * un envío que la base ya negó, y esconderlo de más dejaría a un reto sin forma de aprobar G0.
 *
 * El motivo se DICE, no se deja descubrir por el error del servidor: un botón que no está y
 * no explica por qué es un callejón mudo.
 */
export function motivoParaNoDefinirCriterios(contexto: {
  rol: string;
  criteriosCongelados: boolean;
}): string | null {
  if (!ROLES_DEFINEN_CRITERIOS.includes(contexto.rol)) {
    return 'Los criterios de éxito los define el lead de boutique o quien diseña';
  }
  if (contexto.criteriosCongelados) {
    return 'Los criterios están congelados: el G0 del reto ya fue aprobado o su Metric Registry ya está firmado';
  }
  return null;
}
