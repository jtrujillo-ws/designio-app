-- Ver la cabecera de `razonamiento_usable_guard`, abajo: este fichero existe para que las
-- dos rutas que consumen razonamiento —el checklist de un gate y la certificación de G5—
-- compartan la REDACCIÓN del protocolo en vez de dos copias que ya habían divergido.
--
-- Octava reescritura de `gate_aprobar_suficiencia_guard` en esta rama. `create or replace`
-- reemplaza la función entera: el cuerpo se copió del ÁRBOL YA MIGRADO
-- (`pg_get_functiondef`), no de memoria, y lo único que cambia respecto de él es que los
-- candados y las cuatro comprobaciones de razonamiento salen a la función compartida.

-- RF-03.10 / RF-04.5 / RF-06.3 / SYS-14 — DOS RUTAS QUE CONSUMEN RAZONAMIENTO, UNA SOLA
-- REDACCIÓN DEL PROTOCOLO.
--
-- La rama de G5 que añadió 20260902320000 nació con dos huecos, y los dos son cosas que la
-- ruta hermana —el consumo por checklist— YA hacía:
--
--  · no comprobaba `insight.estado = 'validado'`, y 20260902260000 conserva a propósito los
--    enlaces heredados a insights `propuesto`, así que un G5 podía certificar un diseño
--    INMUTABLE cuyo razonamiento nunca pasó la validación;
--  · y bloqueaba `derecho_uso` pero no tomaba `for share` sobre las DECISIONES alcanzadas,
--    que es el objeto compartido con quien enlaza un `decision_insight`: sin ese candado el
--    insertor no encuentra conflicto y commitea después de las comprobaciones.
--
-- El defecto de fondo no es ninguno de los dos: es que la regla nueva se escribió bien y
-- las viejas no viajaron con ella. Añadirlas a mano dejaría dos redacciones hermanas del
-- mismo protocolo —ya demostradamente divergentes— y el hueco volvería en cuanto alguien
-- tocara una. Así que se comparte la redacción, que es lo que este repositorio hace en
-- todas partes cuando dos sitios deciden lo mismo (el rango bidi en `sin_overrides_bidi`,
-- la poda en `CATALOGO_EXPORT`, el predicado de derechos en `derechos_vigentes`).
--
-- ── Qué se comparte y qué no ──
-- Se comparte el PROTOCOLO ENTERO: candados, orden y predicados. Lo que queda fuera es el
-- RECORRIDO —cómo cada ruta llega a los insights, decisiones y evidencia que consume—,
-- porque son de verdad distintos: el checklist llega por `checklist_item`, y G5 por
-- `elemento_cambio` → `elemento_insight` / `elemento_decision`. Cada llamante recorre lo
-- suyo y pasa ids; a partir de ahí, deciden igual por construcción y no por vigilancia.
create function razonamiento_usable_guard(
  p_ws uuid,
  p_insights uuid[],
  p_decisiones uuid[],
  p_evidencias uuid[],
  p_contexto text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bloqueo text;
  v_afirmacion text;
  v_evidencia uuid;
  v_decision text;
begin
  -- ═══ 1. CANDADO SOBRE LAS DECISIONES ═══
  -- Va PRIMERO porque de estas filas se DERIVA el conjunto de derechos de abajo: bloquear
  -- el resultado sin bloquear la fuente deja el fantasma abierto (una fila de
  -- `decision_insight` insertada en medio no toca ninguna fila bloqueada). `for share` y no
  -- `for update`: dos aprobaciones distintas no tienen por qué esperarse. Orden por id.
  perform d.id
    from decision d
    where d.workspace_id = p_ws and d.id = any(p_decisiones)
    order by d.id
    for share;

  -- ═══ 2. CANDADO SOBRE LOS DERECHOS QUE SE VAN A LEER ═══
  -- Quien revoca hace `update derecho_uso`, que ya toma el candado en conflicto sin
  -- cooperar con ningún protocolo — también desde SQL crudo. Va ANTES de decidir: bloquear
  -- después de comprobar deja exactamente la misma ventana. Se bloquea el mismo conjunto
  -- que las comprobaciones recorren, ni una fila más.
  perform du.evidencia_id
    from derecho_uso du
    where du.workspace_id = p_ws
      and du.evidencia_id in (
        select e.id from evidencia e where e.workspace_id = p_ws and e.id = any(p_evidencias)
        union
        select c.evidencia_id
          from afirmacion a
          join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
          where a.workspace_id = p_ws and a.insight_id = any(p_insights)
        union
        select c.evidencia_id
          from decision_insight di
          join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
          join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
          where di.workspace_id = p_ws and di.decision_id = any(p_decisiones)
      )
    order by du.evidencia_id
    for share;

  -- ═══ 3. LA EVIDENCIA CITADA DIRECTAMENTE SIGUE SIENDO USABLE ═══
  select evidencia_motivo_bloqueo(e.id, e.workspace_id, 'cliente')
    into v_bloqueo
    from evidencia e
    where e.workspace_id = p_ws and e.id = any(p_evidencias)
      and not evidencia_usable(e.id, e.workspace_id, 'cliente')
    limit 1;
  if found then
    raise exception 'no se puede aprobar: % cita evidencia sin derechos vigentes — %',
      p_contexto, coalesce(v_bloqueo, 'derechos insuficientes') using errcode = 'DR001';
  end if;

  -- ═══ 4. NINGUNA DECISIÓN DEL RAZONAMIENTO ESTÁ EN REVISIÓN ═══
  -- `elemento_motivo_citable_guard` ya exige `estado = 'vigente'` al ENLAZAR, y eso no
  -- basta: `reabrirEtapa` puede pasarla a 'en-revision' DESPUÉS, con el diseño ya aprobado
  -- e inmutable. Se re-chequea al consumir en vez de resetear los ítems al reabrir —
  -- resetear tiraría trabajo que quizá sigue en pie, y revalidar la decisión desbloquea el
  -- gate sin tocar el checklist. Estaba a mano en la rama del checklist y por eso G5 no la
  -- tenía: es la CUARTA comprobación del protocolo, y compartir sólo tres reproducía un
  -- piso más abajo el defecto que esta función vino a cerrar. Va después del candado sobre
  -- `decision`, que es de donde lee.
  select d.titulo into v_decision
    from decision d
    where d.workspace_id = p_ws and d.id = any(p_decisiones) and d.estado <> 'vigente'
    order by d.decidido_en, d.id
    limit 1;
  if v_decision is not null then
    raise exception 'no se puede aprobar: % se apoya en la decisión «%», que una reapertura dejó en revisión (SYS-10) — revalídala o rehaz el razonamiento',
      p_contexto, v_decision;
  end if;

  -- ═══ 5. TODA DECISIÓN SE TRAZA A INSIGHTS VALIDADOS ═══
  -- La política `decision_insight_insert` cierra la entrada desde 20260902260000, pero una
  -- política gobierna lo que se escribe A PARTIR DE AHORA: los enlaces heredados solo los
  -- alcanza la comprobación en el CONSUMO, y ésta es.
  if exists (
    select 1 from decision_insight di
    join insight i on i.id = di.insight_id and i.workspace_id = di.workspace_id
    where di.workspace_id = p_ws and di.decision_id = any(p_decisiones)
      and i.estado <> 'validado'
  ) then
    raise exception 'no se puede aprobar: % se traza a una decisión con un insight que no está validado — valídalo o rehaz la decisión',
      p_contexto;
  end if;

  -- ═══ 6. TODA AFIRMACIÓN NO-HIPÓTESIS TIENE AL MENOS UNA CITA USABLE ═══
  -- Sobre el razonamiento alcanzado por las dos vías, directa y a través de decisiones. Se
  -- trae la primera que falla para poder NOMBRARLA (SYS-14): un motivo genérico no dice qué
  -- reparar. «Al menos una usable» y no «ninguna bloqueada»: una afirmación con dos citas
  -- sigue sostenida si a una le quedan derechos, y exigir más sería más estricto que la
  -- propia validación del insight.
  with alcanzado as (
    select a.id, a.texto, a.orden, a.workspace_id, a.es_hipotesis
      from afirmacion a
      where a.workspace_id = p_ws and a.insight_id = any(p_insights)
    union
    select a.id, a.texto, a.orden, a.workspace_id, a.es_hipotesis
      from decision_insight di
      join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
      where di.workspace_id = p_ws and di.decision_id = any(p_decisiones)
  )
  select r.texto,
         (select c.evidencia_id from cita c
           where c.afirmacion_id = r.id and c.workspace_id = r.workspace_id
           order by c.creado_en, c.id limit 1)
    into v_afirmacion, v_evidencia
    from alcanzado r
    where not r.es_hipotesis
      and not exists (select 1 from cita c
        where c.afirmacion_id = r.id and c.workspace_id = r.workspace_id
          and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'))
    order by r.orden
    limit 1;
  if v_afirmacion is not null then
    raise exception 'no se puede aprobar: % se apoya en la afirmación «%», que ya no tiene ninguna cita con derechos vigentes — %',
      p_contexto, v_afirmacion,
      coalesce(evidencia_motivo_bloqueo(v_evidencia, p_ws, 'cliente'),
               'derechos insuficientes')
      using errcode = 'DR001';
  end if;
end $$;
comment on function razonamiento_usable_guard(uuid, uuid[], uuid[], uuid[], text) is
'El protocolo COMPLETO para consumir razonamiento: candado sobre las decisiones, candado sobre los derechos que se van a leer, y las cuatro comprobaciones (evidencia citada usable, ninguna decisión en revisión, decisiones trazadas a insights validados, afirmaciones no-hipótesis con al menos una cita usable). Lo llaman el consumo por checklist y la certificación de G5; el recorrido hasta los ids lo pone cada ruta.';

revoke execute on function razonamiento_usable_guard(uuid, uuid[], uuid[], uuid[], text) from public;

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

-- El orden dentro del guard cambia en una cosa, y conviene decirla: las comprobaciones
-- estructurales del checklist (pendientes, instanciado) pasan a ir ANTES de los candados.
-- Antes los candados iban primero de todo: moverlos detrás de dos comprobaciones que no
-- leen estado compartido no abre ninguna ventana y evita bloquear filas para acabar
-- rechazando por un checklist vacío. La de «decisiones en revisión» ya no está suelta en
-- ninguna parte: entró en la función compartida, que la ejecuta después de su propio
-- `for share` sobre `decision` — que es de donde lee.
