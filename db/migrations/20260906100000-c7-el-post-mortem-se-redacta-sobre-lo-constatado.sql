-- ── C7: el post mortem se redacta sobre lo constatado, no sobre lo que se recuerda ──
--
-- Última capacidad por etapa (SPEC-08 §C7): «Detección de desviaciones + borrador post mortem
-- (7). Entrada: DV vs. constataciones; snapshots. Salida: discrepancias propuestas; narrativa
-- del outcome review sobre datos deterministas.»
--
-- ── LO QUE NO HIZO FALTA CONSTRUIR ──
--
-- Lo digo primero porque la tarea estaba escrita como «pieza de dominio: effective state y sus
-- desviaciones», y al medirlo resultó que ya estaba entero: `effective_state`, `constatacion`
-- —donde la DESVIACIÓN vive dentro, no como tabla aparte, porque separarlas permitiría
-- constatar un elemento como desviado sin desviación—, `release`, `release_elemento`,
-- `outcome_review`, `resultado_criterio`, `filas_de_conciliacion` y `g7_motivo_de_bloqueo`.
-- C7 no necesitaba suelo nuevo: necesitaba enchufarse al que ya había.
--
-- ── EL MATERIAL, QUE ES DETERMINISTA POR CONSTRUCCIÓN ──
--
-- Dos lecturas, las dos ya escritas y las dos ya usadas por el gate:
--
--   · `filas_de_conciliacion` — elemento a elemento, dónde quedó cada uno en la cadena
--     aprobado → release → despliegue → constatación, con el «qué quedó distinto» y la razón
--     que el lead registró. Es el reverso exacto del predicado que bloquea G7, así que el
--     material del modelo y el tablero que el humano mira son la MISMA lectura.
--   · `resultado_criterio` — por criterio, la lectura final (o el motivo por el que no hay
--     dato). Un XOR de la fila garantiza que nunca traiga las dos cosas.
--
-- Nada de esto lo interpreta el modelo: son filas. Lo que el modelo aporta es la PROSA, que es
-- lo único que la etapa 7 pedía a mano.
--
-- ── LAS DISCREPANCIAS NO SON UN SEGUNDO DESTINO ──
--
-- «Discrepancias propuestas» se leyó primero como un objeto nuevo que la AI propondría —una
-- constatación—, y eso es justo lo que NO puede hacer: una constatación es el testimonio de
-- quien miró qué quedó funcionando, y el modelo no miró nada. Además llegan como ENTRADA («DV
-- vs. constataciones»), no como salida: ya están registradas cuando C7 corre.
--
-- Las discrepancias salen, entonces, donde de verdad tienen sitio: DENTRO de la narrativa, que
-- las nombra citando el elemento y la constatación de la que salen. Y el hueco que quedaba
-- —«qué le falta a G7»— ya lo contesta CT, que ancla en el gate. Un segundo C7 informativo
-- anclado en G7 habría sido CT con otro nombre.
--
-- ── EL ANCLA ES EL OBJETO, Y ESO ES NUEVO EN ESTE PIPELINE ──
--
-- Las seis capacidades anteriores CREAN una fila al aceptarse: el criterio, el insight, la
-- entrada KPI, la oportunidad, la evidencia. C7 no: el post mortem YA EXISTE cuando C7 corre
-- —lo abre el lead al cerrarse la última ventana de medición (RF-07.7), y esa política es la
-- que decide cuándo hay algo que redactar— y lo que la aceptación hace es ESCRIBIR SUS CUATRO
-- CAMPOS NARRATIVOS. Así que aquí el ancla y el objeto materializado son la misma fila, y no
-- hay columna de objeto que añadir: sería una segunda forma de decir `outcome_review_id`.
--
-- Tiene dos consecuencias que se ven abajo:
--
--   1. La PROCEDENCIA no puede mirar `creado_en = now()`. Ese par —`xmin` más la fecha de
--      creación— distingue «esta transacción escribió esta versión» de «esta transacción la
--      INSERTÓ», y aquí no hay inserción: la fila es vieja. Queda `xmin`, que es exactamente
--      lo que hay que comprobar cuando lo que se sella es una edición.
--   2. Lo que se acepta es lo que se lee. La proyección se compara campo a campo contra el
--      contenido de la propuesta, igual que la HMW de C3 contra su `oportunidad`.
--
-- ── LO QUE C7 NO ESCRIBE, Y POR QUÉ ──
--
-- El VEREDICTO no. `logrado / parcialmente-logrado / no-logrado / no-concluyente` es el
-- dictamen, y RF-07.8 lo pone en manos de quien firma. Un modelo que lo propusiera estaría
-- proponiendo la conclusión del post mortem con el post mortem todavía sin leer.
--
-- Y `diseno_experimental_suficiente` tampoco, ni su justificación. Es la única casilla que
-- habilita lenguaje causal (SYS-24), y su justificación es la afirmación de un humano sobre el
-- diseño de SU medición. Dejarla al modelo sería abrir la puerta trasera al lenguaje causal
-- que esa invariante existe para cerrar — y encima con una firma que no es de nadie.

-- ═══════════════════════════════════════════════════════════════════════════
-- EL TABLERO DEL RETO ENTERO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `filas_de_conciliacion` contesta por UNA design version, que es lo que el tablero de G7
-- necesita: G7 es del proyecto. El post mortem es del RETO, y un reto puede tener varios
-- proyectos y cada uno varias versiones — así que la pregunta de C7 es una vuelta más ancha.
--
-- Se compone en vez de reescribirse: llama a la función que ya existe por cada design version
-- a cargo de cada proyecto del reto, y añade de quién es cada bloque. Reescribir el CASE aquí
-- habría dejado dos redacciones de «en qué estado está este elemento», que es exactamente lo
-- que aquella función existe para evitar.
--
-- El orden lo da el código de la design version interpretado, no su sello: es la lección que
-- `20260902120000` dejó escrita —dos relojes distintos, el del candado y el de `now()`, se
-- contradicen en cuanto hay espera— y aquí decide en qué orden lee el modelo.
create function conciliacion_del_reto(p_reto uuid, p_ws uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'proyectoCodigo', t.proyecto_codigo,
      'designVersionCodigo', t.dv_codigo,
      'elementos', t.filas)
    order by t.proyecto_codigo, t.orden_dv), '[]'::jsonb)
  from (
    select p.codigo as proyecto_codigo, dv.codigo as dv_codigo,
      (substring(dv.codigo from '[0-9]+$'))::bigint as orden_dv,
      filas_de_conciliacion(dv.id, dv.workspace_id) as filas
    from proyecto p
    join design_version dv on dv.workspace_id = p.workspace_id
      and dv.id in (select design_versions_a_cargo_del_proyecto(p.id, p.workspace_id))
    where p.reto_id = p_reto and p.workspace_id = p_ws
  ) t
$$;

comment on function conciliacion_del_reto(uuid, uuid) is
'El tablero de conciliación de TODAS las design versions a cargo de los proyectos de un reto, agrupado por proyecto y versión. Compone `filas_de_conciliacion` en vez de reescribir su CASE: «en qué estado está este elemento» se dice en un solo sitio. Es el material determinista de C7.';

revoke execute on function conciliacion_del_reto(uuid, uuid) from public;
-- No es SECURITY DEFINER: lee bajo las políticas del rol de la app, igual que la función que
-- compone. Un material que viera filas que su lector no puede leer sería otro oráculo.
grant execute on function conciliacion_del_reto(uuid, uuid) to designio_app;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL ANCLA: EL POST MORTEM EN BORRADOR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El ancla es el objeto del que sale el material Y aquel sobre el que se escribe — y aquí, por
-- primera vez en este pipeline, son literalmente la MISMA FILA.
--
-- Se ancla en el review y no en el reto por lo mismo que C6 se ancla en el registry: la fila
-- tiene que existir para que haya dónde materializar, y la política que la crea es la que sabe
-- CUÁNDO hay algo que redactar —«el outcome review se habilita al cerrar la ventana del último
-- criterio» (RF-07.7)—. Anclando en el reto, C7 se ofrecería en retos que todavía están
-- midiendo y no tendría dónde escribir; anclando en el review, la ventana la decide quien ya
-- la decidía.
alter table reserva_ai   add column outcome_review_id uuid;
alter table llamada_ai   add column outcome_review_id uuid;
alter table propuesta_ai add column outcome_review_id uuid;

alter table reserva_ai add
  foreign key (outcome_review_id, workspace_id) references outcome_review (id, workspace_id);
alter table llamada_ai add
  foreign key (outcome_review_id, workspace_id) references outcome_review (id, workspace_id);
alter table propuesta_ai add
  foreign key (outcome_review_id, workspace_id) references outcome_review (id, workspace_id);

create index propuesta_ai_review_idx on propuesta_ai (workspace_id, outcome_review_id)
  where outcome_review_id is not null;

-- Y su grant, columna a columna como las otras cinco anclas. Sin esto, la reserva de C7 muere
-- con «permission denied for table reserva_ai» —así reporta Postgres una columna sin
-- privilegio en un INSERT—, y no solo la de C7: el pipeline enumera TODAS las columnas de
-- ancla en el mismo insert, así que la que falta tumba a las siete capacidades a la vez. Lo
-- dijeron 147 pruebas.
grant insert (outcome_review_id) on reserva_ai   to designio_app;
grant insert (outcome_review_id) on llamada_ai   to designio_app;
grant insert (outcome_review_id) on propuesta_ai to designio_app;

-- ═══════════════════════════════════════════════════════════════════════════
-- LAS EQUIVALENCIAS DEL PIPELINE, CADA UNA CON SU LISTA COMPLETA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Cada `drop`+`add` lleva la lista ENTERA y no un añadido: una restricción que se amplía en
-- varios sitios acaba diciendo cosas distintas en cada esquema según qué migraciones corrieron.
alter table propuesta_ai drop constraint propuesta_ai_un_ancla;
alter table propuesta_ai add constraint propuesta_ai_un_ancla
  check (num_nonnulls(item_id, reto_id, gate_id, journey_id, registry_id, outcome_review_id) = 1);

-- El nombre NO es libre: hay un censo que compone `<tabla>_ancla_<columna sin _id>` desde
-- `COLUMNAS_DE_ANCLA` y exige que exista una por tabla y por columna, para que una migración
-- que borre la suya en vez de rehacerla deje el ancla sin sujetar y se note. Llamarlas
-- «_ancla_c7» las habría dejado invisibles para ese censo.
alter table propuesta_ai add constraint propuesta_ai_ancla_outcome_review
  check ((capacidad = 'C7') = (outcome_review_id is not null));
alter table llamada_ai add constraint llamada_ai_ancla_outcome_review
  check ((capacidad = 'C7') = (outcome_review_id is not null));
alter table reserva_ai add constraint reserva_ai_ancla_outcome_review
  check ((capacidad = 'C7') = (outcome_review_id is not null));


-- El vocabulario de destinos, con el séptimo dentro.
alter table propuesta_ai drop constraint propuesta_ai_destino_vocabulario;
alter table propuesta_ai add constraint propuesta_ai_destino_vocabulario
  check (destino in ('evidencia', 'criterio-exito', 'insight', 'entrada-kpi', 'oportunidad',
                     'outcome-review'));

-- Y la pareja destino ⇄ ancla. No hay «objeto materializado» que atar aparte —el ancla ES el
-- objeto—, así que esta es la única atadura que hace falta y decirla dos veces sería inventar
-- una columna `outcome_review_materializado_id` que solo podría copiar a la de arriba.
-- ── «ACEPTADA ⇔ HAY OBJETO» HABLA DE OBJETOS QUE NACEN ──
--
-- La restricción cuenta las columnas del objeto materializado y exige exactamente una en cuanto
-- la propuesta se acepta. C7 no encaja, y no por un descuido: su objeto no nace al aceptar
-- —existe desde antes, es su ancla— así que `outcome_review_id` está puesto desde que la
-- propuesta se crea, y la equivalencia sería verdad para una propuesta todavía pendiente.
--
-- Lo que para las otras garantiza esta restricción —que aceptar produjo el objeto que dice— lo
-- garantizan para C7 la PROCEDENCIA y la PROYECCIÓN del guard diferido: que esta transacción
-- escribió esa fila, y que lo que escribió es lo que la propuesta decía. Son dos
-- comprobaciones más fuertes que contar columnas; lo que no son es la misma.
--
-- Se nombra `outcome_review_id` de todos modos, y no por adorno: hay un censo que exige que la
-- columna de destino de CADA destino declarado aparezca en esta definición, precisamente para
-- que un destino nuevo no se quede fuera de la cuenta y su primera aceptación sea imposible.
-- La rama de C7 dice qué cuenta para C7, que es la respuesta a esa pregunta.
alter table propuesta_ai drop constraint propuesta_ai_objeto_materializado;
alter table propuesta_ai add constraint propuesta_ai_objeto_materializado
  check (
    case
      when destino = 'outcome-review'
        then outcome_review_id is not null
             and num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id,
                              oportunidad_id) = 0
      when estado not in ('aceptada', 'corregida')
        then num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id,
                          oportunidad_id) = 0
      when destino = 'entrada-kpi'
        then num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id,
                          oportunidad_id) <= 1
      else num_nonnulls(evidencia_id, criterio_id, insight_id, entrada_kpi_id,
                        oportunidad_id) = 1
    end);

-- ── Y EL TECHO DE LA NARRATIVA, QUE VIVÍA SOLO EN EL FORMULARIO ──
--
-- `TOPE_NARRATIVA` acota los cuatro campos desde la pantalla de la etapa 7, y la columna no
-- decía nada: `text not null default ''` y hasta ahí. Mientras solo escribía una persona, el
-- formulario bastaba. Desde que escribe un modelo, no: el contrato de lo que cabe tiene que
-- estar donde está el dato, o la primera respuesta larga se guarda entera y el tope se
-- convierte en una costumbre de una pantalla. Es la misma lección que los cuatro topes de C6,
-- y aquí llega por el otro lado — allí faltaba el tope en el esquema, aquí en la tabla.
alter table outcome_review add constraint outcome_review_topes_de_narrativa
  check (length(contribucion) <= 8000 and length(factores_externos) <= 8000
     and length(hipotesis_abiertas) <= 8000 and length(aprendizajes) <= 8000);

alter table propuesta_ai add constraint propuesta_ai_destino_c7
  check (capacidad <> 'C7' or destino = 'outcome-review');
alter table propuesta_ai add constraint propuesta_ai_destino_del_review
  check ((destino = 'outcome-review') = (outcome_review_id is not null));

-- Y el sello de procedencia en la fila del post mortem, que es lo que la rama nueva del
-- despachador escribe. Fuera de todo grant a propósito: lo pone el guard, que corre como
-- propietario, y nadie más tiene por qué decir de qué propuesta salió una narrativa.
alter table outcome_review add column propuesta_ai_id uuid;
alter table outcome_review add
  foreign key (propuesta_ai_id, workspace_id) references propuesta_ai (id, workspace_id);
create index outcome_review_propuesta_idx on outcome_review (workspace_id, propuesta_ai_id)
  where propuesta_ai_id is not null;
-- ── EL SELLO DE PROCEDENCIA NO LO ESCRIBE LA APLICACIÓN ──
--
-- `grant select, insert on outcome_review` es de TABLA, así que la columna nueva entró en él
-- sola y el rol de la app podía escribir de qué propuesta salió una narrativa al crear el post
-- mortem. Hay un censo que lo prohíbe para todas las tablas selladas, y con razón: un sello que
-- puede poner quien escribe la fila no atribuye nada — deja atribuir.
--
-- Y no basta con `revoke insert (propuesta_ai_id)`: un privilegio de TABLA no se recorta por
-- columnas. Mientras el grant de tabla siga en pie, cubre todas —incluidas las que se revocan—
-- y el revoke no hace nada, en silencio. Lo comprobé: el censo siguió señalando la fila.
--
-- Así que se baja el INSERT a columnas, enumerándolas. La lista es la de hoy menos el sello, y
-- eso tiene un coste que conviene decir: una columna nueva en esta tabla habrá que añadirla
-- aquí. Es el mismo coste que ya pagan `insight`, `evidencia` y las demás tablas selladas, y
-- se paga por lo mismo — que el sello lo ponga el guard y no quien escribe la fila.
revoke insert on outcome_review from designio_app;
grant insert (workspace_id, reto_id, estado, veredicto, contribucion, factores_externos,
              hipotesis_abiertas, aprendizajes, diseno_experimental_suficiente,
              diseno_experimental_justificacion, completado_por, completado_en, creado_por)
  on outcome_review to designio_app;

-- ── LA PROPUESTA CUELGA DE LA LLAMADA QUE LA PRODUJO ──
--
-- Hermano del guard de linaje de C6, y por lo mismo: sin él, una propuesta de C7 puede colgar
-- de la llamada de otro post mortem —y entonces el libro de costos y el lineage dicen cosas
-- distintas sobre la misma fila, que es justo lo que el lineage existe para que no pase—.
--
-- Que ninguna columna de ancla se quede sin su comparación lo sujeta un censo que enfrenta
-- `COLUMNAS_DE_ANCLA` contra el TEXTO de los guards de `propuesta_ai`, buscando literalmente
-- «l.<columna> is not distinct from new.<columna>». Es una prueba sobre el código fuente y eso
-- suena frágil, pero es lo que hace falta: la alternativa es que una columna nueva se quede sin
-- comparar y no lo diga nadie. Me lo dijo a mí, en esta misma migración.
create function propuesta_ai_c7_linaje_guard() returns trigger
language plpgsql as $$
begin
  if new.capacidad <> 'C7' then
    return new;
  end if;
  if not exists (
    select 1 from llamada_ai l
    where l.id = new.llamada_id and l.workspace_id = new.workspace_id
      and l.outcome_review_id is not distinct from new.outcome_review_id
  ) then
    raise exception 'la propuesta debe colgar de la llamada que la produjo: mismo post mortem';
  end if;
  return new;
end $$;

revoke execute on function propuesta_ai_c7_linaje_guard() from public;

create trigger a_propuesta_ai_c7_linaje
  before insert on propuesta_ai
  for each row execute function propuesta_ai_c7_linaje_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- LA MATERIALIZACIÓN, CON LA SÉPTIMA RAMA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El cuerpo entero, porque `create or replace` SUSTITUYE. Sale de la última versión vigente
-- —volcada con `pg_get_functiondef` sobre el esquema recién migrado, no copiada de una
-- migración anterior—, que es la disciplina que este repositorio aprendió a la mala: copiar de
-- la primera versión se llevó por delante catorce reescrituras y lo dijeron 52 pruebas a la
-- vez.
--
-- Lo añadido son cuatro trozos, y ninguno toca a los seis destinos anteriores: el candado del
-- reto del post mortem, el predicado, la procedencia con su proyección, y la rama del
-- despachador que sella. El `else` que grita se queda donde está — es el que obliga a que un
-- destino nuevo diga qué objeto sella, y es exactamente lo que ha hecho falta contestar aquí.
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
  -- Y el del RETO del post mortem, que es la clave que toma quien lo completa
  -- (`bloquearReto`). Como las otras dos: arriba del todo, porque el orden de los candados es
  -- una propiedad de la transacción entera y no de la regla que lo necesita. `outcome_review`
  -- es 1:1 con su reto, así que la clave sale de él y no hay una nueva que ordenar.
  if new.outcome_review_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || (
      select o.reto_id from outcome_review o
      where o.id = new.outcome_review_id and o.workspace_id = new.workspace_id), 42));
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
  -- ── EL POST MORTEM: EL ANCLA ES EL OBJETO ──
  --
  -- Las seis anteriores comprueban que existe una fila NUEVA con la forma esperada. Aquí la
  -- fila es vieja por construcción —el review lo abrió el lead al cerrarse la última ventana
  -- de medición (RF-07.7), y C7 se ancla en él justamente porque ya existe—, así que lo que
  -- se comprueba es otra cosa: que siga siendo un BORRADOR.
  --
  -- Un post mortem completado es inmutable, y con razón: lleva el veredicto firmado con nombre
  -- y fecha. Escribirle la narrativa después de cerrado cambiaría el documento sobre el que
  -- alguien puso su firma. La política de `outcome_review` ya lo impide por su lado; aquí se
  -- repite porque el camino de ACEPTACIÓN es otra escritura y llega por otra puerta, que es el
  -- mismo motivo por el que la entrada KPI repite lo suyo.
  --
  -- No se exige «lo firma quien aceptó»: nadie CREA esta fila en la aceptación, y `creado_por`
  -- es de quien abrió el post mortem semanas antes. Quien aceptó consta donde tiene que
  -- constar, en `revisada_por` de la propia propuesta.
  if new.destino = 'outcome-review' and not exists (
    select 1 from outcome_review o
    where o.id = new.outcome_review_id and o.workspace_id = new.workspace_id
      and o.estado = 'borrador') then
    raise exception 'el post mortem materializado tiene que seguir siendo un borrador: uno completado lleva un veredicto firmado, y su narrativa ya no se reescribe (SYS-19)';
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
  -- ── LA PROCEDENCIA DE UNA EDICIÓN ──
  --
  -- `xmin` a secas, y aquí sí es lo correcto en vez de la aproximación que las otras tuvieron
  -- que reforzar. Dice «esta transacción escribió esta versión de la fila», que es exactamente
  -- lo que hay que exigir cuando lo materializado es una EDICIÓN: el par con `creado_en =
  -- now()` existe en las otras para distinguir insertar de actualizar, y aquí no hay nada que
  -- distinguir — la fila es vieja a propósito y lo que se sella es su versión nueva.
  --
  -- Sin esto, la puerta es la de siempre: redactar la narrativa a mano y DESPUÉS marcar
  -- aceptada la propuesta pendiente, y el post mortem consta escrito por la AI. Lo que se
  -- mueve con eso no es una fila: es la tasa de corrección humana, y hacia el lado optimista.
  if new.destino = 'outcome-review' and not exists (
    select 1 from outcome_review o
    where o.id = new.outcome_review_id and o.workspace_id = new.workspace_id
      and o.xmin = pg_current_xact_id()::xid) then
    raise exception 'el post mortem materializado tiene que haberlo escrito esta misma aceptación: una propuesta no puede apropiarse de una narrativa que ya estaba (SYS-19)';
  end if;
  -- ── Y LO QUE SE ACEPTÓ ES LO QUE SE LEYÓ ──
  --
  -- Mismo argumento que la proyección de la HMW de C3: la procedencia dice que esta
  -- transacción escribió la fila, no QUÉ escribió. Con solo `xmin`, aceptar la propuesta y
  -- escribir en el review un texto distinto —en la misma transacción— pasa las dos
  -- comprobaciones, y queda un post mortem que no dice lo que el humano leyó al aceptar,
  -- firmado como si lo dijera.
  --
  -- Los cuatro campos, que son los que C7 propone. El veredicto no está, ni la casilla del
  -- diseño experimental: no se proponen, así que el review puede traer lo que traiga en ellos
  -- sin que esta comprobación tenga nada que decir.
  if new.destino = 'outcome-review' and not exists (
    select 1 from outcome_review o
    where o.id = new.outcome_review_id and o.workspace_id = new.workspace_id
      and o.contribucion       = new.contenido ->> 'contribucion'
      and o.factores_externos  = new.contenido ->> 'factoresExternos'
      and o.hipotesis_abiertas = new.contenido ->> 'hipotesisAbiertas'
      and o.aprendizajes       = new.contenido ->> 'aprendizajes') then
    raise exception 'el post mortem escrito no dice lo que dice la propuesta que se aceptó (SYS-19)';
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
  elsif new.destino = 'outcome-review' then
    -- SIN `propuesta_ai_id is null`, y es la única rama que lo omite. Las otras sellan un
    -- objeto que NACE, y un objeto tiene una sola procedencia para siempre. Ésta sella una
    -- EDICIÓN: la columna dice de qué propuesta salió la narrativa que hay ahora, así que un
    -- segundo borrador aceptado la sustituye, igual que sustituyó al texto. Con el guardián
    -- puesto, el segundo intento moriría diciendo «ese objeto ya cuelga de otra propuesta»,
    -- que es verdad y no viene al caso: la primera sigue archivada y legible (SYS-17), que es
    -- donde vive la historia.
    update outcome_review set propuesta_ai_id = new.id
      where id = new.outcome_review_id and workspace_id = new.workspace_id;
    get diagnostics v_filas = row_count;
  else
    raise exception 'destino de propuesta AI sin sello de procedencia: % — un destino nuevo tiene que decir qué objeto sella (SYS-19)', coalesce(new.destino, '(sin destino)');
  end if;
  if v_filas <> 1 then
    raise exception 'ese objeto ya cuelga de otra propuesta AI: un objeto materializado tiene una sola procedencia (SYS-19)';
  end if;

  return null;
end $function$
;

-- ── Y el rastro de la medición, que la aceptación de C7 hacía mentir ──
--
-- ⚠ CUIDADO AL INTEGRAR: esto REEMPLAZA el cuerpo vivo de `medicion_auditoria`. El que sigue
-- sale de `pg_get_functiondef` sobre la versión que dejó C6, con una sola línea de diferencia.
--
-- El caso es el de C6 repetido en otra tabla: aceptar una propuesta escribe el objeto —evento
-- correcto— y después el guard diferido le escribe su `propuesta_ai_id`, que no es un campo
-- del contenido auditado. Ese segundo UPDATE dejaba un `OutcomeReviewEditado` con el «antes»
-- idéntico al «después», o sea una edición que nadie hizo, en el rastro de la pieza de la que
-- sale el veredicto de un reto.
--
-- C6 ya lo había resuelto y lo dejó escrito en su propia rama; esto es aplicar la misma cura
-- a la rama de al lado, que la necesitaba desde el momento en que `outcome_review` pasó a
-- tener columna de procedencia.
CREATE OR REPLACE FUNCTION public.medicion_auditoria()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- Y un UPDATE que no mueve NINGÚN campo auditado tampoco se apunta, exactamente como en
    -- la rama de `entrada_kpi` y por el mismo motivo, que C7 vuelve a traer: la aceptación
    -- escribe la narrativa —`OutcomeReviewEditado`, correcto— y el guard diferido le escribe
    -- después su `propuesta_ai_id`, que no es un campo de la narrativa y no está en
    -- `outcome_review_narrativa`. Ese segundo UPDATE dejaba un `OutcomeReviewEditado` con el
    -- «antes» idéntico al «después»: una edición humana que nadie hizo, apuntada en el rastro
    -- de la pieza de la que sale el veredicto de un reto.
    --
    -- Se compara el CONTENIDO y no la lista de columnas tocadas, por lo mismo que allí: cubre
    -- también la edición humana que devuelve los campos a su valor anterior, sin tener que
    -- enumerar qué columnas son «de procedencia».
    if tg_op = 'UPDATE'
       and outcome_review_narrativa(previa) = outcome_review_narrativa(fila) then
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
end $function$
;
