import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  ETIQUETA_DISENO,
  ETIQUETA_MATERIAL,
  agruparLateral,
  claveDeGobierno,
  notaDeGobierno,
  type RutaDelWorkspace,
} from '@/lib/loop/lateral';

/**
 * El lateral dejó de ser una lista plana de trece destinos: se ordena por clase y lo
 * pendiente sube a «Te espera». Estas pruebas fijan las reglas del handoff (turno 4a) que
 * no se ven en un fotograma: qué sube, qué vuelve a su estante y qué ve cada rol.
 */
describe('agrupación del lateral (4a)', () => {
  const todos = (l: ReturnType<typeof agruparLateral>) => [
    ...l.teEspera,
    ...l.estantes.flatMap((e) => e.destinos),
    ...l.gobierno,
  ];

  it('con ambos contadores, «Te espera» lleva exactamente esos dos, aprobaciones primero', () => {
    const l = agruparLateral({
      rol: 'lead-boutique',
      pendientesDelRol: 1,
      importacionPendientes: 2,
    });
    expect(l.teEspera.map((d) => d.to)).toEqual(['/aprobaciones', '/importacion']);
    expect(l.teEspera[0]?.contador).toEqual({
      n: 1,
      color: 'warn',
      titulo: '1 pendiente de tu rol',
    });
    expect(l.teEspera[1]?.contador).toEqual({ n: 2, color: 'accent', titulo: '2 sin curar' });
    // Y no se repiten abajo.
    expect(l.estantes[0]?.destinos.map((d) => d.to)).toEqual([
      '/evidencia',
      '/insights',
      '/oportunidades',
      '/segmentos',
    ]);
  });

  it('a cero, el bloque no existe y las filas vuelven a «Material y razonamiento»', () => {
    const l = agruparLateral({
      rol: 'lead-boutique',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(l.teEspera).toEqual([]);
    expect(l.estantes[0]?.etiqueta).toBe(ETIQUETA_MATERIAL);
    expect(l.estantes[0]?.destinos.map((d) => d.to)).toEqual([
      '/aprobaciones',
      '/importacion',
      '/evidencia',
      '/insights',
      '/oportunidades',
      '/segmentos',
    ]);
    // Sin contador: nunca se pinta un «0».
    expect(l.estantes[0]?.destinos.every((d) => d.contador === undefined)).toBe(true);
  });

  it('con solo uno > 0, el bloque se pinta con una fila y la otra vuelve a su estante', () => {
    const l = agruparLateral({ rol: 'sponsor', pendientesDelRol: 3, importacionPendientes: 0 });
    expect(l.teEspera.map((d) => d.to)).toEqual(['/aprobaciones']);
    expect(l.teEspera[0]?.contador?.titulo).toBe('3 pendientes de tu rol');
    expect(l.estantes[0]?.destinos[0]?.to).toBe('/importacion');
  });

  it('la bandeja solo cuenta para quien la cura: a un sponsor no se le promueve', () => {
    const sponsor = agruparLateral({
      rol: 'sponsor',
      pendientesDelRol: 0,
      importacionPendientes: 2,
    });
    expect(sponsor.teEspera).toEqual([]);
    expect(sponsor.estantes[0]?.destinos.find((d) => d.to === '/importacion')?.contador).toBe(
      undefined,
    );
    const curador = agruparLateral({
      rol: 'disenador',
      pendientesDelRol: 0,
      importacionPendientes: 2,
    });
    expect(curador.teEspera.map((d) => d.to)).toEqual(['/importacion']);
  });

  it('«Diseño y entrega» recuerda que la AI propone', () => {
    const l = agruparLateral({ rol: 'disenador', pendientesDelRol: 0, importacionPendientes: 0 });
    expect(l.estantes[1]?.etiqueta).toBe(ETIQUETA_DISENO);
    expect(l.estantes[1]?.destinos.map((d) => d.to)).toEqual([
      '/journeys',
      '/design-versions',
      '/propuestas',
      '/biblioteca',
    ]);
    expect(l.estantes[1]?.destinos.find((d) => d.to === '/propuestas')?.sufijo).toBe('propone');
  });

  it('el gobierno se filtra por rol igual que antes: auditoría solo para quien rinde cuentas', () => {
    const lead = agruparLateral({
      rol: 'lead-boutique',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(lead.gobierno.map((d) => d.to)).toEqual([
      '/personas',
      '/auditoria',
      // §14 pone la observabilidad de la capa AI en la misma fila que la auditoría
      // —«Auditoría y operación»—, así que va con su misma puerta de rol; y el informe de
      // grounding detrás, que contesta la otra mitad de la misma pregunta.
      '/observabilidad-ai',
      '/evals-grounding',
      '/exportacion',
      '/disposicion',
    ]);
    expect(lead.gobierno.at(-1)?.etiqueta).toBe('Disposición del workspace');

    const sponsor = agruparLateral({
      rol: 'sponsor',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(sponsor.gobierno.map((d) => d.to)).toEqual([
      '/personas',
      '/exportacion',
      '/disposicion',
    ]);
    // La puerta de disposición no se condiciona al rol: cambia el rótulo, no la fila.
    expect(sponsor.gobierno.at(-1)?.etiqueta).toBe('Constancias que conservas');
  });

  it('ningún destino se pierde ni se repite al agrupar', () => {
    for (const rol of ['lead-boutique', 'disenador', 'admin-cliente', 'sponsor', 'observador']) {
      for (const [p, b] of [
        [0, 0],
        [1, 0],
        [0, 2],
        [1, 2],
      ] as const) {
        const rutas = todos(
          agruparLateral({ rol, pendientesDelRol: p, importacionPendientes: b }),
        ).map((d) => d.to);
        expect(new Set(rutas).size).toBe(rutas.length);
        /*
         * Dieciséis destinos, menos los que el rol puede no ver. El total se deriva de QUÉ
         * puertas condicionadas trae este rol, no de un número escrito a mano por cada uno: con
         * `14 - (…auditoría…)`, la SEGUNDA puerta por rol dejó el censo rojo sin haber roto
         * nada, y arreglarlo restando otro literal habría hecho lo mismo con la tercera.
         *
         * Las tres comparten hoy la misma lista de roles a propósito (§14 pone auditoría y
         * operación en la misma fila, y el grounding se deriva de ahí), así que o entran las
         * tres o no entra ninguna — y si algún día se separan, este recuento lo dice en vez de
         * dejarlo pasar.
         */
        const conPuerta: RutaDelWorkspace[] = [
          '/auditoria',
          '/observabilidad-ai',
          '/evals-grounding',
        ];
        const esperadas = 16 - conPuerta.filter((r) => !rutas.includes(r)).length;
        expect(rutas).toHaveLength(esperadas);
      }
    }
  });

  it('la nota de gobierno nombra solo lo que el rol ve', () => {
    const lead = agruparLateral({
      rol: 'lead-boutique',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(notaDeGobierno(lead.gobierno)).toBe(
      'Personas, auditoría, operación AI, grounding medido, exportación y disposición: se abren cuando se buscan, no cada día.',
    );
    const sponsor = agruparLateral({
      rol: 'sponsor',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(notaDeGobierno(sponsor.gobierno)).toBe(
      'Personas, exportación y disposición: se abren cuando se buscan, no cada día.',
    );
  });

  /**
   * LA PANTALLA DEL LOOP NO ALCANZA EL CONTRATO DE LA CAPA AI.
   *
   * `ai.schemas.ts` lo dice en su propia cabecera: Rollup no puede podar una construcción de Zod
   * de nivel superior, así que importar UNA cosa de allí arrastra el contrato entero. `/app` se
   * pinta en cada visita, y el lateral llegó a importar de ahí una lista de tres roles — con eso
   * bastaba para tender la arista.
   *
   * Se mide sobre el GRAFO DE MÓDULOS y no sobre el tamaño de un chunk, porque el troceado no es
   * la propiedad: medido, quitar aquel import dejaba el bundle byte a byte idéntico, porque
   * Rollup ya izaba `ai.schemas` al chunk común al usarlo tres rutas perezosas. Eso puede cambiar
   * mañana; la arista es lo que se puede afirmar y lo que hay que impedir.
   *
   * Los `import type` NO cuentan: se borran al compilar y no crean arista. Y los específicos que
   * este censo vigila son los DOS módulos pesados de la capa AI —el contrato y sus validadores—,
   * no la carpeta entera: `ai.roles.ts` existe justo para poder importarse desde aquí.
   */
  it('la pantalla del Loop no alcanza el contrato de la capa AI por ningún camino', () => {
    const raiz = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
    const entradas = [`${raiz}/src/components/loop/LoopScreen.tsx`, `${raiz}/src/lib/loop/lateral.ts`];
    for (const e of entradas) expect(existsSync(e), `${e} no existe: el censo no mira nada`).toBe(true);

    const resolver = (desde: string, spec: string): string | null => {
      let base: string;
      if (spec.startsWith('@/')) base = `${raiz}/src/${spec.slice(2)}`;
      else if (spec.startsWith('.')) {
        const dir = desde.slice(0, desde.lastIndexOf('/'));
        base = new URL(spec, `file://${dir}/`).pathname;
      } else return null; // Paquetes de node_modules: no son código de este repositorio.
      for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        if (existsSync(base + ext)) return base + ext;
      }
      return existsSync(base) ? base : null;
    };

    const visto = new Set(entradas);
    const desde = new Map<string, string>();
    const cola = [...entradas];
    while (cola.length > 0) {
      const f = cola.shift()!;
      const arbol = ts.createSourceFile(
        f,
        readFileSync(f, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      // Lo que no parsea limpio no se da por barrido: si no, el censo pasaría en verde sin
      // haber leído el fichero donde estuviera la arista.
      const diagnosticos = (arbol as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
      expect(diagnosticos ?? [], `${f} no parsea limpio`).toHaveLength(0);
      for (const st of arbol.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        if (st.importClause?.isTypeOnly) continue;
        const destino = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
        if (!destino || visto.has(destino)) continue;
        visto.add(destino);
        desde.set(destino, f);
        cola.push(destino);
      }
    }
    // Que haya recorrido algo: con un resolutor roto, el conjunto sería de dos y el censo
    // pasaría sin haber mirado nada — el modo de fallo de todo barrido.
    expect(visto.size, 'el grafo salió demasiado pequeño: el resolutor no está resolviendo').toBeGreaterThan(10);

    const PESADOS = ['/src/lib/ai/ai.schemas.ts', '/src/lib/ai/ai.contenido.ts'];
    const cadena = (m: string): string => {
      const pasos: string[] = [];
      let p: string | undefined = m;
      while (p) {
        pasos.push(p.slice(raiz.length + 1));
        p = desde.get(p);
      }
      return pasos.reverse().join(' → ');
    };
    const alcanzados = [...visto].filter((m) => PESADOS.some((x) => m.endsWith(x)));
    expect(alcanzados.map(cadena)).toEqual([]);
  });

  it('la preferencia de gobierno se guarda por usuario y workspace, como la expansión', () => {
    expect(claveDeGobierno('u-1', 'ws-9')).toBe('designio.loop.gobierno.u-1.ws-9');
  });
});
