-- RF-03.10 / SYS-14 — LA PROCEDENCIA DEL SEMBRADO TIENE QUE SER INFALSIFICABLE, NO SOLO
-- DIFÍCIL DE FALSIFICAR.
--
-- El seed repara los derechos de la cadena de demo en bases sembradas por versiones
-- anteriores, y para eso necesita saber QUÉ evidencia creó él. La versión anterior dedujo
-- esa procedencia de la forma de la base (el recorrido desde `proyecto.codigo = 'P-01'`) y
-- adoptaba lo que encontrara; la siguiente la escribió como un evento `CadenaDemoSembrada`
-- en `evento_dominio` y concedía solo a esos ids. Mejor, y todavía mal: la política
-- `evento_insert` autoriza a **cualquier miembro** del workspace a escribir eventos, con
-- cualquier tipo y cualquier payload.
--
-- Y ahí está el fallo, que no es de auditoría sino de PRIVILEGIO. Conceder derechos es un
-- acto reservado (lead-boutique y admin-cliente: `derecho_update_decision`). Escribir un
-- evento no lo es. Un stakeholder —o cualquier miembro del lado cliente que no puede
-- conceder nada— podía escribir un registro de procedencia con los ids que él eligiera y
-- esperar a la siguiente corrida del seed: se le concederían derechos de ámbito CLIENTE,
-- a nombre de Lucía y con la base contractual del seed, sobre evidencia suya. Es una
-- escalada de privilegio con dos pasos y una espera, no una travesura.
--
-- No sirve razonar sobre quién mentiría. El marcador tiene que vivir donde el rol de
-- aplicación NO ESCRIBE, y entonces la ausencia de otra mano es estructural — la misma
-- forma que `metric_registry.firmado_en`, `design_version.aprobada_en` o
-- `reto.veredicto`, que están fuera del grant justamente para eso.
create table sembrado_registro (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  -- QUÉ sembró: una pieza por clave, para que dos piezas del seed no se pisen y para que
  -- «no hay registro de esta pieza» sea una pregunta con respuesta exacta.
  clave text not null,
  -- Los ids de lo que esa pieza creó. jsonb y no columnas fijas porque cada pieza registra
  -- lo suyo; quien lo lee valida la forma antes de usarla.
  payload jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now(),
  unique (workspace_id, clave)
);
comment on table sembrado_registro is
'Lo que el seed de desarrollo registra haber creado, para que reparar una base vieja sea exacto en vez de adivinado. Escribible SOLO por el propietario (sin grant de insert/update/delete para el rol de aplicación): es la propiedad que lo convierte en un sello y no en una afirmación.';

alter table sembrado_registro enable row level security;

-- SELECT sí, y por dos razones: SYS-04 exige que el archivo del propietario lleve TODOS
-- los objetos del workspace y la exportación corre bajo RLS con el rol de aplicación, así
-- que una tabla ilegible rompería la exportación entera; y no hay nada que proteger aquí
-- —son ids de material del propio workspace—. Lo que no existe, y es todo el punto, es
-- política ni grant de INSERT, UPDATE o DELETE: la aplicación no puede fabricar
-- procedencia ni retocarla.
create policy sembrado_registro_select on sembrado_registro
  for select using (is_workspace_member(app_user_id(), workspace_id));
grant select on sembrado_registro to designio_app;

-- ── Y NO se migra el marcador viejo ──
-- Copiar aquí los `CadenaDemoSembrada` que haya en `evento_dominio` sería meter en el
-- sitio infalsificable justo el dato que se declaró falsificable: el ataque de arriba
-- quedaría consumado por la migración. Una base sembrada con la versión anterior se queda
-- sin registro, que es el caso ya previsto — el seed no repara y deja su aviso nombrando
-- lo que habría tocado, para que un humano lo conceda si procede. Fallar cerrado también
-- cuando el que falla cerrado es el upgrade.
