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
     * Y las de DÓLAR cuentan igual: `select $$insert into cita$$` es la misma avería con la otra
     * forma de citar de Postgres. La apertura se reconoce como `$tag$` con etiqueta opcional, lo
     * que deja fuera los `$1` de los parámetros — una etiqueta no empieza por dígito—, aunque
     * aquí no aparecen: las interpolaciones ya llegan como testigo.
     */
    const soloSql = (t: string): string => {
      let fuera = '';
      let enCadena = false;
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
            fuera += c;
            enCadena = false;
          }
          i += 1;
        } else if (c === "'") {
          fuera += c;
          enCadena = true;
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
    const TESTIGO = ' :interpolado ';

    /**
     * EL RECORRIDO DE LO QUE SIGUE VIVO DENTRO DE UNA FUNCIÓN.
     *
     * No se baja a un ayudante anidado con NOMBRE al que ya no llama nadie. El descenso era
     * incondicional, así que dejar `const persistir = () => tx\`…\`` declarado y quitar su
     * llamada mantenía la escritura contada — la operación desaparecida y el censo en verde.
     * Se mira si el nombre aparece en algún otro sitio del cuerpo: sólo se baja si sí.
     *
     * A las funciones anidadas SIN nombre sí se baja siempre, y no es una excepción de
     * conveniencia: son las que van como argumento —`conUsuario(actorId, async (tx) => …)`,
     * que es como escribe casi todo este repositorio—, y ésas las llama quien las recibe.
     * Excluirlas dejaría ciego el censo entero, que es lo contrario de lo que se busca.
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

      const nombradas = new Map<string, ts.Node>();
      const juntar = (x: ts.Node): void => {
        if (x !== n && ts.isFunctionLike(x)) {
          const nom = nombreDe(x);
          if (nom !== null && !nombradas.has(nom)) nombradas.set(nom, x);
        }
        ts.forEachChild(x, juntar);
      };
      juntar(n);

      /** Lo que una región NOMBRA, sin entrar en los cuerpos con nombre que haya dentro. */
      const nombraA = (region: ts.Node): string[] => {
        const nombres: string[] = [];
        const ver = (x: ts.Node): void => {
          if (x !== region && ts.isFunctionLike(x) && nombreDe(x) !== null) return;
          if (ts.isIdentifier(x)) {
            const padre = x.parent as ts.Node | undefined;
            // Declararse no es nombrarse: si no, todo ayudante se daría vida a sí mismo.
            const esSuPropiaDeclaracion =
              padre !== undefined &&
              ((ts.isFunctionDeclaration(padre) && padre.name === x) ||
                (ts.isVariableDeclaration(padre) && padre.name === x));
            if (!esSuPropiaDeclaracion) nombres.push(x.text);
          }
          ts.forEachChild(x, ver);
        };
        ver(region);
        return nombres;
      };

      const vivas = new Set<string>();
      const cola = nombraA(n);
      while (cola.length > 0) {
        const nom = cola.shift()!;
        if (vivas.has(nom)) continue;
        const cuerpo = nombradas.get(nom);
        if (!cuerpo) continue;
        vivas.add(nom);
        cola.push(...nombraA(cuerpo));
      }

      const ver = (x: ts.Node): void => {
        if (x !== n && ts.isFunctionLike(x)) {
          const nombre = nombreDe(x);
          if (nombre !== null && !vivas.has(nombre)) return;
        }
        visitar(x);
        ts.forEachChild(x, ver);
      };
      ver(n);
    };

    const sqlDe = (n: ts.Node): string[] => {
      const trozos: string[] = [];
      recorrerVivo(n, (x) => {
        if (!ts.isTaggedTemplateExpression(x)) return;
        /*
         * Una consulta de postgres.js es PEREZOSA: no sale hacia la base hasta que alguien la
         * espera. Así que una plantilla que es toda la sentencia —sin `await`, sin `return`, sin
         * asignarse a nada— no se ejecuta, y ni TypeScript ni las reglas de lint la rechazan.
         * Contarla dejaría la invariante en verde justo cuando la operación manual ha dejado de
         * ocurrir, que es lo mismo que pasaba con el comentario y con la cadena.
         */
        if (x.parent !== undefined && ts.isExpressionStatement(x.parent)) return;
        const t = x.template;
        const literales = ts.isNoSubstitutionTemplateLiteral(t)
          ? [t.text]
          : [t.head.text, ...t.templateSpans.map((sp) => sp.literal.text)];
        trozos.push(soloSql(literales.join(TESTIGO)));
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
    const llamadasEn = (n: ts.Node): { objeto: string | null; nombre: string }[] => {
      const llamadas: { objeto: string | null; nombre: string }[] = [];
      recorrerVivo(n, (x) => {
        if (!ts.isCallExpression(x)) return;
        if (ts.isIdentifier(x.expression)) llamadas.push({ objeto: null, nombre: x.expression.text });
        else if (ts.isPropertyAccessExpression(x.expression)) {
          llamadas.push({
            objeto: ts.isIdentifier(x.expression.expression) ? x.expression.expression.text : null,
            nombre: x.expression.name.text,
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
    const columnasTrasLaTabla = (sql: string, desde: number, verbo: string): string[] => {
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
        const values = /\bvalues\s*\(/i.exec(resto);
        if (!values) return columnas; // `insert … select …`: sin pareja, se exigen todas.
        const valores = grupo(resto, values.index + values[0].length - 1);
        if (valores === null) return columnas;
        const partes = partesDeNivelCero(valores);
        if (partes.length !== columnas.length) return columnas;
        return columnas.filter((_, i) => partes[i]!.includes(TESTIGO.trim()));
      }
      const set = /\bset\b/i.exec(resto);
      if (!set) return [];
      const cuerpo = resto.slice(set.index + set[0].length);
      /*
       * El terminador se busca a PROFUNDIDAD CERO, como ya se hacía con las comas.
       * Buscándolo con una regex a secas, un `set a = (select … from …), b = ${…}` se cortaba en
       * el `from` de la subconsulta: las columnas posteriores desaparecían de lo exigido y el
       * escritor a mano podía dejar de guardarlas con el censo en verde.
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
      const fin = finDeNivelCero(cuerpo);
      return partesDeNivelCero(fin >= 0 ? cuerpo.slice(0, fin) : cuerpo)
        .filter((x) => x.includes(TESTIGO.trim()))
        .map((x) => /^\s*([a-z_][a-z0-9_]*)\s*=/i.exec(x)?.[1]?.toLowerCase() ?? '')
        .filter((x) => x !== '');
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
     */
    const filtroTrasLaTabla = (sql: string, desde: number, verbo: string): string[] => {
      if (verbo !== 'update') return [];
      const resto = sql.slice(desde);
      const set = /\bset\b/i.exec(resto);
      if (!set) return [];
      const cuerpo = resto.slice(set.index + set[0].length);
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
      if (donde < 0) return [];
      const cola = cuerpo.slice(donde);
      const columnas: string[] = [];
      let hondo2 = 0;
      let enTexto2 = false;
      for (let i = 0; i < cola.length; i++) {
        const c = cola[i]!;
        if (enTexto2) {
          if (c === "'") enTexto2 = false;
          continue;
        }
        if (c === "'") enTexto2 = true;
        else if (c === '(') hondo2 += 1;
        else if (c === ')') hondo2 -= 1;
        else if (hondo2 === 0 && (i === 0 || /\W/.test(cola[i - 1]!))) {
          if (/^(returning|order|limit)\b/i.test(cola.slice(i))) break;
          const m = /^([a-z_][a-z0-9_]*)\s*(=|<>|!=|\bin\b|\bis\b)/i.exec(cola.slice(i));
          if (m) columnas.push(m[1]!.toLowerCase());
        }
      }
      return columnas;
    };

    /** Las escrituras «verbo tabla» alcanzables desde una función, con las columnas de cada una. */
    type Escritura = { columnas: Set<string>; filtro: Set<string> };
    const cacheDeEscrituras = new Map<string, Map<string, Escritura>>();
    const escriturasDesde = (modulo: string, funcion: string): Map<string, Escritura> => {
      const memo = cacheDeEscrituras.get(`${modulo}#${funcion}`);
      if (memo) return memo;
      const escrituras = new Map<string, Escritura>();
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
          for (const m of sql.matchAll(/(insert\s+into|update)\s+([a-z_]+)/gi)) {
            const tabla = m[2]!;
            if (CONTABILIDAD_AI.includes(tabla)) continue;
            const verbo = m[1]!.toLowerCase().replace(/\s+/g, ' ');
            const clave = `${verbo} ${tabla}`;
            const y = escrituras.get(clave) ?? { columnas: new Set<string>(), filtro: new Set<string>() };
            const tras = m.index + m[0].length;
            for (const c of columnasTrasLaTabla(sql, tras, verbo)) y.columnas.add(c);
            for (const c of filtroTrasLaTabla(sql, tras, verbo)) y.filtro.add(c);
            escrituras.set(clave, y);
          }
        }
        const imports = importesDe(arbol, actual.modulo);
        const locales = funcionesDe(arbol);
        for (const { objeto, nombre } of llamadasEn(decl)) {
          // `servicio.crear(…)` con `import * as servicio`: el módulo lo dice el espacio.
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
        [...escriturasDesde(servicioAI, m).keys()].some((e) => e.endsWith(` ${tabla}`)),
      );
      expect(suyos, `no hay UN materializador que escriba «${tabla}»`).toHaveLength(1);

      const exigido = escriturasDesde(servicioAI, suyos[0]!);
      expect(exigido.size, `${cap}: el materializador no escribe nada, no hay qué exigir`).toBeGreaterThan(0);

      if (def.paridadManual.clase !== 'escritura') continue;
      const cubierto = new Map<string, Escritura>();
      for (const paso of def.paridadManual.pasos) {
        const m = resolver(`${raiz}/src/lib/ai/ai.schemas.ts`, paso.modulo);
        expect(m, `${cap}: el módulo ${paso.modulo} no existe`).not.toBeNull();
        for (const [e, y] of escriturasDesde(m!, paso.funcion)) {
          const acumulado = cubierto.get(e) ?? { columnas: new Set<string>(), filtro: new Set<string>() };
          for (const c of y.columnas) acumulado.columnas.add(c);
          for (const c of y.filtro) acumulado.filtro.add(c);
          cubierto.set(e, acumulado);
        }
      }
      const secuencia = def.paridadManual.pasos.map((x) => x.funcion).join(' → ');
      const faltan = [...exigido.keys()].filter((e) => !cubierto.has(e)).sort();
      expect(
        faltan,
        `${cap}: la secuencia manual (${secuencia}) no cubre lo que ${suyos[0]} escribe`,
      ).toEqual([]);

      const columnasQueFaltan = [...exigido]
        .flatMap(([e, y]) =>
          [...y.columnas].filter((c) => !cubierto.get(e)!.columnas.has(c)).map((c) => `${e}.${c}`),
        )
        .sort();
      expect(
        columnasQueFaltan,
        `${cap}: la secuencia manual (${secuencia}) toca las mismas tablas que ${suyos[0]} pero no escribe todo lo que él escribe`,
      ).toEqual([]);

      const filtrosQueFaltan = [...exigido]
        .flatMap(([e, y]) =>
          [...y.filtro].filter((c) => !cubierto.get(e)!.filtro.has(c)).map((c) => `${e} where ${c}`),
        )
        .sort();
      expect(
        filtrosQueFaltan,
        `${cap}: la secuencia manual (${secuencia}) escribe lo mismo que ${suyos[0]} pero no acota la fila igual`,
      ).toEqual([]);
    }
  });
});
