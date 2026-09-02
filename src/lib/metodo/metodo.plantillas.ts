/**
 * Método como código (§5.2, ADR-0005): vocabulario CANÓNICO de etapas y gates, y el
 * contenido inicial de los checklists de suficiencia por perfil. El perfil gradúa QUÉ
 * ítems aplican (actividades y umbrales), jamás los nombres ni los resultados (I1,
 * SYS-09). Este contenido es la primera versión de la biblioteca metodológica de la
 * boutique (CTX-07); se refina tras el piloto, versionándolo aquí.
 *
 * Módulo compartido (server + UI): sin imports de servidor.
 */

export const PERFILES = ['rapido', 'estandar', 'profundo'] as const;
export type Perfil = (typeof PERFILES)[number];

export const ETIQUETA_PERFIL: Record<Perfil, string> = {
  rapido: 'Rápido',
  estandar: 'Estándar',
  profundo: 'Profundo',
};

/** Nombres canónicos de las etapas 0-7 (idénticos en todo perfil; el CHECK de la
 * migración los ata al número — I1). */
export const ETAPAS_CANONICAS = [
  'Definición del objeto y del reto',
  'Investigación',
  'Análisis y entendimiento',
  'Conceptualización',
  'Exploración de soluciones',
  'Detalle de solución',
  'Plan de implementación',
  'Seguimiento de implementación',
] as const;

/** Rol que aprueba cada gate (§13.2): G0/G3/G5/G6 el sponsor del cliente; el resto,
 * el lead de la boutique. La migración lo ata por CHECK. */
export function rolAprobadorDeGate(numero: number): 'sponsor' | 'lead-boutique' {
  return [0, 3, 5, 6].includes(numero) ? 'sponsor' : 'lead-boutique';
}

type ItemPlantilla = { texto: string; perfiles: readonly Perfil[] };

const TODOS = PERFILES;
const ESTANDAR_Y_PROFUNDO = ['estandar', 'profundo'] as const;
const SOLO_PROFUNDO = ['profundo'] as const;

/**
 * Checklist de suficiencia por gate (RF-04.5): cada ítem se cumple enlazando un objeto
 * REAL (evidencia en el MVP) o queda N/A con justificación aprobada. La completitud de
 * criterios de G0 (ventanas y líneas base, SYS-22) NO es un ítem: la exige la propia
 * aprobación del gate contra los datos.
 */
export const CHECKLIST_POR_GATE: readonly (readonly ItemPlantilla[])[] = [
  // G0 — Definición
  [
    { texto: 'Formulación del reto validada con el sponsor', perfiles: TODOS },
    { texto: 'Stakeholders del reto identificados y notificados', perfiles: ESTANDAR_Y_PROFUNDO },
    { texto: 'Plan del proyecto y perfil acordados con el cliente', perfiles: ESTANDAR_Y_PROFUNDO },
  ],
  // G1 — Investigación
  [
    { texto: 'Evidencia primaria suficiente para decidir en etapa 2', perfiles: TODOS },
    { texto: 'Segmentos priorizados cubiertos por la evidencia', perfiles: ESTANDAR_Y_PROFUNDO },
    { texto: 'Codificación de la investigación revisada por pares', perfiles: SOLO_PROFUNDO },
  ],
  // G2 — Análisis
  [
    { texto: 'Insights con citas a evidencia enlazada', perfiles: TODOS },
    { texto: 'As-is validado con el cliente', perfiles: TODOS },
    { texto: 'Contradicciones de evidencia resueltas o explícitas', perfiles: ESTANDAR_Y_PROFUNDO },
  ],
  // G3 — Conceptualización
  [
    { texto: 'Portafolio de oportunidades trazable a insights', perfiles: TODOS },
    { texto: 'Principios de diseño acordados', perfiles: ESTANDAR_Y_PROFUNDO },
  ],
  // G4 — Exploración
  [
    { texto: 'Evidencia de test de cada concepto que avanza', perfiles: TODOS },
    { texto: 'Conceptos descartados con razón registrada', perfiles: TODOS },
    { texto: 'Tests con usuarios de cada segmento priorizado', perfiles: SOLO_PROFUNDO },
  ],
  // G5 — Detalle
  [
    { texto: 'Design version completa y consistente', perfiles: TODOS },
    { texto: 'Piezas críticas validadas con el cliente', perfiles: TODOS },
    { texto: 'Cobertura journey ↔ blueprint ↔ requisitos revisada', perfiles: ESTANDAR_Y_PROFUNDO },
  ],
  // G6 — Plan
  [
    { texto: 'Cada elemento asignado a un release con dueño y fecha', perfiles: TODOS },
    { texto: 'Metric Registry acordado (KPI, dueño del dato, fuente)', perfiles: TODOS },
    { texto: 'Riesgos y RACI del plan revisados', perfiles: ESTANDAR_Y_PROFUNDO },
  ],
  // G7 — Seguimiento
  [
    { texto: 'Releases conciliados contra la design version', perfiles: TODOS },
    { texto: 'Effective state constatado con desviaciones explicadas', perfiles: TODOS },
    { texto: 'Medición operando con baseline y snapshots llegando', perfiles: ESTANDAR_Y_PROFUNDO },
  ],
];

/** Ítems del checklist de un gate para un perfil (textos en su orden canónico). */
export function checklistParaPerfil(gate: number, perfil: Perfil): string[] {
  return CHECKLIST_POR_GATE[gate]!.filter((i) => i.perfiles.includes(perfil)).map((i) => i.texto);
}
