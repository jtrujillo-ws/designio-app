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
  -- Opcional: un as-is puede existir antes de que haya reto (SPEC-02), y un to-be
  -- siempre nace dentro de uno.
  reto_id uuid,
  tipo text not null check (tipo in ('as-is', 'to-be')),
  nombre text not null check (btrim(nombre) <> ''),
  descripcion text not null default '',
  estado text not null check (estado in ('borrador', 'congelado')) default 'borrador',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id)
);
create index journey_servicio_idx on journey (workspace_id, servicio_id);

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
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (journey_id, workspace_id) references journey (id, workspace_id),
  foreign key (fase_id, workspace_id) references journey_nodo (id, workspace_id),
  -- Una fase no cuelga de otra fase: el grafo tiene dos niveles, no un árbol libre.
  check (tipo <> 'fase' or fase_id is null)
);
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
  tipo text not null check (tipo in (
    'transicion', 'pertenece-a', 'ocurre-en', 'participa', 'soporta', 'duele')),
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
-- Escritura: curadores (lead/diseñador) y SOLO mientras el journey esté en borrador.
alter table journey enable row level security;
alter table journey_nodo enable row level security;
alter table journey_arista enable row level security;
alter table journey_nodo_evidencia enable row level security;
alter table journey_snapshot enable row level security;

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

create policy journey_insert on journey
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'borrador'
  );
-- Congelar es la única transición: borrador → congelado, y no vuelve.
create policy journey_congelar on journey
  for update
  using (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (estado = 'congelado');

-- Nodos y aristas: alta y edición solo con el journey en borrador. Un journey
-- congelado es el registro de lo que se aprobó; editarlo sería reescribir la historia
-- (el ciclo siguiente trabaja sobre el journey de trabajo, no sobre el snapshot).
create policy journey_nodo_insert on journey_nodo
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from journey j
      where j.id = journey_nodo.journey_id and j.workspace_id = journey_nodo.workspace_id
        and j.estado = 'borrador')
  );
create policy journey_nodo_update on journey_nodo
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from journey j
      where j.id = journey_nodo.journey_id and j.workspace_id = journey_nodo.workspace_id
        and j.estado = 'borrador')
  )
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );
create policy journey_nodo_delete on journey_nodo
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from journey j
      where j.id = journey_nodo.journey_id and j.workspace_id = journey_nodo.workspace_id
        and j.estado = 'borrador')
  );

create policy journey_arista_insert on journey_arista
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from journey j
      where j.id = journey_arista.journey_id and j.workspace_id = journey_arista.workspace_id
        and j.estado = 'borrador')
  );
create policy journey_arista_delete on journey_arista
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from journey j
      where j.id = journey_arista.journey_id and j.workspace_id = journey_arista.workspace_id
        and j.estado = 'borrador')
  );

create policy journey_nodo_evidencia_insert on journey_nodo_evidencia
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from journey j
      join journey_nodo n on n.journey_id = j.id and n.workspace_id = j.workspace_id
      where n.id = journey_nodo_evidencia.nodo_id
        and j.workspace_id = journey_nodo_evidencia.workspace_id
        and j.estado = 'borrador')
  );
create policy journey_nodo_evidencia_delete on journey_nodo_evidencia
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from journey j
      join journey_nodo n on n.journey_id = j.id and n.workspace_id = j.workspace_id
      where n.id = journey_nodo_evidencia.nodo_id
        and j.workspace_id = journey_nodo_evidencia.workspace_id
        and j.estado = 'borrador')
  );

-- El snapshot lo escribe quien congela, y nadie lo toca después (sin update ni delete).
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

-- ── Grants mínimos ──
grant select, insert on journey, journey_nodo, journey_arista to designio_app;
grant select, insert on journey_nodo_evidencia, journey_snapshot to designio_app;
-- Editar un nodo es corregir su contenido y su lugar; jamás cambiarlo de journey ni de
-- tipo (eso sería otro nodo, y las aristas que lo citan quedarían mintiendo).
grant update (etiqueta, detalle, fase_id, orden, responsable) on journey_nodo to designio_app;
grant update (estado) on journey to designio_app;
-- El grafo se corrige borrando y rehaciendo mientras está en borrador.
grant delete on journey_nodo, journey_arista, journey_nodo_evidencia to designio_app;
