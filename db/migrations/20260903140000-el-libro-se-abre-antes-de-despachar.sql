-- El libro se abre ANTES de despachar: una llamada pagada no puede desaparecer (RF-09.14).
--
-- El defecto: la fila de `llamada_ai` se escribía al VOLVER del proveedor. Si el proveedor
-- atendía la llamada —y por tanto la cobraba— y la transacción que la anotaba fallaba de
-- forma transitoria, el `catch` descartaba la única copia del intento y la limpieza soltaba
-- la reserva. El gasto desaparecía del coste Y del tope diario, y el usuario podía
-- reintentar. La promesa «el libro registra TODA invocación» dependía de que una transacción
-- POSTERIOR a la llamada saliera bien, que es al revés de como se sostiene una promesa.
--
-- Se invierte el orden: cada intento abre su línea antes de salir, con el estado nuevo
-- `despachada`, y al volver se CIERRA con su desenlace. Si el apunte previo falla, no hay
-- despacho — no se gasta lo que no se puede anotar.

-- ── El estado nuevo ──
alter table llamada_ai drop constraint llamada_ai_resultado_check;
alter table llamada_ai add constraint llamada_ai_resultado_check
  check (resultado in
    ('despachada', 'salida-valida', 'rechazo-proveedor', 'fuera-de-contrato', 'sin-respuesta'));

-- El motivo se exigía a todo lo que no fuera `salida-valida`, y una línea recién abierta no
-- tiene motivo que dar todavía: su desenlace no ha ocurrido. Se exime a `despachada` y solo a
-- ella; los tres desenlaces sin contenido siguen teniendo que decir por qué.
--
-- Se busca por lo que DICE, no por el nombre que Postgres le puso. `llamada_ai_check4` es un
-- ordinal: cuenta los CHECK de tabla en el orden en que se declararon, así que es un nombre
-- que nadie eligió y que depende de la forma del `create table`. Citarlo aquí no rompería en
-- silencio —un `drop constraint` que no encuentra su nombre aborta la migración— pero sí
-- dejaría este paso atado a un detalle que ninguna regla sostiene. Se localiza por su
-- definición, que es lo único estable, y si no aparece se dice por qué en vez de seguir.
do $$
declare v_nombre text;
begin
  select c.conname into v_nombre from pg_constraint c
    where c.conrelid = 'llamada_ai'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%btrim(motivo)%'
      -- Y que NO sea ya el de después: el que se instala abajo también menciona
      -- btrim(motivo), así que sin esta mitad la búsqueda se encontraría a sí misma.
      and pg_get_constraintdef(c.oid) not like '%despachada%';
  if v_nombre is null then
    raise exception 'no se encuentra en llamada_ai el CHECK que exige motivo fuera de salida-valida: esta migración lo sustituye por uno que exime a despachada, y sin quitarlo el estado nuevo no podría insertarse';
  end if;
  execute format('alter table llamada_ai drop constraint %I', v_nombre);
end $$;
alter table llamada_ai add constraint llamada_ai_motivo_del_desenlace_check
  check (resultado in ('salida-valida', 'despachada') or length(btrim(motivo)) > 0);

-- ── Qué reserva pagó esta llamada ─────────────────────────────────────────────────────
--
-- El tope no cuenta una línea en vuelo mientras la reserva de su generación siga viva: la
-- reserva ya apartó ese hueco, y sumar las dos cobra el doble por la misma generación. La
-- pregunta que hay que saber responder es «¿sigue viva LA RESERVA QUE PAGÓ ESTA LLAMADA?»,
-- y hasta aquí se respondía por el ANCLA — que es una respuesta distinta en cuanto el ancla
-- se reintenta. Al fallar un cierre, la limpieza retira la reserva y la línea huérfana pasa
-- a contar (bien); pero el reintento crea una reserva NUEVA sobre la misma ancla, y con el
-- criterio por ancla esa reserva volvía a esconder la llamada ya pagada. Con fallos
-- repetidos se acumulaban líneas huérfanas invisibles mientras una sola reserva las tapaba
-- a todas, y el cupo diario dejaba pasar generaciones de más.
--
-- Sin FK, y a propósito: la reserva se BORRA cuando la generación termina —es su final
-- normal, no una pérdida—, así que una FK obligaría a elegir entre bloquear ese borrado o
-- poner el id a null, y lo segundo destruiría justo el dato que hace falta. Es el mismo
-- caso que un recibo que nombra un instante cuyo referente desaparece: lo que se guarda es
-- la identidad, y quien la lee comprueba si sigue existiendo. Nadie más la consulta.
--
-- `null` en las filas viejas y en las escrituras crudas, y es la dirección segura: sin
-- reserva que la cubra, la línea CUENTA. Ante la duda de si el proveedor cobró se asume
-- que sí.
alter table llamada_ai add column reserva_id uuid;

comment on column llamada_ai.reserva_id is
  'La reserva de presupuesto que apartó el hueco de esta llamada. Sin FK: la reserva se borra '
  'al terminar la generación. Sirve para no contar dos veces una línea en vuelo, y solo '
  'mientras SU reserva siga viva.';

grant insert (reserva_id) on llamada_ai to designio_app;

-- ── Dos relojes, porque ahora son dos momentos distintos ──
--
-- `creado_en` pasa a ser la hora del DESPACHO: la fila nace antes de llamar. Eso rompe en
-- silencio a quien lo leía como «cuándo se supo el desenlace», que es lo que hacía la señal
-- de salud del panel: entre dos llamadas concurrentes, la que salió primero puede ser la
-- última en volver, y ordenar por `creado_en` elegiría la equivocada. Peor aún, la antigüedad
-- de una caída salía inflada por todo el timeout.
--
-- `cerrado_en` es el otro momento: cuándo se OBSERVÓ el desenlace. Lo estampa el guard con
-- `clock_timestamp()` y queda FUERA del grant — es un hecho de la base, no una anotación de
-- la aplicación, y con él dentro del grant una llamada podría fechar su propia observación.
alter table llamada_ai add column cerrado_en timestamptz;

comment on column llamada_ai.cerrado_en is
  'Cuándo se observó el desenlace de esta llamada. NULL mientras sigue despachada. Lo estampa '
  'el guard, no la aplicación: es el reloj con el que se decide si el proveedor responde.';

-- ── Cerrar la línea es el ÚNICO update, y va en un solo sentido ──
--
-- `using` fija el ORIGEN (solo se puede tocar una fila despachada) y `with check` el DESTINO
-- (no puede quedarse despachada). Juntos: de `despachada` a un desenlace, una vez y nunca al
-- revés, así que la garantía vieja —lo que costó una llamada cerrada no se reescribe— sigue
-- en pie.
--
-- Y `creado_por = app_user_id()` en los dos lados, igual que en `llamada_insert`. Sin ese
-- anclaje, cualquier curador del workspace podía cerrar la línea que abrió OTRO: escribirle
-- un desenlace y un coste inventados que el libro atribuiría a quien la abrió, y de paso
-- dejar que el cierre legítimo no encontrara ya su fila. Una política de escritura que no
-- fija al autor no es la misma política que la de inserción, y aquí tenían que serlo.
create policy llamada_completar on llamada_ai
  for update
  using (
    resultado = 'despachada'
    and creado_por = app_user_id()
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (
    resultado <> 'despachada'
    and creado_por = app_user_id()
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

-- Solo las seis columnas del desenlace. `creado_en` sigue fuera por el mismo motivo que en el
-- insert —es el reloj con el que se cuenta el tope diario—, y `cerrado_en` también, porque lo
-- estampa el guard. Quedan fuera además el ancla, el modelo, la credencial y el
-- consentimiento: son lo que la línea ya afirmó al abrirse, y poder reescribirlos convertiría
-- el apunte previo en una promesa vacía.
grant update (resultado, motivo, tokens_entrada, tokens_salida, costo_usd, latencia_ms)
  on llamada_ai to designio_app;

-- ── El guard, que ahora también corre en el UPDATE ──
--
-- Objetos que redefine esta migración, listados porque `create or replace` reemplaza la
-- función ENTERA: `llamada_ai_registro_guard` (cuerpo copiado del árbol migrado con
-- `pg_get_functiondef`; cambios: el bloque de consentimiento pasa a correr solo en INSERT, se
-- añade el sello de `cerrado_en`, y el evento se emite por las dos vías) y el trigger
-- `llamada_ai_registro`, que pasa de `before insert` a `before insert or update`.

CREATE OR REPLACE FUNCTION public.llamada_ai_registro_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- Este guard tiene TRES casos, no dos, y por eso el pre-chequeo de aquí arriba no es el
  -- mismo que el de los demás. El anti-oráculo de siempre —«no miembro ⇒ `return new`»— no
  -- sirve tal cual porque `app_user_id()` es nulo también para el PROPIETARIO, así que
  -- aplicarlo a secas dejaría sin regla justo a la escritura privilegiada, que es donde más
  -- falta hace un suelo. Y quitarlo a secas abre un oráculo de verdad: los `raise` de abajo
  -- DISTINGUEN casos («este material exige consentimiento» vs. «no lo exige»), así que
  -- alguien sondeando uuids desde el rol de aplicación aprendería si un item de otro tenant
  -- existe y de qué tipo es — la política rechazaría el insert después, pero lo que se
  -- filtra no es la fila, es la respuesta.
  --
  -- Los tres casos, separados por QUIÉN está conectado (`session_user`, que sí distingue al
  -- llamante: `current_user` no vale porque SECURITY DEFINER lo cambia al propietario):
  --
  --   · propietario o superusuario  → se aplica la regla. Es el suelo del SQL directo.
  --   · rol de aplicación, miembro  → se aplica la regla, con sus mensajes diagnósticos.
  --   · rol de aplicación, no miembro → `return new`: no hay nada que diagnosticarle a quien
  --     la política no va a dejar escribir, y callar aquí es lo que cierra el oráculo.
  if session_user = 'designio_app'
     and not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;

  -- Este bloque solo tiene sentido en el INSERT: `item_id` y `consentimiento_version` están
  -- FUERA del grant de update, así que en el cierre son byte a byte los que ya se validaron
  -- al abrir la línea. Volver a consultarlos por cada intento, dentro de la transacción que
  -- sostiene los candados de la fila, es trabajo que no puede cambiar ninguna respuesta.
  if tg_op = 'INSERT' then
    -- La OTRA mitad de la ligadura del consentimiento, la que ninguna FK puede expresar
    -- porque depende del `tipo_fuente` del item: citar una versión es obligatorio cuando el
    -- material es de personas, y está prohibido cuando no lo es. Sin las dos direcciones, un
    -- `null` sería ambiguo entre «no aplicaba» y «no lo escribí», y la remediación de RF-09.4
    -- no puede distinguir esas dos cosas leyendo el libro — que es para lo único que sirve.
    if new.item_id is not null then
      if exists (select 1 from item_importacion i
        where i.id = new.item_id and i.workspace_id = new.workspace_id
          and tipo_fuente_exige_consentimiento(i.tipo_fuente))
      then
        if new.consentimiento_version is null then
          raise exception 'una llamada sobre material de personas anota bajo qué consentimiento salió: falta consentimiento_version (RF-09.4/09.5)';
        end if;
      elsif new.consentimiento_version is not null then
        raise exception 'ese material no exige consentimiento: la llamada no puede citar uno, porque la ausencia es lo que significa «no aplicaba»';
      end if;
    end if;
  end if;

  -- El sello del cierre: lo pone la BASE, no la aplicación, y por eso `cerrado_en` está
  -- fuera del grant. Es el reloj de cuándo se OBSERVÓ el desenlace, que no es el mismo que
  -- `creado_en` —ahora la hora del despacho— y es el que necesita la señal de salud: entre
  -- dos llamadas, la observación más reciente puede venir de la que salió primero.
  --
  -- `clock_timestamp()` y no `now()`: dos intentos de una misma generación se cierran en la
  -- misma transacción, y `now()` les daría el mismo instante — justo el empate que el puesto
  -- del intento tuvo que venir a deshacer.
  --
  -- Y también en el INSERT que nace ya con desenlace. El grant de insert incluye `resultado`,
  -- así que una escritura cruda puede anotar una llamada completa en una sola sentencia —es
  -- legítimo: no reescribe nada, registra un hecho consumado— y sin este sello quedaría con
  -- un desenlace y sin hora de observación, que es una fila que afirma dos cosas
  -- incompatibles. `cerrado_en` significa lo mismo por las dos vías o no significa nada.
  --
  -- Se sella solo si viene VACÍO, y esa distinción importa: la aplicación no puede ponerlo
  -- —`cerrado_en` está fuera de los dos grants—, así que un valor explícito solo puede venir
  -- de una escritura administrativa: una restauración, una migración de datos, un seed. Ésas
  -- sí saben cuándo se observó de verdad el desenlace, y pisárselo con la hora de la
  -- restauración convertiría el reloj de la observación en el reloj de la copia.
  if (tg_op = 'UPDATE' and old.resultado = 'despachada' and new.resultado <> 'despachada')
     or (tg_op = 'INSERT' and new.resultado <> 'despachada') then
    new.cerrado_en := coalesce(new.cerrado_en, clock_timestamp());
  end if;

  -- Y el evento sigue siendo cosa de miembros, como en el resto de guards: una escritura
  -- privilegiada no tiene rol de workspace que anotar, y el `actor_rol` quedaría vacío.
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;

  -- ── «Llamada sin propuesta», por las DOS vías por las que puede llegar ──
  --
  -- Con el libro anticipado, el camino normal es: nace `despachada` y luego se cierra. Ahí el
  -- desenlace se conoce en el UPDATE, y emitir en el INSERT anotaría «sin propuesta» en TODA
  -- llamada, incluidas las que acaban bien.
  --
  -- Pero el INSERT sigue admitiendo un desenlace directo —el grant de insert incluye
  -- `resultado`, y una escritura cruda puede nacer ya en `sin-respuesta`—, y la migración
  -- base puso este evento DENTRO del guard precisamente para que el SQL crudo lo produjera
  -- igual. Mover el evento al UPDATE a secas habría retirado ese suelo sin decirlo. Las dos
  -- vías, entonces: nacer con desenlace, o pasar a tenerlo.
  --
  -- La del UPDATE mira el TRÁNSITO y no solo el estado nuevo, para que el evento salga una
  -- vez por línea y no cada vez que alguien toque la fila.
  if (tg_op = 'INSERT' and new.resultado not in ('salida-valida', 'despachada'))
     or (tg_op = 'UPDATE' and old.resultado = 'despachada'
         and new.resultado not in ('salida-valida', 'despachada')) then
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'LlamadaAISinPropuesta',
      jsonb_build_object('llamadaId', new.id, 'capacidad', new.capacidad,
                         'modelo', new.modelo, 'resultado', new.resultado,
                         'motivo', new.motivo, 'costoUsd', new.costo_usd),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $function$;

drop trigger llamada_ai_registro on llamada_ai;
create trigger llamada_ai_registro
  before insert or update on llamada_ai
  for each row execute function llamada_ai_registro_guard();

revoke execute on function llamada_ai_registro_guard() from public;
