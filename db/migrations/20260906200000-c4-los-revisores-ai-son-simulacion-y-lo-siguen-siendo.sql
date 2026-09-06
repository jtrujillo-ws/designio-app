-- ── Los revisores AI son simulación, y lo siguen siendo después de aceptarlos ──
--
-- Etapa 4 del método admite una revisión adversarial de los conceptos hecha con los ARQUETIPOS
-- del reto como lentes (prediseño §4.2, RF-08.2): el arquetipo cuestiona el concepto desde sus
-- características, señala fricciones y exclusiones, y de ahí salen PREGUNTAS para el test que
-- se hará con personas reales. Es C4, y llega con una restricción que no es un adorno de la
-- pantalla sino la razón de que la capacidad exista con esta forma y no otra:
--
--   SYS-20 — «Las salidas de revisores AI quedan etiquetadas como simulación, no son evidencia
--   y no computan en los checklists de G4/G5; no existen simulaciones masivas ni porcentajes
--   sintéticos.»
--
-- La tentación que el journey J4 llama «fricción central y deliberada» es usar la simulación
-- como validación: doce revisores dicen que el concepto convence, y eso se parece mucho a un
-- test. No lo es, y aquí no se pide que nadie se acuerde de que no lo es. Cada mitad de SYS-20
-- se escribe donde se comprueba:
--
--   · «No son evidencia y no computan en G4/G5» — RF-08.3 dice cómo: «el TIPO DE OBJETO lo
--     impide». `checklist_item` tiene exactamente tres columnas para citar —`evidencia_id`,
--     `insight_id`, `decision_id`— y tres CHECK que cuentan `num_nonnulls` sobre esas tres. Una
--     tabla nueva no tiene dónde colgarse: no hay que prohibirlo porque no hay por dónde. Lo
--     que sí hace falta es que eso no se rompa por descuido, y de eso se encarga un censo en la
--     suite —si alguien añade una cuarta columna citable, la prueba obliga a decir en voz alta
--     qué pasa con C4—.
--
--   · «No existen simulaciones masivas» — `unique (concepto_id, arquetipo_id)`. Un arquetipo
--     lee un concepto UNA vez. No hay modo «N usuarios» porque no hay dónde meter el segundo
--     usuario del mismo arquetipo, y los arquetipos del reto son los que son —cada uno con su
--     evidencia enlazada, que es lo que G2 les exige—. La prohibición no es una regla que
--     alguien evalúa: es la forma de la clave.
--
--   · «Ni porcentajes sintéticos» — `sin_agregado_sintetico()`, abajo, sobre los tres textos
--     que el modelo escribe. «El 70 % de los desconfiados digitales abandonaría» es la frase
--     exacta que SYS-20 prohíbe, y la prohíbe porque ese 70 % no lo midió nadie.
--
--   · «Etiquetadas como simulación» — `es_simulacion boolean not null default true` con
--     `check (es_simulacion)`. La columna existe para no poder ser falsa: quitar la etiqueta
--     exige borrar la fila. En el lado de la propuesta la marca ya viajaba —`propuesta_ai.
--     es_simulacion` y la bandera `esSimulacion` del registro de capacidades se pusieron en su
--     día con este caso escrito en el comentario—; lo que faltaba era que sobreviviera a la
--     aceptación, que es cuando la propuesta se convierte en un objeto que la gente mira.
--
-- Y la otra mitad de RF-08.2 —«hallazgos derivados del arquetipo y evidencia citada;
-- extrapolaciones marcadas como hipótesis»— es la regla de `hallazgo_simulado`: o el hallazgo
-- cita evidencia real, o va marcado como hipótesis. Un hallazgo sin ninguna de las dos cosas es
-- una afirmación inventada con aspecto de voz de usuario, que es la avería que SYS-20 teme.

-- ── El agregado sintético, escrito una vez y con nombre ──
--
-- Se nombra en vez de repetir la expresión en cada CHECK por lo mismo que `titulo_normalizado`:
-- tres redacciones de la misma regla acaban siendo tres reglas distintas, y la que se olvide de
-- actualizar es justo la que alguien va a usar.
--
-- Qué se rechaza, y por qué solo eso: un número pegado a un `%`, y la forma «N de cada M».
-- Son las dos maneras de escribir un dato de campo que nadie recogió. No se intenta detectar
-- «muchos usuarios» ni «la mayoría»: eso es prosa cualitativa, se lee como tal y quien revisa
-- puede juzgarla. Lo que este predicado corta es lo que se lee como MEDICIÓN, que es lo que
-- confunde una simulación con un test.
create function sin_agregado_sintetico(p_texto text) returns boolean
language sql immutable as $fn$
  -- `\m` y `\M` marcan frontera de palabra: sin ellas, «100%» dentro de una URL o de un
  -- identificador daría un falso positivo, y el motivo del rechazo no se entendería.
  --
  -- Y `!~*`, insensible a mayúsculas: «6 DE CADA 10» es la misma proporción sintética que
  -- «6 de cada 10», y con `!~` pasaba. Lo mismo en el contrato, que tenía la misma grieta: dos
  -- capas de validación dejando entrar lo mismo no son dos capas.
  -- «70 por ciento» es el mismo porcentaje deletreado, y pasaba las dos capas. Igual que
  -- «6 DE CADA 10»: dos capas que dejan entrar lo mismo no son dos capas.
  --
  -- Y la proporción con BARRA, que es «N de cada M» por otra puerta. Va con la comparación de
  -- los dos números —«6/10» es proporción y «24/7» es «siempre»—, y con los bordes exigiendo
  -- que no haya otra cifra ni otra barra pegada, para no confundir una fecha («6/10/2026»),
  -- una ruta («/a/1/2») ni una versión («1/2/3») con una medición. El falso bloqueo cuesta el
  -- lote entero, y ya costó una ronda con «v2r100%».
  --
  -- Lo que NO cubre, dicho a propósito: los numerales escritos («siete de cada diez»). Pide un
  -- léxico de números en las dos capas, y a medias sería peor que la ausencia declarada.
  select p_texto !~ '\m\d+([.,]\d+)?\s*%'
     and p_texto !~* '\m\d+\s+de\s+cada\s+\d+\M'
     and p_texto !~* '\m\d+([.,]\d+)?\s*por\s?ciento\M'
     and not exists (
       select 1
       from regexp_matches(p_texto,
              '(^|[^0-9/])([0-9]+)[[:space:]]*/[[:space:]]*([0-9]+)([^0-9/]|$)', 'g') as m
       where (m[2])::numeric <= (m[3])::numeric);
$fn$;

revoke execute on function sin_agregado_sintetico(text) from public;
grant execute on function sin_agregado_sintetico(text) to designio_app;

-- ── EL DERECHO QUE VENCE HOY, SOBRE LA EVIDENCIA QUE DE VERDAD SE MANDA ──
--
-- Hermana de `derecho_del_reto_que_vence_ya`, que C2 usa, y hace falta aparte por una razón
-- concreta: aquélla recorre TODOS los arquetipos del reto, y el lote de C4 manda solo las
-- lentes de su ventana —las que tienen evidencia, las no revisadas todavía, y como mucho seis—.
-- Preguntar por el reto entero bloquearía una llamada legítima por un permiso que vence en un
-- arquetipo que este lote ni siquiera enseña. Ésta recibe LA LISTA de lo que se manda.
--
-- El margen no es de medianoche: se pregunta por el día ENTERO. Un permiso que vence HOY no
-- llega vivo al final del camino —entre la llamada y el sello hay un commit, la respuesta del
-- proveedor y una revisión humana, que no ocurre en el mismo minuto—, así que mañana la
-- aceptación fallaría con DR001 y quedaría una revisión pagada, leída y solo tirable. Con el
-- último día ya fuera, además, no queda medianoche que cruzar: `current_date` se congela al
-- empezar la transacción, así que una que arranca a las 23:59 despacharía pasada la medianoche
-- un documento cuyo permiso ya expiró.
--
-- `evidencia_usable` no se toca: es LA definición de «se puede usar» y para leer o citar HOY
-- sigue siendo la correcta. Ésta es una pregunta distinta y más estricta, y solo puede errar en
-- la dirección de no gastar.
--
-- Anti-oráculo como sus hermanas: `security definer` y concedida al rol de aplicación, así que
-- sin la primera rama contestaría por workspaces ajenos —y lo que contesta es el TÍTULO de un
-- documento de otro cliente—.
create function derecho_que_vence_ya(p_evidencias uuid[], p_ws uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $fn$
  select case
    when session_user = 'designio_app' and not is_workspace_member(app_user_id(), p_ws)
      then null
    else (
      select e.titulo
        from derecho_uso du
        join evidencia e on e.id = du.evidencia_id and e.workspace_id = du.workspace_id
       where du.workspace_id = p_ws
         and du.evidencia_id = any (p_evidencias)
         and du.estado = 'concedido' and du.ambito in ('cliente', 'publico')
         and du.vence_en is not null
         and du.vence_en <= timezone('UTC', now())::date
       order by e.titulo asc
       limit 1)
  end
$fn$;

revoke execute on function derecho_que_vence_ya(uuid[], uuid) from public;
grant execute on function derecho_que_vence_ya(uuid[], uuid) to designio_app;

-- ── La sesión de revisión: un arquetipo, un concepto, una lectura ──
create table revision_simulada (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  concepto_id uuid not null,
  arquetipo_id uuid not null,
  -- La etiqueta, y no puede ser falsa. El `default` es para que omitirla al insertar tampoco
  -- deje un hueco: en `propuesta_ai` el default es `false` —allí la mayoría de capacidades no
  -- son simulación— y aquí es al revés, porque aquí TODAS lo son.
  es_simulacion boolean not null default true,
  -- La lectura del arquetipo sobre el concepto: de qué va esta sesión, en una frase larga.
  sintesis text not null,
  -- El linaje: de qué propuesta salió. Nullable porque una revisión se puede escribir a mano
  -- —SYS-21, todo flujo sigue disponible sin AI— y entonces no hay propuesta detrás.
  propuesta_ai_id uuid,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  -- LA PROHIBICIÓN DE LA SIMULACIÓN MASIVA, escrita como clave y no como regla.
  unique (concepto_id, arquetipo_id),
  foreign key (concepto_id, workspace_id) references concepto (id, workspace_id),
  foreign key (arquetipo_id, workspace_id) references arquetipo (id, workspace_id),
  check (es_simulacion),
  check (titulo_normalizado(sintesis) <> '' and length(sintesis) <= 2000),
  check (sin_agregado_sintetico(sintesis))
);

create index revision_simulada_concepto_idx on revision_simulada (workspace_id, concepto_id);

-- ── Los hallazgos: o citan evidencia real, o se marcan como hipótesis ──
create table hallazgo_simulado (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  revision_id uuid not null,
  orden smallint not null,
  titulo text not null,
  descripcion text not null,
  -- RF-08.2: «cuando extrapolen, se marcan como hipótesis». Sin default: quien escribe un
  -- hallazgo tiene que decir cuál de las dos cosas es. Un default convertiría la pregunta en
  -- una casilla que se queda como venga.
  es_hipotesis boolean not null,
  unique (id, workspace_id),
  unique (revision_id, orden),
  -- Y la pareja que la pregunta de test necesita para atarse al mismo hallazgo de su revisión,
  -- sin un trigger que lo compruebe.
  unique (id, revision_id),
  foreign key (revision_id, workspace_id)
    references revision_simulada (id, workspace_id) on delete cascade,
  check (titulo_normalizado(titulo) <> '' and length(titulo) <= 200),
  check (titulo_normalizado(descripcion) <> '' and length(descripcion) <= 2000),
  check (sin_agregado_sintetico(titulo) and sin_agregado_sintetico(descripcion))
);

create index hallazgo_simulado_revision_idx on hallazgo_simulado (workspace_id, revision_id);

-- La evidencia que sostiene un hallazgo. Hermana de `arquetipo_evidencia` y de
-- `concepto_evidencia`, con la misma FK compuesta que ata las dos puntas al mismo workspace.
create table hallazgo_simulado_evidencia (
  hallazgo_id uuid not null,
  evidencia_id uuid not null,
  workspace_id uuid not null references workspace(id),
  primary key (hallazgo_id, evidencia_id),
  foreign key (hallazgo_id, workspace_id)
    references hallazgo_simulado (id, workspace_id) on delete cascade,
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id)
);

-- ── Las preguntas para el test real: la ÚNICA salida legítima de una simulación ──
--
-- El journey lo dice con el ejemplo: «el revisor del "desconfiado digital" señala riesgo de
-- exclusión (simulación → origina una pregunta del test)». La simulación no valida nada; lo que
-- hace es decirle al equipo qué preguntar cuando se siente delante de una persona.
--
-- `hallazgo_id` es opcional y apunta al hallazgo del que nace, cuando nace de uno: la FK va
-- contra `(id, revision_id)` para que una pregunta no pueda colgarse de un hallazgo de OTRA
-- revisión. Eso no necesita guard porque la clave ya lo dice.
create table pregunta_de_test (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  revision_id uuid not null,
  hallazgo_id uuid,
  orden smallint not null,
  pregunta text not null,
  -- El escenario en el que preguntarla. Puede ir vacío: hay preguntas que no necesitan montaje.
  escenario text not null default '',
  unique (id, workspace_id),
  unique (revision_id, orden),
  foreign key (revision_id, workspace_id)
    references revision_simulada (id, workspace_id) on delete cascade,
  foreign key (hallazgo_id, revision_id)
    references hallazgo_simulado (id, revision_id) on delete cascade,
  check (titulo_normalizado(pregunta) <> '' and length(pregunta) <= 500),
  check (length(escenario) <= 1000),
  check (sin_agregado_sintetico(pregunta) and sin_agregado_sintetico(escenario))
);

create index pregunta_de_test_revision_idx on pregunta_de_test (workspace_id, revision_id);

-- ── UN HALLAZGO QUE NO SE MARCA HIPÓTESIS TIENE QUE CITAR EVIDENCIA REAL ──
--
-- La regla de RF-08.2 leída al derecho: «sus afirmaciones deben derivarse del arquetipo y de
-- evidencia real citada; cuando extrapolen, se marcan como hipótesis». O sea que hay
-- exactamente dos clases de hallazgo legítimo —el que se apoya en un documento que alguien
-- recogió, y el que dice abiertamente que está extrapolando— y ninguna tercera. La tercera es
-- la avería: una frase con voz de usuario, sin nada detrás y sin avisar de que no lo hay.
--
-- Va en un trigger DIFERIDO y no en un CHECK porque la condición cruza filas de dos tablas y no
-- puede estar satisfecha en el instante del INSERT: el hallazgo nace antes que sus citas, por
-- fuerza. Diferido significa que la pregunta se hace al COMMIT, cuando la transacción ya escribió
-- todo lo que iba a escribir, y ahí sí la respuesta es la definitiva.
--
-- Corre sobre las DOS tablas: sobre `hallazgo_simulado` para el que nace sin citas, y sobre
-- `hallazgo_simulado_evidencia` para el DELETE que deja al hallazgo sin ninguna. Sin la segunda
-- mitad, desenlazar la última cita de un hallazgo afirmativo lo convertiría en la tercera clase
-- sin que nada fallara.
create function hallazgo_simulado_sostenido_guard() returns trigger
language plpgsql as $fn$
declare
  v_hallazgo uuid;
  v_es_hipotesis boolean;
begin
  -- Del INSERT sobre el hallazgo sale su propio id; del borrado de una cita, el hallazgo que se
  -- quedó sin ella. A una variable, y no leído del `record` dentro de la condición, por la
  -- lección que dejó escrita `concepto_candado_del_reto_guard`: plpgsql resuelve los campos de
  -- un `record` al planificar, así que nombrar un campo que la otra rama no tiene revienta
  -- también en la rama que sí lo tiene.
  if tg_table_name = 'hallazgo_simulado' then
    v_hallazgo := new.id;
  else
    v_hallazgo := old.hallazgo_id;
  end if;
  -- Si el hallazgo ya no está —se borró él, o cayó con su revisión por el `on delete cascade`—
  -- no hay nada que exigir: la pregunta era sobre una fila que ya no existe. Sin esta salida,
  -- borrar una revisión entera fallaría en el commit contra sus propios hallazgos.
  select h.es_hipotesis into v_es_hipotesis
    from hallazgo_simulado h where h.id = v_hallazgo;
  if not found then
    return null;
  end if;
  if not v_es_hipotesis and not exists (
    select 1 from hallazgo_simulado_evidencia e where e.hallazgo_id = v_hallazgo
  ) then
    raise exception 'un hallazgo de revisión simulada que no se marca como hipótesis tiene que citar al menos una evidencia real: sin cita y sin marca es una afirmación inventada con voz de usuario (RF-08.2, SYS-20)';
  end if;
  return null;
end;
$fn$;

revoke execute on function hallazgo_simulado_sostenido_guard() from public;

-- `z_` para que quede por detrás de `a_congelacion_por_disposicion`, como sus hermanos.
create constraint trigger z_hallazgo_sostenido
  after insert on hallazgo_simulado
  deferrable initially deferred
  for each row execute function hallazgo_simulado_sostenido_guard();
create constraint trigger z_hallazgo_sostenido
  after delete on hallazgo_simulado_evidencia
  deferrable initially deferred
  for each row execute function hallazgo_simulado_sostenido_guard();

-- ── Y LA EVIDENCIA CITADA ES LA QUE SOSTIENE AL ARQUETIPO QUE ESTÁ REVISANDO ──
--
-- «Derivadas del arquetipo Y de evidencia real citada» es una sola condición, no dos sueltas:
-- lo que hace del hallazgo la lectura DE ESE ARQUETIPO es que se apoye en lo que constituyó a
-- ese arquetipo. Citar una entrevista del reto que el arquetipo no mira produce una frase que
-- suena a él y no sale de él —«el desconfiado digital abandonaría», sostenido en el testimonio
-- de un apurado de RR. HH.—, y esa es la forma más limpia de fabricar una voz.
--
-- Coincide además con lo que el modelo pudo leer: el material de C4 lleva el concepto, el
-- arquetipo y la evidencia DE ESE ARQUETIPO, así que la regla de presencia literal ya acota las
-- citas a ese conjunto. Esto lo dice en la base, que es donde sigue siendo verdad cuando la
-- revisión se escribe a mano.
create function hallazgo_simulado_evidencia_del_arquetipo_guard() returns trigger
language plpgsql as $fn$
declare
  v_arquetipo uuid;
begin
  select r.arquetipo_id into v_arquetipo
    from hallazgo_simulado h
    join revision_simulada r on r.id = h.revision_id and r.workspace_id = h.workspace_id
   where h.id = new.hallazgo_id and h.workspace_id = new.workspace_id;
  if v_arquetipo is null then
    raise exception 'ese hallazgo no existe en este workspace';
  end if;
  if not exists (
    select 1 from arquetipo_evidencia ae
     where ae.arquetipo_id = v_arquetipo
       and ae.evidencia_id = new.evidencia_id
       and ae.workspace_id = new.workspace_id
  ) then
    raise exception 'esa evidencia no es de las que sostienen al arquetipo que hace la revisión: un hallazgo suyo no puede apoyarse en material que él no mira (RF-08.2)';
  end if;
  return new;
end;
$fn$;

revoke execute on function hallazgo_simulado_evidencia_del_arquetipo_guard() from public;

create trigger c_evidencia_del_arquetipo
  before insert or update on hallazgo_simulado_evidencia
  for each row execute function hallazgo_simulado_evidencia_del_arquetipo_guard();

-- ── LOS DERECHOS DE LA EVIDENCIA CITADA, POR EL MISMO CAMINO QUE SUS DOS HERMANAS ──
--
-- El inventario de la suite obliga a decidir, por cada superficie que enlaza evidencia, cuál de
-- las dos cosas es: uso aguas abajo con guard de derechos, o excepción con motivo escrito.
--
-- Es lo primero, aunque la tentación sea decir que no: «son hallazgos simulados, no se le
-- enseñan al cliente». Sí se le enseñan —la revisión vive en el expediente del concepto y se lee
-- en la pantalla— y sobre todo dicen «esto se apoya en el documento X». Sostener una frase, aun
-- etiquetada como simulación, en material que no se puede citar es exactamente lo que
-- `evidencia_citable_guard` existe para impedir. Que la frase sea simulada no cambia que el
-- documento sea real.
create trigger evidencia_citable
  before insert or update on hallazgo_simulado_evidencia
  for each row execute function evidencia_citable_guard();

-- ── EL CANDADO DEL RETO, QUE ES EL QUE TOMA LA APROBACIÓN DE G4 ──
--
-- Hermano de `concepto_candado_del_reto_guard`, y por la misma razón: escribir una revisión
-- —o un hallazgo, o una pregunta— sobre un concepto cuya etapa 4 acaba de cerrarse es meter
-- trabajo de método en un expediente que un gate ya miró. La ventana es la MISMA que la de los
-- conceptos, `reto_admite_conceptos`, y no una redacción nueva: si mañana esa ventana cambia,
-- tiene que cambiar para las dos cosas a la vez o el concepto y su revisión dejarán de estar
-- de acuerdo sobre cuándo se pueden tocar.
--
-- El reto se resuelve por caminos de distinta profundidad según la tabla que dispare, y cada
-- uno va a su VARIABLE antes de usarse: plpgsql resuelve los campos de un `record` al
-- planificar cada sentencia, así que nombrar `v_fila.revision_id` en una condición que también
-- corre para `revision_simulada` —que no tiene ese campo— revienta en las dos ramas. La lección
-- está pagada dos veces ya, en la oportunidad y en el concepto.
create function revision_simulada_candado_del_reto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_fila record;
  v_concepto uuid;
  v_revision uuid;
  v_hallazgo uuid;
  v_reto uuid;
begin
  v_fila := coalesce(new, old);
  if tg_table_name = 'revision_simulada' then
    v_concepto := v_fila.concepto_id;
  elsif tg_table_name = 'hallazgo_simulado_evidencia' then
    v_hallazgo := v_fila.hallazgo_id;
    select h.revision_id into v_revision
      from hallazgo_simulado h
      where h.id = v_hallazgo and h.workspace_id = v_fila.workspace_id;
  else
    -- `hallazgo_simulado` y `pregunta_de_test`, que cuelgan de la revisión directamente.
    v_revision := v_fila.revision_id;
  end if;
  if v_concepto is null and v_revision is not null then
    select r.concepto_id into v_concepto
      from revision_simulada r
      where r.id = v_revision and r.workspace_id = v_fila.workspace_id;
  end if;
  if v_concepto is not null then
    select c.reto_id into v_reto
      from concepto c
      where c.id = v_concepto and c.workspace_id = v_fila.workspace_id;
  end if;
  -- Sin reto no hay ventana que preguntar: es el borrado en cascada, donde el padre ya no está.
  if v_reto is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
    -- Y la FILA del reto detrás de la clave, que es el orden del sistema.
    perform 1 from reto r
      where r.id = v_reto and r.workspace_id = v_fila.workspace_id
      for share;
    -- Y VOLVER A PREGUNTAR con el candado en la mano: RLS se evaluó con la instantánea del
    -- inicio de la sentencia, antes de que existiera este candado, y Postgres no vuelve a
    -- evaluar la política porque un trigger BEFORE se haya quedado esperando.
    --
    -- El propietario no pasa por políticas y tampoco por aquí: seed, migraciones y backfills
    -- administran la base y responden por lo que escriben.
    if session_user = 'designio_app'
       and not reto_admite_conceptos(v_reto, v_fila.workspace_id) then
      raise exception 'la etapa 4 de ese reto está cerrada: o su G4 está aprobado sin la etapa reabierta, o el reto ya no admite trabajo de método';
    end if;
    -- Y EL ESTADO DEL CONCEPTO, que es la otra mitad de la misma pregunta y faltaba.
    --
    -- Las políticas piden `candidato`, y eso cierra la escritura tardía SECUENCIAL. No la
    -- concurrente, por lo que dice el párrafo de arriba: la instantánea con la que RLS decidió
    -- se tomó antes de que este trigger empezara a esperar, así que el veredicto que se firma
    -- MIENTRAS espera no lo ve nadie — ni la política, que ya decidió, ni este recheck, que
    -- preguntaba solo por la ventana del reto.
    --
    -- El estado del concepto llegó a las políticas dos rondas después de que este recheck se
    -- escribiera, y no lo traje hasta aquí: la regla acabó con una capa menos justo en el
    -- instante para el que esta función existe.
    --
    -- Se lee en una sentencia propia y por eso ve el commit ajeno: en READ COMMITTED cada
    -- sentencia de una función volátil toma instantánea nueva. Es lo mismo que hace que la
    -- comprobación de la ventana de arriba sirva de algo.
    if session_user = 'designio_app' and v_concepto is not null
       and not exists (select 1 from concepto c
                        where c.id = v_concepto and c.workspace_id = v_fila.workspace_id
                          and c.estado = 'candidato') then
      raise exception 'ese concepto ya no es candidato: su veredicto se firmó mientras esta escritura esperaba el candado del reto, así que llega después del pasa/muere que la revisión existía para informar';
    end if;
  end if;
  return v_fila;
end;
$fn$;

revoke execute on function revision_simulada_candado_del_reto_guard() from public;

-- `b_` para quedar detrás de `a_congelacion_por_disposicion`, que toma el candado del workspace:
-- el orden del sistema es workspace → reto, y el prefijo es lo que lo fija.
create trigger b_candado_del_reto
  before insert or update or delete on revision_simulada
  for each row execute function revision_simulada_candado_del_reto_guard();
create trigger b_candado_del_reto
  before insert or update or delete on hallazgo_simulado
  for each row execute function revision_simulada_candado_del_reto_guard();
create trigger b_candado_del_reto
  before insert or delete on hallazgo_simulado_evidencia
  for each row execute function revision_simulada_candado_del_reto_guard();
create trigger b_candado_del_reto
  before insert or update or delete on pregunta_de_test
  for each row execute function revision_simulada_candado_del_reto_guard();

-- ── Y la congelación por disposición, que abre en toda tabla de workspace ──
--
-- Tiene su propio censo en la suite: una tabla nueva con `workspace_id` que no la lleve sale
-- listada. Se pone aquí y no se espera al censo porque el censo dice QUÉ falta, no lo arregla.
create trigger a_congelacion_por_disposicion
  before insert or update or delete on revision_simulada
  for each row execute function congelacion_por_disposicion_guard();
create trigger a_congelacion_por_disposicion
  before insert or update or delete on hallazgo_simulado
  for each row execute function congelacion_por_disposicion_guard();
create trigger a_congelacion_por_disposicion
  before insert or update or delete on hallazgo_simulado_evidencia
  for each row execute function congelacion_por_disposicion_guard();
create trigger a_congelacion_por_disposicion
  before insert or update or delete on pregunta_de_test
  for each row execute function congelacion_por_disposicion_guard();

alter table revision_simulada enable row level security;
alter table hallazgo_simulado enable row level security;
alter table hallazgo_simulado_evidencia enable row level security;
alter table pregunta_de_test enable row level security;

-- Verlas es de todo miembro del workspace.
create policy revision_simulada_select on revision_simulada
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy hallazgo_simulado_select on hallazgo_simulado
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy hallazgo_simulado_evidencia_select on hallazgo_simulado_evidencia
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy pregunta_de_test_select on pregunta_de_test
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- Escribe quien hace método, mientras la etapa 4 siga abierta para este reto Y mientras el
-- concepto siga siendo CANDIDATO.
--
-- Las dos condiciones y no una. La etapa abierta es del reto; el estado es de ESTE concepto, y
-- se decide antes: `reto_admite_conceptos` sigue diciendo que sí durante todo el tiempo en que
-- los demás conceptos del reto se exploran. Sin la segunda, una revisión podía entrar después
-- del pasa/muere que existía para informar, y quedarse en el expediente con aspecto de haberlo
-- informado. La aceptación por la vía AI ya no llega ahí —`huellaDelMaterialDeRevision` no
-- devuelve material para un concepto decidido—, pero un insert directo por la superficie
-- concedida sí, y ésa es la que esta política guarda.
create policy revision_simulada_insert on revision_simulada
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    -- El arquetipo, DEL RETO DEL CONCEPTO. Las dos claves ajenas de la tabla solo dicen que
    -- concepto y arquetipo son del mismo WORKSPACE, que es mucho menos: sin este predicado un
    -- curador puede colgar la lente del reto B de un concepto del reto A, y a partir de ahí
    -- todos los guards de evidencia le dan la razón —comprueban contra la evidencia de SU
    -- arquetipo, que es la de B—. Sale una revisión bien formada y sin sentido.
    and exists (select 1 from concepto c
      join arquetipo a on a.reto_id = c.reto_id and a.workspace_id = c.workspace_id
      where c.id = revision_simulada.concepto_id
        and c.workspace_id = revision_simulada.workspace_id
        and a.id = revision_simulada.arquetipo_id
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

-- Y las hojas, con la MISMA puerta del estado que su padre. Sin ella, una revisión creada
-- mientras el concepto era candidato sigue admitiendo hallazgos, citas y preguntas DESPUÉS del
-- pasa/muere: contenido nuevo dentro de un objeto viejo, que en el expediente se lee como si
-- hubiera informado el veredicto. Que el padre esté cerrado no cierra a los hijos.
-- Y LAS TRES PIDEN QUE LA REVISIÓN NO ESTÉ SELLADA TODAVÍA.
--
-- «revision_simulada.propuesta_ai_id» lo estampa el guard de materialización, y lo estampa al
-- FINAL: la aceptación inserta la revisión, sus hallazgos, sus citas y sus preguntas, y sólo
-- entonces el UPDATE de la propuesta dispara el guard que sella. Así que dentro de la
-- aceptación el sello sigue en null y estas tres políticas dejan escribir; después, ya no.
--
-- Sin eso, un curador podía añadir un hallazgo o una pregunta A UNA REVISIÓN YA ACEPTADA —el
-- guard de materialización no vuelve a correr, porque no hay UPDATE de propuesta que lo
-- dispare— y el archivo presentaba contenido escrito a mano bajo la etiqueta «propuesta por
-- AI». La procedencia es de la fila entera: o todo salió de esa propuesta, o la etiqueta miente
-- sobre la parte que no. Y no es cosmético: lo que se lee ahí decide un pasa/muere.
--
-- Una revisión escrita a mano (SYS-21) tiene el sello en null para siempre, así que se sigue
-- montando y ampliando igual. Lo que se cierra es el añadido a lo que YA se firmó.
create policy hallazgo_simulado_insert on hallazgo_simulado
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from revision_simulada r
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where r.id = hallazgo_simulado.revision_id
        and r.workspace_id = hallazgo_simulado.workspace_id
        and r.propuesta_ai_id is null
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

create policy hallazgo_simulado_evidencia_insert on hallazgo_simulado_evidencia
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from hallazgo_simulado h
      join revision_simulada r on r.id = h.revision_id and r.workspace_id = h.workspace_id
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where h.id = hallazgo_simulado_evidencia.hallazgo_id
        and h.workspace_id = hallazgo_simulado_evidencia.workspace_id
        and r.propuesta_ai_id is null
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

create policy pregunta_de_test_insert on pregunta_de_test
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from revision_simulada r
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where r.id = pregunta_de_test.revision_id
        and r.workspace_id = pregunta_de_test.workspace_id
        and r.propuesta_ai_id is null
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

-- ── Y BORRAR SÍ; ACTUALIZAR NO, Y ESO ES LA ETIQUETA ──
--
-- No hay política de UPDATE sobre ninguna de las cuatro tablas, ni grant de update sobre
-- ninguna columna. No es un olvido y no es rigidez: es la forma más fuerte de decir SYS-20.
-- `es_simulacion` no se puede poner en falso porque no hay ninguna sentencia concedida que
-- escriba en esa columna después del INSERT —y el `check (es_simulacion)` cubre el día en que
-- alguien conceda una—. Quitar la marca exige borrar la revisión entera, que es un acto
-- visible y que se lleva por delante los hallazgos.
--
-- Corregir una revisión es borrarla y escribir la buena. Es lo mismo que hace la corrección
-- humana de una propuesta AI antes de aceptarla, solo que después: el contenido original de la
-- propuesta es inmutable por SYS-17 y el objeto aceptado es lo que alguien aprobó, así que
-- editarlo por debajo dejaría a los dos contando historias distintas.
--
-- Y por eso el BORRADO pide lo mismo que la escritura: concepto CANDIDATO. Si borrar siguiera
-- abierto después del veredicto, «borrar y escribir la buena» se quedaría a medias —el insert
-- de vuelta lo rechaza la política de arriba— y la corrección sería una pérdida. Las dos
-- mitades de una operación no pueden tener puertas distintas.
--
-- Es además la regla de la casa medida en sus dos precedentes: la entrada de KPI de C6 solo se
-- borra mientras su registry es `borrador`, y las citas de un insight de C2 no tienen política
-- de DELETE en absoluto. Lo aceptado se corrige mientras su contenedor sigue abierto; después
-- es lo que alguien aprobó. Un derecho de cita que se retira más tarde no se arregla mutando el
-- objeto: `evidencia_usable` gobierna quién puede volver a citarlo, y la disposición del
-- workspace es lo que se lo lleva.
create policy revision_simulada_delete on revision_simulada
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from concepto c
      where c.id = revision_simulada.concepto_id
        and c.workspace_id = revision_simulada.workspace_id
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

-- Y las hojas por separado —con la MISMA puerta del estado—, para poder quitar una cita cuyos
-- derechos se retiraron sin tirar la revisión entera mientras el concepto sigue siendo
-- candidato. El guard diferido de arriba es el que decide si lo que queda se sostiene: quitar
-- la última cita de un hallazgo afirmativo falla en el commit, y con su motivo.
--
-- Sin el estado, un borrado de hoja sería la vía para MUTAR una revisión después del veredicto
-- sin tocar la puerta que lo impide: quitar hallazgos de uno en uno hasta dejar otra cosa.
create policy hallazgo_simulado_delete on hallazgo_simulado
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from revision_simulada r
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where r.id = hallazgo_simulado.revision_id
        and r.workspace_id = hallazgo_simulado.workspace_id
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

create policy hallazgo_simulado_evidencia_delete on hallazgo_simulado_evidencia
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from hallazgo_simulado h
      join revision_simulada r on r.id = h.revision_id and r.workspace_id = h.workspace_id
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where h.id = hallazgo_simulado_evidencia.hallazgo_id
        and h.workspace_id = hallazgo_simulado_evidencia.workspace_id
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

create policy pregunta_de_test_delete on pregunta_de_test
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from revision_simulada r
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where r.id = pregunta_de_test.revision_id
        and r.workspace_id = pregunta_de_test.workspace_id
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

grant select on revision_simulada, hallazgo_simulado, hallazgo_simulado_evidencia,
  pregunta_de_test to designio_app;

-- `es_simulacion` NO entra en el grant de insert: su valor lo pone el default, que es `true`, y
-- lo que no se concede no se puede escribir ni siquiera con el valor bueno. La columna no es un
-- parámetro de la fila, es una propiedad de la tabla.
-- Y `propuesta_ai_id` TAMPOCO entra, por un motivo distinto del de `es_simulacion`: el sello de
-- procedencia lo escribe el guard de materialización, no quien inserta. Concederlo dejaría a la
-- aplicación firmar una procedencia que no ocurrió —una revisión escrita a mano diciendo que
-- salió de una propuesta AI— y hay un censo en la suite que lo comprueba tabla por tabla.
grant insert (workspace_id, concepto_id, arquetipo_id, sintesis, creado_por)
  on revision_simulada to designio_app;
grant insert (workspace_id, revision_id, orden, titulo, descripcion, es_hipotesis)
  on hallazgo_simulado to designio_app;
grant insert (hallazgo_id, evidencia_id, workspace_id)
  on hallazgo_simulado_evidencia to designio_app;
grant insert (workspace_id, revision_id, hallazgo_id, orden, pregunta, escenario)
  on pregunta_de_test to designio_app;
grant delete on revision_simulada, hallazgo_simulado, hallazgo_simulado_evidencia,
  pregunta_de_test to designio_app;

-- ══════════════════════════════════════════════════════════════════════════════════════════
-- C4 EN EL PIPELINE: EL ANCLA ES EL CONCEPTO, EL DESTINO ES LA REVISIÓN
-- ══════════════════════════════════════════════════════════════════════════════════════════
--
-- El ancla de una capacidad es el objeto del que cuelga su alcance de contexto. Para C4 es el
-- CONCEPTO: se revisa un concepto, con los arquetipos del reto como lentes. Anclar en el reto
-- —que era lo cómodo, porque los arquetipos son del reto— habría hecho que C4 se ofreciera
-- sobre retos y no sobre lo que se revisa, y el lote habría tenido que decir por dentro a qué
-- concepto se refiere cada sesión: un id en el contenido en vez de una columna, o sea la clase
-- de dato que nadie comprueba.
--
-- El lote es UNA PROPUESTA POR ARQUETIPO. Cada una es la sesión de ese arquetipo sobre ese
-- concepto, que es lo que RF-08.2 llama «sesión por arquetipo».
alter table reserva_ai add column concepto_id uuid;
alter table llamada_ai add column concepto_id uuid;
alter table propuesta_ai add column concepto_id uuid;

alter table reserva_ai add constraint reserva_ai_concepto_fk
  foreign key (concepto_id, workspace_id) references concepto (id, workspace_id);
alter table llamada_ai add constraint llamada_ai_concepto_fk
  foreign key (concepto_id, workspace_id) references concepto (id, workspace_id);
alter table propuesta_ai add constraint propuesta_ai_concepto_fk
  foreign key (concepto_id, workspace_id) references concepto (id, workspace_id);

-- Y EL ÍNDICE QUE IMPIDE DOS TRABAJOS A LA VEZ SOBRE EL MISMO CONCEPTO.
--
-- El suelo de «no se paga dos veces por el mismo objeto» son los índices únicos parciales de
-- «reserva_ai», uno por ancla. La columna nueva llegó con su clave ajena y su CHECK y SIN el
-- índice: por la superficie concedida, dos reservas vivas de C4 sobre el mismo concepto
-- commitean las dos, doblan el presupuesto apartado y dejan pagar dos veces el mismo lote. El
-- candado del presupuesto que toma «prepararAlcance» lo evita mientras se pase por ahí; esto
-- es lo que queda cuando no.
--
-- Y NO ES SÓLO EL DE C4: el barrido del catálogo dice que «outcome_review_id» —el ancla de C7,
-- que ya está en «agents»— tampoco lo tiene. Es la CUARTA vez en este fichero que una lista
-- escrita a mano se queda corta al añadir un ancla, así que van los dos, y debajo va el censo
-- que exige el índice para toda columna de ancla: lo que faltaba no era el índice, era la
-- prueba que nota su ausencia. La que había sólo miraba los índices que EXISTEN —que ninguno
-- excluyera por ancla sin distinguir la capacidad—, y un índice que falta no aparece ahí.
create unique index reserva_ai_concepto_idx
  on reserva_ai (workspace_id, capacidad, concepto_id) where concepto_id is not null;
create unique index reserva_ai_outcome_review_idx
  on reserva_ai (workspace_id, capacidad, outcome_review_id) where outcome_review_id is not null;

-- El nombre lo elige el CENSO, no el gusto: la suite recorre las restricciones cuyo nombre
-- termina en el nombre de la columna de ancla para comprobar que toda ancla declarada en
-- `ai.schemas.ts` tiene su check en la base. `..._ancla_c4` habría pasado desapercibida.
alter table reserva_ai add constraint reserva_ai_ancla_concepto
  check ((concepto_id is not null) = (capacidad = 'C4'));
alter table llamada_ai add constraint llamada_ai_ancla_concepto
  check ((concepto_id is not null) = (capacidad = 'C4'));
alter table propuesta_ai add constraint propuesta_ai_ancla_concepto
  check ((concepto_id is not null) = (capacidad = 'C4'));

-- Y el ancla sigue siendo UNA. El check se sustituye entero porque `num_nonnulls` ENUMERA, y
-- una columna que no esté en la lista no cuenta: sin esto, una propuesta de C4 tendría cero
-- anclas contadas y el check exigiría que otra estuviera puesta.
--
-- ⚠ Y por eso los tres `drop constraint` + `add constraint` de esta sección son el MISMO peligro
-- que el `create or replace` del guard, con otra cara: la lista se escribe entera, así que
-- omitir una columna que otra capacidad añadió la BORRA en silencio. Pasó de verdad con este
-- fichero —se escribió antes de que C7 se integrara y las tres listas nacieron sin
-- `outcome_review_id` ni `outcome-review`—, y no lo dijo ningún error de migración: lo dijeron
-- cuatro pruebas de C7 al fallar. La regla es la misma que para el guard: releer lo VIVO cada
-- vez que esta rama se pone al día con `agents`.
alter table propuesta_ai drop constraint propuesta_ai_un_ancla;
alter table propuesta_ai add constraint propuesta_ai_un_ancla
  check (num_nonnulls(item_id, reto_id, gate_id, journey_id, registry_id, outcome_review_id,
                      concepto_id) = 1);

-- ── El destino: la revisión simulada ──
alter table propuesta_ai add column revision_simulada_id uuid;
alter table propuesta_ai add constraint propuesta_ai_revision_simulada_fk
  foreign key (revision_simulada_id, workspace_id) references revision_simulada (id, workspace_id);
create unique index propuesta_ai_revision_simulada_idx
  on propuesta_ai (workspace_id, revision_simulada_id) where revision_simulada_id is not null;

alter table propuesta_ai drop constraint propuesta_ai_destino_vocabulario;
alter table propuesta_ai add constraint propuesta_ai_destino_vocabulario
  check (destino in ('evidencia', 'criterio-exito', 'insight', 'entrada-kpi', 'oportunidad',
                     'outcome-review', 'revision-simulada'));

alter table propuesta_ai add constraint propuesta_ai_destino_c4
  check (capacidad <> 'C4' or destino = 'revision-simulada');

-- Y el ALCANCE, que C4 declara siempre y hasta ahora no estaba obligada a declarar.
--
-- `alcance_evidencia` es lo que el guard diferido compara con la evidencia que el arquetipo
-- tiene al sellar, y su rama estaba escrita «y el alcance no es nulo». Un nulo ahí no comprueba
-- menos: no comprueba nada. Y la columna la escribe quien inserta —hay `grant insert
-- (alcance_evidencia)`— así que por la superficie concedida se sellaba una revisión que no dice
-- haber visto ni un documento de la lente que firma.
--
-- Sus dos hermanas ya lo tenían, cada una la suya: `propuesta_ai_alcance_evidencia_c2` y
-- `propuesta_ai_alcance_insights_c3`. Ésta es la de C4, con la misma forma, y no es la única
-- mitad del arreglo: el guard perdió además la condición del nulo, porque cuelga de
-- `revision_simulada_id` y no de `capacidad`, y una fila con otra etiqueta no la ve este CHECK.
alter table propuesta_ai add constraint propuesta_ai_alcance_evidencia_c4
  check (capacidad <> 'C4' or alcance_evidencia is not null);

-- Y LA ETIQUETA, que tampoco puede depender de que el servicio se acuerde de ponerla.
--
-- `es_simulacion` sale del registro y viaja al insert, pero la columna tiene `default false` y
-- nada la exigía: por la superficie concedida, una propuesta de C4 escrita sin ella nace
-- diciendo que NO es simulación. Y no se queda en la fila — el evento `PropuestaAIGenerada` la
-- copia, así que el libro append-only afirma en falso mientras el panel rotula «simulación AI»
-- encima. SYS-20 pide que la etiqueta sea imborrable, y una que se puede omitir al nacer no lo
-- es: se borra antes de existir.
--
-- Solo en un sentido. «C4 es simulación» es verdad hoy y lo seguirá siendo; «solo C4 lo es» no
-- lo es: la próxima capacidad que simule entraría en conflicto con un CHECK que no la conoce.
alter table propuesta_ai add constraint propuesta_ai_simulacion_c4
  check (capacidad <> 'C4' or es_simulacion);

-- Y LA MISMA EXIGENCIA ESCRITA COMO LA LEE EL GUARD, que no es la misma frase.
--
-- El de arriba mira `capacidad` y salta lo más pronto posible —al escribir la propuesta—, que
-- es donde el error se entiende. Pero el guard diferido no cuelga de `capacidad`: cuelga de
-- `revision_simulada_id`, y ahí llega también una fila con OTRA etiqueta. `propuesta_ai_un_ancla`
-- con los siete bicondicionales deja fuera a `C1` —se queda sin ancla posible, y el conteo
-- exige exactamente una—, pero no cierra la rama `<= 1` de `propuesta_ai_objeto_materializado`:
-- con `destino = 'entrada-kpi'`, la columna materializada que se rellene puede ser justamente
-- `revision_simulada_id`.
--
-- Dos frases y no una porque protegen dos cosas distintas: la primera, que C4 declare; la
-- segunda, que lo que el guard compara exista. Con las dos, la rama del nulo dentro del guard
-- ya no se puede alcanzar — y el `coalesce` que lleva se queda igualmente, porque un valor por
-- defecto que hace fallar no es una rama que haya que alcanzar: es hacia dónde cae la duda.
alter table propuesta_ai add constraint propuesta_ai_alcance_de_lo_sellado
  check (revision_simulada_id is null or alcance_evidencia is not null);

-- Y la regla «aceptada ⇔ hay objeto», con la columna nueva dentro del conteo. Se reescribe
-- entera por lo mismo que `propuesta_ai_un_ancla`: `num_nonnulls` enumera, y una propuesta de C4
-- aceptada habría contado CERO objetos materializados contra un `= 1`.
alter table propuesta_ai drop constraint propuesta_ai_objeto_materializado;
alter table propuesta_ai add constraint propuesta_ai_objeto_materializado
  check (
    case
      /*
       * La rama de C7 va PRIMERO y se copia de su migración tal cual, con `revision_simulada_id`
       * añadido a los conteos. Su columna de objeto es la MISMA que su columna de ancla, así
       * que contarla haría que toda propuesta suya tuviera un objeto puesto desde que nace;
       * por eso `outcome_review_id` se comprueba aparte y no entra en ningún `num_nonnulls`.
       */
      when destino = 'outcome-review'
        then outcome_review_id is not null
             and num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id,
                              oportunidad_id, revision_simulada_id) = 0
      when estado not in ('aceptada', 'corregida')
        then num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id,
                          oportunidad_id, revision_simulada_id) = 0
      /*
       * `<= 1` y no `= 1` para las dos capacidades cuyo objeto SE PUEDE BORRAR después de
       * aceptarlo: la entrada de KPI de C6 y la revisión simulada de C4. Al borrarlo, un
       * trigger suelta el puntero —abajo, y en la migración de C6 el suyo—, y con `= 1` esa
       * suelta violaría el CHECK. El hecho «esta propuesta se aceptó y creó un objeto» no se
       * pierde: vive en `evento_dominio`, que es append-only. La columna es el enlace VIVO.
       */
      when destino in ('entrada-kpi', 'revision-simulada')
        then num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id,
                          oportunidad_id, revision_simulada_id) <= 1
      else num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id,
                        oportunidad_id, revision_simulada_id) = 1
    end);

-- ── LA PROPUESTA CUELGA DE LA LLAMADA QUE LA PRODUJO ──
--
-- Hermano de los guards de linaje de C6 y C7, y por lo mismo: sin él, una propuesta de C4 puede
-- colgar de la llamada de OTRO concepto, y entonces el libro de costos y el lineage dicen cosas
-- distintas sobre la misma fila.
--
-- Que ninguna columna de ancla se quede sin su comparación lo sujeta un censo que enfrenta
-- `COLUMNAS_DE_ANCLA` contra el TEXTO de los guards de `propuesta_ai`, buscando literalmente
-- «l.<columna> is not distinct from new.<columna>». Es una prueba sobre el código fuente y
-- suena frágil; es lo que hace falta, y funcionó: se lo dijo a C7 en su migración y me lo ha
-- dicho a mí en ésta.
create function propuesta_ai_c4_linaje_guard() returns trigger
language plpgsql as $$
begin
  if new.capacidad <> 'C4' then
    return new;
  end if;
  if not exists (
    select 1 from llamada_ai l
    where l.id = new.llamada_id and l.workspace_id = new.workspace_id
      and l.concepto_id is not distinct from new.concepto_id
  ) then
    raise exception 'la propuesta debe colgar de la llamada que la produjo: mismo concepto';
  end if;
  return new;
end $$;

revoke execute on function propuesta_ai_c4_linaje_guard() from public;

create trigger a_propuesta_ai_c4_linaje
  before insert on propuesta_ai
  for each row execute function propuesta_ai_c4_linaje_guard();

-- ── Y EL TESTIMONIO DE C4, EN LA BASE Y NO SOLO EN EL SERVICIO ──
--
-- La comparación que la base ya hacía para las citas mira `contenido -> 'citas'`, y las de C4
-- viven dentro de cada hallazgo: null contra null, o sea que pasaba EN VACÍO. Es exactamente la
-- lección que este repositorio ya tiene escrita —una regla escrita contra una ruta fija del
-- contenido no ve a quien lo guarda en otro sitio— y C2 la aprendió en su día: por eso su guard
-- compara `$.afirmaciones[*].citas`.
--
-- Y el servicio no tapa este camino. `contenido` está en el grant de UPDATE porque la corrección
-- humana es una escritura de la aplicación, así que quien no sea el formulario de la casa puede
-- mandar la corrección directa: repartir las citas entre hallazgos, reescribir un fragmento, o
-- quitar una marca de hipótesis, y escribir después las hojas que cuadran con lo corregido. El
-- guard diferido no lo caza porque comprueba contra el `contenido` YA corregido — su trabajo es
-- que lo materializado sea lo aceptado, no que lo aceptado sea lo propuesto.
--
-- `$.hallazgos[*].citas` y no `...citas[*]`: el primero devuelve un array DE ARRAYS, así que
-- conserva el REPARTO —de qué hallazgo cuelga cada cita—, que es lo único contrastable que hay
-- en una revisión simulada. Aplanado, `[A], [B]` y `[A, B], []` serían iguales.
--
-- Las tres partes son las mismas que el servicio declara intocables, escritas donde no hace
-- falta pasar por él. Y solo en UPDATE: al insertar, el contenido ES el original.
create function propuesta_ai_c4_testimonio_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.capacidad <> 'C4' then
    return new;
  end if;
  if jsonb_path_query_array(new.contenido, '$.hallazgos[*].citas')
     is distinct from jsonb_path_query_array(new.contenido_original, '$.hallazgos[*].citas')
  then
    raise exception 'las citas de una revisión simulada no se corrigen, ni se reparten entre sus hallazgos: son el rastro de lo que el modelo dijo haber leído, y qué documento sostiene cuál lectura es lo único contrastable que hay aquí';
  end if;
  if new.contenido -> 'arquetipoId' is distinct from new.contenido_original -> 'arquetipoId' then
    raise exception 'el arquetipo que la firma no se corrige: la lente dice desde qué perfil se hizo la lectura, y cambiarla conservando las frases es fabricar una voz (SYS-20)';
  end if;
  if jsonb_path_query_array(new.contenido, '$.hallazgos[*].esHipotesis')
     is distinct from jsonb_path_query_array(new.contenido_original, '$.hallazgos[*].esHipotesis')
  then
    raise exception 'la marca de hipótesis de un hallazgo no se corrige: separa lo que se apoya en evidencia de lo que se extrapola, y quitarla convierte una simulación en investigación (SYS-20)';
  end if;
  return new;
end;
$fn$;

revoke execute on function propuesta_ai_c4_testimonio_guard() from public;

create trigger a_propuesta_ai_c4_testimonio
  before update of contenido on propuesta_ai
  for each row execute function propuesta_ai_c4_testimonio_guard();

grant insert (concepto_id) on reserva_ai to designio_app;
grant insert (concepto_id) on llamada_ai to designio_app;
grant insert (concepto_id) on propuesta_ai to designio_app;
grant update (revision_simulada_id) on propuesta_ai to designio_app;

-- ── Y BORRAR UNA REVISIÓN ACEPTADA SUELTA SU PROPUESTA ──
--
-- «Corregir una revisión es borrarla y escribir la buena», dice la política de DELETE de arriba,
-- y con el enlace del sello puesto esa salida se cerraba justo para las revisiones que propuso
-- la AI: `propuesta_ai.revision_simulada_id` las referencia sin acción en cascada, así que lo
-- que llegaba a quien revisa era una violación de clave ajena en vez de la corrección que la
-- política le concede. Y es el caso que más va a pasar —una cita cuyos derechos se retiran, un
-- hallazgo que al leerlo no se sostiene—, porque la revisión AI es la que alguien lee entera.
--
-- El puntero se va con el objeto porque ya no hay a qué apuntar. Lo que NO se va es el hecho:
-- «esta propuesta se aceptó y creó una revisión» vive en `evento_dominio`, que es append-only.
-- La columna es el enlace VIVO; el archivo es el registro.
--
-- Todo esto es literalmente lo que ya hizo C6 con `entrada_kpi`, hasta el `security definer` y
-- el prefijo: un trigger y no `on delete set null` porque la clave ajena es compuesta y anular
-- la pareja entera es imposible —`workspace_id` es NOT NULL—; `security definer` porque la
-- política de UPDATE de `propuesta_ai` exige `estado = 'propuesta'` en su `using` y una ya
-- aceptada es intocable para el rol de aplicación; BEFORE porque la comprobación de la clave
-- ajena corre al final de la sentencia y con AFTER llegaría tarde.
create function revision_simulada_suelta_su_propuesta() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  update propuesta_ai set revision_simulada_id = null
   where revision_simulada_id = old.id and workspace_id = old.workspace_id;
  return old;
end;
$fn$;

revoke execute on function revision_simulada_suelta_su_propuesta() from public;

-- `b_` por detrás de `a_congelacion_por_disposicion` —con el workspace dispuesto aquí no se
-- borra nada— y por detrás de `b_candado_del_reto`, que toma el candado antes de tocar nada.
create trigger b_revision_simulada_suelta_su_propuesta
  before delete on revision_simulada
  for each row execute function revision_simulada_suelta_su_propuesta();

-- ── Y UNA SESIÓN NO ES UNA SESIÓN SI ESTÁ VACÍA ──
--
-- El contrato pide al menos un hallazgo y al menos una pregunta de test, y las preguntas son
-- lo único que una simulación puede legítimamente entregarle a la etapa 4 (RF-08.2): la
-- revisión no se cita, no cuenta en G4, y lo que queda de ella es qué ir a probar con personas.
-- Una revisión sin ninguna de las dos es una etiqueta de simulación colgada de nada.
--
-- El contrato solo gobierna lo que viene del proveedor. Por la superficie concedida —que
-- existe porque SYS-21 obliga a que todo flujo siga disponible sin AI— una `revision_simulada`
-- sola commiteaba, y quedaba archivada así. Medido.
--
-- DIFERIDO porque el montaje legítimo es de varias sentencias: la materialización escribe la
-- revisión, luego sus hallazgos, luego sus preguntas, y exigirlo al insertar haría imposible
-- el camino real. Es el mismo motivo por el que el guard de «hallazgo sin cita y sin marca» es
-- diferido, y por eso la respuesta correcta a «¿está completa?» solo existe en el commit.
--
-- Y cuelga TAMBIÉN del borrado de las hojas, porque si no sería una comprobación de NACIMIENTO
-- y no un invariante: vaciar una revisión existente borrando sus hallazgos uno a uno la dejaría
-- igual de vacía sin pasar por aquí. Cuando la que se va es la revisión entera, sus hojas caen
-- en cascada y entonces no hay nada que comprobar — de ahí que la función pregunte primero si
-- la revisión sigue existiendo.
create function revision_simulada_completa_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_revision uuid;
  v_ws uuid;
begin
  if tg_table_name = 'revision_simulada' then
    v_revision := new.id;
    v_ws := new.workspace_id;
  else
    v_revision := old.revision_id;
    v_ws := old.workspace_id;
  end if;
  if not exists (select 1 from revision_simulada r
                  where r.id = v_revision and r.workspace_id = v_ws) then
    return null;
  end if;
  if not exists (select 1 from hallazgo_simulado h
                  where h.revision_id = v_revision and h.workspace_id = v_ws) then
    raise exception 'esa revisión simulada se queda sin hallazgos: una sesión sin ninguna lectura es una etiqueta de simulación colgada de nada (RF-08.2). Escribe al menos uno, o borra la revisión entera';
  end if;
  if not exists (select 1 from pregunta_de_test q
                  where q.revision_id = v_revision and q.workspace_id = v_ws) then
    raise exception 'esa revisión simulada se queda sin preguntas de test: son lo único que una simulación le puede entregar a la etapa 4, porque sus hallazgos no se citan ni cuentan en G4 (RF-08.2). Escribe al menos una, o borra la revisión entera';
  end if;
  return null;
end;
$fn$;

revoke execute on function revision_simulada_completa_guard() from public;

create constraint trigger revision_simulada_completa
  after insert on revision_simulada
  deferrable initially deferred
  for each row execute function revision_simulada_completa_guard();
create constraint trigger revision_simulada_completa
  after delete on hallazgo_simulado
  deferrable initially deferred
  for each row execute function revision_simulada_completa_guard();
create constraint trigger revision_simulada_completa
  after delete on pregunta_de_test
  deferrable initially deferred
  for each row execute function revision_simulada_completa_guard();

-- ── EL LIBRO, PARA LA QUE SE ESCRIBE A MANO ──
--
-- RF-01.6 pide registro append-only de lo que pasa en el workspace, y las tablas de objeto
-- materializado que ya existían lo escriben DESDE LA BASE —`entrada_kpi`, `oportunidad` y
-- `criterio_exito` llevan su `after insert or delete or update`— precisamente porque el camino
-- manual no pasa por el servicio. `revision_simulada` nació sin él: por la superficie
-- concedida, que existe porque SYS-21 obliga a que todo flujo siga disponible sin AI, una
-- sesión entera entraba sin que nada lo anotara. Y borrarla —que es la salida documentada para
-- corregirla— se llevaba por delante la única atribución que quedaba, la de la propia fila.
--
-- LAS HOJAS NO LO LLEVAN, y es una respuesta y no un olvido: tampoco lo llevan las de C2
-- —`afirmacion` y `cita`— porque el evento es del OBJETO y sus hijos son su contenido. Lo que
-- el libro tiene que poder contestar es «quién metió esta sesión y cuándo», no cada línea.
--
-- El sello viaja dentro: distingue la que nació de una propuesta de la escrita a mano, que es
-- justo la pregunta que este evento existe para contestar.
create function revision_simulada_libro_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_fila record;
  v_propuesta uuid;
begin
  v_fila := coalesce(new, old);
  -- DIFERIDO Y RELEYENDO LA FILA, y las dos cosas por el sello.
  --
  -- La materialización inserta la revisión SIN `propuesta_ai_id` a propósito: esa columna no
  -- está en el grant, la estampa el guard diferido al aceptar. En un `after insert` inmediato
  -- todavía es nula, así que `jsonb_strip_nulls` se llevaba `propuestaAiId` y toda revisión
  -- hecha por la AI quedaba anotada como si la hubiera escrito una persona — que es justo la
  -- pregunta que este evento existe para contestar.
  --
  -- Al ser diferido, `new` sigue siendo la fila TAL COMO SE INSERTÓ, no como está al cerrar. Por
  -- eso se relee: lo que interesa es el sello de ahora. Si la revisión ya no está —se insertó y
  -- se borró en la misma transacción— no hay nada que anotar por el lado del alta.
  if tg_op = 'INSERT' then
    select * into v_fila from revision_simulada r
     where r.id = new.id and r.workspace_id = new.workspace_id;
    if not found then
      return null;
    end if;
    -- Y EL SELLO SE LEE DESDE EL OTRO LADO, que es donde ya está.
    --
    -- Releer la fila no basta: `revision_simulada.propuesta_ai_id` lo estampa el guard de
    -- materialización, que también es diferido y se encola DESPUÉS que éste —el insert de la
    -- revisión ocurre antes que el update de la propuesta—, así que aquí todavía es nulo.
    -- Medido: con la relectura sola, el evento seguía saliendo sin `propuestaAiId`.
    --
    -- Lo que SÍ está puesto es `propuesta_ai.revision_simulada_id`: lo escribe la propia
    -- aplicación en su UPDATE, dentro de esta transacción y antes del commit. Es el mismo
    -- vínculo mirado desde el extremo que ya lo tiene.
    if v_fila.propuesta_ai_id is null then
      select p.id into v_propuesta from propuesta_ai p
       where p.revision_simulada_id = v_fila.id and p.workspace_id = v_fila.workspace_id;
    end if;
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (v_fila.workspace_id,
    case when tg_op = 'INSERT' then 'RevisionSimuladaCreada' else 'RevisionSimuladaBorrada' end,
    jsonb_strip_nulls(jsonb_build_object(
      'revisionSimuladaId', v_fila.id,
      'conceptoId', v_fila.concepto_id,
      'arquetipoId', v_fila.arquetipo_id,
      'propuestaAiId', coalesce(v_fila.propuesta_ai_id, v_propuesta))),
    app_user_id(), workspace_role(app_user_id(), v_fila.workspace_id));
  return null;
end;
$fn$;

revoke execute on function revision_simulada_libro_guard() from public;

create constraint trigger revision_simulada_libro
  after insert or delete on revision_simulada
  deferrable initially deferred
  for each row execute function revision_simulada_libro_guard();

-- ── Y el linaje inverso, atado como el de sus seis hermanas ──
--
-- `propuesta_ai_id` nació sin clave ajena, y es la ÚNICA de las siete columnas de sello que no
-- la tiene: `insight`, `entrada_kpi`, `oportunidad`, `outcome_review`, `evidencia` y
-- `criterio_exito` la llevan compuesta con el workspace. Sin ella, el código privilegiado
-- —seed, importaciones, backfills— puede dejar una revisión apuntando a una propuesta que no
-- existe o que es de otro tenant, y la procedencia permanente que esta columna representa deja
-- de estar garantizada por la base.
--
-- El ciclo entre las dos tablas es el mismo que ya tienen las otras seis y se recorre igual:
-- la propuesta nace sin objeto, el objeto nace con su sello, y el puntero de vuelta se pone
-- después. Las dos columnas son anulables, así que no hay huevo ni gallina.
alter table revision_simulada add constraint revision_simulada_propuesta_fk
  foreign key (propuesta_ai_id, workspace_id) references propuesta_ai (id, workspace_id);

-- ── Y el aislamiento de escritura, por el mismo camino ──
--
-- Las cuatro tablas entran en la derivación en cuanto se les cuelga el guard del candado del
-- reto, que toma clave y fila: un cliente que abriera `repeatable read` escribiría con los
-- guards mirando una foto vieja. Mismo bucle idempotente de `20260903200000`, repetido en vez de
-- extraído a una función por la razón que dejó escrita la migración de la oportunidad: una
-- función «reinstala los triggers de infraestructura» invitaría a llamarla desde sitios donde lo
-- que hace falta es pensar qué tabla se añadió.
do $$
declare r record;
begin
  for r in
    with disparadoras as materialized (
      select distinct t.tgfoid as oid, t.tgrelid::regclass::text as tabla
      from pg_trigger t
      where not t.tgisinternal
    )
    select distinct d.tabla
    from disparadoras d
    join pg_proc p on p.oid = d.oid
    where p.prokind = 'f'
      and p.pronamespace = 'public'::regnamespace
      and pg_get_functiondef(p.oid) ~* '(pg_advisory_xact_lock|for +(share|update|no key update))'
      and p.proname <> 'exigir_aislamiento_de_escritura'
    order by 1
  loop
    if not exists (
      select 1 from pg_trigger t
      where t.tgrelid = r.tabla::regclass and t.tgname = 'aislamiento_de_escritura'
    ) then
      execute format(
        'create trigger aislamiento_de_escritura
           before insert or update or delete on %s
           for each statement execute function exigir_aislamiento_de_escritura()', r.tabla);
    end if;
  end loop;
end $$;


-- ══════════════════════════════════════════════════════════════════════════════════════════
-- Y EL GUARD DE MATERIALIZACIÓN, CON LAS RAMAS DE C4
-- ══════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠ CUIDADO AL INTEGRAR: esto REEMPLAZA el cuerpo vivo de `propuesta_ai_materializacion_guard`.
-- `create or replace` SUSTITUYE, no parchea, así que el cuerpo que sigue sale de
-- `pg_get_functiondef` sobre la versión viva EN EL MOMENTO DE ESCRIBIRLO —la que dejó C7— con
-- las ramas de C4 insertadas donde les toca.
--
-- Y se rehízo una vez por eso mismo: la primera versión de esta migración salió de la versión
-- que dejó C3, y al integrar C7 —que se mergeó antes— habría revertido en silencio sus cuatro
-- ramas. Ningún error lo dice; solo se ve leyendo el orden de las migraciones. La regla es
-- releer la función VIVA cada vez que esta rama se pone al día con `agents`.
CREATE OR REPLACE FUNCTION public.propuesta_ai_materializacion_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_filas integer;
  -- El reto de C4, que no llega por columna: su ancla es el CONCEPTO, y el reto está un salto
  -- más allá. A una variable —y no a una subconsulta en línea como la de C7, que sí puede
  -- porque `outcome_review` es 1:1 con su reto y siempre existe— porque aquí hace falta dos
  -- veces (el candado y el archivado) y porque pasarle NULL a `pg_advisory_xact_lock` no da
  -- error: es estricta, devuelve NULL y no toma nada. Un candado que se salta en silencio es
  -- peor que uno que falta.
  v_reto uuid;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return null;
  end if;
  if new.estado not in ('aceptada', 'corregida') then
    return null;
  end if;
  -- Y una fila que YA estaba decidida y que esta transacción solo TOCA no vuelve a
  -- materializar nada: lo que este guard comprueba es el acto de decidir, y ese acto ocurrió
  -- —y se comprobó— cuando el estado se movió.
  --
  -- Hace falta desde que quitar una entrada del borrador suelta el puntero de su propuesta
  -- (el trigger de abajo): ese UPDATE deja `estado` donde estaba y volvía a disparar este
  -- guard, que entonces exigía la entrada recién borrada y hacía imposible el borrado.
  --
  -- No abre nada por el lado del rol de aplicación: su única política de UPDATE
  -- —`propuesta_revisar`— exige `estado = 'propuesta'` en el `using`, así que el único UPDATE
  -- concedido sobre esta tabla es justamente el que mueve el estado. Y aceptar y borrar la
  -- entrada en la MISMA transacción sigue rechazado: el evento diferido de la aceptación se
  -- guardó con su `entrada_kpi_id`, y en el commit esa fila ya no existe.
  if new.estado is not distinct from old.estado then
    return null;
  end if;

  -- ── EL CANDADO POR CLAVE VA PRIMERO, ANTES QUE NINGÚN CANDADO DE FILA ──
  -- Este guard toma después `for share` sobre el reto, sobre las citas y sobre `derecho_uso`.
  -- El candado por clave del reto tiene que ir DELANTE de todos ellos, porque ése es el orden
  -- del resto del sistema: la revalidación previa al despacho y el trigger de
  -- `arquetipo_evidencia` piden primero la clave y después las filas.
  --
  -- Pedirlo al final —que es como nació— invierte el par y abre un abrazo mortal de tres:
  -- esta transacción retiene el `for share` del reto y espera la clave; un archivado quiere
  -- la fila en modo exclusivo y espera a esta; y la que despacha tiene la clave y espera la
  -- fila, detrás del archivado en la cola del candado. Nadie avanza. No se ve en una máquina
  -- rápida y sí en cuanto hay contención, que es como se manifestó.
  --
  -- Va aquí y no dentro de la comprobación del alcance porque el orden es una propiedad de la
  -- transacción entera, no de la regla que lo necesitaba.
  if new.reto_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || new.reto_id, 42));
  end if;
  -- Y el del REGISTRY, que es la clave que toma `bloquearRegistry` —o sea la que toma quien
  -- firma—. Va aquí arriba por el mismo motivo que la del reto: el orden es una propiedad de
  -- la transacción entera, no de la regla que lo necesita. Las dos claves no coinciden nunca
  -- en la misma fila (`propuesta_ai_un_ancla`), así que no hay par que ordenar entre ellas.
  if new.registry_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:registry:' || new.registry_id, 42));
  end if;
  -- Y el del RETO del post mortem, que es la clave que toma quien lo completa
  -- (`bloquearReto`). Como las otras dos: arriba del todo, porque el orden de los candados es
  -- una propiedad de la transacción entera y no de la regla que lo necesita. `outcome_review`
  -- es 1:1 con su reto, así que la clave sale de él y no hay una nueva que ordenar.
  if new.outcome_review_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || (
      select o.reto_id from outcome_review o
      where o.id = new.outcome_review_id and o.workspace_id = new.workspace_id), 42));
  end if;
  -- Y el del reto de C4, que se alcanza por su concepto. Es la MISMA clave que las dos de
  -- arriba —«designio:reto:»— y por eso va aquí y no más abajo: las tres son la misma cola, y
  -- tomarlas en momentos distintos de la función sería tomar la misma clave en órdenes
  -- distintos según la capacidad. `propuesta_ai_un_ancla` garantiza que solo una de las ramas
  -- corre, así que no hay par que ordenar entre ellas.
  if new.concepto_id is not null then
    select c.reto_id into v_reto from concepto c
      where c.id = new.concepto_id and c.workspace_id = new.workspace_id;
    if v_reto is null then
      raise exception 'esa propuesta ancla en un concepto que no existe en este workspace';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
  end if;
  if new.destino = 'evidencia' and not exists (
    select 1 from item_importacion i
    where i.id = new.item_id and i.workspace_id = new.workspace_id
      and i.estado = 'aprobado'
      and i.evidencia_id = new.evidencia_id
      and i.decidido_por = new.revisada_por) then
    raise exception 'aceptar una extracción sella su item de la bandeja con esa misma evidencia y el mismo humano (SYS-16)';
  end if;
  if new.destino = 'criterio-exito' and not exists (
    select 1 from criterio_exito c
    where c.id = new.criterio_id and c.workspace_id = new.workspace_id
      and c.reto_id = new.reto_id
      and c.creado_por = new.revisada_por) then
    raise exception 'el criterio materializado cuelga del reto de la propuesta y lo firma quien aceptó (SYS-19)';
  end if;
  -- La entrada KPI cuelga del REGISTRY de la propuesta, la firma quien aceptó, y responde a un
  -- criterio DE SU RETO. Ese último trozo es la puerta de grounding de C6: un KPI que responde
  -- a una promesa de otro reto no es un KPI, es telemetría con un nombre prestado (ADR-0007).
  -- La política de `entrada_kpi` ya lo exige al escribirla; repetirlo aquí es el suelo del
  -- camino de ACEPTACIÓN, que es otra escritura y llega por otra puerta.
  if new.destino = 'entrada-kpi' and not exists (
    select 1 from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
    where e.id = new.entrada_kpi_id and e.workspace_id = new.workspace_id
      and e.registry_id = new.registry_id
      and e.creado_por = new.revisada_por
      and exists (select 1 from criterio_exito c
        where c.id = e.criterio_id and c.workspace_id = e.workspace_id
          and c.reto_id = r.reto_id)) then
    raise exception 'la entrada KPI materializada cuelga del registry de la propuesta, responde a un criterio de SU reto y la firma quien aceptó (SYS-19)';
  end if;
  -- La OPORTUNIDAD cuelga del reto de la propuesta y la firma quien aceptó. Y nace
  -- `propuesta`: aceptar una HMW la pone en el portafolio para que el equipo la decida, no la
  -- aprueba. Sellar una ya aprobada sería atribuirle a la AI un veredicto humano — y ese
  -- veredicto tiene su propia puerta, con su razón y su re-comprobación del razonamiento.
  if new.destino = 'oportunidad' and not exists (
    select 1 from oportunidad o
    where o.id = new.oportunidad_id and o.workspace_id = new.workspace_id
      and o.reto_id = new.reto_id
      and o.creado_por = new.revisada_por
      and o.estado = 'propuesta') then
    raise exception 'la oportunidad materializada cuelga del reto de la propuesta, la firma quien aceptó y nace por decidir: aceptar una HMW la pone en el portafolio, no la aprueba (SYS-19)';
  end if;
  -- ── EL POST MORTEM: EL ANCLA ES EL OBJETO ──
  --
  -- Las seis anteriores comprueban que existe una fila NUEVA con la forma esperada. Aquí la
  -- fila es vieja por construcción —el review lo abrió el lead al cerrarse la última ventana
  -- de medición (RF-07.7), y C7 se ancla en él justamente porque ya existe—, así que lo que
  -- se comprueba es otra cosa: que siga siendo un BORRADOR.
  --
  -- Un post mortem completado es inmutable, y con razón: lleva el veredicto firmado con nombre
  -- y fecha. Escribirle la narrativa después de cerrado cambiaría el documento sobre el que
  -- alguien puso su firma. La política de `outcome_review` ya lo impide por su lado; aquí se
  -- repite porque el camino de ACEPTACIÓN es otra escritura y llega por otra puerta, que es el
  -- mismo motivo por el que la entrada KPI repite lo suyo.
  --
  -- No se exige «lo firma quien aceptó»: nadie CREA esta fila en la aceptación, y `creado_por`
  -- es de quien abrió el post mortem semanas antes. Quien aceptó consta donde tiene que
  -- constar, en `revisada_por` de la propia propuesta.
  if new.destino = 'outcome-review' and not exists (
    select 1 from outcome_review o
    where o.id = new.outcome_review_id and o.workspace_id = new.workspace_id
      and o.estado = 'borrador') then
    raise exception 'el post mortem materializado tiene que seguir siendo un borrador: uno completado lleva un veredicto firmado, y su narrativa ya no se reescribe (SYS-19)';
  end if;

  -- ── PROCEDENCIA, que no es lo mismo que PARECIDO ──
  -- Los dos bloques de arriba son PREDICADOS: dicen que existe un objeto que encaja con la
  -- forma esperada (el item apunta a esa evidencia, el criterio cuelga de ese reto, los dos
  -- firmados por quien aceptó). Un predicado lo satisface cualquier objeto que dé la talla,
  -- incluido uno que ya existía. Con el SQL del rol de aplicación eso bastaba para atribuir
  -- a la AI algo hecho a mano: aprobar el item por su cuenta y DESPUÉS marcar aceptada la
  -- propuesta pendiente colgándole esa evidencia preexistente.
  --
  -- Lo que hace falta es una PROCEDENCIA: que el objeto haya nacido de ESTA aceptación. Y
  -- eso sí es comprobable sin guardar nada, porque la transacción es la unidad de trabajo
  -- de la materialización: `xmin` es la transacción que insertó la fila, y aquí —dentro del
  -- constraint trigger diferido, o sea todavía dentro de la transacción que acepta—
  -- `pg_current_xact_id()` es la nuestra. Si no coinciden, ese objeto lo creó otro y la
  -- propuesta se lo está apropiando.
  --
  -- Por qué importa más que una fila rara: lo que queda mal atribuido es que un objeto
  -- CURADO A MANO conste como materializado por la AI, y de eso viven las dos lecturas del
  -- método — el rastro de quién produjo qué (SPEC-08) y la tasa de corrección humana, que
  -- SPEC-09 usa como señal de calidad barata frente al coste de los evals. Una atribución
  -- falsa no ensucia una fila: mueve una métrica de calidad de la AI, y hacia el lado
  -- optimista (entra como `aceptada`, que es «la AI acertó a la primera»).
  if new.destino = 'evidencia' and not exists (
    select 1 from evidencia e
    where e.id = new.evidencia_id and e.workspace_id = new.workspace_id
      and e.xmin = pg_current_xact_id()::xid) then
    raise exception 'la evidencia materializada tiene que haberla creado esta misma aceptación: una propuesta no puede apropiarse de evidencia que ya existía (SYS-19)';
  end if;
  if new.destino = 'criterio-exito' and not exists (
    select 1 from criterio_exito c
    where c.id = new.criterio_id and c.workspace_id = new.workspace_id
      and c.xmin = pg_current_xact_id()::xid) then
    raise exception 'el criterio materializado tiene que haberlo creado esta misma aceptación: una propuesta no puede apropiarse de un criterio que ya existía (SYS-19)';
  end if;
  -- Y la entrada KPI, con la vuelta que el sello del insight dejó escrita: `xmin` dice «esta
  -- transacción escribió esta versión de la fila» y NO distingue insertar de actualizar, así
  -- que una entrada vieja a la que esta misma transacción le hace un UPDATE permitido
  -- —`editarEntrada` existe mientras el registry es borrador— pasaría como recién nacida.
  -- El insight lo cerró con «y sigue propuesto»; `entrada_kpi` no tiene estado con el que
  -- decir eso, así que lo dice su fecha: `creado_en` la pone la base y quedó FUERA del grant
  -- de columnas de esta migración, de modo que ningún UPDATE concedido la mueve. `creado_en =
  -- now()` es entonces «nació en ESTA transacción», que es exactamente lo que hay que exigir.
  if new.destino = 'entrada-kpi' and not exists (
    select 1 from entrada_kpi e
    where e.id = new.entrada_kpi_id and e.workspace_id = new.workspace_id
      and e.xmin = pg_current_xact_id()::xid
      and e.creado_en = now()) then
    raise exception 'la entrada KPI materializada tiene que haber NACIDO en esta misma aceptación: una propuesta no puede apropiarse de una entrada que ya existía, ni de una editada aquí (SYS-19)';
  end if;
  -- El insight, igual — y con una vuelta más, porque es el primer objeto COMPUESTO: no basta
  -- con que la cabecera sea nuestra. Las afirmaciones y las citas son el insight; una
  -- cabecera recién creada con las afirmaciones de otro sitio diría lo mismo por dentro y
  -- constaría igual de materializada. Se exige que TODA la descendencia haya nacido en esta
  -- misma transacción.
  -- El `xmin` NO distingue insertar de actualizar: Postgres le pone al tupla actualizada el
  -- id de la transacción que la actualiza, así que una cabecera VIEJA a la que esta misma
  -- transacción le hace un UPDATE permitido pasa esta comprobación como si acabara de nacer.
  -- Medido: un insight escrito a mano en otra transacción, con la cabecera que la propuesta
  -- dice, más sus afirmaciones y citas creadas aquí, más el UPDATE de validación —que es
  -- legítimo—, se sellaba con la procedencia de la propuesta.
  --
  -- Se cierra exigiendo ADEMÁS que siga `propuesto`, y eso funciona por un motivo que hay que
  -- dejar escrito porque el arreglo entero se apoya en él: el rol de aplicación tiene UPDATE
  -- solo sobre (estado, validado_por, validado_en) y su única política de UPDATE es
  -- `insight_validar`, cuyo `with check` EXIGE que la fila quede en `validado`. O sea que no
  -- existe ningún UPDATE concedido que refresque el `xmin` dejando `propuesto`: el único que
  -- hay obliga a salir de ese estado. Una prueba lo fija contra el catálogo, para que si
  -- alguien amplía esa superficie no se entere por este comentario sino por un caso en rojo.
  --
  -- Y la materialización legítima nace `propuesto` —validar es un acto humano POSTERIOR, en
  -- otra transacción—, así que la condición no le estorba.
  if new.destino = 'insight' and not exists (
    select 1 from insight i
    where i.id = new.insight_id and i.workspace_id = new.workspace_id
      and i.xmin = pg_current_xact_id()::xid
      and i.estado = 'propuesto') then
    raise exception 'el insight materializado tiene que haberlo creado esta misma aceptación y seguir propuesto: una propuesta no puede apropiarse de un insight que ya existía (SYS-19)';
  end if;
  if new.destino = 'insight' and exists (
    select 1 from afirmacion a
    where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id
      and (a.xmin <> pg_current_xact_id()::xid
        or exists (select 1 from cita c
          where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            and c.xmin <> pg_current_xact_id()::xid))) then
    raise exception 'las afirmaciones y las citas del insight materializado tienen que haber nacido en esta misma aceptación (SYS-19)';
  end if;
  if new.destino = 'insight' and exists (
    select 1 from contradiccion c
    where c.insight_id = new.insight_id and c.workspace_id = new.workspace_id
      and c.xmin <> pg_current_xact_id()::xid) then
    raise exception 'las contradicciones del insight materializado tienen que haber nacido en esta misma aceptación (SYS-19)';
  end if;

  -- ── LA OPORTUNIDAD, QUE ES EL SEGUNDO OBJETO COMPUESTO ──
  --
  -- La cabecera, con la misma vuelta que el insight: `xmin` dice «esta transacción escribió
  -- esta versión» y NO distingue insertar de actualizar, así que una oportunidad VIEJA a la
  -- que esta transacción le haga un UPDATE permitido —repriorizar, que la ventana admite—
  -- pasaría como recién nacida. El insight lo cierra con «y sigue propuesto» y esa misma
  -- frase sirve aquí, porque el estado inicial de `oportunidad` es también `propuesta` y la
  -- única política de UPDATE obliga a salir de él… salvo la repriorización, que lo conserva.
  --
  -- Por eso hace falta ADEMÁS `creado_en = now()`, como en `entrada_kpi`: es «nació en ESTA
  -- transacción», y funciona porque `creado_en` la pone la base y quedó fuera del grant de
  -- UPDATE de la migración de la oportunidad, así que ninguna escritura concedida la mueve.
  -- Con las dos, repriorizar una HMW vieja dentro de la aceptación deja de poder sellarla.
  if new.destino = 'oportunidad' and not exists (
    select 1 from oportunidad o
    where o.id = new.oportunidad_id and o.workspace_id = new.workspace_id
      and o.xmin = pg_current_xact_id()::xid
      and o.creado_en = now()) then
    raise exception 'la oportunidad materializada tiene que haber NACIDO en esta misma aceptación: una propuesta no puede apropiarse de una HMW que ya existía, ni de una repriorizada aquí (SYS-19)';
  end if;
  -- Y su TRAZA, que es la parte que la hace compuesta. Una cabecera nuestra con enlaces de
  -- otro sitio diría lo mismo por dentro —la misma pregunta apoyada en los mismos insights—
  -- y constaría igual de materializada por la AI. Es el mismo argumento que el de las
  -- afirmaciones del insight, con una diferencia que conviene decir: aquí los enlaces NO se
  -- pueden actualizar (`oportunidad_insight` solo admite insert y delete), así que `xmin`
  -- basta y no hace falta la fecha.
  if new.destino = 'oportunidad' and exists (
    select 1 from oportunidad_insight oi
    where oi.oportunidad_id = new.oportunidad_id and oi.workspace_id = new.workspace_id
      and oi.xmin <> pg_current_xact_id()::xid) then
    raise exception 'la traza de la oportunidad materializada tiene que haber nacido en esta misma aceptación (SYS-19)';
  end if;
  -- ── LA PROCEDENCIA DE UNA EDICIÓN ──
  --
  -- `xmin` a secas, y aquí sí es lo correcto en vez de la aproximación que las otras tuvieron
  -- que reforzar. Dice «esta transacción escribió esta versión de la fila», que es exactamente
  -- lo que hay que exigir cuando lo materializado es una EDICIÓN: el par con `creado_en =
  -- now()` existe en las otras para distinguir insertar de actualizar, y aquí no hay nada que
  -- distinguir — la fila es vieja a propósito y lo que se sella es su versión nueva.
  --
  -- Sin esto, la puerta es la de siempre: redactar la narrativa a mano y DESPUÉS marcar
  -- aceptada la propuesta pendiente, y el post mortem consta escrito por la AI. Lo que se
  -- mueve con eso no es una fila: es la tasa de corrección humana, y hacia el lado optimista.
  if new.destino = 'outcome-review' and not exists (
    select 1 from outcome_review o
    where o.id = new.outcome_review_id and o.workspace_id = new.workspace_id
      and o.xmin = pg_current_xact_id()::xid) then
    raise exception 'el post mortem materializado tiene que haberlo escrito esta misma aceptación: una propuesta no puede apropiarse de una narrativa que ya estaba (SYS-19)';
  end if;
  -- ── Y LO QUE SE ACEPTÓ ES LO QUE SE LEYÓ ──
  --
  -- Mismo argumento que la proyección de la HMW de C3: la procedencia dice que esta
  -- transacción escribió la fila, no QUÉ escribió. Con solo `xmin`, aceptar la propuesta y
  -- escribir en el review un texto distinto —en la misma transacción— pasa las dos
  -- comprobaciones, y queda un post mortem que no dice lo que el humano leyó al aceptar,
  -- firmado como si lo dijera.
  --
  -- Los cuatro campos, que son los que C7 propone. El veredicto no está, ni la casilla del
  -- diseño experimental: no se proponen, así que el review puede traer lo que traiga en ellos
  -- sin que esta comprobación tenga nada que decir.
  if new.destino = 'outcome-review' and not exists (
    select 1 from outcome_review o
    where o.id = new.outcome_review_id and o.workspace_id = new.workspace_id
      and o.contribucion       = new.contenido ->> 'contribucion'
      and o.factores_externos  = new.contenido ->> 'factoresExternos'
      and o.hipotesis_abiertas = new.contenido ->> 'hipotesisAbiertas'
      and o.aprendizajes       = new.contenido ->> 'aprendizajes') then
    raise exception 'el post mortem escrito no dice lo que dice la propuesta que se aceptó (SYS-19)';
  end if;
  -- Y SYS-15, en el instante en que la HMW empieza a existir: al menos un insight. No es una
  -- regla nueva —la puerta de G3 la exige sobre todo el portafolio, y aprobar una oportunidad
  -- también—, pero las dos llegan DESPUÉS. Una HMW sin traza nacida aquí sería legal hasta
  -- que alguien firmara G3, y entonces el gate se bloquearía por algo que la AI escribió y
  -- que nadie eligió. Va en el nacimiento, que es donde se puede decir de quién es.
  if new.destino = 'oportunidad' and not exists (
    select 1 from oportunidad_insight oi
    where oi.oportunidad_id = new.oportunidad_id and oi.workspace_id = new.workspace_id) then
    raise exception 'una oportunidad materializada por la AI tiene que trazar a al menos un insight: la traza es la cita, así que una HMW sin traza es una que no citó nada (SYS-15)';
  end if;
  -- Y la TRAZA ES LA CITA, comprobado en los dos sentidos: los enlaces materializados son
  -- exactamente los `insightId` distintos de las citas de la propuesta. Sin el sentido
  -- «no sobra ninguno», por la superficie SQL concedida se podía enlazar un insight de más
  -- —apoyo que nadie citó— y sellar igual; sin el otro, omitir uno citado y dejar la HMW
  -- apoyada en menos de lo que dice.
  --
  -- Se compara contra `contenido`, el ya corregido, y no contra `contenido_original`: eso es
  -- deliberado y es lo mismo que hace la proyección de las demás capacidades — corregir la
  -- redacción no puede ser siempre un fallo. Que las CITAS no se corrijan lo cierra el guard
  -- de revisión, así que los dos textos coinciden en esta parte por construcción.
  if new.destino = 'oportunidad' and (
    (select count(*) from oportunidad_insight oi
      where oi.oportunidad_id = new.oportunidad_id and oi.workspace_id = new.workspace_id)
    <> (select count(distinct c ->> 'insightId')
        from jsonb_array_elements(
          case when jsonb_typeof(new.contenido->'citas') = 'array'
               then new.contenido->'citas' else '[]'::jsonb end) as p(c))
    or exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(new.contenido->'citas') = 'array'
             then new.contenido->'citas' else '[]'::jsonb end) as p(c)
      where not exists (
        select 1 from oportunidad_insight oi
        where oi.oportunidad_id = new.oportunidad_id and oi.workspace_id = new.workspace_id
          and oi.insight_id = (c ->> 'insightId')::uuid))
  ) then
    raise exception 'la traza de la oportunidad materializada no es la de sus citas: se apoya exactamente en los insights que citó, ni uno más ni uno menos (SYS-15/SYS-17)';
  end if;

  -- ══════════════════════════════════════════════════════════════════════════════════════
  -- C4: LA REVISIÓN SIMULADA NACIÓ AQUÍ, Y DICE LO QUE LA PROPUESTA DIJO
  -- ══════════════════════════════════════════════════════════════════════════════════════
  --
  -- La cabecera primero. `xmin` a secas basta aquí y no bastaba para la oportunidad: aquella
  -- admite un UPDATE —la repriorización— que conserva el estado, así que una vieja retocada
  -- pasaba por recién nacida. `revision_simulada` no tiene NINGUNA superficie de UPDATE: ni
  -- política, ni grant de columna. `creado_en = now()` se comprueba igual, y no por simetría:
  -- es lo que sigue diciendo la verdad el día que alguien conceda un update, que es
  -- exactamente el día en que este guard tiene que seguir en pie.
  if new.destino = 'revision-simulada' and not exists (
    select 1 from revision_simulada r
    where r.id = new.revision_simulada_id and r.workspace_id = new.workspace_id
      and r.xmin = pg_current_xact_id()::xid
      and r.creado_en = now()) then
    raise exception 'la revisión simulada materializada tiene que haber NACIDO en esta misma aceptación: una propuesta no puede apropiarse de una revisión que ya existía (SYS-19)';
  end if;
  -- Y CUELGA DEL CONCEPTO QUE LA PROPUESTA REVISA, con el arquetipo que la propuesta dijo.
  -- Las dos mitades hacen falta y dicen cosas distintas: sin la primera, la aceptación de una
  -- propuesta sobre el concepto A podía sellar una revisión del concepto B —los dos del mismo
  -- workspace, así que ninguna clave ajena lo ve—; sin la segunda, la lente podía cambiarse al
  -- materializar y la sesión del «apurado de RR. HH.» acabaría firmada como del «desconfiado
  -- digital», que es cambiar de quién es la voz.
  if new.destino = 'revision-simulada' and not exists (
    select 1 from revision_simulada r
    where r.id = new.revision_simulada_id and r.workspace_id = new.workspace_id
      and r.concepto_id = new.concepto_id
      and r.arquetipo_id::text = lower(new.contenido->>'arquetipoId')
      and r.sintesis = new.contenido->>'sintesis') then
    raise exception 'la revisión simulada materializada no dice lo que dice la propuesta: cuelga del concepto anclado, la firma el arquetipo que la propuesta nombra y su síntesis se copia tal cual (SYS-19)';
  end if;
  -- Sus hojas, nacidas también aquí. Ninguna de las tres admite UPDATE, así que `xmin` es
  -- exacto: cualquier fila con otra transacción detrás venía de antes.
  if new.destino = 'revision-simulada' and exists (
    select 1 from hallazgo_simulado h
    where h.revision_id = new.revision_simulada_id and h.workspace_id = new.workspace_id
      and h.xmin <> pg_current_xact_id()::xid) then
    raise exception 'los hallazgos de la revisión materializada tienen que haber nacido en esta misma aceptación (SYS-19)';
  end if;
  if new.destino = 'revision-simulada' and exists (
    select 1 from pregunta_de_test q
    where q.revision_id = new.revision_simulada_id and q.workspace_id = new.workspace_id
      and q.xmin <> pg_current_xact_id()::xid) then
    raise exception 'las preguntas de test de la revisión materializada tienen que haber nacido en esta misma aceptación (SYS-19)';
  end if;
  if new.destino = 'revision-simulada' and exists (
    select 1 from hallazgo_simulado_evidencia he
    join hallazgo_simulado h on h.id = he.hallazgo_id and h.workspace_id = he.workspace_id
    where h.revision_id = new.revision_simulada_id and h.workspace_id = new.workspace_id
      and he.xmin <> pg_current_xact_id()::xid) then
    raise exception 'las citas de los hallazgos materializados tienen que haber nacido en esta misma aceptación (SYS-19)';
  end if;

  -- ── Y LA PROYECCIÓN, QUE ES DONDE VIVE SYS-20 ──
  --
  -- Hallazgo por hallazgo, en el mismo orden, con el mismo texto, LA MISMA MARCA DE HIPÓTESIS
  -- y las mismas citas. La comparación es POSICIONAL, como la de las afirmaciones del insight:
  -- `hallazgo_simulado` tiene único `(revision_id, orden)` y el orden es parte del objeto.
  --
  -- La marca de hipótesis es la que hay que mirar dos veces. Un hallazgo que el modelo propuso
  -- como extrapolación —«esto no lo dice ninguna evidencia, lo estoy infiriendo del
  -- arquetipo»— y que se materializa como afirmación es la avería exacta que SYS-20 nombra:
  -- una simulación que se lee como investigación. Y por la superficie SQL concedida se podía
  -- llegar sin tocar la propuesta, que sigue diciendo `esHipotesis: true` en su contenido
  -- inmutable mientras el objeto de al lado dice que no. El contrato lo exige al parsear y el
  -- panel lo pinta; esto es lo que lo hace verdad en la base.
  if new.destino = 'revision-simulada' and (
    (select count(*) from hallazgo_simulado h
      where h.revision_id = new.revision_simulada_id and h.workspace_id = new.workspace_id)
    <> jsonb_array_length(new.contenido->'hallazgos')
    or exists (
      select 1
      from jsonb_array_elements(new.contenido->'hallazgos') with ordinality as p(ha, pos)
      where not exists (
        select 1 from hallazgo_simulado h
        where h.revision_id = new.revision_simulada_id and h.workspace_id = new.workspace_id
          and h.orden = pos::integer - 1
          and h.titulo = p.ha->>'titulo'
          and h.descripcion = p.ha->>'descripcion'
          and h.es_hipotesis = (p.ha->>'esHipotesis')::boolean
          -- Y sus citas, en los dos sentidos. La cita de C4 se materializa como ENLACE y no
          -- como fila con fragmento —igual que la traza de la oportunidad—: el fragmento vive
          -- en el `contenido`, que es inmutable por SYS-17 y es donde se lee de dónde salió la
          -- frase. Lo que la base guarda es a qué documento se agarra, que es lo que hay que
          -- poder contar y comprobar contra los derechos.
          --
          -- `distinct` sobre el id porque dos citas del mismo documento —dos fragmentos
          -- distintos de la misma entrevista— son un solo enlace, y contarlas dos veces
          -- rompería la igualdad sin que nada estuviera mal.
          and (select count(*) from hallazgo_simulado_evidencia he
                where he.hallazgo_id = h.id and he.workspace_id = h.workspace_id)
              = (select count(distinct ci ->> 'evidenciaId')
                  from jsonb_array_elements(
                    case when jsonb_typeof(p.ha->'citas') = 'array'
                         then p.ha->'citas' else '[]'::jsonb end) as q(ci))
          and not exists (
            select 1 from jsonb_array_elements(
              case when jsonb_typeof(p.ha->'citas') = 'array'
                   then p.ha->'citas' else '[]'::jsonb end) as q(ci)
            where not exists (
              select 1 from hallazgo_simulado_evidencia he
              where he.hallazgo_id = h.id and he.workspace_id = h.workspace_id
                -- `lower`, por la lección que costó la cita del insight: un uuid en mayúscula
                -- es el MISMO uuid, Postgres lo guarda en minúscula, y comparado verbatim una
                -- propuesta que el guard del insert admitió no se podía aceptar nunca.
                and he.evidencia_id::text = lower(q.ci->>'evidenciaId')))))) then
    raise exception 'los hallazgos de la revisión materializada no dicen lo que dice la propuesta: el texto, LA MARCA DE HIPÓTESIS y las citas se copian tal cual de la propuesta aceptada — un hallazgo propuesto como extrapolación no se materializa como afirmación (SYS-19/SYS-20)';
  end if;
  -- Las preguntas de test, igual de posicionales, y con el hallazgo del que nacen. Es la única
  -- salida legítima de una simulación —«origina una pregunta del test», dice el journey—, así
  -- que de qué hallazgo sale forma parte de lo que se materializa: sin esta mitad, la pregunta
  -- podía acabar colgada de otro hallazgo y la trazabilidad de la simulación al test real
  -- diría algo que la propuesta no dijo.
  if new.destino = 'revision-simulada' and (
    (select count(*) from pregunta_de_test q
      where q.revision_id = new.revision_simulada_id and q.workspace_id = new.workspace_id)
    <> jsonb_array_length(new.contenido->'preguntas')
    or exists (
      select 1
      from jsonb_array_elements(new.contenido->'preguntas') with ordinality as p(pr, pos)
      where not exists (
        select 1 from pregunta_de_test q
        where q.revision_id = new.revision_simulada_id and q.workspace_id = new.workspace_id
          and q.orden = pos::integer - 1
          and q.pregunta = p.pr->>'pregunta'
          and q.escenario = coalesce(p.pr->>'escenario', '')
          -- El hallazgo se nombra por su ÍNDICE en el lote y no por id: cuando la propuesta se
          -- escribió, los hallazgos todavía no existían como filas. `is not distinct from`
          -- porque las dos puntas pueden ser nulas —una pregunta que no nace de ningún
          -- hallazgo concreto— y `=` habría dado NULL, que en un `where` no es verdadero.
          and q.hallazgo_id is not distinct from (
            select h2.id from hallazgo_simulado h2
            where h2.revision_id = new.revision_simulada_id
              and h2.workspace_id = new.workspace_id
              and h2.orden = (p.pr->>'hallazgoIndice')::integer)))) then
    raise exception 'las preguntas de test de la revisión materializada no dicen lo que dice la propuesta: el texto, el escenario y de qué hallazgo nacen se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;


  -- ── El consentimiento, en el ÚLTIMO instante ──
  -- El guard de revisión ya lo exige, pero es un trigger BEFORE UPDATE: su snapshot es el
  -- de la sentencia que sella, así que una revocación que commitea DESPUÉS de esa sentencia
  -- y antes de que commitee la aceptación no la ve nadie — y la evidencia entra con la
  -- revocación ya vigente. Aquí, en el commit, sí se ve: cada sentencia de plpgsql toma su
  -- propio snapshot en READ COMMITTED. Es el mismo argumento por el que este guard es el
  -- suelo del ciclo de vida del reto, aplicado al otro eje que también caduca solo.
  --
  -- El servicio toma además `designio:consentimiento:<item>`, el mismo candado que toma
  -- registrar un consentimiento, para que el orden sea determinista y el revisor reciba el
  -- error con nombre en vez de un rechazo del suelo. Pero el candado NO es lo que cierra la
  -- ventana —el SQL directo no lo pide—: lo cierra esto.
  if new.destino = 'evidencia' and exists (
    select 1 from item_importacion i
    where i.id = new.item_id and i.workspace_id = new.workspace_id
      and tipo_fuente_exige_consentimiento(i.tipo_fuente)
      and not consentimiento_externo_vigente(i.id, i.workspace_id)) then
    raise exception 'el consentimiento de ese material ya no autoriza el procesamiento externo: la propuesta no puede materializarse (RF-09.5)';
  end if;
  -- Y el reto tiene que SEGUIR admitiendo criterios al aceptar, que no es lo mismo que el
  -- congelado por G0 y no lo cubre ninguna política de `criterio_exito`. El ciclo de vida
  -- del reto avanza solo: `candidato → archivado` es una transición legal, igual que
  -- `activo → en-medicion → cerrado`. El guard del INSERT exige este mismo predicado al
  -- nacer la propuesta, pero entre nacer y aceptarse caben días — sin esto, aceptar colgaba
  -- un criterio de un reto que ya no lo admite: un contrato de medición para algo que nadie
  -- va a medir.
  --
  -- Que sea DIFERIDO es lo que lo vuelve suelo de verdad para ese hueco: corre en el commit,
  -- o sea en el último instante posible, y ve la transición ajena ya commiteada. Y rechazar
  -- sigue abierto —el `return null` de arriba deja pasar todo lo que no es aceptación—:
  -- una propuesta obsoleta se cierra rechazándola, y bloquear también esa salida dejaría la
  -- fila muerta y su ancla retenida para siempre.
  if new.destino = 'criterio-exito'
     and not reto_admite_criterios(new.reto_id, new.workspace_id) then
    raise exception 'ese reto ya no admite criterios nuevos: solo los admite mientras es candidato o está activo';
  end if;
  -- Y el registry tiene que SEGUIR admitiendo entradas al aceptar, que es el mismo hueco por
  -- el otro contrato: entre proponer y aceptar caben días, y firmar el registry es un acto
  -- humano que ocurre justo en esos días —es lo que G6 hace—. Sin esto, aceptar colaba una
  -- entrada en un contrato ya firmado: un KPI que nadie acordó, dentro de lo que se acordó.
  --
  -- Que este guard sea DIFERIDO es lo que lo vuelve suelo de verdad para ese hueco: corre en
  -- el commit, o sea en el último instante posible, y ve la firma ajena ya commiteada. El
  -- candado de arriba ordena además contra la firma que va EN VUELO. Y rechazar sigue
  -- abierto: una propuesta obsoleta se cierra rechazándola.
  if new.destino = 'entrada-kpi'
     and not registry_admite_entradas(new.registry_id, new.workspace_id) then
    raise exception 'ese Metric Registry ya no admite entradas: se firmó —o el trabajo de su reto se cerró— mientras esta propuesta esperaba revisión, así que solo puede rechazarse';
  end if;
  -- Y el RETO ARCHIVADO, que es la otra mitad y no la cubre la de arriba.
  --
  -- Al nacer la propuesta esto se exige por separado —«un reto archivado no admite propuestas
  -- de NINGUNA clase»— justo porque es lo único de aquella condición que hablaba del reto y no
  -- de los criterios. Aquí se quedó sin sacar: `reto_admite_criterios` excluye `archivado`,
  -- así que C0 lo tenía de rebote y C2 no lo tenía en absoluto. Medido: con la propuesta de
  -- C2 pendiente y el reto archivado, el servicio la rechaza por su nombre y la superficie SQL
  -- concedida sella el insight igual — un objeto nuevo atribuido a un trabajo que esta misma
  -- migración declara cerrado.
  --
  -- Va por ANCLA y no por destino, que es la corrección que la puerta de los criterios ya
  -- costó una vez: la regla habla del reto, no de lo que la propuesta materializa, y escrita
  -- como `destino = 'insight'` se queda corta ante la próxima capacidad que ancle ahí. Para
  -- C0 es redundante hoy y esa redundancia es el punto: deja de depender de que el predicado
  -- de los criterios siga excluyendo el archivo.
  -- Candado ANTES de decidir, sobre la fila del reto. Sin él esto es una FOTO: un archivado
  -- ajeno que commitea entre esta lectura y el commit de la aceptación pasa por delante, y el
  -- insight nace en un reto ya cerrado. El servicio toma «bloquearReto», pero este guard existe
  -- precisamente para quien escribe por SQL directo, que no pasa por el servicio.
  --
  -- «for share» y no «for update»: dos aceptaciones sobre el mismo reto no tienen por qué
  -- esperarse, y quien archiva hace un UPDATE que toma FOR NO KEY UPDATE, con el que FOR SHARE
  -- ya choca. Es el mismo protocolo que la congelación por disposición usa sobre «derecho_uso»,
  -- y el mismo orden que encabeza el del servicio (reto primero).
  perform 1 from reto r
   where r.id = new.reto_id and r.workspace_id = new.workspace_id
   for share;
  if new.reto_id is not null and exists (
    select 1 from reto r
    where r.id = new.reto_id and r.workspace_id = new.workspace_id
      and r.estado = 'archivado'
  ) then
    raise exception 'ese reto está archivado: su trabajo se cerró, así que esta propuesta ya no puede materializarse';
  end if;
  -- Y lo mismo por el ancla de C4, que llega al reto por su concepto. Es literalmente la
  -- lección de arriba —«va por ANCLA y no por destino»— cobrada por segunda vez: la regla habla
  -- del RETO, y una capacidad que ancle en algo que cuelga del reto la necesita igual. La fila
  -- se bloquea antes por lo mismo que la de su hermana: sin candado esto es una foto.
  if v_reto is not null then
    perform 1 from reto r where r.id = v_reto and r.workspace_id = new.workspace_id for share;
    if exists (select 1 from reto r
      where r.id = v_reto and r.workspace_id = new.workspace_id and r.estado = 'archivado') then
      raise exception 'ese reto está archivado: su trabajo se cerró, así que esta propuesta ya no puede materializarse';
    end if;
  end if;
  -- Sin fecha no hay proveniencia que escribir, así que una extracción sin fechar no se
  -- materializa: el modelo tiene permitido decir «el material no la trae» —para eso existe
  -- el par fecha/motivo— y ponerla es entonces trabajo del humano al corregir (I4). El
  -- servicio lo dice con el motivo que dio el modelo; esto es el suelo, y va antes de la
  -- proyección para que el mensaje sea el de la causa y no el genérico.
  if new.destino = 'evidencia' and new.contenido ->> 'fecha' is null then
    raise exception 'esa propuesta no trae fecha del material: una evidencia se sitúa en el tiempo, así que hay que fecharla al corregir antes de aceptarla';
  end if;

  -- LA PROYECCIÓN: los campos que la propuesta dicta, el objeto los lleva TAL CUAL. Es lo
  -- que convierte «nació en esta transacción» en «salió de esta propuesta», y lo que impide
  -- el caso que el `xmin` solo no veía: una evidencia escrita a mano, sellada en el mismo
  -- commit, atribuida a una propuesta con la que no tiene nada que ver.
  --
  -- Se compara contra `contenido` y NUNCA contra `contenido_original`, y ahí está la razón
  -- de que esto no rompa la corrección: corregir reescribe `contenido` en la MISMA sentencia
  -- que dispara este guard, así que el objeto materializado coincide con lo corregido y la
  -- fila sale `corregida` — que es justo lo que hay que poder medir. Exigir lo original sí
  -- convertiría cada enmienda en un fallo, y aprobar incluye enmendar (I4).
  --
  -- Solo los campos COPIADOS literalmente, no los derivados: `dimensiones` mezcla lo que
  -- dice la propuesta con lo que dicen el item y la bitácora de consentimiento, así que
  -- compararla entera ataría este guard al mapeo del servicio y se rompería a la primera
  -- que alguien añada una dimensión.
  --
  -- Y la lista NO se detiene en el borde de la columna: dentro de `dimensiones` hay claves
  -- que también vienen verbatim de la propuesta, y dejarlas fuera dejaba el mismo agujero
  -- abierto para ellas. De dónde sale CADA clave del jsonb, que es lo que hay que mirar
  -- antes de añadir una dimensión nueva:
  --
  --   · de la PROPUESTA (y por tanto se comparan aquí):
  --       proveniencia.fecha, metodo.recoleccion, metodo.derivada,
  --       calidad.confianza, derechos.confidencialidad
  --   · del LINEAGE de la propia fila (columnas `modelo` y `prompt_version`, no `contenido`):
  --       lineage.modelo, lineage.promptVersion  — se comparan también, porque afirman por
  --       qué modelo pasó esta evidencia y eso es exactamente lo que SYS-19 exige que sea
  --       cierto
  --   · del ITEM de la bandeja (no se comparan: la propuesta no los dice):
  --       proveniencia.tipoFuente, proveniencia.localizacion
  --   · de la BITÁCORA de consentimiento (no se compara, y a propósito: los derechos no los
  --     propone la AI):
  --       derechos.consentimiento
  --   · constantes de la materialización (no se comparan):
  --       metodo.segmentoIds, calidad.corroboraIds, calidad.contradiceIds
  --
  -- Una dimensión nueva que venga del item o del consentimiento no rompe nada porque no
  -- está en la lista; una que venga de la propuesta hay que añadirla, que es justo la
  -- decisión que conviene que alguien tome a conciencia.
  if new.destino = 'evidencia' and not exists (
    select 1 from evidencia e
    where e.id = new.evidencia_id and e.workspace_id = new.workspace_id
      and e.titulo = new.contenido->>'titulo'
      and e.resumen = new.contenido->>'resumen'
      and e.es_estado_actual = (new.contenido->>'esEstadoActual')::boolean
      and e.dimensiones#>>'{proveniencia,fecha}' = new.contenido->>'fecha'
      and e.dimensiones#>>'{metodo,recoleccion}' = new.contenido->>'recoleccion'
      and e.dimensiones#>>'{metodo,derivada}' = new.contenido->>'derivada'
      and e.dimensiones#>>'{calidad,confianza}' = new.contenido->>'confianza'
      and e.dimensiones#>>'{derechos,confidencialidad}' = new.contenido->>'confidencialidad'
      and e.dimensiones#>>'{lineage,modelo}' = new.modelo
      and e.dimensiones#>>'{lineage,promptVersion}' = new.prompt_version) then
    raise exception 'la evidencia materializada no dice lo que dice la propuesta: el título, el resumen, «es estado actual», la fecha, la recolección, si es derivada, la confianza, la confidencialidad y el lineage se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;
  -- El insight dice lo que dice la propuesta, y eso incluye su ESTRUCTURA: la cabecera, y
  -- después afirmación por afirmación —en el mismo orden, con el mismo texto y la misma marca
  -- de hipótesis— y cita por cita dentro de cada una. Comparar solo el título y el resumen
  -- habría dejado pasar un insight con otras afirmaciones bajo la misma cabecera, que es
  -- donde vive todo lo que se puede contrastar contra la evidencia.
  --
  -- La comparación es POSICIONAL (`with ordinality` contra el índice del array), igual que la
  -- que hace `propuesta_ai_c2_citas_guard` sobre las citas: reordenar es cambiar, porque
  -- `afirmacion` tiene único `(insight_id, orden)` y el orden es parte del objeto.
  if new.destino = 'insight' and not exists (
    select 1 from insight i
    where i.id = new.insight_id and i.workspace_id = new.workspace_id
      and i.titulo = new.contenido->>'titulo'
      and i.resumen = new.contenido->>'resumen') then
    raise exception 'el insight materializado no dice lo que dice la propuesta: el título y el resumen se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;
  if new.destino = 'insight' and (
    (select count(*) from afirmacion a
      where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id)
    <> jsonb_array_length(new.contenido->'afirmaciones')
    or exists (
      select 1
      from jsonb_array_elements(new.contenido->'afirmaciones') with ordinality as p(af, pos)
      where not exists (
        select 1 from afirmacion a
        where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id
          and a.orden = pos::integer - 1
          and a.texto = p.af->>'texto'
          and a.es_hipotesis = (p.af->>'esHipotesis')::boolean
          and (select count(*) from cita c
                where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id)
              = jsonb_array_length(p.af->'citas')
          and not exists (
            select 1 from jsonb_array_elements(p.af->'citas') as q(ci)
            where not exists (
              select 1 from cita c
              where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
                -- `lower`, igual que el guard del INSERT: un uuid en mayúscula es el MISMO
                -- uuid, y Postgres lo guarda siempre en minúscula. Comparado verbatim, una
                -- propuesta que el guard del insert admitió —porque él sí normaliza— no se
                -- podía aceptar NUNCA. El parser normaliza la salida del proveedor, pero la
                -- superficie SQL no pasa por él: la propuesta nacía muerta.
                and c.evidencia_id::text = lower(q.ci->>'evidenciaId')
                and c.fragmento = q.ci->>'fragmento'
                and c.localizacion = q.ci->>'localizacion'))))) then
    raise exception 'las afirmaciones y las citas del insight materializado no dicen lo que dice la propuesta: se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;
  -- Y que TODA evidencia que el insight acaba de citar siga pudiendo citarse al cliente, en
  -- el COMMIT.
  --
  -- `evidencia_citable_guard` lo exige al insertar cada cita, y ahí lee el derecho en el
  -- snapshot de SU sentencia. Entre esa lectura y el commit cabe una revocación ajena ya
  -- commiteada, y entonces la transacción sella una cita —con su fragmento copiado— cuyo
  -- derecho de uso ya no existe. Medido: la aceptación commiteaba y `evidencia_usable` daba
  -- `false` justo después. Es exactamente el mismo argumento por el que este guard ya rehace
  -- la comprobación del CONSENTIMIENTO para la evidencia extraída, y por el que rehace el
  -- ciclo de vida del reto: lo que caduca solo hay que volver a preguntarlo en el último
  -- instante, y el último instante es este.
  --
  -- Va por el OBJETO —las citas del insight que esta propuesta materializó— y no por destino
  -- ni por capacidad: la regla es «citar exige derechos vigentes» y habla de las citas, así
  -- que cualquier capacidad que mañana materialice un insight la hereda sin tocar esto.
  -- Y aquí también el candado va ANTES de la lectura, por lo mismo y con más motivo: sin él,
  -- volver a preguntar en el commit solo adelanta la foto un poco. Una revocación que ya está
  -- EN VUELO no la ve este snapshot —no ha commiteado—, así que la comprobación pasa y la
  -- aceptación commitea con la revocación pisándole los talones. Con el candado, o la
  -- revocación commitea primero y esta lectura la ve, o espera a que la aceptación termine: hay
  -- un orden, que es lo que no había.
  --
  -- Es literalmente el protocolo de «candados-compartidos»: «for share» sobre las filas de
  -- «derecho_uso» de toda la evidencia que este snapshot va a fijar, ordenadas por su id para
  -- que dos transacciones las pidan en el mismo orden. Va DESPUÉS del candado del reto, que es
  -- el orden que ya encabeza el del servicio.
  --
  -- «Toda la que este snapshot va a fijar» son DOS conjuntos, y durante una ronda esto solo
  -- cubrió el primero. La que el insight CITA la miran las dos comprobaciones de aquí abajo; la
  -- que el reto tiene ENLAZADA y el insight no cita la mira la comprobación de completitud del
  -- final, que pregunta `evidencia_usable` por cada una. Con el candado sobre el subconjunto
  -- citado, una CONCESIÓN en vuelo sobre un documento enlazado y no citado no ordenaba nada:
  -- esta lectura lo veía inutilizable —la concesión aún no ha commiteado—, la completitud
  -- pasaba, y el sello caía justo antes de que el documento pasara a ser citable. Los insights
  -- quedaban sellados sin haber visto una evidencia que el reto ya tenía.
  --
  -- Van en UNA sola sentencia y no en dos: dos «for share» sobre conjuntos que se solapan sin
  -- que uno contenga al otro se piden en órdenes distintos según qué cite cada propuesta, y eso
  -- es un interbloqueo esperando a que dos aceptaciones coincidan. Una sentencia sobre la unión
  -- tiene un orden y solo uno.
  perform du.evidencia_id
    from derecho_uso du
   where du.workspace_id = new.workspace_id
     and du.evidencia_id in (
       select c.evidencia_id
         from afirmacion a
         join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
        where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id
        union
       select ae.evidencia_id
         from arquetipo a
         join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
        where a.reto_id = new.reto_id and a.workspace_id = new.workspace_id
        union
       -- Y las dos puntas de C4, dentro de la MISMA sentencia y por el mismo argumento: lo que
       -- los hallazgos citan, y lo que el arquetipo que revisa tiene enlazado —que es el
       -- material del que la propuesta salió—. Partirlas en un `for share` aparte reintroduce
       -- exactamente el interbloqueo que este párrafo describe.
       select he.evidencia_id
         from hallazgo_simulado h
         join hallazgo_simulado_evidencia he on he.hallazgo_id = h.id
          and he.workspace_id = h.workspace_id
        where h.revision_id = new.revision_simulada_id and h.workspace_id = new.workspace_id
        union
       select ae.evidencia_id
         from revision_simulada r
         join arquetipo_evidencia ae on ae.arquetipo_id = r.arquetipo_id
          and ae.workspace_id = r.workspace_id
        where r.id = new.revision_simulada_id and r.workspace_id = new.workspace_id)
   order by du.evidencia_id
     for share;
  if new.insight_id is not null and exists (
    select 1
    from afirmacion a
    join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
    where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id
      and not evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente')) then
    raise exception 'DR001: alguna de las evidencias que este insight cita dejó de poder citarse al cliente mientras se aceptaba (se retiró el derecho de uso, caducó, o el documento ya no está)';
  end if;
  -- Lo mismo para los hallazgos de C4, y es la misma frase: `evidencia_citable_guard` lo exige
  -- al insertar cada enlace y ahí lee el derecho en el snapshot de SU sentencia; entre esa
  -- lectura y el commit cabe una revocación ajena ya commiteada. Que el hallazgo sea simulación
  -- no cambia nada aquí: lo que se sostiene en el documento es una frase que alguien va a leer.
  if new.revision_simulada_id is not null and exists (
    select 1
    from hallazgo_simulado h
    join hallazgo_simulado_evidencia he on he.hallazgo_id = h.id
     and he.workspace_id = h.workspace_id
    where h.revision_id = new.revision_simulada_id and h.workspace_id = new.workspace_id
      and not evidencia_usable(he.evidencia_id, he.workspace_id, 'cliente')) then
    raise exception 'DR001: alguna de las evidencias que los hallazgos de esa revisión citan dejó de poder citarse al cliente mientras se aceptaba (se retiró el derecho de uso, caducó, o el documento ya no está)';
  end if;
  -- Y que la revisión haya VISTO toda la evidencia que su arquetipo tiene ahora, que es la
  -- hermana de la de los insights con el conjunto que a C4 le corresponde: su material es el
  -- concepto, el arquetipo y LA EVIDENCIA DE ESE ARQUETIPO, así que lo que se enlazó al
  -- arquetipo después de generar la propuesta es material que la sesión no leyó. Sellarla es
  -- firmar una lectura del «desconfiado digital» hecha sin el testimonio que acaba de
  -- entrar — y la corrección humana no lo compensa, porque los hallazgos no se reescriben.
  --
  -- Y SIN LA CONDICIÓN «y el alcance no es nulo», que era la puerta y no la llave. Un alcance
  -- nulo no comprueba MENOS: apaga las dos comprobaciones enteras, porque `x = any (null)` es
  -- nulo y `not null` no es verdadero. El CHECK de abajo lo exige para C4 —como C2 y C3 hacen
  -- con los suyos—, así que por esa etiqueta ya no entra; el `coalesce` es para la fila que
  -- llegue con OTRA, porque este guard cuelga de `revision_simulada_id` y no de `capacidad`.
  -- Con el array vacío, una lente con evidencia falla en vez de pasar: el modo de fallo
  -- apunta hacia donde tiene que apuntar.
  if new.revision_simulada_id is not null then
    if exists (
      select 1
        from revision_simulada r
        join arquetipo_evidencia ae on ae.arquetipo_id = r.arquetipo_id
         and ae.workspace_id = r.workspace_id
       where r.id = new.revision_simulada_id and r.workspace_id = new.workspace_id
         and evidencia_usable(ae.evidencia_id, ae.workspace_id, 'cliente')
         and not (ae.evidencia_id = any (coalesce(new.alcance_evidencia, '{}'::uuid[])))) then
      raise exception 'ese arquetipo tiene evidencia que esta revisión no llegó a ver: se enlazó después de generarla, así que la propuesta quedó obsoleta y solo puede rechazarse. Vuelve a pedirla para que la tenga en cuenta';
    end if;
    -- Y EL ALCANCE NO DECLARA DE MÁS, que es la misma pregunta cerrada por el otro lado.
    --
    -- La de arriba es una CONTENCIÓN: «no falta ninguna». Sola, un alcance inflado la satisface
    -- para siempre — se declara la evidencia de la lente MÁS un documento cualquiera del
    -- workspace, y el día que ese documento se enlace al arquetipo la comprobación lo encuentra
    -- ya dentro y deja sellar una revisión que nunca lo vio. Las dos juntas son una IGUALDAD, y
    -- es la misma lección que C3 pagó en su ronda 5: un alcance que solo contiene no acota.
    --
    -- Va en el SELLO y no al insertar, a propósito. Al insertar, el conjunto que el modelo vio
    -- y el que el arquetipo tiene se separan legítimamente durante la llamada al proveedor: un
    -- enlace nuevo en esos segundos haría fallar el INSERT, y entonces se pierde el lote entero
    -- con la llamada ya pagada. Aquí no: lo que se rechaza es sellar, la propuesta sigue
    -- pudiendo rechazarse, y quien la escribió con un alcance inflado nunca tuvo razón.
    if exists (
      select 1
        from revision_simulada r
        cross join unnest(coalesce(new.alcance_evidencia, '{}'::uuid[])) as declarado(evidencia_id)
       where r.id = new.revision_simulada_id and r.workspace_id = new.workspace_id
         and not exists (
           select 1 from arquetipo_evidencia ae
            where ae.arquetipo_id = r.arquetipo_id and ae.workspace_id = r.workspace_id
              and ae.evidencia_id = declarado.evidencia_id)) then
      raise exception 'ese alcance declara evidencia que no es de la lente que firma esta revisión: lo que se sella tiene que ser lo que esa lente enseñó, ni más ni menos';
    end if;
    -- Y QUE LA LENTE SIGA SIENDO UNA LENTE, que es la misma pregunta por el otro lado.
    --
    -- La de arriba dice «no falta ninguna»: caza la evidencia que ENTRÓ después. No dice nada
    -- de la que SALIÓ, y salir no es desenlazarla —«arquetipo_evidencia» no tiene política de
    -- DELETE ni grant, así que por la superficie concedida un enlace no se quita— sino dejar
    -- de ser utilizable: el derecho se revoca, caduca, o el documento se va.
    --
    -- Entonces la lente se queda vacía, y sellar ahí contradice la puerta que la GENERACIÓN ya
    -- tiene puesta: sin lentes no se pide la revisión, porque lo que volvería es «un perfil
    -- inventado hablando en primera persona» (SYS-20). La misma regla estaba escrita en un solo
    -- extremo del camino, y el que faltaba es el que sella.
    --
    -- Se pide UNA que la revisión haya visto, no todas, y aquí sí es a propósito: «todas» es
    -- justo lo que pregunta la comprobación de arriba, y esta responde a otra cosa. Lo que se
    -- protege es que lo sellado siga siendo la lectura de una lente y no de un perfil vacío,
    -- y para eso una basta.
    --
    -- (El alcance ES el de la lente desde que se escribe partido por sesión: con el del LOTE
    -- —la evidencia de todas las lentes que llegaron al modelo— ni siquiera la de arriba
    -- servía, porque un documento enlazado a esta lente DESPUÉS pasaba por visto si otra lente
    -- ya lo enseñaba. Ver «evidenciaPorLenteQueLlegoAlRevisor».)
    --
    -- Y una sesión de hipótesis pura es justo la que llega hasta aquí: donde hay citas, la
    -- comprobación de DR001 de más arriba ya para la revocación.
    if not exists (
      select 1
        from revision_simulada r
        join arquetipo_evidencia ae on ae.arquetipo_id = r.arquetipo_id
         and ae.workspace_id = r.workspace_id
       where r.id = new.revision_simulada_id and r.workspace_id = new.workspace_id
         and evidencia_usable(ae.evidencia_id, ae.workspace_id, 'cliente')
         and ae.evidencia_id = any (coalesce(new.alcance_evidencia, '{}'::uuid[]))) then
      raise exception 'esa revisión se quedó sin evidencia utilizable de su arquetipo: el permiso de cita se retiró, caducó o el documento ya no está, así que lo que se sellaría es la lectura de un perfil sin nada detrás (SYS-20). Renueva el permiso y vuelve a pedirla, o recházala';
    end if;
  end if;
  -- Y que el insight haya VISTO toda la evidencia que el reto tiene ahora.
  --
  -- Las dos comprobaciones de arriba miran la evidencia que el insight SÍ cita. Esta mira la
  -- que no cita porque no existía para él: entre que la propuesta se guardó y este commit se
  -- pudo enlazar un documento nuevo al reto, y sellar aquí es sellar un insight que nunca lo
  -- leyó — en C2, posiblemente el que lo contradice. Quien revisa no puede compensarlo: las
  -- contradicciones son inmutables, que es la decisión de arriba mirada desde el otro lado.
  --
  -- El candado por CLAVE va primero, y no basta con el «for share» sobre la fila del reto que
  -- ya se tomó: un «insert into arquetipo_evidencia» sin commitear no está en ninguna fila
  -- leída, así que un candado de fila no lo ve. `designio:reto:` es la misma clave que toman
  -- el trigger de «arquetipo_evidencia» y la revalidación previa al despacho.
  if new.reto_id is not null and new.alcance_evidencia is not null then
    if exists (
      select 1
        from arquetipo a
        join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
       where a.reto_id = new.reto_id and a.workspace_id = new.workspace_id
         and evidencia_usable(ae.evidencia_id, ae.workspace_id, 'cliente')
         and not (ae.evidencia_id = any (new.alcance_evidencia))) then
      raise exception 'ese reto tiene evidencia que estos insights no llegaron a ver: se enlazó después de generarlos, así que la propuesta quedó obsoleta y solo puede rechazarse. Vuelve a pedirla para que la tenga en cuenta';
    end if;
  end if;

  -- ── Y LA OPORTUNIDAD, EN SUS DOS EJES ──
  --
  -- 1. LA VENTANA. Entre proponer una HMW y aceptarla caben días, y lo que pasa en esos días
  --    es precisamente lo que la cierra: se firma G3 —que certifica el portafolio tal como
  --    está—, se abre la medición, o se cierra el reto. Sellar entonces mete una HMW en un
  --    portafolio que un gate ya dio por bueno, sin que su guard vuelva a correr para
  --    desmentirlo. Es el mismo eje TIEMPO que obliga a C6 a volver a mirar la firma del
  --    registry y a C2 los derechos de sus citas.
  --
  --    La política de `oportunidad` ya lo exige al INSERTAR la fila, y aun así se comprueba
  --    aquí: aquélla corre en la sentencia del insert, con su snapshot; ésta corre en el
  --    commit, que es donde una firma que llegó en medio sí se ve. El candado por clave del
  --    reto ya está tomado arriba, así que la lectura no es una foto.
  if new.destino = 'oportunidad'
     and not reto_admite_portafolio(new.reto_id, new.workspace_id) then
    raise exception 'el portafolio de ese reto se cerró mientras esta HMW esperaba revisión —se firmó su G3, se abrió la medición o se cerró el reto—: la propuesta solo puede rechazarse';
  end if;
  -- 2. EL ALCANCE. La HMW tiene que haber VISTO todos los insights validados que el reto
  --    tiene ahora. `alcance_insights` guarda los que llegaron enteros al modelo; entre
  --    generar y aceptar se puede VALIDAR uno nuevo, y una pregunta sellada entonces se
  --    escribió sin conocer parte de lo que el reto ya sabe — posiblemente lo que la
  --    reformularía. Quien revisa no puede compensarlo leyendo la propuesta: lo que falta no
  --    está escrito en ella.
  --
  --    Es el hermano exacto de la comprobación de C2 de arriba, con el `for share` del reto y
  --    la clave ya tomados. Los insights se atan al reto por sus arquetipos, igual que la
  --    evidencia: la misma travesía, un salto más.
  if new.destino = 'oportunidad' and new.alcance_insights is not null then
    if exists (
      select 1 from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id)
       where not (v.id = any (new.alcance_insights))) then
      raise exception 'ese reto tiene insights validados que estas oportunidades no llegaron a ver: se validaron después de generarlas, así que la propuesta quedó obsoleta y solo puede rechazarse. Vuelve a pedirla para que los tenga en cuenta';
    end if;
    -- Y NINGUNO DE MÁS, que es lo que convierte la cota en una IGUALDAD.
    --
    -- Con «no falta ninguno» a secas, el array se podía PREDECLARAR: meter un id ajeno hoy y
    -- esperar a que ese insight pase a ser del reto mañana —basta con enlazar su evidencia a
    -- un arquetipo suyo—. Entonces el conjunto real crece hasta caber dentro de lo declarado,
    -- la comprobación de arriba pasa por haberlo anticipado, y la HMW se sella sin haber visto
    -- un insight que el reto ya tiene. Es justo el agujero que esa comprobación existía para
    -- tapar, abierto desde el otro lado.
    --
    -- Declarar de más no es un caso legítimo: el servicio escribe EXACTAMENTE los que llegaron
    -- enteros, y desde que no se despacha con ninguno recortado eso es todo el conjunto. Un
    -- alcance que no cuadra con el reto solo sale de la superficie SQL.
    if exists (
      select 1 from unnest(new.alcance_insights) as a(id)
      where a.id not in (
        select v.id from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id))) then
      raise exception 'el alcance declarado por esa propuesta no es el del reto: dice haber leído insights que el reto no tiene validados, así que no dice la verdad sobre lo que se le enseñó al modelo y no puede sellarse (SYS-19)';
    end if;
    -- Y EL OTRO SENTIDO: lo citado tiene que caber DENTRO del alcance.
    --
    -- La comprobación de arriba dice «no falta ninguno», y esa mitad sola no afirma nada sobre
    -- lo que la propuesta cita. La política de `oportunidad_insight` admite cualquier insight
    -- VALIDADO DEL WORKSPACE —no del reto—, así que por la superficie concedida se podía citar
    -- uno ajeno, enlazarlo, entregar un `alcance_insights` completo (lo es: contiene todos los
    -- del reto) y sellar. Medido: sellaba. La HMW quedaba atribuida a material que el modelo
    -- nunca recibió, con la traza y el alcance diciendo cada uno una verdad distinta.
    --
    -- Se mira la CITA y no la traza porque la cita es el original: la traza se deriva de ella
    -- —eso lo comprueba el bloque de «la traza es la cita»— así que acotar aquí acota las dos,
    -- y hacerlo al revés dejaría el orden de las comprobaciones decidiendo qué se protege.
    --
    -- Y se mide contra `insights_validados_del_reto`, que es el HECHO, no contra
    -- `alcance_insights`, que es lo DECLARADO por quien insertó la fila. Escrito contra el
    -- array no cerraba nada: hay `grant insert (alcance_insights)`, así que el llamante puede
    -- meter el ajeno dentro, y entonces las dos comprobaciones que miran el array se cumplen a
    -- la vez —la de arriba porque un superconjunto sigue conteniendo todos los del reto, y
    -- ésta porque lo citado ya está dentro—. Dos verdades sobre una lista que escribió el
    -- propio llamante no son ninguna verdad sobre el reto. Medido: con el alcance inflado,
    -- sellaba.
    --
    -- La comprobación de arriba no sobra: dice que no FALTE ninguno, y ésta que no SOBRE
    -- ninguno. Juntas, y con ésta apoyada en el hecho, el array ya no puede mentir a favor de
    -- nadie — si declara de más, esta rama lo caza; si declara de menos, la de arriba.
    --
    -- `lower`, igual que en el resto de este guard: un uuid en mayúscula es el MISMO uuid y la
    -- superficie SQL no pasa por el parser, que es quien lo normaliza.
    if exists (
      select 1 from jsonb_array_elements(new.contenido -> 'citas') as c(cita)
      where lower(c.cita ->> 'insightId')::uuid not in (
        select v.id from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id))) then
      raise exception 'esa oportunidad cita insights que no entraron en el material que se le mandó al modelo: una HMW solo puede apoyarse en lo que leyó, y el alcance sellado dice qué fue (SYS-19)';
    end if;
  end if;
  -- Y las CONTRADICCIONES, que son parte del insight y no un adorno.
  --
  -- La comprobación de arriba cubría la cabecera, las afirmaciones y sus citas, y dejaba fuera
  -- las contradicciones: con los grants que la aplicación tiene, quien escriba por SQL podía
  -- omitirlas o cambiarlas y sellar la propuesta como aceptada igual. Y son justamente la
  -- parte que más tienta omitir —es la evidencia que va EN CONTRA—, así que dejarla sin
  -- procedencia rompe la garantía por el sitio en que más importa.
  --
  -- Se comprueba en los dos sentidos: que no falte ninguna de las propuestas y que no sobre
  -- ninguna. Para el segundo basta el RECUENTO, pero solo porque el guard del INSERT ya rechaza
  -- la contradicción repetida: con repetidas, el recuento cuadra y las dos entradas iguales
  -- encuentran la misma fila, de modo que otra distinta entra sin revisar. El
  -- `unique (insight_id, evidencia_id)` no lo cierra, porque las dos filas materializadas
  -- pueden ser de evidencias distintas.
  if new.destino = 'insight' and (
    (select count(*) from contradiccion co
      where co.insight_id = new.insight_id and co.workspace_id = new.workspace_id)
    <> coalesce(jsonb_array_length(new.contenido->'contradicciones'), 0)
    or exists (
      select 1
      from jsonb_array_elements(
             case when jsonb_typeof(new.contenido->'contradicciones') = 'array'
                  then new.contenido->'contradicciones' else '[]'::jsonb end) as p(co)
      where not exists (
        select 1 from contradiccion c
        where c.insight_id = new.insight_id and c.workspace_id = new.workspace_id
          -- `lower`, por lo mismo que en las citas.
          and c.evidencia_id::text = lower(p.co->>'evidenciaId')
          and c.descripcion = p.co->>'descripcion'))) then
    raise exception 'las contradicciones del insight materializado no son las de la propuesta: se copian tal cual, y son la evidencia que va en contra (SYS-19)';
  end if;
  if new.destino = 'criterio-exito' and not exists (
    select 1 from criterio_exito c
    where c.id = new.criterio_id and c.workspace_id = new.workspace_id
      and c.kpi = new.contenido->>'kpi'
      and c.definicion = new.contenido->>'definicion'
      and c.objetivo = new.contenido->>'objetivo'
      and c.ventana_dias = (new.contenido->>'ventanaDias')::integer
      and c.linea_base_plan = new.contenido->>'lineaBasePlan') then
    raise exception 'el criterio materializado no dice lo que dice la propuesta: el KPI, la definición, el objetivo, la ventana y el plan de línea base se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;
  -- Y la de la entrada KPI. Los seis campos que la propuesta DICTA, y solo esos: el criterio
  -- al que responde, el nombre, la definición, la fuente, las dimensiones y la frecuencia.
  -- Los demás —el dueño del dato, la línea base, la ventana, el dashboard y la fecha del post
  -- mortem— NO se comparan porque la propuesta no los dice: son compromisos y datos, no
  -- redacción, y la cabecera de esta migración explica por qué C6 no los propone. Compararlos
  -- exigiría que nacieran vacíos y ataría este guard a esa decisión del servicio.
  if new.destino = 'entrada-kpi' and not exists (
    select 1 from entrada_kpi e
    where e.id = new.entrada_kpi_id and e.workspace_id = new.workspace_id
      and e.criterio_id = (new.contenido ->> 'criterioId')::uuid
      and e.nombre      = new.contenido ->> 'nombre'
      and e.definicion  = new.contenido ->> 'definicion'
      and e.fuente      = new.contenido ->> 'fuente'
      and e.dimensiones = new.contenido ->> 'dimensiones'
      and e.frecuencia  = new.contenido ->> 'frecuencia') then
    raise exception 'la entrada KPI materializada no dice lo que dice la propuesta: el criterio al que responde, el nombre, la definición, la fuente, las dimensiones y la frecuencia se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;

  -- Y la de la OPORTUNIDAD. Los tres campos que la propuesta DICTA, y solo esos: la pregunta,
  -- la prioridad y su razón. El veredicto y su razón NO se comparan porque la propuesta no los
  -- dice: nacen vacíos y los escribe la decisión humana, que llega por otra puerta y con su
  -- propia re-comprobación del razonamiento.
  --
  -- Sin esto la oportunidad se quedaba con su PREDICADO a secas —cuelga del reto, la firma
  -- quien aceptó, nace por decidir, su traza es la citada—, y todo eso lo cumple una HMW que
  -- pregunte otra cosa. Medido por la superficie concedida: sellaba. Lo que quedaba entonces
  -- era una propuesta constando como aceptada con un objeto atribuido que dice algo distinto,
  -- que es procedencia corrupta y una tasa de corrección midiendo texto que nadie propuso.
  --
  -- Verbatim y sin `titulo_normalizado`: la comparación es «se copió tal cual», no «se parece
  -- lo bastante». El esquema normaliza para decidir si la pregunta está VACÍA y para el único
  -- por reto —dos preguntas iguales— y ésas son otras preguntas; aquí normalizar dejaría pasar
  -- una HMW que cambia acentos o espacios respecto de lo que el modelo escribió.
  if new.destino = 'oportunidad' and not exists (
    select 1 from oportunidad o
    where o.id = new.oportunidad_id and o.workspace_id = new.workspace_id
      and o.pregunta        = new.contenido ->> 'pregunta'
      and o.prioridad       = (new.contenido ->> 'prioridad')::integer
      and o.prioridad_razon = new.contenido ->> 'prioridadRazon') then
    raise exception 'la HMW materializada no dice lo que dice la propuesta: la pregunta, la prioridad y su razón se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;

  -- Y LA RELACIÓN, estampada aquí porque este es el único sitio que sabe que la
  -- materialización es legítima: la columna está fuera de todo grant, así que la fila queda
  -- diciendo de qué propuesta viene y ningún camino de la aplicación puede escribirlo ni
  -- reescribirlo después. El índice único hace el resto: si el objeto ya cuelga de otra
  -- propuesta, esto no lo pisa —el `where … is null` no lo alcanza— y el conteo de abajo lo
  -- rechaza. Es la versión permanente de lo que el `xmin` solo sostenía dentro del commit.
  --
  -- Una rama POR DESTINO y un `else` que grita, en vez del `else` que sellaba criterios.
  -- Escrito como «evidencia, si no criterio» era exacto con dos destinos y falso con tres:
  -- un insight caía en el `else` y trataba de sellar `criterio_exito` con un `criterio_id`
  -- nulo — cero filas, y el rechazo salía como «ese objeto ya cuelga de otra propuesta»,
  -- que además es mentira. Es el modo de fallo que `ai.schemas.ts` describe para los
  -- ternarios binarios: elegir el `else` en silencio. Aquí ya no se puede: un destino que
  -- nadie selle se nombra y aborta.
  if new.destino = 'evidencia' then
    update evidencia set propuesta_ai_id = new.id
      where id = new.evidencia_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  elsif new.destino = 'criterio-exito' then
    update criterio_exito set propuesta_ai_id = new.id
      where id = new.criterio_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  elsif new.destino = 'insight' then
    update insight set propuesta_ai_id = new.id
      where id = new.insight_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  elsif new.destino = 'entrada-kpi' then
    update entrada_kpi set propuesta_ai_id = new.id
      where id = new.entrada_kpi_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  elsif new.destino = 'oportunidad' then
    update oportunidad set propuesta_ai_id = new.id
      where id = new.oportunidad_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  elsif new.destino = 'revision-simulada' then
    update revision_simulada set propuesta_ai_id = new.id
      where id = new.revision_simulada_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  elsif new.destino = 'outcome-review' then
    -- SIN `propuesta_ai_id is null`, y es la única rama que lo omite. Las otras sellan un
    -- objeto que NACE, y un objeto tiene una sola procedencia para siempre. Ésta sella una
    -- EDICIÓN: la columna dice de qué propuesta salió la narrativa que hay ahora, así que un
    -- segundo borrador aceptado la sustituye, igual que sustituyó al texto. Con el guardián
    -- puesto, el segundo intento moriría diciendo «ese objeto ya cuelga de otra propuesta»,
    -- que es verdad y no viene al caso: la primera sigue archivada y legible (SYS-17), que es
    -- donde vive la historia.
    update outcome_review set propuesta_ai_id = new.id
      where id = new.outcome_review_id and workspace_id = new.workspace_id;
    get diagnostics v_filas = row_count;
  else
    raise exception 'destino de propuesta AI sin sello de procedencia: % — un destino nuevo tiene que decir qué objeto sella (SYS-19)', coalesce(new.destino, '(sin destino)');
  end if;
  if v_filas <> 1 then
    raise exception 'ese objeto ya cuelga de otra propuesta AI: un objeto materializado tiene una sola procedencia (SYS-19)';
  end if;

  return null;
end $function$
;

-- ── Y EL EVENTO DE LA ACEPTACIÓN, QUE NO NOMBRABA NI A C7 NI A C4 ──
--
-- ⚠ Se reescribe entera y por eso se VUELCA DE LA VIVA, no se copia de una migración anterior:
-- es el mismo peligro que los `drop constraint` + `add constraint` de arriba, y este fichero ya
-- lo pagó una vez con las tres listas que nacieron sin `outcome_review_id`.
CREATE OR REPLACE FUNCTION public.propuesta_ai_revision_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_reto uuid;
begin
  -- Pre-chequeo anti-oráculo: para quien no es miembro del workspace declarado no hay
  -- nada que auditar ni que serializar — la política rechaza la escritura como siempre.
  -- (El seed y los backfills corren como owner sin contexto y también lo saltan.)
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- RF-09.5: el material de personas no se procesa sin consentimiento registrado
    -- ANTES. El servicio lo comprueba antes de construir el prompt —ahí es donde se
    -- evita de verdad la fuga al proveedor— y esto es el suelo: una propuesta derivada
    -- de material sin consentimiento no puede EXISTIR, venga de donde venga la
    -- escritura. Y exige que el consentimiento cubra el procesamiento externo: haber
    -- autorizado la grabación no es haber autorizado mandarla a un tercero.
    -- Se mira el registro VIGENTE, no «si existe alguno»: un permiso solo para uso interno
    -- no desbloquea, uno externo posterior sí, y una revocación futura vuelve a bloquear.
    if new.item_id is not null and exists (
      select 1 from item_importacion i
      where i.id = new.item_id and i.workspace_id = new.workspace_id
        and tipo_fuente_exige_consentimiento(i.tipo_fuente)
        and not consentimiento_externo_vigente(i.id, i.workspace_id)
    ) then
      raise exception 'ese material exige consentimiento registrado para procesamiento externo antes de generar propuestas AI (RF-09.5)';
    end if;

    -- Y no puede haber extracción de un item sin material que extraer: una evidencia
    -- fechada y citada derivada solo de la ficha (título y referencia) sería inventada por
    -- construcción, no por casualidad. El servicio lo corta antes de gastar la llamada;
    -- esto es el suelo para cualquier otra escritura.
    if new.item_id is not null and exists (
      select 1 from item_importacion i
      where i.id = new.item_id and i.workspace_id = new.workspace_id
        and not item_tiene_material_extraible(i.contenido)
    ) then
      raise exception 'ese item no tiene material que citar (solo referencia): no se pueden generar propuestas de extracción sobre él';
    end if;

    -- El ANCLA tiene que seguir admitiendo la propuesta en el momento de escribirla. Todo
    -- lo que el servicio comprobó antes de llamar al proveedor lleva ya una transacción
    -- commiteada de retraso: entre medias otro curador pudo curar el item a mano o aprobar
    -- el G0 del reto. Sin esto nacía una propuesta obsoleta — pendiente en el panel y
    -- rechazada por la materialización— que solo se podía tirar.
    if new.item_id is not null and not exists (
      select 1 from item_importacion i
      where i.id = new.item_id and i.workspace_id = new.workspace_id
        and i.estado = 'pendiente'
    ) then
      raise exception 'ese item de la bandeja ya fue decidido: no admite propuestas nuevas';
    end if;
    -- Un reto ARCHIVADO no admite propuestas de NINGUNA clase: ahí el trabajo se cerró.
    -- Va por delante y por separado de la puerta de los criterios porque es lo único de
    -- aquella condición que hablaba del RETO y no de los criterios; sin sacarlo aquí, C2 se
    -- quedaba sin este suelo al salir de ella.
    --
    -- Y BAJO CANDADO, que es la quinta vez que hace falta la misma frase en este PR. Un
    -- archivado EN VUELO no lo ve este snapshot: el `exists` a secas lee la versión activa
    -- anterior sin esperar, la clave ajena de la propuesta no choca con un UPDATE de
    -- `estado` —que no es columna de clave—, y la propuesta commitea después del archivo.
    -- Nace ya «reto-archivado»: visible en el panel, imposible de aceptar, con la llamada
    -- pagada. `for share` sobre la fila del reto es lo que la ordena detrás o delante, y va
    -- ANTES de cualquier candado sobre `derecho_uso` — el orden del protocolo, el mismo que
    -- toman el guard diferido, la revalidación previa al despacho y `bloquearReto`.
    -- ── EL RETO DE ESTA PROPUESTA, QUE EN C6 VIVE DETRÁS DEL REGISTRY ──
    -- `propuesta_ai_un_ancla` deja `reto_id` NULO cuando el ancla es el registry, así que
    -- preguntando por la columna se saltaba el candado entero: ni la clave de aviso del reto, ni
    -- el `for share` sobre su fila. Y el estado del reto SÍ decide aquí —
    -- `registry_admite_entradas` lo mira por dentro (`rt.estado <> 'archivado'`)—, de modo que sin
    -- candado esa lectura es una FOTO. Medido: con un archivado en vuelo, la propuesta de C6 NACE
    -- —no espera a nadie— y queda en el panel imposible de aceptar, con la llamada ya pagada. Es
    -- exactamente lo que las sondas de C0 y C2 impiden para el ancla que sí es un reto.
    --
    -- Se resuelve por la tabla y no copiando `reto_id` en la propuesta: `metric_registry.reto_id`
    -- es la relación de verdad, y duplicarla sería un segundo sitio donde puede decir otra cosa.
    v_reto := new.reto_id;
    if v_reto is null and new.registry_id is not null then
      select mr.reto_id into v_reto from metric_registry mr
       where mr.id = new.registry_id and mr.workspace_id = new.workspace_id;
    end if;
    -- Y LAS DOS QUE FALTABAN, por la MISMA razón y con la misma forma. Esta lista enumera
    -- anclas a mano y se quedó en la de C6: ni el concepto de C4 ni el post mortem de C7
    -- —que entró con #47 y ya está en `agents`— resolvían su reto, así que para ellas no
    -- había candado, y por tanto tampoco ninguna de las puertas que el candado protege.
    --
    -- Es la TERCERA vez que esta forma falla en este fichero: antes fueron las tres listas de
    -- `num_nonnulls` y el payload del evento de aceptación. Queda dicho aquí.
    if v_reto is null and new.concepto_id is not null then
      select c.reto_id into v_reto from concepto c
       where c.id = new.concepto_id and c.workspace_id = new.workspace_id;
    end if;
    if v_reto is null and new.outcome_review_id is not null then
      select orv.reto_id into v_reto from outcome_review orv
       where orv.id = new.outcome_review_id and orv.workspace_id = new.workspace_id;
    end if;
    if v_reto is not null then
      perform 1 from reto r
       where r.id = v_reto and r.workspace_id = new.workspace_id
       for share;
    end if;
    if v_reto is not null and exists (
      select 1 from reto r
      where r.id = v_reto and r.workspace_id = new.workspace_id
        and r.estado = 'archivado'
    ) then
      raise exception 'ese reto está archivado: no admite propuestas AI nuevas';
    end if;
    -- LAS DOS PUERTAS DE C4, aquí y no solo al materializar. Una propuesta que nace sobre un
    -- concepto ya decidido —o con la etapa 4 cerrada— no se podrá aceptar NUNCA: la política y
    -- el guard diferido la paran. Lo que queda es una fila pendiente que además bloquea pedir
    -- otra, porque el selector no ofrece un concepto con propuesta de C4 en curso, y la llamada
    -- al proveedor ya está pagada. El candado del reto ya está en la mano, así que lo que se lee
    -- aquí no es una foto.
    if new.concepto_id is not null and session_user = 'designio_app' then
      if not exists (select 1 from concepto c
                      where c.id = new.concepto_id and c.workspace_id = new.workspace_id
                        and c.estado = 'candidato') then
        raise exception 'ese concepto ya no es candidato: su pasa/muere está firmado, así que una revisión simulada nueva llegaría después de la decisión que existía para informar';
      end if;
      if v_reto is not null and not reto_admite_conceptos(v_reto, new.workspace_id) then
        raise exception 'la etapa 4 de ese reto está cerrada: no admite revisiones simuladas nuevas';
      end if;
    end if;
    -- Y la puerta de los criterios, por DESTINO y no por ancla. Escrita como «toda
    -- propuesta que cuelgue de un reto» era exacta mientras solo C0 colgara de ahí; con C2
    -- colgando del mismo reto pasaba a decir que un G0 aprobado —que congela los CRITERIOS
    -- (SYS-22)— prohíbe también proponer INSIGHTS, y que un reto `en-medicion` o `cerrado`
    -- tampoco los admite. Medido sobre un reto en medición: `reto_admite_criterios` da
    -- false, así que el INSERT de C2 moría ahí, DESPUÉS de pagar la llamada.
    --
    -- Es el mismo conjunto de filas para C0 —`propuesta_ai_destino_c0` ata C0 ⇔
    -- criterio-exito—, así que su comportamiento no cambia; y quien materialice un criterio
    -- mañana hereda la puerta por materializarlo, no por dónde cuelga. `destino` es
    -- anulable desde CT y `null = 'criterio-exito'` da null, que no dispara: correcto, una
    -- capacidad informativa no crea criterios.
    -- Y el REGISTRY tiene que SEGUIR admitiendo entradas, por lo mismo que el item tiene que
    -- seguir pendiente y el reto sin archivar: lo que el servicio comprobó antes de llamar
    -- lleva ya una transacción commiteada de retraso, y entre medias alguien pudo FIRMAR el
    -- registry —que es su congelado, el G6 del contrato de medición— o cerrar el reto. Sin
    -- esto nacía una propuesta obsoleta: pendiente en el panel, rechazada por la
    -- materialización, y con la llamada ya pagada.
    --
    -- Y BAJO CANDADO, con el mismo argumento que el reto y en el mismo orden —el `for share`
    -- del reto va antes, y el del registry detrás—: una firma EN VUELO no la ve este snapshot.
    -- `for share` sobre la fila del registry choca con el `FOR NO KEY UPDATE` que toma quien
    -- firma; entre dos generaciones no hay espera, porque las dos piden compartido.
    if new.registry_id is not null then
      perform 1 from metric_registry r
       where r.id = new.registry_id and r.workspace_id = new.workspace_id
       for share;
      if not registry_admite_entradas(new.registry_id, new.workspace_id) then
        raise exception 'ese Metric Registry ya no admite entradas: o está firmado —y firmarlo congela el contrato—, o el trabajo de su reto se cerró';
      end if;
    end if;
    if new.destino = 'criterio-exito' and (
      reto_criterios_congelados(new.reto_id, new.workspace_id)
      or not reto_admite_criterios(new.reto_id, new.workspace_id)
    ) then
      raise exception 'ese reto ya no admite criterios nuevos: o su G0 los congeló, o su registry de medición está firmado, o el reto avanzó más allá de candidato/activo';
    end if;
    -- Y la VENTANA DEL PORTAFOLIO, por DESTINO y por la misma razón que la de los criterios:
    -- de este reto cuelgan ya tres capacidades, y la puerta es de lo que se materializa, no
    -- de dónde cuelga. Escrita como «toda propuesta anclada en un reto» diría que un G3
    -- firmado prohíbe también proponer criterios e insights, que es falso.
    --
    -- `reto_admite_portafolio` es la ventana que ya miran las cuatro políticas de
    -- `oportunidad`: C3 no escribe una segunda redacción de la misma pregunta, porque dos
    -- redacciones se separan y entonces la pantalla ofrece lo que la base rechaza.
    --
    -- Y hace falta AQUÍ y no solo en el servicio: entre que la generación la comprobó y este
    -- INSERT commitea hay una transacción de por medio, y lo que ocurre en ese hueco es justo
    -- lo que la cierra —firmar G3, abrir la medición, cerrar el reto—. Sin esto nacía una
    -- propuesta obsoleta: pendiente en el panel, imposible de aceptar, con la llamada pagada.
    -- La lectura va bajo el `for share` del reto que se tomó arriba, así que una firma en
    -- vuelo la ordena en vez de dejarla leer una foto.
    if new.destino = 'oportunidad'
       and not reto_admite_portafolio(new.reto_id, new.workspace_id) then
      raise exception 'el portafolio de ese reto está cerrado: su G3 quedó firmado sobre lo que había y la etapa 3 no está reabierta, o el reto ya no admite trabajo de método';
    end if;

    -- Y que el ALCANCE que trae sea el del reto AHORA, bajo el `for share` de arriba.
    --
    -- El servicio ya lo comprueba tras la llamada, pero esa lectura y este INSERT son dos
    -- momentos: `validarInsight` toma «designio:insight:<id>» y no la clave del reto, así que
    -- una validación puede cometearse justo en medio. Lo que se guardaba entonces era una
    -- propuesta con la llamada PAGADA y un alcance al que ya le falta un insight: nace
    -- `alcance-incompleto` y no se puede aceptar nunca. Aquí sí se ve, porque este guard tiene
    -- el candado del reto tomado, y la salida correcta es no guardarla y decir que se repita.
    --
    -- Es la misma regla que el guard diferido vuelve a hacer en el commit, en su instante: lo
    -- que caduca solo hay que preguntarlo cada vez que se escribe algo que dependa de ello.
    -- Aquí va en una sola comprobación —falta o sobra— porque el destinatario es quien pidió
    -- el lote y el remedio es el mismo: repetirlo. En el commit van separadas, porque ahí lo
    -- lee quien revisa y el motivo que se enseña tiene que ser el que ocurrió.
    if new.destino = 'oportunidad' and new.alcance_insights is not null
       and (exists (
             select 1 from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id)
             where not (v.id = any (new.alcance_insights)))
            or exists (
             select 1 from unnest(new.alcance_insights) as a(id)
             where a.id not in (
               select v.id from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id)))) then
      raise exception 'los insights validados de ese reto cambiaron mientras se preparaba esta propuesta: el alcance que trae no es el que el reto tiene ahora, así que estas preguntas se escribieron sobre otro material y no se guardan. Vuelve a pedirlas';
    end if;

    -- La llamada referenciada tiene que ser LA QUE PRODUJO esta propuesta, no una
    -- cualquiera del workspace. La FK sola comprobaba existencia y tenant, así que por SQL
    -- crudo se podía colgar una extracción de una llamada C0, de otra ancla, de otro modelo
    -- o —lo peor para el libro— de un intento que terminó en negativa o sin respuesta: el
    -- panel atribuiría entonces un coste y una latencia que no son los suyos, y el gasto
    -- por capacidad dejaría de cuadrar. Se exige la coincidencia completa.
    --
    -- Y dicho para que nadie lo lea de más: esto empareja METADATOS, no contenido. Que el
    -- `contenido` sea lo que un modelo devolvió NO es comprobable desde aquí, y no por
    -- falta de ganas: la base no es parte de la llamada HTTP, así que no tiene ningún hecho
    -- propio sobre la respuesta. Guardar un digest de la respuesta en `llamada_ai` no lo
    -- arreglaría — lo escribiría el MISMO rol, en el MISMO acto, con el MISMO grant que
    -- escribe el contenido, así que un escritor que fabrica el contenido fabrica también su
    -- huella y las dos afirmaciones se sostienen entre sí sin que ninguna se apoye en nada.
    -- La diferencia con el linaje de materialización es exacta y vale la pena tenerla clara:
    -- allí el hecho que ata (`evidencia.propuesta_ai_id`) lo produce el GUARD, que es parte
    -- de confianza y está fuera de todo grant; aquí el hecho tendría que producirlo el
    -- proveedor, que no escribe en esta base. Un digest añadiría ceremonia, no garantía.
    --
    -- Así que `contenido` pertenece al mismo conjunto declarado que `modelo`,
    -- `prompt_version`, `tokens_*`, `costo_usd` y `latencia_ms`: lineage y medidas que solo
    -- existen porque la aplicación las anota. Lo que SÍ se ata queda atado —la llamada
    -- (arriba), su unicidad para CI (índice parcial), el consentimiento bajo el que salió
    -- (FK compuesta con la constante dentro) y el objeto materializado (relación + xmin +
    -- proyección)—, y lo que no se puede atar se dice, en vez de blindarse en falso.
    if not exists (
      select 1 from llamada_ai l
      where l.id = new.llamada_id and l.workspace_id = new.workspace_id
        and l.capacidad = new.capacidad
        and l.item_id is not distinct from new.item_id
        and l.reto_id is not distinct from new.reto_id
        and l.modelo = new.modelo
        and l.origen_key = new.origen_key
        and l.resultado = 'salida-valida'
    ) then
      raise exception 'la propuesta debe colgar de la llamada que la produjo: misma capacidad, misma ancla, mismo modelo, misma credencial y con salida válida';
    end if;

    -- RF-09.9: de qué workspace salió qué material, a qué modelo y con qué credencial.
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'PropuestaAIGenerada',
      jsonb_build_object('propuestaId', new.id, 'capacidad', new.capacidad,
                         'destino', new.destino, 'modelo', new.modelo,
                         'promptVersion', new.prompt_version, 'origenKey', new.origen_key,
                         'esSimulacion', new.es_simulacion),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
    return new;
  end if;

  if new.estado = old.estado then
    return new;
  end if;
  -- Ciclo de vida de sentido único: de pendiente a una decisión, y ahí termina.
  if (old.estado, new.estado) not in (
    ('propuesta', 'aceptada'),
    ('propuesta', 'corregida'),
    ('propuesta', 'rechazada')
  ) then
    raise exception 'transición de propuesta AI ilegal: % → %', old.estado, new.estado;
  end if;

  -- El sello temporal lo pone la BASE, no el caller: una revisión no se retro ni
  -- post-data por SQL directo.
  new.revisada_en := now();

  -- SYS-17: la propuesta original se conserva SIEMPRE. No hay grant de UPDATE sobre la
  -- columna, pero el invariante se defiende también aquí (un grant futuro no lo rompe).
  if new.contenido_original is distinct from old.contenido_original then
    raise exception 'la propuesta AI original se conserva siempre (SYS-17)';
  end if;
  -- Aceptar es aceptar LO PROPUESTO; editar es corregir, y se llama por su nombre para
  -- que la tasa de corrección humana no se pueda maquillar.
  if new.estado <> 'corregida' and new.contenido is distinct from old.contenido then
    raise exception 'aceptar o rechazar no edita la propuesta: usa la corrección';
  end if;
  if new.estado = 'corregida' and new.contenido is not distinct from old.contenido then
    raise exception 'una corrección debe cambiar el contenido propuesto';
  end if;
  -- Las CITAS no se corrigen (SYS-17/RF-08.7). Son el testimonio del modelo sobre lo que
  -- dijo haber leído y la entrada de la medida de grounding: cambiar una cita inventada por
  -- otra literal deja una propuesta de aspecto impecable y borra la señal que hay que ver.
  -- El servicio lo rechaza con su mensaje; esto es el suelo, porque una promesa que solo
  -- vive en un formulario la rompe cualquier cliente que hable con la server function.
  -- Sin condicionar al destino: desde que C0 también cita —I4 dice «la AI propone Y CITA»—
  -- la regla es de las citas y no del tipo de propuesta. Atarla a 'evidencia' habría dejado
  -- las de C0 editables el mismo día que existieron. Y con ellas viaja la confianza que el
  -- modelo declaró sobre su propia propuesta: es el dato que ORDENA la revisión humana, así
  -- que dejar que la reescriba quien revisa sería maquillar la medida con la mano que se
  -- está midiendo.
  if new.contenido -> 'citas' is distinct from new.contenido_original -> 'citas'
     or new.contenido -> 'confianzaPropuesta'
        is distinct from new.contenido_original -> 'confianzaPropuesta' then
    raise exception 'las citas y la confianza declarada de una propuesta AI no se corrigen: son el rastro de lo que el modelo dijo y con lo que se ordena la revisión';
  end if;
  -- Y el CRITERIO al que una entrada KPI responde, que es testimonio por el mismo motivo que
  -- las citas y no se veía desde aquí: no está DENTRO de `citas`, es un campo de primer nivel.
  -- El servicio ya lo blinda —`TESTIMONIO_ADICIONAL.C6`— y eso cierra el formulario; el resto
  -- del suelo no lo veía: el criterio nuevo es del reto del registry, que es lo único que la
  -- materialización comprueba, y su proyección compara contra `contenido`, que es el ya
  -- corregido. Por la superficie SQL concedida, entonces, una «corrección» reapuntaba la
  -- entrada a otro criterio CONSERVANDO las citas — que es quedarse con el sostén de uno para
  -- afirmar sobre otro, exactamente lo que la regla de las citas existe para impedir.
  --
  -- Sin condicionar al destino, como la de arriba y por lo mismo: para un contenido que no
  -- lleva `criterioId` los dos lados son nulos y esto no dice nada, así que atarla a C6 solo la
  -- dejaría corta ante la siguiente capacidad que responda a un criterio.
  if new.contenido -> 'criterioId'
     is distinct from new.contenido_original -> 'criterioId' then
    raise exception 'el criterio al que responde una entrada KPI no se corrige: los fragmentos citados se copiaron de ESE criterio, así que reapuntarla a otro conservando las citas es quedarse con el sostén de uno para afirmar sobre otro (SYS-17)';
  end if;

  -- RF-09.4/09.5 en la ACEPTACIÓN, que es la otra mitad del permiso. Generar ya exigía
  -- consentimiento vigente, pero entre generar y revisar la persona puede retirarlo: la
  -- propuesta ya existe legítimamente (nació cuando el permiso valía) y lo que no puede
  -- ocurrir es que el workspace gane un objeto de dominio NUEVO derivado de un material
  -- que ya no está autorizado. Rechazarla sigue permitido —es la salida— y la curaduría a
  -- mano de la bandeja no se toca: eso no manda nada a ningún tercero (SYS-21).
  if new.estado in ('aceptada', 'corregida') and new.item_id is not null and exists (
    select 1 from item_importacion i
    where i.id = new.item_id and i.workspace_id = new.workspace_id
      and tipo_fuente_exige_consentimiento(i.tipo_fuente)
      and not consentimiento_externo_vigente(i.id, i.workspace_id)
  ) then
    raise exception 'el consentimiento de ese material ya no autoriza el procesamiento externo: la propuesta no puede materializarse (RF-09.5)';
  end if;

  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (new.workspace_id,
    case new.estado
      when 'aceptada' then 'PropuestaAIAceptada'
      when 'corregida' then 'PropuestaAICorregida'
      else 'PropuestaAIRechazada'
    end,
    -- El objeto materializado, POR SU COLUMNA, y ahora las CINCO. `insight_id` faltaba
    -- cuando llegó C2 y `jsonb_strip_nulls` se llevaba las otras por nulas, así que el evento
    -- de aquellas aceptaciones no decía QUÉ objeto se creó: un registro append-only que no
    -- puede nombrar lo que documenta no documenta nada. La lista se quedó corta otra vez con
    -- `entrada_kpi_id`, que es la misma enumeración a mano y el mismo modo de fallo — con el
    -- agravante de que aquí el silencio es exactamente igual de silencioso. Con
    -- `oportunidadId` van cinco, y la lista sigue siendo a mano: quien añada la sexta tiene
    -- que acordarse, porque nada la obliga y `jsonb_strip_nulls` no protesta por una nula.
    jsonb_strip_nulls(jsonb_build_object(
      'propuestaId', new.id, 'capacidad', new.capacidad, 'destino', new.destino,
      'modelo', new.modelo, 'evidenciaId', new.evidencia_id, 'criterioId', new.criterio_id,
      'insightId', new.insight_id, 'entradaKpiId', new.entrada_kpi_id,
      'oportunidadId', new.oportunidad_id,
      -- Y LAS DOS QUE FALTABAN. Esta lista enumera columnas de destino a mano, así que se
      -- quedó en la quinta: ni el post mortem de C7 ni la revisión de C4 aparecían. Importa
      -- porque el puntero VIVO se puede soltar —borrar una revisión aceptada suelta
      -- 'propuesta_ai.revision_simulada_id', que es la salida documentada para corregirla— y
      -- entonces lo único que queda diciendo qué objeto nació de esa propuesta es este
      -- evento, que es append-only. Hay censo que compara esta lista con COLUMNA_DE_DESTINO.
      'outcomeReviewId', new.outcome_review_id,
      'revisionSimuladaId', new.revision_simulada_id)),
    app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $function$
;
