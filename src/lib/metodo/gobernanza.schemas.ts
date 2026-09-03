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
   * antes de levantar**: cubre las tres comprobaciones —evidencia citada usable, insights
   * enlazados `validado`, y toda afirmación no-hipótesis con al menos una cita usable— sin
   * que esta proyección tenga que enunciar ninguna.
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
};
