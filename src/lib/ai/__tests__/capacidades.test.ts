import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  CAPACIDADES,
  CAPACIDADES_ACTIVAS,
  COLUMNAS_DE_ANCLA,
  COLUMNA_DE_DESTINO,
  DestinoSchema,
  RevisarPropuestaSchema,
  type ContenidoExtraccion,
  MAX_REMEDIACIONES,
} from '../ai.schemas';
import { ESQUEMA_DE_CONTENIDO, parsearContenido } from '../ai.contenido';
import {
  CamposEntradaSchema,
  MAX_DEFINICION_KPI,
  MAX_DIMENSIONES_KPI,
  MAX_FUENTE_KPI,
  MAX_NOMBRE_KPI,
} from '@/lib/medicion/medicion.schemas';
import { ESQUEMA_SALIDA } from '../ai.prompts';

const RAIZ = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

/** Una extracción válida para CI: sirve para comprobar que la frontera tampoco recorta lo
 * que SÍ encaja en una capacidad. */
const CONTENIDO_CI: ContenidoExtraccion = {
  titulo: 'Abandono en verificación',
  resumen: '',
  recoleccion: 'Análisis de funnel',
  fecha: '2026-07-20',
  fechaLocalizacion: 'párrafo 1',
  fechaSinDatoMotivo: '',
  derivada: true,
  confianza: 'media',
  confidencialidad: 'cliente',
  esEstadoActual: true,
  confianzaPropuesta: 'alta',
  citas: [{ fragmento: 'El 71% de los abandonos', localizacion: 'párrafo 1' }],
};

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
      /*
       * `destino` puede ser `null` —capacidad INFORMATIVA, RF-08.4— pero lo que NO puede ser
       * es un valor fuera del catálogo. `toBeTruthy()` decía las dos cosas a la vez y ahora
       * solo puede decir una: se separa en la que sigue valiendo.
       *
       * Y `null` no se acepta a ciegas: la comprobación de más abajo exige que una capacidad
       * sin destino tampoco tenga forma de aceptarse, que es lo que distingue «informativa»
       * de «se me olvidó declarar el destino».
       */
      expect(
        d.destino === null || (DestinoSchema.options as readonly string[]).includes(d.destino),
        `${c}: destino fuera del catálogo (${String(d.destino)})`,
      ).toBe(true);
      expect(ESQUEMA_DE_CONTENIDO[c], `${c} sin esquema de contenido`).toBeTruthy();
      // El ancla es lo que más varía y lo que más veces se pregunta: si a una capacidad le
      // falta una de estas piezas, la pantalla enseñaría `undefined` a un curador.
      for (const pieza of ['etiqueta', 'enProsa', 'buscar', 'vacia', 'enCurso', 'pendiente'] as const) {
        expect(d.ancla[pieza].length, `${c}: ancla sin ${pieza}`).toBeGreaterThan(0);
      }
      expect(d.ancla.hayMas(3), `${c}: ancla sin texto de desbordamiento`).toContain('3');
      if (d.lote !== null) {
        expect(d.lote.campo.length, `${c}: lote sin campo`).toBeGreaterThan(0);
        expect(d.lote.maximo, `${c}: lote sin techo`).toBeGreaterThan(0);
        // El suelo se declara, y puede ser CERO: lo que no puede es faltar, ni pasarse del
        // techo, que dejaría un rango vacío y ninguna respuesta válida.
        expect(d.lote.minimo, `${c}: lote sin suelo`).toBeGreaterThanOrEqual(0);
        expect(d.lote.minimo, `${c}: el suelo del lote pasa de su techo`).toBeLessThanOrEqual(
          d.lote.maximo,
        );
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
   * La marca de SIMULACIÓN tiene que LLEGAR a la base.
   *
   * `propuesta_ai.es_simulacion` tiene `default false`, así que omitirla en el insert no
   * dejaba un hueco visible: dejaba un `false`. Declarar `esSimulacion: true` en una
   * capacidad futura habría PARECIDO suficiente, y sus hallazgos habrían llegado a la
   * revisión sin la etiqueta que SYS-20 exige imborrable — presentables como propuestas
   * ordinarias. Un valor declarado que no llega a ninguna parte es peor que no declararlo:
   * parece que está puesto.
   *
   * Se comprueba el ACOPLAMIENTO y no el dato, y por una razón medida: hoy las dos
   * capacidades activas declaran `false`, así que una fila leída de vuelta valdría `false`
   * con la columna puesta y sin ella. La prueba que distinguiría las dos llega con C4, que
   * es la primera que declara `true`; hasta entonces, lo único que se puede sujetar es que
   * el insert la nombre y que el valor salga del registro.
   */
  it('lleva la marca de simulación declarada hasta el insert de propuesta_ai', async () => {
    const raiz = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
    const codigo = await readFile(`${raiz}/src/lib/ai/ai.servicio.ts`, 'utf8');
    const insert = codigo.slice(codigo.indexOf('insert into propuesta_ai'));
    // Que esté mirando el insert de verdad y no una cadena vacía por un renombrado.
    expect(insert.length).toBeGreaterThan(200);
    const sentencia = insert.slice(0, insert.indexOf('returning id'));
    expect(sentencia).toContain('es_simulacion');
    expect(sentencia).toContain('CAPACIDADES[entrada.capacidad].esSimulacion');
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

    // Y el DESTINO cuenta igual. `destino === 'evidencia' ? ficha : otraFicha` tiene el mismo
    // modo de fallo con otro nombre: la tarjeta pintaba todo destino nuevo como criterio de
    // éxito, con campos que no son los suyos y un formulario cuya corrección rechaza después
    // el esquema de su capacidad. Presentar mal una propuesta es peor que no presentarla,
    // porque el revisor decide sobre lo que ve.
    const CAPACIDADES_LITERALES = new Set<string>(CAPACIDADES_ACTIVAS);
    const DESTINOS_LITERALES = new Set<string>(Object.keys(COLUMNA_DE_DESTINO));
    const hallazgos: string[] = [];
    for (const f of ficheros) {
      const codigo = await readFile(f, 'utf8');
      /*
       * La gramática, por la EXTENSIÓN. Forzar TSX sobre un `.ts` no es un detalle: en TSX,
       * `<T>(x: T) => x` se lee como JSX y se traga el resto del fichero. Medido sobre un `.ts`
       * con una flecha genérica y una aserción de tipo, con dos llamadas detrás:
       * TSX ve 0, TS ve 2.
       *
       * Y aquí el fallo cae del lado MALO: lo que no se visita no se denuncia, así que este
       * guardián pasaría en verde sin haber leído `ai.servicio.ts` — el día que alguien meta
       * una flecha genérica ahí, todas las ramas binarias por capacidad dejarían de verse.
       * (En el censo del calendario TSX sí es lo correcto y está razonado allí: un fichero mal
       * parseado hace que sus literales dejen de reconocerse como tales, así que mira de MÁS.
       * Lo que decide es la dirección del fallo.)
       */
      const arbol = ts.createSourceFile(
        f,
        codigo,
        ts.ScriptTarget.Latest,
        true,
        f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      // Y lo que no parsea limpio no se da por barrido: elegir bien la gramática cierra el
      // caso conocido; esto convierte cualquier caso futuro en rojo en vez de un verde vacío.
      const diagnosticos = (arbol as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
      expect(diagnosticos ?? [], `${f} no parsea limpio: el barrido no lo ha leído`).toHaveLength(
        0,
      );
      const recorrer = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n)) {
          const op = n.operatorToken.kind;
          const comparacion =
            op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
          // El nombre `capacidad` a cualquiera de los dos lados, contra un literal que sea el
          // de una capacidad: `entrada.capacidad === 'CI'` y `'CI' === capacidad` cuentan igual.
          const nombra = (x: ts.Node): boolean =>
            (ts.isIdentifier(x) && (x.text === 'capacidad' || x.text === 'destino')) ||
            (ts.isPropertyAccessExpression(x) &&
              (x.name.text === 'capacidad' || x.name.text === 'destino'));
          const literal = (x: ts.Node): boolean =>
            ts.isStringLiteral(x) &&
            (CAPACIDADES_LITERALES.has(x.text) || DESTINOS_LITERALES.has(x.text));
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

  /**
   * La frontera de la corrección TRANSPORTA; no juzga.
   *
   * `RevisarPropuestaSchema` recibe un `propuestaId`, no una capacidad: cuál es se lee de la
   * fila, dentro de la transacción, varias llamadas después. Aquí hubo una `z.union` —primero
   * escrita a mano, luego derivada del registro— y las dos compartían el defecto: una unión
   * PARSEA. Elige la primera rama que encaje, aplica sus `default()` y RECORTA lo que esa
   * rama no declara. Como la rama elegida no era la de la propuesta sino la primera que
   * tolerase el payload, al servicio llegaba una corrección ya recortada a la forma de otra
   * capacidad — y se guardaba así, con campos de menos y sin que nadie viera un error.
   *
   * Lo que se sujeta es la propiedad, no la escritura: lo que entra por la puerta sale
   * IDÉNTICO. Si alguien vuelve a poner un esquema aquí, esto enrojece.
   */
  it('deja pasar la corrección sin tocarla: la capacidad la juzga el servicio', () => {
    const base = { workspaceId: crypto.randomUUID(), propuestaId: crypto.randomUUID() };

    // 1. Un contenido que hoy NINGUNA capacidad declara —el de la capacidad que viene—
    //    cruza la frontera entero. La unión lo rechazaba antes de que `parsearContenido`,
    //    que sí sabría contra qué medirlo, llegara a verlo.
    const ajeno = { campoQueNadieDeclara: 'x', anidado: { lista: [1, 2, 3] }, n: 0 };
    expect(RevisarPropuestaSchema.parse({ ...base, correccion: ajeno }).correccion).toEqual(ajeno);

    // 2. Y un contenido que SÍ encaja en una capacidad tampoco se recorta al pasar: los
    //    campos de más siguen ahí para que los examine el esquema de SU capacidad.
    const conDeMas = { ...CONTENIDO_CI, campoDeMas: 'sobrevive' };
    expect(RevisarPropuestaSchema.parse({ ...base, correccion: conDeMas }).correccion).toEqual(
      conDeMas,
    );

    // 3. AUSENTE y PRESENTE no son lo mismo: ausente es aceptar lo propuesto; un `null`
    //    presente es una corrección con forma inválida, y muere en `parsearContenido` con su
    //    mensaje. Por eso el servicio pregunta por `undefined` y no por la verdad del valor.
    expect('correccion' in RevisarPropuestaSchema.parse(base)).toBe(false);
    const conNull = RevisarPropuestaSchema.parse({ ...base, correccion: null });
    expect('correccion' in conNull).toBe(true);
    expect(conNull.correccion).toBeNull();
    expect(() => parsearContenido('CI', null)).toThrow();
  });

  /**
   * Las sentencias del pipeline no nombran a mano ninguna columna de ancla.
   *
   * Los tres inserts —`reserva_ai`, `llamada_ai`, `propuesta_ai`— escribían
   * `item_id, reto_id` tecleados, y para que una tercera no se quedara fuera se declaró un
   * `Record<AnclaCapacidad['columna'], …>`… construido con un `Object.fromEntries` sobre las
   * claves de ese mismo tipo. Un Record derivado del tipo que dice vigilar lo satisface
   * SIEMPRE: ampliar el ancla compilaba, el guardián seguía verde y los inserts seguían
   * escribiendo dos columnas de tres. Un testigo que firma lo que sea.
   *
   * La salida no fue un guardián mejor sino quitarle el trabajo: las listas se GENERAN desde
   * `COLUMNAS_DE_ANCLA`. Esto vigila que sigan generándose — que es lo único que aquí puede
   * volver atrás, porque una lista escrita a mano compila igual de bien.
   */
  it('no teclea ninguna columna de ancla en las sentencias del pipeline', async () => {
    const codigo = await readFile(`${RAIZ}/src/lib/ai/ai.servicio.ts`, 'utf8');

    // Las TRES tablas del pipeline, que son las que llevan una columna POR TIPO de ancla.
    // Fuera de ellas, `item_id` y `reto_id` son la clave ajena propia de otra tabla
    // —`consentimiento_item` cuelga de un item, `criterio_exito` de un reto— y ahí nombrarlas
    // es lo correcto: no hay ningún hueco por tipo de ancla que se pueda quedar sin llenar.
    const DEL_PIPELINE = ['reserva_ai', 'llamada_ai', 'propuesta_ai'];

    // La lista de columnas de un `insert into <tabla> (…)`: desde el paréntesis que sigue al
    // nombre de la tabla hasta el que lo cierra.
    const listas: { tabla: string; columnas: string }[] = [];
    for (const m of codigo.matchAll(/insert into\s+(\w+)\s*\n?\s*\(/g)) {
      let nivel = 1;
      let i = m.index! + m[0].length;
      while (i < codigo.length && nivel > 0) {
        if (codigo[i] === '(') nivel += 1;
        else if (codigo[i] === ')') nivel -= 1;
        i += 1;
      }
      listas.push({ tabla: m[1]!, columnas: codigo.slice(m.index! + m[0].length, i - 1) });
    }
    // Que esté mirando las tres de verdad: con cero listas esto pasaría sin leer nada.
    for (const t of DEL_PIPELINE) {
      expect(listas.map((l) => l.tabla), `no se encontró el insert de ${t}`).toContain(t);
    }

    const tecleadas: string[] = [];
    for (const { tabla, columnas } of listas.filter((l) => DEL_PIPELINE.includes(l.tabla))) {
      for (const c of COLUMNAS_DE_ANCLA) {
        if (new RegExp(`\\b${c}\\b`).test(columnas)) tecleadas.push(`${tabla} nombra ${c}`);
      }
    }
    expect(tecleadas).toEqual([]);
  });

  /**
   * La bandera del consentimiento ENCIENDE la puerta; no la describe.
   *
   * `exigeConsentimiento` estaba declarado y no lo leía nadie: el candado y la comprobación
   * vivían escritos a mano dentro de la entrada de CI en `PREPARAR` y en `REVALIDAR`. Una
   * capacidad futura podía declarar `true` y mandar material de personas al proveedor sin
   * puerta — y el compilador no habría echado nada de menos, porque no faltaba ninguna
   * entrada: faltaba que la bandera sirviera para algo. Es el defecto de esta serie con la
   * peor consecuencia posible (RF-09.5).
   */
  it('gobierna la puerta del consentimiento desde la declaración, no desde cada capacidad', async () => {
    const codigo = await readFile(`${RAIZ}/src/lib/ai/ai.servicio.ts`, 'utf8');

    // 1. Los DOS despachos consultan la bandera. Si alguien vuelve a meter la puerta dentro de
    //    una capacidad, la bandera deja de decidir y esto lo dice.
    const consultas = codigo.match(/CAPACIDADES\[entrada\.capacidad\]\.exigeConsentimiento/g) ?? [];
    expect(consultas.length, 'la bandera tiene que gobernar preparación y despacho').toBe(2);

    // 2. Y ninguna entrada de PREPARAR/REVALIDAR la escribe a mano. Se miran los dos registros
    //    acotados, no el fichero entero: la puerta compartida SÍ tiene que nombrar esas cosas.
    for (const registro of ['const PREPARAR', 'const REVALIDAR']) {
      const desde = codigo.indexOf(registro);
      expect(desde, `no se encontró ${registro}`).toBeGreaterThan(0);
      const cuerpo = codigo.slice(desde, codigo.indexOf('\n};', desde));
      expect(cuerpo.length).toBeGreaterThan(200);
      for (const aMano of ['bloquearConsentimiento', 'consentimiento_externo_vigente']) {
        expect(cuerpo, `${registro} vuelve a comprobar el consentimiento a mano`).not.toContain(
          aMano,
        );
      }
    }
  });

  /**
   * Y la precondición de esa puerta: quien exige consentimiento ancla en `item_id`.
   *
   * El consentimiento es de material de PERSONAS, y ese material vive en `item_importacion`
   * —allí están `tipo_fuente` y `consentimiento_item`—, así que la puerta pregunta ahí. El día
   * que una capacidad exija consentimiento anclando en otra cosa, esto enrojece en vez de
   * dejar la puerta preguntando por una fila que no existe: `item?.falta` sería `undefined`,
   * que NO es verdadero, y el material saldría hacia el proveedor sin permiso.
   */
  it('quien exige consentimiento ancla donde vive el consentimiento', () => {
    for (const c of CAPACIDADES_ACTIVAS) {
      const d = CAPACIDADES[c];
      if (!d.exigeConsentimiento) continue;
      expect(d.ancla.columna, `${c} exige consentimiento y no ancla en un item`).toBe('item_id');
    }
  });

  /**
   * Y el enlace del objeto materializado se escribe EN la columna que el destino nombra.
   *
   * El sello elegía con dos ternarios —`COLUMNA_DE_DESTINO[destino] === 'evidencia_id' ? …`—,
   * así que consultaba el mapa y luego no usaba su valor para nada: lo que decidía dónde iba
   * el id seguían siendo los dos nombres escritos en el SQL. Un destino nuevo hacía fallar
   * los dos ternarios y sellaba una propuesta aceptada sin objeto, contra SYS-19.
   */
  it('no teclea ninguna columna de destino en el sello de la propuesta', async () => {
    const codigo = await readFile(`${RAIZ}/src/lib/ai/ai.servicio.ts`, 'utf8');
    const desde = codigo.indexOf('update propuesta_ai');
    expect(desde, 'no se encontró el UPDATE que sella la propuesta').toBeGreaterThan(0);
    const sello = codigo.slice(desde, codigo.indexOf('returning estado', desde));
    expect(sello.length).toBeGreaterThan(200);

    // Se mira la sentencia SIN sus comentarios: el porqué del cambio nombra las columnas
    // viejas a propósito, y hablar del idioma viejo no es escribirlo.
    const sinComentarios = sello.replace(/^\s*--.*$/gm, '');
    const tecleadas = Object.values(COLUMNA_DE_DESTINO).filter((c) =>
      new RegExp(`\\b${c}\\b`).test(sinComentarios),
    );
    expect(tecleadas).toEqual([]);
    // Y la asignación sale del mapa.
    expect(sinComentarios).toContain('COLUMNA_DE_DESTINO[p.destino]');
  });

  /**
   * Ni en la proyección que lee la propuesta que se va a revisar.
   *
   * Nombraba `item_id, reto_id` a mano y los materializadores tomaban el suyo con un `!`. Un
   * ancla nueva no llegaba a su materializador —y uno de los de ahora, ante una fila anclada
   * en otra columna, recibía `null` y reventaba contra su clave ajena—.
   */
  it('no teclea ninguna columna de ancla en la lectura para revisar', async () => {
    const codigo = await readFile(`${RAIZ}/src/lib/ai/ai.servicio.ts`, 'utf8');
    const desde = codigo.indexOf('async function leerParaRevisar');
    expect(desde, 'no se encontró leerParaRevisar').toBeGreaterThan(0);
    const cuerpo = codigo.slice(desde, codigo.indexOf('\n}', desde));
    expect(cuerpo.length).toBeGreaterThan(300);
    const seleccion = cuerpo.slice(cuerpo.indexOf('select'), cuerpo.indexOf('from propuesta_ai'));
    const tecleadas = COLUMNAS_DE_ANCLA.filter((c) => new RegExp(`\\b${c}\\b`).test(seleccion));
    expect(tecleadas).toEqual([]);
    expect(seleccion).toContain('columnasDeAncla');
  });

  /**
   * El sobre del lote y el esquema que se le pide al proveedor son EL MISMO.
   *
   * Eran dos: `CAPACIDADES[c].lote` decía qué campo lee el servicio y con qué techo, y
   * `ESQUEMA_SALIDA` declaraba a mano el campo y el `maxItems` que se le piden al proveedor.
   * Gobiernan el mismo sobre y nada las ataba —la comprobación de la costura solo miraba que
   * las dos listas tuvieran las mismas claves—. Con un campo distinto en cada sitio, el
   * proveedor devuelve exactamente lo que su esquema pide y el servicio lee otra propiedad:
   * descarta por «fuera de contrato» una llamada YA PAGADA. Con un techo distinto, la descarta
   * por tamaño.
   */
  it('le pide al proveedor el mismo sobre que el servicio va a leer', () => {
    for (const c of CAPACIDADES_ACTIVAS) {
      const { lote } = CAPACIDADES[c];
      const esquema = ESQUEMA_SALIDA[c] as {
        type: string;
        required: string[];
        properties: Record<string, { type: string; minItems?: number; maxItems?: number }>;
      };
      if (lote === null) {
        // Sin lote, el objeto viene en la RAÍZ. Que no haya sobre es la mitad que importa:
        // un sobre de más y el servicio buscaría el objeto donde no está.
        expect(esquema.properties[c], `${c} no debería declarar sobre`).toBeUndefined();
        continue;
      }
      expect(esquema.required, `${c}: el sobre pedido no es el que se lee`).toEqual([lote.campo]);
      const sobre = esquema.properties[lote.campo];
      expect(sobre, `${c}: el esquema no declara ${lote.campo}`).toBeDefined();
      expect(sobre!.type).toBe('array');
      expect(sobre!.maxItems, `${c}: el techo pedido no es el que se valida`).toBe(lote.maximo);
      // Y el SUELO, que es la mitad que faltaba. Estaba escrito `1` a los dos lados: correcto
      // para C5 —se niega a llamar con cero señales, así que ninguna petición real tiene la
      // lista vacía por respuesta— y falso para C2, cuyo prompt dice «hasta N» y prohíbe
      // proponer lo que la evidencia no sostenga. Con el suelo en uno, una evidencia que no
      // sostiene nada obliga al modelo a inventarse un insight, o su respuesta ya pagada se
      // descarta como fuera de contrato por haber obedecido.
      expect(sobre!.minItems, `${c}: el suelo pedido no es el que se valida`).toBe(lote.minimo);
    }
  });

  /**
   * Y las listas de DENTRO del contenido también: lo que se le pide al proveedor y lo que se
   * valida al parsear tienen que decir lo mismo.
   *
   * El caso de arriba mira el SOBRE del lote; esto mira las listas que viajan dentro de un
   * contenido. C5 lleva la suya —`remediaciones`— y su esquema de proveedor no pedía mínimo,
   * con el argumento de que un grafo limpio no tiene nada que remediar. Ese argumento murió
   * cuando C5 pasó a negarse a llamar con cero señales: desde entonces no había ninguna
   * petición real cuya respuesta correcta fuera la lista vacía, y dejarla abierta solo
   * significaba aceptar del proveedor algo que `contenidosValidos` iba a descartar DESPUÉS de
   * pagarlo.
   *
   * Los dos números salen de `MAX_REMEDIACIONES`, así que lo que esto sujeta es que el
   * esquema del proveedor no se quede atrás cuando ese techo cambie.
   */
  it('las listas dentro del contenido piden lo mismo que se valida', () => {
    const c5 = ESQUEMA_SALIDA.C5 as {
      properties: { remediaciones?: { minItems?: number; maxItems?: number } };
    };
    expect(c5.properties.remediaciones, 'C5 no declara sus remediaciones').toBeDefined();
    expect(
      c5.properties.remediaciones!.minItems,
      'el proveedor puede devolver un informe vacío que el contrato rechaza después de pagarlo',
    ).toBe(1);
    expect(c5.properties.remediaciones!.maxItems).toBe(MAX_REMEDIACIONES);
  });

  /**
   * Y lo que C6 propone cabe en el EDITOR que después lo va a guardar.
   *
   * Los cuatro campos de texto de una entrada KPI los escribe C6 y los reescribe el editor del
   * registry, y sus topes estaban escritos dos veces: coincidían en dos y eran más anchos en
   * los otros dos. Una entrada materializada con 400 caracteres de `fuente` pasaba el pipeline
   * de la AI, y a partir de ahí el editor —que hidrata su formulario con esos valores— se
   * negaba a guardar hasta acortarla. Como es por ahí por donde se rellenan el dueño del dato,
   * la línea base y la ventana, la entrada quedaba bloqueando la FIRMA de su propio contrato,
   * y el mensaje no decía qué campo sobraba.
   *
   * Ahora los dos esquemas leen la misma constante, y esto lo sujeta por la CONDUCTA: un texto
   * de un carácter por encima del tope tiene que caer en los dos. Comparar los números entre
   * sí no serviría —serían la misma constante mirada dos veces—; lo que hay que sostener es
   * que ninguno de los dos acepte lo que el otro rechaza.
   */
  it('los textos que C6 propone caben en el editor del registry', () => {
    const CAMPOS = [
      ['nombre', MAX_NOMBRE_KPI],
      ['definicion', MAX_DEFINICION_KPI],
      ['fuente', MAX_FUENTE_KPI],
      ['dimensiones', MAX_DIMENSIONES_KPI],
    ] as const;
    const base = {
      criterioId: 'c3d4e5f6-0000-4000-8000-00000000000a',
      nombre: 'Tasa de verificación',
      definicion: 'Completadas / iniciadas',
      fuente: 'Eventos de la app',
      dimensiones: 'canal',
      frecuencia: 'mensual' as const,
      citas: [{ fragmento: 'Tiempo de verificación', localizacion: 'KPI' }],
      confianzaPropuesta: 'media' as const,
    };
    for (const [campo, tope] of CAMPOS) {
      const pasado = 'x'.repeat(tope + 1);
      expect(
        ESQUEMA_DE_CONTENIDO.C6.safeParse({ ...base, [campo]: pasado }).success,
        `C6 acepta un ${campo} que el editor del registry va a rechazar`,
      ).toBe(false);
      // Y el tope ES el del editor, no un número que se le parece: sin esta mitad, subir el
      // del editor dejaría la comparación midiendo contra una constante huérfana.
      expect(
        CamposEntradaSchema.safeParse({
          workspaceId: '00000000-0000-4000-8000-000000000001',
          frecuencia: 'mensual',
          [campo]: pasado,
        }).success,
        `el editor acepta un ${campo} de ${tope + 1}: la constante no es su tope`,
      ).toBe(false);
    }
    // Y justo en el tope entran los dos, que es la mitad sin la cual un esquema que rechazara
    // todo pasaría igual.
    expect(ESQUEMA_DE_CONTENIDO.C6.safeParse({ ...base, fuente: 'x'.repeat(MAX_FUENTE_KPI) }).success)
      .toBe(true);
  });
});

/**
 * Toda capacidad que ANIDA sus citas tiene que decir de quién cuelga cada una.
 *
 * `CITAS_DEL_CONTENIDO` aplana para dos trabajos: medir la presencia literal —a la que el
 * reparto le da igual— y comprobar que una corrección no toca las citas. Para el segundo,
 * aplanar PIERDE lo que hay que proteger: con las citas dentro de cada hallazgo (C4) o de cada
 * afirmación (C2), `[A], [B]` y `[A, B], []` son la misma lista, así que una corrección podía
 * repartirlas de otra manera —mover el documento que sostenía a una hipótesis debajo de una
 * afirmación— y la comprobación las veía idénticas. La materialización persiste el reparto
 * nuevo, y eso es lo único contrastable que hay: qué documento sostiene cuál lectura.
 *
 * Se mide por la FORMA del registro y no contra una lista escrita a mano de «las que anidan»:
 * esa lista sería una segunda redacción de la regla, y la capacidad que llegue anidando y sin
 * `grupo` pasaría por no estar en ella. Un `flatMap` en la entrada ES el anidamiento.
 *
 * El registro que se lee es `CITAS_POR_CAPACIDAD`, que es donde vive el lector de cada una;
 * `CITAS_DEL_CONTENIDO` se DERIVA de él para canonizar el `alcanceId`, y por eso ya no es un
 * literal que se pueda recorrer. El censo se ancla a un nombre, así que se comprueba además
 * que la exportación siga saliendo de ESTE registro: si mañana se derivara de otro, el censo
 * se quedaría midiendo un literal muerto y pasaría en verde sobre la capacidad nueva.
 */
it('las capacidades que anidan sus citas llevan el reparto en cada una', async () => {
  const ruta = `${RAIZ}/src/lib/ai/ai.contenido.ts`;
  const codigo = await readFile(ruta, 'utf8');
  const arbol = ts.createSourceFile(ruta, codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnosticos = (arbol as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  expect(diagnosticos ?? [], 'ai.contenido.ts no parsea limpio: el censo no lo ha leído').toEqual(
    [],
  );

  const entradas = new Map<string, string>();
  let derivado = '';
  const recorrer = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (n.name.text === 'CITAS_POR_CAPACIDAD' && ts.isObjectLiteralExpression(n.initializer)) {
        for (const prop of n.initializer.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            entradas.set(prop.name.text, prop.initializer.getText(arbol));
          }
        }
      }
      if (n.name.text === 'CITAS_DEL_CONTENIDO') derivado = n.initializer.getText(arbol);
    }
    ts.forEachChild(n, recorrer);
  };
  recorrer(arbol);

  // Y el censo se cae si no encuentra el registro, en vez de pasar sobre un mapa vacío.
  expect([...entradas.keys()].sort(), 'el censo no leyó el registro de citas').toEqual(
    [...CAPACIDADES_ACTIVAS].sort(),
  );
  // Y que lo que consume el resto del sistema sea ESTE registro y no otro: sin esto, el censo
  // se ancla a un nombre que puede quedarse atrás sin que nada lo diga.
  expect(
    derivado,
    '`CITAS_DEL_CONTENIDO` ya no se deriva de `CITAS_POR_CAPACIDAD`: el censo está midiendo un registro que nadie lee',
  ).toMatch(/\bCITAS_POR_CAPACIDAD\b/);

  const anidan = [...entradas].filter(([, cuerpo]) => cuerpo.includes('.flatMap('));
  expect(anidan.length, 'ninguna capacidad anida sus citas: el censo no mide nada').toBeGreaterThan(
    0,
  );
  for (const [capacidad, cuerpo] of anidan) {
    expect(
      cuerpo,
      `${capacidad} anida sus citas y no declara \`grupo\`: aplanadas, dos repartos distintos de las mismas citas son la misma lista, y una corrección que las mueve de hallazgo pasa por «las citas no cambiaron»`,
    ).toMatch(/\bgrupo:/);
  }
});
