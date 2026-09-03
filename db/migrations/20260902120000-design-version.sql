-- SPEC-06 (ADR-0004) — La cadena de trazabilidad y los cuatro objetos de resultado:
-- design version con elementos de cambio, releases PARCIALES, effective state con
-- desviaciones y la conciliación que bloquea G7.
--
-- El diff NO tiene tabla (RF-06.2, y la tabla de decisiones tácticas del domain model):
-- se CALCULA contra el effective state vigente del servicio. Almacenarlo sería guardar
-- una respuesta que caduca en cuanto cambia cualquiera de sus dos lados.
--
-- `release` es palabra clave NO RESERVADA en Postgres (solo lo es en `release savepoint`)
-- y sirve como nombre de tabla sin comillas — verificado en 16. Se usa el nombre canónico
-- del agregado (I1/SYS-09: el vocabulario de resultados no se renombra) en vez de un
-- sinónimo; «Entrega» es el nombre del CONTEXTO (CTX-05), y es el que lleva el módulo
-- TypeScript (src/lib/entrega/), no el objeto.
--
-- Mismo patrón de la casa: FKs compuestas (id, workspace_id), RLS desde el día 1,
-- atribución fijada en la política, transiciones exigidas por el WITH CHECK y efectos
-- (sellos, cambios de estado y eventos) dentro del guard que decide, para que el SQL
-- crudo los produzca igual.

-- ── Design version: qué se decidió construir o cambiar (CTX-04, RF-06.1) ──
-- Estados de §3.3: borrador → aprobada (inmutable) → superada.
create table design_version (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  proyecto_id uuid not null,
  -- El servicio cuyo effective state cambia: es el eje del diff (RF-06.2) y del estado
  -- vigente (RF-06.10). Va aquí y no derivado del reto porque un reto afecta a varios
  -- servicios (n:m) y una design version cambia UNO.
  servicio_id uuid not null,
  -- El grafo to-be que esta versión aprueba. Opcional en borrador (la DV puede abrirse
  -- antes de que el to-be exista); OBLIGATORIO al aprobar, porque aprobar congela su
  -- snapshot (RF-06.3 / RF-05.8).
  journey_id uuid,
  -- CANÓNICO y acotado, no «cualquier cosa que parezca un código»: ver numero_de_serie.
  codigo text not null check (codigo ~ '^DV-[1-9][0-9]{0,8}$'),
  titulo text not null check (btrim(titulo) <> ''),
  resumen text not null default '',
  estado text not null default 'borrador'
    check (estado in ('borrador', 'aprobada', 'superada')),
  -- SYS-05: «toda modificación posterior crea una nueva versión y marca la anterior como
  -- superada». La versión NUEVA declara a cuál supera; al aprobarse, aquella pasa a
  -- 'superada' en la misma transacción.
  supera_a uuid,
  snapshot_id uuid,
  aprobada_por uuid references usuario(id),
  aprobada_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, codigo),
  foreign key (proyecto_id, workspace_id) references proyecto (id, workspace_id),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id),
  foreign key (journey_id, workspace_id) references journey (id, workspace_id),
  foreign key (supera_a, workspace_id) references design_version (id, workspace_id),
  foreign key (snapshot_id, workspace_id) references journey_snapshot (id, workspace_id),
  -- Aprobar es inseparable de congelar: sin snapshot no hay aprobación (RF-06.3).
  check (estado = 'borrador'
    or (aprobada_por is not null and aprobada_en is not null and snapshot_id is not null)),
  check (estado <> 'borrador'
    or (aprobada_por is null and aprobada_en is null and snapshot_id is null)),
  check (supera_a is null or supera_a <> id)
);
create index design_version_proyecto_idx on design_version (workspace_id, proyecto_id);
-- SYS-05 en el MODELO, no en el servicio: un servicio tiene como mucho UNA design
-- version aprobada. Aprobar DV-2 sin superar a DV-1 no es un flujo mal implementado:
-- es una fila que la base rechaza.
create unique index design_version_vigente_uniq
  on design_version (workspace_id, servicio_id) where estado = 'aprobada';
-- La historia es una CADENA, no un árbol: una design version tiene como mucho una
-- sucesora. Parcial sobre las no-borrador a propósito — dos borradores pueden competir
-- por suceder a la misma DV (y uno quedarse en el camino), pero solo uno llega a
-- aprobarse. Sin el parcial, un borrador abandonado bloquearía la sucesión para siempre
-- y no hay DELETE que lo saque de en medio.
create unique index design_version_sucesion_uniq
  on design_version (workspace_id, supera_a)
  where supera_a is not null and estado <> 'borrador';

-- ── Elemento de cambio: la unidad del diff (RF-06.1) ──
-- Tipado a propósito (§3.2 lo enumera): sin tipo, el diff es una lista de frases y la
-- conciliación no puede agrupar ni comparar entre retos.
create table elemento_cambio (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  design_version_id uuid not null,
  tipo text not null check (tipo in (
    'touchpoint', 'proceso-backstage', 'canal', 'politica', 'sistema', 'paso', 'rol')),
  -- Lo que el autor DECLARA hacer. El diff (RF-06.2) contrasta esta declaración contra
  -- el effective state vigente y señala las que no cuadran: por eso se guarda la
  -- declaración y no el resultado del contraste.
  operacion text not null check (operacion in ('agrega', 'modifica', 'retira')),
  titulo text not null check (btrim(titulo) <> ''),
  detalle text not null default '',
  -- El nodo del grafo (SPEC-05) que materializa el cambio: es lo que permite responder
  -- «qué pasos del journey afectó RL-1» (§19.7, criterio de aceptación 5).
  --
  -- SIN FK, a propósito, y es la única columna de este esquema que renuncia a una. Una FK
  -- restrictiva desde aquí invierte la relación que RF-05.8 establece: el grafo de trabajo
  -- NO se cierra al congelar —lo inmutable es el snapshot—, y un elemento de una design
  -- version aprobada es inmutable (sus políticas solo alcanzan borradores). Con la FK, en
  -- cuanto una versión aprobada enlazaba un nodo, ese nodo ya no se podía borrar nunca:
  -- ni desenlazándolo (la versión es inmutable) ni de ninguna otra forma. El objeto
  -- congelado le prohibía cambiar al vivo, que es exactamente el cierre que la spec
  -- rechaza.
  --
  -- Lo que se conserva es el ID, y con él la referencia histórica — que se resuelve contra
  -- el SNAPSHOT de la versión que lo aprobó (nodo_congelado, más abajo), no contra la fila
  -- viva. Leer la fila viva ya era leer otra cosa: el journey sigue editándose, y desde
  -- SPEC-05.1 renombrar una entrada de catálogo reescribe la etiqueta de todos sus nodos,
  -- así que el «paso» que una design version aprobada dice haber cambiado podía cambiar de
  -- nombre por debajo sin que nadie tocara la design version.
  --
  -- La integridad que la FK daba de verdad —que el nodo sea de este workspace y del
  -- journey de esta design version— no se pierde: nunca la dio la FK (que solo garantizaba
  -- el workspace), la da elemento_cambio_nodo_guard en cada escritura. Lo único que se
  -- suelta es «la fila sigue existiendo», que es justo lo que no debe ser un invariante.
  --
  -- Mientras la versión sigue en BORRADOR, «la fila sigue existiendo» tampoco es un
  -- invariante que haga falta: el borrador se edita contra el grafo vivo, y si el nodo se
  -- borra el enlace queda colgando y se corrige —`nodo_id` está en el grant de columna—.
  -- Lo que sí es un invariante es que al APROBAR el snapshot pueda responder por cada
  -- nodo enlazado, y eso lo exige design_version_transicion_guard en la transición, que
  -- es cuando la versión se vuelve inmutable y deja de poder corregirse.
  nodo_id uuid,
  orden integer not null default 0,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (design_version_id, workspace_id) references design_version (id, workspace_id)
);
create index elemento_cambio_dv_idx on elemento_cambio (workspace_id, design_version_id, orden);
create index elemento_cambio_nodo_idx on elemento_cambio (workspace_id, nodo_id);

-- ══ DENTRO DE UNA DESIGN VERSION, UN NODO ES UN SOLO CAMBIO ══
-- La identidad lógica de un elemento la define «clave» (entrega.diff.ts), y su primer
-- escalón es la referencia: catálogo si lo hay, y si no el nodo. Sin esta unicidad, dos
-- elementos de la MISMA versión podían apuntar al mismo nodo, aprobarse y salir en un
-- release — y entonces el modelo y la clave se contradicen:
--
--  · el pliegue del estado efectivo los trata como UNO, así que una constatación machaca a
--    la otra, y un 'retira' constatado borra de golpe el estado que representaban las dos;
--  · mientras el diff y el conteo de G7 siguen viendo DOS filas.
--
-- Es la simetría exacta del fallo que cerró la identidad por tipo, con el signo cambiado:
-- allí eran dos cosas DISTINTAS compartiendo clave, y se arregló distinguiéndolas; aquí son
-- dos filas que comparten clave CON RAZÓN, y no hay nada en ellas que las separe.
--
-- Y por eso la salida no puede ser tocar «clave»: meter el id del elemento la haría única
-- por fila y destruiría lo único que la clave existe para hacer —reconocer el mismo elemento
-- lógico ENTRE versiones—, y meter el tipo partiría la identidad en cuanto alguien
-- reclasifica (el argumento está escrito en «clave», y sigue en pie). Si la clave no puede
-- distinguirlas, entonces son el mismo cambio, y el modelo tiene que decirlo.
--
-- El índice es PARCIAL porque el tercer escalón de la clave —los elementos sin nodo— se
-- desempata por título normalizado dentro de su tipo: ahí un único sobre null no afirmaría
-- nada útil (y en Postgres los nulos ni siquiera colisionan entre sí).
--
-- La otra mitad de la identidad —dos nodos DISTINTOS que apuntan al mismo catálogo, que un
-- journey admite de sobra: el mismo touchpoint en dos momentos del recorrido— no cabe en un
-- índice, porque el catálogo no es una columna de esta tabla sino del nodo. La imponen
-- elemento_cambio_nodo_guard al escribir y design_version_transicion_guard al aprobar.
--
-- Prohibir esto no le quita al usuario ninguna salida que estuviera usando: partir un cambio
-- en dos elementos era la única forma de colgarle varias razones, y desde que el formulario
-- manda las listas completas de decisiones e insights esa presión no existe.
create unique index elemento_cambio_nodo_unico
  on elemento_cambio (workspace_id, design_version_id, nodo_id)
  where nodo_id is not null;

-- ── Y el TERCER escalón de la identidad, que es el que no tiene referencia ──
-- El índice de arriba cubre a los elementos CON nodo. Los que no lo tienen se emparejan por
-- «tipo + título normalizado» —el tercer escalón de «clave»—, y ahí hacía falta el índice
-- complementario, no la ausencia de uno: lo que no se puede indexar es un único sobre
-- `nodo_id` nulo (en Postgres los nulos ni colisionan entre sí), pero `(tipo, título
-- normalizado)` se indexa perfectamente. Entre los dos, cada escalón de la clave tiene su
-- unicidad y el modelo deja de contradecirla.
--
-- Sin esto quedaba abierto EXACTAMENTE el mismo fallo, en el escalón que el otro índice no
-- alcanza: dos elementos sin nodo, mismo tipo y mismo título, aprobados y desplegados; el
-- pliegue los cuenta como uno y G7 como dos.
--
-- La normalización TIENE que decir lo mismo que `normalizar` en entrega.diff.ts, porque son
-- los dos lados de la misma regla —el que la impone y el que la aplica al plegar—. No pueden
-- compartir código (uno es SQL y el otro corre también en el navegador), así que lo que las
-- mantiene juntas es un test que pasa las mismas cadenas por las dos y exige el mismo
-- resultado. Si alguien toca una, ese test se pone rojo.
--
-- Paso a paso, y en el mismo orden que la de TypeScript: descomponer a NFD, quitar las
-- marcas combinantes (así «Atención» y «atencion» son la misma), bajar a minúsculas, recortar
-- los extremos y colapsar cualquier racha de espacios —incluidos los exóticos que `\s`
-- reconoce en JavaScript— a uno solo.
-- El ORDEN de los pasos es parte de la regla, no una preferencia de escritura. `btrim` sin
-- argumento recorta SOLO el espacio ASCII, mientras que `.trim()` de JavaScript se lleva
-- también tabuladores, NBSP y compañía. Recortando ANTES de colapsar, «\tAtención\t» conservaba
-- los tabuladores, el colapso los volvía espacios normales y quedaba « atencion » con espacios
-- en los bordes — mientras TypeScript devolvía «atencion». Dos claves distintas para el mismo
-- título: exactamente los duplicados lógicos que el índice tenía que impedir.
--
-- Colapsando primero y recortando después, el recorte solo tiene que vérselas con espacios
-- ASCII y las dos redacciones coinciden en los bordes igual que en el medio.
create function titulo_normalizado(p_titulo text) returns text
language sql immutable strict as $$
  select btrim(
           regexp_replace(
             lower(regexp_replace(normalize(p_titulo, nfd), '[\u0300-\u036f]', '', 'g')),
             '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',
             ' ', 'g'))
$$;
revoke execute on function titulo_normalizado(text) from public;
-- La evalúa el índice, que corre con los privilegios de quien escribe.
grant execute on function titulo_normalizado(text) to designio_app;

create unique index elemento_cambio_titulo_unico
  on elemento_cambio (workspace_id, design_version_id, tipo, titulo_normalizado(titulo))
  where nodo_id is null;

-- Qué MOTIVA el elemento (RF-06.1). Dos tablas y no una columna polimórfica: cada
-- enlace tiene su FK compuesta real, y la navegación hacia atrás (RF-06.9) es un join,
-- no un case.
create table elemento_decision (
  elemento_id uuid not null,
  decision_id uuid not null,
  workspace_id uuid not null references workspace(id),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  primary key (elemento_id, decision_id),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  foreign key (decision_id, workspace_id) references decision (id, workspace_id)
);
create index elemento_decision_dec_idx on elemento_decision (workspace_id, decision_id);

create table elemento_insight (
  elemento_id uuid not null,
  insight_id uuid not null,
  workspace_id uuid not null references workspace(id),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  primary key (elemento_id, insight_id),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  foreign key (insight_id, workspace_id) references insight (id, workspace_id)
);
create index elemento_insight_ins_idx on elemento_insight (workspace_id, insight_id);

-- ── Release: subconjunto de una design version aprobada (CTX-05, SYS-06) ──
-- Estados de §3.3: planificado → desplegado → verificado.
create table release (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  -- SYS-06: EXACTAMENTE una design version, y aprobada (lo exige la política de insert).
  design_version_id uuid not null,
  codigo text not null check (codigo ~ '^RL-[1-9][0-9]{0,8}$'),
  titulo text not null check (btrim(titulo) <> ''),
  -- RF-06.4: dueño y fecha. Sin dueño, «parcialidad explícita» es una lista sin nadie
  -- que responda por ella.
  responsable text not null check (btrim(responsable) <> ''),
  fecha_objetivo date not null,
  estado text not null default 'planificado'
    check (estado in ('planificado', 'desplegado', 'verificado')),
  -- Fecha REAL del despliegue (RF-06.5), calendárica: la pone quien lo registra porque
  -- puede ser anterior al registro; el guard impide que sea futura.
  desplegado_en date,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, codigo),
  foreign key (design_version_id, workspace_id) references design_version (id, workspace_id),
  check (estado = 'planificado' or desplegado_en is not null),
  check (estado <> 'planificado' or desplegado_en is null)
);
create index release_dv_idx on release (workspace_id, design_version_id);

-- ── Parcialidad explícita (SYS-06, §19.5) ──
-- La PK es el ELEMENTO, no el par: cada elemento va a como mucho UN release, y eso es
-- una constraint, no una convención del servicio. El «exactamente uno» de RF-06.4 lo
-- completa G7, que no aprueba con elementos sin estado conocido.
create table release_elemento (
  elemento_id uuid primary key,
  release_id uuid not null,
  workspace_id uuid not null references workspace(id),
  -- Por qué este elemento cae en ESTE release y no antes (criterio de aceptación 2:
  -- «pendiente asignado a RL-2 con su razón»). Opcional: la razón obligatoria es la de
  -- la desviación (SYS-07), no la del plan.
  razon text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  foreign key (release_id, workspace_id) references release (id, workspace_id)
);
create index release_elemento_rel_idx on release_elemento (workspace_id, release_id);

-- ── Effective state: qué quedó funcionando (CTX-05, RF-06.6) ──
-- Cada constatación es un REGISTRO NUEVO (historia, no mutación); «vigente» es el más
-- reciente por servicio (RF-06.10).
create table effective_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  servicio_id uuid not null,
  release_id uuid not null,
  codigo text not null check (codigo ~ '^ES-[1-9][0-9]{0,8}$'),
  resumen text not null default '',
  constatado_por uuid not null references usuario(id),
  constatado_en date not null,
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, codigo),
  -- Release "1" → "0..1" EffectiveState (domain model): un release se constata una vez.
  unique (release_id),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id),
  foreign key (release_id, workspace_id) references release (id, workspace_id)
);
create index effective_state_servicio_idx
  on effective_state (workspace_id, servicio_id, constatado_en desc);

-- ══ EL ORDEN DE UNA SERIE ES SU NÚMERO, NUNCA SU SELLO TEMPORAL ══
-- Los códigos de serie (ES-1, RL-2, DV-3) se asignan bajo `bloquearSerie`, un candado que la
-- transacción toma DESPUÉS de haber empezado. Y `creado_en` cae por defecto en `now()`, que
-- en Postgres es el instante de INICIO de la transacción. Son DOS RELOJES DISTINTOS, y se
-- contradicen en cuanto hay espera: una transacción que empezó ANTES y se quedó esperando el
-- candado obtiene un número MAYOR con un `creado_en` MENOR. `now()` no sabe nada de un
-- candado que se tomó después.
--
-- Donde el orden solo decora, da igual. Donde DECIDE EL ESTADO, no: el effective state
-- vigente de un servicio es el PLIEGUE cronológico de sus constataciones (RF-06.10), así que
-- dos que caen en la misma fecha de calendario se desempatan aquí — y con el sello el pliegue
-- aplicaba ES-2 primero y dejaba que ES-1 lo pisara. Estado vigente equivocado, y el diff que
-- se calcula contra él, también. Sin excepción ninguna que lo delate.
--
-- El número SÍ es el orden que impuso el candado: es literalmente lo que el candado
-- serializa, así que no puede discrepar de sí mismo. Se ordena por él.
--
-- Y se escribe UNA vez porque lo necesitan dos lecturas —la historia que se pliega y la
-- elección del ES vigente—: dos redacciones del mismo desempate acaban divergiendo, que es
-- la lección que ya dejaron `gate_certificado_del_proyecto` y `g7_motivo_de_bloqueo`.
-- Que el código sea CANÓNICO es ahora carga estructural, y lo es desde que el orden dejó de
-- salir del sello. Mientras el desempate era temporal, 'DV-01' junto a 'DV-1' solo era feo:
-- los dos pasaban el patrón antiguo y la unicidad de TEXTO no los ve iguales. Desde que el
-- orden lo da el número interpretado, los dos valen 1 — y entonces:
--
--  · el keyset de la lista pierde el orden TOTAL que asume y puede saltarse filas en el
--    borde de una página, porque «menor estricto que el del cursor» descarta a su gemelo;
--  · la elección del effective state vigente del mismo día vuelve a ser no determinista,
--    que es justo lo que se acababa de arreglar;
--  · y una tirada larga de dígitos desborda el int en el cast.
--
-- Se cierra DONDE NACE, en el CHECK de cada tabla: un dígito inicial no nulo y como mucho
-- nueve cifras, que es lo que cabe en un int4 con holgura. Así el parseo no tiene casos raros
-- que cubrir — hacer defensivo a `numero_de_serie` habría sido tratar el síntoma y dejar el
-- dato torcido en la tabla, donde el siguiente lector se lo vuelve a encontrar.
--
-- Los generadores ya producían la forma canónica: `max(...)::int + 1` convertido a texto no
-- lleva ceros a la izquierda y empieza en 1.
create function numero_de_serie(p_codigo text) returns int
language sql immutable strict as $$ select substring(p_codigo from '[0-9]+$')::int $$;
revoke execute on function numero_de_serie(text) from public;
-- Las dos lecturas corren como el rol de la app, así que necesita el grant.
grant execute on function numero_de_serie(text) to designio_app;

-- ── El CÓDIGO DE SERIE lo pone la BASE, nunca el que inserta ──
-- El siguiente código sale de un max() sobre la propia tabla. Mientras el valor lo escribía
-- el llamante, ese max() dependía de un dato que el llamante controla — y con el tope
-- canónico de nueve dígitos eso se vuelve un cierre PERMANENTE: basta una fila con
-- 'DV-999999999', que es perfectamente válida, para que toda creación posterior calcule diez
-- dígitos y el CHECK la rechace. Las design versions no se borran y `codigo` no está en el
-- grant de UPDATE, así que el workspace se queda sin poder crear versiones para siempre, sin
-- intervención del dueño.
--
-- Acotar más el tope no arregla eso: mueva donde mueva el límite, quien escribe el dato
-- decide si el resto puede seguir trabajando. Lo que lo cierra por construcción es que el
-- valor deje de venir de fuera. Es la misma doctrina que `aprobado_en` —«el sello lo pone la
-- BASE, no el caller»— y que `previo_a_design_version`: lo que solo debe escribir la base no
-- se le pide al que inserta, se le impone.
--
-- Se SOBRESCRIBE en vez de exigir que venga nulo: así da igual lo que mande el insert —el
-- servicio, un script, una consola—, y no hay ninguna forma de colar un código elegido.
--
-- El nombre importa y por eso son `codigo_de_*`: los triggers BEFORE de una tabla disparan en
-- orden alfabético, y `effective_state_alta` es BEFORE y arma su evento de dominio con
-- `new.codigo`. Con la 'c' por delante de la 'e' este corre primero y aquel ve el código
-- definitivo. Los de design version y release son AFTER, así que ahí el orden ya daba igual.
create function asignar_codigo_de_serie() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_siguiente int;
  v_previo uuid;
begin
  -- ── PRIMERO el candado que va ANTES en el orden canónico, y por eso no depende del nombre ──
  -- Este trigger no es el único BEFORE que toma candados en su tabla: en `design_version`
  -- convive con el de anclaje, que toma el del RETO. Los BEFORE disparan en orden alfabético,
  -- así que confiar en el nombre para que salgan en el orden canónico es frágil — y de hecho
  -- se rompió: `codigo_de_design_version` iba antes que `design_version_anclaje`, o sea
  -- codigo-dv antes que reto, al revés que `crearDesignVersion`. Interbloqueo.
  --
  -- En vez de renombrar —que solo mueve la fragilidad de sitio y ya dependía del nombre en
  -- tres puntos—, cada tomador de candado adquiere aquí el PREFIJO canónico que le
  -- corresponde. Así el orden sale igual dispare quien dispare primero, y renombrar un
  -- trigger deja de poder invertirlo:
  --
  --   design_version  → reto      (crearDesignVersion:      reto → codigo-dv)
  --   release         → servicio  (planificarRelease:       servicio → codigo-rl → release)
  --   effective_state → release   (constatarEffectiveState: release → codigo-es)
  --
  -- Para quien entra por el servicio son no-ops: ya los tiene tomados.
  if tg_table_name = 'design_version' then
    select p.reto_id into v_previo from proyecto p
      where p.id = new.proyecto_id and p.workspace_id = new.workspace_id;
    if v_previo is not null then
      perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_previo, 42));
    end if;
  elsif tg_table_name = 'release' then
    select dv.servicio_id into v_previo from design_version dv
      where dv.id = new.design_version_id and dv.workspace_id = new.workspace_id;
    if v_previo is not null then
      perform pg_advisory_xact_lock(hashtextextended('designio:design-version:' || v_previo, 42));
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended('designio:release:' || new.release_id, 42));
  end if;
  -- Y ahora sí, el candado de la SERIE. `max()+1` sobre la propia tabla es una lectura que otra
  -- transacción invalida escribiendo: sin candado, dos altas por SQL directo calculan el
  -- mismo número y una cae contra el único. Es un fallo y no una corrupción —la misma
  -- distinción que justifica el SECURITY DEFINER de abajo—, pero es evitable y la causa es la
  -- de siempre: la cita vivía solo en el servicio, y el SQL directo está concedido.
  --
  -- Es la MISMA clave que `bloquearSerie` y va en el mismo sitio del orden canónico, así que
  -- para quien entra por el servicio esto es un no-op: ya lo tiene tomado.
  perform pg_advisory_xact_lock(
    hashtextextended('designio:codigo-' || lower(tg_argv[0]) || ':' || new.workspace_id, 42));
  -- SECURITY DEFINER a propósito: el máximo tiene que verse ENTERO. Si una política ocultara
  -- filas, la serie repetiría un número que el índice único rechazaría — un fallo en vez de
  -- una corrupción, pero un fallo evitable.
  execute format(
      'select coalesce(max(numero_de_serie(codigo)), 0) + 1 from %I where workspace_id = $1',
      tg_table_name)
    into v_siguiente
    using new.workspace_id;
  new.codigo := tg_argv[0] || '-' || v_siguiente;
  return new;
end $$;
revoke execute on function asignar_codigo_de_serie() from public;
create trigger codigo_de_design_version before insert on design_version
  for each row execute function asignar_codigo_de_serie('DV');
create trigger codigo_de_release before insert on release
  for each row execute function asignar_codigo_de_serie('RL');
create trigger codigo_de_effective_state before insert on effective_state
  for each row execute function asignar_codigo_de_serie('ES');

-- ── El EFFECTIVE STATE VIGENTE de un servicio (RF-06.10) ──
-- La constatación más reciente de todas las que dejaron sus releases VERIFICADOS, cuelguen
-- de la design version que cuelguen: el estado es del SERVICIO, no de la versión. Un release
-- de DV-1 que ya salió cambió el servicio de verdad aunque DV-2 lo haya reemplazado en el
-- papel, y su constatación es lo que mete ese cambio en el estado contra el que se calculan
-- los diffs siguientes.
--
-- `p_excluir_dv` está por el único lector que necesita apartar algo: el detalle de una design
-- version calcula su diff contra «lo que hay SIN contar lo mío», así que excluye sus propios
-- effective states. El árbol no aparta nada y pasa null. Es UN parámetro y no dos funciones
-- porque lo que tiene que ser idéntico —cuál es el más reciente— es justo lo que se comparte;
-- si cada lector eligiera por su cuenta volveríamos a tener dos verdades sobre el mismo
-- estado, que es el fallo que este esquema ya se ha comido dos veces (ver
-- `gate_certificado_del_proyecto` y `g7_motivo_de_bloqueo`).
--
-- El desempate del mismo día es por NÚMERO DE SERIE y no por el sello, por lo que explica
-- `numero_de_serie` ahí arriba.
create function effective_state_vigente_del_servicio(
  p_servicio uuid, p_workspace uuid, p_excluir_dv uuid default null
) returns uuid language sql stable as $$
  select es.id
  from effective_state es
  join release r on r.id = es.release_id and r.workspace_id = es.workspace_id
  where es.servicio_id = p_servicio and es.workspace_id = p_workspace
    and r.estado = 'verificado'
    and (p_excluir_dv is null or r.design_version_id <> p_excluir_dv)
  order by es.constatado_en desc, numero_de_serie(es.codigo) desc
  limit 1
$$;
revoke execute on function effective_state_vigente_del_servicio(uuid, uuid, uuid) from public;
-- La llaman el detalle de la design version y el ÁRBOL, los dos como el rol de la app. No es
-- SECURITY DEFINER: leer effective_state desde ella pasa por su política de siempre, así que
-- el árbol no puede ver por aquí un estado que su RLS le negaría por la puerta principal.
grant execute on function effective_state_vigente_del_servicio(uuid, uuid, uuid) to designio_app;

-- ── Constatación por elemento, con la desviación dentro (RF-06.6, SYS-07) ──
-- La «Desviación» del modelo NO es otra tabla: es una constatación cuyo resultado no es
-- 'como-aprobado'. Separarlas permitiría constatar un elemento como desviado sin
-- desviación, que es justo el estado que SYS-07 prohíbe.
create table constatacion (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  effective_state_id uuid not null,
  elemento_id uuid not null,
  resultado text not null check (resultado in ('como-aprobado', 'desviado', 'no-implementado')),
  que_quedo_distinto text not null default '',
  razon text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (effective_state_id, elemento_id),
  foreign key (effective_state_id, workspace_id) references effective_state (id, workspace_id),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  -- SYS-07 como CHECK y no como validación del servicio: toda desviación registra el
  -- elemento (la FK) y una razón NO VACÍA. btrim porque el whitespace no es una razón.
  check (resultado = 'como-aprobado'
    or (btrim(que_quedo_distinto) <> '' and btrim(razon) <> '')),
  -- Y al revés: «como aprobado» con texto de desviación sería una desviación escondida.
  check (resultado <> 'como-aprobado'
    or (btrim(que_quedo_distinto) = '' and btrim(razon) = ''))
);
create index constatacion_es_idx on constatacion (workspace_id, effective_state_id);
create index constatacion_elemento_idx on constatacion (workspace_id, elemento_id);

-- ¿De qué design versions responde ESTE proyecto ante sus gates? La pregunta del gate y la
-- pregunta de la supersión son distintas, y durante un tiempo las contestó el mismo filtro:
--
--   · el GATE pregunta por el trabajo DEL PROYECTO — qué declaró cambiar y qué hizo con
--     ello. Es lo que G6 firma (plan) y lo que G7 concilia.
--   · `estado = 'aprobada'` contesta otra cosa: cuál es la versión que gobierna EL SERVICIO
--     ahora mismo (SYS-05, y por eso el índice único parcial es por servicio).
--
-- Confundirlas dejaba al proyecto A INCERTIFICABLE en cuanto otro proyecto B superaba su
-- versión —flujo soportado, porque `supera_a` está restringido por servicio y no por
-- proyecto—: DV-A salía de los chequeos de A, G6 decía que A no tiene plan y G7 que no
-- tiene tablero, aunque el trabajo de A estuviera entero. Y abrir una tercera versión no
-- arreglaba nada: solo trasladaba el bloqueo al proyecto siguiente. Que alguien supere
-- DV-A no deshace el plan de A ni sus constataciones; solo deja de ser la que manda.
--
-- Lo que SÍ saca a una versión del conjunto es que EL PROPIO PROYECTO la haya reemplazado:
-- si A aprobó DV-1 y después DV-2, los elementos de DV-1 que nadie planificó son decisiones
-- que A mismo sustituyó, y exigirles release o constatación ataría sus gates a un ciclo que
-- el proyecto cerró a conciencia. Esa es la distinción que faltaba: no «superada», sino
-- «superada POR MÍ».
--
-- Lo que dejó EN VUELO una versión superada —por quien sea— es harina de otro costal y lo
-- sigue mirando G7 aparte: un release desplegado sin constatar cambia el estado del
-- servicio aunque la decisión que lo motivó ya esté reemplazada.
create function design_versions_a_cargo_del_proyecto(p_proyecto uuid, p_workspace uuid)
returns setof uuid language sql stable as $$
  select dv.id
  from design_version dv
  where dv.proyecto_id = p_proyecto and dv.workspace_id = p_workspace
    and dv.estado <> 'borrador'
    and not exists (
      select 1 from design_version suc
      where suc.supera_a = dv.id and suc.workspace_id = dv.workspace_id
        and suc.proyecto_id = p_proyecto and suc.estado <> 'borrador')
$$;
revoke execute on function design_versions_a_cargo_del_proyecto(uuid, uuid) from public;
-- Las políticas de `release` y `release_elemento` la evalúan como el rol de la app, así que
-- necesita el grant. No es SECURITY DEFINER: leer design_version desde ella pasa por la
-- política de siempre, la misma que esas políticas ya atravesaban con su propio `exists`.
grant execute on function design_versions_a_cargo_del_proyecto(uuid, uuid) to designio_app;

-- Las design versions SUPERADAS por cuyo vuelo responde la conciliación de este proyecto:
-- las suyas propias, y las que sus versiones REEMPLAZARON —directa o transitivamente—,
-- porque la cadena de versiones de un servicio atraviesa proyectos y el effective state es
-- del servicio, no del proyecto. Se escribe una vez porque la usan las DOS mitades de la
-- regla de G7, que distinguen según quién las superó.
--
-- El ámbito es LINAJE, y llegar aquí costó equivocarse por los DOS lados:
--
--  · Demasiado ESTRECHO al principio. Se derivaba de «los servicios de los que el proyecto
--    tiene la aprobada VIGENTE», y eso se rompe un eslabón más arriba: en A → B → C, cuando
--    C supera a la de B, B deja de tener aprobada de ese servicio, el brazo se queda vacío
--    y la de A se cae del ámbito de B — que entonces certificaba G7 sin responder por el
--    trabajo abierto de A.
--  · Demasiado ANCHO después. «Todas las superadas del SERVICIO del que respondo» se traga
--    a los DESCENDIENTES: en A → B → C → D, en cuanto D supera a la de C, la de C entra en
--    el ámbito de B. Y la de C no es trabajo que B heredara: es POSTERIOR a B.
--
-- Lo que delata que lo ancho estaba mal es que el resultado del gate de B cambiaba por un
-- hecho SIN NINGUNA RELACIÓN CON B: esa misma versión de C, igual de sin resolver, no
-- bloqueaba a B mientras era la vigente, y empezaba a bloquearlo en cuanto D la superaba.
-- Un G7 que se vuelve inaprobable por lo que hagan los ciclos siguientes no es una
-- certificación.
--
-- Las dos veces el error fue el mismo: nombrar el ámbito por una propiedad del SERVICIO
-- cuando lo que se quiere decir es una relación de LINAJE. «De qué responde B» es «lo que B
-- reemplazó», directa o transitivamente, así que se recorre `supera_a` HACIA ATRÁS desde el
-- conjunto de responsabilidad de B. Entra la de A y no entra la de C, y el resultado deja
-- de depender de quién esté aprobado hoy — que es lo que hacía saltar el ámbito de un lado
-- a otro sin que B tocara nada.
--
-- Y el linaje SÍ recoge a un tercero cuando de verdad se hereda: si B vuelve a tomar el
-- servicio más tarde (A → B1 → C1 → B2), B2 reemplazó a la de C1, así que C1 entra en el
-- ámbito de B. Lo que decide no es de quién es la versión, sino si la versión de la que
-- respondo la reemplazó.
--
-- No hace falta acotar el recorrido por servicio: `supera_a` solo apunta a versiones del
-- MISMO servicio (lo exige design_version_anclaje_guard), así que no puede salirse.
--
-- El camino acumulado no es decoración. Hoy el grafo no admite ciclos —`supera_a` se fija
-- al nacer y apunta a una versión que ya existe—, pero un UPDATE directo por SQL podría
-- cerrar uno, y sin la comprobación el `with recursive` no terminaría: el gate se COLGARÍA
-- en lugar de rechazar, que es el peor de los dos fallos. Con ella, un ciclo simplemente
-- corta el recorrido.
create function design_versions_superadas_del_ambito(p_proyecto uuid, p_workspace uuid)
returns setof uuid language sql stable as $$
  with recursive linaje as (
    select dv.id, dv.supera_a, array[dv.id] as camino
    from design_version dv
    where dv.workspace_id = p_workspace
      and dv.id in (select design_versions_a_cargo_del_proyecto(p_proyecto, p_workspace))
    union all
    select ant.id, ant.supera_a, l.camino || ant.id
    from linaje l
    join design_version ant on ant.id = l.supera_a and ant.workspace_id = p_workspace
    where not ant.id = any(l.camino)
  )
  select dv.id
  from design_version dv
  where dv.workspace_id = p_workspace and dv.estado = 'superada'
    and (dv.proyecto_id = p_proyecto or dv.id in (select id from linaje))
$$;
revoke execute on function design_versions_superadas_del_ambito(uuid, uuid) from public;

-- POR QUÉ está bloqueado G7 en este proyecto, o null si no lo está. Una sola redacción del
-- predicado para los dos que lo necesitan: el guard, que la levanta como excepción al
-- intentar aprobar, y la pantalla de conciliación, que la enseña antes de que el lead se
-- estrelle contra el gate.
--
-- Escribirla dos veces era el fallo de siempre y ya se cobró su ronda: la regla creció a
-- cuatro ramas y el espejo de la pantalla se quedó copiando una, así que una versión
-- auto-superada con un release en vuelo se pintaba como «no bloquea» mientras la base la
-- rechazaba. Mientras haya dos redacciones, la siguiente que falte es cuestión de tiempo.
--
-- El orden del CASE es el orden en que conviene leerlas: primero si hay tablero, luego lo
-- propio, y al final lo que arrastra la cadena del servicio.
create function g7_motivo_de_bloqueo(p_proyecto uuid, p_workspace uuid)
returns text language sql stable as $$
  select case
    when not exists (
      select 1 from design_version dv
      where dv.id in (select design_versions_a_cargo_del_proyecto(p_proyecto, p_workspace))
        and exists (select 1 from elemento_cambio ec
          where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id))
      then 'el proyecto no tiene ninguna design version con elementos que conciliar (RF-06.7)'
    when exists (
      select 1 from elemento_cambio ec
      where ec.workspace_id = p_workspace
        and ec.design_version_id in (
          select design_versions_a_cargo_del_proyecto(p_proyecto, p_workspace))
        and not exists (
          select 1 from constatacion c
          join effective_state es on es.id = c.effective_state_id and es.workspace_id = c.workspace_id
          join release r on r.id = es.release_id and r.workspace_id = es.workspace_id
          where c.elemento_id = ec.id and c.workspace_id = ec.workspace_id
            and r.estado = 'verificado'))
      then 'hay elementos de la design version en estado desconocido (RF-06.7)'
    when exists (
      select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where dv.id in (select design_versions_superadas_del_ambito(p_proyecto, p_workspace))
        and dv.id in (select design_versions_a_cargo_del_proyecto(dv.proyecto_id, dv.workspace_id))
        and not exists (
          select 1 from constatacion c
          join effective_state es on es.id = c.effective_state_id and es.workspace_id = c.workspace_id
          join release r on r.id = es.release_id and r.workspace_id = es.workspace_id
          where c.elemento_id = ec.id and c.workspace_id = ec.workspace_id
            and r.estado = 'verificado'))
      then 'una design version superada del servicio sigue siendo responsabilidad de su proyecto y tiene elementos sin resolver (RF-06.7)'
    when exists (
      select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      join release_elemento re on re.elemento_id = ec.id and re.workspace_id = ec.workspace_id
      join release r on r.id = re.release_id and r.workspace_id = re.workspace_id
      where dv.id in (select design_versions_superadas_del_ambito(p_proyecto, p_workspace))
        and dv.id not in (select design_versions_a_cargo_del_proyecto(dv.proyecto_id, dv.workspace_id))
        and r.estado <> 'verificado')
      then 'una design version superada dejó releases sin resolver (RF-06.7)'
  end
$$;
revoke execute on function g7_motivo_de_bloqueo(uuid, uuid) from public;
-- La pantalla de conciliación la llama para decir lo mismo que dirá el gate. No es SECURITY
-- DEFINER: lee bajo las políticas del rol de la app, las mismas con las que ya dibuja el
-- tablero.
-- `g7_motivo_de_bloqueo` no es SECURITY DEFINER, así que las dos que llama por dentro se
-- ejecutan también como el rol de la app: necesitan su grant. El de
-- `design_versions_a_cargo_del_proyecto` ya está más arriba, dado para las políticas.
grant execute on function g7_motivo_de_bloqueo(uuid, uuid) to designio_app;
grant execute on function design_versions_superadas_del_ambito(uuid, uuid) to designio_app;

-- ══ RLS ══
-- Lectura: todo miembro. La cadena evidencia→resultado es lo que el cliente audita; un
-- effective state que el sponsor no puede leer no demuestra nada.
-- Escritura: el LEAD opera el método (§13.2). Los elementos de cambio los escriben los
-- curadores (lead/diseñador: producen el artefacto); el plan de releases, el despliegue
-- y la constatación son del lead. El sponsor aprueba GATES (G5/G6/G7), no objetos: su
-- palanca sobre una design version es no aprobar el gate que la certifica.

alter table design_version enable row level security;
alter table elemento_cambio enable row level security;
alter table elemento_decision enable row level security;
alter table elemento_insight enable row level security;
alter table release enable row level security;
alter table release_elemento enable row level security;
alter table effective_state enable row level security;
alter table constatacion enable row level security;

create policy design_version_select on design_version
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy elemento_cambio_select on elemento_cambio
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy elemento_decision_select on elemento_decision
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy elemento_insight_select on elemento_insight
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy release_select on release
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy release_elemento_select on release_elemento
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy effective_state_select on effective_state
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy constatacion_select on constatacion
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- La DV nace en BORRADOR y sin sellos: la política lo exige, así que no existe el camino
-- de colar una versión ya «aprobada» sin pasar por la transición que congela.
create policy design_version_insert on design_version
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'borrador'
    and aprobada_por is null
    and aprobada_en is null
    and snapshot_id is null
  );

-- Aprobar: borrador → aprobada, atribuida, CON snapshot congelado. El snapshot se
-- inserta en una sentencia anterior de la misma transacción, así que este predicado ya
-- lo ve: la congelación de RF-06.3 es parte del permiso, no una cortesía del servicio.
create policy design_version_aprobar on design_version
  for update
  using (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  )
  with check (
    estado = 'aprobada'
    and aprobada_por = app_user_id()
    and aprobada_en is not null
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from journey_snapshot s
      where s.id = design_version.snapshot_id
        and s.workspace_id = design_version.workspace_id
        and s.journey_id = design_version.journey_id)
  );

-- Superar: aprobada → superada. Es el otro lado de SYS-05 y lo ejecuta la misma
-- transacción que aprueba la sucesora.
create policy design_version_superar on design_version
  for update
  using (
    estado = 'aprobada'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  )
  with check (
    estado = 'superada'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );

-- Enlazar el journey to-be DESPUÉS de abrir el borrador. `journey_id` es opcional en
-- borrador a propósito (la DV puede abrirse antes de que el to-be exista), pero sin este
-- camino esa opción era una trampa: el borrador que nacía sin journey no podía aprobarse
-- —aprobar congela el snapshot, y sin grafo no hay snapshot— ni borrarse —no hay DELETE
-- sobre design_version, porque los cuatro objetos de resultado son el registro de lo que
-- pasó—, así que se quedaba muerto en la lista para siempre.
--
-- Alcanza SOLO borradores: una design version aprobada es inmutable y su snapshot ya
-- congeló el grafo que aprobó; reapuntarla a otro journey reescribiría a qué se
-- comprometió. Y el grant por columna (más abajo) deja fuera todo lo demás, así que
-- «de una DV en borrador solo se puede reenlazar el journey» es estructural, no una
-- disciplina del servicio.
--
-- El USING que esto abre (borrador + curador) puede emparejarse con el WITH CHECK de
-- otra política —así funciona la RLS: los predicados se OR-ean entre políticas— pero no
-- abre ninguna transición nueva: 'borrador' → 'superada' ya era emparejable con el USING
-- de design_version_aprobar, y lo que la cierra es el CHECK de la tabla (una no-borrador
-- exige sellos) y `design_version_transicion_guard`, que enumera los pares legales.
create policy design_version_enlazar_journey on design_version
  for update
  using (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

-- Criterio de aceptación 1: sobre una DV aprobada, editar un elemento se RECHAZA. No es
-- un chequeo del servicio con un mensaje amable — es que las tres políticas del elemento
-- solo alcanzan design versions en borrador.
create policy elemento_cambio_insert on elemento_cambio
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_cambio_update on elemento_cambio
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  )
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_cambio_delete on elemento_cambio
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  );

create policy elemento_decision_insert on elemento_decision
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_decision.elemento_id
        and ec.workspace_id = elemento_decision.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_decision_delete on elemento_decision
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_decision.elemento_id
        and ec.workspace_id = elemento_decision.workspace_id
        and dv.estado = 'borrador')
  );

create policy elemento_insight_insert on elemento_insight
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_insight.elemento_id
        and ec.workspace_id = elemento_insight.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_insight_delete on elemento_insight
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_insight.elemento_id
        and ec.workspace_id = elemento_insight.workspace_id
        and dv.estado = 'borrador')
  );

-- SYS-06 en la política de alta: un release solo cuelga de una design version que su
-- proyecto todavía tiene que cerrar. Nace planificado y sin fecha real (las filas nacen en
-- su estado inicial).
--
-- «Que su proyecto todavía tiene que cerrar» y no «aprobada» a secas, y la diferencia no es
-- un matiz: si el proyecto B supera la versión de A antes de que A firme su G6, la versión
-- de A sigue en la responsabilidad de A —lo dice design_versions_a_cargo_del_proyecto, y de
-- eso depende que A pueda certificar— pero pasa a 'superada'. Con el filtro anterior, A no
-- podía planificar el release del elemento que le faltaba ni asignarlo, así que su G6 se
-- volvía inalcanzable: la regla que le devolvía el trabajo le quitaba la forma de cerrarlo.
--
-- Lo que se sigue prohibiendo es lo que la regla vino a prohibir: colgar trabajo nuevo de
-- una versión que EL PROPIO PROYECTO reemplazó. Eso sí es un ciclo cerrado a conciencia, y
-- ahí un release sin resolver bloquearía G7 sin que nadie lo hubiera pedido.
create policy release_insert on release
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and estado = 'planificado'
    and desplegado_en is null
    and exists (select 1 from design_version dv
      where dv.id = release.design_version_id
        and dv.workspace_id = release.workspace_id
        and dv.id in (
          select design_versions_a_cargo_del_proyecto(dv.proyecto_id, dv.workspace_id)))
  );
create policy release_desplegar on release
  for update
  using (estado = 'planificado' and workspace_role(app_user_id(), workspace_id) = 'lead-boutique')
  with check (
    estado = 'desplegado'
    and desplegado_en is not null
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );
create policy release_verificar on release
  for update
  using (estado = 'desplegado' and workspace_role(app_user_id(), workspace_id) = 'lead-boutique')
  with check (
    estado = 'verificado'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );

-- El alcance de un release se declara mientras está PLANIFICADO. Una vez desplegado,
-- mover elementos dentro o fuera reescribiría qué se implementó.
--
-- AÑADIR alcance exige además que la design version padre siga siendo de las que su
-- proyecto tiene que cerrar. Sin eso, una pantalla cargada antes de la supersión seguía
-- pudiendo meter trabajo nuevo en una versión ya reemplazada: la política solo miraba el
-- release, y el release no cambia de estado cuando su versión es superada. Desde el arreglo
-- de G7 eso no es inocuo — un release sin resolver de una versión superada BLOQUEA la
-- certificación del proyecto—, así que la puerta se cierra donde se abre.
--
-- «Reemplazada» significa aquí reemplazada POR SU PROPIO PROYECTO (mismo conjunto que usan
-- G6, G7 y el guard de cobertura). Si la superó otro proyecto, la versión sigue contando
-- para los gates de éste y por tanto tiene que poder terminar su plan: negarle el alcance
-- dejaba su G6 inalcanzable, que es cerrar la puerta y quedarse la llave.
--
-- QUITAR alcance no lo exige, y la asimetría es deliberada: es exactamente la salida que
-- G7 deja al lead para cerrar lo que la versión superada dejó en vuelo («esto ya no va a
-- salir» = se le quita el alcance al release planificado, y entonces no puede desplegarse
-- nunca). Exigir aquí la versión aprobada dejaría ese trabajo sin forma de cerrarse y el
-- gate bloqueado para siempre. Añadir es abrir trabajo nuevo; quitar es cerrar lo abierto.
create policy release_elemento_insert on release_elemento
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and exists (select 1 from release r
      join design_version dv on dv.id = r.design_version_id and dv.workspace_id = r.workspace_id
      where r.id = release_elemento.release_id
        and r.workspace_id = release_elemento.workspace_id
        and r.estado = 'planificado'
        and dv.id in (
          select design_versions_a_cargo_del_proyecto(dv.proyecto_id, dv.workspace_id)))
  );
create policy release_elemento_delete on release_elemento
  for delete using (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from release r
      where r.id = release_elemento.release_id
        and r.workspace_id = release_elemento.workspace_id
        and r.estado = 'planificado')
  );

-- Constatar exige un release DESPLEGADO: no se certifica lo que no salió. Sin update ni
-- delete en ninguna de las dos tablas: la constatación es historia (RF-06.6).
create policy effective_state_insert on effective_state
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and constatado_por = app_user_id()
    and exists (select 1 from release r
      where r.id = effective_state.release_id
        and r.workspace_id = effective_state.workspace_id
        and r.estado = 'desplegado')
  );
create policy constatacion_insert on constatacion
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and exists (select 1 from effective_state es
      join release r on r.id = es.release_id and r.workspace_id = es.workspace_id
      where es.id = constatacion.effective_state_id
        and es.workspace_id = constatacion.workspace_id
        and r.estado = 'desplegado')
  );

-- ══ Guards ══

-- El nodo que materializa un elemento tiene que ser del grafo que la design version
-- aprueba. La FK compuesta garantiza el workspace y nada más: sin esto, un elemento de
-- la DV del servicio A podría apuntar a un paso del journey del servicio B y la
-- respuesta a «qué pasos afectó RL-1» saldría mintiendo.
create function elemento_cambio_nodo_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_journey uuid;
  v_catalogo uuid;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.nodo_id is null then
    return new;
  end if;
  select dv.journey_id into v_journey from design_version dv
    where dv.id = new.design_version_id and dv.workspace_id = new.workspace_id;
  if v_journey is null then
    raise exception 'para enlazar un nodo, la design version debe declarar su journey to-be';
  end if;
  if not exists (select 1 from journey_nodo n
    where n.id = new.nodo_id and n.workspace_id = new.workspace_id
      and n.journey_id = v_journey) then
    raise exception 'el nodo enlazado no pertenece al journey de esta design version';
  end if;
  -- La mitad de la unicidad de identidad que no cabe en un índice: el CATÁLOGO no es una
  -- columna de esta tabla, es del nodo. Dos nodos distintos del mismo journey pueden
  -- apuntar a la misma entrada —el mismo touchpoint en dos momentos del recorrido, que es
  -- legítimo—, y entonces los dos elementos comparten identidad lógica igual que si
  -- compartieran nodo (el primer escalón de «clave» es el catálogo, por delante del nodo).
  --
  -- Se comprueba aquí y no en un constraint porque no hay constraint que lo exprese; y es
  -- correcto hacerlo en un guard porque TODA mutación de elementos toma antes el candado de
  -- su design version, así que dos altas concurrentes no pueden cruzarse.
  select n.catalogo_id into v_catalogo from journey_nodo n
    where n.id = new.nodo_id and n.workspace_id = new.workspace_id;
  if v_catalogo is not null and exists (
    select 1 from elemento_cambio ec
    join journey_nodo n2 on n2.id = ec.nodo_id and n2.workspace_id = ec.workspace_id
    where ec.design_version_id = new.design_version_id
      and ec.workspace_id = new.workspace_id
      and ec.id <> new.id
      and n2.catalogo_id = v_catalogo
  ) then
    raise exception 'otro elemento de esta design version ya cambia esa entrada de catálogo: descríbelo en UN elemento (el estado efectivo no sabe plegar dos)';
  end if;
  return new;
end $$;
create trigger elemento_cambio_nodo
  before insert or update on elemento_cambio
  for each row execute function elemento_cambio_nodo_guard();
revoke execute on function elemento_cambio_nodo_guard() from public;

-- ══ UN ELEMENTO SOLO ENTRA EN UN BORRADOR (SYS-05) ══
-- La política del elemento ya exige que su design version esté en borrador, pero una política
-- es un predicado sobre una INSTANTÁNEA, y la de una sentencia se toma cuando la sentencia
-- empieza. Aprobar y añadir un elemento escriben tablas DISTINTAS —design_version y
-- elemento_cambio—, así que ningún candado de fila las cruza: la aprobación cuenta los
-- elementos que ve y los valida, la inserción ve 'borrador', y las dos commitean. Queda un
-- elemento DENTRO de una versión ya congelada sin haber pasado por ninguna de las
-- comprobaciones de la aprobación.
--
-- Lo que eso rompe, desde que G5 exige una design version aprobada para firmarse: **la firma
-- del cliente pasa a cubrir algo que el cliente no vio**. No es solo una versión inmutable
-- con un nodo fuera de su snapshot —que también, y esa no se puede arreglar nunca porque la
-- versión ya no se edita—: es una certificación humana cuyo contenido cambió por detrás.
--
-- Y el candado SOLO no basta, que es lo que obliga a que esto sea diferido. Si el candado se
-- tomara en el trigger BEFORE del elemento, la inserción esperaría a la aprobación… y después
-- seguiría evaluando su política con la instantánea que tomó al EMPEZAR la sentencia, o sea
-- viendo 'borrador' igual. Hace falta una sentencia NUEVA después de que la otra commitee, y
-- eso es exactamente lo que es un constraint trigger diferido.
--
-- El candado va PRIMERO por lo mismo que en los otros dos pares: dos diferidos que se miran
-- sin verse pasan los dos. La clave es la del servicio ('designio:dv-elemento:' || id), que ya
-- serializa aprobar contra toda mutación de elementos — solo que hasta ahora únicamente para
-- quien entraba por el servicio.
--
-- Es el ÚNICO constraint trigger de elemento_cambio, así que aquí no hay orden alfabético que
-- respetar; si algún día entra otro que tome un candado distinto, hay que colocarlo según el
-- orden canónico del módulo (reto → dv-elemento → …), como ya pasa en release_elemento.
--
-- Si la versión ya no existe no hay nada que proteger: el desmontaje que se lleva versión y
-- elementos en la misma transacción es legítimo.
create function elemento_cambio_version_editable_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dv uuid;
  v_ws uuid;
  v_elemento uuid;
  v_estado text;
begin
  -- Sirve a TRES tablas: el elemento y sus dos enlaces de motivación. Los enlaces tenían el
  -- mismo agujero y por la misma razón —su política mira `dv.estado = 'borrador'` con un
  -- exists sobre otra tabla, o sea con la instantánea del inicio de la sentencia—, así que
  -- el rastro de una versión ya inmutable podía cambiar después de congelarse. Y el rastro
  -- ES el producto: RF-06.9 lo recorre en los dos sentidos.
  if tg_table_name = 'elemento_cambio' then
    if tg_op = 'DELETE' then
      v_dv := old.design_version_id;
      v_ws := old.workspace_id;
    else
      v_dv := new.design_version_id;
      v_ws := new.workspace_id;
    end if;
  else
    if tg_op = 'DELETE' then
      v_elemento := old.elemento_id;
      v_ws := old.workspace_id;
    else
      v_elemento := new.elemento_id;
      v_ws := new.workspace_id;
    end if;
    select ec.design_version_id into v_dv from elemento_cambio ec
      where ec.id = v_elemento and ec.workspace_id = v_ws;
    if v_dv is null then
      return null;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('designio:dv-elemento:' || v_dv, 42));
  select dv.estado into v_estado from design_version dv
    where dv.id = v_dv and dv.workspace_id = v_ws;
  if v_estado is not null and v_estado <> 'borrador' then
    raise exception 'la design version se aprobó mientras se editaban sus elementos: lo que se congeló no incluye este cambio (SYS-05)';
  end if;
  return null;
end $$;
create constraint trigger elemento_cambio_version_editable
  after insert or update or delete on elemento_cambio
  deferrable initially deferred
  for each row execute function elemento_cambio_version_editable_guard();
create constraint trigger elemento_decision_version_editable
  after insert or delete on elemento_decision
  deferrable initially deferred
  for each row execute function elemento_cambio_version_editable_guard();
create constraint trigger elemento_insight_version_editable
  after insert or delete on elemento_insight
  deferrable initially deferred
  for each row execute function elemento_cambio_version_editable_guard();
revoke execute on function elemento_cambio_version_editable_guard() from public;

-- ══ Y LA IDENTIDAD DE CATÁLOGO, REVALIDADA AL COMMIT ══
-- El escalón del NODO lo cierra un índice único, y un índice único sí es atómico: dos altas
-- concurrentes contra el mismo nodo chocan de verdad. El del CATÁLOGO no puede tener índice
-- —el catálogo no es columna de `elemento_cambio`, es del nodo—, así que lo único que lo
-- sostenía era el guard inmediato de arriba. Y un guard inmediato es ciego a lo que otra
-- transacción tiene a medias: dos curadores insertan elementos para NODOS DISTINTOS que
-- apuntan a la MISMA entrada, ninguno ve al otro, y commitean los dos.
--
-- Queda entonces lo que la unicidad existe para impedir: dos elementos con la misma identidad
-- lógica en una versión, que el pliegue cuenta como uno y G7 como dos.
--
-- Que no haya índice de red es justo lo que hace que ESTE sea el que más necesita el candado,
-- no el que menos. Se revalida al commit, con el mismo candado de la versión que ya toma el
-- guard del borrador — así que para una transacción que toque las dos cosas es un no-op.
create function elemento_cambio_identidad_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_catalogo uuid;
begin
  if new.nodo_id is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('designio:dv-elemento:' || new.design_version_id, 42));
  select n.catalogo_id into v_catalogo from journey_nodo n
    where n.id = new.nodo_id and n.workspace_id = new.workspace_id;
  if v_catalogo is not null and exists (
    select 1 from elemento_cambio ec
    join journey_nodo n2 on n2.id = ec.nodo_id and n2.workspace_id = ec.workspace_id
    where ec.design_version_id = new.design_version_id
      and ec.workspace_id = new.workspace_id
      and ec.id <> new.id
      and n2.catalogo_id = v_catalogo
  ) then
    raise exception 'otro elemento de esta design version ya cambia esa entrada de catálogo: descríbelo en UN elemento (el estado efectivo no sabe plegar dos)';
  end if;
  return null;
end $$;
create constraint trigger elemento_cambio_identidad
  after insert or update on elemento_cambio
  deferrable initially deferred
  for each row execute function elemento_cambio_identidad_guard();
revoke execute on function elemento_cambio_identidad_guard() from public;

-- Lo que MOTIVA un elemento tiene que ser citable de verdad: misma doctrina que
-- checklist_objeto_citable_guard (la decisión, del proyecto de la DV y VIGENTE; el
-- insight, validado). El picker filtra las dos cosas; el endpoint acepta cualquier uuid.
--
-- `vigente` es la mitad barata de la regla y NO es la que cierra el agujero: una decisión
-- se cita estando vigente y una reapertura aguas arriba la pasa a 'en-revision' DESPUÉS
-- (RF-04.9), sin que este guard vuelva a mirarla nunca. Lo que sostiene la cadena
-- «decisión aprobada → design version» es la revalidación al APROBAR, en
-- design_version_transicion_guard. Aquí solo se impide nacer torcido — que es lo que hace
-- que el picker y el endpoint digan lo mismo, igual que en la rama del insight.
create function elemento_motivo_citable_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'elemento_decision' then
    if not exists (
      select 1 from decision d
      join elemento_cambio ec on ec.id = new.elemento_id and ec.workspace_id = new.workspace_id
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where d.id = new.decision_id and d.workspace_id = new.workspace_id
        and d.proyecto_id = dv.proyecto_id and d.estado = 'vigente') then
      raise exception 'la decisión citada no existe en el proyecto de esta design version, o ya no está vigente';
    end if;
  else
    if not exists (select 1 from insight i
      where i.id = new.insight_id and i.workspace_id = new.workspace_id
        and i.estado = 'validado') then
      raise exception 'el insight citado no existe o todavía no está validado';
    end if;
  end if;
  return new;
end $$;
create trigger elemento_decision_citable
  before insert on elemento_decision
  for each row execute function elemento_motivo_citable_guard();
create trigger elemento_insight_citable
  before insert on elemento_insight
  for each row execute function elemento_motivo_citable_guard();
revoke execute on function elemento_motivo_citable_guard() from public;

-- El nodo TAL COMO ERA cuando la design version lo congeló. La aprobación guarda el grafo
-- entero en journey_snapshot.grafo (nodos serializados con to_jsonb, o sea con todas sus
-- columnas), así que la respuesta histórica no depende de que la fila viva siga existiendo
-- ni de que siga diciendo lo mismo.
--
-- Devuelve null cuando la design version aún no tiene snapshot —está en borrador—, y ahí
-- el llamador cae a la fila viva, que es la correcta: un borrador se edita CONTRA el grafo
-- de trabajo, no contra una foto que todavía no existe.
create function nodo_congelado(p_snapshot uuid, p_workspace uuid, p_nodo uuid)
returns jsonb language sql stable as $$
  select nodo
  from journey_snapshot s,
       lateral jsonb_array_elements(s.grafo->'nodos') as nodo
  where s.id = p_snapshot and s.workspace_id = p_workspace
    and nodo->>'id' = p_nodo::text
  limit 1
$$;
revoke execute on function nodo_congelado(uuid, uuid, uuid) from public;
grant execute on function nodo_congelado(uuid, uuid, uuid) to designio_app;

-- ¿Este reto APLICA a este servicio? Anclado en él, o declarado como que lo afecta.
-- Es el MISMO criterio que journey_anclaje_guard (SPEC-05) lleva inline: «aplica» es una
-- definición del dominio, y dos versiones divergentes de ella serían dos verdades sobre el
-- mismo hecho. Aquí se le pone nombre para no volver a escribirla en los dos sitios que la
-- necesitan; cuando el guard del journey se reescriba, debería adoptar esta.
create function reto_aplica_a_servicio(p_reto uuid, p_workspace uuid, p_servicio uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from reto r
    where r.id = p_reto and r.workspace_id = p_workspace
      and (r.servicio_ancla_id = p_servicio
           or exists (select 1 from reto_servicio_afectado rsa
             where rsa.reto_id = r.id and rsa.workspace_id = r.workspace_id
               and rsa.servicio_id = p_servicio)))
$$;
revoke execute on function reto_aplica_a_servicio(uuid, uuid, uuid) from public;

-- ── Perdón histórico: los gates que se firmaron ANTES de que esto existiera ──
-- `design_version` nace en esta migración, así que ningún proyecto tenía una cuando aprobó
-- su G6 o su G7. Sin perdón, todo proyecto que ya los hubiera firmado —perfectamente legal
-- entonces— quedaba encerrado: el guard de alta le prohíbe crear una design version «porque
-- ya certificó», y G7 le exige una con elementos para poder aprobarse. Y la salida que el
-- mensaje ofrece no le sirve: le dice que abra el ciclo siguiente en otro proyecto, pero el
-- G7 que necesita es el SUYO.
--
-- Se perdona EL MOMENTO, no el contenido: la marca dice «esta aprobación es anterior a las
-- reglas de design version», que es un hecho, no una dispensa. El proyecto perdonado redacta
-- su versión ahora y llega a G7 por el camino normal, con todos los guards intactos — G7 le
-- exigirá el tablero completo igual que a cualquiera.
--
-- Y se perdona SOLO el G6 de los proyectos que todavía no han aprobado su G7. Un G7 ya
-- aprobado es una certificación EMITIDA y tiene que seguir contando como tal, precisamente
-- porque no se puede reevaluar: aflojarlo dejaría que se le crearan y aprobaran design
-- versions nuevas por debajo, con sus releases y su conciliación, sin que ese gate inmutable
-- pueda volver a mirarlas. Sería peor que el encierro que esto viene a deshacer — aquel
-- bloquea un proyecto, esto ablandaría una certificación ya firmada.
--
-- DEUDA DECLARADA, la otra mitad de la misma decisión: un proyecto cerrado bajo el esquema
-- viejo se queda como está, certificado y sin design version, y sin poder crear ninguna. Su
-- ciclo terminó antes de que estas reglas existieran y nada de lo que se haga ahora lo va a
-- reconciliar hacia atrás. Si el método quiere reabrir esos ciclos, es una decisión de
-- producto y necesita un mecanismo propio, no un perdón más ancho.
--
-- No es una puerta trasera, y la forma es lo que lo garantiza:
--  · la columna se escribe UNA sola vez, aquí, en el instante del despliegue;
--  · no entra en ningún grant —el de gate_instancia es por columnas y no la incluye—, así
--    que el rol de la app no puede ponerla ni quitarla;
--  · ningún guard la toca, así que el conjunto solo puede encoger (por borrado), nunca
--    crecer: una fila creada después nace en false y el estado que habilitaría es
--    inalcanzable para ella.
--
-- Y no se inventan datos: NO se le fabrica al proyecto una design version con elementos.
-- Sería un contrato vacío afirmando un compromiso que nadie redactó — el mismo motivo por el
-- que el slice de medición descartó rellenar un registry ya firmado.
--
-- DEUDA PARA PRODUCTO: un proyecto perdonado tiene su G6 aprobado sin que nadie haya firmado
-- su plan de releases con las reglas nuevas. Nada lo obliga a redactar la design version que
-- describe lo que ya construyó; solo lo necesitará cuando quiera cerrar G7. Si el método
-- quiere exigir esa reconstrucción, es una decisión de producto, no de esta migración.
alter table gate_instancia add column previo_a_design_version boolean not null default false;
-- perdon-historico:inicio
update gate_instancia g set previo_a_design_version = true
where g.estado = 'aprobado' and g.numero = 6
  and not exists (select 1 from gate_instancia g7
    where g7.proyecto_id = g.proyecto_id and g7.workspace_id = g.workspace_id
      and g7.numero = 7 and g7.estado = 'aprobado');
-- perdon-historico:fin

-- ¿Este proyecto ya CERTIFICÓ un resultado que depende de sus design versions aprobadas?
-- Devuelve el número del gate más bajo que lo hizo, o null.
--
-- Solo G6 y G7, y no es una lista arbitraria: son los dos únicos gates cuyo predicado
-- cuantifica sobre «las design versions APROBADAS de este proyecto» — G6 firma que cada
-- elemento de ellas tiene release (RF-06.4) y G7 que ninguno queda en estado desconocido
-- (RF-06.7). G5 aprueba el diseño pero no afirma nada sobre releases ni constataciones,
-- así que una versión nueva no lo vuelve falso.
--
-- Es un CONJUNTO QUE SE MUEVE, y ahí está el problema que esto sirve: aprobar una sucesora
-- saca de él a la superada y mete a la nueva, con sus elementos sin planificar y sin
-- constatar. La afirmación del gate se vuelve falsa sin que nadie toque el gate.
create function gate_certificado_del_proyecto(p_proyecto uuid, p_workspace uuid)
returns int language sql stable as $$
  select min(g.numero) from gate_instancia g
  where g.proyecto_id = p_proyecto and g.workspace_id = p_workspace
    and g.numero in (6, 7) and g.estado = 'aprobado'
    and not g.previo_a_design_version
$$;
revoke execute on function gate_certificado_del_proyecto(uuid, uuid) from public;
-- La pantalla de alta la llama para no ofrecer proyectos que el guard va a rechazar. Se le
-- da la MISMA función y no una consulta parecida: «qué gate certifica» tiene que decirse en
-- un solo sitio o el picker y el guard acaban discrepando, que es justo el fallo que ya
-- costó una ronda con el vigilante de la cobertura. No es SECURITY DEFINER, así que leer
-- gate_instancia desde el rol de la app pasa por su política de siempre.
grant execute on function gate_certificado_del_proyecto(uuid, uuid) to designio_app;

-- El proyecto que produce la design version y el servicio que cambia tienen que
-- pertenecer al mismo reto. Ninguna FK lo dice: design_version referencia proyecto y
-- servicio por separado, y los dos existen en el workspace.
--
-- Sin esto, una design version del servicio B podía colgar de un proyecto A cuyo reto ni
-- ancla ni declara a B. Y no es cosmético: gate_aprobar_suficiencia_guard acota G7 por
-- `dv.proyecto_id`, así que el proyecto A se certificaría con trabajo hecho para un
-- servicio que su reto no toca — el gate diría «la implementación de A está conciliada»
-- mirando elementos que no son de A.
--
-- La comprobación NO puede delegarse en el journey: un to-be sin proyecto es legítimo
-- (SPEC-05 lo permite y esta migración lo usa), así que el chequeo de anclaje del journey
-- se salta entero cuando `j.proyecto_id is null`. La relación hay que derivarla por el
-- RETO del proyecto, que es donde vive de verdad.
--
-- Aquí también el `supera_a`: la transición exige que la superada sea del MISMO servicio,
-- pero eso se descubría al aprobar, cuando ya es tarde — `supera_a` no está en el grant de
-- columna y no hay DELETE sobre design_version, así que un borrador que apunta a la
-- versión de otro servicio no se puede corregir ni borrar. Igual que el journey sin
-- enlazar: la comprobación se adelanta al nacimiento, que es cuando aún hay salida.
create function design_version_anclaje_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gate int;
  v_reto uuid;
begin
  -- El candado del RETO, antes de nada: más abajo este guard pregunta si el proyecto ya
  -- CERTIFICÓ un gate, y eso es una lectura de gate_instancia que otra transacción puede
  -- invalidar aprobando G6 a la vez. Sin candado compartido, el borrador nace en un proyecto
  -- que acaba certificado — y entonces no se puede aprobar (lo rechaza la transición), ni
  -- borrar, ni mudar de proyecto: el callejón exacto que este guard existe para evitar.
  -- `crearDesignVersion` ya lo tomaba; aquí vale también para el SQL directo.
  select p.reto_id into v_reto from proyecto p
    where p.id = new.proyecto_id and p.workspace_id = new.workspace_id;
  if v_reto is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
  end if;
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- Sobre una versión que ya no es borrador manda el guard de transición, que la declara
    -- inmutable; y si `supera_a` no se mueve no hay nada nuevo que validar.
    if old.estado <> 'borrador' or new.supera_a is not distinct from old.supera_a then
      return new;
    end if;
  else
    -- Solo en el alta: ni `proyecto_id` ni `servicio_id` están en el grant de columna, así
    -- que después de nacer no pueden moverse y revalidarlos sería trabajo muerto.
    if not exists (
      select 1 from proyecto p
      where p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        and reto_aplica_a_servicio(p.reto_id, p.workspace_id, new.servicio_id)) then
      raise exception 'el proyecto de la design version cuelga de un reto que no ancla este servicio ni lo declara afectado';
    end if;
    -- Y que el proyecto no haya certificado ya lo que esta versión volvería falso. La
    -- regla vive en la APROBACIÓN (ver design_version_transicion_guard, que es donde el
    -- conjunto del gate se mueve de verdad); esto es la mitad que se adelanta al
    -- nacimiento, exactamente por el mismo motivo que las dos comprobaciones de arriba:
    -- descubrirlo al aprobar dejaría un borrador que no se puede aprobar —la regla—, ni
    -- borrar —no hay DELETE sobre design_version—, ni mudar de proyecto —`proyecto_id` no
    -- está en el grant de columna—. Aquí todavía hay salida y es barata: elegir el
    -- proyecto del ciclo siguiente.
    v_gate := gate_certificado_del_proyecto(new.proyecto_id, new.workspace_id);
    if v_gate is not null then
      raise exception 'el proyecto ya certificó G%: la design version siguiente va en el proyecto del ciclo siguiente', v_gate;
    end if;
  end if;
  if new.supera_a is not null and not exists (
    select 1 from design_version dv
    where dv.id = new.supera_a and dv.workspace_id = new.workspace_id
      and dv.servicio_id = new.servicio_id) then
    raise exception 'una design version solo supera a otra del MISMO servicio (SYS-05)';
  end if;
  -- Y al revés: si el servicio YA tiene una versión aprobada, la nueva tiene que declarar
  -- a cuál supera. Sin esto el borrador nacía sin `supera_a`, y la aprobación chocaba
  -- mucho más tarde contra el índice único parcial de SYS-05 — con la versión ya escrita y
  -- sin forma de corregirla desde la app hasta que `supera_a` entró en el grant.
  if new.supera_a is null and exists (
    select 1 from design_version dv
    where dv.workspace_id = new.workspace_id and dv.servicio_id = new.servicio_id
      and dv.estado = 'aprobada') then
    raise exception 'este servicio ya tiene una design version aprobada: la nueva debe declarar a cuál supera (SYS-05)';
  end if;
  return new;
end $$;
create trigger design_version_anclaje
  before insert or update on design_version
  for each row execute function design_version_anclaje_guard();
revoke execute on function design_version_anclaje_guard() from public;

-- El journey que una design version declara tiene que ser el to-be de SU servicio, se
-- declare al abrirla o se enlace después. La FK compuesta solo garantiza el workspace: sin
-- esto, un borrador podía nacer apuntando al as-is, o al to-be de otro servicio, y la
-- pantalla anunciaba «to-be: X» hasta que la aprobación —mucho más tarde— lo desmintiera.
-- Misma doctrina que `elemento_motivo_citable_guard`: el picker filtra, pero el endpoint
-- acepta cualquier uuid, así que la regla vive en la base.
--
-- Las mismas dos comprobaciones que hace `design_version_transicion_guard` al aprobar, y
-- ahí siguen: esto adelanta el veredicto al momento del enlace (que es cuando el autor
-- puede corregirlo), no lo sustituye — entre enlazar y aprobar, el journey puede haber
-- cambiado de proyecto.
create function design_version_journey_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.journey_id is null then
    return new;
  end if;
  -- Aprobar y superar no tocan el journey: sin esto, cada transición pagaría dos
  -- consultas por una respuesta que ya no puede haber cambiado.
  if tg_op = 'UPDATE' and new.journey_id is not distinct from old.journey_id then
    return new;
  end if;
  -- Sobre una design version que ya NO estaba en borrador no hay nada que validar aquí:
  -- es inmutable, y ese —no «el journey no es el de tu servicio»— es el veredicto que su
  -- autor tiene que leer. Lo dice design_version_transicion_guard, que corre después
  -- (los triggers de un mismo evento van por orden alfabético de nombre).
  if tg_op = 'UPDATE' and old.estado <> 'borrador' then
    return new;
  end if;
  if not exists (select 1 from journey j
    where j.id = new.journey_id and j.workspace_id = new.workspace_id
      and j.tipo = 'to-be' and j.servicio_id = new.servicio_id) then
    raise exception 'el journey de la design version debe ser el to-be de su servicio';
  end if;
  if exists (select 1 from journey j
    where j.id = new.journey_id and j.workspace_id = new.workspace_id
      and j.proyecto_id is not null and j.proyecto_id <> new.proyecto_id) then
    raise exception 'el journey to-be está anclado a otro proyecto';
  end if;
  -- Cambiar el journey de un borrador que ya enlazó elementos a nodos del anterior
  -- dejaría esos enlaces apuntando fuera del grafo que la design version aprueba: la
  -- respuesta a «qué pasos del journey afectó RL-1» (§19.7) saldría de un grafo que esta
  -- versión no congela. El guard del elemento no puede verlo —solo mira la fila que se
  -- escribe, y aquí no se escribe ninguna—, así que lo mira este. No se limpian solos a
  -- propósito: borrar el trabajo de otro en silencio es peor que pedir que lo revise.
  if tg_op = 'UPDATE' and exists (
    select 1 from elemento_cambio ec
    join journey_nodo n on n.id = ec.nodo_id and n.workspace_id = ec.workspace_id
    where ec.design_version_id = new.id and ec.workspace_id = new.workspace_id
      and n.journey_id <> new.journey_id) then
    raise exception 'hay elementos enlazados a nodos del journey anterior: quita esos enlaces antes de cambiar el journey';
  end if;
  return new;
end $$;
create trigger design_version_journey
  before insert or update on design_version
  for each row execute function design_version_journey_guard();
revoke execute on function design_version_journey_guard() from public;

-- Alta de la design version: rastro con actor y rol del MISMO snapshot que la autorizó.
-- El pre-chequeo deja pasar al owner (seed/backfill) sin fabricar eventos anónimos.
create function design_version_alta_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'DesignVersionBorrador',
      jsonb_build_object('designVersionId', new.id, 'codigo', new.codigo,
                         'servicioId', new.servicio_id, 'proyectoId', new.proyecto_id),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger design_version_alta
  after insert on design_version
  for each row when (new.estado = 'borrador')
  execute function design_version_alta_auditoria();
revoke execute on function design_version_alta_auditoria() from public;

-- SYS-05 en la transición. Los efectos van AQUÍ y no en el servicio para que el UPDATE
-- crudo los produzca igual: sello temporal, exigencias de aprobación y evento.
create function design_version_transicion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gate int;
  v_reto uuid;
begin
  if new.estado = old.estado then
    -- SYS-05 donde no llegan las políticas: una design version que ya no está en borrador
    -- es INMUTABLE, y un UPDATE que no cambia de estado es justo el que las políticas no
    -- pueden rechazar. Los predicados de RLS se OR-ean ENTRE políticas: el USING de
    -- design_version_superar (aprobada + lead) selecciona la fila y el WITH CHECK de
    -- design_version_aprobar (sigue aprobada, mismo autor, con snapshot del journey) la
    -- deja pasar, sin que ninguna de las dos haya autorizado nada — la transición que
    -- cada una describe no está ocurriendo. Por ahí, el lead podía repuntar una versión
    -- aprobada a otro journey con otro snapshot y reescribir a qué se comprometió.
    -- Una política es un predicado sobre un snapshot, no un candado ni una máquina de
    -- estados; la máquina de estados es esto.
    if old.estado <> 'borrador' then
      raise exception 'una design version aprobada es inmutable (SYS-05): crea una versión nueva que la supere';
    end if;
    -- Sobre un BORRADOR sí hay UPDATEs legítimos —enlazar el journey, declarar a quién
    -- supera—, y cada uno tiene su guard. Los dos SELLOS que la aprobación escribe
    -- (`snapshot_id`, `aprobada_por`) están además en el grant de columna, así que se
    -- miró si hacía falta congelarlos aquí: NO hace falta, y por eso no hay regla. El
    -- CHECK de la tabla («estado <> borrador o los tres sellos son null») ya impide
    -- sembrarlos de antemano, que era el ataque —aprobar congelando el snapshot de una
    -- aprobación ANTERIOR del mismo grafo, y certificar así un to-be viejo—. Un CHECK no
    -- se puede emparejar entre políticas ni saltar con una transición legal: es el sitio
    -- más fuerte donde podía estar. Hay test que lo fija.
    return new;
  end if;
  if (old.estado, new.estado) not in (('borrador', 'aprobada'), ('aprobada', 'superada')) then
    raise exception 'transición de design version ilegal: % → %', old.estado, new.estado;
  end if;

  if new.estado = 'aprobada' then
    -- Dos candados, y EN ESTE ORDEN, que es el canónico del módulo (reto → dv-elemento):
    --
    --  · el del RETO, porque esta rama pregunta si el proyecto ya certificó un gate, y eso
    --    es una lectura de gate_instancia que una aprobación de G6 concurrente invalida;
    --  · el de la VERSIÓN, porque es el otro lado del par que cierra
    --    `elemento_cambio_version_editable_guard`: sin él, esta aprobación y una inserción de
    --    elemento se miran sin verse y congelan contenido que estas comprobaciones no vieron.
    --
    -- `aprobarDesignVersion` los toma los dos y en este orden; aquí valen además para el SQL
    -- directo. Invertirlos cerraría un ciclo contra esa misma ruta.
    select p.reto_id into v_reto from proyecto p
      where p.id = new.proyecto_id and p.workspace_id = new.workspace_id;
    if v_reto is not null then
      perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
    end if;
    perform pg_advisory_xact_lock(hashtextextended('designio:dv-elemento:' || new.id, 42));
    -- El sello lo pone la BASE: un update directo no puede retro ni post-datar lo que
    -- desde este instante es inmutable.
    new.aprobada_en := now();
    if new.journey_id is null then
      raise exception 'aprobar congela el snapshot del to-be: la design version debe declarar su journey';
    end if;
    if not exists (select 1 from journey j
      where j.id = new.journey_id and j.workspace_id = new.workspace_id
        and j.tipo = 'to-be' and j.servicio_id = new.servicio_id) then
      raise exception 'el journey de la design version debe ser el to-be de su servicio';
    end if;
    -- El anclaje proyecto↔servicio se comprueba OTRA VEZ al aprobar, y no por
    -- desconfianza del guard de alta: los servicios afectados por un reto se declaran y se
    -- retiran (reto_servicio_afectado no es inmutable), así que una design version que
    -- nació coherente puede dejar de serlo. Aprobar es el momento en que pasa a ser
    -- certificable por G7, y es ahí donde la relación tiene que seguir siendo cierta.
    if not exists (
      select 1 from proyecto p
      where p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        and reto_aplica_a_servicio(p.reto_id, p.workspace_id, new.servicio_id)) then
      raise exception 'el proyecto de la design version ya no cuelga de un reto que afecte a este servicio';
    end if;
    -- El journey guarda su proyecto desde SPEC-05 (es opcional). Si lo declara, tiene
    -- que ser el mismo: dos proyectos del mismo reto tocando el mismo servicio podrían
    -- congelar cada uno el grafo del otro sin que ninguna FK se queje.
    if exists (select 1 from journey j
      where j.id = new.journey_id and j.workspace_id = new.workspace_id
        and j.proyecto_id is not null and j.proyecto_id <> new.proyecto_id) then
      raise exception 'el journey to-be está anclado a otro proyecto';
    end if;
    -- Y que el proyecto no haya CERTIFICADO ya lo que esta aprobación vuelve falso. G6 y
    -- G7 no afirman algo sobre una design version concreta: afirman algo sobre «las
    -- aprobadas de este proyecto» —cada elemento con release (RF-06.4), ninguno en estado
    -- desconocido (RF-06.7)—, y esta transición MUEVE ese conjunto: la cubierta pasa a
    -- superada y entra la sucesora, con sus elementos sin planificar y sin constatar. El
    -- gate queda diciendo lo contrario de lo que pasa, sin que nadie lo haya tocado.
    --
    -- Rechazar es la única salida que existe, y conviene decir por qué: la aprobación de
    -- un gate es INMUTABLE y la reapertura de etapa no la deshace —SPEC-04 lo dice con
    -- todas las letras, y `reabrirEtapa` devuelve la ETAPA a 'en-curso' sin tocar el
    -- gate—, así que «revalidar el gate afectado» no es un remedio más caro: no existe
    -- como mecanismo, no hay ningún camino por el que ese 'aprobado' vuelva a evaluarse.
    -- Es la misma doctrina que release_elemento_cobertura_guard aplica al quitar alcance,
    -- aplicada al otro acto que puede volver falso lo mismo.
    --
    -- Y la puerta NO se cierra sin salida: el ciclo siguiente del servicio se abre en OTRO
    -- proyecto. Esa salida es de primera clase en el modelo, no un apaño — `supera_a` está
    -- restringido por SERVICIO y no por proyecto justo para permitirla, y G7 mira la cadena
    -- por servicio (abajo), así que el proyecto que hereda la cadena responde por lo que el
    -- anterior dejó en vuelo. El guard de alta rechaza además el NACIMIENTO del borrador en
    -- un proyecto certificado, que es donde la salida sigue siendo barata.
    --
    -- Lo que esto NO toca es el orden normal: RF-06.3 aprueba la design version en la
    -- ventana G5/G6 y G6 firma DESPUÉS el plan que la cubre. Aprobar diseño nuevo con el
    -- plan ya firmado no es paralelismo de etapas (RF-04.4) — es rehacer una etapa
    -- certificada, y eso abre ciclo.
    v_gate := gate_certificado_del_proyecto(new.proyecto_id, new.workspace_id);
    if v_gate is not null then
      raise exception 'el proyecto ya certificó G% y esa aprobación no se deshace: la design version siguiente de este servicio va en el proyecto del ciclo siguiente (SPEC-04)', v_gate;
    end if;
    -- Una design version sin elementos no es una design version: no hay diff, no hay
    -- plan de releases y G7 se aprobaría vacuamente.
    if not exists (select 1 from elemento_cambio ec
      where ec.design_version_id = new.id and ec.workspace_id = new.workspace_id) then
      raise exception 'no se puede aprobar una design version sin elementos de cambio';
    end if;
    -- Y que lo que MOTIVA a esos elementos siga en pie. Una decisión se cita estando
    -- 'vigente' —lo exige elemento_motivo_citable_guard—, pero reabrir una etapa aguas
    -- arriba la pasa a 'en-revision' (RF-04.9) y ese enlace no se revalida solo. Sin esto,
    -- la versión INMUTABLE entraba en la cadena «decisión aprobada → design version» con su
    -- base explícitamente en revisión, y ya no había forma de corregirlo: aprobar es el
    -- último instante en que el borrador todavía se puede tocar.
    --
    -- Es exactamente la regla que gate_aprobar_suficiencia_guard aplica a los ítems del
    -- checklist («hay ítems cumplidos con decisiones en revisión»), y con la misma salida y
    -- el mismo motivo para no resetear nada al reabrir: revalidar la decisión desbloquea la
    -- aprobación sin tirar trabajo que quizá sigue en pie, y si de verdad ya no la sostiene,
    -- el elemento se borra y se rehace — en borrador los dos caminos están abiertos.
    if exists (
      select 1 from elemento_cambio ec
      join elemento_decision ed on ed.elemento_id = ec.id and ed.workspace_id = ec.workspace_id
      join decision d on d.id = ed.decision_id and d.workspace_id = ed.workspace_id
      where ec.design_version_id = new.id and ec.workspace_id = new.workspace_id
        and d.estado <> 'vigente'
    ) then
      raise exception 'hay elementos que citan decisiones en revisión: revalídalas antes de aprobar (RF-04.9)';
    end if;
    -- Y que dos elementos no describan el mismo cambio. El caso del NODO compartido lo
    -- impide un índice único desde el alta; este es el del CATÁLOGO, que además puede
    -- aparecer DESPUÉS de crear los elementos: basta con que alguien enlace al catálogo, en
    -- el journey de trabajo, un nodo que no lo estaba, y dos elementos que nacieron con
    -- identidades distintas pasan a compartirla sin que nadie tocara la design version.
    --
    -- Por eso se revalida aquí y no solo al escribir, exactamente igual que las decisiones
    -- de arriba: aprobar es el último instante en que el borrador todavía se puede corregir,
    -- y lo que se congela después entra en el pliegue del estado efectivo — donde dos
    -- elementos con la misma identidad no son dos, son uno que pisa al otro.
    if exists (
      select 1 from elemento_cambio ec
      join journey_nodo n on n.id = ec.nodo_id and n.workspace_id = ec.workspace_id
      where ec.design_version_id = new.id and ec.workspace_id = new.workspace_id
        and n.catalogo_id is not null
      group by n.catalogo_id
      having count(*) > 1
    ) then
      raise exception 'hay dos elementos que cambian la misma entrada de catálogo: descríbelo en UN elemento antes de aprobar (el estado efectivo no sabe plegar dos)';
    end if;
    -- Y que el snapshot se haya tomado EN ESTA transición, no antes. RF-06.3 no promete
    -- «hay un snapshot de este journey», promete que aprobar CONGELA el to-be — el de
    -- ahora—, y esas dos cosas se separan en cuanto existe un snapshot anterior del mismo
    -- grafo (lo deja cualquier aprobación previa de ese journey).
    --
    -- Ojo, porque aquí es fácil equivocarse: el CHECK «borrador ⇒ los tres sellos nulos»
    -- NO cubre esto. Un CHECK se evalúa sobre la fila RESULTANTE, y la de una aprobación
    -- ya tiene `estado = 'aprobada'`, así que ese CHECK ni se mira: solo restringe a las
    -- filas que SIGUEN siendo borrador, es decir, sembrar el sello en dos sentencias. En
    -- UNA sola —aprobar y apuntar de paso a un snapshot viejo del mismo journey— pasaba el
    -- CHECK y pasaba la política, cuyo `with check` solo exige que el snapshot sea del
    -- mismo journey y nada sobre cuándo se tomó. La versión quedaba inmutable certificando
    -- un grafo que no era el to-be vigente.
    --
    -- El predicado es «la fila del snapshot nació en esta transacción»: `xmin` es el xid
    -- que la insertó y `pg_current_xact_id()` el de esta transacción. Es lo más fuerte que
    -- se puede pedir —más que «no lo usa nadie más» o «es el más reciente», que admiten
    -- ambos un snapshot tomado antes de la última edición del grafo— y es exactamente lo
    -- que hace el servicio: insertar el snapshot y aprobar en la misma transacción.
    --
    -- PRECONDICIÓN DEL REPOSITORIO, y no solo de este guard: `xmin` es el xid que insertó
    -- la fila, así que con una SUBTRANSACCIÓN de por medio sería el subxid y no
    -- coincidiría con el `pg_current_xact_id()` de nivel superior. Hoy se cumple —
    -- `conUsuario` abre una sola transacción con `begin()` y no hay un solo savepoint en
    -- el repositorio, comprobado— y hay otro guard que se apoya en lo mismo, así que quien
    -- meta un savepoint mañana rompe los dos.
    --
    -- El modo de fallo es contraintuitivo y por eso se escribe: NO se abre el agujero, se
    -- cierra de más. Con un subxid la comparación falla y se rechaza una aprobación
    -- LEGÍTIMA. Es la dirección segura, pero desde producción se ve como «aprobar dejó de
    -- funcionar» y nadie miraría hacia aquí sin este párrafo.
    if new.snapshot_id is not null and not exists (
      select 1 from journey_snapshot s
      where s.id = new.snapshot_id and s.workspace_id = new.workspace_id
        and s.xmin = pg_current_xact_id()::xid
    ) then
      raise exception 'aprobar congela el to-be de AHORA: el snapshot debe tomarse en la misma transición (RF-06.3)';
    end if;
    -- Y el CONTENIDO del snapshot lo escribe la BASE, no el llamante. `xmin` contesta
    -- «¿es de ahora?»; esto contesta «¿es de verdad?», y son dos preguntas distintas: la
    -- política de `journey_snapshot` solo comprueba rol y autor, así que por SQL directo un
    -- lead podía insertar en esta misma transacción un grafo INVENTADO —etiquetas
    -- cambiadas, aristas o evidencias omitidas— y pasaba la frescura sin problema. Bastaba
    -- con incluir los ids de los nodos enlazados para pasar también la comprobación de
    -- abajo. La versión quedaba inmutable certificando un grafo que nunca existió, que es
    -- exactamente lo que RF-06.3 promete que no pasa.
    --
    -- Comparar el payload con el grafo vivo sería la respuesta débil: cara, y ella misma
    -- una lectura sobre algo que puede cambiar. Construirlo aquí lo vuelve inatacable por
    -- construcción — no hay payload que fabricar si el llamante no lo aporta—, y es el
    -- idiom de la casa: el efecto lo produce el guard que decide, para que el SQL crudo lo
    -- produzca igual. Del llamante solo llega la FILA (journey, motivo, autor).
    --
    -- MISMO orden total que `congelarSnapshot` (SPEC-05): el orden de los nodos se reinicia
    -- por tipo y por fase, así que ordenar solo por él deja empates y el array sale distinto
    -- en cada congelación. Importa el doble porque son dos caminos que producen el MISMO
    -- registro: si discreparan, dos snapshots del mismo grafo se compararían como si el
    -- grafo hubiera cambiado.
    update journey_snapshot s
    set grafo = jsonb_build_object(
      'nodos', coalesce((select jsonb_agg(to_jsonb(n) order by n.tipo, n.orden, n.id)
        from journey_nodo n
        where n.journey_id = new.journey_id and n.workspace_id = new.workspace_id), '[]'::jsonb),
      'aristas', coalesce((select jsonb_agg(to_jsonb(a) order by a.creado_en, a.id)
        from journey_arista a
        where a.journey_id = new.journey_id and a.workspace_id = new.workspace_id), '[]'::jsonb),
      'evidencias', coalesce((select jsonb_agg(jsonb_build_object(
          'nodoId', ne.nodo_id, 'evidenciaId', ne.evidencia_id, 'evidenciaTitulo', e.titulo)
          order by ne.creado_en, ne.nodo_id, ne.evidencia_id)
        from journey_nodo_evidencia ne
        join journey_nodo n2 on n2.id = ne.nodo_id and n2.workspace_id = ne.workspace_id
        join evidencia e on e.id = ne.evidencia_id and e.workspace_id = ne.workspace_id
        where n2.journey_id = new.journey_id and ne.workspace_id = new.workspace_id), '[]'::jsonb))
    where s.id = new.snapshot_id and s.workspace_id = new.workspace_id
      and s.journey_id = new.journey_id;
    -- Sin sello no hay nada que escribir, y el veredicto es del CHECK de la tabla («una
    -- no-borrador exige los tres sellos»), no de aquí: si esto abortara, el mensaje diría
    -- «el snapshot no es de este journey» sobre una aprobación que ni siquiera declaró uno.
    if new.snapshot_id is not null and not found then
      raise exception 'el snapshot que se congela no es del journey de esta design version';
    end if;
    -- Y que el snapshot que se congela pueda RESPONDER por cada nodo enlazado. Sin FK en
    -- `elemento_cambio.nodo_id`, entre que un borrador enlaza un nodo y alguien aprueba,
    -- ese nodo puede haberse borrado del grafo de trabajo. Que el borrador se apoye en la
    -- fila viva es lo CORRECTO —se edita contra el grafo vivo, y RF-05.8 dice que ese
    -- grafo sigue editable—, así que la respuesta no es volver a hacer imborrable el nodo:
    -- eso reintroduce por otra puerta el cierre que quitar la FK vino a deshacer, y encima
    -- desde el objeto más provisional que hay. Lo que no puede pasar es que la versión se
    -- CONGELE prometiendo una identidad de nodo que su propio snapshot no contiene: «qué
    -- pasos del journey afectó RL-1» (§19.7) saldría vacío para siempre, y la versión ya
    -- es inmutable. Aprobar es el instante en que el borrador deja de serlo y en que todo
    -- lo demás se revalida (el journey, el anclaje, los elementos); esto es una condición
    -- más de esa lista.
    --
    -- Se comprueba contra el SNAPSHOT y no contra journey_nodo a propósito. El snapshot se
    -- insertó en una sentencia anterior de esta misma transacción y es lo que la pregunta
    -- histórica va a leer, así que la comprobación ES la promesa, palabra por palabra.
    -- Contra la fila viva habría además una carrera —borrar el nodo después de congelar y
    -- antes del update— que rechazaría una aprobación cuyo snapshot sí tiene el nodo.
    if new.snapshot_id is not null and exists (
      select 1 from elemento_cambio ec
      where ec.design_version_id = new.id and ec.workspace_id = new.workspace_id
        and ec.nodo_id is not null
        and nodo_congelado(new.snapshot_id, new.workspace_id, ec.nodo_id) is null
    ) then
      raise exception 'hay elementos enlazados a nodos que ya no están en el journey: desenlázalos antes de aprobar (RF-05.8)';
    end if;
    if new.supera_a is not null and not exists (select 1 from design_version dv
      where dv.id = new.supera_a and dv.workspace_id = new.workspace_id
        and dv.servicio_id = new.servicio_id and dv.estado = 'superada') then
      raise exception 'la design version superada debe quedar marcada como superada en la misma transacción';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'DesignVersionAprobada',
        jsonb_build_object('designVersionId', new.id, 'codigo', new.codigo,
                           'servicioId', new.servicio_id, 'snapshotId', new.snapshot_id,
                           'superaA', new.supera_a),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  else
    -- Superar cambia UNA cosa: el estado. Todo lo demás es el registro de lo que esta
    -- versión aprobó, y sigue teniendo que responder por ello mucho después — el snapshot
    -- es lo que contesta «qué pasos afectó RL-1» (§19.7), y `supera_a` es la cadena de
    -- SYS-05. La transición es LEGAL, así que el rechazo de «mismo estado» de arriba no
    -- dispara y las políticas solo miran el par de estados; el `using` de
    -- design_version_superar y su `with check` dejan pasar la sentencia entera, carga
    -- incluida. Los otros dos guards se apartan a propósito cuando la fila ya no es
    -- borrador, así que aquí no queda nadie más: la lista va explícita.
    if new.journey_id is distinct from old.journey_id
      or new.snapshot_id is distinct from old.snapshot_id
      or new.aprobada_por is distinct from old.aprobada_por
      or new.supera_a is distinct from old.supera_a then
      raise exception 'superar una design version solo cambia su estado: lo que aprobó es inmutable (SYS-05)';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'DesignVersionSuperada',
        jsonb_build_object('designVersionId', new.id, 'codigo', new.codigo,
                           'servicioId', new.servicio_id),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger design_version_transicion
  before update on design_version
  for each row execute function design_version_transicion_guard();
revoke execute on function design_version_transicion_guard() from public;

-- Y el otro lado de SYS-05: una design version pasa a 'superada' PORQUE otra la reemplaza,
-- nunca a secas. La política de supersión solo mira el par de estados y `estado` está en el
-- grant de columna, así que un UPDATE suelto del rol de la app las pasaba las dos y dejaba
-- al servicio SIN versión vigente.
--
-- Y ese estado NO TIENE SALIDA, que es lo que decide el remedio: el selector de «supera a»
-- solo ofrece versiones APROBADAS (mismo predicado que el guard de anclaje), y
-- `aprobarDesignVersion` exige mover la predecesora de 'aprobada' a 'superada' — un update
-- que ahí ya no alcanza ninguna fila. El servicio se quedaba sin poder declarar una versión
-- nueva y sin nada que la app pudiera hacer al respecto. Misma familia que el effective
-- state a medias, y misma respuesta: se endurece la invariante para que el estado sea
-- INALCANZABLE, en vez de construir una reparación que legitimaría en el servicio lo que la
-- base prohíbe. El conjunto de filas heredadas vuelve a ser vacío: la tabla nace aquí.
--
-- DIFERIDO por el mismo motivo que los otros dos de este esquema: en el instante del UPDATE
-- la sucesora todavía es un BORRADOR — `aprobarDesignVersion` marca superada a la anterior
-- ANTES de aprobar la nueva, porque el índice único parcial no admite dos aprobadas del
-- mismo servicio a la vez—. Al COMMIT las dos escrituras están hechas y la condición se
-- puede exigir entera sin imponer un orden de sentencias.
--
-- La sucesora NO tiene que ser del mismo proyecto, y esto es deliberado: `supera_a` está
-- restringido por SERVICIO (design_version_anclaje_guard), y esa libertad es la salida que
-- deja la regla del proyecto certificado —el ciclo siguiente se abre en otro proyecto— y lo
-- que obliga a G7 a recorrer la cadena por servicio. Exigir aquí el mismo proyecto cerraría
-- esa puerta por detrás.
create function design_version_superada_con_sucesora_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if not exists (
    select 1 from design_version suc
    where suc.supera_a = new.id and suc.workspace_id = new.workspace_id
      and suc.estado = 'aprobada'
  ) then
    raise exception 'una design version se supera cuando otra la reemplaza: no hay ninguna versión aprobada que suceda a esta (SYS-05)';
  end if;
  return new;
end $$;
create constraint trigger design_version_superada_con_sucesora
  after update on design_version
  deferrable initially deferred
  for each row when (new.estado = 'superada' and old.estado <> 'superada')
  execute function design_version_superada_con_sucesora_guard();
revoke execute on function design_version_superada_con_sucesora_guard() from public;

-- El release nace planificado y deja su rastro; la DV aprobada la exige la política.
create function release_alta_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'ReleasePlanificado',
      jsonb_build_object('releaseId', new.id, 'codigo', new.codigo,
                         'designVersionId', new.design_version_id,
                         'responsable', new.responsable,
                         'fechaObjetivo', to_char(new.fecha_objetivo, 'YYYY-MM-DD')),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger release_alta
  after insert on release
  for each row execute function release_alta_auditoria();
revoke execute on function release_alta_auditoria() from public;

-- Un elemento solo entra en un release de SU design version. La FK compuesta garantiza
-- el workspace: sin esto, RL-1 de DV-1 podría «incluir» un elemento de DV-2 y la
-- conciliación de las dos saldría cuadrada por elementos que nunca les pertenecieron.
create function release_elemento_misma_dv_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if not exists (
    select 1 from release r
    join elemento_cambio ec on ec.id = new.elemento_id and ec.workspace_id = new.workspace_id
    where r.id = new.release_id and r.workspace_id = new.workspace_id
      and r.design_version_id = ec.design_version_id) then
    raise exception 'el elemento no pertenece a la design version de este release';
  end if;
  return new;
end $$;
create trigger release_elemento_misma_dv
  before insert on release_elemento
  for each row execute function release_elemento_misma_dv_guard();
revoke execute on function release_elemento_misma_dv_guard() from public;

-- Lo que G6 certificó sigue siendo cierto: si el gate aprobó un plan donde CADA elemento
-- de la design version vigente tiene release, quitarle el release a uno de ellos deja el
-- gate diciendo algo falso. La aprobación de un gate es inmutable y la reapertura de etapa
-- NO la deshace (SPEC-04 lo dice explícitamente: «la aprobación del gate no se deshace»),
-- así que no hay ningún camino por el que ese `aprobado` vuelva a evaluarse: la mentira se
-- queda. G7 acabaría atrapando el hueco —un elemento sin release es «desconocido»—, pero
-- eso es descubrirlo al final del ciclo, y entre medias el tablero certifica un plan que
-- no existe.
--
-- El predicado es EL MISMO que el de G6, y a propósito: dos formas de decir «todo elemento
-- del que responde el proyecto está cubierto» serían dos verdades y bastaría olvidar una.
-- Por eso comparte con él `design_versions_a_cargo_del_proyecto` en vez de repetir un
-- filtro: cuando ese conjunto cambió —al separar «cuál manda en el servicio» de «de qué
-- responde el proyecto»—, tenía que cambiar aquí con él o el gate y su vigilante habrían
-- pasado a hablar de cosas distintas.
--
-- DIFERIDO, y aquí está el motivo de fondo: mover un elemento de un release a otro es
-- borrar y volver a insertar, así que entre las dos sentencias el elemento está descubierto
-- sin que nadie haya roto nada. Comprobar al COMMIT es lo que distingue «lo he movido» de
-- «lo he dejado huérfano», que es la diferencia que importa. Un trigger normal habría
-- prohibido reordenar el plan después de G6 — y como el gate no se puede desaprobar, eso
-- habría sido cerrar la puerta para siempre.
--
-- Fuera del conjunto quedan las versiones que EL PROPIO proyecto reemplazó, y eso mantiene
-- abierta la salida de G7: quitarle el alcance a un release planificado de una versión que
-- el proyecto ya sustituyó es como se cierra lo que ya no va a salir.
--
-- Para las que siguen en el conjunto —incluidas las que superó OTRO proyecto— esa salida no
-- hace falta y además no serviría: sus elementos siguen contando para el G7 de este
-- proyecto, así que dejarlos sin release los deja «en estado desconocido» en vez de
-- cerrarlos. La salida de esos es la buena: desplegar y constatar, aunque sea como
-- 'no-implementado' con su razón — una respuesta conocida, que es lo que el gate pide.
--
-- Y el conjunto no se mueve bajo el gate: desde que G6 está aprobado, el proyecto no puede
-- aprobar design versions nuevas (design_version_transicion_guard), así que ni entra ni
-- sale nada de él.
create function release_elemento_cobertura_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reto uuid;
begin
  -- El candado del RETO, y PRIMERO, por lo mismo que el del alcance de abajo: firmar G6 y
  -- quitarle el release a un elemento escriben tablas distintas —gate_instancia y
  -- release_elemento—, y sin candado compartido en la BASE las dos se miran sin verse y
  -- commitean. La cita existía solo en el servicio, que es una convención.
  --
  -- Es el reto y no el proyecto porque es la clave que ya usa el método: `aprobarGate` lo
  -- toma primero de todo, y `desasignarElemento` también. Resolverlo antes de tomarlo no
  -- abre carrera: el reto de un proyecto y la design version de un elemento son inmutables.
  select p.reto_id into v_reto
  from elemento_cambio ec
  join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
  join proyecto p on p.id = dv.proyecto_id and p.workspace_id = dv.workspace_id
  where ec.id = old.elemento_id and ec.workspace_id = old.workspace_id;
  if v_reto is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
  end if;
  if not is_workspace_member(app_user_id(), old.workspace_id) then
    return old;
  end if;
  -- Se volvió a asignar en esta misma transacción: era un movimiento, no un descubierto.
  if exists (select 1 from release_elemento re
    where re.elemento_id = old.elemento_id and re.workspace_id = old.workspace_id) then
    return old;
  end if;
  -- «El proyecto certificó» lo contesta `gate_certificado_del_proyecto` y no una consulta
  -- propia, por el mismo motivo por el que el conjunto de versiones lo contesta una función:
  -- si dos guards deciden por su cuenta qué cuenta como certificación, uno se queda viejo.
  -- Y ya pasó: mirar `numero = 6 and estado = 'aprobado'` a pelo ignoraba el perdón
  -- histórico, así que a un proyecto perdonado —que puede EMPEZAR su plan— se le prohibía
  -- corregirlo en cuanto asignaba el primer elemento, que es justo la capacidad que el
  -- perdón existe para devolverle.
  --
  -- Sirve `is not null` y no hace falta preguntar por el 6: la escalera de gates impide un
  -- G7 aprobado sin G6 aprobado, y el perdón solo marca G6 de proyectos SIN G7 aprobado, así
  -- que «hay algo certificado» y «G6 certificó y no está perdonado» coinciden.
  if exists (
    select 1 from elemento_cambio ec
    join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
    where ec.id = old.elemento_id and ec.workspace_id = old.workspace_id
      and dv.id in (select design_versions_a_cargo_del_proyecto(dv.proyecto_id, dv.workspace_id))
      and gate_certificado_del_proyecto(dv.proyecto_id, dv.workspace_id) is not null
  ) then
    raise exception 'G6 aprobó un plan que cubre este elemento: muévelo a otro release, no lo dejes sin ninguno (RF-06.4)';
  end if;
  return old;
end $$;
create constraint trigger release_elemento_cobertura
  after delete on release_elemento
  deferrable initially deferred
  for each row execute function release_elemento_cobertura_guard();
revoke execute on function release_elemento_cobertura_guard() from public;

-- ══ UN RELEASE QUE YA SALIÓ NO SE QUEDA SIN ALCANCE (SYS-06) ══
-- El guard de transición ya lo comprueba al desplegar, pero es INMEDIATO y por tanto ciego a
-- lo que otra transacción tenga a medias. Quitar el último elemento y desplegar el release
-- escriben TABLAS DISTINTAS —release_elemento y release—, así que ningún candado de fila las
-- cruza: la política del borrado ve 'planificado', el guard del despliegue ve el elemento
-- todavía ahí, y las dos commitean. Queda un release desplegado sin alcance declarado.
--
-- La cita existía, pero solo en el servicio (`bloquearRelease` en los dos caminos). Y eso es
-- una convención, no una garantía: vale mientras todo el mundo entre por la puerta buena.
-- Este esquema no se apoya en eso —por eso el código lo pone un trigger y por eso el perdón
-- histórico está fuera de todo grant—, así que la cooperación tiene que vivir aquí.
--
-- Es UNA sola función para los dos lados a propósito: la invariante se enuncia una vez y la
-- comprueba quien la pueda romper, venga del borrado o del despliegue.
--
-- ── Y LO QUE NO BASTA: diferido no es excluyente ──
-- Un constraint trigger diferido corre en la fase de commit, pero su `select` va ANTES de que
-- el commit propio sea visible para nadie. Dos que lleguen a la vez se miran sin verse y
-- pasan los dos: el diferido por sí solo mueve la ceguera de sitio, no la quita.
--
-- Lo que la quita es el candado COMPARTIDO como PRIMERA sentencia de los dos lados. Ahí no
-- hay ningún candado de fila por delante al que adelantarse, así que uno espera de verdad al
-- otro; y cuando entra, su `select` ya es una sentencia nueva —READ COMMITTED, instantánea
-- fresca— y ve lo que el primero acaba de commitear. Sobrevive exactamente uno.
--
-- La clave es la MISMA cadena que usa el servicio ('designio:release:' || id), porque un
-- candado que no es el mismo no es un candado compartido.
--
-- ── Orden de adquisición ──
-- En el borrado de un release_elemento corren DOS diferidos: `release_elemento_cobertura`
-- toma el candado del RETO y este toma el del RELEASE. Los constraint triggers de una tabla
-- disparan en orden alfabético, y `cobertura` va antes que `sin_alcance`, así que se toman en
-- el orden canónico del módulo (reto → … → release) y no al revés. Invertirlos cerraría un
-- ciclo contra `desasignarElemento`, que los toma en ese mismo orden. El nombre es funcional:
-- renombrar estos triggers sin mirar esto reintroduce el interbloqueo.
create function release_alcance_no_vacio_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_release uuid;
  v_workspace uuid;
  v_estado text;
begin
  if tg_table_name = 'release_elemento' then
    v_release := old.release_id;
    v_workspace := old.workspace_id;
  else
    v_release := new.id;
    v_workspace := new.workspace_id;
  end if;
  -- PRIMERO el candado. Nada de comprobar membresía antes: esto no es una regla de dominio
  -- que dependa de quién mira, es una invariante estructural que tiene que valer también
  -- para un script de administración.
  perform pg_advisory_xact_lock(hashtextextended('designio:release:' || v_release, 42));
  select r.estado into v_estado from release r
    where r.id = v_release and r.workspace_id = v_workspace;
  -- El release ya no existe, o sigue planificado: quitarle el alcance a lo que aún no ha
  -- salido es legítimo —es como se cierra un release que ya no va a construirse—.
  if v_estado is null or v_estado = 'planificado' then
    return null;
  end if;
  if not exists (select 1 from release_elemento re
    where re.release_id = v_release and re.workspace_id = v_workspace) then
    raise exception 'un release que ya salió no puede quedarse sin alcance declarado (SYS-06)';
  end if;
  return null;
end $$;
create constraint trigger release_elemento_sin_alcance
  after delete on release_elemento
  deferrable initially deferred
  for each row execute function release_alcance_no_vacio_guard();
create constraint trigger release_sin_alcance
  after update on release
  deferrable initially deferred
  for each row execute function release_alcance_no_vacio_guard();
revoke execute on function release_alcance_no_vacio_guard() from public;

-- ══ Y EL ALCANCE DE LO QUE YA SALIÓ NO CAMBIA (SYS-06) ══
-- Otra invariante, no otro lado de la anterior, y por eso guard aparte: aquella dice que un
-- release desplegado no se queda VACÍO; esta dice que su alcance no CRECE. La política del
-- alta ya exige 'planificado', pero es un predicado sobre la instantánea de la sentencia, y
-- ahí vuelve el mismo agujero: meter un elemento mientras se despliega el release escribe
-- otra tabla, así que la política ve 'planificado', el guard de transición ve solo el alcance
-- viejo, y las dos commitean. El release sale y DESPUÉS gana un elemento que no formó parte
-- del despliegue — y luego la constatación o lo da por bueno sin haber salido, o se queda
-- bloqueada porque el elemento no tiene forma de resolverse.
--
-- Basta con vigilar el ALTA. Si el alta commitea primero, el elemento entró cuando el release
-- todavía estaba planificado y el despliegue lo incluye con razón; si commitea primero el
-- despliegue, esta comprobación —sentencia nueva, instantánea fresca— ya lo ve desplegado y
-- rechaza. El UPDATE no hace falta mirarlo: release_elemento no tiene grant de update.
--
-- El NOMBRE mantiene el orden canónico, otra vez. En release_elemento los diferidos disparan
-- por orden alfabético, y `alcance_fijo` va antes que `cobertura` y que `sin_alcance` — pero
-- solo se cruzan en una transacción que BORRA e INSERTA (mover un elemento), y ahí los
-- eventos del borrado se encolan antes, así que el candado del reto (cobertura) se toma antes
-- que el del release. Si algún día esto pasa a mirar también el borrado, hay que renombrarlo
-- para que caiga DESPUÉS de `cobertura`, o se invierte la secuencia.
create function release_alcance_fijo_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_release uuid;
  v_ws uuid;
  v_estado text;
begin
  if tg_op = 'DELETE' then
    v_release := old.release_id;
    v_ws := old.workspace_id;
  else
    v_release := new.release_id;
    v_ws := new.workspace_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('designio:release:' || v_release, 42));
  select r.estado into v_estado from release r
    where r.id = v_release and r.workspace_id = v_ws;
  if v_estado is not null and v_estado <> 'planificado' then
    raise exception 'ese release ya salió: su alcance es fijo y no puede cambiar después del despliegue (SYS-06)';
  end if;
  return null;
end $$;
-- Cubre el ALTA y la BAJA, que es lo que «fijo» quiere decir de verdad. Faltaba la baja: la
-- política del borrado exige 'planificado' con un exists sobre otra tabla, así que quitar un
-- elemento mientras se despliega el release también commitea — y el release sale declarando
-- un alcance y acaba con otro más pequeño. El guard de «no vacío» no lo veía porque solo mira
-- si queda vacío, no si encogió.
--
-- El nombre cae entre `cobertura` y `sin_alcance` a propósito: en la baja disparan los tres y
-- el orden alfabético tiene que dar el canónico —cobertura toma el RETO y estos dos el
-- RELEASE—. Con `alcance_fijo` iba el primero y salía release antes que reto.
create constraint trigger release_elemento_fijo
  after insert or delete on release_elemento
  deferrable initially deferred
  for each row execute function release_alcance_fijo_guard();
revoke execute on function release_alcance_fijo_guard() from public;

-- ── Y lo que NO se vigila aquí, con su motivo ──
-- Meter alcance mientras se aprueba la sucesora deja trabajo planificado sobre una versión
-- que el propio proyecto acaba de reemplazar. Parece la misma familia que lo de arriba, y no
-- lo es: ese estado es LEGÍTIMAMENTE alcanzable en secuencia —se planifica el release con su
-- alcance y DESPUÉS se decide reemplazar la design version, que es cuando llega la decisión—,
-- así que no hay invariante que la concurrencia rompa. Rechazarla por concurrente sería
-- rechazar algo que se acepta en orden.
--
-- Y tampoco encierra a nadie: el release sigue 'planificado', así que se cierra vaciándolo,
-- que es exactamente la salida que la pantalla ofrece para las auto-superadas. Vacío, la rama
-- de G7 que cuenta «releases de una superada sin resolver» deja de verlo, porque cuenta
-- releases CON alcance. Está fijado en `entrega.test.ts` («un release de una versión
-- auto-superada se cierra vaciándolo»), que es donde vive el argumento por si alguien vuelve
-- a plantearlo.
--
-- Lo que sí se cierra en secuencia, y basta: la política del alta no deja meter trabajo NUEVO
-- en una versión que el proyecto ya reemplazó.

-- ══ EL CALENDARIO QUE MANDA ES EL DE QUIEN ESCRIBE (RF-06.5, RF-06.6) ══
-- «La fecha no puede ser futura» no dice nada hasta que se responde «futura ¿en qué
-- calendario?», y las dos mitades del producto contestaban distinto:
--
--  · la pantalla propone el día LOCAL del usuario —HOY() en design-version.$designVersionId.tsx
--    se compone con los getters locales justamente para no proponer el de UTC—;
--  · el guard lo juzgaba contra `current_date`, que es el día de la BASE.
--
-- Con la base en UTC y un usuario al este pasada su medianoche local, la fecha correcta que
-- la pantalla propone se rechaza por «futura», y al usuario solo le queda guardar AYER.
-- Sobre escrituras INMUTABLES —no hay UPDATE que corrija `desplegado_en` ni `constatado_en`,
-- y encima ordenan el effective state vigente del servicio (RF-06.10)—, así que el día
-- equivocado se queda para siempre y reordena la historia del servicio.
--
-- El arreglo NO es ensanchar el límite un día. Eso admitiría fechas genuinamente futuras y
-- la regla «no se registra lo que aún no ha ocurrido» dejaría de sostenerse; además elegiría
-- un calendario arbitrario en vez de nombrar el que manda. Lo que faltaba es que la fecha
-- viaje CON el calendario en el que significa algo: el cliente declara su desfase respecto
-- de UTC y el guard juzga en ESE calendario. Los dos lados pasan a contestar lo mismo porque
-- leen la misma pregunta.
--
-- El desfase llega por `app.desfase_utc_minutos`, SET LOCAL por transacción, igual que
-- `app.user_id` — no como columna: la zona de quien teclea no es un hecho del despliegue ni
-- de la constatación, es contexto de la escritura, y guardarla en la fila la convertiría en
-- dato de dominio que alguien acabaría interpretando.
--
-- Se acota a los husos que existen de verdad, [-12:00, +14:00], y eso es lo que impide que
-- un cliente se regale días declarando un desfase absurdo. Dentro de ese rango, lo más que
-- puede hacer es contar como «hoy» un día que YA es hoy en algún sitio habitado — que es la
-- ambigüedad que «hoy» tiene de por sí y no un agujero que abra esto.
--
-- Y si nadie declara calendario —un UPDATE directo por SQL, un job—, el desfase es 0 y la
-- regla es la de siempre, la de UTC: quien no dice en qué calendario escribe se juzga en el
-- de la base. La comprobación del formato es para que un valor con basura no reviente la
-- escritura con un error de casteo que no explica nada: se ignora y se cae al 0.
create function hoy_del_cliente() returns date
language sql stable as $$
  select ((now() at time zone 'UTC') + make_interval(mins => greatest(-720, least(840, v.minutos))))::date
  from (
    select case
      -- Hasta 9 dígitos: lo que cabe en un int4 sin desbordar. El límite no está para
      -- acotar el huso —de eso se encarga el greatest/least, que ACOTA en vez de descartar—
      -- sino para que un valor con basura no reviente la escritura con un error de casteo
      -- que no explicaría nada. Un número fuera de rango se acota; algo que no es un número
      -- se ignora y manda UTC.
      when current_setting('app.desfase_utc_minutos', true) ~ '^-?[0-9]{1,9}$'
        then current_setting('app.desfase_utc_minutos', true)::int
      else 0
    end as minutos
  ) v
$$;
-- Solo la llaman los dos guards, que son SECURITY DEFINER y corren como el dueño.
revoke execute on function hoy_del_cliente() from public;

-- Transiciones del release (§3.3) con sus exigencias y sus eventos dentro del guard.
create function release_transicion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.estado = old.estado then
    -- El mismo hueco que en design_version, aquí sobre la fecha REAL del despliegue. Los
    -- predicados de RLS se OR-ean entre políticas: sobre un release ya desplegado, el
    -- `using` de release_verificar (desplegado + lead) selecciona la fila y el
    -- `with check` de release_desplegar (sigue desplegado, con fecha no nula) la deja
    -- pasar. Como `desplegado_en` está en el grant de columna, un UPDATE que no cambia de
    -- estado reescribía la fecha de lo que ya pasó, y el early-return de este guard se
    -- saltaba tanto las comprobaciones de transición como la auditoría: la corrección no
    -- dejaba ni rastro.
    --
    -- Un release 'planificado' no necesita la regla —ningún with check acepta que siga
    -- planificado, así que la RLS ya rechaza ese UPDATE— y dejarlo fuera mantiene la
    -- excepción diciendo exactamente lo que pasa: lo que salió no se reescribe.
    --
    -- Se levanta excepción en vez de emitir un evento: un UPDATE no-op también dispara
    -- los triggers, y auditar «se desplegó» cada vez que alguien escribe la fila sin
    -- cambiarla llenaría el acta de despliegues que nunca ocurrieron. Si algún día hay
    -- que corregir una fecha mal tecleada, será una operación explícita con su política y
    -- su evento propio, no el efecto lateral de un update que no dice nada.
    if old.estado <> 'planificado' then
      raise exception 'un release ya desplegado no se reescribe: su fecha real es el registro de lo que pasó (RF-06.5)';
    end if;
    return new;
  end if;
  if (old.estado, new.estado) not in (
    ('planificado', 'desplegado'),
    ('desplegado', 'verificado')
  ) then
    raise exception 'transición de release ilegal: % → %', old.estado, new.estado;
  end if;
  -- El candado del RELEASE antes de las comprobaciones que leen OTRAS tablas: el alcance al
  -- desplegar y las constataciones al verificar. Los diferidos del alcance ya cierran el par
  -- por su lado; esto pone a este guard en la misma cita en vez de dejarlo confiando en que
  -- el servicio la tomó. Es el único candado que toma esta ruta, así que no hay orden que
  -- romper.
  perform pg_advisory_xact_lock(hashtextextended('designio:release:' || new.id, 42));

  if new.estado = 'desplegado' then
    -- En el calendario de QUIEN ESCRIBE, no en el de la base (ver hoy_del_cliente).
    if new.desplegado_en > hoy_del_cliente() then
      raise exception 'la fecha real de despliegue no puede ser futura';
    end if;
    -- SYS-06: «declara explícitamente qué elementos incluye». Un release vacío
    -- desplegado no declara nada y dejaría la conciliación cuadrando sobre el aire.
    if not exists (select 1 from release_elemento re
      where re.release_id = new.id and re.workspace_id = new.workspace_id) then
      raise exception 'un release sin elementos declarados no se despliega (SYS-06)';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'ReleaseDesplegado',
        jsonb_build_object('releaseId', new.id, 'codigo', new.codigo,
                           'desplegadoEn', to_char(new.desplegado_en, 'YYYY-MM-DD')),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  else
    -- Verificar cambia UNA cosa: el estado. `desplegado_en` es la fecha REAL de lo que
    -- pasó y ya está registrada; aquí no se toca. El rechazo de «mismo estado» de arriba
    -- no cubre esto —la transición es legal, así que ni siquiera llega—, y la política de
    -- verificación solo pide el estado nuevo mientras el grant de columna sigue dejando
    -- escribir la fecha. Peor aún: la comprobación de fecha no futura vive en la rama de
    -- `desplegado`, así que por aquí entraba incluso una fecha del futuro. Congelar la
    -- columna cierra las dos cosas de una vez.
    if new.desplegado_en is distinct from old.desplegado_en then
      raise exception 'verificar no reescribe la fecha real del despliegue (RF-06.5)';
    end if;
    -- RF-06.6: «por cada elemento desplegado, constatación de cómo quedó». La
    -- constatación se inserta en sentencias anteriores de la misma transacción, así que
    -- este predicado ya las ve; por SQL crudo, verificar sin constatar aborta.
    if exists (
      select 1 from release_elemento re
      where re.release_id = new.id and re.workspace_id = new.workspace_id
        and not exists (
          select 1 from constatacion c
          join effective_state es on es.id = c.effective_state_id and es.workspace_id = c.workspace_id
          where c.elemento_id = re.elemento_id and c.workspace_id = re.workspace_id
            and es.release_id = new.id)) then
      raise exception 'verificar exige constatar TODOS los elementos del release (RF-06.6)';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'ReleaseVerificado',
        jsonb_build_object('releaseId', new.id, 'codigo', new.codigo),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger release_transicion
  before update on release
  for each row execute function release_transicion_guard();
revoke execute on function release_transicion_guard() from public;

-- El effective state es del servicio de la design version del release: encadenarlo a
-- otro servicio rompería el «vigente por servicio» de RF-06.10 sin que ninguna FK se
-- queje. La fecha de constatación tampoco es futura.
create function effective_state_alta_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_desplegado_en date;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  -- En el calendario de QUIEN ESCRIBE, no en el de la base (ver hoy_del_cliente).
  if new.constatado_en > hoy_del_cliente() then
    raise exception 'la fecha de constatación no puede ser futura';
  end if;
  select r.desplegado_en into v_desplegado_en
  from release r
  join design_version dv on dv.id = r.design_version_id and dv.workspace_id = r.workspace_id
  where r.id = new.release_id and r.workspace_id = new.workspace_id
    and dv.servicio_id = new.servicio_id;
  if not found then
    raise exception 'el effective state es del servicio de la design version del release';
  end if;
  -- Una foto de lo que quedó funcionando no puede ser anterior al día en que salió: no
  -- describiría este release, describiría al servicio antes de él. Y el daño no se queda
  -- en esa fila — el estado efectivo vigente se pliega ORDENANDO por `constatado_en`
  -- (RF-06.10), así que una fecha inválida reordena la historia del servicio y hace ganar
  -- a un cambio viejo sobre uno nuevo. La política ya exige el release desplegado, así que
  -- aquí `desplegado_en` nunca es nulo (lo impone el CHECK de la tabla).
  if new.constatado_en < v_desplegado_en then
    raise exception 'la constatación no puede ser anterior al despliegue del release (%)', to_char(v_desplegado_en, 'YYYY-MM-DD');
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'EffectiveStateConstatado',
      jsonb_build_object('effectiveStateId', new.id, 'codigo', new.codigo,
                         'servicioId', new.servicio_id, 'releaseId', new.release_id,
                         'constatadoEn', to_char(new.constatado_en, 'YYYY-MM-DD')),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger effective_state_alta
  before insert on effective_state
  for each row execute function effective_state_alta_guard();
revoke execute on function effective_state_alta_guard() from public;

-- Solo se constata lo que ESTE release incluyó: una constatación sobre un elemento
-- ajeno cerraría el tablero de conciliación con trabajo que nadie desplegó.
-- La desviación deja su propio evento (SYS-07: el elemento y su razón, a la vista).
create function constatacion_alcance_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if not exists (
    select 1 from effective_state es
    join release_elemento re on re.release_id = es.release_id and re.workspace_id = es.workspace_id
    where es.id = new.effective_state_id and es.workspace_id = new.workspace_id
      and re.elemento_id = new.elemento_id) then
    raise exception 'ese elemento no está incluido en el release que se constata';
  end if;
  if new.resultado <> 'como-aprobado' then
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'DesviacionRegistrada',
        jsonb_build_object('effectiveStateId', new.effective_state_id,
                           'elementoId', new.elemento_id, 'resultado', new.resultado,
                           'queQuedoDistinto', new.que_quedo_distinto, 'razon', new.razon),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger constatacion_alcance
  before insert on constatacion
  for each row execute function constatacion_alcance_guard();
revoke execute on function constatacion_alcance_guard() from public;

-- Y el par completo: un effective state SIN la constatación de cada elemento de su
-- release no es «media escritura», es una fila que NADIE puede terminar. `unique
-- (release_id)` deja un solo effective state por release, así que el reintento por el
-- camino normal choca contra la unique y el release se queda `desplegado` para siempre,
-- con su conciliación en estado desconocido y G7 bloqueado sin nada que el lead pueda
-- hacer desde la pantalla.
--
-- La atomicidad de «effective state + constataciones + verificar» vivía SOLO en
-- `constatarEffectiveState`, y una promesa que solo cumple el servicio no es una promesa:
-- el grant es una superficie, no un camino. La política de `effective_state` autoriza el
-- primer paso a solas —lead, release desplegado— y nadie exigía los otros dos.
--
-- Va como CONSTRAINT TRIGGER DIFERIDO, no como uno normal, porque en el instante del
-- insert las constataciones todavía no existen: se insertan en la sentencia siguiente de
-- la misma transacción. Comprobarlo al COMMIT es lo que permite exigir el conjunto entero
-- sin obligar a un orden de sentencias concreto, y es la misma forma que el resto del
-- sistema ya usa para las reglas que solo son ciertas al final de la transacción.
--
-- No hace falta mirar el borrado de constataciones ni el cambio de alcance: no hay
-- políticas de UPDATE/DELETE sobre `constatacion` (es historia, RF-06.6) y el alcance solo
-- se mueve mientras el release está `planificado`, así que una vez que esto se cumple no
-- puede dejar de cumplirse. Y un release desplegado siempre tiene al menos un elemento
-- (`release_transicion_guard`), así que la comprobación nunca es vacuamente cierta.
create function effective_state_completo_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if exists (
    select 1 from release_elemento re
    where re.release_id = new.release_id and re.workspace_id = new.workspace_id
      and not exists (
        select 1 from constatacion c
        where c.effective_state_id = new.id and c.workspace_id = new.workspace_id
          and c.elemento_id = re.elemento_id)
  ) then
    raise exception 'un effective state se registra con la constatación de CADA elemento de su release (RF-06.6)';
  end if;
  -- Y el tercer paso: el release queda VERIFICADO. Con el juego completo de constataciones
  -- pero el release todavía `desplegado`, el callejón es el mismo —`unique (release_id)`
  -- rechaza el reintento y no hay forma de retomar—, así que la invariante tiene que
  -- nombrar la operación entera y no solo su parte más visible. La constatación completa
  -- sin verificar no es media conciliación: es una que nadie puede cerrar.
  if not exists (
    select 1 from release r
    where r.id = new.release_id and r.workspace_id = new.workspace_id
      and r.estado = 'verificado'
  ) then
    raise exception 'constatar termina verificando el release: un effective state no se queda a medias (RF-06.6)';
  end if;
  return new;
end $$;
create constraint trigger effective_state_completo
  after insert on effective_state
  deferrable initially deferred
  for each row execute function effective_state_completo_guard();
revoke execute on function effective_state_completo_guard() from public;

-- ══ G7 no pasa con la conciliación incompleta (RF-06.7, criterio de aceptación 4) ══
-- El guard de suficiencia se REESCRIBE ENTERO (create or replace no fusiona): esta es la
-- versión vigente —checklist sin pendientes y no vacío, ítems cumplidos con decisiones
-- vigentes, orden de gates, criterios de G0 y arquetipos de G2— más las ramas de G6 y G7,
-- que son las dos que SPEC-06 aporta (el plan y la conciliación).
--
-- Un mismo número de gate admite reglas de specs distintas conviviendo: G6 tendrá también
-- la firma del Metric Registry (SPEC-07/SYS-22) además de esta cobertura de releases. Al
-- integrar no se busca «la regla de G6» en singular —se encuentra una y se pierden las
-- otras—: se copia el cuerpo VIVO entero y se le añade lo propio encima.
--
-- Y lo que NO se copia: los EFECTOS de aprobar un gate que dependen de que el gate ya esté
-- escrito no viven aquí. Este guard es BEFORE, así que dentro de él la fila del gate aún
-- no existe y una precondición que la consulte se rechazaría a sí misma; esos efectos van
-- en triggers AFTER propios sobre gate_instancia. Si aparecen en una versión antigua de
-- este cuerpo, su sitio ya no es este.
--
-- «Vigente» significa vigente EN `agents`, no en la rama propia, y esa es la trampa: las
-- migraciones se aplican por nombre de fichero, así que otra rama con un número MENOR que
-- se mergee después que esta seguirá corriendo antes, y este create or replace borrará su
-- regla sin decir nada. Antes de mergear hay que volver a copiar el cuerpo vivo de la
-- migración más reciente que defina esta función en `agents` y añadirle esta rama —nunca
-- reconstruirlo de memoria—, y el test de la regla ajena es la red que lo detecta: si al
-- integrar se pone rojo, no se toca, es que falta portarla.
--
-- La regla NO se duplica en el WITH CHECK de gate_update_aprobar, igual que la de G2: el
-- predicado de la política se quedó con lo que se comprueba mirando el gate y su
-- checklist. El motivo es que la política no puede DECIR por qué falla, y aquí el porqué
-- es el producto: «estos tres elementos no tienen constatación». El guard corre antes que
-- el WITH CHECK y aborta con el mensaje; que la política no lo repita no abre un camino
-- (el trigger es de la tabla, no del rol).
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_motivo text;
  v_reto uuid;
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
    -- El candado del RETO antes de mirar nada. Este guard decide sobre filas de OTRAS tablas
    -- —el checklist, los releases, las constataciones—, así que sin candado compartido en la
    -- base una aprobación y una escritura concurrente sobre lo que afirma se miran sin verse
    -- y commitean las dos: G6 firmando un plan al que otra transacción le acaba de quitar la
    -- cobertura. El servicio ya lo tomaba (`aprobarGate` lo toma primero de todo), pero eso
    -- vale solo para quien entra por ahí.
    --
    -- Es la misma clave y el mismo primer lugar que en `release_elemento_cobertura_guard`,
    -- que es el otro lado del par. Y va aquí dentro, en la rama de la aprobación, para no
    -- serializar por el reto transiciones que no afirman nada sobre otras tablas.
    select p.reto_id into v_reto from proyecto p
      where p.id = new.proyecto_id and p.workspace_id = new.workspace_id;
    if v_reto is not null then
      perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
    end if;
    -- El sello temporal lo pone la BASE, no el caller: un update directo no puede
    -- retro ni post-datar el registro inmutable.
    new.aprobado_en := now();
    if exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'pendiente') then
      raise exception 'no se puede aprobar: checklist con pendientes';
    end if;
    if not exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id) then
      raise exception 'no se puede aprobar: el gate no tiene checklist instanciado';
    end if;
    -- Un ítem YA cumplido cuya decisión pasó a 'en-revision' por una reapertura seguía
    -- contando como suficiencia: el gate se aprobaba sobre razonamiento cuestionado. Se
    -- re-chequea al aprobar en vez de resetear los ítems al reabrir — resetear tiraría
    -- trabajo que quizá sigue en pie, y revalidar la decisión desbloquea el gate sin
    -- tocar el checklist.
    if exists (select 1 from checklist_item ci
      join decision d on d.id = ci.decision_id and d.workspace_id = ci.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and d.estado <> 'vigente') then
      raise exception 'no se puede aprobar: hay ítems cumplidos con decisiones en revisión';
    end if;
    if exists (select 1 from gate_instancia g2
      where g2.proyecto_id = new.proyecto_id and g2.workspace_id = new.workspace_id
        and g2.numero < new.numero and g2.estado <> 'aprobado') then
      raise exception 'no se puede aprobar G%: los gates anteriores deben aprobarse primero', new.numero;
    end if;
    if new.numero = 0 then
      if not exists (select 1 from criterio_exito c
        join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        where c.reto_id = p.reto_id and c.workspace_id = new.workspace_id) then
        raise exception 'no se puede aprobar G0: sin criterios de éxito (SYS-22)';
      end if;
      if exists (select 1 from criterio_exito c
        join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        where c.reto_id = p.reto_id and c.workspace_id = new.workspace_id
          and (c.ventana_dias is null
               or btrim(c.kpi) = '' or btrim(c.definicion) = '' or btrim(c.objetivo) = ''
               or ((nullif(btrim(c.linea_base_valor), '') is null or c.linea_base_fecha is null)
                   and btrim(c.linea_base_plan) = ''))) then
        raise exception 'no se puede aprobar G0: criterios incompletos (SYS-22)';
      end if;
    end if;
    -- G2 cierra el entendimiento: ningún arquetipo puede seguir siendo hipótesis, y
    -- los confirmados ya traen su evidencia (garantizada por su propio guard).
    if new.numero = 2 and exists (select 1 from arquetipo a
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where a.reto_id = p.reto_id and a.workspace_id = new.workspace_id
        and a.estado = 'hipotesis') then
      raise exception 'no se puede aprobar G2: hay arquetipos sin confirmar ni refutar (RF-04.11)';
    end if;
    -- G5 firma el DISEÑO. La etapa 5 («Detalle de solución») entrega precisamente la design
    -- version, y el criterio del gate es «design version completa y consistente, piezas
    -- críticas validadas, APROBADA POR EL CLIENTE». Así que el gate no puede aprobarse sin
    -- que exista lo que dice certificar.
    --
    -- Es el mismo argumento que la rama de G6, palabra por palabra: que el ítem del checklist
    -- esté cumplido no lo demuestra —un ítem registra un objeto citado o un N/A razonado, y
    -- no deriva nada de design_version—, así que sin esto G5 certificaba un diseño que podía
    -- no existir. Y con G5 firmado sobre la nada, `gate_certificado_del_proyecto` tampoco lo
    -- ve, con lo que después se puede aprobar cualquier versión: la aprobación del cliente
    -- acababa desligada de todo diseño concreto.
    --
    -- Se exige APROBADA (o superada: aprobada estuvo) y no un borrador, porque lo que el
    -- cliente firma tiene que estar CONGELADO. Un borrador sigue editándose después de la
    -- firma, que es exactamente la certificación-que-cambia-de-contenido que este esquema
    -- existe para impedir. `design_versions_a_cargo_del_proyecto` ya devuelve solo no
    -- borradores, así que basta con reusarla — la misma que usan G6 y G7.
    --
    -- Lo que esto NO hace es fijar G5 a UNA versión concreta, y es deliberado: ver el porqué
    -- en `gate_certificado_del_proyecto`, donde se explica por qué G5 no entra en ese
    -- conjunto. Aquí se exige que el diseño exista y esté congelado, no que sea para siempre
    -- el único.
    if new.numero = 5 and not exists (
      select 1 from design_version dv
      where dv.id in (select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))
        and exists (select 1 from elemento_cambio ec
          where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id)
    ) then
      raise exception 'no se puede aprobar G5: el proyecto no tiene ninguna design version aprobada con elementos que certificar (RF-06.3)';
    end if;
    -- G6 firma el PLAN (RF-06.4): «cada elemento de la design version queda asignado a
    -- exactamente un release con dueño y fecha». Que el ítem del checklist esté cumplido
    -- no lo demuestra — un ítem cumplido registra un objeto citado o un N/A razonado, y
    -- no deriva nada de release_elemento—, así que sin esto G6 certificaba un plan que
    -- podía no existir. El «exactamente uno» ya lo garantiza la PK de release_elemento; lo
    -- que faltaba era el «cada». Dueño y fecha no hay que comprobarlos: release.responsable
    -- y fecha_objetivo son not null con CHECK, así que estar asignado ya los implica.
    if new.numero = 6 then
      -- El conjunto es «de qué responde este proyecto» (design_versions_a_cargo_del_proyecto)
      -- y no «cuál manda en el servicio»: que otro proyecto haya superado la versión de este
      -- no deshace su plan, solo deja de ser la vigente. Lo que sí la saca es que este mismo
      -- proyecto la haya reemplazado.
      --
      -- El gemelo vacuo, igual que en G7: sin design version con elementos no hay plan que
      -- firmar, y el «no exists elemento sin release» de abajo sería vacuamente cierto por
      -- no haber ningún elemento que mirar.
      if not exists (
        select 1 from design_version dv
        where dv.id in (select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))
          and exists (select 1 from elemento_cambio ec
            where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id)
      ) then
        raise exception 'no se puede aprobar G6: el proyecto no tiene ninguna design version con elementos que planificar (RF-06.4)';
      end if;
      if exists (
        select 1 from elemento_cambio ec
        where ec.workspace_id = new.workspace_id
          and ec.design_version_id in (
            select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))
          and not exists (select 1 from release_elemento re
            where re.elemento_id = ec.id and re.workspace_id = ec.workspace_id)
      ) then
        raise exception 'no se puede aprobar G6: hay elementos de la design version sin release asignado (RF-06.4)';
      end if;
    end if;
    -- G7 cierra la implementación (RF-06.7). Las cuatro ramas del predicado —hay tablero,
    -- lo propio está constatado, lo que la cadena del servicio dejó a medias, y lo que una
    -- versión auto-superada dejó en vuelo— viven en `g7_motivo_de_bloqueo`, con el porqué
    -- de cada una escrito allí. Aquí solo se levanta el motivo que devuelva.
    --
    -- Está fuera del guard a propósito y no por gusto: la pantalla de conciliación tiene
    -- que decir exactamente lo que el gate va a rechazar, y mientras eso se escribía dos
    -- veces siempre le faltaba una rama a la copia. Una sola redacción, dos lectores.
    if new.numero = 7 then
      v_motivo := g7_motivo_de_bloqueo(new.proyecto_id, new.workspace_id);
      if v_motivo is not null then
        raise exception 'no se puede aprobar G7: %', v_motivo;
      end if;
    end if;
    -- Efectos INSEPARABLES de la transición, también para el UPDATE directo: la etapa
    -- homóloga se completa y el evento inmutable queda con el actor y su rol del
    -- MISMO snapshot. aprobarGate ya no los duplica: esta es la única fuente.
    update etapa_instancia set estado = 'completada'
      where proyecto_id = new.proyecto_id and workspace_id = new.workspace_id
        and numero = new.numero;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'GateAprobado',
        jsonb_build_object('gateId', new.id, 'proyectoId', new.proyecto_id,
                           'numero', new.numero),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ══ El portal alcanza la design version (SPEC-01, RF-01.5) ══
-- La migración del portal dejó el alta pendiente con nombre y apellidos: «design version
-- y post mortem entran al arco cuando lleguen con sus specs». SPEC-06 la trae, y sin este
-- bloque el objeto MÁS comentable de la cadena —lo que se decidió cambiar, que es
-- exactamente sobre lo que el cliente opina— era el único que no admitía hilo.
--
-- Se hace aquí y no editando la migración del portal porque aquella ya está aplicada: las
-- migraciones son forward-only. Y se hace DESPUÉS de crear design_version, que es lo que
-- permite que la FK compuesta exista de verdad.

-- El arco es EXCLUSIVO y el CHECK cuenta cuántas columnas van llenas, así que hay que
-- reemplazarlo: con la columna nueva a null y las otras cuatro también, un hilo de design
-- version daría num_nonnulls = 0 y la fila se rechazaría. Se localiza por su definición y
-- no por un nombre adivinado — el CHECK del portal es anónimo, y su nombre generado es un
-- detalle de implementación que nadie escribió.
do $$
declare v_check text;
begin
  select conname into strict v_check from pg_constraint
  where conrelid = 'hilo_comentario'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%num_nonnulls%';
  execute format('alter table hilo_comentario drop constraint %I', v_check);
end $$;

alter table hilo_comentario add column design_version_id uuid;
alter table hilo_comentario
  add constraint hilo_comentario_objeto_unico
    check (num_nonnulls(reto_id, proyecto_id, gate_id, evidencia_id, design_version_id) = 1),
  add foreign key (design_version_id, workspace_id) references design_version (id, workspace_id);

-- Las columnas generadas no admiten cambio de expresión en 16 (SET EXPRESSION llegó en
-- 17), así que se rehacen. Recalcular no pierde nada: son proyección pura de las columnas
-- del arco, y siguen sin poder escribirse — que es lo que impide falsear a qué objeto
-- apunta un hilo. Al dropearlas se va con ellas el índice que las usa; vuelve idéntico.
alter table hilo_comentario drop column objeto_tipo, drop column objeto_id;
alter table hilo_comentario
  add column objeto_tipo text generated always as (
    case
      when reto_id is not null then 'reto'
      when proyecto_id is not null then 'proyecto'
      when gate_id is not null then 'gate_instancia'
      when evidencia_id is not null then 'evidencia'
      when design_version_id is not null then 'design_version'
    end
  ) stored,
  add column objeto_id uuid generated always as (
    coalesce(reto_id, proyecto_id, gate_id, evidencia_id, design_version_id)
  ) stored;
create index hilo_objeto_idx on hilo_comentario (workspace_id, objeto_tipo, objeto_id, creado_en, id);

-- Sin políticas ni grants nuevos a propósito: las del portal no miran QUÉ objeto cuelga
-- del hilo —quién puede abrirlo y comentarlo es cuestión de rol, no de objeto— y el grant
-- de INSERT es de tabla, así que la columna nueva entra sin ampliar ningún permiso. La
-- design version no añade una regla de portal distinta: añade un objeto al arco.

-- ══ Grants mínimos (UPDATE por columnas) ══
grant select, insert on design_version, elemento_cambio to designio_app;
grant select, insert on elemento_decision, elemento_insight to designio_app;
grant select, insert on release, release_elemento to designio_app;
grant select, insert on effective_state, constatacion to designio_app;
-- La aprobación mueve estado, autor y snapshot, y el borrador puede reenlazar su journey
-- (design_version_enlazar_journey). `aprobada_en` NO está: lo escribe solo el guard, así
-- que la promesa «el sello lo pone la base» es estructural, no una disciplina del
-- servicio. `supera_a` entra por el mismo motivo que `journey_id`: la sucesión se declara
-- al abrir el borrador, pero el servicio puede aprobar otra versión mientras tanto —o la
-- declarada puede perder su propia carrera de sucesión, que el índice parcial admite
-- expresamente— y sin poder reapuntarla el borrador quedaría muerto. Tampoco están
-- `titulo`, `resumen`, `servicio_id` ni `proyecto_id`: de un borrador solo se corrige a
-- qué grafo apunta y a qué versión sucede.
grant update (estado, aprobada_por, snapshot_id, journey_id, supera_a) on design_version to designio_app;
-- El release mueve estado y la fecha real de despliegue; nunca su código, su dueño ni
-- su design version (eso sería otro release).
grant update (estado, desplegado_en) on release to designio_app;
-- El elemento se corrige mientras la DV está en borrador; jamás cambia de design
-- version (la política ya lo impediría; el grant lo hace imposible de intentar).
grant update (tipo, operacion, titulo, detalle, nodo_id, orden) on elemento_cambio to designio_app;
grant delete on elemento_cambio, elemento_decision, elemento_insight to designio_app;
grant delete on release_elemento to designio_app;
-- Sin DELETE en design_version, release, effective_state ni constatacion: los cuatro
-- objetos de resultado son el registro de lo que pasó.
