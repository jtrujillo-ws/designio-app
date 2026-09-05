-- ═══════════════════════════════════════════════════════════════════════════
-- C3 — LA OPORTUNIDAD (HMW) SE PROPONE DESDE LOS INSIGHTS QUE LA SOSTIENEN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SPEC-08 §C3: «Insights validados + criterios del reto → HMW trazables a insights +
-- priorización razonada». La etapa 3 ya tiene su objeto —`oportunidad`, con su traza a
-- insights y su ventana de escritura— y hasta ahora solo se llenaba a mano. C3 lo propone por
-- el pipeline de siempre: el modelo redacta, un humano acepta una a una, y solo entonces
-- existe la fila (SYS-19).
--
-- ── LA TRAZA ES LA CITA, Y ESO ES LA DECISIÓN DE FONDO ──
--
-- Una HMW tiene que trazar a ≥1 insight (SYS-15). Lo evidente sería que el modelo devolviera
-- dos cosas: la lista de insights que la sostienen Y las citas que lo demuestran. Eso son DOS
-- fuentes de verdad para el mismo hecho, y se separan a la primera: una HMW que declara tres
-- insights y cita dos, o que cita uno que no declaró, y entonces hay que decidir cuál gana.
--
-- Aquí no hay dos: `oportunidad_insight` se materializa desde los `insightId` DISTINTOS de las
-- citas. Declarar una traza es citarla. Con eso:
--
--   · SYS-15 sale gratis —≥1 cita ⇒ ≥1 insight— en vez de ser una regla aparte que recordar;
--   · no se puede declarar apoyo en un insight del que no se copió nada, que es exactamente
--     la forma que tiene una traza de ser decorativa;
--   · y la traza hereda la inmutabilidad de las citas (SYS-17): reapuntar el apoyo de una HMW
--     conservando su texto es quedarse con el sostén de A para afirmar sobre B, que es lo que
--     C2 impide con el `evidenciaId` de sus citas y C6 con su `criterioId`.
--
-- Lo corregible es lo que es redacción: la pregunta, la prioridad y su razón. Si el modelo se
-- apoyó en el insight equivocado, eso no se corrige — se rechaza.
--
-- ── EL ANCLA ES EL RETO, LA TERCERA CAPACIDAD QUE COMPARTE ESA COLUMNA ──
--
-- Con C0 y C2. `oportunidad.reto_id` es NOT NULL y el portafolio es del reto, así que el
-- objeto del que sale el material y aquel sobre el que se escribe son el mismo. Cada pieza va
-- por COLUMNA y con lista, que es la forma que C2 estrenó y C6 confirmó:
--
--   equivalencia   `(reto_id is not null) = (capacidad in ('C0','C2','C3'))`
--   destino        'oportunidad', quinto valor del vocabulario
--   objeto         `oportunidad_id`, quinta columna de materialización
--
-- ── LA VENTANA DEL PORTAFOLIO GOBIERNA PROPONER Y ACEPTAR ──
--
-- `reto_admite_portafolio` es la ventana que la migración de la oportunidad escribió UNA vez y
-- que miran sus cuatro políticas. C3 no escribe una segunda: la mira igual, en las mismas tres
-- puertas donde el resto de capacidades miran la suya —al insertar la propuesta, antes de
-- despachar y al materializar— porque entre proponer y aceptar caben días y en esos días se
-- firma G3, que es justo lo que la cierra.

-- ── La columna del objeto materializado ──
alter table propuesta_ai add column oportunidad_id uuid;
alter table propuesta_ai add constraint propuesta_ai_oportunidad_id_workspace_id_fkey
  foreign key (oportunidad_id, workspace_id) references oportunidad (id, workspace_id);
-- ÚNICO, como los de sus cuatro hermanos: una oportunidad la materializa UNA propuesta. Sin
-- esa unicidad, dos propuestas aceptadas podrían reclamar el mismo objeto y la procedencia
-- —de la que viven el rastro de quién produjo qué y la tasa de corrección— dejaría de ser
-- una función.
create unique index propuesta_ai_oportunidad_idx
  on propuesta_ai (workspace_id, oportunidad_id) where oportunidad_id is not null;

-- ── LA MITAD PERMANENTE DE SYS-19: de qué propuesta viene esta oportunidad ──
--
-- Se instala igual que en `evidencia`, `criterio_exito`, `insight` y `entrada_kpi`, y con la
-- misma precaución que cobró el penúltimo: el `grant insert` de TABLA cubre las columnas
-- futuras, así que añadir ésta se la regalaría al llamante y el vínculo dejaría de ser
-- vínculo — una procedencia falsificable y, de paso, la plaza única del índice ocupada por
-- una HMW escrita a mano. Aquí el grant de la oportunidad ya era POR COLUMNAS, así que no hay
-- que retirar nada; queda dicho porque la próxima tabla puede no tenerlo.
--
-- Su falta la cazó una sonda antes de que existiera ninguna: el guard de procedencia despacha
-- por destino y su `else` NOMBRA al que nadie sella en vez de elegir una rama en silencio, así
-- que 'oportunidad' abortó con su propio nombre. Es exactamente para lo que ese `else` se
-- escribió cuando C2 fue el tercer destino.
alter table oportunidad add column propuesta_ai_id uuid;
alter table oportunidad add
  foreign key (propuesta_ai_id, workspace_id) references propuesta_ai (id, workspace_id);
create unique index oportunidad_propuesta_ai_idx on oportunidad (propuesta_ai_id)
  where propuesta_ai_id is not null;

-- ── El alcance leído, hermano exacto de `alcance_evidencia` ──
-- Lo que se sella tiene que haberse LEÍDO. `alcance_evidencia` guarda la evidencia que llegó
-- entera al modelo —no la que se consultó— para que el guard diferido pueda negarse a sellar
-- un insight que no vio un documento que el reto ya tenía. Aquí la pregunta es la misma con
-- otro sustantivo: entre generar el lote y aceptarlo se puede VALIDAR un insight nuevo, y una
-- HMW sellada entonces es una pregunta escrita sin conocer parte de lo que el reto ya sabe.
--
-- No es lo mismo que la huella del material, y por eso hay las dos: la huella es de un TEXTO
-- —con su formato y su recorte— y no hay SQL que la recalcule; el conjunto de ids sí, y es lo
-- único que la base puede volver a preguntarse en el último instante.
alter table propuesta_ai add column alcance_insights uuid[];
alter table propuesta_ai add constraint propuesta_ai_alcance_insights_c3
  check (capacidad <> 'C3' or alcance_insights is not null);
-- El alcance se escribe al NACER la propuesta; el objeto materializado, al aceptarla. Son las
-- dos formas que ya tienen sus hermanos: `alcance_evidencia` va en el insert y `insight_id`,
-- `criterio_id` y `entrada_kpi_id` en el update. Dar insert sobre `oportunidad_id` dejaría
-- nacer una propuesta ya apuntando a una oportunidad que nadie aceptó.
grant insert (alcance_insights) on propuesta_ai to designio_app;
grant update (oportunidad_id) on propuesta_ai to designio_app;


-- ═══════════════════════════════════════════════════════════════════════════
-- LAS EQUIVALENCIAS DEL PIPELINE, CADA UNA POR SU COLUMNA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Se reescriben las que enumeran capacidades o destinos. Cada `drop`+`add` lleva la lista
-- COMPLETA y no un añadido: una restricción que se amplía en varios sitios acaba diciendo
-- cosas distintas en cada esquema según qué migraciones corrieron.

-- El reto es ancla de tres capacidades. C0 propone criterios y se congela con G0; C2 propone
-- insights y cita evidencia; C3 propone oportunidades y cita insights. Comparten la columna y
-- no comparten ni su material ni sus puertas — que es lo que el registro por capacidad
-- existía para poder decir.
alter table propuesta_ai drop constraint propuesta_ai_ancla_reto;
alter table propuesta_ai add constraint propuesta_ai_ancla_reto
  check ((reto_id is not null) = (capacidad in ('C0', 'C2', 'C3')));
alter table llamada_ai drop constraint llamada_ai_ancla_reto;
alter table llamada_ai add constraint llamada_ai_ancla_reto
  check ((reto_id is not null) = (capacidad in ('C0', 'C2', 'C3')));
alter table reserva_ai drop constraint reserva_ai_ancla_reto;
alter table reserva_ai add constraint reserva_ai_ancla_reto
  check ((reto_id is not null) = (capacidad in ('C0', 'C2', 'C3')));

-- El vocabulario de destinos, y la pareja destino ⇄ ancla. `oportunidad` cuelga del reto,
-- como el criterio y el insight.
alter table propuesta_ai drop constraint propuesta_ai_destino_vocabulario;
alter table propuesta_ai add constraint propuesta_ai_destino_vocabulario
  check (destino in ('evidencia', 'criterio-exito', 'insight', 'entrada-kpi', 'oportunidad'));
alter table propuesta_ai drop constraint propuesta_ai_destino_del_reto;
alter table propuesta_ai add constraint propuesta_ai_destino_del_reto
  check ((destino in ('criterio-exito', 'insight', 'oportunidad')) = (reto_id is not null));

-- Y el destino de ESTA capacidad. `= 'oportunidad'` y no `is not distinct from`: para C3 el
-- destino nunca es nulo, así que la forma estricta dice exactamente lo que ocurre. (Las de C0,
-- C2 y CI usan `is not distinct from` por herencia de cuando `destino` podía faltar; C6 ya
-- nació con la forma estricta.)
alter table propuesta_ai add constraint propuesta_ai_destino_c3
  check (capacidad <> 'C3' or destino = 'oportunidad');
alter table propuesta_ai add constraint propuesta_ai_objeto_oportunidad
  check (oportunidad_id is null or destino = 'oportunidad');

-- El objeto materializado, con la quinta columna dentro de las TRES ramas. La rama del
-- `<= 1` es para destinos cuyo objeto se puede borrar —hoy solo `entrada-kpi`—; una
-- oportunidad no se borra nunca (no hay política de DELETE sobre `oportunidad`), así que va
-- por el `else`: decidida ⇒ exactamente un objeto.
alter table propuesta_ai drop constraint propuesta_ai_objeto_materializado;
alter table propuesta_ai add constraint propuesta_ai_objeto_materializado
  check (
    case
      when estado not in ('aceptada', 'corregida')
        then num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id, oportunidad_id) = 0
      when destino = 'entrada-kpi'
        then num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id, oportunidad_id) <= 1
      else num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id, oportunidad_id) = 1
    end);

-- La huella del material la exigen las capacidades que CITAN contra un texto compuesto y
-- recortado: C5 su grafo, C2 su evidencia, C6 sus criterios, y ahora C3 sus insights.
alter table propuesta_ai drop constraint propuesta_ai_huella_del_material;
alter table propuesta_ai add constraint propuesta_ai_huella_del_material
  check (capacidad not in ('C5', 'C2', 'C6', 'C3') or huella_material is not null);


-- ═══════════════════════════════════════════════════════════════════════════
-- QUÉ INSIGHTS SON «DE ESTE RETO», EN UNA SOLA REDACCIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La pregunta la hacen DOS sitios y tienen que dar el mismo conjunto: el servicio, para
-- componer el material que el modelo lee, y el guard diferido, para negarse a sellar una HMW
-- que no vio algo que el reto ya sabía. Dos consultas para el mismo conjunto es cómo empiezan
-- las discrepancias que este repositorio ya ha corregido varias veces — y aquí la discrepancia
-- sería especialmente fea: el servicio manda N insights, el guard cuenta N+1, y ninguna
-- propuesta se puede aceptar nunca sin que nadie sepa por qué.
--
-- El camino es el que este esquema ya usa para la evidencia de un reto, un salto más largo:
-- un insight es del reto si alguna de sus afirmaciones cita evidencia que cuelga de un
-- arquetipo del reto. No hay `insight.reto_id` —un insight puede sostener a varios retos, que
-- es lo que la biblioteca del cliente explota— así que la pertenencia se deriva, no se guarda.
--
-- VALIDADOS y no todos: SPEC-08 lo dice en la fila de C3 («insights validados»), y la razón
-- es la misma por la que `oportunidad_insight` solo admite validados — una HMW apoyada en un
-- insight que nadie confirmó es una pregunta apoyada en una hipótesis.
--
-- `stable` y no `volatile`: se llama desde un trigger plpgsql, que es volátil y abre snapshot
-- nuevo en cada sentencia, así que ve lo commiteado. La estabilidad es lo que deja usarla
-- dentro de una consulta sin recalcularla por fila.
create function insights_validados_del_reto(p_reto uuid, p_ws uuid)
returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $fn$
  -- Anti-oráculo, como el resto de predicados expuestos al rol de aplicación: sin pertenencia
  -- no se contesta. `session_user` y no `current_user` porque bajo SECURITY DEFINER el
  -- segundo es siempre el dueño, y el propietario —seed, migraciones, el guard que la llama
  -- sin contexto— sí tiene que recibir la respuesta de verdad.
  select i.id from insight i
  where (session_user <> 'designio_app' or is_workspace_member(app_user_id(), p_ws))
    and i.workspace_id = p_ws
    and i.estado = 'validado'
    and exists (
      select 1 from afirmacion af
        join cita ci on ci.afirmacion_id = af.id and ci.workspace_id = af.workspace_id
        join arquetipo_evidencia ae on ae.evidencia_id = ci.evidencia_id
          and ae.workspace_id = ci.workspace_id
        join arquetipo a on a.id = ae.arquetipo_id and a.workspace_id = ae.workspace_id
      where af.insight_id = i.id and af.workspace_id = i.workspace_id
        and a.reto_id = p_reto and a.workspace_id = p_ws);
$fn$;

revoke execute on function insights_validados_del_reto(uuid, uuid) from public;
grant execute on function insights_validados_del_reto(uuid, uuid) to designio_app;


-- ═══════════════════════════════════════════════════════════════════════════
-- LOS DOS GUARDS, REESCRITOS ENTEROS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ Copiados de `20260905140000-c6-…` y ampliados con las ramas de C3. Es la forma que este
-- esquema usa para los guards compartidos —forward-only, sin `alter function`— y tiene un
-- coste que conviene tener a la vista: quien toque uno de estos guards en otra rama en
-- paralelo tiene que INTEGRAR, no yuxtaponer. Lo que se añade aquí:
--
--   revisión        · la ventana del portafolio al insertar, POR DESTINO; y `oportunidadId`
--                     en el evento, que es la quinta columna de una enumeración a mano
--   materialización · el predicado y la procedencia de la oportunidad —el segundo objeto
--                     COMPUESTO—, la traza = las citas comprobada en los dos sentidos,
--                     SYS-15 en el nacimiento, la ventana en el commit y el alcance de
--                     insights que el modelo llegó a leer

CREATE OR REPLACE FUNCTION public.propuesta_ai_revision_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_reto uuid;
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
    --
    -- Y BAJO CANDADO, que es la quinta vez que hace falta la misma frase en este PR. Un
    -- archivado EN VUELO no lo ve este snapshot: el `exists` a secas lee la versión activa
    -- anterior sin esperar, la clave ajena de la propuesta no choca con un UPDATE de
    -- `estado` —que no es columna de clave—, y la propuesta commitea después del archivo.
    -- Nace ya «reto-archivado»: visible en el panel, imposible de aceptar, con la llamada
    -- pagada. `for share` sobre la fila del reto es lo que la ordena detrás o delante, y va
    -- ANTES de cualquier candado sobre `derecho_uso` — el orden del protocolo, el mismo que
    -- toman el guard diferido, la revalidación previa al despacho y `bloquearReto`.
    -- ── EL RETO DE ESTA PROPUESTA, QUE EN C6 VIVE DETRÁS DEL REGISTRY ──
    -- `propuesta_ai_un_ancla` deja `reto_id` NULO cuando el ancla es el registry, así que
    -- preguntando por la columna se saltaba el candado entero: ni la clave de aviso del reto, ni
    -- el `for share` sobre su fila. Y el estado del reto SÍ decide aquí —
    -- `registry_admite_entradas` lo mira por dentro (`rt.estado <> 'archivado'`)—, de modo que sin
    -- candado esa lectura es una FOTO. Medido: con un archivado en vuelo, la propuesta de C6 NACE
    -- —no espera a nadie— y queda en el panel imposible de aceptar, con la llamada ya pagada. Es
    -- exactamente lo que las sondas de C0 y C2 impiden para el ancla que sí es un reto.
    --
    -- Se resuelve por la tabla y no copiando `reto_id` en la propuesta: `metric_registry.reto_id`
    -- es la relación de verdad, y duplicarla sería un segundo sitio donde puede decir otra cosa.
    v_reto := new.reto_id;
    if v_reto is null and new.registry_id is not null then
      select mr.reto_id into v_reto from metric_registry mr
       where mr.id = new.registry_id and mr.workspace_id = new.workspace_id;
    end if;
    if v_reto is not null then
      perform 1 from reto r
       where r.id = v_reto and r.workspace_id = new.workspace_id
       for share;
    end if;
    if v_reto is not null and exists (
      select 1 from reto r
      where r.id = v_reto and r.workspace_id = new.workspace_id
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
    -- Y el REGISTRY tiene que SEGUIR admitiendo entradas, por lo mismo que el item tiene que
    -- seguir pendiente y el reto sin archivar: lo que el servicio comprobó antes de llamar
    -- lleva ya una transacción commiteada de retraso, y entre medias alguien pudo FIRMAR el
    -- registry —que es su congelado, el G6 del contrato de medición— o cerrar el reto. Sin
    -- esto nacía una propuesta obsoleta: pendiente en el panel, rechazada por la
    -- materialización, y con la llamada ya pagada.
    --
    -- Y BAJO CANDADO, con el mismo argumento que el reto y en el mismo orden —el `for share`
    -- del reto va antes, y el del registry detrás—: una firma EN VUELO no la ve este snapshot.
    -- `for share` sobre la fila del registry choca con el `FOR NO KEY UPDATE` que toma quien
    -- firma; entre dos generaciones no hay espera, porque las dos piden compartido.
    if new.registry_id is not null then
      perform 1 from metric_registry r
       where r.id = new.registry_id and r.workspace_id = new.workspace_id
       for share;
      if not registry_admite_entradas(new.registry_id, new.workspace_id) then
        raise exception 'ese Metric Registry ya no admite entradas: o está firmado —y firmarlo congela el contrato—, o el trabajo de su reto se cerró';
      end if;
    end if;
    if new.destino = 'criterio-exito' and (
      reto_criterios_congelados(new.reto_id, new.workspace_id)
      or not reto_admite_criterios(new.reto_id, new.workspace_id)
    ) then
      raise exception 'ese reto ya no admite criterios nuevos: o su G0 los congeló, o su registry de medición está firmado, o el reto avanzó más allá de candidato/activo';
    end if;
    -- Y la VENTANA DEL PORTAFOLIO, por DESTINO y por la misma razón que la de los criterios:
    -- de este reto cuelgan ya tres capacidades, y la puerta es de lo que se materializa, no
    -- de dónde cuelga. Escrita como «toda propuesta anclada en un reto» diría que un G3
    -- firmado prohíbe también proponer criterios e insights, que es falso.
    --
    -- `reto_admite_portafolio` es la ventana que ya miran las cuatro políticas de
    -- `oportunidad`: C3 no escribe una segunda redacción de la misma pregunta, porque dos
    -- redacciones se separan y entonces la pantalla ofrece lo que la base rechaza.
    --
    -- Y hace falta AQUÍ y no solo en el servicio: entre que la generación la comprobó y este
    -- INSERT commitea hay una transacción de por medio, y lo que ocurre en ese hueco es justo
    -- lo que la cierra —firmar G3, abrir la medición, cerrar el reto—. Sin esto nacía una
    -- propuesta obsoleta: pendiente en el panel, imposible de aceptar, con la llamada pagada.
    -- La lectura va bajo el `for share` del reto que se tomó arriba, así que una firma en
    -- vuelo la ordena en vez de dejarla leer una foto.
    if new.destino = 'oportunidad'
       and not reto_admite_portafolio(new.reto_id, new.workspace_id) then
      raise exception 'el portafolio de ese reto está cerrado: su G3 quedó firmado sobre lo que había y la etapa 3 no está reabierta, o el reto ya no admite trabajo de método';
    end if;

    -- Y que el ALCANCE que trae sea el del reto AHORA, bajo el `for share` de arriba.
    --
    -- El servicio ya lo comprueba tras la llamada, pero esa lectura y este INSERT son dos
    -- momentos: `validarInsight` toma «designio:insight:<id>» y no la clave del reto, así que
    -- una validación puede cometearse justo en medio. Lo que se guardaba entonces era una
    -- propuesta con la llamada PAGADA y un alcance al que ya le falta un insight: nace
    -- `alcance-incompleto` y no se puede aceptar nunca. Aquí sí se ve, porque este guard tiene
    -- el candado del reto tomado, y la salida correcta es no guardarla y decir que se repita.
    --
    -- Es la misma regla que el guard diferido vuelve a hacer en el commit, en su instante: lo
    -- que caduca solo hay que preguntarlo cada vez que se escribe algo que dependa de ello.
    -- Aquí va en una sola comprobación —falta o sobra— porque el destinatario es quien pidió
    -- el lote y el remedio es el mismo: repetirlo. En el commit van separadas, porque ahí lo
    -- lee quien revisa y el motivo que se enseña tiene que ser el que ocurrió.
    if new.destino = 'oportunidad' and new.alcance_insights is not null
       and (exists (
             select 1 from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id)
             where not (v.id = any (new.alcance_insights)))
            or exists (
             select 1 from unnest(new.alcance_insights) as a(id)
             where a.id not in (
               select v.id from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id)))) then
      raise exception 'los insights validados de ese reto cambiaron mientras se preparaba esta propuesta: el alcance que trae no es el que el reto tiene ahora, así que estas preguntas se escribieron sobre otro material y no se guardan. Vuelve a pedirlas';
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
  -- Y el CRITERIO al que una entrada KPI responde, que es testimonio por el mismo motivo que
  -- las citas y no se veía desde aquí: no está DENTRO de `citas`, es un campo de primer nivel.
  -- El servicio ya lo blinda —`TESTIMONIO_ADICIONAL.C6`— y eso cierra el formulario; el resto
  -- del suelo no lo veía: el criterio nuevo es del reto del registry, que es lo único que la
  -- materialización comprueba, y su proyección compara contra `contenido`, que es el ya
  -- corregido. Por la superficie SQL concedida, entonces, una «corrección» reapuntaba la
  -- entrada a otro criterio CONSERVANDO las citas — que es quedarse con el sostén de uno para
  -- afirmar sobre otro, exactamente lo que la regla de las citas existe para impedir.
  --
  -- Sin condicionar al destino, como la de arriba y por lo mismo: para un contenido que no
  -- lleva `criterioId` los dos lados son nulos y esto no dice nada, así que atarla a C6 solo la
  -- dejaría corta ante la siguiente capacidad que responda a un criterio.
  if new.contenido -> 'criterioId'
     is distinct from new.contenido_original -> 'criterioId' then
    raise exception 'el criterio al que responde una entrada KPI no se corrige: los fragmentos citados se copiaron de ESE criterio, así que reapuntarla a otro conservando las citas es quedarse con el sostén de uno para afirmar sobre otro (SYS-17)';
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
    -- El objeto materializado, POR SU COLUMNA, y ahora las CINCO. `insight_id` faltaba
    -- cuando llegó C2 y `jsonb_strip_nulls` se llevaba las otras por nulas, así que el evento
    -- de aquellas aceptaciones no decía QUÉ objeto se creó: un registro append-only que no
    -- puede nombrar lo que documenta no documenta nada. La lista se quedó corta otra vez con
    -- `entrada_kpi_id`, que es la misma enumeración a mano y el mismo modo de fallo — con el
    -- agravante de que aquí el silencio es exactamente igual de silencioso. Con
    -- `oportunidadId` van cinco, y la lista sigue siendo a mano: quien añada la sexta tiene
    -- que acordarse, porque nada la obliga y `jsonb_strip_nulls` no protesta por una nula.
    jsonb_strip_nulls(jsonb_build_object(
      'propuestaId', new.id, 'capacidad', new.capacidad, 'destino', new.destino,
      'modelo', new.modelo, 'evidenciaId', new.evidencia_id, 'criterioId', new.criterio_id,
      'insightId', new.insight_id, 'entradaKpiId', new.entrada_kpi_id,
      'oportunidadId', new.oportunidad_id)),
    app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $function$;

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
  -- Y una fila que YA estaba decidida y que esta transacción solo TOCA no vuelve a
  -- materializar nada: lo que este guard comprueba es el acto de decidir, y ese acto ocurrió
  -- —y se comprobó— cuando el estado se movió.
  --
  -- Hace falta desde que quitar una entrada del borrador suelta el puntero de su propuesta
  -- (el trigger de abajo): ese UPDATE deja `estado` donde estaba y volvía a disparar este
  -- guard, que entonces exigía la entrada recién borrada y hacía imposible el borrado.
  --
  -- No abre nada por el lado del rol de aplicación: su única política de UPDATE
  -- —`propuesta_revisar`— exige `estado = 'propuesta'` en el `using`, así que el único UPDATE
  -- concedido sobre esta tabla es justamente el que mueve el estado. Y aceptar y borrar la
  -- entrada en la MISMA transacción sigue rechazado: el evento diferido de la aceptación se
  -- guardó con su `entrada_kpi_id`, y en el commit esa fila ya no existe.
  if new.estado is not distinct from old.estado then
    return null;
  end if;

  -- ── EL CANDADO POR CLAVE VA PRIMERO, ANTES QUE NINGÚN CANDADO DE FILA ──
  -- Este guard toma después `for share` sobre el reto, sobre las citas y sobre `derecho_uso`.
  -- El candado por clave del reto tiene que ir DELANTE de todos ellos, porque ése es el orden
  -- del resto del sistema: la revalidación previa al despacho y el trigger de
  -- `arquetipo_evidencia` piden primero la clave y después las filas.
  --
  -- Pedirlo al final —que es como nació— invierte el par y abre un abrazo mortal de tres:
  -- esta transacción retiene el `for share` del reto y espera la clave; un archivado quiere
  -- la fila en modo exclusivo y espera a esta; y la que despacha tiene la clave y espera la
  -- fila, detrás del archivado en la cola del candado. Nadie avanza. No se ve en una máquina
  -- rápida y sí en cuanto hay contención, que es como se manifestó.
  --
  -- Va aquí y no dentro de la comprobación del alcance porque el orden es una propiedad de la
  -- transacción entera, no de la regla que lo necesitaba.
  if new.reto_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || new.reto_id, 42));
  end if;
  -- Y el del REGISTRY, que es la clave que toma `bloquearRegistry` —o sea la que toma quien
  -- firma—. Va aquí arriba por el mismo motivo que la del reto: el orden es una propiedad de
  -- la transacción entera, no de la regla que lo necesita. Las dos claves no coinciden nunca
  -- en la misma fila (`propuesta_ai_un_ancla`), así que no hay par que ordenar entre ellas.
  if new.registry_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:registry:' || new.registry_id, 42));
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
  -- La entrada KPI cuelga del REGISTRY de la propuesta, la firma quien aceptó, y responde a un
  -- criterio DE SU RETO. Ese último trozo es la puerta de grounding de C6: un KPI que responde
  -- a una promesa de otro reto no es un KPI, es telemetría con un nombre prestado (ADR-0007).
  -- La política de `entrada_kpi` ya lo exige al escribirla; repetirlo aquí es el suelo del
  -- camino de ACEPTACIÓN, que es otra escritura y llega por otra puerta.
  if new.destino = 'entrada-kpi' and not exists (
    select 1 from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
    where e.id = new.entrada_kpi_id and e.workspace_id = new.workspace_id
      and e.registry_id = new.registry_id
      and e.creado_por = new.revisada_por
      and exists (select 1 from criterio_exito c
        where c.id = e.criterio_id and c.workspace_id = e.workspace_id
          and c.reto_id = r.reto_id)) then
    raise exception 'la entrada KPI materializada cuelga del registry de la propuesta, responde a un criterio de SU reto y la firma quien aceptó (SYS-19)';
  end if;
  -- La OPORTUNIDAD cuelga del reto de la propuesta y la firma quien aceptó. Y nace
  -- `propuesta`: aceptar una HMW la pone en el portafolio para que el equipo la decida, no la
  -- aprueba. Sellar una ya aprobada sería atribuirle a la AI un veredicto humano — y ese
  -- veredicto tiene su propia puerta, con su razón y su re-comprobación del razonamiento.
  if new.destino = 'oportunidad' and not exists (
    select 1 from oportunidad o
    where o.id = new.oportunidad_id and o.workspace_id = new.workspace_id
      and o.reto_id = new.reto_id
      and o.creado_por = new.revisada_por
      and o.estado = 'propuesta') then
    raise exception 'la oportunidad materializada cuelga del reto de la propuesta, la firma quien aceptó y nace por decidir: aceptar una HMW la pone en el portafolio, no la aprueba (SYS-19)';
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
  -- Y la entrada KPI, con la vuelta que el sello del insight dejó escrita: `xmin` dice «esta
  -- transacción escribió esta versión de la fila» y NO distingue insertar de actualizar, así
  -- que una entrada vieja a la que esta misma transacción le hace un UPDATE permitido
  -- —`editarEntrada` existe mientras el registry es borrador— pasaría como recién nacida.
  -- El insight lo cerró con «y sigue propuesto»; `entrada_kpi` no tiene estado con el que
  -- decir eso, así que lo dice su fecha: `creado_en` la pone la base y quedó FUERA del grant
  -- de columnas de esta migración, de modo que ningún UPDATE concedido la mueve. `creado_en =
  -- now()` es entonces «nació en ESTA transacción», que es exactamente lo que hay que exigir.
  if new.destino = 'entrada-kpi' and not exists (
    select 1 from entrada_kpi e
    where e.id = new.entrada_kpi_id and e.workspace_id = new.workspace_id
      and e.xmin = pg_current_xact_id()::xid
      and e.creado_en = now()) then
    raise exception 'la entrada KPI materializada tiene que haber NACIDO en esta misma aceptación: una propuesta no puede apropiarse de una entrada que ya existía, ni de una editada aquí (SYS-19)';
  end if;
  -- El insight, igual — y con una vuelta más, porque es el primer objeto COMPUESTO: no basta
  -- con que la cabecera sea nuestra. Las afirmaciones y las citas son el insight; una
  -- cabecera recién creada con las afirmaciones de otro sitio diría lo mismo por dentro y
  -- constaría igual de materializada. Se exige que TODA la descendencia haya nacido en esta
  -- misma transacción.
  -- El `xmin` NO distingue insertar de actualizar: Postgres le pone al tupla actualizada el
  -- id de la transacción que la actualiza, así que una cabecera VIEJA a la que esta misma
  -- transacción le hace un UPDATE permitido pasa esta comprobación como si acabara de nacer.
  -- Medido: un insight escrito a mano en otra transacción, con la cabecera que la propuesta
  -- dice, más sus afirmaciones y citas creadas aquí, más el UPDATE de validación —que es
  -- legítimo—, se sellaba con la procedencia de la propuesta.
  --
  -- Se cierra exigiendo ADEMÁS que siga `propuesto`, y eso funciona por un motivo que hay que
  -- dejar escrito porque el arreglo entero se apoya en él: el rol de aplicación tiene UPDATE
  -- solo sobre (estado, validado_por, validado_en) y su única política de UPDATE es
  -- `insight_validar`, cuyo `with check` EXIGE que la fila quede en `validado`. O sea que no
  -- existe ningún UPDATE concedido que refresque el `xmin` dejando `propuesto`: el único que
  -- hay obliga a salir de ese estado. Una prueba lo fija contra el catálogo, para que si
  -- alguien amplía esa superficie no se entere por este comentario sino por un caso en rojo.
  --
  -- Y la materialización legítima nace `propuesto` —validar es un acto humano POSTERIOR, en
  -- otra transacción—, así que la condición no le estorba.
  if new.destino = 'insight' and not exists (
    select 1 from insight i
    where i.id = new.insight_id and i.workspace_id = new.workspace_id
      and i.xmin = pg_current_xact_id()::xid
      and i.estado = 'propuesto') then
    raise exception 'el insight materializado tiene que haberlo creado esta misma aceptación y seguir propuesto: una propuesta no puede apropiarse de un insight que ya existía (SYS-19)';
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

  -- ── LA OPORTUNIDAD, QUE ES EL SEGUNDO OBJETO COMPUESTO ──
  --
  -- La cabecera, con la misma vuelta que el insight: `xmin` dice «esta transacción escribió
  -- esta versión» y NO distingue insertar de actualizar, así que una oportunidad VIEJA a la
  -- que esta transacción le haga un UPDATE permitido —repriorizar, que la ventana admite—
  -- pasaría como recién nacida. El insight lo cierra con «y sigue propuesto» y esa misma
  -- frase sirve aquí, porque el estado inicial de `oportunidad` es también `propuesta` y la
  -- única política de UPDATE obliga a salir de él… salvo la repriorización, que lo conserva.
  --
  -- Por eso hace falta ADEMÁS `creado_en = now()`, como en `entrada_kpi`: es «nació en ESTA
  -- transacción», y funciona porque `creado_en` la pone la base y quedó fuera del grant de
  -- UPDATE de la migración de la oportunidad, así que ninguna escritura concedida la mueve.
  -- Con las dos, repriorizar una HMW vieja dentro de la aceptación deja de poder sellarla.
  if new.destino = 'oportunidad' and not exists (
    select 1 from oportunidad o
    where o.id = new.oportunidad_id and o.workspace_id = new.workspace_id
      and o.xmin = pg_current_xact_id()::xid
      and o.creado_en = now()) then
    raise exception 'la oportunidad materializada tiene que haber NACIDO en esta misma aceptación: una propuesta no puede apropiarse de una HMW que ya existía, ni de una repriorizada aquí (SYS-19)';
  end if;
  -- Y su TRAZA, que es la parte que la hace compuesta. Una cabecera nuestra con enlaces de
  -- otro sitio diría lo mismo por dentro —la misma pregunta apoyada en los mismos insights—
  -- y constaría igual de materializada por la AI. Es el mismo argumento que el de las
  -- afirmaciones del insight, con una diferencia que conviene decir: aquí los enlaces NO se
  -- pueden actualizar (`oportunidad_insight` solo admite insert y delete), así que `xmin`
  -- basta y no hace falta la fecha.
  if new.destino = 'oportunidad' and exists (
    select 1 from oportunidad_insight oi
    where oi.oportunidad_id = new.oportunidad_id and oi.workspace_id = new.workspace_id
      and oi.xmin <> pg_current_xact_id()::xid) then
    raise exception 'la traza de la oportunidad materializada tiene que haber nacido en esta misma aceptación (SYS-19)';
  end if;
  -- Y SYS-15, en el instante en que la HMW empieza a existir: al menos un insight. No es una
  -- regla nueva —la puerta de G3 la exige sobre todo el portafolio, y aprobar una oportunidad
  -- también—, pero las dos llegan DESPUÉS. Una HMW sin traza nacida aquí sería legal hasta
  -- que alguien firmara G3, y entonces el gate se bloquearía por algo que la AI escribió y
  -- que nadie eligió. Va en el nacimiento, que es donde se puede decir de quién es.
  if new.destino = 'oportunidad' and not exists (
    select 1 from oportunidad_insight oi
    where oi.oportunidad_id = new.oportunidad_id and oi.workspace_id = new.workspace_id) then
    raise exception 'una oportunidad materializada por la AI tiene que trazar a al menos un insight: la traza es la cita, así que una HMW sin traza es una que no citó nada (SYS-15)';
  end if;
  -- Y la TRAZA ES LA CITA, comprobado en los dos sentidos: los enlaces materializados son
  -- exactamente los `insightId` distintos de las citas de la propuesta. Sin el sentido
  -- «no sobra ninguno», por la superficie SQL concedida se podía enlazar un insight de más
  -- —apoyo que nadie citó— y sellar igual; sin el otro, omitir uno citado y dejar la HMW
  -- apoyada en menos de lo que dice.
  --
  -- Se compara contra `contenido`, el ya corregido, y no contra `contenido_original`: eso es
  -- deliberado y es lo mismo que hace la proyección de las demás capacidades — corregir la
  -- redacción no puede ser siempre un fallo. Que las CITAS no se corrijan lo cierra el guard
  -- de revisión, así que los dos textos coinciden en esta parte por construcción.
  if new.destino = 'oportunidad' and (
    (select count(*) from oportunidad_insight oi
      where oi.oportunidad_id = new.oportunidad_id and oi.workspace_id = new.workspace_id)
    <> (select count(distinct c ->> 'insightId')
        from jsonb_array_elements(
          case when jsonb_typeof(new.contenido->'citas') = 'array'
               then new.contenido->'citas' else '[]'::jsonb end) as p(c))
    or exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(new.contenido->'citas') = 'array'
             then new.contenido->'citas' else '[]'::jsonb end) as p(c)
      where not exists (
        select 1 from oportunidad_insight oi
        where oi.oportunidad_id = new.oportunidad_id and oi.workspace_id = new.workspace_id
          and oi.insight_id = (c ->> 'insightId')::uuid))
  ) then
    raise exception 'la traza de la oportunidad materializada no es la de sus citas: se apoya exactamente en los insights que citó, ni uno más ni uno menos (SYS-15/SYS-17)';
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
  -- Y el registry tiene que SEGUIR admitiendo entradas al aceptar, que es el mismo hueco por
  -- el otro contrato: entre proponer y aceptar caben días, y firmar el registry es un acto
  -- humano que ocurre justo en esos días —es lo que G6 hace—. Sin esto, aceptar colaba una
  -- entrada en un contrato ya firmado: un KPI que nadie acordó, dentro de lo que se acordó.
  --
  -- Que este guard sea DIFERIDO es lo que lo vuelve suelo de verdad para ese hueco: corre en
  -- el commit, o sea en el último instante posible, y ve la firma ajena ya commiteada. El
  -- candado de arriba ordena además contra la firma que va EN VUELO. Y rechazar sigue
  -- abierto: una propuesta obsoleta se cierra rechazándola.
  if new.destino = 'entrada-kpi'
     and not registry_admite_entradas(new.registry_id, new.workspace_id) then
    raise exception 'ese Metric Registry ya no admite entradas: se firmó —o el trabajo de su reto se cerró— mientras esta propuesta esperaba revisión, así que solo puede rechazarse';
  end if;
  -- Y el RETO ARCHIVADO, que es la otra mitad y no la cubre la de arriba.
  --
  -- Al nacer la propuesta esto se exige por separado —«un reto archivado no admite propuestas
  -- de NINGUNA clase»— justo porque es lo único de aquella condición que hablaba del reto y no
  -- de los criterios. Aquí se quedó sin sacar: `reto_admite_criterios` excluye `archivado`,
  -- así que C0 lo tenía de rebote y C2 no lo tenía en absoluto. Medido: con la propuesta de
  -- C2 pendiente y el reto archivado, el servicio la rechaza por su nombre y la superficie SQL
  -- concedida sella el insight igual — un objeto nuevo atribuido a un trabajo que esta misma
  -- migración declara cerrado.
  --
  -- Va por ANCLA y no por destino, que es la corrección que la puerta de los criterios ya
  -- costó una vez: la regla habla del reto, no de lo que la propuesta materializa, y escrita
  -- como `destino = 'insight'` se queda corta ante la próxima capacidad que ancle ahí. Para
  -- C0 es redundante hoy y esa redundancia es el punto: deja de depender de que el predicado
  -- de los criterios siga excluyendo el archivo.
  -- Candado ANTES de decidir, sobre la fila del reto. Sin él esto es una FOTO: un archivado
  -- ajeno que commitea entre esta lectura y el commit de la aceptación pasa por delante, y el
  -- insight nace en un reto ya cerrado. El servicio toma «bloquearReto», pero este guard existe
  -- precisamente para quien escribe por SQL directo, que no pasa por el servicio.
  --
  -- «for share» y no «for update»: dos aceptaciones sobre el mismo reto no tienen por qué
  -- esperarse, y quien archiva hace un UPDATE que toma FOR NO KEY UPDATE, con el que FOR SHARE
  -- ya choca. Es el mismo protocolo que la congelación por disposición usa sobre «derecho_uso»,
  -- y el mismo orden que encabeza el del servicio (reto primero).
  perform 1 from reto r
   where r.id = new.reto_id and r.workspace_id = new.workspace_id
   for share;
  if new.reto_id is not null and exists (
    select 1 from reto r
    where r.id = new.reto_id and r.workspace_id = new.workspace_id
      and r.estado = 'archivado'
  ) then
    raise exception 'ese reto está archivado: su trabajo se cerró, así que esta propuesta ya no puede materializarse';
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
                -- `lower`, igual que el guard del INSERT: un uuid en mayúscula es el MISMO
                -- uuid, y Postgres lo guarda siempre en minúscula. Comparado verbatim, una
                -- propuesta que el guard del insert admitió —porque él sí normaliza— no se
                -- podía aceptar NUNCA. El parser normaliza la salida del proveedor, pero la
                -- superficie SQL no pasa por él: la propuesta nacía muerta.
                and c.evidencia_id::text = lower(q.ci->>'evidenciaId')
                and c.fragmento = q.ci->>'fragmento'
                and c.localizacion = q.ci->>'localizacion'))))) then
    raise exception 'las afirmaciones y las citas del insight materializado no dicen lo que dice la propuesta: se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;
  -- Y que TODA evidencia que el insight acaba de citar siga pudiendo citarse al cliente, en
  -- el COMMIT.
  --
  -- `evidencia_citable_guard` lo exige al insertar cada cita, y ahí lee el derecho en el
  -- snapshot de SU sentencia. Entre esa lectura y el commit cabe una revocación ajena ya
  -- commiteada, y entonces la transacción sella una cita —con su fragmento copiado— cuyo
  -- derecho de uso ya no existe. Medido: la aceptación commiteaba y `evidencia_usable` daba
  -- `false` justo después. Es exactamente el mismo argumento por el que este guard ya rehace
  -- la comprobación del CONSENTIMIENTO para la evidencia extraída, y por el que rehace el
  -- ciclo de vida del reto: lo que caduca solo hay que volver a preguntarlo en el último
  -- instante, y el último instante es este.
  --
  -- Va por el OBJETO —las citas del insight que esta propuesta materializó— y no por destino
  -- ni por capacidad: la regla es «citar exige derechos vigentes» y habla de las citas, así
  -- que cualquier capacidad que mañana materialice un insight la hereda sin tocar esto.
  -- Y aquí también el candado va ANTES de la lectura, por lo mismo y con más motivo: sin él,
  -- volver a preguntar en el commit solo adelanta la foto un poco. Una revocación que ya está
  -- EN VUELO no la ve este snapshot —no ha commiteado—, así que la comprobación pasa y la
  -- aceptación commitea con la revocación pisándole los talones. Con el candado, o la
  -- revocación commitea primero y esta lectura la ve, o espera a que la aceptación termine: hay
  -- un orden, que es lo que no había.
  --
  -- Es literalmente el protocolo de «candados-compartidos»: «for share» sobre las filas de
  -- «derecho_uso» de toda la evidencia que este snapshot va a fijar, ordenadas por su id para
  -- que dos transacciones las pidan en el mismo orden. Va DESPUÉS del candado del reto, que es
  -- el orden que ya encabeza el del servicio.
  --
  -- «Toda la que este snapshot va a fijar» son DOS conjuntos, y durante una ronda esto solo
  -- cubrió el primero. La que el insight CITA la miran las dos comprobaciones de aquí abajo; la
  -- que el reto tiene ENLAZADA y el insight no cita la mira la comprobación de completitud del
  -- final, que pregunta `evidencia_usable` por cada una. Con el candado sobre el subconjunto
  -- citado, una CONCESIÓN en vuelo sobre un documento enlazado y no citado no ordenaba nada:
  -- esta lectura lo veía inutilizable —la concesión aún no ha commiteado—, la completitud
  -- pasaba, y el sello caía justo antes de que el documento pasara a ser citable. Los insights
  -- quedaban sellados sin haber visto una evidencia que el reto ya tenía.
  --
  -- Van en UNA sola sentencia y no en dos: dos «for share» sobre conjuntos que se solapan sin
  -- que uno contenga al otro se piden en órdenes distintos según qué cite cada propuesta, y eso
  -- es un interbloqueo esperando a que dos aceptaciones coincidan. Una sentencia sobre la unión
  -- tiene un orden y solo uno.
  perform du.evidencia_id
    from derecho_uso du
   where du.workspace_id = new.workspace_id
     and du.evidencia_id in (
       select c.evidencia_id
         from afirmacion a
         join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
        where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id
        union
       select ae.evidencia_id
         from arquetipo a
         join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
        where a.reto_id = new.reto_id and a.workspace_id = new.workspace_id)
   order by du.evidencia_id
     for share;
  if new.insight_id is not null and exists (
    select 1
    from afirmacion a
    join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
    where a.insight_id = new.insight_id and a.workspace_id = new.workspace_id
      and not evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente')) then
    raise exception 'DR001: alguna de las evidencias que este insight cita dejó de poder citarse al cliente mientras se aceptaba (se retiró el derecho de uso, caducó, o el documento ya no está)';
  end if;
  -- Y que el insight haya VISTO toda la evidencia que el reto tiene ahora.
  --
  -- Las dos comprobaciones de arriba miran la evidencia que el insight SÍ cita. Esta mira la
  -- que no cita porque no existía para él: entre que la propuesta se guardó y este commit se
  -- pudo enlazar un documento nuevo al reto, y sellar aquí es sellar un insight que nunca lo
  -- leyó — en C2, posiblemente el que lo contradice. Quien revisa no puede compensarlo: las
  -- contradicciones son inmutables, que es la decisión de arriba mirada desde el otro lado.
  --
  -- El candado por CLAVE va primero, y no basta con el «for share» sobre la fila del reto que
  -- ya se tomó: un «insert into arquetipo_evidencia» sin commitear no está en ninguna fila
  -- leída, así que un candado de fila no lo ve. `designio:reto:` es la misma clave que toman
  -- el trigger de «arquetipo_evidencia» y la revalidación previa al despacho.
  if new.reto_id is not null and new.alcance_evidencia is not null then
    if exists (
      select 1
        from arquetipo a
        join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
       where a.reto_id = new.reto_id and a.workspace_id = new.workspace_id
         and evidencia_usable(ae.evidencia_id, ae.workspace_id, 'cliente')
         and not (ae.evidencia_id = any (new.alcance_evidencia))) then
      raise exception 'ese reto tiene evidencia que estos insights no llegaron a ver: se enlazó después de generarlos, así que la propuesta quedó obsoleta y solo puede rechazarse. Vuelve a pedirla para que la tenga en cuenta';
    end if;
  end if;

  -- ── Y LA OPORTUNIDAD, EN SUS DOS EJES ──
  --
  -- 1. LA VENTANA. Entre proponer una HMW y aceptarla caben días, y lo que pasa en esos días
  --    es precisamente lo que la cierra: se firma G3 —que certifica el portafolio tal como
  --    está—, se abre la medición, o se cierra el reto. Sellar entonces mete una HMW en un
  --    portafolio que un gate ya dio por bueno, sin que su guard vuelva a correr para
  --    desmentirlo. Es el mismo eje TIEMPO que obliga a C6 a volver a mirar la firma del
  --    registry y a C2 los derechos de sus citas.
  --
  --    La política de `oportunidad` ya lo exige al INSERTAR la fila, y aun así se comprueba
  --    aquí: aquélla corre en la sentencia del insert, con su snapshot; ésta corre en el
  --    commit, que es donde una firma que llegó en medio sí se ve. El candado por clave del
  --    reto ya está tomado arriba, así que la lectura no es una foto.
  if new.destino = 'oportunidad'
     and not reto_admite_portafolio(new.reto_id, new.workspace_id) then
    raise exception 'el portafolio de ese reto se cerró mientras esta HMW esperaba revisión —se firmó su G3, se abrió la medición o se cerró el reto—: la propuesta solo puede rechazarse';
  end if;
  -- 2. EL ALCANCE. La HMW tiene que haber VISTO todos los insights validados que el reto
  --    tiene ahora. `alcance_insights` guarda los que llegaron enteros al modelo; entre
  --    generar y aceptar se puede VALIDAR uno nuevo, y una pregunta sellada entonces se
  --    escribió sin conocer parte de lo que el reto ya sabe — posiblemente lo que la
  --    reformularía. Quien revisa no puede compensarlo leyendo la propuesta: lo que falta no
  --    está escrito en ella.
  --
  --    Es el hermano exacto de la comprobación de C2 de arriba, con el `for share` del reto y
  --    la clave ya tomados. Los insights se atan al reto por sus arquetipos, igual que la
  --    evidencia: la misma travesía, un salto más.
  if new.destino = 'oportunidad' and new.alcance_insights is not null then
    if exists (
      select 1 from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id)
       where not (v.id = any (new.alcance_insights))) then
      raise exception 'ese reto tiene insights validados que estas oportunidades no llegaron a ver: se validaron después de generarlas, así que la propuesta quedó obsoleta y solo puede rechazarse. Vuelve a pedirla para que los tenga en cuenta';
    end if;
    -- Y NINGUNO DE MÁS, que es lo que convierte la cota en una IGUALDAD.
    --
    -- Con «no falta ninguno» a secas, el array se podía PREDECLARAR: meter un id ajeno hoy y
    -- esperar a que ese insight pase a ser del reto mañana —basta con enlazar su evidencia a
    -- un arquetipo suyo—. Entonces el conjunto real crece hasta caber dentro de lo declarado,
    -- la comprobación de arriba pasa por haberlo anticipado, y la HMW se sella sin haber visto
    -- un insight que el reto ya tiene. Es justo el agujero que esa comprobación existía para
    -- tapar, abierto desde el otro lado.
    --
    -- Declarar de más no es un caso legítimo: el servicio escribe EXACTAMENTE los que llegaron
    -- enteros, y desde que no se despacha con ninguno recortado eso es todo el conjunto. Un
    -- alcance que no cuadra con el reto solo sale de la superficie SQL.
    if exists (
      select 1 from unnest(new.alcance_insights) as a(id)
      where a.id not in (
        select v.id from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id))) then
      raise exception 'el alcance declarado por esa propuesta no es el del reto: dice haber leído insights que el reto no tiene validados, así que no dice la verdad sobre lo que se le enseñó al modelo y no puede sellarse (SYS-19)';
    end if;
    -- Y EL OTRO SENTIDO: lo citado tiene que caber DENTRO del alcance.
    --
    -- La comprobación de arriba dice «no falta ninguno», y esa mitad sola no afirma nada sobre
    -- lo que la propuesta cita. La política de `oportunidad_insight` admite cualquier insight
    -- VALIDADO DEL WORKSPACE —no del reto—, así que por la superficie concedida se podía citar
    -- uno ajeno, enlazarlo, entregar un `alcance_insights` completo (lo es: contiene todos los
    -- del reto) y sellar. Medido: sellaba. La HMW quedaba atribuida a material que el modelo
    -- nunca recibió, con la traza y el alcance diciendo cada uno una verdad distinta.
    --
    -- Se mira la CITA y no la traza porque la cita es el original: la traza se deriva de ella
    -- —eso lo comprueba el bloque de «la traza es la cita»— así que acotar aquí acota las dos,
    -- y hacerlo al revés dejaría el orden de las comprobaciones decidiendo qué se protege.
    --
    -- Y se mide contra `insights_validados_del_reto`, que es el HECHO, no contra
    -- `alcance_insights`, que es lo DECLARADO por quien insertó la fila. Escrito contra el
    -- array no cerraba nada: hay `grant insert (alcance_insights)`, así que el llamante puede
    -- meter el ajeno dentro, y entonces las dos comprobaciones que miran el array se cumplen a
    -- la vez —la de arriba porque un superconjunto sigue conteniendo todos los del reto, y
    -- ésta porque lo citado ya está dentro—. Dos verdades sobre una lista que escribió el
    -- propio llamante no son ninguna verdad sobre el reto. Medido: con el alcance inflado,
    -- sellaba.
    --
    -- La comprobación de arriba no sobra: dice que no FALTE ninguno, y ésta que no SOBRE
    -- ninguno. Juntas, y con ésta apoyada en el hecho, el array ya no puede mentir a favor de
    -- nadie — si declara de más, esta rama lo caza; si declara de menos, la de arriba.
    --
    -- `lower`, igual que en el resto de este guard: un uuid en mayúscula es el MISMO uuid y la
    -- superficie SQL no pasa por el parser, que es quien lo normaliza.
    if exists (
      select 1 from jsonb_array_elements(new.contenido -> 'citas') as c(cita)
      where lower(c.cita ->> 'insightId')::uuid not in (
        select v.id from insights_validados_del_reto(new.reto_id, new.workspace_id) as v(id))) then
      raise exception 'esa oportunidad cita insights que no entraron en el material que se le mandó al modelo: una HMW solo puede apoyarse en lo que leyó, y el alcance sellado dice qué fue (SYS-19)';
    end if;
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
  -- ninguna. Para el segundo basta el RECUENTO, pero solo porque el guard del INSERT ya rechaza
  -- la contradicción repetida: con repetidas, el recuento cuadra y las dos entradas iguales
  -- encuentran la misma fila, de modo que otra distinta entra sin revisar. El
  -- `unique (insight_id, evidencia_id)` no lo cierra, porque las dos filas materializadas
  -- pueden ser de evidencias distintas.
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
          -- `lower`, por lo mismo que en las citas.
          and c.evidencia_id::text = lower(p.co->>'evidenciaId')
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
  -- Y la de la entrada KPI. Los seis campos que la propuesta DICTA, y solo esos: el criterio
  -- al que responde, el nombre, la definición, la fuente, las dimensiones y la frecuencia.
  -- Los demás —el dueño del dato, la línea base, la ventana, el dashboard y la fecha del post
  -- mortem— NO se comparan porque la propuesta no los dice: son compromisos y datos, no
  -- redacción, y la cabecera de esta migración explica por qué C6 no los propone. Compararlos
  -- exigiría que nacieran vacíos y ataría este guard a esa decisión del servicio.
  if new.destino = 'entrada-kpi' and not exists (
    select 1 from entrada_kpi e
    where e.id = new.entrada_kpi_id and e.workspace_id = new.workspace_id
      and e.criterio_id = (new.contenido ->> 'criterioId')::uuid
      and e.nombre      = new.contenido ->> 'nombre'
      and e.definicion  = new.contenido ->> 'definicion'
      and e.fuente      = new.contenido ->> 'fuente'
      and e.dimensiones = new.contenido ->> 'dimensiones'
      and e.frecuencia  = new.contenido ->> 'frecuencia') then
    raise exception 'la entrada KPI materializada no dice lo que dice la propuesta: el criterio al que responde, el nombre, la definición, la fuente, las dimensiones y la frecuencia se copian tal cual de la propuesta aceptada (SYS-19)';
  end if;

  -- Y la de la OPORTUNIDAD. Los tres campos que la propuesta DICTA, y solo esos: la pregunta,
  -- la prioridad y su razón. El veredicto y su razón NO se comparan porque la propuesta no los
  -- dice: nacen vacíos y los escribe la decisión humana, que llega por otra puerta y con su
  -- propia re-comprobación del razonamiento.
  --
  -- Sin esto la oportunidad se quedaba con su PREDICADO a secas —cuelga del reto, la firma
  -- quien aceptó, nace por decidir, su traza es la citada—, y todo eso lo cumple una HMW que
  -- pregunte otra cosa. Medido por la superficie concedida: sellaba. Lo que quedaba entonces
  -- era una propuesta constando como aceptada con un objeto atribuido que dice algo distinto,
  -- que es procedencia corrupta y una tasa de corrección midiendo texto que nadie propuso.
  --
  -- Verbatim y sin `titulo_normalizado`: la comparación es «se copió tal cual», no «se parece
  -- lo bastante». El esquema normaliza para decidir si la pregunta está VACÍA y para el único
  -- por reto —dos preguntas iguales— y ésas son otras preguntas; aquí normalizar dejaría pasar
  -- una HMW que cambia acentos o espacios respecto de lo que el modelo escribió.
  if new.destino = 'oportunidad' and not exists (
    select 1 from oportunidad o
    where o.id = new.oportunidad_id and o.workspace_id = new.workspace_id
      and o.pregunta        = new.contenido ->> 'pregunta'
      and o.prioridad       = (new.contenido ->> 'prioridad')::integer
      and o.prioridad_razon = new.contenido ->> 'prioridadRazon') then
    raise exception 'la HMW materializada no dice lo que dice la propuesta: la pregunta, la prioridad y su razón se copian tal cual de la propuesta aceptada (SYS-19)';
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
  elsif new.destino = 'entrada-kpi' then
    update entrada_kpi set propuesta_ai_id = new.id
      where id = new.entrada_kpi_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  elsif new.destino = 'oportunidad' then
    update oportunidad set propuesta_ai_id = new.id
      where id = new.oportunidad_id and workspace_id = new.workspace_id
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
