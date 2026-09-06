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
