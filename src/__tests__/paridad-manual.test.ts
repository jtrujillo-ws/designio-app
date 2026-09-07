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

  const leer = (f: string): ts.SourceFile => {
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
    return arbol;
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
      const modulo = resolver(`${raiz}/src/lib/ai/ai.schemas.ts`, paridad.modulo);
      expect(modulo, `${cap}: el módulo ${paridad.modulo} no existe`).not.toBeNull();

      const exportadas = new Set<string>();
      for (const st of leer(modulo!).statements) {
        if (!ts.isFunctionDeclaration(st) || !st.name) continue;
        const exportada = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (exportada) exportadas.add(st.name.text);
      }
      expect(
        [...exportadas].includes(paridad.funcion),
        `${cap}: ${paridad.modulo} no exporta ${paridad.funcion}`,
      ).toBe(true);
    }
  });

  /**
   * Y LA MITAD QUE DE VERDAD CUESTA: que ESA FUNCIÓN escriba el destino.
   *
   * La primera versión de esta sonda sembraba el recorrido en el MÓDULO y no en la función
   * declarada, y una revisión la tumbó con dos falsos positivos de este mismo PR:
   *
   *  · CI declaraba `crearItem`, que inserta `item_importacion`. El `insert into evidencia` está
   *    en `aprobarItem`, otra función del mismo fichero. El censo lo daba por bueno.
   *  · C7 declaraba `abrirOutcomeReview`, que abre la fila vacía. Lo que C7 materializa es el
   *    BORRADOR, con un `update outcome_review` — y eso lo hace `guardarBorradorReview`.
   *
   * O sea que el censo comprobaba que en algún punto del grafo alguien escribía la tabla, que es
   * casi siempre cierto y no dice nada: borrar la acción manual de verdad lo habría dejado verde.
   * Un censo que no puede fallar es peor que no tenerlo, porque además tranquiliza.
   *
   * Ahora se recorre el grafo de LLAMADAS desde la función declarada: su cuerpo, y de ahí a lo
   * que llama —local o importado— hasta encontrar la escritura. Sigue haciendo falta seguir el
   * grafo, y por el motivo de siempre: `escribirRevisionAMano` no escribe, delega en el escritor
   * que comparte con la materialización, que es como debe ser.
   *
   * Y la escritura es INSERT **o** UPDATE, porque materializar no siempre es crear una fila:
   * C7 rellena una que ya existe, exactamente igual que su ruta manual. Exigir un insert habría
   * declarado incumplida la paridad mejor emparejada de las siete.
   */
  it('desde esa puerta se alcanza la escritura del destino, siguiendo el grafo', () => {
    /** Las funciones declaradas en un fichero, por nombre: `function f()` y `const f = () => {}`. */
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

    /** Qué nombre viene de qué módulo, para saltar de un fichero a otro por la llamada. */
    const importesDe = (arbol: ts.SourceFile, f: string): Map<string, string> => {
      const m = new Map<string, string>();
      for (const st of arbol.statements) {
        if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
        const destino = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
        if (!destino) continue;
        const b = st.importClause?.namedBindings;
        if (b && ts.isNamedImports(b)) {
          for (const e of b.elements) if (!e.isTypeOnly) m.set(e.name.text, destino);
        }
        if (st.importClause?.name) m.set(st.importClause.name.text, destino);
      }
      return m;
    };

    /** Los nombres que un cuerpo LLAMA, que es por donde sigue el grafo. */
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

    /**
     * EL VERBO NO SE ELIGE: se deriva de cómo materializa la propia capa AI.
     *
     * Primero puse «insert **o** update», y la revisión que trajo este arreglo tenía razón en más
     * de lo que dijo: con esa laxitud, `abrirOutcomeReview` —que abre la fila vacía— seguía
     * pasando como paridad de C7, porque INSERTA la tabla. Lo comprobé neutralizando: verde.
     * Arreglé la declaración y la sonda seguía sin poder cazarla.
     *
     * La paridad que RF-08.6 pide es de FLUJO EQUIVALENTE, así que lo que hay que exigir es que
     * la puerta manual haga la misma clase de escritura que hace la materialización. Y eso no se
     * escribe a mano: se lee de `ai.servicio.ts`. Seis destinos se materializan con `insert into`
     * y `outcome_review` con `update`, que es justo la asimetría que se me escapó.
     *
     * Si algún día hubiera dos verbos distintos sobre la misma tabla, la derivación deja de ser
     * unívoca y esta sonda lo dice en vez de elegir uno.
     */
    const verboDeMaterializacion = (tabla: string): string => {
      const servicio = readFileSync(`${raiz}/src/lib/ai/ai.servicio.ts`, 'utf8');
      const hallados = [
        ...new Set(
          [...servicio.matchAll(new RegExp(`(insert\\s+into|update)\\s+${tabla}\\b`, 'gi'))].map((m) =>
            m[1]!.toLowerCase().replace(/\\s+/g, ' '),
          ),
        ),
      ];
      expect(
        hallados,
        `la materialización de «${tabla}» no se pudo derivar sin ambigüedad de ai.servicio.ts`,
      ).toHaveLength(1);
      return hallados[0]!;
    };

    const escribe = (texto: string, tabla: string, verbo: string): boolean =>
      new RegExp(`${verbo.replace(' ', '\\s+')}\\s+${tabla}\\b`, 'i').test(texto);

    let masLargo = 0;
    for (const cap of CAPACIDADES_ACTIVAS) {
      const def = CAPACIDADES[cap];
      if (def.paridadManual.clase !== 'escritura' || def.destino === null) continue;
      const tabla = tablaDelDestino(def.destino);
      const verbo = verboDeMaterializacion(tabla);
      const entrada = resolver(`${raiz}/src/lib/ai/ai.schemas.ts`, def.paridadManual.modulo);
      expect(entrada, `${cap}: módulo irresoluble`).not.toBeNull();

      const visto = new Set<string>();
      const cola: { modulo: string; funcion: string }[] = [
        { modulo: entrada!, funcion: def.paridadManual.funcion },
      ];
      let alcanza = false;
      let pasos = 0;
      while (cola.length > 0 && !alcanza) {
        const { modulo, funcion } = cola.shift()!;
        const clave = `${modulo}#${funcion}`;
        if (visto.has(clave)) continue;
        visto.add(clave);
        const arbol = leer(modulo);
        const decl = funcionesDe(arbol).get(funcion);
        // Un nombre que no resuelve a una función de este repositorio no es un fallo: puede ser
        // un helper de una librería. Simplemente no hay por dónde seguir por ahí.
        if (!decl) continue;
        pasos += 1;
        if (escribe(decl.getText(), tabla, verbo)) {
          alcanza = true;
          break;
        }
        const imports = importesDe(arbol, modulo);
        const locales = funcionesDe(arbol);
        for (const nombre of llamadasEn(decl)) {
          if (imports.has(nombre)) cola.push({ modulo: imports.get(nombre)!, funcion: nombre });
          else if (locales.has(nombre)) cola.push({ modulo, funcion: nombre });
        }
      }
      masLargo = Math.max(masLargo, pasos);
      expect(
        alcanza,
        `${cap}: desde ${def.paridadManual.modulo}#${def.paridadManual.funcion} no se alcanza «${verbo} ${tabla}» —el mismo verbo con el que la capa AI lo materializa— por ninguna llamada`,
      ).toBe(true);
    }

    /*
     * Que el recorrido haya SALTADO de una función a otra en algún caso, o esto no estaría
     * probando que sepa seguir llamadas y un resolutor roto pasaría con todo verde. C4 es la que
     * lo obliga: `escribirRevisionAMano` delega en el escritor que comparte con la
     * materialización, y es el caso por el que este grafo existe en vez de leer un cuerpo.
     */
    expect(
      masLargo,
      'ninguna paridad necesitó saltar de una función a otra: el grafo de llamadas no se ejercita',
    ).toBeGreaterThan(1);
  });
});
