-- CTX-01 Identidad — auth nativa (bcrypt + JWT): usuarios globales con credenciales propias.
-- La identidad RLS pasa de miembro.id a usuario.id: app.user_id ahora referencia usuario(id)
-- y la membresía se resuelve por miembro.usuario_id. SYS-01/02 quedan intactos: las políticas
-- siguen resolviendo por is_workspace_member, solo cambia qué significa "usuario".

create table usuario (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  nombre text not null,
  password_hash text,
  estado text not null default 'invitado' check (estado in ('invitado', 'activo', 'inactivo')),
  invitacion_token_hash text,
  invitacion_expira timestamptz,
  -- El workspace cuya invitación EMITIÓ el token vigente: solo ese workspace puede
  -- re-emitirlo. Evita que otro tenant obtenga un enlace que reclama esta cuenta
  -- (takeover cross-tenant) o pise el enlace pendiente del emisor original.
  invitacion_origen_ws uuid references workspace(id),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- Email único sin distinguir mayúsculas (login y dedupe de invitaciones).
create unique index usuario_email_unico on usuario (lower(email));
create index usuario_invitacion_idx on usuario (invitacion_token_hash) where invitacion_token_hash is not null;

-- Vincular membresías a usuarios. El backfill cubre bases de desarrollo ya sembradas
-- (en una base fresca miembro está vacío y es un no-op); las cuentas quedan 'invitado'
-- sin password: nadie puede iniciar sesión con ellas hasta activarlas.
alter table miembro add column usuario_id uuid references usuario(id);

insert into usuario (email, nombre, estado)
select distinct on (lower(email)) email, nombre, 'invitado'
from miembro
order by lower(email), creado_en;

update miembro m set usuario_id = u.id
from usuario u
where m.usuario_id is null and lower(u.email) = lower(m.email);

-- La identidad de actor en la auditoría también pasa a usuario.id: se remapean los
-- eventos históricos que registraron miembro.id (bases pre-auth) para que actor_id
-- tenga una sola semántica. Debe correr ANTES del dedupe de abajo: un evento puede
-- referenciar justo la membresía duplicada que se descarta, y este es el último
-- momento en que ese mapeo miembro→usuario existe completo. En una base fresca, no-op.
update evento_dominio e set actor_id = m.usuario_id
from miembro m
where e.actor_id = m.id;

-- El constraint viejo (workspace_id, email) era case-sensitive: 'Alice@' y 'alice@'
-- podían coexistir como miembros y el backfill los mapea al MISMO usuario global.
-- Dedupe conservando primero EL ROL MÁS PRIVILEGIADO (lead-boutique > admin-cliente >
-- resto): quedarse ciegamente con la más antigua podía descartar la única membresía
-- capaz de invitar y dejar el workspace sin administración. Empate de privilegio →
-- la más antigua, con desempate estable. En una base fresca es un no-op.
delete from miembro m
using miembro m2
where m.workspace_id = m2.workspace_id
  and m.usuario_id = m2.usuario_id
  and m.id <> m2.id
  and (
    (case m.rol when 'lead-boutique' then 0 when 'admin-cliente' then 1 else 2 end)
      > (case m2.rol when 'lead-boutique' then 0 when 'admin-cliente' then 1 else 2 end)
    or (
      (case m.rol when 'lead-boutique' then 0 when 'admin-cliente' then 1 else 2 end)
        = (case m2.rol when 'lead-boutique' then 0 when 'admin-cliente' then 1 else 2 end)
      and (m.creado_en > m2.creado_en or (m.creado_en = m2.creado_en and m.id::text > m2.id::text))
    )
  );

alter table miembro alter column usuario_id set not null;
alter table miembro add constraint miembro_usuario_unico unique (workspace_id, usuario_id);

-- ── Recableado de helpers: app.user_id ahora es usuario.id ──
-- (create or replace conserva dueño y grants de la migración anterior)

create or replace function is_workspace_member(p_user uuid, p_ws uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from miembro m where m.usuario_id = p_user and m.workspace_id = p_ws) $$;

create or replace function workspace_role(p_user uuid, p_ws uuid) returns text
language sql stable security definer set search_path = public as
$$ select m.rol from miembro m where m.usuario_id = p_user and m.workspace_id = p_ws $$;

-- ── RLS de usuario: cada quien ve solo su propia fila ──
-- Todo lo demás (login, invitación, activación) pasa por funciones SECURITY DEFINER.

alter table usuario enable row level security;

create policy usuario_select_propio on usuario
  for select using (id = app_user_id());

-- ── Funciones del flujo de auth (el rol de app no escribe usuario directamente) ──

-- Login: resuelve credenciales por email SIN contexto de usuario (paso previo a la sesión).
-- El hash sale hacia el server, que compara con bcrypt; jamás viaja al cliente.
create or replace function usuario_para_login(p_email text)
returns table (id uuid, email text, nombre text, password_hash text, estado text)
language sql stable security definer set search_path = public as
$$
  select u.id, u.email, u.nombre, u.password_hash, u.estado
  from usuario u
  where lower(u.email) = lower(p_email)
$$;

-- Invitación: crea el usuario si no existe (emitiendo token con este workspace como
-- origen); si existe sin activar, SOLO el workspace de origen puede re-emitir el token
-- (token_emitido dice si esta llamada emitió uno). Un workspace distinto agrega su
-- membresía sin recibir ni pisar el token: evita el takeover cross-tenant de cuentas
-- pendientes y que una segunda invitación invalide el enlace de la primera.
-- La fila se lee FOR UPDATE: sin el lock, una activación concurrente entre la lectura
-- y el UPDATE dejaba token y origen restaurados sobre una cuenta ya activa (enlace
-- que activar_usuario_con_token jamás consume), y dos adopciones simultáneas de un
-- origen NULL podían emitir dos enlaces pisándose entre sí. Con el lock, la condición
-- de cada rama se evalúa sobre el estado definitivo de la fila.
-- Devuelve además el estado de la cuenta: el servicio corta la invitación si está
-- desactivada (autenticar la rechazaría y no existe flujo de reactivación).
-- Autoriza por sí misma (actor con rol que invita en p_workspace) además de la política
-- de INSERT de miembro que aplica en la misma transacción.
create or replace function preparar_invitacion(
  p_email text, p_nombre text, p_token_hash text, p_expira timestamptz, p_workspace uuid
) returns table (usuario_id uuid, requiere_activacion boolean, token_emitido boolean, estado text)
language plpgsql security definer set search_path = public as
$$
declare
  v_id uuid;
  v_estado text;
  v_origen uuid;
  v_emitido boolean := false;
begin
  if coalesce(workspace_role(app_user_id(), p_workspace), '') not in ('lead-boutique', 'admin-cliente') then
    raise exception 'sin permiso para invitar en este workspace'
      using errcode = 'insufficient_privilege';
  end if;

  select u.id, u.estado, u.invitacion_origen_ws
    into v_id, v_estado, v_origen
  from usuario u where lower(u.email) = lower(p_email)
  for update;

  if v_id is null then
    insert into usuario (email, nombre, estado, invitacion_token_hash, invitacion_expira, invitacion_origen_ws)
    values (p_email, p_nombre, 'invitado', p_token_hash, p_expira, p_workspace)
    returning id into v_id;
    v_estado := 'invitado';
    v_emitido := true;
  elsif v_estado = 'invitado' and (v_origen = p_workspace or v_origen is null) then
    -- Origen NULL = cuenta creada por el backfill de esta migración (pre-auth), sin
    -- invitación viva. El primer workspace que la invite ADOPTA el origen — el mismo
    -- modelo de confianza que una cuenta nueva; a partir de ahí, solo él re-emite.
    update usuario u
    set invitacion_token_hash = p_token_hash, invitacion_expira = p_expira,
        invitacion_origen_ws = p_workspace, actualizado_en = now()
    where u.id = v_id;
    v_emitido := true;
  end if;

  return query select v_id, (v_estado = 'invitado'), v_emitido, v_estado;
end
$$;

-- Activación: consume un token vigente y fija la password (el hash llega ya calculado).
create or replace function activar_usuario_con_token(p_token_hash text, p_password_hash text)
returns table (id uuid, email text, nombre text)
language sql security definer set search_path = public as
$$
  update usuario u
  set password_hash = p_password_hash,
      estado = 'activo',
      invitacion_token_hash = null,
      invitacion_expira = null,
      invitacion_origen_ws = null,
      actualizado_en = now()
  where u.invitacion_token_hash = p_token_hash
    and u.estado = 'invitado'
    and u.invitacion_expira is not null
    and u.invitacion_expira > now()
  returning u.id, u.email, u.nombre
$$;

-- Estado de cuenta de los miembros del workspace (pantalla Personas, RF-01.4): la RLS
-- de usuario solo muestra la fila PROPIA (correcto: ahí viven hashes y tokens), así que
-- esta función expone SOLO el estado, y únicamente a miembros del workspace consultado.
create or replace function estados_de_miembros(p_workspace uuid)
returns table (usuario_id uuid, estado text)
language sql stable security definer set search_path = public as
$$
  select u.id, u.estado
  from miembro m
  join usuario u on u.id = m.usuario_id
  where m.workspace_id = p_workspace
    and is_workspace_member(app_user_id(), p_workspace)
$$;

-- ── Membresía: la gestionan lead-boutique y admin-cliente desde la app (RF-01.2/01.4) ──
-- agente-ai queda fuera del alta por invitación: es un actor de plataforma, no invitable.

create policy miembro_insert on miembro
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'admin-cliente')
    and rol <> 'agente-ai'
  );

-- ── Permisos mínimos del rol de aplicación ──

grant select on usuario to designio_app;
grant insert on miembro to designio_app;

revoke execute on function
  usuario_para_login(text),
  preparar_invitacion(text, text, text, timestamptz, uuid),
  activar_usuario_con_token(text, text),
  estados_de_miembros(uuid)
from public;

grant execute on function
  usuario_para_login(text),
  preparar_invitacion(text, text, text, timestamptz, uuid),
  activar_usuario_con_token(text, text),
  estados_de_miembros(uuid)
to designio_app;
