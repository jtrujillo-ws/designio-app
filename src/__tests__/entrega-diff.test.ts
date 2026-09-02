import { describe, expect, it } from 'vitest';
import {
  calcularDiff,
  conciliacionCompleta,
  elementosEnEstadoDesconocido,
  plegarEstadoVigente,
} from '@/lib/entrega/entrega.diff';
import type {
  ConstatacionDelServicio,
  ElementoDeCambio,
  EstadoEfectivoVigente,
  FilaConciliacion,
} from '@/lib/entrega/entrega.schemas';

/**
 * El diff (RF-06.2) y la regla de conciliación (RF-06.7) como funciones puras: se
 * prueban sin base porque no la necesitan — es justamente la propiedad que se busca al
 * NO almacenar el diff.
 */

function elemento(p: Partial<ElementoDeCambio> & { id: string; titulo: string }): ElementoDeCambio {
  return {
    tipo: 'touchpoint',
    operacion: 'agrega',
    detalle: '',
    nodoId: null,
    nodoEtiqueta: null,
    catalogoId: null,
    orden: 0,
    decisiones: [],
    insights: [],
    ...p,
  };
}

/** Una constatación de la historia del servicio. `operacion` por defecto 'agrega': lo
 * habitual es que un elemento constatado sea algo que se puso, no que se quitó. */
function constatado(
  p: Partial<ConstatacionDelServicio> & { elementoId: string; titulo: string },
): ConstatacionDelServicio {
  return {
    nodoId: null,
    catalogoId: null,
    operacion: 'agrega',
    resultado: 'como-aprobado',
    ...p,
  };
}

const vigente = (constataciones: ConstatacionDelServicio[]): EstadoEfectivoVigente => ({
  id: 'es-1',
  codigo: 'ES-1',
  constatadoEn: '2026-08-20',
  designVersionCodigo: 'DV-1',
  constataciones,
});

function fila(p: Partial<FilaConciliacion> & { elementoId: string }): FilaConciliacion {
  return {
    elementoTitulo: 'Elemento',
    tipo: 'touchpoint',
    operacion: 'agrega',
    estado: 'aprobado',
    releaseCodigo: null,
    releaseResponsable: null,
    releaseFecha: null,
    razonAsignacion: '',
    queQuedoDistinto: '',
    razonDesviacion: '',
    ...p,
  };
}

describe('diff contra el effective state vigente', () => {
  it('sin estado efectivo vigente, todo elemento es un alta y se dice contra qué se calculó', () => {
    const d = calcularDiff([elemento({ id: 'a', titulo: 'Video-verificación' })], null);
    expect(d.contra).toBeNull();
    expect(d.filas[0]!.veredicto).toBe('agrega');
    expect(d.totales).toMatchObject({ agrega: 1, modifica: 0, retira: 0 });
  });

  it('empareja por NODO del grafo aunque el título haya cambiado', () => {
    const d = calcularDiff(
      [elemento({ id: 'a', titulo: 'Verificación en vídeo (v2)', nodoId: 'n1', operacion: 'modifica' })],
      vigente([
        constatado({ elementoId: 'viejo', titulo: 'Verificación en video', nodoId: 'n1' }),
      ]),
    );
    expect(d.filas[0]!.veredicto).toBe('modifica');
    expect(d.filas[0]!.precedente?.elementoId).toBe('viejo');
    expect(d.filas[0]!.senal).toBeNull();
  });

  it('empareja por CATÁLOGO aunque el nodo sea otro: el journey del ciclo nuevo no rompe la identidad', () => {
    // El to-be del ciclo siguiente puede ser otro grafo, con otros nodos. Lo que no
    // cambia es el touchpoint del catálogo del servicio (SPEC-05): es la identidad.
    const d = calcularDiff(
      [
        elemento({
          id: 'a',
          titulo: 'Video-verificación asistida',
          nodoId: 'n2',
          catalogoId: 'cat-video',
          operacion: 'modifica',
        }),
      ],
      vigente([
        constatado({
          elementoId: 'viejo',
          titulo: 'Video-verificación',
          nodoId: 'n1',
          catalogoId: 'cat-video',
        }),
      ]),
    );
    expect(d.filas[0]!.veredicto).toBe('modifica');
    expect(d.filas[0]!.precedente?.elementoId).toBe('viejo');
    expect(d.seMantiene).toEqual([]);
  });

  it('sin nodo, empareja por título normalizado (acentos, mayúsculas y espacios)', () => {
    const d = calcularDiff(
      [elemento({ id: 'a', titulo: '  Video-VERIFICACIÓN   asistida ', operacion: 'modifica' })],
      vigente([
        constatado({
          elementoId: 'viejo',
          titulo: 'video-verificacion asistida',
          resultado: 'desviado',
        }),
      ]),
    );
    expect(d.filas[0]!.precedente?.elementoId).toBe('viejo');
  });

  it('señala la declaración que no cuadra con lo vigente, sin bloquear (I2)', () => {
    const d = calcularDiff(
      [
        elemento({ id: 'a', titulo: 'Ya existe', operacion: 'agrega' }),
        elemento({ id: 'b', titulo: 'No existe', operacion: 'modifica' }),
        elemento({ id: 'c', titulo: 'Tampoco existe', operacion: 'retira' }),
      ],
      vigente([constatado({ elementoId: 'viejo', titulo: 'Ya existe' })]),
    );
    expect(d.filas[0]!.veredicto).toBe('modifica');
    expect(d.filas[0]!.senal).toMatch(/ya lo tiene constatado/);
    expect(d.filas[1]!.veredicto).toBe('agrega');
    expect(d.filas[1]!.senal).toMatch(/nada vigente que modificar/);
    expect(d.filas[2]!.veredicto).toBe('retira');
    expect(d.filas[2]!.senal).toMatch(/no tiene este elemento/);
    expect(d.totales.senales).toBe(3);
  });

  it('lo constatado como NO implementado no cuenta como precedente', () => {
    const d = calcularDiff(
      [elemento({ id: 'a', titulo: 'Integración en línea', operacion: 'agrega' })],
      vigente([
        constatado({
          elementoId: 'viejo',
          titulo: 'Integración en línea',
          resultado: 'no-implementado',
        }),
      ]),
    );
    // Nunca llegó a existir: volver a proponerlo es un alta, no una modificación.
    expect(d.filas[0]!.veredicto).toBe('agrega');
    expect(d.filas[0]!.senal).toBeNull();
    expect(d.seMantiene).toEqual([]);
  });

  it('enumera lo que se mantiene: un diff que solo lista cambios es media respuesta', () => {
    const d = calcularDiff(
      [elemento({ id: 'a', titulo: 'Cambia esto', operacion: 'modifica' })],
      vigente([
        constatado({ elementoId: 'v1', titulo: 'Cambia esto' }),
        constatado({ elementoId: 'v2', titulo: 'Sigue igual', resultado: 'desviado' }),
      ]),
    );
    expect(d.seMantiene.map((s) => s.elementoId)).toEqual(['v2']);
  });
});

/**
 * La historia del servicio trae una fila por VERSIÓN del elemento —cada design version
 * que vuelve a tocar la misma cosa crea un `elemento_cambio` nuevo—, así que el estado
 * vigente es el pliegue de esa historia por identidad lógica, no la historia.
 */
describe('pliegue del estado efectivo vigente por identidad lógica', () => {
  it('gana la constatación MÁS RECIENTE de la identidad, no una fila histórica cualquiera', () => {
    const estado = plegarEstadoVigente([
      constatado({ elementoId: 'v1', titulo: 'Verificación en video', catalogoId: 'cat-video' }),
      constatado({
        elementoId: 'v2',
        titulo: 'Video-verificación asistida',
        catalogoId: 'cat-video',
        operacion: 'modifica',
        resultado: 'desviado',
      }),
    ]);
    expect([...estado.values()]).toEqual([
      expect.objectContaining({ elementoId: 'v2', resultado: 'desviado' }),
    ]);
  });

  it('un retiro constatado como se aprobó SACA el elemento del estado vigente', () => {
    const estado = plegarEstadoVigente([
      constatado({ elementoId: 'v1', titulo: 'Revisión manual del 100%', catalogoId: 'cat-rev' }),
      constatado({
        elementoId: 'v2',
        titulo: 'Revisión manual del 100%',
        catalogoId: 'cat-rev',
        operacion: 'retira',
      }),
    ]);
    expect([...estado.values()]).toEqual([]);
  });

  it('un retiro DESVIADO no borra nada: el estado vigente no afirma una ausencia que nadie constató', () => {
    const estado = plegarEstadoVigente([
      constatado({ elementoId: 'v1', titulo: 'Revisión manual', catalogoId: 'cat-rev' }),
      constatado({
        elementoId: 'v2',
        titulo: 'Revisión manual',
        catalogoId: 'cat-rev',
        operacion: 'retira',
        resultado: 'desviado',
      }),
    ]);
    expect([...estado.values()]).toEqual([
      expect.objectContaining({ elementoId: 'v2', resultado: 'desviado' }),
    ]);
  });

  it('un cambio NO implementado deja el estado como estaba, no lo vacía', () => {
    const estado = plegarEstadoVigente([
      constatado({ elementoId: 'v1', titulo: 'Integración por lote', catalogoId: 'cat-core' }),
      constatado({
        elementoId: 'v2',
        titulo: 'Integración en línea',
        catalogoId: 'cat-core',
        operacion: 'modifica',
        resultado: 'no-implementado',
      }),
    ]);
    expect([...estado.values()]).toEqual([expect.objectContaining({ elementoId: 'v1' })]);
  });

  it('el elemento retirado no reaparece como vigente ni «se mantiene» se repite por ciclo', () => {
    // Dos ciclos anteriores tocaron el mismo touchpoint y un tercero lo retiró; otro
    // elemento lógico siguió vivo todo el rato. El diff de la design version siguiente
    // ve UN elemento vigente, no cuatro filas históricas.
    const d = calcularDiff(
      [elemento({ id: 'nuevo', titulo: 'Algo sin relación', operacion: 'agrega' })],
      vigente([
        constatado({ elementoId: 'v1', titulo: 'Video-verificación', catalogoId: 'cat-video' }),
        constatado({ elementoId: 'v2', titulo: 'Firma en la app', catalogoId: 'cat-firma' }),
        constatado({
          elementoId: 'v3',
          titulo: 'Video-verificación asistida',
          catalogoId: 'cat-video',
          operacion: 'modifica',
        }),
        constatado({
          elementoId: 'v4',
          titulo: 'Video-verificación asistida',
          catalogoId: 'cat-video',
          operacion: 'retira',
        }),
      ]),
    );
    expect(d.seMantiene.map((s) => s.elementoId)).toEqual(['v2']);
    expect(d.filas[0]!.veredicto).toBe('agrega');
  });
});

describe('conciliación (RF-06.7)', () => {
  it('los tres estados sin constatación son DESCONOCIDOS y bloquean', () => {
    const filas = [
      fila({ elementoId: 'a', estado: 'aprobado' }),
      fila({ elementoId: 'b', estado: 'en-release' }),
      fila({ elementoId: 'c', estado: 'desplegado' }),
    ];
    expect(elementosEnEstadoDesconocido(filas).map((f) => f.elementoId)).toEqual(['a', 'b', 'c']);
    expect(conciliacionCompleta(filas)).toBe(false);
  });

  it('«no implementado» es una respuesta honesta, no un hueco: no bloquea', () => {
    const filas = [
      fila({ elementoId: 'a', estado: 'constatado' }),
      fila({ elementoId: 'b', estado: 'desviado' }),
      fila({ elementoId: 'c', estado: 'no-implementado' }),
    ];
    expect(elementosEnEstadoDesconocido(filas)).toEqual([]);
    expect(conciliacionCompleta(filas)).toBe(true);
  });

  it('un tablero vacío no está completo: no hay nada que haya pasado la conciliación', () => {
    expect(conciliacionCompleta([])).toBe(false);
  });
});
