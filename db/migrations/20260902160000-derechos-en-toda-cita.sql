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
--
-- CUIDADO AL COMPONER RAMAS. Este `create or replace` sustituye el guard ENTERO, así que
-- en una base limpia gana la migración de número más alto y las reglas que otras ramas
-- hubieran añadido a este mismo guard desaparecen sin decir nada. «La versión viva» es la
-- de la base contra la que se escribió esta migración, no la de `agents` de mañana: si al
-- integrar aparece otra rama que también reemplaza este guard, hay que volver a copiar la
-- definición vigente —la de la migración más reciente que lo defina— y volver a añadir
-- encima los dos chequeos de derechos de aquí, comprobando además que las tablas que esas
-- reglas consultan ya existan (plpgsql no resuelve los nombres al crear la función: si
-- falta una tabla, la función se crea igual y revienta al aprobar un gate).
--
-- La raíz es que cada migración copia el guard completo. Un guard que delegara en una
-- función por regla —cada rama definiendo la suya sin tocar el tronco— haría imposible
-- este fallo; queda anotado como refactor posterior, no se hace aquí porque tocaría a
-- todas las ramas en vuelo.
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
