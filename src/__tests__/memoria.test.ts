import { describe, expect, it } from 'vitest';
import {
  agruparArquetiposPorSegmento,
  destinoDeLaDecision,
  destinoDelArquetipo,
  destinoDelInsight,
  destinoDelRetoCerrado,
  memoriaVacia,
  MemoriaInputSchema,
  notaDeRecorte,
  resumenDeArquetipos,
  TOPE_POR_SECCION,
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
  totales: { arquetipos: 0, insights: 0, decisiones: 0, retosCerrados: 0, retosCandidatos: 0 },
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
      estado: 'cerrado' as const,
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

describe('la memoria vacía y el recorte', () => {
  it('está vacía solo cuando ningún total es mayor que cero (los segmentos no cuentan)', () => {
    expect(memoriaVacia(memoria({ segmentos: [segmento('s1', 'independientes')] }))).toBe(true);
    // Los TOTALES mandan, no las listas: una sección recortada a cero filas seguiría contando.
    expect(
      memoriaVacia(
        memoria({
          totales: {
            arquetipos: 0,
            insights: 0,
            decisiones: 0,
            retosCerrados: 0,
            retosCandidatos: 3,
          },
        }),
      ),
    ).toBe(false);
  });

  it('la nota de recorte solo existe cuando el total supera lo mostrado, y dice dónde está el resto', () => {
    expect(notaDeRecorte(3, 3, 'Insights y citas')).toBeNull();
    expect(notaDeRecorte(0, 0, 'Insights y citas')).toBeNull();
    expect(notaDeRecorte(TOPE_POR_SECCION, 120, 'Insights y citas')).toBe(
      `Se muestran los ${TOPE_POR_SECCION} más recientes de 120; la lista completa está en Insights y citas.`,
    );
    expect(notaDeRecorte(1, 2, 'el árbol del loop')).toBe(
      'Se muestran el más reciente de 2; la lista completa está en el árbol del loop.',
    );
  });

  it('el tope por sección es el mismo con el que pagina la pantalla de insights', () => {
    expect(TOPE_POR_SECCION).toBe(50);
  });

  it('la entrada exige un workspace uuid', () => {
    expect(MemoriaInputSchema.safeParse({ workspaceId: 'no-es-uuid' }).success).toBe(false);
    expect(
      MemoriaInputSchema.safeParse({ workspaceId: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(true);
  });
});
