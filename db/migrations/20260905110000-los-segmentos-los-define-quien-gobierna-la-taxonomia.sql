-- ── Los segmentos los define quien gobierna la taxonomía ──
--
-- `segmento` es de las primeras tablas del esquema y su política `segmento_todo` era de
-- membresía a secas: cualquier miembro podía insertar, actualizar —incluido `workspace_id`,
-- es decir, sacar un segmento de su workspace— y borrar. Mientras no hubo pantalla, la única
-- escritura era el seed y la regla no hacía falta. Con la pantalla de segmentos (RF-01.7) la
-- regla de negocio quedó en TypeScript: solo el lead de la boutique y el admin del cliente
-- reescriben la taxonomía con la que el cliente mide. Una regla que solo vive en la app no es
-- capa 2, es capa única: las server functions son invocables directo y el rol de aplicación
-- podía seguir haciendo por SQL lo que la app negaba. La autoridad tiene que ser la política
-- de la base, como hizo el alta de servicios (`servicio_insert`).
--
-- Se abre la superficie MÍNIMA: lectura para cualquier miembro (los segmentos se referencian
-- desde arquetipos, evidencia y métricas, y eso lo hace todo el mundo); INSERT y UPDATE para
-- quienes gobiernan la taxonomía; sin DELETE para nadie del rol de aplicación. Un segmento lo
-- citan evidencia congelada y arquetipos con veredicto, y las FKs compuestas ya impedían
-- borrarlo con referencias; ahora tampoco se borra sin ellas, porque un eje de medición que
-- desaparece deja las series históricas sin nombre. Cuando haga falta retirar uno, llegará
-- con su propia regla (archivar, no borrar).

drop policy segmento_todo on segmento;

create policy segmento_select on segmento
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy segmento_insert on segmento
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'admin-cliente')
  );

-- USING y WITH CHECK con la misma condición: quien no gobierna la taxonomía no ve filas que
-- actualizar (0 filas, sin filtrar existencia), y quien sí, no puede dejar la fila en un
-- estado que no podría haber creado.
create policy segmento_update on segmento
  for update
  using (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'admin-cliente'))
  with check (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'admin-cliente'));

-- Solo las columnas que la app escribe: `id` y `creado_en` los pone la base (la pantalla
-- ordena por esa fecha), y `workspace_id` no se toca nunca después del alta —moverlo era la
-- puerta de extracción que la congelación por disposición tuvo que cerrar a mano—. Al
-- editar solo entran nombre y definición: la identidad es el id, y de él cuelgan las citas.
revoke insert, update, delete on segmento from designio_app;
grant insert (workspace_id, nombre, definicion) on segmento to designio_app;
grant update (nombre, definicion) on segmento to designio_app;

-- La pantalla lee la cobertura POR SEGMENTO —qué arquetipos lo mapean— y `arquetipo_segmento`
-- solo tenía la PK (arquetipo_id, segmento_id): cada segmento recorría la tabla entera.
-- Espejo de `evidencia_segmento_seg_idx`, que ya existía para la otra n:m.
create index arquetipo_segmento_seg_idx on arquetipo_segmento (workspace_id, segmento_id);
