import { describe, expect, it } from 'vitest';
import {
  calcularDiff,
  conciliacionCompleta,
  elementosEnEstadoDesconocido,
} from '@/lib/entrega/entrega.diff';
import type {
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
    orden: 0,
    decisiones: [],
    insights: [],
    ...p,
  };
}

const vigente = (elementos: EstadoEfectivoVigente extends null ? never : NonNullable<EstadoEfectivoVigente>['elementos']): EstadoEfectivoVigente => ({
  id: 'es-1',
  codigo: 'ES-1',
  constatadoEn: '2026-08-20',
  designVersionCodigo: 'DV-1',
  elementos,
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
        { elementoId: 'viejo', titulo: 'Verificación en video', nodoId: 'n1', resultado: 'como-aprobado' },
      ]),
    );
    expect(d.filas[0]!.veredicto).toBe('modifica');
    expect(d.filas[0]!.precedente?.elementoId).toBe('viejo');
    expect(d.filas[0]!.senal).toBeNull();
  });

  it('sin nodo, empareja por título normalizado (acentos, mayúsculas y espacios)', () => {
    const d = calcularDiff(
      [elemento({ id: 'a', titulo: '  Video-VERIFICACIÓN   asistida ', operacion: 'modifica' })],
      vigente([
        { elementoId: 'viejo', titulo: 'video-verificacion asistida', nodoId: null, resultado: 'desviado' },
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
      vigente([
        { elementoId: 'viejo', titulo: 'Ya existe', nodoId: null, resultado: 'como-aprobado' },
      ]),
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
        {
          elementoId: 'viejo',
          titulo: 'Integración en línea',
          nodoId: null,
          resultado: 'no-implementado',
        },
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
        { elementoId: 'v1', titulo: 'Cambia esto', nodoId: null, resultado: 'como-aprobado' },
        { elementoId: 'v2', titulo: 'Sigue igual', nodoId: null, resultado: 'desviado' },
      ]),
    );
    expect(d.seMantiene.map((s) => s.elementoId)).toEqual(['v2']);
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
