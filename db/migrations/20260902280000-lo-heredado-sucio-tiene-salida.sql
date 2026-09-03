-- RF-03.2 / SYS-17 — UN `NOT VALID` NO ES UN PERDÓN: ES UNA TRAMPA CON RETARDO.
--
-- `20260902170000` añadió los tres `CHECK` de material limpio como `NOT VALID` y lo
-- argumentó así: «rigen desde ya para toda escritura nueva, pero una instalación con
-- material heredado que el esquema anterior aceptaba no ve caerse el despliegue». La
-- primera mitad es cierta. La segunda es cierta y está incompleta, que en una promesa de
-- producto es lo mismo que estar mal.
--
-- `NOT VALID` solo salta el escaneo de la tabla al crear la restricción. Postgres SIGUE
-- comprobando el CHECK en cada INSERT y en cada UPDATE posterior de esa fila, y lo hace
-- sobre la fila RESULTANTE, no sobre lo que cambió. Aprobar o rechazar un item heredado
-- sucio toca solo `estado`, `decidido_por` y `decidido_en` —el texto ni se menciona— pero
-- la fila resultante sigue llevando el contenido sucio, el CHECK se reevalúa y el UPDATE
-- muere con 23514.
--
-- Reproducido antes de arreglarlo, sobre una base construida como una instalación
-- heredada (quitar el CHECK, insertar material con un control C0, reponerlo `NOT VALID`):
--
--   ERROR:  new row for relation "item_importacion" violates check constraint
--           "item_contenido_limpio"
--
-- Y ese item no tiene NINGUNA salida de la bandeja: no se puede aprobar, no se puede
-- rechazar, y tampoco corregir, porque el grant de UPDATE del rol de aplicación sobre
-- `item_importacion` son cuatro columnas —`estado`, `decidido_por`, `decidido_en`,
-- `evidencia_id`— y el texto original no es una de ellas (comprobado). Queda clavado para
-- siempre en la cola de curaduría. Es el mismo defecto que el de los adjuntos retenidos
-- sin ruta, otra vez: la base lo permite en teoría y el producto no da camino.
--
-- ═══ QUÉ SE PROMETE DE VERDAD ═══
-- «No entra material sucio nuevo». NO «una fila que ya contiene material sucio no se puede
-- volver a tocar nunca». Lo segundo no protege a nadie: el texto no cambia por decidir
-- sobre él, y el curador que lo mira es exactamente quien tiene que poder rechazarlo.
--
-- Así que el predicado pasa de `CHECK` a TRIGGER, y se impone solo cuando el texto ENTRA o
-- CAMBIA. Lo demás queda igual de cerrado que antes: un INSERT con material sucio se
-- rechaza, y un UPDATE que introduzca o modifique texto sucio también.
--
-- Dos detalles que hacen falta para que esto sea correcto y no aproximado:
--
--  · El trigger compara `old` con `new` DENTRO del cuerpo. `update of contenido` dispara
--    cuando la columna aparece en el `SET`, no cuando su valor cambia de verdad, así que
--    la condición del `create trigger` no basta: un `set contenido = contenido` sobre una
--    fila heredada volvería a fallar. Por eso el trigger es `before insert or update` a
--    secas y la decisión se toma comparando valores.
--  · Se levanta con errcode `23514` y nombrando la restricción, para que el traductor de
--    `evidencia.functions.ts` —que ya distingue `item_%limpi%` y devuelve el mensaje que
--    dice qué pasa— siga funcionando sin tocarlo. Cambiar el mecanismo no debe cambiar lo
--    que lee el curador.
--
-- Lo heredado NO se reescribe, igual que antes: normalizar correría los offsets de las
-- citas (RF-03.7). Sigue habiendo su evento `MaterialImportadoSucioDetectado` de la
-- migración 170000 para que el operador sepa qué hay; lo que cambia es que ahora puede
-- despacharlo.

alter table item_importacion
  drop constraint item_contenido_limpio,
  drop constraint item_titulo_limpio,
  drop constraint item_referencia_limpia;

create function item_texto_importado_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- INSERT: el texto entra entero, se comprueba entero. UPDATE: solo lo que cambia de
  -- verdad, comparado aquí y no en la cláusula del trigger (ver arriba).
  if tg_op = 'INSERT' or new.contenido is distinct from old.contenido then
    if not texto_importado_limpio(new.contenido) then
      raise exception 'el contenido importado lleva controles C0/C1 u overrides bidi'
        using errcode = '23514', constraint = 'item_contenido_limpio';
    end if;
  end if;
  if tg_op = 'INSERT' or new.titulo is distinct from old.titulo then
    if not texto_importado_limpio(new.titulo) then
      raise exception 'el título importado lleva controles C0/C1 u overrides bidi'
        using errcode = '23514', constraint = 'item_titulo_limpio';
    end if;
  end if;
  if tg_op = 'INSERT' or new.referencia is distinct from old.referencia then
    if not texto_importado_limpio(new.referencia) then
      raise exception 'la referencia importada lleva controles C0/C1 u overrides bidi'
        using errcode = '23514', constraint = 'item_referencia_limpia';
    end if;
  end if;
  return new;
end $$;

-- SIN `security definer`: no lee nada que la política no deje ver, solo mira `new` y
-- `old`. Y sin pre-chequeo anti-oráculo, porque no revela nada de ninguna fila ajena: el
-- mensaje habla del texto que el propio llamante acaba de mandar.
create trigger item_texto_importado
  before insert or update on item_importacion
  for each row execute function item_texto_importado_guard();

revoke execute on function item_texto_importado_guard() from public;
