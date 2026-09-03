import { z } from 'zod';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';
import { VeredictoSchema } from '@/lib/metodo/metodo.schemas';
import type { RolCliente } from '@/lib/workspace/workspace.schemas';

/** CTX-06 Medición e Impacto — Metric Registry, snapshots append-only y outcome review (ADR-0007). */

export const EntradaKPISchema = z.object({
  id: z.string().uuid(),
  criterioId: z.string().uuid(),
  kpi: z.string().min(1),
  definicion: z.string().min(1),
  propietarioDelDato: z.string().min(1).describe('Persona del cliente responsable de aportarlo'),
  fuente: z.string().min(1),
  dimensiones: z.array(z.string()).default([]),
  frecuencia: z.enum(['semanal', 'mensual', 'trimestral', 'única']),
  dashboardExternoUrl: z.string().url().nullable(),
});
export type EntradaKPI = z.infer<typeof EntradaKPISchema>;

export const SnapshotSchema = z.object({
  id: z.string().uuid(),
  entradaKpiId: z.string().uuid(),
  valor: z.number(),
  /** Fecha del DATO, calendárica: un snapshot con huso rueda el día y falsea la serie. */
  fecha: FechaCalendarioSchema,
  origen: z.enum(['formulario', 'csv']),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const OutcomeReviewSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
  veredicto: VeredictoSchema,
  /** SYS-24: sin causalidad automática — contribución/asociación salvo flag experimental. */
  disenoExperimentalSuficiente: z.boolean().default(false),
  contribucion: z.string().min(1),
  factoresExternos: z.array(z.string()).default([]),
  aprendizajes: z.array(z.string()).default([]),
  retosCandidatosIds: z.array(z.string().uuid()).default([]),
  completadoEn: z.coerce.date(),
});
export type OutcomeReview = z.infer<typeof OutcomeReviewSchema>;

// ── Contratos ejecutables de SPEC-07 (entradas de server functions y proyecciones de ──
// ── la pantalla; los catálogos en base viajan como slugs y la UI muestra su etiqueta) ──

export const FRECUENCIAS = ['semanal', 'mensual', 'trimestral', 'unica'] as const;
export type Frecuencia = (typeof FRECUENCIAS)[number];

export const ETIQUETA_FRECUENCIA: Record<Frecuencia, string> = {
  semanal: 'Semanal',
  mensual: 'Mensual',
  trimestral: 'Trimestral',
  unica: 'Única',
};

/* Aquí vivía `CADENCIA_DIAS`, el espejo en días del CASE de la proyección (7/30/90). Se
 * borra en vez de corregirse: la cadencia es un INTERVALO DE CALENDARIO —«mensual» es el
 * mes siguiente, no treinta días— y eso no se puede escribir como número de días sin
 * volver a mentir. Nadie lo leía; el único que juzga la cadencia es el servidor, con
 * `interval`. Un espejo que nadie usa y que además es falso solo sirve para que el
 * siguiente lo copie. Lo que la UI necesita nombrar ya está en ETIQUETA_FRECUENCIA. */

/**
 * Estado de recepción del KPI (RF-07.4). Los tres primeros describen una medición VIVA:
 * la cadencia comprometida corre contra hoy. `cerrado` es el estado TERMINAL de un KPI
 * que cumplió: la ventana firmada se acabó y llegó todo lo que se esperaba. Existe porque
 * la ventana es acotada (I5) y después de ella la política rechaza cualquier snapshot: sin
 * un estado propio, cada KPI recurrente cumplido acababa marcado «vencido» por el simple
 * paso del tiempo sobre un proyecto que ya es historia.
 */
export const ESTADOS_SNAPSHOT = ['esperado', 'recibido', 'vencido', 'cerrado'] as const;
export type EstadoSnapshot = (typeof ESTADOS_SNAPSHOT)[number];

export const ETIQUETA_ESTADO_SNAPSHOT: Record<EstadoSnapshot, string> = {
  esperado: 'Snapshot esperado',
  recibido: 'Snapshot recibido',
  vencido: 'Snapshot vencido',
  cerrado: 'Medición cerrada',
};

export const ORIGENES_SNAPSHOT = ['formulario', 'csv'] as const;
export type OrigenSnapshot = (typeof ORIGENES_SNAPSHOT)[number];

/** Catálogo CERRADO del veredicto (SYS-24) tal como se codifica en base. El vocabulario
 * canónico del dominio vive en VeredictoSchema; estos son sus slugs. */
export const VEREDICTOS = [
  'logrado',
  'parcialmente-logrado',
  'no-logrado',
  'no-concluyente',
] as const;
export type VeredictoSlug = (typeof VEREDICTOS)[number];

export const ETIQUETA_VEREDICTO: Record<VeredictoSlug, string> = {
  logrado: 'Logrado',
  'parcialmente-logrado': 'Parcialmente logrado',
  'no-logrado': 'No logrado',
  'no-concluyente': 'No concluyente',
};

/** Valor de un KPI: viaja como TEXTO y se almacena numeric. No es un `number` de JS
 * porque el binario flotante redondea (0.1 + 0.2) y aquí se compara contra la línea
 * base de un contrato firmado; la base hace la aritmética exacta. */
export const ValorMetricoSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, 'Valor numérico (usa punto decimal)')
  .max(40);

export const RetoInputSchema = z.object({
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
});

export const SeguimientoInputSchema = z.object({
  workspaceId: z.string().uuid(),
  proyectoId: z.string().uuid(),
});

/** Campos de la entrada KPI (RF-07.1). Se aceptan INCOMPLETOS mientras el registry es
 * borrador: la completitud la exige la firma (SYS-22), igual que G0 con los criterios. */
const CamposEntradaSchema = z.object({
  workspaceId: z.string().uuid(),
  nombre: z.string().trim().min(1, 'El nombre del KPI es obligatorio').max(200),
  definicion: z.string().trim().max(2000).default(''),
  fuente: z.string().trim().max(300).default(''),
  dimensiones: z.string().trim().max(300).default(''),
  propietarioMiembroId: z.string().uuid().nullable().default(null),
  frecuencia: z.enum(FRECUENCIAS),
  dashboardUrl: z
    .union([z.literal(''), z.string().trim().url('Enlace de dashboard inválido').max(2000)])
    .default(''),
  lineaBaseValor: ValorMetricoSchema.nullable().default(null),
  lineaBaseFecha: FechaCalendarioSchema.nullable().default(null),
  ventanaInicio: FechaCalendarioSchema.nullable().default(null),
  fechaPostMortem: FechaCalendarioSchema.nullable().default(null),
});

export const CrearEntradaSchema = CamposEntradaSchema.extend({
  registryId: z.string().uuid(),
  criterioId: z.string().uuid(),
});
export type CrearEntrada = z.infer<typeof CrearEntradaSchema>;

/** Editar la entrada COMPLETA mientras el registry es borrador, criterio incluido: elegir
 * el criterio equivocado al crearla es el error fácil, y el criterio decide la VENTANA del
 * KPI (`ventana_dias` vive en él). Lo único que no se edita es `registryId`: eso sí es
 * identidad —la entrada pertenece a ese contrato— y moverla sería otra entrada. */
export const EditarEntradaSchema = CamposEntradaSchema.extend({
  entradaId: z.string().uuid(),
  criterioId: z.string().uuid(),
});
export type EditarEntrada = z.infer<typeof EditarEntradaSchema>;

export const RegistryInputSchema = z.object({
  workspaceId: z.string().uuid(),
  registryId: z.string().uuid(),
});

export const RegistrarSnapshotSchema = z.object({
  workspaceId: z.string().uuid(),
  entradaId: z.string().uuid(),
  valor: ValorMetricoSchema,
  fecha: FechaCalendarioSchema,
  /** Corregir es un snapshot NUEVO (SYS-23): la nota dice qué corrige. */
  nota: z.string().trim().max(500).default(''),
});
export type RegistrarSnapshot = z.infer<typeof RegistrarSnapshotSchema>;

export const CargarCsvSchema = z.object({
  workspaceId: z.string().uuid(),
  entradaId: z.string().uuid(),
  csv: z.string().max(100_000, 'Máximo 100k caracteres'),
});
export type CargarCsv = z.infer<typeof CargarCsvSchema>;

/** Fila rechazada del CSV con mensaje ACCIONABLE (criterio de aceptación 1): número de
 * línea del texto pegado, contenido y motivo. Nada se sobreescribe por una fila mala. */
export type FilaRechazada = { linea: number; contenido: string; motivo: string };

export const ResultadoCriterioSchema = z
  .object({
    workspaceId: z.string().uuid(),
    reviewId: z.string().uuid(),
    criterioId: z.string().uuid(),
    /** El valor final APUNTA a un snapshot real de la serie: no se teclea. */
    snapshotFinalId: z.string().uuid().nullable().default(null),
    lectura: z.string().trim().max(4000).default(''),
    sinDatosMotivo: z.string().trim().max(1000).default(''),
  })
  // Exactamente UNA de las dos, espejo del CHECK de la tabla: un resultado que trae valor
  // final y a la vez la explicación de que no hay dato se contradice a sí mismo.
  .refine((d) => (d.snapshotFinalId !== null) !== (d.sinDatosMotivo !== ''), {
    message: 'Elige el snapshot final o escribe por qué no hay dato, pero no las dos cosas',
    path: ['sinDatosMotivo'],
  });
export type ResultadoCriterioEntrada = z.infer<typeof ResultadoCriterioSchema>;

export const CompletarReviewSchema = z
  .object({
    workspaceId: z.string().uuid(),
    reviewId: z.string().uuid(),
    veredicto: z.enum(VEREDICTOS),
    contribucion: z
      .string()
      .trim()
      .min(1, 'Escribe la contribución del rediseño y lo que no puede atribuírsele')
      .max(8000),
    factoresExternos: z.string().trim().max(8000).default(''),
    hipotesisAbiertas: z.string().trim().max(8000).default(''),
    aprendizajes: z.string().trim().max(8000).default(''),
    /** RF-07.9: el lenguaje causal NO es el default; se habilita explícitamente. */
    disenoExperimentalSuficiente: z.boolean().default(false),
    disenoExperimentalJustificacion: z.string().trim().max(4000).default(''),
  })
  .refine((d) => !d.disenoExperimentalSuficiente || d.disenoExperimentalJustificacion !== '', {
    message: 'Declarar diseño experimental suficiente exige justificarlo (SYS-24)',
    path: ['disenoExperimentalJustificacion'],
  });
export type CompletarReview = z.infer<typeof CompletarReviewSchema>;

// ── Proyección de lectura del seguimiento de impacto (vive DENTRO del proyecto: RF-07.6) ──

export type SnapshotDeEntrada = {
  id: string;
  valor: string;
  fecha: string;
  origen: OrigenSnapshot;
  nota: string;
};

export type EntradaDeRegistry = {
  id: string;
  criterioId: string;
  criterioKpi: string;
  criterioObjetivo: string;
  criterioVentanaDias: number | null;
  nombre: string;
  definicion: string;
  fuente: string;
  dimensiones: string;
  propietarioMiembroId: string | null;
  propietarioNombre: string | null;
  /** El propietario del dato carga snapshots aunque no sea de la boutique (RF-07.4). */
  soyPropietario: boolean;
  frecuencia: Frecuencia;
  dashboardUrl: string;
  lineaBaseValor: string | null;
  lineaBaseFecha: string | null;
  ventanaInicio: string | null;
  ventanaFin: string | null;
  fechaPostMortem: string | null;
  /** Días hasta el cierre de la ventana. CERO significa «cierra hoy», y hoy todavía se
   * mide: solo un valor NEGATIVO dice que la ventana ya cerró (ver `ventanaAbierta`). */
  diasRestantes: number | null;
  ultimaFecha: string | null;
  estadoSnapshot: EstadoSnapshot;
  snapshots: SnapshotDeEntrada[];
};

export type ResultadoDeCriterio = {
  criterioId: string;
  criterioKpi: string;
  snapshotFinalId: string | null;
  valorFinal: string | null;
  fechaFinal: string | null;
  lectura: string;
  sinDatosMotivo: string;
};

export type OutcomeReviewDeReto = {
  id: string;
  estado: 'borrador' | 'completado';
  veredicto: VeredictoSlug | null;
  contribucion: string;
  factoresExternos: string;
  hipotesisAbiertas: string;
  aprendizajes: string;
  disenoExperimentalSuficiente: boolean;
  disenoExperimentalJustificacion: string;
  completadoEn: string | null;
  resultados: ResultadoDeCriterio[];
};

export type SeguimientoDeImpacto = {
  retoId: string;
  retoCodigo: string;
  retoEstado: string;
  retoVeredicto: VeredictoSlug | null;
  proyectoEstado: string;
  /** El reto YA venía midiendo cuando corrió la migración de este slice, sin contrato que
   * lo respaldara. Lo escribió la migración una sola vez y nadie más puede escribirlo; es
   * lo que abre las dos puertas del perdón histórico —redactar el registry sobre un reto
   * que no está 'activo' y terminar el movimiento del proyecto que se quedó atrás—. */
  medicionSinRegistry: boolean;
  registry: { id: string; estado: 'borrador' | 'firmado'; firmadoEn: string | null } | null;
  entradas: EntradaDeRegistry[];
  /** Criterios del reto sin KPI que los responda: la firma los exige (SYS-22). */
  criteriosSinEntrada: { id: string; kpi: string }[];
  /** Códigos de los proyectos del reto que están en implementación SIN su G7 aprobado:
   * los que harían fallar la apertura de la medición, que mueve a todos a la vez. */
  proyectosSinG7: string[];
  /** Candidatos a propietario del dato: SOLO los miembros del lado cliente (RF-07.1). No
   * es «los miembros del workspace» filtrados por conveniencia de pantalla — es la misma
   * lista que la política de la entrada y el guard de la firma exigen, así que ofrecer
   * aquí a un curador sería ofrecer algo que la base rechaza. */
  propietariosPosibles: { id: string; nombre: string; rol: RolCliente }[];
  review: OutcomeReviewDeReto | null;
};

/**
 * Espejo cliente EXACTO de `ventana_de_medicion_abierta` de la base: informa la pantalla,
 * no autoriza nada. El último día de la ventana cuenta como abierto —`diasRestantes === 0`
 * es «cierra hoy»— porque ese día la política del snapshot todavía acepta el dato de la
 * jornada; solo un valor negativo cierra. Sin ventana declarada tampoco está cerrada: no
 * hay nada que dar por terminado.
 */
export function ventanaAbierta(entrada: { diasRestantes: number | null }): boolean {
  return entrada.diasRestantes === null || entrada.diasRestantes >= 0;
}

/**
 * Espejo cliente EXACTO de lo que `abrirMedicion` acepta: informa la pantalla, no autoriza
 * nada. Son DOS caminos, no uno.
 *
 * El normal —reto 'activo'— y el HEREDADO: un reto que ya estaba en medición cuando corrió
 * la migración, cuyo proyecto se quedó atrás porque el ciclo anterior ni siquiera le daba
 * grant para moverse. Ese reto no tiene que moverse (ya está donde toca): lo que falta es
 * terminarle el movimiento al proyecto, y esta es la ÚNICA puerta del producto a esa
 * reparación. Escrito solo como `retoEstado === 'activo'`, la salida existía en el servicio
 * y era inalcanzable desde la pantalla: el proyecto se quedaba fuera de medición y su
 * outcome review no podía completarse, porque el guard del cierre exige que el proyecto
 * esté midiendo. Media salida no es una salida.
 *
 * La condición sobre el PROYECTO es la otra mitad del espejo, y no es cosmética: la marca
 * `medicionSinRegistry` no se borra al reparar —la migración la escribió y nadie la vuelve
 * a escribir—, así que sin ella el botón seguiría dibujándose después del arreglo para
 * fallar con «ningún proyecto puede pasar a medición». Lo que decide es el proyecto, y el
 * estado que decide es UNO: 'en-implementacion', que es el único desde el que la operación
 * mueve. 'activo' no está porque a medición se entra por G7, a G7 por G6 y G6 mete el
 * proyecto en implementación; el proyecto heredado que se quedó en 'activo' con su G6 ya
 * aprobado lo movió el relleno de la migración, y ofrecer aquí el botón para él era
 * ofrecerle el atajo que se salta la fase.
 */
export function medicionPorAbrir(seguimiento: {
  retoEstado: string;
  proyectoEstado: string;
  medicionSinRegistry: boolean;
}): boolean {
  if (seguimiento.proyectoEstado !== 'en-implementacion') {
    return false;
  }
  return (
    seguimiento.retoEstado === 'activo' ||
    (seguimiento.retoEstado === 'en-medicion' && seguimiento.medicionSinRegistry)
  );
}

/** El outcome review se habilita al cerrar la ventana del ÚLTIMO criterio (RF-07.7). */
export function ventanasCerradas(entradas: EntradaDeRegistry[]): boolean {
  return entradas.length > 0 && entradas.every((e) => !ventanaAbierta(e));
}

/**
 * Espejo cliente EXACTO de lo que `review_insert` acepta: informa la pantalla, no autoriza
 * nada. Son DOS condiciones y no una —el reto MIDIENDO y las ventanas del contrato ya
 * cerradas— y vive aquí, junto a su hermano `medicionPorAbrir`, por el mismo motivo: un
 * predicado de pantalla escrito a mano dentro del componente es el que se queda a medias.
 * Escrito solo como «las ventanas vencieron», el botón se dibujaba para un reto que aún no
 * ha abierto su medición y la política lo rechazaba en cada clic. Media condición es un
 * botón que miente, igual que media salida no es una salida.
 */
export function postMortemPorAbrir(seguimiento: {
  retoEstado: string;
  entradas: EntradaDeRegistry[];
}): boolean {
  return seguimiento.retoEstado === 'en-medicion' && ventanasCerradas(seguimiento.entradas);
}

/** Cómo se dice una ventana en la pantalla, en UN sitio: los tres estados (falta tiempo,
 * cierra hoy, ya cerró) más la ausencia de ventana. Escrito por su cuenta en cada bloque,
 * el caso del último día —el único que este corte introduce— se olvidaría en alguno. */
export function etiquetaVentana(diasRestantes: number | null): string {
  if (diasRestantes === null) return 'sin ventana';
  if (diasRestantes > 0) return `faltan ${diasRestantes} días`;
  if (diasRestantes === 0) return 'cierra hoy';
  return 'ventana cerrada';
}

/**
 * Por qué una fecha no puede entrar en la serie, o null si puede. La ventana firmada
 * acota QUÉ mide el dato (I5: la medición es temporal y acotada) y el futuro no se ha
 * medido todavía. Ambos extremos son INCLUSIVOS: el día que abre y el que cierra la
 * ventana son días medidos.
 *
 * Espejo del predicado de la política del snapshot, igual que `ventanasCerradas`: quien
 * autoriza es la base; esto da el motivo ACCIONABLE (RF-07.3, criterio 1), que en el CSV
 * va por fila. Puro y comparando textos porque son fechas calendáricas AAAA-MM-DD —
 * comparar textos es comparar días, sin husos de por medio, que es justo por lo que la
 * columna es `date` y no timestamp.
 */
export function motivoFechaDeSnapshot(
  fecha: string,
  ventana: { ventanaInicio: string | null; ventanaFin: string | null; hoy: string },
): string | null {
  if (fecha > ventana.hoy) {
    return `Fecha en el futuro: «${fecha}» (hoy es ${ventana.hoy})`;
  }
  if (ventana.ventanaInicio !== null && fecha < ventana.ventanaInicio) {
    return `Fecha anterior a la ventana firmada: «${fecha}» (abre el ${ventana.ventanaInicio})`;
  }
  if (ventana.ventanaFin !== null && fecha > ventana.ventanaFin) {
    return `Fecha posterior a la ventana firmada: «${fecha}» (cerró el ${ventana.ventanaFin})`;
  }
  return null;
}
