-- RF-03.10 — cierre de los dos ejes que quedaban: dónde se ENLAZA una evidencia y cuándo
-- se RE-COMPRUEBA. La regla es la misma de siempre; lo que faltaba era recorrerla entera
-- en vez de tabla a tabla según iban apareciendo.
--
-- ═══ EJE ENLACE: ¿a qué se puede atar una evidencia bloqueada? ═══
-- Inventario COMPLETO, sacado de las columnas reales: las nueve tablas con `evidencia_id`.
--
-- Con el guard común (`evidencia_citable_guard`, ámbito «cliente»):
--   · checklist_item        — el ítem de gate; se aprueba en el portal.
--   · cita                  — copia el fragmento del original y valida el insight.
--   · arquetipo_evidencia   — respaldo probatorio: confirmar exige enlace y G2 lo consume.
--   · journey_nodo_evidencia — ESTA es la que faltaba, y se le cuelga aquí. Su política
--     solo miraba el rol de curador, así que un paso del journey podía quedar «sostenido»
--     por evidencia denegada: satisface la validación `paso-sin-evidencia` y se congela en
--     un `journey_snapshot`, que es un artefacto que va al cliente. Mismo papel que un ítem
--     de gate, misma regla.
--
-- FUERA del alcance, cada una con su motivo (esto es la otra mitad del inventario):
--   · contradiccion     — RF-03.9: se registra y se muestra SIEMPRE, la levanta cualquier
--     miembro, y jamás bloquea. Impedir señalar que una evidencia contradice un insight
--     por falta de derechos de publicación suprimiría el descubrimiento incómodo que la
--     spec protege. Su lectura tampoco se restringe: la descripción la escribe quien
--     detecta, no se copia del original.
--   · derecho_uso       — ES el registro de derechos. Guardarlo contra sí mismo no tiene
--     sentido: su propia política ya decide quién concede y quién revoca.
--   · evidencia_segmento — parte de la DEFINICIÓN de la evidencia (sus cinco dimensiones),
--     escrita por `aprobarItem` en la misma transacción que la crea, cuando los derechos
--     todavía nacen `pendiente`. Guardarla haría imposible curar: el guard rechazaría el
--     acto que produce la evidencia. No es un uso aguas abajo, es el alta.
--   · item_importacion  — su `evidencia_id` es el SELLO de la curaduría, el mismo acto de
--     alta por el otro extremo. Mismo argumento.
--   · hilo_comentario   — conversación SOBRE la evidencia, no uso de su material. Poder
--     abrir un hilo sobre una evidencia bloqueada es justamente cómo se discute y se
--     resuelve el bloqueo en el portal; cerrarlo dejaría el bloqueo sin superficie donde
--     tratarse. No lleva fragmentos: el comentario es texto propio de quien lo escribe.
--
-- ═══ EJE TIEMPO: ¿y cuando los derechos se revocan DESPUÉS del enlace? ═══
-- Un trigger de enlace comprueba al escribir y no vuelve a correr nunca. Lo que consume el
-- enlace más tarde tiene que re-comprobar por su cuenta. Recorrido lo que un gate consume
-- como respaldo:
--   · ítem cumplido con evidencia   — re-comprobado (20260902160000).
--   · ítem cumplido con insight     — re-comprobado transitivamente hasta sus citas (idem).
--   · ítem cumplido con decisión    — re-comprobado hasta los insights que la trazan
--     (20260902190000).
--   · arquetipo confirmado en G2    — NO se re-comprobaba, y es lo que se corrige abajo.
--     `arquetipo_veredicto_guard` exige evidencia enlazada para confirmar, y el guard de
--     suficiencia exige que no queden hipótesis en G2 — pero entre confirmar y aprobar
--     pueden revocarse los derechos, y entonces G2 pasaba sobre un perfil sostenido por
--     evidencia que ya no sirve. Es el mismo predicado del veredicto re-evaluado con
--     derechos vivos, igual que se hizo con la validación del insight.
--   · criterios de G0 y orden de gates — no consumen evidencia; nada que re-comprobar.

create trigger evidencia_citable
  before insert or update on journey_nodo_evidencia
  for each row execute function evidencia_citable_guard();

-- Enlaces de journey que ya existan sobre evidencia sin derechos: no se borran (sería
-- reescribir el mapa del servicio), quedan registrados. Predicado INLINE porque una
-- migración corre como propietario y `evidencia_usable` exige membresía desde 190000.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select ne.workspace_id, 'JourneyNodoConEvidenciaSinDerechos',
       jsonb_build_object('nodoId', ne.nodo_id, 'evidenciaId', ne.evidencia_id,
                          'estadoDerechos', coalesce(d.estado, 'sin registro')),
       null, null
from journey_nodo_evidencia ne
left join derecho_uso d
  on d.evidencia_id = ne.evidencia_id and d.workspace_id = ne.workspace_id
where d.evidencia_id is null
   or d.estado <> 'concedido'
   or d.ambito not in ('cliente', 'publico')
   or (d.vence_en is not null and d.vence_en < current_date);

-- ── El gate re-comprueba también el respaldo del arquetipo ──
-- Copia ÍNTEGRA de la versión viva (20260902190000, que a su vez copia entero el cuerpo
-- de 20260902120000) más una rama. Ver la advertencia sobre
-- composición de ramas en 20260902160000.
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
