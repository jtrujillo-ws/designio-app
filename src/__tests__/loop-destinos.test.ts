import { describe, expect, it } from 'vitest';
import { JOURNEYS_DEL_LOOP, destinoDeJourney, journeyDelLoop } from '@/lib/loop/loop-data';
import { etiquetaDeDestino } from '@/lib/destinos';

/**
 * Las tarjetas del loop nacieron como `div` sin enlace: nada de lo que se veía permitía
 * entrar ni revisar. Cada journey declara ahora la pantalla donde se trabaja, y la única que
 * necesita un id (la del proyecto) se resuelve con el árbol delante o se queda sin destino.
 */
describe('a dónde abre cada tarjeta del loop', () => {
  it('todos los journeys declaran una pantalla', () => {
    expect(JOURNEYS_DEL_LOOP.map((jl) => jl.pantalla)).toEqual([
      'importacion',
      'proyecto',
      'insights',
      'proyecto',
      'design-versions',
      'design-versions',
      'proyecto',
    ]);
  });

  it('el catálogo se resuelve por número, no por posición', () => {
    for (const jl of JOURNEYS_DEL_LOOP) expect(journeyDelLoop(jl.j)).toBe(jl);
    expect(journeyDelLoop(6).titulo).toBe('Implementación y medición');
  });

  it('las pantallas sin parámetros abren siempre, haya o no proyecto', () => {
    expect(destinoDeJourney('importacion', null)).toEqual({ to: '/importacion' });
    expect(destinoDeJourney('insights', null)).toEqual({ to: '/insights' });
    expect(destinoDeJourney('design-versions', null)).toEqual({ to: '/design-versions' });
  });

  it('la del proyecto lleva el id del proyecto actual', () => {
    expect(destinoDeJourney('proyecto', 'p-1')).toEqual({
      to: '/proyecto/$proyectoId',
      params: { proyectoId: 'p-1' },
    });
  });

  it('y sin proyecto no hay destino: la tarjeta lo dice en vez de fingir un enlace', () => {
    expect(destinoDeJourney('proyecto', null)).toBeNull();
  });

  it('el pie de la tarjeta nombra la pantalla, y el proyecto por su código real', () => {
    expect(etiquetaDeDestino({ to: '/importacion' })).toBe('Bandeja de importación');
    expect(
      etiquetaDeDestino({ to: '/proyecto/$proyectoId', params: { proyectoId: 'p-1' } }, 'P-01'),
    ).toBe('Proyecto P-01');
    expect(etiquetaDeDestino({ to: '/proyecto/$proyectoId', params: { proyectoId: 'p-1' } })).toBe(
      'Proyecto',
    );
  });
});
