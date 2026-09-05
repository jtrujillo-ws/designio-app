import { z } from 'zod';

/**
 * Oportunidad (HMW) — CTX-04, etapa 3.
 *
 * «Pregunta how might we trazable a uno o más insights». La traza es la mitad que importa:
 * sin ella una HMW es una ocurrencia con formato de pregunta, y G3 existe precisamente para
 * no dejar pasar eso (SYS-15).
 *
 * Ojo con el homónimo: `TipoNodo` incluye 'oportunidad' como tipo de NODO del grafo de un
 * journey. Son cosas distintas —aquel marca dónde, en el recorrido, hay margen de mejora;
 * ésta es el objeto del portafolio de la etapa 3— y no se referencian entre sí.
 */

export const EstadoOportunidadSchema = z.enum(['propuesta', 'aprobada', 'descartada']);
export type EstadoOportunidad = z.infer<typeof EstadoOportunidadSchema>;

/**
 * El techo de la pregunta, EXPORTADO porque el formulario tiene que llevar el mismo.
 *
 * Con el techo solo aquí, pegar una pregunta más larga dejaba el botón activo, el validador la
 * rechazaba en la frontera —antes de que el handler pudiera devolver su error de dominio— y la
 * pantalla enseñaba el mensaje genérico de reintento: quien escribe no llegaba a enterarse de
 * que lo que hay que hacer es acortarla. Un número escrito dos veces es un número que se
 * separa, así que va uno solo y lo leen los dos lados.
 */
export const MAX_PREGUNTA = 500;

/** Y el de las razones —la de la prioridad y la del veredicto—, por lo mismo y para los tres
 * controles que las escriben: los dos techos se exportan porque el número que gobierna tiene
 * que ser uno solo, no una copia en cada sitio que se pueda separar del original. */
export const MAX_RAZON = 2000;

/** El texto de la pregunta. No se valida que empiece por «HMW» ni por «cómo podríamos»:
 * imponer el prefijo sería imponer un idioma, y una regla que se rodea escribiendo el
 * prefijo delante no es una regla. */
const PreguntaSchema = z.string().trim().min(1).max(MAX_PREGUNTA);

export const CrearOportunidadSchema = z.object({
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
  pregunta: PreguntaSchema,
  prioridad: z.number().int().min(0).max(1000).default(0),
  prioridadRazon: z.string().trim().max(MAX_RAZON).default(''),
});
export type CrearOportunidad = z.infer<typeof CrearOportunidadSchema>;

export const EnlazarInsightSchema = z.object({
  workspaceId: z.string().uuid(),
  oportunidadId: z.string().uuid(),
  insightId: z.string().uuid(),
});
export type EnlazarInsight = z.infer<typeof EnlazarInsightSchema>;

export const PriorizarOportunidadSchema = z.object({
  workspaceId: z.string().uuid(),
  oportunidadId: z.string().uuid(),
  prioridad: z.number().int().min(0).max(1000),
  prioridadRazon: z.string().trim().max(MAX_RAZON).default(''),
});
export type PriorizarOportunidad = z.infer<typeof PriorizarOportunidadSchema>;

/**
 * El veredicto. Descartar exige razón —lo que se tira de la etapa 3 es justo lo que alguien
 * va a volver a proponer en la 4 si no consta por qué se tiró— y aprobar no: la razón de una
 * HMW aprobada son sus insights, que están enlazados y se pueden leer.
 *
 * El refinamiento va aquí y ADEMÁS en un CHECK de la tabla, no solo aquí: lo que vive únicamente
 * en el contrato no protege a quien escribe por la superficie SQL concedida.
 */
export const DecidirOportunidadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    oportunidadId: z.string().uuid(),
    estado: z.enum(['aprobada', 'descartada']),
    veredictoRazon: z.string().trim().max(MAX_RAZON).default(''),
  })
  .refine((v) => v.estado !== 'descartada' || v.veredictoRazon.length > 0, {
    path: ['veredictoRazon'],
    message: 'Descartar una oportunidad exige decir por qué',
  });
export type DecidirOportunidad = z.infer<typeof DecidirOportunidadSchema>;

/** Una oportunidad tal y como la lee la pantalla: con sus insights ya resueltos, porque el
 * portafolio se juzga por la traza y pedirla aparte invita a pintarlo sin ella. */
export const OportunidadDelPortafolioSchema = z.object({
  id: z.string().uuid(),
  retoId: z.string().uuid(),
  pregunta: z.string(),
  prioridad: z.number().int(),
  prioridadRazon: z.string(),
  estado: EstadoOportunidadSchema,
  veredictoRazon: z.string(),
  decididoEn: z.coerce.date().nullable(),
  insights: z.array(z.object({ id: z.string().uuid(), titulo: z.string() })),
});
export type OportunidadDelPortafolio = z.infer<typeof OportunidadDelPortafolioSchema>;

/** Los retos del workspace con su portafolio dentro: la unidad con la que se mira la etapa 3.
 * Se pide todo junto porque juzgar una HMW suelta, fuera de su reto y de las demás, es
 * exactamente lo que la priorización existe para no hacer. */
export const RetoConPortafolioSchema = z.object({
  retoId: z.string().uuid(),
  codigo: z.string(),
  titulo: z.string(),
  oportunidades: z.array(OportunidadDelPortafolioSchema),
  /**
   * Si la VENTANA de escritura del portafolio está abierta ahora mismo.
   *
   * Es el mismo `reto_admite_portafolio` que miran las cuatro políticas, traído a la
   * proyección porque la pantalla no lo puede deducir: depende de si G3 está firmado, de si
   * la etapa 3 está reabierta y del estado del reto, y ninguna de las tres cosas viaja en el
   * portafolio. Sin él la pantalla ofrecía enlazar, repriorizar y decidir sobre un
   * portafolio congelado, y cada intento rebotaba contra la política — un formulario que se
   * puede rellenar y no se puede guardar.
   */
  admitePortafolio: z.boolean(),
});
export type RetoConPortafolio = z.infer<typeof RetoConPortafolioSchema>;

/** Entradas de las server functions que solo necesitan el workspace. */
export const PortafolioInputSchema = z.object({ workspaceId: z.string().uuid() });
export type PortafolioInput = z.infer<typeof PortafolioInputSchema>;
