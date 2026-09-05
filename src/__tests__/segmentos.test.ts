import { describe, expect, it } from 'vitest';
import {
  CrearSegmentoSchema,
  EditarSegmentoSchema,
  ROLES_EDITAN_SEGMENTOS,
  conteoPorEstado,
  destinoDeArquetipo,
  nombreYaUsado,
  puedeEditarSegmentos,
  resumenDeCobertura,
  type ArquetipoDeSegmento,
} from '@/lib/segmento/segmento.schemas';

const ws = '11111111-1111-4111-8111-111111111111';
const seg = '22222222-2222-4222-8222-222222222222';

const arquetipo = (parcial: Partial<ArquetipoDeSegmento> = {}): ArquetipoDeSegmento => ({
  id: 'a-1',
  nombre: 'Independiente sin firma digital',
  estado: 'hipotesis',
  retoCodigo: 'R-01',
  proyectoId: 'p-1',
  proyectoCodigo: 'P-01',
  ...parcial,
});

describe('quién define segmentos', () => {
  it('el lead de la boutique y el admin del cliente; los demás roles solo los usan', () => {
    expect(ROLES_EDITAN_SEGMENTOS).toEqual(['lead-boutique', 'admin-cliente']);
    expect(puedeEditarSegmentos('lead-boutique')).toBe(true);
    expect(puedeEditarSegmentos('admin-cliente')).toBe(true);
    expect(puedeEditarSegmentos('disenador')).toBe(false);
    expect(puedeEditarSegmentos('sponsor')).toBe(false);
    expect(puedeEditarSegmentos('')).toBe(false);
  });
});

describe('lo que el alta y la edición aceptan', () => {
  it('recorta el nombre y la definición, y la definición es opcional', () => {
    const r = CrearSegmentoSchema.parse({ workspaceId: ws, nombre: '  pymes ' });
    expect(r).toEqual({ workspaceId: ws, nombre: 'pymes', definicion: '' });
  });

  it('un nombre en blanco no es un nombre', () => {
    expect(CrearSegmentoSchema.safeParse({ workspaceId: ws, nombre: '   ' }).success).toBe(false);
  });

  it('acota nombre y definición: un segmento es un rótulo, no un documento', () => {
    expect(
      CrearSegmentoSchema.safeParse({ workspaceId: ws, nombre: 'x'.repeat(121) }).success,
    ).toBe(false);
    expect(
      CrearSegmentoSchema.safeParse({ workspaceId: ws, nombre: 'ok', definicion: 'x'.repeat(2001) })
        .success,
    ).toBe(false);
  });

  it('editar exige el id del segmento además de los mismos campos', () => {
    expect(EditarSegmentoSchema.safeParse({ workspaceId: ws, nombre: 'pymes' }).success).toBe(
      false,
    );
    expect(
      EditarSegmentoSchema.safeParse({ workspaceId: ws, segmentoId: seg, nombre: 'pymes' }).success,
    ).toBe(true);
  });
});

describe('la cobertura de research por segmento', () => {
  it('cuenta los arquetipos por estado, con las tres claves siempre presentes', () => {
    expect(conteoPorEstado([])).toEqual({ hipotesis: 0, confirmado: 0, refutado: 0 });
    expect(
      conteoPorEstado([
        arquetipo(),
        arquetipo({ id: 'a-2', estado: 'confirmado' }),
        arquetipo({ id: 'a-3', estado: 'confirmado' }),
      ]),
    ).toEqual({ hipotesis: 1, confirmado: 2, refutado: 0 });
  });

  it('un segmento sin nada lo dice, en vez de enseñar ceros', () => {
    expect(resumenDeCobertura({ arquetipos: [], evidencias: 0 })).toBe(
      'Sin arquetipos ni evidencia todavía',
    );
  });

  it('resume arquetipos (con el detalle por estado) y evidencias en una frase', () => {
    expect(
      resumenDeCobertura({
        arquetipos: [arquetipo(), arquetipo({ id: 'a-2', estado: 'confirmado' })],
        evidencias: 3,
      }),
    ).toBe('2 arquetipos (1 hipótesis, 1 confirmado) · 3 evidencias');
  });

  it('el singular es singular, y lo que falta se nombra', () => {
    expect(resumenDeCobertura({ arquetipos: [arquetipo()], evidencias: 0 })).toBe(
      '1 arquetipo (1 hipótesis) · Sin evidencia',
    );
    expect(resumenDeCobertura({ arquetipos: [], evidencias: 1 })).toBe(
      'Sin arquetipos · 1 evidencia',
    );
  });

  it('el arquetipo lleva al proyecto de su reto; sin proyecto no hay destino', () => {
    expect(destinoDeArquetipo(arquetipo())).toEqual({
      to: '/proyecto/$proyectoId',
      params: { proyectoId: 'p-1' },
    });
    expect(destinoDeArquetipo(arquetipo({ proyectoId: null, proyectoCodigo: null }))).toBeNull();
  });
});

describe('el nombre único por workspace, visto desde la pantalla', () => {
  const existentes = [
    { id: 's-1', nombre: 'pymes' },
    { id: 's-2', nombre: 'Empleados corporativos' },
  ];

  it('ignora mayúsculas y espacios: «  PYMES » ya está usado', () => {
    expect(nombreYaUsado('  PYMES ', existentes)).toBe(true);
    expect(nombreYaUsado('empleados corporativos', existentes)).toBe(true);
    expect(nombreYaUsado('independientes', existentes)).toBe(false);
  });

  it('al editar, conservar el propio nombre no es repetirlo; tomar el de otro sí', () => {
    expect(nombreYaUsado('Pymes', existentes, 's-1')).toBe(false);
    expect(nombreYaUsado('Pymes', existentes, 's-2')).toBe(true);
  });
});
