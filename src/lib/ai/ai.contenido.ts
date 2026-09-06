import { z } from 'zod';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';
import { CODIGOS_SENAL } from '@/lib/journey/journey.schemas';
import {
  MAX_DEFINICION_KPI,
  MAX_DIMENSIONES_KPI,
  MAX_FUENTE_KPI,
  MAX_NOMBRE_KPI,
} from '@/lib/medicion/medicion.schemas';
// Los topes de la HMW salen del contrato de `oportunidad`, no de aquí: escribirlos a mano es
// cómo se separan, y con una pregunta más larga la propuesta pasaría este esquema para morir
// en el CHECK de la tabla con la llamada ya pagada.
import { TOPE_NARRATIVA } from '@/lib/medicion/medicion.schemas';
import { MAX_PREGUNTA, MAX_RAZON } from '@/lib/servicio/oportunidad.schemas';
import {
  CONFIANZA_PROPUESTA,
  MAX_REMEDIACIONES,
  type CapacidadActiva,
} from './ai.schemas';

/**
 * La marca con la que `check:bundle` sabe si estos validadores llegaron al navegador.
 *
 * Un centinela puesto a propósito, como el «Módulo server-only cargado» de `server-only.ts`,
 * y no un texto prestado de los esquemas. Probé con el nombre de un campo y no servía por dos
 * lados: `fechaSinDatoMotivo` también está en el formulario de corrección —que SÍ vive en el
 * navegador y tiene que seguir estando—, así que daba falso positivo; y un mensaje de
 * validación cualquiera deja de guardar el día que alguien lo reescribe, sin que nadie lo
 * note. Este existe SOLO para esto, así que nadie lo va a reescribir por otra razón.
 *
 * Va en un `describe()` de cada esquema para que no se pueda podar por separado: si el
 * validador está en el chunk, su marca está con él.
 */
export const MARCA_CONTENIDO_SOLO_SERVIDOR = 'designio:contenido-ai-solo-servidor';

/*
 * Los dos topes de C7 que NO salen de ningún contrato de tabla, porque lo que acotan no se
 * materializa: la lectura de una desviación y cuántas caben. Viven aquí por eso mismo — un
 * tope de contenido cuyo destino existe se copia del destino (`TOPE_NARRATIVA`), y uno cuyo
 * destino no existe se decide donde se usa, que es este fichero.
 *
 * El techo de la lista existe por lo que cuesta una respuesta sin él: la conciliación de un
 * reto grande puede traer decenas de elementos, y un modelo que comente todos devuelve un
 * informe que nadie lee y una factura que sí se nota. Cincuenta es más de lo que ninguna
 * design version del piloto tiene, así que recorta sin quitar nada real.
 */
export const MAX_LECTURA_DESVIACION = 1000;
export const MAX_DESVIACIONES_LEIDAS = 50;

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
  })
  .describe(MARCA_CONTENIDO_SOLO_SERVIDOR);
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
}).describe(MARCA_CONTENIDO_SOLO_SERVIDOR);
export type ContenidoCriterio = z.infer<typeof ContenidoCriterioSchema>;

/**
 * Un identificador que el modelo COPIA del material, en la forma en que lo escribe la base.
 *
 * `z.string().uuid()` admite los hexadecimales en mayúscula, y Postgres almacena el uuid en su
 * forma canónica —minúscula—. Así que un id válido copiado en mayúscula pasaba la validación y
 * luego NO acertaba ninguna comparación, y el síntoma cambia con la capacidad: en C2, el guard
 * diferido de materialización compara el id propuesto contra el almacenado tal cual, así que
 * cada intento de aceptar esa propuesta —por lo demás perfecta— se deshacía entero; en C5, la
 * comprobación de que una señal remediada es de las que la validación emitió descarta el
 * informe completo —después de pagarlo— por «señal inventada». Y en las dos, del lado de la
 * pantalla, el mapa de etiquetas se indexa por el id que devuelve la base y una clave en
 * mayúscula no acierta ninguna.
 *
 * Se normaliza AL PARSEAR, que es el único sitio donde se arregla una vez para todos los
 * lectores: lo que se persiste es canónico y las comparaciones —SQL y TypeScript— vuelven a ser
 * la misma pregunta. Los `lower(...)` de los guards se quedan: son el suelo de la base, y el
 * suelo no depende de que la aplicación haya hecho bien su parte.
 */
const IdCopiadoDelMaterial = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());

/**
 * Las citas de C3, cada una con el insight del que copia.
 *
 * No reusa `CitasSchema` porque su forma es distinta —lleva un id— y no lo envuelve con un
 * `.and()` porque el id es de la cita, no un añadido: leerlo como «citas + algo» invitaría a
 * tratarlo como opcional el día que se toque.
 *
 * El techo son SEIS, como el resto: un fragmento por insight y margen para dos por uno de
 * ellos. Y el mínimo es UNO, que es lo que hace que SYS-15 salga de la forma del contenido —
 * una HMW sin citas no puede existir, así que tampoco una sin traza.
 */
const CitasConInsightSchema = z
  .array(
    z.object({
      /* El insight del que se copia el fragmento, POR SU ID: del material, no inventado. */
      insightId: IdCopiadoDelMaterial,
      fragmento: z.string().trim().min(1).max(600),
      localizacion: z.string().trim().min(1).max(200),
    }),
  )
  .min(1)
  .max(6);

/**
 * CT — qué falta para un gate, con los huecos citados (RF-08.4, SPEC-08 §30).
 *
 * INFORMATIVO: aquí no hay ningún campo que describa un objeto a crear, y esa ausencia es
 * el contrato. CT «reporta huecos citando objetos; carece de acción aprobar». Lo que
 * produce se lee y se descarta; el gate lo aprueba una persona con su rol (SYS-18).
 *
 * `huecos` PUEDE venir vacío, y ése es un resultado legítimo y además el bueno: no falta
 * nada. Lo que no puede venir vacío son las citas — un informe que no dice qué miró no se
 * distingue de uno que no miró nada, y es exactamente el que hay que poder desmentir.
 */
export const ContenidoAsistenteGateSchema = z
  .object({
    resumen: z.string().trim().min(1).max(2000),
    huecos: z
      .array(
        z.object({
          /*
           * El item del checklist al que se refiere el hueco, POR SU ID.
           *
           * Se le pide un id y no una descripción porque el id es lo único verificable: el
           * prompt le manda los items con el suyo, y el servicio comprueba después que cada
           * uno de estos esté entre los que le mandó. Una descripción libre no se puede
           * contrastar contra nada, y un hueco que señala un requisito que no existe manda a
           * quien lo lee a buscar algo que no está.
           */
          checklistItemId: IdCopiadoDelMaterial,
          queFalta: z.string().trim().min(1).max(1000),
          comoCerrarlo: z.string().trim().min(1).max(1000),
        }),
      )
      .max(20),
    citas: CitasSchema,
    confianzaPropuesta: z.enum(CONFIANZA_PROPUESTA),
  })
  .describe(MARCA_CONTENIDO_SOLO_SERVIDOR);
export type ContenidoAsistenteGate = z.infer<typeof ContenidoAsistenteGateSchema>;

/**
 * C2 — un insight con sus afirmaciones, y cada afirmación con las citas que la sostienen
 * (SPEC-08 §30, I4: «la AI propone Y CITA; el humano aprueba»).
 *
 * Es el primer contenido COMPUESTO del pipeline: un insight no es una fila, es un `insight`
 * con sus `afirmacion` y las `cita` de cada una. Por eso las citas viven DENTRO de la
 * afirmación y no en una lista suelta al final: una cita es el sostén de UNA afirmación
 * concreta, y aplanarlas perdería justo lo que las hace verificables — cuál sostiene a cuál.
 *
 * Cada cita nombra su EVIDENCIA por id, copiado del material. Es el único campo contrastable
 * que tiene —el fragmento y la localización son texto—, y un trigger comprueba que cada id
 * esté entre las evidencias del reto: una cita a una evidencia ajena manda a quien revisa a
 * buscar un sostén que no está donde dice.
 *
 * `esHipotesis` no es decoración: SPEC-08 §RF-08.2 exige que las extrapolaciones se marquen
 * como hipótesis, y `afirmacion.es_hipotesis` es donde eso vive. Que lo diga el modelo y que
 * el humano pueda corregirlo es la diferencia entre una afirmación sostenida y una que suena
 * igual de bien.
 */
const CitaDeAfirmacionSchema = z.object({
  /* La evidencia de la que sale, POR SU ID: copiado del material, no inventado. */
  evidenciaId: IdCopiadoDelMaterial,
  fragmento: z.string().trim().min(1).max(600),
  localizacion: z.string().trim().min(1).max(200),
});

export const ContenidoInsightSchema = z
  .object({
    titulo: z.string().trim().min(1).max(300),
    resumen: z.string().trim().max(2000).default(''),
    afirmaciones: z
      .array(
        z.object({
          texto: z.string().trim().min(1).max(1000),
          /* SYS-20 / RF-08.2: lo que se extrapola se marca, no se disimula. */
          esHipotesis: z.boolean(),
          /* Al menos UNA: una afirmación sin cita es una opinión, y este pipeline no las
           * propone. El techo existe por lo mismo que el del lote: seis citas ya son más de
           * lo que alguien contrasta de una sentada. */
          citas: z
            .array(CitaDeAfirmacionSchema)
            .min(1)
            .max(6)
            /*
             * Y SIN REPETIR. Una cita idéntica dos veces no añade sostén —es el mismo
             * fragmento del mismo documento— y sí rompe una garantía: el guard de
             * materialización comprueba que cada cita propuesta exista entre las
             * materializadas, y con duplicados el conteo cuadra mientras las dos entradas
             * repetidas encuentran la misma fila. Queda un hueco para colar una cita que
             * nadie revisó. Comparar multiconjuntos en SQL lo cerraría también; rechazar el
             * duplicado lo cierra antes y dice por qué.
             */
            .refine(
              (xs) =>
                new Set(xs.map((c) => `${c.evidenciaId}\u0000${c.fragmento}\u0000${c.localizacion}`))
                  .size === xs.length,
              'una afirmación no repite la misma cita: no añade sostén y deja sin comprobar lo que se materializa',
            ),
        }),
      )
      .min(1)
      .max(6),
    /*
     * Las contradicciones se SEÑALAN, no se resuelven. I4 pide que la evidencia que
     * contradice al insight aparezca, y esconderla es la manera más limpia de vender una
     * conclusión. Puede venir vacío: no toda evidencia se contradice.
     */
    contradicciones: z
      .array(
        z.object({
          evidenciaId: IdCopiadoDelMaterial,
          descripcion: z.string().trim().min(1).max(1000),
        }),
      )
      .max(4)
      /*
       * UNA por evidencia. No es una preferencia de estilo: `contradiccion` tiene
       * `unique (insight_id, evidencia_id)`, así que un contenido con dos contradicciones
       * sobre el mismo documento se persiste, se enseña, se revisa… y su aceptación falla
       * SIEMPRE, en el segundo insert. Quien revisa se queda con una propuesta que solo
       * puede rechazar y sin manera de saber por qué —el formulario no edita las
       * contradicciones—, y la llamada ya está pagada.
       *
       * Se corta en el contrato, que es donde se puede decir el motivo: una respuesta que
       * no se puede aceptar se descarta al parsearla, como cualquier otra fuera de forma.
       */
      .refine(
        (xs) => new Set(xs.map((x) => x.evidenciaId)).size === xs.length,
        'dos contradicciones no pueden señalar la misma evidencia: el insight solo admite una por documento',
      ),
    confianzaPropuesta: z.enum(CONFIANZA_PROPUESTA),
  })
  .describe(MARCA_CONTENIDO_SOLO_SERVIDOR);
export type ContenidoInsight = z.infer<typeof ContenidoInsightSchema>;

/**
 * C5 — cómo CERRAR cada señal que la validación del grafo emitió (SPEC-08 §30, RF-05.6).
 *
 * INFORMATIVO, como CT. Y con una asimetría deliberada respecto a las otras capacidades: aquí
 * el modelo NO dice qué está mal. Eso ya lo dice `validarJourney`, que es determinista y no se
 * equivoca; pedirle al modelo que lo repita sería cambiar una respuesta exacta por una
 * probable. Lo que se le pide es lo otro: dada una señal REAL, qué hacer con ella en ESTE
 * grafo — y eso hay que leerlo entero para decirlo.
 *
 * Por eso cada remediación se identifica por `(nodoId, codigo)`: es el par que nombra una
 * señal ya emitida, y el servicio comprueba que esté entre las que produjo la MISMA lectura
 * del grafo con la que se armó el prompt. Una remediación de una señal inexistente es una
 * avería inventada, y de las caras: manda a alguien a arreglar un grafo que estaba bien.
 *
 * `remediaciones` PUEDE venir vacío: un grafo sin señales es un resultado legítimo, y además
 * el bueno.
 */
export const ContenidoRemediacionJourneySchema = z
  .object({
    resumen: z.string().trim().min(1).max(2000),
    remediaciones: z
      .array(
        z.object({
          /* El nodo que la señal nombra, por su id, copiado del material. */
          nodoId: IdCopiadoDelMaterial,
          /* Y el código de la señal, del catálogo de `validarJourney`. Derivado de él, no
           * copiado: un código nuevo entra aquí el día que la validación lo emita. */
          codigo: z.enum(CODIGOS_SENAL),
          comoCerrarlo: z.string().trim().min(1).max(1000),
        }),
      )
      /*
       * Al menos UNA, y como mucho `MAX_REMEDIACIONES`. El mínimo no estaba y hacía falta: un
       * informe de cero remediaciones sobre un grafo CON señales es una llamada pagada que no
       * dice nada, y el servicio ya se niega a pedir uno sobre un grafo limpio — así que la
       * lista vacía no describe ningún caso legítimo.
       *
       * El techo lleva nombre porque lo leen los dos lados de la misma regla: éste y la
       * negativa a generar cuando el grafo tiene más señales de las que este contrato puede
       * llevar. Con el número en un solo sitio no puede haber un grafo que se acepte para
       * pedir y cuya respuesta se descarte DESPUÉS de pagarla por venir corta.
       */
      .min(1)
      .max(MAX_REMEDIACIONES),
    citas: CitasSchema,
    confianzaPropuesta: z.enum(CONFIANZA_PROPUESTA),
  })
  .describe(MARCA_CONTENIDO_SOLO_SERVIDOR);
export type ContenidoRemediacionJourney = z.infer<typeof ContenidoRemediacionJourneySchema>;

/** Contenido de una propuesta: una de las formas tipadas, nunca un jsonb libre — así el
 * panel, el servicio y la corrección hablan del mismo objeto sin castings. */
export type ContenidoPropuesta =
  | ContenidoExtraccion
  | ContenidoCriterio
  | ContenidoAsistenteGate
  | ContenidoInsight
  | ContenidoRemediacionJourney
  | ContenidoEntradaKpi
  | ContenidoOportunidad
  | ContenidoPostMortem;

/**
 * El contrato de la salida del modelo para UNA propuesta, por capacidad.
 *
 * Vive aquí y no en `CAPACIDADES` por dónde cae la frontera, no por gusto. Ese registro lo
 * importa la PANTALLA —de él salen la etiqueta, los seis textos del ancla y sus dos errores—,
 * así que todo lo que cuelgue de él viaja al navegador. Y un esquema de Zod colgado de un
 * objeto no se puede podar: Rollup ve la referencia y se lleva el validador entero al chunk
 * de la ruta, donde nadie lo llama. Medido: 859 bytes de código muerto en `/propuestas`.
 *
 * Que nadie lo llame allí no es casualidad: desde que la frontera de la corrección es
 * `unknown`, la ÚNICA validación de contenido ocurre en el servidor, contra el esquema de la
 * capacidad de la fila. El navegador construye objetos; no los juzga.
 *
 * Sigue siendo un `Record<CapacidadActiva, …>`, así que una capacidad nueva no compila hasta
 * que alguien escriba su esquema — la costura no se afloja, solo se reparte por lados.
 *
 * La ENTRADA se tipa `unknown` a propósito: lo que llega es JSON del proveedor, y un esquema
 * con `default()` tiene un tipo de entrada distinto del de salida — pedirle que coincidan
 * rechazaría justo a los que traen valores por omisión.
 */
/**
 * C6 — una entrada del Metric Registry: qué se va a medir para saber si el reto se logró
 * (SPEC-07 RF-07.1, ADR-0007).
 *
 * `criterioId` es el campo que hace de esto una propuesta y no una ocurrencia: cada entrada
 * responde a UN criterio de éxito REAL del reto, y un KPI que no responde a ninguno es
 * telemetría, no medición de impacto. El id se copia del material y un guard comprueba
 * después que sea un criterio de ese reto — la misma verificación que C2 hace con la
 * evidencia de sus citas.
 *
 * Y las CITAS son del texto de ese criterio. Aquí no son adorno ni copia del `criterioId`:
 * son lo que distingue «este KPI mide la promesa que dice» de «este KPI suena a esa promesa».
 * El criterio trae KPI, definición, objetivo, ventana y plan de línea base, y el fragmento
 * citado tiene que aparecer LITERAL en alguno — es la señal de grounding que el panel mide
 * (I3), y sin ella la única prueba de que el modelo leyó el criterio sería que copió su id.
 *
 * LO QUE NO ESTÁ, y no por olvido: el dueño del dato, la línea base, el inicio de la ventana,
 * el dashboard y la fecha del post mortem. Los tres primeros son COMPROMISOS —una persona del
 * cliente se obliga a aportar un dato— y los otros son datos que constan o no constan.
 * Proponerlos es inventarlos, y aceptarlos los firmaría. La entrada nace incompleta a
 * propósito: `entrada_kpi` admite entradas incompletas porque el registry se redacta
 * iterando, y la completitud la exige la FIRMA.
 */
/*
 * Los TOPES de los cuatro campos de texto salen del editor del registry, no de aquí.
 *
 * Escritos a mano coincidían en dos y eran más anchos en los otros dos, y esa diferencia no
 * era inofensiva: una entrada materializada con 400 caracteres de `fuente` pasaba este
 * esquema y después el editor —que hidrata su formulario con esos valores— rechazaba TODA
 * guarda hasta acortarla. Como el editor es por donde se rellenan el dueño del dato, la línea
 * base y la ventana, la entrada quedaba bloqueando la firma de su propio contrato.
 *
 * Un límite propio solo tendría sentido si dijera algo que el editor no dice; aquí decía lo
 * mismo con otro número.
 */
export const ContenidoEntradaKpiSchema = z
  .object({
    /* El criterio de éxito al que responde, POR SU ID: copiado del material, no inventado. */
    criterioId: IdCopiadoDelMaterial,
    /*
     * El nombre es la CLAVE de la entrada dentro del registry (`unique (registry_id, nombre)`),
     * así que dos propuestas del mismo lote con el mismo nombre no pueden materializarse las
     * dos. Rechazarlo aquí no está en manos de este esquema —valida una entrada, no el lote—;
     * lo hace el servicio al comprobar el lote, que es quien las ve juntas.
     */
    nombre: z.string().trim().min(1).max(MAX_NOMBRE_KPI),
    /* Qué mide exactamente y cómo se calcula: sin esto un KPI es un rótulo. */
    definicion: z.string().trim().min(1).max(MAX_DEFINICION_KPI),
    /* De dónde sale el dato. Texto, no una URL: el dashboard es otra columna y la pone quien
     * lo tiene. */
    fuente: z.string().trim().min(1).max(MAX_FUENTE_KPI),
    /* Cortes del KPI. Puede venir vacío: no todo indicador se desagrega. */
    dimensiones: z.string().trim().max(MAX_DIMENSIONES_KPI).default(''),
    /* El vocabulario es el de la columna, no uno propio: `entrada_kpi.frecuencia` tiene su
     * CHECK y una lista distinta aquí produciría propuestas que el suelo rechaza. */
    frecuencia: z.enum(['semanal', 'mensual', 'trimestral', 'unica']),
    citas: CitasSchema,
    confianzaPropuesta: z.enum(CONFIANZA_PROPUESTA),
  })
  .describe(MARCA_CONTENIDO_SOLO_SERVIDOR);
export type ContenidoEntradaKpi = z.infer<typeof ContenidoEntradaKpiSchema>;

/**
 * C3 — una oportunidad HMW: la pregunta que abre la etapa 4 y los insights que la sostienen
 * (CTX-04, SYS-15).
 *
 * ── LA TRAZA ES LA CITA ──
 *
 * Este contenido NO lleva una lista de `insightIds` junto a las citas, y esa ausencia es la
 * decisión de diseño de la capacidad. Serían dos fuentes de verdad para el mismo hecho —«en
 * qué se apoya esta pregunta»— y se separan a la primera propuesta que declare tres insights
 * y cite dos. La traza se DERIVA de las citas: `oportunidad_insight` se materializa con los
 * `insightId` distintos que aparecen aquí, y el guard diferido lo comprueba en los dos
 * sentidos.
 *
 * Lo que eso compra: SYS-15 sale de la forma del contenido en vez de ser una regla aparte
 * —≥1 cita ⇒ ≥1 insight—, no se puede declarar apoyo en un insight del que no se copió nada,
 * y la traza hereda la inmutabilidad de las citas (SYS-17).
 *
 * ── LA PRIORIDAD VIENE CON SU RAZÓN, Y CONTRA QUÉ ──
 *
 * `prioridad` sin `prioridadRazon` sería un número que nadie puede discutir. La columna existe
 * en `oportunidad` precisamente porque un portafolio priorizado sin motivos es una lista
 * ordenada por quien la escribió último. Y el prompt pide que la razón hable de los CRITERIOS
 * DE ÉXITO del reto, que es lo que ata la etapa 3 a la promesa de la 0.
 *
 * ── LO QUE NO ESTÁ ──
 *
 * El VEREDICTO. Aceptar una propuesta de C3 mete la HMW en el portafolio `propuesta`, por
 * decidir; aprobarla o descartarla es un acto humano con su propia puerta —que re-comprueba
 * el razonamiento vivo— y su propia razón. Proponer el veredicto y aceptarlo lo firmaría.
 */
export const ContenidoOportunidadSchema = z
  .object({
    /*
     * La pregunta. El techo sale del contrato de `oportunidad` y no de aquí: escribirlo a
     * mano es cómo los dos números se separan, y con una pregunta de 600 caracteres la
     * propuesta pasaría este esquema para morir en el CHECK de la tabla con la llamada ya
     * pagada. Es la misma lección que los cuatro topes de C6.
     *
     * Que empiece por «¿Cómo podríamos…?» lo pide el prompt y NO lo comprueba nadie: la base
     * tampoco lo hace, y por el mismo motivo — exigir el prefijo impondría un idioma a un
     * producto que se usa en español y en inglés, y una regla que se rodea escribiendo el
     * prefijo delante no es una regla.
     */
    pregunta: z.string().trim().min(1).max(MAX_PREGUNTA),
    /* El rango es el de la columna, no uno propio: `oportunidad.prioridad` tiene su CHECK. */
    prioridad: z.number().int().min(0).max(1000),
    /* Y su porqué, obligatorio aunque la columna admita vacío: el vacío existe para las HMW
     * que escribe una persona sin priorizar todavía, no para las que propone un modelo — que
     * está proponiendo justamente un orden. */
    prioridadRazon: z.string().trim().min(1).max(MAX_RAZON),
    citas: CitasConInsightSchema,
    confianzaPropuesta: z.enum(CONFIANZA_PROPUESTA),
  })
  .describe(MARCA_CONTENIDO_SOLO_SERVIDOR);
export type ContenidoOportunidad = z.infer<typeof ContenidoOportunidadSchema>;

/**
 * C7 — el borrador del post mortem, escrito sobre datos deterministas (SPEC-08 §C7).
 *
 * ── LAS DISCREPANCIAS VIVEN AQUÍ, Y NO SON UN OBJETO NUEVO ──
 *
 * SPEC-08 pide «discrepancias propuestas» y «narrativa del outcome review». La primera lectura
 * fue que la discrepancia era un objeto que la AI propondría —una constatación— y eso es justo
 * lo que no puede hacer: una constatación es el testimonio de quien MIRÓ qué quedó
 * funcionando, y el modelo no miró nada. Además llegan como ENTRADA («DV vs. constataciones»):
 * ya están registradas cuando C7 corre.
 *
 * Así que las discrepancias son la lectura del modelo SOBRE el tablero, y viajan en el
 * contenido como las remediaciones de C5: cada una nombra un elemento de cambio POR SU ID
 * copiado del material, y el servicio comprueba que esté entre los que produjo la MISMA
 * lectura de la conciliación con la que se armó el prompt. Una desviación sobre un elemento
 * inexistente es una avería inventada, y de las caras: manda a alguien a revisar un release
 * que estaba bien.
 *
 * ── LOS CUATRO CAMPOS QUE SE MATERIALIZAN, Y LOS DOS QUE NO ──
 *
 * Se proponen contribución, factores externos, hipótesis abiertas y aprendizajes. No se
 * propone el VEREDICTO —`logrado / parcialmente-logrado / no-logrado / no-concluyente` es el
 * dictamen, y RF-07.8 lo pone en manos de quien firma— ni la casilla del diseño experimental
 * con su justificación: es la única que habilita lenguaje causal (SYS-24), y su justificación
 * es la afirmación de un humano sobre el diseño de SU medición. Dejársela al modelo sería
 * abrir la puerta trasera que esa invariante existe para cerrar, y encima con una firma que no
 * es de nadie.
 *
 * ── LOS TOPES ──
 *
 * `TOPE_NARRATIVA` es el del formulario de la etapa 7, no uno propio: escribir aquí otro
 * número es cómo los dos se separan, y con una narrativa de 9000 caracteres la propuesta
 * pasaría este esquema para morir después con la llamada ya pagada. Misma lección que los
 * cuatro topes de C6, que la aprendieron en una ronda de revisión.
 */
export const ContenidoPostMortemSchema = z
  .object({
    /*
     * La contribución y los aprendizajes, obligatorios: son lo que un post mortem dice. Un
     * borrador que llegara vacío en los dos es una llamada pagada que no contesta.
     */
    contribucion: z.string().trim().min(1).max(TOPE_NARRATIVA),
    aprendizajes: z.string().trim().min(1).max(TOPE_NARRATIVA),
    /*
     * Los factores externos y las hipótesis abiertas PUEDEN venir vacíos, y eso es una
     * respuesta: un reto donde no hubo nada externo que contar, o donde no quedó ninguna
     * pregunta abierta, existe. Obligarlos sería pedirle al modelo que rellene, que es
     * exactamente cómo se fabrica una narrativa que no se sostiene.
     */
    factoresExternos: z.string().trim().max(TOPE_NARRATIVA),
    hipotesisAbiertas: z.string().trim().max(TOPE_NARRATIVA),
    desviaciones: z
      .array(
        z.object({
          /* El elemento de cambio, por su id copiado del tablero de conciliación. */
          elementoId: z.string().uuid(),
          /* Qué dice el modelo sobre él: la discrepancia leída, no la constatación. */
          lectura: z.string().trim().min(1).max(MAX_LECTURA_DESVIACION),
        }),
      )
      /*
       * Puede venir VACÍA, al revés que las remediaciones de C5. Un reto cuyos elementos
       * salieron todos «como aprobado» es un resultado legítimo y además el bueno, y C7 se
       * ofrece sobre cualquier post mortem en borrador —no solo sobre los que tienen
       * desviaciones—, así que la lista vacía sí describe un caso real.
       */
      .max(MAX_DESVIACIONES_LEIDAS),
    /*
     * Y las citas, SIN `alcanceId`: el material de C7 es UN documento —el expediente del post
     * mortem, con el tablero de conciliación y las lecturas por criterio dentro—, así que la
     * presencia literal se mide contra él entero y no hay documento vecino del que un
     * fragmento pueda salir prestado. Es la forma de C0 y CI, no la de C2/C3/C6, y la
     * diferencia no es de estilo: allí el material son VARIOS documentos y por eso cada cita
     * tiene que decir de cuál sale.
     */
    citas: CitasSchema,
    confianzaPropuesta: z.enum(CONFIANZA_PROPUESTA),
  })
  .describe(MARCA_CONTENIDO_SOLO_SERVIDOR);
export type ContenidoPostMortem = z.infer<typeof ContenidoPostMortemSchema>;

export const ESQUEMA_DE_CONTENIDO: Record<
  CapacidadActiva,
  z.ZodType<ContenidoPropuesta, z.ZodTypeDef, unknown>
> = {
  CI: ContenidoExtraccionSchema,
  C0: ContenidoCriterioSchema,
  CT: ContenidoAsistenteGateSchema,
  C2: ContenidoInsightSchema,
  C5: ContenidoRemediacionJourneySchema,
  C6: ContenidoEntradaKpiSchema,
  C3: ContenidoOportunidadSchema,
  C7: ContenidoPostMortemSchema,
};

/**
 * DÓNDE guarda sus citas cada capacidad.
 *
 * Existe porque C2 lo cobró. Dos reglas centrales leían `contenido.citas` a pelo —la medida
 * de presencia literal del panel y la prohibición de corregir las citas— y eso funcionaba
 * porque las tres primeras capacidades las tenían en una lista al final. Las de C2 viven
 * DENTRO de cada afirmación, que es donde deben estar: una cita sostiene UNA afirmación
 * concreta y aplanarlas perdería cuál sostiene a cuál.
 *
 * Con el acceso a pelo, C2 no habría roto nada: `contenido.citas` sería `undefined` en los
 * dos lados de la comparación, la regla habría pasado en vacío y las citas de C2 serían
 * EDITABLES — borrando justo la señal que la corrección no puede tocar. Y su grounding se
 * habría medido sobre una lista vacía, o sea no se habría medido.
 *
 * `Record<CapacidadActiva, …>` para que una capacidad nueva tenga que decir dónde están las
 * suyas en vez de heredar una suposición.
 */
export type CitaDelContenido = {
  fragmento: string;
  localizacion: string;
  /**
   * A QUÉ trozo del material señala esta cita, cuando su capacidad lo dice.
   *
   * Las tres primeras capacidades citan contra UN material —el item, el reto, el checklist—,
   * así que «dónde aparece el fragmento» y «dónde dice la cita que aparece» son la misma
   * pregunta. C2 cita contra la evidencia de un reto, que son VARIOS documentos, y cada cita
   * nombra el suyo: sin esto, la presencia literal se mediría contra todos juntos y una cita
   * que dice «esto está en la evidencia B» saldría PRESENTE porque su texto está en la A.
   *
   * Eso no es un falso positivo cualquiera: la presencia literal es la única señal
   * contrastable que tiene quien revisa —el fragmento y la localización son texto—, y un
   * verde prestado le dice que puede confiar en una cita que manda a otro documento.
   *
   * `undefined` en las capacidades que citan contra un material único, que es su respuesta
   * correcta y no una omisión.
   */
  alcanceId?: string;
};
export const CITAS_DEL_CONTENIDO: Record<
  CapacidadActiva,
  (contenido: ContenidoPropuesta) => CitaDelContenido[]
> = {
  CI: (c) => (c as ContenidoExtraccion).citas,
  C0: (c) => (c as ContenidoCriterio).citas,
  CT: (c) => (c as ContenidoAsistenteGate).citas,
  C2: (c) =>
    (c as ContenidoInsight).afirmaciones.flatMap((a) =>
      a.citas.map((x) => ({ ...x, alcanceId: x.evidenciaId })),
    ),
  // C5 las guarda arriba, como las tres primeras: sus remediaciones no son el sujeto de las
  // citas —lo es el grafo entero—, así que no hay nada que anidar.
  C5: (c) => (c as ContenidoRemediacionJourney).citas,
  /*
   * C6 cita contra los CRITERIOS del reto, que son varios documentos como la evidencia de
   * C2 — así que el trozo del material contra el que se mide la presencia literal tiene que
   * decirse, o el fragmento saldría PRESENTE por estar en el criterio de al lado. Y no hace
   * falta preguntarlo por cita: la entrada entera responde a UN criterio, así que el suyo es
   * el de la propuesta. Preguntarlo dos veces abriría la posibilidad de que discreparan.
   */
  C6: (c) =>
    (c as ContenidoEntradaKpi).citas.map((x) => ({
      ...x,
      alcanceId: (c as ContenidoEntradaKpi).criterioId,
    })),
  /*
   * C3 cita contra los INSIGHTS validados del reto, que son varios documentos. Y aquí el
   * `alcanceId` se pregunta POR CITA y no una vez por propuesta, al revés que en C6: una
   * entrada KPI responde a UN criterio, pero una HMW puede nacer del cruce de dos o tres
   * insights —es justo lo que hace buena a una pregunta de la etapa 3—, así que cada cita
   * nombra el suyo.
   *
   * Y esa lista es además la TRAZA: los `insightId` distintos de aquí son los enlaces que la
   * aceptación materializa. Por eso no hay riesgo de que dos redacciones discrepen — solo hay
   * una.
   */
  C3: (c) =>
    (c as ContenidoOportunidad).citas.map((x) => ({ ...x, alcanceId: x.insightId })),
  /* C7 cita contra un solo documento —el expediente del post mortem—, así que sin alcance. */
  C7: (c) => (c as ContenidoPostMortem).citas,
};

/**
 * Qué MÁS, aparte de las citas, es testimonio del modelo y por tanto no se corrige.
 *
 * Las citas las cubre `CITAS_DEL_CONTENIDO` para todas; esto es lo que cada capacidad añade
 * por su cuenta. Hoy solo C2: sus CONTRADICCIONES.
 *
 * Y está en un registro y no en un `if (capacidad === 'C2')` porque este repositorio ya paga
 * esa lección con nombre propio —hay un guardián que barre el pipeline buscando ramas
 * binarias por capacidad, y lo encontró—. Con el `if`, la segunda capacidad que tuviera algo
 * intocable se habría comportado como la primera sin que faltara ninguna entrada.
 *
 * `null` es «nada más», y es una respuesta, no un hueco: el compilador exige la entrada de
 * toda capacidad activa, así que una nueva tiene que decidirlo en vez de heredarlo.
 */
export const TESTIMONIO_ADICIONAL: Record<
  CapacidadActiva,
  { parte: (contenido: ContenidoPropuesta) => unknown; motivo: string } | null
> = {
  CI: null,
  C0: null,
  CT: null,
  /*
   * C3 no añade nada, y eso es una respuesta y no un hueco: lo único que en esta capacidad es
   * testimonio del modelo —a qué insights se apoya— vive DENTRO de las citas, que ya son
   * intocables por `CITAS_DEL_CONTENIDO`. Justo por eso la traza no es un campo aparte.
   *
   * Y lo que queda fuera sí se corrige, que es la otra mitad: la pregunta se reescribe, la
   * prioridad se mueve y su razón también. Es lo que quien revisa está para hacer — una HMW
   * bien fundada pero mal formulada se arregla, no se tira.
   */
  C3: null,
  C2: {
    parte: (c) => (c as ContenidoInsight).contradicciones,
    /*
     * Una contradicción es la evidencia que va EN CONTRA del insight. I4 pide señalarla
     * precisamente porque esconderla es la manera más limpia de vender una conclusión, así
     * que dejar que quien revisa la reescriba al «corregir» sería devolverle esa manera con
     * otro nombre. Y señala un documento por su id, o sea que es —con las citas— la parte
     * contrastable de la salida de C2.
     */
    motivo:
      'Las contradicciones de un insight no se corrigen: son la evidencia que va en contra de lo que propone, y esconderla es la manera más limpia de vender una conclusión. Corrige el resto, o rechaza el insight.',
  },
  // C5 no guarda nada aparte de sus citas: sus remediaciones son el consejo, y ése SÍ se
  // corrige —para eso está la revisión humana—.
  C5: null,
  /*
   * C7 tampoco, y por el mismo argumento que C5, que es su pariente: las desviaciones son la
   * LECTURA del modelo sobre el tablero, y una lectura es exactamente lo que quien revisa está
   * para revisar. Lo contrastable —que el elemento exista en la conciliación de ESTE reto— no
   * se protege dejándolo intocable, se protege comprobándolo antes de que la propuesta nazca,
   * que es donde el servicio lo hace.
   *
   * La diferencia con el `criterioId` de C6, que sí es testimonio: allí el id ES el destino —
   * dice a qué criterio responde el KPI que se va a materializar— y cambiarlo cambia el objeto
   * que nace. Aquí no se materializa nada: las desviaciones se quedan en el contenido, que es
   * inmutable por SYS-17 en su versión original.
   */
  C7: null,
  C6: {
    parte: (c) => (c as ContenidoEntradaKpi).criterioId,
    /*
     * El `criterioId` de C6, y aquí hubo una contradicción mía que conviene dejar escrita
     * porque la resolución no es obvia.
     *
     * Lo puse en `null` razonando que elegir el criterio equivocado es el error que más se
     * corrige al revisar, y que `editarEntrada` existe justamente porque el dominio ya decidió
     * que ese campo se repara. Y a la vez `CITAS_DEL_CONTENIDO.C6` deriva de él el `alcanceId`
     * de cada cita, que la comparación de arriba SÍ compara: las dos reglas decían cosas
     * opuestas, y la que ganaba —el rechazo— lo hacía por accidente y con el mensaje
     * equivocado («las citas no se corrigen» sobre una corrección que no las tocaba).
     *
     * Gana el blindaje, y no por resolver el empate hacia el lado estricto: `criterioId` es la
     * mitad CONTRASTABLE de lo que el modelo dijo. Los fragmentos se copiaron de UN criterio,
     * y reapuntarlos a otro conservándolos es quedarse con el sostén de A para afirmar sobre
     * B — el mismo «verde prestado» que el pajar por cita existe para impedir. Es exactamente
     * lo que C2 hace con el `evidenciaId` de sus citas, y por eso esto deja de ser un caso
     * especial: la parte que se puede contrastar no la reescribe quien revisa.
     *
     * Lo de `editarEntrada` sigue siendo cierto y no se pierde: DESPUÉS de aceptar, la entrada
     * es un objeto de dominio y su criterio se repara mientras el registry sea borrador. Lo
     * que no se puede es reapuntarla ANTES, cuando lo que se está sellando es el testimonio.
     */
    motivo:
      'El criterio al que responde una entrada KPI no se corrige: los fragmentos citados se copiaron de ESE criterio, y reapuntarlos a otro conservando las citas es quedarse con el sostén de uno para afirmar sobre otro. Rechaza la propuesta, o acéptala y reapunta la entrada después (el registry lo admite mientras sea borrador).',
  },
};

/**
 * Valida el contenido según la capacidad: el MISMO esquema para la salida del modelo y para
 * la corrección humana. Corregir no puede producir algo que generar no podría, ni cambiar la
 * forma que la capacidad declara.
 */
export function parsearContenido(
  capacidad: CapacidadActiva,
  valor: unknown,
): ContenidoPropuesta {
  return ESQUEMA_DE_CONTENIDO[capacidad].parse(valor);
}
