import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, sqlAdmin } from '@/lib/db';
import * as ts from 'typescript';
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
    await sqlAdmin().unsafe('drop table if exists censo_probe_escritura');
    await sqlAdmin().unsafe('drop table if exists censo_probe_otra');
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
  /*
   * Las cuatro cadenas que Postgres NO trata como dato. `'now'`, `'today'`, `'tomorrow'` y
   * `'yesterday'` se EVALÚAN contra el reloj de la sesión en cuanto se castean a un tipo
   * temporal, así que son expresiones escritas entre comillas. Medido en husos opuestos:
   * `'today'::date` da 2026-09-05 en Pacific/Kiritimati y 2026-09-04 en Etc/GMT+12,
   * `'now'::timestamp` da la hora de pared de cada uno, y `'yesterday'`/`'tomorrow'` se mueven
   * con ellas. Las otras especiales —`'epoch'`, `'infinity'`, `'allballs'`— son fijas, medidas
   * las tres, y no entran.
   *
   * Postgres las reconoce sin distinguir mayúsculas y recortando los espacios de los bordes
   * (medido: `' NOW '::date` y `'NOW'::date` son la misma lectura), así que aquí igual.
   */
  const ESPECIAL_TEMPORAL = /^\s*(?:now|today|tomorrow|yesterday)\s*$/i;
  /*
   * Y el nombre de un tipo tal como lo ESCRIBE el catálogo, que es la otra mitad de esa misma
   * lección: `format_type` devuelve `timestamp without time zone`, no `timestamp`, y la
   * precisión va dentro del nombre. La regla es la misma que ya se mide arriba —un valor de
   * reloj es independiente del huso si su tipo LLEVA huso— escrita aquí sobre el nombre en vez
   * de sobre la palabra.
   */
  /*
   * Y el sufijo de ARRAY, que no cambia la pregunta: Postgres coerciona elemento a elemento,
   * así que lo que decide es el tipo del ELEMENTO. Medido: `returns date[]` con
   * `return array[now()]` da `{2026-09-05}` en Pacific/Kiritimati y `{2026-09-04}` en
   * Etc/GMT+12, exactamente igual que su versión escalar. Sin admitirlo, escribir un par de
   * corchetes en el tipo de vuelta sacaba a la función de esta familia entera.
   *
   * Las dimensiones se aceptan todas y los tamaños se ignoran, porque a Postgres tampoco le
   * importan: `date[3]` y `date[][]` son el mismo tipo que `date[]` (comprobado en el
   * catálogo, que los imprime los tres como `date[]`).
   */
  const SIN_HUSO_DECLARADO =
    /^\s*(?:date|(?:timestamp|time)(?:\s*\(\s*\d+\s*\))?(?:\s+without\s+time\s+zone)?)(?:\s*\[\s*\d*\s*\])*\s*$/i;
  const PALABRAS_DEL_RELOJ = [
    // De más larga a más corta: con `current_time` delante, la alternación la casaba dentro
    // de `current_timestamp` y el resto quedaba suelto. (Con la frontera derecha puesta ya no
    // haría falta —`current_time\b` no casa dentro de `current_timestamp`— pero el orden no
    // estorba y una alternación ordenada se lee sin tener que razonar el caso.)
    //
    // Las DOS fronteras van DENTRO de cada palabra. Antes vivían al final de la alternación
    // entera —`\b(…)\b`— y ahí no se podían reutilizar: `current_timestamp(0)` termina en
    // `)`, y un `\b` detrás de un paréntesis exige un carácter de palabra que no existe. Así
    // que la derecha va justo después del NOMBRE y antes de la precisión opcional.
    //
    // Y la izquierda tuvo que venirse aquí también. Al reutilizar esta alternación como
    // operando, `DEL_HUSO_DE_LA_SESION` se quedó con su `\b` de la izquierda y el operando
    // no: `mi_current_timestamp::date` casaba desde la mitad del identificador. Es el mismo
    // patrón de siempre —lo que se queda atrás al mover algo— y por eso las fronteras viajan
    // ahora CON la palabra, no alrededor de quien la usa.
    'current_timestamp',
    'current_time',
    'localtimestamp',
    'localtime',
    'current_date',
  ];
  /** El patrón de una palabra: sus dos fronteras y su precisión opcional. */
  const patronDe = (palabra: string) => String.raw`\b${palabra}\b${PRECISION}`;
  /**
   * El NOMBRE de una función, entrecomillado o no. `pg_catalog."to_json"(now())`,
   * `"date_trunc"('day', now())`, `"to_char"(…)`, `"age"(…)`, `"date"(…)`, `"date_part"(…)` y
   * `"timezone"(…)` son llamadas válidas —medidas las siete contra la base— y un patrón que
   * exija el paréntesis pegado al nombre DESNUDO no ve ninguna: encuentra antes la comilla.
   *
   * La variante ya existía en un sitio, el de las funciones de reloj, y faltaba en los otros
   * siete. Es el mismo modo de fallo de siempre —un criterio repetido aprende en un sitio y se
   * queda viejo en los demás—, así que aquí vive UNA vez y la usan todos.
   *
   * `extract` y `cast` NO la llevan, y no es un olvido: son palabras clave con sintaxis propia
   * —`extract(campo from x)`, `cast(x as t)`— y entrecomilladas son errores de sintaxis, las
   * dos medidas. Añadirles la variante sería cobertura de algo que no existe.
   *
   * Las PALABRAS del reloj tampoco: `current_date` es palabra clave, y `"current_date"` ya no
   * lo es — sería el nombre de una columna, que no lee ningún reloj.
   */
  const nombreDeFuncion = (nombres: string) =>
    String.raw`(?:\b(?:${nombres})|"(?:${nombres})")`;

  /**
   * Los campos y precisiones seguros NO se escriben: se MIDEN contra la base, comparando el
   * mismo instante en husos distintos. Tres veces me equivoqué al elegir la muestra:
   *
   *  · con UN instante, `month`, `year` y `week` salían independientes porque ese instante no
   *    cruzaba esas fronteras;
   *  · con dos husos de desfase ENTERO, `minute` salía independiente — y no lo es: en
   *    `Asia/Kathmandu` (UTC+05:45) `extract(minute from …)` da 20 donde UTC da 35;
   *  · con CINCO husos escogidos a mano quedaba la pregunta de siempre, «¿y el que no se me
   *    ocurrió?». Escoger la muestra era el punto débil, así que ya no se escoge: el barrido
   *    va sobre TODO `pg_timezone_names` —499 husos en la tzdata de esta máquina, los que
   *    haya en la del servidor— en un bucle del lado suyo (230 ms). Las listas salen iguales
   *    que con los cinco escogidos a mano — pero
   *    ahora eso es un RESULTADO y no una suposición, y si mañana tzdata añade un huso raro
   *    las listas se recalculan solas sin que nadie tenga que acordarse.
   *
   * Los INSTANTES sí siguen escritos, y son todos de hoy o del futuro a propósito: son los
   * que un RELOJ puede devolver, que es lo único que estos patrones miran. La distinción no
   * es cosmética. Con un instante de 1900 en la muestra, `second`, `milliseconds` y
   * `microseconds` se caen de la lista de campos y `minute` de la de precisiones, porque 297
   * de esos husos tenían entonces desfases de HORA LOCAL MEDIA con segundos sueltos
   * (`Europe/Amsterdam` iba a UTC+00:19:32). Medirlo con 1900 dentro dejaría la lista de
   * campos en `epoch` a secas y convertiría `extract(milliseconds from now())` —que es
   * seguro— en un hallazgo. El caso se comprueba abajo por los dos lados en vez de confiarse.
   *
   * Las dos listas NO coinciden, y la diferencia es instructiva: `minute` es seguro para
   * `date_trunc` —truncar al minuto deja el mismo instante, porque todos los desfases
   * ALCANZABLES POR UN RELOJ son minutos enteros— y peligroso para `extract`, que lee la
   * esfera del reloj de pared.
   */
  const INSTANTES = [
    '2026-09-04 06:35:00+00',
    '2026-09-04 00:10:00+00',
    '2026-09-30 23:30:00+00',
    '2026-12-31 23:30:00+00',
    '2029-12-31 23:30:00+00',
    '2099-12-31 23:30:00+00',
    '2000-12-31 23:30:00+00',
    '2026-01-01 00:30:00+00',
  ];
  const CAMPOS = ['epoch', 'microseconds', 'milliseconds', 'second', 'minute', 'hour', 'day',
    'dow', 'doy', 'week', 'month', 'quarter', 'year', 'isodow', 'isoyear', 'decade', 'century',
    'millennium', 'timezone', 'timezone_hour', 'timezone_minute', 'julian'];
  const UNIDADES = ['microseconds', 'milliseconds', 'second', 'minute', 'hour', 'day', 'week',
    'month', 'quarter', 'year', 'decade', 'century', 'millennium'];

  let CAMPOS_SEGUROS = '';
  let UNIDADES_SEGURAS = '';

  /** Se rellena en el primer caso: los relojes que el CATÁLOGO declara, para no listarlos. */
  let RELOJES = '';
  let RELOJ_COLAPSADO_A_DIA: RegExp[] = [];
  /** Los dos patrones que LEEN el literal: van contra el texto SIN vaciar. */
  let RELOJ_LEYENDO_LITERAL: RegExp[] = [];
  let DEL_HUSO_DE_LA_SESION: RegExp;
  /*
   * Y los dos que NO se pueden decidir mirando la expresión, porque lo decisivo está FUERA de
   * ella: el TIPO del destino. Van aparte por eso, y no porque sean otra clase de reloj.
   */
  let RELOJ_ENTREGADO: (texto: string) => boolean = () => false;
  let RELOJ_ASIGNADO_A_VARIABLE: (texto: string) => boolean = () => false;
  /*
   * Y el TERCER destino tipado, que es el que faltaba: la COLUMNA en la que se escribe.
   * `insert into t(d) values (now())` con `t.d date` guarda 2026-09-05 en Pacific/Kiritimati
   * y 2026-09-04 en Etc/GMT+12 —medido—, la función puede devolver `void`, no hay ninguna
   * variable declarada y en el texto solo hay un `now()` desnudo. Los otros dos destinos
   * —el tipo de vuelta y el de una variable— ya se miraban; éste no, y en este esquema hay
   * DIEZ columnas temporales sin huso donde cabía.
   *
   * El tipo se saca del catálogo, como todo lo demás aquí: nada de listas a mano.
   */
  let RELOJ_ESCRITO_EN_COLUMNA: (texto: string) => boolean = () => false;

  beforeAll(async () => {
    /*
     * Una tabla SONDA para el destino tipado de una escritura, con las dos columnas que
     * separan el caso: una sin huso y otra con él. Se crea a propósito y no se usa una tabla
     * real, por lo mismo que las sondas de matview y de regla: el esquema está limpio, así
     * que sin una tabla fabricada el reconocedor de escrituras no tendría ni un solo culpable
     * y podría romperse sin que nada enrojeciera.
     *
     * Va aquí y no en el bloque de sondas de más abajo porque el tipo de sus columnas se lee
     * del catálogo tres líneas después: si naciera más tarde, no estaría en el mapa.
     */
    await sqlAdmin().unsafe('drop table if exists censo_probe_escritura');
    await sqlAdmin().unsafe(
      'create table censo_probe_escritura (k int primary key, d date, ts timestamptz)',
    );
    /*
     * Y una SEGUNDA tabla con una columna que se llama igual y tiene otro tipo. Existe para
     * una sola sonda, la que comprueba que la culpa no se atribuye a la tabla equivocada: sin
     * dos tablas donde el mismo nombre de columna signifique cosas distintas, ese caso no se
     * puede escribir.
     */
    await sqlAdmin().unsafe('drop table if exists censo_probe_otra');
    await sqlAdmin().unsafe(
      'create table censo_probe_otra (k int primary key, d timestamptz)',
    );
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
        and (format_type(p.prorettype, null) in ('timestamp with time zone',
              'timestamp without time zone', 'date', 'time with time zone',
              'time without time zone')
          -- timeofday() es un reloj que devuelve TEXTO, así que el filtro por tipo no lo
          -- alcanza: timeofday()::timestamptz::date elige día igual. Va por nombre porque
          -- filtrar por text arrastraría media biblioteca. (Sin comillas invertidas: esto
          -- vive dentro de una template literal y las terminaría.)
          or p.proname = 'timeofday')
      order by 1`;
    /*
     * Y el nombre puede ir ENTRECOMILLADO: `pg_catalog."now"()` es la misma función y elige
     * día igual —medido: 2026-09-05 en Kiritimati y 2026-09-03 en Etc/GMT+12—, pero con la
     * frontera de palabra sola no casaba, porque entre el nombre y el `(` va una comilla.
     *
     * Las PALABRAS del reloj no llevan esta variante y es a propósito: `current_date` es una
     * palabra clave, y `"current_date"` entrecomillado ya no lo es — sería el nombre de una
     * columna, que no lee ningún reloj.
     */
    const funciones = filas.map(
      (f) => String.raw`${nombreDeFuncion(f.nombre as string)}\s*\(\s*\)`,
    );
    expect(funciones.length).toBeGreaterThanOrEqual(5);

    /*
     * Y las dos listas seguras, MEDIDAS sobre TODOS los husos que el servidor conoce.
     *
     * El bucle va del lado del servidor, en un bloque `DO`, y no en TypeScript. No es por
     * velocidad: es porque `set_config(…, true)` DENTRO de una consulta no se aplica por
     * fila —el orden de evaluación no está definido— y mi primer intento midió mal por eso
     * («epoch» salía inestable). En plpgsql cada sentencia ve el huso que fijó la anterior,
     * que es la única forma honesta de barrer 499 husos en una ida y vuelta.
     *
     * El valor se compara como NÚMERO ABSOLUTO, no como texto. `date_trunc` devuelve
     * `timestamptz` y su representación textual lleva el desfase: mi primer intento comparaba
     * `…::text` y daba `second` y `milliseconds` como inestables porque «06:35:00+00» y
     * «12:20:00+05:45» son cadenas distintas… del mismo instante. Comparar la impresión en
     * vez del valor es el mismo error que este censo existe para cazar, cometido al medirlo.
     *
     * La reducción también va en el servidor: 140.000 mediciones no tienen por qué cruzar el
     * cable para acabar en dos listas de una línea.
     */
    const [campos, unidades] = await sqlAdmin().begin(async (tx) => {
      await tx`create temp table censo_entrada(clase text, nombre text) on commit drop`;
      await tx`create temp table censo_instante(t timestamptz) on commit drop`;
      await tx`create temp table censo_medicion(clase text, nombre text, t timestamptz, v text)
               on commit drop`;
      await tx`insert into censo_entrada select 'campo', unnest(${CAMPOS}::text[])`;
      await tx`insert into censo_entrada select 'unidad', unnest(${UNIDADES}::text[])`;
      await tx`insert into censo_instante select unnest(${INSTANTES}::timestamptz[])`;
      await tx`do $medir$
        declare z text;
        begin
          for z in select name from pg_timezone_names loop
            perform set_config('TimeZone', z, true);
            insert into censo_medicion
              select e.clase, e.nombre, i.t,
                     case e.clase
                       when 'campo' then date_part(e.nombre, i.t)::text
                       else extract(epoch from date_trunc(e.nombre, i.t))::text
                     end
              from censo_entrada e, censo_instante i;
          end loop;
          perform set_config('TimeZone', 'UTC', true);
        end $medir$`;
      // Estable = para cada instante, un único valor en los 499 husos.
      const estables = await tx`
        select clase, nombre from censo_medicion
        group by clase, nombre
        having count(distinct t::text || '|' || v) = count(distinct t)
        order by clase, nombre`;
      const de = (clase: string) =>
        estables.filter((f) => f.clase === clase).map((f) => f.nombre as string);
      return [de('campo'), de('unidad')];
    });
    /*
     * Que la medición esté midiendo: `epoch` es un instante absoluto y tiene que salir seguro,
     * y `day` depende del huso por definición y no puede salir.
     */
    expect(campos).toContain('epoch');
    expect(campos).not.toContain('day');
    expect(unidades).not.toContain('day');
    /*
     * Y la premisa que sostiene a `second`, `milliseconds`, `microseconds` y al `minute` de
     * `date_trunc`: en los instantes que un RELOJ puede devolver, ningún huso del servidor
     * tiene un desfase con segundos sueltos. Se comprueba por los dos lados, porque un
     * guardián que nunca ve un culpable no está probado: en 1900 sí los hay, en la era de la
     * hora local media, y la misma consulta los encuentra.
     *
     * (Postgres 16 no ofrece otra vía: `set time zone interval '00:00:30' hour to second` la
     * rechaza con «time zone interval must be HOUR or HOUR TO MINUTE», y un huso POSIX con
     * segundos lo rechaza como segundos intercalares. Comprobado, no supuesto.)
     */
    const [desfases] = await sqlAdmin()`
      select
        count(*) filter (where
          extract(second from (i.t at time zone z.name) - (i.t at time zone 'UTC')) <> 0
        ) as con_segundos,
        count(*) filter (where
          extract(second from (h.t at time zone z.name) - (h.t at time zone 'UTC')) <> 0
        ) as con_segundos_en_1900
      from pg_timezone_names z,
        unnest(${INSTANTES}::timestamptz[]) i(t),
        (select timestamptz '1900-01-01 12:00:00+00') h(t)`;
    expect(Number(desfases!.con_segundos)).toBe(0);
    expect(Number(desfases!.con_segundos_en_1900)).toBeGreaterThan(0);
    CAMPOS_SEGUROS = campos.join('|');
    UNIDADES_SEGURAS = unidades.join('|');

    /*
     * Cuáles de esas palabras son peligrosas POR SÍ SOLAS, sin colapsar nada. No se decide a
     * mano: se deriva del TIPO que devuelven, preguntándoselo a la base.
     *
     * La regla —medida, no supuesta— es que un valor de reloj es independiente del huso si su
     * tipo LLEVA huso. Con un instante fijo y dos husos opuestos:
     *
     *   current_timestamp  timestamp with time zone     igualdad → true    estable
     *   current_time       time with time zone          igualdad → true    estable
     *   localtimestamp     timestamp without time zone  20:35 vs 18:35     DEPENDE
     *   localtime          time without time zone       20:35 vs 18:35     DEPENDE
     *   current_date       date                         09-04 vs 09-03     DEPENDE
     *
     * La cabecera de este fichero ya decía que `current_timestamp` es un instante absoluto y
     * no debía marcarse, y sin embargo `DEL_HUSO_DE_LA_SESION` se construía con la lista
     * ENTERA y lo marcaba: el contrato escrito y el código decían cosas distintas. Ahora lo
     * dice una sola vez, y lo dice la base.
     */
    expect(PALABRAS_DEL_RELOJ.every((w) => /^[a-z_]+$/.test(w))).toBe(true);
    const tipos = await sqlAdmin().unsafe(
      PALABRAS_DEL_RELOJ.map(
        (w) => `select '${w}' as palabra, pg_typeof(${w})::text as tipo`,
      ).join(' union all '),
    );
    const yaLeenLaPared = tipos
      .filter((f) => !(f.tipo as string).endsWith('with time zone'))
      .map((f) => f.palabra as string);
    // Que la derivación esté derivando: `current_date` es una fecha y tiene que salir; el
    // `timestamptz` de `current_timestamp` es un instante absoluto y no puede.
    expect(yaLeenLaPared).toContain('current_date');
    expect(yaLeenLaPared).not.toContain('current_timestamp');
    // Sin `\b` alrededor: cada palabra trae ya las suyas, y ponerlas dos veces esconde de
    // quién son. Comprobado que sigue distinguiendo `current_date` de `current_date_pactada`
    // y de `mi_current_timestamp`, y que sigue viendo `localtimestamp(3)`.
    DEL_HUSO_DE_LA_SESION = new RegExp(
      String.raw`(?:${yaLeenLaPared.map(patronDe).join('|')})`,
      'i',
    );

    /*
     * Un reloj rara vez llega DESNUDO a la operación que elige el calendario: se le pone un
     * cast por el camino, o Postgres se lo envuelve en paréntesis al deparsear. Los patrones
     * exigían el reloj a secas, y eso NO eran tres agujeros sueltos sino UNA causa con ocho:
     * `now()::timestamp::date`, `date_trunc('day', timeofday()::timestamptz)` y su forma
     * deparseada, `date_trunc('day', now()::timestamp)`, `cast(now()::timestamp as date)`,
     * `date(now()::timestamp)`, `to_char(now()::timestamp, …)` y
     * `extract(day from (now())::timestamp)` se escapaban todas. Medido — y medido también
     * que las ocho eligen día distinto en husos opuestos, que es lo que las hace hallazgos:
     * `now()::timestamp` da día 4 en `Pacific/Kiritimati` y día 3 en `Etc/GMT+12`.
     *
     * Así que el reloj como OPERANDO se define UNA vez y se usa en todos: el reloj, con o sin
     * paréntesis propios, seguido de cualquier cadena de castos a un tipo de tiempo, y todo
     * ello envolvible otra vez —que es exactamente como sale del deparseador:
     * `((timeofday())::timestamp with time zone)`.
     *
     * El arreglo tiene DOS mitades y las dos cargan peso, comprobado neutralizando cada una
     * por separado: sin el operando se escapan ocho formas —entre ellas las dos del reloj de
     * texto, que es la prueba de que fundir tres patrones en uno no perdió nada—; sin el
     * destino ampliado de aquí abajo se escapan `now()::timestamp` y su deparseo. Ninguna de
     * las dos enrojece nada que no sea suyo.
     */
    const TIPO_DE_TIEMPO = [
      String.raw`timestamptz\b${PRECISION}`,
      String.raw`timestamp\b${PRECISION}(?:\s+with(?:out)?\s+time\s+zone\b)?`,
      // `timetz` conserva el instante —medido: dos husos opuestos dan valores IGUALES— así
      // que no es un destino que elija calendario. Pero es un paso por el que el reloj puede
      // ATRAVESAR hacia uno que sí: `(now()::time with time zone)::time` tira el desfase y se
      // queda la esfera local, 20:35 en Kiritimati y 18:35 en Etc/GMT+12. Excluirlo del
      // destino y no admitirlo como paso dejaba la expresión entera fuera del censo.
      String.raw`timetz\b${PRECISION}`,
      String.raw`time\b${PRECISION}\s+with\s+time\s+zone\b`,
    ].join('|');
    /*
     * Un nombre de tipo puede ir CALIFICADO con su esquema: `now()::pg_catalog.date` elige día
     * igual —medido: distinto en Kiritimati y en Etc/GMT+12— y se escapaba porque los tipos se
     * escribían sin admitir el punto. Va en un solo sitio y lo usan TODOS los sitios donde se
     * consume un nombre de tipo, que es la lección de esta ronda.
     */
    // Y el esquema, entrecomillado o no: `now()::"pg_catalog".date` es el mismo cast
    // (medido). Un identificador entre comillas dobles es un NOMBRE, no un dato.
    const ESQUEMA = String.raw`(?:(?:\w+|"\w+")\s*\.\s*)?`;
    /*
     * El destino de los CASTS incluye además el TEXTO. Serializar un reloj es elegir día igual
     * que `to_char`: medido, `now()::text` da «2026-09-05 00:08…+14» y «2026-09-03 22:08…-12»,
     * y una regla escrita sobre `substring(now()::text, 1, 10)` decide con el huso de quien
     * llama. Va aparte de `TIPO_SIN_HUSO` a propósito: en una COMPARACIÓN mixta el texto no
     * es el caso —ahí lo que importa es la promoción de un temporal sin huso— así que el
     * operando de aquellas sigue siendo el otro.
     */
    /*
     * Los nombres COMPLETOS: `character varying` y `character` son como se escribe en SQL
     * estándar y como Postgres deparsea `varchar`. De más largo a más corto, que si no
     * `character` casa dentro de `character varying` y deja el resto suelto.
     *
     * Y el texto tiene una salida: si el cast a texto es solo un PASO y se vuelve a un tipo
     * CON huso, la ida y vuelta recupera el mismo instante —medido: `now()::text::timestamptz`
     * es estable, porque la representación lleva el desfase—. Marcar eso sería un falso
     * positivo sobre una serialización correcta. Volver a un tipo SIN huso sigue eligiendo
     * calendario (`now()::text::date` depende, medido), y ese lo caza el destino de siempre.
     */
    // `character` lleva su propia guardia contra `varying`: el ORDEN de las alternativas no
    // basta, porque el motor RETROCEDE. Con `character varying::timestamptz`, la alternativa
    // larga la rechaza el lookahead de la vuelta, y entonces el motor prueba la corta —hay
    // frontera de palabra antes del espacio— que ya no ve el cast de vuelta y la marca.
    const TIPO_TEXTUAL = String.raw`(?:"(?:text|varchar|bpchar)"${PRECISION}|character\s+varying\b${PRECISION}|character\b(?!\s+varying)${PRECISION}|varchar\b${PRECISION}|bpchar\b${PRECISION}|text\b)`;
    // Con un `)` opcional en medio: Postgres deparsea `now()::text::timestamptz` como
    // `((now())::text)::timestamp with time zone`, o sea que el cast de vuelta NO va pegado al
    // nombre del tipo sino detrás del paréntesis que cierra. Sin admitirlo, la forma del
    // CATÁLOGO —la única que las sondas pueden ejercitar— salía marcada igual.
    // Entrecomillados también, por lo mismo — y aquí el efecto es el CONTRARIO: sin ellos,
    // `now()::text::"timestamptz"` salía marcada siendo una ida y vuelta que recupera el
    // instante (medido por epoch: idéntico en Kiritimati y en Etc/GMT+12). Un falso positivo
    // sobre código correcto.
    const TIPO_CON_HUSO = String.raw`(?:"(?:timestamptz|timetz)"|timestamptz\b|timetz\b|(?:timestamp|time)\b${PRECISION}\s+with\s+time\s+zone\b)`;
    /*
     * Y la IDA Y VUELTA por texto es un PASO de la cadena, no un final. `now()::text::timestamptz`
     * recupera el mismo instante —medido por epoch: 1788537725 en Kiritimati y en Etc/GMT+12— y por
     * eso el destino de más abajo no la marca. Pero seguir siendo el mismo instante es exactamente
     * lo que la hace un RELOJ, y el reloj se paraba ante el paso por texto: la cadena de castos solo
     * admitía tipos de tiempo, así que `date_trunc('day', now()::text::timestamptz)` se escapaba
     * entera —medido: `2026-09-05 00:00:00+14` en Kiritimati y `2026-09-04 00:00:00-12` en
     * Etc/GMT+12—, y con ella `to_char(now()::text::timestamptz, 'YYYY-MM-DD')` (2026-09-05 contra
     * 2026-09-04) y `concat(now()::text::timestamptz)`, que renderiza el instante con el huso de
     * quien llama. No era un agujero de `date_trunc`: era el reloj que no atravesaba, y por eso el
     * arreglo va donde se define el reloj y no en el patrón que lo consume.
     *
     * La vuelta va como ASERCIÓN, sin consumirse: el paso por texto cuenta como reloj SOLO si detrás
     * vuelve un tipo con huso, porque es la vuelta —y no el paso— lo que conserva el instante. El
     * `)` opcional en medio es el del deparseador: `((now())::text)::timestamp with time zone`.
     *
     * Dicho con la misma honestidad que la precisión de más abajo: la ASERCIÓN no mueve ninguna
     * sonda. Vaciándola no enrojece nada, y buscando el falso positivo que la justificara no lo hay,
     * porque `now()::text` a secas NO es seguro en ningún caso de este censo —ya lo caza el destino,
     * con vuelta o sin ella—. Se queda porque dice la verdad de por qué esto es un reloj: si el
     * criterio se relaja a «cualquier paso por texto», la próxima regla que se escriba sobre `RELOJ`
     * heredará una definición falsa y nadie sabrá por qué. Medido, no supuesto.
     */
    const VUELVE_CON_HUSO = String.raw`(?=(?:\s*\))*\s*::\s*${ESQUEMA}(?:${TIPO_CON_HUSO}))`;
    const CASTOS = String.raw`(?:\s*::\s*${ESQUEMA}(?:${TIPO_DE_TIEMPO}|(?:${TIPO_TEXTUAL})${VUELVE_CON_HUSO}))*`;
    const entreParentesis = (x: string) => String.raw`(?:${x}|\(\s*(?:${x})\s*\))`;
    /*
     * Y la ARITMÉTICA, porque una garantía ajusta el instante antes de colapsarlo:
     * `(now() + interval '1 day')::date` sigue eligiendo día con el huso de la sesión —medido:
     * 09-06 en Kiritimati y 09-04 en Etc/GMT+12— y el operando se paraba ante el `+`.
     * Postgres la deparsea como `((now() + '1 day'::interval))::date`, con el intervalo
     * casteado y un paréntesis de más, así que hacen falta las dos formas del intervalo y un
     * nivel más de envoltura.
     */
    /*
     * El operando del ajuste no es solo un literal de intervalo: `make_interval(days => 1)` y
     * `interval '1 day' * 2` eligen día igual (medido) y el reconocedor se paraba ante ellos.
     * Se admite una llamada a función, un literal, un número o un identificador, con
     * multiplicaciones detrás.
     *
     * LÍMITE DECLARADO: una llamada con paréntesis ANIDADOS —`make_interval(days => f(1))`—
     * no la cubre, porque contar paréntesis no es cosa de una expresión regular. Queda dicho
     * aquí en vez de descubrirse.
     */
    /*
     * La gramática de un LITERAL de SQL, en un solo sitio. Había cuatro reconocedores de «lo
     * seguro» —la unidad, el campo de `extract`, el formato de `to_char` y el huso fijo— y
     * cada uno aprendía por su cuenta: solo el del campo sabía de prefijos, así que
     * `date_trunc(E'second', …)`, `to_char(now(), 'US'::text)` y `date_trunc(…, E'UTC')`
     * —los tres estables, medidos por epoch— salían marcados.
     *
     * Es la misma lección que el predicado de las transacciones en el otro censo: si el
     * criterio vive en cuatro sitios, aprende en uno y se queda viejo en tres.
     *
     * El prefijo se admite y NO relaja nada: el contenido tiene que seguir siendo el nombre
     * seguro tal cual, así que un `E'seco\x6ed'` —que vale «second»— no se declara seguro y
     * se marca. De más, no de menos.
     */
    const PREFIJO = String.raw`[A-Za-z_]*&?`;
    const CASTO = String.raw`(?:\s*::\s*[\w. ]+)?`;
    const literalDe = (contenido: string) => String.raw`${PREFIJO}'(?:${contenido})'${CASTO}`;
    const envuelto = (x: string) => String.raw`(?:\(\s*)?(?:${x})(?:\s*\))?`;
    /*
     * Y AQUÍ se cierra la lista de relojes, y no arriba con las palabras, porque falta uno que
     * necesita saber qué tipos llevan huso: el reloj escrito como LITERAL.
     *
     * `'now'::timestamptz` es el mismo instante que `now()` —medido por epoch: 1788538089 en
     * Pacific/Kiritimati y en Etc/GMT+12—, o sea que no es un hallazgo por sí solo pero es un
     * RELOJ, y todo lo que este censo prohíbe hacerle a `now()` estaba permitido escribiéndolo
     * así. Metido en la lista, lo heredan de golpe el destino, `date_trunc`, `to_char`, la
     * comparación mixta, los serializadores y el `||`, que es lo que se gana definiendo el
     * reloj en un sitio.
     *
     * Va con el tipo EXIGIDO, en las dos sintaxis, y esa es la diferencia entre esto y marcar
     * la palabra: `'now'` a secas es un dato como cualquier otro —`concat('now')` devuelve la
     * cadena, y `jsonb_build_object('now', x)` es una clave— y marcarla sería el falso positivo
     * que acaba con el censo desactivado. Solo cuenta cuando lleva encima un tipo temporal, que
     * es exactamente cuando Postgres la evalúa.
     */
    const AHORA_LITERAL = String.raw`${PREFIJO}'\s*now\s*'`;
    /*
     * Y sus tres hermanas, que no son relojes sino el calendario YA leído: `'today'`,
     * `'tomorrow'` y `'yesterday'` no conservan el instante ni siquiera con huso —medido:
     * `'today'::timestamptz` da epoch 1788516000 en Pacific/Kiritimati y 1788523200 en
     * Etc/GMT+12, dos instantes distintos—, así que con CUALQUIER tipo temporal encima son un
     * hallazgo, y por eso van aparte y no en la lista de relojes.
     */
    const DIA_LITERAL = String.raw`${PREFIJO}'\s*(?:today|tomorrow|yesterday)\s*'`;
    RELOJES = [
      // Las funciones llevan su frontera IZQUIERDA —sin ella, `mi_now()` salía marcado— o la
      // comilla de apertura, que separa igual. A la derecha no hace falta, porque el `(` cierra.
      ...funciones,
      // Y TODAS las palabras: colapsar cualquiera de ellas a un día es peligroso, aunque la
      // palabra desnuda no lo sea.
      ...PALABRAS_DEL_RELOJ.map(patronDe),
      // El literal con su tipo detrás y con su tipo delante: `'now'::timestamptz` y
      // `timestamptz 'now'` (medidas las dos, mismo epoch en husos opuestos).
      String.raw`${AHORA_LITERAL}\s*::\s*${ESQUEMA}(?:${TIPO_CON_HUSO})`,
      String.raw`(?<![\w.])${ESQUEMA}(?:${TIPO_CON_HUSO})\s*${AHORA_LITERAL}`,
    ].join('|');

    // Un grupo entre paréntesis con UN nivel de anidamiento dentro, porque así llega del
    // deparseador: `interval '1 day' * 2` se guarda como
    // `('1 day'::interval * (2)::double precision)`, con el número casteado dentro de su
    // propio paréntesis. Escribiendo solo la forma fuente, la del catálogo se escapaba.
    const GRUPO = String.raw`\([^()]*(?:\([^()]*\)[^()]*)*\)`;
    /*
     * El operando NO puede ser otro reloj: `(now() - now())::text` es la diferencia de dos
     * instantes —el intervalo cero, estable entre husos, medido— y entraba como «reloj
     * ajustado y serializado». Restar un reloj de otro da un intervalo, no una lectura del
     * calendario, así que se excluye explícitamente.
     *
     * Y el multiplicador admite un grupo entre paréntesis: `interval '1 day' * (2)` es
     * TypeScript y SQL válidos y dependía del huso igual (medido).
     */
    /*
     * Y el reloj excluido no es solo `now()`: entre PARENTESIS es el mismo reloj. Con
     * `(now() - (now()))::text` el lookahead solo veía el `(` de apertura, no reconocía un
     * reloj, y la alternativa del GRUPO se tragaba el operando entero: la resta —que sigue
     * siendo el intervalo cero, medido `00:00:00` en Kiritimati y en Etc/GMT+12— salía
     * MARCADA. Un falso positivo sobre una plantilla correcta, que es lo que acaba con el
     * censo desactivado.
     *
     * Se excluye el reloj con su envoltura y sus casts: `now()`, `(now())`, `((now()))`,
     * `now()::timestamptz` y `(now()::timestamptz)`.
     *
     * LÍMITE DECLARADO: un reloj YA AJUSTADO dentro del paréntesis —`(now() - (now() +
     * interval '1 day'))::text`— sigue saliendo marcado. También es un intervalo y también es
     * un falso positivo; cubrirlo pide que el operando se defina en términos de sí mismo, que
     * no es cosa de una expresión regular. Queda dicho aquí en vez de descubrirse.
     */
    const RELOJ_COMO_OPERANDO = entreParentesis(entreParentesis(RELOJES) + CASTOS);
    const OPERANDO_ARITMETICO = String.raw`(?!\s*(?:${RELOJ_COMO_OPERANDO}))(?:interval\s*'[^']*'|${PREFIJO}'[^']*'\s*::\s*${ESQUEMA}interval\b|\w+\s*${GRUPO}|${GRUPO}|[\w.]+)(?:\s*[*/]\s*(?:${GRUPO}|[\w.]+)${CASTO})*`;
    const ARITMETICA = String.raw`(?:\s*[-+]\s*${OPERANDO_ARITMETICO})*`;
    const NUCLEO = entreParentesis(RELOJES) + CASTOS + ARITMETICA;
    const RELOJ = entreParentesis(entreParentesis(NUCLEO)) + CASTOS;

    /*
     * Y el DESTINO que elige calendario: un tipo SIN huso. `timestamptz` no entra porque
     * conserva el instante; `timestamp` a secas sí, porque es ya el reloj de pared de quien
     * llama —medido: `now()::timestamp` da día 4 en Kiritimati y día 3 en Etc/GMT+12—.
     *
     * El nombre del tipo va ACOTADO. Antes el cast intermedio se escribía `timestamp[^)]*`, y
     * ese `[^)]*` se tragaba la cláusula que precisamente FIJA el huso: en
     * `((now())::timestamp with time zone AT TIME ZONE 'UTC')::date` —que medido NO depende
     * del huso— el `AT TIME ZONE 'UTC'` entraba en el tipo y la forma correcta salía marcada.
     * Un censo que marca el propio arreglo se acaba desactivando.
     *
     * Y el nombre de un tipo temporal incluye su PRECISIÓN. Sin ella se escapaban siete
     * formas peligrosas —`now()::timestamptz(0)::date` entre ellas, que Postgres guarda como
     * `((now())::timestamp(0) with time zone)::date`— porque la cadena de castos se paraba
     * ante el `(0)` y no llegaba nunca al `::date`.
     *
     * La guardia del huso va DELANTE, como aserción, y esto sí es sutil: detrás de una
     * precisión opcional NO sirve. Con `timestamp\b(precisión)?(?!\s+with time zone)`, el
     * motor prueba `timestamp(0)`, ve que sigue ` with time zone`, RETROCEDE a la precisión
     * vacía, y entonces el lookahead mira `(0)`, que no es ` with time zone`, y pasa. Así
     * `now()::timestamp(0) with time zone` —que medido conserva el instante— salía marcada.
     * Puesta delante se evalúa en una posición fija y el retroceso no la puede rodear.
     *
     * (La precisión que se CONSUME al final es la única parte de todo esto que no carga
     * peso: quitarla no cambia ni un caso, porque detrás del tipo no hay nada más que casar.
     * Se queda porque el nombre de un tipo la incluye, y una gramática a medias es la que
     * hace que la próxima vez nadie sepa por qué falta. Medido, no supuesto.)
     */
    /*
     * Y el nombre del tipo puede ir ENTRECOMILLADO. `now()::"date"` es el mismo cast que
     * `now()::date` —medido, y elige el mismo día distinto en husos opuestos—, y también
     * `pg_catalog."date"`. Sin admitirlo, escribir el tipo entre comillas sacaba la
     * expresión del censo entero, que es la peor forma de fallar: en silencio.
     *
     * La rama entrecomillada NO lleva la guardia de `with time zone`, y no es un descuido:
     * medido, `now()::"timestamp" with time zone` y `cast(now() as "timestamp" with time
     * zone)` son errores de SINTAXIS. Un nombre entrecomillado es un identificador completo;
     * detrás no cabe el resto de la sintaxis del estándar. Por eso tampoco se entrecomillan
     * los nombres de varias palabras: `"character varying"` y `"timestamp with time zone"`
     * no existen como tipos (medido, los dos).
     *
     * Va envuelto en su propio grupo porque hay sitios donde se concatena algo detrás
     * —el operando lo sigue de un literal—, y una alternativa suelta se llevaría el
     * resto de la expresión con ella.
     */
    const SIN_HUSO = String.raw`date|time|timestamp`;
    const TIPO_SIN_HUSO = String.raw`(?:"(?:${SIN_HUSO})"${PRECISION}|(?!(?:timestamp|time)\b${PRECISION}\s+with\s+time\s+zone\b)(?:${SIN_HUSO})\b${PRECISION})`;
    /*
     * Y la vuelta se escribe de DOS maneras. `now()::text::timestamptz` la introduce un `::`;
     * `cast(now()::text as timestamptz)` la introduce el `as` del cast exterior, y esa mitad
     * ninguna sonda del catálogo puede cubrirla porque Postgres deparsea las dos con `::`.
     * Sin contemplarla, el patrón casaba `now()::text`, no veía vuelta y declaraba culpable
     * una ida y vuelta que recupera el mismo instante —medido por epoch: idéntico en
     * Kiritimati y en Etc/GMT+12, en las dos formas—.
     *
     * El `as` exige su `)` de cierre, que es lo que lo separa de un ALIAS de columna: en
     * `select now()::text as timestamptz` no hay cast, hay un nombre, y eso sigue marcado.
     * LÍMITE DECLARADO: ese mismo alias dentro de un paréntesis —`(select now()::text as
     * timestamptz)`— se leería como cast y se escaparía.
     */
    /*
     * Y la vuelta solo salva si es TERMINAL. `now()::text::timestamptz::date` recupera el
     * instante y a continuación vuelve a elegir día con el huso de la sesión —medido:
     * 2026-09-05 en Kiritimati y 2026-09-04 en Etc/GMT+12—, y la excepción lo tapaba: el
     * patrón descartaba la coincidencia en `::text` y el RELOJ no puede atravesar el paso por
     * texto para llegar al destino final, así que la expresión entera se escapaba.
     *
     * Ahora la excepción lleva su propia condición: la vuelta con huso NO salva si detrás hay
     * otro casto a un tipo sin huso — y ese casto se escribe con las MISMAS dos sintaxis que
     * la vuelta, así que la condición las mira las dos. Escrita solo con `::`,
     * `cast(now()::text::timestamptz as date)` se escapaba entera: el `as date` no se veía, la
     * vuelta pasaba por terminal y la expresión quedaba exenta — y elige día con el huso de la
     * sesión igual que las demás (medido: 2026-09-05 en Kiritimati y 2026-09-04 en
     * Etc/GMT+12). El mismo hueco que ya se había tapado en la mitad de arriba, abierto en la
     * de abajo: un criterio repetido aprende en un sitio y se queda viejo en el otro.
     *
     * El `as` exige aquí también su `)` de cierre, y por lo mismo: `now()::text::timestamptz
     * as date` sin paréntesis es un ALIAS de columna, no un cast, y ahí la vuelta sí es
     * terminal y la expresión sí es correcta.
     *
     * Y lo que descalifica a la vuelta es CUALQUIER casto detrás, no solo uno a un tipo sin
     * huso. Escrita con esa lista, `now()::text::timestamptz::text::date` se escapaba —el
     * paso intermedio por texto no era «un tipo sin huso», así que la vuelta seguía pareciendo
     * terminal— y elige día igual que las demás (medido: 2026-09-05 en Kiritimati y
     * 2026-09-04 en Etc/GMT+12). Era el LÍMITE que esta misma nota declaraba, y mirar qué lo
     * sostenía costó una condición más corta, no una más larga: la vuelta salva si el valor se
     * queda ahí, y no si se le sigue haciendo cosas.
     *
     * Se marca de más un `now()::text::timestamptz::timestamptz`, que no cambia nada y que
     * nadie escribe. Un falso positivo se ve; el hueco que cerraba no.
     */
    const OTRO_CASTO = String.raw`::|as\s+${ESQUEMA}(?:"[^"]*"|\w+)${PRECISION}\s*\)`;
    const VUELTA_CON_HUSO = String.raw`(?!(?:\s*\))*\s*(?:::\s*${ESQUEMA}(?:${TIPO_CON_HUSO})|as\s+${ESQUEMA}(?:${TIPO_CON_HUSO})\s*\))(?!(?:\s*\))*\s*(?:${OTRO_CASTO})))`;
    const DESTINO_QUE_ELIGE = String.raw`${TIPO_SIN_HUSO}|(?:${TIPO_TEXTUAL})${VUELTA_CON_HUSO}`;

    /*
     * Y un operando cuyo tipo NO lleva huso, en las dos formas que se pueden leer del texto:
     * el literal tipado (`date '…'`) y el cast (`'…'::date`, `columna::date`). La segunda es
     * la que devuelve el catálogo: Postgres deparsea `current_timestamp < date '2026-09-04'`
     * como `(CURRENT_TIMESTAMP < '2026-09-04'::date)`.
     *
     * LÍMITE DECLARADO, porque conviene que esté escrito y no descubierto: una COLUMNA cuyo
     * tipo es `date` no se distingue de cualquier otro identificador mirando el texto. Este
     * censo no resuelve tipos de columnas, así que `vence_en > current_timestamp` con
     * `vence_en date` se le escapa. Lo que sí cubre es la forma en que aparece escrita una
     * garantía: un literal o un cast.
     */
    const OPERANDO_SIN_HUSO = String.raw`(?:${TIPO_SIN_HUSO}\s*${PREFIJO}'[^']*'|(?:${PREFIJO}'[^']*'|[\w."]+)\s*::\s*${ESQUEMA}(?:${TIPO_SIN_HUSO}))`;
    const COMPARADOR = String.raw`(?:<=|>=|<>|!=|<|>|=)`;

    /*
     * La UNIDAD de `date_trunc`/`date_part` no siempre es un literal pegado al paréntesis:
     * `date_trunc(CAST('day' AS text), now())` elige día igual —medido: 2026-09-05 00:00+14 y
     * 2026-09-04 00:00-12— y `date_trunc(v_unidad, now())` ni siquiera se puede leer.
     *
     * Así que la pregunta se INVIERTE, que es lo que cierra la clase en vez del caso: en lugar
     * de reconocer las unidades peligrosas —lista infinita— se exige que la unidad sea una de
     * las SEGURAS, medidas contra todos los husos, escrita de alguna de sus tres formas. Todo
     * lo demás se marca, incluida una unidad que no sea literal.
     *
     * LÍMITE DECLARADO: una unidad con una coma dentro del literal partiría el argumento. No
     * existe ninguna unidad válida así.
     */
    /*
     * Y la unidad SEGURA se puede escribir con envolturas que no la cambian: entre paréntesis
     * —`date_trunc(('second'), now())`— y con el tipo calificado —`'second'::pg_catalog.text`—.
     * Las dos son estables (medido por EPOCH, no por texto: el resultado es `timestamptz` y su
     * representación lleva el desfase, así que compararlo como texto dice que cambia cuando no
     * cambia — la misma trampa que este censo existe para cazar, en la que caí al medirlo).
     * Sin admitirlas, el censo marcaba código correcto.
     */
    const unidadSegura = (lista: string) =>
      envuelto(
        String.raw`${literalDe(lista)}|cast\s*\(\s*${PREFIJO}'(?:${lista})'\s+as\s+[\w. ]+\s*\)`,
      );
    /*
     * El PRIMER argumento de una llamada, hasta su coma de primer nivel. Dos niveles de
     * paréntesis y no uno: con uno solo, `timezone((current_setting('TimeZone')), now())` no
     * se podía consumir —el grupo exterior contiene los paréntesis de `current_setting`—, el
     * patrón no casaba y la expresión pasaba entera, eligiendo día con el huso de la sesión
     * (medido: 2026-09-05 en Kiritimati y 2026-09-04 en Etc/GMT+12). Las dos alternativas
     * empiezan por caracteres distintos en cada nivel, así que no hay ambigüedad que hacer
     * retroceder al motor.
     *
     * LÍMITE DECLARADO: un tercer nivel de envoltura vuelve a escaparse. Una expresión regular
     * no cuenta paréntesis; lo que se puede hacer es subir el techo cuando aparezca una forma
     * real que lo pida.
     */
    const PRIMER_ARGUMENTO = String.raw`(?:[^,()]|\((?:[^()]|\([^()]*\))*\))*`;
    /*
     * `date_trunc` tiene una sobrecarga de TRES argumentos, y el tercero es el huso. Con un
     * literal fijo —`date_trunc('day', now(), 'UTC')`— el resultado es el mismo instante en
     * cualquier sesión (medido por epoch); con algo que LEA la sesión —`current_setting(
     * 'TimeZone')`— vuelve a depender de quien llama, y el patrón no lo veía porque exigía el
     * paréntesis pegado al reloj.
     *
     * La guardia va DELANTE del `\s*` y no detrás, que es donde la puse primero: con el
     * espacio por medio, el motor lo devuelve a cero, la aserción se evalúa sobre el espacio
     * —donde no hay literal— y pasa. Una aserción negativa detrás de algo opcional no asegura
     * nada; ya lo tenía escrito de otra vuelta y volví a hacerlo.
     */
    const HUSO_LITERAL = literalDe(String.raw`[^']*`);
    const HUSO_FIJO = String.raw`${HUSO_LITERAL}\s*\)`;
    /*
     * Y el prefijo de una conversión con huso FIJO, para poder decir «este reloj ya está
     * convertido» desde detrás. Se usa como mirada atrás, que es la única forma de excluir el
     * ARREGLO sin dejar de mirar dentro de lo demás.
     *
     * Exige que el huso sea LITERAL, y conviene ser exacto sobre lo que eso vale hoy: NO carga
     * peso por sí solo. Un huso dinámico dentro de un JSON ya lo marca el patrón de
     * `timezone(...)`, que no necesita al de JSON para nada; comprobado aflojando esta
     * condición a un argumento cualquiera, y no se mueve ninguna sonda. Se escribe así porque
     * es el criterio correcto —«convertido» significa convertido a un huso fijo— y porque dos
     * guardas que dicen cosas distintas del mismo hecho es como este fichero ha fallado ya
     * cuatro veces. Medido, no supuesto.
     */
    /** Lo que RENDERIZA un valor a texto: la clase del JSON, más los de la biblioteca. */
    /*
     * `array_to_string` va en la lista aunque no lo parezca: no renderiza UN valor, renderiza
     * cada ELEMENTO con la función de salida de su tipo, que es exactamente lo mismo un piso
     * más abajo. Medido: `array_to_string(array[now()], ',')` da
     * `2026-09-05 08:26:19.88+14` en Pacific/Kiritimati y `2026-09-04 06:26:19.92-12` en
     * Etc/GMT+12 — fecha distinta dentro del texto, no solo desfase distinto.
     *
     * Los demás serializadores de array ya entraban por `\w*json\w*`: `array_to_json`,
     * `to_jsonb`, `jsonb_build_array`. Éste era el único que renderiza a texto plano sin
     * llevar `json` en el nombre.
     */
    const SERIALIZAN = String.raw`\w*json\w*|array_to_string|concat|concat_ws|quote_literal|quote_nullable|quote_ident|format`;
    const HUSO_YA_FIJADO = String.raw`${nombreDeFuncion('timezone')}\s*\(\s*${envuelto(HUSO_LITERAL)}\s*,\s*`;
    /*
     * Y el FORMATO de `to_char`, que hasta ahora no se miraba: se marcaba cualquier `to_char`
     * con un reloj delante, y hay formatos que no leen el calendario —`'"fijo"'` devuelve
     * texto literal y `'US'` extrae microsegundos—.
     *
     * Qué declaro seguro, y por qué NO es la lista que medí. Barrí los 57 códigos contra los
     * 499 husos y seis instantes de frontera y salieron 17 estables; pero seis instantes son
     * una MUESTRA, no una prueba, y equivocarse aquí es un hueco SILENCIOSO. Así que solo
     * declaro seguros aquellos cuya estabilidad se sigue de un invariante ya medido: los
     * campos por debajo del minuto, porque ningún huso tiene hoy desfase con segundos —eso
     * está medido en este mismo fichero, sobre los 499—. `CC`, `IYYY`, `IW` y compañía
     * salieron estables en la muestra y aun así van fuera: marcarlos de más es un falso
     * positivo, que se ve; darlos por seguros sin invariante sería un agujero que no.
     *
     * El texto entre comillas dobles es literal por definición del formato.
     *
     * `SSSS` —segundos desde medianoche— NO entra, y por eso los códigos exigen no llevar
     * detrás otra letra o dígito: sin esa guardia se leería como `SS` + `SS` y pasaría por
     * seguro.
     */
    const FORMATO_SEGURO = literalDe(
      String.raw`(?:"[^"]*"|[^A-Za-z0-9"']|(?:SS|MS|US|FF[1-6])(?![A-Za-z0-9]))*`,
    );
    RELOJ_COLAPSADO_A_DIA = [
      // El cast al tipo sin huso, en sus cuatro formas de una sola vez: `now()::date` tal como
      // se escribe, `(now())::date` tal como Postgres la devuelve —y a la que reduce también
      // `cast(now() as date)`—, `now()::timestamp::date` con salto intermedio, y
      // `((timeofday())::timestamp with time zone)::date`, que es la anterior deparseada.
      //
      // Eran tres patrones y ahora es uno; las cuatro formas siguen teniendo sonda propia,
      // porque juntar patrones sin dejar prueba de cada forma es cambiar un hueco por otro.
      //
      // NO marca `(timezone('UTC'::text, now()))::date`: ahí el paréntesis que precede al
      // `::` es el de `timezone`, y `timezone` no es un reloj — el reloj va envuelto.
      /*
       * La conversión de huso con un huso DINÁMICO. `timezone('UTC', now())` es el ARREGLO
       * canónico de este PR y por eso el censo lo deja pasar; con
       * `timezone(current_setting('TimeZone'), now())` vuelve a decidir quien llama —medido:
       * 2026-09-05 en Kiritimati y 2026-09-04 en Etc/GMT+12— y la excepción lo tapaba.
       *
       * Se marca cuando el huso NO es un literal fijo. En las dos sintaxis, que son la misma
       * operación escrita distinto.
       *
       * La guardia va pegada a la palabra y no detrás del espacio, por lo de siempre: con el
       * `\s+` por medio el motor lo devuelve a cero y la aserción deja de guardar.
       */
      new RegExp(
        String.raw`${nombreDeFuncion('timezone')}\s*\((?!\s*${envuelto(HUSO_LITERAL)}\s*,)\s*${PRIMER_ARGUMENTO},\s*(${RELOJ})\s*\)`,
        'i',
      ),
      new RegExp(
        String.raw`(${RELOJ})\s*at\s+time\s+zone(?!\s+${envuelto(HUSO_LITERAL)})\s+`,
        'i',
      ),
      new RegExp(String.raw`(${RELOJ})\s*::\s*${ESQUEMA}(?:${DESTINO_QUE_ELIGE})`, 'i'),
      /*
       * Y el reloj escrito ENTERO entre comillas, que era la puerta de al lado: `'now'::date`
       * es exactamente `current_date` —2026-09-05 en Pacific/Kiritimati y 2026-09-04 en
       * Etc/GMT+12, medido— y `current_date` está prohibido desde la primera línea de este
       * fichero mientras su sinónimo pasaba limpio, porque el vaciado de literales se llevaba
       * el contenido antes de que nadie lo mirara. No es un caso raro: es la forma de saltarse
       * el censo entero sin escribir ninguna de las palabras que vigila.
       *
       * `'now'` con un tipo CON huso es el instante y ya está en la lista de relojes; aquí van
       * los tipos SIN huso, que es donde se elige calendario. Las tres sintaxis, porque el
       * literal tipado (`date 'now'`) y el `cast` no se deparsean igual que el `::`.
       *
       * La frontera IZQUIERDA es la misma disciplina que llevan las funciones —sin ella,
       * `mi_now()` salía marcado—: un `creado_date` con un literal pegado detrás casaría el
       * nombre del tipo DENTRO del identificador. Dicho con honestidad: no mueve ninguna sonda,
       * y no por falta de buscarla, sino porque en SQL válido no hay sitio donde un
       * identificador pueda ir pegado a un literal —ahí solo cabe un literal TIPADO—. Se queda
       * porque el reconocedor de un nombre de tipo tiene que reconocer el nombre entero, no un
       * trozo; la alternativa es descubrir el falso positivo en el primer nombre de columna que
       * acabe en `_date`.
       */
      new RegExp(String.raw`${AHORA_LITERAL}\s*::\s*${ESQUEMA}(?:${TIPO_SIN_HUSO})`, 'i'),
      new RegExp(String.raw`(?<![\w.])${ESQUEMA}(?:${TIPO_SIN_HUSO})\s*${AHORA_LITERAL}`, 'i'),
      new RegExp(
        String.raw`cast\s*\(\s*${AHORA_LITERAL}\s+as\s+${ESQUEMA}(?:${TIPO_SIN_HUSO})`,
        'i',
      ),
      // Y las tres hermanas, con cualquier tipo temporal: ni con huso conservan el instante.
      new RegExp(
        String.raw`${DIA_LITERAL}\s*::\s*${ESQUEMA}(?:${TIPO_SIN_HUSO}|${TIPO_CON_HUSO})`,
        'i',
      ),
      new RegExp(
        String.raw`(?<![\w.])${ESQUEMA}(?:${TIPO_SIN_HUSO}|${TIPO_CON_HUSO})\s*${DIA_LITERAL}`,
        'i',
      ),
      new RegExp(
        String.raw`cast\s*\(\s*${DIA_LITERAL}\s+as\s+${ESQUEMA}(?:${TIPO_SIN_HUSO}|${TIPO_CON_HUSO})`,
        'i',
      ),
      // `cast(now() as date)` en el código fuente, antes de que nadie la deparsee.
      new RegExp(String.raw`cast\s*\(\s*(${RELOJ})\s+as\s+${ESQUEMA}(?:${DESTINO_QUE_ELIGE})`, 'i'),
      // `date(now())`, la tercera forma de escribir la misma conversión.
      new RegExp(String.raw`${nombreDeFuncion('date|time')}\s*\(\s*(${RELOJ})\s*\)`, 'i'),
      /*
       * Y la COMPARACIÓN MIXTA, que es la puerta que abrió declarar seguro el reloj desnudo.
       * `current_timestamp` es un instante absoluto, sí — pero comparado contra un valor SIN
       * huso, el que se mueve es el otro: Postgres promociona el `date` a `timestamptz`
       * usando la MEDIANOCHE LOCAL de la sesión. Medido:
       *
       *   current_timestamp < date '2026-09-04'   →  false en UTC+14, true en UTC-12
       *
       * O sea que la garantía la sigue eligiendo quien llama, aunque el reloj no tenga la
       * culpa. Marcar el reloj a secas lo cazaba por accidente y a costa de marcar todo uso
       * legítimo; esto lo caza por lo que es, y solo eso.
       *
       * En los dos órdenes, porque el reloj puede ir a cualquier lado del comparador.
       */
      new RegExp(String.raw`(${RELOJ})\s*${COMPARADOR}\s*(${OPERANDO_SIN_HUSO})`, 'i'),
      new RegExp(String.raw`(${OPERANDO_SIN_HUSO})\s*${COMPARADOR}\s*(${RELOJ})`, 'i'),
      /*
       * `BETWEEN` es TERNARIO y lo trataba como binario: solo miraba el primer límite, así
       * que `now() between timestamptz '…' and date '2026-09-04'` —peligrosa por el límite
       * de arriba, medida— pasaba limpia, y `NOT BETWEEN` no casaba siquiera por el `not`
       * de en medio. Un patrón por límite, y el `not` opcional.
       *
       * (En el CATÁLOGO no hacía falta: Postgres deparsea el `between` como
       * `(x >= a) AND (x <= b)`, y esos dos ya los cazaban los comparadores de arriba. Esto
       * es para el censo de plantillas, donde el SQL está tal como se escribió.)
       */
      new RegExp(
        String.raw`(${RELOJ})\s+(?:not\s+)?between\s+(${OPERANDO_SIN_HUSO})`,
        'i',
      ),
      new RegExp(
        // El hueco entre los dos límites no puede CRUZAR un `and`: con `[^;]*?` el patrón
        // alcanzaba cualquier `and` posterior, y `now() between <tz> and <tz> and date … = …`
        // —segura, medida— salía marcada por la condición de al lado. Con la clase templada,
        // el `and` que encuentra es el del propio ternario.
        String.raw`(${RELOJ})\s+(?:not\s+)?between\b(?:(?!\band\b)[^;])*?\band\s+(${OPERANDO_SIN_HUSO})`,
        'i',
      ),
    ];
    /*
     * Y aparte los DOS que LEEN el literal, porque tienen que mirar el texto con los literales
     * dentro y los demás no. Separarlos no es estética: es lo que permite vaciar los literales
     * para todo lo demás sin romper `date_trunc('milliseconds', now())`.
     */
    RELOJ_LEYENDO_LITERAL = [
      // `to_char(now(), 'YYYY-MM-DD')`: no colapsa a un `date` pero produce el mismo día del
      // huso, y una regla escrita sobre esa cadena decide igual. El reloj tiene que ser el
      // PRIMER argumento — envuelto en `timezone('UTC', …)` ya no lo es. Y desde que mira el
      // FORMATO tiene que ver el literal sin vaciar, como los otros dos.
      //
      // La guardia va pegada a la coma y NO detrás del `\s*`: con el espacio por medio el
      // motor lo devuelve a cero y la aserción se evalúa donde no hay literal.
      new RegExp(String.raw`${nombreDeFuncion('to_char')}\s*\(\s*(${RELOJ})\s*,(?!\s*${FORMATO_SEGURO}\s*\))`, 'i'),
      /*
       * `extract` entra aquí desde que el campo puede ser un LITERAL —`extract('dow' from
       * now())` es SQL válido, comprobado contra la base—: si el literal viene vaciado, el
       * nombre del campo desaparece y hasta `extract('epoch' …)` —seguro— saldría marcado.
       * Lo cazó su propia sonda segura, que para eso está.
       */
      new RegExp(
        String.raw`extract\s*\(\s*(?!(?:(?:${CAMPOS_SEGUROS})\b|${literalDe(CAMPOS_SEGUROS)})\s*from)(?:${literalDe(String.raw`[^']*`)}|\w+)\s+from\s+(${RELOJ})`,
        'i',
      ),
      // `date_trunc('day', now())`, su forma deparseada `date_trunc('day'::text, now())` y la
      // que lleva cast: `date_trunc('day', timeofday()::timestamptz)`, obligada porque ese
      // reloj devuelve texto. Marca CUALQUIER unidad que no esté en la lista medida.
      new RegExp(
        String.raw`${nombreDeFuncion('date_trunc')}\s*\(\s*(?!${unidadSegura(UNIDADES_SEGURAS)}\s*,)${PRIMER_ARGUMENTO},\s*(${RELOJ})\s*(?:,(?!\s*${HUSO_FIJO})\s*${PRIMER_ARGUMENTO})?\s*\)`,
        'i',
      ),
      // `date_part('dow', now())`, que es la misma operación con la otra sintaxis, y su forma
      // deparseada `date_part('dow'::text, now())`.
      new RegExp(
        String.raw`${nombreDeFuncion('date_part')}\s*\(\s*(?!${unidadSegura(CAMPOS_SEGUROS)}\s*,)${PRIMER_ARGUMENTO},\s*(${RELOJ})`,
        'i',
      ),
      /*
       * La SERIALIZACIÓN, en cualquiera de sus formas. `to_json(now())` imprime el
       * `timestamptz` con la fecha, la hora y el desfase LOCALES —medido: «2026-09-05T05:11:45+14:00» en Kiritimati y
       * «2026-09-04T03:11:45-12:00» en Etc/GMT+12—, así que es la MISMA elección de calendario
       * que `now()::text`, que ya se marcaba, escrita con otra función.
       *
       * Y no solo el JSON: `concat(now())`, `quote_literal(now())` y `format('%s', now())`
       * hacen la MISMA coerción implícita a texto, medidas las tres igual de dependientes. Lo
       * que las junta no es el formato de salida sino que todas RENDERIZAN el reloj.
       *
       * Los que llevan `json` en el nombre entran por la clase —`to_json`, `to_jsonb`,
       * `json_build_object`, `jsonb_agg`, `row_to_json` y los que nazcan mañana, sin que nadie
       * tenga que acordarse—; los demás son un conjunto CERRADO de la biblioteca estándar y
       * por eso van nombrados.
       *
       * Y el reloj puede ir ANIDADO, que es como se usa `row_to_json` de verdad —exige
       * construir un registro—: `row_to_json(row(now()))` y `jsonb_build_object('d',
       * coalesce(now(), now()))` serializan igual de local (medido). Así que el consumidor
       * DESCIENDE: puede saltarse una llamada anidada entera para seguir en el mismo nivel, o
       * meterse dentro de ella. Lo que no puede es cruzar un `)`, así que nunca sale de la
       * llamada JSON — que es lo que lo separa de un `.*` y de marcar un reloj de más allá.
       *
       * Lo que deja fuera el ARREGLO canónico ya no es la profundidad sino una mirada ATRÁS:
       * un reloj precedido de una conversión con huso LITERAL ya está convertido, y
       * `to_json(timezone('UTC', now()))` da el mismo texto en los dos husos (medido). Con el
       * huso dinámico la mirada no casa y la expresión se marca, que es justo lo correcto.
       * (`to_json(now() at time zone 'UTC')` no llega ni a probarse: detrás del reloj no hay
       * una coma ni un cierre.)
       */
      new RegExp(
        String.raw`${nombreDeFuncion(SERIALIZAN)}\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\)|\()*?(?<!${HUSO_YA_FIJADO})(${RELOJ})\s*(?=[,)\]])`,
        'i',
      ),
      /*
       * Y el OPERADOR de concatenación, que hace la misma coerción sin nombrar ninguna
       * función: `now() || ''` da «2026-09-05 05:43…+14» y «2026-09-04 03:43…-12» (medido).
       * En los dos órdenes, porque el reloj puede ir a cualquier lado.
       *
       * El arreglo no casa por dónde queda el reloj: en `timezone('UTC', now()) || ''` lo que
       * precede al operador es el paréntesis de la conversión, no un reloj. Y la resta de dos
       * relojes tampoco, por la misma gramática que ya usan las comparaciones: sigue siendo el
       * intervalo cero, medido `00:00:00` en los dos husos.
       */
      new RegExp(String.raw`(${RELOJ})\s*\|\|`, 'i'),
      new RegExp(String.raw`\|\|\s*(${RELOJ})`, 'i'),
      /*
       * `age(x)` con UN argumento, que es el único de esta lista donde el reloj no se escribe:
       * lo pone Postgres. La documentación dice «resta el argumento de current_date (a
       * medianoche)», y medido sobre el mismo instante sale `8 mons 3 days 10:00:00` en
       * Kiritimati y `8 mons 3 days 12:00:00` en Etc/GMT+12. Una regla escrita como
       * `age(vence_en) > interval '30 days'` cambia de respuesta con la sesión igual que
       * `current_date`, y por eso no hacía falta que hubiera un reloj a la vista para marcarla:
       * la peligrosa es la FORMA de un solo argumento.
       *
       * Con DOS argumentos no hay calendario que leer —los dos instantes vienen dados, medido
       * idéntico en los dos husos— y no se marca. Los separa `PRIMER_ARGUMENTO`, que no cruza
       * comas de primer nivel: si detrás del primer argumento hay `)`, era uno solo.
       *
       * Hoy `age` no aparece en el repositorio. Entra igual, que es para lo que existe un censo
       * y no una lista de hallazgos: la garantía que lo use mañana ya nace vigilada.
       */
      new RegExp(String.raw`${nombreDeFuncion('age')}\s*\(\s*${PRIMER_ARGUMENTO}\)`, 'i'),
    ];

    /*
     * Y los dos reconocedores del destino TIPADO, que es lo que la expresión no dice.
     *
     * El primero: dónde se ENTREGA un valor al tipo declarado de fuera. Son tres posiciones y
     * las tres se miden: `return now();` en un cuerpo plpgsql, `select now()` como cuerpo SQL
     * —las dos formas, la antigua entre dólares y la nueva `RETURN now()`, que el catálogo
     * guarda SIN cast (comprobado)— y la expresión entera, que es como llega un `default`.
     * Las tres dan 2026-09-05 en Pacific/Kiritimati y 2026-09-04 en Etc/GMT+12 con
     * `returns date`, y las tres son un `now()` desnudo en el texto.
     *
     * El reloj tiene que ser TERMINAL en su posición: si detrás hay algo más —un cast, una
     * coma, un `into`— la coerción implícita ya no es lo que decide, y lo que decida ya lo
     * miran los demás patrones. Por eso el fin de expresión es una aserción y no un consumo.
     *
     * Con una salida: el `from`. `select now() from t` entrega el mismo valor al mismo tipo
     * declarado —medido, 2026-09-05 en Pacific/Kiritimati contra 2026-09-04 en Etc/GMT+12 con
     * `returns date`— y sin admitirlo bastaba escribir un `from` para salirse. Un `into` NO es
     * salida, y la asimetría es a propósito: ahí el destino es la variable, y de eso se ocupa
     * el reconocedor de al lado.
     */
    /*
     * Y el reloj ENTREGADO no tiene por qué ser toda la expresión. Una función `returns date`
     * con `return coalesce(now(), now());` colapsa un `timestamptz` a día con el huso de quien
     * llama —medido: 2026-09-05 en Pacific/Kiritimati y 2026-09-04 en Etc/GMT+12— y lo mismo
     * `greatest(now(), now())` y `case when … then now() else now() end`, las tres medidas.
     * Exigir el reloj pegado al `return` las dejaba pasar las tres: el reconocedor se paraba
     * ante el `coalesce(`.
     *
     * Y no vale con buscar un reloj DENTRO, que es la tentación: `return timezone('UTC',
     * now())::date;` también lo contiene y es el arreglo canónico de este PR —medido 2026-09-04
     * en los dos husos—, y `return (select f from t where creado_en < now());` devuelve una
     * columna `date` con el reloj solo en el `where`. Marcar cualquiera de las dos es el falso
     * positivo que desactiva un censo.
     *
     * Lo que hay que seguir es el VALOR. Así que la expresión entregada se descompone en las
     * ramas que pueden ser su valor —las envolturas transparentes, que devuelven el tipo de sus
     * argumentos, y los brazos de un `case`— y se pregunta si alguna hoja es un reloj a secas.
     * `timezone(…)` no está en la lista porque NO es transparente: fija el huso, que es
     * exactamente lo contrario. Y el `select` de una subconsulta no se abre: su valor es la
     * columna, no lo que haya en el `where`.
     *
     * LÍMITE DECLARADO: la lista de envolturas transparentes se escribe a mano —`coalesce`,
     * `nullif`, `greatest`, `least`— y no se deriva del catálogo. Derivarla pediría resolver
     * tipos polimórficos, que no es cosa de este censo; lo que sí es cosa suya es que la lista
     * esté aquí, a la vista, y no repartida por los patrones.
     */
    const ENVOLTURA_TRANSPARENTE = /^(?:coalesce|nullif|greatest|least)$/i;
    const RELOJ_A_SECAS = new RegExp(String.raw`^\s*(?:${RELOJ})\s*$`, 'i');

    /** Lo que hay dentro de la llamada o del paréntesis, si el cierre es el ÚLTIMO carácter. */
    const dentroDelParentesis = (e: string): string | null => {
      const abre = e.indexOf('(');
      if (abre < 0) return null;
      let nivel = 0;
      for (let i = abre; i < e.length; i++) {
        if (e[i] === '(') nivel++;
        else if (e[i] === ')' && --nivel === 0) return i === e.length - 1 ? e.slice(abre + 1, i) : null;
      }
      return null;
    };

    /*
     * Lo de dentro de un `array[…]`, cuando los corchetes cierran la expresión entera. Se
     * exige el nombre delante: un `x[1]` es un SUBÍNDICE —que saca un elemento, no lo
     * entrega— y no tiene nada que ver.
     */
    const dentroDelCorchete = (e: string): string | null => {
      const m = /^array\s*\[/i.exec(e);
      if (!m) return null;
      const abre = m[0].length - 1;
      let nivel = 0;
      for (let i = abre; i < e.length; i++) {
        if (e[i] === '[') nivel++;
        else if (e[i] === ']' && --nivel === 0)
          return i === e.length - 1 ? e.slice(abre + 1, i) : null;
      }
      return null;
    };

    /**
     * Los argumentos de PRIMER nivel: una coma dentro de un paréntesis no separa. Ni dentro de
     * un CORCHETE, desde que se desciende por los constructores de array: en
     * `coalesce(array[a, b], c)` los argumentos son dos, y contando solo paréntesis salían
     * tres, partidos por la mitad. Contar también los corchetes solo puede unir trozos que
     * estaban mal partidos; no puede partir un argumento que estaba bien.
     */
    const argumentosDe = (dentro: string): string[] => {
      const partes: string[] = [];
      let nivel = 0;
      let desde = 0;
      for (let i = 0; i < dentro.length; i++) {
        if (dentro[i] === '(' || dentro[i] === '[') nivel++;
        else if (dentro[i] === ')' || dentro[i] === ']') nivel--;
        else if (dentro[i] === ',' && nivel === 0) {
          partes.push(dentro.slice(desde, i));
          desde = i + 1;
        }
      }
      partes.push(dentro.slice(desde));
      return partes;
    };

    /*
     * Los brazos de un `case`: lo que sigue a cada `then` y al `else`. Se recogen TODOS los que
     * estén fuera de paréntesis, sin llevar la cuenta de `case` anidados, y eso es a propósito:
     * el brazo de un `case` de dentro también es un valor que sube, así que recoger de más aquí
     * es recoger bien. Lo que no se cruza es un paréntesis, que sí cambia de expresión.
     */
    const brazosDelCase = (e: string): string[] | null => {
      if (!/^case\b/i.test(e)) return null;
      const brazos: string[] = [];
      let nivel = 0;
      let desde = -1;
      const token = /[()]|\b(?:case|when|then|else|end)\b/gi;
      let m: RegExpExecArray | null;
      while ((m = token.exec(e)) !== null) {
        const t = m[0].toLowerCase();
        if (t === '(') nivel++;
        else if (t === ')') nivel--;
        else if (nivel === 0) {
          if (desde >= 0) {
            brazos.push(e.slice(desde, m.index));
            desde = -1;
          }
          if (t === 'then' || t === 'else') desde = m.index + m[0].length;
        }
      }
      if (desde >= 0) brazos.push(e.slice(desde));
      return brazos.length > 0 ? brazos : null;
    };

    /** Las hojas cuyo valor PUEDE ser el de la expresión entera. */
    const hojasDelValor = (expr: string, hondura = 0): string[] => {
      const e = expr.trim();
      if (hondura >= 8 || e === '') return [e];
      const brazos = brazosDelCase(e);
      if (brazos) return brazos.flatMap((b) => hojasDelValor(b, hondura + 1));
      const dentro = dentroDelParentesis(e);
      if (dentro !== null) {
        const nombre = e.slice(0, e.indexOf('(')).trim();
        // Sin nombre delante son los paréntesis propios de la expresión, que no cambian nada.
        if (nombre === '') return hojasDelValor(dentro, hondura + 1);
        if (ENVOLTURA_TRANSPARENTE.test(nombre))
          return argumentosDe(dentro).flatMap((a) => hojasDelValor(a, hondura + 1));
        /*
         * Y el constructor de array en su OTRA sintaxis, la de subconsulta. Aquí me equivoqué
         * al razonarlo la primera vez —escribí que no entraba porque «su valor es la columna,
         * no lo que haya en el where», y eso es media verdad—: el `where` efectivamente no se
         * sigue, pero la LISTA DE SELECCIÓN es exactamente el valor que se entrega. Medido:
         * `returns date[]` con `return array(select now())` da `{2026-09-05}` en
         * Pacific/Kiritimati y `{2026-09-04}` en Etc/GMT+12, sin un solo cast escrito.
         *
         * Así que se abre la lista y se para donde empiezan las cláusulas. La sonda segura es
         * la que fija la mitad correcta de aquel razonamiento: un `array(select d from t where
         * … < now())` proyecta `d` y usa el reloj solo para filtrar.
         */
        if (/^array$/i.test(nombre)) {
          const lista = /^\s*select\s+([\s\S]*?)(?=\s+from\b|\s+where\b|$)/i.exec(dentro);
          if (lista) return argumentosDe(lista[1]!).flatMap((a) => hojasDelValor(a, hondura + 1));
        }
      }
      /*
       * Y el CONSTRUCTOR de array, que no es una llamada y por eso no entraba por arriba.
       * `array[a, b]` no devuelve el valor de sus elementos —devuelve el array— pero para lo
       * único que se pregunta aquí da igual: el tipo declarado se reparte elemento a elemento,
       * así que cada elemento se entrega a `date` con la misma fuerza que si fuera toda la
       * expresión. Medido: `returns date[]` con `return array[now()]`, 2026-09-05 contra
       * 2026-09-04 en husos opuestos.
       *
       * `array(select …)` NO entra, y es la misma asimetría que ya rige para las subconsultas:
       * su valor es la columna que devuelve el select, no lo que se escriba en el `where`. Va
       * por la rama de los paréntesis de arriba, donde el nombre `array` no está en la lista de
       * envolturas transparentes, así que se queda como hoja. (`array(select now()::date)` sí
       * depende de quien llama —medido—, pero por el `::date` que lleva escrito, y de eso ya se
       * ocupan los patrones del cast.)
       */
      const enCorchetes = dentroDelCorchete(e);
      if (enCorchetes !== null)
        return argumentosDe(enCorchetes).flatMap((a) => hojasDelValor(a, hondura + 1));
      return [e];
    };

    /*
     * De dónde se saca la expresión entregada. Tres sitios, los mismos tres de antes: el
     * `return` de plpgsql, el `select` de un cuerpo SQL —que termina también en su `from`— y
     * el texto ENTERO, que es como llega un `default`.
     */
    const ENTREGAS = [
      // `return next` es otra entrega al mismo tipo declarado, no una palabra suelta: medido,
      // `returns setof date` con `return next now();` da 2026-09-05 en Pacific/Kiritimati y
      // 2026-09-04 en Etc/GMT+12. Sin la alternativa, lo que se leía era `next now()`, que no
      // es ningún reloj. (`return next;` a secas —el de un RETURNS TABLE que ya asignó sus
      // columnas— no casa esta rama y sigue yendo por la de al lado, que es lo correcto: ahí
      // el valor lo pusieron las variables.)
      /\breturn\s+(?:query\s+select\s+|next\s+)?([^;]*?)(?=;|\s*\$|\s*$)/gi,
      /\bselect\s+([^;]*?)(?=;|\s+from\b|\s*\$|\s*$)/gi,
    ];
    RELOJ_ENTREGADO = (texto: string): boolean =>
      [texto, ...ENTREGAS.flatMap((r) => [...texto.matchAll(r)].map((m) => m[1]!))].some((e) =>
        hojasDelValor(e).some((hoja) => RELOJ_A_SECAS.test(hoja)),
      );

    /*
     * El segundo no necesita que nadie le pase el tipo, porque lo declara el propio texto: una
     * VARIABLE plpgsql. `declare d date; begin d := now(); …` guarda el día del huso de quien
     * llama —medido, 09-05 contra 09-04— y en el texto solo hay, otra vez, un `now()` desnudo.
     *
     * Se leen los nombres declarados con un tipo sin huso y se busca la asignación a UNO DE
     * ELLOS, en las dos formas que tiene plpgsql: `:=` y `select … into`. Buscar la asignación
     * sin la declaración marcaría `v := now()` sobre una variable `timestamptz`, que es
     * correcto; buscar la declaración sin la asignación marcaría una variable que solo se lee.
     *
     * LÍMITE DECLARADO: el reconocedor de declaraciones no distingue el bloque `declare` del
     * resto del cuerpo, así que puede recoger un nombre de más —`cast(x as date);` daría «as»—.
     * No importa mientras ese nombre no aparezca además asignándose un reloj, que es lo que se
     * marca; queda dicho aquí en vez de descubrirse. Y las variables de un bloque ANIDADO se
     * mezclan con las de fuera, que es de más y no de menos.
     */
    /*
     * Y una variable no se declara solo en el `declare`: las columnas de salida de un
     * `RETURNS TABLE(d date)` son variables plpgsql con todas las letras, y ahí el tipo lo
     * sigue un `)` o una coma en vez de un `;`. Medido: `returns table(d date)` con
     * `d := now();` da 2026-09-05 en Pacific/Kiritimati y 2026-09-04 en Etc/GMT+12.
     *
     * Y es esta mitad la que tiene que cazarlo, no la del tipo declarado, por una razón que
     * conviene medir antes que suponer: con UNA columna de salida `prorettype` sí es `date`
     * —Postgres solo pone `record` a partir de DOS, medidos los dos casos— pero el valor no
     * llega por un `return`, llega por la ASIGNACIÓN, así que el reconocedor del destino no lo
     * ve pase lo que pase con el tipo de vuelta. Los parámetros `IN` de tipo fecha entran por
     * el mismo camino, y también es correcto: asignarles un reloj colapsa igual.
     *
     * LÍMITE DECLARADO, y va escrito aquí en vez de descubrirse: cuando el valor llega por una
     * LISTA de selección y no por una asignación —`returns table(d date, n int) as $$ select
     * now(), 1 $$`— nadie lo caza. Emparejar cada elemento de la lista con su columna declarada
     * es un analizador de listas de selección, no un censo de texto, y sin ese emparejamiento
     * el tipo de la columna no decide nada por sí solo. Lo que llega por asignación, que es
     * como se escribe un `RETURNS TABLE` en plpgsql, sí está cubierto.
     */
    /*
     * El nombre de una variable plpgsql puede venir ENTRECOMILLADO, y entonces no es `\w+`:
     * `declare "d" date; begin "d" := now(); return "d"; end` con `returns date` devuelve
     * 2026-09-05 en Pacific/Kiritimati y 2026-09-04 en Etc/GMT+12 —medido—, y el catálogo lo
     * guarda con las comillas puestas. El barrido las conserva bien (los nombres sí los leen
     * los patrones), pero la gramática del nombre no las admitía, así que no casaba ni la
     * declaración ni la asignación, y por el lado del tipo de vuelta solo se veía un
     * `return "d"` que no es ningún reloj. La variable quedaba invisible por los dos lados a
     * la vez.
     *
     * LÍMITE DECLARADO: un identificador entrecomillado distingue mayúsculas y uno desnudo
     * no, así que `declare "D" date; begin d := now();` son en Postgres dos variables
     * distintas y aquí se conflan. Ya se conflaban antes —estos patrones van con `i`— y el
     * error es hacia marcar de más, no de menos.
     */
    const NOMBRE_DE_VARIABLE = String.raw`"(?:[^"]|"")+"|\w+`;
    /*
     * Y la declaración se escribe con la gramática ENTERA de plpgsql, no con el trozo mínimo:
     *
     *     nombre [CONSTANT] tipo [COLLATE x] [NOT NULL] [ { DEFAULT | := | = } expresión ] ;
     *
     * Cada pieza opcional que faltaba aquí era una forma de declarar lo mismo y quedar fuera.
     * Las cinco medidas, todas 2026-09-05 en Pacific/Kiritimati contra 2026-09-04 en
     * Etc/GMT+12 y todas guardadas verbatim en el catálogo:
     *
     *   d date := now()              el inicializador va DENTRO de la declaración
     *   d constant date := now()     `constant` se mete entre el nombre y el tipo
     *   d date not null := now()     `not null` se mete entre el tipo y el inicializador
     *   d date default now()         la palabra `default` en vez del `:=`
     *   d date = now()               y el `=` a secas, que plpgsql también acepta
     *
     * El primero es el que más dice: el reconocedor separaba «declarar el nombre» de «buscarle
     * una asignación», y eso solo funciona cuando la asignación es una SENTENCIA aparte
     * —`declare d date; begin d := now();`—. Con el valor puesto en la propia declaración no
     * había ninguna sentencia que buscar, y era la forma más corta de escribirlo.
     *
     * Así que el inicializador se captura AQUÍ y se mira con las mismas hojas que todo lo
     * demás. Grupos con nombre y no por número, para que meter una pieza más en el medio no
     * vuelva a mover lo que lee quien llama.
     *
     * PIEZA QUE NO MUEVE NINGUNA SONDA, y se queda dicho en vez de venderse: el
     * `(?:constant\s+)?`. Sin él, `d constant date := now()` casa igual, solo que tomando
     * `constant` por el nombre de la variable — y como el inicializador se captura de todas
     * formas, el veredicto no cambia. Y no puede cambiar nunca: plpgsql **exige** inicializar
     * una `CONSTANT`, así que esa rama siempre está. Se queda porque el nombre que se lleva la
     * lista tiene que ser el de verdad y no una palabra clave, no porque atrape nada.
     */
    const DECLARADAS_SIN_HUSO = new RegExp(
      String.raw`(?<![\w"])(?<nombre>${NOMBRE_DE_VARIABLE})\s+(?:constant\s+)?${ESQUEMA}` +
        String.raw`(?:${TIPO_SIN_HUSO})\s*(?:collate\s+(?:\w+|"\w+")\s*)?(?:not\s+null\s*)?` +
        String.raw`(?:(?::=|=|\bdefault\b)\s*(?<inicial>[^;]*)|[;:,)])`,
      'gi',
    );
    /** El nombre como lo escribe quien lo declara, sin las comillas ni su duplicación. */
    const sinComillas = (n: string): string =>
      n.startsWith('"') ? n.slice(1, -1).replace(/""/g, '"') : n;
    /*
     * Y lo que se asigna se mira con las MISMAS hojas que lo que se devuelve, que es la lección
     * de aquí al lado escrita una vez más: `declare d date; begin d := coalesce(now(), now());`
     * colapsa igual (medido: 2026-09-05 en Pacific/Kiritimati contra 2026-09-04 en Etc/GMT+12)
     * y exigir el reloj pegado al `:=` lo dejaba pasar. El destino tipado y la asignación son
     * dos puertas del mismo sitio: si una sigue el valor y la otra no, la que no lo sigue es
     * por donde se entra.
     */
    RELOJ_ASIGNADO_A_VARIABLE = (texto: string): boolean => {
      const declaradas = [...texto.matchAll(DECLARADAS_SIN_HUSO)];
      const nombres = declaradas.map((m) => sinComillas(m.groups!.nombre!));
      if (nombres.length === 0) return false;
      // Lo que la propia declaración le pone dentro, que no es ninguna sentencia y por eso no
      // lo encontraba la búsqueda de asignaciones.
      const inicializadas = declaradas
        .map((m) => m.groups!.inicial)
        .filter((x): x is string => x !== undefined);
      /*
       * Cada nombre se busca en las formas en que se puede volver a escribir, porque
       * declararlo entrecomillado no obliga a usarlo así después (ni al revés).
       *
       * Y se ESCAPA para la expresión regular en vez de mutilarse, que es lo que hacía antes
       * —`replace(/[^\w]/g, '')`—. Sobre un nombre desnudo daba igual; sobre uno que necesita
       * las comillas, no: `"fecha final"` se convertía en `fechafinal`, que no aparece en el
       * texto por ningún lado, así que la asignación no se encontraba y la función salía
       * limpia. Medido antes de arreglarlo: `declare "fecha final" date; "fecha final" :=
       * now(); return "fecha final";` con `returns date` da 2026-09-05 en Pacific/Kiritimati
       * y 2026-09-04 en Etc/GMT+12.
       *
       * La forma DESNUDA solo se genera cuando el nombre puede escribirse sin comillas. Con un
       * espacio dentro no se puede, y buscarla sería buscar algo que Postgres no acepta.
       */
      const escapado = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const formasDelNombre = (n: string): string[] => {
        const citada = `"${escapado(n.replace(/"/g, '""'))}"`;
        return /^[A-Za-z_]\w*$/.test(n) ? [escapado(n), citada] : [citada];
      };
      const cualquiera = nombres.flatMap(formasDelNombre).join('|');
      if (cualquiera === '') return false;
      // Las tres formas de que a una de esas variables le caiga un valor: en su propia
      // declaración, por una asignación posterior, y por un `select … into`.
      const asignaciones = [
        ...texto.matchAll(
          new RegExp(String.raw`(?<![\w"])(?:${cualquiera})\s*:=\s*([^;]*)`, 'gi'),
        ),
        /*
         * Y plpgsql también asigna con `=` a secas: `declare d date; begin d = now();` hace la
         * misma coerción (medido, 2026-09-05 contra 2026-09-04). Va en su propia búsqueda y
         * no como alternativa del `:=`, porque el `=` es AMBIGUO: en `if d = now() then` es una
         * comparación, no una asignación. Lo que las separa es la posición, así que se exige
         * que el nombre empiece SENTENCIA — detrás de un `;`, o de las palabras que abren un
         * bloque—. El `:=` no necesita esa guarda porque no significa otra cosa.
         */
        ...texto.matchAll(
          new RegExp(
            String.raw`(?:^|;|\bbegin\b|\bthen\b|\belse\b|\bloop\b)\s*(?:${cualquiera})\s*=(?!=)\s*([^;]*)`,
            'gi',
          ),
        ),
        ...texto.matchAll(
          new RegExp(
            String.raw`\bselect\s+([\s\S]*?)\s+into\s+(?:strict\s+)?(?:${cualquiera})(?![\w"])`,
            'gi',
          ),
        ),
      ].map((m) => m[1]!);
      const derechas = [...inicializadas, ...asignaciones];
      return derechas.some((d) => hojasDelValor(d).some((hoja) => RELOJ_A_SECAS.test(hoja)));
    };

    /*
     * ── El destino tipado de una ESCRITURA ──
     *
     * Los tipos salen del catálogo, no de una lista, y con `format_type` y no con
     * `information_schema`: aquél imprime `date`, `timestamp without time zone` y `date[]`
     * exactamente como los escribe una declaración, que es lo que `SIN_HUSO_DECLARADO` ya
     * sabe leer; `information_schema` dice `ARRAY` para lo tercero y habría hecho falta un
     * segundo vocabulario para lo mismo.
     */
    const columnas = await sqlAdmin()`
      select c.relname as tabla, a.attname as columna, a.attnum as posicion,
             format_type(a.atttypid, a.atttypmod) as tipo
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      order by c.relname, a.attnum`;
    const TIPO_DE_COLUMNA = new Map<string, string>();
    const COLUMNAS_EN_ORDEN = new Map<string, string[]>();
    for (const f of columnas as unknown as {
      tabla: string;
      columna: string;
      tipo: string;
    }[]) {
      TIPO_DE_COLUMNA.set(`${f.tabla.toLowerCase()}.${f.columna.toLowerCase()}`, f.tipo);
      const ya = COLUMNAS_EN_ORDEN.get(f.tabla.toLowerCase()) ?? [];
      ya.push(f.columna.toLowerCase());
      COLUMNAS_EN_ORDEN.set(f.tabla.toLowerCase(), ya);
    }

    /** El nombre tal cual lo escribe Postgres: desnudo se pliega a minúsculas, citado no. */
    const nombreCanonico = (t: string): string => {
      const n = t.trim();
      return n.startsWith('"') ? n.slice(1, -1).replace(/""/g, '"') : n.toLowerCase();
    };
    /** Lo que hay entre el paréntesis que empieza en `desde` y el que lo cierra. */
    const parejaDeParentesis = (texto: string, desde: number): string | null => {
      let nivel = 0;
      for (let i = desde; i < texto.length; i++) {
        if (texto[i] === '(') nivel++;
        else if (texto[i] === ')' && --nivel === 0) return texto.slice(desde + 1, i);
      }
      return null;
    };

    /*
     * LÍMITES DECLARADOS, y son de forma, no de fondo: un `insert … select …` no trae la
     * expresión pegada a su columna en el texto, y la forma de fila del `update`
     * —`set (a, b) = (…)`— tampoco. Las dos se quedan fuera y se dicen aquí en vez de
     * descubrirse. Lo que sí entra es el `insert` con lista de columnas, el `insert` SIN
     * lista —que va por posición, y por eso el catálogo se lee ordenado por `attnum`— y el
     * `update … set col = expr`.
     */
    const NOMBRE_SQL = String.raw`(?:"(?:[^"]|"")+"|\w+)`;
    const INSERTA = new RegExp(
      // El destino de un `insert` también admite ALIAS, entre la tabla y la lista de
      // columnas: `insert into t as x(k, d) values (…)`. Medido: 2026-09-05 contra
      // 2026-09-04. El `(?!values\b)` evita que un `insert into t values (…)` tome `values`
      // por alias.
      String.raw`\binsert\s+into\s+(?:${NOMBRE_SQL}\s*\.\s*)?(${NOMBRE_SQL})` +
        String.raw`(?:\s+(?:as\s+)?(?!values\b)${NOMBRE_SQL})?\s*(?:\(([^)]*)\)\s*)?values\s*\(`,
      'gi',
    );
    const ACTUALIZA = new RegExp(
      // El destino puede llevar ALIAS —`update t as x set …`, con `as` o sin él—, y el tipo
      // de la columna se sigue consultando por la tabla de verdad, no por el alias. Medido:
      // 2026-09-05 contra 2026-09-04. El `(?!set\b)` es para que un `update t set …` no tome
      // `set` por alias y se quede sin cláusula que mirar.
      String.raw`\bupdate\s+(?:only\s+)?(?:${NOMBRE_SQL}\s*\.\s*)?(${NOMBRE_SQL})` +
        String.raw`(?:\s+(?:as\s+)?(?!set\b)${NOMBRE_SQL})?\s+set\s+([^;]*)`,
      'gi',
    );
    RELOJ_ESCRITO_EN_COLUMNA = (texto: string): boolean => {
      const entrega = (tabla: string, columna: string, expr: string): boolean => {
        const tipo = TIPO_DE_COLUMNA.get(`${tabla}.${columna}`);
        return (
          tipo !== undefined &&
          SIN_HUSO_DECLARADO.test(tipo) &&
          hojasDelValor(expr).some((hoja) => RELOJ_A_SECAS.test(hoja))
        );
      };
      /*
       * Dónde acaba de verdad la cláusula `set`. El corte NO puede ser la primera palabra
       * `from`/`where`/`returning` que aparezca: en
       * `set ts = (select now() where true), d = now()` ese `where` es de la SUBCONSULTA, y
       * cortar ahí deja fuera la asignación peligrosa —medido, esa función guarda 2026-09-05
       * y 2026-09-04—. Se corta en la primera que esté a profundidad CERO de paréntesis.
       */
      const CLAUSULA_SIGUIENTE = /\s(?:from|where|returning)\b/gi;
      const hastaLaClausula = (t: string): string => {
        CLAUSULA_SIGUIENTE.lastIndex = 0;
        for (let m = CLAUSULA_SIGUIENTE.exec(t); m !== null; m = CLAUSULA_SIGUIENTE.exec(t)) {
          let nivel = 0;
          for (let i = 0; i < m.index; i++) {
            if (t[i] === '(' || t[i] === '[') nivel++;
            else if (t[i] === ')' || t[i] === ']') nivel--;
          }
          if (nivel === 0) return t.slice(0, m.index);
        }
        return t;
      };
      /** Una cláusula `set`: `col = expr` separados por comas de primer nivel. */
      const asignacionCulpable = (tabla: string, clausulaCruda: string): boolean =>
        argumentosDe(hastaLaClausula(clausulaCruda)).some((pieza) => {
          const corte = pieza.indexOf('=');
          return (
            corte >= 0 && entrega(tabla, nombreCanonico(pieza.slice(0, corte)), pieza.slice(corte + 1))
          );
        });
      for (const m of texto.matchAll(INSERTA)) {
        const tabla = nombreCanonico(m[1]!);
        /*
         * TODAS las tuplas, no la primera: un `values (…), (…)` mete varias filas y cada una
         * se coerciona por su cuenta. Medido: `values (date '2026-01-01'), (now())` sobre una
         * columna `date` guarda 2026-01-01 y 2026-09-05 en Pacific/Kiritimati, y 2026-01-01 y
         * 2026-09-04 en Etc/GMT+12 — o sea que quedarse con la primera es mirar justo la fila
         * que suele ser inocente.
         */
        let cursor = m.index + m[0].length - 1;
        const tuplas: string[] = [];
        for (;;) {
          const dentro = parejaDeParentesis(texto, cursor);
          if (dentro === null) break;
          tuplas.push(dentro);
          cursor += dentro.length + 2;
          const siguiente = /^\s*,\s*\(/.exec(texto.slice(cursor));
          if (!siguiente) break;
          cursor += siguiente[0].length - 1;
        }
        if (tuplas.length === 0) continue;
        const destinos =
          m[2] === undefined
            ? (COLUMNAS_EN_ORDEN.get(tabla) ?? [])
            : argumentosDe(m[2]).map(nombreCanonico);
        if (
          tuplas.some((t) => {
            const valores = argumentosDe(t);
            return destinos.some(
              (c, i) => valores[i] !== undefined && entrega(tabla, c, valores[i]!),
            );
          })
        )
          return true;
        /*
         * Y el `ON CONFLICT … DO UPDATE SET`, que es un `update` con la tabla escrita arriba:
         * el propio `update` no lleva nombre detrás, así que el reconocedor de `UPDATE` no lo
         * ve y la tabla hay que traerla del `insert` que lo contiene. Medido:
         * `on conflict (k) do update set d = now()` sobre una columna `date` guarda
         * 2026-09-05 en Pacific/Kiritimati y 2026-09-04 en Etc/GMT+12.
         */
        // `cursor` quedó justo detrás del paréntesis que cierra la última tupla.
        const cola = texto.slice(cursor);
        const enConflicto =
          // El salto hasta el `do update` no cruza un `;`: si lo cruzara, un
          // `on conflict … do nothing;` seguido de un `update` de OTRA tabla se leería como
          // si el `set` de aquél fuera de ésta, y la culpa saldría atribuida a quien no es.
          /^\s*on\s+conflict\b[^;]*?\bdo\s+update\s+set\s+([^;]*)/i.exec(
            cola,
          );
        if (enConflicto && asignacionCulpable(tabla, enConflicto[1]!)) return true;
      }
      for (const m of texto.matchAll(ACTUALIZA)) {
        if (asignacionCulpable(nombreCanonico(m[1]!), m[2]!)) return true;
      }
      return false;
    };
  });

  /** Lo que hace culpable a un cuerpo: la palabra clave o cualquiera de las operaciones. */
  /**
   * Recibe el texto CRUDO y hace él mismo el barrido, en sus dos formas. Antes lo hacía cada
   * llamante y dos no lo hacían: el guardián no llegaba a limpiar lo que iba a mirar. Que la
   * limpieza no se pueda olvidar vale más que la flexibilidad de elegirla.
   *
   * Los patrones que LEEN el literal van contra el texto con los literales dentro; todo lo
   * demás, contra el texto con los literales vacíos, porque una palabra del reloj dentro de un
   * literal es un dato y no una lectura del calendario.
   */
  /*
   * El `tipoDeclarado` es lo que la EXPRESIÓN NO DICE. Postgres coerciona sin que nadie
   * escriba un cast: una función `returns date` cuyo cuerpo es `return now()` devuelve el día
   * del huso de quien llama —medido: 2026-09-05 en Pacific/Kiritimati y 2026-09-04 en
   * Etc/GMT+12— y en el texto solo hay un `now()` desnudo, que este censo declara seguro y con
   * razón. Lo mismo un `default now()` sobre una columna `date`, que el catálogo guarda como
   * `now()` a secas (comprobado) y coerciona en cada `INSERT`.
   *
   * O sea que había una familia entera invisible, y no porque el reconocedor fuera corto: el
   * dato que decide no está en lo que el reconocedor lee. Quien llama a `culpable` sobre algo
   * cuyo destino tiene tipo —una función por su `prorettype`, un default por el tipo de su
   * columna— lo pasa, y quien no lo tiene lo omite.
   */
  const culpable = (
    crudo: string,
    dialecto: 'sql' | 'ts' = 'sql',
    tipoDeclarado?: string,
  ): boolean => {
    const conLiterales = sinComentarios(crudo, dialecto);
    const sinLiterales = sinComentarios(crudo, dialecto, true);
    return (
      DEL_HUSO_DE_LA_SESION.test(sinLiterales) ||
      RELOJ_COLAPSADO_A_DIA.some((r) => r.test(sinLiterales)) ||
      RELOJ_LEYENDO_LITERAL.some((r) => r.test(conLiterales)) ||
      (tipoDeclarado !== undefined &&
        SIN_HUSO_DECLARADO.test(tipoDeclarado) &&
        RELOJ_ENTREGADO(sinLiterales)) ||
      RELOJ_ASIGNADO_A_VARIABLE(sinLiterales) ||
      RELOJ_ESCRITO_EN_COLUMNA(sinLiterales) ||
      /*
       * Y el SQL DINÁMICO: `execute 'select now()::date'` guarda la operación DENTRO de un
       * literal, que el vaciado se lleva por delante. La función depende del huso de quien la
       * llama igual que si estuviera escrita fuera. Se extrae y se analiza por su cuenta,
       * deshaciendo la duplicación de comillas; cada nivel quita una capa, así que la
       * recursión termina.
       *
       * Y el literal puede ir ENVUELTO: `execute format('select now()::date')` es la forma
       * normal de componer SQL dinámico en plpgsql, y el catálogo la conserva —comprobado—.
       * Se admiten las llamadas envolventes que haya delante.
       *
       * LÍMITE DECLARADO: `execute v_sql`, con la consulta en una variable, no se puede leer
       * desde el texto; y un `format` con marcadores mete trozos que aquí no están.
       */
      /*
       * Y el literal por DÓLAR, que es la otra forma de escribir el SQL de un `EXECUTE`.
       * Dentro del cuerpo de una función el delimitador exterior ya es un dólar, así que
       * `execute $q$select now()::date$q$` viajaba como literal ANIDADO: el vaciado se llevaba
       * su contenido y la extracción, que solo miraba comillas simples, no lo recuperaba. La
       * función dependía del huso igual y el censo la daba por limpia.
       *
       * `\\1` con la etiqueta opcional cubre las dos formas: con `$$…$$` el grupo no casa nada
       * y la referencia vale la cadena vacía. Aquí no hay escapes que deshacer — un
       * entrecomillado por dólar no los tiene, que es justo para lo que existe.
       */
      [
        ...conLiterales.matchAll(
          /\bexecute\s+(?:\w+\s*\(\s*)*\$([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$([\s\S]*?)\$\1\$/gi,
        ),
      ].some((m) => culpable(m[2]!, 'sql')) ||
      [
        ...conLiterales.matchAll(
          /\bexecute\s+(?:\w+\s*\(\s*)*((?:[A-Za-z_]*&?'(?:[^']|'')*'|\d+)(?:\s*(?:\|\||,)\s*(?:[A-Za-z_]*&?'(?:[^']|'')*'|\d+|\w+))*)/gi,
        ),
      ].some((m) =>
        /*
         * La cadena ENTERA, no el primer literal. `execute 'select now()' || '::date'` ejecuta
         * una consulta que depende del huso, y leyendo solo el primer trozo se leía
         * `select now()` —seguro— y la función pasaba limpia. El SQL que se ejecuta es la
         * concatenación, así que es la concatenación lo que se analiza.
         *
         * LÍMITE DECLARADO, el mismo de siempre y ahora con una forma más: si en medio de la
         * concatenación hay una VARIABLE, sus trozos no están en el texto. La cadena se corta
         * ahí, igual que `execute v_sql` no se puede leer.
         */
        (() => {
          /*
           * Los argumentos, y no solo los LITERALES. Un número desnudo es un argumento con
           * todas las letras —`format('select %2$*1$s::date', 0, 'now()')` da exactamente
           * `select now()::date`, medido— y dejarlo fuera no lo omitía: DESPLAZABA todo lo de
           * detrás, porque las posiciones de `format` cuentan argumentos, no comillas. La
           * lista se cortaba además en el primer número, así que el reloj ni siquiera
           * llegaba. Un número se sustituye por su propio texto, que es lo que hace Postgres.
           *
           * Y lo que no se puede leer —una VARIABLE— tampoco se puede tirar, que era el otro
           * fallo: cortaba la lista ahí y se perdían los argumentos de DETRÁS, que sí eran
           * constantes. `format('select %3$s::date', 0, v, 'now()')` produce
           * `select now()::date` pase lo que pase con `v` —medido— y el reloj estaba en el
           * tercero. Así que un argumento ilegible ocupa su HUECO y aporta la cadena vacía:
           * su contenido sigue sin estar en el texto, pero su posición sí.
           */
          const trozos = [
            ...m[1]!.matchAll(/[A-Za-z_]*&?'((?:[^']|'')*)'|(\d+)|(\w+)/g),
          ].map((l) => (l[1] !== undefined ? l[1].replace(/''/g, "'") : (l[2] ?? '')));
          /*
           * Los DOS pegados, y no uno: ninguno es la verdad para las dos formas. `||` une
           * exactamente —`'select now()' || '::date'` tiene que quedar sin hueco o el casto no
           * se pega—, mientras que `format('select %s', 'now()::date')` mete el trozo donde
           * está el marcador, y pegado a secas queda `%snow()` sin frontera de palabra: el
           * reloj deja de reconocerse. Con hueco pasa lo contrario, se parte `'da' ||
           * 'te_trunc'`. Se miran los dos y basta con que uno sea culpable, que es el lado
           * seguro.
           */
          /*
           * Y una TERCERA lectura, porque `format` no PEGA los trozos: los mete DONDE está el
           * marcador. `execute format('select %s::date', 'now()')` ejecuta `select now()::date`
           * —medido— y las dos concatenaciones daban `select %s::datenow()` y
           * `select %s::date now()`: en ninguna de las dos se reconoce el reloj pegado a su casto,
           * así que la consulta se escapaba entera. Un marcador que PARTE la expresión no se
           * arregla pegando los trozos, ni con hueco ni sin él; hay que sustituirlo.
           *
           * Se reconstruye lo que `format` produce, medido cada caso: `%s` mete el argumento tal
           * cual, `%L` entre comillas simples duplicando las de dentro, `%I` entre dobles, `%%` es
           * un porciento. Es una lectura MÁS, no en vez de: si el envoltorio no era `format`, no
           * hay marcadores que sustituir y la reconstrucción se queda en el primer trozo, que las
           * otras dos ya miraban.
           *
           * Los POSICIONALES se resuelven por su número, que es como los resuelve Postgres
           * —medido: `format('%1$s y %1$s', 'now()')` da `now() y now()`—. La anchura (`%10s`) se
           * reconoce en la sintaxis y se ignora al rellenar: los espacios de más no cambian que el
           * reloj esté ahí.
           *
           * LÍMITE DECLARADO: un argumento que NO esté en el texto —una variable— deja su marcador
           * sin nada que poner, igual que en las otras dos lecturas la cadena se corta ahí.
           *
           * Y una honestidad sobre el `%%`: la rama existe porque sin ella `'%%s'` se leería como
           * marcador y metería el argumento donde Postgres no mete nada (medido: `format('%%s',
           * 'now()::date')` da `select %s`). Pero NINGUNA sonda la sostiene, y no por falta de
           * ganas: el pegado con hueco ya marca ese caso —`select %%s now()::date`— y marcar de
           * más ahí es la postura declarada de las dos lecturas de arriba. La rama se queda para
           * que la reconstrucción diga la verdad, no para que aporte una marca.
           */
          const comoFormat = (partes: string[]): string => {
            let siguiente = 1;
            return partes[0]!.replace(
              /%(?:(\d+)\$)?[-+ 0]*(\d+|\*(?:\d+\$)?)?([sIL%])/g,
              (
                _todo,
                posicion: string | undefined,
                ancho: string | undefined,
                tipo: string,
              ) => {
                if (tipo === '%') return '%';
                /*
                 * El ancho puede venir de OTRO ARGUMENTO —`%*s` lo toma del siguiente,
                 * `%*n$s` del n-ésimo—, y eso no es cosmética: el `*` a secas SE COME un
                 * argumento del contador secuencial, así que sin contarlo todo lo que viene
                 * detrás se lee corrido. Medido: `format('[%*s][%s]', 4, 'a', 'b')` da
                 * `[   a][b]`, o sea que el 4 fue el ancho y la `a` el valor.
                 *
                 * El relleno NO se aplica, y es deliberado: son espacios, y un espacio no
                 * separa un valor de su cast —medido, `select now()     ::date` devuelve la
                 * fecha—. Lo que hay que reconstruir bien es QUÉ argumento va en cada hueco.
                 */
                if (ancho === '*') siguiente++;
                const arg = partes[posicion === undefined ? siguiente++ : Number(posicion)];
                if (arg === undefined) return '';
                if (tipo === 'L') return `'${arg.replace(/'/g, "''")}'`;
                if (tipo === 'I') return `"${arg.replace(/"/g, '""')}"`;
                return arg;
              },
            );
          };
          return (
            culpable(trozos.join(''), 'sql') ||
            culpable(trozos.join(' '), 'sql') ||
            culpable(comoFormat(trozos), 'sql')
          );
        })(),
      )
    );
  };

  /**
   * Las excepciones se declaran AQUÍ, con su motivo, o no existen. Vacío es el estado
   * correcto: si algo entra, tiene que entrar con una razón escrita al lado.
   */
  const DECLARADAS: Record<string, string> = {};

  /**
   * Quita los comentarios antes de buscar: un `current_date` dentro de un comentario que
   * EXPLICA por qué ya no se usa es exactamente lo contrario de un hallazgo, y sin esto el
   * censo se volvería contra quien documenta el arreglo.
   *
   * Va como RECORRIDO y no como expresión regular, y esta vez la diferencia no es de estilo:
   * con `replace(/--[^\n]*!/g, '')` un cuerpo legítimo como `select '--', now()::date` se
   * queda en `select '` —el resto se va como si fuera comentario— y el censo pasa en verde
   * sin haber mirado la expresión. Lo mismo en TypeScript con una URL: `'https://host'` hace
   * que el barrido de `//` se lleve el resto de la línea. Es la peor forma de fallar de un
   * guardián: no encontrar nada porque no está mirando.
   *
   * Dos decisiones que no son obvias y conviene dejar dichas:
   *
   *  · las comillas invertidas de TypeScript se ATRAVIESAN y su contenido se lee como SQL,
   *    porque ahí es justo donde vive el SQL que este censo busca. Las comillas simples y
   *    dobles sí son datos y se saltan;
   *  · el entrecomillado por dólar de SQL —`$function$ … $function$`— también se atraviesa,
   *    porque `pg_get_functiondef` devuelve así los cuerpos plpgsql. Saltárselo dejaría de
   *    mirar el cuerpo de cada función plpgsql, que es exactamente el error que este arreglo
   *    viene a evitar. El precio es que un literal por dólar que contuviera `--` se leería
   *    como comentario; queda dicho, y no existe ninguno en el esquema.
   */
  /** Lo que puede ir DELANTE de una barra que abre una expresión regular. */
  /*
   * ── La mitad de TypeScript la hace el PARSER de TypeScript ──
   *
   * Aquí había un reconocedor escrito a mano que decidía si una barra abría una expresión
   * regular o dividía, mirando el carácter anterior y una lista de palabras. La revisión le
   * encontró CINCO agujeros seguidos —`throw` y `export default`, el paréntesis de un `if`, el
   * `}` de un bloque, el `for await`, y el `}` de un objeto con `valueOf`— y el quinto refutó
   * una afirmación que yo mismo había escrito aquí: dije que dividir un objeto no significa
   * nada en JavaScript, y `{ valueOf() { return 1; } } / 2` es una división perfectamente
   * válida. Cinco parches al mismo sitio no son cinco descuidos: son la señal de que el
   * criterio no cabe en una heurística.
   *
   * Y no cabe por un motivo conocido: «regex o división» no se decide con el token anterior,
   * se decide con la GRAMÁTICA. Así que la decide quien la tiene. Se parsea el fichero con
   * `typescript` —que ya es dependencia de desarrollo y que el otro censo de este repositorio
   * usa igual—, y del árbol salen los tramos exactos de cada literal: expresión regular,
   * cadena, y cada trozo de plantilla.
   *
   * Con esos tramos, lo demás es aritmética: fuera de un literal, `//` y `/*` SIEMPRE abren
   * comentario —eso sí es cierto sin contexto— y dentro de un literal nunca. El barrido pasa
   * de adivinar a saber.
   *
   * Lo que NO cambia es el contrato: la salida sigue siendo el mismo texto con los comentarios
   * fuera, las expresiones regulares fuera, las cadenas vaciadas si se pide, y el contenido de
   * cada plantilla pasado por el barrido de SQL —que es donde vive el SQL que este censo
   * busca—. Las sondas de este fichero son las que lo comprueban: siguen siendo las mismas y
   * siguen en verde.
   *
   * Se parsea como TSX porque el barrido cubre `.ts` y `.tsx` y no sabe cuál está mirando.
   * LÍMITE DECLARADO: en TSX, `<T>expr` es JSX y no un cast, y una función flecha genérica
   * pide `<T,>`. Comprobado que este repositorio no usa ninguna de las dos formas; si algún
   * día las usa, ese fichero se parsea con errores y sus literales dejan de reconocerse — y el
   * fallo cae del lado seguro, que es MIRAR de más y no de menos.
   */
  const barridoTs = (texto: string, vaciarLiterales: boolean): string => {
    const arbol = ts.createSourceFile(
      'censo.tsx',
      texto,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const piezas: { inicio: number; fin: number; texto: string }[] = [];
    const recorrer = (n: ts.Node): void => {
      const inicio = n.getStart(arbol);
      const fin = n.getEnd();
      const crudo = texto.slice(inicio, fin);
      if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        piezas.push({ inicio, fin, texto: ' ' });
        return;
      }
      if (n.kind === ts.SyntaxKind.StringLiteral) {
        const comilla = crudo[0] ?? "'";
        // Cocinado también aquí, por lo mismo, y con la comilla vuelta a escapar para que el
        // literal siga teniendo los bordes donde los tenía.
        const dentro = (n as ts.LiteralLikeNode).text.split(comilla).join(`\\${comilla}`);
        piezas.push({
          inicio,
          fin,
          texto:
            vaciarLiterales && !ESPECIAL_TEMPORAL.test(dentro) ? `${comilla}${comilla}` : crudo,
        });
        return;
      }
      if (
        n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
        n.kind === ts.SyntaxKind.TemplateHead ||
        n.kind === ts.SyntaxKind.TemplateMiddle ||
        n.kind === ts.SyntaxKind.TemplateTail
      ) {
        // El trozo abre con un backtick o con el `}` que cierra una interpolación, y cierra
        // con un backtick o con el `${` que abre la siguiente. Los delimitadores se conservan
        // para no mover nada de sitio; lo de dentro es SQL y va por el barrido de SQL.
        const cierra = crudo.endsWith('${') ? 2 : 1;
        /*
         * Y lo de dentro se lee COCINADO, que es lo que la etiqueta recibe de verdad. Una
         * plantilla `select \x6eow()::date` entrega `select now()::date` —comprobado con
         * node—, y leer la ortografía en vez del valor es dejar de mirar por cómo está
         * escrito algo. `n.text` es justo eso: el parser ya deshizo los escapes.
         *
         * La salida se construye concatenando, no por posiciones, así que la longitud puede
         * cambiar sin descolocar nada.
         */
        const dentro = (n as ts.LiteralLikeNode).text;
        piezas.push({
          inicio,
          fin,
          texto:
            crudo.slice(0, 1) +
            sinComentarios(dentro, 'sql', vaciarLiterales, false) +
            crudo.slice(crudo.length - cierra),
        });
        return;
      }
      n.forEachChild(recorrer);
    };
    recorrer(arbol);
    piezas.sort((a, b) => a.inicio - b.inicio);

    let salida = '';
    let i = 0;
    let p = 0;
    while (i < texto.length) {
      while (p < piezas.length && piezas[p]!.inicio < i) p++;
      if (p < piezas.length && piezas[p]!.inicio === i) {
        salida += piezas[p]!.texto;
        i = piezas[p]!.fin;
        p++;
        continue;
      }
      if (texto[i] === '/' && texto[i + 1] === '/') {
        const salto = texto.indexOf('\n', i);
        salida += ' ';
        i = salto === -1 ? texto.length : salto;
        continue;
      }
      if (texto[i] === '/' && texto[i + 1] === '*') {
        const cierre = texto.indexOf('*/', i + 2);
        salida += ' ';
        i = cierre === -1 ? texto.length : cierre + 2;
        continue;
      }
      salida += texto[i];
      i++;
    }
    return salida;
  };

  const sinComentarios = (
    texto: string,
    dialecto: 'sql' | 'ts' = 'sql',
    vaciarLiterales = false,
    /*
     * Si el texto es un CUERPO del catálogo —lo que devuelve `pg_get_functiondef`— o un trozo
     * de plantilla de TypeScript. Lo único que cambia es qué significa el primer `$tag$`, y
     * cambia del todo: en un cuerpo es el delimitador que lo envuelve y lo de dentro es CÓDIGO;
     * en una plantilla no hay nada que envolver, así que el primer par es un LITERAL y lo de
     * dentro es dato.
     *
     * Lo rompí yo al borrar el reconocedor a mano: la distinción vivía en la pila —el `$` solo
     * se leía como cuerpo en el marco raíz— y se fue con ella sin que ninguna sonda lo notara.
     * Ahora va en un parámetro, que es donde se ve y donde se puede leer sin reconstruir una
     * máquina de estados en la cabeza.
     */
    cuerpoDelCatalogo = true,
  ): string => {
    if (dialecto === 'ts') return barridoTs(texto, vaciarLiterales);
    let salida = '';
    let i = 0;
    /** La etiqueta del cuerpo por dólar que está abierto, o `null` si no hay ninguno. */
    let cuerpoPorDolar: string | null = null;
    const DOLAR = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;
    while (i < texto.length) {
      const c = texto[i]!;
      const d = texto[i + 1];
      // Comentario de bloque.
      if (c === '/' && d === '*') {
        /*
         * PostgreSQL ANIDA los comentarios de bloque: un bloque abierto dentro de otro exige
         * DOS cierres, y comprobado que un `select` con uno dentro de otro devuelve su valor
         * sin quejarse. Con `indexOf` del primer cierre, el recorrido salía en el INTERIOR. Lo
         * que
         * viene después sigue comentado, así que un `--` de ahí se tomaba por comentario de
         * línea y se llevaba por delante el código real que hubiera detrás: el censo volvía a
         * dejar de mirar. Se cuenta la profundidad.
         *
         * (El ejemplo no se escribe aquí dentro a propósito: un cierre de bloque dentro de un
         * comentario de bloque lo termina, y me costó un fichero sin compilar. La sonda lo
         * lleva, que es donde tiene que estar.)
         *
         */
        let hondura = 1;
        i += 2;
        while (i < texto.length && hondura > 0) {
          // SQL anida y TypeScript no, y esa diferencia estuvo escrita al revés aquí durante
          // un rato —yo mismo puse que contar profundidad «tampoco estorba» en TypeScript, y
          // estorba—. Hoy no hay que elegir: este recorrido solo ve SQL, y el de TypeScript lo
          // hace su parser.
          if (texto[i] === '/' && texto[i + 1] === '*') {
            hondura++;
            i += 2;
          } else if (texto[i] === '*' && texto[i + 1] === '/') {
            hondura--;
            i += 2;
          } else i++;
        }
        salida += ' ';
        continue;
      }
      // Comentario de línea: `--` en SQL, `//` en TypeScript.
      if (c === '-' && d === '-') {
        /*
         * Un comentario no sale de su PLANTILLA, y eso ya no hay que vigilarlo aquí: cada
         * trozo de plantilla llega a este recorrido por separado, recortado por el parser, así
         * que un `--` nunca puede comerse nada de fuera. Antes sí podía, y bastaba una
         * plantilla ajena —`const ayuda = \`--x\`;`— para cegar el censo entero.
         *
         * LÍMITE DECLARADO, ése sigue en pie: toda plantilla de TypeScript se lee como SQL
         * —ahí es donde vive el SQL que este censo busca, y reconocerlas por su etiqueta sería
         * una lista escrita a mano que dejaría fuera el SQL sin etiquetar—, así que una
         * plantilla ajena que mencione una palabra del reloj en PROSA sale marcada. Es un
         * falso positivo, o sea visible, y hoy no hay ninguno.
         */
        const salto = texto.indexOf('\n', i);
        /*
         * El cierre del marco es el primer backtick NO escapado: `indexOf` devolvía también
         * los escapados, que no cierran nada. Con uno dentro del comentario, el recorrido
         * salía de la plantilla a mitad, y lo que todavía era comentario —una comilla, otro
         * `--`— pasaba a leerse como código y se llevaba por delante lo de después.
         */
        i = salto === -1 ? texto.length : salto;
        salida += ' ';
        continue;
      }
      /*
       * Un identificador entre comillas dobles es SQL válido y puede contener CUALQUIER cosa:
       * `declare "--" int;` en una función de una línea hacía que el barrido tomara esos
       * guiones por un comentario y se comiera la operación de después. Se consume entero,
       * con su escape por duplicación.
       *
       * Y se copia TAL CUAL incluso al vaciar literales, a diferencia de un dato: los nombres
       * SÍ los leen los patrones —`pg_catalog."now"()` es un reloj—, así que vaciarlos abriría
       * el hueco que el reconocimiento del nombre entrecomillado vino a cerrar.
       *
       * LÍMITE DECLARADO: un identificador que se llame exactamente como una palabra del reloj
       * —`select 1 as "current_date"`— saldrá marcado. Es un falso positivo, o sea visible.
       */
      if (c === '"') {
        const desde = i;
        i++;
        while (i < texto.length) {
          if (texto[i] === '"' && texto[i + 1] === '"') i += 2;
          else if (texto[i] === '"') {
            i++;
            break;
          } else i++;
        }
        salida += texto.slice(desde, i);
        continue;
      }
      // Literal de comillas simples: dato en los dos dialectos. En SQL se escapa
      // duplicándolo; en TypeScript, con barra invertida.
      if (c === "'") {
        const desde = i;
        /*
         * La cadena con prefijo `E` de SQL escapa con BARRA y no duplicando la comilla, y
         * `pg_get_functiondef` la conserva tal cual. Sin esto, `E'a\\'--b'` terminaba el
         * literal en la barra y el `--` —que todavía es DATO— abría un comentario que se
         * llevaba por delante la operación de después: el censo en verde sin haber mirado.
         *
         * Es el mismo arreglo que acaba de entrar en el censo de proyecciones, allí en la
         * dirección contraria. Las demás formas con prefijo —`U&'…'`, `B'…'`, `X'…'`— escapan
         * duplicando como la normal.
         */
        const prefijoE =
          c === "'" &&
          (texto[i - 1] === 'E' || texto[i - 1] === 'e') &&
          !/[A-Za-z0-9_]/.test(texto[i - 2] ?? ' ');
        i++;
        while (i < texto.length) {
          if (prefijoE && texto[i] === '\\') i += 2;
          else if (texto[i] === c && texto[i + 1] === c) i += 2;
          else if (texto[i] === c) {
            i++;
            break;
          } else i++;
        }
        /*
         * El literal se copia TAL CUAL, no se borra. Borrarlo parecía inofensivo —es un dato,
         * no código— y rompió tres patrones a la vez: los que LEEN el literal,
         * `date_trunc('day', …)`, `date_part('dow', …)` y `to_char(…, 'YYYY-MM-DD')`. Con el
         * contenido fuera, `date_trunc('milliseconds', now())` —seguro— pasaba a marcarse.
         * Lo cazó su propia sonda segura, que para eso está. Aquí el recorrido solo sirve para
         * NO confundir un `--` de dentro de un literal con un comentario.
         */
        /*
         * Con `vaciarLiterales`, el CONTENIDO se va y quedan solo las comillas. Las dos formas
         * hacen falta y por eso conviven: los patrones que LEEN el literal —`date_trunc` y
         * `date_part`— necesitan el texto tal cual; los demás no, y con él dentro una función
         * que devuelva la cadena 'current_date' salía marcada sin leer ningún reloj.
         */
        /*
         * Con UNA excepción, y es la que impedía que el censo entero se rodeara con dos
         * comillas: `'now'`, `'today'`, `'tomorrow'` y `'yesterday'` no son datos —Postgres las
         * EVALÚA— y vaciarlas dejaba `'today'::date` indistinguible de `''::date`. O sea que
         * `current_date` estaba prohibido y su sinónimo exacto pasaba limpio: el mismo día
         * distinto en husos opuestos (2026-09-05 contra 2026-09-04, medido), escrito de otra
         * manera. Se conserva SOLO ese contenido, así que la función que devuelve la cadena
         * `'current_date'` —el falso positivo que motivó el vaciado— se sigue vaciando.
         */
        salida +=
          vaciarLiterales && !ESPECIAL_TEMPORAL.test(texto.slice(desde + 1, i - 1))
            ? `${c}${c}`
            : texto.slice(desde, i);
        continue;
      }
      /*
       * El entrecomillado por DÓLAR: el delimitador del CUERPO se atraviesa, y cualquier otro
       * es un literal.
       *
       * `pg_get_functiondef` envuelve el cuerpo plpgsql en `$function$ … $function$` y hay que
       * ATRAVESARLO, o el censo dejaría de mirar el cuerpo de cada función. Pero dentro del
       * cuerpo puede haber literales por dólar de verdad —`perform $q$--$q$; perform
       * now()::date;`— y leerlos como código hacía que su `--` se comiera la consulta de
       * después. El catálogo los conserva verbatim: comprobado sobre una función real.
       *
       * La regla es la anidación: la primera etiqueta abre el cuerpo; una etiqueta DISTINTA
       * estando dentro es un literal; la MISMA lo cierra.
       *
       * LÍMITE DECLARADO: un cuerpo anidado escrito con otra etiqueta —una función que crea
       * otra— se leería como literal, así que sus comentarios no se quitarían. Eso da falsos
       * positivos, que se ven, no huecos.
       *
       * Y solo aquí, en el recorrido de SQL, que es donde `pg_get_functiondef` pone
       * el cuerpo. Dentro de una plantilla de TypeScript, `$` no es esto: `` `< $${n}` `` —que
       * está en `ai.degradacion.ts`— es un dólar literal seguido de una interpolación, y
       * leerlo como apertura de cuerpo se comía el `${` y dejaba la etiqueta puesta para el
       * resto del fichero. Con una etiqueta sin cerrar más adelante, el vaciado se llevaba
       * por delante la consulta y el censo daba verde. Lo escribí sin este alcance y lo
       * encontré al buscar en `src/` si el idioma existía: existe.
       */
      if (c === '$') {
        const m = DOLAR.exec(texto.slice(i));
        if (m) {
          const etiqueta = m[0];
          if (cuerpoDelCatalogo && cuerpoPorDolar === null) {
            cuerpoPorDolar = etiqueta;
            salida += etiqueta;
            i += etiqueta.length;
            continue;
          }
          if (etiqueta === cuerpoPorDolar) {
            cuerpoPorDolar = null;
            salida += etiqueta;
            i += etiqueta.length;
            continue;
          }
          const cierra = texto.indexOf(etiqueta, i + etiqueta.length);
          /*
           * Y en una plantilla solo cuenta el par BALANCEADO. Un `$x$` sin cierre no es un
           * literal: es SQL a medio escribir —o una plantilla que se corta en una
           * interpolación—, y tragarse el resto sería dejar de mirar por un fallo de sintaxis
           * ajeno, que es la forma en que este barrido ha fallado siempre. Se copia la etiqueta
           * y se sigue leyendo lo de detrás como código.
           *
           * En un cuerpo del catálogo no hace falta la salvedad: ahí el primer par SÍ envuelve,
           * y lo que no cierra ya lo cubre la rama de arriba.
           */
          if (!cuerpoDelCatalogo && cierra === -1) {
            salida += etiqueta;
            i += etiqueta.length;
            continue;
          }
          const hasta = cierra === -1 ? texto.length : cierra + etiqueta.length;
          salida += vaciarLiterales ? `${etiqueta}${etiqueta}` : texto.slice(i, hasta);
          i = hasta;
          continue;
        }
      }
      salida += c;
      i++;
    }
    return salida;
  };

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
    // El reloj que devuelve TEXTO, con su salto de cast intermedio.
    censo_probe_tod: {
      expr: 'timeofday()::timestamptz::date',
      tipo: 'date',
      culpable: true,
    },
    // Las OCHO formas que el reloj desnudo dejaba pasar. Todas medidas: eligen día distinto
    // en husos opuestos. Van con sonda propia porque un patrón sin culpable no está probado,
    // y porque tres de los patrones se fundieron en uno — sin una sonda por FORMA, la fusión
    // habría podido perder una sin que nada enrojeciera.
    censo_probe_cast_interm: {
      expr: 'now()::timestamp::date',
      tipo: 'date',
      culpable: true,
    },
    censo_probe_trunc_tod: {
      expr: "date_trunc('day', timeofday()::timestamptz)",
      tipo: 'timestamptz',
      culpable: true,
    },
    censo_probe_trunc_ts: {
      expr: "date_trunc('day', now()::timestamp)",
      tipo: 'timestamp',
      culpable: true,
    },
    censo_probe_cast_kw_ts: {
      expr: 'cast(now()::timestamp as date)',
      tipo: 'date',
      culpable: true,
    },
    censo_probe_datefn_ts: {
      expr: 'date(now()::timestamp)',
      tipo: 'date',
      culpable: true,
    },
    censo_probe_tochar_ts: {
      expr: "to_char(now()::timestamp, 'YYYY-MM-DD')",
      tipo: 'text',
      culpable: true,
    },
    censo_probe_extract_ts: {
      expr: 'extract(day from (now())::timestamp)::int',
      tipo: 'integer',
      culpable: true,
    },
    // El destino ampliado: un cast a un tipo SIN huso ya es el reloj de pared de quien llama,
    // aunque no llegue a `date`.
    censo_probe_pared: {
      expr: 'now()::timestamp',
      tipo: 'timestamp',
      culpable: true,
    },
    // Y las mismas con PRECISIÓN, que es parte del nombre del tipo. La primera se guarda
    // deparseada como `((now())::timestamp(0) with time zone)::date`, así que la sonda del
    // catálogo ejercita justo la forma que se escapaba.
    censo_probe_prec_interm: {
      expr: 'now()::timestamptz(0)::date',
      tipo: 'date',
      culpable: true,
    },
    censo_probe_prec_pared: {
      expr: 'now()::timestamp(0)',
      tipo: 'timestamp',
      culpable: true,
    },
    // El reloj que ATRAVIESA un `timetz` para quedarse la esfera local. El `timetz` conserva
    // el instante, pero tirar su desfase no: 20:35 en Kiritimati, 18:35 en Etc/GMT+12.
    censo_probe_timetz: {
      expr: '(now()::time with time zone)::time',
      tipo: 'time',
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
    // El cast que CONSERVA el instante no elige calendario: `timestamptz` se queda fuera del
    // destino a propósito. Sin esta sonda, ampliar el destino a `timestamp` podía haberse
    // pasado de largo y llevarse también el que no molesta.
    censo_probe_ok_tz: {
      expr: 'now()::timestamptz',
      tipo: 'timestamptz',
      culpable: false,
    },
    // La ida y vuelta por TEXTO recupera el mismo instante —la representación lleva el
    // desfase— así que marcarla sería un falso positivo sobre una serialización correcta.
    censo_probe_ok_texto_vuelta: {
      expr: 'now()::text::timestamptz',
      tipo: 'timestamptz',
      culpable: false,
    },
    // Con precisión sigue conservando el instante (medido comparando el VALOR): se guarda
    // como `(now())::timestamp(0) with time zone`, y esa forma es la que el guardia del huso
    // marcaba en falso cuando iba detrás de la precisión.
    censo_probe_ok_tz_prec: {
      expr: 'now()::timestamp(0) with time zone',
      tipo: 'timestamptz',
      culpable: false,
    },
    // El reloj AJUSTADO antes de colapsarlo. Medido: 09-06 en Kiritimati, 09-04 en Etc/GMT+12.
    censo_probe_aritmetica: {
      expr: "(now() + interval '1 day')::date",
      tipo: 'date',
      culpable: true,
    },
    // Serializar el reloj elige día igual que `to_char`. Se guarda deparseada como
    // `"substring"((now())::text, 1, 10)`.
    censo_probe_texto: {
      expr: 'substring(now()::text, 1, 10)',
      tipo: 'text',
      culpable: true,
    },
    censo_probe_texto_cast: {
      expr: 'cast(current_timestamp as text)',
      tipo: 'text',
      culpable: true,
    },
    // Un literal con `--` DENTRO: sin recorrer las comillas, todo lo que sigue se iba como
    // comentario y el censo no llegaba a mirar el `::date`. Esta sonda solo sale marcada si
    // el barrido de comentarios respeta el literal.
    censo_probe_guion_en_literal: {
      expr: "('--' || (now())::date::text)",
      tipo: 'text',
      culpable: true,
    },
    // El ajuste con una LLAMADA y con una multiplicación: el operando de la aritmética no es
    // solo un literal de intervalo. Medidas las dos.
    censo_probe_make_interval: {
      expr: '(now() + make_interval(days => 1))::date',
      tipo: 'date',
      culpable: true,
    },
    censo_probe_interval_mult: {
      expr: "(now() + interval '1 day' * 2)::date",
      tipo: 'date',
      culpable: true,
    },
    // El nombre SQL completo del tipo textual, que es como Postgres deparsea `varchar`.
    censo_probe_character_varying: {
      expr: 'cast(now() as character varying)',
      tipo: 'text',
      culpable: true,
    },
    // La comparación MIXTA: el reloj es absoluto, pero el `date` del otro lado se promociona
    // con la medianoche LOCAL. Medido: false en UTC+14 y true en UTC-12. Se guarda deparseada
    // como `(CURRENT_TIMESTAMP < '2026-09-04'::date)`, que es la forma que hay que cazar.
    censo_probe_mixta: {
      expr: "current_timestamp < date '2026-09-04'",
      tipo: 'boolean',
      culpable: true,
    },
    // Y en el otro orden, porque el reloj puede ir a cualquier lado del comparador.
    censo_probe_mixta_der: {
      expr: "date '2026-09-04' > now()",
      tipo: 'boolean',
      culpable: true,
    },
    // Comparar dos instantes absolutos no elige nada: el otro operando LLEVA huso.
    censo_probe_ok_mixta: {
      expr: "now() < timestamptz '2026-09-04 00:00:00+00'",
      tipo: 'boolean',
      culpable: false,
    },
    // `current_timestamp` desnudo es un instante absoluto —la cabecera de este fichero lo dice
    // desde el principio— y el censo lo marcaba igual. Con la lista derivada del tipo, ya no.
    censo_probe_ok_ct: {
      expr: 'current_timestamp',
      tipo: 'timestamptz',
      culpable: false,
    },
    // Y `timetz` desnudo, que conserva el instante (medido por igualdad, no por impresión).
    censo_probe_ok_timetz: {
      expr: 'now()::time with time zone',
      tipo: 'timetz',
      culpable: false,
    },
    // Un identificador que TERMINA en la palabra clave no es una lectura del reloj, y solo la
    // frontera IZQUIERDA lo distingue: `current_date_pactada` lo para la derecha, así que no
    // sirve para probar la otra mitad. `mi_current_date` sí, y sobrevive al deparseo como
    // alias de la subconsulta (comprobado). Sin la frontera izquierda, sale marcado.
    censo_probe_ok_prefijo: {
      expr: "(select q.mi_current_date from (select date '2026-01-01' as mi_current_date) q)",
      tipo: 'date',
      culpable: false,
    },
    // La edad contra HOY, que es el reloj que no se escribe: lo pone `age` con un solo
    // argumento. Medido: 10:00:00 en Kiritimati y 12:00:00 en Etc/GMT+12 sobre el mismo
    // instante.
    censo_probe_edad: { expr: "age(timestamptz '2020-01-01 00:00:00+00')", tipo: 'interval', culpable: true },
    // Y con los DOS instantes dados no hay calendario que leer: medido idéntico en los dos.
    censo_probe_ok_edad_dos: {
      expr: "age(now(), timestamptz '2020-01-01 00:00:00+00')",
      tipo: 'interval',
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
      // El huso dinámico ENVUELTO: el paréntesis de más impedía consumir el argumento y el
      // patrón no casaba. Medido: 2026-09-05 en Kiritimati y 2026-09-04 en Etc/GMT+12.
      "timezone((current_setting('TimeZone')), now())::date",
      // Y el SQL de un EXECUTE compuesto por concatenación, en sus dos cortes, y por `format`,
      // que es la forma idiomática de componerlo en plpgsql.
      "execute 'select now()' || '::date'",
      "execute 'select ' || 'now()::date'",
      "execute format('select %s', 'now()::date')",
      // Y el marcador PARTIENDO la expresión, que es donde pegar los trozos ya no alcanza:
      // Postgres ejecuta `select now()::date` (medido) y las dos concatenaciones daban
      // `select %s::datenow()` y `select %s::date now()`, ninguna culpable.
      "execute format('select %s::date', 'now()')",
      // Con marcador POSICIONAL y con anchura, que es la misma sustitución escrita distinto. El
      // posicional se elige SALTEADO a propósito: con `%1$s` el orden natural acierta por
      // casualidad y la sonda no probaría nada. Medido: `format('select %2$s::date', 'columna',
      // 'now()')` da `select now()::date`.
      "execute format('select %2$s::date', 'columna', 'now()')",
      "execute format('select %10s::date', 'now()')",
      // Y el ancho tomado de OTRO argumento, que es la parte de la gramática de `format` que
      // faltaba. Medido: `format('select %2$*1$s::date', 0, 'now()')` da exactamente
      // `select now()::date`. Va con posición SALTEADA y con ancho posicional a la vez,
      // porque es la forma en que reconstruir mal el marcador desalinea todo lo de detrás.
      "execute format('select %2$*1$s::date', 0, 'now()')",
      // Y el ancho por `*` a secas, que se COME un argumento del contador secuencial: sin
      // contarlo, el valor que se sustituye es el ancho y el reloj se queda fuera.
      "execute format('select %*s::date', 4, 'now()')",
      // Y con un argumento ILEGIBLE en medio, que ocupa hueco pero no se lee: el reloj está
      // en el tercero y el posicional tiene que llegar hasta él. Medido: `select now()::date`.
      "execute format('select %3$s::date', 0, v_cualquiera, 'now()')",
      // Serializar un ARRAY a texto plano: `array_to_string` aplica la función de salida a
      // cada elemento. Medido: `2026-09-05 …+14` contra `2026-09-04 …-12`, con fecha distinta
      // dentro del texto. Era el único serializador de array sin `json` en el nombre.
      "array_to_string(array[now()], ',')",
      // La coerción IMPLÍCITA a texto, que renderiza igual sin nombrar ningún formato. Las
      // cuatro medidas: cadena distinta en husos opuestos.
      'concat(now())',
      'quote_literal(now())',
      "now() || ''",
      "'fecha: ' || now()",
      // El NOMBRE de la función, entrecomillado. Las siete son llamadas válidas (medidas) y
      // ninguna casaba: el patrón exigía el paréntesis pegado al nombre desnudo.
      'pg_catalog."to_json"(now())',
      '"date_trunc"(\'day\', now())',
      '"to_char"(now(), \'YYYY-MM-DD\')',
      '"date_part"(\'dow\', now())',
      '"date"(now())',
      '"age"(vence_en)',
      '"timezone"(current_setting(\'TimeZone\'), now())::date',
      // La serialización a JSON, que es la misma elección de calendario que `::text` escrita
      // con otra función. Las cuatro medidas: cadena distinta en husos opuestos.
      'to_json(now())',
      'to_jsonb(now())',
      "jsonb_build_object('cuando', now())",
      'json_agg(now())',
      // Y el reloj ANIDADO dentro del valor que se serializa, que es como se usa `row_to_json`
      // de verdad. Las dos medidas: cadena distinta en husos opuestos.
      'row_to_json(row(now()))',
      "jsonb_build_object('d', coalesce(now(), now()))",
      // Ésta es peligrosa y está bien que esté, pero NO prueba el patrón de JSON: la marca el
      // de `timezone(...)`, que ve el huso dinámico sin mirar el envoltorio. Se deja dicho para
      // que nadie la lea como cobertura de lo que no cubre.
      "jsonb_build_object('d', timezone(current_setting('TimeZone'), now()))",
      // La edad contra HOY, sin ningún reloj escrito: la forma de un solo argumento basta.
      'age(vence_en)',
      "select age(t.creado_en) > interval '30 days' from t",
      'pg_catalog.age(vence_en)',
      // El nombre del tipo ENTRECOMILLADO, y el del esquema. Las tres medidas: 2026-09-05 en
      // Kiritimati y 2026-09-04 en Etc/GMT+12, igual que sin comillas. El catálogo tampoco
      // produce esta forma —deparsea el nombre desnudo—, así que solo el reconocedor la cubre.
      'now()::"date"',
      'now()::pg_catalog."date"',
      'now()::"pg_catalog".date',
      'now()::"timestamp"',
      'now()::"text"',
      // Y la ida y vuelta cuya SALIDA vuelve a elegir día, escrita con `cast … as`: la vuelta
      // con huso solo salva si es TERMINAL, y aquí no lo es. Medido: 2026-09-05 y 2026-09-04.
      'cast(now()::text::timestamptz as date)',
      'cast(now()::text::"timestamptz" as "date")',
      // Y la cadena LARGA, que era el límite declarado de esa misma guardia: volver a texto y
      // de ahí a fecha. El paso intermedio no es «un tipo sin huso» y la vuelta pasaba por
      // terminal. Medido: 2026-09-05 y 2026-09-04, las dos.
      'now()::text::timestamptz::text::date',
      'left(now()::text::timestamptz::text, 10)',
      'cast(cast(now()::text as timestamptz) as text)',
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
      // El `as` del cast solo salva si el destino LLEVA huso: a un tipo sin huso sigue
      // eligiendo calendario.
      "cast(now()::text as date)",
      // Y un ALIAS no es un cast, aunque se llame como el tipo: sin `)` de cierre no hay
      // vuelta que valga. Con sufijo, la frontera de palabra lo separa igual.
      'select now()::text as timestamptz',
      'select now()::text as timestamptz_pactado',
      // El nombre del reloj ENTRE COMILLAS: `pg_catalog."now"()` es la misma función y el día
      // cambia igual (medido: 2026-09-05 en Kiritimati y 2026-09-03 en Etc/GMT+12).
      'pg_catalog."now"()::date',
      // La unidad puede llegar CASTEADA con la sintaxis larga, o no ser un literal siquiera.
      "date_trunc(CAST('day' AS text), now())",
      'date_trunc(v_unidad, now())',
      "date_part(CAST('dow' AS text), now())",
      'date_part(v_campo, now())',
      // Y el campo de `extract` también admite literal: `extract('dow' from now())` es SQL
      // válido —comprobado contra la base— y la palabra desnuda no lo casaba.
      "extract('dow' from now())",
      // El TERCER argumento que lee la sesión: la sobrecarga de tres se escapaba entera.
      "date_trunc('day', now(), current_setting('TimeZone'))",
      // Y el campo con PREFIJO, que es otra forma válida de escribir el mismo literal.
      "extract(E'dow' from now())",
      // El prefijo no vuelve segura una unidad peligrosa, ni un contenido escapado la iguala.
      "date_trunc(E'day', now())",
      "(now() + interval '1 day' * (2)::pg_catalog.float8)::date",
      "(now() + '1 day'::pg_catalog.interval)::date",
      "current_timestamp < '2026-09-05'::pg_catalog.date",
      'now()::pg_catalog.date',
      // El RELOJ escrito entre comillas, que es `current_date` con otra ortografía. Medidas
      // todas en husos opuestos: 2026-09-05 en Pacific/Kiritimati contra 2026-09-04 en
      // Etc/GMT+12 las que colapsan a día, y la hora de pared de cada uno las de `timestamp`.
      "'now'::date",
      "'now'::timestamp",
      "date 'now'",
      "cast('now' as date)",
      "'now'::pg_catalog.date",
      // Sin distinguir mayúsculas, con espacios de sobra y con prefijo: las tres son la misma
      // lectura para Postgres (medido).
      "'NOW'::date",
      "' now '::date",
      "E'now'::date",
      // Y `'now'` CON huso es el instante, o sea un reloj: no es hallazgo solo, pero todo lo
      // que este censo prohíbe hacerle a `now()` vale igual escrito así.
      "'now'::timestamptz::date",
      "date_trunc('day', 'now'::timestamptz)",
      "to_char(timestamptz 'now', 'YYYY-MM-DD')",
      "concat('now'::timestamptz)",
      // Y las tres hermanas, que ni con huso conservan el instante (medido por epoch:
      // 1788516000 contra 1788523200).
      "'today'::date",
      "'today'::timestamptz",
      "timestamptz 'today'",
      "'tomorrow'::date",
      "cast('yesterday' as date)",
      // La ida y vuelta que NO termina ahí: recupera el instante y vuelve a elegir día.
      // En su forma fuente y en la que devuelve el catálogo.
      'now()::text::timestamptz::date',
      // Y la ida y vuelta USADA COMO OPERANDO de otra cosa: el instante es el mismo, pero
      // quien elige calendario es la operación de fuera. Medidas las tres en husos opuestos:
      // `2026-09-05 00:00:00+14` contra `2026-09-04 00:00:00-12`, `2026-09-05` contra
      // `2026-09-04`, y el renderizado con su desfase.
      "date_trunc('day', now()::text::timestamptz)",
      "to_char(now()::text::timestamptz, 'YYYY-MM-DD')",
      'concat(now()::text::timestamptz)',
      // Y el reloj dentro de un CONSTRUCTOR de array: `to_json` serializa recursivamente, así
      // que el instante sale con el desfase de quien llama (medido:
      // `["2026-09-05T…+14:00"]` contra `["2026-09-04T…-12:00"]`).
      'to_json(array[now()])',
      'to_jsonb(array[now()])',
      // El huso DINÁMICO en las dos sintaxis: vuelve a decidir quien llama.
      "timezone(current_setting('TimeZone'), now())::date",
      "(now() at time zone current_setting('TimeZone'))::date",
      // Y el SQL dentro de un EXECUTE, que el vaciado de literales se llevaba.
      "execute 'select now()::date'",
      "execute format('select now()::date')",
      '(((now())::text)::timestamp with time zone)::date',
      "to_char(now(), E'YYYY'::text)",
      // El formato de `to_char` que SÍ lee el calendario, y `SSSS` —segundos desde
      // medianoche— que sin la guardia de frontera se leería como dos `SS` seguros.
      "to_char(now(), 'SSSS')",
      "to_char(now(), 'US HH24')",
      'statement_timestamp()::date',
      '(statement_timestamp())::date',
      'transaction_timestamp()::date',
      'current_timestamp(0)::date',
      '(CURRENT_TIMESTAMP(0))::date',
      'localtimestamp(3)',
      'extract(day from now())',
      'EXTRACT(day FROM now())',
      // `minute` NO es seguro para `extract`: con un desfase de 45 minutos (`Asia/Kathmandu`)
      // da 20 donde UTC da 35. Sí lo es para `date_trunc`, que conserva el instante — y esa
      // asimetría es la razón de que las dos listas se midan por separado.
      'extract(minute from now())',
      "date_part('minute', now())",
      'extract(month from clock_timestamp())',
      "date_part('dow', now())",
      "date_part('dow'::text, now())",
      'timeofday()::timestamptz::date',
      '((timeofday())::timestamp with time zone)::date',
      // El reloj con cast por el camino, en las ocho formas que el reloj desnudo dejaba
      // pasar. Medidas: las ocho eligen día distinto en husos opuestos.
      'now()::timestamp::date',
      'now()::timestamp without time zone::date',
      "date_trunc('day', timeofday()::timestamptz)",
      "date_trunc('day'::text, (timeofday())::timestamp with time zone)",
      "date_trunc('day', now()::timestamp)",
      'cast(now()::timestamp as date)',
      'date(now()::timestamp)',
      "to_char(now()::timestamp, 'YYYY-MM-DD')",
      'extract(day from (now())::timestamp)',
      "date_part('day', now()::timestamp)",
      // Y el destino ampliado: un tipo SIN huso ya es el reloj de pared, no haga falta llegar
      // a `date`. `now()::timestamp` da día 4 en Kiritimati y día 3 en Etc/GMT+12 (medido).
      'now()::timestamp',
      '(now())::timestamp without time zone',
      'localtimestamp::date',
      // Con precisión: el nombre del tipo la incluye, y sin ella la cadena de castos se
      // paraba ante el `(0)` sin llegar nunca al `::date`. La segunda es la forma en que
      // Postgres guarda la primera.
      'now()::timestamptz(0)::date',
      '((now())::timestamp(0) with time zone)::date',
      'now()::timestamp(0)::date',
      'now()::timestamp(0)',
      'cast(now()::timestamptz(3) as date)',
      'current_timestamp(0)::timestamp(0)',
      // El reloj que atraviesa un `timetz` y se queda la esfera local.
      '(now()::time with time zone)::time',
      'now()::timetz::time',
      '(now()::timetz)::time',
      'extract(hour from now()::time with time zone)',
      'current_time::time',
      // La comparación mixta: el reloj es absoluto y el otro operando se promociona con la
      // medianoche LOCAL. Medido: false en UTC+14 y true en UTC-12.
      "current_timestamp < date '2026-09-04'",
      "CURRENT_TIMESTAMP < '2026-09-04'::date",
      "now() < '2026-09-04'::date",
      "now() >= timestamp '2026-09-04 00:00:00'",
      "date '2026-09-04' > now()",
      "'2026-09-04'::date > current_timestamp",
      "now() between date '2026-09-01' and date '2026-09-30'",
      'vence_en::date = current_timestamp',
      // `BETWEEN` es ternario: el límite peligroso puede ser el de ARRIBA, y el `not` va en
      // medio. Medido: el primero da false en UTC+14 y true en UTC-12.
      "now() between timestamptz '2020-01-01 00:00+00' and date '2026-09-04'",
      "now() not between timestamptz '2020-01-01 00:00+00' and '2026-09-04'::date",
      // La aritmética con llamada y con multiplicación, y con el multiplicador entre
      // paréntesis, que es la forma FUENTE que el deparseo no enseña.
      '(now() + make_interval(days => 1))::date',
      "(now() + interval '1 day' * 2)::date",
      "(now() + interval '1 day' * (2))::date",
      // Y los nombres completos del tipo textual.
      'cast(now() as character varying)',
      'now()::character varying',
      'now()::character(10)',
      // El texto que NO vuelve a un tipo con huso sigue eligiendo día.
      'now()::text::date',
      // La aritmética antes del colapso.
      "(now() + interval '1 day')::date",
      "((now() + '1 day'::interval))::date",
      "(current_timestamp - interval '2 hours')::date",
      "date(now() + interval '1 day')",
      // Y el destino de TEXTO, que serializa el reloj con el huso de la sesión.
      'now()::text',
      'substring(now()::text, 1, 10)',
      'cast(current_timestamp as text)',
      '((now())::text)',
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
      "extract(day from timezone('UTC', now()))",
      // Y las precisiones de `date_trunc` que solo quitan fracciones del instante.
      "date_trunc('milliseconds', now())",
      // `AT TIME ZONE 'UTC'` es justo lo que FIJA el reloj, y la expresión entera es
      // independiente del huso (medido). El cast intermedio se escribía `timestamp[^)]*` y
      // ese `[^)]*` se tragaba la cláusula, así que la forma CORRECTA salía marcada: un censo
      // que marca su propio arreglo se acaba desactivando.
      "((now())::timestamp with time zone AT TIME ZONE 'UTC')::date",
      "(now() at time zone 'UTC')::date",
      // El cast que CONSERVA el instante: `timestamptz` no elige calendario.
      'now()::timestamptz',
      '(now())::timestamp with time zone',
      'clock_timestamp()::timestamptz',
      // Un campo por debajo del minuto sí es seguro sobre un reloj — y lo sería mal si los
      // instantes de la medición incluyeran la era de la hora local media.
      'extract(milliseconds from now())',
      // La precisión es parte del NOMBRE del tipo, y con ella el tipo sigue llevando huso:
      // medido comparando el valor, `now()::timestamp(0) with time zone` es el mismo instante
      // en husos opuestos. La guardia del huso tiene que ir DELANTE de la precisión para que
      // el retroceso del motor no la rodee.
      'now()::timestamp(0) with time zone',
      '(now())::timestamp(0) with time zone',
      'now()::timestamptz(0)',
      // Las palabras cuyo tipo LLEVA huso son instantes absolutos y no se marcan solas.
      // Medido: con instante fijo, la igualdad da `true` en husos opuestos.
      'current_timestamp',
      'current_time',
      'select current_timestamp - creado_en from disposicion',
      'vence_en > current_timestamp',
      // Comparar dos instantes absolutos no elige calendario: el otro operando lleva huso.
      "now() < timestamptz '2026-09-04 00:00:00+00'",
      "now() >= '2026-09-04 00:00:00+00'::timestamptz",
      'now() < creado_en',
      // Y comparar dos FECHAS tampoco: ninguna tiene huso del que moverse.
      "fecha_de_la_base() = date '2026-09-04'",
      // El `and` de al lado no es el límite superior del `between`. Medida: estable.
      "now() between timestamptz '2020-01-01+00' and timestamptz '2030-01-01+00' and date '2026-09-04' = fecha_de_la_base()",
      // La ida y vuelta por texto conserva el instante (medido por valor: mismo epoch en husos
      // opuestos). Con cualquier envoltura de paréntesis y con el nombre largo del tipo, que
      // son las dos formas por las que el guardia se dejaba rodear.
      'now()::text::timestamptz',
      'now()::text::timestamp with time zone',
      '((now()::text))::timestamptz',
      '(((now())::text))::timestamptz',
      'now()::character varying::timestamptz',
      // La RESTA de dos relojes es un intervalo, no una lectura del calendario: el cero es el
      // cero en todos los husos (medido).
      '(now() - now())::text',
      '(now() - now())::interval',
      "(now() at time zone 'UTC')::date = date '2026-09-04'",
      // Un intervalo sobre un valor que NO es reloj no colapsa ningún calendario.
      "(vence_en + interval '1 day')::date",
      // Y serializar algo que ya es fecha tampoco: un `date` no tiene huso del que moverse.
      'fecha_de_la_base()::text',
      // …y la unidad segura sigue siéndolo escrita con la sintaxis larga.
      "date_trunc(CAST('milliseconds' AS text), now())",
      "date_part(CAST('epoch' AS text), now())",
      "extract('epoch' from now())",
      // Un huso FIJO como tercer argumento da el mismo instante en cualquier sesión (medido
      // por epoch: idéntico en Kiritimati y en Etc/GMT+12), aunque su TEXTO se imprima
      // distinto — que es justo la trampa que este censo persigue, y en la que caí midiendo.
      "date_trunc('day', now(), 'UTC')",
      "date_trunc('day', now(), 'UTC'::text)",
      // Y las envolturas que no cambian la unidad segura.
      "date_trunc(('second'), now())",
      "date_trunc('second'::pg_catalog.text, now())",
      // Y las mismas formas SEGURAS escritas con prefijo o con cast, que es la gramática común
      // del literal. Las cuatro medidas por epoch: iguales en los dos husos.
      "date_trunc(E'second', now())",
      "date_part(E'epoch', now())",
      "date_trunc('day', now(), E'UTC')",
      "to_char(now(), 'US'::text)",
      'now()::text::pg_catalog.timestamptz',
      // El huso FIJO sigue siendo el arreglo canónico y no se marca, en las dos sintaxis.
      "timezone('UTC', now())::date",
      "(now() at time zone 'UTC')::date",
      // Y sigue siendo fijo con un paréntesis de más, que es la otra mitad de admitir la
      // envoltura: sin ella, subir el techo de anidamiento habría marcado código correcto.
      // Medido: 2026-09-04 en los dos husos.
      "timezone(('UTC'), now())::date",
      "(now() at time zone ('UTC'))::date",
      // Ni un EXECUTE cuyo SQL no lee el calendario.
      "execute 'select 1'",
      "execute format('select 1')",
      // Y la sustitución no INVENTA culpa: el mismo `format` con un argumento que no lee el
      // calendario sigue limpio.
      "execute format('select %s', '1')",
      // Y la mitad que acota a `array_to_string`: serializar un array de algo que YA es fecha
      // no elige calendario (medido: `2026-09-04` en los dos husos). El huso ya fijado dentro
      // del corchete se respeta igual que fuera — comprobado retirando esa mirada de atrás,
      // que la mueve junto a las tres seguras que ya la sostenían.
      "array_to_string(array[timezone('UTC', now())::date], ',')",
      // Y serializar un array de algo que YA es fecha no elige calendario: un `date` no tiene
      // huso del que moverse (medido: `["2026-09-04"]` en los dos husos). Es la mitad que
      // acota el descenso por los corchetes.
      'to_json(array[fecha_de_la_base()])',
      // `'now'` con huso es el instante y no elige nada: mismo epoch en husos opuestos
      // (1788538089, medido), igual que `now()` a secas.
      "'now'::timestamptz",
      "timestamptz 'now'",
      // Y las especiales que NO se mueven: las tres medidas iguales en husos opuestos.
      "'epoch'::date",
      "'infinity'::date",
      "'allballs'::timetz",
      // La palabra entre comillas SIN tipo encima es un dato como cualquier otro, y marcarla
      // sería el falso positivo que desactiva un censo: una clave de JSON, un texto que se
      // devuelve, una comparación contra una columna de texto.
      "concat('now')",
      "jsonb_build_object('now', creado_en)",
      "select 'today' as etiqueta",
      "where clase = 'yesterday'",
      // Y los formatos que NO leen el calendario: texto entrecomillado y campos por debajo
      // del minuto (ningún huso tiene desfase con segundos — medido sobre los 499).
      "to_char(now(), '\"fijo\"')",
      "to_char(now(), 'US')",
      "to_char(now(), 'SS.MS')",
      // …y `timetz` como destino conserva el instante igual.
      'now()::time with time zone',
      'now()::timetz',
      // Un identificador que TERMINA en la palabra clave. Solo la frontera IZQUIERDA lo
      // separa: `current_date_pactada` lo para la derecha, y por eso no prueba esta mitad.
      'mi_current_timestamp::date',
      'select mi_localtimestamp::date from t',
      'tabla.current_date_previo::date',
      // …y el reloj restado entre PARÉNTESIS es el mismo reloj: sigue siendo el intervalo
      // cero (medido `00:00:00` en los dos husos). Las dos formas que la exclusión ancha
      // recupera; con DOBLE paréntesis no hay sonda porque no la había marcado nadie —el
      // GRUPO solo anida un nivel—, y una sonda que pasa por otro motivo no prueba nada.
      '(now() - (now()))::text',
      '(now() - (now()::timestamptz))::text',
      // La ida y vuelta escrita con CAST … AS, en sus dos mitades. El catálogo NUNCA produce
      // esta forma —la deparsea con `::`—, así que ninguna sonda de objeto real la cubre.
      'cast(now()::text as timestamptz)',
      // Y el nombre entrecomillado no puede volverse una excusa para marcar: el arreglo
      // canónico y una unidad segura siguen siéndolo escritos así (medidos los dos).
      '"timezone"(\'UTC\', now())::date',
      '"date_trunc"(\'second\', now())',
      // Y el arreglo canónico DENTRO del JSON: lo que se serializa ya es un `timestamp` sin
      // huso, y sale igual en los dos (medido). Sin esta mitad, el patrón de arriba habría
      // marcado justo la forma que este PR propone como solución.
      "to_json(timezone('UTC', now()))",
      "jsonb_build_object('d', timezone('UTC', now()))",
      // Y la otra sintaxis de la conversión fija, que ni llega a probarse: detrás del reloj no
      // hay coma ni cierre. Medido estable en los dos husos.
      "to_json(now() at time zone 'UTC')",
      // Y las dos formas en que el operador NO renderiza un reloj: con la conversión delante
      // —lo que precede al operador es su paréntesis— y con la resta, que sigue siendo el
      // intervalo cero. Medidas las dos: iguales en los dos husos.
      "timezone('UTC', now()) || ''",
      "(now() - now()) || ''",
      "concat(timezone('UTC', now()))",
      // Con los dos instantes dados, `age` no lee ningún calendario (medido). Y el nombre
      // dentro de otro identificador tampoco: `promedio_age` y `average` no son la función.
      'age(now(), t.creado_en)',
      'select average(x) from t',
      'select promedio_age(x) from t',
      // Y con el tipo de la vuelta ENTRECOMILLADO, que sigue recuperando el instante (medido
      // por epoch: 1788530625 en los dos husos). Sin reconocerlo, el censo marcaba correcto.
      'now()::text::"timestamptz"',
      'cast(now()::text as "timestamptz")',
      // Un ALIAS de columna llamado como un tipo NO es un casto: la vuelta sigue siendo
      // terminal y la expresión sigue siendo correcta. Es lo que separa a la guardia nueva de
      // marcar cualquier `as` que venga detrás.
      'select now()::text::timestamptz as date from t',
      'cast(cast(now() as text) as timestamptz)',
      'cast(now()::text as timestamp with time zone)',
    ];
    expect(PELIGROSAS.filter((f) => !culpable(f))).toEqual([]);
    expect(SEGURAS.filter((f) => culpable(f))).toEqual([]);

    /*
     * Y el BARRIDO DE COMENTARIOS por los dos dialectos, que es por donde pasa TODO lo que
     * este censo inspecciona: si se come código, el censo da verde sin haber mirado.
     *
     * La diferencia entre los dialectos no es un detalle: **SQL anida los comentarios de
     * bloque y TypeScript no** (comprobados los dos). Contar profundidad en TypeScript deja la
     * cuenta abierta en el primer cierre y se lleva por delante la consulta real hasta el
     * siguiente cierre o el final del fichero.
     */
    /*
     * Y la BARRA de una expresión regular, que es la misma con la que empieza un comentario.
     * Dentro de una clase de caracteres no se escapa, así que `/[/*]/` lleva un `/*` que el
     * recorrido tomaba por comentario de bloque y, sin cierre por delante, se comía el resto
     * del fichero con la consulta peligrosa dentro.
     */
    expect(culpable('const sep = /[/*]/; const q = sql`select now()::date`;', 'ts')).toBe(true);
    // Y con la otra forma dentro de la clase, que se llevaba solo hasta el fin de renglón.
    expect(culpable('const sep = /[//]/;\nconst q = sql`select now()::date`;', 'ts')).toBe(true);
    /*
     * La otra mitad, y la que decide que la heurística vaya por el lado seguro: una DIVISIÓN
     * no puede tomarse por regex. Si se tomara, el recorrido se comería desde ahí hasta la
     * siguiente barra —la consulta de después incluida— y el censo daría verde sin mirar. Aquí
     * hay dos divisiones y una consulta peligrosa en medio.
     */
    expect(
      culpable('const a = b / c; const q = sql`select now()::date`; const d = e / f;', 'ts'),
    ).toBe(true);
    /*
     * Y la CLASE de caracteres tiene que consumirse entera, no hasta la primera barra de
     * dentro: cortar ahí devuelve al recorrido el resto de la regex como si fuera código, y
     * ese resto puede llevar una barra que abra otra «regex» que sí se coma la consulta. Aquí
     * la clase esconde una barra y el cuerpo lleva `\/\*` escapado, que es lo que al cortar
     * pronto deja un `*` delante de la barra siguiente.
     */
    expect(
      culpable('const r = /[/]|\\/\\*/; const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    // Y una regex que MENCIONA una palabra del reloj es un dato, no una lectura: no se ejecuta
    // como SQL nunca. Copiarla tal cual la marcaba.
    expect(culpable('const r = /current_date/; const q = sql`select 1`;', 'ts')).toBe(false);
    /*
     * El SQL de un `EXECUTE` escrito con literal por DÓLAR, dentro del cuerpo de una función
     * —que es donde aparece de verdad, y donde el delimitador exterior ya es otro dólar—.
     */
    expect(
      culpable(
        'create function f() returns void language plpgsql as $$ begin execute $q$select now()::date$q$; end $$',
        'sql',
      ),
    ).toBe(true);
    // Y la segura por la misma vía: fallar cerrado sobre un EXECUTE que no lee el calendario
    // sería marcar cualquier SQL dinámico.
    expect(
      culpable(
        'create function f() returns void language plpgsql as $$ begin execute $q$select 1$q$; end $$',
        'sql',
      ),
    ).toBe(false);
    /*
     * Una expresión regular en posición de SENTENCIA, tras la condición de un `if`. El `)` no
     * se puede decidir mirando un carácter: cierra un valor —y la barra divide— o cierra una
     * condición, y entonces lo que sigue es una sentencia que puede empezar por una regex.
     */
    expect(
      culpable('if (activo) /[/*]/.test(x); const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    /*
     * Y tras CERRAR un bloque empieza otra sentencia, así que también puede empezar una regex:
     * `if (activo) {} /re/.test(x)`. Con el `}` fuera de los abridores, la barra se leía como
     * división y el `/*` de la clase abría un comentario sin cierre que se llevaba la consulta
     * de después — el censo en verde por no estar mirando, que es su peor forma de fallar.
     *
     * Y no hay caso legítimo del otro lado que perder: dividir un objeto, una función o un
     * bloque no significa nada en JavaScript, así que una barra pegada a un `}` no es una
     * división en ningún código que compile.
     */
    expect(
      culpable('if (activo) {} /[/*]/.test(x); const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    /*
     * Y el `for await` de un bucle asíncrono: la palabra pegada al paréntesis es `await`, no
     * `for`, así que la condición de control no se reconocía y la barra de después volvía a
     * leerse como división.
     *
     * La segunda sonda es la que impide el arreglo perezoso: meter `await` en la lista de
     * control taparía el caso y rompería `await (f()) / 2`, que es una división legítima y
     * bien formada —y entonces la «regex» se comería hasta el salto de línea la consulta que
     * viene detrás—. Lo que hay que hacer es ATRAVESAR el modificador, no darle rango propio.
     */
    expect(
      culpable(
        'async function f() { for await (const x of xs) /[/*]/.test(x); }\nconst q = sql`select now()::date`;',
        'ts',
      ),
    ).toBe(true);
    expect(
      culpable('const n = await (f()) / 2; const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    /*
     * Y la división cuyo operando izquierdo es un OBJETO, que es la que refutó la afirmación
     * con la que yo había justificado meter el `}` entre los abridores: escribí que dividir un
     * objeto no significa nada en JavaScript, y con un `valueOf` significa exactamente lo que
     * parece. Es la quinta de esta familia y la que la cerró: esto ya no lo decide una lista de
     * caracteres, lo decide el parser.
     */
    expect(
      culpable(
        'const ratio = { valueOf() { return 1; } } / 2; const sep = /[/*]/;'
          + ' const q = sql`select now()::date`;',
        'ts',
      ),
    ).toBe(true);
    expect(culpable('function f() {} /[/*]/.test(x); const q = sql`select now()::date`;', 'ts')).toBe(
      true,
    );
    // Y las dos posiciones que faltaban tras una PALABRA: lo que sigue a `throw` y a un
    // `export default` es una expresión, y puede ser una regex.
    expect(
      culpable('if (error) throw /[/*]/; const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    expect(
      culpable('export default /[/*]/; const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    // Y el lado seguro del mismo carácter: un valor entre paréntesis dividido, que NO puede
    // tomarse por regex o se comería la consulta de después.
    expect(
      culpable('const a = (b + c) / d; const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    /*
     * Un backtick dentro de un comentario de bloque que está en una INTERPOLACIÓN: ahí es
     * texto inerte y no cierra la plantilla. Cortando el comentario en él, ese backtick abría
     * una plantilla nueva y el `--` de después se comía hasta el cierre de verdad.
     */
    expect(
      culpable('const q = sql`select ${/* ` -- nota */ valor}, now()::date`;', 'ts'),
    ).toBe(true);
    /*
     * Y el backtick ESCAPADO dentro de un comentario de línea de la plantilla: no cierra el
     * marco. Saliendo de la plantilla ahí, la comilla que todavía era comentario abría un
     * literal que se llevaba por delante la operación de la línea siguiente.
     */
    expect(culpable("const q = sql`select 1 -- \\` '\nnow()::date`;", 'ts')).toBe(true);
    /*
     * Y la otra cara de ese mismo escape: en un cuerpo del CATÁLOGO la barra no escapa nada
     * —SQL no la trata como escape—, así que `\*` no protege al `/` que le sigue y el
     * comentario SÍ cierra ahí. Saltando el par, el recorrido se comía el cierre y seguía
     * tragando SQL de verdad. Es el hueco que abrió el arreglo de arriba antes de acotarlo.
     */
    expect(culpable('/* nota \\*/ select now()::date', 'sql')).toBe(true);
    /*
     * Y dentro de una plantilla sí escapa, también en un comentario de BLOQUE: parando en ese
     * backtick, el recorrido salía de la plantilla a mitad y lo que aún era comentario pasaba
     * a leerse como TypeScript, donde el cierre del comentario ya no significa nada y lo de
     * detrás desaparece.
     */
    expect(culpable("const q = sql`select 1 /* \\` */ , now()::date`;", 'ts')).toBe(true);
    // Un `--` DENTRO de un literal no abre comentario.
    expect(culpable("select '--', now()::date", 'sql')).toBe(true);
    // Ni un `//` dentro de una cadena de TypeScript.
    expect(
      culpable("const u = 'https://host'; const q = sql`select now()::date`;", 'ts'),
    ).toBe(true);
    /*
     * Y el literal que SÍ es código sobrevive al vaciado en los dos dialectos, sin que la
     * cadena que solo lo NOMBRA se contagie. Las dos mitades hacen falta: conservar el
     * contenido de un literal es exactamente lo que el vaciado existe para no hacer, y sin la
     * segunda mitad esto sería la puerta de vuelta al falso positivo que lo motivó.
     */
    expect(culpable("const q = sql`select 'today'::date from t`;", 'ts')).toBe(true);
    expect(culpable("const modo = 'now'; const q = sql`select 1`;", 'ts')).toBe(false);
    expect(culpable("select clase from t where clase = 'now'", 'sql')).toBe(false);
    // SQL ANIDA: el cierre interior no termina el comentario, así que el `--` de después sigue
    // comentado y no puede comerse el código que viene tras el cierre exterior.
    expect(
      culpable('/* fuera /* dentro */ -- sigue fuera */ select now()::date', 'sql'),
    ).toBe(true);
    // TypeScript NO anida: el primer cierre termina el comentario y lo de después es código.
    expect(
      culpable('/* explica /* de SQL */ const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    // Y la otra mitad: un comentario de verdad no se convierte en hallazgo.
    expect(culpable('-- antes usaba current_date; ahora fecha_de_la_base()', 'sql')).toBe(
      false,
    );
    expect(culpable('// antes usaba current_date; ahora fecha_de_la_base()', 'ts')).toBe(
      false,
    );
    /*
     * Y DENTRO DE UNA INTERPOLACIÓN se vuelve a TypeScript. Una plantilla SQL es SQL, pero lo
     * que va entre las llaves es código, y ahí no anidan los comentarios ni las comillas
     * dobles son un carácter cualquiera. Sin esa transición, un comentario escrito dentro de
     * la interpolación dejaba la cuenta abierta y el recorrido se comía la consulta que venía
     * detrás: el censo de la aplicación en verde sin haber mirado.
     */
    expect(
      culpable('const q = sql`select ${/* uno /* dos */ v}, now()::date`;', 'ts'),
    ).toBe(true);
    /*
     * La misma transición por el otro carácter, y el daño es el CONTRARIO: una comilla simple
     * dentro de una cadena de comillas dobles es un apóstrofo, y leída como SQL abría un
     * literal que se tragaba el resto del fichero. Tragárselo NO deja ciego al censo —los
     * literales se copian tal cual, a propósito—, pero sí deja sin borrar los comentarios de
     * después: un `current_date` mencionado en uno pasa a ser hallazgo. Falso positivo, no
     * hueco.
     *
     * (Lo escribí primero al revés, esperando que cegara, y la sonda pasaba en verde con el
     * arreglo retirado. Una sonda que pasa por otro motivo no prueba nada.)
     */
    expect(
      culpable('const q = sql`select ${x ? "it\'s" : \'\'} from t`; // usaba current_date', 'ts',
      ),
    ).toBe(false);
    // Y la otra mitad: un comentario de verdad dentro de la interpolación sigue borrándose.
    expect(culpable('const q = sql`select ${/* current_date */ v} from t`;', 'ts')).toBe(
      false,
    );
    /*
     * Y las cuatro formas de desalinear la cuenta de llaves que abre este mismo arreglo: una
     * plantilla ANIDADA dentro de la interpolación, una llave dentro de una cadena, una
     * dentro de un comentario y un literal de objeto. En las cuatro tiene que seguir viéndose
     * el reloj que va DESPUÉS.
     *
     * DICHO CLARO, PORQUE VERDE NO ES PRUEBA: estas cuatro NO se mueven al retirar el
     * arreglo, ni al romper el conteo de llaves. Medido, no supuesto. Y la razón es
     * estructural: salirse de la interpolación ANTES de tiempo devuelve el recorrido a `sql`,
     * que es el modo que INSPECCIONA, así que un desajuste en esa dirección no puede cegar
     * nada; y al revés no hay forma de llegar, porque las cadenas y los comentarios se
     * consumen antes de que sus llaves se cuenten. El conteo es higiene, no guardián.
     *
     * Se quedan como PINS de regresión —si alguien hace que `${` se trague hasta el final de
     * la plantilla, estas cuatro lo cazan—, no como prueba de nada de hoy. Que es lo que ya
     * me obligó a retirar una sonda del doble paréntesis y a reescribir la del apóstrofo:
     * una sonda que pasa por otro motivo no prueba nada, y disfrazada de cobertura es peor
     * que no estar.
     */
    expect(
      culpable('const q = sql`a ${c ? sql`b ${x} c` : d}, now()::date`;', 'ts'),
    ).toBe(true);
    expect(culpable('const q = sql`a ${o["}"]}, now()::date`;', 'ts')).toBe(true);
    expect(culpable('const q = sql`a ${/* } */ v}, now()::date`;', 'ts')).toBe(true);
    // Y un literal de objeto, que abre y cierra llaves de verdad dentro de la interpolación.
    expect(culpable('const q = sql`a ${{ k: 1 }.k}, now()::date`;', 'ts')).toBe(true);
    /*
     * Un literal POR DÓLAR dentro de un cuerpo plpgsql. El delimitador del cuerpo hay que
     * atravesarlo —si no, el censo deja de mirar el cuerpo de cada función—, pero el literal
     * de dentro es un dato: leerlo como código hacía que su `--` se comiera la consulta de
     * después. `pg_get_functiondef` los conserva verbatim, comprobado sobre una función real.
     */
    expect(
      culpable(
        'create function f() returns void language plpgsql as $function$ begin perform $q$--$q$; perform now()::date; end $function$',
        'sql',
      ),
    ).toBe(true);
    // Y el cuerpo entero sigue mirándose: el delimitador se atraviesa, no se salta.
    expect(
      culpable(
        'create function f() returns void language plpgsql as $function$ begin perform now()::date; end $function$',
        'sql',
      ),
    ).toBe(true);
    // Una plantilla AJENA no puede tapar la consulta que viene después: su comentario acaba
    // donde acaba la plantilla.
    expect(
      culpable('const ayuda = `--opcion`; const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    // Y con un bloque sin cerrar, que es la misma puerta por el otro comentario.
    expect(
      culpable('const ayuda = `/*x`; const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    /*
     * Y la otra dirección: una palabra del reloj DENTRO de un literal es un dato, no una
     * lectura del calendario. Vale para el literal de SQL y para un mensaje de TypeScript.
     */
    expect(
      culpable(
        "create function f() returns text language sql as $$ select 'current_date' $$",
        'sql',
      ),
    ).toBe(false);
    expect(culpable("const aviso = 'current_date ya no se usa';", 'ts')).toBe(false);
    // Pero vaciar el literal NO puede romper a los dos patrones que lo LEEN.
    expect(culpable("date_trunc('milliseconds', now())")).toBe(false);
    expect(culpable("date_trunc('day', now())")).toBe(true);
    // Un identificador entrecomillado con guiones no abre comentario: el catálogo devuelve la
    // función en una línea y el barrido se comía la operación de después.
    expect(
      culpable(
        'create function f() returns date language plpgsql as $function$ declare "--" int; begin return now()::date; end $function$',
        'sql',
      ),
    ).toBe(true);
    // Y un backtick ESCAPADO no cierra la plantilla: si la cierra, el `//` que es contenido
    // pasa a ser comentario y se lleva la consulta de después.
    expect(
      culpable('const ayuda = `texto \\` // ejemplo`; const q = sql`select now()::date`;', 'ts'),
    ).toBe(true);
    /*
     * Y la cadena con prefijo E dentro de un cuerpo plpgsql: la comilla escapada con BARRA no
     * termina el literal, así que el `--` de dentro sigue siendo dato y no se come la
     * operación de después.
     */
    expect(
      culpable(
        "create function f() returns void language plpgsql as $function$ begin perform E'a\\'--b'; perform now()::date; end $function$",
        'sql',
      ),
    ).toBe(true);
    /*
     * El dólar dentro de una PLANTILLA no es un entrecomillado por dólar. `` `< $${n}` `` es
     * TypeScript real —está en `ai.degradacion.ts`—, y tomarlo por apertura de cuerpo dejaba
     * la etiqueta puesta: una etiqueta sin cerrar más adelante se leía como literal, el
     * vaciado se llevaba el resto y el censo daba verde. Lo introduje yo con el arreglo del
     * dólar y lo cacé buscando el idioma en `src/`.
     */
    expect(
      culpable('const p = `< $${n}`; const q = sql`select $x$ now()::date`;', 'ts'),
    ).toBe(true);
    /*
     * Y el literal por DÓLAR dentro de una plantilla no es el cuerpo de nada: en
     * `` sql`select $q$--$q$, now()::date` `` el `$q$…$q$` es un literal cuyo contenido es
     * `--` —medido: la consulta devuelve el texto `--` y la fecha—, así que tomarlo por la
     * apertura de un cuerpo dejaba ese `--` de código y se comía la operación de después.
     *
     * Esto lo rompí yo al quitar el reconocedor a mano: la guarda que lo distinguía vivía en
     * la pila que se fue con él, y ninguna sonda cubría el caso. La distinción va ahora en un
     * parámetro, que es donde se ve.
     */
    expect(culpable('const q = sql`select $q$--$q$, now()::date`;', 'ts')).toBe(true);
    /*
     * Y la plantilla se lee por lo que VALE, no por cómo está escrita. `\x6e` es una `n`
     * —comprobado con node: `` `select \x6eow()::date` `` es exactamente la cadena
     * `select now()::date` —, así que la etiqueta `sql` recibe el reloj aunque en el fichero
     * no aparezca escrito. Leer la ortografía es dejar de mirar por la forma de teclear algo,
     * que es la misma familia que el `$q$` de aquí arriba.
     *
     * Va con su mitad segura: un escape que NO compone ningún reloj se sigue leyendo como lo
     * que es, y no enrojece por llevar barras.
     */
    expect(culpable('const q = sql`select \\x6eow()::date`;', 'ts')).toBe(true);
    expect(culpable('const q = sql`select \\x64ato from t`;', 'ts')).toBe(false);
    // Y la interpolación se sigue reconociendo detrás de un dólar literal: si no, el
    // comentario de dentro volvería a anidar como SQL.
    expect(
      culpable('const p = sql`a $${n} ${/* uno /* dos */ v}, now()::date`;', 'ts'),
    ).toBe(true);
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
    /* Y un PROCEDIMIENTO, que no se puede crear con la forma de arriba y que `prokind = 'f'`
     * dejaba invisible: un procedimiento puede validar o escribir con el calendario de la
     * sesión igual que una función. Va aparte porque su sintaxis lo es. */
    await admin`create procedure censo_probe_procedimiento()
      language plpgsql as $$ begin perform current_date; end $$`;
    /*
     * Y el comentario de bloque ANIDADO, que tiene que ir en plpgsql y no en un cuerpo SQL.
     * Mi primera sonda tenía cuerpo SQL con un comentario dentro, y no probaba NADA: un
     * cuerpo SQL se guarda como ÁRBOL ANALIZADO, así que `pg_get_functiondef` lo devuelve sin
     * comentarios —comprobado: sale `RETURN (SELECT (now())::date AS now)`— y el recorrido
     * nunca veía uno. Un cuerpo plpgsql sí se guarda VERBATIM, comentarios incluidos.
     *
     * TODO EN UNA LÍNEA, y esto costó una segunda pasada: con el cierre exterior en su propio
     * renglón, el recorrido roto salía en el interior, se comía una línea con el `--` y el
     * `perform` de la siguiente SEGUÍA visible — la sonda no perdía nada y por tanto no probaba
     * nada. En una línea, el `--` que sigue al cierre interior se lleva por delante el resto,
     * cierre exterior y `perform` incluidos, que es justo la pérdida que hay que enseñar.
     */
    await admin.unsafe(
      'create function censo_probe_bloque_anidado() returns void language plpgsql as $c$ ' +
        'begin /* fuera /* dentro */ -- sigue fuera */ perform (now())::date; end $c$',
    );
    /*
     * Y el RELOJ ESCRITO ENTRE COMILLAS, que también tiene que ir en plpgsql, y por una razón
     * que conviene medir antes que suponer: Postgres PLIEGA `'today'::date` en cuanto puede.
     * Medido sobre cuatro sitios distintos —
     *
     *   cuerpo SQL nuevo (`return 'now'::date`)   se guarda ya como `'2026-09-04'::date`
     *   vista (`select 'today'::date`)            se guarda ya como `'2026-09-04'::date`
     *   cuerpo SQL antiguo (`as $$ select … $$`)  se guarda VERBATIM y depende: 09-05 / 09-04
     *   cuerpo plpgsql                            se guarda VERBATIM y depende: 09-05 / 09-04
     *
     * — o sea que donde el literal queda congelado ya no hay nada que censar (el problema ahí
     * es otro: una fecha fija que nadie escribió), y donde SÍ lee el reloj de quien llama el
     * texto sigue en el catálogo. La sonda va en el lado que el censo tiene que ver.
     *
     * Sin ella, todo lo que sostiene a esta familia serían sondas de TEXTO: el patrón podría
     * estar bien y el recorrido del catálogo no llegar nunca a enseñárselo.
     */
    await admin.unsafe(
      "create function censo_probe_literal_reloj() returns void language plpgsql as $c$ " +
        "begin perform 'today'::date; end $c$",
    );
    /*
     * Y las sondas del DESTINO TIPADO, que son las únicas de este fichero donde el cuerpo, por
     * sí solo, es CORRECTO: `begin return now(); end` no tiene nada que marcar hasta que se
     * sabe qué tipo declara la firma. Por eso van en pares —la misma expresión con `date` y
     * con `timestamptz`— y por eso ninguna sonda de texto podía sostenerlas: lo que decide no
     * está en el texto que se le pasa al reconocedor.
     *
     * Las cinco culpables son las cinco formas medidas de entregar un reloj a un tipo sin
     * huso, todas 2026-09-05 en Pacific/Kiritimati contra 2026-09-04 en Etc/GMT+12: el
     * `return` de plpgsql, la asignación a una variable declarada, el `select … into`, el
     * cuerpo SQL antiguo y el nuevo —que el catálogo guarda como `RETURN now()`, sin cast—.
     * Las dos seguras son las mismas expresiones devolviendo el instante, que es lo que hacen
     * bien las funciones de este esquema y no puede enrojecer.
     */
    for (const [nombre, sql] of [
      ['censo_probe_devuelve_date', 'returns date language plpgsql as $c$ begin return now(); end $c$'],
      [
        'censo_probe_variable_date',
        'returns date language plpgsql as $c$ declare d date; begin d := now(); return d; end $c$',
      ],
      [
        'censo_probe_into_date',
        'returns date language plpgsql as $c$ declare d date; begin select now() into d; return d; end $c$',
      ],
      ['censo_probe_cuerpo_viejo_date', 'returns date language sql stable as $c$ select now() $c$'],
      [
        'censo_probe_cuerpo_from_date',
        'returns date language sql stable as $c$ select now() from generate_series(1, 1) $c$',
      ],
      ['censo_probe_cuerpo_nuevo_date', 'returns date language sql stable return now()'],
      [
        'censo_probe_devuelve_instante',
        'returns timestamptz language plpgsql as $c$ begin return now(); end $c$',
      ],
      [
        'censo_probe_variable_instante',
        'returns timestamptz language plpgsql as $c$ declare d timestamptz; begin d := now(); return d; end $c$',
      ],
      /*
       * Y la misma variable con el nombre ENTRECOMILLADO, que es un identificador SQL con
       * todas las letras y que el catálogo guarda con las comillas puestas (comprobado).
       * Medido: 2026-09-05 en Pacific/Kiritimati contra 2026-09-04 en Etc/GMT+12, igual que
       * su hermana desnuda. Se escapaba por los DOS lados a la vez —ni la declaración ni la
       * asignación casaban con `\w+`— y por el del tipo de vuelta solo se veía un
       * `return "d"`, que no es ningún reloj.
       *
       * Con su pareja segura, que acota la forma: el mismo nombre entrecomillado sobre un
       * tipo CON huso conserva el instante. Dicho lo que vale, que es poco: no carga peso
       * propio —lo que la mantiene limpia es que `timestamptz` no case como tipo sin huso,
       * exactamente lo mismo que mantiene limpia a `censo_probe_variable_instante`—. Está
       * para que la forma nueva no entre sin su mitad, no como cobertura.
       */
      [
        'censo_probe_var_comillas_date',
        'returns date language plpgsql as $c$ declare "d" date;' +
          ' begin "d" := now(); return "d"; end $c$',
      ],
      [
        'censo_probe_var_comillas_instante',
        'returns timestamptz language plpgsql as $c$ declare "d" timestamptz;' +
          ' begin "d" := now(); return "d"; end $c$',
      ],
      /*
       * La gramática ENTERA de una declaración plpgsql, que es donde estaba la familia. Las
       * cinco culpables, todas medidas 2026-09-05 contra 2026-09-04 y todas verbatim en el
       * catálogo. La primera es la que más dice: el valor puesto en la PROPIA declaración no
       * es ninguna sentencia, así que la búsqueda de asignaciones no tenía qué buscar — y es
       * la forma más corta de escribirlo.
       *
       * Y sus dos seguras, que acotan las dos mitades por separado: el `constant` sobre un
       * tipo CON huso conserva el instante (mismo epoch en husos opuestos, medido) y el
       * `default` con el huso ya fijado da 2026-09-04 en los dos, o sea que capturar el
       * inicializador no se convierte en «hay un reloj dentro».
       */
      [
        'censo_probe_decl_inicializada',
        'returns date language plpgsql as $c$ declare d date := now(); begin return d; end $c$',
      ],
      [
        'censo_probe_decl_constant',
        'returns date language plpgsql as $c$ declare d constant date := now();' +
          ' begin return d; end $c$',
      ],
      [
        'censo_probe_decl_notnull',
        'returns date language plpgsql as $c$ declare d date not null := now();' +
          ' begin return d; end $c$',
      ],
      [
        'censo_probe_decl_default',
        'returns date language plpgsql as $c$ declare d date default now();' +
          ' begin return d; end $c$',
      ],
      [
        'censo_probe_decl_igual',
        'returns date language plpgsql as $c$ declare d date = now(); begin return d; end $c$',
      ],
      [
        'censo_probe_ok_decl_constant_instante',
        'returns timestamptz language plpgsql as $c$ declare d constant timestamptz := now();' +
          ' begin return d; end $c$',
      ],
      [
        'censo_probe_ok_decl_default_huso_fijo',
        "returns date language plpgsql as $c$ declare d date default timezone('UTC', now())::date;" +
          ' begin return d; end $c$',
      ],
      /*
       * Y el nombre citado que NECESITA las comillas, que es donde la normalización de antes
       * mentía: mutilaba `"fecha final"` hasta `fechafinal`, que no está en el texto por
       * ningún lado. Medido: 2026-09-05 en Pacific/Kiritimati contra 2026-09-04 en
       * Etc/GMT+12. Ahora el nombre se escapa en vez de recortarse, y la forma desnuda solo
       * se genera cuando Postgres la aceptaría.
       */
      [
        'censo_probe_var_espacio_date',
        'returns date language plpgsql as $c$ declare "fecha final" date;' +
          ' begin "fecha final" := now(); return "fecha final"; end $c$',
      ],
      /*
       * Y el constructor de array por SUBCONSULTA, con su segura al lado. La culpable
       * proyecta el reloj —`{2026-09-05}` contra `{2026-09-04}`, medido— y la segura proyecta
       * una columna y usa el reloj solo en el `where`, que es la mitad que impide que abrir la
       * lista se convierta en «hay un reloj dentro» (medido: la misma fecha en los dos husos).
       */
      [
        'censo_probe_arreglo_subconsulta_date',
        'returns date[] language plpgsql as $c$ begin return array(select now()); end $c$',
      ],
      /*
       * El destino tipado de una ESCRITURA, con y sin lista de columnas, y en `update`. Las
       * tres medidas: 2026-09-05 en Pacific/Kiritimati contra 2026-09-04 en Etc/GMT+12, con
       * la función devolviendo `void` y sin una sola variable declarada.
       *
       * La sonda SIN lista de columnas es la que carga el reparto por posición, que es la
       * mitad que no se ve: ahí la columna la elige el orden del catálogo y no el texto.
       *
       * Y sus dos seguras: la misma escritura sobre la columna CON huso conserva el instante
       * (mismo epoch en los dos husos, medido) y la de siempre con el huso ya fijado da
       * 2026-09-04 en los dos.
       */
      [
        'censo_probe_insert_date',
        'returns void language plpgsql as $c$' +
          ' begin insert into censo_probe_escritura(k, d) values (1, now()); end $c$',
      ],
      [
        'censo_probe_insert_posicional_date',
        'returns void language plpgsql as $c$' +
          ' begin insert into censo_probe_escritura values (1, now(), now()); end $c$',
      ],
      [
        'censo_probe_update_date',
        'returns void language plpgsql as $c$' +
          ' begin update censo_probe_escritura set d = now(); end $c$',
      ],
      [
        'censo_probe_ok_insert_instante',
        'returns void language plpgsql as $c$' +
          ' begin insert into censo_probe_escritura(k, ts) values (1, now()); end $c$',
      ],
      /*
       * Y el `ON CONFLICT … DO UPDATE SET`, que es un `update` cuya tabla está escrita arriba,
       * en el `insert`. Medido: 2026-09-05 en Pacific/Kiritimati contra 2026-09-04 en
       * Etc/GMT+12. Con su segura sobre la columna con huso.
       *
       * Salió de preguntarme dónde MÁS se entrega una expresión a un tipo que no está escrito,
       * y de esa pregunta salieron tres candidatos. Los otros dos NO son huecos, y queda
       * medido para que nadie los persiga: pasar un `timestamptz` a una función de parámetro
       * `date` es un error —«function … (timestamp with time zone) does not exist»— y un
       * `return query select now()` contra un `returns table(d date)` también —«structure of
       * query does not match function result type»—. Postgres coerciona en ASIGNACIÓN, no en
       * llamada ni en proyección, y por eso el destino tipado tiene las puertas que tiene y
       * no más.
       */
      [
        'censo_probe_conflicto_date',
        'returns void language plpgsql as $c$ begin' +
          " insert into censo_probe_escritura(k, d) values (1, date '2020-01-01')" +
          ' on conflict (k) do update set d = now(); end $c$',
      ],
      /*
       * Y la que comprueba que la culpa va a la tabla que TOCA. Las dos sentencias son
       * seguras por separado: la primera resuelve su conflicto sin escribir nada y la segunda
       * escribe el reloj en una columna que SÍ lleva huso. Pero el salto desde `on conflict`
       * hasta un `do update set` no puede cruzar el `;`: si lo cruza, el `set d = …` de la
       * segunda se lee como si fuera de la tabla de la primera, donde `d` es un `date`, y sale
       * un culpable que no existe. Es un falso positivo, que en un guardián cuesta lo mismo
       * que un hueco: se acaba desactivando.
       *
       * Por eso la segunda tabla tiene una columna que se llama IGUAL y significa otra cosa.
       * Sin eso el caso no se puede escribir: la atribución equivocada daría el mismo
       * veredicto que la correcta y la sonda pasaría por los dos motivos.
       */
      /*
       * Cuatro formas más de escribir lo mismo, las cuatro medidas 2026-09-05 en
       * Pacific/Kiritimati contra 2026-09-04 en Etc/GMT+12:
       *
       *   values (…), (…)          la SEGUNDA tupla, que es donde no se mira
       *   d = now()                plpgsql también asigna con `=` a secas
       *   update t as x set …      el destino puede llevar alias
       *   return next now()        con `returns setof date`
       *
       * La del `values` es la que más dice de cómo falla un reconocedor a mano: leía la
       * primera tupla, y la primera suele ser la inocente.
       *
       * Y la del `=` va con su segura al lado, que es la que separa las dos cosas que ese
       * signo significa. La comparación tiene que terminar EN el `;` para que el caso valga:
       * en `if d = now() then …` la captura se lleva el `then …` detrás y ya no parece un
       * reloj a secas, así que ese escrito no distingue nada. En `perform 1 where d = now();`
       * sí —la captura es exactamente `now()`—, y ahí se ve que lo único que separa una
       * asignación de una comparación es la POSICIÓN. Medido: 2026-09-04 en los dos husos, o
       * sea que no elige calendario y marcarla sería un falso positivo.
       */
      [
        'censo_probe_values_dos_tuplas_date',
        'returns void language plpgsql as $c$ begin insert into censo_probe_escritura(k, d)' +
          " values (1, date '2026-01-01'), (2, now()); end $c$",
      ],
      [
        'censo_probe_asigna_igual_date',
        'returns date language plpgsql as $c$ declare d date; begin d = now(); return d; end $c$',
      ],
      [
        'censo_probe_update_alias_date',
        'returns void language plpgsql as $c$' +
          ' begin update censo_probe_escritura as x set d = now(); end $c$',
      ],
      [
        'censo_probe_return_next_date',
        'returns setof date language plpgsql as $c$ begin return next now(); end $c$',
      ],
      /*
       * El `where` de una SUBCONSULTA no cierra la cláusula `set`. Medido: la función guarda
       * 2026-09-05 en Pacific/Kiritimati y 2026-09-04 en Etc/GMT+12, y la asignación que lo
       * hace es la SEGUNDA — la primera es segura (`ts` lleva huso) y estaba puesta ahí para
       * que cortar por la primera palabra suelta pareciera correcto.
       */
      [
        'censo_probe_set_subconsulta_date',
        'returns void language plpgsql as $c$ begin update censo_probe_escritura' +
          ' set ts = (select now() where true), d = now(); end $c$',
      ],
      // Y el alias en el destino de un `insert`, que va entre la tabla y la lista de columnas.
      [
        'censo_probe_insert_alias_date',
        'returns void language plpgsql as $c$ begin' +
          ' insert into censo_probe_escritura as x(k, d) values (1, now()); end $c$',
      ],
      [
        'censo_probe_ok_compara_igual',
        'returns date language plpgsql as $c$ declare d date; begin' +
          " d := timezone('UTC', now())::date; perform 1 where d = now(); return d; end $c$",
      ],
      [
        'censo_probe_ok_conflicto_otra_tabla',
        'returns void language plpgsql as $c$ begin' +
          " insert into censo_probe_escritura(k, ts) values (1, timestamptz '2020-01-01Z')" +
          ' on conflict (k) do nothing;' +
          " insert into censo_probe_otra(k, d) values (1, timestamptz '2020-01-01Z')" +
          ' on conflict (k) do update set d = now(); end $c$',
      ],
      [
        'censo_probe_ok_conflicto_instante',
        'returns void language plpgsql as $c$ begin' +
          " insert into censo_probe_escritura(k, ts) values (1, timestamptz '2020-01-01Z')" +
          ' on conflict (k) do update set ts = now(); end $c$',
      ],
      [
        'censo_probe_ok_insert_huso_fijo',
        "returns void language plpgsql as $c$ begin insert into censo_probe_escritura(k, d)" +
          " values (1, timezone('UTC', now())::date); end $c$",
      ],
      [
        'censo_probe_ok_arreglo_subconsulta_where',
        "returns date[] language sql stable as $c$ select array(select d from" +
          " (values (date '2026-01-01')) v(d) where now() > timestamptz '2000-01-01') $c$",
      ],
      // Y el reloj ENVUELTO en algo que no cambia su tipo, que es como llega de verdad una
      // expresión escrita por una persona. Las cuatro medidas: 2026-09-05 en
      // Pacific/Kiritimati contra 2026-09-04 en Etc/GMT+12.
      [
        'censo_probe_coalesce_date',
        'returns date language plpgsql as $c$ begin return coalesce(now(), now()); end $c$',
      ],
      [
        'censo_probe_greatest_date',
        'returns date language plpgsql as $c$ begin return greatest(now(), now()); end $c$',
      ],
      [
        'censo_probe_case_date',
        'returns date language plpgsql as $c$ begin return case when true then now() else now() end; end $c$',
      ],
      [
        'censo_probe_coalesce_sql_date',
        'returns date language sql stable as $c$ select coalesce(now(), now()) $c$',
      ],
      // Y las dos que impiden el atajo de «hay un reloj dentro»: las dos LO TIENEN y las dos
      // dan lo mismo en husos opuestos (2026-09-04 y 2026-01-01, medidas). La primera es el
      // arreglo canónico de este PR; la segunda devuelve una columna y usa el reloj solo para
      // filtrar. Sin ellas, seguir el valor y buscar dentro se verían igual de verdes.
      // Y la envoltura también en lo que se ASIGNA, que es la misma puerta por el otro lado.
      // Medidas las dos: 2026-09-05 contra 2026-09-04.
      [
        'censo_probe_variable_coalesce_date',
        'returns date language plpgsql as $c$ declare d date;' +
          ' begin d := coalesce(now(), now()); return d; end $c$',
      ],
      [
        'censo_probe_into_coalesce_date',
        'returns date language plpgsql as $c$ declare d date;' +
          ' begin select coalesce(now(), now()) into d; return d; end $c$',
      ],
      // Y las columnas de salida de un RETURNS TABLE, que son variables con otro sitio donde
      // declararse. Con una columna y con dos —`prorettype` dice `date` en el primer caso y
      // `record` en el segundo, medido—, porque lo que las caza es la declaración y no el
      // tipo de vuelta.
      [
        'censo_probe_tabla_date',
        'returns table(d date) language plpgsql as $c$ begin d := now(); return next; end $c$',
      ],
      [
        'censo_probe_tabla_dos_date',
        'returns table(d date, n int) language plpgsql as $c$' +
          ' begin d := now(); n := 1; return next; end $c$',
      ],
      // Y su pareja segura, que es la que acota: la misma columna de salida CON huso conserva
      // el instante y no puede enrojecer.
      [
        'censo_probe_tabla_instante',
        'returns table(d timestamptz) language plpgsql as $c$' +
          ' begin d := now(); return next; end $c$',
      ],
      /*
       * Y el destino tipado a través de un CONSTRUCTOR de array. Postgres coerciona
       * ELEMENTO A ELEMENTO: `returns date[]` con `return array[now()]` da
       * `{2026-09-05}` en Pacific/Kiritimati y `{2026-09-04}` en Etc/GMT+12 —medido—, y en
       * el catálogo no hay más que un `now()` desnudo, igual que en toda esta familia. Lo
       * que cambia es la SINTAXIS del envoltorio: `array[…]` no es una llamada, así que no
       * lo veía ni el seguimiento del valor ni la lista de tipos sin huso, que estaba
       * anclada al tipo escalar.
       *
       * El arreglo son DOS piezas y ninguna basta sola —admitir el sufijo en la lista de
       * tipos sin huso, y descender por el corchete—: retirando cualquiera de las dos se
       * mueve esta misma sonda y ninguna otra.
       *
       * Y sus dos parejas seguras, dicho lo que cada una vale de verdad, que no es lo que
       * parece:
       *
       * - `censo_probe_arreglo_instante` (elemento CON huso, que conserva el instante) SÍ
       *   carga peso: relajando el tipo del elemento para que acepte `with time zone`,
       *   enrojece. Pero enrojece junto a `censo_probe_devuelve_instante`, o sea que lo que
       *   añade no es el guardián —ése ya estaba— sino que el sufijo nuevo no se lo llevó
       *   por delante al pasar por encima.
       * - `censo_probe_ok_arreglo_huso_fijo` (el huso ya fijado DENTRO del corchete) NO
       *   añade cobertura, y se queda escrito como tal en vez de venderse: se mueve con
       *   exactamente la misma neutralización que `censo_probe_ok_huso_fijo_date` —quitarle
       *   el anclaje a `RELOJ_A_SECAS`— y con ninguna otra. Es la misma guarda de siempre
       *   redicha en forma de array. Lo que NO la sostiene, comprobado: meter `timezone` en
       *   las envolturas transparentes deja la suite entera en verde, porque ahí el
       *   descenso ni siquiera llega —el `)` no cierra la expresión, que sigue con `::date`—.
       */
      [
        'censo_probe_arreglo_date',
        'returns date[] language plpgsql as $c$ begin return array[now()]; end $c$',
      ],
      [
        'censo_probe_arreglo_instante',
        'returns timestamptz[] language plpgsql as $c$ begin return array[now()]; end $c$',
      ],
      [
        'censo_probe_ok_arreglo_huso_fijo',
        "returns date[] language plpgsql as $c$" +
          " begin return array[timezone('UTC', now())::date]; end $c$",
      ],
      // Y su pareja segura: la misma envoltura sobre una variable CON huso conserva el
      // instante, así que seguir el valor no puede enrojecerla.
      [
        'censo_probe_variable_coalesce_instante',
        'returns timestamptz language plpgsql as $c$ declare d timestamptz;' +
          ' begin d := coalesce(now(), now()); return d; end $c$',
      ],
      [
        'censo_probe_ok_huso_fijo_date',
        "returns date language plpgsql as $c$ begin return timezone('UTC', now())::date; end $c$",
      ],
      [
        'censo_probe_ok_subconsulta_date',
        "returns date language sql stable as $c$ select d from (values (date '2026-01-01')) v(d)" +
          " where now() > timestamptz '2000-01-01' $c$",
      ],
    ] as const) {
      await admin.unsafe(`create function ${nombre}() ${sql}`);
    }
    try {
      // `pg_get_functiondef` y no `prosrc`, y `prokind = 'f'` porque aquél no acepta
      // agregados ni funciones de ventana.
      const funciones = await admin`
        select p.proname as nombre, pg_get_functiondef(p.oid) as cuerpo, p.prosrc,
               -- El TIPO DE VUELTA, que es lo que la expresión no dice: una funcion
               -- que devuelve date con un now() desnudo dentro coerciona con el huso de
               -- quien llama, y en el texto no hay ningun cast que mirar.
               format_type(p.prorettype, null) as tipo
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and l.lanname not in ('internal', 'c')
          -- Funciones Y PROCEDIMIENTOS: pg_get_functiondef reconstruye los dos, y lo que no
          -- acepta son agregados (a) y funciones de ventana (w). Con prokind = f a secas, un
          -- procedimiento que validara con el calendario de la sesión quedaba invisible.
          -- (Sin comillas invertidas: esto vive en una template literal y las terminaría.)
          and p.prokind in ('f', 'p')
        order by 1`;
      // El censo tiene que estar mirando algo: sin esto, un cambio en la consulta que
      // devolviera cero filas dejaría el test en verde para siempre sin comprobar nada.
      expect(funciones.length).toBeGreaterThan(50);
      // Y la premisa del hallazgo del `prosqlbody`, comprobada y no supuesta.
      expect(funciones.find((f) => f.nombre === 'censo_probe_castop')!.prosrc).toBe('');

      const culpables = funciones
        .filter((f) => culpable(f.cuerpo as string, 'sql', f.tipo as string))
        .map((f) => f.nombre as string)
        .filter((n) => !(n in DECLARADAS));
      // Exactamente las peligrosas y ninguna más: si un patrón se rompe, su sonda desaparece
      // de aquí; si un patrón se pasa de ancho, aparece una segura.
      expect(culpables.sort()).toEqual(
        [
          ...Object.entries(SONDAS)
            .filter(([, v]) => v.culpable)
            .map(([n]) => n),
          'censo_probe_procedimiento',
          'censo_probe_bloque_anidado',
          'censo_probe_literal_reloj',
          'censo_probe_devuelve_date',
          'censo_probe_variable_date',
          'censo_probe_into_date',
          'censo_probe_cuerpo_viejo_date',
          'censo_probe_cuerpo_from_date',
          'censo_probe_cuerpo_nuevo_date',
          'censo_probe_coalesce_date',
          'censo_probe_greatest_date',
          'censo_probe_case_date',
          'censo_probe_coalesce_sql_date',
          'censo_probe_variable_coalesce_date',
          'censo_probe_into_coalesce_date',
          'censo_probe_tabla_date',
          'censo_probe_tabla_dos_date',
          'censo_probe_arreglo_date',
          'censo_probe_var_comillas_date',
          'censo_probe_decl_inicializada',
          'censo_probe_decl_constant',
          'censo_probe_decl_notnull',
          'censo_probe_decl_default',
          'censo_probe_decl_igual',
          'censo_probe_var_espacio_date',
          'censo_probe_arreglo_subconsulta_date',
          'censo_probe_insert_date',
          'censo_probe_insert_posicional_date',
          'censo_probe_update_date',
          'censo_probe_conflicto_date',
          'censo_probe_values_dos_tuplas_date',
          'censo_probe_asigna_igual_date',
          'censo_probe_update_alias_date',
          'censo_probe_return_next_date',
          'censo_probe_set_subconsulta_date',
          'censo_probe_insert_alias_date',
        ].sort(),
      );
    } finally {
      for (const nombre of Object.keys(SONDAS)) {
        await admin.unsafe(`drop function ${nombre}()`);
      }
      await admin`drop procedure censo_probe_procedimiento()`;
      await admin`drop function censo_probe_bloque_anidado()`;
      await admin`drop function censo_probe_literal_reloj()`;
      for (const nombre of [
        'censo_probe_devuelve_date',
        'censo_probe_variable_date',
        'censo_probe_into_date',
        'censo_probe_cuerpo_viejo_date',
        'censo_probe_cuerpo_from_date',
        'censo_probe_cuerpo_nuevo_date',
        'censo_probe_devuelve_instante',
        'censo_probe_variable_instante',
        'censo_probe_coalesce_date',
        'censo_probe_greatest_date',
        'censo_probe_case_date',
        'censo_probe_coalesce_sql_date',
        'censo_probe_variable_coalesce_date',
        'censo_probe_into_coalesce_date',
        'censo_probe_variable_coalesce_instante',
        'censo_probe_tabla_date',
        'censo_probe_tabla_dos_date',
        'censo_probe_tabla_instante',
        'censo_probe_arreglo_date',
        'censo_probe_arreglo_instante',
        'censo_probe_var_comillas_date',
        'censo_probe_var_comillas_instante',
        'censo_probe_decl_inicializada',
        'censo_probe_decl_constant',
        'censo_probe_decl_notnull',
        'censo_probe_decl_default',
        'censo_probe_decl_igual',
        'censo_probe_var_espacio_date',
        'censo_probe_arreglo_subconsulta_date',
        'censo_probe_ok_arreglo_subconsulta_where',
        'censo_probe_insert_date',
        'censo_probe_insert_posicional_date',
        'censo_probe_update_date',
        'censo_probe_conflicto_date',
        'censo_probe_values_dos_tuplas_date',
        'censo_probe_asigna_igual_date',
        'censo_probe_update_alias_date',
        'censo_probe_return_next_date',
        'censo_probe_set_subconsulta_date',
        'censo_probe_insert_alias_date',
        'censo_probe_ok_compara_igual',
        'censo_probe_ok_conflicto_instante',
        'censo_probe_ok_conflicto_otra_tabla',
        'censo_probe_ok_insert_instante',
        'censo_probe_ok_insert_huso_fijo',
        'censo_probe_ok_decl_constant_instante',
        'censo_probe_ok_decl_default_huso_fijo',
        'censo_probe_ok_arreglo_huso_fijo',
        'censo_probe_ok_huso_fijo_date',
        'censo_probe_ok_subconsulta_date',
      ]) {
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

  it('ni una vista, ni un CHECK, ni un default, ni una vista MATERIALIZADA, ni una REGLA', async () => {
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
    /*
     * Y el DEFAULT tipado, que es la otra mitad de la coerción implícita y la que ninguna sonda
     * de texto puede enseñar: el catálogo guarda `now()` a secas en las dos columnas
     * (comprobado con `pg_get_expr`), y lo que las separa es el TIPO. Medido insertando en las
     * dos: la de `date` da 2026-09-05 en Pacific/Kiritimati y 2026-09-04 en Etc/GMT+12; la de
     * `timestamptz` guarda el mismo instante. La segunda columna no es adorno: sin ella, una
     * regla que marcara cualquier `default now()` pasaría esta sonda igual y estaría rompiendo
     * el patrón correcto que usa medio esquema.
     */
    await admin`create table censo_tmp_defecto (d date default now(), t timestamptz default now())`;
    // Y una REGLA de reescritura, por lo mismo que la matview: hoy no hay ninguna real
    // (medido: cero), así que sin sonda su rama estaría en verde por no mirar nada.
    await admin`create table censo_tmp_regla_log (d date)`;
    await admin`create rule censo_tmp_regla as on insert to censo_tmp_tabla
      do also insert into censo_tmp_regla_log values (current_date)`;
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
             pg_get_expr(d.adbin, d.adrelid) as cuerpo,
             -- Y aquí el tipo de la COLUMNA, por lo mismo: el catálogo guarda
             -- default now() tal cual sobre una columna date (comprobado) y la
             -- coerción la hace cada INSERT con el huso de quien inserta.
             format_type(a.atttypid, a.atttypmod) as tipo
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
      // La SÉPTIMA, y la última que queda: una REGLA de reescritura. No es una vista —esas
      // son la regla `_RETURN` de su propia relación, y ya se cuentan por `pg_views`— sino la
      // forma legada de `CREATE RULE … DO ALSO`: una expresión guardada que se inserta DENTRO
      // de la sentencia de quien escribe y se evalúa en su sesión, igual que una condición
      // `WHEN`. Ninguna de las otras seis mira `pg_rewrite`, así que una regla calendárica
      // pasaba entera. Medido: hoy este repositorio no tiene ninguna, y precisamente por eso
      // entra — un censo cubre la clase, no los hallazgos.
      regla: await admin`select c.relname || ' / ' || r.rulename as nombre,
             pg_get_ruledef(r.oid) as cuerpo
        from pg_rewrite r
        join pg_class c on c.oid = r.ev_class
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and r.rulename <> '_RETURN'`,
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
      regla: 1,
    };
      for (const [nombre, filas] of Object.entries(categorias)) {
        expect(filas.length, `la rama «${nombre}» no está mirando nada`).toBeGreaterThanOrEqual(
          MINIMO[nombre as keyof typeof categorias],
        );
        const culpables = filas
          .filter((o) => culpable(o!.cuerpo as string, 'sql', o!.tipo as string | undefined))
          .map((o) => `${nombre} ${o!.nombre as string}`)
          .filter((n) => !(n in DECLARADAS));
        // La única culpable admitida es la sonda, y tiene que ESTAR: si la rama de matviews
        // deja de devolver filas, desaparece de aquí y este caso se pone rojo.
        // La única culpable admitida por categoría es su sonda, y tiene que ESTAR: si la
        // rama deja de devolver filas o mira la columna equivocada, desaparece de aquí.
        const esperadas: Record<string, string[]> = {
          default: ['default censo_tmp_defecto.d'],
          matview: ['matview censo_tmp_matview'],
          trigger: ['trigger censo_tmp_trg on censo_tmp_tabla'],
          regla: ['regla censo_tmp_tabla / censo_tmp_regla'],
        };
        expect(culpables).toEqual(esperadas[nombre] ?? []);
      }
    } finally {
      await admin`drop materialized view censo_tmp_matview`;
      await admin`drop table censo_tmp_tabla cascade`;
      await admin`drop table censo_tmp_regla_log cascade`;
      await admin`drop table censo_tmp_defecto cascade`;
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
      const codigo = await readFile(f, 'utf8');
      if (culpable(codigo, 'ts')) culpables.push(f.slice(raiz.length + 1));
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
