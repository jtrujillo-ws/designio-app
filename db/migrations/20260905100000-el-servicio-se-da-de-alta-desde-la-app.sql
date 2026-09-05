-- ── El servicio se da de alta desde la app ──
--
-- El árbol nace en el servicio (ADR-0002: comprador organización, servicio primero) y
-- hasta hoy solo el seed podía crear uno: la app proyectaba servicios que nadie podía dar
-- de alta, y un workspace nuevo se quedaba en «Sin servicios aún» sin ninguna puerta para
-- dejar de estarlo. La pantalla Loop anuncia la fila «+ Nuevo servicio» (handoff 3a), y una
-- fila que no abre nada es exactamente lo que este repositorio no pinta.
--
-- Se abre la superficie MÍNIMA: INSERT, para quienes arrancan el engagement —el lead de la
-- boutique, que opera el workspace, y el admin del cliente, que es dueño de sus datos
-- (J1 «arranque en frío»: lead + admin cliente)—, siempre como 'activo' y firmado por quien
-- lo crea. Sin UPDATE ni DELETE: renombrar o archivar un servicio arrastra retos anclados y
-- estado efectivo, y esas reglas llegan con su propia migración cuando existan.

create policy servicio_insert on servicio
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'admin-cliente')
    and creado_por = app_user_id()
    and estado = 'activo'
  );

grant insert on servicio to designio_app;
