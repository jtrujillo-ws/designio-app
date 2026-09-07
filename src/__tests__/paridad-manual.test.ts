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

  /*
   * Y QUE SE PUEDA INVOCAR, no sólo que el nombre esté exportado.
   *
   * `export const guardar = persistir()` exporta una PROMESA —el resultado de una llamada que
   * ocurrió UNA vez al cargar el módulo—, no algo que una pantalla pueda llamar. Y el recorrido
   * de escrituras llegaba igual hasta `persistir` y acreditaba su SQL, así que las dos
   * aserciones pasaban sobre una puerta que no existe. SYS-21 pide que la operación sea
   * EJECUTABLE; esto es lo que lo comprueba.
   *
   * Lo invocable aquí son dos formas y ninguna más: una función literal, y la CADENA con la que
   * este repositorio declara una server function —`createServerFn({…}).inputValidator(…)
   * .handler(fn)`—, reconocida por la raíz de la cadena y por el import que la trae. Lo demás
   * no se acepta en silencio: se nombra.
   */
  const CONSTRUCTOR_DE_SERVER_FN = 'createServerFn';
  const MODULO_DE_SERVER_FN = '@tanstack/react-start';
  const traeElConstructor = (arbol: ts.SourceFile): boolean =>
    arbol.statements.some((st) => {
      if (!ts.isImportDeclaration(st)) return false;
      if ((st.moduleSpecifier as ts.StringLiteral).text !== MODULO_DE_SERVER_FN) return false;
      const b = st.importClause?.namedBindings;
      return (
        b !== undefined &&
        ts.isNamedImports(b) &&
        b.elements.some((e) => e.name.text === CONSTRUCTOR_DE_SERVER_FN)
      );
    });
  const raizDeLaCadena = (x: ts.Expression): ts.Expression => {
    let a: ts.Expression = x;
    for (;;) {
      if (ts.isCallExpression(a) || ts.isPropertyAccessExpression(a)) {
        a = a.expression;
        continue;
      }
      return a;
    }
  };
  const invocable = (f: string, nombre: string, saltos = 0): boolean => {
    if (saltos > 6) return false;
    const arbol = leer(f);
    let decl: ts.Node | null = null;
    for (const st of arbol.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === nombre) decl = st;
      else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === nombre && d.initializer) {
            decl = d.initializer;
          }
        }
      } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
        // Un barrel legítimo: se sigue hasta donde se declara, con nombre o con comodín.
        const destino = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
        if (destino === null) continue;
        if (st.exportClause === undefined) {
          if (invocable(destino, nombre, saltos + 1)) return true;
        } else if (ts.isNamedExports(st.exportClause)) {
          for (const e of st.exportClause.elements) {
            if (e.name.text !== nombre) continue;
            if (invocable(destino, (e.propertyName ?? e.name).text, saltos + 1)) return true;
          }
        }
      }
    }
    if (decl === null) return false;
    let x: ts.Node = decl;
    while (
      ts.isParenthesizedExpression(x) ||
      ts.isAsExpression(x) ||
      ts.isNonNullExpression(x)
    ) {
      x = x.expression;
    }
    if (ts.isFunctionDeclaration(x) || ts.isArrowFunction(x) || ts.isFunctionExpression(x)) {
      return true;
    }
    if (ts.isCallExpression(x)) {
      const r = raizDeLaCadena(x);
      return (
        ts.isIdentifier(r) && r.text === CONSTRUCTOR_DE_SERVER_FN && traeElConstructor(arbol)
      );
    }
    if (!ts.isIdentifier(x)) return false;
    // Un alias: local primero, y si no, por donde lo importen.
    const nom = x.text;
    for (const st of arbol.statements) {
      if (!ts.isImportDeclaration(st)) continue;
      const destino = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
      if (destino === null) continue;
      const b = st.importClause?.namedBindings;
      if (b === undefined || !ts.isNamedImports(b)) continue;
      for (const e of b.elements) {
        if (e.name.text === nom) return invocable(destino, (e.propertyName ?? e.name).text, saltos + 1);
      }
    }
    return invocable(f, nom, saltos + 1);
  };

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
        expect(
          invocable(modulo!, paso.funcion),
          `${cap}: ${paso.modulo} exporta ${paso.funcion}, pero no es algo que se pueda invocar`,
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
        /*
         * Una declaración por defecto SIN nombre —`export default function () {…}`, que es una
         * forma válida— no tiene con qué indexarse, y el recorrido llega buscando «default».
         * Sin esta entrada se paraba y daba por incumplida una ruta intacta.
         */
        if (
          ts.isFunctionDeclaration(st) &&
          !st.name &&
          st.modifiers?.some((x) => x.kind === ts.SyntaxKind.DefaultKeyword)
        ) {
          m.set('default', st);
        }
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
        /*
         * `import * as servicio from './servicio'` guarda el espacio con `'*'` por original.
         * Sin esto, `servicio.crear(…)` dejaba el recorrido a medias: `llamadasEn` saca el
         * nombre de la propiedad —`crear`— y el mapa no tenía nada que decir sobre `servicio`,
         * así que el barrido se paraba y daba por incumplida una ruta manual intacta. Es el
         * mismo fallo que el alias de import, con la otra forma de importar.
         */
        if (b && ts.isNamespaceImport(b)) m.set(b.name.text, { modulo: destino, original: '*' });
        if (st.importClause?.name) {
          m.set(st.importClause.name.text, { modulo: destino, original: 'default' });
        }
      }
      return m;
    };

    /**
     * SÓLO EL SQL: fuera sus comentarios y fuera el TEXTO de sus cadenas.
     *
     * Es el mismo agujero, dos veces más adentro. Limitar el barrido a las plantillas etiquetadas
     * dejó fuera los comentarios de TypeScript, pero no los de SQL: un `-- update outcome_review`
     * DENTRO de la plantilla contaba como escritura. Y quitados esos, seguía contando un
     * `select 'insert into cita'` — un texto de diagnóstico o de auditoría que nombra la
     * operación que ya no se hace.
     *
     * Las dos formas abren el mismo modo de fallo, que es el que este censo existe para impedir:
     * borrar la sentencia y dejar lo que la explicaba mantiene la invariante en verde. Las dos
     * reproducidas sobre `enlazarInsight` cambiando su tabla y dejando el nombre viejo, primero
     * en un comentario y luego en una cadena: verde las dos veces.
     *
     * De las cadenas se conservan las comillas y se tira el contenido, para no descolocar lo que
     * viene después: una lista de valores sigue teniendo el mismo número de elementos.
     *
     * CON UNA EXCEPCIÓN, y muy estrecha: una cadena que sea UNA SOLA PALABRA en minúsculas
     * —`'borrador'`, `'completado'`— se conserva entera. Es el valor de un estado, y sin él no
     * se puede decir si un `and estado = ${'${…}'}` de más acota o ANULA la sentencia. Lo que la
     * excepción no deja pasar es justo lo que hacía peligroso el contenido: ni espacios —así
     * `'update outcome_review'` no puede fingir una escritura, que hace falta el `\s+`—, ni
     * paréntesis, ni `--`, ni `$`, ni `:`, ni comas. Y las palabras clave que sí caben —`'and'`—
     * las lee cada rastreador dentro de sus comillas, porque todos llevan la cuenta de si van
     * por dentro de una cadena.
     *
     * Y las de DÓLAR cuentan igual: `select $$insert into cita$$` es la misma avería con la otra
     * forma de citar de Postgres. La apertura se reconoce como `$tag$` con etiqueta opcional, lo
     * que deja fuera los `$1` de los parámetros — una etiqueta no empieza por dígito—, aunque
     * aquí no aparecen: las interpolaciones ya llegan como testigo.
     */
    const soloSql = (t: string): string => {
      let fuera = '';
      let enCadena = false;
      let dentro = '';
      let cierreDolar: string | null = null;
      let i = 0;
      while (i < t.length) {
        const c = t[i]!;
        if (cierreDolar !== null) {
          if (t.startsWith(cierreDolar, i)) {
            fuera += cierreDolar;
            i += cierreDolar.length;
            cierreDolar = null;
          } else i += 1;
          continue;
        }
        const abre = c === '$' && !enCadena ? /^\$([A-Za-z_]\w*)?\$/.exec(t.slice(i)) : null;
        if (abre) {
          fuera += abre[0];
          cierreDolar = abre[0];
          i += abre[0].length;
          continue;
        }
        if (enCadena) {
          if (c === "'") {
            if (/^[a-z0-9_-]+$/.test(dentro)) fuera += dentro;
            fuera += c;
            enCadena = false;
            dentro = '';
          } else dentro += c;
          i += 1;
        } else if (c === "'") {
          fuera += c;
          enCadena = true;
          dentro = '';
          i += 1;
        } else if (c === '-' && t[i + 1] === '-') {
          while (i < t.length && t[i] !== '\n') i += 1;
        } else if (c === '/' && t[i + 1] === '*') {
          i += 2;
          while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i += 1;
          i += 2;
        } else {
          fuera += c;
          i += 1;
        }
      }
      return fuera;
    };

    /**
     * EL SQL DE UNA FUNCIÓN, leído de sus PLANTILLAS ETIQUETADAS y no de su texto.
     *
     * `decl.getText()` incluye comentarios y literales corrientes, así que un comentario que
     * dijera «insert into cita» contaba como escritura. Lo señaló una revisión, y el modo de
     * fallo que describe es el peor de todos: borrar el SQL de verdad y dejar el comentario que
     * lo explicaba mantiene la invariante en verde justo cuando la operación ha desaparecido.
     *
     * Se recogen los `tx\`…\`` y equivalentes, y de cada uno se recompone su SQL a partir de los
     * TROZOS LITERALES —la cabeza y lo que hay entre substituciones— con cada `${…}` sustituido
     * por un testigo. Es lo que hace fiable mirar las comillas: una interpolación puede llevar
     * un apóstrofo de JavaScript y ese apóstrofo no abre una cadena de SQL. Y se recompone en
     * vez de leer los trozos por separado porque una sentencia puede tener un `${…}` en medio
     * —la lista de columnas, sin ir más lejos— y partirla la dejaría a medias.
     *
     * Las plantillas anidadas dentro de un `${…}` se visitan por su cuenta al recorrer el árbol,
     * así que no se pierden.
     */
    /**
     * Cada `${…}` deja un testigo NUMERADO, y aparte se guardan los identificadores que hay
     * dentro de él. Sin eso, la comparación por columnas sólo puede mirar el destino: un
     * `contribucion = ${entrada.aprendizajes}` da el mismo conjunto de columnas que el correcto
     * y guarda el relato en el campo equivocado con el censo en verde.
     */
    type Consulta = { sql: string; campos: string[][]; etiqueta: string; tag: ts.Expression };

    /*
     * QUIÉN ETIQUETA LA PLANTILLA. Contando toda plantilla etiquetada, un `sqlText\`…\`` o un
     * `String.raw\`…\`` que formatee o registre una sentencia contaba como escritura: borrar la
     * consulta de verdad y dejar el texto formateado mantenía la invariante en verde.
     *
     * Se guarda el NODO de la etiqueta y no su texto: la ligadura se resuelve más abajo, ya con
     * el módulo delante. Mirar el texto —el último nombre tras los puntos— aceptaba un
     * `logger.sql\`…\`` o un `sql` local que tapara al importado, que es la misma avería con
     * otro disfraz. Lo que no resuelva a un cliente de la base no se ignora en silencio: tumba
     * el censo nombrando la etiqueta, y así pide una decisión en vez de contarla o perderla.
     */
    /**
     * EL NOMBRE QUE UNA EXPRESIÓN REASIGNA, si es que reasigna alguno.
     *
     * Vale para todo el rango de operadores de asignación —un `+=` cambia el valor igual que un
     * `=`— y para `++`/`--`. Lo usan las tres ligaduras que este censo sigue —la del valor de un
     * campo, la del cliente de la base y la del destino de una llamada—, porque las tres se
     * apoyaban en el inicializador de la declaración y ninguna miraba lo que pasaba después.
     */
    const nombreReasignado = (y: ts.Node): ts.Identifier | null => {
      if (
        ts.isBinaryExpression(y) &&
        y.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        y.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(y.left)
      ) {
        return y.left;
      }
      if (
        (ts.isPrefixUnaryExpression(y) || ts.isPostfixUnaryExpression(y)) &&
        (y.operator === ts.SyntaxKind.PlusPlusToken ||
          y.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(y.operand)
      ) {
        return y.operand;
      }
      return null;
    };
    const etiquetasDesconocidas = new Set<string>();
    const callbacksSinInvocar = new Set<string>();
    const predicadosSinColumna = new Set<string>();
    const conjuntosImposibles = new Set<string>();
    const origenesSinLeer = new Set<string>();
    const testigo = (k: number): string => ` :i${k} `;

    /**
     * EL RECORRIDO DE LO QUE SIGUE VIVO DENTRO DE UNA FUNCIÓN.
     *
     * No se baja a un ayudante anidado con NOMBRE al que ya no llama nadie. El descenso era
     * incondicional, así que dejar `const persistir = () => tx\`…\`` declarado y quitar su
     * llamada mantenía la escritura contada — la operación desaparecida y el censo en verde.
     * Se mira si el nombre aparece en algún otro sitio del cuerpo: sólo se baja si sí.
     *
     * A las funciones anidadas SIN nombre se baja cuando QUIEN LAS RECIBE LAS EJECUTA. Bajar a
     * todas era lo mismo que contar toda mención: un manejador que se limitara a GUARDAR o a
     * REGISTRAR un `async () => await tx\`…\`` —sin llegar a llamarlo— seguía aportando su
     * escritura, así que borrar la persistencia de verdad dejaba la paridad en verde.
     *
     * Quién las ejecuta se lee de la LLAMADA que las recibe, y la lista sale del código, no de
     * una conjetura: `conUsuario(actorId, async (tx) => …)` —el único camino a la base—, el
     * `.handler(…)` con el que este repositorio escribe cada función de servidor, y los métodos
     * de `Array`/`String` que llaman a lo que se les pasa. Lo que no esté en esa lista no se
     * cuenta, y si lleva una plantilla dentro se NOMBRA al final: pide una decisión en vez de
     * contarla en silencio.
     *
     * Un nodo función-like SIN cuerpo es un TIPO —`(cb: (t: T) => void)`—, y un tipo no ejecuta
     * nada: se salta sin más.
     *
     * Y ES UN SOLO RECORRIDO porque la primera versión de esta regla vivía únicamente en la
     * lectura del SQL, y la de las llamadas seguía bajando a todas partes: un ayudante muerto
     * que en vez de traer el SQL DELEGARA en otro módulo seguía arrastrando su escritura. Una
     * regla en dos sitios se aplica en uno.
     *
     * La vida se deriva de lo ALCANZABLE y no de contar apariciones, que fue la primera versión
     * y no bastaba: dos ayudantes muertos que se nombraran entre sí —o uno recursivo— llegaban
     * a dos apariciones y pasaban por vivos. Se parte de lo que se nombra FUERA de todo cuerpo
     * con nombre y se expande por punto fijo: sólo entra el que alguien vivo nombra.
     */
    /**
     * LOS AYUDANTES QUE SE PASAN A QUIEN LOS EJECUTA TAMBIÉN SE LLAMAN.
     *
     * `items.map(persistir)` ejecuta `persistir` sin que su nombre aparezca nunca como
     * callee, y yo lo había dejado dicho como límite —«se leería como muerto, y eso sale
     * ROJO»—. Es cierto para las escrituras, donde perder una arista deja una escritura sin
     * cubrir; pero la comprobación de SYS-21 pregunta lo CONTRARIO —que la ruta manual NO
     * alcance al proveedor— y ahí perder una arista sale VERDE. La misma ceguera con el signo
     * cambiado: `await Promise.all(items.map(generarConProveedor))` llamaba al proveedor con
     * la invariante tranquila.
     *
     * Así que un identificador pasado como argumento a alguien de la lista de abajo cuenta
     * como llamada. La lista es la misma que decide si se baja a un callback anónimo, y por
     * el mismo motivo: es lo que este repositorio usa para ejecutar lo que recibe.
     */
    const argumentosEjecutados = (x: ts.CallExpression): ts.Expression[] => {
      const q = x.expression;
      const quien = ts.isPropertyAccessExpression(q)
        ? q.name.text
        : ts.isIdentifier(q)
          ? q.text
          : null;
      const posiciones = quien === null ? undefined : EJECUTAN_SU_CALLBACK.get(quien);
      if (posiciones === undefined) return [];
      // El nombre a secas y el acceso a propiedad: `map(persistir)` y
      // `map(proveedor.generar)` ejecutan lo mismo, y quedarse con el primero dejaba
      // al espacio de nombres —la forma normal de llamar a otro módulo— fuera del grafo.
      return posiciones
        .map((k) => x.arguments[k])
        .filter(
          (a): a is ts.Expression =>
            a !== undefined && (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)),
        );
    };

    /*
     * Y en QUÉ POSICIÓN va el callback de cada uno. Aceptando cualquier argumento, un
     * `items.reduce((acc) => acc, persistir)` —donde `persistir` es el acumulador inicial, no
     * una función que se llame— daba por vivo al ayudante y contaba su SQL. Cada API dice
     * dónde recibe lo que ejecuta, y lo que llegue en otra posición no cuenta.
     */
    const EJECUTAN_SU_CALLBACK = new Map<string, number[]>([
      // El único camino de este repositorio a la base, y el cuerpo de cada función de servidor.
      ['conUsuario', [1]],
      ['handler', [0]],
      // Y los métodos que llaman a lo que reciben, cada uno donde lo recibe.
      ['map', [0]],
      ['flatMap', [0]],
      ['filter', [0]],
      ['forEach', [0]],
      ['find', [0]],
      ['findLast', [0]],
      ['findIndex', [0]],
      ['some', [0]],
      ['every', [0]],
      ['reduce', [0]],
      ['sort', [0]],
      ['replace', [1]],
      ['then', [0, 1]],
      ['catch', [0]],
      ['finally', [0]],
    ]);
    /*
     * Y HAY QUIEN ESPERA LO QUE SU CALLBACK DEVUELVE, no sólo quien lo llama. `conUsuario` hace
     * `return fn(tx)` dentro de un callback asíncrono que `begin` espera, así que la promesa de
     * la consulta se ASIMILA: un `(tx) => tx\`insert …\`` de cuerpo corto SÍ sale hacia la base
     * aunque la flecha no sea `async`.
     *
     * Sin esto, reescribir `async (tx) => { await tx\`…\` }` como `(tx) => tx\`…\`` —que hace
     * exactamente lo mismo— ponía el censo en rojo sobre una ruta intacta. Un rechazo falso no
     * es el modo de fallo menor: es el que enseña a desconfiar de la sonda.
     *
     * La lista es corta a propósito: `map` o `forEach` reciben lo que llaman y TIRAN lo que
     * devuelve, así que ahí un cuerpo corto sigue sin ejecutarse.
     */
    const asimilaLoQueDevuelve = (quien: string): boolean => quien === ENTREGA_LA_TRANSACCION;
    /** Si la función que envuelve a la plantilla la entrega a alguien que ESPERA su vuelta. */
    const laEsperaQuienLaRecibe = (f: ts.Node): boolean => {
      const recibe = f.parent as ts.Node | undefined;
      if (recibe === undefined || !ts.isCallExpression(recibe)) return false;
      const q = recibe.expression;
      const quien = ts.isPropertyAccessExpression(q)
        ? q.name.text
        : ts.isIdentifier(q)
          ? q.text
          : null;
      if (quien === null || !asimilaLoQueDevuelve(quien)) return false;
      const posiciones = EJECUTAN_SU_CALLBACK.get(quien);
      return (
        posiciones !== undefined &&
        posiciones.includes(recibe.arguments.indexOf(f as unknown as ts.Expression))
      );
    };

    /** Si quien recibe una función anónima la ejecuta. Lo que no, se nombra si lleva SQL. */
    const laEjecutaQuienLaRecibe = (x: ts.Node): boolean => {
      // Un nodo función-like sin cuerpo es un TIPO: no ejecuta nada y no hay nada que decir.
      const cuerpo = (x as ts.FunctionLikeDeclaration).body;
      if (cuerpo === undefined) return false;
      const nombrarSiLleva = (donde: ts.Node, quien: string): void => {
        let conSql = false;
        const buscar = (z: ts.Node): void => {
          if (ts.isTaggedTemplateExpression(z)) conSql = true;
          if (!conSql) ts.forEachChild(z, buscar);
        };
        buscar(donde);
        if (conSql) callbacksSinInvocar.add(quien);
      };
      const recibe = x.parent as ts.Node | undefined;
      if (
        recibe === undefined ||
        !ts.isCallExpression(recibe) ||
        !recibe.arguments.includes(x as unknown as ts.Expression)
      ) {
        nombrarSiLleva(x, recibe === undefined ? '(sin padre)' : `${ts.SyntaxKind[recibe.kind]}`);
        return false;
      }
      const q = recibe.expression;
      const quien = ts.isPropertyAccessExpression(q)
        ? q.name.text
        : ts.isIdentifier(q)
          ? q.text
          : null;
      const posiciones = quien === null ? undefined : EJECUTAN_SU_CALLBACK.get(quien);
      if (posiciones !== undefined && posiciones.includes(recibe.arguments.indexOf(x as unknown as ts.Expression))) {
        return true;
      }
      nombrarSiLleva(x, `${quien ?? q.getText().slice(0, 40)}(…)`);
      return false;
    };

    const recorrerVivo = (n: ts.Node, visitar: (x: ts.Node) => void): void => {
      /** El nombre con el que se declara una función anidada, si lo tiene. */
      const nombreDe = (x: ts.Node): string | null => {
        if (ts.isFunctionDeclaration(x)) return x.name?.text ?? null;
        const padre = x.parent as ts.Node | undefined;
        if (
          padre &&
          ts.isVariableDeclaration(padre) &&
          padre.initializer === x &&
          ts.isIdentifier(padre.name)
        ) {
          return padre.name.text;
        }
        return null;
      };

      /**
       * Y el cuerpo que un nombre resuelve DESDE EL SITIO donde se le llama, por ligadura
       * léxica. Un mapa único por nombre para toda la función no es una ligadura: con un
       * `persistir` muerto arriba —conservado para un log— y OTRO `persistir` declarado y
       * llamado dentro de un ámbito anidado, la llamada del segundo daba por vivo al primero
       * y su SQL seguía contando. Es el mismo error que ya costó las sombras en las llamadas,
       * un ámbito más adentro.
       */
      const declaradaEn = (ambito: ts.Node, nombre: string): ts.Node | null => {
        if (!ts.isBlock(ambito) && !ts.isSourceFile(ambito)) return null;
        for (const st of ambito.statements) {
          if (ts.isFunctionDeclaration(st) && st.name?.text === nombre) return st;
          if (!ts.isVariableStatement(st)) continue;
          for (const d of st.declarationList.declarations) {
            if (
              ts.isIdentifier(d.name) &&
              d.name.text === nombre &&
              d.initializer &&
              ts.isFunctionLike(d.initializer)
            ) {
              return d.initializer;
            }
          }
        }
        return null;
      };
      const cuerpoDesde = (donde: ts.Node, nombre: string): ts.Node | null => {
        let a: ts.Node | undefined = donde;
        while (a !== undefined) {
          const hallada = declaradaEn(a, nombre);
          if (hallada !== null) return hallada;
          a = a.parent as ts.Node | undefined;
        }
        return null;
      };

      /**
       * Lo que una región LLAMA, sin entrar en los cuerpos con nombre que haya dentro.
       *
       * Llamar y nombrar no son lo mismo: con `console.debug(persistir)` y sin la llamada real,
       * contar toda mención daba por vivo al ayudante y su SQL seguía sumando. Sólo cuenta
       * aparecer como CALLEE, que es lo único que lo ejecuta.
       *
       * El límite, dicho: un ayudante que sólo se pasara como callback —`items.map(persistir)`—
       * se leería como muerto. Medido, hoy ninguna de las siete secuencias lo hace, y ese fallo
       * sale ROJO y nombrando la escritura que falta, no verde: pide una decisión en vez de
       * tranquilizar.
       */
      const nombraA = (region: ts.Node): { nombre: string; donde: ts.Node }[] => {
        const nombres: { nombre: string; donde: ts.Node }[] = [];
        const ver = (x: ts.Node): void => {
          if (x !== region && ts.isFunctionLike(x) && nombreDe(x) !== null) return;
          if (ts.isCallExpression(x)) {
            if (ts.isIdentifier(x.expression)) {
              nombres.push({ nombre: x.expression.text, donde: x });
            }
            for (const a of argumentosEjecutados(x)) {
              // Para la VIDA sólo cuenta el nombre a secas: un ayudante local no se declara
              // detrás de un punto.
              if (ts.isIdentifier(a)) nombres.push({ nombre: a.text, donde: a });
            }
          }
          ts.forEachChild(x, ver);
        };
        ver(region);
        return nombres;
      };

      // El punto fijo se expande sobre CUERPOS, no sobre nombres: dos ayudantes homónimos en
      // ámbitos distintos son dos cosas distintas, y sólo vive el que alguien vivo llama.
      const vivas = new Set<ts.Node>();
      const cola = nombraA(n);
      while (cola.length > 0) {
        const { nombre, donde } = cola.shift()!;
        const cuerpo = cuerpoDesde(donde, nombre);
        if (cuerpo === null || vivas.has(cuerpo)) continue;
        vivas.add(cuerpo);
        cola.push(...nombraA(cuerpo));
      }

      const ver = (x: ts.Node): void => {
        if (x !== n && ts.isFunctionLike(x)) {
          const nombre = nombreDe(x);
          if (nombre !== null && !vivas.has(x)) return;
          if (nombre === null && !laEjecutaQuienLaRecibe(x)) return;
        }
        visitar(x);
        ts.forEachChild(x, ver);
      };
      ver(n);
    };

    const sqlDe = (n: ts.Node): Consulta[] => {
      /**
       * Los nombres que se consumen —aparecen dentro de un `await` o de un `return`— y EN QUÉ
       * función, que es lo que hace útil la cuenta. Un `return conUsuario(actorId, async (tx) =>
       * {…})` envuelve el cuerpo entero en un `return`; sin cortar en la frontera de la función
       * anidada, todo lo que hay dentro contaba como consumido y la comprobación no medía nada.
       */
      const funcionDe = (y: ts.Node): ts.Node => {
        let a: ts.Node | undefined = y.parent as ts.Node | undefined;
        while (a !== undefined && !ts.isFunctionLike(a)) a = a.parent as ts.Node | undefined;
        return a ?? n;
      };
      /**
       * Y QUÉ NOMBRE SE CONSUME DE VERDAD. Recoger todo identificador que hubiera debajo de un
       * `await` o de un `return` daba por disparada la consulta con un `await
       * console.debug(pendiente)`: ahí el `await` espera lo que devuelve `console.debug`
       * —`undefined`—, la consulta perezosa no sale nunca, y borrar la escritura de verdad
       * dejaba la invariante en verde. Se recoge sólo el valor que LLEGA al `await` o al
       * `return`, atravesando lo que no lo consume —paréntesis, `as`, `!`— y el
       * `Promise.all([…])` de las que se esperan juntas, que sí las dispara todas.
       *
       * El límite, dicho: pasar la consulta a otra función que la espere —`await
       * ejecutar(pendiente)`— se lee como no consumida. Medido, hoy ninguna de las nueve
       * secuencias lo hace, y ese fallo sale ROJO nombrando la escritura que falta: pide una
       * decisión en vez de tranquilizar.
       */
      const esperaConjunta = (x: ts.CallExpression): boolean =>
        ts.isPropertyAccessExpression(x.expression) &&
        ts.isIdentifier(x.expression.expression) &&
        x.expression.expression.text === 'Promise' &&
        ['all', 'allSettled', 'race', 'any'].includes(x.expression.name.text);
      const valorConsumido = (
        e: ts.Expression | undefined,
        set: Set<string>,
        enLista = false,
      ): void => {
        if (e === undefined) return;
        let x: ts.Expression = e;
        while (
          ts.isParenthesizedExpression(x) ||
          ts.isAsExpression(x) ||
          ts.isNonNullExpression(x)
        ) {
          x = x.expression;
        }
        if (ts.isIdentifier(x)) {
          set.add(x.text);
          return;
        }
        if (ts.isAwaitExpression(x)) {
          valorConsumido(x.expression, set);
          return;
        }
        if (ts.isCallExpression(x) && esperaConjunta(x)) {
          for (const a of x.arguments) valorConsumido(a, set, true);
          return;
        }
        // Una lista sólo entrega sus elementos DENTRO de esa espera conjunta: un `return [q]`
        // devuelve la consulta sin ejecutar, y contarlo sería el mismo agujero otra vez.
        if (enLista && ts.isArrayLiteralExpression(x)) {
          for (const el of x.elements) valorConsumido(el, set, true);
        }
      };
      /*
       * Y el consumo se apunta contra la DECLARACIÓN, no contra el texto del nombre. Un
       * conjunto de cadenas por función confunde dos ámbitos hermanos: con un
       * `const pendiente = tx\`…\`` en un bloque y un `const pendiente = Promise.resolve();
       * await pendiente` en otro, el segundo daba por ejecutada la consulta del primero.
       * Dos variables con el mismo nombre en ámbitos distintos son dos variables.
       */
      const declaracionDe = (donde: ts.Node, nombre: string): ts.Node | null => {
        let a: ts.Node | undefined = donde;
        while (a !== undefined) {
          if (ts.isBlock(a) || ts.isSourceFile(a)) {
            for (const st of a.statements) {
              if (!ts.isVariableStatement(st)) continue;
              for (const d of st.declarationList.declarations) {
                if (ts.isIdentifier(d.name) && d.name.text === nombre) return d;
              }
            }
          }
          if (ts.isFunctionLike(a)) {
            for (const par of a.parameters) {
              if (ts.isIdentifier(par.name) && par.name.text === nombre) return par;
            }
          }
          a = a.parent as ts.Node | undefined;
        }
        return null;
      };
      const esAsincrona = (f: ts.Node): boolean =>
        ts.canHaveModifiers(f) &&
        (ts.getModifiers(f) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      const consumidas = new Set<ts.Node>();
      /*
       * Y UNA VARIABLE QUE SE REASIGNA DEJA DE VALER. El consumo se apunta contra la
       * declaración, así que con `let pendiente = tx\`…\`; pendiente = Promise.resolve();
       * await pendiente` lo que se espera es OTRO valor y la consulta perezosa no sale nunca:
       * borrar la escritura de verdad dejaba la paridad en verde. No se sigue el valor que
       * llega —eso es otro análisis—; se deja de contar, que falla hacia rojo.
       */
      const reasignadas = new Set<ts.Node>();
      const juntarConsumidos = (y: ts.Node): void => {
        /*
         * Y CUALQUIER forma de reasignar, no sólo `=`. Un `contribucion += entrada.aprendizajes`
         * cambia el valor igual y mirando sólo el `=` pasaba en verde: la misma avería con otro
         * operador, que es como han llegado casi todas.
         */
        const reasignado = nombreReasignado(y);
        if (reasignado !== null) {
          const d = declaracionDe(y, reasignado.text);
          if (d !== null) reasignadas.add(d);
        }
        /*
         * Y UN `return` SÓLO CONSUME SI LA FUNCIÓN ES ASÍNCRONA, igual que el `return`
         * directo. La comprobación estaba puesta en `seEjecuta` para la plantilla que se
         * devuelve tal cual, pero no en la puerta de la variable: un
         * `const pendiente = tx\`…\`; return pendiente` dentro de un ayudante SÍNCRONO daba
         * por ejecutada la consulta aunque quien llamara tirase el valor, que es justo lo
         * que el arreglo anterior perseguía por el otro lado.
         */
        const dispara =
          ts.isAwaitExpression(y) ||
          (ts.isReturnStatement(y) &&
            (esAsincrona(funcionDe(y)) || laEsperaQuienLaRecibe(funcionDe(y))));
        if (dispara) {
          const nombres = new Set<string>();
          valorConsumido(y.expression, nombres);
          for (const nombre of nombres) {
            const decl = declaracionDe(y, nombre);
            if (decl !== null) consumidas.add(decl);
          }
        }
      };
      /*
       * Y SÓLO DE LOS CUERPOS VIVOS. Bajando a toda función anidada, un ayudante al que no
       * llama nadie con un `return pendiente` dentro daba por consumida la declaración de
       * fuera: la consulta perezosa se contaba aunque ese `return` no se ejecute jamás. Es la
       * misma regla que el recorrido del SQL ya aplica, y aquí faltaba.
       */
      recorrerVivo(n, juntarConsumidos);
      const trozos: Consulta[] = [];
      recorrerVivo(n, (x) => {
        if (!ts.isTaggedTemplateExpression(x)) return;
        /*
         * Una consulta de postgres.js es PEREZOSA: no sale hacia la base hasta que alguien la
         * espera. Así que la pregunta no es «¿se tira este valor?» sino «¿SE EJECUTA?», y ésa
         * es la vuelta que faltaba: enumerar las formas de tirarlo —la sentencia suelta, el
         * `void`, la variable que nadie consume— deja fuera todas las que no se enumeraron.
         * Guardar la plantilla en un objeto (`const h = { pendiente: tx\`…\` }`) no la ejecuta,
         * y el censo la contaba porque su padre no era ninguno de los casos previstos.
         *
         * Así que se sube desde la plantilla hasta encontrar QUIÉN la dispara, y lo que no
         * llegue a uno de esos sitios no cuenta:
         *   · el `await` o el `return` que la espera, a través de lo que no consume el valor
         *     —paréntesis, `as`, `!`—;
         *   · el `Promise.all([…])` que espera varias, si a su vez se espera;
         *   · o una variable cuyo NOMBRE se consume después en la misma función.
         * Un `void`, un argumento de otra llamada, o quedarse dentro de un objeto o una lista,
         * no la ejecutan.
         */
        const seEjecuta = (desde: ts.Node, saltos = 0): boolean => {
          if (saltos > 12) return false;
          let hijo: ts.Node = desde;
          let padre = hijo.parent as ts.Node | undefined;
          while (
            padre !== undefined &&
            (ts.isParenthesizedExpression(padre) ||
              ts.isAsExpression(padre) ||
              ts.isNonNullExpression(padre)) &&
            padre.expression === hijo
          ) {
            hijo = padre;
            padre = padre.parent as ts.Node | undefined;
          }
          if (padre === undefined) return false;
          if (ts.isAwaitExpression(padre) && padre.expression === hijo) return true;
          /*
           * Un `return` dispara la consulta sólo si la función es ASÍNCRONA: ahí la máquina de
           * promesas la ASIMILA —la espera antes de resolver—. En una función síncrona el
           * `return` se limita a entregar la consulta perezosa a quien llame, y si ése tira el
           * valor no sale nada: `function persistir(tx) { return tx\`…\`; }` seguido de
           * `persistir(tx)` contaba la escritura sin que ocurriera.
           */
          if (ts.isReturnStatement(padre) && padre.expression === hijo) {
            const suya = funcionDe(padre);
            return esAsincrona(suya) || laEsperaQuienLaRecibe(suya);
          }
          // El cuerpo CORTO de una flecha es un `return` con otra forma, y se mide igual.
          if (ts.isArrowFunction(padre) && padre.body === hijo) {
            return esAsincrona(padre) || laEsperaQuienLaRecibe(padre);
          }
          // `Promise.all([q1, q2])`: la lista y la llamada sólo cuentan si LA LLAMADA se espera.
          if (ts.isArrayLiteralExpression(padre) && padre.elements.includes(hijo as ts.Expression)) {
            const llamada = padre.parent as ts.Node | undefined;
            if (
              llamada !== undefined &&
              ts.isCallExpression(llamada) &&
              esperaConjunta(llamada) &&
              llamada.arguments.includes(padre)
            ) {
              return seEjecuta(llamada, saltos + 1);
            }
            return false;
          }
          if (
            ts.isCallExpression(padre) &&
            esperaConjunta(padre) &&
            padre.arguments.includes(hijo as ts.Expression)
          ) {
            return seEjecuta(padre, saltos + 1);
          }
          if (ts.isVariableDeclaration(padre) && padre.initializer === hijo && ts.isIdentifier(padre.name)) {
            return consumidas.has(padre) && !reasignadas.has(padre);
          }
          return false;
        };
        if (!seEjecuta(x)) return;
        const t = x.template;
        const etiqueta = x.tag.getText();
        if (ts.isNoSubstitutionTemplateLiteral(t)) {
          trozos.push({ sql: soloSql(t.text), campos: [], etiqueta, tag: x.tag });
          return;
        }
        /*
         * De cada interpolación se guardan TODAS sus fuentes, y de cada una su campo: de
         * `entrada.aprendizajes` sale `aprendizajes`, y el objeto que lo lleva —que se llama
         * distinto en cada capa— se queda fuera.
         *
         * Quedarse con el ÚLTIMO identificador no era leer la fuente sino UNA de ellas:
         * `contribucion = ${'${entrada.reviewId + entrada.contribucion}'}` daba `contribucion` y
         * pasaba la comparación con el id de la review guardado dentro del relato. Se recogen
         * las dos, y más abajo se exige que TODAS estén justificadas.
         *
         * De una cadena `a.b.c` el campo es `c`: lo de en medio es el CAMINO, no la fuente.
         * Pero si la base de la cadena no es un nombre a secas —una llamada, un índice— ahí
         * dentro puede haber otra fuente y se sigue mirando.
         */
        /*
         * Y UN NOMBRE LOCAL SE RESUELVE HASTA SU ORIGEN antes de contarlo. Con
         * `const contribucion = entrada.aprendizajes` y luego `contribucion = ${'${contribucion}'}`,
         * el campo salía `contribucion`, coincidía con el nombre de la columna y la salvedad lo
         * aceptaba: C7 guardaba los aprendizajes dentro de la contribución con el censo en
         * verde. Un alias con forma de destino no es un origen.
         */
        /*
         * Y UN DESESTRUCTURADO TAMBIÉN RENOMBRA. `const { aprendizajes: contribucion } = entrada`
         * deja un nombre con forma de destino sin que haya ningún `const x = y` que seguir: el
         * campo salía `contribucion`, coincidía con el nombre de la columna y la salvedad lo
         * aceptaba otra vez —el mismo agujero de antes por la otra puerta—.
         *
         * La fuente de `{ p: q }` es `p`; la de `{ p }` es el propio `p`, que ya es el campo; y
         * en `[q]` no hay nombre de campo que valga, así que se sigue mirando lo que se
         * desestructura. De un anidado `{ r: { p: q } }` sale `p`, porque `r` es el CAMINO —lo
         * mismo que en `a.b.c`—.
         */
        type Fuente = { campo: string } | { nodo: ts.Node } | null;
        const esPatron = (b: ts.BindingName): b is ts.BindingPattern =>
          ts.isObjectBindingPattern(b) || ts.isArrayBindingPattern(b);
        const elementoLigado = (
          patron: ts.BindingPattern,
          nombre: string,
        ): ts.BindingElement | null => {
          for (const el of patron.elements) {
            if (ts.isOmittedExpression(el)) continue;
            if (!esPatron(el.name)) {
              if (ts.isIdentifier(el.name) && el.name.text === nombre) return el;
              continue;
            }
            const dentro = elementoLigado(el.name, nombre);
            if (dentro !== null) return dentro;
          }
          return null;
        };
        const fuenteLigada = (el: ts.BindingElement, raiz: ts.Expression | null): Fuente => {
          /*
           * Un REST no nombra un campo: lo que liga es TODO lo que queda del objeto. Sin mirar
           * el `...`, `const { ...contribucion } = entrada` se leía como la taquigrafía
           * `{ contribucion }`, o sea como el campo homónimo, y la salvedad de «el campo nombra
           * a su columna» lo aceptaba — con la interpolación guardando el objeto entero.
           */
          if (el.dotDotDotToken !== undefined) {
            origenesSinLeer.add(
              `${ts.isIdentifier(el.name) ? el.name.text : '(patrón)'} (resto de un desestructurado)`,
            );
            return null;
          }
          if (el.propertyName !== undefined) {
            if (ts.isComputedPropertyName(el.propertyName)) {
              return { nodo: el.propertyName.expression };
            }
            return { campo: el.propertyName.text };
          }
          const patron = el.parent;
          // En un objeto sin `p:`, el nombre local YA es el campo.
          if (ts.isObjectBindingPattern(patron) && ts.isIdentifier(el.name)) {
            return { campo: el.name.text };
          }
          // En una lista no hay nombre de campo: la fuente es la de quien la contiene.
          const arriba = patron.parent;
          if (ts.isBindingElement(arriba)) return fuenteLigada(arriba, raiz);
          return raiz === null ? null : { nodo: raiz };
        };
        const origenDelNombre = (donde: ts.Node, nombre: string, hondo = 0): Fuente => {
          if (hondo > 8) return null;
          let a: ts.Node | undefined = donde;
          while (a !== undefined) {
            if (ts.isBlock(a) || ts.isSourceFile(a)) {
              for (const st of a.statements) {
                if (!ts.isVariableStatement(st)) continue;
                for (const d of st.declarationList.declarations) {
                  if (!d.initializer) continue;
                  const suyo = esPatron(d.name)
                    ? elementoLigado(d.name, nombre) !== null
                    : ts.isIdentifier(d.name) && d.name.text === nombre;
                  if (!suyo) continue;
                  /*
                   * Y UN NOMBRE QUE SE REASIGNA NO TIENE UN ORIGEN QUE LEER. Con
                   * `let contribucion = entrada.contribucion; contribucion = entrada.aprendizajes`,
                   * el inicializador dice el campo correcto y lo que llega a la interpolación es
                   * otro: C7 guardaba los aprendizajes dentro de la contribución con la
                   * comparación en verde. No se sigue la asignación que llega —eso es otro
                   * análisis—; se NOMBRA, que es lo que este censo hace con lo que no sabe leer.
                   */
                  if (reasignadas.has(d)) {
                    origenesSinLeer.add(`${nombre} (reasignado antes de interpolarse)`);
                    return null;
                  }
                  if (esPatron(d.name)) {
                    const el = elementoLigado(d.name, nombre)!;
                    return fuenteLigada(el, d.initializer);
                  }
                  if (!ts.isIdentifier(d.name)) {
                    continue;
                  }
                  /*
                   * Sólo un RENOMBRADO se sigue: `const x = y` o `const x = y.z`, con sus
                   * envolturas. Un valor CONSTRUIDO —`const dimensiones = { … }`— no es un
                   * alias, y seguirlo traía dentro los nombres de todo el objeto: medido, así
                   * el censo declaraba rota CI, que en este eje está bien. Lo que este hallazgo
                   * persigue es un alias con forma de destino, no una composición.
                   */
                  let init: ts.Expression = d.initializer;
                  while (
                    ts.isParenthesizedExpression(init) ||
                    ts.isAsExpression(init) ||
                    ts.isNonNullExpression(init)
                  ) {
                    init = init.expression;
                  }
                  if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) {
                    return { nodo: init };
                  }
                  return null;
                }
              }
            }
            /*
             * Un PARÁMETRO no tiene origen que seguir: es el dato tal como entra. Pero uno
             * DESESTRUCTURADO sí renombra —`({ aprendizajes: contribucion }) => …`—, y ahí el
             * campo se lee igual que en una declaración, sin nada detrás a lo que seguir.
             */
            if (ts.isFunctionLike(a)) {
              for (const par of a.parameters) {
                if (!esPatron(par.name)) {
                  if (ts.isIdentifier(par.name) && par.name.text === nombre) return null;
                  continue;
                }
                const el = elementoLigado(par.name, nombre);
                if (el !== null) return fuenteLigada(el, null);
              }
            }
            a = a.parent as ts.Node | undefined;
          }
          return null;
        };
        const campos = t.templateSpans.map((sp) => {
          const dentro: string[] = [];
          const ver = (y: ts.Node, hondo = 0): void => {
            if (ts.isPropertyAccessExpression(y)) {
              dentro.push(y.name.text);
              let base: ts.Node = y.expression;
              while (ts.isPropertyAccessExpression(base)) base = base.expression;
              if (!ts.isIdentifier(base)) ver(base, hondo);
              return;
            }
            if (ts.isIdentifier(y)) {
              const origen = hondo > 4 ? null : origenDelNombre(sp.expression, y.text, hondo);
              if (origen === null) dentro.push(y.text);
              else if ('campo' in origen) dentro.push(origen.campo);
              else ver(origen.nodo, hondo + 1);
              return;
            }
            ts.forEachChild(y, (z) => ver(z, hondo));
          };
          ver(sp.expression);
          return [...new Set(dentro)];
        });
        let sql = t.head.text;
        t.templateSpans.forEach((sp, k) => {
          sql += testigo(k) + sp.literal.text;
        });
        trozos.push({ sql: soloSql(sql), campos, etiqueta, tag: x.tag });
      });
      return trozos;
    };

    /**
     * A dónde manda un módulo que RE-EXPORTA el nombre buscado: con nombre, con comodín o
     * renombrando algo suyo.
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
        if (!ts.isExportDeclaration(st)) continue;
        if (!st.exportClause || !ts.isNamedExports(st.exportClause)) {
          if (st.moduleSpecifier && !st.exportClause) {
            const destino = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
            if (destino) comodines.push(destino);
          }
          continue;
        }
        for (const e of st.exportClause.elements) {
          if (e.name.text !== nombre) continue;
          const local = (e.propertyName ?? e.name).text;
          if (st.moduleSpecifier) {
            const destino = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
            if (destino) return { modulo: destino, original: local };
            continue;
          }
          /*
           * `export { implementar as puerta }` SIN `from`: el símbolo es de este módulo, o algo
           * que este módulo importó. La sonda de existencia ya acepta el nombre de salida, así
           * que sin resolver el de entrada el recorrido no encontraba declaración y rechazaba
           * una ruta manual intacta — el mismo desacuerdo entre las dos mitades que ya costó
           * los alias y los comodines.
           */
          const importado = importesDe(arbol, f).get(local);
          if (importado) return { modulo: importado.modulo, original: importado.original };
          if (funcionesDe(arbol).has(local)) return { modulo: f, original: local };
        }
      }
      for (const destino of comodines) {
        if (exportadasDe(destino).has(nombre)) return { modulo: destino, original: nombre };
      }
      /*
       * `export default …` no se indexa por «default»: una declaración con nombre entra en el
       * mapa por SU nombre. Sin esto, delegar por un import por defecto —un cambio que no altera
       * ninguna conducta— hacía que el censo dijera que la ruta manual ya no escribe nada.
       */
      if (nombre === 'default') {
        for (const st of arbol.statements) {
          if (
            ts.isFunctionDeclaration(st) &&
            st.name &&
            st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
          ) {
            return { modulo: f, original: st.name.text };
          }
          if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) {
            return { modulo: f, original: st.expression.text };
          }
        }
      }
      return null;
    };

    /** Las llamadas VIVAS de una función, con el objeto sobre el que se hacen si lo hay. */
    const llamadasEn = (
      n: ts.Node,
    ): { objeto: string | null; nombre: string; donde: ts.Node }[] => {
      const llamadas: { objeto: string | null; nombre: string; donde: ts.Node }[] = [];
      recorrerVivo(n, (x) => {
        if (!ts.isCallExpression(x)) return;
        for (const a of argumentosEjecutados(x)) {
          if (ts.isIdentifier(a)) {
            llamadas.push({ objeto: null, nombre: a.text, donde: a });
          } else if (ts.isPropertyAccessExpression(a)) {
            llamadas.push({
              objeto: ts.isIdentifier(a.expression) ? a.expression.text : null,
              nombre: a.name.text,
              donde: a,
            });
          }
        }
        if (ts.isIdentifier(x.expression)) {
          llamadas.push({ objeto: null, nombre: x.expression.text, donde: x });
        } else if (ts.isPropertyAccessExpression(x.expression)) {
          llamadas.push({
            objeto: ts.isIdentifier(x.expression.expression) ? x.expression.expression.text : null,
            nombre: x.expression.name.text,
            donde: x,
          });
        }
      });
      return llamadas;
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

    /**
     * LAS COLUMNAS que una sentencia escribe, para que la comparación no se quede en la tabla.
     *
     * Coincidir en «update outcome_review» no es hacer lo mismo: el escritor a mano podía
     * quedarse con el veredicto y dejar de guardar las cuatro columnas de relato que la
     * materialización escribe, y el censo seguiría en verde con la paridad ya rota. Lo señaló
     * una revisión y se reprodujo antes de aceptarlo.
     *
     * De un `insert into t (…)` se toma su lista de columnas; de un `update t set a = …, b = …`,
     * los destinos de las asignaciones, cortando en el primer `where`/`returning` de nivel cero.
     * Las comas se parten sólo a profundidad cero de paréntesis y fuera de cadenas, que es lo que
     * distingue `coalesce(a, b)` de dos columnas.
     *
     * Y sólo cuentan las columnas cuyo valor VIENE DE FUERA —un `${…}`, que aquí llega como
     * testigo—, no las que la materialización fija con una constante. La distinción no es de
     * comodidad: es la que hace la pregunta correcta. `materializarInsight` escribe
     * `estado` con el literal `'propuesto'` y `crearInsight` lo deja a la base; medido, la
     * columna es la ÚNICA diferencia de las siete capacidades, y no rompe ninguna paridad porque
     * lo que el usuario no podría reproducir a mano es el CONTENIDO del modelo, no un valor fijo
     * que el esquema puede poner igual. Exigirla habría obligado a escribir a mano una constante
     * para poner verde un censo, que es la clase de arreglo que este PR existe para no hacer.
     */
    const indicesEn = (t: string): number[] =>
      [...t.matchAll(/:i(\d+)\b/g)].map((m) => Number(m[1]));

    const columnasTrasLaTabla = (
      sql: string,
      desde: number,
      verbo: string,
    ): { columna: string; indices: number[]; valor: string }[] => {
      const resto = sql.slice(desde);
      const partesDeNivelCero = (t: string): string[] => {
        const partes: string[] = [];
        let actual = '';
        let hondo = 0;
        let enCadena = false;
        for (const c of t) {
          if (enCadena) {
            actual += c;
            if (c === "'") enCadena = false;
            continue;
          }
          if (c === "'") enCadena = true;
          else if (c === '(') hondo += 1;
          else if (c === ')') hondo -= 1;
          else if (c === ',' && hondo === 0) {
            partes.push(actual);
            actual = '';
            continue;
          }
          actual += c;
        }
        partes.push(actual);
        return partes;
      };
      /** El grupo entre paréntesis que empieza en `abre`, sin los paréntesis. */
      const grupo = (t: string, abre: number): string | null => {
        let hondo = 0;
        for (let i = abre; i < t.length; i++) {
          if (t[i] === '(') hondo += 1;
          else if (t[i] === ')') {
            hondo -= 1;
            if (hondo === 0) return t.slice(abre + 1, i);
          }
        }
        return null;
      };
      /*
       * El terminador se busca a PROFUNDIDAD CERO, como ya se hacía con las comas.
       * Buscándolo con una regex a secas, un `set a = (select … from …), b = ${'${…}'}` se
       * cortaba en el `from` de la subconsulta: las columnas posteriores desaparecían de lo
       * exigido y el escritor a mano podía dejar de guardarlas con el censo en verde.
       */
      const finDeNivelCero = (t: string): number => {
        let hondo = 0;
        let enTexto = false;
        for (let i = 0; i < t.length; i++) {
          const c = t[i]!;
          if (enTexto) {
            if (c === "'") enTexto = false;
            continue;
          }
          if (c === "'") enTexto = true;
          else if (c === '(') hondo += 1;
          else if (c === ')') hondo -= 1;
          else if (hondo === 0 && (i === 0 || /\W/.test(t[i - 1]!))) {
            if (/^(where|returning|from)\b/i.test(t.slice(i))) return i;
          }
        }
        return -1;
      };
      if (verbo === 'insert into') {
        const abre = resto.indexOf('(');
        if (abre < 0) return [];
        // Sólo cuenta si el paréntesis viene ANTES del values/select: si no, no hay lista.
        if (/\b(values|select|default)\b/i.test(resto.slice(0, abre))) return [];
        const lista = grupo(resto, abre);
        if (lista === null) return [];
        const columnas = partesDeNivelCero(lista)
          .map((x) => x.trim().toLowerCase())
          .filter((x) => /^[a-z_][a-z0-9_]*$/.test(x));
        const sinPareja = columnas.map((c) => ({ columna: c, indices: [], valor: '' }));
        const values = /\bvalues\s*\(/i.exec(resto);
        /*
         * `insert … (a, b, c) select v1, v2, v3 from …` empareja igual que un `values`: la lista
         * del SELECT, cortada a profundidad cero por su `from`/`where`. Sin esto, las cinco
         * columnas de la afirmación a mano —que es un `insert … select`— llegaban SIN campo, y
         * una comprobación que no puede distinguir un `${'${entrada.texto}'}` de un `${"${'n/a'}"}`
         * no puede acusar al segundo.
         */
        const partes = ((): string[] | null => {
          if (values) {
            const valores = grupo(resto, values.index + values[0].length - 1);
            return valores === null ? null : partesDeNivelCero(valores);
          }
          const sel = /\bselect\b/i.exec(resto.slice(abre));
          if (!sel) return null;
          const cuerpoSel = resto.slice(abre + sel.index + sel[0].length);
          const finSel = finDeNivelCero(cuerpoSel);
          return partesDeNivelCero(finSel >= 0 ? cuerpoSel.slice(0, finSel) : cuerpoSel);
        })();
        if (partes === null || partes.length !== columnas.length) return sinPareja;
        return columnas
          .map((c, i) => ({ columna: c, indices: indicesEn(partes[i]!), valor: partes[i]! }))
          .filter((x) => x.indices.length > 0);
      }
      const set = /\bset\b/i.exec(resto);
      if (!set) return [];
      const cuerpo = resto.slice(set.index + set[0].length);
      const fin = finDeNivelCero(cuerpo);
      return partesDeNivelCero(fin >= 0 ? cuerpo.slice(0, fin) : cuerpo)
        .map((x) => {
          const m = /^\s*([a-z_][a-z0-9_]*)\s*=/i.exec(x);
          return {
            columna: m?.[1]?.toLowerCase() ?? '',
            indices: indicesEn(x),
            valor: m === null ? '' : x.slice(m[0].length),
          };
        })
        .filter((x) => x.columna !== '' && x.indices.length > 0);
    };

    /**
     * POR QUÉ FILA se escribe, que no es lo mismo que qué se escribe en ella.
     *
     * Coincidir en verbo, tabla y columnas no basta: un `update outcome_review` a mano que
     * pierda su `where id = …` escribiría TODOS los borradores del workspace al guardar uno, y
     * el censo seguiría diciendo que la paridad está completa. Se recogen las columnas que el
     * `where` compara —a profundidad cero, para no confundir las de una subconsulta con las de
     * la sentencia— y se exige que la ruta manual acote AL MENOS por las mismas.
     *
     * Al menos, y no exactamente: acotar de más es asunto suyo; acotar de menos es escribir
     * donde la materialización no escribiría.
     *
     * Y sólo cuenta el predicado que ATA la fila a un valor de fuera. Aceptando cualquier
     * operador, un `id is not null` registraba `id` y satisfacía el conjunto igual que
     * `id = ${entrada.reviewId}` — o sea, se podían escribir todos los borradores del workspace
     * con el censo en verde. Es la misma distinción que en las columnas: lo que viene de fuera.
     */
    const filtroTrasLaTabla = (
      sql: string,
      desde: number,
      verbo: string,
    ): {
      columnas: { columna: string; operador: string; indice: number }[];
      literales: { columna: string; operador: string; valor: string }[];
    } => {
      const nada = (): {
        columnas: { columna: string; operador: string; indice: number }[];
        literales: { columna: string; operador: string; valor: string }[];
      } => ({ columnas: [], literales: [] });
      const resto = sql.slice(desde);
      let cuerpo: string;
      if (verbo === 'update') {
        const set = /\bset\b/i.exec(resto);
        if (!set) return nada();
        cuerpo = resto.slice(set.index + set[0].length);
      } else {
        /*
         * Y UN `insert … select` TAMBIÉN ACOTA. Lo que su WHERE deje fuera no se inserta, y
         * este censo lo tiraba: cortaba la lista del select en el `where` de nivel cero y
         * seguía. Un `where false` colgado del `insert into afirmacion … select …` dejaba las
         * columnas proyectadas idénticas, no metía NINGUNA fila, y la paridad en verde.
         *
         * Un `values (…)` no lleva `where` a nivel cero, así que ahí esto no encuentra nada y
         * la sentencia se cuenta igual que antes.
         */
        cuerpo = resto;
      }
      let hondo = 0;
      let enTexto = false;
      let donde = -1;
      for (let i = 0; i < cuerpo.length; i++) {
        const c = cuerpo[i]!;
        if (enTexto) {
          if (c === "'") enTexto = false;
          continue;
        }
        if (c === "'") enTexto = true;
        else if (c === '(') hondo += 1;
        else if (c === ')') hondo -= 1;
        else if (hondo === 0 && (i === 0 || /\W/.test(cuerpo[i - 1]!))) {
          if (/^where\b/i.test(cuerpo.slice(i))) {
            donde = i + 'where'.length;
            break;
          }
        }
      }
      if (donde < 0) return nada();
      const cola = cuerpo.slice(donde);
      /*
       * Y tiene que ser una cadena de «and». Guardando sólo las columnas, un
       * `where id = ${id} or workspace_id = ${ws}` daba el mismo conjunto que el correcto — y
       * con un `or` ninguna columna ata la fila, así que escribir uno podía escribirlos todos.
       * Ante un `or` de nivel cero no se registra NADA: la ruta manual no acota, y eso es
       * exactamente lo que la comparación tiene que decir.
       */
      {
        let hondoO = 0;
        let enTextoO = false;
        for (let i = 0; i < cola.length; i++) {
          const c = cola[i]!;
          if (enTextoO) {
            if (c === "'") enTextoO = false;
            continue;
          }
          if (c === "'") enTextoO = true;
          else if (c === '(') hondoO += 1;
          else if (c === ')') hondoO -= 1;
          else if (hondoO === 0 && (i === 0 || /\W/.test(cola[i - 1]!))) {
            if (/^(returning|order|limit)\b/i.test(cola.slice(i))) break;
            if (/^or\b/i.test(cola.slice(i))) return nada();
          }
        }
      }
      /*
       * CADA CONJUNTO DE LA CADENA TIENE QUE NOMBRAR UNA COLUMNA, Y UNA SOLA VEZ. Con o sin
       * el alias de su tabla delante: el WHERE de un `insert … select` los lleva —`s.id`,
       * `s.workspace_id`— y sin admitirlos el censo denunciaba una sentencia intacta.
       *
       * Mirando únicamente los predicados que la materialización exige, un `and false` —o un
       * `and id is null` junto al `id = ${'${…}'}` correcto— dejaba el mapa de filtros
       * idéntico y la sentencia sin tocar ninguna fila: la ruta manual declarada no existe y
       * la invariante en verde. Lo que sobra no es inocuo, así que no se ignora.
       *
       * Un conjunto que no empiece nombrando una columna no se entiende y se NOMBRA al final;
       * y una columna repetida en la misma cadena es una contradicción o una redundancia que
       * este censo no sabe leer. Lo que sí pasa —y es lo que hay en las dos capacidades que
       * filtran— es un `and estado = 'borrador'`: una columna distinta contra un literal, que
       * acota de más sin anular nada.
       */
      const columnas: { columna: string; operador: string; indice: number }[] = [];
      const literales: { columna: string; operador: string; valor: string }[] = [];

      /*
       * La cadena se parte en sus CONJUNTOS a profundidad cero, en vez de mirar cada posición
       * del texto: mirando posiciones, el índice 0 llegaba con el espacio inicial delante y
       * ningún patrón casaba, así que el primer predicado se denunciaba solo. Partir es además
       * lo que la pregunta pide: cada conjunto se examina UNA vez y entero.
       */
      const conjuntos: string[] = [];
      {
        let actual = '';
        let h = 0;
        let enT = false;
        for (let i = 0; i < cola.length; i++) {
          const c = cola[i]!;
          if (enT) {
            actual += c;
            if (c === "'") enT = false;
            continue;
          }
          if (c === "'") enT = true;
          else if (c === '(') h += 1;
          else if (c === ')') h -= 1;
          else if (h === 0 && (i === 0 || /\W/.test(cola[i - 1]!))) {
            if (/^(returning|order|limit)\b/i.test(cola.slice(i))) break;
            if (/^and\b/i.test(cola.slice(i))) {
              conjuntos.push(actual);
              actual = '';
              i += 'and'.length - 1;
              continue;
            }
          }
          actual += c;
        }
        conjuntos.push(actual);
      }

      const nombradas: string[] = [];
      for (const bruto of conjuntos) {
        const trozo = bruto.trim();
        if (trozo === '') continue;
        const m = /^(?:[a-z_][a-z0-9_]*\s*\.\s*)?([a-z_][a-z0-9_]*)\s*(=|<>|!=|\bin\b)\s*\(?\s*:i(\d+)\b/i.exec(
          trozo,
        );
        if (m) {
          columnas.push({
            columna: m[1]!.toLowerCase(),
            operador: m[2]!.toLowerCase().trim(),
            indice: Number(m[3]),
          });
          nombradas.push(m[1]!.toLowerCase());
          continue;
        }
        // Lo que no se registra SÍ se mira: tiene que nombrar una columna. Un `and false` no
        // la nombra, y anula la sentencia entera sin tocar el mapa de filtros.
        const col =
          /^(?:[a-z_][a-z0-9_]*\s*\.\s*)?([a-z_][a-z0-9_]*)\s*(=|<>|!=|<=|>=|<|>|\bis\b|\bin\b|\blike\b|\bilike\b|@>)/i.exec(
            trozo,
          );
        if (col === null) {
          predicadosSinColumna.add(trozo.slice(0, 60));
          continue;
        }
        nombradas.push(col[1]!.toLowerCase());
        /*
         * Y si acota contra un LITERAL se guarda con su valor. Que nombre una columna distinta
         * lo hacía inocuo a ojos del censo, y no lo es: cambiar `and estado = 'borrador'` por
         * `and estado = 'completado'` en el guardado del borrador deja una sentencia que no
         * toca NINGUNA fila —el borrador nunca está completado— con la paridad en verde.
         */
        const lit = /^(?:[a-z_][a-z0-9_]*\s*\.\s*)?([a-z_][a-z0-9_]*)\s*(=|<>|!=)\s*'([^']*)'\s*$/i.exec(
          trozo,
        );
        if (lit) {
          literales.push({
            columna: lit[1]!.toLowerCase(),
            operador: lit[2]!.toLowerCase(),
            valor: lit[3]!,
          });
        }
      }
      // Y una columna repetida en la misma cadena es una contradicción —`id = ${'${…}'} and id
      // is null`— o una redundancia que este censo no sabe leer. Las dos piden una decisión.
      for (const n of new Set(nombradas)) {
        if (nombradas.filter((x) => x === n).length > 1) {
          predicadosSinColumna.add(`${n} (repetida en el mismo where)`);
        }
      }
      return { columnas, literales };
    };

    /*
     * LO QUE LA PROPIA RUTA YA DESCARTÓ NO ACOTA: ANULA.
     *
     * Un conjunto de más contra un literal —`and estado = 'borrador'`— nombra una columna
     * distinta, no repite ninguna y no anula nada a la vista: el censo lo daba por bueno. Pero
     * si el literal es uno que la propia función acaba de RECHAZAR unas líneas antes, la
     * sentencia no puede tocar ninguna fila: `guardarBorradorReview` tira si la review está
     * completada, así que un `and estado = 'completado'` en su WHERE deja el guardado sin
     * efecto —y la ruta manual que SYS-21 declara, sin existir— con la paridad en verde.
     *
     * De qué valor se puede fiar uno: sólo del que la función misma niega ANTES de escribir,
     * y sólo si el dato viene de la MISMA tabla que se actualiza. Si `if (x.estado ===
     * 'completado') throw` corta el paso, abajo `estado` no vale 'completado'; y si el corte es
     * `if (x.estado !== 'borrador') throw`, abajo `estado` vale 'borrador' Y NADA MÁS.
     *
     * Sólo se baja por `||`: de un `if (A || B) throw` que no salta se sabe que NI A NI B; de
     * un `if (A && B) throw` que no salta no se sabe nada de A. Y la comparación tiene que
     * quedar por encima de la consulta en el propio texto, que es lo que la hace anterior.
     */
    type Guarda = {
      columna: string;
      valor: string;
      niega: boolean;
      tabla: string;
      fin: number;
      /**
       * Y la función DONDE corta el paso. Sin esto, una guarda escrita en un ayudante que
       * NADIE llama —o en cualquier función hermana declarada más arriba— garantizaba algo
       * que nunca ocurre: medido, `and estado = 'borrador'` quedaba denunciado en una ruta
       * intacta sólo por tener un `if (otro.estado === 'borrador') throw` muerto por encima.
       * Vale la que CONTIENE a la consulta, y sólo ésa.
       */
      ambito: ts.Node;
    };
    const dentroDe = (a: ts.Node, n: ts.Node): boolean => {
      let x: ts.Node | undefined = n;
      while (x !== undefined) {
        if (x === a) return true;
        x = x.parent as ts.Node | undefined;
      }
      return false;
    };
    const guardasDe = (decl: ts.Node): Guarda[] => {
      const fuera: Guarda[] = [];
      const texto = decl.getSourceFile().text;
      /** La tabla de la que sale un nombre local, leída de la consulta que lo declara. */
      const tablaDelNombre = (donde: ts.Node, nombre: string): string | null => {
        let a: ts.Node | undefined = donde;
        while (a !== undefined) {
          if (ts.isBlock(a) || ts.isSourceFile(a)) {
            for (const st of a.statements) {
              if (!ts.isVariableStatement(st)) continue;
              for (const d of st.declarationList.declarations) {
                const suyo =
                  (ts.isIdentifier(d.name) && d.name.text === nombre) ||
                  (ts.isArrayBindingPattern(d.name) &&
                    d.name.elements.some(
                      (el) =>
                        !ts.isOmittedExpression(el) &&
                        ts.isIdentifier(el.name) &&
                        el.name.text === nombre,
                    ));
                if (!suyo || d.initializer === undefined) continue;
                const m = /\bfrom\s+([a-z_][a-z0-9_]*)/i.exec(
                  texto.slice(d.initializer.pos, d.initializer.end),
                );
                return m === null ? null : m[1]!.toLowerCase();
              }
            }
          }
          a = a.parent as ts.Node | undefined;
        }
        return null;
      };
      const funcionQueContiene = (y: ts.Node): ts.Node => {
        let a: ts.Node | undefined = y.parent as ts.Node | undefined;
        while (a !== undefined && !ts.isFunctionLike(a)) a = a.parent as ts.Node | undefined;
        return a ?? decl;
      };
      const lanza = (st: ts.Statement): boolean =>
        ts.isThrowStatement(st) ||
        (ts.isBlock(st) && st.statements.some((y) => ts.isThrowStatement(y)));
      const comparaciones = (e: ts.Expression, poner: (b: ts.BinaryExpression) => void): void => {
        if (ts.isParenthesizedExpression(e)) return comparaciones(e.expression, poner);
        if (!ts.isBinaryExpression(e)) return;
        if (e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
          comparaciones(e.left, poner);
          comparaciones(e.right, poner);
          return;
        }
        if (
          e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
        ) {
          poner(e);
        }
      };
      const ver = (n: ts.Node): void => {
        if (ts.isIfStatement(n) && lanza(n.thenStatement)) {
          comparaciones(n.expression, (b) => {
            const lados: [ts.Expression, ts.Expression][] = [
              [b.left, b.right],
              [b.right, b.left],
            ];
            for (const [campo, valor] of lados) {
              if (!ts.isPropertyAccessExpression(campo) || !ts.isStringLiteral(valor)) continue;
              if (!ts.isIdentifier(campo.expression)) continue;
              const tabla = tablaDelNombre(n, campo.expression.text);
              if (tabla === null) continue;
              fuera.push({
                columna: campo.name.text.toLowerCase().replace(/_/g, ''),
                valor: valor.text,
                niega: b.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken,
                tabla,
                fin: n.expression.end,
                ambito: funcionQueContiene(n),
              });
            }
          });
        }
        ts.forEachChild(n, ver);
      };
      ts.forEachChild(decl, ver);
      return fuera;
    };

    /*
     * DE DÓNDE SALE LA ETIQUETA, resuelta hasta el cliente de postgres.js.
     *
     * El sufijo del texto no es una ligadura: `logger.sql\`…\`` acaba en `sql`, y un `const sql
     * = (x: TemplateStringsArray) => …` declarado dentro de la propia función tapa al importado
     * sin cambiar una letra del sitio donde se usa. En los dos casos, borrar la consulta de
     * verdad y dejar el formateador mantenía la invariante en verde.
     *
     * Las TRES formas que este repositorio tiene de sostener el cliente, resueltas por su
     * ligadura y ninguna más:
     *   · un parámetro TIPADO con el tipo del driver —`tx: TransactionSql`—, que es como se
     *     pasa la transacción de una función a otra;
     *   · un parámetro SIN tipo que entrega quien recibe la función —`conUsuario(actorId,
     *     async (tx) => …)`, que es el único camino legítimo a la base de este repositorio—;
     *   · `sql()` y `sqlAdmin()`, las dos fábricas de `db.ts`, llamadas en el sitio o guardadas
     *     antes en una constante.
     *
     * Los dos módulos que esto ancla se comprueban: si se renombran, el censo se cae en vez de
     * dejar de mirar en silencio.
     */
    const BASE = `${raiz}/src/lib/db.ts`;
    expect(existsSync(BASE), `el módulo de la base no está en ${BASE}`).toBe(true);
    const CLIENTES_DE_LA_BASE = ['sql', 'sqlAdmin'];
    const ENTREGA_LA_TRANSACCION = 'conUsuario';

    /** Los nombres que un módulo trae del DRIVER: de ahí sale el tipo del cliente. */
    const tiposDelDriver = (arbol: ts.SourceFile): Set<string> => {
      const nombres = new Set<string>();
      for (const st of arbol.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        if ((st.moduleSpecifier as ts.StringLiteral).text !== 'postgres') continue;
        const b = st.importClause?.namedBindings;
        if (b && ts.isNamedImports(b)) for (const e of b.elements) nombres.add(e.name.text);
      }
      return nombres;
    };

    /** El nombre con el que `db.ts` declara lo que un módulo importa, o nada si no viene de ahí. */
    const vieneDeLaBase = (f: string, nombre: string): string | null => {
      let modulo = f;
      let actual = nombre;
      for (let i = 0; i < 8; i += 1) {
        if (modulo === BASE) return actual;
        const arbol = leer(modulo);
        const via = importesDe(arbol, modulo).get(actual);
        if (via) {
          modulo = via.modulo;
          actual = via.original;
          continue;
        }
        const salto = reexportDe(arbol, modulo, actual);
        if (!salto) return null;
        modulo = salto.modulo;
        actual = salto.original;
      }
      return null;
    };

    /** La ligadura LÉXICA de un nombre en el sitio donde se usa: parámetro o variable. */
    const ligaduraDe = (donde: ts.Node, nombre: string): ts.Node | null => {
      let a: ts.Node | undefined = donde.parent as ts.Node | undefined;
      while (a !== undefined) {
        if (ts.isFunctionLike(a)) {
          for (const p of a.parameters) {
            if (ts.isIdentifier(p.name) && p.name.text === nombre) return p;
          }
        }
        if (ts.isBlock(a) || ts.isSourceFile(a)) {
          for (const st of a.statements) {
            if (!ts.isVariableStatement(st)) continue;
            for (const d of st.declarationList.declarations) {
              if (ts.isIdentifier(d.name) && d.name.text === nombre) return d;
            }
          }
        }
        a = a.parent as ts.Node | undefined;
      }
      return null;
    };

    /** `sql` / `sqlAdmin` de `db.ts`: la FÁBRICA del cliente, que todavía hay que llamar. */
    const esFabricaDeCliente = (e: ts.Expression, f: string): boolean => {
      if (ts.isIdentifier(e)) {
        // Una ligadura local TAPA al import: ahí ya no se sabe qué es.
        if (ligaduraDe(e, e.text) !== null) return false;
        const original = vieneDeLaBase(f, e.text);
        return original !== null && CLIENTES_DE_LA_BASE.includes(original);
      }
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
        // Y el RECEPTOR se mira igual que el nombre suelto: con `import * as db`, un parámetro
        // o un local llamado `db` tapa al módulo, y `db.sql()` deja de ser la fábrica de verdad.
        if (ligaduraDe(e.expression, e.expression.text) !== null) return false;
        const via = importesDe(leer(f), f).get(e.expression.text);
        return (
          via !== undefined &&
          via.modulo === BASE &&
          via.original === '*' &&
          CLIENTES_DE_LA_BASE.includes(e.name.text)
        );
      }
      return false;
    };

    /** Un parámetro que sostiene la transacción: por su TIPO, o por quien entrega la función. */
    const esParametroDeLaBase = (p: ts.ParameterDeclaration, f: string): boolean => {
      if (p.type) {
        return (
          ts.isTypeReferenceNode(p.type) &&
          ts.isIdentifier(p.type.typeName) &&
          tiposDelDriver(leer(f)).has(p.type.typeName.text)
        );
      }
      const fn = p.parent as ts.Node;
      if (!ts.isFunctionLike(fn)) return false;
      const llamada = fn.parent as ts.Node | undefined;
      if (llamada === undefined || !ts.isCallExpression(llamada)) return false;
      if (llamada.arguments.indexOf(fn as unknown as ts.Expression) !== 1) return false;
      if (fn.parameters.indexOf(p) !== 0) return false;
      const quien = llamada.expression;
      if (!ts.isIdentifier(quien) || ligaduraDe(quien, quien.text) !== null) return false;
      return vieneDeLaBase(f, quien.text) === ENTREGA_LA_TRANSACCION;
    };

    /** Y la etiqueta entera: lo que de verdad manda la sentencia a la base. */
    /** El mismo lector, con otro nombre, para los ámbitos donde `ligaduraDe` queda tapado. */
    const ligaduraLexica = ligaduraDe;

    /**
     * Si una variable se REASIGNA dentro de la función que la declara.
     *
     * `let client = sql(); client = String.raw; await client\`update …\`` se leía por el
     * inicializador y contaba como escritura, cuando lo que se etiqueta es un formateador de
     * cadenas: borrar la persistencia de verdad dejaba la paridad en verde.
     */
    const seReasigna = (d: ts.VariableDeclaration): boolean => {
      if (!ts.isIdentifier(d.name)) return false;
      const nombre = d.name.text;
      let ambito: ts.Node | undefined = d.parent as ts.Node | undefined;
      while (
        ambito !== undefined &&
        !ts.isFunctionLike(ambito) &&
        !ts.isSourceFile(ambito)
      ) {
        ambito = ambito.parent as ts.Node | undefined;
      }
      if (ambito === undefined) return false;
      let hay = false;
      const ver = (y: ts.Node): void => {
        if (hay) return;
        const izq = nombreReasignado(y);
        if (izq !== null && izq.text === nombre && ligaduraDe(izq, nombre) === d) hay = true;
        ts.forEachChild(y, ver);
      };
      ver(ambito);
      return hay;
    };

    const esCliente = (e: ts.Expression, f: string, hondo = 0): boolean => {
      if (hondo > 8) return false;
      let x: ts.Expression = e;
      while (
        ts.isParenthesizedExpression(x) ||
        ts.isAsExpression(x) ||
        ts.isNonNullExpression(x)
      ) {
        x = x.expression;
      }
      if (ts.isCallExpression(x)) return esFabricaDeCliente(x.expression, f);
      if (!ts.isIdentifier(x)) return false;
      const liga = ligaduraDe(x, x.text);
      // Sin ligadura local sólo puede ser un import, y lo que `db.ts` exporta es la fábrica.
      if (liga === null) return false;
      if (ts.isParameter(liga)) return esParametroDeLaBase(liga, f);
      if (ts.isVariableDeclaration(liga) && liga.initializer) {
        return !seReasigna(liga) && esCliente(liga.initializer, f, hondo + 1);
      }
      return false;
    };

    /**
     * Las escrituras «verbo tabla» alcanzables desde una función: UNA ENTRADA POR SENTENCIA.
     *
     * Juntar en una sola bolsa las columnas y los filtros de todas las sentencias que tocan la
     * misma tabla borra a cuál pertenece cada predicado. Con dos `update outcome_review` —uno
     * acotado sólo por `id` y otro sólo por `workspace_id`— la unión daba el mismo conjunto que
     * la materialización, y el segundo actualizaba TODAS las reviews del workspace con el censo
     * en verde. Cada sentencia se guarda entera y se compara entera.
     */
    type Sentencia = {
      columnas: Map<string, Set<string>>;
      /** Y el SQL del valor de cada una: un valor puede nombrar a su columna sin interpolarla. */
      valores: Map<string, string>;
      filtro: Map<string, Set<string>>;
    };
    type Alcance = { escrituras: Map<string, Sentencia[]>; modulos: Set<string> };
    const cacheDeEscrituras = new Map<string, Alcance>();
    const alcanceDesde = (modulo: string, funcion: string): Alcance => {
      const memo = cacheDeEscrituras.get(`${modulo}#${funcion}`);
      if (memo) return memo;
      const modulos = new Set<string>();
      const escrituras = new Map<string, Sentencia[]>();
      const visto = new Set<string>();
      const cola = [{ modulo, funcion }];
      while (cola.length > 0) {
        const actual = cola.shift()!;
        const clave = `${actual.modulo}#${actual.funcion}`;
        if (visto.has(clave)) continue;
        visto.add(clave);
        modulos.add(actual.modulo);
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
        const guardas = guardasDe(decl);
        for (const consulta of sqlDe(decl)) {
          for (const m of consulta.sql.matchAll(/(insert\s+into|update)\s+([a-z_]+)/gi)) {
            const tabla = m[2]!;
            if (CONTABILIDAD_AI.includes(tabla)) continue;
            if (!esCliente(consulta.tag, actual.modulo)) {
              etiquetasDesconocidas.add(consulta.etiqueta);
              continue;
            }
            const verbo = m[1]!.toLowerCase().replace(/\s+/g, ' ');
            const clave = `${verbo} ${tabla}`;
            const y: Sentencia = {
              columnas: new Map<string, Set<string>>(),
              valores: new Map<string, string>(),
              filtro: new Map<string, Set<string>>(),
            };
            const tras = m.index + m[0].length;
            for (const c of columnasTrasLaTabla(consulta.sql, tras, verbo)) {
              const campos = y.columnas.get(c.columna) ?? new Set<string>();
              for (const i of c.indices) for (const n of consulta.campos[i] ?? []) campos.add(n);
              y.columnas.set(c.columna, campos);
              y.valores.set(c.columna, `${y.valores.get(c.columna) ?? ''} ${c.valor}`);
            }
            /*
             * El filtro se guarda con su OPERADOR y con el campo del que sale, por lo mismo que
             * las columnas: `id <> ${…}` acota la fila al revés y daba el mismo conjunto que
             * `id = ${…}`.
             */
            const acota = filtroTrasLaTabla(consulta.sql, tras, verbo);
            for (const c of acota.columnas) {
              const clv = `${c.columna} ${c.operador}`;
              const campos = y.filtro.get(clv) ?? new Set<string>();
              for (const n of consulta.campos[c.indice] ?? []) campos.add(n);
              y.filtro.set(clv, campos);
            }
            // Y un conjunto contra un literal que esta misma ruta ya descartó no acota: anula.
            for (const c of acota.literales) {
              if (c.operador !== '=') continue;
              const col = c.columna.replace(/_/g, '');
              for (const g of guardas) {
                if (g.tabla !== tabla || g.columna !== col || g.fin > consulta.tag.pos) continue;
                if (!dentroDe(g.ambito, consulta.tag)) continue;
                if (g.niega ? c.valor !== g.valor : c.valor === g.valor) {
                  conjuntosImposibles.add(
                    `${actual.funcion}: ${clave} where ${c.columna} = '${c.valor}', y la ruta ${
                      g.niega ? `ya exige que sea '${g.valor}'` : 'ya rechazó ese valor'
                    }`,
                  );
                }
              }
            }
            escrituras.set(clave, [...(escrituras.get(clave) ?? []), y]);
          }
        }
        const imports = importesDe(arbol, actual.modulo);
        const locales = funcionesDe(arbol);
        /*
         * LO QUE LA PROPIA FUNCIÓN LIGA TAPA AL MÓDULO. Si el manejador declara su `persistir`
         * —o lo recibe como parámetro— y lo llama, resolverlo contra un `persistir` importado
         * traía las escrituras de OTRO sitio: la invariante seguía verde aunque este manejador
         * ya no alcanzara ninguna.
         *
         * Sólo tapan las funciones anidadas con nombre y los parámetros, que es lo que el
         * recorrido ya sabe leer por su cuenta —o lo que no puede resolver de ninguna manera—.
         * Un alias corriente (`const escribir = enlazarInsight`) NO tapa: ahí el respaldo por
         * nombre sigue siendo la única forma de llegar.
         */
        const nombresDe = (b: ts.BindingName, poner: (n: string) => void): void => {
          if (ts.isIdentifier(b)) poner(b.text);
          else if (ts.isObjectBindingPattern(b) || ts.isArrayBindingPattern(b)) {
            for (const e of b.elements) {
              if (ts.isBindingElement(e)) nombresDe(e.name, poner);
            }
          }
        };
        /**
         * QUÉ LIGA UN ÁMBITO, mirado en el sitio de CADA llamada y no en todo el fichero.
         *
         * Doblando en un solo mapa las ligaduras de cualquier descendiente, el parámetro de un
         * callback anidado tapaba el import que usa el manejador de fuera y el censo daba por
         * incumplida una ruta intacta. Se resuelve subiendo desde la llamada hasta la función
         * declarada, que es lo que hace el lenguaje.
         *
         * Un alias simple —`const escribir = enlazarInsight`— tapa el nombre PERO conserva su
         * destino; cualquier otra ligadura —desestructurar, una llamada que devuelve un
         * callback— tapa sin destino, que es lo que corresponde: ese nombre ya no es el del
         * módulo.
         */
        /**
         * Lo que un ámbito liga POR SÍ MISMO, sin bajar a los de dentro.
         *
         * Bajando a todos los hijos, un `const escribir = …` dentro de un `if` contaba como
         * ligadura del bloque de FUERA, y entonces una llamada legítima de fuera se leía como
         * tapada por un nombre que allí no existe. Eso no rechaza una escritura falsa: rechaza
         * una ruta INTACTA, que es el otro modo de fallo y el que empuja a «arreglar» lo que
         * no está roto. Un `const` de un bloque pertenece a ese bloque.
         */
        /*
         * …CON UNA EXCEPCIÓN QUE SÍ TIENE DESTINO: lo que sale de un MIEMBRO de un espacio de
         * nombres. `const generar = proveedor.generarConProveedor` —o desestructurarlo— tapaba
         * el nombre sin destino, así que el recorrido no llegaba a `proveedor.server.ts` y la
         * ruta manual podía llamar al modelo con SYS-21 en verde. El espacio dice el módulo y
         * el miembro dice la función: eso es un destino, y se sigue.
         */
        type Sombra = {
          hay: boolean;
          alias: string | null;
          via: { objeto: string; miembro: string } | null;
        };
        /** De `X.y` o de `{ y }`/`{ y: z }` sobre `X`: el espacio y el miembro, si los hay. */
        const miembroDeEspacio = (d: ts.VariableDeclaration, nombre: string): Sombra['via'] => {
          const init = d.initializer;
          if (init === undefined) return null;
          if (
            ts.isIdentifier(d.name) &&
            ts.isPropertyAccessExpression(init) &&
            ts.isIdentifier(init.expression)
          ) {
            return { objeto: init.expression.text, miembro: init.name.text };
          }
          if (!ts.isObjectBindingPattern(d.name) || !ts.isIdentifier(init)) return null;
          for (const el of d.name.elements) {
            if (el.dotDotDotToken !== undefined || !ts.isIdentifier(el.name)) continue;
            if (el.name.text !== nombre) continue;
            const suyo = el.propertyName;
            if (suyo !== undefined && !ts.isIdentifier(suyo)) return null;
            return { objeto: init.text, miembro: (suyo ?? el.name).text };
          }
          return null;
        };
        /*
         * Y TAMPOCO SI SE REASIGNA. `let ejecutar = persistirManual; ejecutar =
         * generarConProveedor; await ejecutar()` acreditaba el SQL del primero y dejaba fuera
         * el módulo del proveedor: la ruta declarada llamaba SÓLO al modelo y SYS-21 seguía en
         * verde. Un alias mutable tapa el nombre y no dice a dónde va, que es lo conservador.
         */
        const reasignadasAqui = new Set<ts.Node>();
        {
          const anotar = (y: ts.Node): void => {
            const izq = nombreReasignado(y);
            if (izq !== null) {
              const d = ligaduraLexica(izq, izq.text);
              if (d !== null) reasignadasAqui.add(d);
            }
            ts.forEachChild(y, anotar);
          };
          anotar(decl);
        }
        const ligaduraDe = (ambito: ts.Node, nombre: string): Sombra => {
          if (ts.isFunctionLike(ambito)) {
            for (const par of ambito.parameters) {
              let hay = false;
              nombresDe(par.name, (n) => {
                if (n === nombre) hay = true;
              });
              if (hay) return { hay: true, alias: null, via: null };
            }
          }
          const cuerpo = ts.isFunctionLike(ambito)
            ? ((ambito as ts.FunctionLikeDeclaration).body as ts.Node | undefined)
            : ambito;
          if (cuerpo === undefined || (!ts.isBlock(cuerpo) && !ts.isSourceFile(cuerpo))) {
            return { hay: false, alias: null, via: null };
          }
          for (const st of cuerpo.statements) {
            if (ts.isFunctionDeclaration(st) && st.name?.text === nombre) {
              return { hay: true, alias: null, via: null };
            }
            if (!ts.isVariableStatement(st)) continue;
            for (const d of st.declarationList.declarations) {
              let hay = false;
              nombresDe(d.name, (n) => {
                if (n === nombre) hay = true;
              });
              if (!hay) continue;
              const alias =
                d.initializer !== undefined && ts.isIdentifier(d.initializer)
                  ? d.initializer.text
                  : null;
              if (reasignadasAqui.has(d)) return { hay: true, alias: null, via: null };
              return {
                hay: true,
                alias: ts.isIdentifier(d.name) ? alias : null,
                via: miembroDeEspacio(d, nombre),
              };
            }
          }
          return { hay: false, alias: null, via: null };
        };
        const sombraEn = (donde: ts.Node, nombre: string): Sombra => {
          let a: ts.Node | undefined = donde.parent as ts.Node | undefined;
          for (;;) {
            if (a === undefined) return { hay: false, alias: null, via: null };
            if (ts.isFunctionLike(a) || ts.isBlock(a) || ts.isSourceFile(a)) {
              const l = ligaduraDe(a, nombre);
              if (l.hay) return l;
            }
            if (a === decl) return { hay: false, alias: null, via: null };
            a = a.parent as ts.Node | undefined;
          }
        };
        for (const { objeto, nombre, donde } of llamadasEn(decl)) {
          /*
           * `servicio.crear(…)` con `import * as servicio`: el módulo lo dice el espacio — PERO
           * sólo si nadie lo tapa. Con un parámetro o un local llamado igual, esta rama se
           * creía el import y acreditaba SQL de otro módulo mientras corría el método del
           * parámetro: la escritura de verdad podía borrarse con la invariante en verde. Es el
           * mismo agujero que la etiqueta de la plantilla ya tenía tapado, por el otro lado.
           */
          if (objeto !== null && sombraEn(donde, objeto).hay) continue;
          const espacio = objeto === null ? undefined : imports.get(objeto);
          if (espacio?.original === '*') {
            cola.push({ modulo: espacio.modulo, funcion: nombre });
            continue;
          }
          /*
           * Y sólo las llamadas SUELTAS caen a estos dos respaldos. Resolviendo también las de
           * propiedad, `logger.persistir()` casaba con un `persistir` importado que no tiene
           * nada que ver y arrastraba su escritura: la invariante seguía verde con la llamada
           * real ya quitada.
           */
          if (objeto !== null) continue;
          const sombra = sombraEn(donde, nombre);
          // Un alias que sale de un miembro de espacio de nombres YA dice a dónde va.
          if (sombra.hay && sombra.via !== null) {
            const suyo = imports.get(sombra.via.objeto);
            if (suyo?.original === '*') cola.push({ modulo: suyo.modulo, funcion: sombra.via.miembro });
            continue;
          }
          const bajo = sombra.hay ? sombra.alias : nombre;
          if (bajo === null) continue;
          const importado = imports.get(bajo);
          if (importado) cola.push({ modulo: importado.modulo, funcion: importado.original });
          else if (locales.has(bajo)) cola.push({ modulo: actual.modulo, funcion: bajo });
        }
      }
      const alcance = { escrituras, modulos };
      cacheDeEscrituras.set(`${modulo}#${funcion}`, alcance);
      return alcance;
    };
    const escriturasDesde = (modulo: string, funcion: string): Map<string, Sentencia[]> =>
      alcanceDesde(modulo, funcion).escrituras;

    /*
     * EL PROVEEDOR NO PUEDE ESTAR EN LA RUTA MANUAL, que es lo que SYS-21 pide de verdad.
     *
     * Comparando sólo escrituras, un manejador manual que esperara al proveedor antes de llegar
     * a su SQL salía verde — y en la caída que este requisito cubre no funcionaría. Lo que se
     * exige es que ninguno de los módulos que la secuencia alcanza sea el del proveedor.
     *
     * Se comprueba que el fichero existe: si se renombra, esto tiene que caerse en vez de dejar
     * de mirar en silencio.
     */
    const PROVEEDOR = `${raiz}/src/lib/ai/proveedor.server.ts`;
    expect(existsSync(PROVEEDOR), `el módulo del proveedor no está en ${PROVEEDOR}`).toBe(true);

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
        [...escriturasDesde(servicioAI, m).keys()].some((e) => e.endsWith(` ${tabla}`)),
      );
      expect(suyos, `no hay UN materializador que escriba «${tabla}»`).toHaveLength(1);

      const exigido = escriturasDesde(servicioAI, suyos[0]!);
      expect(exigido.size, `${cap}: el materializador no escribe nada, no hay qué exigir`).toBeGreaterThan(0);

      if (def.paridadManual.clase !== 'escritura') continue;
      // Las sentencias de todos los pasos, cada una entera: no se funden entre sí.
      const cubierto = new Map<string, Sentencia[]>();
      for (const paso of def.paridadManual.pasos) {
        const m = resolver(`${raiz}/src/lib/ai/ai.schemas.ts`, paso.modulo);
        expect(m, `${cap}: el módulo ${paso.modulo} no existe`).not.toBeNull();
        for (const [e, lista] of escriturasDesde(m!, paso.funcion)) {
          cubierto.set(e, [...(cubierto.get(e) ?? []), ...lista]);
        }
      }
      const secuencia = def.paridadManual.pasos.map((x) => x.funcion).join(' → ');

      const porElProveedor = def.paridadManual.pasos.filter((paso) => {
        const m = resolver(`${raiz}/src/lib/ai/ai.schemas.ts`, paso.modulo);
        return m !== null && alcanceDesde(m, paso.funcion).modulos.has(PROVEEDOR);
      });
      expect(
        porElProveedor.map((x) => x.funcion),
        `${cap}: la ruta manual pasa por el proveedor AI, así que no funciona en la caída que SYS-21 cubre`,
      ).toEqual([]);
      const faltan = [...exigido.keys()].filter((e) => !cubierto.has(e)).sort();
      expect(
        faltan,
        `${cap}: la secuencia manual (${secuencia}) no cubre lo que ${suyos[0]} escribe`,
      ).toEqual([]);

      /*
       * CADA SENTENCIA DE LA MATERIALIZACIÓN CONTRA UNA SENTENCIA MANUAL, entera.
       *
       * Antes se comparaban dos uniones —todas las columnas contra todas las columnas, todos los
       * predicados contra todos los predicados—, y ahí se pierde a qué sentencia pertenece cada
       * cosa: partir en dos `update outcome_review` lo que la materialización hace en uno, con
       * un `where id` en el primero y un `where workspace_id` en el segundo, daba exactamente la
       * misma unión. El segundo actualiza TODAS las reviews del workspace, y el censo lo daba
       * por bueno.
       *
       * Se exige que ALGUNA sentencia manual cubra la de la materialización por completo: sus
       * columnas, el campo del que sale cada una y su acotación. Si ninguna lo hace, se cuentan
       * los reparos de la que MENOS le faltó, que es la que el mensaje debe describir.
       *
       * Basta con que exista una que la cubra —no se exige que sea una por una—: la ruta manual
       * puede escribir de más, y agrupar en una sola sentencia lo que la materialización parte
       * en dos sigue dejando la fila igual.
       */
      const pelar = (n: string): string => n.toLowerCase().replace(/_/g, '');
      const reparosDe = (
        r: Sentencia,
        x: Sentencia,
        e: string,
      ): { columnas: string[]; campos: string[]; filtros: string[] } => {
        const columnas: string[] = [];
        const campos: string[] = [];
        const filtros: string[] = [];
        for (const [c, suyos] of r.columnas) {
          const mios = x.columnas.get(c);
          if (mios === undefined) {
            columnas.push(`${e}.${c}`);
            continue;
          }
          /*
           * Y de dónde SALE cada columna, no sólo cuál se escribe. Un intercambio entre dos
           * campos de relato —`contribucion = ${'${entrada.aprendizajes}'}` y al revés— da el
           * mismo conjunto de destinos y guarda el texto en el sitio equivocado. Basta con que
           * compartan un identificador, porque el objeto que los lleva se llama distinto en cada
           * capa (`c.` en la materialización, `entrada.` a mano) y lo que tiene que coincidir es
           * el CAMPO. Si alguno de los dos lados no tiene identificadores —un valor calculado—
           * no hay nada que comparar y se deja pasar.
           *
           * Y si no coinciden, todavía vale que el campo de la ruta manual NOMBRE A SU COLUMNA:
           * `reto_id` desde `entrada.retoId` es correcto aunque la materialización lo escriba
           * desde `p.anclaId`, porque las dos capas nombran distinto el mismo dato. Medido: sin
           * esta salvedad el censo declaraba rota C0, que en este eje está bien. La primera
           * versión sólo acusaba si el campo aparecía en OTRA columna —o sea, sólo los
           * intercambios—, y eso dejaba pasar una sustitución cualquiera.
           */
          if (suyos.size === 0) continue;
          // TODAS las fuentes de la ruta manual tienen que estar justificadas: que compartan
          // campo con la materialización o que nombren a su columna. Bastar con UNA dejaba
          // pasar la que viniera acompañada —`contribucion = ${'${entrada.reviewId + entrada.contribucion}'}`
          // comparte `contribucion` y guarda además el id de la review dentro del relato.
          const justificado = (nombre: string): boolean =>
            suyos.has(nombre) || pelar(nombre) === pelar(c);
          if (mios.size > 0 && [...mios].every(justificado)) continue;
          /*
           * Y si no comparten campo, vale que el valor de la ruta manual NOMBRE A SU COLUMNA
           * —por el identificador de su interpolación o en el propio SQL—:
           *
           *   · `reto_id` desde `entrada.retoId` es correcto aunque la materialización lo
           *     escriba desde `p.anclaId`, porque las dos capas nombran distinto el mismo dato.
           *     Medido: sin esta salvedad el censo declaraba rota C0, que en este eje está bien.
           *   · y el `orden` de una afirmación a mano sale de un `coalesce((select max(orden) +
           *     1 …), 0)`: lo calcula la base A PARTIR DE LA PROPIA COLUMNA, y no hay campo
           *     interpolado con el que comparar. Exigirlo pondría en rojo una ruta intacta.
           *
           * Lo que ya NO pasa es un valor que no dice de dónde sale: `contribucion = ${"${'n/a'}"}`
           * deja la columna escrita y el conjunto de campos VACÍO, y aceptarlo sin más mantenía
           * la invariante en verde con C7 guardando el contenido equivocado. Tampoco pasa una
           * sustitución cualquiera —`contribucion = ${'${entrada.reviewId}'}`—, que no comparte
           * identificador con nada y tampoco nombra a su columna.
           */
          /*
           * Y la salvedad del SQL vale sólo si NINGUNA interpolación llega al valor fuera de una
           * subconsulta. Con la mención a secas, `contribucion = coalesce(${'${entrada.reviewId}'}
           * ::text, contribucion)` pasaba nombrando la columna en el respaldo mientras guardaba
           * el dato equivocado: la mención textual no es derivación. Lo que la hace legítima en
           * el `orden` de una afirmación es que el valor lo calcula ENTERO la base —los `${'${…}'}`
           * viven dentro del `where` de su subconsulta, no en el valor—; en cuanto una
           * interpolación es operando del valor, ésa es la fuente y tiene que justificarse.
           */
          const suyoSql = x.valores.get(c) ?? '';
          const sinSubconsultas = (t: string): string => {
            let y = t;
            for (;;) {
              const m = /\(\s*select\b/i.exec(y);
              if (!m) return y;
              let hondo = 0;
              let fin = -1;
              for (let i = m.index; i < y.length; i += 1) {
                if (y[i] === '(') hondo += 1;
                else if (y[i] === ')') {
                  hondo -= 1;
                  if (hondo === 0) {
                    fin = i;
                    break;
                  }
                }
              }
              if (fin < 0) return y;
              y = y.slice(0, m.index) + y.slice(fin + 1);
            }
          };
          if (
            !/:i\d/.test(sinSubconsultas(suyoSql)) &&
            new RegExp(`\\b${c}\\b`, 'i').test(suyoSql)
          ) {
            continue;
          }
          campos.push(
            `${e}.${c} ← ${[...suyos].sort().join('|')}${mios.size === 0 ? ' (a mano, sin origen)' : ''}`,
          );
        }
        /*
         * Y EL OPERANDO DEL PREDICADO TIENE QUE NOMBRAR LA FILA. Con la misma clave `id =`,
         * cambiar `${'${entrada.reviewId}'}` por `${'${entrada.actorId}'}` acota otra fila —o
         * ninguna— y el censo lo daba por bueno: la clave coincidía y el cruce no salta porque
         * `actorId` no se parece a ninguna otra columna del filtro.
         *
         * Vale que comparta identificador con el operando de la materialización, que nombre la
         * COLUMNA, o que nombre la TABLA que se acota —quitándole un `Id` final y comparando
         * contra el nombre entero o contra una de sus palabras—. Es lo que hace legítimos
         * `entrada.itemId` sobre `item_importacion` y `entrada.reviewId` sobre `outcome_review`,
         * que a mano nombran la fila con el sustantivo de su tabla mientras la materialización
         * la nombra con el suyo (`p.anclaId`, el ancla de la propuesta) — el mismo dato con dos
         * nombres, que es justo lo que aquí no se podía distinguir de una sustitución.
         */
        const tabla = e.split(' ').pop() ?? '';
        const nombraLaFila = (n: string, col: string): boolean => {
          if (pelar(n) === pelar(col)) return true;
          /*
           * Y el sustantivo de la tabla nombra la fila por su IDENTIDAD, así que vale para `id`
           * y para nada más. Sin acotarlo, `where id = ${'${entrada.reviewId}'} and workspace_id =
           * ${'${entrada.reviewId}'}` pasaba entero —`review` es palabra de `outcome_review`, y el
           * cruce no salta porque `reviewId` no nombra a ninguna de las dos columnas— y ese
           * guardado no toca ninguna fila.
           */
          if (col !== 'id') return false;
          const sinId = pelar(n).replace(/id$/, '');
          if (sinId === '') return false;
          return sinId === pelar(tabla) || tabla.split('_').includes(sinId);
        };
        for (const k of r.filtro.keys()) {
          const mios = x.filtro.get(k);
          if (mios === undefined) {
            filtros.push(`${e} where ${k}`);
            continue;
          }
          const suyos = r.filtro.get(k)!;
          if ([...mios].some((n) => suyos.has(n))) continue;
          const col = k.split(' ')[0]!;
          if ([...mios].some((n) => nombraLaFila(n, col))) continue;
          filtros.push(
            `${e} where ${k} ← ${mios.size === 0 ? '(sin origen)' : [...mios].sort().join('|')}`,
          );
        }
        return { columnas, campos, filtros };
      };

      const columnasQueFaltan: string[] = [];
      const camposQueNoCasan: string[] = [];
      const filtrosQueFaltan: string[] = [];
      for (const [e, exigidas] of exigido) {
        const manuales = cubierto.get(e);
        if (manuales === undefined) continue; // Ya lo dice `faltan`, y con mejor mensaje.
        for (const r of exigidas) {
          let cubre = false;
          let peor: { columnas: string[]; campos: string[]; filtros: string[] } | null = null;
          const cuantos = (y: { columnas: string[]; campos: string[]; filtros: string[] }): number =>
            y.columnas.length + y.campos.length + y.filtros.length;
          for (const x of manuales) {
            const rp = reparosDe(r, x, e);
            if (cuantos(rp) === 0) {
              cubre = true;
              break;
            }
            if (peor === null || cuantos(rp) < cuantos(peor)) peor = rp;
          }
          if (cubre || peor === null) continue;
          columnasQueFaltan.push(...peor.columnas);
          camposQueNoCasan.push(...peor.campos);
          filtrosQueFaltan.push(...peor.filtros);
        }
      }
      expect(
        [...new Set(columnasQueFaltan)].sort(),
        `${cap}: la secuencia manual (${secuencia}) toca las mismas tablas que ${suyos[0]} pero no escribe todo lo que él escribe en una misma sentencia`,
      ).toEqual([]);
      expect(
        [...new Set(camposQueNoCasan)].sort(),
        `${cap}: la secuencia manual (${secuencia}) escribe las mismas columnas que ${suyos[0]} pero no desde los mismos campos`,
      ).toEqual([]);
      expect(
        [...new Set(filtrosQueFaltan)].sort(),
        `${cap}: la secuencia manual (${secuencia}) escribe lo mismo que ${suyos[0]} pero no acota la fila igual en la misma sentencia`,
      ).toEqual([]);

      /*
       * Y UN OPERANDO QUE NOMBRA A OTRA COLUMNA DEL MISMO FILTRO es un intercambio:
       * `where id = ${'${entrada.workspaceId}'} and workspace_id = ${'${entrada.reviewId}'}`
       * acota por los valores cruzados y da el mismo conjunto que lo correcto. Se mira DENTRO DE
       * CADA SENTENCIA, que es donde el cruce ocurre.
       *
       * No se compara el campo contra el de la materialización, y esto es una LIMITACIÓN medida,
       * no un olvido: C7 acota por `id` desde `p.anclaId` en la materialización y desde
       * `entrada.reviewId` a mano, y ahí no hay nada roto — son el mismo dato con dos nombres, y
       * a diferencia de las columnas escritas no hay un nombre de columna con el que normalizar
       * (`id` no se parece a ninguno de los dos). Exigir la coincidencia habría puesto en rojo
       * una ruta intacta.
       */
      const operandosCruzados = [...cubierto]
        .flatMap(([e, lista]) =>
          lista.flatMap((x) => {
            const columnasDelFiltro = new Set(
              [...x.filtro.keys()].map((k) => pelar(k.split(' ')[0]!)),
            );
            return [...x.filtro].flatMap(([clv, campos]) => {
              const col = clv.split(' ')[0]!;
              return [...campos]
                .filter((n) => pelar(n) !== pelar(col) && columnasDelFiltro.has(pelar(n)))
                .map((n) => `${e} where ${col} ← ${n}`);
            });
          }),
        )
        .sort();
      expect(
        [...new Set(operandosCruzados)].sort(),
        `${cap}: la secuencia manual (${secuencia}) acota por un valor que nombra a otra columna del mismo filtro`,
      ).toEqual([]);
    }

    /*
     * AL FINAL, cuando ya se ha recorrido todo: antes del bucle este conjunto está vacío
     * SIEMPRE, y la aserción no podía fallar. Se vio midiendo —la sonda que se movía era otra—,
     * y es el mismo modo de fallo que persigue el resto del fichero.
     */
    expect(
      [...etiquetasDesconocidas].sort(),
      'una plantilla escribe en la base con una etiqueta que este censo no reconoce: decide si cuenta',
    ).toEqual([]);
    expect(
      [...callbacksSinInvocar].sort(),
      'una función anónima con SQL dentro llega a alguien que este censo no sabe si la ejecuta: decide si cuenta',
    ).toEqual([]);
    expect(
      [...predicadosSinColumna].sort(),
      'una escritura lleva un predicado que este censo no sabe leer, o repite una columna: puede anular la sentencia entera',
    ).toEqual([]);
    expect(
      [...conjuntosImposibles].sort(),
      'una escritura acota por un valor que su propia ruta ya descartó: no toca ninguna fila',
    ).toEqual([]);
    expect(
      [...origenesSinLeer].sort(),
      'una interpolación sale de un nombre cuyo origen este censo no sabe leer: decide si cuenta',
    ).toEqual([]);
  });
});
