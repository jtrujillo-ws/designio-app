import { z } from 'zod';

/*
 * Los contratos de CONTENIDO viven en `ai.contenido.ts` y aquí solo se reexportan sus TIPOS,
 * que se borran al compilar. No es orden: es dónde cae la frontera. Este módulo lo importa la
 * pantalla, y Rollup no puede podar una construcción de Zod de nivel superior —no sabe
 * demostrar que no tiene efectos—, así que basta con que la pantalla importe UNA cosa de aquí
 * para que TODOS los esquemas declarados en este fichero viajen al navegador. Medido: los dos
 * validadores de contenido estaban en el chunk de `/propuestas` desde antes de esta rama, sin
 * que nadie los llamara allí. Un reexport de tipos no crea esa arista.
 */
import type { ContenidoPropuesta } from './ai.contenido';
export type {
  ContenidoAsistenteGate,
  ContenidoCriterio,
  ContenidoEntradaKpi,
  ContenidoExtraccion,
  ContenidoInsight,
  ContenidoOportunidad,
  ContenidoPropuesta,
  ContenidoRemediacionJourney,
} from './ai.contenido';

/** CTX-08 Capacidades AI — el pipeline único PropuestaAI (ADR-0012, SPEC-08). */

export const CapacidadAISchema = z.enum(['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'CT', 'CI']);
export type CapacidadAI = z.infer<typeof CapacidadAISchema>;

/** Estados de revisión: aceptar es aceptar LO PROPUESTO; corregir es su propio estado
 * (y su propio evento) para que la tasa de corrección humana no se pueda maquillar. */
export const EstadoPropuestaSchema = z.enum(['propuesta', 'corregida', 'aceptada', 'rechazada']);
export type EstadoPropuesta = z.infer<typeof EstadoPropuestaSchema>;

/** Qué credencial sirvió la llamada (BYOAI, RF-09.9): hoy la app resuelve siempre
 * `entorno`; `workspace` existe para el día en que la key del cliente viva en el secret
 * manager (RF-09.6) sin migrar datos ni relecturas del lineage histórico. */
export const OrigenKeySchema = z.enum(['workspace', 'entorno']);
export type OrigenKey = z.infer<typeof OrigenKeySchema>;

export const LineageSchema = z.object({
  modelo: z.string().min(1),
  promptVersion: z.string().min(1),
  alcanceResumen: z.string().default(''),
  origenKey: OrigenKeySchema,
  costoUsd: z.number().nonnegative().nullable(),
  latenciaMs: z.number().nonnegative().nullable(),
});
export type Lineage = z.infer<typeof LineageSchema>;

/**
 * Único camino de escritura AI (SYS-19): el contenido original propuesto se conserva
 * siempre, aunque un humano lo corrija (SYS-17 — insumo de la tasa de corrección).
 */
export const PropuestaAISchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  capacidad: CapacidadAISchema,
  contenido: z.unknown().describe('Salida estructurada tipada por capacidad (Zod por capacidad)'),
  contenidoOriginal: z.unknown(),
  confianza: z.number().min(0).max(1).nullable(),
  /** Los hallazgos de revisores AI (C4) llevan esta marca imborrable (SYS-20). */
  esSimulacion: z.boolean().default(false),
  estado: EstadoPropuestaSchema,
  lineage: LineageSchema,
  revisadaPorId: z.string().uuid().nullable(),
});
export type PropuestaAI = z.infer<typeof PropuestaAISchema>;

// ── Contratos ejecutables de SPEC-08 ──────────────────────────────────────────────────
// Las que están vivas hoy. El resto (C1-C7) llegan con sus specs; el catálogo de arriba ya
// las nombra, y el vocabulario de la base admite las diez desde
// `…030000-el-vocabulario-de-capacidades-es-uno.sql`.

/**
 * Las capacidades VIVAS: las únicas que llaman al proveedor.
 *
 * Ya no son «las que tienen destino materializable». CT no lo tiene y está aquí: es
 * INFORMATIVA (RF-08.4) y ése es justamente su contrato — reporta huecos citando objetos y
 * carece de acción «aprobar».
 */
export const CAPACIDADES_ACTIVAS = ['CI', 'C0', 'CT', 'C2', 'C5', 'C6', 'C3'] as const;
export type CapacidadActiva = (typeof CAPACIDADES_ACTIVAS)[number];

export const DestinoSchema = z.enum([
  'evidencia',
  'criterio-exito',
  'insight',
  'entrada-kpi',
  'oportunidad',
]);
export type Destino = z.infer<typeof DestinoSchema>;


/**
 * CI — candidato a evidencia extraído de un item de la bandeja (§12).
 *
 * Dos ausencias deliberadas: el modelo NO propone `consentimiento` (los derechos sobre
 * personas se capturan antes de procesar, RF-09.5 — jamás se infieren de un texto) ni
 * la línea base de nada. Las citas son fragmentos que deben aparecer LITERALES en el
 * material: es lo que hace verificable el grounding en lugar de presumirlo (I3).
 */
/**
 * Lo que el modelo dice de SU PROPIA propuesta, no del objeto que propone. Se pregunta en
 * tres niveles y no en un 0-1 porque un decimal auto-reportado finge una calibración que
 * ningún modelo tiene; tres niveles es lo que de verdad sabe distinguir.
 *
 * NO se confunde con `ContenidoExtraccion.confianza`, que viaja a
 * `dimensiones.calidad.confianza` y es un juicio sobre la EVIDENCIA (cómo de sólida es como
 * prueba). Una extracción puede ser una propuesta impecable de una evidencia floja, y al
 * revés. Fundirlas daría un número que no significaría ninguna de las dos cosas.
 *
 * Es la que ordena la revisión humana: sin ella el panel presenta todas las propuestas como
 * si mereciesen la misma atención, que es lo contrario de lo que una capacidad con revisión
 * humana necesita. Y es una AFIRMACIÓN del modelo, no una medida — la medida de verdad es la
 * presencia literal de las citas, que se calcula contra el material.
 */
export const CONFIANZA_PROPUESTA = ['alta', 'media', 'baja'] as const;
export const CONFIANZA_PROPUESTA_NUMERICA: Record<(typeof CONFIANZA_PROPUESTA)[number], number> =
  { alta: 0.9, media: 0.6, baja: 0.3 };



/**
 * Cuántos criterios se le piden a C0 de una vez: la revisión es por elemento, así que el lote
 * es pequeño a propósito — un lote grande no se revisa, se acepta entero.
 *
 * Vive con el resto del contrato de la capacidad y no con el prompt: es lo que el servicio
 * exige al validar la salida, y tenerlo en `ai.prompts` obligaba a que el registro importara
 * del módulo que lo importa a él.
 */
export const MAX_CRITERIOS_POR_LOTE = 4;

/**
 * Y cuántos insights de una vez. Mismo criterio y mismo tamaño que los criterios: la revisión
 * es por elemento, así que el lote es pequeño a propósito — uno grande no se revisa, se acepta
 * entero. Un insight además arrastra sus afirmaciones y las citas de cada una, así que un lote
 * de cuatro ya es una pantalla larga de revisar con atención.
 */
export const MAX_INSIGHTS_POR_LOTE = 4;

/**
 * Cuántas entradas KPI se le piden a C6 de una vez.
 *
 * El techo lo pone aquí el DOMINIO y no la comodidad de la revisión: una entrada del registry
 * responde a UN criterio de éxito del reto (ADR-0007), y G0 congela como mucho unos pocos
 * criterios por reto. Pedir más entradas que criterios hay solo puede producir dos entradas
 * para la misma promesa, que es lo que `unique (registry_id, nombre)` acaba rechazando después
 * de haber pagado la llamada. Seis deja margen para un reto ancho sin invitar a inventar.
 */
export const MAX_ENTRADAS_KPI_POR_LOTE = 6;

/**
 * Cuántas oportunidades HMW se le piden a C3 de una vez.
 *
 * Aquí el techo no lo pone la revisión ni el dominio, sino LO QUE UNA ETAPA PUEDE TRABAJAR.
 * La etapa 3 no produce un catálogo de preguntas: produce el puñado que el equipo va a
 * explorar en la 4, y cada una arrastra su prioridad, su razón y la traza a los insights que
 * la sostienen. Un lote de doce se acepta entero sin leerlo, que es la forma que tiene esta
 * capacidad de fallar sin que nadie lo note — y lo que quedaría es un portafolio inflado que
 * G3 certifica igual, porque el gate mira la traza y no el tamaño.
 *
 * Cinco: uno más que los criterios y los insights, porque una HMW es más corta de leer que un
 * insight con sus citas, y bastantes menos que las entradas KPI, que responden una a una a
 * criterios que ya existen.
 */
export const MAX_OPORTUNIDADES_POR_LOTE = 5;

/**
 * Cuántas remediaciones puede llevar UN informe de C5 — que es lo mismo que decir cuántas
 * señales abiertas admite un journey para poder pedirlo.
 *
 * Está aquí y no solo dentro del esquema de Zod porque lo leen los DOS lados de la misma
 * regla: el contrato de la salida y la negativa a generar cuando el grafo trae más señales de
 * las que ese contrato puede llevar. Con el número escrito en un solo sitio no puede haber un
 * grafo que se acepte para pedir y cuya respuesta se descarte por larga después de pagarla.
 */
export const MAX_REMEDIACIONES = 20;

/**
 * El ANCLA de una capacidad: el objeto del que cuelga su alcance de contexto, y todo lo que
 * hay que decir sobre él.
 *
 * Está aquí y no repartido porque el ancla es lo que MÁS varía entre capacidades y lo que
 * más veces se pregunta: con dos capacidades, `capacidad === 'CI' ? item : reto` funciona;
 * con diez, cada uno de esos ternarios es un sitio donde la tercera capacidad se comporta
 * como la segunda sin que nadie lo note. Un ternario binario no puede expresar tres casos,
 * y su forma de fallar es elegir el `else` en silencio.
 */
export type AnclaCapacidad = {
  /** La columna donde cuelga en `reserva_ai`, `llamada_ai` y `propuesta_ai`. */
  columna: 'item_id' | 'reto_id' | 'gate_id' | 'journey_id' | 'registry_id';
  /** El título del selector en la pantalla. */
  etiqueta: string;
  /** Cómo se nombra en prosa, en minúscula, dentro de una frase. */
  enProsa: string;
  /** El texto de ayuda del buscador. */
  buscar: string;
  /** Qué decir cuando la cola está vacía. */
  vacia: string;
  /** Qué decir cuando hay más anclas de las que caben, con las que sí caben. */
  hayMas: (mostradas: number) => string;
  /** El error cuando el ancla ya tiene una generación en vuelo. */
  enCurso: string;
  /** El error cuando el ancla ya tiene trabajo esperando revisión. */
  pendiente: string;
};

/**
 * Qué produce una llamada: UNA propuesta o un LOTE de varias.
 *
 * `null` es «una», y no es lo mismo que un lote de uno: una extracción devuelve el objeto
 * en la raíz de la respuesta, y un lote lo devuelve dentro de un campo con nombre. El techo
 * existe porque la revisión es por elemento — un lote grande no se revisa, se acepta entero.
 */
export type LoteCapacidad = {
  campo: string;
  /**
   * Cuántas propuestas TIENE que traer el lote, que no siempre es una.
   *
   * Estaba escrito `min(1)` en los dos sitios que gobiernan el mismo sobre —el esquema que se
   * le pide al proveedor y el que valida la respuesta—, y para C5 es correcto y está razonado:
   * como se niega a llamar con cero señales, no queda ninguna petición real cuya respuesta
   * correcta sea la lista vacía. Ese es el criterio, y C2 lo falla: su prompt dice «hasta N» y
   * le prohíbe expresamente proponer lo que la evidencia no sostenga, así que una evidencia
   * que no sostiene ningún insight responsable tiene por respuesta correcta NINGUNO — y con el
   * mínimo en uno el modelo o se inventa uno o su respuesta, ya pagada, se descarta como fuera
   * de contrato, culpándolo de haber obedecido.
   *
   * Se declara por capacidad porque la pregunta es de cada una, y las dos mitades lo leen de
   * aquí por lo mismo que ya leían de aquí el campo y el techo: gobiernan el mismo sobre y no
   * pueden discrepar si solo hay una declaración.
   */
  minimo: number;
  maximo: number;
} | null;

/**
 * TODO lo que varía de una capacidad, en un solo sitio.
 *
 * Antes esto vivía en tres mapas y unos treinta ternarios repartidos por cuatro ficheros.
 * Añadir la tercera capacidad no era escribir una entrada: era encontrar los treinta sitios
 * —y el modo de fallo de no encontrarlos era que la capacidad nueva se comportara como C0
 * sin decir nada—. La comprobación que acompaña a este registro exige que cada capacidad
 * declarada tenga TODAS sus piezas, así que una a medias enrojece en vez de callar.
 */
export type DefinicionCapacidad = {
  /** Cómo se lee en el selector de capacidad. */
  etiqueta: string;
  /**
   * Qué objeto del dominio materializa una propuesta aceptada, o `null` si NO materializa.
   *
   * `null` es «capacidad informativa», y la primera es CT: RF-08.4 dice que «reporta huecos
   * citando objetos; carece de acción aprobar». No es un hueco en el contrato — es el
   * contrato, y por eso se escribe como una ausencia REPRESENTABLE y no como un destino
   * inventado. La misma distinción que sostiene el `null` de `llamada_ai.consentimiento_version`.
   *
   * Esto llegó DESPUÉS de su migración y no antes, a propósito: mientras `propuesta_ai.destino`
   * fue `not null`, un `Destino | null` en TypeScript habría sido justo la declaración
   * decorativa que este registro existe para quitar —un valor que se puede escribir y que no
   * llega a ninguna parte—. Ahora el suelo lo admite: `destino` es anulable,
   * `propuesta_ai_destino_informativo` ata «sin destino» a su ancla, y
   * `propuesta_ai_destino_ct` lo exige por capacidad.
   *
   * Y lo que hace que «sin acción aprobar» sea una IMPOSIBILIDAD y no una regla de pantalla
   * es un CHECK que ya estaba y no hubo que tocar:
   *
   *   check ((estado in ('aceptada','corregida')) = (coalesce(evidencia_id, criterio_id) is not null))
   *
   * Sin destino no hay objeto que enlazar, así que una propuesta informativa NO PUEDE quedar
   * 'aceptada' ni 'corregida'. Su ciclo es 'propuesta' → 'rechazada', que es «leída y
   * descartada», y eso sigue exigiendo revisor y fecha.
   */
  destino: Destino | null;
  ancla: AnclaCapacidad;
  /*
   * El contrato de la salida del modelo NO vive aquí, y esa ausencia es deliberada. Este
   * registro lo importa la PANTALLA —de él salen la etiqueta, los seis textos del ancla y sus
   * dos errores—, así que todo lo que ponga aquí viaja al navegador. Un esquema de Zod
   * colgado del registro no se puede podar: Rollup ve la referencia y se lleva el validador
   * entero al chunk de la ruta, donde nadie lo llama —desde que la frontera de la corrección
   * es `unknown`, la única validación de contenido ocurre en el servidor—. Medido: 859 bytes
   * de código muerto en el chunk de `/propuestas`.
   *
   * Vive en `ESQUEMA_DE_CONTENIDO` (`ai.contenido.ts`), que es otro
   * `Record<CapacidadActiva, …>`: sigue habiendo UN sitio por cada cosa que varía y el
   * compilador sigue exigiendo la entrada de cada capacidad en los dos. Lo que cambia es de
   * qué lado de la frontera cae cada uno.
   */
  lote: LoteCapacidad;
  /**
   * Si el material del ancla puede ser de personas y hace falta consentimiento vigente
   * antes de procesarlo fuera (RF-09.5). No es un detalle de la pantalla: decide si la
   * generación toma el candado del consentimiento antes que el del presupuesto.
   */
  exigeConsentimiento: boolean;
  /**
   * SYS-20: los hallazgos de esta capacidad son SIMULACIÓN y la marca es imborrable. Hoy
   * ninguna lo es; C4 (revisores AI por arquetipo) lo será, y entonces esta bandera tiene
   * que llegar hasta `propuesta_ai.es_simulacion` sin que nadie se acuerde de ponerla.
   */
  esSimulacion: boolean;
};

/**
 * Las columnas de ancla que el esquema tiene, EXHAUSTIVAS por el tipo.
 *
 * Existe para que el compilador se niegue: ampliar `AnclaCapacidad['columna']` rompe aquí, y
 * de aquí sale la lista que recorren los sitios que las escriben o las leen una a una —los
 * inserts del pipeline y la proyección del panel—. Sin ella, cada uno de esos sitios era una
 * pareja fija que una capacidad nueva no habría tocado: pasaría la comprobación del catálogo
 * (que solo mira que la columna exista) y luego perdería su enlace, o aparecería en el panel
 * con el ancla vacía y por tanto no aceptable.
 */
const ANCLA_DECLARADA: Record<AnclaCapacidad['columna'], true> = {
  item_id: true,
  reto_id: true,
  gate_id: true,
  journey_id: true,
  registry_id: true,
};
export const COLUMNAS_DE_ANCLA = Object.keys(ANCLA_DECLARADA) as AnclaCapacidad['columna'][];

/**
 * Y lo mismo para el DESTINO: qué columna de `propuesta_ai` enlaza el objeto materializado.
 * Un destino nuevo rompe la compilación aquí en vez de escribir `null` en las dos y fallar
 * contra el guard de materialización.
 */
export const COLUMNA_DE_DESTINO: Record<
  Destino,
  'evidencia_id' | 'criterio_id' | 'insight_id' | 'entrada_kpi_id' | 'oportunidad_id'
> = {
  evidencia: 'evidencia_id',
  'criterio-exito': 'criterio_id',
  insight: 'insight_id',
  'entrada-kpi': 'entrada_kpi_id',
  oportunidad: 'oportunidad_id',
};

export const CAPACIDADES: Record<CapacidadActiva, DefinicionCapacidad> = {
  CI: {
    etiqueta: 'Extracción de importación → evidencia',
    destino: 'evidencia',
    ancla: {
      columna: 'item_id',
      etiqueta: 'Item de la bandeja',
      enProsa: 'item pendiente',
      buscar: 'Buscar por título…',
      vacia: 'No hay items pendientes sin propuesta en la bandeja.',
      hayMas: (n) =>
        `Hay más items pendientes de los que caben aquí: se listan los ${n} más antiguos. ` +
        'Decide o cura estos y los siguientes aparecerán; para uno concreto, búscalo por su título.',
      enCurso:
        'Ese item ya tiene una generación AI en curso: espera a que termine antes de pedir otra',
      pendiente: 'Ese item ya tiene una propuesta pendiente: revísala antes de pedir otra',
    },
    lote: null,
    exigeConsentimiento: true,
    esSimulacion: false,
  },
  C0: {
    etiqueta: 'Borrador de reto → criterio de éxito',
    destino: 'criterio-exito',
    ancla: {
      columna: 'reto_id',
      etiqueta: 'Reto con criterios abiertos',
      enProsa: 'reto con criterios abiertos',
      buscar: 'Buscar por código o título…',
      vacia: 'No hay retos con criterios abiertos (un G0 aprobado los congela).',
      hayMas: (n) =>
        `Hay más retos con criterios abiertos de los que caben aquí: se listan los ${n} primeros ` +
        'por código. Un reto sale de la lista mientras sus criterios propuestos esperan revisión; ' +
        'para uno concreto, búscalo por su código o su título.',
      enCurso:
        'Ese reto ya tiene una generación AI en curso: espera a que termine antes de pedir otra',
      pendiente:
        'Ese reto ya tiene criterios propuestos esperando revisión: decídelos antes de pedir otros',
    },
    // Uno como mínimo, que es lo que C0 hacía y este PR no revisa: el registro solo hace
    // que la pregunta se pueda contestar por capacidad en vez de estar escrita para todas.
    lote: { campo: 'criterios', minimo: 1, maximo: MAX_CRITERIOS_POR_LOTE },
    exigeConsentimiento: false,
    esSimulacion: false,
  },
  CT: {
    etiqueta: 'Asistente de gates → qué falta para este gate',
    /*
     * INFORMATIVA. Lee y cita; no escribe. Todo lo que hay que decir de esta ausencia está
     * en el docblock de `destino`, arriba.
     */
    destino: null,
    ancla: {
      columna: 'gate_id',
      etiqueta: 'Gate pendiente',
      enProsa: 'gate pendiente',
      buscar: 'Buscar por proyecto o número de gate…',
      vacia: 'No hay gates pendientes sin informe.',
      hayMas: (n) =>
        `Hay más gates pendientes de los que caben aquí: se listan los ${n} más antiguos. ` +
        'Un gate sale de la lista mientras su informe espera lectura; para uno concreto, ' +
        'búscalo por su proyecto o su número.',
      enCurso:
        'Ese gate ya tiene un informe AI en curso: espera a que termine antes de pedir otro',
      pendiente: 'Ese gate ya tiene un informe sin leer: léelo antes de pedir otro',
    },
    /*
     * Sin lote, y no por parecerse a CI: un informe es UNO por gate. Los huecos viajan
     * DENTRO del contenido porque se leen juntos —«qué falta para G3» es una sola respuesta,
     * no cinco propuestas independientes— y porque no hay nada que decidir por elemento:
     * ninguno se acepta. El techo de un lote existe para que la revisión por elemento no
     * degenere en aceptar todo de golpe (SPEC-08 §3), y aquí no hay aceptación que proteger.
     */
    lote: null,
    /*
     * El material de CT son los textos del checklist y los objetos del proyecto que esos
     * items citan —evidencias, insights, decisiones—, y ninguno es material de PERSONAS: el
     * consentimiento se pide sobre `item_importacion`, que es por donde entra lo que alguien
     * dijo o escribió (RF-09.5). Un item de checklist es una frase del método.
     *
     * Y la comprobación que acompaña al registro lo sujeta por el otro lado: quien exige
     * consentimiento tiene que anclar en `item_id`, que es donde el consentimiento vive.
     */
    exigeConsentimiento: false,
    esSimulacion: false,
  },
  C2: {
    etiqueta: 'Insights del reto → insight con afirmaciones citadas',
    destino: 'insight',
    /*
     * El RETO, la misma columna que C0. C2 es la primera capacidad que COMPARTE ancla, y eso
     * es lo que el registro anticipaba: dos capacidades pueden colgar del mismo objeto y no
     * comparten ni sus puertas ni su material. C0 se congela con el G0 (SYS-22) y cita la
     * formulación del reto; C2 no se congela con nada de eso y cita la EVIDENCIA.
     */
    ancla: {
      columna: 'reto_id',
      etiqueta: 'Reto con evidencia',
      enProsa: 'reto con evidencia',
      buscar: 'Buscar por código o título…',
      vacia:
        'No hay retos con evidencia enlazada. La evidencia llega a un reto por sus arquetipos: enlázala allí y el reto aparecerá aquí.',
      hayMas: (n) =>
        `Hay más retos con evidencia de los que caben aquí: se listan los ${n} primeros por ` +
        'código. Un reto sale de la lista mientras sus insights propuestos esperan revisión; ' +
        'para uno concreto, búscalo por su código o su título.',
      enCurso:
        'Ese reto ya tiene una generación AI en curso: espera a que termine antes de pedir otra',
      pendiente:
        'Ese reto ya tiene insights propuestos esperando revisión: decídelos antes de pedir otros',
    },
    /*
     * LOTE, como C0: una llamada propone varios insights y la revisión es POR ELEMENTO
     * (SPEC-08 §3), así que cada uno se acepta o se descarta por separado. El techo es
     * pequeño a propósito — un lote grande no se revisa, se acepta entero.
     */
    // CERO es una respuesta legítima: la evidencia de un reto puede no sostener ningún
    // insight, y el prompt pide expresamente que no se proponga lo que no se sostiene.
    lote: { campo: 'insights', minimo: 0, maximo: MAX_INSIGHTS_POR_LOTE },
    /*
     * El material de C2 es EVIDENCIA, y la evidencia sale de material de personas: entrevistas,
     * sesiones, documentos que alguien entregó. Pero el consentimiento en este esquema se
     * registra sobre `item_importacion`, que es por donde ese material ENTRA, y se comprueba
     * cuando se procesa allí — CI no puede extraer evidencia de un item sin permiso vigente.
     *
     * O sea: la evidencia que C2 lee ya pasó por esa puerta, y la comprobación que este
     * registro sabe hacer —`exigirConsentimientoVigente` sobre el ancla— pide un `item_id`
     * que C2 no tiene. Declararlo `true` con un ancla de reto haría que la generación buscara
     * un consentimiento inexistente y se negara siempre; declararlo `false` dice la verdad de
     * lo que este pipeline comprueba hoy, que es dónde se comprueba y no que no se comprueba.
     *
     * Lo que queda pendiente, dicho para que se decida y no se descubra: una revocación
     * POSTERIOR sobre el item de origen no retira la evidencia ya materializada, así que C2
     * puede leerla. Eso es una regla de retención sobre `evidencia`, no una puerta de esta
     * capacidad, y arreglarla aquí sería taparla en un solo sitio.
     */
    exigeConsentimiento: false,
    esSimulacion: false,
  },
  C5: {
    etiqueta: 'Remediación del grafo → cómo cerrar lo que la validación señala',
    /*
     * INFORMATIVA, la segunda. No toca el grafo: propone qué hacer y lo hace una persona.
     *
     * Y hay una razón de fondo por la que C5 no puede ser otra cosa, aunque SPEC-08 la
     * nombre «validación del grafo»: esa validación YA EXISTE y es DETERMINISTA
     * (`validarJourney`, RF-05.6, con sus nueve códigos de señal). Pedirle a un modelo que
     * la repita cambiaría una respuesta exacta por una probable —lo que §21 prohíbe
     * vender— y dejaría dos listas de señales discrepando sin criterio para decir cuál
     * vale. Lo que el modelo sí añade es lo que el código no puede: dada una señal REAL,
     * qué hacer con ella EN ESTE grafo.
     */
    destino: null,
    ancla: {
      columna: 'journey_id',
      etiqueta: 'Journey con señales abiertas',
      enProsa: 'journey con señales abiertas',
      buscar: 'Buscar por nombre del journey o del servicio…',
      vacia: 'No hay journeys con señales de validación abiertas.',
      hayMas: (n) =>
        `Hay más journeys con señales abiertas de los que caben aquí: se listan los ${n} más ` +
        'recientes. Un journey sale de la lista mientras su informe espera lectura; para uno ' +
        'concreto, búscalo por su nombre o el de su servicio.',
      enCurso:
        'Ese journey ya tiene una remediación AI en curso: espera a que termine antes de pedir otra',
      pendiente: 'Ese journey ya tiene un informe sin leer: léelo antes de pedir otro',
    },
    /*
     * Sin lote. Las remediaciones viajan DENTRO del contenido, como los huecos de CT, y por
     * la misma razón: se leen juntas —«qué le falta a este grafo» es una respuesta— y
     * ninguna se acepta por separado, así que no hay revisión por elemento que proteger.
     */
    lote: null,
    /* El material es el GRAFO: etiquetas de nodos, fases y transiciones. No hay material de
     * personas por ningún lado — eso entra por `item_importacion`, que es otra ancla. */
    exigeConsentimiento: false,
    esSimulacion: false,
  },
  C6: {
    etiqueta: 'Borrador del Metric Registry → entrada KPI',
    destino: 'entrada-kpi',
    /*
     * El REGISTRY, y no el reto, aunque el material salga del reto. `entrada_kpi.registry_id`
     * es NOT NULL, así que una propuesta anclada en el reto no sabría en qué registry
     * materializarse mientras el reto no tenga uno — y el registry es 1:1 con el reto pero
     * puede no existir todavía. El ancla es el objeto del que se deriva el prompt Y aquel
     * sobre el que se escribe: aquí es el mismo, y sus criterios se leen por `registry → reto`.
     */
    ancla: {
      columna: 'registry_id',
      etiqueta: 'Metric Registry en borrador',
      enProsa: 'registry en borrador',
      buscar: 'Buscar por código o título del reto…',
      vacia:
        'No hay Metric Registries en borrador. El contrato de medición se abre desde el proyecto, y hasta entonces no hay dónde proponer KPIs.',
      hayMas: (n) =>
        `Hay más registries en borrador de los que caben aquí: se listan los ${n} primeros por ` +
        'código de reto. Uno sale de la lista mientras sus entradas propuestas esperan ' +
        'revisión; para uno concreto, búscalo por el código o el título de su reto.',
      enCurso:
        'Ese registry ya tiene una generación AI en curso: espera a que termine antes de pedir otra',
      pendiente:
        'Ese registry ya tiene entradas KPI propuestas esperando revisión: decídelas antes de pedir otras',
    },
    /*
     * LOTE, como C0 y C2: una llamada propone varias entradas y cada una se acepta o se
     * descarta por separado (SPEC-08 §3). CERO es legítimo — un reto cuyos criterios no dan
     * para un KPI medible es una respuesta, y el prompt pide expresamente que no se proponga
     * lo que no se sostiene.
     */
    lote: { campo: 'entradas', minimo: 0, maximo: MAX_ENTRADAS_KPI_POR_LOTE },
    /*
     * El material son los CRITERIOS DE ÉXITO del reto: KPI, definición, objetivo, ventana y
     * plan de línea base. Frases del método, no material de personas — eso entra por
     * `item_importacion`, que es otra ancla, y el registro lo sujeta por el otro lado: quien
     * exige consentimiento tiene que anclar en `item_id`.
     */
    exigeConsentimiento: false,
    esSimulacion: false,
  },
  C3: {
    etiqueta: 'Oportunidades del reto → pregunta HMW trazada a insights',
    destino: 'oportunidad',
    /*
     * El RETO, la TERCERA capacidad que comparte esta columna —con C0 y C2—. Que sean tres y
     * no dos importa poco por sí mismo; lo que importa es que ninguna de las tres comparte
     * puertas con las otras, y por eso cada regla se escribe por DESTINO: C0 se congela con
     * el G0 (SYS-22), C2 no se congela con nada de eso y cita evidencia, y C3 vive dentro de
     * la ventana del portafolio —que abre y cierra la etapa 3 con su G3— y cita insights.
     *
     * `oportunidad.reto_id` es NOT NULL y el portafolio es del reto, así que el objeto del que
     * sale el material y aquel sobre el que se escribe son el mismo. No hay aquí la vuelta que
     * obligó a C6 a anclar en el registry.
     */
    ancla: {
      columna: 'reto_id',
      etiqueta: 'Reto con insights validados',
      enProsa: 'reto con insights validados',
      buscar: 'Buscar por código o título…',
      vacia:
        'No hay retos con insights validados y portafolio abierto. Una HMW se apoya en lo que ya se sabe: valida insights en la etapa 2 y el reto aparecerá aquí.',
      hayMas: (n) =>
        `Hay más retos con insights validados de los que caben aquí: se listan los ${n} ` +
        'primeros por código. Un reto sale de la lista mientras sus oportunidades propuestas ' +
        'esperan revisión; para uno concreto, búscalo por su código o su título.',
      enCurso:
        'Ese reto ya tiene una generación AI en curso: espera a que termine antes de pedir otra',
      pendiente:
        'Ese reto ya tiene oportunidades propuestas esperando revisión: decídelas antes de pedir otras',
    },
    /*
     * LOTE, y la revisión es POR ELEMENTO: cada HMW se acepta o se descarta por separado, que
     * es lo que pide SPEC-08 §3 y lo que la etapa 3 hace de todas formas — un portafolio se
     * arma pregunta a pregunta.
     *
     * CERO es una respuesta legítima, como en C2: los insights validados de un reto pueden no
     * dar para ninguna pregunta que valga la pena explorar, y el prompt pide expresamente que
     * no se proponga lo que no se sostiene. Una lista vacía es mejor respuesta que cinco
     * preguntas de relleno que después alguien tiene que descartar una a una — y que, hasta
     * que las descarte, bloquean el G3 de su proyecto.
     */
    lote: { campo: 'oportunidades', minimo: 0, maximo: MAX_OPORTUNIDADES_POR_LOTE },
    /*
     * El material son INSIGHTS, que son conclusiones del equipo y no material de personas.
     * El consentimiento se registra sobre `item_importacion` —por donde ese material entra— y
     * se comprueba allí; lo que C3 lee ya pasó por esa puerta dos veces, porque un insight
     * cita evidencia y esa evidencia salió de un item consentido.
     *
     * Es la misma respuesta que dio C2 y por el mismo motivo, con la salvedad que allí quedó
     * apuntada: una revocación posterior sobre el item de origen no retira la evidencia ya
     * materializada ni el insight que la cita. Eso es una regla de retención sobre
     * `evidencia`, no una puerta de esta capacidad, y arreglarla aquí sería taparla en un
     * tercer sitio en vez de en el suyo.
     */
    exigeConsentimiento: false,
    esSimulacion: false,
  },
};


export const GenerarPropuestasSchema = z.object({
  workspaceId: z.string().uuid(),
  capacidad: z.enum(CAPACIDADES_ACTIVAS),
  /** Ancla del AlcanceDeContexto: item de la bandeja (CI) o reto (C0). */
  anclaId: z.string().uuid(),
});
export type GenerarPropuestas = z.infer<typeof GenerarPropuestasSchema>;

export const RevisarPropuestaSchema = z.object({
  workspaceId: z.string().uuid(),
  propuestaId: z.string().uuid(),
  /**
   * Presente ⇒ corrección humana: se valida contra el esquema de la capacidad de la
   * propuesta (el servicio la re-parsea) y, si cambia algo, queda `corregida` conservando
   * el original (SYS-17).
   *
   * Y llega SIN TOCAR: `unknown` es el tipo de lo que todavía no se puede juzgar.
   *
   * Aquí hubo primero una unión escrita a mano y después una derivada del registro. Las dos
   * compartían el defecto de fondo, y la segunda lo escondía mejor: una unión no solo
   * ACEPTA, PARSEA —aplica los `default()`, recorta las claves que su rama no declara y
   * devuelve otro objeto—, y elige rama por la PRIMERA que encaje. Esta frontera no sabe de
   * qué capacidad es la propuesta: la capacidad se lee de la fila, dentro de la transacción,
   * varias llamadas después. Así que la rama que encajaba no era la de la propuesta sino la
   * primera que tolerase el payload, y lo que llegaba al servicio ya venía recortado a la
   * forma de OTRA capacidad. El modo de fallo no era un rechazo —eso se ve— sino una
   * corrección que se guarda con campos de menos.
   *
   * Validar exige saber contra qué, y aquí no se sabe. La puerta transporta; la única
   * verificación es `parsearContenido`, que sí conoce la capacidad de la fila y rechaza con
   * su mensaje. Nada se pierde por el camino: lo que el revisor escribió es exactamente lo
   * que ese esquema examina.
   *
   * `.optional()` no es decorativo: distingue AUSENTE (aceptar lo propuesto) de PRESENTE,
   * incluido un `null` presente —que es una corrección con forma inválida y muere en
   * `parsearContenido`, no una aceptación silenciosa—. Por eso el servicio pregunta por
   * `undefined` y no por la verdad del valor.
   */
  correccion: z.unknown().optional(),
});
export type RevisarPropuesta = z.infer<typeof RevisarPropuestaSchema>;

export const PropuestasInputSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Filtro de las anclas ofrecidas a la generación. Con más anclas elegibles que sitio en
   * el selector, ningún orden alcanza: buscar por nombre es lo que hace que ninguna quede
   * fuera del alcance del producto. */
  busqueda: z.string().trim().max(100).default(''),
});

/**
 * RF-09.5: el consentimiento de las personas se captura ANTES de procesar su material,
 * no se infiere de un texto ni se rellena al aceptar. `procesamientoExterno` es la mitad
 * que la AI necesita: autorizar la grabación no es autorizar mandarla a un tercero.
 */
export const RegistrarConsentimientoSchema = z.object({
  workspaceId: z.string().uuid(),
  itemId: z.string().uuid(),
  alcance: z
    .string()
    .trim()
    .min(1, 'Describe qué autorizó la persona')
    .max(1000),
  procesamientoExterno: z.boolean(),
});
export type RegistrarConsentimiento = z.infer<typeof RegistrarConsentimientoSchema>;

/** Tipos de fuente cuyo material es de PERSONAS y exige consentimiento registrado antes
 * de cualquier procesamiento AI. Espejo de `tipo_fuente_exige_consentimiento()` en la
 * base, que es quien lo impone; aquí sirve a la UI para explicarlo antes de intentarlo. */
export const TIPOS_FUENTE_CON_PERSONAS = ['entrevista', 'observacion'] as const;

// ── Proyección del panel de revisión ──

/** Estado del ancla de una propuesta pendiente: `disponible` es el único que admite
 * aceptar o corregir; el resto son motivos de obsolescencia, cada uno con su salida.
 * RECHAZAR se admite en todos ellos, incluido el ancla ausente: es la salida de una
 * propuesta obsoleta, y bloquearla dejaría la fila muerta y su ancla retenida. */
export const ESTADOS_ANCLA = [
  'disponible',
  'item-curado',
  'consentimiento-revocado',
  'criterios-congelados',
  'registry-firmado',
  'reto-no-admite',
  'gate-decidido',
  'checklist-avanzado',
  'reto-archivado',
  'evidencia-no-citable',
  'alcance-incompleto',
  'journey-cambiado',
  'registry-cerrado',
  'criterio-ausente',
  'nombre-ocupado',
  'criterios-cambiados',
  'insights-cambiados',
  'portafolio-cerrado',
  'insight-no-validado',
  'material-no-comparable',
  'ancla-ausente',
] as const;
export type EstadoAncla = (typeof ESTADOS_ANCLA)[number];

export type CitaConPresencia = {
  fragmento: string;
  localizacion: string;
  /**
   * A qué trozo del material dice señalar esta cita, cuando su capacidad cita contra varios.
   *
   * `null` en las que citan contra un material único, que es su respuesta correcta. Viaja al
   * panel porque el verde de `presenteLiteral` no significa lo mismo sin él: con varios
   * documentos, «aparece» tiene que decir DÓNDE, y sin eso quien revisa ve media señal.
   */
  alcanceId: string | null;
  /**
   * true si el fragmento aparece LITERAL en el material del alcance. Es una subcadena, y el
   * nombre lo dice porque el control no establece nada más: una cita puede estar presente
   * palabra por palabra y no sostener la afirmación que acompaña —basta con que el modelo
   * copie una frase mientras alucina el resto—. Llamarlo «fiel» o «verificada» prometería
   * un sostén que aquí nadie ata; quien lo ata es la persona que acepta (SYS-19).
   *
   * `false` es la señal de alarma y la UI la pinta; `true` no es un visto bueno, es la
   * ausencia de esa alarma.
   *
   * Y `null` es NO COMPROBABLE, que no es ninguna de las dos. El panel recompone el material
   * a partir del estado de HOY, y para las capacidades que saben si su material sigue siendo
   * el que vio el modelo —C5 lo sabe: guarda su huella— la respuesta después de una edición
   * ajena no es ni sí ni no. Con un booleano, un fragmento que la edición acaba de añadir
   * salía en verde y una cita legítima que la edición borró salía en rojo: las dos mentiras
   * caben en un booleano y ninguna en un `null`.
   */
  presenteLiteral: boolean | null;
};

export type PropuestaEnPanel = {
  id: string;
  capacidad: CapacidadAI;
  /**
   * `null` en una capacidad INFORMATIVA: no materializa nada, así que no hay objeto que
   * anunciar ni formulario de corrección que ofrecer. La pantalla tiene que decidir qué
   * pinta en ese caso, y con el tipo así no compila hasta que lo decida.
   */
  destino: Destino | null;
  estado: EstadoPropuesta;
  esSimulacion: boolean;
  confianza: number | null;
  contenido: ContenidoPropuesta;
  /** Se envía solo cuando difiere del contenido vigente (una corrección): la propuesta
   * original nunca se pierde de vista. */
  contenidoOriginal: ContenidoPropuesta | null;
  citas: CitaConPresencia[];
  /**
   * Cómo se llaman los ids que el contenido nombra: `{ id → etiqueta }`.
   *
   * El modelo copia ids del material porque es lo único verificable, y la pantalla los recibe
   * tal cual. Un uuid no le dice nada a quien revisa, y las dos capacidades que nombran ids lo
   * necesitan por motivos distintos: sin él una cita de C2 enseña su verde sin decir CONTRA QUÉ
   * documento se midió —que es la mitad de la señal—, y en C5 varias remediaciones pueden traer
   * el mismo código sobre nodos distintos, así que sus tarjetas son indistinguibles. Vacío en
   * las capacidades que no nombran ids, que es su respuesta y no un hueco.
   */
  etiquetas: Record<string, string>;
  /** Título del objeto del que se derivó (item de bandeja o reto), para dar contexto. */
  anclaTitulo: string;
  anclaId: string;
  /**
   * Si el ancla sigue admitiendo la materialización y, cuando no, POR QUÉ: el item se curó
   * a mano, su consentimiento dejó de autorizar el procesamiento externo (RF-09.4/09.5), el
   * G0 del reto congeló sus criterios (SYS-22), el registry de medición del reto se firmó
   * (SYS-22 también, pero es otra puerta), o el reto avanzó en su ciclo de vida y ya no
   * admite criterios nuevos (RF-04.12). Las cinco dejan la propuesta obsoleta y solo
   * rechazable, pero se explican distinto —y tienen salidas distintas—, así que con un
   * booleano el panel no podía decirlo.
   *
   * El congelado son DOS valores y no uno porque las salidas no coinciden: reabrir la etapa
   * 0 (RF-04.9) descongela el del G0 y no descongela el de la firma, que es de ida. Un solo
   * valor le habría ofrecido al lead un trámite que no desbloquea nada.
   *
   * Son cinco y no tres porque la propuesta vive DOS recorridos: entre que se genera y que
   * alguien la revisa pueden pasar días, y en ese hueco cada precondición caduca por su
   * cuenta. El inventario de `ai.servicio.ts` las lista una a una.
   */
  anclaEstado: EstadoAncla;
  modelo: string;
  promptVersion: string;
  origenKey: OrigenKey;
  alcanceResumen: string;
  latenciaMs: number | null;
  /** Coste de la llamada que la produjo, en USD (RF-09.14). null si el modelo no tiene
   * tarifa registrada o si la propuesta es anterior a que se midiera: preferimos «sin
   * dato» a un número inventado. */
  costoUsd: number | null;
  creadoEn: string;
  revisadaEn: string | null;
};

export type CandidatoAncla = {
  id: string;
  titulo: string;
  /** Solo items: el consentimiento VIGENTE sobre su material de personas no cubre el
   * procesamiento externo (nunca se registró, o el último registro no lo autoriza), así que
   * la generación está bloqueada (RF-09.5). */
  consentimientoPendiente?: boolean;
  /** Solo items: se importó sin texto pegado (solo la referencia al original), así que no
   * hay nada que citar y la extracción produciría una evidencia inventada a partir de la
   * ficha. Se marca en vez de esconderse: el item sigue curándose a mano en la bandeja. */
  sinMaterial?: boolean;
  /**
   * Por qué esta ancla NO se puede generar ahora mismo, con lo que hay que hacer. `undefined`
   * cuando se puede.
   *
   * Existe por lo mismo que los dos de arriba —«se marca en vez de esconderse»— pero sin un
   * campo por motivo: los de arriba son de una capacidad concreta y llevan su propio trato en
   * la pantalla (el formulario de consentimiento, el camino de la bandeja), y esto es el caso
   * general, donde lo único que hay que hacer es DECIRLO.
   *
   * Y hace falta porque esconderlas era peor que no ofrecerlas: el selector se quedaba vacío
   * y la pantalla afirmaba «no hay journeys con señales abiertas» sobre un workspace lleno de
   * ellos, mientras el motivo accionable —cierra a mano las más claras— vivía en un mensaje de
   * `PREPARAR` que ningún camino del producto podía alcanzar.
   */
  bloqueo?: string;
};

export type PanelPropuestas = {
  workspaceId: string;
  /** Estado de la capacidad AI (SYS-21): la pantalla se pinta igual esté encendida o no. */
  ai: {
    disponible: boolean;
    motivo: string;
    modelo: string;
    /** Llamadas al proveedor atendidas hoy: lo que se ha pagado, que es lo que el tope
     * acota (y lo que suma el reporte de costos). */
    llamadasHoy: number;
    limiteDiario: number;
    /** Si el ÚLTIMO intento de este workspace se quedó sin respuesta dentro de la ventana
     * de salud. No apaga la capacidad: la pantalla avisa y deja reintentar, porque lo único
     * que averigua si el proveedor volvió es volver a llamarlo. */
    proveedorResponde: boolean;
    advertencia: string;
  };
  pendientes: PropuestaEnPanel[];
  decididas: PropuestaEnPanel[];
  /** Cada lista se corta por su cuenta y avisa de su recorte: con un solo corte antes de
   * partir por estado, 150 decisiones nuevas escondían para siempre una propuesta
   * pendiente antigua (y la generación tampoco volvía a ofrecer su item). */
  /**
   * El grounding que alguien SOSTIENE, sobre todo el workspace y no sobre una página.
   * La presencia literal de las citas mide una subcadena y no verifica nada por sí sola; lo
   * que sí es una medida que alguien sostiene es cuántas propuestas pasó una PERSONA a
   * objeto real del dominio, con su nombre en `revisada_por` (SYS-19).
   *
   * `aceptadas` + `corregidas` son las respaldadas —corregir es aceptar habiendo enmendado,
   * y el respaldo es igual de suyo—; `rechazadas` está para que el denominador sea el de lo
   * DECIDIDO y no el de lo generado.
   */
  respaldo: { aceptadas: number; corregidas: number; rechazadas: number };
  hayMasPendientes: boolean;
  /** Cuántas pendientes hay en total, no cuántas caben. Con la cola ordenada por confianza
   * ASCENDENTE, lo que el corte deja fuera son las más fiables, así que decir el número es lo que
   * distingue «esto es todo» de «esto es lo que cabe». */
  totalPendientes: number;
  hayMasDecididas: boolean;
  /**
   * Anclas ofrecibles a la generación, POR CAPACIDAD.
   *
   * El selector del formulario es la ÚNICA puerta a la generación, así que estas listas se
   * ordenan por antigüedad (FIFO): el recorte cae sobre lo recién llegado —que vuelve a
   * aparecer en la siguiente pasada— y nunca sobre lo que más lleva esperando, que si no
   * jamás alcanzaría la ventana. Y el recorte se DICE, como en las listas de propuestas:
   * callarlo hacía creer que no había más anclas que ofrecer.
   *
   * Aquí había dos listas fijas —`itemsPendientes` y `retosAbiertos`— y la pantalla elegía
   * por la COLUMNA del ancla. La elegibilidad no es de la columna: es de la capacidad. Dos
   * pueden colgar del mismo reto y no admitir los mismos —C0 excluye los de criterios
   * congelados; una capacidad posterior al G0 no tendría por qué—, así que la segunda recibía
   * la cola de la primera y sus anclas válidas no aparecían en el selector. Con un
   * `Record<CapacidadActiva, …>`, una capacidad nueva no compila hasta que alguien diga de
   * dónde salen las suyas.
   */
  candidatas: Record<CapacidadActiva, { lista: CandidatoAncla[]; hayMas: boolean }>;
  /**
   * Items cuyo material es de personas, con su consentimiento VIGENTE. Lista propia y no
   * derivada del selector de generación: registrar un consentimiento —o revocarlo— es un
   * hecho de la investigación que ocurre cuando ocurre, no un paso previo a generar. Colgado
   * del selector, un item ya autorizado no tenía formulario y uno con propuesta pendiente ni
   * siquiera se listaba, así que la revocación no tenía puerta en el producto.
   */
  materialDePersonas: ConsentimientoDeItem[];
  /** El corte de esa lista también se dice. */
  hayMasMaterial: boolean;
  /** El filtro con el que se resolvieron las listas: la pantalla lo devuelve al buscador
   * para que se vea qué se está mirando. */
  busqueda: string;
};

export type ConsentimientoDeItem = {
  id: string;
  titulo: string;
  /** El item ya fue decidido en la bandeja. Se lista igual: una revocación posterior a la
   * curaduría tiene MÁS consecuencias, no menos —la evidencia ya existe—, y la puerta para
   * registrarla no puede cerrarse justo entonces. */
  curado: boolean;
  /** Si el registro vigente cubre el procesamiento por un proveedor externo. */
  autorizaExterno: boolean;
  /** Versión del registro vigente; null si nunca se registró ninguno. */
  version: number | null;
};
