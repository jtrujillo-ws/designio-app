import { z } from 'zod';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';

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

// ── Contratos ejecutables del slice 1 de SPEC-08 ──────────────────────────────────────
// Dos capacidades: las únicas con objeto REAL en el esquema de hoy. El resto (C1-C7, CT)
// llegan con sus specs; el catálogo de arriba ya las nombra.

/** Capacidades con destino materializable en este slice. */
export const CAPACIDADES_ACTIVAS = ['CI', 'C0'] as const;
export type CapacidadActiva = (typeof CAPACIDADES_ACTIVAS)[number];

export const DestinoSchema = z.enum(['evidencia', 'criterio-exito']);
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

const CitasSchema = z
  .array(
    z.object({
      fragmento: z.string().trim().min(1).max(600),
      localizacion: z.string().trim().min(1).max(200),
    }),
  )
  .min(1)
  .max(6);

export const ContenidoExtraccionSchema = z
  .object({
    titulo: z.string().trim().min(1).max(300),
    resumen: z.string().trim().max(2000).default(''),
    recoleccion: z.string().trim().min(1).max(300),
    /**
     * La fecha del material, o la razón de que no la haya — EXACTAMENTE una de las dos.
     *
     * Era obligatoria, y eso convertía el contrato en una contradicción: `item_importacion`
     * guarda título, contenido, tipo de fuente y referencia, y NADA garantiza que ese
     * material traiga una fecha calendárica. El prompt prohíbe inventar fechas y el esquema
     * exigía una, así que al modelo solo le quedaban dos salidas: fabricarla —y se
     * persistía como `proveniencia`, que es de las claves que este slice blinda contra la
     * falsificación— o devolver algo que se descarta. Blindar el transporte de un dato que
     * el propio contrato obliga a inventar no protege nada.
     *
     * La forma es la que este repo ya usa en `resultado_criterio`: o apunta al dato, o
     * escribe por qué no lo hay, y el XOR lo impone. Así la ausencia es representable y
     * significa «no consta», no «no lo escribí» — la misma distinción que sostiene el
     * `null` de `llamada_ai.consentimiento_version`.
     *
     * Con fecha hay que decir DÓNDE se leyó, por lo mismo que las citas llevan localización:
     * una fecha sin sitio en el material es indistinguible de una inventada.
     */
    fecha: FechaCalendarioSchema.nullable(),
    fechaLocalizacion: z.string().trim().max(200).default(''),
    fechaSinDatoMotivo: z.string().trim().max(300).default(''),
    derivada: z.boolean(),
    confianza: z.enum(['alta', 'media', 'baja']),
    confidencialidad: z.enum(['interna', 'cliente', 'restringida']),
    esEstadoActual: z.boolean(),
    confianzaPropuesta: z.enum(CONFIANZA_PROPUESTA),
    citas: CitasSchema,
  })
  .superRefine((c, ctx) => {
    if ((c.fecha !== null) === (c.fechaSinDatoMotivo !== '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fecha'],
        message:
          'La fecha del material o consta con su localización, o falta con su motivo: exactamente una de las dos',
      });
    }
    if (c.fecha !== null && c.fechaLocalizacion === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fechaLocalizacion'],
        message: 'Una fecha extraída dice dónde se leyó en el material',
      });
    }
  });
export type ContenidoExtraccion = z.infer<typeof ContenidoExtraccionSchema>;

/**
 * C0 — un criterio de éxito medible con su ventana (SYS-22), por propuesta: la revisión
 * es POR ELEMENTO (SPEC-08 §3), así que una generación produce varias propuestas y cada
 * una se acepta o se descarta por separado.
 *
 * El modelo propone el PLAN para obtener la línea base, nunca un valor ni una fecha: una
 * medición inventada es exactamente lo que §21 prohíbe vender. El valor real lo registra
 * un humano editando el criterio antes de G0.
 */
export const ContenidoCriterioSchema = z.object({
  kpi: z.string().trim().min(1).max(200),
  definicion: z.string().trim().min(1).max(2000),
  objetivo: z.string().trim().min(1).max(200),
  ventanaDias: z.number().int().positive().max(3650),
  lineaBasePlan: z.string().trim().min(1).max(1000),
  razonamiento: z.string().trim().max(1000).default(''),
  /**
   * Y CITA, como CI. C0 proponía solo con `razonamiento`, y eso la dejaba fuera del marco
   * por dos sitios: I4 dice «la AI propone Y CITA; el humano aprueba», y un criterio que se
   * acepta sin ver qué parte del reto lo sostiene es justo lo que G0 tendrá que certificar
   * después. Peor todavía, RF-09.10 exige una suite de grounding con línea base y
   * regresión: una capacidad con cero citas no sale MAL en esa medición, sale EXCLUIDA en
   * silencio — y la que no puede salir mal es la que más falta hace medir.
   *
   * El material del alcance de C0 es la formulación del reto (código, título, descripción y
   * métrica objetivo declarada), delimitado igual que el de CI, así que la presencia se mide
   * exactamente con la misma regla y la misma función.
   */
  citas: CitasSchema,
  confianzaPropuesta: z.enum(CONFIANZA_PROPUESTA),
});
export type ContenidoCriterio = z.infer<typeof ContenidoCriterioSchema>;

/** Contenido de una propuesta: una de las formas tipadas, nunca un jsonb libre — así el
 * panel, el servicio y la corrección hablan del mismo objeto sin castings. */
export type ContenidoPropuesta = ContenidoExtraccion | ContenidoCriterio;

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
  columna: 'item_id' | 'reto_id';
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
export type LoteCapacidad = { campo: string; maximo: number } | null;

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
  /** Qué objeto del dominio materializa una propuesta aceptada. */
  destino: Destino;
  ancla: AnclaCapacidad;
  /**
   * El contrato de la salida del modelo para UNA propuesta. La entrada se tipa `unknown` a
   * propósito: lo que llega es JSON del proveedor, y un esquema con `default()` tiene un
   * tipo de ENTRADA distinto del de salida — pedirle que coincidan rechazaría justo a los
   * que traen valores por omisión.
   */
  contenido: z.ZodType<ContenidoPropuesta, z.ZodTypeDef, unknown>;
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
    contenido: ContenidoExtraccionSchema,
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
    contenido: ContenidoCriterioSchema,
    lote: { campo: 'criterios', maximo: MAX_CRITERIOS_POR_LOTE },
    exigeConsentimiento: false,
    esSimulacion: false,
  },
};


/** Valida el contenido según la capacidad (el mismo esquema para la salida del modelo y
 * para la corrección humana: corregir no puede producir algo que generar no podría, ni
 * cambiar la forma que la capacidad declara). */
export function parsearContenido(
  capacidad: CapacidadActiva,
  valor: unknown,
): ContenidoPropuesta {
  return CAPACIDADES[capacidad].contenido.parse(valor);
}

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
  /** Presente ⇒ corrección humana: se valida contra el esquema de la capacidad de la
   * propuesta (el servicio la re-parsea) y, si cambia algo, queda `corregida` conservando
   * el original (SYS-17). */
  correccion: z.union([ContenidoExtraccionSchema, ContenidoCriterioSchema]).optional(),
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
  'ancla-ausente',
] as const;
export type EstadoAncla = (typeof ESTADOS_ANCLA)[number];

export type CitaConPresencia = {
  fragmento: string;
  localizacion: string;
  /**
   * true si el fragmento aparece LITERAL en el material del alcance. Es una subcadena, y el
   * nombre lo dice porque el control no establece nada más: una cita puede estar presente
   * palabra por palabra y no sostener la afirmación que acompaña —basta con que el modelo
   * copie una frase mientras alucina el resto—. Llamarlo «fiel» o «verificada» prometería
   * un sostén que aquí nadie ata; quien lo ata es la persona que acepta (SYS-19).
   *
   * `false` es la señal de alarma y la UI la pinta; `true` no es un visto bueno, es la
   * ausencia de una alarma concreta.
   */
  presenteLiteral: boolean;
};

export type PropuestaEnPanel = {
  id: string;
  capacidad: CapacidadAI;
  destino: Destino;
  estado: EstadoPropuesta;
  esSimulacion: boolean;
  confianza: number | null;
  contenido: ContenidoPropuesta;
  /** Se envía solo cuando difiere del contenido vigente (una corrección): la propuesta
   * original nunca se pierde de vista. */
  contenidoOriginal: ContenidoPropuesta | null;
  citas: CitaConPresencia[];
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
  /** Anclas ofrecibles a la generación: items de bandeja pendientes y retos abiertos. El
   * selector del formulario es la ÚNICA puerta a la generación, así que estas listas se
   * ordenan por antigüedad (FIFO): el recorte cae sobre lo recién llegado —que vuelve a
   * aparecer en la siguiente pasada— y nunca sobre lo que más lleva esperando, que si no
   * jamás alcanzaría la ventana. */
  itemsPendientes: CandidatoAncla[];
  retosAbiertos: CandidatoAncla[];
  /** Y el recorte se DICE, como en las listas de propuestas: callarlo hacía creer que no
   * había más anclas que ofrecer. */
  hayMasItems: boolean;
  hayMasRetos: boolean;
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
