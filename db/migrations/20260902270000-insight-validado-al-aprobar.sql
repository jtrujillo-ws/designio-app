-- SPEC-04.9 / RF-03.10 — CERRAR LA PUERTA DE DELANTE DEJA DENTRO A LOS QUE YA ESTABAN.
--
-- `20260902260000` añadió a `decision_insight_insert` la exigencia de que el insight esté
-- validado, y con eso creí cerrado el agujero. No lo estaba: una política gobierna las
-- escrituras NUEVAS del rol de aplicación, y nada más. Los enlaces que ya existían —los
-- que esa misma migración se molesta en enumerar en el evento
-- `DecisionConInsightSinValidarDetectada`, o sea que hay constancia de que existen y son
-- alcanzables— siguen en su sitio, y el guard de aprobación nunca mira `insight.estado`.
--
-- Reproducido antes de arreglarlo, sobre base viva: un `decision_insight` escrito por el
-- propietario hacia un insight `propuesto` con citas de derechos vigentes → ítem
-- `cumplido` citando esa decisión → `update gate_instancia set estado = 'aprobado'` desde
-- el rol de aplicación. Resultado: gate APROBADO. Exactamente el mismo desenlace que antes
-- de 260000, por la puerta de atrás.
--
-- ═══ POR QUÉ RECHAZAR EN EL CONSUMO Y NO PONER EN CUARENTENA EL ENLACE ═══
-- Es el patrón que este slice ya eligió y argumentó para los derechos: re-validar al
-- APROBAR —el acto que pone el razonamiento delante del cliente— en vez de invalidar hacia
-- atrás filas que registran una decisión humana. Borrar o marcar enlaces heredados
-- reescribiría la traza de por qué se decidió algo, que es justo lo que este dominio no
-- toca; y dejaría además sin cubrir cualquier fila que llegue por una vía que no sea la
-- política (el propietario no pasa por políticas). La comprobación en el consumo las ve
-- todas, vengan de donde vengan y existieran desde cuando existieran.
--
-- Y no es un perdón histórico de los que este repositorio sí admite. Los que admite
-- perdonan el MOMENTO —una fila escrita antes de que la regla existiera— dejando el
-- contenido intacto y sin habilitar nada nuevo. Éste habilitaría aprobar un gate sobre un
-- insight que nunca pasó `insight_validar_guard`, es decir sobre un razonamiento del que
-- nadie comprobó que sus afirmaciones no-hipótesis tuvieran cita. Eso es perdonar el
-- CONTENIDO, y no se hace.
--
-- ═══ LO QUE SE COMPROBÓ Y NO HIZO FALTA ═══
--  · La vía DIRECTA —un ítem de checklist que cita el insight sin pasar por la decisión—
--    ya está cerrada: `checklist_item_objeto_guard` (20260902080000) exige
--    `i.estado = 'validado'` al marcar. Comprobado por SQL crudo: levanta «el insight
--    citado no existe o todavía no está validado». No se le añade nada.
--  · Un insight validado NO puede volver a `propuesto` por el producto: el grant de UPDATE
--    del rol de aplicación sobre `insight` es solo `estado`, `validado_por` y
--    `validado_en`, y la política `insight_validar` es
--    `using (estado = 'propuesto') with check (estado = 'validado')`. Así que un enlace no
--    heredado no se puede quedar rancio por ese lado; la población alcanzable es la
--    heredada y la que escriba el propietario. Se comprobó en vez de suponerlo, porque de
--    haber sido al revés esta rama no sería «para los heredados» sino la regla general.

-- ── Copia ÍNTEGRA de la versión viva (20260902250000, que arrastra entero el cuerpo de
--    20260902120000: G5, G6 y G7 de SPEC-06 y la regla del Metric Registry) más la rama ──
-- Ver la advertencia sobre composición de ramas en 20260902160000: este `create or
-- replace` reescribe la función entera, así que lo que no se copie se pierde.
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bloqueo text;
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
