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

-- La columna nace SIN el CHECK del rango porque las filas que ya existen aún no tienen
-- puesto: todas toman el default 0, que sí satisface el rango, y el reparto viene después.
alter table propuesta_ai add column orden smallint not null default 0;

-- ── Un lote que YA rebasa el techo se para, no se recorta ──
--
-- Va ANTES de repartir para poder decir lo que pasa en vez de un fallo de CHECK sin contexto.
-- Borrar propuestas es decisión de una persona, no de una migración: el techo no existía
-- cuando esas filas se escribieron, así que el dato no está corrupto —está fuera de una regla
-- nueva—, y quién sobra lo decide quien conozca el workspace.
do $$
declare n integer;
begin
  select count(*) into n from (
    select 1 from propuesta_ai group by workspace_id, llamada_id having count(*) > 4
  ) x;
  if n > 0 then
    raise exception 'AI: % lote(s) exceden el techo (MAX_CRITERIOS_POR_LOTE=4) y esta '
      'migracion no borra propuestas por su cuenta. Revisa: select workspace_id, llamada_id, '
      'count(*) from propuesta_ai group by 1,2 having count(*) > 4;', n;
  end if;
end $$;

-- Los dos CHECK van antes del reparto y no después: un UPDATE deja eventos de trigger
-- DIFERIDOS pendientes sobre esta tabla (`propuesta_ai_materializacion`), y con la cola
-- pendiente Postgres rechaza cualquier ALTER TABLE con «cannot ALTER TABLE ... because it has
-- pending trigger events». Las filas ya escritas llevan todas el 0, así que satisfacen los
-- dos desde el primer momento y no hace falta validar nada a posteriori.
alter table propuesta_ai
  -- El 3 es MAX_CRITERIOS_POR_LOTE - 1, y la base no puede importar la constante de TS. Por
  -- eso hay una prueba que ata los dos lados: inserta exactamente ese máximo y uno más, y
  -- exige que la base acepte lo primero y rechace lo segundo. El vínculo es el test, no la
  -- esperanza de que nadie mueva uno de los dos.
  add constraint propuesta_ai_orden_check check (orden >= 0 and orden <= 3);

-- CI queda fijada al puesto 0, así que el índice GENERAL sustituye al parcial sin perder
-- nada de lo que aquél garantizaba: para CI, (workspace, llamada, 0) sigue siendo una sola
-- fila posible por llamada. Una regla en vez de dos, y la de CI deja de ser un caso aparte.
alter table propuesta_ai
  add constraint propuesta_ai_ci_puesto_unico check (capacidad <> 'CI' or orden = 0);

-- ── Reparto del puesto en lo YA ESCRITO ──
--
-- Sin esto, un lote C0 anterior a esta migración deja N filas compartiendo
-- (workspace, llamada, 0) y el índice único de abajo NO se puede crear: la migración aborta
-- entera. No es hipotético —cualquier base de desarrollo o previsualización que corriera el
-- slice AI y generara un lote está en ese estado—, y como el ledger solo anota lo que
-- commitea, el entorno se queda atascado repitiendo el mismo fallo.
--
-- El reparto es determinista y pone a CI primero: una llamada de CI respaldaba ya una sola
-- propuesta (lo imponía el índice parcial que se retira abajo), así que le toca el 0 y el
-- CHECK de arriba la deja pasar. Sin ese desempate, una llamada que por lo que fuera
-- respaldara filas de las dos capacidades podría dejar la de CI fuera del 0.
--
-- En una base limpia no hay nada que repartir y el UPDATE no toca ninguna fila.
update propuesta_ai p
   set orden = r.puesto
  from (select id,
               (row_number() over (partition by workspace_id, llamada_id
                                   order by (capacidad <> 'CI'), creado_en, id) - 1)::smallint
                 as puesto
          from propuesta_ai) r
 where p.id = r.id and p.orden is distinct from r.puesto;

-- El UPDATE de arriba encola los eventos del trigger DIFERIDO de esta tabla
-- (`propuesta_ai_materializacion`), y con esa cola pendiente Postgres rechaza tanto
-- ALTER TABLE como CREATE INDEX sobre ella («because it has pending trigger events»). Se
-- vacía aquí, dentro de la misma transacción de la migración: los guards se ejecutan de
-- verdad sobre las filas tocadas —no se saltan— y solo después se crea el índice.
set constraints all immediate;

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
