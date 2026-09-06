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
  -- ── EL UMBRAL, que es la primera mitad de SYS-13 y faltaba entera ──
  --
  -- «Evidencia de test que alcance EL UMBRAL DEFINIDO». Enlazar una evidencia no dice nada de
  -- eso: una sesión de test enlazada puede haber salido 2 de 8. El ejemplo del prediseño
  -- (§424) lo deja explícito —«test real con 8 usuarios, umbral 6/8: pasa 'verificación
  -- diferida', muere 'pre-carga por convenio'»—, así que el umbral es un objeto del método y
  -- no una lectura que se hace de memoria.
  --
  -- Dos campos y no uno, porque son dos actos distintos y en dos momentos: el umbral se
  -- DECLARA antes de probar (y por eso se congela en cuanto hay prueba enlazada, abajo), y la
  -- lectura se REGISTRA después. Con un solo campo, «alcanzó el umbral» sería una frase que se
  -- escribe una vez ya visto el resultado, que es exactamente el sesgo que un umbral existe
  -- para impedir.
  --
  -- Lo que la base NO hace es comparar «7 de 8» contra «6 de 8»: son textos del método, y un
  -- comparador de umbrales inventaría una aritmética que el dominio no tiene. Lo que sí hace
  -- es que el par sea OBLIGATORIO para avanzar, que quede escrito quién lo declaró y cuándo, y
  -- que el umbral no se pueda mover una vez hay prueba que mirar. Con eso la afirmación es
  -- auditable, que es la forma que este esquema le da siempre a un juicio humano.
  umbral_test text not null default '' check (length(umbral_test) <= 500),
  test_lectura text not null default '' check (length(test_lectura) <= 500),
  -- Lo que AVANZA dice una de dos cosas: «la N/A está aprobada, por esto» o «el umbral era X y
  -- la lectura fue Y». Nunca ninguna. El que muere y el que sigue candidato no deben nada:
  -- SYS-13 habla de «cada concepto que avanza».
  check (estado <> 'pasa'
         or btrim(test_na_justificacion) <> ''
         or (btrim(umbral_test) <> '' and btrim(test_lectura) <> '')),
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

-- ── Y EL CONCEPTO DECIDIDO ES DEL RETO QUE SE ESTÁ DECIDIENDO ──
--
-- La clave ajena compuesta ata las dos puntas al mismo WORKSPACE, que es lo que impide la fuga
-- entre clientes, y ahí se acaba lo que una FK puede decir. Dentro de un workspace quedaba
-- abierto apuntar desde el pasa/muere del gate del proyecto A a un concepto del reto B: la
-- decisión existiría, el CHECK del tipo pasaría, y el concepto de B tendría colgada una
-- decisión que nadie tomó sobre él. Y la puerta está en la superficie concedida —`grant
-- select, insert on decision` es de tabla, así que la columna entra— y en el servicio, que
-- toma el proyecto del gate y el concepto de quien llama sin cruzarlos.
--
-- La regla se escribe una vez y para los dos verbos: `decision.proyecto_id` no está en el
-- grant de update, pero `estado` sí, y un guard que solo mirara el INSERT dejaría la puerta
-- entreabierta el día que alguien conceda otra columna.
create function decision_concepto_del_mismo_reto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.concepto_id is null then return new; end if;
  if not exists (
    select 1
    from concepto c
    join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
    where c.id = new.concepto_id and c.workspace_id = new.workspace_id
      and c.reto_id = p.reto_id) then
    raise exception 'ese concepto no es del reto de este proyecto: un pasa/muere decide sobre lo que su propio reto exploró (RF-04.10)';
  end if;
  return new;
end;
$fn$;

revoke execute on function decision_concepto_del_mismo_reto_guard() from public;

create trigger b_decision_concepto_del_reto
  before insert or update on decision
  for each row execute function decision_concepto_del_mismo_reto_guard();

alter table concepto enable row level security;
alter table concepto_evidencia enable row level security;
alter table concepto force row level security;
alter table concepto_evidencia force row level security;

create policy concepto_select on concepto
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- ── LA VENTANA: G4 CONGELA EL PORTAFOLIO DE CONCEPTOS QUE CERTIFICA ──
--
-- Hermana exacta de `reto_admite_portafolio`, la que la migración de la oportunidad escribió
-- para G3, con la etapa y el gate 4 en lugar de los 3. No se generalizó a una sola función con
-- el número por parámetro a propósito: leerla al lado de su hermana enseña que las dos dicen
-- lo mismo de dos etapas, mientras que `reto_admite_etapa(p_reto, p_ws, 4)` invitaría a
-- llamarla con un número cualquiera para una etapa cuyo congelado nadie ha pensado.
--
-- Medido antes de escribirla, con G4 aprobado y la etapa 4 completada: un diseñador CREABA un
-- concepto nuevo y lo pasaba a 'pasa' sin prueba ninguna, y el gate ya firmado seguía firmado.
-- El guard del gate no lo ve porque solo corre al aprobar, así que G4 certificaba un
-- portafolio de conceptos que ya no era el que miró — exactamente lo que SYS-13 prohíbe,
-- alcanzado sin que ninguna regla fallara.
--
-- ── ANTI-ORÁCULO ──
-- Es SECURITY DEFINER y está concedida al rol de aplicación, así que la primera línea es la
-- misma puerta que su hermana: sin ella, cualquiera con un par de uuids ajenos le pregunta si
-- aquel reto tiene su G4 aprobado. Lo que se filtraría no es una fila, es LA RESPUESTA. Y se
-- distingue al llamante por `session_user` porque bajo SECURITY DEFINER `current_user` es
-- siempre el dueño, y el propietario —seed, migraciones, el guard que la llama sin contexto—
-- sí tiene que recibir la respuesta de verdad.
create function reto_admite_conceptos(p_reto uuid, p_ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $fn$
  -- `case` y no `or … and …` por lo mismo que en la hermana: la precedencia de `and` sobre
  -- `or` le daría al propietario un `true` constante en vez de la respuesta.
  select case
    when session_user = 'designio_app' and not is_workspace_member(app_user_id(), p_ws)
      then false
    -- Primero el ciclo de vida del reto, con la misma condición que `reto_admite_criterios` y
    -- `reto_admite_portafolio` —candidato o activo—: son la misma pregunta («¿este reto admite
    -- todavía trabajo de método?») y tres redacciones acabarían separándose. Cubre de paso el
    -- reto ARCHIVADO sin proyecto, que si no pasaría la puerta de G4 en vacío.
    when not exists (
      select 1 from reto r
      where r.id = p_reto and r.workspace_id = p_ws
        and r.estado in ('candidato', 'activo'))
      then false
    else not exists (
      select 1 from gate_instancia g
        join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
        join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
          and e.numero = 4
      where p.reto_id = p_reto and p.workspace_id = p_ws
        and g.numero = 4 and g.estado = 'aprobado' and e.estado <> 'en-curso')
  end;
$fn$;

revoke execute on function reto_admite_conceptos(uuid, uuid) from public;
grant execute on function reto_admite_conceptos(uuid, uuid) to designio_app;

-- Escribe quien hace método. El concepto nace CANDIDATO y sin veredicto: eso lo fija el CHECK
-- de arriba, así que la política no lo repite — repetirlo sería una segunda redacción del
-- mismo juicio, que es como este repositorio se ha equivocado antes.
create policy concepto_insert on concepto
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    -- Y solo mientras la etapa 4 siga abierta para este reto. La ventana incluye el ciclo de
    -- vida del reto —proponer un concepto para un reto cerrado o archivado es escribir en un
    -- expediente terminado— y además la puerta de G4.
    --
    -- Esta mitad, en el INSERT, no es la que rechaza: los triggers BEFORE corren antes de que
    -- se evalúe el `with check`, así que `concepto_candado_del_reto_guard` releé la ventana con
    -- el candado en la mano y levanta la excepción primero. Se comprobó neutralizándola sola:
    -- ninguna prueba se movió. Se queda de todos modos, y no por simetría: la política es donde
    -- se LEE la regla —quien audita quién puede escribir aquí mira las políticas, no los
    -- cuerpos de los guards— y es la única que sigue en pie si mañana alguien toca el trigger.
    -- En el UPDATE sí es la que actúa, y de otra forma: filtra la fila al escanear, así que el
    -- retoque no falla, no alcanza nada. Eso sí lo mueve una prueba.
    and reto_admite_conceptos(concepto.reto_id, concepto.workspace_id)
  );

-- Y actualizar —el veredicto, el umbral, la lectura, la N/A— por la MISMA ventana: si el gate
-- ya firmó este portafolio, moverle a un concepto lo que G4 miró es cambiar lo certificado
-- después de certificarlo.
create policy concepto_actualizar on concepto
  for update using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and reto_admite_conceptos(concepto.reto_id, concepto.workspace_id)
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
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

create policy concepto_evidencia_delete on concepto_evidencia
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from concepto c
      where c.id = concepto_evidencia.concepto_id
        and c.workspace_id = concepto_evidencia.workspace_id
        and c.estado = 'candidato'
        and reto_admite_conceptos(c.reto_id, c.workspace_id))
  );

grant select on concepto, concepto_evidencia to designio_app;
grant insert (workspace_id, reto_id, titulo, descripcion, creado_por) on concepto to designio_app;
-- ── QUÉ COLUMNAS SE CONCEDEN, Y CUÁLES NO ──
--
-- `decidido_por`, `decidido_en` y `test_na_aprobado_por` NO están: las escribe el trigger, y
-- un privilegio de columna solo se comprueba sobre lo que la SENTENCIA asigna, así que
-- quitarlas de aquí no le estorba al guard y sí cierra la puerta al UPDATE directo.
--
-- Estaban, y lo que dejaban hacer se midió: un lead ponía `decidido_por` a nombre del
-- diseñador —el veredicto atribuido a quien no lo tomó—, y un segundo UPDATE que no tocaba
-- `estado` esquivaba entera la rama de transición y retro-databa el sello a 2001. Autoría de
-- auditoría falsificable con la superficie concedida, sin SQL de propietario.
grant update (titulo, descripcion, estado, veredicto_razon,
              umbral_test, test_lectura, test_na_justificacion) on concepto to designio_app;
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
declare
  v_rol_del_gate text;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;

  -- ── AUTOR Y SELLO: LOS PONE LA BASE, Y DESPUÉS NO SE TOCAN ──
  --
  -- Los dos campos van juntos porque son el mismo hecho —quién decidió y cuándo— y por
  -- separado se falsificaban los dos. Fuera de la transición se REPONEN desde `old` en vez de
  -- confiar en que nadie los asigne: la rama de abajo solo corre cuando `estado` cambia, así
  -- que un UPDATE que deja el estado quieto la esquiva entera. Medido: retro-databa el sello a
  -- 2001 y cambiaba el autor, con G4 ya firmado sobre ese veredicto.
  if new.estado is distinct from old.estado then
    if old.estado <> 'candidato' then
      raise exception 'ese concepto ya se decidió: pasa/muere es un acto que queda, y volver atrás sería reescribir la historia. Si el equipo cambia de idea, el concepto es otro';
    end if;
    new.decidido_en := now();
    new.decidido_por := app_user_id();
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id,
      case when new.estado = 'pasa' then 'ConceptoPasa' else 'ConceptoMuere' end,
      jsonb_build_object('conceptoId', new.id, 'retoId', new.reto_id,
                         'razon', new.veredicto_razon),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  else
    new.decidido_en := old.decidido_en;
    new.decidido_por := old.decidido_por;
  end if;

  -- ── LA N/A LA FIRMA QUIEN APRUEBA G4, Y LA FIRMA CON SU NOMBRE ──
  --
  -- Es una EXCEPCIÓN a una regla del gate, así que solo puede concederla quien podría aprobar
  -- ese gate. Sin esto, la política de update —lead o diseñador— dejaba que un diseñador
  -- escribiera la justificación Y pusiera de aprobador a cualquier fila de `usuario`, incluida
  -- la de alguien que no es miembro del workspace: G4 leía «justificación no vacía» y daba la
  -- N/A por aprobada. Medido tal cual.
  --
  -- El rol sale del PROPIO gate (`rol_aprobador`) y no de una lista escrita aquí: quién firma
  -- G4 ya está decidido en `rolAprobadorDeGate`, y una segunda redacción se separaría de la
  -- primera en cuanto el método cambiara. Y el aprobador se sella desde `app_user_id()` por lo
  -- mismo que el veredicto: quien firma es quien está, no quien se escriba.
  if new.test_na_justificacion is distinct from old.test_na_justificacion then
    if old.estado <> 'candidato' then
      raise exception 'ese concepto ya se decidió: la N/A del test se aprueba antes del veredicto, no después (SYS-13)';
    end if;
    if btrim(new.test_na_justificacion) <> '' then
      select g.rol_aprobador into v_rol_del_gate
        from gate_instancia g
        join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
        where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id and g.numero = 4
        limit 1;
      if v_rol_del_gate is null then
        raise exception 'todavía no hay G4 en este reto: la N/A del test es una excepción a ese gate y no se puede aprobar antes de que exista (SYS-13)';
      end if;
      if workspace_role(app_user_id(), new.workspace_id) is distinct from v_rol_del_gate then
        raise exception 'la N/A del test de un concepto la aprueba el rol que firma G4 (%), y no quien pueda editar el concepto (SYS-13)', v_rol_del_gate;
      end if;
      new.test_na_aprobado_por := app_user_id();
    else
      new.test_na_aprobado_por := null;
    end if;
  else
    new.test_na_aprobado_por := old.test_na_aprobado_por;
  end if;

  -- ── EL UMBRAL SE DEFINE ANTES DE VER EL RESULTADO ──
  --
  -- «El umbral DEFINIDO» de SYS-13 no es un umbral que se escriba mirando la lectura. Lo que lo
  -- hace definido es que la fila no lo admita ya cuando hay prueba enlazada: hasta entonces se
  -- corrige libremente —todavía no se ha probado nada—, y desde entonces es el listón contra el
  -- que se lee.
  --
  -- Se cierra la ESCRITURA y no solo el cambio, y esa diferencia es toda la regla: bloquear
  -- únicamente los cambios dejaba abierta la única forma que de verdad importa de saltársela
  -- —enlazar la evidencia, mirar el resultado y ESCRIBIR ENTONCES el umbral que encaja—, que
  -- pasaría porque el valor viejo estaba vacío. Quien se dio cuenta tarde tiene salida y es la
  -- honesta: desenlazar la prueba (se puede mientras el concepto siga candidato), declarar el
  -- umbral y volver a enlazarla. Lo que no hay es escribir el listón con el resultado delante.
  --
  -- La lectura no se congela aquí: se registra después, por definición, y la congela el
  -- veredicto como a todo lo demás de la fila.
  if new.umbral_test is distinct from old.umbral_test
     and exists (select 1 from concepto_evidencia ce
       where ce.concepto_id = old.id and ce.workspace_id = old.workspace_id) then
    raise exception 'el umbral de test de ese concepto ya no se puede escribir: hay evidencia enlazada, y un listón que se pone con el resultado delante no es un umbral. Desenlaza la prueba, declara el umbral y vuelve a enlazarla (SYS-13)';
  end if;

  return new;
end $$;

create trigger b_concepto_veredicto
  before update on concepto
  for each row execute function concepto_veredicto_guard();

revoke execute on function concepto_veredicto_guard() from public;

-- ── EL CANDADO DEL RETO, QUE ES EL QUE YA TOMA LA APROBACIÓN DE G4 ──
--
-- La ventana de arriba y el CHECK de la fila cierran cada uno lo suyo mirando su propia
-- instantánea, y en READ COMMITTED dos transacciones toman fotos distintas y no se ven: la
-- aprobación de G4 lee el concepto todavía 'candidato' mientras el UPDATE que lo pasa a 'pasa'
-- sigue sin commitear. Las dos comprueban lo suyo, las dos pasan, las dos commitean — y queda
-- G4 firmado sobre un concepto que avanzó sin prueba. Es la misma carrera que la migración de
-- la oportunidad midió para G3, y se cierra igual.
--
-- La clave es `designio:reto:`, la misma que `gate_aprobar_suficiencia_guard` toma en su
-- primera línea, así que los dos lados se serializan sin protocolo nuevo. Va en un TRIGGER y
-- no en el servicio por lo de siempre: quien escribe por la superficie SQL concedida no
-- coopera con ningún protocolo del servicio.
--
-- ── EL ORDEN ──
-- `a_congelacion_por_disposicion` toma `designio:workspace:` en compartido y su prefijo lo
-- pone el primero, así que el orden del sistema sigue siendo workspace → reto. Y `b_candado…`
-- va antes que `b_concepto_veredicto` por orden de nombre, que es como Postgres dispara los
-- triggers de fila: el guard del veredicto encuentra el candado ya tomado antes de leer nada.
create function concepto_candado_del_reto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_reto uuid;
  v_concepto uuid;
  v_fila record;
begin
  v_fila := coalesce(new, old);
  if tg_table_name = 'concepto' then
    v_reto := v_fila.reto_id;
  else
    -- El id va a una VARIABLE y no se vuelve a nombrar desde el record más abajo: plpgsql
    -- resuelve los campos de un `record` al planificar cada sentencia, así que escribir
    -- `v_fila.concepto_id` dentro de una condición compuesta revienta también cuando la fila
    -- es de `concepto`, donde ese campo no existe — aunque la otra mitad diga que esa rama no
    -- aplica. La lección es de la migración de la oportunidad, y se paga una sola vez.
    v_concepto := v_fila.concepto_id;
    select c.reto_id into v_reto
      from concepto c
      where c.id = v_concepto and c.workspace_id = v_fila.workspace_id;
  end if;
  if v_reto is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
    -- Y la FILA del reto detrás de la clave, que es el orden del sistema: quien cierra el reto
    -- por SQL directo no toma ninguna clave, y su UPDATE toma FOR NO KEY UPDATE sobre esta
    -- misma fila. Entre dos escrituras de conceptos no hay espera: las dos piden compartido.
    perform 1 from reto r
     where r.id = v_reto and r.workspace_id = v_fila.workspace_id
     for share;
    -- Y VOLVER A PREGUNTAR, que es la mitad que faltaría. Esperar no basta: cuando este
    -- trigger corre, la fila YA está calificada —RLS se evaluó con la instantánea del inicio
    -- de la sentencia, antes de que existiera este candado— y Postgres no vuelve a evaluar la
    -- política porque un trigger BEFORE se haya quedado esperando.
    --
    -- El propietario no pasa por políticas y tampoco por aquí: seed, migraciones y backfills
    -- administran la base y responden por lo que escriben. Misma exención que el resto.
    if session_user = 'designio_app' then
      if not reto_admite_conceptos(v_reto, v_fila.workspace_id) then
        raise exception 'la etapa 4 de ese reto está cerrada: o su G4 está aprobado sin la etapa reabierta, o el reto ya no admite trabajo de método';
      end if;
      -- Y el ESTADO del concepto, que es la otra condición que miró la política del enlace.
      -- Releer una y dejar a la hermana con la foto vieja es el mismo error una capa más
      -- adentro: el enlace califica con el concepto todavía 'candidato', espera detrás del
      -- UPDATE que lo pasa, y al soltarse ata una prueba a un concepto ya juzgado.
      if v_concepto is not null and not exists (
        select 1 from concepto c
         where c.id = v_concepto and c.workspace_id = v_fila.workspace_id
           and c.estado = 'candidato') then
        raise exception 'ese concepto ya se decidió: su evidencia de test no se toca';
      end if;
    end if;
  end if;
  return v_fila;
end;
$fn$;

revoke execute on function concepto_candado_del_reto_guard() from public;

create trigger b_candado_del_reto
  before insert or update or delete on concepto
  for each row execute function concepto_candado_del_reto_guard();
create trigger b_candado_del_reto
  before insert or delete on concepto_evidencia
  for each row execute function concepto_candado_del_reto_guard();

-- ── EL GUARD DEL GATE, CON EL CANDADO DEL RETO QUE G4 TAMBIÉN NECESITA ──
--
-- La regla de SYS-13 no vive aquí: vive en `gate_faltas_para_aprobar`, más abajo, que es la
-- única redacción de «qué le falta a un gate» y la que lee también la bandeja. Lo que sí es de
-- este guard son los CANDADOS, y G4 no añade ninguno: la primera línea ya toma
-- `designio:reto:`, y las escrituras de conceptos toman esa misma clave en su propio trigger,
-- así que los dos lados ya se serializan.
--
-- Se reescribe entero de todos modos porque `create or replace` sustituye, y porque la rama
-- que este PR había puesto aquí —donde la bandeja no la veía— hay que quitarla de donde
-- estaba. El cuerpo sale de la ÚLTIMA versión vigente, la de la migración de la oportunidad.
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reto uuid;
  v_falta motivo_de_bloqueo;
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

-- ── SYS-13 EN G4, DONDE SE ESCRIBE «LO QUE LE FALTA A UN GATE» ──
--
-- El cuerpo entero se reescribe porque `create or replace` no parchea: SUSTITUYE. Sale de la
-- ÚLTIMA versión vigente —la de la migración de la oportunidad— y no de la original, que lleva
-- catorce reescrituras de diferencia. Copiarla de la primera fue exactamente el error que esta
-- nota existe para que no se repita: se cayeron el candado del reto, la puerta de G3 y todo lo
-- demás que se había ido añadiendo, y lo dijeron 52 pruebas a la vez.
--
-- Lo añadido es la rama `numero = 4`, y nada más.
create or replace function gate_faltas_para_aprobar(p_gate uuid, p_ws uuid)
returns setof motivo_de_bloqueo
language plpgsql stable set search_path = public, pg_temp as $$
declare
  g gate_instancia%rowtype;
  p proyecto%rowtype;
  v_motivo text;
  v_falta_concepto text;
begin
  select * into g from gate_instancia where id = p_gate and workspace_id = p_ws;
  if not found then return; end if;
  select * into p from proyecto where id = g.proyecto_id and workspace_id = p_ws;

  if exists (select 1 from checklist_item ci
    where ci.gate_id = g.id and ci.workspace_id = g.workspace_id
      and ci.estado = 'pendiente') then
    return next row('P0001', 'no se puede aprobar: checklist con pendientes')::motivo_de_bloqueo;
  end if;
  if not exists (select 1 from checklist_item ci
    where ci.gate_id = g.id and ci.workspace_id = g.workspace_id) then
    return next row('P0001', 'no se puede aprobar: el gate no tiene checklist instanciado')::motivo_de_bloqueo;
  end if;

  -- El protocolo de razonamiento sobre lo que el checklist consume (el recorrido es propio
  -- de esta ruta; el predicado es el de siempre).
  v_motivo := razonamiento_sin_respaldo(
    g.workspace_id,
    array(select ci.insight_id from checklist_item ci
            where ci.gate_id = g.id and ci.workspace_id = g.workspace_id
              and ci.estado = 'cumplido' and ci.insight_id is not null),
    array(select ci.decision_id from checklist_item ci
            where ci.gate_id = g.id and ci.workspace_id = g.workspace_id
              and ci.estado = 'cumplido' and ci.decision_id is not null),
    array(select ci.evidencia_id from checklist_item ci
            where ci.gate_id = g.id and ci.workspace_id = g.workspace_id
              and ci.estado = 'cumplido' and ci.evidencia_id is not null));
  if v_motivo is not null then
    return next row('DR001', 'no se puede aprobar: un ítem cumplido ' || v_motivo)::motivo_de_bloqueo;
  end if;

  if exists (select 1 from gate_instancia g2
    where g2.proyecto_id = g.proyecto_id and g2.workspace_id = g.workspace_id
      and g2.numero < g.numero and g2.estado <> 'aprobado') then
    return next row('P0001', format('no se puede aprobar G%s: los gates anteriores deben aprobarse primero', g.numero))::motivo_de_bloqueo;
  end if;

  if g.numero = 0 then
    if not exists (select 1 from criterio_exito c
      where c.reto_id = p.reto_id and c.workspace_id = g.workspace_id) then
      return next row('P0001', 'no se puede aprobar G0: sin criterios de éxito (SYS-22)')::motivo_de_bloqueo;
    end if;
    if exists (select 1 from criterio_exito c
      where c.reto_id = p.reto_id and c.workspace_id = g.workspace_id
        and (c.ventana_dias is null
             or btrim(c.kpi) = '' or btrim(c.definicion) = '' or btrim(c.objetivo) = ''
             or ((nullif(btrim(c.linea_base_valor), '') is null or c.linea_base_fecha is null)
                 and btrim(c.linea_base_plan) = ''))) then
      return next row('P0001', 'no se puede aprobar G0: criterios incompletos (SYS-22)')::motivo_de_bloqueo;
    end if;
  end if;

  -- G2 cierra el entendimiento: ningún arquetipo sigue en hipótesis, y los confirmados
  -- siguen teniendo evidencia con derechos VIVOS (eje tiempo: se confirmaron antes).
  if g.numero = 2 and exists (select 1 from arquetipo a
    where a.reto_id = p.reto_id and a.workspace_id = g.workspace_id
      and a.estado = 'hipotesis') then
    return next row('P0001', 'no se puede aprobar G2: hay arquetipos sin confirmar ni refutar (RF-04.11)')::motivo_de_bloqueo;
  end if;
  -- `derechos_vigentes` y no `evidencia_usable`: la regla sin la puerta, que aquí sobra (ver
  -- la cabecera). El guard la llamaba con puerta, y le valía porque quien aprueba siempre
  -- tiene `app.user_id`; la cruda tiene que valer también sin él.
  if g.numero = 2 and exists (select 1 from arquetipo a
    where a.reto_id = p.reto_id and a.workspace_id = g.workspace_id
      and a.estado = 'confirmado'
      and not exists (select 1 from arquetipo_evidencia ae
        where ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
          and derechos_vigentes(ae.evidencia_id, ae.workspace_id, 'cliente'))) then
    return next row('DR001', 'no se puede aprobar G2: un arquetipo confirmado ya no tiene ninguna evidencia con derechos vigentes que lo sostenga')::motivo_de_bloqueo;
  end if;

  -- G3 certifica el PORTAFOLIO de oportunidades de la etapa 3: SYS-15 sobre cada una que
  -- sigue viva, y su razonamiento todavía en pie.
  --
  -- Lo que NO se exige, dicho aquí porque su ausencia se nota: que el portafolio esté
  -- aprobado. Eso es expectativa del MÉTODO y este esquema ya tiene dónde ponerla —el
  -- checklist del gate, que se instancia por perfil—, mientras que SYS-15 es un invariante
  -- del OBJETO. Meterla aquí duplicaría el checklist y dejaría sin poder firmar G3 a todo
  -- proyecto que llegó a la etapa 3 antes de que la tabla existiera. Y por eso mismo las dos
  -- que sí van son vacuamente ciertas sin oportunidades: SYS-15 es una regla SOBRE ellas, no
  -- una regla que las exija.
  if g.numero = 3 then
    -- Las descartadas no entran —lo que se tiró no sostiene nada— y las PROPUESTAS sí: el
    -- invariante habla de la oportunidad, no de su veredicto, y dejar fuera las que nadie
    -- decidió sería aprobar G3 sobre preguntas sin apoyo con solo no decidirlas.
    if exists (select 1 from oportunidad o
      where o.reto_id = p.reto_id and o.workspace_id = g.workspace_id
        and o.estado <> 'descartada'
        and not exists (select 1 from oportunidad_insight oi
          where oi.oportunidad_id = o.id and oi.workspace_id = o.workspace_id)) then
      return next row('P0001', 'no se puede aprobar G3: hay una oportunidad que no traza a ningún insight (SYS-15)')::motivo_de_bloqueo;
    end if;
    -- EJE TIEMPO, el mismo que G2 tiene para los arquetipos y G5 para el diseño: aprobar una
    -- oportunidad exigió razonamiento en pie, pero eso fue cuando se aprobó. Entre aquel
    -- momento y éste se revocan derechos y se reabren decisiones, y G3 se firma con el
    -- sponsor delante.
    v_motivo := razonamiento_sin_respaldo(
      g.workspace_id,
      array(select oi.insight_id
              from oportunidad o
              join oportunidad_insight oi on oi.oportunidad_id = o.id
                and oi.workspace_id = o.workspace_id
              where o.reto_id = p.reto_id and o.workspace_id = g.workspace_id
                and o.estado <> 'descartada'),
      array[]::uuid[],
      array[]::uuid[]);
    if v_motivo is not null then
      return next row('DR001', 'no se puede aprobar: una oportunidad del portafolio ' || v_motivo)::motivo_de_bloqueo;
    end if;
  end if;

  -- ── SYS-13: LO QUE AVANZA EN LA ETAPA 4, SE PROBÓ ──
  --
  -- «G4 exige evidencia de test que alcance el umbral definido para cada concepto que avanza
  -- (o N/A aprobada)». Va AQUÍ y no en el guard por lo que dejó dicho la migración que creó
  -- esta función: ésta es la única redacción de «qué le falta a un gate», y la bandeja de
  -- aprobaciones lee la misma por `gate_faltas_para_aprobar_visible`. Escrita en el guard,
  -- quedaba invisible para la bandeja — medido: con un concepto pasado sin prueba, la bandeja
  -- no veía NINGUNA falta y anunciaba G4 como aprobable, y la aprobación fallaba después. Ese
  -- espejo a medias es exactamente lo que esta función vino a quitar.
  --
  -- Se exige POR CONCEPTO: un N/A suelto en el checklist habría tapado a todos los conceptos
  -- del gate a la vez, y SYS-13 dice «para cada concepto que avanza». Por eso la excepción vive
  -- en la fila del concepto y se lee aquí uno a uno.
  --
  -- Y se mira solo lo que AVANZA. El que murió no necesita prueba —su razón es su registro, y
  -- ya se la exige su CHECK— y el que sigue candidato no ha avanzado a ninguna parte: pedirle
  -- evidencia sería bloquear G4 por un concepto que nadie propuso pasar.
  --
  -- Las dos mitades del invariante, en el orden en que se leen: que HAYA prueba enlazada, y
  -- que esa prueba se lea contra un umbral. La segunda la garantiza además el CHECK de la fila
  -- —no se pasa sin umbral y lectura, o sin N/A—; se repite aquí porque las filas anteriores a
  -- este esquema no existen pero el gate sí, y porque el motivo que se enseña tiene que decir
  -- qué falta y no solo que algo falta.
  if g.numero = 4 then
    -- Se nombra el PRIMERO que falta, en vez de decir «alguno»: quien aprueba tiene que poder
    -- ir a arreglarlo sin buscarlo a mano entre todos los conceptos del reto.
    select c.titulo into v_falta_concepto
    from concepto c
    where c.reto_id = p.reto_id and c.workspace_id = g.workspace_id
      and c.estado = 'pasa'
      and btrim(c.test_na_justificacion) = ''
      and not exists (select 1 from concepto_evidencia ce
        where ce.concepto_id = c.id and ce.workspace_id = c.workspace_id)
    order by c.titulo asc
    limit 1;
    if v_falta_concepto is not null then
      return next row('P0001', format('no se puede aprobar G4: el concepto «%s» avanza sin evidencia de test enlazada ni N/A aprobada (SYS-13)', v_falta_concepto))::motivo_de_bloqueo;
    end if;
    select c.titulo into v_falta_concepto
    from concepto c
    where c.reto_id = p.reto_id and c.workspace_id = g.workspace_id
      and c.estado = 'pasa'
      and btrim(c.test_na_justificacion) = ''
      and (btrim(c.umbral_test) = '' or btrim(c.test_lectura) = '')
    order by c.titulo asc
    limit 1;
    if v_falta_concepto is not null then
      return next row('P0001', format('no se puede aprobar G4: el concepto «%s» avanza con evidencia de test pero sin umbral definido y su lectura, así que nadie puede decir que lo alcanzó (SYS-13)', v_falta_concepto))::motivo_de_bloqueo;
    end if;
  end if;

  -- G5 firma el DISEÑO: tiene que existir congelado (aprobada o superada) y con elementos,
  -- y su razonamiento tiene que seguir siendo usable (ver 20260902320000).
  if g.numero = 5 then
    if not exists (
      select 1 from design_version dv
      where dv.id in (select design_versions_a_cargo_del_proyecto(g.proyecto_id, g.workspace_id))
        and exists (select 1 from elemento_cambio ec
          where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id)
    ) then
      return next row('P0001', 'no se puede aprobar G5: el proyecto no tiene ninguna design version aprobada con elementos que certificar (RF-06.3)')::motivo_de_bloqueo;
    end if;
    v_motivo := razonamiento_sin_respaldo(
      g.workspace_id,
      array(select ei.insight_id
              from elemento_cambio ec
              join elemento_insight ei on ei.elemento_id = ec.id and ei.workspace_id = ec.workspace_id
              where ec.workspace_id = g.workspace_id
                and ec.design_version_id in (
                  select design_versions_a_cargo_del_proyecto(g.proyecto_id, g.workspace_id))),
      array(select ed.decision_id
              from elemento_cambio ec
              join elemento_decision ed on ed.elemento_id = ec.id and ed.workspace_id = ec.workspace_id
              where ec.workspace_id = g.workspace_id
                and ec.design_version_id in (
                  select design_versions_a_cargo_del_proyecto(g.proyecto_id, g.workspace_id))),
      array[]::uuid[]);
    if v_motivo is not null then
      return next row('DR001', 'no se puede aprobar: el diseño que certifica G5 ' || v_motivo)::motivo_de_bloqueo;
    end if;
  end if;

  -- G6 firma el PLAN: registry firmado (SYS-22), diseño con elementos y cada elemento con
  -- release (RF-06.4). Y el proyecto activo, porque aprobar lo pone en implementación (§7):
  -- lo impone el trigger AFTER, aquí solo se anticipa.
  if g.numero = 6 then
    if not exists (select 1 from metric_registry r
      where r.reto_id = p.reto_id and r.workspace_id = g.workspace_id
        and r.estado = 'firmado') then
      return next row('P0001', 'no se puede aprobar G6: el Metric Registry no está firmado (SYS-22)')::motivo_de_bloqueo;
    end if;
    if not exists (
      select 1 from design_version dv
      where dv.id in (select design_versions_a_cargo_del_proyecto(g.proyecto_id, g.workspace_id))
        and exists (select 1 from elemento_cambio ec
          where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id)
    ) then
      return next row('P0001', 'no se puede aprobar G6: el proyecto no tiene ninguna design version con elementos que planificar (RF-06.4)')::motivo_de_bloqueo;
    end if;
    if exists (
      select 1 from elemento_cambio ec
      where ec.workspace_id = g.workspace_id
        and ec.design_version_id in (
          select design_versions_a_cargo_del_proyecto(g.proyecto_id, g.workspace_id))
        and not exists (select 1 from release_elemento re
          where re.elemento_id = ec.id and re.workspace_id = ec.workspace_id)
    ) then
      return next row('P0001', 'no se puede aprobar G6: hay elementos de la design version sin release asignado (RF-06.4)')::motivo_de_bloqueo;
    end if;
    if p.estado <> 'activo' then
      return next row('P0001', 'no se puede aprobar G6 con el proyecto parado: retómalo antes, porque aprobar el plan lo pone en implementación (§7)')::motivo_de_bloqueo;
    end if;
  end if;

  -- G7 cierra la implementación: las cuatro ramas viven en `g7_motivo_de_bloqueo`.
  if g.numero = 7 then
    v_motivo := g7_motivo_de_bloqueo(g.proyecto_id, g.workspace_id);
    if v_motivo is not null then
      return next row('P0001', 'no se puede aprobar G7: ' || v_motivo)::motivo_de_bloqueo;
    end if;
  end if;

  return;
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
