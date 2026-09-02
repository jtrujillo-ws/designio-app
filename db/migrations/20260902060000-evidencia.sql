-- SPEC-03 — evidencia e importación manual (CTX-02): fuente, evidencia con las cinco
-- dimensiones (ADR-0010) y la bandeja de importación con curaduría humana obligatoria
-- (SYS-16). El MVP importa TEXTO pegado o referencias; los binarios llegan con el
-- object storage y la extracción AI con SPEC-08.
--
-- Mismo patrón multi-tenant del árbol: FKs compuestas (id, workspace_id) y RLS activo.

create table fuente (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  tipo text not null check (tipo in ('documento', 'entrevista', 'observacion', 'dataset', 'enlace', 'nota')),
  titulo text not null,
  referencia text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id)
);
create index fuente_ws_idx on fuente (workspace_id);

-- Evidencia: las cinco dimensiones viajan en jsonb VALIDADO POR ZOD en la capa de
-- aplicación (DimensionesEvidenciaSchema); aquí solo se garantiza la forma básica.
create table evidencia (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  fuente_id uuid not null,
  titulo text not null,
  resumen text not null default '',
  dimensiones jsonb not null check (jsonb_typeof(dimensiones) = 'object'),
  -- RF-03.4: el curador decide qué describe el estado ACTUAL y qué queda histórico.
  es_estado_actual boolean not null default false,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (fuente_id, workspace_id) references fuente (id, workspace_id)
);
create index evidencia_ws_idx on evidencia (workspace_id);

-- Bandeja de importación (RF-03.1): contenido de TEXTO acotado (contenido no confiable,
-- SPEC-09: bounds antes de cualquier procesamiento; la sanitización AI llega con SPEC-08).
create table item_importacion (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  titulo text not null,
  contenido text not null check (length(contenido) <= 100000),
  tipo_fuente text not null check (tipo_fuente in ('documento', 'entrevista', 'observacion', 'dataset', 'enlace', 'nota')),
  referencia text not null default '',
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado')),
  decidido_por uuid references usuario(id),
  decidido_en timestamptz,
  evidencia_id uuid,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id),
  -- Consistencia del sellado: un item decidido siempre sabe quién y cuándo, un
  -- aprobado siempre enlaza su evidencia y un rechazado jamás la tiene
  -- (decidido = inmutable, no habría reparación).
  check (estado = 'pendiente' or (decidido_por is not null and decidido_en is not null)),
  check (estado <> 'aprobado' or evidencia_id is not null),
  check (estado <> 'rechazado' or evidencia_id is null)
);
create index item_importacion_ws_idx on item_importacion (workspace_id, estado, creado_en);

-- ── RLS ──
-- Lectura: cualquier miembro del workspace. Escritura:
--  · item_importacion INSERT — cualquier miembro humano (el material lo aporta también
--    el cliente, RF-03.1); agente-ai queda fuera (actor de plataforma).
--  · item_importacion UPDATE — SOLO items pendientes y SOLO curadores de la boutique
--    (lead-boutique/diseñador, RF-03.4): una vez decidido, el item es inmutable para
--    la app (SYS-17: la propuesta original se conserva).
--  · fuente/evidencia INSERT — solo curadores (nacen de la curaduría o registro nativo).
--  · Sin UPDATE/DELETE en fuente/evidencia y sin DELETE en la bandeja: sin grant no
--    hay superficie.

alter table fuente enable row level security;
alter table evidencia enable row level security;
alter table item_importacion enable row level security;

create policy fuente_select on fuente
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy evidencia_select on evidencia
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy item_select on item_importacion
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- Toda escritura queda ATRIBUIDA a quien la hace: creado_por/decidido_por se fijan al
-- usuario del contexto en la propia política (la auditoría no se puede falsificar).
create policy fuente_insert on fuente
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );
create policy evidencia_insert on evidencia
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );

create policy item_insert on item_importacion
  for insert with check (
    coalesce(workspace_role(app_user_id(), workspace_id), '') not in ('', 'agente-ai')
    and creado_por = app_user_id()
    -- Todo item NACE pendiente y sin decisión: sin esto, cualquier miembro podía
    -- insertar directo un 'rechazado'/'aprobado' con metadata de decisión forjada,
    -- saltándose la política de curaduría (que solo cubre UPDATE).
    and estado = 'pendiente'
    and decidido_por is null
    and decidido_en is null
    and evidencia_id is null
  );

-- La decisión es una TRANSICIÓN: el WITH CHECK exige que el update deje el item
-- DECIDIDO y completo — sin él, un curador podía poblar o reescribir los campos de
-- decisión dejando la fila 'pendiente' (los CHECKs de tabla aceptan cualquier
-- pendiente), y el sellado dejaba de ser invariante a nivel RLS.
create policy item_update_curaduria on item_importacion
  for update
  using (
    estado = 'pendiente'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and decidido_por = app_user_id()
    and estado in ('aprobado', 'rechazado')
    and decidido_en is not null
    and (estado <> 'aprobado' or evidencia_id is not null)
    and (estado <> 'rechazado' or evidencia_id is null)
  );

grant select, insert on fuente, evidencia to designio_app;
-- UPDATE a nivel de COLUMNA: la curaduría solo sella la decisión; ni el propio rol de
-- app puede reescribir contenido/título/workspace de una propuesta (SYS-17) ni moverla
-- de tenant (SYS-01/02).
grant select, insert on item_importacion to designio_app;
grant update (estado, decidido_por, decidido_en, evidencia_id) on item_importacion to designio_app;

-- ── Anclaje relacional de segmentos referenciados por evidencia ──
-- El jsonb de dimensiones conserva el snapshot CONGELADO (ADR-0010); esta tabla ancla
-- la integridad: un segmento referenciado por evidencia no puede borrarse (FK compuesta
-- sin cascada) y la existencia se valida en la MISMA sentencia que crea el vínculo —
-- sin ella, la validación por conteo solo probaba existencia en su propio snapshot y un
-- borrado posterior dejaba la referencia colgante para siempre en evidencia inmutable.
alter table segmento add constraint segmento_id_ws_unico unique (id, workspace_id);

create table evidencia_segmento (
  evidencia_id uuid not null,
  segmento_id uuid not null,
  workspace_id uuid not null references workspace(id),
  primary key (evidencia_id, segmento_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id),
  foreign key (segmento_id, workspace_id) references segmento (id, workspace_id)
);
create index evidencia_segmento_seg_idx on evidencia_segmento (workspace_id, segmento_id);

alter table evidencia_segmento enable row level security;
create policy evidencia_segmento_select on evidencia_segmento
  for select using (is_workspace_member(app_user_id(), workspace_id));
-- Solo curadores crean vínculos (misma regla que evidencia); congelado: sin update/delete.
create policy evidencia_segmento_insert on evidencia_segmento
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

grant select, insert on evidencia_segmento to designio_app;
