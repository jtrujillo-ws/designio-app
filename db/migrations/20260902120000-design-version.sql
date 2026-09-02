-- SPEC-06 (ADR-0004) — La cadena de trazabilidad y los cuatro objetos de resultado:
-- design version con elementos de cambio, releases PARCIALES, effective state con
-- desviaciones y la conciliación que bloquea G7.
--
-- El diff NO tiene tabla (RF-06.2, y la tabla de decisiones tácticas del domain model):
-- se CALCULA contra el effective state vigente del servicio. Almacenarlo sería guardar
-- una respuesta que caduca en cuanto cambia cualquiera de sus dos lados.
--
-- `release` es palabra clave NO RESERVADA en Postgres (solo lo es en `release savepoint`)
-- y sirve como nombre de tabla sin comillas — verificado en 16. Se usa el nombre canónico
-- del agregado (I1/SYS-09: el vocabulario de resultados no se renombra) en vez de un
-- sinónimo; «Entrega» es el nombre del CONTEXTO (CTX-05), y es el que lleva el módulo
-- TypeScript (src/lib/entrega/), no el objeto.
--
-- Mismo patrón de la casa: FKs compuestas (id, workspace_id), RLS desde el día 1,
-- atribución fijada en la política, transiciones exigidas por el WITH CHECK y efectos
-- (sellos, cambios de estado y eventos) dentro del guard que decide, para que el SQL
-- crudo los produzca igual.

-- ── Design version: qué se decidió construir o cambiar (CTX-04, RF-06.1) ──
-- Estados de §3.3: borrador → aprobada (inmutable) → superada.
create table design_version (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  proyecto_id uuid not null,
  -- El servicio cuyo effective state cambia: es el eje del diff (RF-06.2) y del estado
  -- vigente (RF-06.10). Va aquí y no derivado del reto porque un reto afecta a varios
  -- servicios (n:m) y una design version cambia UNO.
  servicio_id uuid not null,
  -- El grafo to-be que esta versión aprueba. Opcional en borrador (la DV puede abrirse
  -- antes de que el to-be exista); OBLIGATORIO al aprobar, porque aprobar congela su
  -- snapshot (RF-06.3 / RF-05.8).
  journey_id uuid,
  codigo text not null check (codigo ~ '^DV-[0-9]+$'),
  titulo text not null check (btrim(titulo) <> ''),
  resumen text not null default '',
  estado text not null default 'borrador'
    check (estado in ('borrador', 'aprobada', 'superada')),
  -- SYS-05: «toda modificación posterior crea una nueva versión y marca la anterior como
  -- superada». La versión NUEVA declara a cuál supera; al aprobarse, aquella pasa a
  -- 'superada' en la misma transacción.
  supera_a uuid,
  snapshot_id uuid,
  aprobada_por uuid references usuario(id),
  aprobada_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, codigo),
  foreign key (proyecto_id, workspace_id) references proyecto (id, workspace_id),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id),
  foreign key (journey_id, workspace_id) references journey (id, workspace_id),
  foreign key (supera_a, workspace_id) references design_version (id, workspace_id),
  foreign key (snapshot_id, workspace_id) references journey_snapshot (id, workspace_id),
  -- Aprobar es inseparable de congelar: sin snapshot no hay aprobación (RF-06.3).
  check (estado = 'borrador'
    or (aprobada_por is not null and aprobada_en is not null and snapshot_id is not null)),
  check (estado <> 'borrador'
    or (aprobada_por is null and aprobada_en is null and snapshot_id is null)),
  check (supera_a is null or supera_a <> id)
);
create index design_version_proyecto_idx on design_version (workspace_id, proyecto_id);
-- SYS-05 en el MODELO, no en el servicio: un servicio tiene como mucho UNA design
-- version aprobada. Aprobar DV-2 sin superar a DV-1 no es un flujo mal implementado:
-- es una fila que la base rechaza.
create unique index design_version_vigente_uniq
  on design_version (workspace_id, servicio_id) where estado = 'aprobada';
-- La historia es una CADENA, no un árbol: una design version tiene como mucho una
-- sucesora. Parcial sobre las no-borrador a propósito — dos borradores pueden competir
-- por suceder a la misma DV (y uno quedarse en el camino), pero solo uno llega a
-- aprobarse. Sin el parcial, un borrador abandonado bloquearía la sucesión para siempre
-- y no hay DELETE que lo saque de en medio.
create unique index design_version_sucesion_uniq
  on design_version (workspace_id, supera_a)
  where supera_a is not null and estado <> 'borrador';

-- ── Elemento de cambio: la unidad del diff (RF-06.1) ──
-- Tipado a propósito (§3.2 lo enumera): sin tipo, el diff es una lista de frases y la
-- conciliación no puede agrupar ni comparar entre retos.
create table elemento_cambio (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  design_version_id uuid not null,
  tipo text not null check (tipo in (
    'touchpoint', 'proceso-backstage', 'canal', 'politica', 'sistema', 'paso', 'rol')),
  -- Lo que el autor DECLARA hacer. El diff (RF-06.2) contrasta esta declaración contra
  -- el effective state vigente y señala las que no cuadran: por eso se guarda la
  -- declaración y no el resultado del contraste.
  operacion text not null check (operacion in ('agrega', 'modifica', 'retira')),
  titulo text not null check (btrim(titulo) <> ''),
  detalle text not null default '',
  -- El nodo del grafo (SPEC-05) que materializa el cambio: es lo que permite responder
  -- «qué pasos del journey afectó RL-1» (§19.7, criterio de aceptación 5).
  nodo_id uuid,
  orden integer not null default 0,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (design_version_id, workspace_id) references design_version (id, workspace_id),
  foreign key (nodo_id, workspace_id) references journey_nodo (id, workspace_id)
);
create index elemento_cambio_dv_idx on elemento_cambio (workspace_id, design_version_id, orden);
create index elemento_cambio_nodo_idx on elemento_cambio (workspace_id, nodo_id);

-- Qué MOTIVA el elemento (RF-06.1). Dos tablas y no una columna polimórfica: cada
-- enlace tiene su FK compuesta real, y la navegación hacia atrás (RF-06.9) es un join,
-- no un case.
create table elemento_decision (
  elemento_id uuid not null,
  decision_id uuid not null,
  workspace_id uuid not null references workspace(id),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  primary key (elemento_id, decision_id),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  foreign key (decision_id, workspace_id) references decision (id, workspace_id)
);
create index elemento_decision_dec_idx on elemento_decision (workspace_id, decision_id);

create table elemento_insight (
  elemento_id uuid not null,
  insight_id uuid not null,
  workspace_id uuid not null references workspace(id),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  primary key (elemento_id, insight_id),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  foreign key (insight_id, workspace_id) references insight (id, workspace_id)
);
create index elemento_insight_ins_idx on elemento_insight (workspace_id, insight_id);

-- ── Release: subconjunto de una design version aprobada (CTX-05, SYS-06) ──
-- Estados de §3.3: planificado → desplegado → verificado.
create table release (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  -- SYS-06: EXACTAMENTE una design version, y aprobada (lo exige la política de insert).
  design_version_id uuid not null,
  codigo text not null check (codigo ~ '^RL-[0-9]+$'),
  titulo text not null check (btrim(titulo) <> ''),
  -- RF-06.4: dueño y fecha. Sin dueño, «parcialidad explícita» es una lista sin nadie
  -- que responda por ella.
  responsable text not null check (btrim(responsable) <> ''),
  fecha_objetivo date not null,
  estado text not null default 'planificado'
    check (estado in ('planificado', 'desplegado', 'verificado')),
  -- Fecha REAL del despliegue (RF-06.5), calendárica: la pone quien lo registra porque
  -- puede ser anterior al registro; el guard impide que sea futura.
  desplegado_en date,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, codigo),
  foreign key (design_version_id, workspace_id) references design_version (id, workspace_id),
  check (estado = 'planificado' or desplegado_en is not null),
  check (estado <> 'planificado' or desplegado_en is null)
);
create index release_dv_idx on release (workspace_id, design_version_id);

-- ── Parcialidad explícita (SYS-06, §19.5) ──
-- La PK es el ELEMENTO, no el par: cada elemento va a como mucho UN release, y eso es
-- una constraint, no una convención del servicio. El «exactamente uno» de RF-06.4 lo
-- completa G7, que no aprueba con elementos sin estado conocido.
create table release_elemento (
  elemento_id uuid primary key,
  release_id uuid not null,
  workspace_id uuid not null references workspace(id),
  -- Por qué este elemento cae en ESTE release y no antes (criterio de aceptación 2:
  -- «pendiente asignado a RL-2 con su razón»). Opcional: la razón obligatoria es la de
  -- la desviación (SYS-07), no la del plan.
  razon text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  foreign key (release_id, workspace_id) references release (id, workspace_id)
);
create index release_elemento_rel_idx on release_elemento (workspace_id, release_id);

-- ── Effective state: qué quedó funcionando (CTX-05, RF-06.6) ──
-- Cada constatación es un REGISTRO NUEVO (historia, no mutación); «vigente» es el más
-- reciente por servicio (RF-06.10).
create table effective_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  servicio_id uuid not null,
  release_id uuid not null,
  codigo text not null check (codigo ~ '^ES-[0-9]+$'),
  resumen text not null default '',
  constatado_por uuid not null references usuario(id),
  constatado_en date not null,
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, codigo),
  -- Release "1" → "0..1" EffectiveState (domain model): un release se constata una vez.
  unique (release_id),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id),
  foreign key (release_id, workspace_id) references release (id, workspace_id)
);
create index effective_state_servicio_idx
  on effective_state (workspace_id, servicio_id, constatado_en desc);

-- ── Constatación por elemento, con la desviación dentro (RF-06.6, SYS-07) ──
-- La «Desviación» del modelo NO es otra tabla: es una constatación cuyo resultado no es
-- 'como-aprobado'. Separarlas permitiría constatar un elemento como desviado sin
-- desviación, que es justo el estado que SYS-07 prohíbe.
create table constatacion (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  effective_state_id uuid not null,
  elemento_id uuid not null,
  resultado text not null check (resultado in ('como-aprobado', 'desviado', 'no-implementado')),
  que_quedo_distinto text not null default '',
  razon text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (effective_state_id, elemento_id),
  foreign key (effective_state_id, workspace_id) references effective_state (id, workspace_id),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  -- SYS-07 como CHECK y no como validación del servicio: toda desviación registra el
  -- elemento (la FK) y una razón NO VACÍA. btrim porque el whitespace no es una razón.
  check (resultado = 'como-aprobado'
    or (btrim(que_quedo_distinto) <> '' and btrim(razon) <> '')),
  -- Y al revés: «como aprobado» con texto de desviación sería una desviación escondida.
  check (resultado <> 'como-aprobado'
    or (btrim(que_quedo_distinto) = '' and btrim(razon) = ''))
);
create index constatacion_es_idx on constatacion (workspace_id, effective_state_id);
create index constatacion_elemento_idx on constatacion (workspace_id, elemento_id);

-- ══ RLS ══
-- Lectura: todo miembro. La cadena evidencia→resultado es lo que el cliente audita; un
-- effective state que el sponsor no puede leer no demuestra nada.
-- Escritura: el LEAD opera el método (§13.2). Los elementos de cambio los escriben los
-- curadores (lead/diseñador: producen el artefacto); el plan de releases, el despliegue
-- y la constatación son del lead. El sponsor aprueba GATES (G5/G6/G7), no objetos: su
-- palanca sobre una design version es no aprobar el gate que la certifica.

alter table design_version enable row level security;
alter table elemento_cambio enable row level security;
alter table elemento_decision enable row level security;
alter table elemento_insight enable row level security;
alter table release enable row level security;
alter table release_elemento enable row level security;
alter table effective_state enable row level security;
alter table constatacion enable row level security;

create policy design_version_select on design_version
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy elemento_cambio_select on elemento_cambio
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy elemento_decision_select on elemento_decision
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy elemento_insight_select on elemento_insight
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy release_select on release
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy release_elemento_select on release_elemento
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy effective_state_select on effective_state
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy constatacion_select on constatacion
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- La DV nace en BORRADOR y sin sellos: la política lo exige, así que no existe el camino
-- de colar una versión ya «aprobada» sin pasar por la transición que congela.
create policy design_version_insert on design_version
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'borrador'
    and aprobada_por is null
    and aprobada_en is null
    and snapshot_id is null
  );

-- Aprobar: borrador → aprobada, atribuida, CON snapshot congelado. El snapshot se
-- inserta en una sentencia anterior de la misma transacción, así que este predicado ya
-- lo ve: la congelación de RF-06.3 es parte del permiso, no una cortesía del servicio.
create policy design_version_aprobar on design_version
  for update
  using (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  )
  with check (
    estado = 'aprobada'
    and aprobada_por = app_user_id()
    and aprobada_en is not null
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from journey_snapshot s
      where s.id = design_version.snapshot_id
        and s.workspace_id = design_version.workspace_id
        and s.journey_id = design_version.journey_id)
  );

-- Superar: aprobada → superada. Es el otro lado de SYS-05 y lo ejecuta la misma
-- transacción que aprueba la sucesora.
create policy design_version_superar on design_version
  for update
  using (
    estado = 'aprobada'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  )
  with check (
    estado = 'superada'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );

-- Criterio de aceptación 1: sobre una DV aprobada, editar un elemento se RECHAZA. No es
-- un chequeo del servicio con un mensaje amable — es que las tres políticas del elemento
-- solo alcanzan design versions en borrador.
create policy elemento_cambio_insert on elemento_cambio
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_cambio_update on elemento_cambio
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  )
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_cambio_delete on elemento_cambio
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  );

create policy elemento_decision_insert on elemento_decision
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_decision.elemento_id
        and ec.workspace_id = elemento_decision.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_decision_delete on elemento_decision
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_decision.elemento_id
        and ec.workspace_id = elemento_decision.workspace_id
        and dv.estado = 'borrador')
  );

create policy elemento_insight_insert on elemento_insight
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_insight.elemento_id
        and ec.workspace_id = elemento_insight.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_insight_delete on elemento_insight
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_insight.elemento_id
        and ec.workspace_id = elemento_insight.workspace_id
        and dv.estado = 'borrador')
  );

-- SYS-06 en la política de alta: un release solo cuelga de una design version APROBADA.
-- Nace planificado y sin fecha real (las filas nacen en su estado inicial).
create policy release_insert on release
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and estado = 'planificado'
    and desplegado_en is null
    and exists (select 1 from design_version dv
      where dv.id = release.design_version_id
        and dv.workspace_id = release.workspace_id
        and dv.estado = 'aprobada')
  );
create policy release_desplegar on release
  for update
  using (estado = 'planificado' and workspace_role(app_user_id(), workspace_id) = 'lead-boutique')
  with check (
    estado = 'desplegado'
    and desplegado_en is not null
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );
create policy release_verificar on release
  for update
  using (estado = 'desplegado' and workspace_role(app_user_id(), workspace_id) = 'lead-boutique')
  with check (
    estado = 'verificado'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );

-- El alcance de un release se declara mientras está PLANIFICADO. Una vez desplegado,
-- mover elementos dentro o fuera reescribiría qué se implementó.
create policy release_elemento_insert on release_elemento
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and exists (select 1 from release r
      where r.id = release_elemento.release_id
        and r.workspace_id = release_elemento.workspace_id
        and r.estado = 'planificado')
  );
create policy release_elemento_delete on release_elemento
  for delete using (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from release r
      where r.id = release_elemento.release_id
        and r.workspace_id = release_elemento.workspace_id
        and r.estado = 'planificado')
  );

-- Constatar exige un release DESPLEGADO: no se certifica lo que no salió. Sin update ni
-- delete en ninguna de las dos tablas: la constatación es historia (RF-06.6).
create policy effective_state_insert on effective_state
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and constatado_por = app_user_id()
    and exists (select 1 from release r
      where r.id = effective_state.release_id
        and r.workspace_id = effective_state.workspace_id
        and r.estado = 'desplegado')
  );
create policy constatacion_insert on constatacion
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and exists (select 1 from effective_state es
      join release r on r.id = es.release_id and r.workspace_id = es.workspace_id
      where es.id = constatacion.effective_state_id
        and es.workspace_id = constatacion.workspace_id
        and r.estado = 'desplegado')
  );

-- ══ Guards ══

-- El nodo que materializa un elemento tiene que ser del grafo que la design version
-- aprueba. La FK compuesta garantiza el workspace y nada más: sin esto, un elemento de
-- la DV del servicio A podría apuntar a un paso del journey del servicio B y la
-- respuesta a «qué pasos afectó RL-1» saldría mintiendo.
create function elemento_cambio_nodo_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_journey uuid;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.nodo_id is null then
    return new;
  end if;
  select dv.journey_id into v_journey from design_version dv
    where dv.id = new.design_version_id and dv.workspace_id = new.workspace_id;
  if v_journey is null then
    raise exception 'para enlazar un nodo, la design version debe declarar su journey to-be';
  end if;
  if not exists (select 1 from journey_nodo n
    where n.id = new.nodo_id and n.workspace_id = new.workspace_id
      and n.journey_id = v_journey) then
    raise exception 'el nodo enlazado no pertenece al journey de esta design version';
  end if;
  return new;
end $$;
create trigger elemento_cambio_nodo
  before insert or update on elemento_cambio
  for each row execute function elemento_cambio_nodo_guard();
revoke execute on function elemento_cambio_nodo_guard() from public;

-- Lo que MOTIVA un elemento tiene que ser citable de verdad: misma doctrina que
-- checklist_objeto_citable_guard (la decisión, del proyecto de la DV; el insight,
-- validado). El picker filtra las dos cosas; el endpoint acepta cualquier uuid.
create function elemento_motivo_citable_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'elemento_decision' then
    if not exists (
      select 1 from decision d
      join elemento_cambio ec on ec.id = new.elemento_id and ec.workspace_id = new.workspace_id
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where d.id = new.decision_id and d.workspace_id = new.workspace_id
        and d.proyecto_id = dv.proyecto_id) then
      raise exception 'la decisión citada no existe en el proyecto de esta design version';
    end if;
  else
    if not exists (select 1 from insight i
      where i.id = new.insight_id and i.workspace_id = new.workspace_id
        and i.estado = 'validado') then
      raise exception 'el insight citado no existe o todavía no está validado';
    end if;
  end if;
  return new;
end $$;
create trigger elemento_decision_citable
  before insert on elemento_decision
  for each row execute function elemento_motivo_citable_guard();
create trigger elemento_insight_citable
  before insert on elemento_insight
  for each row execute function elemento_motivo_citable_guard();
revoke execute on function elemento_motivo_citable_guard() from public;

-- Alta de la design version: rastro con actor y rol del MISMO snapshot que la autorizó.
-- El pre-chequeo deja pasar al owner (seed/backfill) sin fabricar eventos anónimos.
create function design_version_alta_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'DesignVersionBorrador',
      jsonb_build_object('designVersionId', new.id, 'codigo', new.codigo,
                         'servicioId', new.servicio_id, 'proyectoId', new.proyecto_id),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger design_version_alta
  after insert on design_version
  for each row when (new.estado = 'borrador')
  execute function design_version_alta_auditoria();
revoke execute on function design_version_alta_auditoria() from public;

-- SYS-05 en la transición. Los efectos van AQUÍ y no en el servicio para que el UPDATE
-- crudo los produzca igual: sello temporal, exigencias de aprobación y evento.
create function design_version_transicion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.estado = old.estado then
    return new;
  end if;
  if (old.estado, new.estado) not in (('borrador', 'aprobada'), ('aprobada', 'superada')) then
    raise exception 'transición de design version ilegal: % → %', old.estado, new.estado;
  end if;

  if new.estado = 'aprobada' then
    -- El sello lo pone la BASE: un update directo no puede retro ni post-datar lo que
    -- desde este instante es inmutable.
    new.aprobada_en := now();
    if new.journey_id is null then
      raise exception 'aprobar congela el snapshot del to-be: la design version debe declarar su journey';
    end if;
    if not exists (select 1 from journey j
      where j.id = new.journey_id and j.workspace_id = new.workspace_id
        and j.tipo = 'to-be' and j.servicio_id = new.servicio_id) then
      raise exception 'el journey de la design version debe ser el to-be de su servicio';
    end if;
    -- El journey guarda su proyecto desde SPEC-05 (es opcional). Si lo declara, tiene
    -- que ser el mismo: dos proyectos del mismo reto tocando el mismo servicio podrían
    -- congelar cada uno el grafo del otro sin que ninguna FK se queje.
    if exists (select 1 from journey j
      where j.id = new.journey_id and j.workspace_id = new.workspace_id
        and j.proyecto_id is not null and j.proyecto_id <> new.proyecto_id) then
      raise exception 'el journey to-be está anclado a otro proyecto';
    end if;
    -- Una design version sin elementos no es una design version: no hay diff, no hay
    -- plan de releases y G7 se aprobaría vacuamente.
    if not exists (select 1 from elemento_cambio ec
      where ec.design_version_id = new.id and ec.workspace_id = new.workspace_id) then
      raise exception 'no se puede aprobar una design version sin elementos de cambio';
    end if;
    if new.supera_a is not null and not exists (select 1 from design_version dv
      where dv.id = new.supera_a and dv.workspace_id = new.workspace_id
        and dv.servicio_id = new.servicio_id and dv.estado = 'superada') then
      raise exception 'la design version superada debe quedar marcada como superada en la misma transacción';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'DesignVersionAprobada',
        jsonb_build_object('designVersionId', new.id, 'codigo', new.codigo,
                           'servicioId', new.servicio_id, 'snapshotId', new.snapshot_id,
                           'superaA', new.supera_a),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  else
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'DesignVersionSuperada',
        jsonb_build_object('designVersionId', new.id, 'codigo', new.codigo,
                           'servicioId', new.servicio_id),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger design_version_transicion
  before update on design_version
  for each row execute function design_version_transicion_guard();
revoke execute on function design_version_transicion_guard() from public;

-- El release nace planificado y deja su rastro; la DV aprobada la exige la política.
create function release_alta_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'ReleasePlanificado',
      jsonb_build_object('releaseId', new.id, 'codigo', new.codigo,
                         'designVersionId', new.design_version_id,
                         'responsable', new.responsable,
                         'fechaObjetivo', to_char(new.fecha_objetivo, 'YYYY-MM-DD')),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger release_alta
  after insert on release
  for each row execute function release_alta_auditoria();
revoke execute on function release_alta_auditoria() from public;

-- Un elemento solo entra en un release de SU design version. La FK compuesta garantiza
-- el workspace: sin esto, RL-1 de DV-1 podría «incluir» un elemento de DV-2 y la
-- conciliación de las dos saldría cuadrada por elementos que nunca les pertenecieron.
create function release_elemento_misma_dv_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if not exists (
    select 1 from release r
    join elemento_cambio ec on ec.id = new.elemento_id and ec.workspace_id = new.workspace_id
    where r.id = new.release_id and r.workspace_id = new.workspace_id
      and r.design_version_id = ec.design_version_id) then
    raise exception 'el elemento no pertenece a la design version de este release';
  end if;
  return new;
end $$;
create trigger release_elemento_misma_dv
  before insert on release_elemento
  for each row execute function release_elemento_misma_dv_guard();
revoke execute on function release_elemento_misma_dv_guard() from public;

-- Transiciones del release (§3.3) con sus exigencias y sus eventos dentro del guard.
create function release_transicion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.estado = old.estado then
    return new;
  end if;
  if (old.estado, new.estado) not in (
    ('planificado', 'desplegado'),
    ('desplegado', 'verificado')
  ) then
    raise exception 'transición de release ilegal: % → %', old.estado, new.estado;
  end if;

  if new.estado = 'desplegado' then
    if new.desplegado_en > current_date then
      raise exception 'la fecha real de despliegue no puede ser futura';
    end if;
    -- SYS-06: «declara explícitamente qué elementos incluye». Un release vacío
    -- desplegado no declara nada y dejaría la conciliación cuadrando sobre el aire.
    if not exists (select 1 from release_elemento re
      where re.release_id = new.id and re.workspace_id = new.workspace_id) then
      raise exception 'un release sin elementos declarados no se despliega (SYS-06)';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'ReleaseDesplegado',
        jsonb_build_object('releaseId', new.id, 'codigo', new.codigo,
                           'desplegadoEn', to_char(new.desplegado_en, 'YYYY-MM-DD')),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  else
    -- RF-06.6: «por cada elemento desplegado, constatación de cómo quedó». La
    -- constatación se inserta en sentencias anteriores de la misma transacción, así que
    -- este predicado ya las ve; por SQL crudo, verificar sin constatar aborta.
    if exists (
      select 1 from release_elemento re
      where re.release_id = new.id and re.workspace_id = new.workspace_id
        and not exists (
          select 1 from constatacion c
          join effective_state es on es.id = c.effective_state_id and es.workspace_id = c.workspace_id
          where c.elemento_id = re.elemento_id and c.workspace_id = re.workspace_id
            and es.release_id = new.id)) then
      raise exception 'verificar exige constatar TODOS los elementos del release (RF-06.6)';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'ReleaseVerificado',
        jsonb_build_object('releaseId', new.id, 'codigo', new.codigo),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger release_transicion
  before update on release
  for each row execute function release_transicion_guard();
revoke execute on function release_transicion_guard() from public;

-- El effective state es del servicio de la design version del release: encadenarlo a
-- otro servicio rompería el «vigente por servicio» de RF-06.10 sin que ninguna FK se
-- queje. La fecha de constatación tampoco es futura.
create function effective_state_alta_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.constatado_en > current_date then
    raise exception 'la fecha de constatación no puede ser futura';
  end if;
  if not exists (
    select 1 from release r
    join design_version dv on dv.id = r.design_version_id and dv.workspace_id = r.workspace_id
    where r.id = new.release_id and r.workspace_id = new.workspace_id
      and dv.servicio_id = new.servicio_id) then
    raise exception 'el effective state es del servicio de la design version del release';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'EffectiveStateConstatado',
      jsonb_build_object('effectiveStateId', new.id, 'codigo', new.codigo,
                         'servicioId', new.servicio_id, 'releaseId', new.release_id,
                         'constatadoEn', to_char(new.constatado_en, 'YYYY-MM-DD')),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger effective_state_alta
  before insert on effective_state
  for each row execute function effective_state_alta_guard();
revoke execute on function effective_state_alta_guard() from public;

-- Solo se constata lo que ESTE release incluyó: una constatación sobre un elemento
-- ajeno cerraría el tablero de conciliación con trabajo que nadie desplegó.
-- La desviación deja su propio evento (SYS-07: el elemento y su razón, a la vista).
create function constatacion_alcance_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if not exists (
    select 1 from effective_state es
    join release_elemento re on re.release_id = es.release_id and re.workspace_id = es.workspace_id
    where es.id = new.effective_state_id and es.workspace_id = new.workspace_id
      and re.elemento_id = new.elemento_id) then
    raise exception 'ese elemento no está incluido en el release que se constata';
  end if;
  if new.resultado <> 'como-aprobado' then
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'DesviacionRegistrada',
        jsonb_build_object('effectiveStateId', new.effective_state_id,
                           'elementoId', new.elemento_id, 'resultado', new.resultado,
                           'queQuedoDistinto', new.que_quedo_distinto, 'razon', new.razon),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger constatacion_alcance
  before insert on constatacion
  for each row execute function constatacion_alcance_guard();
revoke execute on function constatacion_alcance_guard() from public;

-- ══ G7 no pasa con la conciliación incompleta (RF-06.7, criterio de aceptación 4) ══
-- El guard de suficiencia se REESCRIBE ENTERO (create or replace no fusiona): esta es la
-- versión vigente —checklist sin pendientes y no vacío, ítems cumplidos con decisiones
-- vigentes, orden de gates, criterios de G0 y arquetipos de G2— más la rama de G7.
--
-- La regla NO se duplica en el WITH CHECK de gate_update_aprobar, igual que la de G2: el
-- predicado de la política se quedó con lo que se comprueba mirando el gate y su
-- checklist. El motivo es que la política no puede DECIR por qué falla, y aquí el porqué
-- es el producto: «estos tres elementos no tienen constatación». El guard corre antes que
-- el WITH CHECK y aborta con el mensaje; que la política no lo repita no abre un camino
-- (el trigger es de la tabla, no del rol).
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
    -- El sello temporal lo pone la BASE, no el caller: un update directo no puede
    -- retro ni post-datar el registro inmutable.
    new.aprobado_en := now();
    if exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'pendiente') then
      raise exception 'no se puede aprobar: checklist con pendientes';
    end if;
    if not exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id) then
      raise exception 'no se puede aprobar: el gate no tiene checklist instanciado';
    end if;
    -- Un ítem YA cumplido cuya decisión pasó a 'en-revision' por una reapertura seguía
    -- contando como suficiencia: el gate se aprobaba sobre razonamiento cuestionado. Se
    -- re-chequea al aprobar en vez de resetear los ítems al reabrir — resetear tiraría
    -- trabajo que quizá sigue en pie, y revalidar la decisión desbloquea el gate sin
    -- tocar el checklist.
    if exists (select 1 from checklist_item ci
      join decision d on d.id = ci.decision_id and d.workspace_id = ci.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and d.estado <> 'vigente') then
      raise exception 'no se puede aprobar: hay ítems cumplidos con decisiones en revisión';
    end if;
    if exists (select 1 from gate_instancia g2
      where g2.proyecto_id = new.proyecto_id and g2.workspace_id = new.workspace_id
        and g2.numero < new.numero and g2.estado <> 'aprobado') then
      raise exception 'no se puede aprobar G%: los gates anteriores deben aprobarse primero', new.numero;
    end if;
    if new.numero = 0 then
      if not exists (select 1 from criterio_exito c
        join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        where c.reto_id = p.reto_id and c.workspace_id = new.workspace_id) then
        raise exception 'no se puede aprobar G0: sin criterios de éxito (SYS-22)';
      end if;
      if exists (select 1 from criterio_exito c
        join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        where c.reto_id = p.reto_id and c.workspace_id = new.workspace_id
          and (c.ventana_dias is null
               or btrim(c.kpi) = '' or btrim(c.definicion) = '' or btrim(c.objetivo) = ''
               or ((nullif(btrim(c.linea_base_valor), '') is null or c.linea_base_fecha is null)
                   and btrim(c.linea_base_plan) = ''))) then
        raise exception 'no se puede aprobar G0: criterios incompletos (SYS-22)';
      end if;
    end if;
    -- G2 cierra el entendimiento: ningún arquetipo puede seguir siendo hipótesis, y
    -- los confirmados ya traen su evidencia (garantizada por su propio guard).
    if new.numero = 2 and exists (select 1 from arquetipo a
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where a.reto_id = p.reto_id and a.workspace_id = new.workspace_id
        and a.estado = 'hipotesis') then
      raise exception 'no se puede aprobar G2: hay arquetipos sin confirmar ni refutar (RF-04.11)';
    end if;
    -- G7 cierra la implementación: el tablero de conciliación no puede tener NINGÚN
    -- elemento en estado desconocido (RF-06.7). Desconocido es la ausencia de
    -- constatación: sin release asignado, en un release aún planificado, o desplegado
    -- sin constatar. Un elemento constatado como 'no-implementado' NO bloquea — está
    -- explicado, que es lo que el gate exige (honestidad, no perfección).
    -- Solo las design versions APROBADAS: los elementos de una superada son historia de
    -- un ciclo anterior, y exigirles conciliación ataría G7 a decisiones ya reemplazadas.
    if new.numero = 7 and exists (
      select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where dv.proyecto_id = new.proyecto_id and dv.workspace_id = new.workspace_id
        and dv.estado = 'aprobada'
        and not exists (
          select 1 from constatacion c
          join effective_state es on es.id = c.effective_state_id and es.workspace_id = c.workspace_id
          join release r on r.id = es.release_id and r.workspace_id = es.workspace_id
          where c.elemento_id = ec.id and c.workspace_id = ec.workspace_id
            and r.estado = 'verificado')
    ) then
      raise exception 'no se puede aprobar G7: hay elementos de la design version en estado desconocido (RF-06.7)';
    end if;
    -- Efectos INSEPARABLES de la transición, también para el UPDATE directo: la etapa
    -- homóloga se completa y el evento inmutable queda con el actor y su rol del
    -- MISMO snapshot. aprobarGate ya no los duplica: esta es la única fuente.
    update etapa_instancia set estado = 'completada'
      where proyecto_id = new.proyecto_id and workspace_id = new.workspace_id
        and numero = new.numero;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'GateAprobado',
        jsonb_build_object('gateId', new.id, 'proyectoId', new.proyecto_id,
                           'numero', new.numero),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ══ Grants mínimos (UPDATE por columnas) ══
grant select, insert on design_version, elemento_cambio to designio_app;
grant select, insert on elemento_decision, elemento_insight to designio_app;
grant select, insert on release, release_elemento to designio_app;
grant select, insert on effective_state, constatacion to designio_app;
-- La aprobación mueve estado, autor y snapshot. `aprobada_en` NO está: lo escribe solo
-- el guard, así que la promesa «el sello lo pone la base» es estructural, no una
-- disciplina del servicio.
grant update (estado, aprobada_por, snapshot_id) on design_version to designio_app;
-- El release mueve estado y la fecha real de despliegue; nunca su código, su dueño ni
-- su design version (eso sería otro release).
grant update (estado, desplegado_en) on release to designio_app;
-- El elemento se corrige mientras la DV está en borrador; jamás cambia de design
-- version (la política ya lo impediría; el grant lo hace imposible de intentar).
grant update (tipo, operacion, titulo, detalle, nodo_id, orden) on elemento_cambio to designio_app;
grant delete on elemento_cambio, elemento_decision, elemento_insight to designio_app;
grant delete on release_elemento to designio_app;
-- Sin DELETE en design_version, release, effective_state ni constatacion: los cuatro
-- objetos de resultado son el registro de lo que pasó.
