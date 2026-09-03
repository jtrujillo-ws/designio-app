-- SYS-01/02 — LA FUNCIÓN QUE SACÓ EL PREDICADO SE CONVIRTIÓ EN UN ORÁCULO CON CONTENIDO.
--
-- `20260902350000` hizo lo correcto —sacar el predicado a una función de solo lectura para
-- que el guard y las pantallas compartan una sola redacción— y lo estropeó con una línea:
-- `grant execute … to designio_app` sobre la función CRUDA.
--
-- Medido, no deducido. Con el rol de aplicación y una identidad que NO es miembro del
-- workspace, pasando los ids como literales (la RLS solo esconde las filas si los ids se
-- LEEN de una tabla; el atacante los pasa a mano):
--
--   razonamiento_sin_respaldo(<ws ajeno>, array[<insight ajeno>], '{}', '{}')
--     → 'se apoya en la afirmación «62 de cada 100 solicitudes digitales se detienen al
--        cargar el documento», que ya no tiene ninguna cita con derechos vigentes — …'
--
-- Texto literal del contenido de otro workspace. Y no hace falta conocer un insight: con
-- cualquier `decision_id` sale lo mismo, porque el paso 3 alcanza las afirmaciones a través
-- de `decision_insight`.
--
-- ── Por qué, que es lo que hay que entender antes de arreglarlo ──
-- Dentro de una función `SECURITY DEFINER` cuyo propietario es el dueño de las tablas, la
-- RLS no se aplica (ninguna lleva `force row level security`). Y la puerta de membresía de
-- `evidencia_usable` aquí no protege: EMPEORA. Para un workspace ajeno devuelve falso en
-- toda cita, así que el `not exists (… evidencia_usable …)` es cierto para todas, la
-- afirmación se SELECCIONA, y la función devuelve su texto. El comentario que acompañaba al
-- grant decía «de un workspace ajeno devuelve el mismo null que devolvería si todo
-- estuviera en orden»: es exactamente al revés — devuelve SIEMPRE un motivo, y con
-- contenido dentro. Un comentario que afirma una propiedad que el código no tiene, otra vez.
--
-- ── El arreglo tiene la forma que esta rama ya usó dos veces ──
-- `derechos_vigentes` es la regla y `evidencia_usable` es la regla MÁS la puerta; la regla
-- va sin grant y la puerta es lo único que el rol de aplicación puede llamar. Aquí igual:
-- la función cruda pierde el grant y la llama solo el guard (que corre como propietario y
-- necesita ver todo), y encima va un envoltorio con la puerta anti-oráculo, que es el único
-- con grant y el que llaman las proyecciones.
--
-- Y la trampa que hay que esquivar, porque ya mordió en los backfills de `310000`: la
-- puerta NO puede ir en la función que llama el guard. El guard corre como propietario y
-- muchas veces sin `app.user_id`, así que `is_workspace_member(app_user_id(), …)` sería
-- falso siempre y el guard dejaría de comprobar nada mientras aparenta comprobarlo. Por eso
-- son dos funciones y no un `if` dentro de una.
-- Y se revoca de PUBLIC, no solo de `designio_app`. Postgres otorga EXECUTE a PUBLIC por
-- defecto sobre toda función nueva, y `20260902350000` añadió el grant sin quitar ese
-- default: quitarle el grant explícito al rol de aplicación lo habría dejado ejecutándola
-- igual, por PUBLIC. Comprobado — con solo el `revoke … from designio_app` la función
-- seguía devolviendo el texto ajeno. Es la misma disciplina que el resto del esquema
-- (`revoke execute … from public` sobre cada helper SECURITY DEFINER) y aquí faltó.
revoke execute on function razonamiento_sin_respaldo(uuid, uuid[], uuid[], uuid[])
  from public, designio_app;

create function razonamiento_sin_respaldo_visible(
  p_ws uuid,
  p_insights uuid[],
  p_decisiones uuid[],
  p_evidencias uuid[]
) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  -- Para quien no es miembro, la respuesta es la misma que si todo estuviera en orden:
  -- `null`. Indistinguible, que es el punto — un motivo distinto para «no eres miembro»
  -- volvería a ser un oráculo, solo que de existencia en vez de contenido.
  select case
    when is_workspace_member(app_user_id(), p_ws)
      then razonamiento_sin_respaldo(p_ws, p_insights, p_decisiones, p_evidencias)
  end
$$;
comment on function razonamiento_sin_respaldo_visible(uuid, uuid[], uuid[], uuid[]) is
'`razonamiento_sin_respaldo` MÁS la puerta anti-oráculo: para quien no es miembro del workspace devuelve null, indistinguible de «se puede consumir». Es la única de las dos que el rol de aplicación puede ejecutar, y la que llaman las proyecciones de los pickers; la cruda la llama el guard, que corre como propietario.';

revoke execute on function razonamiento_sin_respaldo_visible(uuid, uuid[], uuid[], uuid[])
  from public;
grant execute on function razonamiento_sin_respaldo_visible(uuid, uuid[], uuid[], uuid[])
  to designio_app;
