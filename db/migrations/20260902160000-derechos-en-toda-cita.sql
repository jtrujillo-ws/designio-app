-- RF-03.10 / SYS-14 — los derechos bloqueantes valen en TODAS las superficies de cita,
-- y siguen valiendo cuando se revocan.
--
-- Dos agujeros de la misma clase: la regla «sin derechos vigentes para el ámbito cliente
-- esta evidencia no se cita» se impuso donde se pensó en ella y no donde también aplicaba.
--
-- 1) LA OTRA SUPERFICIE DE CITA. El guard de derechos colgaba solo de `checklist_item`,
--    pero la superficie de cita del producto son DOS: el ítem de gate y la `cita` de una
--    afirmación dentro de un insight (SPEC-03.9). La política de `cita` comprueba rol,
--    autoría e insight-propuesto, nunca derechos, así que un curador podía citar evidencia
--    pendiente o denegada desde /insights. Y la `cita` es peor que el ítem de gate: COPIA
--    el `fragmento` y la `localizacion` del original, de modo que persistir una es
--    persistir el material; encima esa cita satisface el requisito que valida el insight,
--    y un insight validado es inmutable y sostiene decisiones y gates. Podar `cita` del
--    paquete entregable —lo que ya se hizo— evita publicarla; esto evita crearla.
--
-- 2) LA REVOCACIÓN NO ALCANZABA A LO YA CUMPLIDO. Un ítem marcado `cumplido` cuando la
--    evidencia SÍ tenía derechos queda intacto si después se revocan: nada actualiza esa
--    fila, así que su trigger no vuelve a correr, y el guard de aprobación miraba
--    pendientes, orden de gates, criterios de G0, arquetipos y decisiones en revisión —
--    pero no derechos. El gate se aprobaba, delante del cliente, sobre una cita que ya
--    estaba bloqueada.
--
--    Se re-chequea AL APROBAR en vez de invalidar las citas al revocar, y no por comodidad:
--     · Es la decisión que este mismo guard ya tomó para las decisiones en revisión
--       («resetear tiraría trabajo que quizá sigue en pie»). Los derechos son, además, lo
--       único que en este dominio va y vuelve: un consentimiento se retira y se vuelve a
--       firmar. Borrar la curaduría del checklist en cada vaivén destruiría juicio humano
--       por una condición reversible.
--     · Aprobar el gate es el acto que pone la cita delante del cliente. Ahí es donde el
--       predicado tiene que ser cierto, y ahí es donde el operador puede repararlo
--       (reconceder, o re-marcar el ítem con otro objeto) sin rehacer el checklist entero.
--     · Y por permisos: revocar lo hacen lead-boutique y admin-cliente, y admin-cliente NO
--       tiene política ni grant para escribir `checklist_item`. Invalidar al revocar exigiría
--       que un SECURITY DEFINER escribiera, en nombre de quien revoca, filas que esa persona
--       no puede tocar. Eso es contrabando de privilegio, justo lo que estas políticas evitan.

-- ── Guard ÚNICO para toda superficie que fije una evidencia citada ──
-- Una sola función y un trigger por tabla: mientras la regla estuvo escrita en un guard
-- con nombre de tabla, «añadir la tabla siguiente» significó reescribirla, y por eso faltó.
-- Trabaja sobre `to_jsonb(new)` a propósito: plpgsql resuelve TODAS las referencias a
-- campos de una expresión aunque la rama no se ejecute, así que un guard compartido que
-- nombrara `new.evidencia_id` reventaría el día que se cuelgue de una tabla que llame a esa
-- columna de otra forma. Con jsonb, una tabla sin la columna simplemente no bloquea nada.
--
-- Ámbito «cliente» porque las dos superficies son de cara al cliente: el gate se aprueba en
-- el portal y la cita viaja en el paquete entregable.
create function evidencia_citable_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_fila jsonb := to_jsonb(new);
  v_evidencia uuid := (v_fila->>'evidencia_id')::uuid;
  v_ws uuid := (v_fila->>'workspace_id')::uuid;
begin
  if v_evidencia is null then
    return new;
  end if;
  -- Anti-oráculo: para quien no es miembro no hay nada que informar; la política ya
  -- rechaza la escritura.
  if not is_workspace_member(app_user_id(), v_ws) then
    return new;
  end if;
  if not evidencia_usable(v_evidencia, v_ws, 'cliente') then
    raise exception 'No puedes citar esta evidencia: %',
      coalesce(evidencia_motivo_bloqueo(v_evidencia, v_ws, 'cliente'),
               'derechos insuficientes')
      using errcode = 'DR001';
  end if;
  return new;
end $$;

-- El guard con nombre de tabla se retira: su regla es ahora la compartida, palabra por
-- palabra (mismo errcode DR001 y mismo mensaje, que el servicio ya traduce).
drop trigger checklist_item_derechos on checklist_item;
drop function checklist_item_derechos_guard();

create trigger evidencia_citable
  before insert or update on checklist_item
  for each row execute function evidencia_citable_guard();

-- La superficie que faltaba. `cita.evidencia_id` es NOT NULL, así que aquí el guard
-- siempre decide.
create trigger evidencia_citable
  before insert or update on cita
  for each row execute function evidencia_citable_guard();

revoke execute on function evidencia_citable_guard() from public;

-- FUERA a propósito, y conviene dejarlo escrito para que no parezca un olvido:
--  · `contradiccion` — RF-03.9: la contradicción se registra y se muestra SIEMPRE, jamás
--    bloquea ni se oculta, y la puede levantar cualquier miembro (que un stakeholder diga
--    «esto no cuadra» es el punto del portal). Bloquear el registro de que una evidencia
--    contradice un insight sería suprimir justo el descubrimiento incómodo que la spec
--    protege. Lo que no puede es SALIR en el entregable, y de eso ya se encarga la poda.
--  · `arquetipo_evidencia` — apoyo del razonamiento interno de la boutique: no copia
--    contenido y no se publica (la poda del entregable lo filtra). Bloquear su creación
--    frenaría trabajo interno sobre material que puede tener derechos internos.

-- ── El gate re-valida los derechos de lo que ya está cumplido ──
-- Se parte de la versión VIVA del guard (la de 20260902080000, que ya sumó las decisiones
-- en revisión sobre la de 20260902070000) y se AÑADE: reescribirlo de memoria perdería en
-- silencio cualquiera de los chequeos anteriores.
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bloqueo text;
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
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
    -- Mismo razonamiento, aplicado a los DERECHOS: se conceden y se revocan, y un ítem
    -- cumplido no se entera porque nada lo actualiza. Aprobar es el acto que pone la cita
    -- delante del cliente, así que es aquí donde el predicado tiene que volver a ser
    -- cierto. El mensaje nombra la dimensión que falta (SYS-14 exige explicar el bloqueo).
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
    -- Y por la vía indirecta: un ítem cumplido con un INSIGHT cuyo respaldo perdió los
    -- derechos. El predicado es EXACTAMENTE el de `insight_validar_guard` —toda afirmación
    -- no marcada como hipótesis necesita al menos una cita— re-evaluado con derechos vivos.
    -- No basta con «alguna cita sin derechos»: una afirmación con dos citas sigue sostenida
    -- si a una le quedan derechos, y exigir más sería más estricto que la propia validación.
    -- No se sigue la cadena hasta las decisiones: ese eslabón ya tiene su propio re-chequeo
    -- (estado 'en-revision') y su propia maquinaria de reapertura.
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
    update etapa_instancia set estado = 'completada'
      where proyecto_id = new.proyecto_id and workspace_id = new.workspace_id
        and numero = new.numero;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'GateAprobado',
        jsonb_build_object('gateId', new.id, 'proyectoId', new.proyecto_id,
                           'numero', new.numero),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ── Rastro de lo que ya existía citando evidencia sin derechos ──
-- Las citas creadas antes de este guard no se borran (reescribiría juicio humano ya
-- emitido) pero se registran para que el operador conceda derechos o retire la cita.
-- En una base fresca es un no-op.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select c.workspace_id, 'CitaSinDerechosDetectada',
       jsonb_build_object('citaId', c.id, 'afirmacionId', c.afirmacion_id,
                          'evidenciaId', c.evidencia_id,
                          'motivo', evidencia_motivo_bloqueo(c.evidencia_id, c.workspace_id, 'cliente')),
       null, null
from cita c
where not evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente');
