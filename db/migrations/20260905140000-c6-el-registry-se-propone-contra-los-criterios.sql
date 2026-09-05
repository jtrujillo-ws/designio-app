-- ── C6: el borrador del Metric Registry, propuesto contra los criterios que promete medir ──
--
-- La etapa 6 tiene su contrato de medición —`metric_registry` con sus `entrada_kpi`— y hasta
-- hoy solo se llenaba a mano. C6 lo propone, y lo hace por el pipeline de siempre: el modelo
-- redacta entradas, un humano las acepta una a una y solo entonces existe la fila (SYS-19).
--
-- LO QUE C6 PROPONE Y LO QUE NO, que aquí es la mitad del diseño. `entrada_kpi` tiene catorce
-- columnas y esta capacidad escribe cinco: `criterio_id`, `nombre`, `definicion`, `fuente` y
-- `dimensiones`, más `frecuencia`. Las otras se quedan fuera A PROPÓSITO y cada una por su
-- motivo, no por recorte:
--
--   · `propietario_miembro_id` es la PERSONA DEL CLIENTE que se compromete a aportar el dato
--     (RF-07.1/07.4). Un compromiso lo adquiere alguien, no se propone en su nombre; y la
--     política de la entrada ya exige que sea del cliente porque ese compromiso es lo que
--     hace medible al contrato. Que el modelo eligiera quién responde por un KPI sería
--     fabricar la parte del contrato que ninguna revisión posterior desmiente —el nombre
--     estaría puesto, y aceptar la propuesta lo firmaría.
--   · `linea_base_valor`, `linea_base_fecha`, `ventana_inicio` y `fecha_post_mortem` son
--     DATOS y FECHAS, no redacción: o constan o no constan, y proponerlos es inventarlos.
--     Es la misma regla que CI ya aplica a la fecha del material — o apunta al dato, o
--     escribe por qué no lo hay— llevada a su forma más simple: aquí no hay dónde apuntar,
--     así que no se pide.
--   · `dashboard_url` es una dirección que existe o no existe. Igual.
--
-- Así que una entrada materializada por C6 nace INCOMPLETA, y eso no es un defecto de la
-- capacidad: `entrada_kpi` acepta entradas incompletas por diseño —el registry se redacta
-- iterando— y la completitud la exige la FIRMA, que es un acto humano con su propio guard.
-- C6 adelanta la parte que es redacción; la parte que es compromiso la sigue poniendo quien
-- se compromete.
--
-- LO QUE NO ENTRA EN ESTA MIGRACIÓN. SPEC-08 pone en la misma fila de C6 dos salidas:
-- «entradas KPI propuestas + descomposición en releases». Aquí va la primera. La segunda no
-- se queda fuera por tamaño sino porque el pipeline no la puede modelar todavía, y conviene
-- dejar escrito por qué para que quien la retome no repita el análisis:
--
--   · `release` exige `responsable` y `fecha_objetivo` NOT NULL, y las dos son compromisos —
--     quién responde y para cuándo—, o sea exactamente lo que el párrafo de arriba dice que
--     no se propone. Lo proponible es la AGRUPACIÓN: qué `elemento_cambio` cae en qué
--     release y por qué (`release_elemento.razon`). Pero un `release_elemento` no existe sin
--     su `release`, así que esa agrupación no se puede materializar sola.
--   · Y una capacidad tiene UN ancla y UN destino en `CAPACIDADES`. La agrupación cuelga de
--     la design version y no materializa nada (sería informativa, como CT y C5), así que no
--     es otra forma de C6: es otra capacidad, y el vocabulario `CapacidadAISchema` —C0..C7,
--     CT, CI— no tiene hueco donde ponerla.
--
-- Ampliar ese vocabulario es una decisión de producto, no un detalle de esta migración.

-- ═══════════════════════════════════════════════════════════════════════════
-- EL ANCLA: EL REGISTRY, Y NO EL RETO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El material de C6 son los criterios de éxito, que cuelgan del RETO. Anclar ahí habría sido
-- lo directo, y es lo que no se hace: `entrada_kpi.registry_id` es NOT NULL, así que una
-- propuesta anclada en el reto no sabría en qué registry materializarse mientras el reto no
-- tenga uno —y `metric_registry` es 1:1 con el reto, pero puede no existir todavía—. El ancla
-- es el objeto del que se deriva el prompt Y aquel sobre el que se escribe: aquí es el mismo,
-- el registry en borrador, y sus criterios se leen por el camino corto `registry → reto`.
--
-- Y una consecuencia que vale la pena decir: como el ancla es el registry, la puerta de
-- entrada de C6 es «el registry existe y está en borrador». Abrirlo sigue siendo un acto
-- humano (`abrirRegistry`), y eso deja la decisión de empezar a medir donde estaba.

alter table reserva_ai   add column registry_id uuid;
alter table llamada_ai   add column registry_id uuid;
alter table propuesta_ai add column registry_id uuid;
alter table reserva_ai   add foreign key (registry_id, workspace_id) references metric_registry (id, workspace_id);
alter table llamada_ai   add foreign key (registry_id, workspace_id) references metric_registry (id, workspace_id);
alter table propuesta_ai add foreign key (registry_id, workspace_id) references metric_registry (id, workspace_id);

-- La equivalencia POR COLUMNA que instaló C2, con su lista. La forma —y no «(capacidad =
-- 'C6') = (registry_id is not null)»— porque la lección ya está pagada: escribir la
-- equivalencia por capacidad es exacto mientras la columna tenga una sola dueña y falso en
-- cuanto deja de tenerla, y la prueba que compara esta lista contra `CAPACIDADES[c].ancla`
-- solo puede compararla si está escrita así.
alter table reserva_ai   add constraint reserva_ai_ancla_registry   check ((registry_id is not null) = (capacidad in ('C6')));
alter table llamada_ai   add constraint llamada_ai_ancla_registry   check ((registry_id is not null) = (capacidad in ('C6')));
alter table propuesta_ai add constraint propuesta_ai_ancla_registry check ((registry_id is not null) = (capacidad in ('C6')));

-- «Exactamente un ancla», rehecha con la quinta columna. Rehecha y no añadida, por lo mismo
-- que la vez anterior: es UNA regla sobre el conjunto, y dejar la vieja al lado admitiría dos
-- anclas puestas con tal de que una fuera la nueva.
alter table propuesta_ai drop constraint propuesta_ai_un_ancla;
alter table propuesta_ai add constraint propuesta_ai_un_ancla
  check (num_nonnulls(item_id, reto_id, gate_id, journey_id, registry_id) = 1);

grant insert (registry_id) on reserva_ai   to designio_app;
grant insert (registry_id) on llamada_ai   to designio_app;
grant insert (registry_id) on propuesta_ai to designio_app;

-- Exclusión por ancla, con la forma que C2 dejó: por (capacidad, ancla), que es la unidad de
-- trabajo real. Dos personas no piden a la vez sobre el mismo registry.
create unique index reserva_ai_registry_idx
  on reserva_ai (workspace_id, capacidad, registry_id)
  where registry_id is not null;

-- Y NO hay índice de «propuesta pendiente» sobre el registry, por lo mismo que no lo hay
-- sobre el reto: C6 es un LOTE, y un lote son varias filas pendientes del mismo ancla. Esa
-- regla —«este registry ya tiene entradas esperando revisión»— vive en la admisión, que
-- sabe contar; un índice único ahí rechazaría la segunda entrada del PRIMER lote.

-- ═══════════════════════════════════════════════════════════════════════════
-- EL DESTINO: UNA ENTRADA DEL REGISTRY
-- ═══════════════════════════════════════════════════════════════════════════

alter table propuesta_ai add column entrada_kpi_id uuid;
alter table propuesta_ai add
  foreign key (entrada_kpi_id, workspace_id) references entrada_kpi (id, workspace_id);

-- El vocabulario de destinos, con la cuarta. Misma razón que la tercera: la enumeración vive
-- en un sitio que la capacidad nueva no sabe que tiene que tocar, y sin esta línea TODA
-- propuesta de C6 la rechaza el CHECK.
alter table propuesta_ai drop constraint propuesta_ai_destino_vocabulario;
alter table propuesta_ai add constraint propuesta_ai_destino_vocabulario
  check (destino in ('evidencia', 'criterio-exito', 'insight', 'entrada-kpi'));

-- Destino ⇔ ancla, en los dos sentidos: una entrada del registry exige registry, y un
-- registry exige ese destino.
alter table propuesta_ai add constraint propuesta_ai_destino_del_registry
  check ((destino = 'entrada-kpi') = (registry_id is not null));

-- Objeto ⇔ destino, como los otros tres.
alter table propuesta_ai add constraint propuesta_ai_objeto_entrada_kpi
  check (entrada_kpi_id is null or destino = 'entrada-kpi');

-- Y el enlace lo escribe el sello al aceptar, así que la columna necesita su UPDATE. Igual que
-- `insight_id` cuando llegó C2 — la superficie de `propuesta_ai` va por columnas, así que una
-- columna de destino nueva no la hereda: sin esta línea el sello muere con «permission denied»
-- DESPUÉS de haber creado la entrada, y el rechazo no dice cuál es la columna que falta.
grant update (entrada_kpi_id) on propuesta_ai to designio_app;

-- Y «aceptada ⇔ hay objeto», con el cuarto en la cuenta. Igual que la vez anterior: la
-- enumeración corta rechazaba la aceptación de la capacidad nueva con la mitad izquierda
-- cierta y la derecha falsa.
alter table propuesta_ai drop constraint propuesta_ai_objeto_materializado;
alter table propuesta_ai add constraint propuesta_ai_objeto_materializado
  check ((estado in ('aceptada', 'corregida'))
         = (num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id) = 1));

-- Y capacidad ⇒ destino, aditiva como las de C0/C2/C5.
alter table propuesta_ai add constraint propuesta_ai_destino_c6
  check (capacidad <> 'C6' or destino = 'entrada-kpi');

-- ═══════════════════════════════════════════════════════════════════════════
-- LA HUELLA DEL MATERIAL: C6 TAMBIÉN LA GUARDA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Los criterios del reto se editan mientras G0 no los congela (SYS-22), y se AÑADEN. Una
-- propuesta redactada contra tres criterios y revisada cuando ya hay cinco no está mal, pero
-- tampoco es lo que se leyó: sin huella, esa diferencia no se puede ver, y el silencio se
-- lee como «al día». La constraint se rehace con la tercera capacidad que la declara.
alter table propuesta_ai drop constraint propuesta_ai_huella_del_material;
alter table propuesta_ai add constraint propuesta_ai_huella_del_material
  check (capacidad not in ('C5', 'C2', 'C6') or huella_material is not null);

-- ═══════════════════════════════════════════════════════════════════════════
-- EL SELLO DE PROCEDENCIA EN `entrada_kpi`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La mitad permanente de SYS-19: de qué propuesta viene este objeto. Se instala igual que en
-- `evidencia`, `criterio_exito` e `insight`, y con la misma precaución que cobró el último:
-- el `grant insert` de TABLA cubre las columnas futuras, así que añadir esta columna se la
-- regalaría al llamante y el vínculo dejaría de ser vínculo —una proveniencia falsificable y,
-- de paso, la plaza única del índice ocupada por una entrada escrita a mano—. Se retira el
-- grant de tabla y se devuelve la lista exacta, sin la columna nueva.
alter table entrada_kpi add column propuesta_ai_id uuid;
alter table entrada_kpi add
  foreign key (propuesta_ai_id, workspace_id) references propuesta_ai (id, workspace_id);
create unique index entrada_kpi_propuesta_ai_idx on entrada_kpi (propuesta_ai_id)
  where propuesta_ai_id is not null;

revoke insert on entrada_kpi from designio_app;
grant insert (workspace_id, registry_id, criterio_id, nombre, definicion, fuente,
              dimensiones, propietario_miembro_id, frecuencia, dashboard_url,
              linea_base_valor, linea_base_fecha, ventana_inicio, fecha_post_mortem,
              creado_por)
  on entrada_kpi to designio_app;
-- Y en esa lista NO están `id` ni `creado_en`, que el grant de tabla sí concedía. `agregarEntrada`
-- no escribe ninguno de los dos —los pone la base—, así que quitarlos no cierra ningún camino; lo
-- que abre es una PRUEBA que el sello necesita. `xmin` dice «esta transacción escribió esta
-- versión de la fila» y no distingue insertar de actualizar: una entrada vieja a la que esta
-- misma transacción le hace un UPDATE permitido —y `editarEntrada` existe mientras el registry
-- es borrador— pasa esa comprobación como si acabara de nacer. Es el mismo agujero que el sello
-- del insight midió y cerró con «y sigue propuesto», y `entrada_kpi` no tiene estado con el que
-- decir eso. Con `creado_en` fuera del alcance del llamante, `creado_en = now()` significa
-- «nació en ESTA transacción» —ningún UPDATE concedido la mueve— y las dos juntas sí lo dicen.

-- ── La propuesta cuelga de la LLAMADA que la produjo, y del mismo registry ──
--
-- Aditivo por ancla, como el de CT y el de C5, y por el mismo motivo que ellos dejaron
-- escrito: sin esta comparación, una llamada hecha sobre un registry se puede colgar de la
-- propuesta de OTRO —y entonces el libro de costos y el lineage dicen cosas distintas sobre la
-- misma fila—. Que ninguna columna de ancla se quede sin su comparación lo sujeta una prueba
-- que enfrenta `COLUMNAS_DE_ANCLA` contra el texto de los guards.
create function propuesta_ai_c6_linaje_guard() returns trigger
language plpgsql as $$
begin
  if new.capacidad <> 'C6' then
    return new;
  end if;
  if not exists (
    select 1 from llamada_ai l
    where l.id = new.llamada_id and l.workspace_id = new.workspace_id
      and l.registry_id is not distinct from new.registry_id
  ) then
    raise exception 'la propuesta debe colgar de la llamada que la produjo: mismo registry';
  end if;
  return new;
end $$;

revoke execute on function propuesta_ai_c6_linaje_guard() from public;

create trigger a_propuesta_ai_c6_linaje
  before insert on propuesta_ai
  for each row execute function propuesta_ai_c6_linaje_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- LA PUERTA DE ENTRADA: EL REGISTRY TIENE QUE ADMITIR ENTRADAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Escrita como función y no en línea dentro del guard porque la miran TRES sitios —el guard
-- del INSERT, el guard diferido de la materialización y el panel de anclas ofrecidas—, y este
-- repositorio ya lleva varias rondas cuyo hallazgo fue «dos redacciones hermanas del mismo
-- predicado divergieron».
--
-- Un registry admite entradas mientras está en BORRADOR. Firmarlo congela el contrato: es su
-- G0, y por eso `entrada_kpi_insert` ya lo exige. Y el reto, además, tiene que seguir vivo:
-- un reto archivado no admite propuestas de ninguna clase.
--
-- El anti-oráculo de siempre: quien no es miembro del workspace recibe `false` y no una
-- respuesta sobre datos que no puede ver. Se distingue por `session_user` —el rol de LOGIN—
-- y no por `current_user`, que bajo SECURITY DEFINER es siempre el propietario.
create function registry_admite_entradas(p_registry uuid, p_ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $fn$
  select case
    when session_user = 'designio_app' and not is_workspace_member(app_user_id(), p_ws)
      then false
    else exists (
      select 1 from metric_registry r
        join reto rt on rt.id = r.reto_id and rt.workspace_id = r.workspace_id
      where r.id = p_registry and r.workspace_id = p_ws
        and r.estado = 'borrador'
        and rt.estado <> 'archivado')
  end;
$fn$;

revoke execute on function registry_admite_entradas(uuid, uuid) from public;
grant execute on function registry_admite_entradas(uuid, uuid) to designio_app;


-- ═══════════════════════════════════════════════════════════════════════════
-- LOS DOS GUARDS DEL PIPELINE, CON LA RAMA DE `entrada-kpi`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ CUIDADO AL INTEGRAR: lo que sigue REEMPLAZA dos cuerpos vivos definidos en migraciones
-- anteriores —la última es `…060000-c2-los-insights-se-proponen-con-sus-citas.sql`—. En base
-- limpia gana la migración de número más alto, o sea ésta, así que si otra rama le añade una
-- regla a cualquiera de los dos en una migración ANTERIOR, ésta la borra en silencio: no habrá
-- conflicto de merge que avise, porque los ficheros son distintos. Es el mismo aviso que la
-- migración de la capa AI dejó escrito, por el mismo motivo, y ya se cobró una vez.
--
-- El cuerpo va copiado de allí con sus comentarios —no regenerado desde `pg_get_functiondef`,
-- que los pierde— y lo único nuevo son las ramas de `entrada-kpi`, cada una junto a su
-- hermana del criterio para que se lean en pareja.

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
    --
    -- Y BAJO CANDADO, que es la quinta vez que hace falta la misma frase en este PR. Un
    -- archivado EN VUELO no lo ve este snapshot: el `exists` a secas lee la versión activa
    -- anterior sin esperar, la clave ajena de la propuesta no choca con un UPDATE de
    -- `estado` —que no es columna de clave—, y la propuesta commitea después del archivo.
    -- Nace ya «reto-archivado»: visible en el panel, imposible de aceptar, con la llamada
    -- pagada. `for share` sobre la fila del reto es lo que la ordena detrás o delante, y va
    -- ANTES de cualquier candado sobre `derecho_uso` — el orden del protocolo, el mismo que
    -- toman el guard diferido, la revalidación previa al despacho y `bloquearReto`.
    if new.reto_id is not null then
      perform 1 from reto r
       where r.id = new.reto_id and r.workspace_id = new.workspace_id
       for share;
    end if;
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
    -- El objeto materializado, POR SU COLUMNA, y ahora las CUATRO. `insight_id` faltaba
    -- cuando llegó C2 y `jsonb_strip_nulls` se llevaba las otras por nulas, así que el evento
    -- de aquellas aceptaciones no decía QUÉ objeto se creó: un registro append-only que no
    -- puede nombrar lo que documenta no documenta nada. La lista se quedó corta otra vez con
    -- `entrada_kpi_id`, que es la misma enumeración a mano y el mismo modo de fallo — con el
    -- agravante de que aquí el silencio es exactamente igual de silencioso.
    jsonb_strip_nulls(jsonb_build_object(
      'propuestaId', new.id, 'capacidad', new.capacidad, 'destino', new.destino,
      'modelo', new.modelo, 'evidenciaId', new.evidencia_id, 'criterioId', new.criterio_id,
      'insightId', new.insight_id, 'entradaKpiId', new.entrada_kpi_id)),
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
  else
    raise exception 'destino de propuesta AI sin sello de procedencia: % — un destino nuevo tiene que decir qué objeto sella (SYS-19)', coalesce(new.destino, '(sin destino)');
  end if;
  if v_filas <> 1 then
    raise exception 'ese objeto ya cuelga de otra propuesta AI: un objeto materializado tiene una sola procedencia (SYS-19)';
  end if;

  return null;
end $function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- EL SELLO NO ES UNA EDICIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ CUIDADO AL INTEGRAR: esto REEMPLAZA el cuerpo vivo de `medicion_auditoria`, definido en
-- `…110000-medicion.sql`. Mismo aviso que los dos guards de arriba y por el mismo motivo: si
-- otra rama le añade una tabla a este guard en una migración anterior, ésta la borra en
-- silencio. El cuerpo va copiado de allí con sus comentarios; lo único nuevo es la salida
-- temprana de la rama de `entrada_kpi`, comentada en su sitio.

create or replace function medicion_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- En un DELETE no hay `new`, y nombrarlo aquí reventaría el trigger: la fila auditada es
  -- `old`. Se asigna en el cuerpo y no en la declaración justamente por eso.
  fila jsonb;
  previa jsonb;
  cuerpo jsonb;
  evento text;
begin
  if tg_op = 'DELETE' then
    fila := to_jsonb(old);
  else
    fila := to_jsonb(new);
    if tg_op = 'UPDATE' then previa := to_jsonb(old); end if;
  end if;
  -- Guard compartido entre tablas con columnas distintas: se trabaja sobre jsonb porque
  -- plpgsql resuelve TODAS las referencias de campo aunque su rama no se ejecute.
  if tg_table_name = 'metric_registry' then
    evento := 'MetricRegistryAbierto';
    cuerpo := jsonb_build_object('registryId', fila->'id', 'retoId', fila->'reto_id');
  elsif tg_table_name = 'entrada_kpi' then
    evento := case tg_op
      when 'INSERT' then 'EntradaKpiAgregada'
      when 'DELETE' then 'EntradaKpiBorrada'
      else 'EntradaKpiEditada' end;
    -- Y un UPDATE que no mueve NINGÚN campo auditado no se apunta. La rama existía para las
    -- ediciones de verdad y desde C6 la dispara también el SELLO: la aceptación inserta la
    -- entrada —`EntradaKpiAgregada`, correcto— y el guard diferido le escribe después su
    -- `propuesta_ai_id`, que no es un campo del contrato y no está en `entrada_kpi_contenido`.
    -- Medido: cada aceptación de C6 dejaba un `EntradaKpiEditada` con el «antes» idéntico al
    -- «después», o sea una edición que nadie hizo, en la única tabla cuyo rastro sirve para
    -- decir quién movió el contrato de medición.
    --
    -- Se compara el CONTENIDO y no la lista de columnas tocadas, que es la diferencia que
    -- importa: así cubre también el otro caso —una edición humana que devuelve los campos a su
    -- valor anterior— sin tener que enumerar qué columnas son «de procedencia».
    if tg_op = 'UPDATE'
       and entrada_kpi_contenido(previa) = entrada_kpi_contenido(fila) then
      return null;
    end if;
    cuerpo := jsonb_build_object('entradaId', fila->'id', 'registryId', fila->'registry_id')
      || entrada_kpi_contenido(fila);
    -- El «antes» es lo que hace auditable una EDICIÓN: sin él, el rastro dice que alguien
    -- tocó la entrada pero no qué movió — y aquí lo que se mueve es el contrato.
    if previa is not null then
      cuerpo := cuerpo || jsonb_build_object('antes', entrada_kpi_contenido(previa));
    end if;
  elsif tg_table_name = 'snapshot' then
    evento := 'SnapshotRegistrado';
    cuerpo := jsonb_build_object('snapshotId', fila->'id', 'entradaId', fila->'entrada_kpi_id',
      'valor', fila->'valor', 'fecha', fila->'fecha', 'origen', fila->'origen');
  elsif tg_table_name = 'outcome_review' then
    -- La TRANSICIÓN —completar— ya tiene su evento en el guard del cierre, con el veredicto,
    -- la narrativa que congela y su `antes`; emitir otro aquí sería dos eventos para una
    -- sola escritura. Lo que faltaba es el UPDATE que NO es transición: el borrador que se
    -- redacta y se vuelve a redactar, que la política `review_completar` admite en su WITH
    -- CHECK (`estado = 'borrador'`) y el grant por columna permite. Sin este rastro, el post
    -- mortem —la pieza de la que sale el veredicto de un reto— era lo único del slice que
    -- se podía reescribir sin que nadie pudiera decir quién lo cambió ni qué reemplazó.
    if tg_op = 'UPDATE' and fila->>'estado' <> 'borrador' then
      return null;
    end if;
    evento := case tg_op when 'INSERT' then 'OutcomeReviewAbierto'
                         else 'OutcomeReviewEditado' end;
    cuerpo := jsonb_build_object('reviewId', fila->'id', 'retoId', fila->'reto_id')
      || outcome_review_narrativa(fila);
    if previa is not null then
      cuerpo := cuerpo || jsonb_build_object('antes', outcome_review_narrativa(previa));
    end if;
  else
    evento := case tg_op when 'INSERT' then 'ResultadoCriterioRegistrado'
                         else 'ResultadoCriterioEditado' end;
    cuerpo := jsonb_build_object('resultadoId', fila->'id', 'reviewId', fila->'review_id',
      'criterioId', fila->'criterio_id', 'snapshotFinalId', fila->'snapshot_final_id',
      'lectura', fila->'lectura', 'sinDatosMotivo', fila->'sin_datos_motivo');
    if previa is not null then
      cuerpo := cuerpo || jsonb_build_object('antes', jsonb_build_object(
        'snapshotFinalId', previa->'snapshot_final_id',
        'sinDatosMotivo', previa->'sin_datos_motivo', 'lectura', previa->'lectura'));
    end if;
  end if;
  -- Sin `jsonb_strip_nulls`: aquí un nulo es información, no un hueco. `resultado_criterio`
  -- lleva por CHECK exactamente uno de los dos —snapshot final o motivo de la falta—, así
  -- que quitar la clave nula borraría de qué tipo de resultado se trataba; y en `antes`
  -- convertiría «este campo estaba vacío y ahora tiene valor» en «este campo no se
  -- audita». El rastro dice lo que había, incluido que no había nada.
  -- El workspace sale de `fila`, que es `new` u `old` según la operación: en un DELETE no hay
  -- `new` que nombrar, y el rastro de una fila borrada es tan escritura como los demás.
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values ((fila->>'workspace_id')::uuid, evento, cuerpo,
      app_user_id(), workspace_role(app_user_id(), (fila->>'workspace_id')::uuid));
  return null;
end $$;
