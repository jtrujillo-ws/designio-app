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

-- ── Y 'completada' se cruza POR LA PUERTA, en los dos sentidos ──
-- La función de arriba toma `etapa_instancia.estado = 'en-curso'` por «hay una reapertura
-- viva». No se lo inventa: es la lectura que hacen también las ventanas de insight/decisión, de
-- medición y de la capa AI — seis sitios en cinco migraciones anteriores escriben
-- `e.estado <> 'en-curso'`. Ninguno comprobaba que ese 'en-curso' VINIERA de una reapertura
-- registrada, y la superficie SQL concedida no lo impide: `grant update (estado) on
-- etapa_instancia` y la política `etapa_update` dejan que un lead o un diseñador pongan la
-- etapa en curso a mano.
--
-- Medido antes de escribir esto: con G3 aprobado y la etapa cerrada, `reto_admite_portafolio`
-- decía `false`; después de un `update etapa_instancia set estado = 'en-curso'` hecho por el
-- propio lead decía `true`, con CERO filas en `reapertura_etapa` y CERO eventos
-- `EtapaReabierta`. El congelado lo abría sin dejar rastro exactamente el rol al que congela, y
-- volver a cerrar la etapa después deja el gate firmado sin que el guard de G3 vuelva a correr.
--
-- Se arregla en la TRANSICIÓN y no en el predicado de esta migración: endurecer solo
-- `reto_admite_portafolio` dejaría las otras cinco ventanas igual de falsificables y ésta
-- distinta de sus hermanas sin ningún motivo que se pueda leer.
--
-- Diferido porque `reabrirEtapa` escribe la etapa y su registro en la MISMA sentencia (un CTE),
-- y un guard inmediato dependería del orden en que se materializan sus ramas. Al commit las dos
-- están escritas.
--
-- `reabierto_en = now()` significa «en esta transacción»: `now()` es la hora de INICIO de la
-- transacción y es el default de la columna, así que solo casan las filas escritas aquí. Una
-- reapertura vieja —de un ciclo anterior, ya vuelto a cerrar— no sirve de coartada.
--
-- Se calla ante el propietario por `session_user`, como el resto de la casa: migraciones, seed
-- y fixtures montan estados a mano a propósito, y quien tiene el rol dueño no necesita esta
-- puerta para nada.
create function etapa_cruza_completada_por_la_puerta_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if session_user <> 'designio_app' then return null; end if;

  -- ── SALIR de 'completada': su registro de reapertura ──
  -- La puerta se mide sobre SALIR de 'completada', no sobre entrar en 'en-curso'. Escrita
  -- como «completada → en-curso» dejaba el mismo rodeo en DOS pasos —completada →
  -- pendiente, commit, pendiente → en-curso—, porque ninguna de esas dos transiciones es la
  -- que se vigilaba. Y exigir registro al entrar en 'en-curso' no vale: así es como EMPIEZA
  -- una etapa normal.
  if old.estado = 'completada' and new.estado <> 'completada' then
    if new.estado <> 'en-curso' then
      raise exception 'una etapa completada no vuelve a %: su única salida es reabrirla, y eso queda registrado', new.estado;
    end if;
    if not exists (
      select 1 from reapertura_etapa r
       where r.workspace_id = new.workspace_id
         and r.proyecto_id = new.proyecto_id
         and r.etapa_numero = new.numero
         and r.reabierto_en = now()) then
      raise exception 'esa etapa está cerrada y solo se reabre por la puerta: la reapertura tiene que quedar registrada —motivo, alcance y quién— en la misma transacción que la abre';
    end if;
  end if;

  -- ── ENTRAR en 'completada': la firma de su gate ──
  -- Vigilar solo la salida deja el rodeo entero por el otro lado, y se midió: reabierta la
  -- etapa 3 POR LA PUERTA —registro y todo—, el lead añade una oportunidad sin traza y cierra
  -- con `update etapa_instancia set estado = 'completada'`. Pasaba. Y quedaba la etapa cerrada,
  -- G3 en 'aprobado' y `gate_faltas_para_aprobar` diciendo P0001 (SYS-15) sobre ese mismo gate:
  -- una firma congelada sobre un portafolio que la contradice, con la ventana ya cerrada para
  -- que nadie vuelva a mirarla.
  --
  -- El cierre también tiene UNA puerta, y es la del método: `gate_aprobar_suficiencia_guard`
  -- —y solo él— escribe 'completada', después de preguntarle a `gate_faltas_para_aprobar`. Se
  -- exige su firma EN ESTA transacción, con el mismo `= now()` que la rama de arriba y por el
  -- mismo motivo: una firma vieja, de un ciclo anterior, no es coartada de este cierre.
  --
  -- Rechazar y no «revalidar aquí» es una decisión: revalidar dejaría pasar el cierre siempre
  -- que el portafolio esté limpio, pero `aprobado_por` y `aprobado_en` seguirían diciendo que
  -- el sponsor firmó en aquel momento —sobre el portafolio de aquel momento—. Eso no arregla la
  -- firma congelada: la falsifica.
  --
  -- Tampoco tapia: hoy no hay ningún camino de producto que cierre una etapa reabierta.
  -- `gate_update_aprobar` solo admite 'pendiente' → 'aprobado', y `reabrirEtapa` no devuelve el
  -- gate a 'pendiente', así que un gate ya firmado no se vuelve a firmar. La etapa reabierta se
  -- queda abierta —y su ventana con ella, que es el lado seguro— hasta que el método tenga su
  -- ceremonia de recierre. Lo único que esta rama quita es el atajo.
  if new.estado = 'completada' and old.estado <> 'completada' then
    if not exists (
      select 1 from gate_instancia g
       where g.workspace_id = new.workspace_id
         and g.proyecto_id = new.proyecto_id
         and g.numero = new.numero
         and g.estado = 'aprobado'
         and g.aprobado_en = now()) then
      raise exception 'una etapa se cierra al firmar su gate, no por SQL: sin la firma del gate % en esta misma transacción, cerrarla congelaría lo que el gate certificó sin volver a comprobarlo', new.numero;
    end if;
  end if;
  return null;
end;
$fn$;

revoke execute on function etapa_cruza_completada_por_la_puerta_guard() from public;

-- `z_` para que quede por detrás de `a_congelacion_por_disposicion`, que es la que abre en toda
-- tabla de workspace y tiene su propio censo.
create constraint trigger z_etapa_cruza_completada_por_la_puerta
  after update on etapa_instancia
  deferrable initially deferred
  for each row execute function etapa_cruza_completada_por_la_puerta_guard();

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

-- ── Y una repriorización tiene que ser una repriorización ──
-- El grant por columnas deja tocar `veredicto_razon`, y la política de UPDATE solo exige que la
-- fila siga en 'propuesta'. Así que un `update oportunidad set veredicto_razon = …` que no
-- cambia el estado pasaba — y la auditoría, que clasifica por «no cambió el estado ⇒ se
-- repriorizó», lo apuntaba como `OportunidadRepriorizada`. Un archivo que describe una acción
-- que no ocurrió es peor que uno incompleto: se puede contar, y cuenta mal.
--
-- La salida no es inventarle un tipo de evento a eso, es que eso no ocurra. La razón de un
-- veredicto es el porqué de una decisión: cambiarla sin cambiar la decisión reescribe el
-- archivo, que es justo lo que el append-only existe para impedir. Con esta puerta cerrada, la
-- rama `else` de `oportunidad_auditoria` es verdad POR CONSTRUCCIÓN y no por confianza — el
-- grant no deja tocar `pregunta` ni el ancla, el CHECK de la tabla no deja firmar sin decidir,
-- y lo único que queda es la prioridad y su razón.
--
-- Se calla ante el propietario por `session_user`, como el resto de guards: seed y backfills
-- montan estados a mano y no pasan por esta puerta.
create function oportunidad_razon_del_veredicto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if session_user = 'designio_app'
     and new.veredicto_razon is distinct from old.veredicto_razon then
    raise exception 'la razón del veredicto no se reescribe sin veredicto: esa razón explica una decisión, y aquí no se está decidiendo nada';
  end if;
  return new;
end;
$fn$;

revoke execute on function oportunidad_razon_del_veredicto_guard() from public;

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
  v_oportunidad uuid;
  v_fila record;
begin
  v_fila := coalesce(new, old);
  if tg_table_name = 'oportunidad' then
    v_reto := v_fila.reto_id;
  else
    -- El id se guarda en una VARIABLE y no se vuelve a leer del record más abajo: plpgsql
    -- resuelve los campos de un `record` al planificar cada sentencia, así que nombrar
    -- `v_fila.oportunidad_id` dentro de una condición compuesta revienta también cuando la
    -- fila es de `oportunidad`, donde ese campo no existe — aunque la otra mitad de la
    -- condición diga que esa rama no aplica.
    v_oportunidad := v_fila.oportunidad_id;
    select o.reto_id into v_reto
      from oportunidad o
      where o.id = v_oportunidad and o.workspace_id = v_fila.workspace_id;
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
    if session_user = 'designio_app' then
      if not reto_admite_portafolio(v_reto, v_fila.workspace_id) then
        raise exception 'el G3 de ese reto está aprobado: su portafolio no se toca sin reabrir la etapa 3';
      end if;
      -- Y el ESTADO de la oportunidad, que es la otra condición que miró la política del
      -- enlace. Releer una y dejar la hermana con la foto vieja es el mismo error una capa
      -- más adentro: el borrado califica con la oportunidad todavía «propuesta», espera
      -- detrás de una APROBACIÓN de esa misma oportunidad —que toma este mismo candado— y al
      -- soltarse la ventana de G3 sigue abierta, porque G3 no tiene nada que ver aquí. Queda
      -- una oportunidad aprobada sin traza: lo que SYS-15 prohíbe, alcanzado por otra puerta.
      --
      -- Si hay que releer, se relee TODO lo que la política miró.
      if v_oportunidad is not null and not exists (
        select 1 from oportunidad o
         where o.id = v_oportunidad and o.workspace_id = v_fila.workspace_id
           and o.estado = 'propuesta') then
        raise exception 'esa oportunidad ya se decidió: su traza no se toca';
      end if;
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

-- El complementario del de arriba: aquel corre cuando el estado CAMBIA, éste cuando no. Entre
-- los dos cubren todo UPDATE de la tabla.
create trigger c_razon_del_veredicto
  before update on oportunidad
  for each row when (old.estado = new.estado)
  execute function oportunidad_razon_del_veredicto_guard();
-- ═══════════════════════════════════════════════════════════════════════════
-- G3, SOBRE LA FORMA QUE 20260905120000-lo-que-le-falta-a-un-gate LE DIO AL GATE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Esta migración y `lo-que-le-falta-a-un-gate-lo-dice-la-base` nacieron en ramas paralelas y
-- con el MISMO prefijo de fecha. Por orden alfabético ésta corría antes, así que la
-- reescritura del guard que hace la otra habría borrado la rama de G3 sin que nada fallara:
-- de ahí el renombrado a 130000. Es el modo de fallo más silencioso que tiene una migración,
-- y no lo habría dicho ninguna prueba — la rama simplemente dejaría de existir.
--
-- Y la regla de G3 no vuelve al guard: va donde esa migración puso «lo que le falta a un
-- gate», `gate_faltas_para_aprobar`, que es la única redacción de esas reglas y la que lee
-- también la bandeja de aprobaciones. Escribirla en el guard la habría dejado invisible para
-- la bandeja, que es exactamente el espejo a medias que esa migración vino a quitar.
--
-- Las dos funciones se reescriben enteras porque así funciona `create or replace`: el cuerpo
-- es copia íntegra del suyo, y lo añadido es la rama `numero = 3` en cada una —la
-- comprobación en las faltas, sus candados en el guard—.

create or replace function gate_faltas_para_aprobar(p_gate uuid, p_ws uuid)
returns setof motivo_de_bloqueo
language plpgsql stable set search_path = public, pg_temp as $$
declare
  g gate_instancia%rowtype;
  p proyecto%rowtype;
  v_motivo text;
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


-- ═══════════════════════════════════════════════════════════════════════════
-- AUDITORÍA: TODA ESCRITURA DEL PORTAFOLIO DEJA RASTRO (RF-01.6)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- «Toda acción de escritura, aprobación y acción AI genera un registro de auditoría
-- append-only» (RF-01.6), escrito «en la misma transacción que el cambio de estado»
-- (diseño técnico §evento_dominio). El portafolio nació cumpliéndolo A MEDIAS: el servicio
-- escribía el evento al crear y al decidir, y no al enlazar, al desenlazar ni al
-- repriorizar — y NINGUNO de los cuatro dejaba rastro si la escritura entraba por la
-- superficie SQL concedida, que es justo la que hay que auditar.
--
-- Va en TRIGGERS y el servicio deja de escribirlos. Dos escritores para el mismo evento es
-- peor que ninguno: dejaría dos filas por una acción hecha desde la app y una por la misma
-- acción hecha por SQL, y entonces el archivo no permite contar nada.
--
-- El pre-chequeo anti-oráculo es el mismo del resto del esquema: sin contexto de aplicación
-- (seed, migraciones, backfills) no hay actor a quien atribuir la acción, y `evento_dominio`
-- nace para auditar a las personas, no al administrador de la base.
create function oportunidad_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_fila record;
  v_tipo text;
  v_payload jsonb;
  v_oportunidad record;
begin
  v_fila := coalesce(new, old);
  if not is_workspace_member(app_user_id(), v_fila.workspace_id) then
    return null;
  end if;

  if tg_table_name = 'oportunidad' then
    if tg_op = 'INSERT' then
      v_tipo := 'OportunidadPropuesta';
    elsif tg_op = 'DELETE' then
      v_tipo := 'OportunidadBorrada';
    elsif old.estado is distinct from new.estado then
      v_tipo := 'OportunidadDecidida';
    elsif old.prioridad is distinct from new.prioridad
       or old.prioridad_razon is distinct from new.prioridad_razon then
      -- Lo único que queda es la repriorización, y eso es verdad por construcción y no por
      -- confianza: el grant no deja tocar `pregunta` ni el ancla, el CHECK de la tabla no deja
      -- firmar sin decidir, y `oportunidad_razon_del_veredicto_guard` cierra la última rendija
      -- —tocar `veredicto_razon` sin veredicto—, que era la que hacía que este `else` apuntara
      -- como repriorización algo que no lo era.
      v_tipo := 'OportunidadRepriorizada';
    else
      -- Y la última que quedaba: un UPDATE que no mueve nada. La pantalla lo produce sola —se
      -- edita la prioridad, se deshace la edición y se guarda—, y por SQL basta con reasignar
      -- los valores que ya están. El archivo anotaba una repriorización idéntica a la fila
      -- anterior: ruido que no distingue de una de verdad, y que hace incontable justo lo que
      -- este trigger existe para poder contar.
      --
      -- `is distinct from` y no `<>`: `prioridad_razon` es NOT NULL hoy, pero `<>` con un NULL
      -- da NULL —ni cierto ni falso— y esta rama se colaría callada el día que deje de serlo.
      return null;
    end if;
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'oportunidadId', v_fila.id, 'retoId', v_fila.reto_id,
      'pregunta', v_fila.pregunta, 'estado', v_fila.estado,
      'prioridad', v_fila.prioridad,
      -- La razón viaja SOLO cuando la hay: un archivo lleno de cadenas vacías esconde las
      -- que sí dicen algo.
      'prioridadRazon', nullif(btrim(v_fila.prioridad_razon), ''),
      'veredictoRazon', nullif(btrim(v_fila.veredicto_razon), '')));
  else
    v_tipo := case tg_op when 'INSERT' then 'OportunidadTrazada' else 'OportunidadDestrazada' end;
    -- El reto y la pregunta se leen de la oportunidad para que el evento se entienda SOLO:
    -- un rastro que obliga a ir a buscar la fila para saber de qué habla no es auditoría.
    -- En el DELETE puede no estar (un borrado en cascada la habría quitado antes), y
    -- entonces el evento sale con lo que sí consta.
    select o.reto_id, o.pregunta into v_oportunidad
      from oportunidad o
      where o.id = v_fila.oportunidad_id and o.workspace_id = v_fila.workspace_id;
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'oportunidadId', v_fila.oportunidad_id, 'insightId', v_fila.insight_id,
      'retoId', v_oportunidad.reto_id, 'pregunta', v_oportunidad.pregunta));
  end if;

  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (v_fila.workspace_id, v_tipo, v_payload,
            app_user_id(), workspace_role(app_user_id(), v_fila.workspace_id));
  return null;
end;
$fn$;

revoke execute on function oportunidad_auditoria() from public;

create trigger oportunidad_auditoria
  after insert or update or delete on oportunidad
  for each row execute function oportunidad_auditoria();
create trigger oportunidad_auditoria
  after insert or delete on oportunidad_insight
  for each row execute function oportunidad_auditoria();
