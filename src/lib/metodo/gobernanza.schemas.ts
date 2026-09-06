import { z } from 'zod';

/**
 * CTX-03 — Gobernanza del método más allá del gate: decisiones aprobadas trazables a
 * los insights que las sostienen (RF-04.10), arquetipos del reto con evidencia
 * obligatoria (RF-04.11) y reapertura de etapa que cuestiona sin borrar (RF-04.9).
 */

export const TIPOS_DECISION = ['pasa-muere', 'diseno', 'alcance', 'otra'] as const;
export type TipoDecision = (typeof TIPOS_DECISION)[number];

export const ETIQUETA_TIPO_DECISION: Record<TipoDecision, string> = {
  'pasa-muere': 'Pasa / muere',
  diseno: 'Diseño',
  alcance: 'Alcance',
  otra: 'Otra',
};

export const RegistrarDecisionSchema = z.object({
  workspaceId: z.string().uuid(),
  gateId: z.string().uuid(),
  tipo: z.enum(TIPOS_DECISION),
  titulo: z.string().trim().min(1, 'El título es obligatorio').max(300),
  fundamento: z.string().trim().max(4000).default(''),
  /** Sin insights que la sostengan no hay decisión trazable: el servicio lo exige. */
  insightIds: z.array(z.string().uuid()).min(1, 'Enlaza al menos un insight').max(20),
  /**
   * Qué concepto se decide, cuando la decisión es un pasa/muere (RF-04.10).
   *
   * Opcional en el TIPO y obligatorio en el REFINE, que no es lo mismo: el resto de tipos no
   * decide ningún concepto, y un pasa/muere sin concepto no es una decisión incompleta, es un
   * pasa/muere que no dice sobre qué. La compatibilidad que las filas antiguas necesitan es
   * que la COLUMNA admita nulos —hay decisiones 'pasa-muere' anteriores a que la tabla
   * existiera—, y eso no obliga a seguir aceptando altas nuevas sin él.
   *
   * La atadura al revés —un concepto solo cuelga de una decisión de ese tipo— es un CHECK de
   * la base; aquí se anticipan las dos para que la pantalla diga qué pasa en vez de enseñar
   * un 23514.
   */
  conceptoId: z.string().uuid().optional(),
}).refine((d) => (d.tipo === 'pasa-muere') === (d.conceptoId !== undefined), {
  path: ['conceptoId'],
  message: 'Una decisión pasa/muere decide un concepto, y solo ella lo decide',
});
export type RegistrarDecision = z.infer<typeof RegistrarDecisionSchema>;

export const RevalidarDecisionSchema = z.object({
  workspaceId: z.string().uuid(),
  decisionId: z.string().uuid(),
});

export const CrearArquetipoSchema = z.object({
  workspaceId: z.string().uuid(),
  retoId: z.string().uuid(),
  nombre: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
  definicion: z.string().trim().max(4000).default(''),
  segmentoIds: z.array(z.string().uuid()).max(20).default([]),
});
export type CrearArquetipo = z.infer<typeof CrearArquetipoSchema>;

export const ApoyarArquetipoSchema = z.object({
  workspaceId: z.string().uuid(),
  arquetipoId: z.string().uuid(),
  evidenciaId: z.string().uuid(),
});

export const VeredictoArquetipoSchema = z.object({
  workspaceId: z.string().uuid(),
  arquetipoId: z.string().uuid(),
  estado: z.enum(['confirmado', 'refutado']),
  razon: z.string().trim().min(1, 'La razón del veredicto es obligatoria').max(2000),
});
export type VeredictoArquetipo = z.infer<typeof VeredictoArquetipoSchema>;

export const ReabrirEtapaSchema = z.object({
  workspaceId: z.string().uuid(),
  proyectoId: z.string().uuid(),
  etapaNumero: z.number().int().min(0).max(7),
  motivo: z.string().trim().min(1, 'El motivo de la reapertura es obligatorio').max(2000),
  /**
   * Los insights que la reapertura declara cambiados (RF-04.9: «registra motivo y
   * cambios»). Si se declaran, solo entran en revisión las decisiones que se apoyan en
   * ellos; si se deja vacío, se marca la etapa entera hacia adelante y así queda
   * registrado. Declarar es lo preciso; barrer es lo honesto cuando no se puede acotar.
   */
  insightIds: z.array(z.string().uuid()).max(50).default([]),
});
export type ReabrirEtapa = z.infer<typeof ReabrirEtapaSchema>;

/** Proyecciones de lectura para la pantalla del proyecto. */
export type DecisionDeProyecto = {
  id: string;
  gateNumero: number;
  tipo: TipoDecision;
  titulo: string;
  fundamento: string;
  estado: 'vigente' | 'en-revision';
  decididoEn: string;
  insights: { id: string; titulo: string }[];
  /**
   * Por qué NO se puede citar esta decisión, ya redactado, o `null` si se puede. Sale de
   * `razonamiento_sin_respaldo`, **la misma función que consulta el guard de suficiencia
   * antes de levantar**: cubre las cuatro comprobaciones —evidencia citada usable, ninguna
   * decisión en revisión, insights enlazados `validado`, y toda afirmación no-hipótesis con
   * al menos una cita usable— sin que esta proyección tenga que enunciar ninguna.
   *
   * Estuvo escrito a mano, con las comprobaciones repartidas en dos campos, y así fue como
   * el selector de la design version —copiado de éste— se quedó con una sola. El estado
   * VIVO del respaldo es algo que `estado` no cuenta: `estado` habla de reaperturas
   * (SYS-10) y una decisión perfectamente `vigente` puede trazarse a un insight sin validar
   * o apoyarse en evidencia cuyos derechos se revocaron.
   */
  sinRespaldo: string | null;
};

/** Los tres estados de gobernanza de un arquetipo (SPEC-04.11). Vive aquí y se importa
 * desde donde haga falta: el journey referencia arquetipos y necesita hablar del mismo
 * vocabulario, no de una copia que pueda quedarse atrás. */
export type EstadoArquetipo = 'hipotesis' | 'confirmado' | 'refutado';

/** Cómo se NOMBRA cada estado en pantalla: el slug es de la base, no del lector. */
export const ETIQUETA_ESTADO_ARQUETIPO: Record<EstadoArquetipo, string> = {
  hipotesis: 'Hipótesis',
  confirmado: 'Confirmado',
  refutado: 'Refutado',
};

/** Y su color, uno para el proyecto y para la biblioteca: el vocabulario visual es el mismo. */
export const COLOR_ARQUETIPO: Record<EstadoArquetipo, string> = {
  hipotesis: 'var(--warn)',
  confirmado: 'var(--accent)',
  refutado: 'var(--text-faint)',
};

export type ArquetipoDeReto = {
  id: string;
  nombre: string;
  definicion: string;
  estado: EstadoArquetipo;
  veredictoRazon: string;
  segmentos: { id: string; nombre: string }[];
  evidencias: { id: string; titulo: string }[];
};

export type AlcanceReapertura = 'declarado' | 'etapa-completa';

export const ETIQUETA_ALCANCE: Record<AlcanceReapertura, string> = {
  declarado: 'insights declarados',
  'etapa-completa': 'etapa completa',
};

export type ReaperturaDeProyecto = {
  id: string;
  etapaNumero: number;
  motivo: string;
  alcance: AlcanceReapertura;
  decisionesMarcadas: number;
  insights: { id: string; titulo: string }[];
  reabiertoEn: string;
};

export type GobernanzaDeProyecto = {
  decisiones: DecisionDeProyecto[];
  arquetipos: ArquetipoDeReto[];
  reaperturas: ReaperturaDeProyecto[];
  /** Segmentos del workspace: el mapeo n:m del arquetipo se elige entre estos (RF-01.7). */
  segmentosDisponibles: { id: string; nombre: string }[];
  /**
   * Conceptos del reto: sobre uno de ellos decide un pasa/muere (RF-04.10).
   *
   * Con el estado dentro porque la pantalla lo enseña: elegir «El que ya murió» para un
   * pasa/muere es raro pero no imposible —la decisión y el veredicto son dos escrituras del
   * mismo acto y pueden llegar en cualquier orden—, y quien decide tiene que ver cuál es cuál.
   */
  conceptos: {
    id: string;
    titulo: string;
    estado: EstadoConcepto;
    /**
     * Y LAS REVISIONES SIMULADAS QUE YA SE ACEPTARON SOBRE ÉL.
     *
     * Sin esto, C4 escribía y nadie leía: la revisión, sus hallazgos, sus citas y las preguntas
     * de test entraban en la base y salían del panel —que solo pinta `estado = 'propuesta'`— sin
     * ninguna pantalla detrás. Las preguntas son lo único que una simulación le entrega a la
     * etapa 4 (RF-08.2), así que dejarlas sin lector es dejar la capacidad sin entregar.
     *
     * Las cinco capacidades que materializan tienen su sitio donde leer lo aceptado: los
     * insights en `/insights`, las entradas de KPI en el registry, las HMW en el portafolio, el
     * post mortem en medición. Ésta es el de C4.
     */
    revisiones: RevisionSimuladaDeConcepto[];
  }[];
};

/**
 * Una sesión de revisión simulada, tal como la lee quien decide el pasa/muere.
 *
 * Con la lente y su estado por delante, porque es lo que dice DESDE QUÉ perfil se leyó, y con
 * la marca de simulación en cada hallazgo: SYS-20 pide que no se pueda confundir con
 * investigación, y eso vale también donde se lee, no solo donde se guarda.
 */
export type RevisionSimuladaDeConcepto = {
  id: string;
  arquetipoNombre: string;
  arquetipoEstado: string;
  sintesis: string;
  /** De qué propuesta salió, o `null` si la escribió una persona (SYS-21). */
  propuestaAiId: string | null;
  hallazgos: {
    id: string;
    titulo: string;
    descripcion: string;
    esHipotesis: boolean;
    /** Los documentos que sostienen la lectura, por título. Vacío en una hipótesis. */
    citas: string[];
  }[];
  /** Lo único que esta sesión le entrega a la etapa 4: qué ir a probar con personas. */
  preguntas: {
    id: string;
    pregunta: string;
    escenario: string;
    /**
     * De qué hallazgo nace, o `null` si no nace de ninguno.
     *
     * El enlace es opcional en la base y no es adorno: distingue «ve a comprobar ESTE riesgo
     * que la simulación se inventó» de una pregunta suelta. La tarjeta de la propuesta
     * pendiente ya lo dice —«Nace del hallazgo N»— y perderlo al aceptar cortaría el rastro
     * justo cuando se está decidiendo el pasa/muere.
     */
    hallazgoId: string | null;
  }[];
};

/** El ciclo de vida de un concepto, tal como lo escribe su tabla. */
export const ESTADOS_CONCEPTO = ['candidato', 'pasa', 'muere'] as const;
export type EstadoConcepto = (typeof ESTADOS_CONCEPTO)[number];
export const ETIQUETA_ESTADO_CONCEPTO: Record<EstadoConcepto, string> = {
  candidato: 'candidato',
  pasa: 'pasa',
  muere: 'muere',
};
