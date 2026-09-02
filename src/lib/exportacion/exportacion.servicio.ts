import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { bytesABase64 } from '@/lib/evidencia/sanitizacion';
import {
  CATALOGO_EXPORT,
  PRESUPUESTO_ADJUNTOS_BYTES,
  type ArchivoExportado,
  type EvidenciaBloqueada,
  type FilaExportada,
  type PodaEntregable,
  type ValorJson,
  type Exportacion,
  type Exportar,
} from './exportacion.schemas';

/**
 * Exportación del workspace (RF-01.8) y del paquete entregable (RF-03.10).
 *
 * Corre con la conexión de APLICACIÓN dentro de `conUsuario`, no con la admin: el
 * aislamiento entre tenants (SYS-02, «ninguna exportación combina datos de más de un
 * workspace») queda garantizado por RLS y no por un `where` que alguien pueda olvidar.
 * El permiso y el registro de la ejecución los impone la base en `registrar_exportacion`:
 * sin evento de auditoría no hay exportación, y sin rol adecuado tampoco.
 *
 * En ámbito `entregable` la evidencia se lee de la vista `evidencia_entregable`, que
 * aplica el predicado de derechos en la BASE. Lo excluido no se calla: sale listado en
 * `bloqueadas` con la dimensión que falta (SYS-14).
 *
 * REPEATABLE READ, y es una decisión de corrección, no de rendimiento. La exportación son
 * treinta y pico consultas: el permiso y su evento de auditoría, la vista de derechos, la
 * lista de bloqueadas, un volcado por tabla del catálogo y dos pasadas de adjuntos. Bajo
 * READ COMMITTED cada una abre su propio snapshot, así que una revocación commiteada a
 * media exportación deja la evidencia dentro del paquete (el filtro ya se había
 * materializado) y a la vez en `bloqueadas` — con sus citas y sus ficheros. El manifiesto
 * es un RECIBO (SYS-04): un recibo cosido de treinta instantes distintos no acredita nada,
 * y `generadoEn` solo significa algo si hay un «en» que nombrar. Con un único snapshot, el
 * `registrar_exportacion` que autoriza y audita comparte foto con TODO lo que se emite —
 * la misma disciplina que ya se exige dentro de una sentencia, extendida a la operación.
 */

export class ErrorExportacion extends Error {}

export async function exportarWorkspace(
  actorId: string,
  entrada: Exportar,
): Promise<Exportacion> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);

    // Permiso + auditoría en la misma transacción que lee los datos (RF-01.6/01.8).
    // El instante del manifiesto se lee AQUÍ, del reloj de la base y no del proceso: es el
    // `now()` de la transacción, exactamente el mismo del que `current_date` deriva dentro
    // de `evidencia_usable` para decidir qué derechos siguen vigentes. Sellarlo después
    // con `new Date()` era firmar el recibo con un reloj distinto del que lo emitió: una
    // exportación arrancada antes de medianoche podía incluir evidencia cuyos derechos
    // vencían ese día y fecharse al día siguiente, y cualquier desfase entre el reloj de
    // la base y el del contenedor producía la misma contradicción sin necesidad de
    // medianoche. Con esto, la fecha del manifiesto y la que decidió la caducidad son la
    // misma por construcción, no por suerte — que es lo que hace que `generadoEn`
    // signifique algo en un recibo (SYS-04).
    let rol: string;
    let generadoEn: string;
    try {
      const [fila] = await tx`select registrar_exportacion(${entrada.workspaceId},
        ${entrada.ambito}) as rol, now() as instante`;
      rol = fila!.rol as string;
      generadoEn = (fila!.instante as Date).toISOString();
    } catch (e) {
      if ((e as { code?: string }).code === '42501') {
        throw new ErrorExportacion(
          'Solo lead-boutique o admin-cliente ejecutan la exportación del workspace',
        );
      }
      throw e;
    }

    const [ws] = await tx`select id, nombre, creado_en from workspace
      where id = ${entrada.workspaceId}`;
    // RLS: un workspace ajeno simplemente no existe para esta sesión.
    if (!ws) throw new ErrorExportacion('El workspace no existe o no eres miembro');

    // Qué puede viajar en un entregable: lo decide la VISTA de la base, no un where de
    // la app. De ahí se derivan también las fuentes y los items cuyo séquito acompaña a
    // esa evidencia, para que el paquete sea internamente consistente.
    const filtro =
      entrada.ambito === 'entregable' ? await filtroEntregable(tx, entrada.workspaceId) : null;

    const bloqueadas: EvidenciaBloqueada[] =
      entrada.ambito === 'entregable'
        ? (
            await tx`select id, titulo,
                evidencia_motivo_bloqueo(id, workspace_id, 'cliente') as motivo
              from evidencia
              where workspace_id = ${entrada.workspaceId}
                and not evidencia_usable(id, workspace_id, 'cliente')
              order by creado_en, id`
          ).map((f) => ({
            evidenciaId: f.id as string,
            titulo: f.titulo as string,
            motivo: (f.motivo ?? 'derechos insuficientes') as string,
          }))
        : [];

    const datos: Record<string, FilaExportada[]> = {};
    const conteos: Record<string, number> = {};

    for (const { tabla, orden, poda } of CATALOGO_EXPORT) {
      // En el entregable solo viaja lo que cuelga de evidencia con derechos, y CÓMO se
      // poda cada tabla lo declara su propia entrada del catálogo (no un switch aparte
      // que pueda quedarse corto).
      if (entrada.ambito === 'entregable' && poda.modo === 'fuera') continue;

      const filas = await filasDeTabla(tx, tabla, orden, entrada.workspaceId, filtro, poda);
      datos[tabla] = filas;
      conteos[tabla] = filas.length;
    }

    const archivos = await archivosDelExport(tx, entrada.workspaceId, filtro);
    const bytesIncluidos = archivos
      .filter((a) => a.contenidoBase64 !== null)
      .reduce((suma, a) => suma + a.bytes, 0);

    return {
      manifiesto: {
        formato: 'whitespace-export/1',
        ambito: entrada.ambito,
        workspaceId: ws.id as string,
        workspaceNombre: ws.nombre as string,
        generadoEn,
        generadoPorRol: rol,
        conteos,
        adjuntos: {
          total: archivos.length,
          incluidos: archivos.filter((a) => a.contenidoBase64 !== null).length,
          omitidos: archivos.filter((a) => a.contenidoBase64 === null).length,
          bytesIncluidos,
          presupuestoBytes: PRESUPUESTO_ADJUNTOS_BYTES,
        },
        evidenciaBloqueada: bloqueadas.length,
      },
      workspace: {
        id: ws.id as string,
        nombre: ws.nombre as string,
        creadoEn: (ws.creado_en as Date).toISOString(),
      },
      datos,
      archivos,
      bloqueadas,
    };
  }, { aislamiento: 'repeatable read' });
}

/** Alcance del paquete entregable, derivado ENTERAMENTE de la vista de la base. */
type FiltroEntregable = {
  evidencias: Set<string>;
  fuentes: Set<string>;
  /** Items de la bandeja cuya curaduría produjo evidencia con derechos: sus adjuntos
   * son los originales que el entregable sí puede llevar. */
  items: Set<string>;
};

async function filtroEntregable(
  tx: TransactionSql,
  workspaceId: string,
): Promise<FiltroEntregable> {
  const evidencias = await tx`select id, fuente_id from evidencia_entregable
    where workspace_id = ${workspaceId}`;
  const ids = new Set(evidencias.map((f) => f.id as string));
  const items = await tx`select id from item_importacion
    where workspace_id = ${workspaceId} and evidencia_id is not null
      and evidencia_id in (select id from evidencia_entregable where workspace_id = ${workspaceId})`;
  return {
    evidencias: ids,
    fuentes: new Set(evidencias.map((f) => f.fuente_id as string)),
    items: new Set(items.map((f) => f.id as string)),
  };
}

/**
 * Vuelca una tabla del catálogo. El nombre de tabla y el orden vienen de `CATALOGO_EXPORT`,
 * una constante del código: no hay interpolación de entrada del usuario. El workspace sí
 * viaja como parámetro. `archivo_importado` excluye la columna `contenido` (los bytes
 * salen aparte, en base64 y con presupuesto).
 */
async function filasDeTabla(
  tx: TransactionSql,
  tabla: string,
  orden: string,
  workspaceId: string,
  filtro: FiltroEntregable | null,
  poda: PodaEntregable,
): Promise<FilaExportada[]> {
  const columnas = tabla === 'archivo_importado' ? COLUMNAS_ARCHIVO : '*';
  const filas = (await tx.unsafe(
    `select ${columnas} from ${tabla} where workspace_id = $1 order by ${orden}`,
    [workspaceId],
  )) as unknown as Record<string, unknown>[];
  if (!filtro) return filas.map(normalizarFila);
  return filas.filter((f) => enElEntregable(poda, f, filtro)).map(normalizarFila);
}

const COLUMNAS_ARCHIVO =
  'id, workspace_id, item_id, nombre, tipo_mime, sha256, creado_por, creado_en';

/**
 * Poda del séquito de la evidencia, según lo que DECLARA el catálogo. La evidencia misma
 * ya la filtró la vista; aquí se quitan su fuente, sus vínculos de segmento, sus derechos,
 * sus adjuntos y todo lo que la cita cuando ella no viaja — un entregable que llevara el
 * documento original (o el fragmento citado) de algo que no puede citarse sería el mismo
 * agujero por otra puerta.
 *
 * Sin `default`: el `switch` es exhaustivo sobre la unión discriminada, así que añadir un
 * modo de poda sin darle rama aquí no compila. Antes había un `default: true` y era él
 * quien dejaba pasar enteras `cita`, `contradiccion` y `arquetipo_evidencia`.
 */
function enElEntregable(
  poda: PodaEntregable,
  fila: Record<string, unknown>,
  filtro: FiltroEntregable,
): boolean {
  switch (poda.modo) {
    case 'fuera':
      return false;
    case 'porEvidencia':
      return filtro.evidencias.has(fila[poda.columna] as string);
    case 'porFuente':
      return filtro.fuentes.has(fila[poda.columna] as string);
    case 'porItem':
      return filtro.items.has(fila[poda.columna] as string);
    default: {
      const nunca: never = poda;
      return nunca;
    }
  }
}

/** Los timestamptz salen como texto ISO (el driver los entrega como Date, que no cruza
 * la frontera de serialización); el resto ya es JSON puro — uuid/text/int/jsonb. */
function normalizarFila(fila: Record<string, unknown>): FilaExportada {
  const salida: FilaExportada = {};
  for (const [clave, valor] of Object.entries(fila)) {
    salida[clave] = (valor instanceof Date ? valor.toISOString() : valor) as ValorJson;
  }
  return salida;
}

/**
 * Adjuntos con sus bytes (RF-01.8 «evidencia con sus archivos»). Se incluyen en orden
 * hasta agotar el presupuesto; el resto viaja en el inventario con su sha256 y el motivo
 * de omisión — desaparecer del manifiesto sería justo lo que SYS-04 prohíbe.
 *
 * DOS pasadas, y el orden importa: primero los METADATOS (con `octet_length`, que la base
 * calcula sin materializar el bytea) para decidir qué cabe, y solo después los bytes de lo
 * seleccionado. Traerlo todo de una vez y recortar en el bucle hacía que el pico de memoria
 * fuese el tamaño del almacén entero —items ilimitados × 10 adjuntos × 5 MiB— en vez del
 * presupuesto: una exportación perfectamente autorizada podía tumbar el proceso aunque el
 * paquete resultante no pasara de 25 MiB. Ahora el pico es O(presupuesto), un tope explícito
 * que ya está declarado en el manifiesto.
 *
 * Las dos consultas comparten transacción Y snapshot: la exportación corre en REPEATABLE
 * READ, así que la segunda ve exactamente los adjuntos que la primera midió — sin esto,
 * partir en dos pasadas habría abierto una ventana para que el presupuesto se calculara
 * sobre un inventario y los bytes salieran de otro. El fallback de «bytes que faltan» se
 * conserva como red: si alguna vez esta transacción volviera a READ COMMITTED, la fila
 * seguiría en el inventario con su motivo en vez de desaparecer del manifiesto (SYS-04).
 */
async function archivosDelExport(
  tx: TransactionSql,
  workspaceId: string,
  filtro: FiltroEntregable | null,
): Promise<ArchivoExportado[]> {
  const metadatos = await tx`
    select a.id, a.item_id, a.nombre, a.tipo_mime, a.sha256,
           octet_length(a.contenido) as bytes
    from archivo_importado a
    where a.workspace_id = ${workspaceId}
    order by a.creado_en, a.id`;

  const salida: ArchivoExportado[] = [];
  const seleccionados: string[] = [];
  let presupuesto = PRESUPUESTO_ADJUNTOS_BYTES;
  for (const f of metadatos) {
    if (filtro && !filtro.items.has(f.item_id as string)) continue;

    const bytes = f.bytes as number;
    const cabe = bytes <= presupuesto;
    if (cabe) {
      presupuesto -= bytes;
      seleccionados.push(f.id as string);
    }
    salida.push({
      id: f.id as string,
      itemId: f.item_id as string,
      nombre: f.nombre as string,
      tipoMime: f.tipo_mime as string,
      bytes,
      sha256: f.sha256 as string,
      contenidoBase64: null,
      omitido: cabe
        ? null
        : `Omitido por presupuesto de adjuntos (${PRESUPUESTO_ADJUNTOS_BYTES / 1024 / 1024} MB por exportación): descárgalo desde la bandeja; su sha256 permite verificarlo`,
    });
  }

  if (seleccionados.length > 0) {
    const contenidos = await tx`select id, contenido from archivo_importado
      where workspace_id = ${workspaceId} and id in ${tx(seleccionados)}`;
    const porId = new Map(
      contenidos.map((f) => [
        f.id as string,
        bytesABase64(new Uint8Array(f.contenido as Uint8Array)),
      ]),
    );
    for (const archivo of salida) {
      if (archivo.omitido !== null) continue;
      const base64 = porId.get(archivo.id);
      archivo.contenidoBase64 = base64 ?? null;
      if (base64 === undefined) {
        archivo.omitido =
          'El adjunto se retiró de la bandeja mientras se armaba la exportación; su sha256 queda en el inventario';
      }
    }
  }
  return salida;
}
