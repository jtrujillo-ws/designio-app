import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

/**
 * La cuenta que el seed siembra se lee BAJO CANDADO, o la decisión no vale.
 *
 * `sembrarAdminPropio` lee una cuenta por su correo y con lo leído decide tres cosas: si está
 * desactivada —y entonces corta—, si escribirle la contraseña, y si concederle dos membresías
 * `lead-boutique`. Leer y decidir por separado deja un hueco, y el hueco está medido contra la
 * base real, con la cuenta invitada de una persona:
 *
 *   A lee «invitado» · B ejecuta «update usuario set estado = 'inactivo'» y CONFIRMA
 *   A escribe (su «where» solo mira password_hash is null, que sigue siendo cierto)
 *   → estado final: activo
 *
 * Un despliegue deshacía en silencio una desactivación deliberada y acto seguido le concedía
 * accesos privilegiados. Con «for update» en la lectura, los dos órdenes quedan bien y ambos
 * están comprobados: con A primero el estado final es «inactivo» —B espera y su desactivación
 * sobrevive—, y con B primero A RELEE «inactivo» y la guarda corta.
 *
 * Por qué un guardián y no solo el arreglo: lo que se pierde al reescribir esa consulta es una
 * palabra, y una palabra que falta no rompe ninguna prueba —el seed sigue sembrando igual en
 * cuanto nadie corre en paralelo, que es siempre menos el día que importa—. Lo que hay que
 * sujetar es que la lectura de esa cuenta NO PUEDA volver a quedarse sin candado.
 *
 * Lo decide el parser de TypeScript y no una expresión regular, por lo mismo que el barrido de
 * capacidades y el censo del calendario: este mismo comentario nombra la consulta y las
 * palabras que busca, y distinguir una MENCIÓN de una consulta de verdad es trabajo de la
 * gramática, no de un grep.
 */
describe('el seed de la cuenta propia', () => {
  it('lee esa cuenta bajo candado: la desactivación ajena no se deshace', async () => {
    const raiz = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
    const ruta = `${raiz}/db/seed.ts`;
    const codigo = await readFile(ruta, 'utf8');

    /*
     * La gramática por la EXTENSIÓN, y aquí es `.ts`: forzar TSX sobre un `.ts` hace que
     * `<T>(x: T) => x` se lea como JSX y se trague el resto del fichero. Medido: TSX ve 0
     * llamadas donde TS ve 2. El fallo caería del lado malo —lo que no se visita no se
     * denuncia— y este guardián pasaría en verde sin haber leído una línea.
     */
    const fuente = ts.createSourceFile(ruta, codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    // Que el parser haya entendido el fichero. Un fichero mal parseado no produce nodos, y sin
    // nodos no hay hallazgos: verde por ceguera.
    expect((fuente as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).toEqual(
      [],
    );

    const cuerpo = (() => {
      let hallado: ts.Node | undefined;
      const buscar = (n: ts.Node): void => {
        if (ts.isFunctionDeclaration(n) && n.name?.text === 'sembrarAdminPropio') hallado = n.body;
        else ts.forEachChild(n, buscar);
      };
      ts.forEachChild(fuente, buscar);
      return hallado;
    })();
    // Que esté mirando algo. Si alguien renombra la función, la lista de consultas queda vacía
    // y el guardián aprueba el fichero sin haberlo mirado.
    expect(cuerpo, 'sembrarAdminPropio ya no se llama así: el guardián se quedó sin sujeto').toBeDefined();

    /*
     * El TEXTO de una plantilla SQL, sin sus interpolaciones. `select … where lower(email) =
     * ${email} for update` llega partido en dos trozos por el hueco del parámetro, y la palabra
     * que se busca está en el segundo. Concatenar los trozos es lo que permite leer la consulta
     * entera; los valores interpolados no se miran, que para eso son parámetros.
     */
    const textoDePlantilla = (n: ts.TaggedTemplateExpression): string => {
      const t = n.template;
      if (ts.isNoSubstitutionTemplateLiteral(t)) return t.text;
      return t.head.text + t.templateSpans.map((s) => s.literal.text).join(' ');
    };

    const lecturas: string[] = [];
    const recorrer = (n: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(n)) {
        const sql = textoDePlantilla(n).replace(/\s+/g, ' ').toLowerCase();
        if (/^\s*select\b/.test(sql) && /\bfrom usuario\b/.test(sql)) lecturas.push(sql);
      }
      ts.forEachChild(n, recorrer);
    };
    recorrer(cuerpo!);

    // Al menos la lectura de la cuenta. Cero lecturas significaría que el reconocedor dejó de
    // reconocerlas, no que el seed dejó de leer.
    expect(lecturas.length).toBeGreaterThan(0);

    const sinCandado = lecturas.filter((s) => !/\bfor update\b/.test(s));
    expect(
      sinCandado,
      'una lectura de «usuario» dentro de sembrarAdminPropio decide accesos sin candado: ' +
        'entre ese select y lo que se decide con él cabe una desactivación ajena',
    ).toEqual([]);
  });
});
