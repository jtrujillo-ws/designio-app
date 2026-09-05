import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { EditarNodoSchema } from '@/lib/journey/journey.schemas';

/**
 * Lo que un formulario lee de una caja de texto no se TROCEA: se mide contra el contrato.
 *
 * `parseInt` no valida, recorta — y recorta en silencio, devolviendo un número que suele ser
 * perfectamente válido. Medido con lo que un `<input type="number">` deja escribir:
 *
 *   «1e3»    → parseInt: 1      · Number: 1000
 *   «3.7»    → parseInt: 3      · Number: 3.7
 *   «9999.9» → parseInt: 9999   · Number: 9999.9
 *   «12abc»  → parseInt: 12     · Number: NaN
 *
 * El primero es el que duele: quien escribe `1e3` pide el puesto 1000 y le dan el 1. Y 1 es un
 * orden válido, así que ni el esquema del servidor ni la base tienen nada que rechazar — el
 * daño ya está hecho aquí, del lado del que escribe. Los otros hacen justo lo que
 * `z.number().int().max(9999)` prohíbe, y por eso ese esquema no llegaba a verlos nunca: el
 * recorte pasaba antes.
 *
 * Así que el vigilante no es «usa Number»: es que ninguna pantalla trocee. La decisión la
 * toma el parser de TypeScript y no una expresión regular, por lo mismo que el censo del
 * calendario y el barrido de capacidades: los comentarios que EXPLICAN el defecto —como el de
 * arriba— nombran `parseInt` a propósito, y distinguir una mención de una llamada es trabajo
 * de la gramática.
 */
describe('los números que entran por un formulario', () => {
  it('no los trocea ninguna pantalla: se miden contra su contrato', async () => {
    const raiz = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
    const ficheros: string[] = [];
    const recorrerDir = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const ruta = `${dir}/${e.name}`;
        if (e.isDirectory()) await recorrerDir(ruta);
        else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) ficheros.push(ruta);
      }
    };
    await recorrerDir(`${raiz}/src/routes`);
    await recorrerDir(`${raiz}/src/components`);
    // Que esté mirando algo: si la ruta cambiara, la lista quedaría vacía y esto pasaría en
    // verde sin haber leído una línea — el modo de fallo de todo censo.
    expect(ficheros.length).toBeGreaterThan(10);

    const TROCEADORES = new Set(['parseInt', 'parseFloat']);
    const hallazgos: string[] = [];
    for (const f of ficheros) {
      const codigo = await readFile(f, 'utf8');
      /*
       * La gramática, por la EXTENSIÓN. Forzar TSX sobre un `.ts` no es un detalle: en TSX,
       * `<T>(x: T) => x` se lee como JSX y se traga el resto del fichero. Medido sobre un `.ts`
       * con una flecha genérica y una aserción de tipo, y dos llamadas después:
       *
       *   TSX → ve 0 llamadas        TS → ve 2
       *
       * Y aquí el fallo cae del lado MALO: lo que no se visita no se denuncia, así que el
       * guardián pasaría en verde sin haber mirado nada — el modo de fallo que este
       * repositorio ya pagó una vez en el censo del calendario. (Allí TSX sí es la elección
       * correcta y está razonada: un fichero mal parseado hace que sus literales dejen de
       * reconocerse como literales, así que el censo mira de MÁS. La dirección del fallo es lo
       * que decide, no la comodidad de un solo `ScriptKind`.)
       */
      const arbol = ts.createSourceFile(
        f,
        codigo,
        ts.ScriptTarget.Latest,
        true,
        f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      /*
       * Y por si la extensión alguna vez no bastara: un fichero que no parsea LIMPIO no se
       * puede dar por barrido. Elegir bien la gramática arregla el caso conocido; esto
       * convierte cualquier caso futuro en rojo en vez de en un verde vacío, que es la
       * diferencia entre un censo y una lista de lo que a alguien se le ocurrió mirar.
       */
      const diagnosticos = (arbol as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
      expect(diagnosticos ?? [], `${f} no parsea limpio: el barrido no lo ha leído`).toHaveLength(
        0,
      );
      const recorrer = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          // `parseInt(x)` y `Number.parseInt(x)` cuentan igual: es la misma función.
          const nombre = ts.isIdentifier(n.expression)
            ? n.expression.text
            : ts.isPropertyAccessExpression(n.expression)
              ? n.expression.name.text
              : '';
          if (TROCEADORES.has(nombre)) {
            const { line } = arbol.getLineAndCharacterOfPosition(n.getStart(arbol));
            hallazgos.push(`${f.slice(raiz.length + 1)}:${line + 1} — ${n.getText(arbol)}`);
          }
        }
        ts.forEachChild(n, recorrer);
      };
      recorrer(arbol);
    }
    expect(hallazgos).toEqual([]);
  });

  /**
   * Y el contrato que sustituye al troceo es el del SERVIDOR, no una copia. Lo que aquí se
   * sujeta es su conducta ante los valores medidos: si alguien relaja el campo, el formulario
   * deja de rechazarlos sin que nadie lo note.
   */
  it('el campo del orden rechaza los números que el troceo dejaba pasar', () => {
    const orden = EditarNodoSchema.shape.orden;
    expect(orden.safeParse(3.7).success).toBe(false);
    expect(orden.safeParse(9999.9).success).toBe(false);
    // `NaN` es lo que sale de un texto que no es un número, y el campo lo rechaza. Se pasa
    // literal y no como `Number('12abc')`: escrito así, la aserción decía qué se le pide al
    // CAMPO sin depender de cómo llegó hasta él.
    expect(orden.safeParse(Number.NaN).success).toBe(false);
    // Y 0 SÍ es un orden real —el primer puesto—, así que el campo lo acepta. (Antes esto
    // estaba escrito como `Number('')`, que vale 0: la aserción parecía cubrir «campo vacío» y
    // en realidad solo probaba el cero. El vacío lo decide la PANTALLA, y lo rechaza; se
    // comprueba abajo, donde vive esa decisión.)
    expect(orden.safeParse(0).success).toBe(true);
    // El techo y el suelo siguen siendo los suyos.
    expect(orden.safeParse(10000).success).toBe(false);
    expect(orden.safeParse(-1).success).toBe(false);
  });

  /**
   * Y lo que el CAMPO no puede ver: un texto que no denota un entero pero que `Number` acerca
   * a uno que sí cumple el contrato.
   *
   * Es el mismo defecto que `parseInt`, por otro camino, y lo encontró una revisión sobre el
   * primer arreglo —donde yo solo comprobaba el número resultante—. Por eso la pantalla mira
   * la SINTAXIS del texto antes de convertirlo, y esto sujeta esa regla.
   */
  it('la sintaxis del texto se comprueba antes de convertirlo', () => {
    const SINTAXIS_ENTERA = /^[+-]?\d+$/;
    const orden = EditarNodoSchema.shape.orden;
    // Los dos que el contrato aprobaría siendo OTRO número del que se escribió.
    for (const texto of ['9998.9999999999999', '1e-324']) {
      expect(orden.safeParse(Number(texto)).success, `${texto}: el contrato no lo ve`).toBe(true);
      expect(SINTAXIS_ENTERA.test(texto), `${texto}: la sintaxis sí`).toBe(false);
    }
    // El vacío tampoco pasa: `Number('')` es 0, así que sin este corte borrar el campo y
    // guardar mandaba el nodo al primer puesto en vez de decir que falta el dato.
    expect(SINTAXIS_ENTERA.test('')).toBe(false);
    // Y lo que una persona escribe de verdad, sí.
    for (const texto of ['0', '12', '0012', '9999']) {
      expect(SINTAXIS_ENTERA.test(texto), `${texto} debería valer`).toBe(true);
      expect(orden.safeParse(Number(texto)).success).toBe(true);
    }
    // La regla vive en la pantalla; que sea ESTA se comprueba contra su fuente.
    const raiz = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
    return readFile(`${raiz}/src/routes/_autenticada/journey.$journeyId.tsx`, 'utf8').then((c) => {
      expect(c).toContain(String(SINTAXIS_ENTERA));
    });
  });
});
