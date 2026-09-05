-- ── Lo que le falta a un gate para aprobarse lo dice LA BASE, en un solo sitio ──
--
-- `gate_aprobar_suficiencia_guard` es quien manda: checklist decidido, gates anteriores,
-- criterios de G0, arquetipos de G2 (y sus derechos vivos), diseño congelado de G5 con su
-- razonamiento usable, registry y cobertura de releases de G6, conciliación de G7. Todo
-- eso vivía DENTRO de un trigger que levanta excepciones, y por eso quien quería mirarlo
-- antes no tenía más remedio que reescribirlo: `faltaParaAprobarGate` en TypeScript
-- espeja cinco de esas reglas para apagar el botón del proyecto, y la bandeja de
-- aprobaciones —que cuenta lo que un rol puede aprobar AHORA— heredó ese espejo y con él
-- sus huecos. Un G5 con el checklist decidido y sin design version aprobada salía contado
-- en el lateral, la bandeja decía «se puede aprobar ahora» y la base lo rechazaba. La
-- revisión lo señaló y tenía razón: seguir ampliando el espejo es la misma deuda con más
-- líneas. Es el mismo movimiento que ya hicieron `g7_motivo_de_bloqueo` (20260902120000)
-- y `razonamiento_sin_respaldo` (20260902350000), ahora para el gate entero.
--
-- ── Lo que entra ──
--
-- 1. Un tipo `motivo_de_bloqueo (codigo, motivo)`: el motivo es el texto que hoy levanta el
--    guard, TAL CUAL, y el código es el SQLSTATE con el que lo levanta (`DR001` para los de
--    derechos, que el servicio distingue para propagar la dimensión que falta —SYS-14—;
--    `P0001` para el resto). Devolver solo el texto habría perdido esa distinción al pasar
--    por la función, y el servicio la usa.
--
-- 2. `razonamiento_candados`: los dos `for share` de `razonamiento_usable_guard`, solos.
--    El guard del gate los necesita SIN la comprobación —porque la comprobación pasa a
--    hacerla `gate_faltas_para_aprobar` junto con las demás, en el mismo orden de siempre—
--    y extraerlos es lo que permite que la lectura y la escritura compartan el predicado
--    sin compartir los candados. `razonamiento_usable_guard` se conserva con su contrato
--    (candados + predicado + raise) para quien la llame.
--
-- 3. `gate_faltas_para_aprobar(gate, workspace)`: las razones por las que el gate NO se
--    aprobaría, en el orden en que el guard las comprobaba, o ninguna fila si sí. Solo
--    lectura y sin candados. Es la función CRUDA, con la misma disciplina que
--    `razonamiento_sin_respaldo` desde 20260902360000: lee la REGLA (`derechos_vigentes`,
--    `razonamiento_sin_respaldo`) y no la regla más la puerta, porque la llama el guard, que
--    corre como propietario y muchas veces sin `app.user_id` —con la puerta dentro dejaría
--    de comprobar nada mientras aparenta comprobarlo—. Sin grant: la ejecuta el guard.
--
--    Y encima, `gate_faltas_para_aprobar_visible`: la misma pregunta con la puerta
--    anti-oráculo delante, que es la única que el rol de la app puede ejecutar y la que
--    llama la bandeja de aprobaciones. Para quien no es miembro devuelve nada, indistinguible
--    de «se puede aprobar»: un motivo distinto sería un oráculo de existencia.
--
--    Trae además una razón que el guard BEFORE no daba porque la da otro trigger: G6 con el
--    proyecto parado (`proyecto_a_implementacion_tras_g6_guard`, AFTER, con el mismo
--    texto). El AFTER sigue siendo quien la impone —hace el UPDATE con el candado de la
--    fila del proyecto—; aquí solo se anticipa para que la bandeja no prometa un G6 que el
--    guard de después va a negar.
--
-- 4. El guard se reescribe entero (copia íntegra de 20260902340000 en todo lo que no es
--    comprobación): candado del reto, sello temporal, candados del razonamiento —del
--    checklist, del diseño en G5, de los arquetipos en G2—, y después UNA sola llamada a
--    `gate_faltas_para_aprobar`. Los efectos inseparables (etapa completada, evento
--    GateAprobado) quedan tal cual.
--
--    Cambia el orden en una cosa, dicha aquí: las dos comprobaciones estructurales del
--    checklist (pendientes, instanciado) iban ANTES de los candados desde 340000, para no
--    bloquear filas y acabar rechazando por un checklist vacío. Ahora van con las demás,
--    después de los candados, porque comprobarlas dos veces —una antes para atajar y otra
--    dentro de la función— es exactamente la segunda redacción que esta migración viene a
--    quitar. Un candado tomado para una aprobación que se rechaza se suelta con el
--    rollback: cuesta una espera corta y no abre ninguna ventana.
--
-- Los textos de las razones son LOS MISMOS que levantaba el guard, carácter a carácter:
-- los tests que los fijan siguen valiendo, y la pantalla del proyecto —que traduce estos
-- mismos mensajes al pulsar— no nota el cambio.

create type motivo_de_bloqueo as (codigo text, motivo text);

-- ── 2. Los candados del razonamiento, solos ──
create function razonamiento_candados(
  p_ws uuid,
  p_insights uuid[],
  p_decisiones uuid[],
  p_evidencias uuid[]
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- ═══ 1. CANDADO SOBRE LAS DECISIONES ═══
  -- Va PRIMERO porque de estas filas se DERIVA el conjunto de derechos de abajo: bloquear
  -- el resultado sin bloquear la fuente deja el fantasma abierto. `for share` y no
  -- `for update`: dos aprobaciones distintas no tienen por qué esperarse. Orden por id.
  perform d.id
    from decision d
    where d.workspace_id = p_ws and d.id = any(p_decisiones)
    order by d.id
    for share;

  -- ═══ 2. CANDADO SOBRE LOS DERECHOS QUE SE VAN A LEER ═══
  -- Quien revoca hace `update derecho_uso`, que ya toma el candado en conflicto sin
  -- cooperar con ningún protocolo. Va ANTES de decidir: bloquear después de comprobar deja
  -- exactamente la misma ventana.
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
end $$;
revoke execute on function razonamiento_candados(uuid, uuid[], uuid[], uuid[]) from public;

-- `razonamiento_usable_guard` conserva su contrato: candados + predicado + raise. Solo
-- cambia que los candados ya no están escritos aquí.
create or replace function razonamiento_usable_guard(
  p_ws uuid,
  p_insights uuid[],
  p_decisiones uuid[],
  p_evidencias uuid[],
  p_contexto text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_motivo text;
begin
  perform razonamiento_candados(p_ws, p_insights, p_decisiones, p_evidencias);
  v_motivo := razonamiento_sin_respaldo(p_ws, p_insights, p_decisiones, p_evidencias);
  if v_motivo is not null then
    raise exception 'no se puede aprobar: % %', p_contexto, v_motivo using errcode = 'DR001';
  end if;
end $$;

-- ── 3. Las razones, en el orden del guard ──
create function gate_faltas_para_aprobar(p_gate uuid, p_ws uuid)
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
comment on function gate_faltas_para_aprobar(uuid, uuid) is
'Por qué NO se aprobaría este gate, en el orden en que el guard lo comprueba; ninguna fila si se puede aprobar ya. Solo lectura y sin candados, y CRUDA (sin puerta de membresía): la llama el guard, que corre como propietario, y levanta la primera con su código. El rol de la app pasa por `gate_faltas_para_aprobar_visible`. Que sea una sola redacción es lo que impide que una pantalla espeje media regla.';
-- De PUBLIC y no solo del rol de la app: Postgres otorga EXECUTE a PUBLIC por defecto sobre
-- toda función nueva (la lección de 20260902360000).
revoke execute on function gate_faltas_para_aprobar(uuid, uuid) from public;

create function gate_faltas_para_aprobar_visible(p_gate uuid, p_ws uuid)
returns setof motivo_de_bloqueo
language sql stable security definer set search_path = public, pg_temp as $$
  -- Para quien no es miembro, la respuesta es la misma que si todo estuviera en orden:
  -- ninguna fila. Indistinguible, que es el punto.
  select f.* from gate_faltas_para_aprobar(p_gate, p_ws) f
  where is_workspace_member(app_user_id(), p_ws)
$$;
comment on function gate_faltas_para_aprobar_visible(uuid, uuid) is
'`gate_faltas_para_aprobar` MÁS la puerta anti-oráculo: para quien no es miembro del workspace no devuelve nada, indistinguible de «se puede aprobar». Es la única de las dos que el rol de aplicación puede ejecutar, y la que llama la bandeja de aprobaciones.';
revoke execute on function gate_faltas_para_aprobar_visible(uuid, uuid) from public;
grant execute on function gate_faltas_para_aprobar_visible(uuid, uuid) to designio_app;

-- ── 4. El guard: candados y la primera razón ──
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
