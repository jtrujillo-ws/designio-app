-- CTX-01 Workspace e Identidad — primer esquema del dominio con RLS ACTIVO desde el día 1.
-- Decisión (diseño técnico · Multi-tenancy): el rol de aplicación es no privilegiado; toda
-- tabla de datos de cliente lleva políticas RLS por membresía; una query sin contexto
-- devuelve cero filas por construcción (SYS-01/02).

create table workspace (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  creado_en timestamptz not null default now()
);

create table miembro (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  nombre text not null,
  email text not null,
  rol text not null check (rol in ('sponsor','stakeholder','admin-cliente','lead-boutique','disenador','agente-ai')),
  creado_en timestamptz not null default now(),
  unique (workspace_id, email)
);

create table segmento (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  nombre text not null,
  definicion text not null default '',
  creado_en timestamptz not null default now()
);

-- Auditoría append-only y fuente de proyecciones (RF-01.6). Sin UPDATE/DELETE para la app.
create table evento_dominio (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  tipo text not null,
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid,
  actor_rol text,
  creado_en timestamptz not null default now()
);

create index evento_dominio_ws_idx on evento_dominio (workspace_id, creado_en);

-- ── Helpers SECURITY DEFINER (dueño: rol administrativo; los usan las políticas) ──

create or replace function app_user_id() returns uuid
language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function is_workspace_member(p_user uuid, p_ws uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from miembro m where m.id = p_user and m.workspace_id = p_ws) $$;

create or replace function workspace_role(p_user uuid, p_ws uuid) returns text
language sql stable security definer set search_path = public as
$$ select m.rol from miembro m where m.id = p_user and m.workspace_id = p_ws $$;

-- ── RLS activo ──

alter table workspace enable row level security;
alter table miembro enable row level security;
alter table segmento enable row level security;
alter table evento_dominio enable row level security;

create policy workspace_select on workspace
  for select using (is_workspace_member(app_user_id(), id));

create policy miembro_select on miembro
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy segmento_todo on segmento
  for all
  using (is_workspace_member(app_user_id(), workspace_id))
  with check (is_workspace_member(app_user_id(), workspace_id));

create policy evento_select on evento_dominio
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy evento_insert on evento_dominio
  for insert with check (is_workspace_member(app_user_id(), workspace_id));
-- Deliberadamente SIN políticas de update/delete en evento_dominio: append-only.

-- ── Permisos del rol de aplicación (mínimos; DELETE solo donde el dominio lo permite) ──

grant usage on schema public to designio_app;
grant select on workspace, miembro to designio_app;
grant select, insert, update, delete on segmento to designio_app;
grant select, insert on evento_dominio to designio_app;
grant execute on function app_user_id(), is_workspace_member(uuid, uuid), workspace_role(uuid, uuid) to designio_app;
