-- El lote de C0 tiene techo, y «único» no era la única alternativa a «sin límite»
-- (RF-08.5 / RF-09.14).
--
-- `propuesta_ai_llamada_ci_idx` acotaba a UNA propuesta por llamada, pero solo para CI. La
-- asimetría estaba razonada —C0 persiste un LOTE de una sola llamada, y sus filas hermanas
-- violarían un índice de unicidad— y dejaba a C0 sin cota ninguna: una llamada C0 genuina
-- podía respaldar propuestas sin límite, cuando el contrato del proveedor acota su respuesta
-- a cuatro criterios.
--
-- Lo que hacía falta no era elegir entre «una» y «ninguna», sino dar a cada propuesta su
-- PUESTO dentro del lote. Con `orden`, la cota vuelve a ser una regla de FILA —cuatro
-- puestos, cuatro filas— que Postgres puede imponer sin preguntar «cuántas hay ya», que es
-- justo la pregunta sobre el conjunto que dos transacciones responden a la vez sobre
-- snapshots distintos bajo READ COMMITTED. El guard no puede cerrar esa ventana; el índice
-- sí, porque no la abre.
--
-- Por qué importa el daño y no solo la forma: cada propuesta afirma «esta llamada ME
-- produjo», y con N filas colgadas de la misma llamada esa frase solo es cierta en una. Las
-- demás heredan un coste, una latencia y un `usage` que no son suyos, el coste por propuesta
-- se reparte entre filas que nadie pagó y el recuento de propuestas generadas crece sin
-- gasto detrás — la dirección que esconde el problema.

alter table propuesta_ai
  -- El 3 es MAX_CRITERIOS_POR_LOTE - 1, y la base no puede importar la constante de TS. Por
  -- eso hay una prueba que ata los dos lados: inserta exactamente ese máximo y uno más, y
  -- exige que la base acepte lo primero y rechace lo segundo. El vínculo es el test, no la
  -- esperanza de que nadie mueva uno de los dos.
  add column orden smallint not null default 0 check (orden >= 0 and orden <= 3);

comment on column propuesta_ai.orden is
  'Puesto de esta propuesta dentro del lote de su llamada (0..MAX_CRITERIOS_POR_LOTE-1). '
  'CI lo lleva fijado a 0 por CHECK: una extracción es un lote de uno.';

-- CI queda fijada al puesto 0, así que el índice GENERAL sustituye al parcial sin perder
-- nada de lo que aquél garantizaba: para CI, (workspace, llamada, 0) sigue siendo una sola
-- fila posible por llamada. Una regla en vez de dos, y la de CI deja de ser un caso aparte.
alter table propuesta_ai
  add constraint propuesta_ai_ci_puesto_unico check (capacidad <> 'CI' or orden = 0);

drop index propuesta_ai_llamada_ci_idx;
create unique index propuesta_ai_llamada_orden_idx
  on propuesta_ai (workspace_id, llamada_id, orden);

-- La aplicación escribe el puesto al persistir el lote (viene del `with ordinality` de la
-- misma sentencia que inserta, no de un contador que alguien lleve a mano), así que entra en
-- el grant de INSERT. No entra en ningún grant de UPDATE: el puesto de una propuesta dentro
-- de su lote es un hecho del momento en que nació y reordenarlo después no significaría nada
-- —salvo liberar un hueco para colgar una quinta fila de una llamada ya pagada, que es
-- exactamente lo que este techo impide—.
grant insert (orden) on propuesta_ai to designio_app;
