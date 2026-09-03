-- RF-03.10 / RF-05.8 — EJE TIEMPO, segunda superficie: CONGELAR también consume el enlace.
--
-- El barrido anterior (20260902220000) recorrió lo que un GATE consume como respaldo y
-- cerró el hueco del arquetipo. Pero el gate no es el único consumidor de un enlace de
-- evidencia: `congelarSnapshot` copia cada `journey_nodo_evidencia` —con el TÍTULO de su
-- evidencia— dentro de `journey_snapshot.grafo`, y ese registro es inmutable y lo lee todo
-- miembro (su política de SELECT es `is_workspace_member`). Un enlace creado con derechos
-- válidos y revocados antes de congelar no vuelve a pasar por el trigger de enlace: la
-- evidencia revocada seguía sosteniendo el paso dentro de un artefacto que ya no se puede
-- corregir. El barrido miró «qué consume un gate» cuando la pregunta era «qué consume un
-- ENLACE».
--
-- ═══ INVENTARIO DE CONSUMIDORES (la pregunta bien hecha) ═══
-- ¿Qué actos leen un enlace de evidencia DESPUÉS de que su trigger comprobó los derechos?
--
--   · aprobar un gate            — re-comprueba (160000, 190000, 220000): ítem con
--     evidencia, con insight, con decisión y arquetipo confirmado.
--   · congelar un snapshot       — NO re-comprobaba. Es lo que cierra esta migración.
--   · exportar el entregable     — no necesita trigger: la poda se evalúa contra
--     `evidencia_entregable` en la misma sentencia y en la misma foto `repeatable read`,
--     así que ya lee derechos VIVOS por construcción.
--
-- Y los dos que a primera vista parecen consumidores y NO lo son, que es la mitad del
-- inventario que suele quedarse sin escribir:
--   · validar un insight (`insight_validar_guard`) — exige ≥1 cita por afirmación no
--     hipótesis, pero no re-comprueba derechos, y es correcto: validar no copia material
--     nuevo (el `fragmento` lo copió la cita, bajo guard) y el insight validado es
--     razonamiento INTERNO. Todo consumo suyo de cara al cliente —el picker del checklist
--     y el guard de suficiencia— re-evalúa derechos vivos. Bloquear la validación
--     congelaría trabajo interno sobre material con derechos internos, que es exactamente
--     lo que el orden de ámbitos (`interno ⊂ cliente ⊂ publico`) existe para permitir.
--   · dar veredicto a un arquetipo (`arquetipo_veredicto_guard`) — mismo argumento, y su
--     re-chequeo ya vive donde el arquetipo se pone delante del cliente: G2 (220000).
--
-- La regla que queda escrita para el siguiente: si un acto FIJA o PUBLICA lo que un enlace
-- sostiene, re-comprueba; si solo razona internamente sobre él, no.

-- ── El snapshot se congela con derechos vivos, o no se congela ──
-- Se comprueban las DOS caras a propósito:
--   · el `grafo` que se está insertando —que es lo que queda inmutable—, para que un
--     INSERT a mano no pueda congelar un título de evidencia revocada aunque no toque
--     `journey_nodo_evidencia`; y
--   · los enlaces vivos del journey, que es el consumo que da nombre a este eje. Un
--     enlace bloqueado no se poda del snapshot en silencio (podar sería reescribir el mapa
--     del servicio y decir que el paso nunca tuvo respaldo): se rechaza congelar y el
--     operador decide — reconceder los derechos o desenlazar, que RF-05.9 ya permite.
create function journey_snapshot_derechos_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_evidencia uuid;
begin
  -- Anti-oráculo: para quien no es miembro no hay nada que informar; la política ya
  -- rechaza la escritura. `is_workspace_member(null, …)` es false, así que esto cierra
  -- además la sesión sin contexto RLS.
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  select ev into v_evidencia from (
    -- Lo que el grafo congela. El filtro por forma de uuid evita que un `grafo` con basura
    -- reviente en el cast: lo que no nombra una evidencia no hay derechos que comprobarle.
    select (e->>'evidenciaId')::uuid as ev
      from jsonb_array_elements(
             case when jsonb_typeof(new.grafo->'evidencias') = 'array'
                  then new.grafo->'evidencias' else '[]'::jsonb end) as e
      where e->>'evidenciaId' ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    union
    -- Lo que el journey tiene enlazado ahora mismo.
    select ne.evidencia_id
      from journey_nodo_evidencia ne
      join journey_nodo n on n.id = ne.nodo_id and n.workspace_id = ne.workspace_id
      where n.journey_id = new.journey_id and ne.workspace_id = new.workspace_id
  ) t
  where not evidencia_usable(ev, new.workspace_id, 'cliente')
  limit 1;
  if found then
    raise exception 'No puedes congelar este snapshot: un paso se apoya en evidencia sin derechos vigentes — %',
      coalesce(evidencia_motivo_bloqueo(v_evidencia, new.workspace_id, 'cliente'),
               'derechos insuficientes')
      using errcode = 'DR001';
  end if;
  return new;
end $$;

create trigger journey_snapshot_derechos
  before insert on journey_snapshot
  for each row execute function journey_snapshot_derechos_guard();

revoke execute on function journey_snapshot_derechos_guard() from public;

-- Snapshots YA congelados que llevan dentro evidencia sin derechos vigentes: son
-- inmutables por definición, así que no se tocan — se hacen visibles, que es la misma
-- disciplina de las migraciones anteriores (no se revierten decisiones humanas ya tomadas;
-- se registran para que el operador las resuelva). Predicado INLINE porque una migración
-- corre como propietario y `evidencia_usable` exige membresía desde 190000.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select s.workspace_id, 'JourneySnapshotConEvidenciaSinDerechos',
       jsonb_build_object('snapshotId', s.id, 'journeyId', s.journey_id,
                          'evidenciaId', ev.evidencia_id,
                          'estadoDerechos', coalesce(d.estado, 'sin registro')),
       null, null
from journey_snapshot s
cross join lateral (
  select distinct (e->>'evidenciaId')::uuid as evidencia_id
  from jsonb_array_elements(
         case when jsonb_typeof(s.grafo->'evidencias') = 'array'
              then s.grafo->'evidencias' else '[]'::jsonb end) as e
  where e->>'evidenciaId' ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
) ev
left join derecho_uso d
  on d.evidencia_id = ev.evidencia_id and d.workspace_id = s.workspace_id
where d.evidencia_id is null
   or d.estado <> 'concedido'
   or d.ambito not in ('cliente', 'publico')
   or (d.vence_en is not null and d.vence_en < current_date);
