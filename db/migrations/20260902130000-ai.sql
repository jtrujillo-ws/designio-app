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
--
-- Dos tablas acompañan al pipeline y existen por lo mismo —que las promesas del slice se
-- cumplan aunque haya concurrencia o prisa—: `consentimiento_item` (RF-09.5: el material
-- de personas no se procesa sin permiso registrado ANTES) y `reserva_ai` (RF-09.12: el
-- presupuesto se aparta antes de llamar al proveedor, no después de pagar).

-- ── Consentimiento del material ANTES de procesarlo (RF-09.5) ─────────────────────────
-- Qué material lo exige. Vive en una función y no repartido por consultas: el día que
-- entren audio/vídeo transcritos, la lista se amplía en UN sitio y el bloqueo de la base,
-- el del servicio y el aviso de la UI se mueven juntos. No es SECURITY DEFINER ni lee
-- nada: es un mapa constante sobre su argumento, así que no hay oráculo que revocar.
create function tipo_fuente_exige_consentimiento(tipo text) returns boolean
language sql immutable parallel safe as $$
  select tipo in ('entrevista', 'observacion')
$$;

/*
 * El consentimiento de las personas se captura ANTES de procesar (RF-09.5), no se infiere
 * de un texto ni se rellena al final: hasta ahora nacía en `false` al aceptar la propuesta,
 * o sea DESPUÉS de que el material ya hubiera viajado al proveedor.
 *
 * Vive en su propia tabla y no en una columna de `item_importacion` por tres razones:
 *  · append-only por construcción — sin grant de UPDATE/DELETE no hay superficie con la
 *    que reescribir un consentimiento ya registrado, sin necesidad de un guard que lo
 *    defienda ni de ampliar el grant por columna de la bandeja (que hoy solo sella la
 *    decisión de curaduría);
 *  · no mezcla dos transiciones distintas sobre la misma fila: registrar consentimiento y
 *    decidir la curaduría son actos separados, con políticas separadas;
 *  · el registro tiene contenido propio (qué se autorizó y si cubre a un tercero) que no
 *    tiene por qué engordar la tabla caliente de la bandeja.
 * Una revocación futura (RF-09.4) será otra fila/objeto, nunca un UPDATE sobre esta.
 */
create table consentimiento_item (
  item_id uuid not null,
  workspace_id uuid not null references workspace(id),
  -- Qué autorizó la persona, en las palabras de quien lo recogió: es el registro del
  -- consentimiento, no el contrato.
  alcance text not null check (length(btrim(alcance)) between 1 and 1000),
  -- Y si ese consentimiento cubre EXPLÍCITAMENTE el procesamiento por un tercero: un
  -- permiso para grabar y transcribir en interno no autoriza mandar el material a un
  -- proveedor externo (RF-09.5 + condiciones de uso del proveedor, RF-09.9). Registrar
  -- consentimiento no es marcar una casilla: distingue qué se autorizó.
  procesamiento_externo boolean not null,
  registrado_por uuid not null references usuario(id),
  registrado_en timestamptz not null default now(),
  primary key (item_id, workspace_id),
  foreign key (item_id, workspace_id) references item_importacion (id, workspace_id)
);

alter table consentimiento_item enable row level security;

create policy consentimiento_select on consentimiento_item
  for select using (is_workspace_member(app_user_id(), workspace_id));
-- Lo registra quien conduce la investigación (los mismos curadores que deciden la
-- bandeja) y queda atribuido por la política, no por el caller.
create policy consentimiento_insert on consentimiento_item
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and registrado_por = app_user_id()
  );

-- Auditoría del registro (RF-09.13). Sin `returning` en ningún lado: el evento se emite
-- dentro del trigger, así que quien registra no necesita poder LEER `evento_dominio`.
create function consentimiento_item_registro_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (new.workspace_id, 'ConsentimientoRegistrado',
    jsonb_build_object('itemId', new.item_id,
                       'procesamientoExterno', new.procesamiento_externo),
    app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;

create trigger consentimiento_item_registro
  before insert on consentimiento_item
  for each row execute function consentimiento_item_registro_guard();

revoke execute on function consentimiento_item_registro_guard() from public;

-- Sin UPDATE ni DELETE: un consentimiento registrado es un hecho, no un campo editable.
grant select, insert on consentimiento_item to designio_app;

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

  -- Uso y coste de la llamada que la produjo (RF-09.14: observabilidad de costos). El
  -- proveedor devuelve el `usage` de cada respuesta y aquí se conserva: sin esto el
  -- `costoUsd` del lineage no se puede calcular NUNCA — el dato solo existe en el
  -- instante de la llamada y se perdía al quedarnos con el texto.
  -- `llamada_id` agrupa las propuestas nacidas de UNA misma llamada (C0 devuelve un
  -- lote): el uso y el coste son de la LLAMADA, así que las filas del lote los repiten
  -- y el gasto real del workspace se suma por llamada distinta, no por propuesta —
  -- prorratear el coste entre las filas habría hecho cuadrar la suma a costa de que
  -- ninguna fila dijera la verdad sobre lo que se pagó.
  llamada_id uuid not null default gen_random_uuid(),
  tokens_entrada integer check (tokens_entrada is null or tokens_entrada >= 0),
  tokens_salida integer check (tokens_salida is null or tokens_salida >= 0),
  -- Al precio VIGENTE cuando se generó: una tarifa nueva no reescribe el histórico.
  costo_usd numeric(12, 6) check (costo_usd is null or costo_usd >= 0),

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
-- Un item tiene COMO MUCHO una propuesta pendiente, y el índice lo impone además de
-- servir la consulta («este item ya tiene propuesta pendiente» sin recorrer el
-- workspace). Que sea único y parcial es el punto: dos curadores concurrentes veían
-- cada uno un snapshot sin propuesta pendiente y ambos insertaban — un predicado sobre
-- un snapshot no es un candado, un índice único sí. La segunda escritura falla aunque
-- ninguna de las dos haya visto a la otra; el gasto duplicado en el proveedor lo corta
-- antes la reserva de más abajo. Decidir la propuesta libera el hueco: el índice solo
-- cubre `estado = 'propuesta'`, así que un item rechazado admite otra pasada.
create unique index propuesta_ai_item_pendiente_idx on propuesta_ai (workspace_id, item_id)
  where item_id is not null and estado = 'propuesta';

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
    -- RF-09.5: el material de personas no se procesa sin consentimiento registrado
    -- ANTES. El servicio lo comprueba antes de construir el prompt —ahí es donde se
    -- evita de verdad la fuga al proveedor— y esto es el suelo: una propuesta derivada
    -- de material sin consentimiento no puede EXISTIR, venga de donde venga la
    -- escritura. Y exige que el consentimiento cubra el procesamiento externo: haber
    -- autorizado la grabación no es haber autorizado mandarla a un tercero.
    if new.item_id is not null and exists (
      select 1 from item_importacion i
      where i.id = new.item_id and i.workspace_id = new.workspace_id
        and tipo_fuente_exige_consentimiento(i.tipo_fuente)
        and not exists (
          select 1 from consentimiento_item c
          where c.item_id = i.id and c.workspace_id = i.workspace_id
            and c.procesamiento_externo)
    ) then
      raise exception 'ese material exige consentimiento registrado para procesamiento externo antes de generar propuestas AI (RF-09.5)';
    end if;

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

-- ── Reserva del presupuesto AI: se aparta ANTES de llamar al proveedor ────────────────
/*
 * El presupuesto por workspace (RF-09.12) se contaba sobre lo PERSISTIDO y se comprobaba
 * en una transacción que commiteaba antes de la llamada, y el insert posterior no volvía
 * a mirar nada: N curadores concurrentes pasaban todos el mismo chequeo con 59/60 y cada
 * uno persistía su lote. El tope prometido se rebasaba por un margen arbitrario y, peor,
 * el gasto en el proveedor ya se había hecho.
 *
 * Una fila de reserva ocupa el hueco durante la llamada: se toma bajo candado consultivo
 * del workspace, se consume (se borra) en la MISMA transacción que persiste las
 * propuestas, y se libera si la generación no llega a nacer — una llamada fallida sigue
 * sin consumir presupuesto. Caduca sola: si el proceso muere, la reserva deja de contar
 * pasada la ventana en vez de bloquear el workspace para siempre.
 *
 * Y para CI hace de token de exclusión por item: dos curadores no pueden tener a la vez
 * una generación en curso sobre el mismo item de bandeja, así que el gasto duplicado en
 * el proveedor se corta ANTES de la llamada (el índice único parcial de propuesta_ai es
 * el suelo, pero llega cuando el dinero ya se gastó).
 */
create table reserva_ai (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  capacidad text not null check (capacidad in ('C0', 'CI')),
  item_id uuid,
  -- Cuántas propuestas puede llegar a persistir esta generación (el techo que admite el
  -- esquema de la capacidad), no cuántas se le piden al modelo.
  unidades smallint not null check (unidades between 1 and 8),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (item_id, workspace_id) references item_importacion (id, workspace_id),
  check ((capacidad = 'CI') = (item_id is not null))
);
create index reserva_ai_ws_idx on reserva_ai (workspace_id, creado_en);
create unique index reserva_ai_item_idx on reserva_ai (workspace_id, item_id)
  where item_id is not null;

-- Ventana de vida de una reserva: cuatro veces el timeout duro del proveedor. Se define
-- una sola vez y AQUÍ para que el conteo del servicio y la limpieza no puedan divergir;
-- ninguna llamada puede sobrevivirla (el SDK aborta a los 25 s).
create function reserva_ai_ventana() returns interval
language sql immutable parallel safe as $$ select interval '100 seconds' $$;

alter table reserva_ai enable row level security;

create policy reserva_select on reserva_ai
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy reserva_insert on reserva_ai
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );
-- Se libera la PROPIA reserva; las ajenas, solo cuando ya caducaron (recolección de
-- basura de un proceso muerto). Sin esto, un curador podría liberar la reserva viva de
-- otro y devolver el presupuesto al mismo agujero que esta tabla cierra.
create policy reserva_delete on reserva_ai
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and (creado_por = app_user_id() or creado_en <= now() - reserva_ai_ventana())
  );

-- Sin UPDATE: una reserva no se edita, se consume o se libera.
grant select, insert, delete on reserva_ai to designio_app;

-- ── Grants mínimos (UPDATE por columna: solo la transición y su materialización) ──
grant select, insert on propuesta_ai to designio_app;
-- Fuera del grant y por tanto sin superficie: capacidad, destino, item_id, reto_id,
-- contenido_original, confianza, es_simulacion, modelo, prompt_version, alcance_resumen,
-- latencia_ms, origen_key, llamada_id, tokens_entrada, tokens_salida, costo_usd,
-- creado_por — el lineage y el original son inmutables (SYS-17/19), y el coste de una
-- llamada ya hecha no se reescribe.
-- `revisada_en` tampoco: lo estampa el guard, no el caller.
grant update (estado, contenido, revisada_por, evidencia_id, criterio_id)
  on propuesta_ai to designio_app;
