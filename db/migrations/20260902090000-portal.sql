-- SPEC-01 — Portal de comentarios (RF-01.5) y auditoría consultable (RF-01.6).
-- El portal es el canal DEL CLIENTE: todo objeto presentable admite hilos de comentarios
-- con identidad, rol y timestamp, y los hilos se resuelven (abierto/resuelto) por
-- curadores. Los objetos citables de este slice son los que YA existen en el modelo:
-- reto, proyecto, gate_instancia y evidencia; design version y post mortem entran al
-- arco cuando lleguen con sus specs (SPEC-05/SPEC-07). Fuera de este slice: las
-- aprobaciones de gate (viven en SPEC-04, ya implementadas), las notificaciones por
-- correo y la exportación (RF-01.8).
--
-- Mismo patrón multi-tenant de las migraciones previas: FKs compuestas (id, workspace_id)
-- contra cada tabla padre, RLS activo desde el día 1, autoría fijada en la política y
-- eventos de dominio emitidos por trigger — con el rol del MISMO snapshot que autorizó
-- la escritura, también cuando la escritura llega por SQL directo.

-- ── Hilos sobre objetos presentables (RF-01.5) ──
-- La referencia al objeto es polimórfica, y se paga con un ARCO EXCLUSIVO (una columna
-- por tipo) en lugar de un par (tipo, id) genérico: solo así sobrevive la FK COMPUESTA
-- (id, workspace_id) contra cada padre. Un (tipo, id) suelto no tendría integridad
-- alguna — admitiría hilos colgando de objetos inexistentes o, peor, de objetos de otro
-- tenant (SYS-01/02). objeto_tipo/objeto_id son columnas GENERADAS: dan la proyección
-- uniforme que necesitan las consultas sin que nadie pueda escribirlas (ni falsear a qué
-- objeto apunta un hilo).
create table hilo_comentario (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid,
  proyecto_id uuid,
  gate_id uuid,
  evidencia_id uuid,
  objeto_tipo text generated always as (
    case
      when reto_id is not null then 'reto'
      when proyecto_id is not null then 'proyecto'
      when gate_id is not null then 'gate_instancia'
      when evidencia_id is not null then 'evidencia'
    end
  ) stored,
  objeto_id uuid generated always as (
    coalesce(reto_id, proyecto_id, gate_id, evidencia_id)
  ) stored,
  estado text not null default 'abierto' check (estado in ('abierto', 'resuelto')),
  abierto_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  resuelto_por uuid references usuario(id),
  resuelto_en timestamptz,
  unique (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  foreign key (proyecto_id, workspace_id) references proyecto (id, workspace_id),
  foreign key (gate_id, workspace_id) references gate_instancia (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id),
  -- EXACTAMENTE un objeto: ni hilos huérfanos (sin nada que comentar) ni hilos colgados
  -- de dos objetos a la vez (¿de quién sería la conversación?).
  check (num_nonnulls(reto_id, proyecto_id, gate_id, evidencia_id) = 1),
  -- Estado y sello inseparables: un abierto no arrastra restos de resolución y un
  -- resuelto siempre sabe quién y cuándo. Reabrir limpia el sello — la historia de
  -- resoluciones no se pierde: vive en evento_dominio, que es append-only.
  check ((estado = 'resuelto') = (resuelto_por is not null)),
  check ((resuelto_por is not null) = (resuelto_en is not null))
);
-- La consulta del portal es «los hilos de ESTE objeto», en orden estable.
create index hilo_objeto_idx on hilo_comentario (workspace_id, objeto_tipo, objeto_id, creado_en, id);

-- Un comentario es INMUTABLE (sin update ni delete, ni políticas ni grants): el portal
-- es la superficie auditada de la co-creación (RF-01.5/01.6) y un comentario que puede
-- reescribirse en silencio no acredita nada de lo que se dijo en un gate.
create table comentario (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  hilo_id uuid not null,
  -- Contenido acotado y con sustancia: whitespace no es un comentario (SPEC-09: bounds
  -- antes de cualquier procesamiento).
  -- No basta btrim(): con un solo argumento quita espacios, no tabuladores ni saltos,
  -- así que un cuerpo de puros \n pasaba por la puerta del SQL directo y producía un
  -- comentario visualmente vacío con su evento de auditoría detrás. El regex exige al
  -- menos un carácter que no sea espacio en blanco, sea cual sea.
  cuerpo text not null check (cuerpo ~ '[^[:space:]]' and length(cuerpo) <= 5000),
  autor_id uuid not null references usuario(id),
  -- El rol CONGELADO con el que se habló: la membresía cambia (un stakeholder asciende a
  -- admin-cliente) y el acta del portal debe seguir diciendo bajo qué rol se dijo cada
  -- cosa. Lo fija la política, no el caller.
  autor_rol text not null,
  creado_en timestamptz not null default now(),
  foreign key (hilo_id, workspace_id) references hilo_comentario (id, workspace_id)
);
create index comentario_hilo_idx on comentario (workspace_id, hilo_id, creado_en, id);

-- ── RLS ──
-- Lectura: miembros del workspace (el hilo es del cliente, no de quien lo abrió).
-- Escrituras:
--  · hilo/comentario INSERT — cualquier miembro HUMANO, stakeholder y sponsor incluidos:
--    el portal es SU canal (RF-01.5). Queda fuera agente-ai (I4/SYS-18: la AI propone
--    por su carril, no publica en el portal).
--  · hilo UPDATE — solo curadores (lead-boutique/diseñador) y solo el estado: el cliente
--    abre y conversa, la boutique cierra el hilo cuando la conversación terminó.
--  · comentario UPDATE/DELETE — no existen (append-only).

alter table hilo_comentario enable row level security;
alter table comentario enable row level security;

create policy hilo_select on hilo_comentario
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy comentario_select on comentario
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy hilo_insert on hilo_comentario
  for insert with check (
    coalesce(workspace_role(app_user_id(), workspace_id), '') not in ('', 'agente-ai')
    and abierto_por = app_user_id()
    -- Todo hilo NACE abierto y sin sello: sin esto, cualquier miembro insertaría directo
    -- un hilo «resuelto» con resolución forjada, esquivando la política de UPDATE.
    and estado = 'abierto'
    and resuelto_por is null
    and resuelto_en is null
  );

create policy comentario_insert on comentario
  for insert with check (
    coalesce(workspace_role(app_user_id(), workspace_id), '') not in ('', 'agente-ai')
    and autor_id = app_user_id()
    -- La atribución no la elige el caller: el rol auditado es el que la política evalúa
    -- en el mismo snapshot que autoriza la escritura.
    and autor_rol = workspace_role(app_user_id(), workspace_id)
    -- Un hilo resuelto está CERRADO: si la conversación sigue, un curador lo reabre. Sin
    -- esto, «resuelto» no significaría nada — el acta seguiría creciendo por detrás.
    and exists (select 1 from hilo_comentario h
      where h.id = comentario.hilo_id and h.workspace_id = comentario.workspace_id
        and h.estado = 'abierto')
  );

create policy hilo_update_resolucion on hilo_comentario
  for update
  using (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'))
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    -- Los dos únicos pares legales, con su sello coherente: resolver deja quién y cuándo
    -- (y el quién es el actor, no un tercero); reabrir lo limpia.
    and (
      (estado = 'resuelto' and resuelto_por = app_user_id() and resuelto_en is not null)
      or (estado = 'abierto' and resuelto_por is null and resuelto_en is null)
    )
  );

-- ── La auditoría se consulta, y no por cualquiera (RF-01.6) ──
-- evento_dominio nació legible para todo miembro; la spec dice quién rinde cuentas: el
-- admin del cliente (dueño de los datos, RF-01.4) y LA BOUTIQUE (operador) — que son sus
-- dos roles, lead y diseñador, no solo el lead. Para sponsor y stakeholder la auditoría
-- NO EXISTE: cero filas por RLS, no una pantalla escondida por conveniencia de UI. La
-- política de INSERT queda intacta: todo miembro sigue generando eventos con sus
-- acciones, aunque no pueda leerlos.
drop policy evento_select on evento_dominio;
create policy evento_select on evento_dominio
  for select using (
    workspace_role(app_user_id(), workspace_id)
      in ('admin-cliente', 'lead-boutique', 'disenador')
  );

-- La auditoría se LEE en orden, y con el default now() todos los eventos de una misma
-- transacción comparten instante (now() es el inicio de la transacción): la pantalla los
-- mostraría en orden arbitrario — «ComentarioPublicado» antes del «HiloAbierto» que lo
-- contiene. clock_timestamp() estampa el instante real de cada inserción. El keyset sigue
-- desempatando por id de todos modos: la corrección no depende de que no haya empates.
alter table evento_dominio alter column creado_en set default clock_timestamp();

-- La pantalla pagina por keyset (creado_en, id) descendente y filtra por tipo: el índice
-- de workspace+fecha no desempataba por id (dos eventos del mismo instante se saltaban o
-- repetían al paginar) y no cubría el filtro.
drop index evento_dominio_ws_idx;
create index evento_dominio_ws_idx on evento_dominio (workspace_id, creado_en desc, id desc);
create index evento_dominio_tipo_idx on evento_dominio (workspace_id, tipo, creado_en desc, id desc);

-- ── Guards: los eventos van CON la escritura, también por SQL directo ──

-- Abrir un hilo es un acto del portal: deja rastro con el objeto sobre el que se abre.
-- AFTER (no BEFORE): el WITH CHECK ya pasó, así que aquí solo llega quien es miembro
-- —sin oráculo de existencia cross-tenant— y las columnas GENERADAS ya están calculadas.
create function hilo_abierto_evento() returns trigger
language plpgsql as $$
begin
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'HiloAbierto',
      jsonb_build_object('hiloId', new.id, 'objetoTipo', new.objeto_tipo,
                         'objetoId', new.objeto_id),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return null;
end $$;
create trigger hilo_abierto
  after insert on hilo_comentario
  for each row execute function hilo_abierto_evento();
revoke execute on function hilo_abierto_evento() from public;

-- Serialización comentar↔resolver. Las políticas son chequeos por snapshot: bajo READ
-- COMMITTED, el WITH CHECK de un comentario en vuelo no ve la resolución concurrente
-- todavía sin commitear, así que un comentario podría colarse en un hilo ya cerrado.
-- Este guard toma el candado de FILA del hilo (FOR UPDATE conflictúa con el NO KEY
-- UPDATE de la resolución) y re-verifica en una sentencia nueva: en READ COMMITTED cada
-- sentencia de plpgsql toma snapshot fresco, así que quien llega segundo ve lo que el
-- primero commiteó mientras esperaba. SECURITY DEFINER porque bloquear la fila del hilo
-- bajo RLS exigiría pasar el USING de la política de resolución, que un stakeholder
-- —comentarista legítimo— no cumple.
create function comentario_hilo_abierto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hilo record;
begin
  select h.estado, h.objeto_tipo, h.objeto_id into v_hilo
  from hilo_comentario h
  where h.id = new.hilo_id and h.workspace_id = new.workspace_id
  for update;
  -- Si el hilo no existe (o es de otro workspace), que hable la FK compuesta —aborta la
  -- transacción entera—: aquí no hay nada que serializar ni que auditar.
  if not found then
    return null;
  end if;
  if v_hilo.estado = 'resuelto' then
    raise exception 'el hilo ya está resuelto: reábrelo para seguir la conversación';
  end if;
  -- El rastro del portal es la métrica de adopción (§17) y el acta de la co-creación:
  -- cada comentario deja evento con su hilo y su objeto. El servicio ya no lo duplica —
  -- esta es la única fuente, y cubre también el INSERT por SQL directo.
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'ComentarioPublicado',
      jsonb_build_object('comentarioId', new.id, 'hiloId', new.hilo_id,
                         'objetoTipo', v_hilo.objeto_tipo, 'objetoId', v_hilo.objeto_id),
      new.autor_id, new.autor_rol);
  return null;
end $$;
create trigger comentario_hilo_abierto
  after insert on comentario
  for each row execute function comentario_hilo_abierto_guard();
revoke execute on function comentario_hilo_abierto_guard() from public;

-- El sello de la resolución lo pone la BASE, no el caller: ni por SQL directo se puede
-- atribuir una resolución a otra persona ni retro/post-datarla (el rol de app ni
-- siquiera tiene grant sobre esas columnas). Sin contexto de usuario —una conexión
-- administrativa— app_user_id() es null y el CHECK de coherencia aborta: resolver un
-- hilo exige identidad.
create function hilo_resolucion_guard() returns trigger
language plpgsql as $$
begin
  if new.estado = old.estado then
    return new;
  end if;
  if new.estado = 'resuelto' then
    new.resuelto_por := app_user_id();
    new.resuelto_en := now();
  else
    new.resuelto_por := null;
    new.resuelto_en := null;
  end if;
  -- El objeto sale de OLD: en un trigger BEFORE las columnas generadas de NEW aún no
  -- están calculadas (y no deben leerse), y el arco es inmutable — el objeto de un hilo
  -- es el mismo antes y después de resolverlo.
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id,
      case new.estado when 'resuelto' then 'HiloResuelto' else 'HiloReabierto' end,
      jsonb_build_object('hiloId', new.id, 'objetoTipo', old.objeto_tipo,
                         'objetoId', old.objeto_id),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger hilo_resolucion
  before update of estado on hilo_comentario
  for each row execute function hilo_resolucion_guard();
revoke execute on function hilo_resolucion_guard() from public;

-- Un hilo VACÍO no es un hilo: nace con su primer comentario (que es lo que se comenta).
-- Diferido al commit para que abrirHilo —que inserta hilo y comentario en la misma
-- transacción— pase, y el INSERT crudo solitario aborte. El pre-chequeo de membresía
-- salta el guard para conexiones administrativas sin contexto (seed, backfill), igual
-- que los guards del método.
create function hilo_con_comentario_guard() returns trigger
language plpgsql as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return null;
  end if;
  if not exists (select 1 from comentario c
    where c.hilo_id = new.id and c.workspace_id = new.workspace_id) then
    raise exception 'un hilo nace con su primer comentario: usa el portal de la app';
  end if;
  return null;
end $$;
create constraint trigger hilo_con_comentario
  after insert on hilo_comentario
  deferrable initially deferred
  for each row execute function hilo_con_comentario_guard();
revoke execute on function hilo_con_comentario_guard() from public;

-- ── Grants mínimos (UPDATE por columnas: solo la transición del hilo) ──
grant select, insert on hilo_comentario to designio_app;
grant select, insert on comentario to designio_app;
-- Solo `estado`: el sello (resuelto_por/resuelto_en) lo escribe el guard de la
-- transición, y el objeto del hilo es inmutable — un hilo no se muda de objeto ni de
-- tenant. comentario sin UPDATE/DELETE: append-only, como evento_dominio.
grant update (estado) on hilo_comentario to designio_app;
