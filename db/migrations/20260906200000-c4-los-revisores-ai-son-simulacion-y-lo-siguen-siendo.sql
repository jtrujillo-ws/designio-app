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
  select p_texto !~ '\m\d+([.,]\d+)?\s*%'
     and p_texto !~ '\m\d+\s+de\s+cada\s+\d+\M';
$fn$;

revoke execute on function sin_agregado_sintetico(text) from public;
grant execute on function sin_agregado_sintetico(text) to designio_app;

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

-- Escribe quien hace método, y solo mientras la etapa 4 siga abierta para este reto.
create policy revision_simulada_insert on revision_simulada
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from concepto c
      where c.id = revision_simulada.concepto_id
        and c.workspace_id = revision_simulada.workspace_id
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

create policy hallazgo_simulado_insert on hallazgo_simulado
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from revision_simulada r
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where r.id = hallazgo_simulado.revision_id
        and r.workspace_id = hallazgo_simulado.workspace_id
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
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

create policy pregunta_de_test_insert on pregunta_de_test
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from revision_simulada r
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where r.id = pregunta_de_test.revision_id
        and r.workspace_id = pregunta_de_test.workspace_id
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
create policy revision_simulada_delete on revision_simulada
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from concepto c
      where c.id = revision_simulada.concepto_id
        and c.workspace_id = revision_simulada.workspace_id
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

-- Y las hojas por separado, para poder quitar una cita cuyos derechos se retiraron sin tirar la
-- revisión entera. El guard diferido de arriba es el que decide si lo que queda se sostiene:
-- quitar la última cita de un hallazgo afirmativo falla en el commit, y con su motivo.
create policy hallazgo_simulado_delete on hallazgo_simulado
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from revision_simulada r
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where r.id = hallazgo_simulado.revision_id
        and r.workspace_id = hallazgo_simulado.workspace_id
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
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

create policy pregunta_de_test_delete on pregunta_de_test
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from revision_simulada r
      join concepto c on c.id = r.concepto_id and c.workspace_id = r.workspace_id
      where r.id = pregunta_de_test.revision_id
        and r.workspace_id = pregunta_de_test.workspace_id
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

-- El nombre lo elige el CENSO, no el gusto: la suite recorre las restricciones cuyo nombre
-- termina en el nombre de la columna de ancla para comprobar que toda ancla declarada en
-- `ai.schemas.ts` tiene su check en la base. `..._ancla_c4` habría pasado desapercibida.
alter table reserva_ai add constraint reserva_ai_ancla_concepto
  check ((concepto_id is not null) = (capacidad = 'C4'));
alter table llamada_ai add constraint llamada_ai_ancla_concepto
  check ((concepto_id is not null) = (capacidad = 'C4'));
alter table propuesta_ai add constraint propuesta_ai_ancla_concepto
  check ((concepto_id is not null) = (capacidad = 'C4'));

-- Y el ancla sigue siendo UNA. El check se sustituye entero porque `num_nonnulls` enumera, y
-- una columna que no esté en la lista no cuenta: sin esto, una propuesta de C4 tendría cero
-- anclas contadas y el check exigiría que otra estuviera puesta.
alter table propuesta_ai drop constraint propuesta_ai_un_ancla;
alter table propuesta_ai add constraint propuesta_ai_un_ancla
  check (num_nonnulls(item_id, reto_id, gate_id, journey_id, registry_id, concepto_id) = 1);

-- ── El destino: la revisión simulada ──
alter table propuesta_ai add column revision_simulada_id uuid;
alter table propuesta_ai add constraint propuesta_ai_revision_simulada_fk
  foreign key (revision_simulada_id, workspace_id) references revision_simulada (id, workspace_id);
create unique index propuesta_ai_revision_simulada_idx
  on propuesta_ai (workspace_id, revision_simulada_id) where revision_simulada_id is not null;

alter table propuesta_ai drop constraint propuesta_ai_destino_vocabulario;
alter table propuesta_ai add constraint propuesta_ai_destino_vocabulario
  check (destino in ('evidencia', 'criterio-exito', 'insight', 'entrada-kpi', 'oportunidad',
                     'revision-simulada'));

alter table propuesta_ai add constraint propuesta_ai_destino_c4
  check (capacidad <> 'C4' or destino = 'revision-simulada');

-- Y la regla «aceptada ⇔ hay objeto», con la columna nueva dentro del conteo. Se reescribe
-- entera por lo mismo que `propuesta_ai_un_ancla`: `num_nonnulls` enumera, y una propuesta de C4
-- aceptada habría contado CERO objetos materializados contra un `= 1`.
alter table propuesta_ai drop constraint propuesta_ai_objeto_materializado;
alter table propuesta_ai add constraint propuesta_ai_objeto_materializado
  check (case
    when estado not in ('aceptada', 'corregida')
      then num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id, oportunidad_id,
                        revision_simulada_id) = 0
    when destino = 'entrada-kpi'
      then num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id, oportunidad_id,
                        revision_simulada_id) <= 1
    else num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id, oportunidad_id,
                      revision_simulada_id) = 1
  end);

grant insert (concepto_id) on reserva_ai to designio_app;
grant insert (concepto_id) on llamada_ai to designio_app;
grant insert (concepto_id) on propuesta_ai to designio_app;
grant update (revision_simulada_id) on propuesta_ai to designio_app;

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
  if new.revision_simulada_id is not null and new.alcance_evidencia is not null then
    if exists (
      select 1
        from revision_simulada r
        join arquetipo_evidencia ae on ae.arquetipo_id = r.arquetipo_id
         and ae.workspace_id = r.workspace_id
       where r.id = new.revision_simulada_id and r.workspace_id = new.workspace_id
         and evidencia_usable(ae.evidencia_id, ae.workspace_id, 'cliente')
         and not (ae.evidencia_id = any (new.alcance_evidencia))) then
      raise exception 'ese arquetipo tiene evidencia que esta revisión no llegó a ver: se enlazó después de generarla, así que la propuesta quedó obsoleta y solo puede rechazarse. Vuelve a pedirla para que la tenga en cuenta';
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
