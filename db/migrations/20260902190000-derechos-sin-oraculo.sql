-- RF-03.10 / SYS-01-02 / SYS-14 — tres agujeros de la misma familia: el predicado de
-- derechos decía la verdad, pero se la contaba a quien no debía, no la re-evaluaba por
-- todos los caminos y dejaba cambiar la atribución sin dejar rastro.
--
-- 1) ORÁCULO CROSS-TENANT. `evidencia_usable` y `evidencia_motivo_bloqueo` son
--    SECURITY DEFINER —tienen que decidir igual para todos los roles, sin depender de qué
--    filas de `derecho_uso` vea el invocante— y están concedidas a designio_app. Pero no
--    comprobaban membresía: una sesión de la aplicación podía llamarlas con el workspace y
--    la evidencia de OTRO tenant y recibir respuesta. La de `usable` ya es un oráculo de
--    existencia; la de `motivo_bloqueo` es peor, porque devuelve el texto de `base`, que es
--    prosa libre escrita por el cliente («el titular retiró el consentimiento», cláusulas
--    de contrato). Es exactamente lo que el resto de guards del repositorio evita con su
--    pre-chequeo anti-oráculo, y estas dos se quedaron fuera del patrón.
--
--    `is_workspace_member(null, ...)` es FALSE, así que endurecerlas también cierra la
--    puerta a una sesión del rol de aplicación sin contexto RLS. Las backfills de las
--    migraciones anteriores las llamaban como propietario, pero corren ANTES que esta
--    (números menores) y por tanto contra la definición permisiva: no se ven afectadas.
--
-- 2) LA CADENA SE CORTABA EN LA DECISIÓN. El guard de suficiencia re-valida los derechos
--    de la evidencia citada directamente y de la citada a través de un insight, pero un
--    ítem que cita una DECISIÓN solo se comprobaba contra `decision.estado`. Y ese estado
--    habla de reaperturas (SYS-10), no de derechos: una decisión perfectamente `vigente`
--    puede apoyarse en insights cuyo respaldo se revocó. Justifiqué la omisión diciendo
--    que ese eslabón «ya tiene su propio re-chequeo», y era confundir dos mecanismos
--    distintos: el mismo razonamiento entra por la puerta de al lado.
--
-- 3) ATRIBUCIÓN SIN EVENTO. La condición del guard de transición mira estado, ámbito,
--    vigencia y base, pero no la atribución. Si un segundo responsable reenvía la MISMA
--    decisión, el UPDATE del servicio reescribe `decidido_por` y `decidido_en` y el guard
--    no dispara: la fila viva pasa a atribuir la decisión a la segunda persona mientras la
--    auditoría sigue nombrando a la primera. En un dominio donde conceder derechos es un
--    acto contractual, quién lo firmó no puede cambiar en silencio.

-- ── 1. Los predicados solo responden a quien es miembro ──
create or replace function evidencia_usable(p_evidencia uuid, p_ws uuid, p_ambito text) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$
  select is_workspace_member(app_user_id(), p_ws) and exists (
    select 1 from derecho_uso d
    where d.evidencia_id = p_evidencia
      and d.workspace_id = p_ws
      and d.estado = 'concedido'
      -- Caducado ⇒ ya no hay derechos (fecha calendárica, comparada como día).
      and (d.vence_en is null or d.vence_en >= current_date)
      and case p_ambito
            when 'interno' then d.ambito in ('interno', 'cliente', 'publico')
            when 'cliente' then d.ambito in ('cliente', 'publico')
            when 'publico' then d.ambito = 'publico'
            else false
          end
  )
$$;

-- Para quien no es miembro no hay motivo que dar: null, igual que cuando sí se puede. No
-- se distingue «no puedes verlo» de «no existe», que es la propiedad anti-oráculo.
create or replace function evidencia_motivo_bloqueo(p_evidencia uuid, p_ws uuid, p_ambito text) returns text
language sql stable security definer set search_path = public, pg_temp as
$$
  select case
    when not is_workspace_member(app_user_id(), p_ws) then null
    when evidencia_usable(p_evidencia, p_ws, p_ambito) then null
    when d.evidencia_id is null then
      'la evidencia no existe en este workspace o no tiene registro de derechos'
    when d.estado = 'pendiente' then
      'derechos pendientes: nadie ha registrado la base (consentimiento o cláusula) que autoriza este uso'
    when d.estado = 'denegado' then
      'derechos denegados: ' || d.base
    when d.vence_en is not null and d.vence_en < current_date then
      'los derechos vencieron el ' || to_char(d.vence_en, 'YYYY-MM-DD')
    else
      'los derechos concedidos alcanzan solo el ámbito «' || d.ambito ||
      '» y este uso exige «' || p_ambito || '»'
  end
  from (select p_evidencia as ev) param
  left join derecho_uso d on d.evidencia_id = param.ev and d.workspace_id = p_ws
$$;

-- ── 2. La atribución también es una transición ──
create or replace function derecho_uso_transicion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado is distinct from old.estado
     or new.ambito is distinct from old.ambito
     or new.vence_en is distinct from old.vence_en
     or new.base is distinct from old.base
     -- Quién firma es parte de la decisión, no metadato: si cambia, hay decisión nueva
     -- que auditar aunque el contenido sea idéntico. Sin esto, un segundo responsable se
     -- quedaba como autor de la fila viva sin aparecer en la historia.
     or new.decidido_por is distinct from old.decidido_por then
    new.decidido_en := now();
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id,
      case new.estado when 'concedido' then 'DerechosConcedidos' else 'DerechosDenegados' end,
      jsonb_strip_nulls(jsonb_build_object(
        'evidenciaId', new.evidencia_id, 'ambito', new.ambito, 'base', new.base,
        'venceEn', to_char(new.vence_en, 'YYYY-MM-DD'),
        'previo', jsonb_build_object('estado', old.estado, 'ambito', old.ambito,
                                     'decididoPor', old.decidido_por))),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ── 3. El gate sigue la cadena también a través de la decisión ──
-- Se parte de la versión VIVA (la de 20260902160000) y se AÑADE una rama. Ver la
-- advertencia sobre composición de ramas en esa migración: este guard se reemplaza entero,
-- así que copiar la definición vigente es obligatorio, no una preferencia.
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

-- ── 4. El original adjunto no se descarga por el mero hecho de ser miembro ──
-- `interno` significa «solo trabajo de la boutique» y `cliente` «portal y entregables».
-- La política de lectura era solo de membresía, así que un stakeholder o un sponsor podía
-- descargar los BYTES ORIGINALES del material de una evidencia con derechos pendientes,
-- denegados o concedidos solo para uso interno — el ámbito declarado no significaba nada
-- en la única superficie que entrega el documento entero.
--
-- Quién sigue viendo qué, y por qué:
--  · Quien lo subió — aportar material y no poder releerlo sería absurdo, y es la vía por
--    la que un stakeholder contribuye (RF-03.1).
--  · La boutique (lead-boutique, disenador) — cura el material: es su trabajo, y es
--    exactamente lo que el ámbito `interno` autoriza.
--  · admin-cliente — administra los datos del cliente (RF-01.4) y es quien ejerce el
--    derecho de exportar el archivo COMPLETO (SYS-04: «todos sus objetos»). Excluirlo
--    dejaría el archivo del propietario incompleto, que es justo lo que SYS-04 prohíbe.
--  · Cualquier miembro, si la evidencia resultante tiene derechos vigentes para `cliente`:
--    ahí el material ya está autorizado para el uso con el cliente.
-- Los roles de cliente que NO administran (stakeholder, sponsor) dejan de recibir el
-- original de material que todavía no está autorizado para ellos.
drop policy archivo_select on archivo_importado;
create policy archivo_select on archivo_importado
  for select using (
    is_workspace_member(app_user_id(), workspace_id)
    and (
      creado_por = app_user_id()
      or workspace_role(app_user_id(), workspace_id)
         in ('lead-boutique', 'disenador', 'admin-cliente')
      or exists (select 1 from item_importacion i
        where i.id = archivo_importado.item_id
          and i.workspace_id = archivo_importado.workspace_id
          and i.evidencia_id is not null
          and evidencia_usable(i.evidencia_id, i.workspace_id, 'cliente'))
    )
  );
