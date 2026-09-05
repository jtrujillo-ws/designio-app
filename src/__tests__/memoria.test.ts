import { describe, expect, it } from 'vitest';
import {
  agruparArquetiposPorSegmento,
  conteo,
  destinoDeLaDecision,
  destinoDelArquetipo,
  destinoDelInsight,
  destinoDelRetoCerrado,
  memoriaVacia,
  MemoriaInputSchema,
  resumenDeArquetipos,
  type ArquetipoEnMemoria,
  type MemoriaDelWorkspace,
  type SegmentoEnMemoria,
} from '@/lib/memoria/memoria.schemas';

const segmento = (id: string, nombre: string): SegmentoEnMemoria => ({
  id,
  nombre,
  definicion: '',
});

const arquetipo = (
  parcial: Partial<ArquetipoEnMemoria> & Pick<ArquetipoEnMemoria, 'id' | 'nombre'>,
): ArquetipoEnMemoria => ({
  definicion: '',
  estado: 'hipotesis',
  veredictoRazon: '',
  reto: { id: 'r1', codigo: 'R-01', titulo: 'Reto', estado: 'activo' },
  proyecto: { id: 'p1', codigo: 'P-01' },
  segmentoIds: [],
  ...parcial,
});

const memoria = (parcial: Partial<MemoriaDelWorkspace> = {}): MemoriaDelWorkspace => ({
  workspaceId: 'ws',
  workspaceNombre: 'Banco',
  segmentos: [],
  arquetipos: [],
  insights: [],
  decisiones: [],
  retosCerrados: [],
  retosCandidatos: [],
  ...parcial,
});

describe('los arquetipos agrupados por segmento', () => {
  const independientes = segmento('s1', 'independientes');
  const pymes = segmento('s2', 'pymes');

  it('respeta el orden de los segmentos y conserva los que no tienen arquetipos, vacíos', () => {
    const grupos = agruparArquetiposPorSegmento(
      [independientes, pymes],
      [arquetipo({ id: 'a1', nombre: 'Sin firma digital', segmentoIds: ['s1'] })],
    );
    expect(grupos.map((g) => g.segmento?.nombre)).toEqual(['independientes', 'pymes']);
    expect(grupos[0]!.arquetipos.map((a) => a.id)).toEqual(['a1']);
    expect(grupos[1]!.arquetipos).toEqual([]);
  });

  it('un arquetipo mapeado a dos segmentos aparece en los dos: el mapeo es n:m', () => {
    const grupos = agruparArquetiposPorSegmento(
      [independientes, pymes],
      [arquetipo({ id: 'a1', nombre: 'Compartido', segmentoIds: ['s1', 's2'] })],
    );
    expect(grupos[0]!.arquetipos.map((a) => a.id)).toEqual(['a1']);
    expect(grupos[1]!.arquetipos.map((a) => a.id)).toEqual(['a1']);
  });

  it('los arquetipos sin segmento van en un grupo final, que solo existe si hay alguno', () => {
    const conSueltos = agruparArquetiposPorSegmento(
      [independientes],
      [
        arquetipo({ id: 'a1', nombre: 'Con segmento', segmentoIds: ['s1'] }),
        arquetipo({ id: 'a2', nombre: 'Suelto' }),
        // Un id de segmento que el workspace ya no reconoce tampoco se pierde.
        arquetipo({ id: 'a3', nombre: 'Huérfano', segmentoIds: ['s-borrado'] }),
      ],
    );
    expect(conSueltos).toHaveLength(2);
    expect(conSueltos[1]!.segmento).toBeNull();
    expect(conSueltos[1]!.arquetipos.map((a) => a.id)).toEqual(['a3', 'a2']);

    const sinSueltos = agruparArquetiposPorSegmento(
      [independientes],
      [arquetipo({ id: 'a1', nombre: 'Con segmento', segmentoIds: ['s1'] })],
    );
    expect(sinSueltos).toHaveLength(1);
  });

  it('dentro del segmento va primero lo confirmado, luego las hipótesis y al final lo refutado', () => {
    const [grupo] = agruparArquetiposPorSegmento(
      [independientes],
      [
        arquetipo({ id: 'a1', nombre: 'Zeta', estado: 'refutado', segmentoIds: ['s1'] }),
        arquetipo({ id: 'a2', nombre: 'Beta', estado: 'hipotesis', segmentoIds: ['s1'] }),
        arquetipo({ id: 'a3', nombre: 'Alfa', estado: 'hipotesis', segmentoIds: ['s1'] }),
        arquetipo({ id: 'a4', nombre: 'Omega', estado: 'confirmado', segmentoIds: ['s1'] }),
      ],
    );
    expect(grupo!.arquetipos.map((a) => a.nombre)).toEqual(['Omega', 'Alfa', 'Beta', 'Zeta']);
  });

  it('no muta la lista que recibe', () => {
    const lista = [
      arquetipo({ id: 'a1', nombre: 'B', estado: 'refutado' }),
      arquetipo({ id: 'a2', nombre: 'A', estado: 'confirmado' }),
    ];
    agruparArquetiposPorSegmento([], lista);
    expect(lista.map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('el resumen de arquetipos', () => {
  it('cuenta por estado y dice cero donde no hay', () => {
    expect(
      resumenDeArquetipos([
        arquetipo({ id: 'a1', nombre: 'A', estado: 'confirmado' }),
        arquetipo({ id: 'a2', nombre: 'B', estado: 'hipotesis' }),
        arquetipo({ id: 'a3', nombre: 'C', estado: 'hipotesis' }),
      ]),
    ).toEqual({ confirmado: 1, hipotesis: 2, refutado: 0 });
    expect(resumenDeArquetipos([])).toEqual({ confirmado: 0, hipotesis: 0, refutado: 0 });
  });
});

describe('a dónde abre cada pieza de la memoria', () => {
  it('el arquetipo y el reto cerrado abren su proyecto, y sin proyecto no abren nada', () => {
    expect(destinoDelArquetipo(arquetipo({ id: 'a1', nombre: 'A' }))).toEqual({
      to: '/proyecto/$proyectoId',
      params: { proyectoId: 'p1' },
    });
    expect(destinoDelArquetipo(arquetipo({ id: 'a1', nombre: 'A', proyecto: null }))).toBeNull();

    const cerrado = {
      id: 'r',
      codigo: 'R-02',
      titulo: 'Cerrado',
      veredicto: null,
      contribucion: '',
      aprendizajes: '',
      cerradoEn: null,
      proyecto: { id: 'p2', codigo: 'P-02' },
    };
    expect(destinoDelRetoCerrado(cerrado)).toEqual({
      to: '/proyecto/$proyectoId',
      params: { proyectoId: 'p2' },
    });
    expect(destinoDelRetoCerrado({ ...cerrado, proyecto: null })).toBeNull();
  });

  it('el insight abre la lista con él destacado; la decisión, su proyecto', () => {
    expect(
      destinoDelInsight({ id: 'i1', titulo: 'x', resumen: '', validadoEn: '2026-09-01' }),
    ).toEqual({
      to: '/insights',
      search: { destacar: 'i1' },
    });
    expect(
      destinoDeLaDecision({
        id: 'd1',
        tipo: 'diseno',
        titulo: 'x',
        fundamento: '',
        gateNumero: 1,
        decididoEn: '2026-09-01',
        proyecto: { id: 'p1', codigo: 'P-01', titulo: 'Proyecto' },
      }),
    ).toEqual({ to: '/proyecto/$proyectoId', params: { proyectoId: 'p1' } });
  });
});

describe('la memoria vacía y los conteos', () => {
  it('está vacía solo cuando ninguna sección tiene nada (los segmentos no cuentan)', () => {
    expect(memoriaVacia(memoria({ segmentos: [segmento('s1', 'independientes')] }))).toBe(true);
    expect(
      memoriaVacia(
        memoria({
          retosCandidatos: [
            { id: 'r', codigo: 'R-03', titulo: 'x', descripcion: '', metricaObjetivo: '' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('el conteo concuerda en número', () => {
    expect(conteo(1, 'insight validado', 'insights validados')).toBe('1 insight validado');
    expect(conteo(0, 'insight validado', 'insights validados')).toBe('0 insights validados');
    expect(conteo(3, 'decisión vigente', 'decisiones vigentes')).toBe('3 decisiones vigentes');
  });

  it('la entrada exige un workspace uuid', () => {
    expect(MemoriaInputSchema.safeParse({ workspaceId: 'no-es-uuid' }).success).toBe(false);
    expect(
      MemoriaInputSchema.safeParse({ workspaceId: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(true);
  });
});
