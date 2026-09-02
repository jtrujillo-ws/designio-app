import type {
  JourneyCompleto,
  NodoDeJourney,
  SenalValidacion,
  TipoNodo,
} from './journey.schemas';

/**
 * Render Mermaid y validación del grafo (RF-05.3, RF-05.6): funciones PURAS sobre la
 * proyección del journey. Que no toquen la base es lo que las hace testeables caso por
 * caso y lo que garantiza el criterio de aceptación 1 — el código Mermaid es un
 * artefacto derivado de solo lectura: editarlo no cambia nada porque nada lo lee.
 *
 * Módulo compartido (servidor + UI): sin imports de servidor.
 */

/** Forma del nodo por tipo: el vocabulario visual también es canónico. */
const FORMA: Record<TipoNodo, [string, string]> = {
  fase: ['[', ']'],
  paso: ['([', '])'],
  touchpoint: ['[/', '/]'],
  canal: ['[\\', '\\]'],
  actor: ['((', '))'],
  arquetipo: ['((', '))'],
  sistema: ['[(', ')]'],
  'accion-frontstage': ['[', ']'],
  'accion-backstage': ['[', ']'],
  emocion: ['>', ']'],
  friccion: ['{{', '}}'],
  oportunidad: ['{{', '}}'],
  decision: ['{', '}'],
};

/** Identificador estable y seguro para Mermaid a partir del uuid. */
function idMermaid(id: string): string {
  return `n${id.replace(/-/g, '').slice(0, 12)}`;
}

/** Mermaid interpreta comillas, corchetes y saltos: el texto del usuario se neutraliza
 * (no se «escapa» — se sustituye, porque Mermaid no tiene escapes fiables). */
function texto(valor: string): string {
  return valor
    .replace(/["`]/g, "'")
    .replace(/[[\]{}()<>|]/g, ' ')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Diagrama de flujo por fases con bifurcaciones condicionadas. Las transiciones son el
 * esqueleto; el resto de las relaciones se dibuja punteado con su tipo, para que el
 * render no mienta sobre qué es una secuencia y qué es un soporte.
 */
export function mermaidDeJourney(journey: JourneyCompleto): string {
  const lineas: string[] = ['flowchart TD'];
  const fases = journey.nodos.filter((n) => n.tipo === 'fase').sort((a, b) => a.orden - b.orden);
  const sueltos = journey.nodos.filter((n) => n.tipo !== 'fase' && n.faseId === null);
  const porFase = new Map<string, NodoDeJourney[]>();
  for (const n of journey.nodos) {
    if (n.tipo === 'fase' || n.faseId === null) continue;
    const lista = porFase.get(n.faseId) ?? [];
    lista.push(n);
    porFase.set(n.faseId, lista);
  }

  for (const fase of fases) {
    lineas.push(`  subgraph ${idMermaid(fase.id)}["${texto(fase.etiqueta)}"]`);
    const dentro = (porFase.get(fase.id) ?? []).sort((a, b) => a.orden - b.orden);
    if (dentro.length === 0) {
      // Un subgrafo vacío rompe el layout: se marca explícitamente para que la fase
      // sin pasos se VEA (y la validación ya la reporta aparte).
      lineas.push(`    ${idMermaid(fase.id)}_vacia[" "]`);
    }
    for (const n of dentro) {
      const [a, b] = FORMA[n.tipo];
      lineas.push(`    ${idMermaid(n.id)}${a}"${texto(n.etiqueta)}"${b}`);
    }
    lineas.push('  end');
  }

  for (const n of sueltos.sort((x, y) => x.orden - y.orden)) {
    const [a, b] = FORMA[n.tipo];
    lineas.push(`  ${idMermaid(n.id)}${a}"${texto(n.etiqueta)}"${b}`);
  }

  for (const arista of journey.aristas) {
    // «pertenece-a» ya está dibujada por el subgrafo: repetirla como flecha duplicaría
    // la información y ensuciaría el flujo.
    if (arista.tipo === 'pertenece-a') continue;
    const origen = idMermaid(arista.origenId);
    const destino = idMermaid(arista.destinoId);
    if (arista.tipo === 'transicion') {
      lineas.push(
        arista.condicion
          ? `  ${origen} -->|"${texto(arista.condicion)}"| ${destino}`
          : `  ${origen} --> ${destino}`,
      );
    } else {
      const etiqueta = arista.condicion
        ? `${arista.tipo}: ${texto(arista.condicion)}`
        : arista.tipo;
      lineas.push(`  ${origen} -.->|"${etiqueta}"| ${destino}`);
    }
  }

  return lineas.join('\n');
}

/**
 * Validación accionable del grafo (RF-05.6). No bloquea nada por sí sola: produce
 * señales que el checklist del gate referencia (I2 — la validación es gate, no etapa).
 *
 * Cubre las cinco familias de la spec: pasos sin evidencia, transiciones rotas
 * (inalcanzables o sin salida), huecos frontstage↔backstage, elementos sin responsable
 * y nodos huérfanos de fase.
 */
export function validarJourney(journey: JourneyCompleto): SenalValidacion[] {
  const senales: SenalValidacion[] = [];
  const pasos = journey.nodos.filter((n) => n.tipo === 'paso');
  const transiciones = journey.aristas.filter((a) => a.tipo === 'transicion');
  const conEntrada = new Set(transiciones.map((a) => a.destinoId));
  const conSalida = new Set(transiciones.map((a) => a.origenId));

  for (const paso of pasos) {
    if (paso.evidencias.length === 0) {
      senales.push({
        codigo: 'paso-sin-evidencia',
        severidad: 'alta',
        nodoId: paso.id,
        etiqueta: paso.etiqueta,
        mensaje: 'El paso no tiene evidencia enlazada que lo sostenga',
      });
    }
    // El primer paso del journey no necesita entrada; el resto sí. «Primero» se define
    // por orden dentro de su fase (y por orden global si no tiene fase).
    const esPrimero = pasos.every((otro) => otro.id === paso.id || otro.orden >= paso.orden);
    if (!conEntrada.has(paso.id) && !esPrimero) {
      senales.push({
        codigo: 'paso-inalcanzable',
        severidad: 'alta',
        nodoId: paso.id,
        etiqueta: paso.etiqueta,
        mensaje: 'Ninguna transición llega a este paso: es inalcanzable',
      });
    }
    // El último tampoco necesita salida: el journey termina en algún lado.
    const esUltimo = pasos.every((otro) => otro.id === paso.id || otro.orden <= paso.orden);
    if (!conSalida.has(paso.id) && !esUltimo) {
      senales.push({
        codigo: 'paso-sin-salida',
        severidad: 'media',
        nodoId: paso.id,
        etiqueta: paso.etiqueta,
        mensaje: 'El paso no tiene transición de salida y no es el final',
      });
    }
    if (paso.faseId === null) {
      senales.push({
        codigo: 'huerfano-de-fase',
        severidad: 'media',
        nodoId: paso.id,
        etiqueta: paso.etiqueta,
        mensaje: 'El paso no pertenece a ninguna fase',
      });
    }
  }

  // Hueco frontstage↔backstage: lo que el usuario ve sin nada que lo sostenga detrás.
  const soportes = new Set(
    journey.aristas.filter((a) => a.tipo === 'soporta').map((a) => a.destinoId),
  );
  for (const accion of journey.nodos.filter((n) => n.tipo === 'accion-frontstage')) {
    if (!soportes.has(accion.id)) {
      senales.push({
        codigo: 'frontstage-sin-soporte',
        severidad: 'alta',
        nodoId: accion.id,
        etiqueta: accion.etiqueta,
        mensaje: 'Acción visible sin soporte backstage ni sistema que la sostenga',
      });
    }
  }

  // Responsable: se exige donde alguien tiene que hacer algo, no en emociones ni
  // fricciones (que se sienten, no se ejecutan).
  const EXIGEN_RESPONSABLE: TipoNodo[] = ['accion-frontstage', 'accion-backstage', 'sistema'];
  for (const nodo of journey.nodos) {
    if (EXIGEN_RESPONSABLE.includes(nodo.tipo) && nodo.responsable.trim() === '') {
      senales.push({
        codigo: 'sin-responsable',
        severidad: 'media',
        nodoId: nodo.id,
        etiqueta: nodo.etiqueta,
        mensaje: 'El elemento no tiene responsable asignado',
      });
    }
  }

  return senales;
}

/** Carriles del blueprint (RF-05.4): los pasos ordenan las columnas y cada carril
 * muestra lo que le corresponde, alineado por paso. */
export type CarrilesBlueprint = {
  pasos: NodoDeJourney[];
  carriles: {
    nombre: string;
    porPaso: Record<string, NodoDeJourney[]>;
  }[];
};

export function carrilesDeJourney(journey: JourneyCompleto): CarrilesBlueprint {
  const pasos = [...journey.nodos.filter((n) => n.tipo === 'paso')].sort(
    (a, b) => a.orden - b.orden,
  );
  const porId = new Map(journey.nodos.map((n) => [n.id, n]));

  /** Nodos de un tipo relacionados con un paso por cualquier arista, en cualquier
   * dirección: en el blueprint importa la adyacencia, no quién apuntó a quién. */
  function relacionados(pasoId: string, tipos: TipoNodo[]): NodoDeJourney[] {
    const vecinos: NodoDeJourney[] = [];
    for (const a of journey.aristas) {
      const otroId = a.origenId === pasoId ? a.destinoId : a.destinoId === pasoId ? a.origenId : null;
      if (!otroId) continue;
      const nodo = porId.get(otroId);
      if (nodo && tipos.includes(nodo.tipo) && !vecinos.some((v) => v.id === nodo.id)) {
        vecinos.push(nodo);
      }
    }
    return vecinos;
  }

  const definicion: { nombre: string; tipos: TipoNodo[] }[] = [
    { nombre: 'Evidencia física', tipos: ['touchpoint', 'canal'] },
    { nombre: 'Frontstage', tipos: ['accion-frontstage', 'actor', 'arquetipo'] },
    { nombre: 'Backstage', tipos: ['accion-backstage'] },
    { nombre: 'Sistemas', tipos: ['sistema'] },
    { nombre: 'Fricción y emoción', tipos: ['friccion', 'emocion', 'oportunidad'] },
  ];

  return {
    pasos,
    carriles: definicion.map(({ nombre, tipos }) => ({
      nombre,
      porPaso: Object.fromEntries(pasos.map((p) => [p.id, relacionados(p.id, tipos)])),
    })),
  };
}
