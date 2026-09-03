-- RF-06.3 / RF-03.10 / SYS-14 — G5 CERTIFICABA QUE EL DISEÑO EXISTE, NO QUE SE PUEDE
-- ENSEÑAR.
--
-- Tercera aparición de la misma clase —«comprobar existencia en vez de vigencia»— y la
-- peor de las tres, porque el artefacto que queda es INMUTABLE y de cara al cliente.
--
-- El camino: se enlaza a un elemento de la design version razonamiento cuya evidencia ya
-- perdió los derechos, se aprueba la versión (que congela) y se certifica G5. Este mismo
-- guard rechaza ese razonamiento si se cita DIRECTAMENTE desde un ítem del checklist —esa
-- puerta la cerró 20260902160000 y la afinó 20260902270000— pero G5 entraba por la de al
-- lado, mirando solo que existiera una design version aprobada con elementos. Dos puertas
-- al mismo sitio, una con cerradura.
--
-- Se cierra con EL MISMO predicado que la vía indirecta del checklist, no con uno nuevo:
-- toda afirmación no marcada como hipótesis necesita al menos una cita con derechos
-- vigentes para el ámbito cliente. Aplicado al razonamiento que cuelga de los elementos
-- por las dos vías que existen, `elemento_insight` y `elemento_decision`.
--
-- Lo que NO se hace, y conviene decirlo: no se toca `design_version_transicion_guard`, que
-- es donde la versión se congela y donde el mismo argumento se podría aplicar un paso
-- antes. Eso es la regla de #16 y cambiar su semántica de aprobación no es cosa de este
-- PR; queda dicho como pregunta abierta. Lo que sí queda cerrado es la certificación, que
-- es el acto que pone el diseño delante del cliente y el que este fichero gobierna.
--
-- ── Copia ÍNTEGRA de la versión viva (20260902270000) más la rama de G5 ──
-- Séptima reescritura de este guard en esta rama. `create or replace` reemplaza la función
-- entera: el cuerpo se copió del ÁRBOL YA MIGRADO (`pg_get_functiondef`), no de memoria, y
-- lo único que cambia respecto de él son dos declaraciones nuevas y el bloque de G5.

create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bloqueo text;
  v_motivo text;
  v_reto uuid;
  v_afirmacion text;
  v_evidencia uuid;
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

    -- ═══ CANDADO SOBRE LAS DECISIONES QUE ESTE GATE CONSUME ═══
    -- Va ANTES del `for share` de `derecho_uso` porque de estas filas se DERIVA aquel
    -- conjunto: bloquear el resultado sin bloquear la fuente deja el fantasma abierto.
    -- `for share of d` y no a secas: se bloquea la decisión, que es el objeto compartido,
    -- y ni una fila de `checklist_item` de más — ese lado ya lo serializa `designio:gate:`.
    -- Orden determinista por id: dos aprobaciones no se estorban entre sí (`for share` es
    -- compatible consigo mismo), pero el orden es gratis y no hay que volver a pensarlo.
    perform d.id
      from decision d
      join checklist_item ci on ci.decision_id = d.id and ci.workspace_id = d.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and ci.decision_id is not null
      order by d.id
      for share of d;

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
    -- Se bloquea el mismo conjunto de FILAS que las comprobaciones recorren, ni una más —
    -- y ahora también es el conjunto correcto, porque el `for share` sobre `decision` de
    -- arriba impide que otro camino le añada miembros mientras se decide.
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
      join insight i on i.id = di.insight_id and i.workspace_id = di.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and ci.decision_id is not null
        and i.estado <> 'validado') then
      raise exception 'no se puede aprobar: un ítem cumplido cita una decisión trazada a un insight que no está validado — valídalo o rehaz la decisión';
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
    -- cliente. El camino era: enlazar a un elemento razonamiento cuya evidencia ya perdió
    -- los derechos, aprobar la versión —que congela— y certificar G5 con algo que este
    -- mismo guard rechazaría si se citara directamente desde un ítem del checklist. Dos
    -- puertas al mismo sitio, una con cerradura y otra sin ella.
    --
    -- El predicado es EL MISMO que el de la vía indirecta del checklist, unas líneas más
    -- arriba —toda afirmación no marcada como hipótesis necesita al menos una cita con
    -- derechos vigentes para el ámbito cliente—, aplicado al razonamiento que cuelga de los
    -- elementos por las dos vías que existen: `elemento_insight` y `elemento_decision`.
    -- Deliberadamente NO es «alguna cita bloqueada»: una afirmación con dos citas sigue
    -- sostenida si a una le quedan derechos.
    --
    -- Y la salida no hace falta inventarla: reconceder los derechos revive el razonamiento
    -- entero, que es lo único de este dominio que va y viene. Lo que no puede pasar es
    -- certificar de cara al cliente sobre algo que ya no se puede enseñar.
    if new.numero = 5 then
      -- Candado de fila sobre los derechos que se van a leer, antes de leerlos: mismo
      -- motivo y mismo modo que el bloque de arriba.
      perform du.evidencia_id
        from derecho_uso du
        where du.workspace_id = new.workspace_id
          and du.evidencia_id in (
            select c.evidencia_id
              from elemento_cambio ec
              join elemento_insight ei on ei.elemento_id = ec.id and ei.workspace_id = ec.workspace_id
              join afirmacion a on a.insight_id = ei.insight_id and a.workspace_id = ei.workspace_id
              join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
              where ec.workspace_id = new.workspace_id
                and ec.design_version_id in (
                  select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))
            union
            select c.evidencia_id
              from elemento_cambio ec
              join elemento_decision ed on ed.elemento_id = ec.id and ed.workspace_id = ec.workspace_id
              join decision_insight di on di.decision_id = ed.decision_id and di.workspace_id = ed.workspace_id
              join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
              join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
              where ec.workspace_id = new.workspace_id
                and ec.design_version_id in (
                  select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id)))
        order by du.evidencia_id
        for share;

      with razonamiento as (
        select a.id, a.texto, a.orden, a.workspace_id, a.es_hipotesis
          from elemento_cambio ec
          join elemento_insight ei on ei.elemento_id = ec.id and ei.workspace_id = ec.workspace_id
          join afirmacion a on a.insight_id = ei.insight_id and a.workspace_id = ei.workspace_id
          where ec.workspace_id = new.workspace_id
            and ec.design_version_id in (
              select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))
        union
        select a.id, a.texto, a.orden, a.workspace_id, a.es_hipotesis
          from elemento_cambio ec
          join elemento_decision ed on ed.elemento_id = ec.id and ed.workspace_id = ec.workspace_id
          join decision_insight di on di.decision_id = ed.decision_id and di.workspace_id = ed.workspace_id
          join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
          where ec.workspace_id = new.workspace_id
            and ec.design_version_id in (
              select design_versions_a_cargo_del_proyecto(new.proyecto_id, new.workspace_id))
      )
      select r.texto,
             (select c.evidencia_id from cita c
               where c.afirmacion_id = r.id and c.workspace_id = r.workspace_id
               order by c.creado_en, c.id limit 1)
        into v_afirmacion, v_evidencia
        from razonamiento r
        where not r.es_hipotesis
          and not exists (select 1 from cita c
            where c.afirmacion_id = r.id and c.workspace_id = r.workspace_id
              and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'))
        order by r.orden
        limit 1;
      if v_afirmacion is not null then
        raise exception 'no se puede aprobar G5: el diseño que certifica se apoya en la afirmación «%», que ya no tiene ninguna cita con derechos vigentes — %. Reconcede los derechos o rehaz el razonamiento antes de certificar: la design version es inmutable y es lo que ve el cliente',
          v_afirmacion,
          coalesce(evidencia_motivo_bloqueo(v_evidencia, new.workspace_id, 'cliente'),
                   'derechos insuficientes')
          using errcode = 'DR001';
      end if;
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

-- ── Los diseños que ya certificaron sobre razonamiento muerto quedan NOMBRADOS ──
-- No se revierte ningún gate: aprobar es un juicio humano y este dominio no lo reescribe.
-- Y no se quedan sin salida —reconceder los derechos revive el razonamiento entero— pero
-- el operador tiene que poder enterarse sin esperar a que algo se rompa.
--
-- El censo recorre LAS DOS VÍAS que recorre el guard de arriba. La primera versión de este
-- bloque unía solo por `elemento_insight`: un G5 heredado cuyo elemento se motiva por
-- DECISIÓN quedaba sin nombrar, aunque el guard nuevo rechace ese mismo diseño en runtime.
-- Medido sobre una base con ese caso exacto —un G5 aprobado, su elemento motivado por
-- decisión, y el insight trazado con las citas sin derechos—: el censo viejo escribía 0
-- eventos y el nuevo escribe 1. Un nombramiento a medias es peor que ninguno aquí, porque
-- este bloque corre UNA vez: lo que no se nombre ahora no se reconstruye después.
--
-- Lo que el censo comprueba es lo que ESTA migración añade: que toda afirmación
-- no-hipótesis del razonamiento certificado conserve una cita con derechos vigentes. Las
-- otras dos comprobaciones del protocolo llegan a la ruta de G5 en 20260902340000, y su
-- censo le corresponde a esa migración, no a ésta.
--
-- Y no llama a `razonamiento_sin_respaldo`, aunque el predicado esté factorizado, por una
-- razón concreta que conviene dejar escrita en vez de implícita: esa función usa
-- `evidencia_usable`, que lleva delante la puerta `is_workspace_member(app_user_id(), …)`.
-- Aquí corre `db/migrate.ts` con la conexión administrativa y sin `app.user_id`, así que la
-- puerta sería falsa siempre y el censo marcaría TODOS los G5 como rotos — exactamente el
-- defecto que hubo que arreglar en el backfill de `310000`. Medido sobre un diseño SANO
-- —derechos concedidos y vigentes de cara al cliente—: llamada como propietario y sin
-- `app.user_id`, la función responde «se apoya en la afirmación «…», que ya no tiene
-- ninguna cita con derechos vigentes»; con un miembro declarado responde null. Por eso el
-- recorrido se escribe aquí y el predicado de derechos se toma de `derechos_vigentes`, que
-- es la misma regla sin la puerta. El recorrido sí es el del guard, línea por línea.

-- Por las dos vías: `elemento_insight` y `elemento_decision → decision_insight`.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select distinct g.workspace_id, 'G5CertificadoSinRespaldoUsable',
       jsonb_build_object('gateId', g.id, 'proyectoId', g.proyecto_id,
                          'afirmacionSinRespaldo', a.texto),
       null::uuid, null::text
from gate_instancia g
join elemento_cambio ec on ec.workspace_id = g.workspace_id
  and ec.design_version_id in (
    select design_versions_a_cargo_del_proyecto(g.proyecto_id, g.workspace_id))
join afirmacion a on a.workspace_id = g.workspace_id
  and a.insight_id in (
    select ei.insight_id from elemento_insight ei
      where ei.elemento_id = ec.id and ei.workspace_id = ec.workspace_id
    union
    select di.insight_id from elemento_decision ed
      join decision_insight di on di.decision_id = ed.decision_id
        and di.workspace_id = ed.workspace_id
      where ed.elemento_id = ec.id and ed.workspace_id = ec.workspace_id)
where g.numero = 5 and g.estado = 'aprobado'
  and not a.es_hipotesis
  and not exists (select 1 from cita c
    where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
      and derechos_vigentes(c.evidencia_id, c.workspace_id, 'cliente'));
