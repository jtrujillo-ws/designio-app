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
   * Y LA MITAD QUE DE VERDAD CUESTA: que esa puerta ESCRIBA el destino.
   *
   * Un nombre que existe no prueba nada — podría exportarse y no tocar la tabla. Pero tampoco vale
   * mirar sólo su fichero: `escribirRevisionAMano` no inserta nada por sí misma, delega en el
   * escritor que comparte con la materialización, y eso es exactamente como debe ser (un solo
   * sitio que escribe, dos caminos que llegan). Un censo de un fichero la habría dado por
   * incumplida y habría empujado a duplicar el insert para ponerlo verde, que es lo contrario de
   * lo que conviene.
   *
   * Así que se sigue el grafo de imports desde el módulo declarado, igual que el censo del
   * lateral, y se busca la escritura de la tabla del destino en cualquier punto alcanzable. De
   * dónde sale ese nombre de tabla —y por qué no de la columna, que fue mi primer intento y era
   * falso— está en `tablaDelDestino`.
   */
  it('desde esa puerta se alcanza la escritura del destino, siguiendo el grafo', () => {
    let caminado = 0;
    for (const cap of CAPACIDADES_ACTIVAS) {
      const def = CAPACIDADES[cap];
      if (def.paridadManual.clase !== 'escritura' || def.destino === null) continue;
      const tabla = tablaDelDestino(def.destino);
      const entrada = resolver(`${raiz}/src/lib/ai/ai.schemas.ts`, def.paridadManual.modulo);
      expect(entrada, `${cap}: módulo irresoluble`).not.toBeNull();

      const visto = new Set<string>([entrada!]);
      const cola = [entrada!];
      let escribe = false;
      while (cola.length > 0 && !escribe) {
        const f = cola.shift()!;
        const arbol = leer(f);
        if (new RegExp(`insert\\s+into\\s+${tabla}\\b`, 'i').test(arbol.text)) {
          escribe = true;
          break;
        }
        for (const st of arbol.statements) {
          if (!ts.isImportDeclaration(st)) continue;
          if (st.importClause?.isTypeOnly) continue;
          const destino = resolver(f, (st.moduleSpecifier as ts.StringLiteral).text);
          if (!destino || visto.has(destino)) continue;
          visto.add(destino);
          cola.push(destino);
        }
      }
      /*
       * La guardia contra el resolutor roto va ABAJO y no aquí, y esto lo corrigió la primera
       * ejecución: exigir que cada capacidad hubiera recorrido más de un módulo declaraba rota
       * la más sana de todas —CI escribe en su propio fichero de entrada, así que el barrido
       * termina sin expandir— y el censo se ponía rojo sobre el caso bueno. El fallo estaba en
       * la MEDIDA. La guardia sólo tiene sentido cuando hizo falta caminar.
       */
      if (!escribe || visto.size > 1) caminado = Math.max(caminado, visto.size);
      expect(
        escribe,
        `${cap}: desde ${def.paridadManual.modulo}#${def.paridadManual.funcion} no se alcanza «insert into ${tabla}» por ningún camino`,
      ).toBe(true);
    }
    /*
     * Y AQUÍ la guardia, sobre el conjunto: alguna capacidad tuvo que necesitar el grafo, o este
     * censo no está probando que sepa seguirlo. C4 es la que lo obliga —`escribirRevisionAMano`
     * delega en el escritor que comparte con la materialización— y es justo el caso por el que
     * este barrido existe en vez de un grep por fichero.
     */
    expect(
      caminado,
      'ninguna capacidad necesitó el grafo: el barrido no se está ejercitando y un resolutor roto pasaría',
    ).toBeGreaterThan(1);
  });
});
