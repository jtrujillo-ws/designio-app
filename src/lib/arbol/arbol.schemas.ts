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

export type ServicioArbol = {
  id: string;
  nombre: string;
  estado: string;
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
