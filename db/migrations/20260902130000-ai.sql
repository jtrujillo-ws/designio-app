-- SPEC-08 — capacidades AI vía el pipeline único PropuestaAI (CTX-08, ADR-0012/I4) y la
-- parte AI de SPEC-09 (degradación segura, RF-09.11/SYS-21).
--
-- La regla que estructura toda esta migración: la AI NUNCA escribe en el dominio. Propone;
-- un humano acepta, corrige o rechaza, y solo entonces —en la MISMA transacción— nace el
-- objeto real firmado por ese humano (SYS-19). El rol `agente-ai` no aparece por ninguna
-- parte: no es un actor que cura ni que aprueba (SYS-18).
--
-- Este slice materializa dos destinos, los únicos con objeto real hoy en el esquema:
--  · CI (extracción de importación, §12) → `evidencia` curada desde un item de la bandeja.
--  · C0 (borrador de reto) → `criterio_exito` del reto, con su ventana (SYS-22).
-- El resto de capacidades (C1-C7, CT) llegan con sus specs; el catálogo ya las nombra para
-- que su alta no reabra el CHECK de la tabla.
--
-- Mismo patrón multi-tenant de la casa: FKs compuestas (id, workspace_id), RLS día 1,
-- atribución fijada en la política, transiciones exigidas por WITH CHECK y efectos
-- (eventos + sellos temporales) emitidos DENTRO del guard que decide.

create table propuesta_ai (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  capacidad text not null check (capacidad in
    ('C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'CT', 'CI')),
  -- Destino en el grafo: qué objeto REAL nace si un humano acepta.
  destino text not null check (destino in ('evidencia', 'criterio-exito')),

  -- Ancla del AlcanceDeContexto (RF-02.7): el objeto del workspace del que se derivó el
  -- prompt. Exactamente uno y del tipo que exige el destino — nada fuera del alcance entra
  -- al prompt y nada del prompt escapa a otro tenant (las FKs son compuestas).
  item_id uuid,
  reto_id uuid,

  -- Salida ESTRUCTURADA tipada por capacidad (Zod en la app: ContenidoCISchema/C0).
  -- `contenido_original` es la propuesta tal como la emitió el modelo y no cambia jamás
  -- (SYS-17: insumo de la tasa de corrección humana); `contenido` es lo que se materializa.
  contenido jsonb not null check (jsonb_typeof(contenido) = 'object'),
  contenido_original jsonb not null check (jsonb_typeof(contenido_original) = 'object'),
  confianza numeric check (confianza is null or (confianza >= 0 and confianza <= 1)),
  -- SYS-20: marca imborrable de los revisores AI por arquetipo (C4). No hay grant de
  -- UPDATE sobre esta columna: ni el rol de aplicación puede quitarla.
  es_simulacion boolean not null default false,

  estado text not null default 'propuesta'
    check (estado in ('propuesta', 'aceptada', 'corregida', 'rechazada')),

  -- ── Lineage (SYS-19, RF-09.9): con qué se generó y qué key sirvió ──
  -- Sin grant de UPDATE: el lineage de una propuesta es inmutable para la app.
  modelo text not null,
  prompt_version text not null,
  alcance_resumen text not null default '',
  latencia_ms integer check (latencia_ms is null or latencia_ms >= 0),
  -- BYOAI: qué credencial sirvió la llamada. Hoy la app resuelve siempre 'entorno'
  -- (el almacenamiento de la key por workspace espera al secret manager, RF-09.6);
  -- el catálogo ya admite 'workspace' para que ese día no haya migración de datos.
  origen_key text not null check (origen_key in ('workspace', 'entorno')),

  -- ── Revisión humana y materialización ──
  revisada_por uuid references usuario(id),
  revisada_en timestamptz,
  -- Punteros TIPADOS al objeto materializado (no un uuid polimórfico): la FK compuesta
  -- garantiza que existe, que es del tenant y que no puede borrarse por debajo.
  evidencia_id uuid,
  criterio_id uuid,

  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),

  unique (id, workspace_id),
  foreign key (item_id, workspace_id) references item_importacion (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id),
  foreign key (criterio_id, workspace_id) references criterio_exito (id, workspace_id),

  -- Destino ⇔ ancla ⇔ objeto materializado: el estado inválido es IMPOSIBLE (MOD), no
  -- una validación que algún camino futuro pueda saltarse.
  check ((destino = 'evidencia') = (item_id is not null)),
  check ((destino = 'criterio-exito') = (reto_id is not null)),
  check (evidencia_id is null or destino = 'evidencia'),
  check (criterio_id is null or destino = 'criterio-exito'),
  check (capacidad <> 'CI' or destino = 'evidencia'),
  check (capacidad <> 'C0' or destino = 'criterio-exito'),
  -- SYS-20: una simulación de revisor AI jamás se materializa como evidencia.
  check (not es_simulacion or destino <> 'evidencia'),

  -- Pendiente ⇒ sin revisor, sin sello y sin rastro en el dominio; decidida ⇒ con quién
  -- y cuándo. Y aceptada/corregida ⇒ EXACTAMENTE el objeto que su destino declara:
  -- ninguna propuesta puede quedar «aceptada» sin haber creado nada (SYS-19), ni una
  -- rechazada arrastrar un objeto creado a su sombra.
  check (estado <> 'propuesta' or (revisada_por is null and revisada_en is null)),
  check (estado = 'propuesta' or (revisada_por is not null and revisada_en is not null)),
  check ((estado in ('aceptada', 'corregida')) = (coalesce(evidencia_id, criterio_id) is not null)),
  -- 'aceptada' es aceptación LITERAL; editar es 'corregida', y ese es el dato que
  -- alimenta la tasa de corrección humana (SYS-17/§17).
  check (estado <> 'aceptada' or contenido = contenido_original)
);

create index propuesta_ai_ws_idx on propuesta_ai (workspace_id, estado, creado_en);
-- La bandeja pinta «este item ya tiene propuesta pendiente» sin recorrer el workspace.
create index propuesta_ai_item_idx on propuesta_ai (workspace_id, item_id)
  where item_id is not null;

-- ── RLS ──
-- Lectura: cualquier miembro (el cliente también ve qué propuso la AI y quién decidió).
-- Escritura: SOLO curadores de la boutique (lead-boutique/diseñador) — los mismos que
-- curan la bandeja (RF-03.4) y definen criterios. Pedir una generación es una acción
-- humana atribuida; revisarla, también. `agente-ai` no aparece: no propone por su cuenta
-- ni decide (SYS-18).

alter table propuesta_ai enable row level security;

create policy propuesta_select on propuesta_ai
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy propuesta_insert on propuesta_ai
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    -- Toda propuesta NACE pendiente y sin decisión: sin esto se podría insertar directo
    -- una 'aceptada' con revisor forjado, saltándose la política de revisión (que solo
    -- cubre UPDATE) y con ella la firma humana del objeto materializado.
    and estado = 'propuesta'
    and revisada_por is null
    and revisada_en is null
    and evidencia_id is null
    and criterio_id is null
    -- SYS-17 desde el alta: el «original» es de verdad lo que el modelo dijo.
    and contenido = contenido_original
  );

-- La revisión es una TRANSICIÓN completa: solo alcanza pendientes y solo deja la fila
-- decidida y atribuida al humano del contexto. Decidida ⇒ inmutable (el USING ya no la
-- alcanza): la propuesta original se conserva aunque se corrija.
create policy propuesta_revisar on propuesta_ai
  for update
  using (
    estado = 'propuesta'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (
    estado in ('aceptada', 'corregida', 'rechazada')
    and revisada_por = app_user_id()
    and revisada_en is not null
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

-- ── Guard de la transición: sello temporal, inmutabilidad del original y auditoría ──
-- Los efectos van CON la transición y no en el servicio, para que el SQL crudo los
-- produzca igual (idioma de la casa; mismo patrón que gate_aprobar_suficiencia_guard).
create function propuesta_ai_revision_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Pre-chequeo anti-oráculo: para quien no es miembro del workspace declarado no hay
  -- nada que auditar ni que serializar — la política rechaza la escritura como siempre.
  -- (El seed y los backfills corren como owner sin contexto y también lo saltan.)
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- RF-09.9: de qué workspace salió qué material, a qué modelo y con qué credencial.
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'PropuestaAIGenerada',
      jsonb_build_object('propuestaId', new.id, 'capacidad', new.capacidad,
                         'destino', new.destino, 'modelo', new.modelo,
                         'promptVersion', new.prompt_version, 'origenKey', new.origen_key,
                         'esSimulacion', new.es_simulacion),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
    return new;
  end if;

  if new.estado = old.estado then
    return new;
  end if;
  -- Ciclo de vida de sentido único: de pendiente a una decisión, y ahí termina.
  if (old.estado, new.estado) not in (
    ('propuesta', 'aceptada'),
    ('propuesta', 'corregida'),
    ('propuesta', 'rechazada')
  ) then
    raise exception 'transición de propuesta AI ilegal: % → %', old.estado, new.estado;
  end if;

  -- El sello temporal lo pone la BASE, no el caller: una revisión no se retro ni
  -- post-data por SQL directo.
  new.revisada_en := now();

  -- SYS-17: la propuesta original se conserva SIEMPRE. No hay grant de UPDATE sobre la
  -- columna, pero el invariante se defiende también aquí (un grant futuro no lo rompe).
  if new.contenido_original is distinct from old.contenido_original then
    raise exception 'la propuesta AI original se conserva siempre (SYS-17)';
  end if;
  -- Aceptar es aceptar LO PROPUESTO; editar es corregir, y se llama por su nombre para
  -- que la tasa de corrección humana no se pueda maquillar.
  if new.estado <> 'corregida' and new.contenido is distinct from old.contenido then
    raise exception 'aceptar o rechazar no edita la propuesta: usa la corrección';
  end if;
  if new.estado = 'corregida' and new.contenido is not distinct from old.contenido then
    raise exception 'una corrección debe cambiar el contenido propuesto';
  end if;

  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (new.workspace_id,
    case new.estado
      when 'aceptada' then 'PropuestaAIAceptada'
      when 'corregida' then 'PropuestaAICorregida'
      else 'PropuestaAIRechazada'
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'propuestaId', new.id, 'capacidad', new.capacidad, 'destino', new.destino,
      'modelo', new.modelo, 'evidenciaId', new.evidencia_id, 'criterioId', new.criterio_id)),
    app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;

create trigger propuesta_ai_revision
  before insert or update on propuesta_ai
  for each row execute function propuesta_ai_revision_guard();

-- ── Guard de materialización: el objeto lo FIRMA quien aceptó, y cierra su ancla ──
-- Los CHECKs de arriba exigen que exista un objeto; este exige que sea EL objeto correcto:
--  · CI ⇒ el item de la bandeja queda sellado como aprobado, con ESA evidencia y por el
--    MISMO humano que aceptó — la curaduría humana obligatoria (SYS-16) no se esquiva
--    aceptando una propuesta, y una evidencia AI no puede colarse sin pasar por bandeja.
--  · C0 ⇒ el criterio cuelga del reto de la propuesta y lo firma quien aceptó (SYS-19).
-- Diferido al commit porque el servicio materializa y sella en sentencias posteriores de
-- la misma transacción; una UPDATE cruda solitaria aborta.
create function propuesta_ai_materializacion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return null;
  end if;
  if new.estado not in ('aceptada', 'corregida') then
    return null;
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
  return null;
end $$;

create constraint trigger propuesta_ai_materializacion
  after update on propuesta_ai
  deferrable initially deferred
  for each row execute function propuesta_ai_materializacion_guard();

-- EXECUTE es de PUBLIC por defecto: sin esto, una sesión del rol de app podría adjuntar
-- estos SECURITY DEFINER a una tabla temporal propia y usarlos como oráculo de existencia
-- sobre items o criterios de OTROS workspaces.
revoke execute on function propuesta_ai_revision_guard() from public;
revoke execute on function propuesta_ai_materializacion_guard() from public;

-- ── Grants mínimos (UPDATE por columna: solo la transición y su materialización) ──
grant select, insert on propuesta_ai to designio_app;
-- Fuera del grant y por tanto sin superficie: capacidad, destino, item_id, reto_id,
-- contenido_original, confianza, es_simulacion, modelo, prompt_version, alcance_resumen,
-- latencia_ms, origen_key, creado_por — el lineage y el original son inmutables (SYS-17/19).
-- `revisada_en` tampoco: lo estampa el guard, no el caller.
grant update (estado, contenido, revisada_por, evidencia_id, criterio_id)
  on propuesta_ai to designio_app;
