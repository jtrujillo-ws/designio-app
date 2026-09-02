-- SPEC-03 (RF-03.9) + SPEC-04 (RF-04.9/04.10/04.11) — la cadena de razonamiento:
-- evidencia → insight (afirmaciones con citas) → decisión aprobada en un gate, más los
-- arquetipos del reto y la reapertura trazada de etapas.
--
-- Cierra el hueco que dejó la migración del método: sus ítems de checklist solo podían
-- enlazar evidencia («insights/decisiones llegan con sus specs»); ahora enlazan los tres
-- tipos de objeto real que RF-04.5 exige.
--
-- Mismo patrón: FKs compuestas (id, workspace_id), RLS día 1, autoría fijada en la
-- política, transiciones exigidas por WITH CHECK y guards que ponen el rastro en la
-- propia sentencia que decide.

-- ── Insight: interpretación con afirmaciones soportadas por citas (RF-03.9, I3) ──
-- El insight es del WORKSPACE (no del reto): nace de la investigación y se enlaza donde
-- se usa (ítem de gate, decisión). Nace 'propuesto'; validarlo exige que toda afirmación
-- no marcada como hipótesis tenga al menos una cita.
create table insight (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  titulo text not null check (btrim(titulo) <> ''),
  resumen text not null default '',
  estado text not null default 'propuesto' check (estado in ('propuesto', 'validado')),
  validado_por uuid references usuario(id),
  validado_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  check (estado = 'propuesto' or (validado_por is not null and validado_en is not null))
);
create index insight_ws_idx on insight (workspace_id, creado_en desc);

-- Afirmación: la unidad que se sostiene (o no) con citas. `es_hipotesis` marca la
-- extrapolación honesta — no exige cita, pero queda etiquetada como tal para siempre.
create table afirmacion (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  insight_id uuid not null,
  orden integer not null,
  texto text not null check (btrim(texto) <> ''),
  es_hipotesis boolean not null default false,
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (insight_id, orden),
  foreign key (insight_id, workspace_id) references insight (id, workspace_id)
);
create index afirmacion_insight_idx on afirmacion (workspace_id, insight_id);

-- Cita: el enlace verificable afirmación → evidencia CON localización exacta (I3: llegar
-- al fragmento, no al documento). El fragmento se copia para que la lista sea legible
-- sin abrir cada evidencia; la evidencia sigue siendo la fuente de verdad.
create table cita (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  afirmacion_id uuid not null,
  evidencia_id uuid not null,
  fragmento text not null check (btrim(fragmento) <> ''),
  -- Sin localización la cita apunta al documento y no al punto: deja de cumplir su
  -- promesa (volver al fragmento exacto) justo cuando alguien la audita.
  localizacion text not null check (btrim(localizacion) <> ''),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (afirmacion_id, workspace_id) references afirmacion (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id)
);
create index cita_afirmacion_idx on cita (workspace_id, afirmacion_id);

-- Contradicción: evidencia que CONTRADICE al insight. Se registra y se muestra siempre;
-- jamás bloquea ni se oculta (RF-03.9) — el juicio es humano, la visibilidad obligatoria.
create table contradiccion (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  insight_id uuid not null,
  evidencia_id uuid not null,
  descripcion text not null check (btrim(descripcion) <> ''),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (insight_id, evidencia_id),
  foreign key (insight_id, workspace_id) references insight (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id)
);
create index contradiccion_insight_idx on contradiccion (workspace_id, insight_id);

-- ── Decisión aprobada en un gate (RF-04.10) ──
-- Toda decisión nace con al menos un insight que la sostiene (lo exige el servicio en
-- una sola sentencia) y cita el gate en que se tomó. Reabrir aguas arriba la marca
-- 'en-revision' (SYS-10): la historia no se borra, se cuestiona.
create table decision (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  proyecto_id uuid not null,
  gate_id uuid not null,
  tipo text not null check (tipo in ('pasa-muere', 'diseno', 'alcance', 'otra')),
  titulo text not null check (btrim(titulo) <> ''),
  fundamento text not null default '',
  estado text not null default 'vigente' check (estado in ('vigente', 'en-revision')),
  decidido_por uuid not null references usuario(id),
  decidido_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (proyecto_id, workspace_id) references proyecto (id, workspace_id),
  foreign key (gate_id, workspace_id) references gate_instancia (id, workspace_id)
);
create index decision_proyecto_idx on decision (workspace_id, proyecto_id);

create table decision_insight (
  decision_id uuid not null,
  insight_id uuid not null,
  workspace_id uuid not null references workspace(id),
  primary key (decision_id, insight_id),
  foreign key (decision_id, workspace_id) references decision (id, workspace_id),
  foreign key (insight_id, workspace_id) references insight (id, workspace_id)
);
create index decision_insight_ins_idx on decision_insight (workspace_id, insight_id);

-- ── Arquetipos del reto (RF-04.11) ──
-- Los históricos del cliente entran como HIPÓTESIS a confirmar o refutar; confirmar
-- exige evidencia enlazada. G2 no pasa con hipótesis colgando ni confirmados sin apoyo.
create table arquetipo (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid not null,
  nombre text not null check (btrim(nombre) <> ''),
  definicion text not null default '',
  estado text not null default 'hipotesis' check (estado in ('hipotesis', 'confirmado', 'refutado')),
  -- El veredicto (confirmar/refutar) exige razón: por qué la evidencia lo sostiene o no.
  veredicto_razon text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (reto_id, nombre),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  check (estado = 'hipotesis' or btrim(veredicto_razon) <> '')
);
create index arquetipo_reto_idx on arquetipo (workspace_id, reto_id);

create table arquetipo_segmento (
  arquetipo_id uuid not null,
  segmento_id uuid not null,
  workspace_id uuid not null references workspace(id),
  primary key (arquetipo_id, segmento_id),
  foreign key (arquetipo_id, workspace_id) references arquetipo (id, workspace_id),
  foreign key (segmento_id, workspace_id) references segmento (id, workspace_id)
);

create table arquetipo_evidencia (
  arquetipo_id uuid not null,
  evidencia_id uuid not null,
  workspace_id uuid not null references workspace(id),
  primary key (arquetipo_id, evidencia_id),
  foreign key (arquetipo_id, workspace_id) references arquetipo (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id)
);

-- ── Reapertura de etapa (RF-04.9, SYS-10) ──
-- Append-only: cada reapertura queda con su motivo. La aprobación del gate NO se
-- deshace (es inmutable y es historia); lo que cambia es que la etapa vuelve a estar
-- en curso y las decisiones aguas abajo quedan marcadas para revisión.
create table reapertura_etapa (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  proyecto_id uuid not null,
  etapa_numero integer not null check (etapa_numero between 0 and 7),
  motivo text not null check (btrim(motivo) <> ''),
  -- 'declarado': la reapertura nombró los insights que cambiaron y solo se marcaron
  -- las decisiones que se apoyan en ellos. 'etapa-completa': no se nombró ninguno y se
  -- marcó todo de esa etapa en adelante. El tablero muestra cuál fue, porque el alcance
  -- de una reapertura es parte de lo que se está diciendo.
  alcance text not null check (alcance in ('declarado', 'etapa-completa')),
  decisiones_marcadas integer not null default 0,
  reabierto_por uuid not null references usuario(id),
  reabierto_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (proyecto_id, workspace_id) references proyecto (id, workspace_id)
);
create index reapertura_proyecto_idx on reapertura_etapa (workspace_id, proyecto_id);

-- Los insights que la reapertura declara cambiados (RF-04.9: «registra motivo y
-- cambios»). Sin esto «decisiones aguas abajo AFECTADAS» no se puede computar y solo
-- queda barrer la etapa entera, que marca de más y enseña a ignorar la marca.
create table reapertura_insight (
  reapertura_id uuid not null,
  insight_id uuid not null,
  workspace_id uuid not null references workspace(id),
  primary key (reapertura_id, insight_id),
  foreign key (reapertura_id, workspace_id) references reapertura_etapa (id, workspace_id),
  foreign key (insight_id, workspace_id) references insight (id, workspace_id)
);
create index reapertura_insight_ins_idx on reapertura_insight (workspace_id, insight_id);

-- ── La reapertura de la etapa 0 tiene que poder cambiar los criterios ──
-- Tal como estaban, `criterio_insert`/`criterio_update` rechazaban toda escritura en
-- cuanto existía un G0 aprobado. Reabrir la etapa 0 devolvía la etapa a 'en-curso'
-- y NADA más: el cambio de criterios para el que existe la reapertura seguía sin poder
-- hacerse. Se reemplazan para admitir exactamente ese caso — G0 aprobado PERO la etapa
-- 0 reabierta — sin desaprobar el gate (una aprobación es un hecho histórico, SYS-10).
drop policy criterio_insert on criterio_exito;
drop policy criterio_update on criterio_exito;

-- El guard que congela los criterios tiene la misma ceguera que las políticas: mira
-- «¿G0 aprobado?» y no «¿la etapa 0 está reabierta?». Se reemplaza conservando todo lo
-- demás (candado por G0 en orden estable, evento de la transición).
create or replace function criterio_g0_pendiente_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  perform 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id and g.numero = 0
    order by g.id for update of g;
  if exists (select 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
      and e.numero = 0
    where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id
      and g.numero = 0 and g.estado = 'aprobado'
      -- La etapa 0 REABIERTA es la excepción: es el cambio para el que existe la
      -- reapertura. La aprobación del gate sigue en pie (SYS-10: se cuestiona, no se
      -- borra), y el evento de abajo deja el rastro de qué se tocó después.
      and e.estado <> 'en-curso') then
    raise exception 'el G0 del reto está aprobado: criterios congelados';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id,
      case tg_op when 'INSERT' then 'CriterioDefinido' else 'CriterioEditado' end,
      jsonb_build_object('criterioId', new.id, 'retoId', new.reto_id, 'kpi', new.kpi),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;

create policy criterio_insert on criterio_exito
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and not exists (select 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
        and e.numero = 0
      where p.reto_id = criterio_exito.reto_id
        and p.workspace_id = criterio_exito.workspace_id
        and g.numero = 0 and g.estado = 'aprobado'
        and e.estado <> 'en-curso')
  );
create policy criterio_update on criterio_exito
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and not exists (select 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
        and e.numero = 0
      where p.reto_id = criterio_exito.reto_id
        and p.workspace_id = criterio_exito.workspace_id
        and g.numero = 0 and g.estado = 'aprobado'
        and e.estado <> 'en-curso')
  )
  with check (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'));

-- ── El checklist enlaza los TRES objetos citables que exige RF-04.5 ──
alter table checklist_item add column insight_id uuid;
alter table checklist_item add column decision_id uuid;
alter table checklist_item
  add constraint checklist_item_insight_fk
  foreign key (insight_id, workspace_id) references insight (id, workspace_id);
alter table checklist_item
  add constraint checklist_item_decision_fk
  foreign key (decision_id, workspace_id) references decision (id, workspace_id);

-- Los CHECKs de exclusividad se reescriben: cumplido exige EXACTAMENTE UN objeto real
-- (no dos, no cero); los otros estados siguen sin arrastrar nada.
alter table checklist_item drop constraint checklist_item_check;
alter table checklist_item drop constraint checklist_item_check1;
alter table checklist_item drop constraint checklist_item_check2;
alter table checklist_item
  add constraint checklist_item_cumplido_check
  check (estado <> 'cumplido' or (
    num_nonnulls(evidencia_id, insight_id, decision_id) = 1
    and btrim(na_justificacion) = '' and na_aprobado_por is null));
alter table checklist_item
  add constraint checklist_item_na_check
  check (estado <> 'na' or (
    btrim(na_justificacion) <> '' and na_aprobado_por is not null
    and num_nonnulls(evidencia_id, insight_id, decision_id) = 0));
alter table checklist_item
  add constraint checklist_item_pendiente_check
  check (estado <> 'pendiente' or (
    num_nonnulls(evidencia_id, insight_id, decision_id) = 0
    and na_aprobado_por is null and btrim(na_justificacion) = ''));

-- ── RLS ──
-- Lectura: miembros del workspace (el portal es de todos; el juicio es de los curadores).
-- Escritura de insights/citas/arquetipos/decisiones: curadores (lead/diseñador), con
-- autoría fijada en la política. La contradicción la puede registrar CUALQUIER miembro:
-- que un stakeholder señale que algo no cuadra es exactamente el valor del portal.
alter table insight enable row level security;
alter table afirmacion enable row level security;
alter table cita enable row level security;
alter table contradiccion enable row level security;
alter table decision enable row level security;
alter table decision_insight enable row level security;
alter table arquetipo enable row level security;
alter table arquetipo_segmento enable row level security;
alter table arquetipo_evidencia enable row level security;
alter table reapertura_etapa enable row level security;
alter table reapertura_insight enable row level security;

create policy insight_select on insight
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy afirmacion_select on afirmacion
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy cita_select on cita
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy contradiccion_select on contradiccion
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy decision_select on decision
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy decision_insight_select on decision_insight
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy arquetipo_select on arquetipo
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy arquetipo_segmento_select on arquetipo_segmento
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy arquetipo_evidencia_select on arquetipo_evidencia
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy reapertura_select on reapertura_etapa
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy reapertura_insight_select on reapertura_insight
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- Insight: nace PROPUESTO (nadie se auto-valida en el insert) y atribuido.
create policy insight_insert on insight
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'propuesto'
  );
-- Validar es la transición decisora: propuesto → validado, firmada por quien valida.
-- Un insight validado es INMUTABLE (el USING no lo alcanza): sostiene decisiones.
create policy insight_validar on insight
  for update
  using (
    estado = 'propuesto'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (
    estado = 'validado'
    and validado_por = app_user_id()
    and validado_en is not null
  );

-- Afirmaciones y citas solo se agregan mientras el insight sigue propuesto: validado
-- significa «esto es lo que afirmo y con esto lo sostengo», no un documento vivo.
create policy afirmacion_insert on afirmacion
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from insight i
      where i.id = afirmacion.insight_id and i.workspace_id = afirmacion.workspace_id
        and i.estado = 'propuesto')
  );
create policy cita_insert on cita
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from afirmacion a
      join insight i on i.id = a.insight_id and i.workspace_id = a.workspace_id
      where a.id = cita.afirmacion_id and a.workspace_id = cita.workspace_id
        and i.estado = 'propuesto')
  );
-- Contradicción: cualquier miembro, en cualquier momento (también contra un insight ya
-- validado — el descubrimiento incómodo llega tarde por definición).
create policy contradiccion_insert on contradiccion
  for insert with check (
    is_workspace_member(app_user_id(), workspace_id)
    and creado_por = app_user_id()
  );

-- Decisión: la registra el lead (opera el método) sobre un gate del proyecto, atribuida
-- y siempre 'vigente' al nacer; pasar a 'en-revision' es potestad de la reapertura.
create policy decision_insert on decision
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and decidido_por = app_user_id()
    and estado = 'vigente'
  );
create policy decision_revision on decision
  for update
  using (workspace_role(app_user_id(), workspace_id) = 'lead-boutique')
  with check (estado in ('vigente', 'en-revision'));
create policy decision_insight_insert on decision_insight
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );

-- Arquetipos: curadores los definen y les dan veredicto; el enlace a evidencia y
-- segmentos es aditivo (quitar apoyo a un arquetipo confirmado sería reescribir).
-- Un arquetipo nace hipótesis, y solo mientras G2 esté por decidirse. Si G2 ya se
-- aprobó, agregar una hipótesis dejaría al proyecto con un arquetipo sin resolver para
-- siempre: G2 es inmutable y su guard solo corre al aprobar, así que nadie volvería a
-- mirarlo. La vía para hacerlo es la que ya existe y queda trazada — reabrir la etapa 2,
-- que la devuelve a 'en-curso'.
create policy arquetipo_insert on arquetipo
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'hipotesis'
    and not exists (
      select 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
        and e.numero = 2
      where p.reto_id = arquetipo.reto_id
        and p.workspace_id = arquetipo.workspace_id
        and g.numero = 2 and g.estado = 'aprobado'
        and e.estado <> 'en-curso'
    )
  );
create policy arquetipo_veredicto on arquetipo
  for update
  using (
    estado = 'hipotesis'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (estado in ('confirmado', 'refutado'));
create policy arquetipo_segmento_insert on arquetipo_segmento
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );
create policy arquetipo_evidencia_insert on arquetipo_evidencia
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

-- Reapertura: la ejecuta el lead y queda atribuida; append-only por ausencia de update.
create policy reapertura_insert on reapertura_etapa
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and reabierto_por = app_user_id()
  );
-- Los insights declarados solo los cuelga un lead; sin update ni delete, la declaración
-- es lo que se dijo. La autoría NO se comprueba aquí a propósito: la fila hermana de
-- reapertura_etapa se inserta en la MISMA sentencia y las sub-consultas de un WITH
-- comparten snapshot, así que el exists nunca la vería. La comprueba el constraint
-- trigger diferido de abajo, que corre al commit y ya la ve.
create policy reapertura_insight_insert on reapertura_insight
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );

-- ── Guard: confirmar un arquetipo exige evidencia enlazada ──
-- Vive en la base (no solo en el servicio) porque es la promesa del arquetipo: un perfil
-- conductual «confirmado» sin nada que lo sostenga es exactamente la persona inventada
-- que el método existe para evitar.
create function arquetipo_veredicto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado = 'confirmado' and old.estado <> 'confirmado'
    and not exists (select 1 from arquetipo_evidencia ae
      where ae.arquetipo_id = new.id and ae.workspace_id = new.workspace_id) then
    raise exception 'confirmar un arquetipo exige evidencia enlazada';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'ArquetipoVeredicto',
      jsonb_build_object('arquetipoId', new.id, 'retoId', new.reto_id,
                         'de', old.estado, 'a', new.estado),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger arquetipo_veredicto_trg
  before update on arquetipo
  for each row execute function arquetipo_veredicto_guard();
revoke execute on function arquetipo_veredicto_guard() from public;

-- ── Guard: validar un insight exige que toda afirmación no-hipótesis tenga cita ──
-- RF-03.9 en el dato: «afirmaciones + ≥1 cita por afirmación soportada».
create function insight_validar_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado = 'validado' and old.estado = 'propuesto' then
    new.validado_en := now();
    if not exists (select 1 from afirmacion a
      where a.insight_id = new.id and a.workspace_id = new.workspace_id) then
      raise exception 'un insight sin afirmaciones no se valida';
    end if;
    if exists (select 1 from afirmacion a
      where a.insight_id = new.id and a.workspace_id = new.workspace_id
        and not a.es_hipotesis
        and not exists (select 1 from cita c
          where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id)) then
      raise exception 'toda afirmación no marcada como hipótesis exige al menos una cita';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'InsightValidado',
        jsonb_build_object('insightId', new.id, 'titulo', new.titulo),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger insight_validar_trg
  before update on insight
  for each row execute function insight_validar_guard();
revoke execute on function insight_validar_guard() from public;

-- ── El gate G2 exige arquetipos resueltos (RF-04.11) ──
-- Se reemplaza el guard de suficiencia para sumar la regla sin perder ninguna de las
-- anteriores (checklist sin pendientes y no vacío, orden de gates, criterios de G0).
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

-- El rastro del checklist ahora nombra el objeto real enlazado, sea cual sea.
create or replace function checklist_gate_pendiente_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  perform 1 from gate_instancia g
    where g.id = new.gate_id and g.workspace_id = new.workspace_id for update;
  if exists (select 1 from gate_instancia g
    where g.id = new.gate_id and g.workspace_id = new.workspace_id
      and g.estado = 'aprobado') then
    raise exception 'el gate ya está aprobado: checklist congelado';
  end if;
  if tg_op = 'UPDATE' then
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'ItemMarcado',
      jsonb_strip_nulls(jsonb_build_object(
        'itemId', new.id, 'gateId', new.gate_id, 'accion', new.estado,
        'evidenciaId', new.evidencia_id,
        'insightId', new.insight_id,
        'decisionId', new.decision_id,
        'justificacion', nullif(new.na_justificacion, '')))
        || jsonb_build_object('previo', jsonb_build_object(
             'estado', old.estado, 'naAprobadoPor', old.na_aprobado_por,
             'naJustificacion', old.na_justificacion)),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ── La declaración de cambios es de la propia reapertura ──
-- Diferido al commit porque es exactamente el caso que la política no puede ver: la
-- reapertura y sus insights nacen en una sola sentencia.
create function reapertura_insight_autor_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if not exists (select 1 from reapertura_etapa r
    where r.id = new.reapertura_id and r.workspace_id = new.workspace_id
      and r.reabierto_por = app_user_id()) then
    raise exception 'solo se declaran cambios en la propia reapertura';
  end if;
  return new;
end $$;
create constraint trigger reapertura_insight_autor
  after insert on reapertura_insight
  deferrable initially deferred
  for each row execute function reapertura_insight_autor_guard();
revoke execute on function reapertura_insight_autor_guard() from public;

-- ── Lo que cumple un ítem tiene que ser CITABLE de verdad ──
-- La FK compuesta garantiza el workspace y nada más. Con ella sola, una petición
-- fabricada cumple un gate del proyecto A citando una decisión del proyecto B, o lo
-- cumple con un insight que nadie validó todavía — razonamiento que ni siquiera pasó
-- por el guard de las citas. El picker filtra las dos cosas; el endpoint acepta
-- cualquier uuid, así que la regla vive aquí, donde el SQL directo tampoco la esquiva.
create function checklist_objeto_citable_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.decision_id is not null and not exists (
    select 1 from decision d
    join gate_instancia g on g.id = new.gate_id and g.workspace_id = new.workspace_id
    where d.id = new.decision_id and d.workspace_id = new.workspace_id
      and d.proyecto_id = g.proyecto_id) then
    -- Un solo mensaje para los dos casos porque los dos son lo mismo desde aquí: la
    -- decisión no está donde el ítem la busca (no existe, o es de otro proyecto).
    raise exception 'la decisión citada no existe en este proyecto';
  end if;
  if new.insight_id is not null and not exists (
    select 1 from insight i
    where i.id = new.insight_id and i.workspace_id = new.workspace_id
      and i.estado = 'validado') then
    raise exception 'el insight citado no existe o todavía no está validado';
  end if;
  return new;
end $$;
create trigger checklist_objeto_citable
  before insert or update on checklist_item
  for each row execute function checklist_objeto_citable_guard();
revoke execute on function checklist_objeto_citable_guard() from public;

-- ── Grants mínimos ──
grant select, insert on insight, afirmacion, cita, contradiccion to designio_app;
grant select, insert on decision, decision_insight to designio_app;
grant select, insert on arquetipo, arquetipo_segmento, arquetipo_evidencia to designio_app;
grant select, insert on reapertura_etapa, reapertura_insight to designio_app;
-- Solo la transición de validación (nunca el contenido de un insight).
grant update (estado, validado_por, validado_en) on insight to designio_app;
-- Solo el veredicto del arquetipo (nunca renombrarlo ni redefinirlo).
grant update (estado, veredicto_razon) on arquetipo to designio_app;
-- Solo la marca de revisión de una decisión (su contenido es historia).
grant update (estado) on decision to designio_app;
-- El checklist gana las dos columnas nuevas de objeto citable.
grant update (insight_id, decision_id) on checklist_item to designio_app;
