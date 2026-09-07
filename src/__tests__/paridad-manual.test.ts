import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CAPACIDADES, CAPACIDADES_ACTIVAS } from '@/lib/ai/ai.schemas';
import type { Destino } from '@/lib/ai/ai.schemas';

/**
 * RF-08.6 / SYS-21 — LA PARIDAD MANUAL, MEDIDA EN VEZ DE AFIRMADA.
 *
 * «Degradación segura: caída del proveedor AI ⇒ los flujos manuales equivalentes están siempre
 * presentes (crear insight a mano, llenar registry a mano, etc.)». Eso se cumplía el día que se
 * escribió este censo —las siete capacidades con destino tenían su ruta sin AI— pero se cumplía
 * como HECHO: la paridad vivía en cuatro comentarios repartidos por tres ficheros, y ninguno de
 * los cuatro impedía que la capacidad diez llegara con destino y sin equivalente manual.
 *
 * Un requisito que sólo vive en prosa se cumple hasta el día que alguien no lea la prosa. Estas
 * sondas lo convierten en invariante, y en las tres direcciones en que puede romperse:
 *
 *  1. Que alguien NO LA DECLARE: lo impide el tipo, no este fichero. `paridadManual` es
 *     obligatoria en `DefinicionCapacidad`, así que una capacidad nueva no compila sin ella.
 *  2. Que la declare MAL DE CLASE: una capacidad que materializa algo declarándose informativa,
 *     o al revés. Las dos derivaciones —el destino y la clase— se comparan aquí.
 *  3. Que la declare BIEN Y APUNTE A NADA: el nombre de una función que no existe, o que existe
 *     y no escribe el destino. Eso es lo que el barrido comprueba de verdad.
 */
/**
 * La tabla que materializa cada destino, derivada del DESTINO y no de su columna.
 *
 * Lo intenté primero con `COLUMNA_DE_DESTINO` menos el `_id` y el censo se puso rojo sobre C0:
 * la columna es `criterio_id` y la tabla es `criterio_exito`. La regla no se sostenía, y el
 * fallo estaba en mi derivación, no en la paridad de C0 — que existe. Del destino sí se sostiene
 * para las siete, comprobado contra el catálogo vivo, y una sonda de la suite con base lo vuelve
 * a comprobar ahí para que un destino renombrado sin su tabla no pase.
 */
const tablaDelDestino = (destino: Destino): string => destino.replace(/-/g, '_');

describe('paridad manual de las capacidades AI (RF-08.6)', () => {
  const raiz = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

  /** El mismo resolutor del censo del lateral: alias `@/`, relativos, y las cuatro extensiones. */
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

  /*
   * El parseo se memoiza porque este censo lee los mismos ficheros muchas veces: siete
   * capacidades por siete materializadores son cuarenta y nueve recorridos, y sin memoria la
   * suite se pasaba de tiempo. Es caché de lectura, no de resultado: lo que se guarda es el
   * árbol de un fichero que no cambia durante la corrida.
   */
  const arboles = new Map<string, ts.SourceFile>();
  const leer = (f: string): ts.SourceFile => {
    const guardado = arboles.get(f);
    if (guardado) return guardado;
    const arbol = ts.createSourceFile(
      f,
      readFileSync(f, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    // Lo que no parsea limpio no se da por leído: si no, el censo pasaría en verde sin haber
    // mirado el fichero donde estuviera la escritura.
    const diagnosticos = (arbol as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
    expect(diagnosticos ?? [], `${f} no parsea limpio`).toHaveLength(0);
    arboles.set(f, arbol);
    return arbol;
  };

  /**
   * LOS NOMBRES QUE UN MÓDULO EXPORTA, en las cuatro formas en que este repositorio los escribe.
   *
   * La primera versión sólo reconocía `export function`, y una revisión señaló el efecto: una
   * puerta manual escrita como `export const` o re-exportada habría puesto el censo rojo siendo
   * válida. No hay hoy ninguna así entre las siete —lo comprobé—, así que era preventivo; pero un
   * censo que impone un estilo de export mide otra cosa que la que dice medir, y encima este
   * fichero se contradecía solo: el grafo de llamadas de abajo SÍ acepta `const f = …`.
   *
   * `export * from` se sigue hasta el módulo de origen: sin eso, un re-export completo se leería
   * como «no exporta nada» y volvería el mismo falso negativo por otra puerta.
   */
  const exportadasDe = (f: string, vistos = new Set<string>()): Set<string> => {
    const nombres = new Set<string>();
    if (vistos.has(f)) return nombres; // Ciclo de re-exports: no se cuelga, se corta.
    vistos.add(f);
    for (const st of leer(f).statements) {
      const exportado = (n: ts.Node): boolean =>
        (n as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        ) ?? false;
      if (ts.isFunctionDeclaration(st) && st.name && exportado(st)) nombres.add(st.name.text);
      else if (ts.isVariableStatement(st) && exportado(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) nombres.add(d.name.text);
        }
      } else if (ts.isExportDeclaration(st)) {
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          // `export { x }` y `export { x as y }`: cuenta el nombre con el que SALE.
          for (const e of st.exportClause.elements) nombres.add(e.name.text);
        } else if (!st.exportClause && st.moduleSpecifier) {
          const origen = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
          if (origen) for (const n of exportadasDe(origen, vistos)) nombres.add(n);
        }
      }
    }
    return nombres;
  };

  it('cada capacidad declara su paridad, y la clase concuerda con el destino', () => {
    // Que el censo mire las nueve y no una lista suya: derivado del registro.
    expect(CAPACIDADES_ACTIVAS.length, 'el registro salió vacío').toBeGreaterThan(5);
    for (const cap of CAPACIDADES_ACTIVAS) {
      const def = CAPACIDADES[cap];
      const materializa = def.destino !== null;
      expect(
        def.paridadManual.clase,
        `${cap} materializa ${String(def.destino)} pero declara su paridad como «${def.paridadManual.clase}»`,
      ).toBe(materializa ? 'escritura' : 'informativa');
      if (def.paridadManual.clase === 'informativa') {
        // Un porqué vacío es una omisión con otra cara: la razón se escribe o no se declara.
        expect(def.paridadManual.porque.trim().length, `${cap} se declara informativa sin decir por qué`).toBeGreaterThan(40);
      }
    }
  });

  it('la puerta manual que cada capacidad nombra existe y se exporta', () => {
    const conEscritura = CAPACIDADES_ACTIVAS.filter(
      (c) => CAPACIDADES[c].paridadManual.clase === 'escritura',
    );
    expect(conEscritura.length, 'ninguna capacidad declaró escritura: el censo no mira nada').toBeGreaterThan(0);

    for (const cap of conEscritura) {
      const paridad = CAPACIDADES[cap].paridadManual;
      if (paridad.clase !== 'escritura') continue;
      // Una secuencia vacía sería «no hay puerta» disfrazado de declaración cumplida.
      expect(paridad.pasos.length, `${cap} declara escritura sin un solo paso`).toBeGreaterThan(0);
      for (const paso of paridad.pasos) {
        const modulo = resolver(`${raiz}/src/lib/ai/ai.schemas.ts`, paso.modulo);
        expect(modulo, `${cap}: el módulo ${paso.modulo} no existe`).not.toBeNull();
        expect(
          [...exportadasDe(modulo!)].includes(paso.funcion),
          `${cap}: ${paso.modulo} no exporta ${paso.funcion}`,
        ).toBe(true);
      }
    }
  });

  /**
   * Y LA MITAD QUE DE VERDAD CUESTA: que la SECUENCIA manual cubra lo que la materialización hace.
   *
   * Esta sonda ha fallado tres veces contra sí misma, y cada corrección la acercó a lo que RF-08.6
   * pide de verdad. Vale la pena dejar las tres escritas, porque son la misma clase de error:
   *
   *  1. Sembraba en el MÓDULO, no en la función declarada. CI declaraba `crearItem` —que inserta
   *     `item_importacion`— y pasaba porque `aprobarItem`, en el mismo fichero, escribe evidencia.
   *  2. Admitía «insert **o** update» sobre la tabla. C7 declaraba `abrirOutcomeReview`, que abre
   *     la fila vacía, y pasaba porque INSERTA — mientras la materialización hace un `update`.
   *  3. Y se daba por satisfecha con la escritura RAÍZ. C2 declaraba sólo `crearInsight`, cuando
   *     materializar un insight escribe además sus afirmaciones, sus citas y sus contradicciones:
   *     borrar `agregarCita` dejaba esto verde con la paridad ya rota.
   *
   * Las tres veces el censo comprobaba algo casi siempre cierto, que es la forma que tiene un
   * censo de no servir. Lo que se exige ahora se DERIVA del materializador: qué tablas escribe y
   * con qué verbo, siguiendo sus llamadas. La secuencia declarada tiene que cubrir ese conjunto.
   *
   * Nada de esto se escribe a mano. Ni qué materializa cada capacidad —se busca el materializador
   * que alcanza la tabla del destino—, ni qué escribe, ni con qué verbo.
   */
  it('la secuencia manual cubre todo lo que la materialización escribe', () => {
    const servicioAI = `${raiz}/src/lib/ai/ai.servicio.ts`;

    /** Las funciones de un fichero por nombre: `function f()` y `const f = …`. */
    const funcionesDe = (arbol: ts.SourceFile): Map<string, ts.Node> => {
      const m = new Map<string, ts.Node>();
      for (const st of arbol.statements) {
        if (ts.isFunctionDeclaration(st) && st.name) m.set(st.name.text, st);
        else if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.initializer) m.set(d.name.text, d.initializer);
          }
        }
      }
      return m;
    };

    /** Qué nombre viene de qué módulo, para saltar de fichero por la llamada. */
    const importesDe = (
      arbol: ts.SourceFile,
      f: string,
    ): Map<string, { modulo: string; original: string }> => {
      const m = new Map<string, { modulo: string; original: string }>();
      for (const st of arbol.statements) {
        if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
        const destino = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
        if (!destino) continue;
        const b = st.importClause?.namedBindings;
        /*
         * Se guarda el nombre LOCAL como clave y el ORIGINAL como destino, que es la corrección
         * de una revisión: con `import { escribirRevisionSimulada as persistirRevision }`, quien
         * llama escribe `persistirRevision` pero el módulo de destino indexa por el nombre con
         * el que la función se declaró. Guardando sólo el local, el recorrido llegaba al fichero
         * correcto, no encontraba nada con ese nombre y se paraba — declarando incumplida una
         * paridad que un renombrado inocuo no había tocado.
         */
        if (b && ts.isNamedImports(b)) {
          for (const e of b.elements) {
            if (e.isTypeOnly) continue;
            m.set(e.name.text, { modulo: destino, original: (e.propertyName ?? e.name).text });
          }
        }
        if (st.importClause?.name) {
          m.set(st.importClause.name.text, { modulo: destino, original: 'default' });
        }
      }
      return m;
    };

    /**
     * EL SQL DE UNA FUNCIÓN, leído de sus PLANTILLAS ETIQUETADAS y no de su texto.
     *
     * `decl.getText()` incluye comentarios y literales corrientes, así que un comentario que
     * dijera «insert into cita» contaba como escritura. Lo señaló una revisión, y el modo de
     * fallo que describe es el peor de todos: borrar el SQL de verdad y dejar el comentario que
     * lo explicaba mantiene la invariante en verde justo cuando la operación ha desaparecido.
     *
     * Se recogen los `tx\`…\`` y equivalentes. Las plantillas anidadas dentro de un `${…}` se
     * visitan por su cuenta al recorrer el árbol, así que no se pierden.
     */
    const sqlDe = (n: ts.Node): string[] => {
      const trozos: string[] = [];
      const ver = (x: ts.Node): void => {
        if (ts.isTaggedTemplateExpression(x)) trozos.push(x.template.getText());
        ts.forEachChild(x, ver);
      };
      ver(n);
      return trozos;
    };

    /**
     * A dónde manda un módulo que RE-EXPORTA el nombre buscado, con nombre o con comodín.
     *
     * Sin esto, un barrel legítimo rompía el recorrido: se sembraba el nombre en el barrel,
     * `funcionesDe` no encontraba allí ninguna declaración y el censo concluía que la secuencia
     * no cubría nada. Es el mismo error que el de los alias, un fichero más allá.
     *
     * Y las DOS formas, porque atender sólo la de nombre dejaba a las dos mitades de este
     * fichero en desacuerdo sobre qué es un barrel: la sonda de existencia sigue `export * from`
     * desde que se escribió, y este recorrido no lo hacía. Un módulo declarado que fuera un
     * comodín pasaba la existencia y luego se leía como si no escribiera nada — o sea, rechazaba
     * una paridad intacta, que es el mismo modo de fallo que el alias sin resolver.
     *
     * El comodín re-exporta con el MISMO nombre, así que el símbolo no cambia; lo que hay que
     * decidir es CUÁL de los comodines lo trae, y eso lo contesta `exportadasDe` — el
     * reconocedor de la otra mitad, que es justamente lo que las pone de acuerdo.
     */
    const reexportDe = (
      arbol: ts.SourceFile,
      f: string,
      nombre: string,
    ): { modulo: string; original: string } | null => {
      const comodines: string[] = [];
      for (const st of arbol.statements) {
        if (!ts.isExportDeclaration(st) || !st.moduleSpecifier) continue;
        const destino = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
        if (!destino) continue;
        if (!st.exportClause) {
          comodines.push(destino);
          continue;
        }
        if (!ts.isNamedExports(st.exportClause)) continue;
        for (const e of st.exportClause.elements) {
          if (e.name.text !== nombre) continue;
          return { modulo: destino, original: (e.propertyName ?? e.name).text };
        }
      }
      for (const destino of comodines) {
        if (exportadasDe(destino).has(nombre)) return { modulo: destino, original: nombre };
      }
      return null;
    };

    const llamadasEn = (n: ts.Node): string[] => {
      const nombres: string[] = [];
      const ver = (x: ts.Node): void => {
        if (ts.isCallExpression(x)) {
          if (ts.isIdentifier(x.expression)) nombres.push(x.expression.text);
          else if (ts.isPropertyAccessExpression(x.expression)) nombres.push(x.expression.name.text);
        }
        ts.forEachChild(x, ver);
      };
      ts.forEachChild(n, ver);
      return nombres;
    };

    /*
     * LAS TABLAS DE LA PROPIA CAPA AI, que no tienen equivalente manual por definición.
     *
     * `llamada_ai` y `propuesta_ai` son la contabilidad del pipeline: sin AI no hay llamada que
     * anotar ni propuesta que decidir. `evento_dominio` es la traza, y la escribe quien actúe —
     * exigir que las dos rutas escriban los mismos eventos no es lo que RF-08.6 pide.
     *
     * Es la única lista escrita a mano de esta sonda, así que se comprueba abajo que ninguna de
     * ellas sea la tabla de un destino: una exclusión que tapara un destino haría verde justo lo
     * que este censo existe para ver.
     */
    const CONTABILIDAD_AI = ['llamada_ai', 'propuesta_ai', 'evento_dominio'];

    /** El conjunto «verbo tabla» alcanzable desde una función, siguiendo sus llamadas. */
    const cacheDeEscrituras = new Map<string, Set<string>>();
    const escriturasDesde = (modulo: string, funcion: string): Set<string> => {
      const memo = cacheDeEscrituras.get(`${modulo}#${funcion}`);
      if (memo) return memo;
      const escrituras = new Set<string>();
      const visto = new Set<string>();
      const cola = [{ modulo, funcion }];
      while (cola.length > 0) {
        const actual = cola.shift()!;
        const clave = `${actual.modulo}#${actual.funcion}`;
        if (visto.has(clave)) continue;
        visto.add(clave);
        const arbol = leer(actual.modulo);
        const decl = funcionesDe(arbol).get(actual.funcion);
        if (!decl) {
          // Puede que el módulo sólo la RE-EXPORTE: se sigue hasta donde se declara.
          const via = reexportDe(arbol, actual.modulo, actual.funcion);
          if (via) cola.push({ modulo: via.modulo, funcion: via.original });
          // Y si tampoco es eso, el nombre no resuelve a una función de este repositorio —puede
          // venir de una librería—. No es un fallo: simplemente no hay por dónde seguir.
          continue;
        }
        for (const sql of sqlDe(decl)) {
          for (const [, verbo, tabla] of sql.matchAll(/(insert\s+into|update)\s+([a-z_]+)/gi)) {
            if (CONTABILIDAD_AI.includes(tabla!)) continue;
            escrituras.add(`${verbo!.toLowerCase().replace(/\s+/g, ' ')} ${tabla!}`);
          }
        }
        const imports = importesDe(arbol, actual.modulo);
        const locales = funcionesDe(arbol);
        for (const nombre of llamadasEn(decl)) {
          const importado = imports.get(nombre);
          if (importado) cola.push({ modulo: importado.modulo, funcion: importado.original });
          else if (locales.has(nombre)) cola.push({ modulo: actual.modulo, funcion: nombre });
        }
      }
      cacheDeEscrituras.set(`${modulo}#${funcion}`, escrituras);
      return escrituras;
    };

    // Los materializadores, derivados del fichero y no de una lista: `materializarAlgo`.
    const materializadores = [...funcionesDe(leer(servicioAI)).keys()].filter((n) =>
      /^materializar[A-Z]/.test(n),
    );
    expect(materializadores.length, 'no se encontró ningún materializador').toBeGreaterThan(3);

    const conDestino = CAPACIDADES_ACTIVAS.filter((c) => CAPACIDADES[c].destino !== null);
    for (const cap of conDestino) {
      const def = CAPACIDADES[cap];
      const tabla = tablaDelDestino(def.destino!);
      expect(
        CONTABILIDAD_AI.includes(tabla),
        `la exclusión de contabilidad AI tapa «${tabla}», que es el destino de ${cap}`,
      ).toBe(false);

      // QUIÉN materializa esta capacidad: el que alcanza la tabla de su destino. No una lista.
      const suyos = materializadores.filter((m) =>
        [...escriturasDesde(servicioAI, m)].some((e) => e.endsWith(` ${tabla}`)),
      );
      expect(suyos, `no hay UN materializador que escriba «${tabla}»`).toHaveLength(1);

      const exigido = escriturasDesde(servicioAI, suyos[0]!);
      expect(exigido.size, `${cap}: el materializador no escribe nada, no hay qué exigir`).toBeGreaterThan(0);

      if (def.paridadManual.clase !== 'escritura') continue;
      const cubierto = new Set<string>();
      for (const paso of def.paridadManual.pasos) {
        const m = resolver(`${raiz}/src/lib/ai/ai.schemas.ts`, paso.modulo);
        expect(m, `${cap}: el módulo ${paso.modulo} no existe`).not.toBeNull();
        for (const e of escriturasDesde(m!, paso.funcion)) cubierto.add(e);
      }
      const faltan = [...exigido].filter((e) => !cubierto.has(e)).sort();
      expect(
        faltan,
        `${cap}: la secuencia manual (${def.paridadManual.pasos.map((x) => x.funcion).join(' → ')}) no cubre lo que ${suyos[0]} escribe`,
      ).toEqual([]);
    }
  });
});
