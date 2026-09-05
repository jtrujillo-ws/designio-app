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

/** Contenido de una propuesta: una de las formas tipadas, nunca un jsonb libre — así el
 * panel, el servicio y la corrección hablan del mismo objeto sin castings. */
export type ContenidoPropuesta = ContenidoExtraccion | ContenidoCriterio | ContenidoAsistenteGate;

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
