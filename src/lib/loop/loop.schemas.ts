import { z } from 'zod';
import type { ConteoDePendientes } from '@/lib/aprobaciones/aprobaciones.schemas';

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
  /** El servicio que la pantalla enseña. Ausente —o no visible en este workspace—: el
   * primero, con el mismo orden que el árbol (creado_en, id), para que ambos hablen del mismo. */
  servicioId: z.string().uuid().optional(),
});
export type ResumenLoopInput = z.infer<typeof ResumenLoopInputSchema>;

/** Lo que del método sabe un proyecto: qué gates firmó y si su reto ya cerró el post mortem. */
export type GatesDeProyecto = {
  proyectoId: string;
  proyectoCodigo: string;
  retoId: string;
  retoCodigo: string;
  /** Estado del reto y del proyecto: deciden cuál es el proyecto ACTUAL de un servicio (ver
   * proyectoActualDe). */
  retoEstado: string;
  proyectoEstado: string;
  servicioId: string;
  /** Números de gate (0–7) ya aprobados. La base exige que sean un prefijo 0..n. */
  aprobados: number[];
  /** El post mortem se puede abrir (o ya está abierto): reto en medición, registry firmado y
   * ninguna ventana de KPI abierta —el predicado de `review_insert`—. Hasta entonces J6 sigue
   * en curso: ni con G7 aprobado y la medición sin abrir, ni con ventanas abiertas. */
  postMortemAbrible: boolean;
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
  /** La primera entrada del registry: es la cifra que la cabecera enseña. */
  primaria: {
    nombre: string;
    lineaBase: string | null;
    objetivo: string;
    /** Último snapshot de la serie; null mientras no llegue ninguno. */
    actual: string | null;
  } | null;
};

/**
 * Entregas de métricas que ESPERAN a quien mira en un reto en medición del servicio:
 * entradas con snapshot pendiente o vencido por cadencia (con la ventana abierta) que él
 * puede cargar (curador o propietario del dato). Con el proyecto donde se cargan.
 */
export type EntregaPendiente = {
  retoCodigo: string;
  proyectoId: string | null;
  proyectoCodigo: string | null;
  cuantas: number;
};

export type ResumenDelLoop = {
  workspaceId: string;
  /** El servicio del que habla la proyección: el pedido si es de este workspace, si no el
   * primero; null solo en un workspace sin servicios. */
  servicioId: string | null;
  /** Hay evidencia curada en el workspace: el arranque en frío (J1) ya ocurrió. */
  hayEvidencia: boolean;
  /** Items de la bandeja de importación sin decidir. */
  importacionPendientes: number;
  /** TODOS los proyectos del workspace: el árbol pinta con esto el journey de cada reto. */
  proyectos: GatesDeProyecto[];
  aprobaciones: AprobacionPendiente[];
  /** Cuánto puede decidir AHORA el rol de quien mira, en todo el workspace: gates propios,
   * derechos de uso, insights propuestos y design versions en borrador. Es el contador de
   * la fila «Aprobaciones» del lateral; las filas las lista /aprobaciones con la misma
   * fuente (módulo de aprobaciones). */
  pendientesDelRol: ConteoDePendientes;
  /** Del servicio actual. */
  release: ReleaseDelServicio | null;
  /** Del reto del proyecto actual del servicio. */
  metricas: MetricasDelReto | null;
  /** De TODOS los retos en medición del servicio: dos pueden estar vivos a la vez. */
  entregas: EntregaPendiente[];
};
