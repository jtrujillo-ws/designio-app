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
-- Copia ÍNTEGRA de la versión viva (20260902190000) más una rama. Ver la advertencia sobre
-- composición de ramas en 20260902160000.
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bloqueo text;
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
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
