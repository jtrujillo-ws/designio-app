import { describe, expect, it } from 'vitest';
import {
  agruparArquetiposPorSegmento,
  cabeceraDeGrupo,
  destinoDeLaDecision,
  destinoDelArquetipo,
  destinoDelInsight,
  destinoDelRetoCerrado,
  memoriaVacia,
  MemoriaInputSchema,
  notaDeRecorte,
  resumenDeArquetipos,
  resumenDeRespaldo,
  TOPE_POR_SECCION,
  type ArquetipoEnMemoria,
  type MemoriaDelWorkspace,
  type SegmentoEnMemoria,
} from '@/lib/memoria/memoria.schemas';

const segmento = (id: string, nombre: string, totalArquetipos = 0): SegmentoEnMemoria => ({
  id,
  nombre,
  definicion: '',
  totalArquetipos,
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
  totales: {
    segmentos: 0,
    arquetipos: 0,
    arquetiposSinSegmento: 0,
    insights: 0,
    decisiones: 0,
    retosCerrados: 0,
    retosCandidatos: 0,
  },
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

  it('tres casos: en un segmento mostrado, solo en segmentos no mostrados, y sin segmento alguno', () => {
    // `segmentos` viene recortada al tope: «s-antiguo» existe en el workspace pero no cupo.
    // El arquetipo mapeado solo a él TIENE segmento, y no puede acabar en «sin segmento».
    const grupos = agruparArquetiposPorSegmento(
      [independientes],
      [
        arquetipo({ id: 'a1', nombre: 'Con segmento', segmentoIds: ['s1'] }),
        arquetipo({ id: 'a2', nombre: 'Suelto' }),
        arquetipo({ id: 'a3', nombre: 'De un segmento no mostrado', segmentoIds: ['s-antiguo'] }),
        // Mapeado a uno mostrado y a uno no mostrado: va con el mostrado, no aparte.
        arquetipo({ id: 'a4', nombre: 'Mixto', segmentoIds: ['s-antiguo', 's1'] }),
      ],
      1,
    );
    expect(grupos.map((g) => [g.clase, g.arquetipos.map((a) => a.id), g.total])).toEqual([
      ['segmento', ['a1', 'a4'], 2],
      // Total desconocido: solo se sabe de los que cupieron entre los mostrados.
      ['fuera-de-los-mostrados', ['a3'], null],
      ['sin-segmento', ['a2'], 1],
    ]);
    expect(grupos[1]!.segmento).toBeNull();
    expect(grupos[2]!.segmento).toBeNull();
    // Y su cabecera no presenta lo mostrado como cifra exacta.
    expect(cabeceraDeGrupo(grupos[1]!)).toBe(
      '1 mostrado (puede haber más entre los arquetipos más antiguos)',
    );
    expect(
      cabeceraDeGrupo({
        clase: 'fuera-de-los-mostrados',
        segmento: null,
        arquetipos: [],
        total: null,
      }),
    ).toBe('0 mostrados (puede haber más entre los arquetipos más antiguos)');
  });

  it('los grupos «fuera de los mostrados» y «sin segmento» solo existen si hay alguno', () => {
    const conSueltos = agruparArquetiposPorSegmento(
      [independientes],
      [
        arquetipo({ id: 'a1', nombre: 'Con segmento', segmentoIds: ['s1'] }),
        arquetipo({ id: 'a2', nombre: 'Suelto' }),
      ],
    );
    expect(conSueltos.map((g) => g.clase)).toEqual(['segmento', 'sin-segmento']);
    expect(conSueltos[1]!.arquetipos.map((a) => a.id)).toEqual(['a2']);

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

  it('cada grupo lleva el total del count, no el de la lista recortada', () => {
    // «pymes» tiene 3 arquetipos de verdad pero ninguno sobrevivió al tope global; y hay 2
    // sin segmento de los que tampoco se enseña ninguno. Ni un grupo dice «sin arquetipos».
    const grupos = agruparArquetiposPorSegmento(
      [segmento('s1', 'independientes', 2), segmento('s2', 'pymes', 3), segmento('s3', 'nuevos')],
      [arquetipo({ id: 'a1', nombre: 'Visible', segmentoIds: ['s1'] })],
      2,
    );
    expect(
      grupos.map((g) => [g.segmento?.nombre ?? g.clase, g.arquetipos.length, g.total]),
    ).toEqual([
      ['independientes', 1, 2],
      ['pymes', 0, 3],
      ['nuevos', 0, 0],
      ['sin-segmento', 0, 2],
    ]);
    expect(cabeceraDeGrupo(grupos[0]!)).toBe('se muestran 1 de 2 (los más recientes)');
    expect(cabeceraDeGrupo(grupos[1]!)).toBe('se muestran 0 de 3 (los más recientes)');
    expect(cabeceraDeGrupo(grupos[2]!)).toBe('sin arquetipos todavía');
    expect(cabeceraDeGrupo(grupos[3]!)).toBe('se muestran 0 de 2 (los más recientes)');
    // Sin recorte, la cabecera cuenta a secas.
    const [entero] = agruparArquetiposPorSegmento(
      [segmento('s1', 'independientes', 1)],
      [arquetipo({ id: 'a1', nombre: 'Visible', segmentoIds: ['s1'] })],
    );
    expect(cabeceraDeGrupo(entero!)).toBe('1 arquetipo');
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
  const tres = [
    arquetipo({ id: 'a1', nombre: 'A', estado: 'confirmado' }),
    arquetipo({ id: 'a2', nombre: 'B', estado: 'hipotesis' }),
    arquetipo({ id: 'a3', nombre: 'C', estado: 'hipotesis' }),
  ];

  it('sin recorte, cuenta por estado y dice cero donde no hay', () => {
    expect(resumenDeArquetipos(tres, 3)).toBe(
      '3 arquetipos · 1 confirmado · 2 hipótesis · 0 refutados',
    );
    expect(resumenDeArquetipos([], 0)).toBe('0 arquetipos');
  });

  it('con recorte, dice que el desglose es de los mostrados: lo que el tope dejó fuera no se cuenta por estado', () => {
    expect(resumenDeArquetipos(tres, 80)).toBe(
      '80 arquetipos · de los 3 mostrados: 1 confirmado · 2 hipótesis · 0 refutados',
    );
    expect(resumenDeArquetipos([tres[0]!], 2)).toBe(
      '2 arquetipos · del mostrado: 1 confirmado · 0 hipótesis · 0 refutados',
    );
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
      destinoDelInsight({
        id: 'i1',
        titulo: 'x',
        resumen: '',
        validadoEn: '2026-09-01',
        sinRespaldo: null,
      }),
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
        sinRespaldo: null,
      }),
    ).toEqual({ to: '/proyecto/$proyectoId', params: { proyectoId: 'p1' } });
  });
});

describe('el respaldo de lo validado y lo vigente', () => {
  const vivo = { sinRespaldo: null };
  const roto = { sinRespaldo: 'la afirmación «x» cita evidencia sin derechos vigentes' };

  it('sin recorte, cuenta aparte lo que sigue con respaldo y lo que lo perdió', () => {
    expect(resumenDeRespaldo([vivo, roto, vivo], 3, 'insight validado', 'insights validados')).toBe(
      '3 insights validados · 2 con respaldo · 1 sin respaldo vivo',
    );
    expect(resumenDeRespaldo([vivo], 1, 'decisión vigente', 'decisiones vigentes')).toBe(
      '1 decisión vigente · 1 con respaldo · 0 sin respaldo vivo',
    );
    expect(resumenDeRespaldo([], 0, 'insight validado', 'insights validados')).toBe(
      '0 insights validados',
    );
  });

  it('con recorte, dice que el desglose es de los mostrados: no se evalúa lo que el tope dejó fuera', () => {
    const mostrados = Array.from({ length: TOPE_POR_SECCION }, (_, i) => (i < 2 ? roto : vivo));
    expect(resumenDeRespaldo(mostrados, 53, 'insight validado', 'insights validados')).toBe(
      `53 insights validados · de los ${TOPE_POR_SECCION} mostrados: 48 con respaldo · 2 sin respaldo vivo`,
    );
    expect(resumenDeRespaldo([roto], 2, 'decisión vigente', 'decisiones vigentes')).toBe(
      '2 decisiones vigentes · del mostrado: 0 con respaldo · 1 sin respaldo vivo',
    );
  });
});

describe('la memoria vacía y el recorte', () => {
  it('está vacía solo cuando ningún total es mayor que cero (los segmentos no cuentan)', () => {
    expect(memoriaVacia(memoria({ segmentos: [segmento('s1', 'independientes')] }))).toBe(true);
    // Ni aunque haya más segmentos de los que se enseñan: son taxonomía, no lo aprendido.
    expect(
      memoriaVacia(
        memoria({
          totales: {
            segmentos: 80,
            arquetipos: 0,
            arquetiposSinSegmento: 0,
            insights: 0,
            decisiones: 0,
            retosCerrados: 0,
            retosCandidatos: 0,
          },
        }),
      ),
    ).toBe(true);
    // Los TOTALES mandan, no las listas: una sección recortada a cero filas seguiría contando.
    expect(
      memoriaVacia(
        memoria({
          totales: {
            segmentos: 0,
            arquetipos: 0,
            arquetiposSinSegmento: 0,
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
