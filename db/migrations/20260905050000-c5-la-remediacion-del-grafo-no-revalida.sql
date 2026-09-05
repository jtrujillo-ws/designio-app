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

-- ── El suelo de C5: linaje por su ancla, y el grafo todavía editable ──
--
-- `propuesta_ai_revision_guard` compara el ancla ENUMERANDO columnas, y las que enumera son
-- null en toda fila de C5: una llamada válida de C5 para el journey A se podía colgar de un
-- informe del journey B, con la FK compuesta conforme y la atribución de coste corrompida.
-- Cada ancla trae su comparación, aditiva como sus CHECK — reescribir aquel guard obligaría a
-- copiar sus casi doscientas líneas aquí, y la siguiente migración que las copiara sin esta
-- línea la revocaría en silencio. Que ninguna se quede sin ella lo sujeta la prueba que
-- compara `COLUMNAS_DE_ANCLA` contra el texto de todos los guards de la tabla: sin esto sale
-- roja nombrando «journey_id», y así es como se descubrió este hueco.
--
-- Y el grafo tiene que seguir EDITABLE al escribir. `REVALIDAR.C5` lo comprueba antes de
-- despachar, y entre esa transacción y ésta cabe el snapshot: sin el corte nacía una
-- remediación sobre un grafo ya congelado —que no se puede aplicar— ocupando además el hueco
-- del journey por el índice parcial.
create or replace function propuesta_ai_c5_linaje_guard() returns trigger
language plpgsql as $$
begin
  if new.capacidad <> 'C5' then
    return new;
  end if;
  if exists (
    select 1 from journey_snapshot sn
    where sn.journey_id = new.journey_id and sn.workspace_id = new.workspace_id
  ) then
    raise exception 'ese journey ya está congelado en un snapshot: no admite remediaciones nuevas';
  end if;
  if not exists (
    select 1 from llamada_ai l
    where l.id = new.llamada_id and l.workspace_id = new.workspace_id
      and l.journey_id is not distinct from new.journey_id
  ) then
    raise exception 'la propuesta debe colgar de la llamada que la produjo: mismo journey';
  end if;
  return new;
end $$;

revoke execute on function propuesta_ai_c5_linaje_guard() from public;

create trigger a_propuesta_ai_c5_linaje
  before insert on propuesta_ai
  for each row execute function propuesta_ai_c5_linaje_guard();

-- Un informe por llamada, como CI y CT: C5 tampoco es un lote. Índice propio, para que dos
-- ramas no se pisen el mismo.
create unique index propuesta_ai_llamada_c5_idx on propuesta_ai (workspace_id, llamada_id)
  where capacidad = 'C5';
