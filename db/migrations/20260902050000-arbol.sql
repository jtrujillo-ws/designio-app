-- SPEC-02 / ADR-0003 — agregados del árbol: servicio (CTX-04), reto y proyecto (CTX-03).
-- El árbol Cliente → Servicios → Retos → Proyectos es PROYECCIÓN DE LECTURA (RF-02.2):
-- aquí viven los agregados; el grafo genérico nodo/arista llega con los journeys (SPEC-05).
-- La relación n:m «reto afecta servicios» se materializa a nivel de agregado con los
-- metadatos de arista de RF-02.5 (autor, fecha, lineage de propuesta AI).
--
-- Integridad multi-tenant en el esquema: las referencias del árbol usan FOREIGN KEYs
-- COMPUESTAS (id, workspace_id) para que ni siquiera código administrativo con un bug
-- pueda colgar un reto de un servicio de otro workspace.

create table servicio (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  nombre text not null,
  descripcion text not null default '',
  estado text not null default 'activo' check (estado in ('activo', 'archivado')),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id)
);
create index servicio_ws_idx on servicio (workspace_id);

-- Reto: promesa medible de cambio (CTX-03) con servicio ANCLA (RF-02.3: ubicación en el
-- árbol, no restricción estructural) y estado de backlog con origen (RF-02.8).
-- Los criterios de éxito completos y su congelamiento en G0 llegan con SPEC-04;
-- metrica_objetivo es el resumen presentable (el Metric Registry real llega con SPEC-07).
create table reto (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  servicio_ancla_id uuid not null,
  codigo text not null,
  titulo text not null,
  descripcion text not null default '',
  estado text not null default 'candidato' check (estado in ('candidato', 'activo', 'cerrado')),
  origen text check (origen in ('post-mortem', 'hallazgo-medicion', 'peticion-cliente')),
  metrica_objetivo text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (workspace_id, codigo),
  unique (id, workspace_id),
  foreign key (servicio_ancla_id, workspace_id) references servicio (id, workspace_id)
);
create index reto_ancla_idx on reto (servicio_ancla_id);

create table proyecto (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid not null,
  codigo text not null,
  titulo text not null,
  estado text not null default 'activo' check (estado in ('activo', 'pausado', 'cerrado')),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (workspace_id, codigo),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id)
);
create index proyecto_reto_idx on proyecto (reto_id);

-- Arista «afecta» reto→servicio a nivel de agregado. El servicio ANCLA no se duplica
-- aquí (criterio de aceptación 1 de SPEC-02: ninguna relación se duplica).
create table reto_servicio_afectado (
  reto_id uuid not null,
  servicio_id uuid not null,
  workspace_id uuid not null references workspace(id),
  propuesta_ai_id uuid,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  primary key (reto_id, servicio_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id)
);
-- La proyección lee por servicio (¿qué retos afectan a este servicio?): el PK no lo cubre.
create index reto_servicio_afectado_servicio_idx on reto_servicio_afectado (workspace_id, servicio_id);

-- ── RLS: por ahora SOLO LECTURA para el rol de aplicación ──
-- Las escrituras del árbol llegan con sus server functions (backlog de retos, gates)
-- y sus políticas de rol; hasta entonces, sin grant de escritura no hay superficie.

alter table servicio enable row level security;
alter table reto enable row level security;
alter table proyecto enable row level security;
alter table reto_servicio_afectado enable row level security;

create policy servicio_select on servicio
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy reto_select on reto
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy proyecto_select on proyecto
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy reto_servicio_select on reto_servicio_afectado
  for select using (is_workspace_member(app_user_id(), workspace_id));

grant select on servicio, reto, proyecto, reto_servicio_afectado to designio_app;
