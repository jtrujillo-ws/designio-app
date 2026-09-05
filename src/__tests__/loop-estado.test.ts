import { describe, expect, it } from 'vitest';
import { estadoDelLoop, loopDeProyecto, marcaDeReto } from '@/lib/loop/loop-estado';
import type { GatesDeProyecto } from '@/lib/loop/loop.schemas';

/**
 * El estado del loop J1–J7 ya no se declara a mano: se deriva de los gates del proyecto.
 * Estas son las reglas que la pantalla pinta, recorridas enteras sin base ni framework.
 */
describe('el estado del loop se deriva de los gates', () => {
  it('sin evidencia ni gates, el arranque en frío es lo que está en curso', () => {
    const loop = estadoDelLoop({
      hayEvidencia: false,
      gatesAprobados: [],
      reviewCompletado: false,
    });
    expect(loop.journeys[1]).toBe('en curso');
    expect(loop.journeys[2]).toBe('próximo');
    expect(loop.enCurso).toBe(1);
    expect(loop.gateAbierto).toBe(0);
    expect(loop.cerrados).toBe(0);
  });

  it('con evidencia curada y ningún gate, se está formulando el reto (J2, G0 abierto)', () => {
    const loop = estadoDelLoop({ hayEvidencia: true, gatesAprobados: [], reviewCompletado: false });
    expect(loop.journeys[1]).toBe('hecho');
    expect(loop.journeys[2]).toBe('en curso');
    expect(loop.enCurso).toBe(2);
    expect(loop.gateAbierto).toBe(0);
    expect(loop.cerrados).toBe(1);
  });

  it('cada journey cubre sus gates: J3 necesita G1 y G2, no solo G1', () => {
    const conG1 = estadoDelLoop({
      hayEvidencia: true,
      gatesAprobados: [0, 1],
      reviewCompletado: false,
    });
    expect(conG1.journeys[3]).toBe('en curso');
    expect(conG1.gateAbierto).toBe(2);
    const conG2 = estadoDelLoop({
      hayEvidencia: true,
      gatesAprobados: [0, 1, 2],
      reviewCompletado: false,
    });
    expect(conG2.journeys[3]).toBe('hecho');
    expect(conG2.journeys[4]).toBe('en curso');
    expect(conG2.gateAbierto).toBe(3);
  });

  it('con G7 aprobado se está en el post mortem (J7) hasta que el review se complete', () => {
    const midiendo = estadoDelLoop({
      hayEvidencia: true,
      gatesAprobados: [0, 1, 2, 3, 4, 5, 6, 7],
      reviewCompletado: false,
    });
    expect(midiendo.journeys[6]).toBe('hecho');
    expect(midiendo.journeys[7]).toBe('en curso');
    expect(midiendo.enCurso).toBe(7);
    expect(midiendo.gateAbierto).toBeNull();
    expect(midiendo.cerrados).toBe(6);

    const cerrado = estadoDelLoop({
      hayEvidencia: true,
      gatesAprobados: [0, 1, 2, 3, 4, 5, 6, 7],
      reviewCompletado: true,
    });
    expect(cerrado.enCurso).toBeNull();
    expect(cerrado.cerrados).toBe(7);
    expect(Object.values(cerrado.journeys).every((e) => e === 'hecho')).toBe(true);
  });

  it('un journey no se da por hecho por delante de otro sin hacer: el primer hueco manda', () => {
    // Un G7 aprobado con G0 pendiente no puede existir en la base (los gates ordenan el
    // método), pero la derivación no se apoya en eso: el primer journey no hecho es el que
    // está en curso y todo lo posterior es próximo, esté como esté.
    const loop = estadoDelLoop({
      hayEvidencia: true,
      gatesAprobados: [7],
      reviewCompletado: false,
    });
    expect(loop.journeys[2]).toBe('en curso');
    expect(loop.journeys[6]).toBe('próximo');
    expect(loop.gateAbierto).toBe(0);
  });

  it('sin evidencia pero con gates aprobados, el arranque se da por hecho: sin él no hay G0', () => {
    // Checklists decididos enteros por N/A, o un proyecto heredado: no hay `evidencia` y sin
    // esta regla la pantalla decía «J1 en curso» con «gate abierto G5» al lado.
    const loop = estadoDelLoop({
      hayEvidencia: false,
      gatesAprobados: [0, 1, 2, 3, 4],
      reviewCompletado: false,
    });
    expect(loop.journeys[1]).toBe('hecho');
    expect(loop.journeys[5]).toBe('en curso');
    expect(loop.gateAbierto).toBe(5);
    expect(loop.cerrados).toBe(4);
  });

  it('un servicio sin proyecto solo puede tener J1 hecho', () => {
    expect(loopDeProyecto(null, true).enCurso).toBe(2);
    expect(loopDeProyecto(null, false).enCurso).toBe(1);
  });
});

describe('la marca de un reto en el árbol', () => {
  const proyectos = new Map<string, GatesDeProyecto>([
    [
      'p-6',
      {
        proyectoId: 'p-6',
        proyectoCodigo: 'P-01',
        retoId: 'r-1',
        retoCodigo: 'R-01',
        servicioId: 's-1',
        aprobados: [0, 1, 2, 3, 4, 5, 6],
        reviewCompletado: false,
      },
    ],
    [
      'p-cerrado',
      {
        proyectoId: 'p-cerrado',
        proyectoCodigo: 'P-09',
        retoId: 'r-9',
        retoCodigo: 'R-09',
        servicioId: 's-1',
        aprobados: [0, 1, 2, 3, 4, 5, 6, 7],
        reviewCompletado: true,
      },
    ],
  ]);
  const proyecto = (id: string) => ({ id, codigo: 'P', titulo: 'p', estado: 'activo' });

  it('un reto con proyecto está donde está su proyecto', () => {
    expect(
      marcaDeReto(
        { estado: 'activo', origen: null, proyectos: [proyecto('p-6')] },
        proyectos,
        true,
      ),
    ).toEqual({
      j: 6,
      punteado: false,
      sufijo: 'J6',
    });
  });

  it('un reto cuyo ciclo cerró lo dice, con el color del post mortem', () => {
    expect(
      marcaDeReto(
        { estado: 'cerrado', origen: null, proyectos: [proyecto('p-cerrado')] },
        proyectos,
        true,
      ),
    ).toEqual({ j: 7, punteado: false, sufijo: 'cerrado' });
  });

  it('un candidato del post mortem aún no existe formalmente: punteado en J7', () => {
    expect(
      marcaDeReto({ estado: 'candidato', origen: 'post-mortem', proyectos: [] }, proyectos, true),
    ).toEqual({
      j: 7,
      punteado: true,
      sufijo: '—',
    });
  });

  it('un reto sin proyecto (activo, o candidato de otro origen) se está formulando: J2', () => {
    expect(
      marcaDeReto({ estado: 'activo', origen: 'peticion-cliente', proyectos: [] }, proyectos, true)
        .j,
    ).toBe(2);
    expect(
      marcaDeReto(
        { estado: 'candidato', origen: 'peticion-cliente', proyectos: [] },
        proyectos,
        true,
      ),
    ).toEqual({
      j: 2,
      punteado: false,
      sufijo: 'J2',
    });
  });

  it('un proyecto que el resumen no conoce (aún no cargado) no inventa un journey', () => {
    // Sin gates a la vista se cae al mismo caso que «sin proyecto»: se está formulando.
    expect(
      marcaDeReto(
        { estado: 'activo', origen: null, proyectos: [proyecto('p-desconocido')] },
        proyectos,
        true,
      ).j,
    ).toBe(2);
  });
});
