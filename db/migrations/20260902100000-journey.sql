-- SPEC-05 (ADR-0006) — El journey y el blueprint como GRAFO TIPADO: la fuente de verdad
-- es el modelo estructurado, no un lienzo. Mermaid y la vista de carriles son renders
-- derivados; editar el código exportado no cambia nada (criterio de aceptación 1).
--
-- Sin coordenadas: un nodo tiene tipo, etiqueta, fase y orden. Lo que en un canvas es
-- «dónde lo puse» aquí es «qué es y de qué depende» — que es lo único que se puede
-- consultar, validar y trazar después.

-- ── Journey: as-is o to-be de un servicio (RF-05.1) ──
-- El blueprint NO es otro objeto: es el mismo grafo visto por carriles (RF-05.4).
create table journey (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  servicio_id uuid not null,
  -- Opcionales: un as-is puede existir antes de que haya reto (SPEC-02), y un to-be
  -- siempre nace dentro de uno. El proyecto también se guarda (RF-05.1 lo permite): sin
  -- él, con dos proyectos bajo el mismo reto no se sabría de cuál cuelga el grafo, y el
  -- gate y la design version lo van a necesitar.
  reto_id uuid,
  proyecto_id uuid,
  tipo text not null check (tipo in ('as-is', 'to-be')),
  nombre text not null check (btrim(nombre) <> ''),
  descripcion text not null default '',
  -- SIN estado a propósito. RF-05.8 es explícito: al aprobar una design version se
  -- congela un SNAPSHOT del grafo (inmutable) y «el grafo de trabajo continúa editable
  -- para el ciclo siguiente». Cerrar el journey al congelar dejaría al equipo sin grafo
  -- vivo justo cuando empieza el ciclo que el snapshot habilita. Lo inmutable es el
  -- snapshot; el journey es el modelo que sigue.
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  foreign key (proyecto_id, workspace_id) references proyecto (id, workspace_id)
);
create index journey_servicio_idx on journey (workspace_id, servicio_id);
create index journey_proyecto_idx on journey (workspace_id, proyecto_id);

-- ── Catálogo del workspace: identidad estable de lo que se repite entre journeys ──
-- Un actor, un canal, un touchpoint o un sistema son LOS MISMOS en el as-is y en el
-- to-be, y en los journeys de otros servicios. Guardados como texto libre en cada nodo,
-- «qué pasos dependen del sistema X» se convierte en comparar cadenas, y renombrarlo
-- crea una identidad nueva. El catálogo les da un id; el nodo lo referencia.
--
-- Solo para los tipos que SON entidades del workspace. Un paso o una fricción existen
-- dentro de su journey y no se comparten: darles catálogo sería inventar identidad
-- donde no la hay.
-- El catálogo es DEL SERVICIO, no del workspace: dos servicios del mismo cliente pueden
-- tener un «Core» que no es el mismo Core, y una clave por workspace los fundiría —
-- arrastrando dependencias y renombres a través de una frontera que el modelo separa.
--
-- Sin 'arquetipo': el arquetipo YA es un objeto curado del reto, con su estado, su
-- evidencia y sus segmentos. Darle una identidad de catálogo paralela permitiría que el
-- grafo mostrara un arquetipo que el modelo curado refutó. El nodo apunta al de verdad.
create table catalogo_journey (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  servicio_id uuid not null,
  tipo text not null check (tipo in ('touchpoint', 'canal', 'actor', 'sistema')),
  nombre text not null check (btrim(nombre) <> ''),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  -- Clave que ARRASTRA el tipo, para que la FK del nodo lo verifique estructuralmente y
  -- no dependa solo del guard: un nodo 'sistema' no puede apuntar a un catálogo 'actor'
  -- ni con SQL crudo.
  unique (id, workspace_id, tipo),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id),
  -- Un nombre por tipo DENTRO del servicio: es lo que hace que el as-is y el to-be del
  -- mismo servicio hablen del mismo sistema.
  unique (workspace_id, servicio_id, tipo, nombre)
);

-- ── Nodos: la taxonomía mínima de §10 ──
-- El CHECK la fija: inventar un tipo nuevo exige migración, que es exactamente la
-- fricción que mantiene comparables los journeys entre retos y clientes.
create table journey_nodo (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  journey_id uuid not null,
  tipo text not null check (tipo in (
    'fase', 'paso', 'touchpoint', 'canal', 'actor', 'arquetipo', 'sistema',
    'accion-frontstage', 'accion-backstage', 'emocion', 'friccion', 'oportunidad', 'decision')),
  etiqueta text not null check (btrim(etiqueta) <> ''),
  detalle text not null default '',
  -- La fase agrupa pasos (RF-05.2: reordenar sin coordenadas). Autorreferencia dentro
  -- del mismo journey: la FK compuesta lo garantiza.
  fase_id uuid,
  orden integer not null default 0,
  -- Responsable del elemento: su ausencia es una señal de la validación (RF-05.6).
  responsable text not null default '',
  -- Identidad compartida entre journeys, obligatoria justo en los tipos que la tienen.
  catalogo_id uuid,
  -- El nodo de tipo 'arquetipo' apunta al arquetipo CURADO del reto (SPEC-04.11), no a
  -- una copia: su estado, su evidencia y sus segmentos se alcanzan desde el grafo, y un
  -- arquetipo refutado no puede seguir vivo en el journey como si nada.
  arquetipo_id uuid,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (journey_id, workspace_id) references journey (id, workspace_id),
  foreign key (fase_id, workspace_id) references journey_nodo (id, workspace_id),
  -- Una fase no cuelga de otra fase: el grafo tiene dos niveles, no un árbol libre.
  check (tipo <> 'fase' or fase_id is null),
  -- La FK lleva el TIPO dentro: es lo que impide que un nodo 'sistema' cuelgue de una
  -- entrada de catálogo 'actor'. Con `catalogo_id` nulo la FK no se evalúa (MATCH SIMPLE),
  -- así que los tipos sin catálogo pasan sin ruido.
  foreign key (catalogo_id, workspace_id, tipo) references catalogo_journey (id, workspace_id, tipo),
  foreign key (arquetipo_id, workspace_id) references arquetipo (id, workspace_id),
  -- Los cuatro tipos de entidad EXIGEN catálogo; el resto no lo admite. Sin el «solo
  -- estos», nada impediría colgar un paso de una entrada de catálogo y volver a tener
  -- dos identidades para la misma cosa.
  check (
    (tipo in ('touchpoint', 'canal', 'actor', 'sistema')) = (catalogo_id is not null)
  ),
  -- Y el arquetipo, exactamente igual pero contra su propia tabla.
  check ((tipo = 'arquetipo') = (arquetipo_id is not null))
);
create index journey_nodo_arquetipo_idx on journey_nodo (workspace_id, arquetipo_id);
create index journey_nodo_catalogo_idx on journey_nodo (workspace_id, catalogo_id);
create index journey_nodo_journey_idx on journey_nodo (workspace_id, journey_id, orden);

-- ── Aristas tipadas ──
-- El tipo de arista ES la semántica de la relación: sin él, «A → B» no se puede
-- consultar («qué sistemas soportan este paso» vs. «qué sigue después»).
create table journey_arista (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  journey_id uuid not null,
  origen_id uuid not null,
  destino_id uuid not null,
  -- Sin 'pertenece-a': la pertenencia a una fase YA la modela journey_nodo.fase_id, y
  -- dos representaciones del mismo hecho es la ambigüedad que el grafo tipado existe
  -- para evitar (¿cuál manda si discrepan?). 'dependencia' sí falta y el modelo la pide.
  tipo text not null check (tipo in (
    'transicion', 'dependencia', 'ocurre-en', 'participa', 'soporta', 'duele')),
  -- Condición de la bifurcación (RF-05.3): el render la muestra sobre la flecha.
  condicion text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (journey_id, origen_id, destino_id, tipo),
  foreign key (journey_id, workspace_id) references journey (id, workspace_id),
  foreign key (origen_id, workspace_id) references journey_nodo (id, workspace_id),
  foreign key (destino_id, workspace_id) references journey_nodo (id, workspace_id),
  -- Un nodo no se conecta consigo mismo: un ciclo de un paso no es un journey.
  check (origen_id <> destino_id)
);
create index journey_arista_journey_idx on journey_arista (workspace_id, journey_id);

-- ── Evidencia enlazada a un nodo (arista «evidencia-de», SYS-15) ──
-- Tabla propia y no arista genérica porque el otro extremo NO es un nodo del grafo:
-- es una evidencia del workspace, con su propia identidad y sus derechos.
create table journey_nodo_evidencia (
  nodo_id uuid not null,
  evidencia_id uuid not null,
  workspace_id uuid not null references workspace(id),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  primary key (nodo_id, evidencia_id),
  foreign key (nodo_id, workspace_id) references journey_nodo (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id)
);
create index journey_nodo_evidencia_ev_idx on journey_nodo_evidencia (workspace_id, evidencia_id);

-- ── Snapshot congelado (RF-05.8, SYS-05) ──
-- El grafo completo serializado en el momento de congelar. El journey de trabajo sigue
-- editable para el ciclo siguiente; el snapshot es lo que la design version aprobó.
-- SPEC-06 lo invocará al aprobar la DV; aquí queda el mecanismo y su inmutabilidad.
create table journey_snapshot (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  journey_id uuid not null,
  motivo text not null default '',
  grafo jsonb not null,
  congelado_por uuid not null references usuario(id),
  congelado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (journey_id, workspace_id) references journey (id, workspace_id)
);
create index journey_snapshot_journey_idx on journey_snapshot (workspace_id, journey_id);

-- ── RLS ──
-- Lectura: todo miembro (el journey es el lenguaje común con el cliente).
-- Escritura: curadores (lead/diseñador). El grafo de trabajo no se cierra (RF-05.8).
alter table catalogo_journey enable row level security;
alter table journey enable row level security;
alter table journey_nodo enable row level security;
alter table journey_arista enable row level security;
alter table journey_nodo_evidencia enable row level security;
alter table journey_snapshot enable row level security;

create policy catalogo_select on catalogo_journey
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy journey_select on journey
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy journey_nodo_select on journey_nodo
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy journey_arista_select on journey_arista
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy journey_nodo_evidencia_select on journey_nodo_evidencia
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy journey_snapshot_select on journey_snapshot
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- El catálogo lo pueblan los curadores al nombrar el elemento; renombrarlo cambia su
-- nombre EN TODAS PARTES, que es justamente el punto de tener identidad.
create policy catalogo_insert on catalogo_journey
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );
create policy catalogo_update on catalogo_journey
  for update
  using (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'))
  with check (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'));

create policy journey_insert on journey
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );

-- Nodos, aristas y enlaces de evidencia: los escriben los curadores, siempre. El grafo
-- de trabajo no se cierra nunca (RF-05.8); lo que queda fijo es cada snapshot.
create policy journey_nodo_insert on journey_nodo
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );
create policy journey_nodo_update on journey_nodo
  for update
  using (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'))
  with check (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'));
create policy journey_nodo_delete on journey_nodo
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

create policy journey_arista_insert on journey_arista
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );
-- Corregir el tipo o la condición de una relación es edición estructurada (RF-05.2),
-- no una operación destructiva: borrar y rehacer cambiaría su identidad y dejaría un
-- par borrado/alta en la auditoría para lo que fue una corrección de una palabra.
-- Los EXTREMOS no se editan: cambiarlos es otra relación, y para eso está el borrado.
create policy journey_arista_update on journey_arista
  for update
  using (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'))
  with check (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'));
create policy journey_arista_delete on journey_arista
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

create policy journey_nodo_evidencia_insert on journey_nodo_evidencia
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );
create policy journey_nodo_evidencia_delete on journey_nodo_evidencia
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

-- El snapshot lo escribe quien congela, y nadie lo toca después (sin update ni delete):
-- ESTA es la inmutabilidad de RF-05.8, y vive aquí y no en el journey.
create policy journey_snapshot_insert on journey_snapshot
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and congelado_por = app_user_id()
  );

-- ── Guards ──
-- El grafo NO cruza journeys: una arista solo une nodos del suyo. Las FKs compuestas
-- garantizan el workspace, no el journey — esto lo cierra.
create function journey_arista_mismo_journey_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if exists (select 1 from journey_nodo n
    where n.id in (new.origen_id, new.destino_id)
      and n.workspace_id = new.workspace_id
      and n.journey_id <> new.journey_id) then
    raise exception 'una arista solo une nodos del mismo journey';
  end if;
  return new;
end $$;
create trigger journey_arista_mismo_journey
  before insert on journey_arista
  for each row execute function journey_arista_mismo_journey_guard();
revoke execute on function journey_arista_mismo_journey_guard() from public;

-- ── El anclaje del journey tiene que ser coherente hacia arriba ──
-- Las FKs compuestas garantizan que el reto y el proyecto son del workspace, pero no que
-- el proyecto sea DEL reto: un journey anclado al reto R y al proyecto de S diría una cosa
-- por cada lado, y la conciliación de la design version (SPEC-06) elegiría mal.
create function journey_anclaje_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  -- El reto tiene que APLICAR a este servicio: anclado en él, o declarado como afectado.
  -- Sin esto, un journey del servicio B podía colgar del reto del servicio A y exponer
  -- bajo B los proyectos y arquetipos de A. El selector ya ofrece solo esos dos conjuntos,
  -- pero un filtro de cliente no es una garantía.
  if new.reto_id is not null and not exists (
    select 1 from reto r
    where r.id = new.reto_id and r.workspace_id = new.workspace_id
      and (r.servicio_ancla_id = new.servicio_id
           or exists (select 1 from reto_servicio_afectado rsa
             where rsa.reto_id = r.id and rsa.workspace_id = r.workspace_id
               and rsa.servicio_id = new.servicio_id))) then
    raise exception 'el reto no está anclado a este servicio ni declarado como que lo afecta';
  end if;
  if new.proyecto_id is not null and new.reto_id is null then
    raise exception 'un journey con proyecto tiene que estar anclado también a su reto';
  end if;
  if new.proyecto_id is not null and not exists (
    select 1 from proyecto p
    where p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      and p.reto_id = new.reto_id) then
    raise exception 'el proyecto pertenece a otro reto';
  end if;
  return new;
end $$;
create trigger journey_anclaje
  before insert or update on journey
  for each row execute function journey_anclaje_guard();
revoke execute on function journey_anclaje_guard() from public;

-- Lo mismo para la fase de un nodo: agrupar bajo una fase de OTRO journey rompería
-- todas las vistas sin que ninguna FK se queje.
create function journey_nodo_fase_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.fase_id is not null and not exists (select 1 from journey_nodo f
    where f.id = new.fase_id and f.workspace_id = new.workspace_id
      and f.journey_id = new.journey_id and f.tipo = 'fase') then
    raise exception 'la fase debe ser un nodo de tipo fase del mismo journey';
  end if;
  return new;
end $$;
create trigger journey_nodo_fase
  before insert or update on journey_nodo
  for each row execute function journey_nodo_fase_guard();
revoke execute on function journey_nodo_fase_guard() from public;

-- ── La identidad que cuelga de un nodo tiene que ser la de SU journey ──
-- Las FKs compuestas ya garantizan el workspace y el tipo del catálogo; lo que no pueden
-- expresar es el SERVICIO ni el RETO, porque cuelgan del journey y no del nodo. Sin esto,
-- un nodo del journey del servicio A podría apuntar al catálogo del servicio B —fundiendo
-- dos entidades distintas— o a un arquetipo de otro reto.
--
-- La comprobación de tipo se queda además aquí, duplicada a propósito: el guard corre
-- antes que la FK y da el mensaje bueno, y la FK sostiene la promesa aunque alguien
-- reescriba el guard.
create function journey_nodo_identidad_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  arq_nombre text;
  arq_estado text;
  cat_nombre text;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.catalogo_id is not null then
    select c.nombre into cat_nombre
    from catalogo_journey c
    join journey j on j.id = new.journey_id and j.workspace_id = new.workspace_id
    where c.id = new.catalogo_id and c.workspace_id = new.workspace_id
      and c.servicio_id = j.servicio_id and c.tipo = new.tipo;
    if cat_nombre is null then
      raise exception 'la entrada de catálogo es de otro servicio o de otro tipo';
    end if;
    -- La etiqueta la pone el CATÁLOGO, igual que el arquetipo pone la suya. Sin esto, un
    -- update directo puede dejar el nodo mostrando y congelando un nombre mientras las
    -- consultas por catálogo lo identifican por otro — que es precisamente la identidad
    -- partida que el catálogo viene a eliminar. Renombrar sigue siendo renombrar la
    -- entrada: el servicio actualiza el catálogo primero, así que para cuando el nodo
    -- pasa por aquí, `cat_nombre` ya es el nombre nuevo.
    new.etiqueta := cat_nombre;
  end if;
  if new.arquetipo_id is not null then
    select a.nombre, a.estado into arq_nombre, arq_estado
    from arquetipo a
    join journey j on j.id = new.journey_id and j.workspace_id = new.workspace_id
    where a.id = new.arquetipo_id and a.workspace_id = new.workspace_id
      and a.reto_id = j.reto_id;
    if arq_nombre is null then
      raise exception 'el arquetipo es de otro reto, o el journey no tiene reto al que anclarlo';
    end if;
    -- Un arquetipo REFUTADO no entra al grafo. El veredicto de SPEC-04.11 dice que ese
    -- perfil no describe a nadie: dibujarlo en el journey lo resucitaría como si el
    -- veredicto no se hubiera dado. Lo que ya estaba puesto se queda —el grafo es
    -- historia y borrarlo sería reescribirla— y la validación lo reporta.
    if arq_estado = 'refutado' and (tg_op = 'INSERT' or old.arquetipo_id is distinct from new.arquetipo_id) then
      raise exception 'el arquetipo está refutado: no puede entrar al journey';
    end if;
    -- La etiqueta se DERIVA del arquetipo, no se teclea. Si el curador pudiera escribirla
    -- libremente, el diagrama, el blueprint y los snapshots congelados mostrarían un
    -- nombre inventado para un arquetipo curado distinto — que es exactamente la
    -- identidad que referenciarlo en vez de copiarlo viene a garantizar.
    new.etiqueta := arq_nombre;
  end if;
  return new;
end $$;
create trigger journey_nodo_identidad
  before insert or update on journey_nodo
  for each row execute function journey_nodo_identidad_guard();
revoke execute on function journey_nodo_identidad_guard() from public;

-- ── Los extremos de una arista tienen que encajar con su tipo ──
-- El CHECK del tipo solo valida la cadena. Sin esto se puede guardar una 'transicion'
-- de un sistema a un actor o un 'soporta' entre dos emociones: relaciones que los
-- renders y la validación tratan como buenas, o se comen en silencio. El tipo de arista
-- ES la semántica, así que la semántica se impone.
create function journey_arista_extremos_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t_origen text;
  t_destino text;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  select tipo into t_origen from journey_nodo
    where id = new.origen_id and workspace_id = new.workspace_id;
  select tipo into t_destino from journey_nodo
    where id = new.destino_id and workspace_id = new.workspace_id;
  if t_origen is null or t_destino is null then
    return new;  -- lo dirá la FK compuesta, con su propio error
  end if;

  -- Una fase no participa en ninguna arista: agrupa por fase_id y nada más.
  if t_origen = 'fase' or t_destino = 'fase' then
    raise exception 'una fase agrupa por fase_id, no por aristas';
  end if;

  case new.tipo
    -- Secuencia: solo entre lo que ocurre en el tiempo (un paso o una bifurcación).
    when 'transicion' then
      if t_origen not in ('paso', 'decision') or t_destino not in ('paso', 'decision') then
        raise exception 'una transición va entre pasos o decisiones, no de % a %', t_origen, t_destino;
      end if;
    -- Algo que otro necesita para poder ocurrir. Incluye la oportunidad, que depende
    -- del paso o de la fricción que viene a resolver: sin esta pareja el tipo
    -- 'oportunidad' no podría conectarse a nada y su carril del blueprint sería
    -- estructuralmente imposible de llenar.
    when 'dependencia' then
      if t_origen not in ('paso', 'accion-frontstage', 'accion-backstage', 'sistema', 'oportunidad')
        or t_destino not in ('paso', 'accion-frontstage', 'accion-backstage', 'sistema', 'friccion') then
        raise exception 'una dependencia va entre pasos, acciones, sistemas u oportunidades, no de % a %', t_origen, t_destino;
      end if;
    -- Dónde ocurre: el canal o el touchpoint es el destino.
    when 'ocurre-en' then
      if t_origen not in ('paso', 'accion-frontstage') or t_destino not in ('canal', 'touchpoint') then
        raise exception 'ocurre-en va de un paso o acción visible a un canal o touchpoint, no de % a %', t_origen, t_destino;
      end if;
    -- Quién participa: el actor o arquetipo es el origen.
    when 'participa' then
      if t_origen not in ('actor', 'arquetipo')
        or t_destino not in ('paso', 'accion-frontstage', 'accion-backstage') then
        raise exception 'participa va de un actor o arquetipo a un paso o acción, no de % a %', t_origen, t_destino;
      end if;
    -- Qué lo sostiene por detrás: el soporte es el origen.
    when 'soporta' then
      if t_origen not in ('sistema', 'accion-backstage')
        or t_destino not in ('paso', 'accion-frontstage', 'accion-backstage') then
        raise exception 'soporta va de un sistema o acción backstage a lo que sostiene, no de % a %', t_origen, t_destino;
      end if;
    -- Dónde duele: la fricción o la emoción es el origen.
    when 'duele' then
      if t_origen not in ('friccion', 'emocion')
        or t_destino not in ('paso', 'accion-frontstage', 'touchpoint', 'canal') then
        raise exception 'duele va de una fricción o emoción a donde se siente, no de % a %', t_origen, t_destino;
      end if;
    else
      null;
  end case;
  return new;
end $$;
create trigger journey_arista_extremos
  before insert or update on journey_arista
  for each row execute function journey_arista_extremos_guard();
revoke execute on function journey_arista_extremos_guard() from public;

-- ── Auditoría de TODA mutación del grafo ──
-- El journey es sistema de registro: si solo se auditaran el alta y el congelado, el
-- historial no podría decir quién movió un paso o quién le quitó la evidencia que lo
-- sostenía. Va en triggers y no en el servicio para que el SQL directo también lo emita.
create function journey_grafo_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  fila jsonb;
  previa jsonb;
  ws uuid;
  jid uuid;
  cuerpo jsonb;
  evento text;
begin
  -- Se trabaja sobre jsonb y no sobre el record: las tres tablas tienen columnas
  -- distintas, y plpgsql resuelve TODAS las referencias de campo de una expresión aunque
  -- la rama no se ejecute (`fila.origen_id` reventaría al auditar un nodo).
  fila := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  -- En un UPDATE, la fila vieja también: el evento tiene que decir QUÉ cambió, no solo
  -- que algo cambió. Como el update pisa la fila, un historial append-only que solo
  -- guarde el estado posterior no puede reconstruir la corrección — y auditar una
  -- corrección sin poder leerla es no auditarla.
  previa := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  ws := (fila->>'workspace_id')::uuid;

  if tg_table_name = 'journey_nodo_evidencia' then
    select n.journey_id into jid from journey_nodo n
      where n.id = (fila->>'nodo_id')::uuid and n.workspace_id = ws;
    cuerpo := jsonb_build_object('nodoId', fila->'nodo_id', 'evidenciaId', fila->'evidencia_id');
    evento := case tg_op when 'INSERT' then 'JourneyEvidenciaEnlazada'
                         else 'JourneyEvidenciaDesenlazada' end;
  elsif tg_table_name = 'journey_nodo' then
    jid := (fila->>'journey_id')::uuid;
    cuerpo := jsonb_build_object(
      'nodoId', fila->'id', 'tipo', fila->'tipo', 'etiqueta', fila->'etiqueta',
      'detalle', fila->'detalle', 'responsable', fila->'responsable',
      'faseId', fila->'fase_id', 'orden', fila->'orden');
    if previa is not null then
      cuerpo := cuerpo || jsonb_build_object('antes', jsonb_build_object(
        'etiqueta', previa->'etiqueta', 'detalle', previa->'detalle',
        'faseId', previa->'fase_id', 'orden', previa->'orden',
        'responsable', previa->'responsable'));
    end if;
    evento := case tg_op when 'INSERT' then 'JourneyNodoAgregado'
                         when 'UPDATE' then 'JourneyNodoEditado'
                         else 'JourneyNodoBorrado' end;
  else
    jid := (fila->>'journey_id')::uuid;
    cuerpo := jsonb_build_object(
      'aristaId', fila->'id', 'tipo', fila->'tipo', 'condicion', fila->'condicion',
      'origenId', fila->'origen_id', 'destinoId', fila->'destino_id');
    if previa is not null then
      cuerpo := cuerpo || jsonb_build_object('antes', jsonb_build_object(
        'tipo', previa->'tipo', 'condicion', previa->'condicion'));
    end if;
    evento := case tg_op when 'INSERT' then 'JourneyAristaAgregada'
                         when 'UPDATE' then 'JourneyAristaEditada'
                         else 'JourneyAristaBorrada' end;
  end if;

  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (ws, evento, cuerpo || jsonb_build_object('journeyId', jid),
      app_user_id(), workspace_role(app_user_id(), ws));
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger journey_nodo_auditoria
  after insert or update or delete on journey_nodo
  for each row execute function journey_grafo_auditoria();
create trigger journey_arista_auditoria
  after insert or update or delete on journey_arista
  for each row execute function journey_grafo_auditoria();
create trigger journey_nodo_evidencia_auditoria
  after insert or delete on journey_nodo_evidencia
  for each row execute function journey_grafo_auditoria();
revoke execute on function journey_grafo_auditoria() from public;

-- ── Grants mínimos ──
grant select, insert on catalogo_journey to designio_app;
grant update (nombre) on catalogo_journey to designio_app;
grant select, insert on journey, journey_nodo, journey_arista to designio_app;
grant select, insert on journey_nodo_evidencia, journey_snapshot to designio_app;
-- Editar un nodo es corregir su contenido y su lugar; jamás cambiarlo de journey ni de
-- tipo (eso sería otro nodo, y las aristas que lo citan quedarían mintiendo).
grant update (etiqueta, detalle, fase_id, orden, responsable) on journey_nodo to designio_app;
-- journey sin UPDATE: no tiene estado que mover y su contenido es su identidad.
-- El grafo se corrige borrando y rehaciendo; el snapshot conserva lo que hubo.
-- Solo el tipo y la condición: los extremos y el journey son la identidad de la arista.
grant update (tipo, condicion) on journey_arista to designio_app;
grant delete on journey_nodo, journey_arista, journey_nodo_evidencia to designio_app;
