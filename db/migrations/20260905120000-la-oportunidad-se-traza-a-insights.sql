-- ── La oportunidad (HMW) existe, y no se sostiene sola ──
--
-- CTX-04 la tiene definida desde el principio —«pregunta how might we trazable a uno o más
-- insights»— y el esquema no tenía dónde ponerla. La etapa 3 es la única del método sin su
-- objeto: G3 se aprobaba sin nada que mirar, porque no había nada. Eso convierte SYS-15
-- («una oportunidad referencia ≥1 insight (G3)») en una frase de un documento, que es la
-- forma más silenciosa de no cumplir un invariante.
--
-- ═══ LO QUE ESTA MIGRACIÓN DECIDE, Y POR QUÉ ═══
--
-- 1. LA ORACIÓN ES «HMW …», Y ESO NO LO COMPRUEBA LA BASE. Se guarda la pregunta como texto
--    no vacío y punto. Exigir el prefijo por CHECK sería imponer un idioma —«¿cómo podríamos
--    …?», «how might we …»— a un producto que se usa en español y en inglés, y una regla que
--    se rodea escribiendo «HMW: » delante no es una regla: es una fricción.
--
-- 2. EL VEREDICTO ES DEL PORTAFOLIO, NO DE LA PREGUNTA SUELTA. `estado` va de 'propuesta' a
--    'aprobada' o 'descartada', igual que el arquetipo va de hipótesis a confirmado o
--    refutado, y por lo mismo: G3 aprueba un PORTAFOLIO (prediseño §3), así que dejar una
--    oportunidad sin decidir es dejar el portafolio a medias. Descartar exige razón —la
--    misma disciplina que `arquetipo.veredicto_razon`—: lo que se tira de la etapa 3 es
--    justo lo que alguien va a volver a proponer en la 4 si no consta por qué se tiró.
--
-- 3. LA TRAZA ES UNA TABLA, NO UNA COLUMNA. `oportunidad_insight` es n:m porque el modelo lo
--    dice («trazable a uno o más insights») y porque el caso real es ése: una HMW nace de la
--    tensión entre dos insights más veces que de uno solo.
--
-- 4. Y SOLO ADMITE INSIGHTS VALIDADOS, POR POLÍTICA. Es literalmente la regla que
--    20260902260000 tuvo que añadir a `decision_insight` después de comprobar sobre una base
--    viva que un insight `propuesto` —bien citado y con derechos vigentes— atravesaba entero
--    el guard del gate. Un insight `propuesto` no ha pasado la barra de suficiencia de
--    `insight_validar_guard`; apoyar en él una oportunidad, y a través de ella G3, es
--    trazabilidad de mentira. Va en la política y no en un trigger por el mismo motivo que
--    allí: el escritor que hay que cerrar es el ROL DE APLICACIÓN por SQL directo.
--
-- 5. APROBAR RE-COMPRUEBA EL RAZONAMIENTO, NO SOLO QUE EXISTA EL ENLACE. Entre enlazar y
--    aprobar caben semanas, y en ese hueco se revocan derechos. `razonamiento_usable_guard`
--    es el protocolo que este esquema ya tiene escrito para eso —candados sobre los derechos
--    ANTES de leerlos, y el mismo predicado que miran los pickers—, así que la aprobación de
--    una oportunidad entra por ahí en vez de estrenar una comprobación propia que nacería
--    divergiendo. Es el eje TIEMPO, el que ya obligó a re-comprobar los arquetipos en G2.
--
-- 6. G3 MIRA EL PORTAFOLIO ENTERO. La rama `numero = 3` de `gate_aprobar_suficiencia_guard`
--    exige: que haya portafolio, que no quede nada sin decidir, que toda oportunidad viva
--    trace a ≥1 insight (SYS-15) y que ese razonamiento siga en pie con derechos vivos. La
--    cuarta es la que no se puede omitir aunque las tres primeras se comprobaran al aprobar
--    cada oportunidad: se aprueba G3 con el cliente delante.

-- ═══════════════════════════════════════════════════════════════════════════
-- LA TABLA
-- ═══════════════════════════════════════════════════════════════════════════

create table oportunidad (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid not null,
  -- La pregunta. `unique (reto_id, pregunta)` para que el portafolio no acumule la misma
  -- HMW escrita dos veces: priorizar un duplicado es repartir el mismo voto dos veces.
  pregunta text not null check (btrim(pregunta) <> ''),
  -- La priorización RAZONADA (SPEC-08 C3, prediseño §3: «priorización contra criterios del
  -- reto»). El número ordena; el texto dice por qué, que es la mitad que se pierde siempre.
  prioridad integer not null default 0,
  prioridad_razon text not null default '',
  estado text not null default 'propuesta'
    check (estado in ('propuesta', 'aprobada', 'descartada')),
  veredicto_razon text not null default '',
  decidido_por uuid references usuario(id),
  decidido_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (reto_id, pregunta),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  -- Descartar exige razón. Aprobar no: la razón de una HMW aprobada son sus insights, que
  -- están enlazados y se pueden leer; la de una descartada no la guarda nadie más.
  check (estado <> 'descartada' or btrim(veredicto_razon) <> ''),
  -- Y todo veredicto lleva firma y fecha, como el resto del esquema.
  check ((estado = 'propuesta') = (decidido_por is null)),
  check ((decidido_por is null) = (decidido_en is null))
);
create index oportunidad_reto_idx on oportunidad (workspace_id, reto_id, prioridad desc, creado_en);

-- La traza. Sin `creado_por`: quién enlazó un insight a una HMW no es una decisión firmada
-- —lo es el veredicto de la oportunidad, que sí la lleva— y una columna que nadie lee es
-- una columna que miente sobre lo que se auditó. Mismo criterio que `decision_insight`.
create table oportunidad_insight (
  oportunidad_id uuid not null,
  insight_id uuid not null,
  workspace_id uuid not null references workspace(id),
  creado_en timestamptz not null default now(),
  primary key (oportunidad_id, insight_id),
  foreign key (oportunidad_id, workspace_id) references oportunidad (id, workspace_id),
  foreign key (insight_id, workspace_id) references insight (id, workspace_id)
);
create index oportunidad_insight_insight_idx
  on oportunidad_insight (workspace_id, insight_id);

alter table oportunidad enable row level security;
alter table oportunidad_insight enable row level security;

-- ═══════════════════════════════════════════════════════════════════════════
-- QUIÉN ESCRIBE QUÉ
-- ═══════════════════════════════════════════════════════════════════════════

-- La VENTANA en la que el portafolio se puede tocar, escrita UNA vez porque la miran cuatro
-- políticas. G3 certifica un portafolio; lo que certificó no se cambia por debajo sin reabrir
-- la etapa 3, que es la misma regla que `arquetipo_insert` aplica a G2 y la misma que I1
-- pide para todo lo que un gate dejó firmado.
--
-- Escribirla solo en el INSERT —que es como nació— dejaba abierto justo lo que más importa:
-- con G3 aprobado, se podía BORRAR el último enlace de una oportunidad viva y dejar el gate
-- firmado incumpliendo SYS-15, sin que nadie reabriera nada. El guard del gate no lo ve
-- porque solo corre al aprobar.
--
-- ── ANTI-ORÁCULO ──
-- Es SECURITY DEFINER, así que no pasa por RLS, y está concedida al rol de aplicación: sin
-- esta primera línea, cualquiera con un par de uuids ajenos puede preguntarle si aquel reto
-- tiene su G3 aprobado y su etapa cerrada. Lo que se filtra no es una fila, es la RESPUESTA —
-- el mismo argumento con el que `congelacion_por_disposicion_guard` se calla ante quien no es
-- miembro—, y por eso se distingue al llamante por `session_user`: bajo SECURITY DEFINER,
-- `current_user` es siempre el dueño, y el propietario (seed, migraciones, el guard que la
-- llama sin contexto) sí tiene que recibir la respuesta de verdad.
--
-- Devolver `false` para el no-miembro es además lo correcto y no solo lo callado: significa
-- «esa ventana no está abierta para ti», y las políticas que la miran ya exigen además un rol
-- del workspace, así que ninguna escritura ajena dependía de otra respuesta.
create function reto_admite_portafolio(p_reto uuid, p_ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $fn$
  -- `case` y no `or … and …`: la precedencia de `and` sobre `or` haría que el propietario
  -- recibiera `true` siempre en vez de la respuesta de verdad. Escrito así no hay que
  -- acordarse de la precedencia para leerlo.
  select case
    when session_user = 'designio_app' and not is_workspace_member(app_user_id(), p_ws)
      then false
    else not exists (
      select 1 from gate_instancia g
        join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
        join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
          and e.numero = 3
      where p.reto_id = p_reto and p.workspace_id = p_ws
        and g.numero = 3 and g.estado = 'aprobado' and e.estado <> 'en-curso')
  end;
$fn$;

revoke execute on function reto_admite_portafolio(uuid, uuid) from public;
grant execute on function reto_admite_portafolio(uuid, uuid) to designio_app;

-- Verla es de todo miembro: el portal existe para que el cliente vea el razonamiento, y una
-- oportunidad es exactamente el razonamiento que se le enseña en la etapa 3.
create policy oportunidad_select on oportunidad
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- Proponerla, quien hace el trabajo de diseño. Siempre 'propuesta' y firmada: el veredicto
-- tiene su propia política, y nacer aprobada sería saltarse la puerta desde el nacimiento.
-- La ventana es la misma que la del arquetipo: con G3 ya aprobado no se añaden oportunidades
-- al portafolio que G3 aprobó, salvo que la etapa esté reabierta (I1).
create policy oportunidad_insert on oportunidad
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'propuesta'
    and decidido_por is null
    and reto_admite_portafolio(oportunidad.reto_id, oportunidad.workspace_id)
  );

-- UNA sola política de UPDATE, y esto es una decisión, no un descuido. Las dos escrituras
-- que existen —repriorizar y decidir— parecen pedir dos políticas, pero las políticas
-- permisivas se combinan con OR: dos habrían dado la UNIÓN de sus permisos, no la
-- intersección, y la que dijera «esta puerta no cambia el estado» no habría impedido nada.
-- Escribirlas separadas habría documentado una distinción que la base no hace.
--
-- Lo que de verdad gobierna está repartido así:
--   · La IRREVERSIBILIDAD la da el `using`: solo se actualiza lo que sigue en 'propuesta',
--     así que un veredicto no se puede repisar. Mismo patrón que `arquetipo_veredicto`.
--   · Los valores posibles de `estado` los da el CHECK de la tabla, no la política.
--   · Que `pregunta` y `reto_id` NO se puedan tocar lo da el GRANT por columnas, que no los
--     incluye. Repetirlo aquí sugeriría que la política es lo que los protege.
--   · Que aprobar exija traza y razonamiento vivo lo da `oportunidad_veredicto_guard`.
-- El `with check` no puede omitirse: sin él Postgres reusa el `using` para la fila nueva y
-- entonces ningún veredicto pasaría, porque la fila nueva ya no está en 'propuesta'.
create policy oportunidad_actualizar on oportunidad
  for update using (
    estado = 'propuesta'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and reto_admite_portafolio(reto_id, workspace_id)
  ) with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and reto_admite_portafolio(reto_id, workspace_id)
  );

create policy oportunidad_insight_select on oportunidad_insight
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy oportunidad_insight_insert on oportunidad_insight
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    -- La traza se hace de insights VALIDADOS. Ver el punto 4 de la cabecera: es la regla
    -- que `decision_insight_insert` ya lleva, y por el mismo agujero medido.
    and exists (select 1 from insight i
      where i.id = oportunidad_insight.insight_id
        and i.workspace_id = oportunidad_insight.workspace_id
        and i.estado = 'validado')
    -- Y solo mientras la oportunidad esté por decidir: enlazar un insight a una HMW ya
    -- aprobada cambiaría, después del hecho, en qué se apoyó una aprobación.
    and exists (select 1 from oportunidad o
      where o.id = oportunidad_insight.oportunidad_id
        and o.workspace_id = oportunidad_insight.workspace_id
        and o.estado = 'propuesta'
        and reto_admite_portafolio(o.reto_id, o.workspace_id))
  );

-- Desenlazar mientras está por decidir: corregir la traza es parte de armarla. Después del
-- veredicto no, por lo mismo que arriba — y tampoco con G3 firmado, que es el caso serio:
-- borrar el último enlace de una oportunidad viva deja el gate certificando un portafolio
-- que ya no cumple SYS-15, y el guard del gate no vuelve a correr para desmentirlo.
create policy oportunidad_insight_delete on oportunidad_insight
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from oportunidad o
      where o.id = oportunidad_insight.oportunidad_id
        and o.workspace_id = oportunidad_insight.workspace_id
        and o.estado = 'propuesta'
        and reto_admite_portafolio(o.reto_id, o.workspace_id))
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- APROBAR UNA OPORTUNIDAD: EL ENLACE TIENE QUE EXISTIR Y TIENE QUE SEGUIR SIRVIENDO
-- ═══════════════════════════════════════════════════════════════════════════

create function oportunidad_veredicto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  -- Pre-chequeo anti-oráculo, el mismo que lleva `propuesta_ai_revision_guard`: sin contexto
  -- de aplicación no hay a quién atribuir el veredicto ni nada que serializar. A diferencia
  -- de las POLÍTICAS, un trigger sí corre para el propietario, así que sin esta salida el
  -- seed y los backfills —que corren como owner— no podrían escribir un veredicto: la firma
  -- saldría nula y el CHECK de la tabla la rechazaría. Quien administra la base responde por
  -- lo que escribe, y lo que escriba lo vuelve a mirar el guard de G3.
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;

  -- La firma la pone la BASE, no quien llama: un update directo no puede atribuir el
  -- veredicto a otro ni fecharlo fuera de su momento. Mismo criterio que el sello de
  -- `gate_aprobar_suficiencia_guard`.
  new.decidido_por := app_user_id();
  new.decidido_en := now();

  if new.estado = 'aprobada' then
    -- SYS-15, en el momento en que deja de ser una propuesta.
    if not exists (select 1 from oportunidad_insight oi
      where oi.oportunidad_id = new.id and oi.workspace_id = new.workspace_id) then
      raise exception 'no se puede aprobar la oportunidad: no traza a ningún insight (SYS-15)';
    end if;
    -- Y el razonamiento entero, por el protocolo compartido: candados sobre los derechos
    -- antes de leerlos y el predicado que miran los pickers. Entre enlazar y aprobar caben
    -- semanas, y una revocación en ese hueco deja la HMW apoyada en una cita que ya no se
    -- puede usar con el cliente.
    perform razonamiento_usable_guard(
      new.workspace_id,
      array(select oi.insight_id from oportunidad_insight oi
              where oi.oportunidad_id = new.id and oi.workspace_id = new.workspace_id),
      '{}'::uuid[],
      '{}'::uuid[],
      'la oportunidad');
  end if;
  return new;
end;
$fn$;

-- Una función SECURITY DEFINER corre con los privilegios del PROPIETARIO, así que dejarla
-- ejecutable por PUBLIC es ofrecerle a cualquiera una puerta con las llaves del dueño puestas.
-- El esquema tiene un censo que lo comprueba tabla por tabla; esto es lo que lo mantiene en
-- verde, y no una precaución de más: un trigger no necesita EXECUTE público para dispararse.
revoke execute on function oportunidad_veredicto_guard() from public;

-- ═══════════════════════════════════════════════════════════════════════════
-- Y EL CANDADO DEL RETO, QUE ES LA CLAVE QUE USA LA APROBACIÓN DE G3
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Todo lo de arriba decide sobre el portafolio; `gate_aprobar_suficiencia_guard` decide sobre
-- el MISMO portafolio al firmar G3. Sin una clave común, las dos transacciones tocan filas
-- distintas y no se ven: el gate lee el enlace mientras el borrado lee una oportunidad
-- `propuesta`, las dos comprobaciones pasan, y las dos commitean. Resultado: G3 firmado sobre
-- una oportunidad viva sin traza — exactamente lo que SYS-15 prohíbe, alcanzado sin que
-- ninguna de las dos reglas fallara.
--
-- La clave es `designio:reto:`, la que ya toma el guard del gate. Va en un TRIGGER y no solo
-- en el servicio por lo de siempre: quien escribe por SQL directo no coopera con ningún
-- protocolo del servicio, y el insert del enlace está en la superficie concedida.
--
-- ── El ORDEN ──
-- `a_congelacion_por_disposicion` toma `designio:workspace:` en COMPARTIDO y corre el primero
-- (su prefijo lo garantiza), así que el orden del sistema es workspace → reto. El prefijo `b_`
-- pone éste justo detrás y delante de `oportunidad_veredicto_guard`, que así encuentra el
-- candado ya tomado antes de leer nada.
create function portafolio_candado_del_reto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_reto uuid;
  v_fila record;
begin
  v_fila := coalesce(new, old);
  if tg_table_name = 'oportunidad' then
    v_reto := v_fila.reto_id;
  else
    select o.reto_id into v_reto
      from oportunidad o
      where o.id = v_fila.oportunidad_id and o.workspace_id = v_fila.workspace_id;
  end if;
  if v_reto is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
    -- Y VOLVER A PREGUNTAR, que es la mitad que faltaba. Esperar no basta: cuando este
    -- trigger corre, la fila YA está calificada —la política de RLS se evaluó con la
    -- instantánea del inicio de la sentencia, antes de que existiera este candado—, y
    -- Postgres no vuelve a evaluarla porque un trigger BEFORE se haya quedado esperando.
    -- Así, un DELETE que califica su fila mientras G3 se está aprobando, espera aquí y
    -- borra después de que la aprobación commitee: el gate se queda certificando un
    -- portafolio que ya perdió su traza. La ventana se relee AQUÍ, con el candado en la
    -- mano y por tanto sobre un estado que nadie puede estar cambiando.
    --
    -- El propietario no pasa por políticas y tampoco por esta comprobación —seed, migraciones
    -- y backfills administran la base y responden por lo que escriben—, que es la misma
    -- exención que tienen `oportunidad_veredicto_guard` y el resto de guards del esquema.
    if session_user = 'designio_app'
       and not reto_admite_portafolio(v_reto, v_fila.workspace_id) then
      raise exception 'el G3 de ese reto está aprobado: su portafolio no se toca sin reabrir la etapa 3';
    end if;
  end if;
  return v_fila;
end;
$fn$;

revoke execute on function portafolio_candado_del_reto_guard() from public;

create trigger b_candado_del_reto
  before insert or update or delete on oportunidad
  for each row execute function portafolio_candado_del_reto_guard();
create trigger b_candado_del_reto
  before insert or delete on oportunidad_insight
  for each row execute function portafolio_candado_del_reto_guard();

create trigger oportunidad_veredicto_guard
  before update on oportunidad
  for each row when (old.estado = 'propuesta' and new.estado <> 'propuesta')
  execute function oportunidad_veredicto_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- G3
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Se reescribe `gate_aprobar_suficiencia_guard` entero —es como se ha hecho cada vez que
-- una regla nueva entra en él— añadiendo la rama `numero = 3` justo después de la de G2.
-- El resto del cuerpo es el de 20260902340000, sin tocar.


create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- `v_bloqueo`, `v_afirmacion` y `v_evidencia` se han ido con las comprobaciones que ahora
  -- viven en `razonamiento_usable_guard`: declararlas aquí sin usarlas sería dejar el rastro
  -- de una regla que ya no está en este cuerpo.
  v_motivo text;
  v_reto uuid;
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
    -- El candado del RETO antes de mirar nada. Este guard decide sobre filas de OTRAS tablas
    -- —el checklist, los releases, las constataciones—, así que sin candado compartido en la
    -- base una aprobación y una escritura concurrente sobre lo que afirma se miran sin verse
    -- y commitean las dos: G6 firmando un plan al que otra transacción le acaba de quitar la
    -- cobertura. El servicio ya lo tomaba (`aprobarGate` lo toma primero de todo), pero eso
    -- vale solo para quien entra por ahí.
    --
    -- Es la misma clave y el mismo primer lugar que en `release_elemento_cobertura_guard`,
    -- que es el otro lado del par. Y va aquí dentro, en la rama de la aprobación, para no
    -- serializar por el reto transiciones que no afirman nada sobre otras tablas.
    select p.reto_id into v_reto from proyecto p
      where p.id = new.proyecto_id and p.workspace_id = new.workspace_id;
    if v_reto is not null then
      perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || v_reto, 42));
    end if;
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
    -- ═══ EL PROTOCOLO DE RAZONAMIENTO, COMPARTIDO CON G5 ═══
    -- Candados (decisiones y derechos, en ese orden) y las cuatro comprobaciones viven en
    -- `razonamiento_usable_guard`. Aquí solo va el RECORRIDO: qué insights, decisiones y
    -- evidencia consume este gate por su checklist. Estuvo escrito dos veces —aquí y en la
    -- rama de G5— y las dos redacciones ya habían divergido: la de G5 nació sin el estado
    -- del insight y sin el candado de las decisiones. Compartir la redacción es lo que hace
    -- que la siguiente ruta que consuma razonamiento herede el protocolo entero.
    perform razonamiento_usable_guard(
      new.workspace_id,
      array(select ci.insight_id from checklist_item ci
              where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
                and ci.estado = 'cumplido' and ci.insight_id is not null),
      array(select ci.decision_id from checklist_item ci
              where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
                and ci.estado = 'cumplido' and ci.decision_id is not null),
      array(select ci.evidencia_id from checklist_item ci
              where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
                and ci.estado = 'cumplido' and ci.evidencia_id is not null),
      'un ítem cumplido');

    -- El arquetipo NO entra en esa función: no es razonamiento citado, es el veredicto de
    -- un perfil, y tiene su propia comprobación con su propio mensaje unas líneas más
    -- abajo. Su candado va aquí, en el mismo modo y con el mismo orden por id.
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

    -- La comprobación de «ítems cumplidos con decisiones en revisión» YA NO ESTÁ AQUÍ: es
    -- la cuarta del protocolo y vive dentro de `razonamiento_usable_guard`, que se llama
    -- justo arriba con las decisiones de los ítems cumplidos — el mismo conjunto que
    -- recorría esta versión a mano. Se deja dicho porque el hueco que dejó fue real: al
    -- estar escrita aquí y no en la función compartida, la ruta de G5 no la heredó y podía
    -- certificar un diseño inmutable y de cara al cliente sobre una decisión que una
    -- reapertura había puesto en cuestión.
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
    -- EJE TIEMPO: confirmar un arquetipo exige evidencia enlazada, pero eso se comprobó
    -- cuando se confirmó. Entre aquel momento y éste los derechos pueden haberse revocado,
    -- y G2 se aprueba con el cliente delante sobre un perfil que ya no se sostiene. Mismo
    -- predicado del veredicto, re-evaluado con derechos vivos.
    if new.numero = 2 and exists (select 1 from arquetipo a
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where a.reto_id = p.reto_id and a.workspace_id = new.workspace_id
        and a.estado = 'confirmado'
        and not exists (select 1 from arquetipo_evidencia ae
          where ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
            and evidencia_usable(ae.evidencia_id, ae.workspace_id, 'cliente'))) then
      raise exception 'no se puede aprobar G2: un arquetipo confirmado ya no tiene ninguna evidencia con derechos vigentes que lo sostenga'
        using errcode = 'DR001';
    end if;
    -- ═══ G3: SYS-15 SOBRE EL PORTAFOLIO ═══
    -- Dos comprobaciones, y las dos son la MISMA regla mirada en dos momentos.
    --
    -- Lo que NO va aquí, y conviene decirlo porque es la decisión de fondo: «el portafolio
    -- de oportunidades está aprobado» (prediseño §3) NO se exige en el guard. Es una
    -- expectativa del MÉTODO, y este esquema ya tiene dónde ponerla —el checklist del gate,
    -- que se instancia por perfil— mientras que SYS-15 es un invariante del OBJETO. Meter
    -- la primera aquí duplicaría el checklist y, de paso, dejaría sin poder aprobar G3 a
    -- todo proyecto que llegó a la etapa 3 antes de que este objeto existiera: un gate que
    -- de pronto no se puede firmar porque se añadió una tabla no es una garantía nueva, es
    -- una regresión. Cuando el checklist de la etapa 3 lo pida por su ítem, lo pedirá donde
    -- se lee.
    --
    -- Y por eso mismo, las dos comprobaciones que sí van son vacuamente ciertas sin
    -- oportunidades: SYS-15 es una regla SOBRE las oportunidades, no una regla que las
    -- exija.

    -- 1. SYS-15: toda oportunidad viva traza a ≥1 insight. Las descartadas no entran —lo
    --    que se tiró no sostiene nada— y las PROPUESTAS sí: el invariante habla de la
    --    oportunidad, no de su veredicto, y dejar fuera las que nadie decidió sería aprobar
    --    G3 sobre un portafolio de preguntas sin apoyo con solo no decidirlas.
    --    `oportunidad_veredicto_guard` ya lo exige al aprobar; se repite aquí porque ese
    --    trigger se aparta cuando no hay contexto de aplicación (seed, backfills) y porque
    --    un enlace puede borrarse después.
    if new.numero = 3 and exists (select 1 from oportunidad o
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where o.reto_id = p.reto_id and o.workspace_id = new.workspace_id
        and o.estado <> 'descartada'
        and not exists (select 1 from oportunidad_insight oi
          where oi.oportunidad_id = o.id and oi.workspace_id = o.workspace_id)) then
      raise exception 'no se puede aprobar G3: hay una oportunidad que no traza a ningún insight (SYS-15)';
    end if;
    -- 2. EJE TIEMPO, el mismo que G2 tiene para los arquetipos: aprobar una oportunidad
    --    exigió razonamiento en pie, pero eso fue cuando se aprobó. Entre aquel momento y
    --    éste se revocan derechos y se reabren decisiones, y G3 se firma con el sponsor
    --    delante. Va por el protocolo compartido —candados sobre los derechos ANTES de
    --    leerlos— y no por un predicado propio, que nacería divergiendo.
    if new.numero = 3 then
      perform razonamiento_usable_guard(
        new.workspace_id,
        array(select oi.insight_id
                from oportunidad o
                join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
                join oportunidad_insight oi on oi.oportunidad_id = o.id and oi.workspace_id = o.workspace_id
                where o.reto_id = p.reto_id and o.workspace_id = new.workspace_id
                  and o.estado <> 'descartada'),
        '{}'::uuid[],
        '{}'::uuid[],
        'una oportunidad del portafolio');
    end if;
    -- G5 firma el DISEÑO. La etapa 5 («Detalle de solución») entrega precisamente la design
    -- version, y el criterio del gate es «design version completa y consistente, piezas
    -- críticas validadas, APROBADA POR EL CLIENTE». Así que el gate no puede aprobarse sin
    -- que exista lo que dice certificar.
    --
    -- Es el mismo argumento que la rama de G6, palabra por palabra: que el ítem del checklist
    -- esté cumplido no lo demuestra —un ítem registra un objeto citado o un N/A razonado, y
    -- no deriva nada de design_version—, así que sin esto G5 certificaba un diseño que podía
    -- no existir. Y con G5 firmado sobre la nada, `gate_certificado_del_proyecto` tampoco lo
    -- ve, con lo que después se puede aprobar cualquier versión: la aprobación del cliente
    -- acababa desligada de todo diseño concreto.
    --
    -- Se exige APROBADA (o superada: aprobada estuvo) y no un borrador, porque lo que el
    -- cliente firma tiene que estar CONGELADO. Un borrador sigue editándose después de la
    -- firma, que es exactamente la certificación-que-cambia-de-contenido que este esquema
    -- existe para impedir. `design_versions_a_cargo_del_proyecto` ya devuelve solo no
    -- borradores, así que basta con reusarla — la misma que usan G6 y G7.
    --
    -- Lo que esto NO hace es fijar G5 a UNA versión concreta, y es deliberado: ver el porqué
    -- en `gate_certificado_del_proyecto`, donde se explica por qué G5 no entra en ese
    -- conjunto. Aquí se exige que el diseño exista y esté congelado, no que sea para siempre
    -- el único.
    if new.numero = 5 and not exists (
      select 1 from design_version dv
      where dv.id in (select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))
        and exists (select 1 from elemento_cambio ec
          where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id)
    ) then
      raise exception 'no se puede aprobar G5: el proyecto no tiene ninguna design version aprobada con elementos que certificar (RF-06.3)';
    end if;

    -- ═══ G5 CERTIFICA VIGENCIA, NO EXISTENCIA ═══
    -- La comprobación de arriba mira que EXISTA una design version aprobada con elementos.
    -- Es la misma clase de defecto que este PR lleva toda la revisión cerrando, y aquí cae
    -- sobre el peor artefacto de todos: la design version es INMUTABLE y es lo que ve el
    -- cliente. El camino era enlazar a un elemento razonamiento ya bloqueado, aprobar la
    -- versión —que congela— y certificar G5 con algo que este mismo guard rechaza si se
    -- cita DIRECTAMENTE desde un ítem del checklist. Dos puertas al mismo sitio.
    --
    -- Y se cierra con LA MISMA FUNCIÓN que usa el checklist, no con una copia de sus
    -- comprobaciones: la primera versión de esta rama las copió y le faltaron dos —el
    -- estado del insight y el candado de las decisiones—, que es exactamente lo que pasa
    -- cuando un protocolo se escribe dos veces. Aquí solo va el recorrido, que sí es propio
    -- de esta ruta: `elemento_cambio` → `elemento_insight` / `elemento_decision`.
    if new.numero = 5 then
      perform razonamiento_usable_guard(
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
        array[]::uuid[],
        'el diseño que certifica G5');
    end if;
    -- G6 es donde el Metric Registry se acuerda y se FIRMA (SYS-22): aprobar el plan de
    -- implementación sin contrato de medición firmado deja el loop abierto por diseño.
    if new.numero = 6 and not exists (select 1 from metric_registry r
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where r.reto_id = p.reto_id and r.workspace_id = new.workspace_id
        and r.estado = 'firmado') then
      raise exception 'no se puede aprobar G6: el Metric Registry no está firmado (SYS-22)';
    end if;
    -- ↑ Copiada TAL CUAL del cuerpo vivo de `20260902110000-medicion.sql`, que corre antes
    -- que esta migración. Este `create or replace` reemplaza la función ENTERA, así que sin
    -- traerla se perdería la puerta de G6 que SPEC-07 acaba de poner — y en silencio, porque
    -- nada falla al borrar una regla. Lo que NO se trae es el efecto de G6 sobre el proyecto:
    -- vive en su propio trigger AFTER (`proyecto_a_implementacion_tras_g6`), y aquí, en un
    -- BEFORE, la fila del gate todavía no existe.
    -- G6 firma el PLAN (RF-06.4): «cada elemento de la design version queda asignado a
    -- exactamente un release con dueño y fecha». Que el ítem del checklist esté cumplido
    -- no lo demuestra — un ítem cumplido registra un objeto citado o un N/A razonado, y
    -- no deriva nada de release_elemento—, así que sin esto G6 certificaba un plan que
    -- podía no existir. El «exactamente uno» ya lo garantiza la PK de release_elemento; lo
    -- que faltaba era el «cada». Dueño y fecha no hay que comprobarlos: release.responsable
    -- y fecha_objetivo son not null con CHECK, así que estar asignado ya los implica.
    if new.numero = 6 then
      -- El conjunto es «de qué responde este proyecto» (design_versions_a_cargo_del_proyecto)
      -- y no «cuál manda en el servicio»: que otro proyecto haya superado la versión de este
      -- no deshace su plan, solo deja de ser la vigente. Lo que sí la saca es que este mismo
      -- proyecto la haya reemplazado.
      --
      -- El gemelo vacuo, igual que en G7: sin design version con elementos no hay plan que
      -- firmar, y el «no exists elemento sin release» de abajo sería vacuamente cierto por
      -- no haber ningún elemento que mirar.
      if not exists (
        select 1 from design_version dv
        where dv.id in (select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))
          and exists (select 1 from elemento_cambio ec
            where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id)
      ) then
        raise exception 'no se puede aprobar G6: el proyecto no tiene ninguna design version con elementos que planificar (RF-06.4)';
      end if;
      if exists (
        select 1 from elemento_cambio ec
        where ec.workspace_id = new.workspace_id
          and ec.design_version_id in (
            select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))
          and not exists (select 1 from release_elemento re
            where re.elemento_id = ec.id and re.workspace_id = ec.workspace_id)
      ) then
        raise exception 'no se puede aprobar G6: hay elementos de la design version sin release asignado (RF-06.4)';
      end if;
    end if;
    -- G7 cierra la implementación (RF-06.7). Las cuatro ramas del predicado —hay tablero,
    -- lo propio está constatado, lo que la cadena del servicio dejó a medias, y lo que una
    -- versión auto-superada dejó en vuelo— viven en `g7_motivo_de_bloqueo`, con el porqué
    -- de cada una escrito allí. Aquí solo se levanta el motivo que devuelva.
    --
    -- Está fuera del guard a propósito y no por gusto: la pantalla de conciliación tiene
    -- que decir exactamente lo que el gate va a rechazar, y mientras eso se escribía dos
    -- veces siempre le faltaba una rama a la copia. Una sola redacción, dos lectores.
    if new.numero = 7 then
      v_motivo := g7_motivo_de_bloqueo(new.proyecto_id, new.workspace_id);
      if v_motivo is not null then
        raise exception 'no se puede aprobar G7: %', v_motivo;
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
        -- El cuerpo del evento viene ENTERO de la migración de medición. Este
        -- `create or replace` reescribe la función completa, así que lo que no se copie
        -- desaparece sin que nada falle al aplicar: el rastro pierde columnas y solo lo
        -- nota quien lo lea. `aprobado_en` está en el grant y el WITH CHECK solo le exige
        -- NO SER NULO —la fecha la propone la aplicación y nada la ata al instante real—,
        -- así que es la clase de dato que el evento tiene que conservar tal cual quedó.
        jsonb_build_object('gateId', new.id, 'proyectoId', new.proyecto_id,
                           'numero', new.numero, 'estado', new.estado,
                           'aprobadoPor', new.aprobado_por, 'aprobadoEn', new.aprobado_en),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- LA SUPERFICIE DEL ROL DE APLICACIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `grant … on tabla` a secas concede TODAS las columnas, presentes y futuras, así que las
-- de escritura van enumeradas: es lo que impide que un lead fabrique la firma de un
-- veredicto o feche una oportunidad en el pasado (`decidido_por`, `decidido_en` y
-- `creado_en` los pone la base). El INSERT sí va a nivel de tabla porque la política ya
-- fija estado, firma y ventana, igual que en `arquetipo`.
grant select on oportunidad, oportunidad_insight to designio_app;
grant insert (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
  on oportunidad to designio_app;
grant insert (oportunidad_id, insight_id, workspace_id) on oportunidad_insight to designio_app;
grant delete on oportunidad_insight to designio_app;
-- El veredicto y la repriorización, y nada más. `pregunta` NO se puede editar: cambiar el
-- texto de una HMW después de enlazarle insights es reescribir a qué apuntaba la traza.
grant update (estado, veredicto_razon, decidido_por, decidido_en, prioridad, prioridad_razon)
  on oportunidad to designio_app;


-- ═══════════════════════════════════════════════════════════════════════════
-- LA CONGELACIÓN POR DISPOSICIÓN ALCANZA A LAS TABLAS NUEVAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `20260903200000` instaló `a_congelacion_por_disposicion` recorriendo `tablas_congelables()`
-- UNA vez, así que toda tabla con `workspace_id` creada DESPUÉS nace fuera de la congelación:
-- se podría escribir en ella con el workspace ya dispuesto, que es justo lo que el acuerdo
-- cierra. Estas dos son las primeras en esa situación, y el bucle se escribe idempotente
-- —solo las que no lo tengan— para que la próxima migración que añada una tabla pueda copiar
-- este bloque tal cual en vez de enumerar nombres.
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

-- ═══════════════════════════════════════════════════════════════════════════
-- Y LA PREMISA DE LA QUE DEPENDEN ESOS CANDADOS: READ COMMITTED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Los guards que serializan y RELEEN se apoyan en que cada sentencia abre instantánea nueva,
-- y eso solo es cierto bajo READ COMMITTED — el nivel lo elige quien llama. `20260902330000`
-- instaló `aislamiento_de_escritura` derivando las tablas cuyos triggers toman candados, y
-- `20260903200000` volvió a pasar el mismo bucle por las que habían nacido en medio.
--
-- Las dos tablas de aquí entran en esa derivación por dos caminos: el guard de congelación
-- que se acaba de instalar toma el candado del workspace, y `oportunidad_veredicto_guard`
-- llama a `razonamiento_usable_guard`, que toma `for share` sobre decisiones y derechos. Sin
-- esta pasada, un cliente que abriera `repeatable read` aprobaría una oportunidad con el
-- protocolo mirando una foto vieja — y el censo de la suite lo detecta, que es de donde
-- salió este bloque.
--
-- Es literalmente el mismo bucle idempotente de `20260903200000`, y se repite en vez de
-- extraerse a una función a propósito: una función «reinstala los triggers de infraestructura»
-- invitaría a llamarla desde sitios donde lo que hace falta es pensar qué tabla se añadió.
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
