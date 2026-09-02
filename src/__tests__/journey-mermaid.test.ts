import { describe, expect, it } from 'vitest';
import {
  carrilesDeJourney,
  mermaidDeJourney,
  validarJourney,
} from '@/lib/journey/journey.mermaid';
import type { AristaDeJourney, JourneyCompleto, NodoDeJourney } from '@/lib/journey/journey.schemas';

/**
 * El render y la validación son funciones puras sobre la proyección del grafo: se
 * prueban caso por caso sin base de datos, que es justamente lo que hace verificable el
 * criterio de aceptación 1 (el Mermaid es un derivado, no una fuente).
 */

let siguiente = 0;
function id(): string {
  siguiente += 1;
  return `00000000-0000-4000-8000-${String(siguiente).padStart(12, '0')}`;
}

function nodo(parcial: Partial<NodoDeJourney> & Pick<NodoDeJourney, 'tipo' | 'etiqueta'>): NodoDeJourney {
  return {
    id: id(),
    detalle: '',
    catalogoId: null,
    faseId: null,
    orden: 0,
    responsable: '',
    evidencias: [],
    ...parcial,
  };
}

function arista(
  origen: NodoDeJourney,
  destino: NodoDeJourney,
  tipo: AristaDeJourney['tipo'],
  condicion = '',
): AristaDeJourney {
  return { id: id(), origenId: origen.id, destinoId: destino.id, tipo, condicion };
}

function journey(nodos: NodoDeJourney[], aristas: AristaDeJourney[]): JourneyCompleto {
  return {
    id: id(),
    servicioId: id(),
    servicioNombre: 'Apertura de cuenta',
    retoId: null,
    tipo: 'as-is',
    nombre: 'Alta digital',
    descripcion: '',
    nodos,
    aristas,
    snapshots: [],
  };
}

describe('mermaidDeJourney', () => {
  it('agrupa los pasos en el subgrafo de su fase y respeta el orden', () => {
    const fase = nodo({ tipo: 'fase', etiqueta: 'Descubrimiento', orden: 0 });
    const segundo = nodo({ tipo: 'paso', etiqueta: 'Sube el documento', faseId: fase.id, orden: 1 });
    const primero = nodo({ tipo: 'paso', etiqueta: 'Abre la app', faseId: fase.id, orden: 0 });
    const codigo = mermaidDeJourney(journey([fase, segundo, primero], []));

    expect(codigo.startsWith('flowchart TD')).toBe(true);
    expect(codigo).toContain('subgraph');
    // El orden del subgrafo lo fija `orden`, no el orden en que llegaron los nodos.
    expect(codigo.indexOf('Abre la app')).toBeLessThan(codigo.indexOf('Sube el documento'));
    expect(codigo).toContain('end');
  });

  it('dibuja la transición con su condición y el resto de relaciones punteadas', () => {
    const a = nodo({ tipo: 'paso', etiqueta: 'Verifica identidad', orden: 0 });
    const b = nodo({ tipo: 'paso', etiqueta: 'Firma contrato', orden: 1 });
    const sistema = nodo({ tipo: 'sistema', etiqueta: 'Core bancario', orden: 0 });
    const codigo = mermaidDeJourney(
      journey([a, b, sistema], [arista(a, b, 'transicion', 'documento válido'), arista(sistema, a, 'soporta')]),
    );

    expect(codigo).toContain('-->|"documento válido"|');
    expect(codigo).toContain('-.->|"soporta"|');
  });

  it('la pertenencia a la fase la dibuja el subgrafo, no una flecha', () => {
    const fase = nodo({ tipo: 'fase', etiqueta: 'Onboarding', orden: 0 });
    const paso = nodo({ tipo: 'paso', etiqueta: 'Registro', faseId: fase.id, orden: 0 });
    // Sin aristas: el agrupamiento sale de fase_id y de nada más (por eso el tipo
    // «pertenece-a» no existe en la taxonomía: sería el mismo hecho dos veces).
    const codigo = mermaidDeJourney(journey([fase, paso], []));

    expect(codigo).toContain('subgraph');
    expect(codigo).toContain('Registro');
    expect(codigo).not.toContain('-.->');
    expect(codigo).not.toContain('-->');
  });

  it('neutraliza comillas, corchetes y saltos del texto del usuario', () => {
    const paso = nodo({
      tipo: 'paso',
      etiqueta: 'El cliente dice "no [entiendo]"\ny abandona',
      orden: 0,
    });
    const codigo = mermaidDeJourney(journey([paso], []));

    // Ni una comilla doble dentro de la etiqueta rompería el nodo; ni un corchete
    // cerraría la forma antes de tiempo.
    const linea = codigo.split('\n').find((l) => l.includes('El cliente'))!;
    expect(linea).toBe(`  ${linea.trim().split('([')[0]}(["El cliente dice 'no entiendo ' y abandona"])`);
  });

  it('marca la fase vacía en lugar de emitir un subgrafo que rompe el layout', () => {
    const fase = nodo({ tipo: 'fase', etiqueta: 'Post-venta', orden: 0 });
    expect(mermaidDeJourney(journey([fase], []))).toContain('_vacia[" "]');
  });
});

describe('validarJourney', () => {
  it('reporta el paso sin evidencia y el que quedó inalcanzable', () => {
    const a = nodo({ tipo: 'paso', etiqueta: 'Primero', orden: 0, evidencias: [{ id: id(), titulo: 'E1' }] });
    const b = nodo({ tipo: 'paso', etiqueta: 'Suelto', orden: 1 });
    const c = nodo({ tipo: 'paso', etiqueta: 'Último', orden: 2, evidencias: [{ id: id(), titulo: 'E2' }] });
    const senales = validarJourney(journey([a, b, c], [arista(a, c, 'transicion')]));
    const codigos = senales.filter((s) => s.nodoId === b.id).map((s) => s.codigo);

    expect(codigos).toContain('paso-sin-evidencia');
    expect(codigos).toContain('paso-inalcanzable');
    expect(codigos).toContain('paso-sin-salida');
    expect(codigos).toContain('huerfano-de-fase');
  });

  it('el primer paso no necesita entrada ni el último salida', () => {
    const ev = [{ id: id(), titulo: 'E' }];
    const fase = nodo({ tipo: 'fase', etiqueta: 'F', orden: 0 });
    const a = nodo({ tipo: 'paso', etiqueta: 'Inicio', orden: 0, faseId: fase.id, evidencias: ev });
    const b = nodo({ tipo: 'paso', etiqueta: 'Fin', orden: 1, faseId: fase.id, evidencias: ev });
    const senales = validarJourney(journey([fase, a, b], [arista(a, b, 'transicion')]));

    expect(senales).toEqual([]);
  });

  it('primero y último se calculan sobre la secuencia de fases, no por orden global', () => {
    const ev = [{ id: id(), titulo: 'E' }];
    const f1 = nodo({ tipo: 'fase', etiqueta: 'Solicitud', orden: 0 });
    const f2 = nodo({ tipo: 'fase', etiqueta: 'Verificación', orden: 1 });
    // Los `orden` de paso se reinician por fase, que es lo natural al editarlas por
    // separado: sin mirar la fase, «Sube documento» (orden 0) parecería el primero.
    const abre = nodo({ tipo: 'paso', etiqueta: 'Abre', orden: 0, faseId: f1.id, evidencias: ev });
    const datos = nodo({ tipo: 'paso', etiqueta: 'Datos', orden: 1, faseId: f1.id, evidencias: ev });
    const sube = nodo({ tipo: 'paso', etiqueta: 'Sube documento', orden: 0, faseId: f2.id, evidencias: ev });
    const firma = nodo({ tipo: 'paso', etiqueta: 'Firma', orden: 1, faseId: f2.id, evidencias: ev });

    // Se conecta TODO menos la costura entre fases: datos → sube.
    const senales = validarJourney(
      journey(
        [f1, f2, abre, datos, sube, firma],
        [arista(abre, datos, 'transicion'), arista(sube, firma, 'transicion')],
      ),
    );

    // «Sube documento» es primero de su fase pero NO del journey: no se llega hasta él.
    // Y «Firma», que cuelga de él, tampoco — el recorrido propaga la rotura, que es
    // exactamente lo que se quiere ver: la fase 2 entera quedó desconectada.
    expect(
      senales.filter((s) => s.codigo === 'paso-inalcanzable').map((s) => s.nodoId).sort(),
    ).toEqual([sube.id, firma.id].sort());
    // «Datos» es último de su fase pero no del journey: le falta la salida.
    expect(senales.filter((s) => s.codigo === 'paso-sin-salida').map((s) => s.nodoId)).toEqual([
      datos.id,
    ]);
    // El primer paso real del journey no se reporta por ningún lado.
    expect(senales.some((s) => s.nodoId === abre.id)).toBe(false);
  });

  it('un ciclo suelto no se salva por apuntarse a sí mismo: se recorre desde el inicio', () => {
    const ev = [{ id: id(), titulo: 'E' }];
    const fase = nodo({ tipo: 'fase', etiqueta: 'F', orden: 0 });
    const a = nodo({ tipo: 'paso', etiqueta: 'Inicio', orden: 0, faseId: fase.id, evidencias: ev });
    const b = nodo({ tipo: 'paso', etiqueta: 'Fin', orden: 1, faseId: fase.id, evidencias: ev });
    // C y D forman un ciclo desconectado del resto: los dos TIENEN entrada, pero no se
    // llega a ninguno desde el primer paso del journey.
    const c = nodo({ tipo: 'paso', etiqueta: 'Isla C', orden: 2, faseId: fase.id, evidencias: ev });
    const d = nodo({ tipo: 'paso', etiqueta: 'Isla D', orden: 3, faseId: fase.id, evidencias: ev });
    const senales = validarJourney(
      journey(
        [fase, a, b, c, d],
        [arista(a, b, 'transicion'), arista(c, d, 'transicion'), arista(d, c, 'transicion')],
      ),
    );

    const inalcanzables = senales.filter((s) => s.codigo === 'paso-inalcanzable').map((s) => s.nodoId);
    expect(inalcanzables.sort()).toEqual([c.id, d.id].sort());
    // Y el mensaje distingue el caso: tienen entrada, pero no camino.
    expect(senales.find((s) => s.nodoId === c.id && s.codigo === 'paso-inalcanzable')!.mensaje)
      .toContain('no se llega hasta él desde el inicio');
  });

  it('una bifurcación puede terminar en varios desenlaces sin señal falsa', () => {
    const ev = [{ id: id(), titulo: 'E' }];
    const fase = nodo({ tipo: 'fase', etiqueta: 'F', orden: 0 });
    const a = nodo({ tipo: 'paso', etiqueta: 'Verifica', orden: 0, faseId: fase.id, evidencias: ev });
    const b = nodo({ tipo: 'paso', etiqueta: 'Aprobado', orden: 1, faseId: fase.id, evidencias: ev });
    const c = nodo({ tipo: 'paso', etiqueta: 'Rechazado', orden: 2, faseId: fase.id, evidencias: ev });
    // A bifurca: B y C son los dos desenlaces legítimos de la rama. Antes, solo el
    // último por secuencia quedaba exento y el otro salía como «sin salida».
    const senales = validarJourney(
      journey(
        [fase, a, b, c],
        [arista(a, b, 'transicion', 'documento válido'), arista(a, c, 'transicion', 'documento inválido')],
      ),
    );

    expect(senales).toEqual([]);
  });

  it('un journey que empieza bifurcando desde una decisión recorre las dos ramas', () => {
    const ev = [{ id: id(), titulo: 'E' }];
    const fase = nodo({ tipo: 'fase', etiqueta: 'F', orden: 0 });
    // La decisión es la entrada: `transicion` admite decisión→paso, así que un journey
    // puede empezar bifurcando. Anclar el recorrido en «el primer paso» dejaría la otra
    // rama marcada como inalcanzable y no miraría siquiera la decisión de entrada.
    const d = nodo({ tipo: 'decision', etiqueta: '¿Tiene certificado?', orden: 0, faseId: fase.id });
    const a = nodo({ tipo: 'paso', etiqueta: 'Vía digital', orden: 0, faseId: fase.id, evidencias: ev });
    const b = nodo({ tipo: 'paso', etiqueta: 'Vía presencial', orden: 1, faseId: fase.id, evidencias: ev });
    const senales = validarJourney(
      journey([fase, d, a, b], [arista(d, a, 'transicion', 'sí'), arista(d, b, 'transicion', 'no')]),
    );

    expect(senales).toEqual([]);
  });

  it('la acción frontstage sin soporte backstage es señal alta', () => {
    const accion = nodo({
      tipo: 'accion-frontstage',
      etiqueta: 'Muestra el saldo',
      orden: 0,
      responsable: 'App',
    });
    const senales = validarJourney(journey([accion], []));

    expect(senales.map((s) => s.codigo)).toEqual(['frontstage-sin-soporte']);
    expect(senales[0]!.severidad).toBe('alta');
  });

  it('exige responsable donde alguien ejecuta, no en lo que se siente', () => {
    const backstage = nodo({ tipo: 'accion-backstage', etiqueta: 'Valida contra buró', orden: 0 });
    const friccion = nodo({ tipo: 'friccion', etiqueta: 'Espera de 3 días', orden: 0 });
    const senales = validarJourney(journey([backstage, friccion], []));

    expect(senales.map((s) => s.nodoId)).toEqual([backstage.id]);
    expect(senales[0]!.codigo).toBe('sin-responsable');
  });
});

describe('carrilesDeJourney', () => {
  it('ordena las columnas por fase antes que por orden, igual que la validación', () => {
    const f1 = nodo({ tipo: 'fase', etiqueta: 'Solicitud', orden: 0 });
    const f2 = nodo({ tipo: 'fase', etiqueta: 'Verificación', orden: 1 });
    const p1 = nodo({ tipo: 'paso', etiqueta: 'Abre', orden: 0, faseId: f1.id });
    const p2 = nodo({ tipo: 'paso', etiqueta: 'Datos', orden: 1, faseId: f1.id });
    const p3 = nodo({ tipo: 'paso', etiqueta: 'Sube', orden: 0, faseId: f2.id });
    // Con `orden` reiniciado por fase, ordenar solo por él intercalaría Abre/Sube/Datos.
    const b = carrilesDeJourney(journey([f1, f2, p1, p2, p3], []));
    expect(b.pasos.map((p) => p.etiqueta)).toEqual(['Abre', 'Datos', 'Sube']);
  });

  it('alinea cada carril por paso siguiendo la adyacencia en cualquier dirección', () => {
    const paso = nodo({ tipo: 'paso', etiqueta: 'Verifica identidad', orden: 0 });
    const sistema = nodo({ tipo: 'sistema', etiqueta: 'Core bancario', orden: 0 });
    const canal = nodo({ tipo: 'canal', etiqueta: 'App móvil', orden: 0 });
    const dolor = nodo({ tipo: 'friccion', etiqueta: 'Rechazo sin motivo', orden: 0 });
    const blueprint = carrilesDeJourney(
      journey(
        [paso, sistema, canal, dolor],
        [
          // El sistema apunta al paso; el paso apunta al canal. El blueprint no
          // distingue dirección: lo que importa es qué toca a qué.
          arista(sistema, paso, 'soporta'),
          arista(paso, canal, 'ocurre-en'),
          arista(dolor, paso, 'duele'),
        ],
      ),
    );

    const porNombre = Object.fromEntries(blueprint.carriles.map((c) => [c.nombre, c.porPaso[paso.id]!]));
    expect(porNombre['Sistemas']!.map((n) => n.etiqueta)).toEqual(['Core bancario']);
    expect(porNombre['Evidencia física']!.map((n) => n.etiqueta)).toEqual(['App móvil']);
    expect(porNombre['Fricción y emoción']!.map((n) => n.etiqueta)).toEqual(['Rechazo sin motivo']);
    expect(porNombre['Backstage']).toEqual([]);
  });

  it('sin pasos no hay columnas: el blueprint se ordena por pasos', () => {
    const sistema = nodo({ tipo: 'sistema', etiqueta: 'CRM', orden: 0 });
    expect(carrilesDeJourney(journey([sistema], [])).pasos).toEqual([]);
  });
});
