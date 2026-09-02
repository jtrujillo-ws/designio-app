import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import {
  DimensionesEvidenciaSchema,
  ROLES_CURADORES,
  type AprobarItem,
  type CrearItemImportacion,
  type ItemBandeja,
  type RechazarItem,
  type TipoFuente,
} from './evidencia.schemas';

/**
 * Bandeja de importación y curaduría (SPEC-03, SYS-16): nada entra como evidencia sin
 * acción humana explícita. Capa 1: políticas RLS (miembros leen; humanos aportan; solo
 * curadores de la boutique deciden y SOLO sobre pendientes — decidido = inmutable).
 * Capa 2: los re-checks de este módulo — estado ACTUAL de la cuenta en toda operación
 * (el JWT vive 7 días y las server functions son invocables directo) y rol curador en
 * las decisiones.
 */

export class ErrorCuraduria extends Error {}

const LARGO_EXTRACTO = 400;

export async function crearItem(
  actorId: string,
  entrada: CrearItemImportacion,
): Promise<{ itemId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [item] = await tx`insert into item_importacion
      (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
      values (${entrada.workspaceId}, ${entrada.titulo}, ${entrada.contenido},
              ${entrada.tipoFuente}, ${entrada.referencia}, ${actorId})
      returning id`;
    // Con el id en el payload, la auditoría correlaciona la importación con su
    // decisión posterior aunque dos items compartan título y tipo de fuente.
    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id)
      values (${entrada.workspaceId}, 'ItemImportado',
        ${tx.json({ itemId: item!.id as string, titulo: entrada.titulo, tipoFuente: entrada.tipoFuente })},
        ${actorId})`;
    return { itemId: item!.id as string };
  });
}

export const PAGINA_PENDIENTES = 100;
export const DECIDIDAS_RECIENTES = 50;

export type Bandeja = {
  /** Cola operativa: TODOS los pendientes son alcanzables paginando por keyset. */
  pendientes: ItemBandeja[];
  hayMasPendientes: boolean;
  /** Solo en la primera página: historial reciente de decisiones (acotado — el
   * registro completo e inmutable vive en evento_dominio y en la propia evidencia). */
  decididas: ItemBandeja[];
};

function filaDeBandeja(f: Record<string, unknown>): ItemBandeja {
  return {
    id: f.id as string,
    titulo: f.titulo as string,
    tipoFuente: f.tipo_fuente as TipoFuente,
    referencia: f.referencia as string,
    estado: f.estado as ItemBandeja['estado'],
    extracto: f.extracto as string,
    truncado: f.truncado as boolean,
    creadoEn: (f.creado_en as Date).toISOString(),
    decididoEn: f.decidido_en ? (f.decidido_en as Date).toISOString() : null,
  };
}

export async function listarBandeja(
  actorId: string,
  workspaceId: string,
  antesDe?: string,
): Promise<Bandeja> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Keyset (creado_en, id) — estable ante inserciones mientras se pagina, a diferencia
    // de un offset. El cursor viaja como id y su (creado_en, id) se resuelve aquí con la
    // precisión de la base (serializar el timestamp perdería los microsegundos y saltaría
    // o repetiría filas). Se pide una fila extra para saber si hay más.
    const pendientes = await tx`
      select id, titulo, tipo_fuente, referencia, estado,
             left(contenido, ${LARGO_EXTRACTO}) as extracto,
             length(contenido) > ${LARGO_EXTRACTO} as truncado,
             creado_en, decidido_en
      from item_importacion
      where workspace_id = ${workspaceId} and estado = 'pendiente'
        ${antesDe
          ? tx`and (creado_en, id) < (select i2.creado_en, i2.id from item_importacion i2
                where i2.id = ${antesDe} and i2.workspace_id = ${workspaceId})`
          : tx``}
      order by creado_en desc, id desc
      limit ${PAGINA_PENDIENTES + 1}`;

    const decididas = antesDe
      ? []
      : await tx`
        select id, titulo, tipo_fuente, referencia, estado,
               left(contenido, ${LARGO_EXTRACTO}) as extracto,
               length(contenido) > ${LARGO_EXTRACTO} as truncado,
               creado_en, decidido_en
        from item_importacion
        where workspace_id = ${workspaceId} and estado <> 'pendiente'
        order by decidido_en desc
        limit ${DECIDIDAS_RECIENTES}`;

    return {
      pendientes: pendientes.slice(0, PAGINA_PENDIENTES).map(filaDeBandeja),
      hayMasPendientes: pendientes.length > PAGINA_PENDIENTES,
      decididas: decididas.map(filaDeBandeja),
    };
  });
}

/**
 * Contenido COMPLETO de un item (RF-03.3): quien cura debe poder inspeccionar todo lo
 * importado antes de decidir — la lista solo lleva un extracto. RLS limita a miembros
 * del workspace; null si el item no existe o no es visible.
 */
export async function contenidoDeItem(
  actorId: string,
  workspaceId: string,
  itemId: string,
): Promise<string | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await tx`select contenido from item_importacion
      where id = ${itemId} and workspace_id = ${workspaceId}`;
    return fila ? (fila.contenido as string) : null;
  });
}

/**
 * Aprobar = curar (RF-03.4/03.5): compone las CINCO dimensiones (proveniencia desde el
 * propio item; lineage null — la importación manual no pasó por AI), crea fuente y
 * evidencia, y sella el item con la evidencia resultante. Todo en una transacción.
 */
export async function aprobarItem(
  actorId: string,
  entrada: AprobarItem,
): Promise<{ evidenciaId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const rol = await rolCurador(tx, actorId, entrada.workspaceId);

    const [item] = await tx`
      select id, titulo, contenido, tipo_fuente, referencia
      from item_importacion
      where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId} and estado = 'pendiente'`;
    if (!item) throw new ErrorCuraduria('El item no existe o ya fue decidido');

    // Las dimensiones quedan CONGELADAS en la evidencia (sin update posterior): los
    // segmentos referenciados deben existir en ESTE workspace o la referencia colgante
    // sería permanente.
    const segmentoIds = [...new Set(entrada.dimensiones.segmentoIds)];
    if (segmentoIds.length > 0) {
      const [validos] = await tx`select count(*)::int as n from segmento
        where workspace_id = ${entrada.workspaceId} and id in ${tx(segmentoIds)}`;
      if ((validos!.n as number) !== segmentoIds.length) {
        throw new ErrorCuraduria('Algún segmento referenciado no existe en este workspace');
      }
    }

    const dimensiones = DimensionesEvidenciaSchema.parse({
      proveniencia: {
        tipoFuente: item.tipo_fuente as string,
        fecha: entrada.dimensiones.fecha,
        localizacion: item.referencia as string,
      },
      metodo: {
        recoleccion: entrada.dimensiones.recoleccion,
        derivada: entrada.dimensiones.derivada,
        segmentoIds,
      },
      calidad: {
        confianza: entrada.dimensiones.confianza,
        corroboraIds: [],
        contradiceIds: [],
      },
      derechos: {
        consentimiento: entrada.dimensiones.consentimiento,
        confidencialidad: entrada.dimensiones.confidencialidad,
      },
      lineage: null,
    });

    const [fuente] = await tx`insert into fuente (workspace_id, tipo, titulo, referencia, creado_por)
      values (${entrada.workspaceId}, ${item.tipo_fuente as string}, ${item.titulo as string},
              ${item.referencia as string}, ${actorId})
      returning id`;

    const [evidencia] = await tx`insert into evidencia
      (workspace_id, fuente_id, titulo, resumen, dimensiones, es_estado_actual, creado_por)
      values (${entrada.workspaceId}, ${fuente!.id as string}, ${item.titulo as string},
              ${entrada.resumen}, ${tx.json(dimensiones)}, ${entrada.esEstadoActual}, ${actorId})
      returning id`;
    const evidenciaId = evidencia!.id as string;

    // La política de UPDATE solo alcanza pendientes: si otro curador decidió en paralelo,
    // esto afecta 0 filas y la transacción entera se revierte.
    const selladas = await tx`update item_importacion
      set estado = 'aprobado', decidido_por = ${actorId}, decidido_en = now(), evidencia_id = ${evidenciaId}
      where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId} and estado = 'pendiente'`;
    if (selladas.count === 0) throw new ErrorCuraduria('El item ya fue decidido por otra persona');

    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (${entrada.workspaceId}, 'EvidenciaCurada',
        ${tx.json({ itemId: entrada.itemId, evidenciaId, esEstadoActual: entrada.esEstadoActual })},
        ${actorId}, ${rol})`;

    return { evidenciaId };
  });
}

export async function rechazarItem(actorId: string, entrada: RechazarItem): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const rol = await rolCurador(tx, actorId, entrada.workspaceId);
    const selladas = await tx`update item_importacion
      set estado = 'rechazado', decidido_por = ${actorId}, decidido_en = now()
      where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId} and estado = 'pendiente'`;
    if (selladas.count === 0) throw new ErrorCuraduria('El item no existe o ya fue decidido');
    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (${entrada.workspaceId}, 'ItemRechazado', ${tx.json({ itemId: entrada.itemId })}, ${actorId}, ${rol})`;
  });
}

/** Capa 2: re-check explícito del rol curador (la política RLS es la capa 1). */
async function rolCurador(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
): Promise<string> {
  const [fila] = await tx`select workspace_role(${actorId}, ${workspaceId}) as rol`;
  const rol = (fila?.rol ?? null) as string | null;
  if (!rol || !(ROLES_CURADORES as readonly string[]).includes(rol)) {
    throw new ErrorCuraduria('Solo lead-boutique o diseñador pueden curar la bandeja');
  }
  return rol;
}
