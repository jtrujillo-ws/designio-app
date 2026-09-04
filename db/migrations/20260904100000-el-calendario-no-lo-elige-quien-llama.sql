-- ── El calendario de las garantías no lo elige quien llama ──
--
-- `current_date` no es una fecha: es la fecha EN EL HUSO DE LA SESIÓN, y el huso lo pone
-- quien llama con `SET LOCAL TIME ZONE`. Eso convierte cada regla escrita contra
-- `current_date` en una regla que el llamante mide con su propio metro.
--
-- No basta con que la función sea `SECURITY DEFINER`: eso presta los PRIVILEGIOS del dueño,
-- no devuelve los parámetros de sesión al valor del servidor. Solo lo que la función fija en
-- su propio `SET` queda fuera del alcance de quien la invoca, y en las tres de abajo eso era
-- únicamente `search_path`. Medido:
--
--     set local time zone 'Etc/GMT+12';          -- current_date = 2026-09-03
--     set local time zone 'Pacific/Kiritimati';  -- current_date = 2026-09-04
--
-- El mundo abarca a la vez 26 horas de calendario (de UTC-12 a UTC+14), así que la fecha del
-- huso más adelantado es SIEMPRE un día mayor que la del más atrasado: no hay hora del día en
-- la que esto no esté disponible, solo cambia hacia dónde conviene empujar.
--
-- Lo que estaba en juego, objeto por objeto:
--
--  · `derechos_vigentes` — «caducado ⇒ ya no hay derechos». Un derecho vencido AYER vuelve a
--    estar vigente atrasando el huso, y con él la evidencia vuelve a ser citable, congelable
--    y validable. Es la garantía de SPEC-03 entera, medida con el reloj de quien la quiere
--    esquivar. No está concedida a `designio_app` directamente, pero `evidencia_usable` sí lo
--    está y la invoca: el huso de la sesión viaja igual a través de la llamada.
--  · `evidencia_motivo_bloqueo` — el motivo que se PINTA. Concedida a `designio_app`. Con el
--    huso movido decía «los derechos vencieron el …» sobre un derecho vivo, o callaba sobre
--    uno muerto, que es peor: el mensaje es lo único que le dice a una persona por qué no
--    puede citar.
--  · `ventana_de_medicion_abierta` — ni siquiera es `SECURITY DEFINER`. Un día extra de
--    ventana es un dato dentro del plazo firmado que se cargó fuera de él.
--  · la política `snapshot_insert` — su comentario dice, con todas las letras, que la fecha
--    del dato «no puede ser del futuro», y enumera el daño: la proyección lo toma como la
--    última recepción y la cadencia pasa a «recibido» sin que nadie haya aportado nada. Una
--    política se evalúa ENTERA en la sesión de quien escribe, así que ahí `current_date` es
--    directamente el calendario del que inserta.
--
-- El arreglo es el mismo en los cuatro y ya está en uso en este repositorio para los
-- instantes que entran en un sello: `timezone('UTC', now())` devuelve un `timestamp` SIN
-- huso, del que el `::date` ya no tiene de dónde moverse (medido). `now()` y no
-- `clock_timestamp()` porque `current_date` medía el inicio de la transacción: esto fija el
-- calendario, no cambia el instante.
--
-- Lo que NO se toca, comprobado y no supuesto: `to_char(<date>, 'YYYY-MM-DD')` no depende del
-- huso —un `date` no tiene ninguno—, así que los mensajes que imprimen `vence_en` ya estaban
-- bien. Solo `to_char` sobre un `timestamptz` se mueve, y en estos objetos no hay ninguno.

-- ── 0. El calendario, con un nombre ──────────────────────────────────────────────────
-- Una función y no la expresión repetida en cada sitio, por la razón que este esquema ya
-- tiene escrita para el espejo de la pantalla: «el espejo LEE la regla; no la reproduce».
-- Con `timezone('UTC', now())::date` copiado en ocho sitios, la regla vuelve a ser ocho
-- reglas, y basta con arreglar siete para que el octavo empiece a discrepar justo en el
-- borde del día — que es exactamente el fallo que esta migración viene a cerrar.
--
-- STABLE y no IMMUTABLE: depende del reloj, no de la sesión. Concedida a `designio_app`
-- porque el servicio la NECESITA: sus consultas de diagnóstico tienen que juzgar con el
-- mismo día que la política que autoriza, o el lead ve «no falta nada» junto a un rechazo.
create function fecha_de_la_base() returns date
language sql stable parallel safe as
$$ select timezone('UTC', now())::date $$;
comment on function fecha_de_la_base() is
  'El día de calendario contra el que juzga la base: UTC, fijo, nunca el huso de la sesión. Lo leen las reglas y también los espejos que las diagnostican, para que no puedan discrepar.';
grant execute on function fecha_de_la_base() to designio_app;

-- Y el mismo calendario como INSTANTE, para lo que no compara días sino marcas de tiempo.
-- `date_trunc('day', now())` es la otra forma de colapsar el reloj a un día, y se mueve igual:
-- medido, entre UTC-12 y UTC+14 da dos días distintos. La usa el cupo diario de IA para
-- decidir qué llamadas cuentan, así que sin fijarla se reinicia el presupuesto cambiando de
-- huso. Aquí el día empieza donde lo dice `fecha_de_la_base()` y no donde diga la sesión.
--
-- Devuelve `timestamptz` —un instante absoluto— y no un `timestamp` naíf: comparado contra
-- `creado_en`, que también es `timestamptz`, no hay conversión implícita que reintroduzca el
-- huso por la puerta de atrás. (Un `date` sí la tendría: al compararlo con un `timestamptz`,
-- Postgres lo promociona usando el huso de la sesión, que es justo lo que se quiere evitar.)
create function inicio_del_dia_de_la_base() returns timestamptz
language sql stable parallel safe as
$$ select timezone('UTC', fecha_de_la_base()::timestamp) $$;
comment on function inicio_del_dia_de_la_base() is
  'El instante en que empieza el día de la base (medianoche UTC del día en curso). Para lo que compara marcas de tiempo en vez de fechas, como el cupo diario.';
grant execute on function inicio_del_dia_de_la_base() to designio_app;

-- ── 1. Los derechos vigentes ──
create or replace function derechos_vigentes(p_evidencia uuid, p_ws uuid, p_ambito text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from derecho_uso d
    where d.evidencia_id = p_evidencia
      and d.workspace_id = p_ws
      and d.estado = 'concedido'
      -- Caducado ⇒ ya no hay derechos (fecha calendárica, comparada como día, en el
      -- calendario de la BASE y no en el de quien pregunta).
      and (d.vence_en is null or d.vence_en >= fecha_de_la_base())
      and case p_ambito
            when 'interno' then d.ambito in ('interno', 'cliente', 'publico')
            when 'cliente' then d.ambito in ('cliente', 'publico')
            when 'publico' then d.ambito = 'publico'
            else false
          end
  )
$$;

-- ── 2. El motivo que se pinta ──
create or replace function evidencia_motivo_bloqueo(p_evidencia uuid, p_ws uuid, p_ambito text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when not is_workspace_member(app_user_id(), p_ws) then null
    when evidencia_usable(p_evidencia, p_ws, p_ambito) then null
    when d.evidencia_id is null then
      'la evidencia no existe en este workspace o no tiene registro de derechos'
    when d.estado = 'pendiente' then
      'derechos pendientes: nadie ha registrado la base (consentimiento o cláusula) que autoriza este uso'
    when d.estado = 'denegado' then
      'derechos denegados: ' || d.base
    when d.vence_en is not null and d.vence_en < fecha_de_la_base() then
      -- `to_char` sobre un `date` no depende del huso (medido): la fecha que se imprime ya
      -- era estable, y ahora también lo es la comparación que decide imprimirla.
      'los derechos vencieron el ' || to_char(d.vence_en, 'YYYY-MM-DD')
    else
      'los derechos concedidos alcanzan solo el ámbito «' || d.ambito ||
      '» y este uso exige «' || p_ambito || '»'
  end
  from (select p_evidencia as ev) param
  left join derecho_uso d on d.evidencia_id = param.ev and d.workspace_id = p_ws
$$;

-- ── 3. La ventana de medición ──
create or replace function ventana_de_medicion_abierta(p_inicio date, p_dias integer)
returns boolean language sql stable parallel safe as $$
  select p_inicio is null or p_dias is null
     or p_inicio + p_dias >= fecha_de_la_base()
$$;

-- ── 4. La fecha del dato no puede ser del futuro ──
-- Se recrea entera porque una política no se puede alterar por partes. Es la MISMA regla,
-- con la única diferencia del calendario contra el que se compara.
drop policy snapshot_insert on snapshot;
create policy snapshot_insert on snapshot
  for insert with check (
    creado_por = app_user_id()
    -- La fecha del DATO no puede ser del futuro. Sin esto, el propietario del dato mete
    -- un valor fechado por delante: la proyección lo toma como la última recepción (y la
    -- cadencia pasa a «recibido» sin que nadie haya aportado nada), y el selector del
    -- outcome review lo ofrece como resultado final del criterio.
    --
    -- Contra el calendario de la base: una política se evalúa entera en la sesión de quien
    -- escribe, así que con `current_date` «el futuro» empezaba donde el que inserta dijera.
    and snapshot.fecha <= fecha_de_la_base()
    and exists (select 1 from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
      join reto rt on rt.id = r.reto_id and rt.workspace_id = r.workspace_id
      join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
      where e.id = snapshot.entrada_kpi_id and e.workspace_id = snapshot.workspace_id
        -- Solo se mide lo FIRMADO (SYS-22) y solo mientras el reto está en medición:
        -- después del cierre el resultado es historia (SYS-08).
        and r.estado = 'firmado' and rt.estado = 'en-medicion'
        -- Y solo DENTRO de la ventana firmada: I5 dice que la medición es temporal y
        -- ACOTADA, así que un valor de antes del inicio o de después del cierre no mide
        -- lo que se acordó medir. La ventana es la del contrato —inicio de la entrada,
        -- largo del criterio congelado en G0— y ninguna de las dos se copia aquí: se
        -- leen donde viven, que es lo que evita la segunda verdad.
        and e.ventana_inicio is not null and c.ventana_dias is not null
        and snapshot.fecha >= e.ventana_inicio
        and snapshot.fecha <= e.ventana_inicio + c.ventana_dias
        and (workspace_role(app_user_id(), snapshot.workspace_id) in ('lead-boutique', 'disenador')
          or exists (select 1 from miembro m
            where m.id = e.propietario_miembro_id and m.workspace_id = e.workspace_id
              and m.usuario_id = app_user_id())))
  );
