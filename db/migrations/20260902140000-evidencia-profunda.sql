-- SPEC-03 (resto) — evidencia profunda: archivos adjuntos al material importado
-- (RF-03.1), sanitización del contenido no confiable (RF-03.2 / RF-09.7-09.8) y
-- DERECHOS DE USO BLOQUEANTES (RF-03.10, SYS-14) — más el soporte de la exportación
-- del workspace (RF-01.8, SYS-04).
--
-- Tres decisiones de fondo, todas ejecutadas en la BASE (no solo en la app):
--
-- 1) SANITIZACIÓN — el texto importado se guarda CRUDO, byte a byte. La cita verificable
--    (RF-03.7, I3) localiza un fragmento por posición dentro del original: normalizar,
--    recortar o "limpiar" el texto correría esos offsets y destruiría la fidelidad que
--    la spec exige medir (SYS-17). Lo que se rechaza al entrar no es contenido sino
--    vector: controles C0/C1 (NUL incluido — `text` ni siquiera lo admite) y los
--    overrides bidireccionales de Unicode (U+202A-202E, U+2066-2069, U+200E/200F), que
--    solo sirven para que el curador LEA algo distinto de lo que se guardó. No hay
--    sanitizador de HTML porque el contenido nunca se interpreta como markup: se pinta
--    como texto (React escapa; `white-space: pre-wrap`) y jamás como HTML.
--
-- 2) ARCHIVOS — los bytes viven en Postgres (`bytea`), no en el filesystem. El contenedor
--    de despliegue no tiene volumen persistente (Dockerfile/railway.json): un archivo en
--    disco desaparecería en el siguiente deploy y la evidencia dejaría de tener original
--    (RF-01.8 exige exportar "evidencia con sus archivos"). La base ya es el único
--    almacenamiento con backup, RLS y transacciones — el adjunto entra en la MISMA
--    transacción que su item. El precio es el tamaño: tope duro por archivo en el
--    esquema, allowlist cerrada de formatos y verificación de firma en la app.
--
-- 3) DERECHOS — nacen `pendiente` (fail-closed) y conceder es un acto humano atribuido,
--    con base documental obligatoria. Sin derechos vigentes para el ámbito, la evidencia
--    NO se cita (guard sobre checklist_item) ni sale en un entregable (vista filtrada).
--
-- Mismo patrón multi-tenant: FKs compuestas (id, workspace_id), RLS día 1, escrituras
-- atribuidas en la política y transiciones exigidas por WITH CHECK.

-- ── 1. Sanitización de ingesta (RF-03.2, RF-09.7) ──
-- Predicado IMMUTABLE para poder usarse en CHECK. Se permiten tab/LF/CR: son contenido
-- real de un texto pegado. Todo lo demás de C0/C1 y los overrides bidi, no.
create function texto_importado_limpio(t text) returns boolean
language sql immutable parallel safe as
$$ select t !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]' $$;
comment on function texto_importado_limpio(text) is
  'RF-03.2: el material importado se guarda crudo; lo que se rechaza son controles C0/C1 y overrides bidi (vector de spoofing), nunca se "limpian" en silencio porque eso correría los offsets de las citas.';

alter table item_importacion
  add constraint item_contenido_limpio check (texto_importado_limpio(contenido)),
  add constraint item_titulo_limpio check (texto_importado_limpio(titulo)),
  add constraint item_referencia_limpia check (texto_importado_limpio(referencia));

-- ── 2. Archivos adjuntos del material importado (RF-03.1) ──
-- Cuelgan del ITEM, no de la evidencia: el archivo es el material tal como llegó, y
-- llega antes de que exista curaduría. Un item aprobado enlaza su evidencia
-- (item_importacion.evidencia_id), así que "los archivos de una evidencia" es un join
-- por ese enlace — una sola fuente de verdad, sin columna espejo que pueda divergir.
-- Un item rechazado conserva sus archivos (SYS-17: la propuesta original se conserva)
-- pero nunca es evidencia, luego nunca se cita ni se exporta como tal.
create table archivo_importado (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  item_id uuid not null,
  -- Nombre ya normalizado por la app (basename, sin rutas ni controles). El CHECK es el
  -- backstop: este nombre se sirve en Content-Disposition y no puede llevar separadores
  -- de ruta, comillas ni controles, ni empezar por punto (dotfiles/"..").
  nombre text not null,
  tipo_mime text not null,
  contenido bytea not null,
  -- Integridad verificable del original (RF-01.8: el manifiesto de export lo publica).
  -- GENERATED: ni la app puede declarar un hash que no corresponda a los bytes.
  sha256 text generated always as (encode(sha256(contenido), 'hex')) stored,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (item_id, workspace_id) references item_importacion (id, workspace_id),
  -- Allowlist CERRADA de formatos (RF-09.8). Sin SVG ni HTML: son ejecutables en un
  -- navegador. La firma mágica se verifica en la app antes de llegar aquí.
  constraint archivo_tipo_permitido check (tipo_mime in (
    'application/pdf',
    'text/plain', 'text/csv', 'text/markdown',
    'image/png', 'image/jpeg', 'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  )),
  -- 5 MiB por archivo: el adjunto viaja base64 dentro del payload de la server function
  -- (~6,7 MiB de JSON) y se guarda entero en una fila. Es el tope explícito del MVP.
  constraint archivo_tamano check (octet_length(contenido) between 1 and 5242880),
  constraint archivo_nombre_seguro check (
    length(nombre) between 1 and 200
    and nombre !~ '[[:cntrl:]]'
    and nombre !~ '[/\\"]'
    and nombre not like '.%'
  )
);
create index archivo_importado_item_idx on archivo_importado (workspace_id, item_id);

-- ── 3. Derechos de uso (RF-03.10, SYS-14) ──
-- El jsonb de dimensiones conserva lo que el curador DECLARÓ al aprobar (snapshot
-- congelado, ADR-0010). Esta tabla es el estado VIVO y ejecutable: el consentimiento se
-- concede y se revoca, y lo que bloquea aguas abajo es el estado vivo, no el snapshot.
-- Una fila por evidencia, nacida SIEMPRE en 'pendiente' (fail-closed: sin acto humano
-- explícito no hay derechos).
create table derecho_uso (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  evidencia_id uuid not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'concedido', 'denegado')),
  -- Ámbito MÁXIMO concedido, orden total: interno ⊂ cliente ⊂ publico.
  --  · interno   — solo trabajo de la boutique.
  --  · cliente   — portal y entregables del workspace (citar en un gate vive aquí).
  --  · publico   — difusión fuera del workspace.
  ambito text not null default 'interno' check (ambito in ('interno', 'cliente', 'publico')),
  -- Qué respalda la decisión: consentimiento firmado, cláusula del contrato, o el motivo
  -- de la denegación. Obligatorio en toda decisión — SYS-14 exige explicar el bloqueo.
  base text not null default '',
  -- Caducidad calendárica del permiso (consentimiento con vigencia). Fecha pura, sin huso.
  vence_en date,
  decidido_por uuid references usuario(id),
  decidido_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  -- Una evidencia, un estado de derechos: la historia vive en evento_dominio.
  unique (evidencia_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id),
  -- Toda decisión sabe quién, cuándo y con qué base; lo pendiente no arrastra nada.
  constraint derecho_decision_completa check (
    estado = 'pendiente'
    or (decidido_por is not null and decidido_en is not null and btrim(base) <> '')
  ),
  constraint derecho_pendiente_vacio check (
    estado <> 'pendiente'
    or (decidido_por is null and decidido_en is null and btrim(base) = '')
  ),
  -- Ámbito y vigencia solo significan algo si hay concesión: un denegado no "alcanza"
  -- a cliente ni caduca.
  constraint derecho_alcance_solo_concedido check (
    estado = 'concedido' or (ambito = 'interno' and vence_en is null)
  )
);
create index derecho_uso_ws_idx on derecho_uso (workspace_id, estado);

-- ── Predicado de uso: la ÚNICA definición de "esta evidencia puede usarse aquí" ──
-- SECURITY DEFINER: lo invocan guards y vistas que deben decidir igual para todos los
-- roles, sin depender de qué filas de derecho_uso vea el invocante.
create function evidencia_usable(p_evidencia uuid, p_ws uuid, p_ambito text) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$
  select exists (
    select 1 from derecho_uso d
    where d.evidencia_id = p_evidencia
      and d.workspace_id = p_ws
      and d.estado = 'concedido'
      -- Caducado ⇒ ya no hay derechos (fecha calendárica, comparada como día).
      and (d.vence_en is null or d.vence_en >= current_date)
      and case p_ambito
            when 'interno' then d.ambito in ('interno', 'cliente', 'publico')
            when 'cliente' then d.ambito in ('cliente', 'publico')
            when 'publico' then d.ambito = 'publico'
            else false
          end
  )
$$;

-- Por qué NO se puede: la spec exige bloquear "indicando la dimensión faltante"
-- (criterio de aceptación 3). null = sí se puede.
create function evidencia_motivo_bloqueo(p_evidencia uuid, p_ws uuid, p_ambito text) returns text
language sql stable security definer set search_path = public, pg_temp as
$$
  select case
    when evidencia_usable(p_evidencia, p_ws, p_ambito) then null
    when d.evidencia_id is null then
      'la evidencia no existe en este workspace o no tiene registro de derechos'
    when d.estado = 'pendiente' then
      'derechos pendientes: nadie ha registrado la base (consentimiento o cláusula) que autoriza este uso'
    when d.estado = 'denegado' then
      'derechos denegados: ' || d.base
    when d.vence_en is not null and d.vence_en < current_date then
      'los derechos vencieron el ' || to_char(d.vence_en, 'YYYY-MM-DD')
    else
      'los derechos concedidos alcanzan solo el ámbito «' || d.ambito ||
      '» y este uso exige «' || p_ambito || '»'
  end
  from (select p_evidencia as ev) param
  left join derecho_uso d on d.evidencia_id = param.ev and d.workspace_id = p_ws
$$;

-- ── Toda evidencia nace CON su registro de derechos ──
-- Diferido al commit: aprobarItem inserta la evidencia y su derecho_uso en la misma
-- transacción. Un INSERT crudo solitario en evidencia aborta: sin registro de derechos
-- la evidencia sería inusable de facto pero invisible para el operador. Mismo
-- pre-chequeo anti-oráculo que los guards del método (el seed y los backfills corren
-- como owner sin contexto y lo saltan).
create function evidencia_con_derechos_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return null;
  end if;
  if not exists (select 1 from derecho_uso d
    where d.evidencia_id = new.id and d.workspace_id = new.workspace_id) then
    raise exception 'toda evidencia exige su registro de derechos: usa la curaduría de la app';
  end if;
  return null;
end $$;
create constraint trigger evidencia_con_derechos
  after insert on evidencia
  deferrable initially deferred
  for each row execute function evidencia_con_derechos_guard();

-- ── Sello temporal y rastro de la decisión de derechos, DENTRO de la transición ──
-- El `decidido_en` lo pone la base (un update directo no puede retro ni post-datar), y
-- cada concesión/denegación/revocación deja evento con el estado previo — también por
-- SQL crudo. Los derechos son lo único que puede volver atrás en este dominio (un
-- consentimiento se retira), así que la historia tiene que estar completa.
create function derecho_uso_transicion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado is distinct from old.estado
     or new.ambito is distinct from old.ambito
     or new.vence_en is distinct from old.vence_en
     or new.base is distinct from old.base then
    new.decidido_en := now();
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id,
      case new.estado when 'concedido' then 'DerechosConcedidos' else 'DerechosDenegados' end,
      jsonb_strip_nulls(jsonb_build_object(
        'evidenciaId', new.evidencia_id, 'ambito', new.ambito, 'base', new.base,
        'venceEn', to_char(new.vence_en, 'YYYY-MM-DD'),
        'previo', jsonb_build_object('estado', old.estado, 'ambito', old.ambito))),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger derecho_uso_transicion
  before update on derecho_uso
  for each row execute function derecho_uso_transicion_guard();

-- ── DERECHOS BLOQUEANTES AL CITAR (RF-03.10, criterio de aceptación 3) ──
-- La superficie de cita que existe hoy es el checklist de suficiencia de un gate
-- (SPEC-04: `cumplido` exige una evidencia REAL enlazada), y un gate se aprueba en el
-- portal con el cliente: el ámbito exigido es «cliente».
--
-- Va en un TRIGGER y no solo en la política de checklist_item por dos razones: (a) un
-- trigger corre para TODA escritura y TODO rol (la política solo para los no dueños), y
-- (b) puede nombrar la dimensión que falta, que es justo lo que la spec pide. La política
-- de SPEC-04 sigue decidiendo QUIÉN marca; este guard decide QUÉ puede citarse.
-- Errcode propio para que el servicio lo distinga de "rol insuficiente" (42501).
create function checklist_item_derechos_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.evidencia_id is null then
    return new;
  end if;
  -- Anti-oráculo: para quien no es miembro no hay nada que informar; la política ya
  -- rechaza la escritura.
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if not evidencia_usable(new.evidencia_id, new.workspace_id, 'cliente') then
    raise exception 'No puedes citar esta evidencia: %',
      coalesce(evidencia_motivo_bloqueo(new.evidencia_id, new.workspace_id, 'cliente'),
               'derechos insuficientes')
      using errcode = 'DR001';
  end if;
  return new;
end $$;
create trigger checklist_item_derechos
  before insert or update on checklist_item
  for each row execute function checklist_item_derechos_guard();

-- ── Vista del entregable: el filtro de derechos vive en la BASE ──
-- La exportación en ámbito «entregable» lee de aquí, no de `evidencia` con un WHERE de
-- la app: cualquier consulta (también SQL crudo del rol de aplicación) ve exactamente
-- la evidencia con derechos vigentes para el cliente. security_invoker mantiene la RLS
-- del invocante sobre la tabla base: el aislamiento por tenant no se relaja.
create view evidencia_entregable with (security_invoker = true) as
  select e.id, e.workspace_id, e.fuente_id, e.titulo, e.resumen, e.dimensiones,
         e.es_estado_actual, e.creado_por, e.creado_en
  from evidencia e
  where evidencia_usable(e.id, e.workspace_id, 'cliente');

-- ── Exportación del workspace (RF-01.8): permiso y registro, en la base ──
-- El export es el archivo del PROPIETARIO: lo ejecuta quien administra el workspace
-- (admin-cliente, RF-01.4) o quien lo opera (lead-boutique). La ejecución queda
-- registrada aquí mismo (RF-01.8 "ejecución registrada", RF-01.6), en la misma
-- transacción que después lee los datos: sin evento no hay export.
create function registrar_exportacion(p_ws uuid, p_ambito text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rol text;
begin
  if p_ambito not in ('archivo', 'entregable') then
    raise exception 'ámbito de exportación desconocido: %', p_ambito;
  end if;
  v_rol := workspace_role(app_user_id(), p_ws);
  if coalesce(v_rol, '') not in ('lead-boutique', 'admin-cliente') then
    raise exception 'solo lead-boutique o admin-cliente ejecutan la exportación del workspace'
      using errcode = 'insufficient_privilege';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (p_ws, 'WorkspaceExportado', jsonb_build_object('ambito', p_ambito),
          app_user_id(), v_rol);
  return v_rol;
end $$;

-- ── RLS ──
-- archivo_importado:
--  · SELECT — miembros del workspace.
--  · INSERT — cualquier miembro humano (aporta material, como la propia bandeja) y SOLO
--    mientras su item siga PENDIENTE: lo curado es inmutable (SYS-17).
--  · DELETE — quien lo subió o un curador, también solo mientras el item esté pendiente;
--    nada que ya sea evidencia se borra.
--  · Sin UPDATE: un adjunto no se reescribe (su sha256 es su identidad).
-- derecho_uso:
--  · SELECT — miembros (el bloqueo se explica, no se oculta).
--  · INSERT — curadores, nace 'pendiente' y sin decisión (fail-closed).
--  · UPDATE — solo lead-boutique o admin-cliente, y solo hacia concedido/denegado con
--    base no vacía y atribución propia. Nunca se vuelve a 'pendiente'.

alter table archivo_importado enable row level security;
alter table derecho_uso enable row level security;

create policy archivo_select on archivo_importado
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy archivo_insert on archivo_importado
  for insert with check (
    coalesce(workspace_role(app_user_id(), workspace_id), '') not in ('', 'agente-ai')
    and creado_por = app_user_id()
    and exists (select 1 from item_importacion i
      where i.id = archivo_importado.item_id
        and i.workspace_id = archivo_importado.workspace_id
        and i.estado = 'pendiente')
  );

create policy archivo_delete on archivo_importado
  for delete using (
    exists (select 1 from item_importacion i
      where i.id = archivo_importado.item_id
        and i.workspace_id = archivo_importado.workspace_id
        and i.estado = 'pendiente')
    and (creado_por = app_user_id()
      or workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'))
  );

create policy derecho_select on derecho_uso
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy derecho_insert on derecho_uso
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'pendiente'
    and decidido_por is null
    and decidido_en is null
    and ambito = 'interno'
    and btrim(base) = ''
    and vence_en is null
  );

create policy derecho_update_decision on derecho_uso
  for update
  using (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'admin-cliente'))
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'admin-cliente')
    and decidido_por = app_user_id()
    and estado in ('concedido', 'denegado')
    and decidido_en is not null
    and btrim(base) <> ''
  );

-- ── Grants mínimos (UPDATE por columnas) ──
grant select, insert, delete on archivo_importado to designio_app;
grant select, insert on derecho_uso to designio_app;
grant update (estado, ambito, base, vence_en, decidido_por, decidido_en)
  on derecho_uso to designio_app;
grant select on evidencia_entregable to designio_app;

-- Sin esto cualquier sesión del rol de app podría colgar estos SECURITY DEFINER de una
-- tabla temporal propia y usarlos como oráculo cross-tenant.
revoke execute on function
  evidencia_con_derechos_guard(),
  derecho_uso_transicion_guard(),
  checklist_item_derechos_guard()
from public;

revoke execute on function
  evidencia_usable(uuid, uuid, text),
  evidencia_motivo_bloqueo(uuid, uuid, text),
  registrar_exportacion(uuid, text)
from public;
grant execute on function
  evidencia_usable(uuid, uuid, text),
  evidencia_motivo_bloqueo(uuid, uuid, text),
  registrar_exportacion(uuid, text)
to designio_app;

-- ── Backfill: la evidencia anterior a esta migración entra fail-closed ──
-- Sin registro de derechos, ninguna evidencia previa sería citable ni exportable como
-- entregable (que es exactamente el comportamiento correcto): se le crea su fila
-- 'pendiente' para que aparezca en la pantalla de derechos con camino de reparación,
-- atribuida a quien la curó. En una base fresca es un no-op.
insert into derecho_uso (workspace_id, evidencia_id, creado_por)
select e.workspace_id, e.id, e.creado_por
from evidencia e
where not exists (select 1 from derecho_uso d where d.evidencia_id = e.id);

-- Y el checklist ya marcado antes de esta migración puede estar citando evidencia sin
-- derechos: no se revierte (reescribiría decisiones humanas ya tomadas), pero queda
-- registrado para que el operador lo resuelva concediendo derechos o revirtiendo la marca.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select ci.workspace_id, 'CitaSinDerechosDetectada',
       jsonb_build_object('itemId', ci.id, 'evidenciaId', ci.evidencia_id),
       null, null
from checklist_item ci
where ci.evidencia_id is not null
  and not evidencia_usable(ci.evidencia_id, ci.workspace_id, 'cliente');
