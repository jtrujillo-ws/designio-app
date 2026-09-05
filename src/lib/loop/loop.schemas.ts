import { z } from 'zod';

/**
 * Contratos de la pantalla Loop (la vista de aterrizaje de un servicio). Módulo compartido
 * client/server: solo tipos y validadores, sin datos ni secretos.
 *
 * La pantalla lee UNA proyección por servicio (`resumenDelLoop`) además del árbol: de ahí
 * salen el estado del loop de cada proyecto, lo que espera a alguien y los datos del
 * journey en curso. «Te toca a ti» y los contadores del lateral beben de la misma respuesta,
 * no de dos consultas parecidas.
 */

export const ResumenLoopInputSchema = z.object({
  workspaceId: z.string().uuid(),
  /** El servicio que la pantalla enseña. Ausente: el primero del workspace, con el mismo
   * orden que el árbol (creado_en, id), para que ambos hablen del mismo servicio. */
  servicioId: z.string().uuid().optional(),
});
export type ResumenLoopInput = z.infer<typeof ResumenLoopInputSchema>;

/** Lo que del método sabe un proyecto: qué gates firmó y si su reto ya cerró el post mortem. */
export type GatesDeProyecto = {
  proyectoId: string;
  proyectoCodigo: string;
  retoId: string;
  retoCodigo: string;
  servicioId: string;
  /** Números de gate (0–7) ya aprobados. La base exige que sean un prefijo 0..n. */
  aprobados: number[];
  /** El outcome review del reto está completado con veredicto (J7 hecho). */
  reviewCompletado: boolean;
};

/**
 * Un gate ABIERTO (el primero pendiente de su proyecto) con el checklist entero decidido:
 * ya no espera trabajo, espera a su aprobador. Es el predicado que la pantalla llama
 * «aprobación pendiente». La suficiencia completa (criterios de G0, registry de G6, decisiones
 * en revisión…) la juzga la base al aprobar: aquí solo se cuenta lo que dejó de ser trabajo.
 */
export type AprobacionPendiente = {
  gateId: string;
  numero: number;
  rolAprobador: 'sponsor' | 'lead-boutique';
  /** El rol aprobador es el de quien mira: es SU aprobación, no una que espera a otro. */
  esMia: boolean;
  proyectoId: string;
  proyectoCodigo: string;
  retoCodigo: string;
};

/** El release más avanzado del servicio (desplegado o verificado antes que planificado). */
export type ReleaseDelServicio = {
  id: string;
  codigo: string;
  titulo: string;
  estado: 'planificado' | 'desplegado' | 'verificado';
  designVersionId: string;
  designVersionCodigo: string;
  /** Días desde el despliegue, contados por el calendario de la base; null si aún no salió. */
  diasVivo: number | null;
};

/** Lo que el Metric Registry del reto actual ya sabe decir. */
export type MetricasDelReto = {
  registryFirmado: boolean;
  /** Entradas KPI con al menos un snapshot recibido. */
  listas: number;
  total: number;
  /** Entradas con una entrega PENDIENTE o VENCIDA según su cadencia —con el reto en medición
   * y la ventana abierta— que QUIEN MIRA puede cargar: curador, o propietario del dato de esa
   * entrada. Es el mismo juicio que la pantalla del proyecto hace por entrada. */
  entregasPendientesMias: number;
  /** La primera entrada del registry: es la cifra que la cabecera enseña. */
  primaria: {
    nombre: string;
    lineaBase: string | null;
    objetivo: string;
    /** Último snapshot de la serie; null mientras no llegue ninguno. */
    actual: string | null;
  } | null;
};

export type ResumenDelLoop = {
  workspaceId: string;
  /** El servicio del que habla la proyección; null en un workspace sin servicios. */
  servicioId: string | null;
  /** Hay evidencia curada en el workspace: el arranque en frío (J1) ya ocurrió. */
  hayEvidencia: boolean;
  /** Items de la bandeja de importación sin decidir. */
  importacionPendientes: number;
  /** TODOS los proyectos del workspace: el árbol pinta con esto el journey de cada reto. */
  proyectos: GatesDeProyecto[];
  aprobaciones: AprobacionPendiente[];
  /** Del servicio actual. */
  release: ReleaseDelServicio | null;
  /** Del reto del proyecto actual del servicio. */
  metricas: MetricasDelReto | null;
};
