import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import type { ArbolWorkspace, ProyectoArbol, RetoArbol, ServicioArbol } from './arbol.schemas';

/**
 * Construye la proyección del árbol (RF-02.1/02.2) con lecturas planas + ensamblado en
 * memoria: volumen de piloto, proyección síncrona (nota técnica de SPEC-02). Corre DENTRO
 * de una transacción con contexto RLS — las políticas ya acotan al workspace del usuario;
 * el filtro explícito por workspace_id es la capa 2.
 */
export async function construirArbol(
  tx: TransactionSql,
  workspaceId: string,
  workspaceNombre: string,
): Promise<ArbolWorkspace> {
  const servicios = await tx`
    select id, nombre, estado from servicio
    where workspace_id = ${workspaceId}
    order by creado_en`;
  const retos = await tx`
    select id, servicio_ancla_id, codigo, titulo, estado, origen, metrica_objetivo from reto
    where workspace_id = ${workspaceId}
    order by codigo`;
  const proyectos = await tx`
    select id, reto_id, codigo, titulo, estado from proyecto
    where workspace_id = ${workspaceId}
    order by codigo`;
  const afectados = await tx`
    select ra.servicio_id, r.id, r.codigo, r.titulo
    from reto_servicio_afectado ra
    join reto r on r.id = ra.reto_id
    where ra.workspace_id = ${workspaceId}
    order by r.codigo`;

  const proyectosPorReto = new Map<string, ProyectoArbol[]>();
  for (const p of proyectos) {
    const retoId = p.reto_id as string;
    const lista = proyectosPorReto.get(retoId) ?? [];
    lista.push({
      id: p.id as string,
      codigo: p.codigo as string,
      titulo: p.titulo as string,
      estado: p.estado as string,
    });
    proyectosPorReto.set(retoId, lista);
  }

  const retosPorServicio = new Map<string, RetoArbol[]>();
  for (const r of retos) {
    const anclaId = r.servicio_ancla_id as string;
    const lista = retosPorServicio.get(anclaId) ?? [];
    lista.push({
      id: r.id as string,
      codigo: r.codigo as string,
      titulo: r.titulo as string,
      estado: r.estado as string,
      origen: (r.origen ?? null) as string | null,
      metricaObjetivo: r.metrica_objetivo as string,
      proyectos: proyectosPorReto.get(r.id as string) ?? [],
    });
    retosPorServicio.set(anclaId, lista);
  }

  const afectanPorServicio = new Map<string, ServicioArbol['retosQueAfectan']>();
  for (const a of afectados) {
    const servicioId = a.servicio_id as string;
    const lista = afectanPorServicio.get(servicioId) ?? [];
    lista.push({ id: a.id as string, codigo: a.codigo as string, titulo: a.titulo as string });
    afectanPorServicio.set(servicioId, lista);
  }

  return {
    workspaceId,
    workspaceNombre,
    servicios: servicios.map((s) => ({
      id: s.id as string,
      nombre: s.nombre as string,
      estado: s.estado as string,
      retos: retosPorServicio.get(s.id as string) ?? [],
      retosQueAfectan: afectanPorServicio.get(s.id as string) ?? [],
    })),
  };
}
