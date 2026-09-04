import { afterAll, expect, it } from 'vitest';
import { cerrarPools, sqlAdmin } from '@/lib/db';
import { describeAuthz } from './helpers';

/**
 * El calendario contra el que se miden las garantías lo fija la BASE, no quien llama.
 *
 * `current_date` —y sus hermanos `current_time`, `localtime` y `localtimestamp`— no devuelven
 * un instante: devuelven el reloj de pared EN EL HUSO DE LA SESIÓN, y ese huso lo pone quien
 * llama con `SET LOCAL TIME ZONE`. `SECURITY DEFINER` no protege de esto: presta los
 * privilegios del dueño, no devuelve los parámetros de sesión al valor del servidor. Solo lo
 * que la función fija en su propio `SET` queda fuera del alcance del llamante.
 *
 * `now()` y `current_timestamp` NO están en la lista y es a propósito: devuelven un
 * `timestamptz`, o sea un instante absoluto. El huso solo cambia cómo se IMPRIMEN, no lo que
 * valen, así que compararlos es seguro. Lo que no es seguro es colapsarlos a un día.
 */
describeAuthz('el calendario de las garantías lo fija la base', () => {
  afterAll(async () => {
    await cerrarPools();
  });

  /**
   * Lo que un objeto puede leer del reloj de pared de la sesión. Con `\\b` y no `\\y`: `\\y`
   * es la frontera de palabra de POSIX y en JavaScript no es un escape, así que la expresión
   * pasaba a buscar el literal «ycurrent_datey» y el censo daba verde sin mirar nada. Lo
   * descubrí retirando la migración y viendo que estos tres casos NO enrojecían.
   * `_` cuenta como carácter de palabra, así que un `current_date_de_algo` no se marca.
   */
  const DEL_HUSO_DE_LA_SESION = /\b(current_date|current_time|localtime|localtimestamp)\b/i;

  /**
   * Las excepciones se declaran AQUÍ, con su motivo, o no existen. Vacío es el estado
   * correcto: si algo entra, tiene que entrar con una razón escrita al lado.
   */
  const DECLARADAS: Record<string, string> = {};

  /** Quita los comentarios SQL antes de buscar: un `current_date` dentro de un comentario que
   * EXPLICA por qué ya no se usa es exactamente lo contrario de un hallazgo, y sin esto el
   * censo se volvería contra quien documenta el arreglo. */
  const sinComentarios = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

  it('ninguna función lee el reloj de pared de quien la llama', async () => {
    const funciones = await sqlAdmin()`
      select p.proname as nombre, p.prosrc as cuerpo
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname = 'public' and l.lanname not in ('internal', 'c')
      order by 1`;
    // El censo tiene que estar mirando algo: sin esto, un cambio en la consulta que devuelva
    // cero filas dejaría el test en verde para siempre sin comprobar nada.
    expect(funciones.length).toBeGreaterThan(50);

    const culpables = funciones
      .filter((f) => DEL_HUSO_DE_LA_SESION.test(sinComentarios(f.cuerpo as string)))
      .map((f) => f.nombre as string)
      .filter((n) => !(n in DECLARADAS));
    expect(culpables).toEqual([]);
  });

  it('ninguna política RLS lo lee tampoco', async () => {
    // Una política es el caso peor de todos: se evalúa ENTERA en la sesión de quien escribe,
    // así que no hay ni siquiera un `SECURITY DEFINER` de por medio que confunda. Postgres la
    // devuelve deparseada y en mayúsculas (`CURRENT_DATE`), de ahí la `i` de la expresión.
    const politicas = await sqlAdmin()`
      select tablename || ' / ' || policyname as nombre,
             coalesce(qual, '') || ' ' || coalesce(with_check, '') as cuerpo
      from pg_policies where schemaname = 'public' order by 1`;
    expect(politicas.length).toBeGreaterThan(50);

    const culpables = politicas
      .filter((p) => DEL_HUSO_DE_LA_SESION.test(p.cuerpo as string))
      .map((p) => p.nombre as string)
      .filter((n) => !(n in DECLARADAS));
    expect(culpables).toEqual([]);
  });

  it('ni una vista, ni un CHECK, ni un default, ni una vista MATERIALIZADA', async () => {
    /*
     * Los cuatro sitios que quedan donde una expresión se guarda y se vuelve a evaluar.
     *
     * Un CHECK es el más traicionero: se comprueba al escribir, así que fijaría la fila
     * contra el calendario de quien la escribió y la dejaría incumpliendo su propia
     * restricción. Y una vista MATERIALIZADA es peor todavía, porque no está en `pg_views`
     * sino en `pg_matviews`: su valor se CALCULA con el huso de la sesión que ejecuta el
     * `CREATE` o el `REFRESH`, y se queda ahí congelado — el calendario elegido por quien
     * refrescó, servido después a todo el mundo como si fuera un hecho.
     *
     * Cada categoría se cuenta POR SEPARADO y no en un montón. La versión anterior las unía y
     * exigía «más de 50 filas en total», y eso no comprobaba lo que parecía: medido contra
     * esta base hay 485 constraints —de los cuales solo 141 son CHECK— frente a UNA vista y
     * cero materializadas. Los constraints solos pasaban el listón, así que si la rama de
     * vistas o la de defaults dejaba de devolver filas, el censo seguía en verde sin mirarlas.
     * Es el mismo modo de fallo que ya me comió una vez en este fichero, con la frontera de
     * palabra: verde porque no estaba buscando nada.
     */
    const admin = sqlAdmin();
    const categorias = {
      vista: await admin`select viewname as nombre, definition as cuerpo
        from pg_views where schemaname = 'public'`,
      // Solo `contype = 'c'`: una PK, una unique o una FK no pueden contener una expresión
      // de reloj, así que contarlas era inflar el censo con filas que no prueban nada.
      check: await admin`select conrelid::regclass || '/' || conname as nombre,
             pg_get_constraintdef(c.oid) as cuerpo
        from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public' and c.contype = 'c'`,
      default: await admin`select a.attrelid::regclass || '.' || a.attname as nombre,
             pg_get_expr(d.adbin, d.adrelid) as cuerpo
        from pg_attribute a
        join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        join pg_class rel on rel.oid = a.attrelid
        join pg_namespace n2 on n2.oid = rel.relnamespace
        where n2.nspname = 'public'`,
      matview: await admin`select matviewname as nombre, definition as cuerpo
        from pg_matviews where schemaname = 'public'`,
    };

    /* Lo que cada categoría tiene que estar mirando para que su verde signifique algo. La
     * de vistas materializadas va a CERO a propósito —hoy no hay ninguna— y por eso su rama
     * se comprueba abajo fabricando una, que es la única forma de saber que funciona. */
    const MINIMO: Record<keyof typeof categorias, number> = {
      vista: 1,
      check: 100,
      default: 100,
      matview: 0,
    };
    for (const [nombre, filas] of Object.entries(categorias)) {
      expect(filas.length, `la rama «${nombre}» no está mirando nada`).toBeGreaterThanOrEqual(
        MINIMO[nombre as keyof typeof categorias],
      );
      const culpables = filas
        .filter((o) => DEL_HUSO_DE_LA_SESION.test(o.cuerpo as string))
        .map((o) => `${nombre} ${o.nombre as string}`)
        .filter((n) => !(n in DECLARADAS));
      expect(culpables).toEqual([]);
    }

    // Y la rama de materializadas se comprueba de verdad: con cero filas, un `select` roto
    // daría el mismo verde que uno correcto. Se fabrica una culpable y se exige que la vea.
    await admin`create materialized view censo_tmp_matview as select current_date as d`;
    try {
      const vistas = await admin`select matviewname as nombre, definition as cuerpo
        from pg_matviews where schemaname = 'public'`;
      const pilladas = vistas
        .filter((o) => DEL_HUSO_DE_LA_SESION.test(o.cuerpo as string))
        .map((o) => o.nombre as string);
      expect(pilladas).toEqual(['censo_tmp_matview']);
    } finally {
      await admin`drop materialized view censo_tmp_matview`;
    }
  });

  it('ni el SQL de la aplicación, que es por donde volvió', async () => {
    /*
     * El censo del catálogo no alcanzaba al SQL que la aplicación escribe en sus plantillas,
     * y por ahí volvió el defecto en cuanto se arregló la base: `snapshot_insert` pasó a
     * juzgar con el calendario fijo mientras `contextoDeEntrada` y `seguimientoDeImpacto`
     * seguían diagnosticando con `current_date`. En el borde del día la pantalla ofrecía una
     * fecha que la política rechaza —con el error genérico de RLS— o escondía una que sí
     * acepta, que es justo lo que el comentario de ese módulo dice que no puede pasar: «el
     * espejo LEE la regla; no la reproduce».
     *
     * Se leen los ficheros del repositorio y no el catálogo, porque lo que se vigila es la
     * plantilla, no un objeto de la base. Los tests quedan fuera: ahí `current_date` es
     * legítimo para construir un caso.
     */
    const { readdir, readFile } = await import('node:fs/promises');
    const raiz = new URL('../../', import.meta.url).pathname;
    const ficheros: string[] = [];
    const recorrer = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const ruta = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== '__tests__') await recorrer(ruta);
        } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) ficheros.push(ruta);
      }
    };
    await recorrer(raiz.replace(/\/$/, ''));
    // Que el censo esté mirando algo, y no un directorio que alguien movió.
    expect(ficheros.length).toBeGreaterThan(50);

    const culpables: string[] = [];
    for (const f of ficheros) {
      // Sin comentarios: un `current_date` que EXPLICA por qué ya no se usa no es un
      // hallazgo, y sin esto el censo se volvería contra quien documenta el arreglo.
      const codigo = (await readFile(f, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (DEL_HUSO_DE_LA_SESION.test(codigo)) culpables.push(f.slice(raiz.length));
    }
    expect(culpables.filter((c) => !(c in DECLARADAS))).toEqual([]);
  });

  it('la ventana de medición no se alarga cambiando de huso', async () => {
    /*
     * El caso concreto, sobre la única de las cuatro que es una función PURA —sin filas de por
     * medio, así que lo que falla o pasa es exactamente la comparación de fechas.
     *
     * Se construye sin depender de la hora a la que corra: el mundo abarca a la vez 26 horas
     * de calendario (de UTC-12 a UTC+14), así que la fecha del huso más adelantado es SIEMPRE
     * un día mayor que la del más atrasado. Con la ventana cerrando en la fecha del más
     * atrasado, sin fijar el calendario la misma llamada respondía «abierta» o «cerrada»
     * según lo que el llamante hubiera declarado un renglón antes.
     */
    const admin = sqlAdmin();
    const [dias] = await admin`
      select (timezone('Etc/GMT+12', now()))::date as temprana,
             (timezone('Pacific/Kiritimati', now()))::date as tardia`;
    const temprana = (dias!.temprana as Date).toISOString().slice(0, 10);
    const tardia = (dias!.tardia as Date).toISOString().slice(0, 10);
    // El supuesto sobre el que se apoya el caso, comprobado y no asumido.
    expect(tardia > temprana).toBe(true);

    const respuestas: Record<string, boolean> = {};
    for (const huso of ['Etc/GMT+12', 'UTC', 'Pacific/Kiritimati']) {
      respuestas[huso] = await admin.begin(async (tx) => {
        await tx.unsafe(`set local time zone '${huso}'`);
        const [r] = await tx`select ventana_de_medicion_abierta(${temprana}::date, 0) as v`;
        return r!.v as boolean;
      });
    }
    expect(respuestas['Etc/GMT+12']).toBe(respuestas['Pacific/Kiritimati']);
    expect(respuestas['UTC']).toBe(respuestas['Pacific/Kiritimati']);
    // Y con el calendario fijado en UTC la respuesta no es «cualquiera igual para todos»:
    // es la que corresponde a la fecha de la base, que a esta altura ya pasó o es hoy.
    const [hoy] = await admin`select (timezone('UTC', now()))::date as d`;
    expect(respuestas['UTC']).toBe(temprana >= (hoy!.d as Date).toISOString().slice(0, 10));
  });
});
