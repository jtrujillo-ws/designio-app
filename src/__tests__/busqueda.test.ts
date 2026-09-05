import { describe, expect, it } from 'vitest';
import {
  BusquedaInputSchema,
  conDestino,
  destinoDeResultado,
  patronDeBusqueda,
  type FilaBusqueda,
} from '@/lib/busqueda/busqueda.schemas';

const fila = (parcial: Partial<FilaBusqueda> & Pick<FilaBusqueda, 'clase'>): FilaBusqueda => ({
  id: 'id-1',
  codigo: null,
  titulo: 'Algo',
  detalle: '',
  refId: null,
  ...parcial,
});

describe('el patrón de búsqueda', () => {
  it('busca dentro del texto, sin distinguir dónde empieza', () => {
    expect(patronDeBusqueda('nómina')).toBe('%nómina%');
  });

  it('recorta espacios: «  P-01 » es P-01', () => {
    expect(patronDeBusqueda('  P-01 ')).toBe('%P-01%');
  });

  it('escapa los comodines de LIKE: quien escribe «100%» busca eso', () => {
    expect(patronDeBusqueda('100%')).toBe('%100\\%%');
    expect(patronDeBusqueda('a_b')).toBe('%a\\_b%');
    expect(patronDeBusqueda('c\\d')).toBe('%c\\\\d%');
  });
});

describe('lo que el buscador acepta', () => {
  const ws = '11111111-1111-4111-8111-111111111111';

  it('exige al menos dos caracteres, ya sin espacios alrededor', () => {
    expect(BusquedaInputSchema.safeParse({ workspaceId: ws, texto: ' a ' }).success).toBe(false);
    expect(BusquedaInputSchema.safeParse({ workspaceId: ws, texto: ' ab ' }).success).toBe(true);
  });

  it('y no más de cien', () => {
    expect(BusquedaInputSchema.safeParse({ workspaceId: ws, texto: 'x'.repeat(101) }).success).toBe(
      false,
    );
  });
});

describe('a dónde abre cada resultado', () => {
  it('lo que tiene pantalla propia abre su pantalla', () => {
    expect(destinoDeResultado(fila({ clase: 'proyecto', id: 'p' }))).toEqual({
      to: '/proyecto/$proyectoId',
      params: { proyectoId: 'p' },
    });
    expect(destinoDeResultado(fila({ clase: 'journey', id: 'j' }))).toEqual({
      to: '/journey/$journeyId',
      params: { journeyId: 'j' },
    });
    expect(destinoDeResultado(fila({ clase: 'design-version', id: 'd' }))).toEqual({
      to: '/design-version/$designVersionId',
      params: { designVersionId: 'd' },
    });
  });

  it('un reto abre su proyecto si lo tiene, y el árbol del loop si no', () => {
    expect(destinoDeResultado(fila({ clase: 'reto', id: 'r', refId: 'p' }))).toEqual({
      to: '/proyecto/$proyectoId',
      params: { proyectoId: 'p' },
    });
    expect(destinoDeResultado(fila({ clase: 'reto', id: 'r' }))).toEqual({ to: '/app' });
  });

  it('servicio, evidencia e insight abren donde se leen', () => {
    expect(destinoDeResultado(fila({ clase: 'servicio' }))).toEqual({ to: '/app' });
    expect(destinoDeResultado(fila({ clase: 'evidencia' }))).toEqual({ to: '/evidencia' });
    expect(destinoDeResultado(fila({ clase: 'insight' }))).toEqual({ to: '/insights' });
  });

  it('conDestino conserva la fila y le añade el destino', () => {
    const [r] = conDestino([fila({ clase: 'proyecto', id: 'p', codigo: 'P-01' })]);
    expect(r).toMatchObject({
      clase: 'proyecto',
      codigo: 'P-01',
      destino: { to: '/proyecto/$proyectoId' },
    });
  });
});
