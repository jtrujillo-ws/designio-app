-- ── C5: proponer cómo CERRAR las señales del grafo, no volver a buscarlas (SPEC-08 §30) ──
--
-- El ancla nueva es el JOURNEY, y la capacidad es informativa como CT: no toca el grafo. A
-- quien edita un journey se le propone qué hacer; lo hace una persona.
--
-- Por qué informativa y no «validación AI», que es como SPEC-08 nombra la capacidad: la
-- validación de RF-05.6 YA EXISTE y es DETERMINISTA (`validarJourney`, con sus nueve códigos
-- de señal y su alcanzabilidad calculada de verdad). Pedirle a un modelo que la repita sería
-- cambiar una respuesta exacta por una probable, que es justo lo que §21 prohíbe vender —y
-- además haría a la capacidad indistinguible de un bug: dos listas de señales que discrepan y
-- ningún criterio para decir cuál vale.
--
-- Lo que un modelo sí añade es lo que el código determinista no puede: dada una señal REAL,
-- qué hacer con ella en ESTE grafo. «El paso "Recibir documento" no tiene salida» lo dice la
-- función; «encadénalo con "Verificar identidad", que es el único paso de la fase siguiente
-- sin entrada» hace falta leer el grafo entero para decirlo.
--
-- Y de ahí sale la comprobación que sostiene la capacidad, que NO vive aquí sino en el
-- servicio, y conviene decir por qué: cada remediación tiene que señalar una señal que
-- `validarJourney` emitió de verdad sobre este journey. Esa lista no es una tabla —es una
-- función pura del grafo—, así que no hay trigger que pueda comprobarla; lo comprueba el
-- servicio volviendo a evaluar LA MISMA función sobre LA MISMA lectura. Es la diferencia con
-- el guard de CT, cuyos ids sí viven en `checklist_item` y por eso están sujetos en la base.

alter table reserva_ai   add column journey_id uuid;
alter table llamada_ai   add column journey_id uuid;
alter table propuesta_ai add column journey_id uuid;

alter table reserva_ai   add foreign key (journey_id, workspace_id)
  references journey (id, workspace_id);
alter table llamada_ai   add foreign key (journey_id, workspace_id)
  references journey (id, workspace_id);
alter table propuesta_ai add foreign key (journey_id, workspace_id)
  references journey (id, workspace_id);

-- El ancla de C5, con la misma forma que las otras tres: una equivalencia por capacidad y no
-- una lista, para que cada capacidad añada la suya sin tocar las ajenas.
alter table reserva_ai   add constraint reserva_ai_ancla_c5   check ((capacidad = 'C5') = (journey_id is not null));
alter table llamada_ai   add constraint llamada_ai_ancla_c5   check ((capacidad = 'C5') = (journey_id is not null));
alter table propuesta_ai add constraint propuesta_ai_ancla_c5 check ((capacidad = 'C5') = (journey_id is not null));

-- Exclusión por ancla: dos personas no pueden tener a la vez una generación en vuelo sobre el
-- mismo grafo, y un grafo no acumula informes sin leer.
create unique index reserva_ai_journey_idx on reserva_ai (workspace_id, journey_id)
  where journey_id is not null;
create unique index propuesta_ai_journey_pendiente_idx on propuesta_ai (workspace_id, journey_id)
  where journey_id is not null and estado = 'propuesta';

-- «Exactamente un ancla» se amplía con la nueva. Va rehecho y no añadido: es UNA regla sobre
-- el conjunto de columnas, no una por columna, y dejar la vieja al lado admitiría dos anclas
-- puestas a la vez con tal de que una de las dos fuera la nueva.
alter table propuesta_ai drop constraint propuesta_ai_un_ancla;
alter table propuesta_ai add constraint propuesta_ai_un_ancla
  check (num_nonnulls(item_id, reto_id, gate_id, journey_id) = 1);

-- Y «sin destino ⇔ ancla informativa». Con CT sola, la ausencia de destino equivalía a tener
-- ancla de gate; ahora hay DOS capacidades informativas, así que la equivalencia es con
-- cualquiera de las dos anclas. Sin rehacerla, una propuesta de C5 —sin destino y con
-- `journey_id`— la violaría, y la capacidad nacería imposible de persistir.
alter table propuesta_ai drop constraint propuesta_ai_destino_informativo;
alter table propuesta_ai add constraint propuesta_ai_destino_informativo
  check ((destino is null) = (num_nonnulls(gate_id, journey_id) = 1));

-- Y su capacidad ⇒ destino, aditiva como las otras.
alter table propuesta_ai add constraint propuesta_ai_destino_c5
  check (capacidad <> 'C5' or destino is null);

grant insert (journey_id) on reserva_ai   to designio_app;
grant insert (journey_id) on llamada_ai   to designio_app;
grant insert (journey_id) on propuesta_ai to designio_app;
