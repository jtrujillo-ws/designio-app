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

-- ── Copia ÍNTEGRA de la versión viva (20260902250000) más la rama ──
-- Ver la advertencia sobre composición de ramas en 20260902160000: este `create or
-- replace` reescribe la función entera, así que lo que no se copie se pierde.
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bloqueo text;
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
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
    -- El insight que traza la decisión tiene que estar VALIDADO, y se re-comprueba aquí.
    -- La política `decision_insight_insert` (20260902260000) cierra la puerta de entrada,
    -- pero solo para las escrituras nuevas del rol de aplicación: los enlaces que ya
    -- existían —los que esa misma migración enumera en el evento
    -- `DecisionConInsightSinValidarDetectada`— siguen ahí y siguen siendo alcanzables.
    -- Sin esta rama, uno de ellos hacia un insight `propuesto` con citas de derechos
    -- vigentes cumple el ítem y aprueba el gate exactamente igual que antes: la puerta se
    -- cerró por delante y los que ya estaban dentro se quedaron dentro. Reproducido por
    -- SQL crudo antes de escribir esto.
    --
    -- Se rechaza EN EL CONSUMO y no se pone en cuarentena el enlace, que es el mismo
    -- patrón que este slice ya eligió y argumentó para los derechos: re-validar al
    -- aprobar —el acto que pone el razonamiento delante del cliente— en vez de invalidar
    -- hacia atrás filas que registran una decisión humana. Y perdonar esto sería perdonar
    -- el CONTENIDO, no el momento: un insight `propuesto` nunca pasó por
    -- `insight_validar_guard`, así que nadie comprobó que sus afirmaciones no-hipótesis
    -- tuvieran cita. La vía DIRECTA (un ítem que cita el insight sin pasar por la
    -- decisión) no necesita esta rama: su propio guard de 20260902080000 ya exige
    -- `estado = 'validado'` al marcar, comprobado.
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
