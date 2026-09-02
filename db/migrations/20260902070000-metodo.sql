-- SPEC-04 — Método como código (CTX-03, ADR-0005): criterios de éxito con ventana,
-- activación de reto → proyecto con perfil, etapas 0-7 CANÓNICAS y gates G0-G7 con
-- checklist de suficiencia y aprobación humana por rol (§13.2). Este slice deja fuera
-- (con sus specs): reaperturas (RF-04.9), arquetipos (RF-04.11), registro de decisiones
-- (RF-04.10) y el asistente de gate AI (RF-04.8, depende de SPEC-08).
--
-- Mismo patrón multi-tenant: FKs compuestas (id, workspace_id), RLS día 1, escrituras
-- atribuidas en la política y transiciones exigidas por WITH CHECK.

-- ── Estados completos de reto y proyecto (RF-04.12) ──
alter table reto drop constraint reto_estado_check;
alter table reto add constraint reto_estado_check
  check (estado in ('candidato', 'activo', 'en-medicion', 'cerrado', 'archivado'));

alter table proyecto drop constraint proyecto_estado_check;
alter table proyecto add constraint proyecto_estado_check
  check (estado in ('activo', 'pausado', 'en-implementacion', 'en-medicion', 'cerrado'));

-- El perfil gradúa actividades y umbrales de los checklists, JAMÁS el vocabulario ni
-- los resultados canónicos (RF-04.3, I1/SYS-09).
alter table proyecto add column perfil text not null default 'estandar'
  check (perfil in ('rapido', 'estandar', 'profundo'));

-- Las instancias del método referencian proyecto por FK compuesta (anti cross-tenant),
-- que exige esta unique — el árbol la dio a servicio y reto, no a proyecto.
alter table proyecto add constraint proyecto_id_ws_unico unique (id, workspace_id);

-- ── Criterios de éxito del reto (RF-04.2) ──
-- La tabla acepta criterios INCOMPLETOS (se definen iterando); la completitud la exige
-- G0 en su aprobación (SYS-22): ventana presente y línea base registrada o con plan.
-- linea_base_fecha y fecha_post_mortem son fechas CALENDÁRICAS (date, sin huso).
create table criterio_exito (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid not null,
  kpi text not null,
  definicion text not null default '',
  linea_base_valor text,
  linea_base_fecha date,
  linea_base_plan text not null default '',
  objetivo text not null default '',
  ventana_dias integer check (ventana_dias is null or ventana_dias > 0),
  fecha_post_mortem date,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id)
);
create index criterio_exito_reto_idx on criterio_exito (workspace_id, reto_id);

-- ── Etapas 0-7: existen SIEMPRE con su nombre canónico (RF-04.4, I1) ──
-- El CHECK ata nombre a número: ni el rol admin con un bug puede renombrar el método.
-- El estado de etapa es INFORMATIVO; el estado que gobierna es el de los gates.
create table etapa_instancia (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  proyecto_id uuid not null,
  numero integer not null check (numero between 0 and 7),
  nombre text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'en-curso', 'completada')),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (proyecto_id, numero),
  foreign key (proyecto_id, workspace_id) references proyecto (id, workspace_id),
  check (nombre = case numero
    when 0 then 'Definición del objeto y del reto'
    when 1 then 'Investigación'
    when 2 then 'Análisis y entendimiento'
    when 3 then 'Conceptualización'
    when 4 then 'Exploración de soluciones'
    when 5 then 'Detalle de solución'
    when 6 then 'Plan de implementación'
    when 7 then 'Seguimiento de implementación'
  end)
);

-- ── Gates G0-G7 (RF-04.5/04.7) ──
-- El rol aprobador es CANÓNICO por gate (§13.2): G0/G3/G5/G6 sponsor, resto lead.
-- Un gate aprobado es inmutable (la política de UPDATE solo alcanza pendientes).
create table gate_instancia (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  proyecto_id uuid not null,
  numero integer not null check (numero between 0 and 7),
  rol_aprobador text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aprobado')),
  aprobado_por uuid references usuario(id),
  aprobado_en timestamptz,
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (proyecto_id, numero),
  foreign key (proyecto_id, workspace_id) references proyecto (id, workspace_id),
  check (rol_aprobador = case when numero in (0, 3, 5, 6) then 'sponsor' else 'lead-boutique' end),
  check (estado = 'pendiente' or (aprobado_por is not null and aprobado_en is not null))
);

-- ── Checklist de suficiencia (RF-04.5/04.6) ──
-- Tres estados, sin cuarto: cumplido (con objeto REAL enlazado — en el MVP el objeto
-- citable es la evidencia de SPEC-03; insights/decisiones llegan con sus specs),
-- pendiente, o N/A (justificación + aprobación del rol aprobador del gate).
create table checklist_item (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  gate_id uuid not null,
  orden integer not null,
  texto text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'cumplido', 'na')),
  evidencia_id uuid,
  na_justificacion text not null default '',
  na_aprobado_por uuid references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (gate_id, orden),
  foreign key (gate_id, workspace_id) references gate_instancia (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id),
  check (estado <> 'cumplido' or evidencia_id is not null),
  check (estado <> 'na' or (na_justificacion <> '' and na_aprobado_por is not null)),
  check (estado <> 'pendiente' or (evidencia_id is null and na_aprobado_por is null))
);
create index checklist_item_gate_idx on checklist_item (workspace_id, gate_id);

-- ── RLS ──
-- Lectura: miembros. Escrituras del método:
--  · reto INSERT — curadores (lead/diseñador) proponen candidatos (RF-04.1), atribuidos.
--  · reto/proyecto UPDATE de estado — solo lead-boutique (opera el método, §13.2);
--    un reto jamás vuelve a 'candidato'.
--  · etapa/gate/checklist INSERT — lead-boutique (nacen en la activación del reto).
--  · etapa UPDATE — curadores (estado informativo).
--  · gate UPDATE — SOLO el rol aprobador del gate, SOLO pendiente→aprobado y con
--    atribución exigida (transición completa, como el sellado de la bandeja).
--  · checklist UPDATE — curadores, SOLO mientras su gate esté pendiente (aprobado ⇒
--    checklist congelado); el estado N/A exige que quien lo marca TENGA el rol
--    aprobador del gate y quede como su aprobador.

alter table criterio_exito enable row level security;
alter table etapa_instancia enable row level security;
alter table gate_instancia enable row level security;
alter table checklist_item enable row level security;

create policy criterio_select on criterio_exito
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy etapa_select on etapa_instancia
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy gate_select on gate_instancia
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy checklist_select on checklist_item
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy reto_insert on reto
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'candidato'
  );
create policy reto_afectado_insert on reto_servicio_afectado
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );
create policy reto_update_estado on reto
  for update
  using (workspace_role(app_user_id(), workspace_id) = 'lead-boutique')
  with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and estado <> 'candidato'
  );

create policy proyecto_insert on proyecto
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
  );
-- Los criterios se CONGELAN cuando algún G0 del reto queda aprobado: el gate certificó
-- exactamente esos criterios (SYS-22) — ni agregar ni mutar después sin reapertura
-- (las reaperturas trazadas llegan con RF-04.9).
create policy criterio_insert on criterio_exito
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and not exists (select 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      where p.reto_id = criterio_exito.reto_id
        and p.workspace_id = criterio_exito.workspace_id
        and g.numero = 0 and g.estado = 'aprobado')
  );
create policy criterio_update on criterio_exito
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and not exists (select 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      where p.reto_id = criterio_exito.reto_id
        and p.workspace_id = criterio_exito.workspace_id
        and g.numero = 0 and g.estado = 'aprobado')
  )
  with check (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'));

create policy etapa_insert on etapa_instancia
  for insert with check (workspace_role(app_user_id(), workspace_id) = 'lead-boutique');
-- Curadores mueven el estado informativo; el APROBADOR del gate homólogo también
-- (aprobarGate marca 'completada' la etapa en la misma transacción — el sponsor
-- aprueba G0/G3/G5/G6 sin ser curador).
create policy etapa_update on etapa_instancia
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    or exists (select 1 from gate_instancia g
      where g.proyecto_id = etapa_instancia.proyecto_id
        and g.workspace_id = etapa_instancia.workspace_id
        and g.numero = etapa_instancia.numero
        and workspace_role(app_user_id(), workspace_id) = g.rol_aprobador)
  )
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    or exists (select 1 from gate_instancia g
      where g.proyecto_id = etapa_instancia.proyecto_id
        and g.workspace_id = etapa_instancia.workspace_id
        and g.numero = etapa_instancia.numero
        and workspace_role(app_user_id(), workspace_id) = g.rol_aprobador)
  );

create policy gate_insert on gate_instancia
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and estado = 'pendiente'
    and aprobado_por is null
    and aprobado_en is null
  );
create policy gate_update_aprobar on gate_instancia
  for update
  using (
    estado = 'pendiente'
    and workspace_role(app_user_id(), workspace_id) = rol_aprobador
  )
  with check (
    estado = 'aprobado'
    and aprobado_por = app_user_id()
    and aprobado_en is not null
    and workspace_role(app_user_id(), workspace_id) = rol_aprobador
  );

create policy checklist_insert on checklist_item
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and estado = 'pendiente'
  );
-- Cumplido/pendiente los marcan los curadores (producen artefactos, §13.2); N/A lo
-- marca SOLO quien tiene el rol aprobador del gate (que en G0/G3/G5/G6 es el sponsor,
-- no curador) y queda como su aprobador. Gate aprobado ⇒ checklist congelado.
create policy checklist_update on checklist_item
  for update
  using (
    exists (select 1 from gate_instancia g
      where g.id = checklist_item.gate_id
        and g.workspace_id = checklist_item.workspace_id
        and g.estado = 'pendiente')
    and (
      workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
      or exists (select 1 from gate_instancia g2
        where g2.id = checklist_item.gate_id
          and g2.workspace_id = checklist_item.workspace_id
          and workspace_role(app_user_id(), workspace_id) = g2.rol_aprobador)
    )
  )
  with check (
    (estado in ('pendiente', 'cumplido')
      and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'))
    or (estado = 'na'
      and na_aprobado_por = app_user_id()
      and exists (select 1 from gate_instancia g
        where g.id = checklist_item.gate_id
          and g.workspace_id = checklist_item.workspace_id
          and workspace_role(app_user_id(), workspace_id) = g.rol_aprobador))
  );

-- ── Grants mínimos (UPDATE por columnas: nada más que la transición de cada pieza) ──
grant insert on reto, proyecto, reto_servicio_afectado, criterio_exito,
  etapa_instancia, gate_instancia, checklist_item to designio_app;
grant select on criterio_exito, etapa_instancia, gate_instancia, checklist_item to designio_app;
grant update (estado) on reto to designio_app;
-- proyecto sin UPDATE: sus transiciones (en-implementacion/en-medicion/cerrado) llegan
-- con G7 y el post mortem — sin grant no hay superficie.
grant update (kpi, definicion, linea_base_valor, linea_base_fecha, linea_base_plan,
  objetivo, ventana_dias, fecha_post_mortem) on criterio_exito to designio_app;
grant update (estado) on etapa_instancia to designio_app;
grant update (estado, aprobado_por, aprobado_en) on gate_instancia to designio_app;
grant update (estado, evidencia_id, na_justificacion, na_aprobado_por) on checklist_item to designio_app;
