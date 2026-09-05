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
      const arbol = ts.createSourceFile(f, codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
   * sujeta es su conducta ante los cuatro valores medidos: si alguien relaja el campo, el
   * formulario deja de rechazarlos sin que nadie lo note.
   */
  it('el campo del orden rechaza lo que el troceo dejaba pasar', () => {
    const orden = EditarNodoSchema.shape.orden;
    // Lo que `parseInt` convertía en un número válido y distinto del que se pidió.
    expect(orden.safeParse(3.7).success).toBe(false);
    expect(orden.safeParse(9999.9).success).toBe(false);
    expect(orden.safeParse(Number('12abc')).success).toBe(false); // NaN
    expect(orden.safeParse(Number('')).success).toBe(true); // '' es 0, y 0 es un orden real
    // Y `1e3` es MIL, que es lo que quien lo escribió pidió: dentro del contrato.
    expect(orden.safeParse(Number('1e3'))).toEqual({ success: true, data: 1000 });
    // El techo sigue siendo el techo.
    expect(orden.safeParse(10000).success).toBe(false);
    expect(orden.safeParse(-1).success).toBe(false);
  });
});
