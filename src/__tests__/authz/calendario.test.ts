import { afterAll, beforeAll, expect, it } from 'vitest';
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
   * Las palabras clave del reloj de pared. Son de la GRAMÁTICA, no funciones, así que no
   * salen del catálogo y esta lista es a mano — pero es cerrada: la define el estándar SQL y
   * no crece. `(\s*\(\s*\d+\s*\))?` es por la precisión opcional, que Postgres conserva
   * al deparsear: `current_timestamp(0)` se guarda tal cual y sin eso quedaba fuera.
   *
   * Con `\b` y no `\y`: `\y` es la frontera de palabra de POSIX y en JavaScript no es un
   * escape, así que la expresión buscaba el literal «ycurrent_datey» y el censo daba verde
   * sin mirar nada. `_` cuenta como carácter de palabra, así que `current_date_pactada` no
   * se marca.
   */
  const PRECISION = String.raw`(?:\s*\(\s*\d+\s*\))?`;
  const PALABRAS_DEL_RELOJ = [
    // De más larga a más corta: con `current_time` delante, la alternación la casaba dentro
    // de `current_timestamp` y el resto quedaba suelto.
    `current_timestamp${PRECISION}`,
    `current_time${PRECISION}`,
    `localtimestamp${PRECISION}`,
    `localtime${PRECISION}`,
    'current_date',
  ];

  /**
   * Los CAMPOS que no dependen del huso, medidos contra dos husos extremos y siete instantes
   * elegidos para cruzar frontera de día, mes, año, década, siglo y milenio. La lista va al
   * revés que la primera versión —enumera lo SEGURO y marca todo lo demás— y ese giro importa
   * más que su contenido: enumerando lo peligroso, un campo que no se me ocurriera quedaba sin
   * marcar; enumerando lo seguro, queda marcado. El error cae del lado que avisa.
   *
   * Medir con UN solo instante daba `month`, `year` y `week` como independientes, porque ese
   * instante no cruzaba esas fronteras. Es el mismo muestreo que ya me costó un carácter
   * Unicode, así que aquí van siete instantes y dos husos.
   */
  const CAMPOS_SEGUROS = 'epoch|microseconds|milliseconds|second|minute';
  /** Y las precisiones de `date_trunc`, por el mismo criterio y la misma medición. */
  const UNIDADES_SEGURAS = 'microseconds|milliseconds|second|minute';

  /** Se rellena en el primer caso: los relojes que el CATÁLOGO declara, para no listarlos. */
  let RELOJES = '';
  let RELOJ_COLAPSADO_A_DIA: RegExp[] = [];
  let DEL_HUSO_DE_LA_SESION: RegExp;

  beforeAll(async () => {
    /*
     * Los relojes que son FUNCIONES se derivan del catálogo en vez de escribirlos: cualquier
     * función de `pg_catalog` sin argumentos que devuelva un tipo de tiempo y no sea inmutable
     * lee el reloj. Así salen `now`, `clock_timestamp`, `statement_timestamp` y
     * `transaction_timestamp` —el que faltaba— sin que nadie tenga que acordarse, y también
     * las de información del servidor, cuyo día colapsado depende del huso igual.
     */
    const filas = await sqlAdmin()`
      select p.proname as nombre
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'pg_catalog' and p.pronargs = 0 and p.provolatile in ('s', 'v')
        and format_type(p.prorettype, null) in ('timestamp with time zone',
            'timestamp without time zone', 'date', 'time with time zone',
            'time without time zone')
      order by 1`;
    const funciones = filas.map((f) => `${f.nombre as string}\\s*\\(\\s*\\)`);
    expect(funciones.length).toBeGreaterThanOrEqual(4);
    RELOJES = [...funciones, ...PALABRAS_DEL_RELOJ].join('|');
    // La frontera de palabra va a los DOS lados: sin la de la derecha,
    // `current_date_pactada` —un identificador que contiene la palabra— salía marcado, y un
    // censo que marca lo que no es se acaba desactivando. Con `_` como carácter de palabra,
    // `\b` la separa; y no estorba a la precisión, porque `current_time(3)` sí tiene
    // frontera entre la `e` y el paréntesis.
    DEL_HUSO_DE_LA_SESION = new RegExp(
      String.raw`\b(${PALABRAS_DEL_RELOJ.join('|')})\b`,
      'i',
    );
    RELOJ_COLAPSADO_A_DIA = [
      // `date_trunc('day', now())`, y su forma deparseada `date_trunc('day'::text, now())`.
      // Marca CUALQUIER unidad que no esté en la lista segura.
      new RegExp(
        String.raw`date_trunc\s*\(\s*'(?!(?:${UNIDADES_SEGURAS})')[^']*'(::\w+)?\s*,\s*(${RELOJES})\s*\)`,
        'i',
      ),
      // `now()::date` tal como se escribe…
      new RegExp(String.raw`\b(${RELOJES})\s*::\s*(date|time)\b`, 'i'),
      // …y tal como Postgres la devuelve: `(now())::date`, con paréntesis propios. Es la forma
      // canónica a la que reduce también `cast(now() as date)`. NO marca
      // `(timezone('UTC'::text, now()))::date`, porque ahí el paréntesis que precede al `::`
      // es el de `timezone`: el reloj va envuelto.
      new RegExp(String.raw`\(\s*(${RELOJES})\s*\)\s*::\s*(date|time)\b`, 'i'),
      // `cast(now() as date)` en el código fuente, antes de que nadie la deparsee.
      new RegExp(String.raw`cast\s*\(\s*(${RELOJES})\s+as\s+(date|time)\b`, 'i'),
      // `date(now())`, la tercera forma de escribir la misma conversión.
      new RegExp(String.raw`\b(date|time)\s*\(\s*(${RELOJES})\s*\)`, 'i'),
      // `to_char(now(), 'YYYY-MM-DD')`: no colapsa a un `date` pero produce el mismo día del
      // huso, y una regla escrita sobre esa cadena decide igual. El reloj tiene que ser el
      // PRIMER argumento — envuelto en `timezone('UTC', …)` ya no lo es.
      new RegExp(String.raw`to_char\s*\(\s*(${RELOJES})\s*,`, 'i'),
      // `extract(day from now())` y `EXTRACT(day FROM now())`: no colapsa a un día entero,
      // extrae UN campo del calendario, y el campo cambia con el huso igual.
      new RegExp(
        String.raw`extract\s*\(\s*(?!(?:${CAMPOS_SEGUROS})\b)\w+\s+from\s+(${RELOJES})`,
        'i',
      ),
      // `date_part('dow', now())`, que es la misma operación con la otra sintaxis, y su forma
      // deparseada `date_part('dow'::text, now())`.
      new RegExp(
        String.raw`date_part\s*\(\s*'(?!(?:${CAMPOS_SEGUROS})')[^']*'(::\w+)?\s*,\s*(${RELOJES})`,
        'i',
      ),
    ];
  });

  /** Lo que hace culpable a un cuerpo: la palabra clave o cualquiera de las operaciones. */
  const culpable = (cuerpo: string) =>
    DEL_HUSO_DE_LA_SESION.test(cuerpo) || RELOJ_COLAPSADO_A_DIA.some((r) => r.test(cuerpo));

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

  /**
   * Una forma peligrosa por CADA patrón, y una segura por cada trampa que los patrones tienen
   * que esquivar. Se fabrican como funciones y se exige que el censo señale exactamente las
   * primeras: sin esto, los patrones solo se ejercitaban con `current_date` —los objetos
   * reales ya están limpios—, así que cualquiera de los otros podía romperse y el censo seguir
   * en verde. Es la tercera vuelta de la misma lección: un guardián sin culpable no se prueba.
   */
  const SONDAS: Record<string, { expr: string; tipo: string; culpable: boolean }> = {
    censo_probe_current_date: { expr: 'current_date', tipo: 'date', culpable: true },
    censo_probe_cast: { expr: 'cast(now() as date)', tipo: 'date', culpable: true },
    censo_probe_castop: { expr: 'now()::date', tipo: 'date', culpable: true },
    censo_probe_datefn: { expr: 'date(now())', tipo: 'date', culpable: true },
    censo_probe_trunc: {
      expr: "(date_trunc('day', now()))::date",
      tipo: 'date',
      culpable: true,
    },
    censo_probe_tochar: {
      expr: "to_char(now(), 'YYYY-MM-DD')",
      tipo: 'text',
      culpable: true,
    },
    censo_probe_stmt: { expr: 'statement_timestamp()::date', tipo: 'date', culpable: true },
    censo_probe_prec: { expr: 'current_timestamp(0)::date', tipo: 'date', culpable: true },
    censo_probe_extract: {
      expr: 'extract(day from now())::int',
      tipo: 'integer',
      culpable: true,
    },
    censo_probe_datepart: {
      expr: "date_part('dow', now())::int",
      tipo: 'integer',
      culpable: true,
    },
    // Y las seguras, que son la otra mitad del contrato: un censo que marcara el propio
    // arreglo acabaría desactivado, así que se exige explícitamente que NO las señale.
    censo_probe_ok_utc: {
      expr: "timezone('UTC', now())::date",
      tipo: 'date',
      culpable: false,
    },
    censo_probe_ok_trunc: {
      expr: "(date_trunc('day', timezone('UTC', now())))::date",
      tipo: 'date',
      culpable: false,
    },
    // `date_trunc` a una precisión que NO elige día: solo quita fracciones del instante, y
    // medido no depende del huso. Marcarla sería un falso positivo.
    censo_probe_ok_ms: {
      expr: "date_trunc('milliseconds', now())",
      tipo: 'timestamptz',
      culpable: false,
    },
    // `to_char` sobre un `date`: un `date` no tiene huso del que moverse (medido).
    censo_probe_ok_fecha: {
      expr: "to_char(fecha_de_la_base(), 'YYYY-MM-DD')",
      tipo: 'text',
      culpable: false,
    },
    // `epoch` es el instante absoluto: medido, no cambia con el huso.
    censo_probe_ok_epoch: {
      expr: 'extract(epoch from now())::bigint',
      tipo: 'bigint',
      culpable: false,
    },
  };

  it('el reconocedor dice que sí a cada forma peligrosa y que no a cada segura', async () => {
    /*
     * Las sondas de más abajo son objetos REALES y por eso solo pueden ejercitar lo que el
     * catálogo devuelve, que es la forma DEPARSEADA. Dos de los patrones existen para el otro
     * censo —el del código TypeScript, donde el SQL está tal como se escribió— y ningún objeto
     * puede producirlos: Postgres reduce `now()::date` y `cast(now() as date)` a
     * `(now())::date` antes de guardarlos. Comprobado: rompiendo esos dos patrones, las sondas
     * del catálogo siguen en verde.
     *
     * Así que el reconocedor se prueba también solo, con las dos formas de cada cosa. Es la
     * mitad que las sondas no pueden cubrir, y sin ella dos de los siete patrones no los
     * ejercitaba nada.
     */
    const PELIGROSAS = [
      'current_date',
      'CURRENT_DATE',
      'select localtimestamp',
      "date_trunc('day', now())",
      "date_trunc('day'::text, now())",
      "date_trunc('month', current_timestamp)",
      'now()::date',
      '(now())::date',
      'cast(now() as date)',
      'CAST(clock_timestamp() AS date)',
      'date(now())',
      "to_char(now(), 'YYYY-MM-DD')",
      "to_char(now(), 'YYYY-MM-DD'::text)",
      'statement_timestamp()::date',
      '(statement_timestamp())::date',
      'transaction_timestamp()::date',
      'current_timestamp(0)::date',
      '(CURRENT_TIMESTAMP(0))::date',
      'localtimestamp(3)',
      'extract(day from now())',
      'EXTRACT(day FROM now())',
      'extract(month from clock_timestamp())',
      "date_part('dow', now())",
      "date_part('dow'::text, now())",
    ];
    const SEGURAS = [
      "timezone('UTC', now())::date",
      "(timezone('UTC'::text, now()))::date",
      "date_trunc('day', timezone('UTC', now()))",
      "date_trunc('milliseconds', now())",
      "date_trunc('second', now())",
      'fecha_de_la_base()',
      'inicio_del_dia_de_la_base()',
      "to_char(vence_en, 'YYYY-MM-DD')",
      "to_char(fecha_de_la_base(), 'YYYY-MM-DD')",
      'creado_en >= inicio_del_dia_de_la_base()',
      // Un identificador que CONTIENE una palabra clave no es una lectura del reloj.
      'select current_date_pactada from acuerdo',
      // `epoch` y los campos por debajo del minuto NO dependen del huso (medido con siete
      // instantes que cruzan día, mes, año, década, siglo y milenio, y dos husos extremos).
      'extract(epoch from now())',
      "date_part('epoch', now())",
      'extract(minute from now())',
      "extract(day from timezone('UTC', now()))",
      // Y las precisiones de `date_trunc` que solo quitan fracciones del instante.
      "date_trunc('milliseconds', now())",
    ];
    expect(PELIGROSAS.filter((f) => !culpable(f))).toEqual([]);
    expect(SEGURAS.filter((f) => culpable(f))).toEqual([]);
  });

  it('ninguna función lee el reloj de pared de quien la llama', async () => {
    /*
     * Las sondas se crean ANTES de capturar el censo y se exige que salgan entre SUS
     * culpables, usando la misma consulta y el mismo filtro. Antes hacían una consulta aparte,
     * y eso no protegía nada: volver la consulta principal a `prosrc` las habría dejado en
     * verde. Lo comprobé mal —cambié las dos a la vez— y por eso el rojo me pareció una prueba
     * cuando no lo era. Una sonda que no atraviesa el camino que dice proteger es peor que
     * ninguna: da la impresión de cubrirlo.
     *
     * Van como `LANGUAGE SQL … RETURN …`, así que de paso ejercitan la otra mitad: ese cuerpo
     * vive en `prosqlbody` y deja `prosrc` VACÍO (comprobado abajo), que es lo que hacía
     * invisible a una función entera cuando el censo leía `prosrc`.
     */
    const admin = sqlAdmin();
    for (const [nombre, { expr, tipo }] of Object.entries(SONDAS)) {
      await admin.unsafe(
        `create function ${nombre}() returns ${tipo} language sql stable return ${expr}`,
      );
    }
    try {
      // `pg_get_functiondef` y no `prosrc`, y `prokind = 'f'` porque aquél no acepta
      // agregados ni funciones de ventana.
      const funciones = await admin`
        select p.proname as nombre, pg_get_functiondef(p.oid) as cuerpo, p.prosrc
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and l.lanname not in ('internal', 'c')
          and p.prokind = 'f'
        order by 1`;
      // El censo tiene que estar mirando algo: sin esto, un cambio en la consulta que
      // devolviera cero filas dejaría el test en verde para siempre sin comprobar nada.
      expect(funciones.length).toBeGreaterThan(50);
      // Y la premisa del hallazgo del `prosqlbody`, comprobada y no supuesta.
      expect(funciones.find((f) => f.nombre === 'censo_probe_castop')!.prosrc).toBe('');

      const culpables = funciones
        .filter((f) => culpable(sinComentarios(f.cuerpo as string)))
        .map((f) => f.nombre as string)
        .filter((n) => !(n in DECLARADAS));
      // Exactamente las peligrosas y ninguna más: si un patrón se rompe, su sonda desaparece
      // de aquí; si un patrón se pasa de ancho, aparece una segura.
      expect(culpables.sort()).toEqual(
        Object.entries(SONDAS)
          .filter(([, v]) => v.culpable)
          .map(([n]) => n)
          .sort(),
      );
    } finally {
      for (const nombre of Object.keys(SONDAS)) {
        await admin.unsafe(`drop function ${nombre}()`);
      }
    }
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
      .filter((p) => culpable(p.cuerpo as string))
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
    // La sonda de vistas materializadas se crea ANTES de capturar las categorías y sale por el
    // MISMO recorrido que protege, por lo mismo que la de cuerpos SQL estándar: una consulta
    // aparte no protegería la del censo. Con cero matviews reales, es lo único que distingue
    // «no hay ninguna» de «no estoy mirando».
    await admin`create materialized view censo_tmp_matview as select current_date as d`;
    // Y una culpable para la rama de triggers, por lo mismo: sin ella, la consulta podría
    // dejar de devolver filas o mirar la columna equivocada y el mínimo seguiría cumpliéndose
    // con los siete triggers reales, que están limpios.
    await admin`create table censo_tmp_tabla (id int, f date)`;
    await admin`create function censo_tmp_guard() returns trigger
      language plpgsql as $$ begin return new; end $$`;
    await admin`create trigger censo_tmp_trg before insert on censo_tmp_tabla
      for each row when (new.f > current_date) execute function censo_tmp_guard()`;
    try {
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
      // La condición `WHEN` de un trigger no vive en el cuerpo de su función: vive en
      // `pg_trigger.tgqual`, y decide SI el guard llega a ejecutarse. Se evalúa en la sesión
      // de quien escribe, así que una condición calendárica ahí elige el día igual que una
      // política — y ninguna de las otras cuatro categorías la miraba. Este repositorio ya
      // usa siete condiciones `WHEN`, así que no es una categoría hipotética.
      trigger: await admin`select t.tgname || ' on ' || t.tgrelid::regclass as nombre,
             pg_get_triggerdef(t.oid) as cuerpo
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal`,
    };

    /* Lo que cada categoría tiene que estar mirando para que su verde signifique algo. */
    const MINIMO: Record<keyof typeof categorias, number> = {
      vista: 1,
      check: 100,
      default: 100,
      trigger: 50,
      // Uno: el que fabrica la sonda. Hoy no hay ninguna real, y por eso su rama se comprueba
      // con ella en vez de con un conteo — cero es el conteo correcto y no prueba nada.
      matview: 1,
    };
      for (const [nombre, filas] of Object.entries(categorias)) {
        expect(filas.length, `la rama «${nombre}» no está mirando nada`).toBeGreaterThanOrEqual(
          MINIMO[nombre as keyof typeof categorias],
        );
        const culpables = filas
          .filter((o) => culpable(o!.cuerpo as string))
          .map((o) => `${nombre} ${o!.nombre as string}`)
          .filter((n) => !(n in DECLARADAS));
        // La única culpable admitida es la sonda, y tiene que ESTAR: si la rama de matviews
        // deja de devolver filas, desaparece de aquí y este caso se pone rojo.
        // La única culpable admitida por categoría es su sonda, y tiene que ESTAR: si la
        // rama deja de devolver filas o mira la columna equivocada, desaparece de aquí.
        const esperadas: Record<string, string[]> = {
          matview: ['matview censo_tmp_matview'],
          trigger: ['trigger censo_tmp_trg on censo_tmp_tabla'],
        };
        expect(culpables).toEqual(esperadas[nombre] ?? []);
      }
    } finally {
      await admin`drop materialized view censo_tmp_matview`;
      await admin`drop table censo_tmp_tabla cascade`;
      await admin`drop function censo_tmp_guard()`;
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
    // Desde la RAÍZ del repositorio y no desde `src/`: hay TypeScript de producción fuera de
    // `src/` —`serve.ts` es el entrypoint del servidor y ya lleva plantillas SQL—, y con el
    // recorrido empezando en `src/` quedaba fuera del censo mientras el mínimo de ficheros se
    // seguía cumpliendo de sobra. Un guardián que no mira el entrypoint no guarda la puerta.
    const raiz = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
    /* Lo que se salta, con su motivo: dependencias y artefactos no son código de este
     * repositorio, y en los tests `current_date` es legítimo para construir un caso. */
    const FUERA = new Set(['node_modules', '.git', 'dist', 'build', '.output', '.vinxi',
      '.nitro', 'coverage', '__tests__']);
    const ficheros: string[] = [];
    const recorrer = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const ruta = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (!FUERA.has(e.name)) await recorrer(ruta);
        } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) ficheros.push(ruta);
      }
    };
    await recorrer(raiz);
    // Que el censo esté mirando algo, y no un directorio que alguien movió.
    expect(ficheros.length).toBeGreaterThan(50);
    // Y que alcance de verdad la raíz: `serve.ts` es el fichero que se le escapaba.
    expect(ficheros.map((f) => f.slice(raiz.length + 1))).toContain('serve.ts');

    const culpables: string[] = [];
    for (const f of ficheros) {
      // Sin comentarios: un `current_date` que EXPLICA por qué ya no se usa no es un
      // hallazgo, y sin esto el censo se volvería contra quien documenta el arreglo.
      const codigo = (await readFile(f, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (culpable(codigo)) culpables.push(f.slice(raiz.length + 1));
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
