import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { CAPACIDADES, CAPACIDADES_ACTIVAS } from '../ai.schemas';
import { ESQUEMA_SALIDA } from '../ai.prompts';

/**
 * La costura por la que entra una capacidad nueva.
 *
 * Añadir una capacidad tocaba cinco ficheros y unos treinta sitios, casi todos de la forma
 * `capacidad === 'CI' ? esto : aquello`. Un ternario binario no puede expresar tres casos, y
 * su modo de fallo no es un error: es ELEGIR EL «ELSE» EN SILENCIO. La tercera capacidad se
 * habría comportado como C0 en cada uno de esos treinta sitios que a alguien se le olvidara,
 * y ninguna prueba lo habría dicho, porque el código sigue siendo válido y sigue compilando.
 *
 * Así que lo que varía se DECLARA en un registro, y estas comprobaciones son las que impiden
 * que el idioma viejo vuelva a entrar. Lo que el compilador ya garantiza —que todo
 * `Record<CapacidadActiva, …>` tenga su entrada— no se prueba aquí: se prueba lo que el
 * compilador NO ve.
 */
describe('el registro de capacidades', () => {
  it('declara TODAS sus piezas para cada capacidad activa', () => {
    for (const c of CAPACIDADES_ACTIVAS) {
      const d = CAPACIDADES[c];
      expect(d.etiqueta.length, `${c} sin etiqueta`).toBeGreaterThan(0);
      expect(d.destino, `${c} sin destino`).toBeTruthy();
      expect(d.contenido, `${c} sin esquema de contenido`).toBeTruthy();
      // El ancla es lo que más varía y lo que más veces se pregunta: si a una capacidad le
      // falta una de estas piezas, la pantalla enseñaría `undefined` a un curador.
      for (const pieza of ['etiqueta', 'enProsa', 'buscar', 'vacia', 'enCurso', 'pendiente'] as const) {
        expect(d.ancla[pieza].length, `${c}: ancla sin ${pieza}`).toBeGreaterThan(0);
      }
      expect(d.ancla.hayMas(3), `${c}: ancla sin texto de desbordamiento`).toContain('3');
      if (d.lote !== null) {
        expect(d.lote.campo.length, `${c}: lote sin campo`).toBeGreaterThan(0);
        expect(d.lote.maximo, `${c}: lote sin techo`).toBeGreaterThan(0);
      }
    }
  });

  /*
   * El esquema de salida vive en `ai.prompts` y no en el registro, a propósito: el registro lo
   * importa la PANTALLA, y arrastrar los prompts al bundle del cliente es justo lo que
   * `check:bundle` vigila. El precio de esa separación es que las dos mitades pueden
   * desincronizarse — una capacidad declarada sin esquema de salida compilaría, y fallaría al
   * despachar la primera llamada, ya pagada. Esto es lo que cobra ese precio.
   */
  it('tiene un esquema de salida por capacidad, y ninguno de sobra', () => {
    expect(Object.keys(ESQUEMA_SALIDA).sort()).toEqual([...CAPACIDADES_ACTIVAS].sort());
  });

  /**
   * Y el guardián de la costura: ninguna comparación de una capacidad contra un LITERAL puede
   * sobrevivir en el pipeline. Se decide con el parser de TypeScript y no con una expresión
   * regular, por lo mismo que el censo del calendario: un comentario que hable del idioma
   * viejo —como los de este fichero— no es una ocurrencia del idioma viejo, y distinguirlos
   * es trabajo de la gramática.
   */
  it('no deja ninguna rama binaria por capacidad en el pipeline', async () => {
    const raiz = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
    const ficheros: string[] = [`${raiz}/src/routes/_autenticada/propuestas.tsx`];
    for (const e of await readdir(`${raiz}/src/lib/ai`, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.ts')) ficheros.push(`${raiz}/src/lib/ai/${e.name}`);
    }
    // Que esté mirando algo: si la ruta cambiara, la lista quedaría vacía y este caso pasaría
    // en verde sin haber leído una sola línea — el modo de fallo de todo censo.
    expect(ficheros.length).toBeGreaterThan(4);

    const CAPACIDADES_LITERALES = new Set<string>(CAPACIDADES_ACTIVAS);
    const hallazgos: string[] = [];
    for (const f of ficheros) {
      const codigo = await readFile(f, 'utf8');
      const arbol = ts.createSourceFile(f, codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const recorrer = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n)) {
          const op = n.operatorToken.kind;
          const comparacion =
            op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
          // El nombre `capacidad` a cualquiera de los dos lados, contra un literal que sea el
          // de una capacidad: `entrada.capacidad === 'CI'` y `'CI' === capacidad` cuentan igual.
          const nombra = (x: ts.Node): boolean =>
            (ts.isIdentifier(x) && x.text === 'capacidad') ||
            (ts.isPropertyAccessExpression(x) && x.name.text === 'capacidad');
          const literal = (x: ts.Node): boolean =>
            ts.isStringLiteral(x) && CAPACIDADES_LITERALES.has(x.text);
          if (comparacion && ((nombra(n.left) && literal(n.right)) || (literal(n.left) && nombra(n.right)))) {
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
});
