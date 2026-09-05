-- ── CT: el asistente de gates, que INFORMA y no aprueba (RF-08.4, SPEC-08 §30) ──
--
-- La primera capacidad INFORMATIVA del pipeline, y por eso trae más esquema que declaración.
-- Las dos que había —CI y C0— terminan escribiendo un objeto del dominio, y el esquema
-- estaba escrito dando eso por hecho: `propuesta_ai.destino` era `not null` y toda la
-- gramática de la tabla colgaba de él.
--
-- CT no escribe nada. Lee el checklist de un gate y los objetos del proyecto y dice QUÉ
-- FALTA, citando dónde lo miró. RF-08.4 lo dice sin rodeos: «CT es informativo: reporta
-- huecos citando objetos; CARECE de acción "aprobar"». Un gate lo aprueba una persona con
-- su rol (SYS-18); que un asistente pudiera «aceptarse» a sí mismo hasta un objeto sería
-- justo la escritura AI directa que SYS-19 prohíbe.
--
-- ── Lo que cambia y por qué ──
--
-- 1. Un ANCLA NUEVA, `gate_id`. Las tres tablas del pipeline la llevan, con FK compuesta a
--    `gate_instancia (id, workspace_id)` como el resto del esquema: una FK simple a `id`
--    dejaba el cruce de tenants abierto.
--
-- 2. `destino` pasa a ANULABLE, y `null` significa «no materializa». No es aflojar: es que
--    la ausencia sea REPRESENTABLE, la misma distinción que sostiene el `null` de
--    `llamada_ai.consentimiento_version`. Sin ella, CT tendría que elegir un destino
--    materializable y la revisión guardaría un id que no significa nada.
--
-- 3. Los CHECK que ataban destino con ancla y con objeto se rehacen para admitir el caso
--    sin objeto SIN abrir ninguno de los que ya cerraban. Ese es el trabajo fino y va
--    explicado uno a uno abajo, porque `null` en SQL no es `false`: una comparación con
--    `null` da `null`, y un CHECK que da `null` PASA. Hacer `destino` anulable convierte en
--    sospechoso todo CHECK que lo compare con un literal, y son cinco. Los cinco pasan a
--    `is not distinct from` / `is distinct from`, pero NO los cinco por el mismo motivo, y la
--    diferencia está medida fila a fila contra la tabla real (no sobre una tabla de juguete,
--    que fue mi primer intento y me dio una respuesta que el conjunto entero desmiente):
--
--    · Los DOS de «objeto ⇒ destino» sostienen de verdad, y son los que hacen falta. Medido:
--      una propuesta INFORMATIVA sellada como 'aceptada' con un `evidencia_id` —justo lo que
--      RF-08.4 prohíbe— pasaba el CHECK viejo entero. Con `is not distinct from` la rechaza
--      «propuesta_ai_objeto_evidencia».
--    · Los DOS de «capacidad ⇒ destino» SÍ disparan —Postgres nombra a
--      «propuesta_ai_destino_ci» cuando una CI llega sin destino—, pero no son el ÚNICO corte
--      de ninguna fila: toda la que los viola la rechazan también
--      «propuesta_ai_destino_informativo» (sin destino ⇒ ancla de gate) o
--      «propuesta_ai_ancla_ct» (ancla de gate ⇒ capacidad CT). Cuál de las dos se nombra
--      depende del orden en que el motor las evalúe, que no es cosa nuestra. Se reescriben
--      igual, y la razón es honesta y menor: que digan a propósito lo que hoy aciertan por
--      accidente. Un CHECK que acierta devolviendo `null` deja de acertar en cuanto cambia
--      cualquiera de sus vecinos.
--    · El de SYS-20 tampoco era un agujero, y lleva su nota abajo porque medirlo desmintió
--      lo que yo esperaba.
--
-- Lo que NO cambia, y es lo que convierte a RF-08.4 en una imposibilidad y no en una regla:
--
--   check ((estado in ('aceptada','corregida')) = (coalesce(evidencia_id, criterio_id) is not null))
--
-- Ese CHECK ya estaba, y con `destino is null` no hay objeto que enlazar nunca, así que una
-- propuesta informativa NO PUEDE quedar 'aceptada' ni 'corregida'. La acción «aprobar» no
-- se le quita a CT en la pantalla: no existe para ella en la base. Su ciclo es 'propuesta'
-- → 'rechazada', que es «leída y descartada», y eso sigue exigiendo revisor y fecha.

-- ── 1. El ancla ──
alter table reserva_ai   add column gate_id uuid;
alter table llamada_ai   add column gate_id uuid;
alter table propuesta_ai add column gate_id uuid;

alter table reserva_ai   add foreign key (gate_id, workspace_id)
  references gate_instancia (id, workspace_id);
alter table llamada_ai   add foreign key (gate_id, workspace_id)
  references gate_instancia (id, workspace_id);
alter table propuesta_ai add foreign key (gate_id, workspace_id)
  references gate_instancia (id, workspace_id);

-- El ancla de CT, con la MISMA forma que las otras dos: una equivalencia por capacidad, no
-- una lista. Así cada capacidad añade la suya sin tocar las ajenas — que es lo que permite
-- que las cuatro ramas de la Fase 1 entren en paralelo.
alter table reserva_ai   add constraint reserva_ai_ancla_ct   check ((capacidad = 'CT') = (gate_id is not null));
alter table llamada_ai   add constraint llamada_ai_ancla_ct   check ((capacidad = 'CT') = (gate_id is not null));
alter table propuesta_ai add constraint propuesta_ai_ancla_ct check ((capacidad = 'CT') = (gate_id is not null));

-- El token de exclusión por ancla, como `reserva_ai_item_idx` y `reserva_ai_reto_idx`: dos
-- personas no pueden tener a la vez una generación en vuelo sobre el mismo gate, así que el
-- gasto duplicado se corta ANTES de llamar al proveedor.
create unique index reserva_ai_gate_idx on reserva_ai (workspace_id, gate_id)
  where gate_id is not null;

-- Y el suelo de la cola: un gate no acumula informes sin leer. El mismo índice parcial que
-- `propuesta_ai_item_pendiente_idx` — con 'propuesta' en el predicado, porque los informes
-- ya descartados no estorban al siguiente.
create unique index propuesta_ai_gate_pendiente_idx on propuesta_ai (workspace_id, gate_id)
  where gate_id is not null and estado = 'propuesta';

-- ── 2. El destino, ahora anulable ──
alter table propuesta_ai alter column destino drop not null;

-- ── 3. La gramática de destino ⇔ ancla ⇔ objeto, rehecha ──
--
-- Primero se sueltan los seis por su nombre generado. Van por nombre y no por un `do $$`
-- que los busque: si mañana alguien renombra uno, esta migración tiene que FALLAR y que
-- alguien lo mire, no encontrar «cero coincidencias» y seguir en verde.
alter table propuesta_ai drop constraint propuesta_ai_check;    -- (destino='evidencia') = (item_id is not null)
alter table propuesta_ai drop constraint propuesta_ai_check1;   -- (destino='criterio-exito') = (reto_id is not null)
alter table propuesta_ai drop constraint propuesta_ai_check2;   -- evidencia_id is null or destino='evidencia'
alter table propuesta_ai drop constraint propuesta_ai_check3;   -- criterio_id is null or destino='criterio-exito'
alter table propuesta_ai drop constraint propuesta_ai_check4;   -- capacidad<>'CI' or destino='evidencia'
alter table propuesta_ai drop constraint propuesta_ai_check5;   -- capacidad<>'C0' or destino='criterio-exito'
alter table propuesta_ai drop constraint propuesta_ai_check6;   -- not es_simulacion or destino<>'evidencia'

-- EXACTAMENTE un ancla. Antes lo decía el conjunto: con `destino` obligatorio y de dos
-- valores, las dos equivalencias de abajo ya forzaban una y solo una. Con un tercer ancla y
-- un destino que puede faltar, eso deja de deducirse y hay que escribirlo.
alter table propuesta_ai add constraint propuesta_ai_un_ancla
  check (num_nonnulls(item_id, reto_id, gate_id) = 1);

-- Destino ⇔ ancla. Las dos primeras se quedan como estaban: con `destino` nulo devuelven
-- `null` y no cierran nada, y no hace falta que cierren — de eso se encarga el CHECK de
-- arriba, que con `gate_id` puesto obliga a que las otras dos columnas estén vacías.
alter table propuesta_ai add constraint propuesta_ai_destino_evidencia
  check ((destino = 'evidencia') = (item_id is not null));
alter table propuesta_ai add constraint propuesta_ai_destino_criterio
  check ((destino = 'criterio-exito') = (reto_id is not null));
-- Y la de la ausencia, que es la que da sentido a las otras dos: sin destino ⇔ ancla de gate.
alter table propuesta_ai add constraint propuesta_ai_destino_informativo
  check ((destino is null) = (gate_id is not null));

-- Objeto ⇒ destino. ESTOS DOS son los que sostienen, y por eso van con su medición.
--
-- Con `destino = 'evidencia'` a secas y `destino` nulo, la expresión vale `null`, y
-- `evidencia_id is null or null` con `evidencia_id` PUESTO da `false or null` = `null`, que
-- PASA. Medido contra la tabla real, con la fila que de verdad importa —una propuesta
-- INFORMATIVA sellada como 'aceptada' con su revisor y un `evidencia_id`, que es exactamente
-- lo que RF-08.4 prohíbe—: con el CHECK viejo la tabla la aceptaba (el insert solo moría
-- después, en la FK, por ser un id inventado); con `is not distinct from` la rechaza aquí.
--
-- Ni siquiera el CHECK que ata `estado in ('aceptada','corregida')` con tener objeto la
-- paraba: esa fila TIENE objeto, y por eso lo cumple. Lo que había que decir es que el objeto
-- no puede ser de un destino que no existe.
alter table propuesta_ai add constraint propuesta_ai_objeto_evidencia
  check (evidencia_id is null or destino is not distinct from 'evidencia');
alter table propuesta_ai add constraint propuesta_ai_objeto_criterio
  check (criterio_id is null or destino is not distinct from 'criterio-exito');

-- Capacidad ⇒ destino, una por capacidad, aditivas. Las dos que había se reescriben con
-- `is not distinct from` para que digan a propósito lo que hoy aciertan por accidente: hoy
-- NINGUNA fila las necesita —los dos CHECK de arriba la rechazan antes— y aciertan porque un
-- CHECK que devuelve `null` pasa. Eso deja de ser cierto en cuanto cambie cualquiera de sus
-- vecinos, y un guardián que depende de sus vecinos no es un guardián.
--
-- Y la de CT: su destino es la AUSENCIA, y así queda dicho en la base y no solo en el
-- registro de la aplicación.
alter table propuesta_ai add constraint propuesta_ai_destino_ci
  check (capacidad <> 'CI' or destino is not distinct from 'evidencia');
alter table propuesta_ai add constraint propuesta_ai_destino_c0
  check (capacidad <> 'C0' or destino is not distinct from 'criterio-exito');
alter table propuesta_ai add constraint propuesta_ai_destino_ct
  check (capacidad <> 'CT' or destino is null);

-- SYS-20. Ésta es la excepción, y va dicha porque medirla desmintió lo que yo esperaba: NO
-- había hueco que cerrar. Con `destino` nulo, el viejo `destino <> 'evidencia'` da `null` y
-- pasa, y el nuevo `is distinct from` da `true` y también pasa — las dos aceptan una
-- simulación informativa, y aceptarla es lo correcto: SYS-20 prohíbe que una simulación se
-- MATERIALICE como evidencia, y una propuesta sin destino no materializa nada.
--
-- Se reescribe igual porque la forma vieja acertaba por accidente —un CHECK que devuelve
-- `null` pasa, y aquí eso coincidía con lo que queríamos— y la nueva lo dice a propósito:
-- `null is distinct from 'evidencia'` es `true` porque no es evidencia, no porque no se sepa.
alter table propuesta_ai add constraint propuesta_ai_simulacion_no_es_evidencia
  check (not es_simulacion or destino is distinct from 'evidencia');

-- ── Los grants: la columna nueva se escribe igual que las otras dos anclas ──
-- Sin esto la aplicación no puede poner `gate_id` y CT nace muerta: los grants de INSERT de
-- estas tres tablas van POR COLUMNA a propósito (dejan fuera `creado_en`, que es el reloj
-- del tope diario), así que una columna nueva no entra sola.
grant insert (gate_id) on reserva_ai   to designio_app;
grant insert (gate_id) on llamada_ai   to designio_app;
grant insert (gate_id) on propuesta_ai to designio_app;

-- ── El guard: un hueco señala un requisito DE ESTE GATE, o no entra ──
--
-- Cada hueco del informe apunta a un item del checklist por su id, y ése es el único campo
-- verificable que tiene: `queFalta` y `comoCerrarlo` son prosa y no se pueden contrastar
-- contra nada. Un id inventado —o el de otro gate— manda a quien lee el informe a buscar un
-- requisito que ahí no está, que es peor que no decir nada; y es exactamente la clase de
-- afirmación sin sostén que §21 prohíbe vender.
--
-- Va en la BASE y no en el servicio por lo mismo que el resto de guards de este esquema: el
-- servicio ya lo comprobaría en su camino, pero el camino no es el único —queda el SQL
-- directo—, y una regla que solo vive en la aplicación se salta por donde la aplicación no
-- pasa. Aquí no hay por dónde.
--
-- Comparado como TEXTO y no casteando a uuid: `(h->>'checklistItemId')::uuid` revienta con
-- un error de sintaxis, no con este mensaje, en cuanto alguien escriba cualquier cosa por
-- SQL directo. (`pg_input_is_valid` resolvería el casteo seguro, pero es de PG 16 y CI corre
-- PG 15.) En minúsculas porque el contrato de la aplicación admite un uuid en cualquier caja
-- y `id::text` sale siempre en minúscula.
create or replace function propuesta_ai_ct_huecos_guard() returns trigger
language plpgsql as $$
declare
  ajeno text;
begin
  if new.capacidad <> 'CT' then
    return new;
  end if;
  select h->>'checklistItemId' into ajeno
  from jsonb_array_elements(
         case when jsonb_typeof(new.contenido->'huecos') = 'array'
              then new.contenido->'huecos' else '[]'::jsonb end) h
  where not exists (
    select 1 from checklist_item c
    where c.id::text = lower(h->>'checklistItemId')
      and c.gate_id = new.gate_id
      and c.workspace_id = new.workspace_id)
  limit 1;
  if ajeno is not null then
    raise exception
      'un hueco del informe señala un requisito que no pertenece a este gate: %', ajeno;
  end if;
  return new;
end $$;

revoke execute on function propuesta_ai_ct_huecos_guard() from public;

-- En INSERT y en UPDATE del contenido. Hoy una propuesta informativa no se puede corregir
-- —no se acepta, y corregir es «editar y aceptar»—, así que el UPDATE es defensa en
-- profundidad: cubre el día que alguien abra un camino de edición sin acordarse de esto.
create trigger a_propuesta_ai_ct_huecos
  before insert or update of contenido on propuesta_ai
  for each row execute function propuesta_ai_ct_huecos_guard();
