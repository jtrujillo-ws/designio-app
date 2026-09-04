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
        and (format_type(p.prorettype, null) in ('timestamp with time zone',
              'timestamp without time zone', 'date', 'time with time zone',
              'time without time zone')
          -- timeofday() es un reloj que devuelve TEXTO, así que el filtro por tipo no lo
          -- alcanza: timeofday()::timestamptz::date elige día igual. Va por nombre porque
          -- filtrar por text arrastraría media biblioteca. (Sin comillas invertidas: esto
          -- vive dentro de una template literal y las terminaría.)
          or p.proname = 'timeofday')
      order by 1`;
    const funciones = filas.map((f) => `${f.nombre as string}\\s*\\(\\s*\\)`);
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
    RELOJES = [
      // Las funciones llevan su frontera IZQUIERDA: sin ella, `mi_now()` salía marcado. A la
      // derecha no hace falta ninguna, porque el `\)` del nombre ya cierra.
      ...funciones.map((f) => String.raw`\b${f}`),
      // Y TODAS las palabras: colapsar cualquiera de ellas a un día es peligroso, aunque la
      // palabra desnuda no lo sea.
      ...PALABRAS_DEL_RELOJ.map(patronDe),
    ].join('|');

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
    const CASTOS = String.raw`(?:\s*::\s*(?:${TIPO_DE_TIEMPO}))*`;
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
    // Un grupo entre paréntesis con UN nivel de anidamiento dentro, porque así llega del
    // deparseador: `interval '1 day' * 2` se guarda como
    // `('1 day'::interval * (2)::double precision)`, con el número casteado dentro de su
    // propio paréntesis. Escribiendo solo la forma fuente, la del catálogo se escapaba.
    const GRUPO = String.raw`\([^()]*(?:\([^()]*\)[^()]*)*\)`;
    const OPERANDO_ARITMETICO = String.raw`(?:interval\s*'[^']*'|'[^']*'\s*::\s*interval\b|\w+\s*${GRUPO}|${GRUPO}|[\w.]+)(?:\s*[*/]\s*[\w.]+(?:\s*::\s*[\w ]+)?)*`;
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
    const TIPO_SIN_HUSO = String.raw`(?!(?:timestamp|time)\b${PRECISION}\s+with\s+time\s+zone\b)(?:date|time|timestamp)\b${PRECISION}`;
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
    const TIPO_TEXTUAL = String.raw`character\s+varying\b${PRECISION}|character\b${PRECISION}|varchar\b${PRECISION}|bpchar\b${PRECISION}|text\b`;
    // Con un `)` opcional en medio: Postgres deparsea `now()::text::timestamptz` como
    // `((now())::text)::timestamp with time zone`, o sea que el cast de vuelta NO va pegado al
    // nombre del tipo sino detrás del paréntesis que cierra. Sin admitirlo, la forma del
    // CATÁLOGO —la única que las sondas pueden ejercitar— salía marcada igual.
    const VUELTA_CON_HUSO = String.raw`(?!\s*\)?\s*::\s*(?:timestamptz\b|timetz\b|(?:timestamp|time)\b${PRECISION}\s+with\s+time\s+zone\b))`;
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
    const OPERANDO_SIN_HUSO = String.raw`(?:${TIPO_SIN_HUSO}\s*'[^']*'|(?:'[^']*'|[\w."]+)\s*::\s*${TIPO_SIN_HUSO})`;
    const COMPARADOR = String.raw`(?:<=|>=|<>|!=|<|>|=)`;

    RELOJ_COLAPSADO_A_DIA = [
      // `date_trunc('day', now())`, su forma deparseada `date_trunc('day'::text, now())` y la
      // que lleva cast: `date_trunc('day', timeofday()::timestamptz)`, obligada porque ese
      // reloj devuelve texto. Marca CUALQUIER unidad que no esté en la lista medida.
      new RegExp(
        String.raw`date_trunc\s*\(\s*'(?!(?:${UNIDADES_SEGURAS})')[^']*'(::\w+)?\s*,\s*(${RELOJ})\s*\)`,
        'i',
      ),
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
      new RegExp(String.raw`(${RELOJ})\s*::\s*(?:${DESTINO_QUE_ELIGE})`, 'i'),
      // `cast(now() as date)` en el código fuente, antes de que nadie la deparsee.
      new RegExp(String.raw`cast\s*\(\s*(${RELOJ})\s+as\s+(?:${DESTINO_QUE_ELIGE})`, 'i'),
      // `date(now())`, la tercera forma de escribir la misma conversión.
      new RegExp(String.raw`\b(date|time)\s*\(\s*(${RELOJ})\s*\)`, 'i'),
      // `to_char(now(), 'YYYY-MM-DD')`: no colapsa a un `date` pero produce el mismo día del
      // huso, y una regla escrita sobre esa cadena decide igual. El reloj tiene que ser el
      // PRIMER argumento — envuelto en `timezone('UTC', …)` ya no lo es.
      new RegExp(String.raw`to_char\s*\(\s*(${RELOJ})\s*,`, 'i'),
      // `extract(day from now())` y `EXTRACT(day FROM now())`: no colapsa a un día entero,
      // extrae UN campo del calendario, y el campo cambia con el huso igual.
      new RegExp(
        String.raw`extract\s*\(\s*(?!(?:${CAMPOS_SEGUROS})\b)\w+\s+from\s+(${RELOJ})`,
        'i',
      ),
      // `date_part('dow', now())`, que es la misma operación con la otra sintaxis, y su forma
      // deparseada `date_part('dow'::text, now())`.
      new RegExp(
        String.raw`date_part\s*\(\s*'(?!(?:${CAMPOS_SEGUROS})')[^']*'(::\w+)?\s*,\s*(${RELOJ})`,
        'i',
      ),
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
  });

  /** Lo que hace culpable a un cuerpo: la palabra clave o cualquiera de las operaciones. */
  const culpable = (cuerpo: string) =>
    DEL_HUSO_DE_LA_SESION.test(cuerpo) || RELOJ_COLAPSADO_A_DIA.some((r) => r.test(cuerpo));

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
  const sinComentarios = (texto: string, dialecto: 'sql' | 'ts' = 'sql'): string => {
    let salida = '';
    let i = 0;
    const modos: ('sql' | 'ts')[] = [dialecto];
    while (i < texto.length) {
      const modo = modos[modos.length - 1]!;
      const c = texto[i]!;
      const d = texto[i + 1];
      // Comentario de bloque, igual en los dos dialectos.
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
         * En TypeScript no anidan, pero contar la profundidad tampoco estorba ahí: `/*`
         * dentro de un bloque no es válido en ninguno de los dos.
         */
        let hondura = 1;
        i += 2;
        while (i < texto.length && hondura > 0) {
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
      if (modo === 'sql' ? c === '-' && d === '-' : c === '/' && d === '/') {
        const fin = texto.indexOf('\n', i);
        i = fin === -1 ? texto.length : fin;
        salida += ' ';
        continue;
      }
      // Literal de comillas simples: dato en los dos dialectos. En SQL se escapa
      // duplicándolo; en TypeScript, con barra invertida.
      if (c === "'" || (modo === 'ts' && c === '"')) {
        const desde = i;
        i++;
        while (i < texto.length) {
          if (modo === 'ts' && texto[i] === '\\') i += 2;
          else if (texto[i] === c && modo === 'sql' && texto[i + 1] === c) i += 2;
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
        salida += texto.slice(desde, i);
        continue;
      }
      // Las comillas invertidas abren y cierran SQL dentro de TypeScript.
      if (c === '`') {
        if (modo === 'ts') modos.push('sql');
        else if (modos.length > 1) modos.pop();
        salida += c;
        i++;
        continue;
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
      // La aritmética con llamada y con multiplicación.
      '(now() + make_interval(days => 1))::date',
      "(now() + interval '1 day' * 2)::date",
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
      // La ida y vuelta por texto conserva el instante (medido).
      'now()::text::timestamptz',
      'now()::text::timestamp with time zone',
      "(now() at time zone 'UTC')::date = date '2026-09-04'",
      // Un intervalo sobre un valor que NO es reloj no colapsa ningún calendario.
      "(vence_en + interval '1 day')::date",
      // Y serializar algo que ya es fecha tampoco: un `date` no tiene huso del que moverse.
      'fecha_de_la_base()::text',
      // …y `timetz` como destino conserva el instante igual.
      'now()::time with time zone',
      'now()::timetz',
      // Un identificador que TERMINA en la palabra clave. Solo la frontera IZQUIERDA lo
      // separa: `current_date_pactada` lo para la derecha, y por eso no prueba esta mitad.
      'mi_current_timestamp::date',
      'select mi_localtimestamp::date from t',
      'tabla.current_date_previo::date',
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
    try {
      // `pg_get_functiondef` y no `prosrc`, y `prokind = 'f'` porque aquél no acepta
      // agregados ni funciones de ventana.
      const funciones = await admin`
        select p.proname as nombre, pg_get_functiondef(p.oid) as cuerpo, p.prosrc
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
        .filter((f) => culpable(sinComentarios(f.cuerpo as string)))
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
        ].sort(),
      );
    } finally {
      for (const nombre of Object.keys(SONDAS)) {
        await admin.unsafe(`drop function ${nombre}()`);
      }
      await admin`drop procedure censo_probe_procedimiento()`;
      await admin`drop function censo_probe_bloque_anidado()`;
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
      const codigo = sinComentarios(await readFile(f, 'utf8'), 'ts');
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
