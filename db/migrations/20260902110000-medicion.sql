-- SPEC-07 — Metric Registry, medición temporal y outcome review con veredicto
-- (CTX-06, ADR-0007; SYS-22, SYS-23, SYS-24). Este slice CIERRA el loop: convierte
-- «rediseñamos» en «esto pasó». Registry 1:1 con el reto que se firma en G6, snapshots
-- append-only por formulario o CSV, lectura por criterio contra la línea base, y
-- post-mortem con veredicto del catálogo cerrado que cierra reto y proyecto.
--
-- Deja fuera (con sus specs): el borrador narrativo AI del post-mortem (SPEC-08 —
-- aquí la redacción es HUMANA), las marcas de release en la serie (SPEC-06) y los retos
-- candidatos pre-poblados desde los aprendizajes (RF-07.10, segunda mitad).
--
-- Mismo patrón multi-tenant que el resto: FKs compuestas (id, workspace_id), RLS día 1,
-- autoría fijada en la política, transiciones exigidas por WITH CHECK + guard de fila, y
-- fechas CALENDÁRICAS como date (jamás timestamps: una fecha de snapshot con huso rueda
-- el día en UTC+13/14 y falsea la serie).

-- El propietario del dato es una PERSONA del cliente (RF-07.1): se referencia por FK
-- compuesta contra miembro, que hasta ahora no tenía la unique que eso exige.
alter table miembro add constraint miembro_id_ws_unico unique (id, workspace_id);

-- ── El veredicto vive en el reto (SYS-24) ──
-- Catálogo CERRADO en el propio CHECK: ni un bug de la app ni SQL directo inventan un
-- quinto valor. Los slugs son la codificación de base; el vocabulario canónico
-- («parcialmente logrado») lo pone la capa de dominio.
alter table reto add column veredicto text
  check (veredicto is null or veredicto in
    ('logrado', 'parcialmente-logrado', 'no-logrado', 'no-concluyente'));
-- Cerrar un reto SIN veredicto sería exactamente el loop abierto que este slice cierra…
-- …pero el ciclo ANTERIOR ya admitía `en-medicion → cerrado` (20260902070000) cuando la
-- columna ni existía: en una base con historia hay retos cerrados LEGALMENTE bajo aquel
-- esquema. Validar el CHECK contra ellos abortaría la migración entera —y el arranque del
-- contenedor con ella, porque cada archivo corre en UNA transacción.
--
-- Política de esas filas: NO se les inventa un veredicto.
--  · Un quinto slug («sin-outcome-review») rompería el catálogo CERRADO que SYS-24 exige
--    y obligaría a la UI, al vocabulario canónico y a la métrica de loop cerrado (§17) a
--    tratar como veredicto algo que no lo es.
--  · «No concluyente» sería una FABRICACIÓN peor: afirma que hubo post mortem y que no
--    pudo concluir, y contamina justo la métrica que cuenta cuántos retos cierran con
--    resultado. «No concluyente» es un veredicto caro y ganado; no un relleno.
-- El veredicto que nunca se dictó se codifica como lo que es: ausencia (null). Y la forma
-- que PostgreSQL tiene de decir «esto se exige a todo lo que se escriba desde ahora y no
-- afirmo nada sobre lo ya escrito» es exactamente NOT VALID — que sigue rechazando todo
-- INSERT y todo UPDATE de esas mismas filas.
alter table reto add constraint reto_cerrado_con_veredicto
  check (estado <> 'cerrado' or veredicto is not null) not valid;
-- Y se valida EN EL ACTO si no hay nada que arrastrar (toda base nueva, el CI y el dev
-- local): así el constraint queda plenamente confiable donde puede estarlo, en vez de
-- quedar NOT VALID para siempre «por si acaso». Con deuda histórica el deploy no aborta:
-- la nombra en un notice y el constraint sigue exigiéndose a cada escritura nueva. Saldarla
-- es decisión de PRODUCTO, no de esta migración: archivar esas filas (`cerrado → archivado`
-- sigue admitiendo veredicto nulo) o dictarles el veredicto por vía administrativa —el
-- outcome review ya no se abre sobre un reto cerrado—. Después basta VALIDATE CONSTRAINT.
do $$
declare
  heredados int;
begin
  select count(*) into heredados from reto where estado = 'cerrado' and veredicto is null;
  if heredados = 0 then
    alter table reto validate constraint reto_cerrado_con_veredicto;
  else
    raise notice
      '% reto(s) cerrados antes de SPEC-07 se quedan sin veredicto: reto_cerrado_con_veredicto queda NOT VALID (exigido en toda escritura nueva); valídalo cuando cierres esa deuda',
      heredados;
  end if;
end $$;
-- …y un veredicto en un reto que sigue vivo sería un resultado sin medición terminada.
alter table reto add constraint reto_veredicto_solo_cerrado
  check (veredicto is null or estado in ('cerrado', 'archivado'));

-- ── Metric Registry: 1:1 con el reto (RF-07.1) ──
-- El registry es el CONTRATO de medición del reto: qué se mide, quién lo aporta y cada
-- cuánto. Nace borrador en la etapa 6 y se FIRMA en G6 (SYS-22); firmado = congelado.
create table metric_registry (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid not null,
  estado text not null default 'borrador' check (estado in ('borrador', 'firmado')),
  firmado_por uuid references usuario(id),
  firmado_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  -- 1:1 con el reto (RF-07.1): un reto tiene UN contrato de medición, no una colección.
  unique (reto_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  check (estado = 'borrador' or (firmado_por is not null and firmado_en is not null))
);

-- ── Entradas KPI del registry (RF-07.1) ──
-- La tabla acepta entradas INCOMPLETAS (el registry se redacta iterando); la completitud
-- la exige la FIRMA, igual que G0 exige criterios completos. Cada entrada responde a un
-- criterio de éxito REAL del reto: un KPI que no responde a ningún criterio es telemetría,
-- no medición de impacto (ADR-0007).
create table entrada_kpi (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  registry_id uuid not null,
  criterio_id uuid not null,
  nombre text not null,
  definicion text not null default '',
  fuente text not null default '',
  -- Cortes/dimensiones del KPI (RF-07.1): texto libre, no un modelo analítico.
  dimensiones text not null default '',
  -- Persona del CLIENTE que se compromete a aportar el dato (RF-07.4).
  propietario_miembro_id uuid,
  frecuencia text not null check (frecuencia in ('semanal', 'mensual', 'trimestral', 'unica')),
  dashboard_url text not null default '',
  -- Línea base del KPI: numérica y con fecha, porque contra ella se lee la serie.
  -- (criterio_exito.linea_base_valor es el resumen presentable del compromiso de G0;
  -- esta es la que se compara.)
  linea_base_valor numeric,
  linea_base_fecha date,
  -- Inicio de la ventana: la fecha desde la que este KPI se mide (con SPEC-06 será la
  -- del primer release desplegado; hasta entonces la declara quien firma el plan).
  -- El LARGO de la ventana no se duplica aquí: vive en criterio_exito.ventana_dias,
  -- congelado por G0 (SYS-22) — una segunda copia sería una segunda verdad.
  ventana_inicio date,
  fecha_post_mortem date,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (registry_id, nombre),
  foreign key (registry_id, workspace_id) references metric_registry (id, workspace_id),
  foreign key (criterio_id, workspace_id) references criterio_exito (id, workspace_id),
  foreign key (propietario_miembro_id, workspace_id) references miembro (id, workspace_id)
);
create index entrada_kpi_registry_idx on entrada_kpi (workspace_id, registry_id);
create index entrada_kpi_criterio_idx on entrada_kpi (workspace_id, criterio_id);

-- ── Snapshots: APPEND-ONLY (SYS-23) ──
-- Sin políticas de UPDATE/DELETE y sin grants: corregir un valor es un snapshot NUEVO
-- con su nota, nunca una edición. El origen es cerrado (formulario o CSV): ninguna
-- ingesta continua entra por aquí (ADR-0007, decisión 4).
create table snapshot (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  entrada_kpi_id uuid not null,
  valor numeric not null,
  -- Fecha CALENDÁRICA del dato (no la de carga: creado_en ya registra cuándo entró).
  fecha date not null,
  origen text not null check (origen in ('formulario', 'csv')),
  nota text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (entrada_kpi_id, workspace_id) references entrada_kpi (id, workspace_id)
);
create index snapshot_entrada_idx on snapshot (workspace_id, entrada_kpi_id, fecha);

-- ── Outcome review: el post-mortem con veredicto (RF-07.7 a RF-07.10, SYS-24) ──
-- La estructura SEPARA contribución de causalidad: los campos narrativos hablan de
-- contribución y factores externos, y solo el flag de diseño experimental —con
-- justificación obligatoria por CHECK— habilita lenguaje causal (RF-07.9).
create table outcome_review (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid not null,
  estado text not null default 'borrador' check (estado in ('borrador', 'completado')),
  veredicto text check (veredicto is null or veredicto in
    ('logrado', 'parcialmente-logrado', 'no-logrado', 'no-concluyente')),
  contribucion text not null default '',
  factores_externos text not null default '',
  hipotesis_abiertas text not null default '',
  aprendizajes text not null default '',
  diseno_experimental_suficiente boolean not null default false,
  diseno_experimental_justificacion text not null default '',
  completado_por uuid references usuario(id),
  completado_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (reto_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  -- SYS-24: afirmar «diseño experimental suficiente» sin decir POR QUÉ es exactamente
  -- la puerta trasera al lenguaje causal que la invariante cierra.
  check (not diseno_experimental_suficiente
         or btrim(diseno_experimental_justificacion) <> ''),
  -- Completado = veredicto del catálogo, contribución escrita y firma con fecha.
  check (estado = 'borrador' or (veredicto is not null and completado_por is not null
    and completado_en is not null and btrim(contribucion) <> ''))
);

-- ── Resultado por criterio dentro del review (RF-07.8) ──
-- El valor final NO se teclea: apunta a un snapshot REAL de la serie (o declara por qué
-- no hay dato). Es la diferencia entre un post-mortem y una presentación de resultados.
create table resultado_criterio (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  review_id uuid not null,
  criterio_id uuid not null,
  snapshot_final_id uuid,
  lectura text not null default '',
  -- Criterio de aceptación 3 de SPEC-07: sin datos suficientes, el motivo queda escrito.
  sin_datos_motivo text not null default '',
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (review_id, criterio_id),
  foreign key (review_id, workspace_id) references outcome_review (id, workspace_id),
  foreign key (criterio_id, workspace_id) references criterio_exito (id, workspace_id),
  foreign key (snapshot_final_id, workspace_id) references snapshot (id, workspace_id),
  check (snapshot_final_id is not null or btrim(sin_datos_motivo) <> '')
);
create index resultado_criterio_review_idx on resultado_criterio (workspace_id, review_id);

-- ── RLS ──
-- Lectura: TODO miembro (ver el tablero completo es el punto del portal; el stakeholder
-- lee el impacto aunque no escriba nada). Escrituras:
--  · registry/entradas — curadores (lead/diseñador) mientras el registry es borrador.
--  · firma del registry — SOLO el rol aprobador de G6 (sponsor, §13.2) y solo en G6:
--    con G0-G5 aprobados y G6 aún pendiente. Firmado ⇒ congelado (ninguna política
--    alcanza sus filas).
--  · snapshots — curadores o el PROPIETARIO DEL DATO de esa entrada, solo con el
--    registry firmado y el reto en medición, y solo con FECHA dentro de la ventana
--    firmada y no futura (I5); jamás update ni delete (SYS-23).
--  · outcome review — el lead (opera el método), y solo cuando la ventana del último
--    criterio ya cerró (RF-07.7).

alter table metric_registry enable row level security;
alter table entrada_kpi enable row level security;
alter table snapshot enable row level security;
alter table outcome_review enable row level security;
alter table resultado_criterio enable row level security;

create policy registry_select on metric_registry
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy entrada_select on entrada_kpi
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy snapshot_select on snapshot
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy review_select on outcome_review
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy resultado_select on resultado_criterio
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy registry_insert on metric_registry
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'borrador'
    and firmado_por is null
    and firmado_en is null
    -- El contrato de medición se redacta con el reto VIVO: ni sobre un candidato sin
    -- método ni sobre uno ya cerrado (SYS-08).
    and exists (select 1 from reto r
      where r.id = metric_registry.reto_id and r.workspace_id = metric_registry.workspace_id
        and r.estado = 'activo')
  );

-- La firma es la transición decisora del registry (SYS-22). El rol se lee del PROPIO
-- gate G6 del proyecto del reto: si el método cambiara su rol aprobador, la firma lo
-- sigue sin tocar esta política.
create policy registry_firmar on metric_registry
  for update
  using (
    estado = 'borrador'
    and exists (select 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      where p.reto_id = metric_registry.reto_id
        and p.workspace_id = metric_registry.workspace_id
        and g.numero = 6 and g.estado = 'pendiente'
        and workspace_role(app_user_id(), metric_registry.workspace_id) = g.rol_aprobador)
    -- «Se firma EN G6»: no antes. Los gates ordenan el método y el registry se acuerda
    -- con el plan de implementación delante, no en el kickoff.
    and not exists (select 1 from gate_instancia g2
      join proyecto p2 on p2.id = g2.proyecto_id and p2.workspace_id = g2.workspace_id
      where p2.reto_id = metric_registry.reto_id
        and p2.workspace_id = metric_registry.workspace_id
        and g2.numero < 6 and g2.estado <> 'aprobado')
  )
  with check (
    estado = 'firmado'
    and firmado_por = app_user_id()
  );

create policy entrada_insert on entrada_kpi
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from metric_registry r
      where r.id = entrada_kpi.registry_id and r.workspace_id = entrada_kpi.workspace_id
        and r.estado = 'borrador')
    -- El criterio debe ser del MISMO reto del registry: un KPI colgado del criterio de
    -- otro reto mediría otra promesa (la FK compuesta solo garantiza el workspace).
    and exists (select 1 from metric_registry r
      join criterio_exito c on c.reto_id = r.reto_id and c.workspace_id = r.workspace_id
      where r.id = entrada_kpi.registry_id and r.workspace_id = entrada_kpi.workspace_id
        and c.id = entrada_kpi.criterio_id)
  );
create policy entrada_update on entrada_kpi
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from metric_registry r
      where r.id = entrada_kpi.registry_id and r.workspace_id = entrada_kpi.workspace_id
        and r.estado = 'borrador')
  )
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from metric_registry r
      join criterio_exito c on c.reto_id = r.reto_id and c.workspace_id = r.workspace_id
      where r.id = entrada_kpi.registry_id and r.workspace_id = entrada_kpi.workspace_id
        and c.id = entrada_kpi.criterio_id)
  );

-- Snapshots: quien tiene el dato lo aporta. El propietario del dato es normalmente del
-- CLIENTE (sponsor, stakeholder, admin-cliente): sin esta rama, medir dependería de que
-- la boutique transcriba, que es justo el compromiso que G6 formaliza.
create policy snapshot_insert on snapshot
  for insert with check (
    creado_por = app_user_id()
    -- La fecha del DATO no puede ser del futuro. Sin esto, el propietario del dato mete
    -- un valor fechado por delante: la proyección lo toma como la última recepción (y la
    -- cadencia pasa a «recibido» sin que nadie haya aportado nada), y el selector del
    -- outcome review lo ofrece como resultado final del criterio.
    and snapshot.fecha <= current_date
    and exists (select 1 from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
      join reto rt on rt.id = r.reto_id and rt.workspace_id = r.workspace_id
      join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
      where e.id = snapshot.entrada_kpi_id and e.workspace_id = snapshot.workspace_id
        -- Solo se mide lo FIRMADO (SYS-22) y solo mientras el reto está en medición:
        -- después del cierre el resultado es historia (SYS-08).
        and r.estado = 'firmado' and rt.estado = 'en-medicion'
        -- Y solo DENTRO de la ventana firmada: I5 dice que la medición es temporal y
        -- ACOTADA, así que un valor de antes del inicio o de después del cierre no mide
        -- lo que se acordó medir. La ventana es la del contrato —inicio de la entrada,
        -- largo del criterio congelado en G0— y ninguna de las dos se copia aquí: se
        -- leen donde viven, que es lo que evita la segunda verdad.
        and e.ventana_inicio is not null and c.ventana_dias is not null
        and snapshot.fecha >= e.ventana_inicio
        and snapshot.fecha <= e.ventana_inicio + c.ventana_dias
        and (workspace_role(app_user_id(), snapshot.workspace_id) in ('lead-boutique', 'disenador')
          or exists (select 1 from miembro m
            where m.id = e.propietario_miembro_id and m.workspace_id = e.workspace_id
              and m.usuario_id = app_user_id())))
  );
-- Deliberadamente SIN update ni delete en snapshot: append-only (SYS-23).

-- El outcome review se HABILITA al cerrar la ventana del último criterio (RF-07.7): la
-- condición vive en la política, no solo en la pantalla.
create policy review_insert on outcome_review
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and estado = 'borrador'
    and veredicto is null
    and exists (select 1 from reto r
      where r.id = outcome_review.reto_id and r.workspace_id = outcome_review.workspace_id
        and r.estado = 'en-medicion')
    and exists (select 1 from metric_registry r
      where r.reto_id = outcome_review.reto_id and r.workspace_id = outcome_review.workspace_id
        and r.estado = 'firmado')
    and not exists (select 1 from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
      join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
      where r.reto_id = outcome_review.reto_id and r.workspace_id = outcome_review.workspace_id
        and (e.ventana_inicio is null or c.ventana_dias is null
             or e.ventana_inicio + c.ventana_dias > current_date))
  );
create policy review_completar on outcome_review
  for update
  using (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  )
  with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    -- Redactar (sigue borrador) o completar (veredicto firmado). El catálogo cerrado lo
    -- exige el CHECK de la tabla; aquí se exige la FIRMA de quien lo dicta.
    and (estado = 'borrador'
      or (estado = 'completado' and veredicto is not null
          and completado_por = app_user_id() and completado_en is not null))
  );

create policy resultado_insert on resultado_criterio
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from outcome_review o
      join criterio_exito c on c.reto_id = o.reto_id and c.workspace_id = o.workspace_id
      where o.id = resultado_criterio.review_id and o.workspace_id = resultado_criterio.workspace_id
        and o.estado = 'borrador' and c.id = resultado_criterio.criterio_id)
    -- El valor final apunta a un snapshot de ESTE criterio o no apunta a nada: un
    -- «resultado» tomado de la serie de otro KPI sería una cifra inventada con FK.
    and (snapshot_final_id is null or exists (select 1 from snapshot s
      join entrada_kpi e on e.id = s.entrada_kpi_id and e.workspace_id = s.workspace_id
      where s.id = resultado_criterio.snapshot_final_id
        and s.workspace_id = resultado_criterio.workspace_id
        and e.criterio_id = resultado_criterio.criterio_id))
  );
create policy resultado_update on resultado_criterio
  for update
  using (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from outcome_review o
      where o.id = resultado_criterio.review_id
        and o.workspace_id = resultado_criterio.workspace_id and o.estado = 'borrador')
  )
  with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and (snapshot_final_id is null or exists (select 1 from snapshot s
      join entrada_kpi e on e.id = s.entrada_kpi_id and e.workspace_id = s.workspace_id
      where s.id = resultado_criterio.snapshot_final_id
        and s.workspace_id = resultado_criterio.workspace_id
        and e.criterio_id = resultado_criterio.criterio_id))
  );

-- ── El proyecto gana su transición de estado (hasta ahora sin grant ni política) ──
-- La abre este slice porque es el que la necesita: G7 mueve el proyecto a medición y el
-- post-mortem lo cierra. Con el mismo rigor que el reto: rol que opera el método, pares
-- legales en un guard y CERRADO INMUTABLE (SYS-08) ya en el USING. Qué gate habilita cada
-- par y quién puede cerrar viven en el guard y no aquí: una política solo ve la fila
-- NUEVA, y estas dos reglas son sobre el par viejo→nuevo y sobre otra tabla.
create policy proyecto_update_estado on proyecto
  for update
  using (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and estado <> 'cerrado'
  )
  with check (workspace_role(app_user_id(), workspace_id) = 'lead-boutique');

create function proyecto_estado_transicion_guard() returns trigger
language plpgsql as $$
begin
  if new.estado = old.estado then
    return new;
  end if;
  -- Ciclo de vida del proyecto (RF-04.12): pausar y retomar es reversible; avanzar en el
  -- método no. Nada sale de 'cerrado' — el trabajo posterior es un reto nuevo (SYS-08).
  if (old.estado, new.estado) not in (
    ('activo', 'pausado'),
    ('pausado', 'activo'),
    ('activo', 'en-implementacion'),
    ('activo', 'en-medicion'),
    ('en-implementacion', 'en-medicion'),
    ('en-medicion', 'cerrado')
  ) then
    raise exception 'transición de proyecto ilegal: % → %', old.estado, new.estado;
  end if;
  -- §5.2: el paso a «en medición» es el gate de SEGUIMIENTO (G7), no el del plan (G6).
  -- Antes de G7 no hay releases conciliados contra la design version ni effective state
  -- constatado: medir ahí sería medir una implementación que nadie verificó.
  if new.estado = 'en-medicion' and not exists (select 1 from gate_instancia g
    where g.proyecto_id = new.id and g.workspace_id = new.workspace_id
      and g.numero = 7 and g.estado = 'aprobado') then
    raise exception 'el proyecto pasa a medición al aprobarse su G7 (§5.2)';
  end if;
  -- RF-07.10: el proyecto cierra CON su reto y por una sola mano, la del outcome review.
  -- `reto.veredicto` no tiene grant para el rol de aplicación —solo lo escribe el guard
  -- del review—, así que exigirlo aquí ata el cierre del proyecto a la completación del
  -- post mortem también por SQL directo. Sin esto, cualquier lead cerraba el proyecto
  -- (inmutable, SYS-08) y dejaba su reto midiendo y aceptando snapshots.
  if new.estado = 'cerrado' and not exists (select 1 from reto r
    where r.id = new.reto_id and r.workspace_id = new.workspace_id
      and r.veredicto is not null) then
    raise exception 'el proyecto cierra al completarse el outcome review de su reto (RF-07.10)';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'ProyectoTransicionado',
      jsonb_build_object('proyectoId', new.id, 'de', old.estado, 'a', new.estado),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger proyecto_estado_transicion
  before update of estado on proyecto
  for each row execute function proyecto_estado_transicion_guard();
revoke execute on function proyecto_estado_transicion_guard() from public;

-- ── Las dos condiciones duras del ciclo del reto que aporta la medición ──
-- Se reemplaza el guard de transición (create or replace conserva el trigger instalado)
-- para sumar, sin perder el rastro ni los pares legales: medir exige registry FIRMADO, y
-- cerrar exige VEREDICTO. Sigue sin ser SECURITY DEFINER a propósito: consulta bajo el
-- RLS del invocante, así que no puede volverse oráculo de otros workspaces.
create or replace function reto_estado_transicion_guard() returns trigger
language plpgsql as $$
begin
  if new.estado = old.estado then
    return new;
  end if;
  if (old.estado, new.estado) not in (
    ('candidato', 'activo'),
    ('candidato', 'archivado'),
    ('activo', 'en-medicion'),
    ('en-medicion', 'cerrado'),
    ('cerrado', 'archivado')
  ) then
    raise exception 'transición de reto ilegal: % → %', old.estado, new.estado;
  end if;
  -- SYS-22: no se mide sin contrato firmado. Sin esto, «en medición» sería una etiqueta
  -- y los snapshots entrarían sin dueño del dato ni frecuencia comprometidos.
  if new.estado = 'en-medicion' and not exists (select 1 from metric_registry r
    where r.reto_id = new.id and r.workspace_id = new.workspace_id and r.estado = 'firmado') then
    raise exception 'abrir la medición exige el Metric Registry firmado en G6 (SYS-22)';
  end if;
  -- §5.2: y exige el G7 APROBADO, que es el gate al que el ciclo canónico le asigna este
  -- paso («releases conciliados contra la design version; effective state constatado;
  -- medición operando. El proyecto y el reto pasan a en medición»). G6 solo acuerda el
  -- plan y firma el contrato de medición: abrir ahí admitiría snapshots de una
  -- implementación aún sin conciliar y se saltaría el último gate del método.
  if new.estado = 'en-medicion' and not exists (select 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = new.id and p.workspace_id = new.workspace_id
      and g.numero = 7 and g.estado = 'aprobado') then
    raise exception 'abrir la medición exige el G7 aprobado: releases conciliados y effective state constatado (§5.2)';
  end if;
  -- SYS-24: el reto cierra CON veredicto. La columna no tiene grant para el rol de app:
  -- la única mano que la escribe es el guard del outcome review, así que exigirla aquí
  -- ata el cierre al post-mortem también para el SQL directo.
  if new.estado = 'cerrado' and new.veredicto is null then
    raise exception 'cerrar un reto exige el veredicto del outcome review (SYS-24)';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'RetoTransicionado',
      jsonb_strip_nulls(jsonb_build_object('retoId', new.id, 'de', old.estado,
                                           'a', new.estado, 'veredicto', new.veredicto)),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;

-- ── Guard de la firma del registry (SYS-22) ──
-- La completitud del contrato vive en el DATO: ni el propio sponsor firma por SQL
-- directo un registry sin dueño del dato, sin línea base o con criterios sin KPI.
create function registry_firmar_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  faltan text;
begin
  -- Pre-chequeo anti-oráculo: la consulta privilegiada solo corre para miembros del
  -- workspace declarado; a los demás los rechaza la política, como siempre.
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado = 'firmado' and old.estado = 'borrador' then
    -- El sello temporal lo pone la BASE: un update directo no retro ni post-data la firma.
    new.firmado_en := now();
    if not exists (select 1 from entrada_kpi e
      where e.registry_id = new.id and e.workspace_id = new.workspace_id) then
      raise exception 'no se puede firmar: el registry no tiene entradas KPI (SYS-22)';
    end if;
    -- Cada criterio de éxito del reto necesita al menos un KPI que lo responda: firmar
    -- con un criterio huérfano garantizaría un «no concluyente» por construcción.
    select string_agg(c.kpi, ', ' order by c.kpi) into faltan
    from criterio_exito c
    where c.reto_id = new.reto_id and c.workspace_id = new.workspace_id
      and not exists (select 1 from entrada_kpi e
        where e.criterio_id = c.id and e.workspace_id = c.workspace_id
          and e.registry_id = new.id);
    if faltan is not null then
      raise exception 'no se puede firmar: criterios sin entrada KPI (SYS-22): %', faltan;
    end if;
    -- Entrada completa = lo que RF-07.1 exige y la medición usa: definición, fuente,
    -- dueño del dato, línea base con valor y fecha, y ventana con post-mortem previsto.
    -- btrim en los textos: whitespace no es contenido, tampoco por SQL directo.
    select string_agg(e.nombre, ', ' order by e.nombre) into faltan
    from entrada_kpi e
    where e.registry_id = new.id and e.workspace_id = new.workspace_id
      and (btrim(e.nombre) = '' or btrim(e.definicion) = '' or btrim(e.fuente) = ''
           or e.propietario_miembro_id is null or e.linea_base_valor is null
           or e.linea_base_fecha is null or e.ventana_inicio is null
           or e.fecha_post_mortem is null);
    if faltan is not null then
      raise exception 'no se puede firmar: entradas incompletas (SYS-22): %', faltan;
    end if;
    -- El post-mortem se prevé DESPUÉS del cierre de la ventana: fecharlo antes sería
    -- comprometerse a un veredicto sobre datos que aún no existen.
    select string_agg(e.nombre, ', ' order by e.nombre) into faltan
    from entrada_kpi e
    join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
    where e.registry_id = new.id and e.workspace_id = new.workspace_id
      and e.fecha_post_mortem < e.ventana_inicio + c.ventana_dias;
    if faltan is not null then
      raise exception 'no se puede firmar: post-mortem antes del cierre de la ventana: %', faltan;
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'MetricRegistryFirmado',
        jsonb_build_object('registryId', new.id, 'retoId', new.reto_id,
          'entradas', (select count(*) from entrada_kpi e
            where e.registry_id = new.id and e.workspace_id = new.workspace_id)),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger registry_firmar_trg
  before update on metric_registry
  for each row execute function registry_firmar_guard();
revoke execute on function registry_firmar_guard() from public;

-- ── Guard del cierre del outcome review (RF-07.8/07.10, SYS-24) ──
-- Completar el review es la transición que CIERRA el loop, y sus efectos son
-- inseparables de ella: reto cerrado con veredicto y proyecto cerrado inmutable.
create function outcome_review_completar_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  faltan text;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado = 'completado' and old.estado = 'borrador' then
    new.completado_en := now();
    -- RF-07.7 de nuevo aquí (la política ya lo exigió al abrir el review): entre la
    -- apertura y el cierre nadie amplió una ventana, pero el dato manda, no el orden.
    if exists (select 1 from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
      join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
      where r.reto_id = new.reto_id and r.workspace_id = new.workspace_id
        and (e.ventana_inicio is null or c.ventana_dias is null
             or e.ventana_inicio + c.ventana_dias > current_date)) then
      raise exception 'el outcome review se habilita al cerrar la ventana del último criterio (RF-07.7)';
    end if;
    -- Resultado por criterio, sin elegir cuáles contar (RF-07.8).
    select string_agg(c.kpi, ', ' order by c.kpi) into faltan
    from criterio_exito c
    where c.reto_id = new.reto_id and c.workspace_id = new.workspace_id
      and not exists (select 1 from resultado_criterio rc
        where rc.review_id = new.id and rc.workspace_id = new.workspace_id
          and rc.criterio_id = c.id);
    if faltan is not null then
      raise exception 'el outcome review exige resultado por criterio: faltan %', faltan;
    end if;
    -- «Logrado» con un criterio sin dato final es exactamente la presión por demostrar
    -- éxito que la spec nombra como riesgo: con datos faltantes el veredicto honesto
    -- existe y se llama «no concluyente» (o parcialmente logrado).
    if new.veredicto = 'logrado' and exists (select 1 from resultado_criterio rc
      where rc.review_id = new.id and rc.workspace_id = new.workspace_id
        and rc.snapshot_final_id is null) then
      raise exception 'veredicto «logrado» con criterios sin dato final: usa parcialmente logrado o no concluyente (SYS-24)';
    end if;
    -- El reto cierra con SU veredicto (el guard de transición vuelve a exigirlo y deja su
    -- propio rastro). Esta es la ÚNICA escritura de reto.veredicto del sistema, y va
    -- PRIMERO a propósito: el guard del proyecto exige ese veredicto para dejarlo cerrar,
    -- que es lo que ata el cierre del proyecto a esta completación y a ninguna otra mano.
    -- Tienen que ser dos sentencias, no una CTE: las sub-sentencias de un WITH comparten
    -- snapshot y el guard del proyecto no vería el veredicto recién escrito.
    update reto set estado = 'cerrado', veredicto = new.veredicto
      where id = new.reto_id and workspace_id = new.workspace_id;
    -- El proyecto cierra CON el reto (RF-07.10) y queda inmutable. Se exige que esté en
    -- medición: si alguien lo pausó, el cierre no lo arrastra en silencio.
    update proyecto set estado = 'cerrado'
      where reto_id = new.reto_id and workspace_id = new.workspace_id
        and estado = 'en-medicion';
    if exists (select 1 from proyecto p
      where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id
        and p.estado <> 'cerrado') then
      raise exception 'el proyecto del reto no está en medición: no puede cerrarse con el outcome review';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'OutcomeReviewCompletado',
        jsonb_build_object('reviewId', new.id, 'retoId', new.reto_id,
          'veredicto', new.veredicto,
          'disenoExperimental', new.diseno_experimental_suficiente),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger outcome_review_completar_trg
  before update on outcome_review
  for each row execute function outcome_review_completar_guard();
revoke execute on function outcome_review_completar_guard() from public;

-- ── G6 no se aprueba sin registry firmado (SYS-22) ──
-- Se reemplaza el guard de suficiencia sumando la regla, sin perder ninguna anterior
-- (checklist sin pendientes y no vacío, orden de gates, criterios de G0, arquetipos G2).
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
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
    -- Se conserva de la migración anterior: un ítem YA cumplido cuya decisión pasó a
    -- 'en-revision' por una reapertura no cuenta como suficiencia (RF-04.9). Este
    -- `create or replace` reescribe la función entera, así que omitirlo la desharía.
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
    if new.numero = 2 and exists (select 1 from arquetipo a
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where a.reto_id = p.reto_id and a.workspace_id = new.workspace_id
        and a.estado = 'hipotesis') then
      raise exception 'no se puede aprobar G2: hay arquetipos sin confirmar ni refutar (RF-04.11)';
    end if;
    -- G6 es donde el Metric Registry se acuerda y se FIRMA (SYS-22): aprobar el plan de
    -- implementación sin contrato de medición firmado deja el loop abierto por diseño.
    if new.numero = 6 and not exists (select 1 from metric_registry r
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where r.reto_id = p.reto_id and r.workspace_id = new.workspace_id
        and r.estado = 'firmado') then
      raise exception 'no se puede aprobar G6: el Metric Registry no está firmado (SYS-22)';
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

-- ── Dos puertas que la firma del registry y el cierre del proyecto tienen que cerrar ──
-- Ambas nacen de la convivencia entre la reapertura de etapa (SPEC-04.9) y lo que este
-- slice añade: un contrato de medición firmado y un proyecto que se cierra.

-- 1) Un proyecto CERRADO no se reabre. `reapertura_insert` solo miraba el rol, así que
-- un lead podía devolver a 'en-curso' una etapa de un proyecto ya cerrado con veredicto
-- y marcar en revisión decisiones que son historia (SYS-08: cerrado es inmutable, el
-- trabajo posterior es un reto nuevo).
drop policy reapertura_insert on reapertura_etapa;
create policy reapertura_insert on reapertura_etapa
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and reabierto_por = app_user_id()
    and exists (select 1 from proyecto p
      where p.id = reapertura_etapa.proyecto_id
        and p.workspace_id = reapertura_etapa.workspace_id
        and p.estado <> 'cerrado')
  );

-- 2) Con el registry FIRMADO, los criterios quedan congelados aunque se reabra la etapa 0.
-- La excepción de la reapertura existe para corregir el compromiso ANTES de acordar cómo
-- se mide; una vez firmado, `objetivo` y `ventana_dias` son el contrato que el post
-- mortem va a leer, y el registry no copia la ventana a propósito. Moverlos después de
-- firmar cambiaría la promesa sin que nadie lo viera. Si hay que cambiarlos, el camino
-- es un reto nuevo, no una reapertura.
drop policy criterio_insert on criterio_exito;
drop policy criterio_update on criterio_exito;

create policy criterio_insert on criterio_exito
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and not exists (select 1 from metric_registry r
      where r.reto_id = criterio_exito.reto_id and r.workspace_id = criterio_exito.workspace_id
        and r.estado = 'firmado')
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
    and not exists (select 1 from metric_registry r
      where r.reto_id = criterio_exito.reto_id and r.workspace_id = criterio_exito.workspace_id
        and r.estado = 'firmado')
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

-- El guard tiene la misma ceguera y hay que reponerle la condición nueva: habla ANTES
-- que el WITH CHECK, así que sin esto el mensaje sería el de siempre y la firma no
-- aparecería como motivo.
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
  if exists (select 1 from metric_registry r
    where r.reto_id = new.reto_id and r.workspace_id = new.workspace_id
      and r.estado = 'firmado') then
    raise exception 'el registry del reto está firmado: los criterios de medición son el contrato acordado (SYS-22)';
  end if;
  if exists (select 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
      and e.numero = 0
    where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id
      and g.numero = 0 and g.estado = 'aprobado'
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

-- ── Grants mínimos ──
grant select, insert on metric_registry, entrada_kpi, snapshot to designio_app;
grant select, insert on outcome_review, resultado_criterio to designio_app;
-- Solo la FIRMA del registry (jamás su reto ni su autoría).
-- Sin `firmado_en` en el grant: el sello temporal lo pone el guard y NADIE más. Que la
-- columna estuviera aquí dejaba al rol de app proponer una fecha —que el guard pisaba,
-- pero el contrato decía otra cosa— y obligaba a repetirla en el servicio. Sin permiso
-- de escritura, la promesa «un update directo no retro ni post-data la firma» es
-- estructural en vez de depender de que el trigger siga ahí.
grant update (estado, firmado_por) on metric_registry to designio_app;
-- La entrada se corrige entera mientras el registry es borrador, salvo su pertenencia
-- (registry y criterio son la identidad del compromiso, no un campo editable).
grant update (nombre, definicion, fuente, dimensiones, propietario_miembro_id, frecuencia,
  dashboard_url, linea_base_valor, linea_base_fecha, ventana_inicio, fecha_post_mortem)
  on entrada_kpi to designio_app;
-- snapshot SIN update ni delete: append-only por ausencia de política Y de grant (SYS-23).
grant update (estado, veredicto, contribucion, factores_externos, hipotesis_abiertas,
  aprendizajes, diseno_experimental_suficiente, diseno_experimental_justificacion,
  completado_por, completado_en) on outcome_review to designio_app;
grant update (snapshot_final_id, lectura, sin_datos_motivo) on resultado_criterio to designio_app;
-- El proyecto gana su transición de estado; reto.veredicto NO recibe grant: lo escribe
-- únicamente el guard del outcome review.
grant update (estado) on proyecto to designio_app;
