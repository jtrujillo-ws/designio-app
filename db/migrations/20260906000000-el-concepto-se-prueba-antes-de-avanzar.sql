-- ── El concepto (solución candidata) existe, y no avanza sin haberse probado ──
--
-- Etapa 4 del método produce CONCEPTOS: soluciones candidatas que se prueban y de las que
-- alguien decide si pasan o mueren. El modelo lo define `docs/01-ddd/domain-model.md`
-- («Concepto | CTX-04 | Solución candidata con resultados de test y decisión pasa/muere»),
-- con agregado propio y eventos `ConceptoPasa` / `ConceptoMuere`.
--
-- Hasta ahora no tenía tabla, y eso dejaba dos cosas colgando:
--
--   · SYS-13 no se podía exigir. «G4 exige evidencia de test que alcance el umbral definido
--     para cada concepto que avanza (o N/A aprobada); los conceptos descartados registran
--     razón» habla de objetos que no existían, así que G4 aprobaba sin nada que comprobar.
--   · `decision` ya tenía `tipo = 'pasa-muere'` —RF-04.10 dice que las decisiones registran el
--     pasa/muere DE CONCEPTOS— pero ninguna columna que apuntara al concepto decidido. El
--     tipo estaba; su objeto no.
--
-- Lo que NO hace falta inventar, y conviene decirlo porque parecía que sí: los «resultados de
-- test» que RF-04.5 enumera entre los objetos citables por un checklist son EVIDENCIA. El
-- `fuente.tipo` ya admite 'observacion' y 'entrevista', que es lo que produce una sesión de
-- test, y `checklist_item` ya puede apuntar a una evidencia. Esa lista de la spec —«evidencias,
-- insights, decisiones, resultados de test, documentos»— enumera CLASES DE OBJETO REAL, no
-- tablas: los documentos también son evidencia. Así que el concepto se ata a su prueba por
-- `concepto_evidencia`, hermano exacto de `arquetipo_evidencia`, y el checklist se queda como
-- está.

create table concepto (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid not null,
  -- `titulo_normalizado` y no `btrim`: es la función que este esquema ya usa para lo mismo en
  -- la oportunidad y en el elemento de cambio, y recorta también los espacios que `btrim` no
  -- ve. Repetir aquí media normalización sería tener dos ideas de «título vacío».
  titulo text not null check (titulo_normalizado(titulo) <> '' and length(titulo) <= 200),
  descripcion text not null default '' check (length(descripcion) <= 4000),
  -- El ciclo de vida: nace candidato y termina en un veredicto. No hay vuelta atrás, por lo
  -- mismo que la oportunidad: decidir es un acto que queda.
  estado text not null default 'candidato'
    check (estado in ('candidato', 'pasa', 'muere')),
  veredicto_razon text not null default '',
  decidido_por uuid,
  decidido_en timestamptz,
  -- SYS-13, segunda mitad: «los conceptos descartados registran razón». Solo el que MUERE la
  -- necesita — el que pasa se sostiene en su evidencia de test, que es otra cosa y se
  -- comprueba en G4.
  check (estado <> 'muere' or titulo_normalizado(veredicto_razon) <> ''),
  -- Un candidato no lleva veredicto puesto, y un decidido lo lleva entero: sin esto quedaba
  -- una fila que dice «candidato» con fecha de decisión, que no es ningún estado del método.
  check (estado <> 'candidato'
         or (veredicto_razon = '' and decidido_por is null and decidido_en is null)),
  check (estado = 'candidato' or (decidido_por is not null and decidido_en is not null)),
  -- Y la N/A de SYS-13, que vive AQUÍ y no en el checklist.
  --
  -- «O N/A aprobada» tiene que poder decirse de UN concepto: si viviera como un ítem suelto
  -- del checklist, un solo N/A taparía a todos los conceptos del gate a la vez, que es
  -- justo lo que SYS-13 impide al decir «para cada concepto que avanza». Con la
  -- justificación y su aprobador en la fila, la excepción se lee donde se aplica y queda
  -- claro quién la firmó. Misma forma que la N/A de `checklist_item`, por la misma razón.
  test_na_justificacion text not null default '',
  test_na_aprobado_por uuid,
  check ((btrim(test_na_justificacion) <> '') = (test_na_aprobado_por is not null)),
  creado_por uuid not null,
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  -- La autoría apunta a `usuario`, NO a `miembro`, igual que en la oportunidad y por una
  -- razón que tiene su propia prueba: ninguna clave ajena a `miembro` puede retener la baja
  -- —un workspace archivado durante años no puede quedarse sin forma de quitarle la entrada a
  -- quien se fue—. Apuntando a la persona, la salida del workspace nunca choca con la
  -- historia que esa persona escribió, que es lo que de verdad hay que conservar.
  foreign key (creado_por) references usuario (id),
  foreign key (decidido_por) references usuario (id),
  foreign key (test_na_aprobado_por) references usuario (id)
);

create index concepto_reto_idx on concepto (reto_id, workspace_id);

-- Un título no se repite dentro del reto, por lo mismo que la pregunta de una HMW: dos
-- conceptos con el mismo nombre son el mismo concepto contado dos veces, y las decisiones
-- pasa/muere dejarían de poder señalar a cuál.
create unique index concepto_titulo_unico_por_reto
  on concepto (reto_id, titulo_normalizado(titulo));

-- ── La evidencia de test del concepto ──
--
-- Hermano exacto de `arquetipo_evidencia`: n:m, con la misma FK compuesta que ata las dos
-- puntas al mismo workspace. Es lo que SYS-13 cuenta en G4.
create table concepto_evidencia (
  concepto_id uuid not null,
  evidencia_id uuid not null,
  workspace_id uuid not null references workspace(id),
  primary key (concepto_id, evidencia_id),
  foreign key (concepto_id, workspace_id) references concepto (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id)
);

-- ── Y la decisión pasa/muere apunta al concepto que decide (RF-04.10) ──
--
-- `decision.tipo` ya admitía 'pasa-muere' desde que existe la tabla, pero no había a qué
-- apuntar: la decisión decía de qué CLASE era y no SOBRE QUÉ. Se añade la columna en un solo
-- sentido —hay decisiones 'pasa-muere' que ya existen sin concepto— y lo que se prohíbe es lo
-- que no tiene lectura: apuntar a un concepto desde una decisión que no es de ese tipo.
alter table decision add column concepto_id uuid;
alter table decision add
  foreign key (concepto_id, workspace_id) references concepto (id, workspace_id);
alter table decision add constraint decision_concepto_es_pasa_muere
  check (concepto_id is null or tipo = 'pasa-muere');
create index decision_concepto_idx on decision (concepto_id, workspace_id)
  where concepto_id is not null;

alter table concepto enable row level security;
alter table concepto_evidencia enable row level security;
alter table concepto force row level security;
alter table concepto_evidencia force row level security;

create policy concepto_select on concepto
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- Escribe quien hace método. El concepto nace CANDIDATO y sin veredicto: eso lo fija el CHECK
-- de arriba, así que la política no lo repite — repetirlo sería una segunda redacción del
-- mismo juicio, que es como este repositorio se ha equivocado antes.
create policy concepto_insert on concepto
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    -- Y solo mientras el reto admita trabajo de método: proponer un concepto para un reto
    -- cerrado o archivado es escribir en un expediente terminado.
    and exists (select 1 from reto r
      where r.id = concepto.reto_id and r.workspace_id = concepto.workspace_id
        and r.estado in ('candidato', 'activo'))
  );

create policy concepto_actualizar on concepto
  for update using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

create policy concepto_evidencia_select on concepto_evidencia
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- Enlazar la prueba: mientras el concepto siga por decidir. Añadir evidencia de test a un
-- concepto ya juzgado cambiaría, después del hecho, en qué se apoyó ese juicio — el mismo
-- argumento que cierra `oportunidad_insight` tras el veredicto.
create policy concepto_evidencia_insert on concepto_evidencia
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from concepto c
      where c.id = concepto_evidencia.concepto_id
        and c.workspace_id = concepto_evidencia.workspace_id
        and c.estado = 'candidato')
  );

create policy concepto_evidencia_delete on concepto_evidencia
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from concepto c
      where c.id = concepto_evidencia.concepto_id
        and c.workspace_id = concepto_evidencia.workspace_id
        and c.estado = 'candidato')
  );

grant select on concepto, concepto_evidencia to designio_app;
grant insert (workspace_id, reto_id, titulo, descripcion, creado_por) on concepto to designio_app;
grant update (titulo, descripcion, estado, veredicto_razon, decidido_por, decidido_en,
              test_na_justificacion, test_na_aprobado_por) on concepto to designio_app;
grant insert (concepto_id, evidencia_id, workspace_id) on concepto_evidencia to designio_app;
grant delete on concepto_evidencia to designio_app;

-- ── El veredicto es de sentido único, y lo sella la base ──
--
-- Mismo trato que la oportunidad, y por lo mismo: `decidido_en` lo pone la BASE, no quien
-- llama, para que un UPDATE directo no pueda retro ni post-datar el acto. Y la transición es
-- de un solo sentido — un concepto que murió no revive: si el equipo cambia de idea, lo que
-- hay es un concepto NUEVO, y así queda en la historia.
create function concepto_veredicto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado is distinct from old.estado then
    if old.estado <> 'candidato' then
      raise exception 'ese concepto ya se decidió: pasa/muere es un acto que queda, y volver atrás sería reescribir la historia. Si el equipo cambia de idea, el concepto es otro';
    end if;
    new.decidido_en := now();
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id,
      case when new.estado = 'pasa' then 'ConceptoPasa' else 'ConceptoMuere' end,
      jsonb_build_object('conceptoId', new.id, 'retoId', new.reto_id,
                         'razon', new.veredicto_razon),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

create trigger b_concepto_veredicto
  before update on concepto
  for each row execute function concepto_veredicto_guard();

revoke execute on function concepto_veredicto_guard() from public;

-- ── SYS-13 en G4: lo que avanza, se probó ──
--
-- «G4 exige evidencia de test que alcance el umbral definido para cada concepto que avanza (o
-- N/A aprobada)». La puerta va en el MISMO guard que ya decide si un gate puede aprobarse, con
-- la misma forma que la de G0: una rama por número de gate. Escribirla aparte habría dejado
-- dos sitios que dicen cuándo se aprueba un gate, y este repositorio ya ha pagado por tener el
-- mismo juicio en dos redacciones.
--
-- Lo que se exige es POR CONCEPTO, no por gate: un solo N/A suelto en el checklist habría
-- tapado a todos los conceptos a la vez, y SYS-13 dice «para cada concepto que avanza». Por
-- eso la excepción vive en la fila del concepto y se lee aquí concepto a concepto.
--
-- Y se mira solo lo que AVANZA. Un concepto que murió no necesita prueba —su razón es su
-- registro, y ya la exige su CHECK— y uno que sigue candidato no ha avanzado a ninguna parte:
-- exigirle evidencia sería bloquear G4 por un concepto que nadie propuso pasar.

-- ── SYS-13 en G4: lo que avanza, se probó ──
--
-- «G4 exige evidencia de test que alcance el umbral definido para cada concepto que avanza (o
-- N/A aprobada)». La puerta va en el MISMO guard que ya decide si un gate puede aprobarse, con
-- la misma forma que las de G0 y G3: una rama por número de gate. Escribirla aparte habría
-- dejado dos sitios diciendo cuándo se aprueba un gate, y este repositorio ya ha pagado por
-- tener el mismo juicio en dos redacciones.
--
-- Lo que se exige es POR CONCEPTO: un solo N/A suelto en el checklist habría tapado a todos
-- los conceptos del gate a la vez, y SYS-13 dice «para cada concepto que avanza». Por eso la
-- excepción vive en la fila del concepto y se lee aquí uno a uno.
--
-- Y se mira solo lo que AVANZA. El que murió no necesita prueba —su razón es su registro, y ya
-- se la exige su CHECK— y el que sigue candidato no ha avanzado a ninguna parte: pedirle
-- evidencia sería bloquear G4 por un concepto que nadie propuso pasar.
--
-- El cuerpo entero se reescribe porque `create or replace` no parchea: se sustituye. Sale de
-- la ÚLTIMA versión vigente —la de la migración de la oportunidad— y no de la original, que
-- lleva catorce reescrituras de diferencia. Copiarla de la primera fue exactamente el error
-- que esta nota existe para que no se repita: se cayeron el candado del reto, la puerta de G3
-- y todo lo demás que se había ido añadiendo, y lo dijeron 52 pruebas a la vez.
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reto uuid;
  v_falta motivo_de_bloqueo;
  v_sin_prueba text;
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
    -- El candado del RETO antes de mirar nada. Este guard decide sobre filas de OTRAS tablas
    -- —el checklist, los releases, las constataciones—, así que sin candado compartido en la
    -- base una aprobación y una escritura concurrente sobre lo que afirma se miran sin verse
    -- y commitean las dos: G6 firmando un plan al que otra transacción le acaba de quitar la
    -- cobertura. Es la misma clave y el mismo primer lugar que en
    -- `release_elemento_cobertura_guard`, que es el otro lado del par.
    select p.reto_id into v_reto from proyecto p
      where p.id = new.proyecto_id and p.workspace_id = new.workspace_id;
    if v_reto is not null then
      perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
    end if;
    -- El sello temporal lo pone la BASE, no el caller: un update directo no puede
    -- retro ni post-datar el registro inmutable.
    new.aprobado_en := now();

    -- Los candados del razonamiento que el checklist consume: se bloquea lo que se va a
    -- leer, antes de leerlo. El recorrido es el mismo que `gate_faltas_para_aprobar` hace
    -- después para comprobar.
    perform razonamiento_candados(
      new.workspace_id,
      array(select ci.insight_id from checklist_item ci
              where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
                and ci.estado = 'cumplido' and ci.insight_id is not null),
      array(select ci.decision_id from checklist_item ci
              where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
                and ci.estado = 'cumplido' and ci.decision_id is not null),
      array(select ci.evidencia_id from checklist_item ci
              where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
                and ci.estado = 'cumplido' and ci.evidencia_id is not null));
    -- Y los del diseño que certifica G5, por el recorrido elemento → insight / decisión.
    if new.numero = 5 then
      perform razonamiento_candados(
        new.workspace_id,
        array(select ei.insight_id
                from elemento_cambio ec
                join elemento_insight ei on ei.elemento_id = ec.id and ei.workspace_id = ec.workspace_id
                where ec.workspace_id = new.workspace_id
                  and ec.design_version_id in (
                    select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))),
        array(select ed.decision_id
                from elemento_cambio ec
                join elemento_decision ed on ed.elemento_id = ec.id and ed.workspace_id = ec.workspace_id
                where ec.workspace_id = new.workspace_id
                  and ec.design_version_id in (
                    select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))),
        array[]::uuid[]);
    end if;
    -- Y los del portafolio que certifica G3, por el recorrido oportunidad → insight. Mismo
    -- recorrido que `gate_faltas_para_aprobar` hace después para comprobar.
    if new.numero = 3 then
      perform razonamiento_candados(
        new.workspace_id,
        array(select oi.insight_id
                from oportunidad o
                join proyecto pr on pr.id = new.proyecto_id and pr.workspace_id = new.workspace_id
                join oportunidad_insight oi on oi.oportunidad_id = o.id
                  and oi.workspace_id = o.workspace_id
                where o.reto_id = pr.reto_id and o.workspace_id = new.workspace_id
                  and o.estado <> 'descartada'),
        array[]::uuid[],
        array[]::uuid[]);
    end if;
    -- El arquetipo no entra en ese protocolo: no es razonamiento citado, es el veredicto de
    -- un perfil. Su candado va aquí, en el mismo modo y con el mismo orden por id.
    perform du.evidencia_id
      from derecho_uso du
      where du.workspace_id = new.workspace_id
        and new.numero = 2
        and du.evidencia_id in (
          select ae.evidencia_id from arquetipo a2
            join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
            join arquetipo_evidencia ae on ae.arquetipo_id = a2.id and ae.workspace_id = a2.workspace_id
            where a2.reto_id = p.reto_id and a2.workspace_id = new.workspace_id
              and a2.estado = 'confirmado')
      order by du.evidencia_id
      for share;

    -- ═══ Y UNA SOLA PREGUNTA, LA MISMA QUE HACE LA BANDEJA ═══
    select * into v_falta from gate_faltas_para_aprobar(new.id, new.workspace_id) limit 1;
    if found then
      raise exception '%', v_falta.motivo using errcode = v_falta.codigo;
    end if;

    if new.numero = 4 then
      -- Se nombra el PRIMERO que falta, en vez de decir «alguno»: quien aprueba tiene que
      -- poder ir a arreglarlo sin buscarlo a mano entre todos los conceptos del reto.
      select c.titulo into v_sin_prueba
      from concepto c
      where c.reto_id = v_reto and c.workspace_id = new.workspace_id
        and c.estado = 'pasa'
        and btrim(c.test_na_justificacion) = ''
        and not exists (select 1 from concepto_evidencia ce
          where ce.concepto_id = c.id and ce.workspace_id = c.workspace_id)
      order by c.titulo asc
      limit 1;
      if v_sin_prueba is not null then
        raise exception 'no se puede aprobar G4: el concepto «%» avanza sin evidencia de test enlazada ni N/A aprobada (SYS-13)', v_sin_prueba;
      end if;
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
                           'numero', new.numero, 'estado', new.estado,
                           'aprobadoPor', new.aprobado_por, 'aprobadoEn', new.aprobado_en),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- LA CONGELACIÓN POR DISPOSICIÓN ALCANZA A LAS TABLAS NUEVAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El bucle de `20260905130000` se dejó escrito idempotente justamente para esto: una tabla con
-- `workspace_id` creada después de `20260903200000` nace fuera de la congelación, y se podría
-- escribir en ella con el workspace ya dispuesto. Se copia tal cual, como decía su nota.
--
-- El prefijo `a_` no es decorativo: Postgres dispara los triggers de fila por orden de nombre
-- y éste tiene que tomar el candado del workspace antes que ningún otro guard.
do $$
declare
  r record;
begin
  for r in
    select t.tabla from tablas_congelables() t
     where not exists (
       select 1 from pg_trigger g
        where g.tgrelid = t.tabla::regclass
          and g.tgname = 'a_congelacion_por_disposicion'
          and not g.tgisinternal)
  loop
    execute format(
      'create trigger a_congelacion_por_disposicion
         before insert or update or delete on %I
         for each row execute function congelacion_por_disposicion_guard()',
      r.tabla);
  end loop;
end $$;

-- ── Y el aislamiento de escritura, por el mismo camino ──
--
-- Las dos tablas entran en la derivación en cuanto se les cuelga el guard de congelación, que
-- toma el candado del workspace: un cliente que abriera `repeatable read` escribiría con los
-- guards mirando una foto vieja. Mismo bucle idempotente de `20260903200000`, repetido en vez
-- de extraído a una función por la razón que dejó escrita la migración de la oportunidad: una
-- función «reinstala los triggers de infraestructura» invitaría a llamarla desde sitios donde
-- lo que hace falta es pensar qué tabla se añadió.
do $$
declare r record;
begin
  for r in
    with disparadoras as materialized (
      select distinct t.tgfoid as oid, t.tgrelid::regclass::text as tabla
      from pg_trigger t
      where not t.tgisinternal
    )
    select distinct d.tabla
    from disparadoras d
    join pg_proc p on p.oid = d.oid
    where p.prokind = 'f'
      and p.pronamespace = 'public'::regnamespace
      and pg_get_functiondef(p.oid) ~* '(pg_advisory_xact_lock|for +(share|update|no key update))'
      and p.proname <> 'exigir_aislamiento_de_escritura'
    order by 1
  loop
    if not exists (
      select 1 from pg_trigger t
      where t.tgrelid = r.tabla::regclass and t.tgname = 'aislamiento_de_escritura'
    ) then
      execute format(
        'create trigger aislamiento_de_escritura
           before insert or update or delete on %s
           for each statement execute function exigir_aislamiento_de_escritura()', r.tabla);
    end if;
  end loop;
end $$;

-- ── La evidencia de test es RESPALDO, así que pasa por el mismo guard de derechos ──
--
-- `concepto_evidencia` es una superficie de enlace a evidencia más, y el inventario de la
-- suite obliga a decidir cuál de las dos cosas es: uso aguas abajo con guard, o excepción con
-- motivo escrito. Es lo primero, y es el caso de `arquetipo_evidencia` casi palabra por
-- palabra: respaldo PROBATORIO cuyo enlace decide si un gate pasa —allí G2 con los arquetipos
-- confirmados, aquí G4 con SYS-13— y cuyo título se lee en el tablero de gobernanza. Enlazar
-- como prueba de un concepto evidencia que no se puede citar al cliente sería sostener un
-- «pasa» en material que no se puede enseñar.
create trigger evidencia_citable
  before insert or update on concepto_evidencia
  for each row execute function evidencia_citable_guard();
