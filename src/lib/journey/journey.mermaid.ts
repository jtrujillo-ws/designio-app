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

/**
 * La secuencia real del journey: las fases se suceden en su orden y los pasos dentro de
 * cada una en el suyo. Los pasos sin fase van al final (la validación ya los reporta).
 *
 * La usan la validación Y el blueprint: si cada una ordenara a su manera, las columnas
 * del blueprint y las señales hablarían de journeys distintos.
 */
function porSecuencia(journey: JourneyCompleto, nodos: NodoDeJourney[]): NodoDeJourney[] {
  const ordenDeFase = new Map(
    journey.nodos.filter((n) => n.tipo === 'fase').map((f) => [f.id, f.orden]),
  );
  const deFase = (n: NodoDeJourney): number =>
    n.faseId === null ? Number.MAX_SAFE_INTEGER : (ordenDeFase.get(n.faseId) ?? Number.MAX_SAFE_INTEGER);
  return [...nodos].sort((a, b) => {
    const fa = deFase(a);
    const fb = deFase(b);
    return fa !== fb ? fa - fb : a.orden !== b.orden ? a.orden - b.orden : a.id.localeCompare(b.id);
  });
}

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

  for (const n of porSecuencia(journey, sueltos)) {
    const [a, b] = FORMA[n.tipo];
    lineas.push(`  ${idMermaid(n.id)}${a}"${texto(n.etiqueta)}"${b}`);
  }

  for (const arista of journey.aristas) {
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
  const transiciones = journey.aristas.filter((a) => a.tipo === 'transicion');
  const conEntrada = new Set(transiciones.map((a) => a.destinoId));
  const conSalida = new Set(transiciones.map((a) => a.origenId));

  // Solo el PRIMER paso de la secuencia puede no tener entrada, y solo el último puede
  // no tener salida — el primer paso de la fase 2 sí necesita que algo de la fase 1
  // lleve hasta él, que es la costura que más se rompe.
  const pasos = journey.nodos.filter((n) => n.tipo === 'paso');
  const secuencia = porSecuencia(journey, pasos);
  const primeroId = secuencia[0]?.id ?? null;
  const ultimoId = secuencia[secuencia.length - 1]?.id ?? null;

  // La ENTRADA del recorrido no es «el primer paso» a secas: una transición también
  // puede salir de una decisión, así que un journey puede empezar bifurcando y anclar en
  // el primer paso dejaría la otra rama marcada como inalcanzable.
  //
  // Pero la entrada es UNA: un journey tiene un principio. Se toma el primero de la
  // secuencia entre los nodos transitables sin transición de entrada — así una decisión
  // que abre el journey es la entrada, y un paso sin entrada que aparece más adelante
  // sigue siendo lo que es: una costura rota, no un segundo comienzo.
  //
  // Si no hay ninguno (todo el grafo es un ciclo), se ancla en el primer paso.
  const transitables = journey.nodos.filter((n) => n.tipo === 'paso' || n.tipo === 'decision');
  const candidatas = porSecuencia(
    journey,
    transitables.filter((n) => conSalida.has(n.id) && !conEntrada.has(n.id)),
  );
  const entrada = candidatas[0]?.id ?? primeroId;

  // Alcanzable = se LLEGA desde el inicio siguiendo transiciones, no «alguien me apunta».
  // Un ciclo suelto C→D→C se apunta a sí mismo y quedaría exculpado con lo segundo,
  // que es precisamente el grafo roto que hay que ver.
  const salidas = new Map<string, string[]>();
  for (const a of transiciones) {
    salidas.set(a.origenId, [...(salidas.get(a.origenId) ?? []), a.destinoId]);
  }
  const alcanzables = new Set<string>();
  // Además de si se llega, se recuerda si se llegó PASANDO POR UNA BIFURCACIÓN: un paso
  // al que solo se llega tras una bifurcación es un desenlace legítimo de esa rama y no
  // le falta salida. Sin esto, un `A → B` y `A → C` con dos finales reporta uno de los
  // dos como roto, que es un journey perfectamente normal.
  const trasBifurcacion = new Set<string>();
  const pendientes: { id: string; bifurcado: boolean }[] = entrada
    ? [{ id: entrada, bifurcado: false }]
    : [];
  while (pendientes.length > 0) {
    const { id: actual, bifurcado } = pendientes.pop()!;
    const yaVisto = alcanzables.has(actual);
    // Se revisita solo si aporta información nueva (llegar tras una bifurcación cuando
    // antes no se había llegado así): el recorrido termina igual.
    if (yaVisto && (!bifurcado || trasBifurcacion.has(actual))) continue;
    alcanzables.add(actual);
    if (bifurcado) trasBifurcacion.add(actual);
    const siguientes = salidas.get(actual) ?? [];
    for (const siguiente of siguientes) {
      pendientes.push({ id: siguiente, bifurcado: bifurcado || siguientes.length > 1 });
    }
  }

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
    if (!alcanzables.has(paso.id)) {
      senales.push({
        codigo: 'paso-inalcanzable',
        severidad: 'alta',
        nodoId: paso.id,
        etiqueta: paso.etiqueta,
        mensaje: conEntrada.has(paso.id)
          ? 'Tiene transiciones de entrada, pero no se llega hasta él desde el inicio'
          : 'Ninguna transición llega a este paso: es inalcanzable',
      });
    }
    // No necesitan salida ni el último de la secuencia ni los desenlaces de una
    // bifurcación: el journey termina en algún lado, y con ramas termina en varios.
    if (!conSalida.has(paso.id) && paso.id !== ultimoId && !trasBifurcacion.has(paso.id)) {
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
  // Misma secuencia que usa la validación: si el blueprint ordenara solo por `orden`,
  // dos fases numeradas desde cero intercalarían sus columnas y las tres vistas
  // dejarían de hablar del mismo journey.
  const pasos = porSecuencia(journey, journey.nodos.filter((n) => n.tipo === 'paso'));
  const porId = new Map(journey.nodos.map((n) => [n.id, n]));

  // Adyacencia no dirigida: en el blueprint importa que dos cosas se toquen, no quién
  // apuntó a quién (`actor -participa-> acción` y `acción -ocurre-en-> paso` describen la
  // misma columna aunque las flechas vayan en sentidos distintos).
  const vecindad = new Map<string, string[]>();
  function unir(a: string, b: string) {
    vecindad.set(a, [...(vecindad.get(a) ?? []), b]);
  }
  for (const a of journey.aristas) {
    unir(a.origenId, a.destinoId);
    unir(a.destinoId, a.origenId);
  }

  const ACCIONES: TipoNodo[] = ['accion-frontstage', 'accion-backstage'];

  /**
   * Nodos de un tipo que le corresponden a un paso: los adyacentes al paso Y los
   * adyacentes a sus acciones.
   *
   * El segundo salto no es un adorno: el modelo canónico cuelga los actores de la acción
   * en la que participan y los sistemas de la acción que soportan, no del paso. Con
   * adyacencia de un salto, un actor que `participa` en una acción frontstage del paso no
   * caería en ningún carril y el blueprint mostraría acciones sin nadie que las haga.
   *
   * El salto se detiene en las acciones y nunca aterriza en otro paso o fase: sin ese
   * tope, un `paso → acción → paso` arrastraría la columna vecina entera y los carriles
   * dejarían de distinguir un paso de otro.
   */
  function relacionados(pasoId: string, tipos: TipoNodo[]): NodoDeJourney[] {
    const vecinos: NodoDeJourney[] = [];
    const agregar = (id: string) => {
      const nodo = porId.get(id);
      if (nodo && tipos.includes(nodo.tipo) && !vecinos.some((v) => v.id === nodo.id)) {
        vecinos.push(nodo);
      }
    };
    const directos = vecindad.get(pasoId) ?? [];
    for (const id of directos) agregar(id);
    for (const id of directos) {
      const intermedio = porId.get(id);
      if (!intermedio || !ACCIONES.includes(intermedio.tipo)) continue;
      for (const lejano of vecindad.get(id) ?? []) {
        const nodo = porId.get(lejano);
        if (!nodo || nodo.tipo === 'paso' || nodo.tipo === 'fase') continue;
        agregar(lejano);
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
