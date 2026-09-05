-- ── C2: insights propuestos, con sus afirmaciones y las citas que las sostienen ──
--
-- La primera capacidad que materializa un objeto COMPUESTO. CI crea una evidencia y C0 un
-- criterio; un insight no es una fila: es un `insight` con sus `afirmacion`, y cada afirmación
-- con las `cita` que la sostienen —fragmento literal y localización, apuntando a la evidencia
-- de la que salió—. Y opcionalmente sus `contradiccion`, que es lo que I4 pide señalar en vez
-- de esconder.
--
-- El ancla es el RETO, que ya existe como columna. Lo que hubo que decidir es de dónde sale su
-- material, porque `evidencia` NO está atada a un reto en este esquema: el único camino es
-- `reto → arquetipo (reto_id) → arquetipo_evidencia → evidencia`. Ése es el que se usa, y la
-- consecuencia va dicha porque se mide: en el seed demo, de las 5 evidencias del workspace
-- solo 1 es alcanzable desde un reto por ese camino. Un reto sin arquetipos con evidencia no
-- se ofrece y su generación se niega — como CI niega un item sin material— en vez de mandarle
-- al modelo un montón que no es del reto.
--
-- El destino nuevo se llama `insight` y trae su columna de enlace, con la misma gramática que
-- las dos que había.

alter table propuesta_ai add column insight_id uuid;
alter table propuesta_ai add foreign key (insight_id, workspace_id)
  references insight (id, workspace_id);

-- Destino ⇔ objeto, con `is not distinct from` como sus hermanas: `destino` es anulable desde
-- CT, y un CHECK que compara con null devuelve null, que PASA.
alter table propuesta_ai add constraint propuesta_ai_objeto_insight
  check (insight_id is null or destino is not distinct from 'insight');
alter table propuesta_ai add constraint propuesta_ai_destino_c2
  check (capacidad <> 'C2' or destino is not distinct from 'insight');

-- ── El ancla deja de ser una pareja fija y pasa a ser una LISTA por columna ──
--
-- C2 es la primera capacidad que COMPARTE columna de ancla con otra: cuelga del reto, igual
-- que C0. Y ahí se ve que las restricciones de ancla estaban escritas como equivalencias
-- «una capacidad ⇔ una columna», que es exacto mientras cada columna tenga una sola dueña y
-- FALSO en cuanto deja de tenerla. Medido contra la base, antes de tocar nada, intentando
-- escribir la llamada de C2 que produce sus insights:
--
--   ERROR: new row for relation "llamada_ai" violates check constraint "llamada_ai_check1"
--   CHECK ((capacidad = 'C0') = (reto_id IS NOT NULL))
--
-- No es que C2 estuviera mal anclada: es que la base tenía escrito que colgar del reto ES ser
-- C0. Lo mismo en `reserva_ai`. Añadir junto a ellas la implicación de una sola dirección
-- —«C2 exige reto»— no arregla nada, porque la que rechaza es la OTRA mitad, la que dice que
-- el reto exige C0; y esa mitad sigue haciendo falta, porque sin ella una fila puede colgar
-- de un ancla que su capacidad no declara.
--
-- Así que la forma correcta no es una equivalencia por capacidad sino una POR COLUMNA, con
-- la lista de las capacidades que la declaran:
--
--   (reto_id is not null) = (capacidad in ('C0','C2'))
--
-- Las dos direcciones siguen sujetas y la lista crece con cada capacidad que ancle ahí. Que
-- esa lista se quede corta es el modo de fallo que queda, y por eso NO se deja al cuidado de
-- quien escriba la próxima migración: `ANCLA_DECLARADA` y `CAPACIDADES[c].ancla.columna` ya
-- dicen en la aplicación qué capacidad cuelga de dónde, y la prueba «cada columna de ancla
-- enumera en la base las capacidades que la declaran» compara las dos listas. Una capacidad
-- nueva que no se añada aquí enrojece antes de que su primera reserva la rechace.
--
-- De paso las tres dejan de llamarse `_check` y `_check1`: nombres que Postgres puso y que no
-- dicen qué sujetan. La misma razón por la que la prueba del vocabulario las busca por nombre
-- exacto.

alter table reserva_ai   drop constraint reserva_ai_check;    -- (capacidad='CI') = (item_id …)
alter table reserva_ai   drop constraint reserva_ai_check1;   -- (capacidad='C0') = (reto_id …)
alter table reserva_ai   drop constraint reserva_ai_ancla_ct;
alter table llamada_ai   drop constraint llamada_ai_check;
alter table llamada_ai   drop constraint llamada_ai_check1;
alter table llamada_ai   drop constraint llamada_ai_ancla_ct;
alter table propuesta_ai drop constraint propuesta_ai_ancla_ct;

alter table reserva_ai   add constraint reserva_ai_ancla_item   check ((item_id is not null) = (capacidad in ('CI')));
alter table reserva_ai   add constraint reserva_ai_ancla_reto   check ((reto_id is not null) = (capacidad in ('C0', 'C2')));
alter table reserva_ai   add constraint reserva_ai_ancla_gate   check ((gate_id is not null) = (capacidad in ('CT')));
alter table llamada_ai   add constraint llamada_ai_ancla_item   check ((item_id is not null) = (capacidad in ('CI')));
alter table llamada_ai   add constraint llamada_ai_ancla_reto   check ((reto_id is not null) = (capacidad in ('C0', 'C2')));
alter table llamada_ai   add constraint llamada_ai_ancla_gate   check ((gate_id is not null) = (capacidad in ('CT')));
alter table propuesta_ai add constraint propuesta_ai_ancla_item check ((item_id is not null) = (capacidad in ('CI')));
alter table propuesta_ai add constraint propuesta_ai_ancla_reto check ((reto_id is not null) = (capacidad in ('C0', 'C2')));
alter table propuesta_ai add constraint propuesta_ai_ancla_gate check ((gate_id is not null) = (capacidad in ('CT')));

-- Y `propuesta_ai`, que hasta ahora ataba la capacidad a su ancla POR EL CAMINO LARGO —de la
-- capacidad al destino con un CHECK por capacidad, y del destino al ancla con otro—, la ata
-- ahora también en directo. El camino largo sigue siendo cierto y se queda: dice otra cosa
-- (qué objeto materializa cada destino) y es lo que sujeta a CT, que no materializa ninguno.

-- Y «destino ⇔ ancla»: la equivalencia de C0 decía «destino criterio ⇔ reto», y con C2
-- colgando del MISMO reto con OTRO destino eso deja de valer. Se rehace en los dos sentidos
-- que siguen siendo ciertos: un destino de criterio o de insight exige reto, y un reto exige
-- uno de esos dos destinos.
alter table propuesta_ai drop constraint propuesta_ai_destino_criterio;
alter table propuesta_ai add constraint propuesta_ai_destino_del_reto
  check ((destino in ('criterio-exito', 'insight')) = (reto_id is not null));

-- ── El VOCABULARIO de destinos también estaba enumerado, y también se quedó corto ──
--
-- `propuesta_ai.destino` traía `check (destino in ('evidencia','criterio-exito'))` desde la
-- migración original. CT no lo rozó porque su destino es NULL y un `in (…)` sobre null da
-- null, que pasa; C2 sí, porque el suyo es un valor nuevo. Medido: sin esta línea, TODA
-- propuesta de C2 la rechaza `propuesta_ai_destino_check` — y con el mismo modo de fallo que
-- el vocabulario de capacidades que ya hubo que alinear una vez: la enumeración vive en un
-- sitio que la capacidad nueva no sabe que tiene que tocar.
--
-- Se rehace con nombre propio y la lista completa. Que siga cuadrando con lo que declara la
-- aplicación —`CAPACIDADES[c].destino`— lo comprueba una prueba, por lo mismo que arriba.
alter table propuesta_ai drop constraint propuesta_ai_destino_check;
alter table propuesta_ai add constraint propuesta_ai_destino_vocabulario
  check (destino in ('evidencia', 'criterio-exito', 'insight'));

-- ── La puerta de los criterios era del RETO, y tenía que ser del DESTINO ──
--
-- `propuesta_ai_revision_guard` cerraba así, en el INSERT:
--
--   if new.reto_id is not null and (reto_criterios_congelados(…) or not reto_admite_criterios(…))
--     then raise exception 'ese reto ya no admite criterios nuevos: …'
--
-- Escrito cuando colgar del reto era ser C0, dice lo que quería decir. Con C2 colgando del
-- mismo reto pasa a decir otra cosa: que un G0 aprobado —que congela los CRITERIOS de un reto
-- (SYS-22)— también prohíbe proponerle INSIGHTS, que no tiene nada que ver; y que un reto
-- `en-medicion` o `cerrado` tampoco los admite. Medido sobre un reto en medición:
-- `admite_criterios = false`, así que el INSERT de C2 muere ahí — después de haber pagado la
-- llamada, porque el servicio sí distingue: `ELEGIBILIDAD.C2` declara que lo único que la
-- cierra es que el reto se archive.
--
-- La puerta se reescribe por lo que de verdad gobierna: el destino. Es exactamente el mismo
-- conjunto de filas para C0 —`propuesta_ai_destino_c0` ata C0 ⇔ criterio-exito—, así que su
-- comportamiento no cambia en nada, y cualquier capacidad futura que materialice un criterio
-- la hereda por materializarlo, no por colgar de donde cuelga.
--
-- Lo que sí es del RETO y no del destino se queda como regla aparte y por delante: un reto
-- ARCHIVADO no admite propuestas de ninguna clase. Estaba dentro de `reto_admite_criterios`
-- —que excluye `archivado` entre otros—, y sacarlo a su propia línea es lo que evita que C2
-- pierda el suelo al salir de aquella. El servicio ya lo comprueba antes de llamar; esto es
-- el suelo, para cualquier otra escritura.

CREATE OR REPLACE FUNCTION public.propuesta_ai_revision_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- Pre-chequeo anti-oráculo: para quien no es miembro del workspace declarado no hay
  -- nada que auditar ni que serializar — la política rechaza la escritura como siempre.
  -- (El seed y los backfills corren como owner sin contexto y también lo saltan.)
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- RF-09.5: el material de personas no se procesa sin consentimiento registrado
    -- ANTES. El servicio lo comprueba antes de construir el prompt —ahí es donde se
    -- evita de verdad la fuga al proveedor— y esto es el suelo: una propuesta derivada
    -- de material sin consentimiento no puede EXISTIR, venga de donde venga la
    -- escritura. Y exige que el consentimiento cubra el procesamiento externo: haber
    -- autorizado la grabación no es haber autorizado mandarla a un tercero.
    -- Se mira el registro VIGENTE, no «si existe alguno»: un permiso solo para uso interno
    -- no desbloquea, uno externo posterior sí, y una revocación futura vuelve a bloquear.
    if new.item_id is not null and exists (
      select 1 from item_importacion i
      where i.id = new.item_id and i.workspace_id = new.workspace_id
        and tipo_fuente_exige_consentimiento(i.tipo_fuente)
        and not consentimiento_externo_vigente(i.id, i.workspace_id)
    ) then
      raise exception 'ese material exige consentimiento registrado para procesamiento externo antes de generar propuestas AI (RF-09.5)';
    end if;

    -- Y no puede haber extracción de un item sin material que extraer: una evidencia
    -- fechada y citada derivada solo de la ficha (título y referencia) sería inventada por
    -- construcción, no por casualidad. El servicio lo corta antes de gastar la llamada;
    -- esto es el suelo para cualquier otra escritura.
    if new.item_id is not null and exists (
      select 1 from item_importacion i
      where i.id = new.item_id and i.workspace_id = new.workspace_id
        and not item_tiene_material_extraible(i.contenido)
    ) then
      raise exception 'ese item no tiene material que citar (solo referencia): no se pueden generar propuestas de extracción sobre él';
    end if;

    -- El ANCLA tiene que seguir admitiendo la propuesta en el momento de escribirla. Todo
    -- lo que el servicio comprobó antes de llamar al proveedor lleva ya una transacción
    -- commiteada de retraso: entre medias otro curador pudo curar el item a mano o aprobar
    -- el G0 del reto. Sin esto nacía una propuesta obsoleta — pendiente en el panel y
    -- rechazada por la materialización— que solo se podía tirar.
    if new.item_id is not null and not exists (
      select 1 from item_importacion i
      where i.id = new.item_id and i.workspace_id = new.workspace_id
        and i.estado = 'pendiente'
    ) then
      raise exception 'ese item de la bandeja ya fue decidido: no admite propuestas nuevas';
    end if;
    -- Un reto ARCHIVADO no admite propuestas de NINGUNA clase: ahí el trabajo se cerró.
    -- Va por delante y por separado de la puerta de los criterios porque es lo único de
    -- aquella condición que hablaba del RETO y no de los criterios; sin sacarlo aquí, C2 se
    -- quedaba sin este suelo al salir de ella.
    if new.reto_id is not null and exists (
      select 1 from reto r
      where r.id = new.reto_id and r.workspace_id = new.workspace_id
        and r.estado = 'archivado'
    ) then
      raise exception 'ese reto está archivado: no admite propuestas AI nuevas';
    end if;
    -- Y la puerta de los criterios, por DESTINO y no por ancla. Escrita como «toda
    -- propuesta que cuelgue de un reto» era exacta mientras solo C0 colgara de ahí; con C2
    -- colgando del mismo reto pasaba a decir que un G0 aprobado —que congela los CRITERIOS
    -- (SYS-22)— prohíbe también proponer INSIGHTS, y que un reto `en-medicion` o `cerrado`
    -- tampoco los admite. Medido sobre un reto en medición: `reto_admite_criterios` da
    -- false, así que el INSERT de C2 moría ahí, DESPUÉS de pagar la llamada.
    --
    -- Es el mismo conjunto de filas para C0 —`propuesta_ai_destino_c0` ata C0 ⇔
    -- criterio-exito—, así que su comportamiento no cambia; y quien materialice un criterio
    -- mañana hereda la puerta por materializarlo, no por dónde cuelga. `destino` es
    -- anulable desde CT y `null = 'criterio-exito'` da null, que no dispara: correcto, una
    -- capacidad informativa no crea criterios.
    if new.destino = 'criterio-exito' and (
      reto_criterios_congelados(new.reto_id, new.workspace_id)
      or not reto_admite_criterios(new.reto_id, new.workspace_id)
    ) then
      raise exception 'ese reto ya no admite criterios nuevos: o su G0 los congeló, o su registry de medición está firmado, o el reto avanzó más allá de candidato/activo';
    end if;

    -- La llamada referenciada tiene que ser LA QUE PRODUJO esta propuesta, no una
    -- cualquiera del workspace. La FK sola comprobaba existencia y tenant, así que por SQL
    -- crudo se podía colgar una extracción de una llamada C0, de otra ancla, de otro modelo
    -- o —lo peor para el libro— de un intento que terminó en negativa o sin respuesta: el
    -- panel atribuiría entonces un coste y una latencia que no son los suyos, y el gasto
    -- por capacidad dejaría de cuadrar. Se exige la coincidencia completa.
    --
    -- Y dicho para que nadie lo lea de más: esto empareja METADATOS, no contenido. Que el
    -- `contenido` sea lo que un modelo devolvió NO es comprobable desde aquí, y no por
    -- falta de ganas: la base no es parte de la llamada HTTP, así que no tiene ningún hecho
    -- propio sobre la respuesta. Guardar un digest de la respuesta en `llamada_ai` no lo
    -- arreglaría — lo escribiría el MISMO rol, en el MISMO acto, con el MISMO grant que
    -- escribe el contenido, así que un escritor que fabrica el contenido fabrica también su
    -- huella y las dos afirmaciones se sostienen entre sí sin que ninguna se apoye en nada.
    -- La diferencia con el linaje de materialización es exacta y vale la pena tenerla clara:
    -- allí el hecho que ata (`evidencia.propuesta_ai_id`) lo produce el GUARD, que es parte
    -- de confianza y está fuera de todo grant; aquí el hecho tendría que producirlo el
    -- proveedor, que no escribe en esta base. Un digest añadiría ceremonia, no garantía.
    --
    -- Así que `contenido` pertenece al mismo conjunto declarado que `modelo`,
    -- `prompt_version`, `tokens_*`, `costo_usd` y `latencia_ms`: lineage y medidas que solo
    -- existen porque la aplicación las anota. Lo que SÍ se ata queda atado —la llamada
    -- (arriba), su unicidad para CI (índice parcial), el consentimiento bajo el que salió
    -- (FK compuesta con la constante dentro) y el objeto materializado (relación + xmin +
    -- proyección)—, y lo que no se puede atar se dice, en vez de blindarse en falso.
    if not exists (
      select 1 from llamada_ai l
      where l.id = new.llamada_id and l.workspace_id = new.workspace_id
        and l.capacidad = new.capacidad
        and l.item_id is not distinct from new.item_id
        and l.reto_id is not distinct from new.reto_id
        and l.modelo = new.modelo
        and l.origen_key = new.origen_key
        and l.resultado = 'salida-valida'
    ) then
      raise exception 'la propuesta debe colgar de la llamada que la produjo: misma capacidad, misma ancla, mismo modelo, misma credencial y con salida válida';
    end if;

    -- RF-09.9: de qué workspace salió qué material, a qué modelo y con qué credencial.
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'PropuestaAIGenerada',
      jsonb_build_object('propuestaId', new.id, 'capacidad', new.capacidad,
                         'destino', new.destino, 'modelo', new.modelo,
                         'promptVersion', new.prompt_version, 'origenKey', new.origen_key,
                         'esSimulacion', new.es_simulacion),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
    return new;
  end if;

  if new.estado = old.estado then
    return new;
  end if;
  -- Ciclo de vida de sentido único: de pendiente a una decisión, y ahí termina.
  if (old.estado, new.estado) not in (
    ('propuesta', 'aceptada'),
    ('propuesta', 'corregida'),
    ('propuesta', 'rechazada')
  ) then
    raise exception 'transición de propuesta AI ilegal: % → %', old.estado, new.estado;
  end if;

  -- El sello temporal lo pone la BASE, no el caller: una revisión no se retro ni
  -- post-data por SQL directo.
  new.revisada_en := now();

  -- SYS-17: la propuesta original se conserva SIEMPRE. No hay grant de UPDATE sobre la
  -- columna, pero el invariante se defiende también aquí (un grant futuro no lo rompe).
  if new.contenido_original is distinct from old.contenido_original then
    raise exception 'la propuesta AI original se conserva siempre (SYS-17)';
  end if;
  -- Aceptar es aceptar LO PROPUESTO; editar es corregir, y se llama por su nombre para
  -- que la tasa de corrección humana no se pueda maquillar.
  if new.estado <> 'corregida' and new.contenido is distinct from old.contenido then
    raise exception 'aceptar o rechazar no edita la propuesta: usa la corrección';
  end if;
  if new.estado = 'corregida' and new.contenido is not distinct from old.contenido then
    raise exception 'una corrección debe cambiar el contenido propuesto';
  end if;
  -- Las CITAS no se corrigen (SYS-17/RF-08.7). Son el testimonio del modelo sobre lo que
  -- dijo haber leído y la entrada de la medida de grounding: cambiar una cita inventada por
  -- otra literal deja una propuesta de aspecto impecable y borra la señal que hay que ver.
  -- El servicio lo rechaza con su mensaje; esto es el suelo, porque una promesa que solo
  -- vive en un formulario la rompe cualquier cliente que hable con la server function.
  -- Sin condicionar al destino: desde que C0 también cita —I4 dice «la AI propone Y CITA»—
  -- la regla es de las citas y no del tipo de propuesta. Atarla a 'evidencia' habría dejado
  -- las de C0 editables el mismo día que existieron. Y con ellas viaja la confianza que el
  -- modelo declaró sobre su propia propuesta: es el dato que ORDENA la revisión humana, así
  -- que dejar que la reescriba quien revisa sería maquillar la medida con la mano que se
  -- está midiendo.
  if new.contenido -> 'citas' is distinct from new.contenido_original -> 'citas'
     or new.contenido -> 'confianzaPropuesta'
        is distinct from new.contenido_original -> 'confianzaPropuesta' then
    raise exception 'las citas y la confianza declarada de una propuesta AI no se corrigen: son el rastro de lo que el modelo dijo y con lo que se ordena la revisión';
  end if;

  -- RF-09.4/09.5 en la ACEPTACIÓN, que es la otra mitad del permiso. Generar ya exigía
  -- consentimiento vigente, pero entre generar y revisar la persona puede retirarlo: la
  -- propuesta ya existe legítimamente (nació cuando el permiso valía) y lo que no puede
  -- ocurrir es que el workspace gane un objeto de dominio NUEVO derivado de un material
  -- que ya no está autorizado. Rechazarla sigue permitido —es la salida— y la curaduría a
  -- mano de la bandeja no se toca: eso no manda nada a ningún tercero (SYS-21).
  if new.estado in ('aceptada', 'corregida') and new.item_id is not null and exists (
    select 1 from item_importacion i
    where i.id = new.item_id and i.workspace_id = new.workspace_id
      and tipo_fuente_exige_consentimiento(i.tipo_fuente)
      and not consentimiento_externo_vigente(i.id, i.workspace_id)
  ) then
    raise exception 'el consentimiento de ese material ya no autoriza el procesamiento externo: la propuesta no puede materializarse (RF-09.5)';
  end if;

  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (new.workspace_id,
    case new.estado
      when 'aceptada' then 'PropuestaAIAceptada'
      when 'corregida' then 'PropuestaAICorregida'
      else 'PropuestaAIRechazada'
    end,
    -- El objeto materializado, POR SU COLUMNA, y ahora las tres. `insight_id` faltaba y
    -- `jsonb_strip_nulls` se lleva las otras dos por nulas, así que el evento de una
    -- aceptación de C2 no decía QUÉ insight se creó: un registro append-only que no puede
    -- nombrar el objeto que documenta no documenta nada. Es la misma enumeración corta de
    -- siempre, esta vez en la bitácora.
    jsonb_strip_nulls(jsonb_build_object(
      'propuestaId', new.id, 'capacidad', new.capacidad, 'destino', new.destino,
      'modelo', new.modelo, 'evidenciaId', new.evidencia_id, 'criterioId', new.criterio_id,
      'insightId', new.insight_id)),
    app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $function$;


-- ── La MATERIALIZACIÓN de un objeto compuesto ──
--
-- Aceptar una propuesta de C2 no crea una fila: crea un `insight` con sus `afirmacion`, cada
-- una con sus `cita`, y sus `contradiccion`. El suelo que sujeta a la evidencia y al criterio
-- —procedencia por `xmin`, paridad con lo propuesto y sello de origen imborrable— tenía que
-- extenderse a los tres, y no estaba: medido contra la base, ANTES de tocar nada, C2 no podía
-- materializar de tres maneras distintas y ninguna se veía desde TypeScript.
--
-- 1) `insight` no tenía columna de procedencia. `evidencia` y `criterio_exito` sí, fuera de
--    todo grant, y el guard es quien las escribe. Sin ella no hay dónde estampar de qué
--    propuesta viene un insight, que es la mitad permanente de SYS-19.
alter table insight add column propuesta_ai_id uuid;
alter table insight add
  foreign key (propuesta_ai_id, workspace_id) references propuesta_ai (id, workspace_id);
-- Un insight cuelga de UNA propuesta como mucho. El índice parcial es lo que convierte el
-- sello en irrepetible: el `update … where propuesta_ai_id is null` del guard no pisa un
-- sello previo y el conteo de filas lo rechaza.
create unique index insight_propuesta_ai_idx on insight (propuesta_ai_id)
  where propuesta_ai_id is not null;
-- Sin GRANT: la aplicación no escribe esta columna por ningún camino, igual que las otras dos.

-- 2) «Aceptada ⇔ hay objeto» enumeraba DOS objetos:
--
--      check ((estado in ('aceptada','corregida')) = (coalesce(evidencia_id, criterio_id) is not null))
--
--    Un insight no está en esa cuenta, así que una propuesta de C2 aceptada la rechazaba el
--    CHECK: la mitad izquierda cierta y la derecha falsa. La misma enumeración corta que el
--    vocabulario de destinos, en otro sitio.
--
--    Se rehace con `num_nonnulls(…) = 1`, que es el idioma que ya usa `propuesta_ai_un_ancla`
--    para lo mismo. No es más estricto que lo que había: los tres `propuesta_ai_objeto_*` atan
--    cada objeto a su destino y `destino` es un solo valor, así que dos objetos a la vez ya era
--    imposible; «al menos uno» y «exactamente uno» describen hoy el mismo conjunto de filas.
alter table propuesta_ai drop constraint propuesta_ai_check9;
alter table propuesta_ai add constraint propuesta_ai_objeto_materializado
  check ((estado in ('aceptada', 'corregida'))
         = (num_nonnulls(evidencia_id, criterio_id, insight_id) = 1));

-- 3) Y el guard de materialización, que cerraba con un `else` binario. Lo demás va comentado
--    dentro de la función, junto a cada regla.

CREATE OR REPLACE FUNCTION public.propuesta_ai_materializacion_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_filas integer;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return null;
  end if;
  if new.estado not in ('aceptada', 'corregida') then
    return null;
  end if;
  if new.destino = 'evidencia' and not exists (
    select 1 from item_importacion i
    where i.id = new.item_id and i.workspace_id = new.workspace_id
      and i.estado = 'aprobado'
      and i.evidencia_id = new.evidencia_id
      and i.decidido_por = new.revisada_por) then
    raise exception 'aceptar una extracción sella su item de la bandeja con esa misma evidencia y el mismo humano (SYS-16)';
  end if;
  if new.destino = 'criterio-exito' and not exists (
    select 1 from criterio_exito c
    where c.id = new.criterio_id and c.workspace_id = new.workspace_id
      and c.reto_id = new.reto_id
      and c.creado_por = new.revisada_por) then
    raise exception 'el criterio materializado cuelga del reto de la propuesta y lo firma quien aceptó (SYS-19)';
  end if;

  -- ── PROCEDENCIA, que no es lo mismo que PARECIDO ──
  -- Los dos bloques de arriba son PREDICADOS: dicen que existe un objeto que encaja con la
  -- forma esperada (el item apunta a esa evidencia, el criterio cuelga de ese reto, los dos
  -- firmados por quien aceptó). Un predicado lo satisface cualquier objeto que dé la talla,
  -- incluido uno que ya existía. Con el SQL del rol de aplicación eso bastaba para atribuir
  -- a la AI algo hecho a mano: aprobar el item por su cuenta y DESPUÉS marcar aceptada la
  -- propuesta pendiente colgándole esa evidencia preexistente.
  --
  -- Lo que hace falta es una PROCEDENCIA: que el objeto haya nacido de ESTA aceptación. Y
  -- eso sí es comprobable sin guardar nada, porque la transacción es la unidad de trabajo
  -- de la materialización: `xmin` es la transacción que insertó la fila, y aquí —dentro del
  -- constraint trigger diferido, o sea todavía dentro de la transacción que acepta—
  -- `pg_current_xact_id()` es la nuestra. Si no coinciden, ese objeto lo creó otro y la
  -- propuesta se lo está apropiando.
  --
  -- Por qué importa más que una fila rara: lo que queda mal atribuido es que un objeto
  -- CURADO A MANO conste como materializado por la AI, y de eso viven las dos lecturas del
  -- método — el rastro de quién produjo qué (SPEC-08) y la tasa de corrección humana, que
  -- SPEC-09 usa como señal de calidad barata frente al coste de los evals. Una atribución
  -- falsa no ensucia una fila: mueve una métrica de calidad de la AI, y hacia el lado
  -- optimista (entra como `aceptada`, que es «la AI acertó a la primera»).
  if new.destino = 'evidencia' and not exists (
    select 1 from evidencia e
    where e.id = new.evidencia_id and e.workspace_id = new.workspace_id
      and e.xmin = pg_current_xact_id()::xid) then
    raise exception 'la evidencia materializada tiene que haberla creado esta misma aceptación: una propuesta no puede apropiarse de evidencia que ya existía (SYS-19)';
  end if;
  if new.destino = 'criterio-exito' and not exists (
    select 1 from criterio_exito c
    where c.id = new.criterio_id and c.workspace_id = new.workspace_id
      and c.xmin = pg_current_xact_id()::xid) then
    raise exception 'el criterio materializado tiene que haberlo creado esta misma aceptación: una propuesta no puede apropiarse de un criterio que ya existía (SYS-19)';
  end if;
  -- El insight, igual — y con una vuelta más, porque es el primer objeto COMPUESTO: no basta
  -- con que la cabecera sea nuestra. Las afirmaciones y las citas son el insight; una
  -- cabecera recién creada con las afirmaciones de otro sitio diría lo mismo por dentro y
  -- constaría igual de materializada. Se exige que TODA la descendencia haya nacido en esta
  -- misma transacción.
  if new.destino = 'insight' and not exists (
    select 1 from insight i
    where i.id = new.insight_id and i.workspace_id = new.workspace_id
      and i.xmin = pg_current_xact_id()::xid) then
    raise exception 'el insight materializado tiene que haberlo creado esta misma aceptación: una propuesta no puede apropiarse de un insight que ya existía (SYS-19)';
  end if;
  if new.destino = 'insight' and exists (
    select 1 from afirmacion a
    where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id
      and (a.xmin <> pg_current_xact_id()::xid
        or exists (select 1 from cita c
          where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            and c.xmin <> pg_current_xact_id()::xid))) then
    raise exception 'las afirmaciones y las citas del insight materializado tienen que haber nacido en esta misma aceptación (SYS-19)';
  end if;
  if new.destino = 'insight' and exists (
    select 1 from contradiccion c
    where c.insight_id = new.insight_id and c.workspace_id = new.workspace_id
      and c.xmin <> pg_current_xact_id()::xid) then
    raise exception 'las contradicciones del insight materializado tienen que haber nacido en esta misma aceptación (SYS-19)';
  end if;


  -- ── El consentimiento, en el ÚLTIMO instante ──
  -- El guard de revisión ya lo exige, pero es un trigger BEFORE UPDATE: su snapshot es el
  -- de la sentencia que sella, así que una revocación que commitea DESPUÉS de esa sentencia
  -- y antes de que commitee la aceptación no la ve nadie — y la evidencia entra con la
  -- revocación ya vigente. Aquí, en el commit, sí se ve: cada sentencia de plpgsql toma su
  -- propio snapshot en READ COMMITTED. Es el mismo argumento por el que este guard es el
  -- suelo del ciclo de vida del reto, aplicado al otro eje que también caduca solo.
  --
  -- El servicio toma además `designio:consentimiento:<item>`, el mismo candado que toma
  -- registrar un consentimiento, para que el orden sea determinista y el revisor reciba el
  -- error con nombre en vez de un rechazo del suelo. Pero el candado NO es lo que cierra la
  -- ventana —el SQL directo no lo pide—: lo cierra esto.
  if new.destino = 'evidencia' and exists (
    select 1 from item_importacion i
    where i.id = new.item_id and i.workspace_id = new.workspace_id
      and tipo_fuente_exige_consentimiento(i.tipo_fuente)
      and not consentimiento_externo_vigente(i.id, i.workspace_id)) then
    raise exception 'el consentimiento de ese material ya no autoriza el procesamiento externo: la propuesta no puede materializarse (RF-09.5)';
  end if;
  -- Y el reto tiene que SEGUIR admitiendo criterios al aceptar, que no es lo mismo que el
  -- congelado por G0 y no lo cubre ninguna política de `criterio_exito`. El ciclo de vida
  -- del reto avanza solo: `candidato → archivado` es una transición legal, igual que
  -- `activo → en-medicion → cerrado`. El guard del INSERT exige este mismo predicado al
  -- nacer la propuesta, pero entre nacer y aceptarse caben días — sin esto, aceptar colgaba
  -- un criterio de un reto que ya no lo admite: un contrato de medición para algo que nadie
  -- va a medir.
  --
  -- Que sea DIFERIDO es lo que lo vuelve suelo de verdad para ese hueco: corre en el commit,
  -- o sea en el último instante posible, y ve la transición ajena ya commiteada. Y rechazar
  -- sigue abierto —el `return null` de arriba deja pasar todo lo que no es aceptación—:
  -- una propuesta obsoleta se cierra rechazándola, y bloquear también esa salida dejaría la
  -- fila muerta y su ancla retenida para siempre.
  if new.destino = 'criterio-exito'
     and not reto_admite_criterios(new.reto_id, new.workspace_id) then
    raise exception 'ese reto ya no admite criterios nuevos: solo los admite mientras es candidato o está activo';
  end if;
  -- Sin fecha no hay proveniencia que escribir, así que una extracción sin fechar no se
  -- materializa: el modelo tiene permitido decir «el material no la trae» —para eso existe
  -- el par fecha/motivo— y ponerla es entonces trabajo del humano al corregir (I4). El
  -- servicio lo dice con el motivo que dio el modelo; esto es el suelo, y va antes de la
  -- proyección para que el mensaje sea el de la causa y no el genérico.
  if new.destino = 'evidencia' and new.contenido ->> 'fecha' is null then
    raise exception 'esa propuesta no trae fecha del material: una evidencia se sitúa en el tiempo, así que hay que fecharla al corregir antes de aceptarla';
  end if;

  -- LA PROYECCIÓN: los campos que la propuesta dicta, el objeto los lleva TAL CUAL. Es lo
  -- que convierte «nació en esta transacción» en «salió de esta propuesta», y lo que impide
  -- el caso que el `xmin` solo no veía: una evidencia escrita a mano, sellada en el mismo
  -- commit, atribuida a una propuesta con la que no tiene nada que ver.
  --
  -- Se compara contra `contenido` y NUNCA contra `contenido_original`, y ahí está la razón
  -- de que esto no rompa la corrección: corregir reescribe `contenido` en la MISMA sentencia
  -- que dispara este guard, así que el objeto materializado coincide con lo corregido y la
  -- fila sale `corregida` — que es justo lo que hay que poder medir. Exigir lo original sí
  -- convertiría cada enmienda en un fallo, y aprobar incluye enmendar (I4).
  --
  -- Solo los campos COPIADOS literalmente, no los derivados: `dimensiones` mezcla lo que
  -- dice la propuesta con lo que dicen el item y la bitácora de consentimiento, así que
  -- compararla entera ataría este guard al mapeo del servicio y se rompería a la primera
  -- que alguien añada una dimensión.
  --
  -- Y la lista NO se detiene en el borde de la columna: dentro de `dimensiones` hay claves
  -- que también vienen verbatim de la propuesta, y dejarlas fuera dejaba el mismo agujero
  -- abierto para ellas. De dónde sale CADA clave del jsonb, que es lo que hay que mirar
  -- antes de añadir una dimensión nueva:
  --
  --   · de la PROPUESTA (y por tanto se comparan aquí):
  --       proveniencia.fecha, metodo.recoleccion, metodo.derivada,
  --       calidad.confianza, derechos.confidencialidad
  --   · del LINEAGE de la propia fila (columnas `modelo` y `prompt_version`, no `contenido`):
  --       lineage.modelo, lineage.promptVersion  — se comparan también, porque afirman por
  --       qué modelo pasó esta evidencia y eso es exactamente lo que SYS-19 exige que sea
  --       cierto
  --   · del ITEM de la bandeja (no se comparan: la propuesta no los dice):
  --       proveniencia.tipoFuente, proveniencia.localizacion
  --   · de la BITÁCORA de consentimiento (no se compara, y a propósito: los derechos no los
  --     propone la AI):
  --       derechos.consentimiento
  --   · constantes de la materialización (no se comparan):
  --       metodo.segmentoIds, calidad.corroboraIds, calidad.contradiceIds
  --
  -- Una dimensión nueva que venga del item o del consentimiento no rompe nada porque no
  -- está en la lista; una que venga de la propuesta hay que añadirla, que es justo la
  -- decisión que conviene que alguien tome a conciencia.
  if new.destino = 'evidencia' and not exists (
    select 1 from evidencia e
    where e.id = new.evidencia_id and e.workspace_id = new.workspace_id
      and e.titulo = new.contenido->>'titulo'
      and e.resumen = new.contenido->>'resumen'
      and e.es_estado_actual = (new.contenido->>'esEstadoActual')::boolean
      and e.dimensiones#>>'{proveniencia,fecha}' = new.contenido->>'fecha'
      and e.dimensiones#>>'{metodo,recoleccion}' = new.contenido->>'recoleccion'
      and e.dimensiones#>>'{metodo,derivada}' = new.contenido->>'derivada'
      and e.dimensiones#>>'{calidad,confianza}' = new.contenido->>'confianza'
      and e.dimensiones#>>'{derechos,confidencialidad}' = new.contenido->>'confidencialidad'
      and e.dimensiones#>>'{lineage,modelo}' = new.modelo
      and e.dimensiones#>>'{lineage,promptVersion}' = new.prompt_version) then
    raise exception 'la evidencia materializada no dice lo que dice la propuesta: el título, el resumen, «es estado actual», la fecha, la recolección, si es derivada, la confianza, la confidencialidad y el lineage se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;
  -- El insight dice lo que dice la propuesta, y eso incluye su ESTRUCTURA: la cabecera, y
  -- después afirmación por afirmación —en el mismo orden, con el mismo texto y la misma marca
  -- de hipótesis— y cita por cita dentro de cada una. Comparar solo el título y el resumen
  -- habría dejado pasar un insight con otras afirmaciones bajo la misma cabecera, que es
  -- donde vive todo lo que se puede contrastar contra la evidencia.
  --
  -- La comparación es POSICIONAL (`with ordinality` contra el índice del array), igual que la
  -- que hace `propuesta_ai_c2_citas_guard` sobre las citas: reordenar es cambiar, porque
  -- `afirmacion` tiene único `(insight_id, orden)` y el orden es parte del objeto.
  if new.destino = 'insight' and not exists (
    select 1 from insight i
    where i.id = new.insight_id and i.workspace_id = new.workspace_id
      and i.titulo = new.contenido->>'titulo'
      and i.resumen = new.contenido->>'resumen') then
    raise exception 'el insight materializado no dice lo que dice la propuesta: el título y el resumen se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;
  if new.destino = 'insight' and (
    (select count(*) from afirmacion a
      where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id)
    <> jsonb_array_length(new.contenido->'afirmaciones')
    or exists (
      select 1
      from jsonb_array_elements(new.contenido->'afirmaciones') with ordinality as p(af, pos)
      where not exists (
        select 1 from afirmacion a
        where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id
          and a.orden = pos::integer - 1
          and a.texto = p.af->>'texto'
          and a.es_hipotesis = (p.af->>'esHipotesis')::boolean
          and (select count(*) from cita c
                where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id)
              = jsonb_array_length(p.af->'citas')
          and not exists (
            select 1 from jsonb_array_elements(p.af->'citas') as q(ci)
            where not exists (
              select 1 from cita c
              where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
                and c.evidencia_id::text = q.ci->>'evidenciaId'
                and c.fragmento = q.ci->>'fragmento'
                and c.localizacion = q.ci->>'localizacion'))))) then
    raise exception 'las afirmaciones y las citas del insight materializado no dicen lo que dice la propuesta: se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;
  -- Y las CONTRADICCIONES, que son parte del insight y no un adorno.
  --
  -- La comprobación de arriba cubría la cabecera, las afirmaciones y sus citas, y dejaba fuera
  -- las contradicciones: con los grants que la aplicación tiene, quien escriba por SQL podía
  -- omitirlas o cambiarlas y sellar la propuesta como aceptada igual. Y son justamente la
  -- parte que más tienta omitir —es la evidencia que va EN CONTRA—, así que dejarla sin
  -- procedencia rompe la garantía por el sitio en que más importa.
  --
  -- Se comprueba en los dos sentidos: que no falte ninguna de las propuestas y que no sobre
  -- ninguna. `contradiccion` tiene único (insight_id, evidencia_id), así que el recuento basta
  -- para el segundo sentido.
  if new.destino = 'insight' and (
    (select count(*) from contradiccion co
      where co.insight_id = new.insight_id and co.workspace_id = new.workspace_id)
    <> coalesce(jsonb_array_length(new.contenido->'contradicciones'), 0)
    or exists (
      select 1
      from jsonb_array_elements(
             case when jsonb_typeof(new.contenido->'contradicciones') = 'array'
                  then new.contenido->'contradicciones' else '[]'::jsonb end) as p(co)
      where not exists (
        select 1 from contradiccion c
        where c.insight_id = new.insight_id and c.workspace_id = new.workspace_id
          and c.evidencia_id::text = p.co->>'evidenciaId'
          and c.descripcion = p.co->>'descripcion'))) then
    raise exception 'las contradicciones del insight materializado no son las de la propuesta: se copian tal cual, y son la evidencia que va en contra (SYS-19)';
  end if;
  if new.destino = 'criterio-exito' and not exists (
    select 1 from criterio_exito c
    where c.id = new.criterio_id and c.workspace_id = new.workspace_id
      and c.kpi = new.contenido->>'kpi'
      and c.definicion = new.contenido->>'definicion'
      and c.objetivo = new.contenido->>'objetivo'
      and c.ventana_dias = (new.contenido->>'ventanaDias')::integer
      and c.linea_base_plan = new.contenido->>'lineaBasePlan') then
    raise exception 'el criterio materializado no dice lo que dice la propuesta: el KPI, la definición, el objetivo, la ventana y el plan de línea base se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;

  -- Y LA RELACIÓN, estampada aquí porque este es el único sitio que sabe que la
  -- materialización es legítima: la columna está fuera de todo grant, así que la fila queda
  -- diciendo de qué propuesta viene y ningún camino de la aplicación puede escribirlo ni
  -- reescribirlo después. El índice único hace el resto: si el objeto ya cuelga de otra
  -- propuesta, esto no lo pisa —el `where … is null` no lo alcanza— y el conteo de abajo lo
  -- rechaza. Es la versión permanente de lo que el `xmin` solo sostenía dentro del commit.
  --
  -- Una rama POR DESTINO y un `else` que grita, en vez del `else` que sellaba criterios.
  -- Escrito como «evidencia, si no criterio» era exacto con dos destinos y falso con tres:
  -- un insight caía en el `else` y trataba de sellar `criterio_exito` con un `criterio_id`
  -- nulo — cero filas, y el rechazo salía como «ese objeto ya cuelga de otra propuesta»,
  -- que además es mentira. Es el modo de fallo que `ai.schemas.ts` describe para los
  -- ternarios binarios: elegir el `else` en silencio. Aquí ya no se puede: un destino que
  -- nadie selle se nombra y aborta.
  if new.destino = 'evidencia' then
    update evidencia set propuesta_ai_id = new.id
      where id = new.evidencia_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  elsif new.destino = 'criterio-exito' then
    update criterio_exito set propuesta_ai_id = new.id
      where id = new.criterio_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  elsif new.destino = 'insight' then
    update insight set propuesta_ai_id = new.id
      where id = new.insight_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  else
    raise exception 'destino de propuesta AI sin sello de procedencia: % — un destino nuevo tiene que decir qué objeto sella (SYS-19)', coalesce(new.destino, '(sin destino)');
  end if;
  if v_filas <> 1 then
    raise exception 'ese objeto ya cuelga de otra propuesta AI: un objeto materializado tiene una sola procedencia (SYS-19)';
  end if;

  return null;
end $function$;

-- Un objeto materializado cuelga de UNA sola propuesta, como la evidencia y el criterio.
create unique index propuesta_ai_insight_idx on propuesta_ai (workspace_id, insight_id)
  where insight_id is not null;

-- «Un informe por llamada» no aplica: C2 propone un LOTE de insights de una sola llamada, como
-- C0 propone varios criterios. Su techo lo declara `CAPACIDADES.C2.lote` y lo comprueba el
-- servicio al parsear; aquí solo se anota para que no se busque el índice que no está.

-- El suelo de C2: linaje por su ancla. `propuesta_ai_revision_guard` compara `item_id` y
-- `reto_id`, así que el reto YA está comparado y C2 no necesita guard propio para eso — se
-- deja dicho aquí porque la prueba que exige una comparación por columna declarada se
-- satisface con la del guard original, y quien lea esta migración buscando la suya tiene que
-- encontrar la razón de que no exista.

grant insert (insight_id) on propuesta_ai to designio_app;
grant update (insight_id) on propuesta_ai to designio_app;

-- ── El guard: una cita señala evidencia DEL RETO, y las citas no se corrigen ──
--
-- Las dos reglas van juntas porque las dos miran dónde C2 guarda sus citas, que no es donde
-- las guardan las otras tres.
--
-- La primera: cada `evidenciaId` de una cita —y de una contradicción— tiene que estar entre
-- las evidencias que el reto alcanza por sus arquetipos, que son las que se le enseñaron al
-- modelo. La FK compuesta ya garantiza que existe y que es del tenant; lo que falta es que
-- sea del ALCANCE. Una cita a una evidencia ajena manda a quien revisa a buscar un sostén
-- donde no está, y es lo único de la salida de C2 que se puede contrastar contra algo: el
-- fragmento y la localización son texto.
--
-- La segunda: `propuesta_ai_revision_guard` prohíbe corregir las citas comparando
-- `contenido -> 'citas'`. Las de C2 viven DENTRO de cada afirmación, así que esa comparación
-- da null contra null —iguales— y la regla pasaría EN VACÍO: las citas de C2 serían
-- editables, borrando justo la señal que la corrección no puede tocar. Se compara donde están.
--
-- La comparación es POSICIONAL (`jsonb_path_query_array` conserva el orden), así que reordenar
-- las afirmaciones también se rechaza. Es lo correcto: lo que se acepta es lo que se vio, y
-- `afirmacion` tiene único `(insight_id, orden)` — mover una afirmación mueve su sitio en el
-- objeto materializado.
create or replace function propuesta_ai_c2_citas_guard() returns trigger
language plpgsql as $$
declare
  senalada text;
  motivo text;
begin
  if new.capacidad <> 'C2' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if jsonb_path_query_array(new.contenido, '$.afirmaciones[*].citas')
       is distinct from jsonb_path_query_array(new.contenido_original, '$.afirmaciones[*].citas')
    then
      raise exception 'las citas de una propuesta AI no se corrigen: son el rastro de lo que el modelo dijo haber leído';
    end if;
    -- Y LAS CONTRADICCIONES TAMPOCO, por lo mismo y por una razón propia.
    --
    -- Por lo mismo: son testimonio del modelo sobre evidencia que ha leído, igual que una
    -- cita, y señalan un documento por su id — o sea, es la otra mitad de su salida que se
    -- puede contrastar contra algo.
    --
    -- Y por lo suyo: una contradicción es la evidencia que va EN CONTRA del insight. I4 pide
    -- señalarla precisamente porque esconderla es la manera más limpia de vender una
    -- conclusión, así que dejar que quien revisa la reescriba o la borre al «corregir» sería
    -- devolverle esa manera con otro nombre. Se lee y se decide con ella delante; si no se
    -- sostiene, la salida es rechazar el insight entero.
    --
    -- La comprobación tenía además un agujero de alcance: este guard salía por aquí antes de
    -- llegar al barrido de evidencia ajena de abajo, así que una corrección podía cambiar el
    -- `evidenciaId` de una contradicción por CUALQUIER evidencia del workspace —`contradiccion`
    -- solo tiene la FK del tenant— y la aceptación la materializaba. Prohibir el cambio cierra
    -- las dos cosas con una sola regla, en vez de repetir el barrido.
    if new.contenido -> 'contradicciones'
       is distinct from new.contenido_original -> 'contradicciones'
    then
      raise exception 'las contradicciones de un insight no se corrigen: son la evidencia que va en contra, y esconderla es la manera más limpia de vender una conclusión';
    end if;
    return new;
  end if;

  -- Dos motivos por los que una cita no puede nacer, y un solo barrido para los dos.
  --
  --  · AJENA: señala evidencia que no cuelga de los arquetipos de este reto. Es una regla de
  --    PROVENIENCIA y no cambia nunca: lo que no es del reto no lo será mañana.
  --
  --  · NO CITABLE: el derecho de uso de esa evidencia ya no autoriza citarla al cliente
  --    —se retiró, caducó o nunca se concedió—. Es una regla TEMPORAL, y por eso hay que
  --    leerla aquí y no darla por leída antes: `PREPARAR.C2` solo enseña al modelo evidencia
  --    usable y `REVALIDAR.C2` vuelve a comprobar el material entero antes de despachar, pero
  --    entre el despacho y esta escritura pasa la llamada al proveedor, que es exactamente el
  --    hueco que ningún candado puede cubrir. Sin esta lectura nacía una propuesta que
  --    `materializarInsight` iba a rechazar SIEMPRE con DR001 al insertar la cita: quien
  --    revisa se encontraba una tarjeta aceptable que no se deja aceptar, con un código de
  --    error por toda explicación.
  --
  --    Es la misma regla que el suelo de CI —«el guard lee el registro VIGENTE, así que la
  --    propuesta no llega a existir aunque el proveedor ya hubiera respondido»— escrita para
  --    lo que C2 lee: allí es el consentimiento del item, aquí el derecho de uso de cada
  --    evidencia citada.
  --
  -- El MOTIVO viaja con el hallazgo en vez de un booleano suelto, y hace además el trabajo
  -- que hacía `hallada`: una cita sin `evidenciaId` la selecciona el `not exists` y deja el
  -- valor en null, así que preguntar por el valor no dispararía — admitiendo justo lo que se
  -- rechaza. `motivo` solo es null cuando no hubo fila.
  select
    coalesce(citas.x, '(sin evidenciaId)'),
    case
      when not exists (
        select 1
        from arquetipo a
        join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
        where a.reto_id = new.reto_id and a.workspace_id = new.workspace_id
          and ae.evidencia_id::text = lower(citas.x))
      then 'ajena'
      else 'no-citable'
    end
  into senalada, motivo
  from (
    select h->>'evidenciaId' as x
    from jsonb_path_query(
           new.contenido, '$.afirmaciones[*].citas[*]') h
    union all
    select h->>'evidenciaId'
    from jsonb_array_elements(
           case when jsonb_typeof(new.contenido->'contradicciones') = 'array'
                then new.contenido->'contradicciones' else '[]'::jsonb end) h
  ) citas
  where not exists (
    select 1
    from arquetipo a
    join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
    where a.reto_id = new.reto_id and a.workspace_id = new.workspace_id
      and ae.evidencia_id::text = lower(citas.x))
     or not exists (
    select 1 from evidencia e
    where e.id::text = lower(citas.x) and e.workspace_id = new.workspace_id
      and evidencia_usable(e.id, e.workspace_id, 'cliente'))
  limit 1;
  if motivo = 'ajena' then
    raise exception
      'una cita del insight señala evidencia que no es de este reto: %', senalada;
  elsif motivo = 'no-citable' then
    raise exception
      'una cita del insight señala evidencia que ya no se puede citar al cliente (su derecho de uso se retiró, caducó o el documento ya no está): %. La propuesta se descarta; si el derecho vuelve, vuelve a pedirla.',
      senalada;
  end if;
  return new;
end $$;

revoke execute on function propuesta_ai_c2_citas_guard() from public;

create trigger a_propuesta_ai_c2_citas
  before insert or update of contenido on propuesta_ai
  for each row execute function propuesta_ai_c2_citas_guard();

-- ── La EXCLUSIÓN por ancla también era «una capacidad por columna» ──
--
-- Los índices que impiden dos trabajos a la vez sobre el mismo objeto están por COLUMNA:
--
--   unique (workspace_id, reto_id) where reto_id is not null   -- reserva_ai
--
-- Con una capacidad por columna eso decía «no se paga dos veces por el mismo objeto», que es
-- lo que se quería. Con C2 colgando del mismo reto que C0 pasa a decir otra cosa: que pedir
-- insights y pedir criterios sobre el mismo reto son el MISMO trabajo y no pueden convivir.
-- Medido: con una generación de C0 en vuelo, la reserva de C2 muere en este índice; y con un
-- criterio de C0 esperando revisión, la admisión de C2 la rechaza con el mensaje de C2 («ese
-- reto ya tiene insights propuestos»), que además es falso.
--
-- Son pipelines independientes: lo que C0 tenga pendiente no dice nada sobre si C2 puede
-- proponer. La exclusión pasa a ser por (capacidad, ancla), que es la unidad de trabajo real.
--
-- Se hace en las TRES columnas y no solo en el reto, aunque item y gate tengan hoy una sola
-- capacidad cada uno: la trampa no es del reto, es de escribir la exclusión por columna, y
-- dejar dos así es dejarla puesta para la próxima capacidad que ancle ahí.
drop index reserva_ai_item_idx;
drop index reserva_ai_reto_idx;
drop index reserva_ai_gate_idx;
create unique index reserva_ai_item_idx on reserva_ai (workspace_id, capacidad, item_id)
  where item_id is not null;
create unique index reserva_ai_reto_idx on reserva_ai (workspace_id, capacidad, reto_id)
  where reto_id is not null;
create unique index reserva_ai_gate_idx on reserva_ai (workspace_id, capacidad, gate_id)
  where gate_id is not null;

-- Y lo mismo con «un ancla no admite otra propuesta mientras la suya espera revisión». No hay
-- índice de reto —C0 es un lote, y un lote son varias filas pendientes del mismo reto—, así
-- que ahí la regla vive en la admisión; los de item y gate se reescriben por lo dicho arriba.
drop index propuesta_ai_item_pendiente_idx;
drop index propuesta_ai_gate_pendiente_idx;
create unique index propuesta_ai_item_pendiente_idx
  on propuesta_ai (workspace_id, capacidad, item_id)
  where item_id is not null and estado = 'propuesta';
create unique index propuesta_ai_gate_pendiente_idx
  on propuesta_ai (workspace_id, capacidad, gate_id)
  where gate_id is not null and estado = 'propuesta';
