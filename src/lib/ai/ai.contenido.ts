import { z } from 'zod';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';
import { CONFIANZA_PROPUESTA, type CapacidadActiva } from './ai.schemas';

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
          checklistItemId: z.string().uuid(),
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
  evidenciaId: z.string().uuid(),
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
          evidenciaId: z.string().uuid(),
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

/** Contenido de una propuesta: una de las formas tipadas, nunca un jsonb libre — así el
 * panel, el servicio y la corrección hablan del mismo objeto sin castings. */
export type ContenidoPropuesta =
  | ContenidoExtraccion
  | ContenidoCriterio
  | ContenidoAsistenteGate
  | ContenidoInsight;

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
export const ESQUEMA_DE_CONTENIDO: Record<
  CapacidadActiva,
  z.ZodType<ContenidoPropuesta, z.ZodTypeDef, unknown>
> = {
  CI: ContenidoExtraccionSchema,
  C0: ContenidoCriterioSchema,
  CT: ContenidoAsistenteGateSchema,
  C2: ContenidoInsightSchema,
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
