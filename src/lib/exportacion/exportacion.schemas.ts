import { z } from 'zod';

/**
 * Exportación del workspace (RF-01.8, SYS-04) y del paquete entregable (RF-03.10).
 * Módulo compartido servidor/UI: sin imports de servidor.
 *
 * DOS ámbitos, porque la spec pide dos cosas incompatibles entre sí y ambas son
 * correctas en su contexto:
 *
 *  · `archivo` — el archivo del PROPIETARIO. SYS-04 exige que incluya *todos* sus
 *    objetos, derivados y auditoría: es su dato y su derecho. Aquí los derechos de uso
 *    NO filtran nada; viajan como un bloque más, para que el destino sepa qué puede
 *    hacer con cada evidencia.
 *  · `entregable` — el paquete que sale hacia un uso con el cliente. Aquí SÍ mandan los
 *    derechos (RF-03.10): la evidencia sin derechos vigentes para el ámbito «cliente»
 *    queda fuera, y aparece listada en `bloqueadas` con la dimensión que falta. Nunca se
 *    oculta en silencio (SYS-14 pide bloquear *explicando*).
 *
 * El filtro del entregable no es un WHERE de la aplicación: la evidencia se lee de la
 * vista `evidencia_entregable`, que aplica el predicado en la BASE.
 */

export const AMBITOS_EXPORT = ['archivo', 'entregable'] as const;
export type AmbitoExport = (typeof AMBITOS_EXPORT)[number];

export const ETIQUETA_AMBITO_EXPORT: Record<AmbitoExport, string> = {
  archivo: 'Archivo completo del workspace (todos los objetos y la auditoría)',
  entregable: 'Paquete entregable (solo evidencia con derechos vigentes para el cliente)',
};

export const ExportarSchema = z.object({
  workspaceId: z.string().uuid(),
  ambito: z.enum(AMBITOS_EXPORT),
});
export type Exportar = z.infer<typeof ExportarSchema>;

/**
 * Cómo se poda cada tabla al armar un paquete `entregable`. Es un campo OBLIGATORIO de
 * cada entrada del catálogo, y esa obligación es la corrección de fondo: mientras la
 * poda vivía en un `switch` con `default: true`, toda tabla no contemplada viajaba
 * ENTERA — el estado por omisión era «se exporta todo», que es justo el que no debe
 * alcanzarse por descuido. Ahora omitir la declaración no compila y el estado por
 * omisión no existe.
 *
 *  · `fuera`        — no viaja en el entregable (el archivo del propietario sí la lleva).
 *  · `porEvidencia` — la fila cuelga de una evidencia por esa columna (`id` en la propia
 *    tabla `evidencia`): sale solo si esa evidencia tiene derechos vigentes.
 *  · `porFuente` / `porItem` — séquito indirecto: la fuente de la que nace la evidencia
 *    y el material importado cuyos adjuntos son su original.
 *  · `todo`         — viaja completa. Reservado para el modelo PROPIO del cliente que no
 *    cuelga de ninguna evidencia y que hace legible lo que sí cuelga: hoy solo `segmento`,
 *    sin el cual los vínculos de segmento de la evidencia serían uuids colgando. No es el
 *    `default: true` de antes disfrazado: hay que escribirlo tabla por tabla y justificarlo.
 */
export type PodaEntregable =
  | { modo: 'fuera' }
  | { modo: 'todo' }
  | { modo: 'porEvidencia'; columna: string }
  | { modo: 'porFuente'; columna: string }
  | { modo: 'porItem'; columna: string };

export type EntradaCatalogo = {
  tabla: string;
  orden: string;
  poda: PodaEntregable;
  /**
   * Tablas a las que esta apunta por FK y que a propósito NO viajan en el entregable, con
   * el motivo. La regla general es que **una fila viaja solo si viaja aquello a lo que
   * apunta**: exportar hijos cuyos padres se podaron deja al receptor con ids colgando y
   * fragmentos que no puede asociar a nada. Un test estructural contrasta esta declaración
   * con las FKs REALES de la base, así que una excepción nueva no pasa sin escribirse aquí.
   */
  padresAusentes?: readonly { tabla: string; motivo: string }[];
};

/**
 * Catálogo de objetos del workspace: la lista contra la que se verifica que la
 * exportación es COMPLETA (SYS-04 «checklist de export contra el catálogo de objetos»).
 * Un test estructural compara este catálogo con las tablas que realmente tienen
 * `workspace_id` en la base: si alguien añade una tabla de dominio y no la exporta, el
 * test lo detiene — que es exactamente cómo un invariante deja de ser un deseo. El mismo
 * test comprueba la otra mitad: toda tabla real con `evidencia_id` o queda `fuera` del
 * entregable o se poda EXACTAMENTE por esa columna.
 *
 * `workspace` no aparece aquí porque se filtra por `id`, no por `workspace_id`; se
 * exporta aparte, siempre.
 */
export const CATALOGO_EXPORT = [
  { tabla: 'miembro', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  // Los segmentos son la taxonomía del PROPIO cliente, no material de terceros, y sin
  // ellos `evidencia_segmento` viajaría apuntando a uuids que no están en el paquete.
  { tabla: 'segmento', orden: 'creado_en, id', poda: { modo: 'todo' } },
  { tabla: 'servicio', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'reto', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'reto_servicio_afectado', orden: 'reto_id, servicio_id', poda: { modo: 'fuera' } },
  { tabla: 'proyecto', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'criterio_exito', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'etapa_instancia', orden: 'proyecto_id, numero', poda: { modo: 'fuera' } },
  { tabla: 'gate_instancia', orden: 'proyecto_id, numero', poda: { modo: 'fuera' } },
  // Cita evidencia (`evidencia_id`), pero el entregable no lleva el método: fuera entera.
  { tabla: 'checklist_item', orden: 'gate_id, orden', poda: { modo: 'fuera' } },
  { tabla: 'fuente', orden: 'creado_en, id', poda: { modo: 'porFuente', columna: 'id' } },
  { tabla: 'evidencia', orden: 'creado_en, id', poda: { modo: 'porEvidencia', columna: 'id' } },
  {
    tabla: 'evidencia_segmento',
    orden: 'evidencia_id, segmento_id',
    poda: { modo: 'porEvidencia', columna: 'evidencia_id' },
  },
  {
    tabla: 'derecho_uso',
    orden: 'creado_en, id',
    poda: { modo: 'porEvidencia', columna: 'evidencia_id' },
  },
  // Cadena de razonamiento (SPEC-03.9 / SPEC-04.9-11): el insight y lo que lo sostiene,
  // las decisiones con su enlace a insights, los arquetipos y las reaperturas. Sin
  // esto, el archivo entregado tendría los gates pero no el porqué de cada decisión.
  { tabla: 'insight', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'afirmacion', orden: 'insight_id, orden', poda: { modo: 'fuera' } },
  // `cita`, `contradiccion` y `arquetipo_evidencia` son ANOTACIONES sobre razonamiento que
  // el entregable no lleva (insight, afirmación, arquetipo). Podarlas por derechos —como
  // estaban— dejaba filas con `afirmacion_id` e `insight_id` colgando: fragmentos
  // permitidos que el receptor no puede asociar a la afirmación que sostienen. Se aplica
  // la regla general (una fila viaja solo si viaja aquello a lo que apunta) y salen
  // enteras; de paso, el `fragmento` copiado del original deja de estar en el paquete.
  // Si algún día el entregable lleva la cadena de razonamiento, vuelven CON sus padres y
  // el test estructural lo exigirá.
  { tabla: 'cita', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'contradiccion', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'decision', orden: 'decidido_en, id', poda: { modo: 'fuera' } },
  { tabla: 'decision_insight', orden: 'decision_id, insight_id', poda: { modo: 'fuera' } },
  { tabla: 'arquetipo', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'arquetipo_segmento', orden: 'arquetipo_id, segmento_id', poda: { modo: 'fuera' } },
  { tabla: 'arquetipo_evidencia', orden: 'arquetipo_id, evidencia_id', poda: { modo: 'fuera' } },
  { tabla: 'reapertura_etapa', orden: 'reabierto_en, id', poda: { modo: 'fuera' } },
  { tabla: 'reapertura_insight', orden: 'reapertura_id, insight_id', poda: { modo: 'fuera' } },
  // Medición temporal de impacto y post mortem (SPEC-07 / SYS-22): el contrato de
  // medición que se firma en G6, sus KPI, las lecturas append-only y el veredicto del
  // cierre. Las cinco entran en el catálogo porque SYS-04 exige que el ARCHIVO del
  // propietario lo lleve todo, y ahí van enteras.
  //
  // En el ENTREGABLE las cinco quedan `fuera`, y conviene decir por qué no es la
  // respuesta cómoda sino la única defendible. Ninguna cuelga de una evidencia —no hay
  // `evidencia_id` en ninguna—, así que el eje de poda de este ámbito (derechos de uso
  // sobre material de terceros) no las alcanza: la pregunta no es «¿con qué derechos?»
  // sino «¿pertenecen al paquete?». Y el `entregable` de este slice es el MATERIAL
  // citable con sus derechos —evidencia, su fuente, sus segmentos, su registro de
  // derechos y sus originales—, no el expediente del método; por eso ya están fuera el
  // `criterio_exito` contra el que se mide, los gates que lo aprueban y la cadena de
  // razonamiento entera.
  //
  // La regla general del catálogo lo cierra por el otro lado: una fila viaja solo si
  // viaja aquello a lo que apunta, y los padres de estas cinco son `reto`,
  // `criterio_exito`, `miembro` y entre ellas mismas — todos `fuera`. Meterlas sin sus
  // padres dejaría un contrato firmado sin el reto que contrata, KPI sin el criterio que
  // miden y un veredicto sin los criterios que juzga: ids colgando, que es exactamente lo
  // que esa regla existe para impedir.
  { tabla: 'metric_registry', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  // Además nombra a una persona (`propietario_miembro_id` → `miembro`, que el entregable
  // no lleva): el dueño de cada KPI por parte del cliente.
  { tabla: 'entrada_kpi', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  // Lecturas append-only con su `nota`: apuntes de operación de quien mide, no material
  // entregable. Sin su `entrada_kpi` serían números sin unidad ni objetivo.
  { tabla: 'snapshot', orden: 'entrada_kpi_id, fecha, id', poda: { modo: 'fuera' } },
  // El post mortem es el caso donde `fuera` incomoda más, y aun así es el correcto AQUÍ:
  // `contribucion`, `factores_externos` y `diseno_experimental_justificacion` son el
  // juicio de la boutique sobre si su propio trabajo funcionó y sobre el rigor de su
  // método. Que el cliente deba recibirlo es muy probable — pero entonces lo recibe como
  // informe de resultados, con los criterios y las lecturas que lo sostienen, no colado
  // dentro de un paquete cuyo contrato es «material con derechos vigentes». Ensanchar el
  // `entregable` en silencio sería cambiar lo que ese ámbito significa; queda anotado como
  // pregunta de producto, no resuelto de tapadillo aquí.
  { tabla: 'outcome_review', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'resultado_criterio', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  // Journey (SPEC-05): el mapa del servicio, su catálogo de touchpoints/canales/sistemas,
  // los nodos y aristas del grafo y los snapshots congelados. Es modelo PROPIO del
  // workspace, no material de terceros, así que el archivo del dueño lo lleva entero y el
  // entregable no lo arrastra — misma línea que el método y la cadena de razonamiento.
  { tabla: 'journey', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'catalogo_journey', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'journey_nodo', orden: 'journey_id, orden, id', poda: { modo: 'fuera' } },
  { tabla: 'journey_arista', orden: 'journey_id, creado_en, id', poda: { modo: 'fuera' } },
  // Enlaza un nodo con la evidencia que lo respalda: tiene `evidencia_id`, así que el
  // invariante estructural obliga a declararlo. Queda FUERA —y no podado por evidencia—
  // porque el journey al que apunta tampoco viaja: un enlace a un nodo ausente no informa
  // de nada y sí revela qué evidencia sostiene qué paso. Mismo criterio que checklist_item.
  {
    tabla: 'journey_nodo_evidencia',
    orden: 'nodo_id, evidencia_id',
    poda: { modo: 'fuera' },
  },
  { tabla: 'journey_snapshot', orden: 'congelado_en, id', poda: { modo: 'fuera' } },
  // Entrega y estado efectivo (SPEC-06): la design version que se congela al aprobarse,
  // sus elementos de cambio con la traza al insight y a la decisión que los justifican, los
  // releases que los llevan a producción y la constatación de lo que de verdad quedó. Las
  // ocho al catálogo, porque SYS-04 exige que el ARCHIVO del propietario lo lleve todo.
  //
  // Las ocho quedan `fuera` del ENTREGABLE, y por el mismo motivo estructural que la
  // medición: ninguna tiene `evidencia_id`, así que el eje de poda de este ámbito no las
  // alcanza, y sus padres —`proyecto`, `servicio`, `journey`, `journey_snapshot`,
  // `decision`, `insight` y ellas entre sí— tampoco viajan. Un elemento de cambio sin el
  // journey que modifica, sin la decisión que lo ordena y sin el insight que lo justifica
  // es un título y un id colgando; y `constatacion` sin su `elemento_cambio` es un
  // veredicto sobre algo que no está en el paquete.
  //
  // Y como con el post mortem, la incomodidad hay que decirla en vez de esconderla: la
  // design version aprobada es probablemente lo MÁS entregable de todo el método —es
  // literalmente el diseño que se entrega—. Pero entonces se entrega como tal, con su
  // journey y su cadena de razonamiento, no colada dentro de un paquete cuyo contrato es
  // «material de terceros con derechos vigentes». Ensanchar este ámbito en silencio sería
  // cambiar lo que significa; queda como pregunta de producto.
  { tabla: 'design_version', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'elemento_cambio', orden: 'design_version_id, orden, id', poda: { modo: 'fuera' } },
  { tabla: 'elemento_decision', orden: 'elemento_id, decision_id', poda: { modo: 'fuera' } },
  { tabla: 'elemento_insight', orden: 'elemento_id, insight_id', poda: { modo: 'fuera' } },
  { tabla: 'release', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'release_elemento', orden: 'release_id, elemento_id', poda: { modo: 'fuera' } },
  { tabla: 'effective_state', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'constatacion', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  // Portal (SPEC-01.5): la conversación con el cliente es parte de lo que se le entrega.
  // Un hilo puede colgar de una evidencia, pero el entregable no lleva la conversación:
  // fuera entera (y por eso `comentario`, que cuelga del hilo, también).
  { tabla: 'hilo_comentario', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'comentario', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  { tabla: 'item_importacion', orden: 'creado_en, id', poda: { modo: 'fuera' } },
  // Los bytes NO salen por esta vía: archivo_importado se exporta aparte, sin la
  // columna `contenido` y con el binario en base64 sujeto al presupuesto de adjuntos.
  {
    tabla: 'archivo_importado',
    orden: 'creado_en, id',
    poda: { modo: 'porItem', columna: 'item_id' },
    // Su padre NO viaja, y es deliberado: las filas de la bandeja llevan `contenido`, el
    // texto crudo del material de terceros. En vez del padre se publica el enlace útil
    // (`evidenciaId` en cada adjunto), que es lo que el receptor necesita.
    padresAusentes: [
      {
        tabla: 'item_importacion',
        motivo:
          'sus filas llevan el texto crudo del material; el adjunto publica en su lugar el evidenciaId',
      },
    ],
  },
  { tabla: 'evento_dominio', orden: 'creado_en, id', poda: { modo: 'fuera' } },
] as const satisfies readonly EntradaCatalogo[];

/** Tablas que viajan en un paquete `entregable`. DERIVADA del catálogo, no una lista
 * paralela: cuando eran dos listas independientes podían discrepar — y discrepaban
 * (`cita` figuraba aquí sin que la poda supiera podarla, así que salía entera). */
export const TABLAS_ENTREGABLE: readonly string[] = CATALOGO_EXPORT.filter(
  (c) => c.poda.modo !== 'fuera',
).map((c) => c.tabla);

/** 25 MiB de binarios por exportación: el paquete se arma en memoria y viaja como una
 * sola respuesta JSON. Pasado el tope, el archivo sale en el manifiesto con su sha256 y
 * su motivo de omisión (nunca desaparece del inventario) y se descarga por su ruta
 * normal. Es el límite explícito del MVP mientras el almacenamiento sea la base. */
export const PRESUPUESTO_ADJUNTOS_BYTES = 25 * 1024 * 1024;

export type ArchivoExportado = {
  id: string;
  itemId: string;
  /**
   * A qué EVIDENCIA pertenece el original, o null si su material sigue en la bandeja sin
   * curar. El adjunto cuelga del item y el único sitio donde vivía la correspondencia
   * item → evidencia era `item_importacion`, que el entregable no lleva: el receptor de un
   * paquete con varias evidencias se quedaba con un montón de ficheros y sin saber cuál
   * respalda a cuál. La alternativa —exportar las filas de la bandeja— habría metido en el
   * paquete la columna `contenido`, es decir el texto crudo del material de terceros, que
   * es precisamente lo que el ámbito del entregable protege. Se publica el enlace, no la
   * fuente.
   */
  evidenciaId: string | null;
  nombre: string;
  tipoMime: string;
  bytes: number;
  sha256: string;
  /** base64 del original, o null si se omitió por presupuesto. */
  contenidoBase64: string | null;
  omitido: string | null;
};

export type EvidenciaBloqueada = {
  evidenciaId: string;
  titulo: string;
  motivo: string;
};

export type Manifiesto = {
  formato: 'whitespace-export/1';
  ambito: AmbitoExport;
  workspaceId: string;
  workspaceNombre: string;
  generadoEn: string;
  generadoPorRol: string;
  /** Filas exportadas por tabla del catálogo: es el recibo verificable de SYS-04. */
  conteos: Record<string, number>;
  /**
   * Filas que EXISTÍAN en el workspace y la poda del entregable dejó fuera, por tabla. Es
   * la otra mitad del recibo: un recibo que omite filas sin decir cuántas es un recibo
   * peor, y es el mismo motivo por el que existe `bloqueadas` en vez de que la evidencia
   * simplemente no aparezca (SYS-04 + SYS-14: lo excluido no se calla).
   *
   * El criterio contado es EXACTAMENTE el predicado de la poda —la fila no cuelga de
   * evidencia con derechos vigentes para el ámbito cliente—, que es lo que hace la resta
   * verificable: `count(*)` de la tabla en el workspace menos las filas emitidas, las dos
   * bajo la misma RLS y el mismo snapshot `repeatable read`.
   *
   * NUNCA cuenta la ausencia por diseño, que es una ausencia distinta y no se puede sumar
   * con ésta. Una tabla que no viaja en el entregable —el método, el razonamiento, la
   * bandeja, el journey— tiene cero filas porque no viaja, no porque se le haya
   * restringido nada: anotarle «podadas: 40» inventaría una restricción que no existe y
   * mentiría en la dirección incómoda, la de insinuar que se ocultó algo. Esas tablas no
   * aparecen aquí, igual que las de modo `todo` (no podan nada) y que el ámbito `archivo`
   * entero, donde el mapa va vacío en vez de relleno de ceros.
   *
   * No es un oráculo, y es la diferencia entre un recibo y una filtración. Viaja DENTRO de
   * un paquete que la base ya autorizó (`registrar_exportacion` exige lead-boutique o
   * admin-cliente) y cuyas consultas corren bajo RLS acotadas a ese workspace, así que el
   * conteo es de filas que ese actor ya podía ver — de hecho, menos de lo que el propio
   * manifiesto ya publica, porque `bloqueadas` lista cada evidencia excluida con su título
   * y su motivo. Contar por tabla para un workspace ajeno, o para un rol que no debería
   * saber que esas filas existen, sería la fuga que `evidencia_motivo_bloqueo` cerró un
   * nivel más abajo; por eso el conteo no tiene camino propio y solo existe aquí dentro.
   */
  podadasPorDerechos: Record<string, number>;
  adjuntos: {
    total: number;
    incluidos: number;
    omitidos: number;
    bytesIncluidos: number;
    presupuestoBytes: number;
  };
  evidenciaBloqueada: number;
};

/** Valor JSON puro: el paquete de exportación viaja por la frontera servidor→cliente y
 * el contrato de serialización exige tipos que sepan cruzarla (nada de Date ni Buffer:
 * las fechas salen ya como texto ISO y los binarios como base64). */
export type ValorJson =
  | string
  | number
  | boolean
  | null
  | ValorJson[]
  | { [clave: string]: ValorJson };
export type FilaExportada = Record<string, ValorJson>;

export type Exportacion = {
  manifiesto: Manifiesto;
  workspace: FilaExportada;
  datos: Record<string, FilaExportada[]>;
  archivos: ArchivoExportado[];
  bloqueadas: EvidenciaBloqueada[];
};

/** Nombre del archivo que se descarga. Solo caracteres seguros: el nombre del workspace
 * es dato de cliente y termina en un `download` del navegador. */
export function nombreDeArchivoExport(
  nombreWorkspace: string,
  ambito: AmbitoExport,
  /**
   * El `generadoEn` del MANIFIESTO (ISO), no el reloj de quien descarga. Es el mismo
   * arreglo que ya se hizo DENTRO del recibo y que aquí faltaba: `generadoEn` sale del
   * `now()` de la transacción que leyó los datos —el mismo del que `current_date` derivó
   * para decidir qué derechos seguían vigentes—, mientras que el nombre del fichero salía
   * de `new Date()` en el navegador. Con desfase de relojes o cruzando medianoche, el
   * fichero que el auditor archiva llevaba un día distinto del que dice el recibo que
   * contiene. Un recibo y su etiqueta tienen que venir del mismo reloj, y el que manda es
   * el de la base porque es el único que decidió algo.
   */
  generadoEn: string,
): string {
  const base = nombreWorkspace
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  const dia = generadoEn.slice(0, 10);
  return `whitespace-${base || 'workspace'}-${ambito}-${dia}.json`;
}
