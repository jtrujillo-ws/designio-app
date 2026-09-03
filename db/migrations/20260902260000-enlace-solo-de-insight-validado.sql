-- SPEC-04.9 / RF-03.10 — LA CADENA DE UNA DECISIÓN SE HACE DE INSIGHTS VALIDADOS, Y ESO
-- TIENE QUE DECIRLO LA BASE.
--
-- La migración anterior (250000) dejó escrita una nota que era FALSA, y esta la corrige
-- además de arreglar el fondo. Decía que enlazar un insight sin validar «falla cerrado»
-- porque un insight sin validar no tendría citas con derechos vigentes. Es exactamente al
-- revés, y lo desmiente `cita_insert` (20260902080000):
--
--   and exists (select 1 from afirmacion a
--     join insight i on i.id = a.insight_id ...
--     where ... and i.estado = 'propuesto')
--
-- Las citas SOLO se pueden crear con el insight en `propuesto`. O sea que `propuesto` no
-- es el estado en el que no hay citas: es precisamente el estado en el que se crean. Un
-- insight `propuesto`, bien citado y con derechos vigentes, atraviesa entero el
-- re-chequeo de derechos del guard del gate —que exige «alguna cita con derechos
-- vigentes» por afirmación, y la hay— y el gate se aprueba.
--
-- Comprobado sobre una base viva antes de escribir esto, por SQL crudo con el rol de
-- aplicación y un lead-boutique: `insert into decision_insight` de un insight `propuesto`
-- → `update checklist_item set estado='cumplido', decision_id=…` → `update gate_instancia
-- set estado='aprobado'`. Resultado: gate APROBADO sobre un insight que nunca pasó
-- `insight_validar_guard`, es decir que nunca cumplió la barra de suficiencia (toda
-- afirmación no marcada como hipótesis exige al menos una cita) que la validación impone.
-- Nada más lo frenaba: la política solo miraba el rol, y la comprobación de «decisiones en
-- revisión» mira `decision.estado`, no el del insight.
--
-- ═══ POR QUÉ EN LA POLÍTICA Y NO EN UN TRIGGER ═══
-- El bypass que hay que cerrar es el del ROL DE APLICACIÓN escribiendo SQL directo: el
-- filtro `estado = 'validado'` vivía solo en el CTE de `registrarDecision`, y un espejo
-- copiado a mano en el servicio no es una regla de la base. La política cubre exactamente
-- a ese escritor, y es además donde viven sus dos reglas hermanas del mismo dominio —
-- `cita_insert` («solo con el insight propuesto») y `decision_insert` («nace vigente»)—,
-- así que la regla queda donde alguien la va a buscar.
--
-- Lo que esto NO cubre, dicho sin adornos: el PROPIETARIO no pasa por políticas. Las
-- migraciones y el seed pueden escribir el enlace que quieran. Es la misma exención que
-- tienen todas las políticas de este esquema y la misma que hace que el seed pueda sembrar
-- la cadena de demo; no es un agujero abierto a un usuario, es la definición de quién
-- administra la base.
--
-- El trigger `decision_insight_candado` de 250000 NO se toca: sigue siendo solo el candado,
-- sin reglas de dominio dentro. Son dos cosas distintas sobre la misma escritura —cuándo
-- puede ocurrir y con qué puede ocurrir— y mezclarlas habría hecho ilegibles las dos.
alter policy decision_insight_insert on decision_insight
  with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    -- La cadena de una decisión se hace de insights VALIDADOS: uno `propuesto` no ha
    -- pasado la barra de suficiencia de `insight_validar_guard`, así que apoyar en él una
    -- decisión —y, a través de ella, la aprobación de un gate— es trazabilidad de mentira.
    and exists (select 1 from insight i
      where i.id = decision_insight.insight_id
        and i.workspace_id = decision_insight.workspace_id
        and i.estado = 'validado')
  );

-- Enlaces YA existentes hacia insights sin validar: no se borran —sería reescribir una
-- decisión humana, y la traza de por qué se decidió algo es justo lo que no se toca— pero
-- quedan registrados para que el operador los resuelva (validando el insight o rehaciendo
-- la decisión). Misma disciplina que `CitaSinDerechosDetectada` en 20260902140000.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select di.workspace_id, 'DecisionConInsightSinValidarDetectada',
       jsonb_build_object('decisionId', di.decision_id, 'insightId', di.insight_id,
                          'estadoInsight', i.estado),
       null, null
from decision_insight di
join insight i on i.id = di.insight_id and i.workspace_id = di.workspace_id
where i.estado <> 'validado';
