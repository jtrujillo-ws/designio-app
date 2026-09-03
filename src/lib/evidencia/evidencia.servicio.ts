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
  nombreSeguroParaFormato,
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
  /**
   * Historial de decisiones, también alcanzable ENTERO por keyset. Estuvo acotado a las
   * más recientes, y eso dejaba una promesa sin ruta: un item RECHAZADO conserva sus
   * archivos (SYS-17) y no tiene `evidencia_id`, así que no aparece en la pantalla de
   * evidencias; pasadas las primeras decisiones, sus originales seguían ahí, RLS los
   * dejaba leer y el producto no daba ningún camino para llegar. «Lo que la base permite,
   * la pantalla lo ofrece» leído del revés: retener sin ruta de acceso es retener nada.
   */
  decididas: ItemBandeja[];
  hayMasDecididas: boolean;
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

/**
 * Bandeja del workspace: pendientes e historial de decididas, cada lista con SU cursor
 * keyset independiente. Pasar uno de los dos cursores pide la página siguiente de esa
 * lista y devuelve la otra vacía: son dos recorridos distintos y mezclarlos duplicaría
 * payload sin que nadie lo mirara.
 */
export async function listarBandeja(
  actorId: string,
  workspaceId: string,
  antesDe?: string,
  antesDeDecidida?: string,
): Promise<Bandeja> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Keyset (creado_en, id) — estable ante inserciones mientras se pagina, a diferencia
    // de un offset. El cursor viaja como id y su (creado_en, id) se resuelve aquí con la
    // precisión de la base (serializar el timestamp perdería los microsegundos y saltaría
    // o repetiría filas). Se pide una fila extra para saber si hay más.
    const pendientes = antesDeDecidida
      ? []
      : await tx`
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

    // Mismo keyset que los pendientes, sobre `(decidido_en, id)`: el CHECK de la tabla
    // garantiza que un item no pendiente tiene `decidido_en`, así que el par nunca es
    // parcialmente nulo y el orden es total. Una fila extra para saber si hay más.
    const decididas = antesDe
      ? []
      : await tx`
        select id, titulo, tipo_fuente, referencia, estado,
               left(contenido, ${LARGO_EXTRACTO}) as extracto,
               length(contenido) > ${LARGO_EXTRACTO} as truncado,
               creado_en, decidido_en
        from item_importacion
        where workspace_id = ${workspaceId} and estado <> 'pendiente'
          ${antesDeDecidida
            ? tx`and (decidido_en, id) < (select i2.decidido_en, i2.id from item_importacion i2
                  where i2.id = ${antesDeDecidida} and i2.workspace_id = ${workspaceId})`
            : tx``}
        order by decidido_en desc, id desc
        limit ${DECIDIDAS_RECIENTES + 1}`;

    const visibles = [
      ...pendientes.slice(0, PAGINA_PENDIENTES),
      ...decididas.slice(0, DECIDIDAS_RECIENTES),
    ];
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
      decididas: decididas
        .slice(0, DECIDIDAS_RECIENTES)
        .map((f) => filaDeBandeja(f, adjuntos.get(f.id as string) ?? [])),
      hayMasDecididas: decididas.length > DECIDIDAS_RECIENTES,
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

/** Página de la pantalla de derechos. Cada fila es una tarjeta con formulario y adjuntos,
 * así que la página es más corta que la de la bandeja; lo que importa es que TODA la
 * evidencia sea alcanzable paginando, no cuántas caben de una vez. */
export const PAGINA_DERECHOS = 50;

/**
 * Evidencia del workspace con sus DERECHOS vivos y sus adjuntos (pantalla de derechos,
 * RF-03.10). El jsonb de dimensiones guarda lo que el curador declaró al aprobar
 * (snapshot congelado, ADR-0010); lo que bloquea aguas abajo es esta fila, que se
 * concede y se revoca.
 *
 * Paginación keyset `(creado_en, id)`, el mismo patrón que `listarBandeja`. No es una
 * mejora de rendimiento: con un tope duro y sin cursor, la evidencia más antigua de un
 * workspace con historia quedaba PERMANENTEMENTE fuera de la única pantalla desde la que
 * se conceden y revocan derechos — y como los derechos nacen `pendiente` (fail-closed),
 * esa evidencia quedaba también permanentemente incitable e inexportable, sin camino de
 * reparación en el producto. El cursor viaja como id y su `(creado_en, id)` se resuelve
 * en la base: serializar el timestamp perdería microsegundos y saltaría o repetiría filas.
 */
export async function listarEvidenciaConDerechos(
  actorId: string,
  workspaceId: string,
  antesDe?: string,
): Promise<{ evidencias: EvidenciaConDerechos[]; hayMas: boolean }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El item se trae con subconsulta escalar y no con un join: `item_importacion.evidencia_id`
    // no es único, y un join que multiplicara filas haría que `limit` contase duplicados y
    // dejara evidencia real fuera de la página — el mismo daño que el tope duro.
    const filas = await tx`select e.id, e.titulo, e.resumen, e.es_estado_actual, e.creado_en,
        d.estado, d.ambito, d.base, d.vence_en::text as vence_en, d.decidido_en,
        (select i.id from item_importacion i
          where i.evidencia_id = e.id and i.workspace_id = e.workspace_id
          order by i.creado_en, i.id limit 1) as item_id,
        evidencia_usable(e.id, e.workspace_id, 'cliente') as citable,
        evidencia_motivo_bloqueo(e.id, e.workspace_id, 'cliente') as motivo
      from evidencia e
      left join derecho_uso d on d.evidencia_id = e.id and d.workspace_id = e.workspace_id
      where e.workspace_id = ${workspaceId}
        ${antesDe
          ? tx`and (e.creado_en, e.id) < (select e2.creado_en, e2.id from evidencia e2
                where e2.id = ${antesDe} and e2.workspace_id = ${workspaceId})`
          : tx``}
      order by e.creado_en desc, e.id desc
      limit ${PAGINA_DERECHOS + 1}`;

    const pagina = filas.slice(0, PAGINA_DERECHOS);
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
      hayMas: filas.length > PAGINA_DERECHOS,
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
    // Sellar el item y adjuntarle material se serializan: la política del adjunto exige que
    // el item siga `pendiente`, pero eso es un predicado sobre una instantánea — una subida
    // podía comprobarlo, este sello commitear, y la subida entrar después, con las dos
    // transacciones en lo cierto en su propio snapshot y equivocadas juntas. El mismo
    // candado lo toma el trigger `item_sellado_candado` para los caminos que no pasan por
    // aquí; se toma también ANTES de trabajar para no construir la evidencia entera y
    // descubrir al final que había que esperar.
    await bloquearItem(tx, entrada.itemId);

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
    // Mismo candado que en aprobar, y por lo mismo: rechazar también SELLA el item, y un
    // item rechazado conserva sus archivos (SYS-17). Una subida en vuelo no puede colarse
    // detrás del sello.
    await bloquearItem(tx, entrada.itemId);
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
 *
 * El nombre se ata además al formato ya verificado: validar bytes y nombre por separado
 * dejaba pasar un `payload.html` declarado `text/plain` con HTML dentro, que se guardaba
 * con esa extensión y se descargaba como un fichero ejecutable en el disco de quien lo
 * abriera. `nombreSeguroParaFormato` garantiza que la extensión FINAL corresponda al
 * formato que sí se comprobó por bytes.
 */
export async function adjuntarArchivo(
  actorId: string,
  entrada: AdjuntarArchivo,
): Promise<{ archivoId: string; sha256: string }> {
  const bytes = base64ABytes(entrada.contenidoBase64);
  const veredicto = verificarArchivo(bytes, entrada.tipoMime);
  if (!veredicto.ok) throw new ErrorCuraduria(veredicto.motivo);
  const nombre = nombreSeguroParaFormato(entrada.nombre, entrada.tipoMime);

  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El candado se toma aquí y OTRA VEZ dentro del trigger (es reentrante): aquí para no
    // hacer el trabajo de la inserción sabiendo que habrá que esperar, y allí para que lo
    // tomen también los caminos que no pasan por este servicio.
    await bloquearItem(tx, entrada.itemId);

    // UNA sentencia = UN snapshot: el rol auditado es el que autorizó la escritura.
    // El insert del evento NO lleva `returning`: con RLS, un INSERT ... RETURNING exige
    // además pasar la política de SELECT, y la auditoría solo la leen los roles que
    // rinden cuentas (RF-01.6) — un stakeholder que adjunta un archivo GENERA el evento
    // pero no puede leerlo, así que pedir la fila de vuelta rompería la escritura.
    // El TOPE ya no se cuenta aquí. Contarlo en la app era contar «lo que este usuario
    // ve»: desde 20260902210000 `archivo_select` solo enseña a quien no cura los adjuntos
    // que él mismo subió, así que un stakeholder veía cero por muchos que hubiera y subía
    // por encima del tope. Un tope es una propiedad del OBJETO, no de quien mira. Vive en
    // `archivo_item_candado_guard`, que cuenta sin RLS y además serializa.
    let fila;
    try {
      [fila] = await tx`
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
      )
      select id, sha256 from nuevo`;
    } catch (e) {
      // AD001 (tope por item) y AD002 (el material ya fue decidido mientras esperábamos
      // el candado). Los dos mensajes vienen de la base y ya están redactados para no
      // filtrar: ni de quién son los adjuntos, ni quién selló el material ni cuándo
      // (SYS-14: se explica el bloqueo sin decir lo que quien pregunta no podía ver).
      const code = (e as { code?: string }).code;
      if (code === 'AD001' || code === 'AD002') {
        throw new ErrorCuraduria(
          (e as { message?: string }).message ??
            `Este material ya alcanzó el máximo de ${MAX_ARCHIVOS_POR_ITEM} adjuntos`,
        );
      }
      throw e;
    }
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
    // El candado es por ITEM, así que primero hay que saber de qué item cuelga. Esta
    // lectura NO decide nada —si el adjunto no se ve, el DELETE de abajo afecta 0 filas y
    // el mensaje es el mismo— y por eso puede correr antes del candado: lo que no puede
    // correr antes es la sentencia decisora. Sin él, un borrado podía quitar un original
    // justo después de que el curador lo revisara y sellara el material.
    const [dueno] = await tx`select item_id from archivo_importado
      where id = ${archivoId} and workspace_id = ${workspaceId}`;
    if (dueno) await bloquearItem(tx, dueno.item_id as string);
    // El DELETE puede chocar con AD002: su política eligió el adjunto con el item todavía
    // pendiente, y para cuando el trigger soltó el candado el curador ya había sellado.
    // Sin traducirlo, el curador vería un error de driver en vez del motivo.
    let borradas;
    try {
      borradas = await tx`
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
      )
      select id from fuera`;
    } catch (e) {
      if ((e as { code?: string }).code === 'AD002') {
        throw new ErrorCuraduria(
          (e as { message?: string }).message ?? 'El material ya fue decidido',
        );
      }
      throw e;
    }
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
          decidido_por = ${actorId}
      -- decidido_en NO se escribe aquí: lo sella el guard de la transición y la columna
      -- ni siquiera está en el grant de UPDATE. Si el caller pudiera ponerlo, un UPDATE
      -- directo retro o post-dataría cuándo se concedieron unos derechos.
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
