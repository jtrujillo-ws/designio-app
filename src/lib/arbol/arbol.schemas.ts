import { z } from 'zod';

/**
 * Proyección de lectura del árbol de navegación (SPEC-02, ADR-0003):
 * Cliente → Servicios → Retos → Proyectos sobre los agregados de CTX-03/04.
 * Módulo compartido client/server: solo tipos y contratos, sin datos.
 */

export const ArbolInputSchema = z
  .object({ workspaceId: z.string().uuid().optional() })
  .optional();

export type ProyectoArbol = {
  id: string;
  codigo: string;
  titulo: string;
  estado: string;
};

export type RetoArbol = {
  id: string;
  codigo: string;
  titulo: string;
  estado: string;
  origen: string | null;
  metricaObjetivo: string;
  proyectos: ProyectoArbol[];
};

export type RetoQueAfecta = { id: string; codigo: string; titulo: string };

/**
 * El estado efectivo VIGENTE del servicio (RF-06.10): la última constatación que dejaron sus
 * releases verificados. Es el estado OPERATIVO —lo que el servicio hace hoy de verdad—, y no
 * hay que confundirlo con `ServicioArbol.estado`, que es el estado de gestión del servicio en
 * el árbol. Null mientras nadie haya constatado nada: un servicio recién creado no tiene
 * estado efectivo, y decirlo es más honesto que fingir uno vacío.
 */
export type EstadoEfectivoDelServicio = {
  codigo: string;
  constatadoEn: string;
  /** De qué design version salió el release que lo dejó así: sin esto el código no ubica. */
  designVersionCodigo: string;
  resumen: string;
};

export type ServicioArbol = {
  id: string;
  nombre: string;
  estado: string;
  /** Lo que el servicio hace HOY, derivado de lo que se constató (RF-06.10). */
  estadoEfectivo: EstadoEfectivoDelServicio | null;
  /** Retos anclados en este servicio (su ubicación en el árbol, RF-02.3). */
  retos: RetoArbol[];
  /** Retos anclados en OTRO servicio que afectan a este (sin duplicar la relación). */
  retosQueAfectan: RetoQueAfecta[];
};

export type ArbolWorkspace = {
  workspaceId: string;
  workspaceNombre: string;
  servicios: ServicioArbol[];
};
