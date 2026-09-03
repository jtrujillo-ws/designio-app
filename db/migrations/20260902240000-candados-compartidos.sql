-- RF-03.10 / RF-03.1 / SYS-17 — CANDADOS COMPARTIDOS: una comprobación sin candado sobre
-- estado que otro camino muta no cierra la ventana, la estrecha. Un conteo bajo RLS no es
-- un conteo. Y un candado sin re-lectura ordena la espera sin cambiar lo que ya se
-- decidió: esperar sin releer es esperar para nada.
--
-- Las tres cosas que cierra esta migración son la MISMA falta desde tres sitios, y es
-- literalmente el axioma que ya rige esta base —«una política es un predicado sobre una
-- instantánea, no un cerrojo»— aplicado a los guards que la ronda anterior añadió:
--
--   Una decisión que lee estado que otro camino puede mutar necesita compartir candado
--   con ese camino. Y cuando lo que decide es una propiedad del OBJETO y no de quien
--   pregunta, tiene que leerlo sin el filtro de quien pregunta.
--
-- ═══ COLUMNA 1 — comprobaciones sobre estado mutable: quién más lo escribe, qué candado ═══
--
--  · aprobar gate → derechos (220000)     — muta `decidirDerechos`. SIN candado. ← se arregla
--  · congelar snapshot → derechos (230000) — muta `decidirDerechos`. SIN candado. ← se arregla
--  · adjuntar → item pendiente (política)  — muta aprobar/rechazar item. SIN candado. ← se arregla
--  · borrar adjunto → item pendiente       — muta aprobar/rechazar item. SIN candado. ← se arregla
--  · citar/enlazar → derechos (160000, 200000, 220000) — NO necesita candado, y es una
--    decisión, no un olvido: el guard de entrada es un predicado sobre el instante de la
--    cita A PROPÓSITO. Que los derechos se revoquen después es justamente lo que el eje
--    TIEMPO existe para atrapar, y lo atrapa en el consumo. Ponerle candado ahí daría la
--    falsa impresión de que la cita queda garantizada para siempre, que es lo contrario
--    de lo que este PR sostiene.
--  · exportar → derechos (`evidencia_entregable`) — NO necesita candado: corre en
--    `repeatable read` y el manifiesto publica el `now()` de ESA transacción. Un recibo
--    dice el estado en un instante nombrado; una revocación posterior no lo invalida, y
--    ningún candado devolvería los bytes ya entregados. Aquí la instantánea es la
--    semántica, no el defecto.
--  · marcar ítem ↔ aprobar gate           — YA comparten `designio:gate:` (070000/metodo).
--  · criterios ↔ aprobar G0               — YA comparten `designio:reto:`.
--  · orden de nodo del journey            — YA comparte `designio:journey-orden:`.
--
-- ═══ COLUMNA 2 — conteos/exists que gobiernan un límite o una suficiencia, bajo RLS ═══
--
--  · tope de 10 adjuntos por item — corría en la APP bajo `archivo_select`, que desde
--    210000 solo enseña a quien no cura los adjuntos que él subió. Diez del curador más
--    diez suyos y el stakeholder ve cero. Y no había NINGÚN respaldo en la base: los
--    `CHECK` de `archivo_importado` cubren tipo, tamaño y nombre — contar hermanas no
--    cabe en un CHECK de fila. ← se arregla, y de paso el SQL crudo choca igual
--  · `podadasPorDerechos` de la exportación — corre bajo RLS y ESTÁ BIEN: quien exporta
--    es lead-boutique o admin-cliente, y `material_evidencia_visible` les da el material
--    entero, así que el conteo no está recortado. Además el minuendo y el sustraendo se
--    leen bajo la misma RLS y el mismo snapshot: la resta es coherente por construcción.
--  · suficiencia del gate (`exists` sobre checklist, arquetipos, criterios) — corre
--    dentro de un guard `SECURITY DEFINER`, luego ya cuenta sin el filtro de quien mira.
--  · `insight_validar_guard`, `arquetipo_veredicto_guard` — igual, `SECURITY DEFINER`.
--  · conteos de la bandeja, del listado de journeys y del diagnóstico de `aprobarGate`
--    — son PRESENTACIÓN y diagnóstico, no gobiernan ningún límite. «Lo que este usuario
--    ve» es ahí exactamente lo que se quiere decir.
--
-- ═══ COLUMNA 3 — operaciones atómicas de varios pasos: ¿qué pasa si alguien ejecuta
--     solo el primero por SQL directo? ═══
-- La misma doctrina de siempre (la promesa que solo cumple el servicio no es una promesa,
-- porque el `grant` es una superficie y no un camino) aplicada a la ATOMICIDAD en vez de
-- a una regla de contenido. Recorridas las cinco de este slice, y las cinco salen enteras
-- SIN tocar nada — se deja escrito para que no haya que volver a preguntarlo:
--
--  · curar un item (fuente → evidencia → derechos → segmentos → sello) — el estado a
--    medias sería «evidencia sin registro de derechos», y lo impide un `constraint
--    trigger` DIFERIDO que se comprueba al COMMIT, no en la sentencia: por eso atrapa
--    también al que inserta la evidencia suelta y nunca vuelve. Comprobado por SQL crudo
--    del rol de aplicación: la transacción muere con «toda evidencia exige su registro de
--    derechos». El otro medio-estado —item `aprobado` sin `evidencia_id`— lo cierra un
--    CHECK de la tabla, no el servicio.
--  · congelar un snapshot — es UNA sentencia: el `journey_snapshot` y su evento salen del
--    mismo CTE, así que no hay primer paso que ejecutar a solas. Y su guard cuelga del
--    INSERT, luego da igual quién lo escriba.
--  · adjuntar y retirar un archivo — igual, un CTE cada uno. `archivo_importado` ni
--    siquiera tiene `grant update`: un adjunto no se muta, se pone o se quita.
--  · decidir derechos — el sello temporal y el evento los pone el guard DENTRO de la
--    transición, y `decidido_en` salió del grant en 20260902210000 precisamente por esto:
--    mientras estuvo dentro, un `update` que solo tocara esa columna no disparaba la rama
--    del guard y retro-databa la concesión sin dejar rastro. Verificado ahora contra la
--    base viva: el rol de aplicación tiene UPDATE sobre cinco columnas y `decidido_en` no
--    es una de ellas.
--  · exportar — el permiso y el registro los impone `registrar_exportacion` en la misma
--    transacción que lee. Lo que ESO no puede hacer, y conviene no prometerlo, es impedir
--    que quien ya tiene derecho a leer su workspace lea las mismas filas con un `select`:
--    la auditoría registra el acto de EMPAQUETAR, no el de mirar. La coherencia del
--    paquete no la da el registro sino el `repeatable read`.
--
-- ═══ COLUMNA 4 — de cada candado que se introduce aquí: ¿qué se leyó ANTES de tomarlo,
--     y quién lo relee DESPUÉS? ═══
-- Un candado ORDENA; no arregla retroactivamente la instantánea que la sentencia ya usó
-- para elegir filas. Esperar sin releer es esperar para nada, y la columna 1 no basta por
-- sí sola: hay que mirar qué decidió el predicado ANTES de dormirse.
--
--   candado                        | decidido antes de esperar        | quién lo revalida
--   -------------------------------|----------------------------------|------------------
--   `for share` derecho_uso (gate) | la fila de `gate_instancia` que   | las comprobaciones
--                                  | eligió el UPDATE externo — pero   | de derechos, TODAS
--                                  | `decidirDerechos` no toca esa     | debajo del candado
--                                  | tabla, y marcar↔aprobar ya        | y con snapshot
--                                  | comparten `designio:gate:`        | nuevo ✔
--   `for share` derecho_uso        | nada: el guard corre en el INSERT | ídem, todo el
--   (congelar)                     | del snapshot y no hay predicado   | recorrido va
--                                  | previo sobre derechos             | debajo ✔
--   `designio:item:` en el sello   | `estado = 'pendiente'` del USING  | EvalPlanQual: el
--   (`item_sellado_candado`)       | de `item_update_decision`, sobre  | UPDATE bloquea SU
--                                  | la fila que el UPDATE actualiza   | propia fila y
--                                  |                                   | re-evalúa el qual
--                                  |                                   | con la versión
--                                  |                                   | nueva ⇒ 0 filas ✔
--   `designio:item:` en el adjunto | `estado = 'pendiente'` del EXISTS | NADIE ← el agujero
--   (`archivo_item_candado`)       | de `archivo_insert`/`archivo_     | que se cierra abajo
--                                  | delete`, evaluado sobre OTRA      | con una re-lectura
--                                  | tabla y con el snapshot de la     | explícita
--                                  | sentencia DML                     |
--
-- La diferencia entre las dos últimas filas es exactamente por qué el caso del adjunto se
-- escapaba: cuando el predicado mira la MISMA fila que la sentencia va a escribir, EPQ la
-- revalida sola; cuando mira OTRA tabla (el item, desde el adjunto), no hay nada que
-- revalidar y el snapshot viejo sobrevive al candado.

-- ── El gate re-comprueba derechos Y comparte candado con quien los revoca ──
-- Copia ÍNTEGRA de la versión viva (20260902220000) más el candado. Ver la advertencia
-- sobre composición de ramas en 20260902160000.
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bloqueo text;
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
    new.aprobado_en := now();

    -- ═══ CANDADO COMPARTIDO CON QUIEN REVOCA (la mitad que faltaba) ═══
    -- Re-comprobar los derechos al aprobar cerró el eje TIEMPO, pero una comprobación
    -- SIN candado sobre estado que otro camino muta no cierra la ventana: la estrecha.
    -- Bajo READ COMMITTED esto leía `derecho_uso` sin bloquear nada, así que
    -- `decidirDerechos` podía commitear su revocación entre esta lectura y el commit del
    -- gate, y el gate quedaba aprobado sobre un respaldo ya revocado. Es literalmente el
    -- axioma de esta base —una política es un predicado sobre una instantánea, no un
    -- cerrojo— aplicado a un guard en vez de a una política.
    --
    -- El candado es de FILA sobre `derecho_uso`, no consultivo, y la elección es lo
    -- importante: quien revoca hace `update derecho_uso`, que YA toma el candado de fila
    -- en conflicto sin saber nada de este protocolo — también desde SQL crudo. Un
    -- candado consultivo obligaría a cooperar a todo el que escriba, y un consultivo y
    -- uno de fila sobre el mismo objeto no se ven entre sí. `for share` y no
    -- `for update`: dos aprobaciones de gates distintos no tienen por qué esperarse, y
    -- lo único que hay que impedir es que la revocación entre en medio.
    --
    -- Va ANTES de decidir, no después: bloquear tras comprobar deja exactamente la misma
    -- ventana. Y si la revocación ya estaba en vuelo, este `for share` espera a que
    -- commitee y Postgres re-evalúa la fila con la versión nueva (EvalPlanQual), así que
    -- las comprobaciones de abajo leen el estado posterior a la revocación y rechazan.
    -- Se bloquea el mismo conjunto de FILAS que las comprobaciones recorren, ni una más.
    -- OJO, y esto de aquí decía «el MISMO conjunto» a secas, que era decir de más: bloquear
    -- las filas correctas no basta si CUÁLES son esas filas se deriva de un `select` que
    -- también corre sobre una instantánea. `decision_insight` es una de las tablas de las
    -- que se deriva y nada la serializaba, así que un enlace nuevo entraba como fantasma —
    -- una fila que habría cambiado el conjunto y que ningún candado de fila puede tomar
    -- porque todavía no existe. Lo cierra 20260902250000 poniendo el candado sobre la
    -- DECISIÓN, que es el objeto común de las dos operaciones.
    perform du.evidencia_id
      from derecho_uso du
      where du.workspace_id = new.workspace_id
        and du.evidencia_id in (
          select ci.evidencia_id from checklist_item ci
            where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
              and ci.estado = 'cumplido' and ci.evidencia_id is not null
          union
          select c.evidencia_id from checklist_item ci
            join afirmacion a on a.insight_id = ci.insight_id and a.workspace_id = ci.workspace_id
            join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
              and ci.estado = 'cumplido' and ci.insight_id is not null
          union
          select c.evidencia_id from checklist_item ci
            join decision_insight di on di.decision_id = ci.decision_id and di.workspace_id = ci.workspace_id
            join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
            join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
              and ci.estado = 'cumplido' and ci.decision_id is not null
          union
          select ae.evidencia_id from arquetipo a2
            join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
            join arquetipo_evidencia ae on ae.arquetipo_id = a2.id and ae.workspace_id = a2.workspace_id
            where new.numero = 2 and a2.reto_id = p.reto_id and a2.workspace_id = new.workspace_id
              and a2.estado = 'confirmado'
        )
      -- Orden determinista: dos aprobaciones concurrentes toman las filas comunes en el
      -- mismo orden. `for share` no se estorba consigo mismo, pero el orden es gratis.
      order by du.evidencia_id
      for share;
    if exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'pendiente') then
      raise exception 'no se puede aprobar: checklist con pendientes';
    end if;
    if not exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id) then
      raise exception 'no se puede aprobar: el gate no tiene checklist instanciado';
    end if;
    if exists (select 1 from checklist_item ci
      join decision d on d.id = ci.decision_id and d.workspace_id = ci.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and d.estado <> 'vigente') then
      raise exception 'no se puede aprobar: hay ítems cumplidos con decisiones en revisión';
    end if;
    select evidencia_motivo_bloqueo(ci.evidencia_id, ci.workspace_id, 'cliente')
      into v_bloqueo
      from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and ci.evidencia_id is not null
        and not evidencia_usable(ci.evidencia_id, ci.workspace_id, 'cliente')
      limit 1;
    if found then
      raise exception 'no se puede aprobar: un ítem cumplido cita evidencia sin derechos vigentes — %',
        coalesce(v_bloqueo, 'derechos insuficientes') using errcode = 'DR001';
    end if;
    if exists (select 1 from checklist_item ci
      join afirmacion a on a.insight_id = ci.insight_id and a.workspace_id = ci.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and ci.insight_id is not null
        and not a.es_hipotesis
        and not exists (select 1 from cita c
          where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'))) then
      raise exception 'no se puede aprobar: un ítem cumplido cita un insight cuya afirmación ya no tiene ninguna cita con derechos vigentes'
        using errcode = 'DR001';
    end if;
    if exists (select 1 from checklist_item ci
      join decision_insight di on di.decision_id = ci.decision_id and di.workspace_id = ci.workspace_id
      join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and ci.decision_id is not null
        and not a.es_hipotesis
        and not exists (select 1 from cita c
          where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'))) then
      raise exception 'no se puede aprobar: un ítem cumplido cita una decisión cuyo insight de respaldo ya no tiene ninguna cita con derechos vigentes'
        using errcode = 'DR001';
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
    -- ── ABSORBIDO de 20260902110000-medicion.sql, no reescrito ──
    -- G6 es donde el Metric Registry se acuerda y se FIRMA (SYS-22): aprobar el plan de
    -- implementación sin contrato de medición firmado deja el loop abierto por diseño.
    -- Este `create or replace` reescribe la función ENTERA, así que omitirlo la desharía;
    -- es la misma advertencia que ya lleva la rama de decisiones en revisión, con el
    -- mismo motivo. Lo que NO se copia aquí es el efecto de G6 sobre el proyecto
    -- (`en-implementacion`): vive en su propio trigger AFTER
    -- (`proyecto_a_implementacion_tras_g6`) precisamente porque su precondición lee la
    -- fila del gate que este guard, siendo BEFORE, todavía no ha escrito. Traérselo aquí
    -- lo duplicaría y encima en el único momento en que no puede funcionar.
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
        -- Payload también absorbido de 110000: `aprobado_en` está en el grant y el WITH
        -- CHECK solo le exige no ser nulo, así que la fecha la propone la aplicación y
        -- nada la ata al instante real — es la clase de dato que el rastro conserva tal
        -- cual quedó.
        jsonb_build_object('gateId', new.id, 'proyectoId', new.proyecto_id,
                           'numero', new.numero, 'estado', new.estado,
                           'aprobadoPor', new.aprobado_por, 'aprobadoEn', new.aprobado_en),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
-- ── El snapshot del journey, con el mismo candado y por la misma razón ──
-- El guard de 230000 tiene EXACTAMENTE la misma forma que el del gate —re-comprueba
-- derechos vivos en el acto que fija algo inmutable— así que tiene exactamente el mismo
-- agujero. Se copia entero y se le antepone el candado de fila sobre las mismas filas
-- que va a consultar.
create or replace function journey_snapshot_derechos_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_evidencia uuid;
begin
  -- Anti-oráculo: para quien no es miembro no hay nada que informar; la política ya
  -- rechaza la escritura. `is_workspace_member(null, …)` es false, así que esto cierra
  -- además la sesión sin contexto RLS.
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  -- Candado ANTES de decidir, sobre las filas de `derecho_uso` de toda la evidencia que
  -- este snapshot va a fijar. Ver la explicación larga en el guard del gate: es de fila
  -- porque `decidirDerechos` ya lo toma con su UPDATE sin cooperar, y `for share` porque
  -- dos congelaciones no tienen por qué esperarse.
  perform du.evidencia_id
    from derecho_uso du
    where du.workspace_id = new.workspace_id
      and du.evidencia_id in (
        select (e->>'evidenciaId')::uuid
          from jsonb_array_elements(
                 case when jsonb_typeof(new.grafo->'evidencias') = 'array'
                      then new.grafo->'evidencias' else '[]'::jsonb end) as e
          where e->>'evidenciaId' ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        union
        select ne.evidencia_id
          from journey_nodo_evidencia ne
          join journey_nodo n on n.id = ne.nodo_id and n.workspace_id = ne.workspace_id
          where n.journey_id = new.journey_id and ne.workspace_id = new.workspace_id
      )
    order by du.evidencia_id
    for share;
  select ev into v_evidencia from (
    -- Lo que el grafo congela. El filtro por forma de uuid evita que un `grafo` con basura
    -- reviente en el cast: lo que no nombra una evidencia no hay derechos que comprobarle.
    select (e->>'evidenciaId')::uuid as ev
      from jsonb_array_elements(
             case when jsonb_typeof(new.grafo->'evidencias') = 'array'
                  then new.grafo->'evidencias' else '[]'::jsonb end) as e
      where e->>'evidenciaId' ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    union
    -- Lo que el journey tiene enlazado ahora mismo.
    select ne.evidencia_id
      from journey_nodo_evidencia ne
      join journey_nodo n on n.id = ne.nodo_id and n.workspace_id = ne.workspace_id
      where n.journey_id = new.journey_id and ne.workspace_id = new.workspace_id
  ) t
  where not evidencia_usable(ev, new.workspace_id, 'cliente')
  limit 1;
  if found then
    raise exception 'No puedes congelar este snapshot: un paso se apoya en evidencia sin derechos vigentes — %',
      coalesce(evidencia_motivo_bloqueo(v_evidencia, new.workspace_id, 'cliente'),
               'derechos insuficientes')
      using errcode = 'DR001';
  end if;
  return new;
end $$;

-- ── El tope de adjuntos deja de ser «lo que este usuario ve» ──
-- Contarlo en la app bajo RLS era contar otra cosa: desde 210000 `archivo_select` solo
-- enseña a quien no cura los adjuntos que él mismo subió, así que un stakeholder veía
-- cero por muchos que hubiera y el tope no existía para él. Un tope es una propiedad del
-- OBJETO —cuántos archivos aguanta ese material—, no de quien mira; leerlo con el filtro
-- de quien pregunta es la misma confusión que `evidencia_motivo_bloqueo` cerró un nivel
-- más abajo, y al revés. Aquí se cuenta sin RLS (`security definer`) y se serializa.
--
-- Y así el tope pasa a estar EN LA BASE: hasta ahora vivía solo en el servicio, de modo
-- que un `insert` directo lo ignoraba. Los `CHECK` de la tabla cubren tipo, tamaño y
-- nombre; contar filas hermanas no cabe en un CHECK de fila, tiene que ser un trigger.
create function archivo_item_candado_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_item uuid := coalesce(new.item_id, old.item_id);
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
  v_n int;
  v_estado text;
begin
  -- El candado va PRIMERO y sin condición: es el mismo espacio de nombres que toma la
  -- app (`designio:item:` + el uuid en texto canónico, semilla 42), de modo que subir,
  -- retirar y sellar el item se serializan entre sí vengan de donde vengan. No revela
  -- nada a nadie —esperar no es una respuesta— así que no hay motivo para condicionarlo,
  -- y ponerlo antes del pre-chequeo es lo que hace que también participe el SQL crudo.
  perform pg_advisory_xact_lock(hashtextextended('designio:item:' || v_item::text, 42));
  -- Anti-oráculo. Un no-miembro no puede enterarse por el mensaje de error de que ese
  -- material existe, ni de si está lleno o ya decidido — su escritura la rechaza la
  -- política de todas formas, pero el `WITH CHECK` (y el `USING` del DELETE) se evalúan
  -- DESPUÉS de este trigger, así que sin el pre-chequeo el error llegaría antes que el
  -- rechazo. Mismo motivo por el que el guard de derechos lo lleva.
  if not is_workspace_member(app_user_id(), v_ws) then
    return coalesce(new, old);
  end if;

  -- ═══ RE-LECTURA DESPUÉS DEL CANDADO (esperar sin releer es esperar para nada) ═══
  -- El candado ORDENA, pero no arregla retroactivamente la instantánea que la sentencia
  -- ya usó para elegir filas. Las dos políticas del adjunto —`archivo_insert` y
  -- `archivo_delete`— exigen que el item siga `pendiente`, y ese `exists` se evalúa con
  -- el snapshot de la sentencia DML, que se tomó ANTES de que este trigger empezara a
  -- esperar. Así que un `delete … where id = X` crudo podía elegir el adjunto con el item
  -- todavía pendiente, dormirse aquí en el candado del curador, despertar con el sello ya
  -- commiteado y BORRAR IGUAL el original de un material ya decidido. Es el mismo error
  -- que el `for share` sobre `derecho_uso` no comete: allí hay comprobaciones DEBAJO del
  -- candado que releen; aquí no había nada debajo, el trigger esperaba y dejaba pasar.
  --
  -- Por el camino del servicio no se daba, y eso es justo lo que lo hacía fácil de no ver:
  -- `bloquearItem` toma el candado en una sentencia ANTERIOR, así que el DML arranca con
  -- el candado ya en la mano y su snapshot es posterior al sello. El agujero era del SQL
  -- directo, que es el que este repositorio se compromete a que choque igual.
  --
  -- La re-lectura es un `select` llano, no un `for share`: el candado consultivo YA es el
  -- candado elegido para este objeto y lo toman los dos lados dentro de la base (aquí y
  -- en `item_sellado_candado`), así que añadir un candado de fila sobre `item_importacion`
  -- no protegería de nada nuevo y sí metería un segundo mecanismo sobre el mismo objeto
  -- —justo lo que esta migración evita— con su orden de adquisición que cuadrar.
  --
  -- Y funciona porque este camino corre en READ COMMITTED: un `select` posterior al
  -- candado toma snapshot nuevo y ve lo que se commiteó mientras esperaba (comprobado).
  -- OJO al futuro: bajo `repeatable read` —que la exportación sí usa a propósito— esta
  -- re-lectura vería el snapshot viejo y volvería a ser decorativa. Si algún día un
  -- camino de adjuntos necesita ese nivel, esta comprobación hay que rehacerla.
  select i.estado into v_estado from item_importacion i
    where i.id = v_item and i.workspace_id = v_ws;
  if v_estado is distinct from 'pendiente' then
    -- Dice QUE fue decidido y nada más: ni quién lo selló ni cuándo. Que un material haya
    -- pasado a decidido lo puede saber cualquiera que pudiera verlo pendiente.
    raise exception 'No puedes cambiar los adjuntos de este material: ya fue decidido, y lo decidido es inmutable (SYS-17)'
      using errcode = 'AD002';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  select count(*) into v_n from archivo_importado
    where item_id = v_item and workspace_id = v_ws;
  -- Espejo de MAX_ARCHIVOS_POR_ITEM en `sanitizacion.ts`, igual que los 5 MiB del CHECK
  -- de tamaño. El mensaje dice que el material está lleno y su tope, y NADA más: ni
  -- cuántos hay de cada quien ni de quién son. Que un objeto compartido esté saturado es
  -- una propiedad suya, y callarlo dejaría una subida que falla sin decir por qué, que
  -- es justo lo que SYS-14 prohíbe.
  if v_n >= 10 then
    raise exception 'Este material ya alcanzó el máximo de 10 adjuntos: la bandeja es curaduría, no un repositorio'
      using errcode = 'AD001';
  end if;
  return new;
end $$;

create trigger archivo_item_candado
  before insert or delete on archivo_importado
  for each row execute function archivo_item_candado_guard();

revoke execute on function archivo_item_candado_guard() from public;

-- ── Sellar el item toma el MISMO candado ──
-- «Lo decidido es inmutable» (SYS-17) lo dice la política del adjunto exigiendo que el
-- item siga `pendiente`. Pero eso es un predicado sobre una instantánea: una subida podía
-- comprobar que el item estaba pendiente, el curador sellarlo, y la subida commitear
-- después — las dos transacciones con razón en su propio snapshot y equivocadas juntas.
-- Con las dos tomando este candado, la subida entra ENTERA antes del sello o la rechaza
-- la política; no hay tercer resultado. Simétricamente, un borrado ya no puede quitar un
-- original después de que el curador lo haya revisado y sellado.
create function item_sellado_candado_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.estado = 'pendiente' and new.estado is distinct from old.estado then
    perform pg_advisory_xact_lock(hashtextextended('designio:item:' || new.id::text, 42));
  end if;
  return new;
end $$;

create trigger item_sellado_candado
  before update on item_importacion
  for each row execute function item_sellado_candado_guard();

revoke execute on function item_sellado_candado_guard() from public;

-- Los items que YA tienen más adjuntos que el tope (podrían existir en una instalación
-- que corrió con el conteo recortado por RLS) no se tocan —borrar material aportado no
-- es cosa de una migración— pero quedan registrados, la misma disciplina de siempre.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select a.workspace_id, 'ItemConAdjuntosSobreTope',
       jsonb_build_object('itemId', a.item_id, 'adjuntos', count(*)),
       null, null
from archivo_importado a
group by a.workspace_id, a.item_id
having count(*) > 10;
