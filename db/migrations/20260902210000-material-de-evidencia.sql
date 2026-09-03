-- RF-03.10 / SYS-14 — UNA definición de «quién puede recibir el material de una evidencia»,
-- aplicada a todas las superficies que lo entregan.
--
-- Las rondas anteriores cerraron superficies de una en una —la cita del checklist, la del
-- insight, la de la decisión, la del arquetipo, el adjunto— y cada ronda encontraba la
-- siguiente. La causa es que no había predicado: había cinco decisiones parecidas escritas
-- en cinco sitios. Aquí se escribe una vez y se aplica al conjunto, para que la próxima
-- tabla que guarde material lo herede en vez de necesitar otra ronda.
--
-- LA LÍNEA, explícita, porque es lo que decide qué se cierra y qué no:
--
--   · La IDENTIDAD de una evidencia es visible para todo miembro: su título, su resumen
--     curado, su fuente, su estado de derechos y el MOTIVO por el que está bloqueada. Tiene
--     que serlo, porque SYS-14 exige bloquear *explicando* y no se puede explicar un
--     bloqueo sin nombrar lo bloqueado. Por eso `evidencia`, `fuente` y `derecho_uso`
--     siguen con RLS de membresía, a propósito.
--   · El MATERIAL —los bytes del original y el texto copiado literalmente de él— solo llega
--     a quien tiene derecho a ese uso. Eso es lo que este predicado gobierna.
--
-- Superficies de MATERIAL en el esquema, recorridas una por una:
--   · `archivo_importado.contenido`  — los bytes del original. Cerrada en 20260902190000;
--     aquí solo se reescribe la política para que use el predicado común en vez de repetirlo.
--   · `item_importacion.contenido`   — el texto pegado, que es el mismo material por la otra
--     vía de ingesta. ABIERTA hasta ahora. Pegar la transcripción de una entrevista es tan
--     común como adjuntarla, así que cerrar el adjunto y dejar esto abierto convertía la
--     promesa del slice en media promesa — y peor: en una que parece entera.
--   · `cita.fragmento` / `cita.localizacion` — texto copiado literalmente del original para
--     que la lista sea legible sin abrir la evidencia. La ESCRITURA ya estaba guardada; la
--     LECTURA era de membresía, así que un fragmento citado antes de revocar los derechos
--     seguía siendo legible por todo el workspace.
--
-- Descartadas tras mirarlas, con su motivo:
--   · `contradiccion.descripcion` — la escribe quien detecta la contradicción («en sucursal
--     el abandono es del 20%»), no se copia del original. Y RF-03.9 exige que se vea
--     siempre: es lo contrario de un secreto.
--   · `arquetipo.definicion` / `veredicto_razon` — juicio del curador, no material.
--   · `evidencia.titulo` / `resumen`, `fuente.titulo` / `referencia`,
--     `item_importacion.titulo` / `referencia` — identidad y procedencia, no contenido; ver
--     la línea de arriba. Cerrarlas rompería la explicación del bloqueo.
--   · `evidencia.dimensiones` — la declaración de curaduría (cómo se recogió, con qué
--     confianza), no el material.
--   · `evento_dominio.payload` — ya tiene su propia RLS por rol (RF-01.6) y no lleva
--     fragmentos.
--   · Exportación ámbito `archivo` — lleva todo a propósito (SYS-04, «es su dato y su
--     derecho») y solo la ejecutan lead-boutique y admin-cliente, que son justamente los
--     roles a los que el predicado da acceso al material.

-- ── El predicado ──
-- Quién recibe el material de una evidencia:
--  · la boutique que la cura (lead-boutique, disenador) — es lo que autoriza el ámbito
--    `interno`, y sin ello no se puede curar;
--  · admin-cliente, que administra los datos del cliente (RF-01.4) y ejerce el derecho de
--    exportar el archivo completo (SYS-04);
--  · cualquier miembro si la evidencia tiene derechos vigentes para el ámbito `cliente`.
-- Si `p_evidencia` es null —material aún sin curar— no hay derechos que consultar y solo
-- quedan los dos primeros grupos. No es un caso especial: es la misma regla evaluada sobre
-- una evidencia que todavía no existe.
create function material_evidencia_visible(p_evidencia uuid, p_ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$
  select is_workspace_member(app_user_id(), p_ws)
    and (
      workspace_role(app_user_id(), p_ws) in ('lead-boutique', 'disenador', 'admin-cliente')
      or (p_evidencia is not null and evidencia_usable(p_evidencia, p_ws, 'cliente'))
    )
$$;
comment on function material_evidencia_visible(uuid, uuid) is
  'RF-03.10: única definición de quién puede recibir el MATERIAL de una evidencia (bytes originales y texto copiado de ellos). La identidad de la evidencia —título, resumen, motivo de bloqueo— es visible para todo miembro, porque SYS-14 exige explicar el bloqueo.';

-- El adjunto cuelga del ITEM, así que su evidencia se resuelve saltando por él. Va en una
-- función SECURITY DEFINER y no en un `exists` dentro de la política porque una subconsulta
-- en política aplica la RLS de la tabla consultada: al restringir `item_importacion` abajo,
-- la política del adjunto habría dependido de si el lector ve además la fila del item.
create function material_item_visible(p_item uuid, p_ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$
  select material_evidencia_visible(
    (select i.evidencia_id from item_importacion i where i.id = p_item and i.workspace_id = p_ws),
    p_ws)
$$;

revoke execute on function material_evidencia_visible(uuid, uuid),
  material_item_visible(uuid, uuid) from public;
grant execute on function material_evidencia_visible(uuid, uuid),
  material_item_visible(uuid, uuid) to designio_app;

-- ── Las tres superficies, bajo el mismo predicado ──
-- Quien aportó el material lo sigue viendo siempre: contribuir y no poder releer lo propio
-- convierte el portal en un buzón sin tapa, y es la vía por la que aporta un stakeholder.
-- La membresía envuelve TODO, incluida la cláusula del autor: `creado_por = app_user_id()`
-- por sí sola no menciona el workspace, así que sin el envoltorio alcanzaría material de un
-- tenant del que quien lo subió ya no forma parte. El aislamiento (SYS-01/02) es la
-- condición previa, no una de las alternativas.
drop policy archivo_select on archivo_importado;
create policy archivo_select on archivo_importado
  for select using (
    is_workspace_member(app_user_id(), workspace_id)
    and (
      creado_por = app_user_id()
      or material_item_visible(item_id, workspace_id)
    )
  );

drop policy item_select on item_importacion;
create policy item_select on item_importacion
  for select using (
    is_workspace_member(app_user_id(), workspace_id)
    and (
      creado_por = app_user_id()
      or material_evidencia_visible(evidencia_id, workspace_id)
    )
  );

drop policy cita_select on cita;
create policy cita_select on cita
  for select using (material_evidencia_visible(evidencia_id, workspace_id));

-- ── El sello de la decisión de derechos lo pone la base, no el caller ──
-- `decidido_en` estaba en el grant de UPDATE y el servicio lo escribía a mano, así que un
-- UPDATE directo podía retro o post-datar cuándo se concedieron unos derechos — el mismo
-- fallo que ya se corrigió en otros slices sacando la columna del grant en vez de
-- defenderla con un trigger. El guard de transición lo fija (`new.decidido_en := now()`),
-- que es la única forma de que valga también para el SQL crudo.
revoke update (decidido_en) on derecho_uso from designio_app;
