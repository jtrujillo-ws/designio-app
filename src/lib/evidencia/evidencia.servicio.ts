import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import {
  DimensionesEvidenciaSchema,
  ROLES_CURADORES,
  ROLES_DERECHOS,
  type AdjuntarArchivo,
  type AmbitoUso,
  type AprobarItem,
  type ArchivoAdjunto,
  type CrearItemImportacion,
  type DecidirDerechos,
  type EstadoDerechos,
  type EvidenciaCitable,
  type EvidenciaConDerechos,
  type ItemBandeja,
  type RechazarItem,
  type TipoFuente,
} from './evidencia.schemas';
import {
  base64ABytes,
  bytesABase64,
  MAX_ARCHIVOS_POR_ITEM,
  normalizarNombreArchivo,
  verificarArchivo,
} from './sanitizacion';

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
    // UNA sentencia = UN snapshot: el rol que registra la auditoría es exactamente el
    // que autorizó la escritura. En sentencias separadas bajo READ COMMITTED, un cambio
    // de membresía entre ambas auditaría un rol distinto al vigente en el insert. El
    // itemId del payload correlaciona la importación con su decisión posterior.
    const [fila] = await tx`
      with quien as (
        select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
      ),
      nuevo as (
        insert into item_importacion
          (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
        values (${entrada.workspaceId}, ${entrada.titulo}, ${entrada.contenido},
                ${entrada.tipoFuente}, ${entrada.referencia}, ${actorId})
        returning id
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${entrada.workspaceId}, 'ItemImportado',
               jsonb_build_object('itemId', nuevo.id, 'titulo', ${entrada.titulo}::text,
                                  'tipoFuente', ${entrada.tipoFuente}::text),
               ${actorId}, quien.rol
        from nuevo, quien
      )
      select id from nuevo`;
    return { itemId: fila!.id as string };
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

function filaDeBandeja(f: Record<string, unknown>, archivos: ArchivoAdjunto[]): ItemBandeja {
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
    archivos,
  };
}

function filaDeArchivo(f: Record<string, unknown>): ArchivoAdjunto {
  return {
    id: f.id as string,
    nombre: f.nombre as string,
    tipoMime: f.tipo_mime as string,
    bytes: f.bytes as number,
    sha256: f.sha256 as string,
    creadoEn: (f.creado_en as Date).toISOString(),
  };
}

/** Adjuntos de un conjunto de items, agrupados por item. Los BYTES no viajan aquí: solo
 * metadatos y el hash — el contenido se pide archivo por archivo. */
async function archivosPorItem(
  tx: TransactionSql,
  workspaceId: string,
  itemIds: string[],
): Promise<Map<string, ArchivoAdjunto[]>> {
  const mapa = new Map<string, ArchivoAdjunto[]>();
  if (itemIds.length === 0) return mapa;
  const filas = await tx`select id, item_id, nombre, tipo_mime,
      octet_length(contenido) as bytes, sha256, creado_en
    from archivo_importado
    where workspace_id = ${workspaceId} and item_id in ${tx(itemIds)}
    order by creado_en, id`;
  for (const f of filas) {
    const lista = mapa.get(f.item_id as string) ?? [];
    lista.push(filaDeArchivo(f));
    mapa.set(f.item_id as string, lista);
  }
  return mapa;
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

    const visibles = [...pendientes.slice(0, PAGINA_PENDIENTES), ...decididas];
    const adjuntos = await archivosPorItem(
      tx,
      workspaceId,
      visibles.map((f) => f.id as string),
    );

    return {
      pendientes: pendientes
        .slice(0, PAGINA_PENDIENTES)
        .map((f) => filaDeBandeja(f, adjuntos.get(f.id as string) ?? [])),
      hayMasPendientes: pendientes.length > PAGINA_PENDIENTES,
      decididas: decididas.map((f) => filaDeBandeja(f, adjuntos.get(f.id as string) ?? [])),
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

const EVIDENCIAS_PICKER = 200;

/** Evidencias del workspace para enlazar desde checklists u otros módulos citantes
 * (RF-04.6). Viene ya marcada con si puede citarse y por qué no: la UI deshabilita lo
 * bloqueado con su explicación en vez de dejar que el usuario descubra el error al
 * guardar. El bloqueo real lo impone la base (guard `checklist_item_derechos`); esto es
 * la capa que lo hace legible. hayMas avisa que el picker está recortado a las más
 * recientes (búsqueda/paginación llegan con la biblioteca CTX-07). */
export async function listarEvidencias(
  actorId: string,
  workspaceId: string,
): Promise<{ evidencias: EvidenciaCitable[]; hayMas: boolean }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`select id, titulo,
        evidencia_usable(id, workspace_id, 'cliente') as citable,
        evidencia_motivo_bloqueo(id, workspace_id, 'cliente') as motivo
      from evidencia
      where workspace_id = ${workspaceId}
      order by creado_en desc, id desc
      limit ${EVIDENCIAS_PICKER + 1}`;
    return {
      evidencias: filas.slice(0, EVIDENCIAS_PICKER).map((f) => ({
        id: f.id as string,
        titulo: f.titulo as string,
        citable: f.citable as boolean,
        motivoBloqueo: (f.motivo ?? null) as string | null,
      })),
      hayMas: filas.length > EVIDENCIAS_PICKER,
    };
  });
}

/**
 * Evidencia del workspace con sus DERECHOS vivos y sus adjuntos (pantalla de derechos,
 * RF-03.10). El jsonb de dimensiones guarda lo que el curador declaró al aprobar
 * (snapshot congelado, ADR-0010); lo que bloquea aguas abajo es esta fila, que se
 * concede y se revoca.
 */
export async function listarEvidenciaConDerechos(
  actorId: string,
  workspaceId: string,
): Promise<{ evidencias: EvidenciaConDerechos[]; hayMas: boolean }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const filas = await tx`select e.id, e.titulo, e.resumen, e.es_estado_actual, e.creado_en,
        d.estado, d.ambito, d.base, d.vence_en::text as vence_en, d.decidido_en,
        i.id as item_id,
        evidencia_usable(e.id, e.workspace_id, 'cliente') as citable,
        evidencia_motivo_bloqueo(e.id, e.workspace_id, 'cliente') as motivo
      from evidencia e
      left join derecho_uso d on d.evidencia_id = e.id and d.workspace_id = e.workspace_id
      left join item_importacion i on i.evidencia_id = e.id and i.workspace_id = e.workspace_id
      where e.workspace_id = ${workspaceId}
      order by e.creado_en desc, e.id desc
      limit ${EVIDENCIAS_PICKER + 1}`;

    const pagina = filas.slice(0, EVIDENCIAS_PICKER);
    const adjuntos = await archivosPorItem(
      tx,
      workspaceId,
      pagina.map((f) => f.item_id as string | null).filter((id): id is string => id !== null),
    );

    return {
      evidencias: pagina.map((f) => ({
        id: f.id as string,
        titulo: f.titulo as string,
        resumen: f.resumen as string,
        esEstadoActual: f.es_estado_actual as boolean,
        creadoEn: (f.creado_en as Date).toISOString(),
        derechos: {
          // El backfill de la migración garantiza la fila; el fallback deja la pantalla
          // en fail-closed si alguna vez faltara, en vez de romperse.
          estado: (f.estado ?? 'pendiente') as EstadoDerechos,
          ambito: (f.ambito ?? 'interno') as AmbitoUso,
          base: (f.base ?? '') as string,
          // Calendárica pura: viaja como texto desde la base (`::text`), nunca como
          // instante — formatearla con huso la correría de día.
          venceEn: (f.vence_en ?? null) as string | null,
          decididoEn: f.decidido_en ? (f.decidido_en as Date).toISOString() : null,
        },
        citable: f.citable as boolean,
        motivoBloqueo: (f.motivo ?? null) as string | null,
        archivos: f.item_id ? (adjuntos.get(f.item_id as string) ?? []) : [],
      })),
      hayMas: filas.length > EVIDENCIAS_PICKER,
    };
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
    // Gate temprano (mensaje claro antes de trabajar); el rol que se AUDITA no sale de
    // aquí sino del RETURNING del update decisor — mismo snapshot que su política RLS.
    await rolCurador(tx, actorId, entrada.workspaceId);

    const [item] = await tx`
      select id, titulo, contenido, tipo_fuente, referencia
      from item_importacion
      where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId} and estado = 'pendiente'`;
    if (!item) throw new ErrorCuraduria('El item no existe o ya fue decidido');

    const segmentoIds = [...new Set(entrada.dimensiones.segmentoIds)];

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

    // Los DERECHOS nacen PENDIENTES (RF-03.10, SYS-14): declarar el consentimiento en las
    // dimensiones es la foto de lo que el curador sabía; conceder el uso es otro acto,
    // con su propia base documental y su propio responsable. Hasta que ocurra, la
    // evidencia existe pero no se cita ni sale en un entregable — fail-closed. El
    // constraint trigger `evidencia_con_derechos` verifica al commit que esta fila exista:
    // ninguna evidencia puede quedar sin registro de derechos.
    await tx`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
      values (${entrada.workspaceId}, ${evidenciaId}, ${actorId})`;

    // Anclaje relacional de segmentos: el vínculo se crea desde la propia tabla segmento
    // (validación y enlace en UNA sentencia, mismo snapshot) y la FK compuesta impide
    // borrar un segmento referenciado — el jsonb conserva el snapshot congelado, la
    // integridad vive aquí. Si falta alguno, el conteo delata y la transacción revierte.
    if (segmentoIds.length > 0) {
      const enlazados = await tx`insert into evidencia_segmento (evidencia_id, segmento_id, workspace_id)
        select ${evidenciaId}, s.id, ${entrada.workspaceId}
        from segmento s
        where s.workspace_id = ${entrada.workspaceId} and s.id in ${tx(segmentoIds)}`;
      if (enlazados.count !== segmentoIds.length) {
        throw new ErrorCuraduria('Algún segmento referenciado no existe en este workspace');
      }
    }

    // La política de UPDATE solo alcanza pendientes: si otro curador decidió en paralelo,
    // esto afecta 0 filas y la transacción entera se revierte. El RETURNING evalúa
    // workspace_role en el snapshot de ESTA sentencia: el rol auditado es exactamente
    // el que autorizó la decisión (en sentencias separadas, un cambio de membresía
    // entre lead-boutique y diseñador registraría el rol viejo).
    const selladas = await tx`update item_importacion
      set estado = 'aprobado', decidido_por = ${actorId}, decidido_en = now(), evidencia_id = ${evidenciaId}
      where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId} and estado = 'pendiente'
      returning workspace_role(${actorId}, ${entrada.workspaceId}) as rol`;
    if (selladas.length === 0) throw new ErrorCuraduria('El item ya fue decidido por otra persona');

    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (${entrada.workspaceId}, 'EvidenciaCurada',
        ${tx.json({ itemId: entrada.itemId, evidenciaId, esEstadoActual: entrada.esEstadoActual })},
        ${actorId}, ${selladas[0]!.rol as string})`;

    return { evidenciaId };
  });
}

export async function rechazarItem(actorId: string, entrada: RechazarItem): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId); // gate temprano (mensaje claro)
    // Igual que en aprobar: el rol auditado sale del snapshot del update decisor.
    const selladas = await tx`update item_importacion
      set estado = 'rechazado', decidido_por = ${actorId}, decidido_en = now()
      where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId} and estado = 'pendiente'
      returning workspace_role(${actorId}, ${entrada.workspaceId}) as rol`;
    if (selladas.length === 0) throw new ErrorCuraduria('El item no existe o ya fue decidido');
    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (${entrada.workspaceId}, 'ItemRechazado', ${tx.json({ itemId: entrada.itemId })}, ${actorId}, ${selladas[0]!.rol as string})`;
  });
}

// ── Archivos adjuntos del material importado (RF-03.1, RF-09.8) ──

/** Candado por item: el tope de adjuntos se comprueba y se aplica en la misma
 * transacción; sin él, dos subidas concurrentes contarían el mismo snapshot y pasarían
 * ambas. Mismo patrón que los candados del método. */
async function bloquearItem(tx: TransactionSql, itemId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:item:' || ${itemId}, 42))`;
}

/**
 * Adjunta un archivo al material de la bandeja. El archivo cuelga del ITEM (llega antes
 * de que exista curaduría) y solo mientras siga PENDIENTE: lo decidido es inmutable
 * (SYS-17). Validación de formato ANTES de tocar la base (RF-09.8): allowlist cerrada +
 * firma mágica — no se confía ni en la extensión ni en el `type` del navegador.
 */
export async function adjuntarArchivo(
  actorId: string,
  entrada: AdjuntarArchivo,
): Promise<{ archivoId: string; sha256: string }> {
  const bytes = base64ABytes(entrada.contenidoBase64);
  const veredicto = verificarArchivo(bytes, entrada.tipoMime);
  if (!veredicto.ok) throw new ErrorCuraduria(veredicto.motivo);
  const nombre = normalizarNombreArchivo(entrada.nombre);

  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearItem(tx, entrada.itemId);

    const [cuenta] = await tx`select count(*)::int as n from archivo_importado
      where item_id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId}`;
    if ((cuenta!.n as number) >= MAX_ARCHIVOS_POR_ITEM) {
      throw new ErrorCuraduria(
        `Este material ya tiene ${MAX_ARCHIVOS_POR_ITEM} adjuntos: la bandeja es curaduría, no un repositorio`,
      );
    }

    // UNA sentencia = UN snapshot: el rol auditado es el que autorizó la escritura.
    const [fila] = await tx`
      with quien as (
        select workspace_role(${actorId}, ${entrada.workspaceId}) as rol
      ),
      nuevo as (
        insert into archivo_importado
          (workspace_id, item_id, nombre, tipo_mime, contenido, creado_por)
        values (${entrada.workspaceId}, ${entrada.itemId}, ${nombre}, ${entrada.tipoMime},
                ${Buffer.from(bytes)}, ${actorId})
        returning id, sha256
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${entrada.workspaceId}, 'ArchivoAdjuntado',
               jsonb_build_object('itemId', ${entrada.itemId}::uuid, 'archivoId', nuevo.id,
                                  'nombre', ${nombre}::text, 'tipoMime', ${entrada.tipoMime}::text,
                                  'sha256', nuevo.sha256, 'bytes', ${bytes.length}::int),
               ${actorId}, quien.rol
        from nuevo, quien
        returning id
      )
      select id, sha256 from nuevo`;
    return { archivoId: fila!.id as string, sha256: fila!.sha256 as string };
  });
}

/** Baja un adjunto mal subido. La política solo lo permite mientras el item siga
 * pendiente y a quien lo subió o a un curador: nada que ya sea evidencia se borra. */
export async function eliminarArchivo(
  actorId: string,
  workspaceId: string,
  archivoId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const borradas = await tx`
      with quien as (
        select workspace_role(${actorId}, ${workspaceId}) as rol
      ),
      fuera as (
        delete from archivo_importado
        where id = ${archivoId} and workspace_id = ${workspaceId}
        returning id, item_id, nombre
      ),
      evento as (
        insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        select ${workspaceId}, 'ArchivoRetirado',
               jsonb_build_object('archivoId', fuera.id, 'itemId', fuera.item_id,
                                  'nombre', fuera.nombre),
               ${actorId}, quien.rol
        from fuera, quien
        returning id
      )
      select id from fuera`;
    if (borradas.length === 0) {
      throw new ErrorCuraduria(
        'El adjunto no existe, su material ya fue curado o no puedes retirarlo',
      );
    }
  });
}

/** Bytes de un adjunto para descarga/preview. Viajan base64 dentro de la respuesta de la
 * server function: no se abre una ruta HTTP nueva para binarios, así el acceso pasa por
 * exactamente el mismo camino (sesión → RLS) que el resto de los datos. */
export async function archivoParaDescarga(
  actorId: string,
  workspaceId: string,
  archivoId: string,
): Promise<{ nombre: string; tipoMime: string; sha256: string; contenidoBase64: string } | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await tx`select nombre, tipo_mime, sha256, contenido
      from archivo_importado where id = ${archivoId} and workspace_id = ${workspaceId}`;
    if (!fila) return null;
    return {
      nombre: fila.nombre as string,
      tipoMime: fila.tipo_mime as string,
      sha256: fila.sha256 as string,
      contenidoBase64: bytesABase64(new Uint8Array(fila.contenido as Uint8Array)),
    };
  });
}

// ── Derechos de uso (RF-03.10, SYS-14) ──

/**
 * Concede, deniega o REVOCA derechos sobre una evidencia. Es el acto que desbloquea
 * (o vuelve a bloquear) citarla y exportarla: la base lo impone, esto solo lo ejecuta.
 * A diferencia del resto del dominio, aquí sí se vuelve atrás — un consentimiento se
 * retira — y por eso cada decisión deja evento con su estado previo (lo emite el guard
 * de la transición, también para SQL crudo).
 */
export async function decidirDerechos(actorId: string, entrada: DecidirDerechos): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Gate temprano (mensaje claro antes de trabajar); la política RLS es la capa 1.
    const [fila] = await tx`select workspace_role(${actorId}, ${entrada.workspaceId}) as rol`;
    const rol = (fila?.rol ?? null) as string | null;
    if (!rol || !(ROLES_DERECHOS as readonly string[]).includes(rol)) {
      throw new ErrorCuraduria(
        'Solo lead-boutique o admin-cliente conceden o deniegan derechos de uso',
      );
    }

    const decididas = await tx`update derecho_uso
      set estado = ${entrada.decision},
          ambito = ${entrada.decision === 'concedido' ? entrada.ambito : 'interno'},
          base = ${entrada.base},
          vence_en = ${entrada.decision === 'concedido' ? entrada.venceEn : null}::date,
          decidido_por = ${actorId},
          decidido_en = now()
      where evidencia_id = ${entrada.evidenciaId} and workspace_id = ${entrada.workspaceId}
      returning id`;
    if (decididas.length === 0) {
      throw new ErrorCuraduria('La evidencia no existe en este workspace');
    }
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
