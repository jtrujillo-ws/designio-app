import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TODO TOKEN QUE SE USA TIENE QUE ESTAR DEFINIDO.
 *
 * Un `var(--lo-que-sea)` que no existe no es un error de compilación ni de lint: es CSS válido
 * que el navegador tira. La declaración entera se descarta en tiempo de valor computado, así
 * que `color` vuelve a heredar y `border` se queda en nada — la jerarquía visual se aplana en
 * silencio y sólo se ve mirando la pantalla, que es lo que ningún test hace.
 *
 * Apareció escribiendo el bloque de revisiones simuladas: `--texto-3`, `--texto-2` y `--linea`
 * son nombres plausibles —el repositorio nombra en español— y ninguno existe; los de verdad son
 * `--text-faint`, `--text-muted` y `--border`. Es la misma clase que este PR lleva pagando en la
 * migración con las listas escritas a mano: un valor tecleado de memoria en vez de derivado del
 * sitio donde vive. La respuesta es la misma, un censo.
 */
const RAIZ = 'src';

function ficheros(dir: string, ext: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ficheros(p, ext);
    return ext.some((x) => e.name.endsWith(x)) ? [p] : [];
  });
}

describe('tokens de diseño', () => {
  it('todo var(--token) que se usa está definido en los ficheros de tokens', () => {
    const definidos = new Set(
      ficheros(RAIZ, ['.css']).flatMap((f) => [
        ...readFileSync(f, 'utf8').matchAll(/(--[A-Za-z0-9_-]+)\s*:/g),
      ].map((m) => m[1]!)),
    );
    expect(definidos.size, 'no se encontró ningún token: el censo no mide nada').toBeGreaterThan(20);

    const huerfanos: string[] = [];
    // Lo que se barre es lo que SE PINTA. Las pruebas quedan fuera porque nombran tokens para
    // hablar de ellos —este mismo comentario lo hacía— y un censo que se caza a sí mismo no
    // mide la pantalla.
    for (const f of ficheros(RAIZ, ['.tsx', '.ts', '.css']).filter((f) => !f.includes('__tests__'))) {
      const texto = readFileSync(f, 'utf8');
      for (const m of texto.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)(\$\{)?/g)) {
        /*
         * Un nombre COMPUESTO en tiempo de ejecución —`var(--j${j})`, los siete colores de
         * journey— no se puede resolver leyendo el texto, y fingir que sí daría un censo que
         * miente en la otra dirección. Se salta, y se dice por qué.
         */
        if (m[2]) continue;
        const token = m[1]!;
        if (!definidos.has(token)) huerfanos.push(`${f}: ${token}`);
      }
    }
    expect(
      huerfanos,
      'esas referencias apuntan a tokens que no existen: el navegador descarta la declaración entera',
    ).toEqual([]);
  });
});
