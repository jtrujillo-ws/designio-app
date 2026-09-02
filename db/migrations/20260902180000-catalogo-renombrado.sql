-- ── Renombrar una entrada del catálogo la renombra EN TODAS PARTES ──
--
-- La política de `catalogo_journey` ya lo prometía con esas palabras («renombrarlo cambia
-- su nombre EN TODAS PARTES, que es justamente el punto de tener identidad»), y hasta
-- ahora lo cumplía el SERVICIO: `editarNodo` actualizaba la entrada y después, con una
-- sentencia aparte, la etiqueta de todos los nodos que la comparten.
--
-- El problema es que `grant update (nombre) on catalogo_journey` es una superficie
-- abierta, no un camino. Cualquier escritura que no pasara por esa función —SQL directo
-- con el rol de la app, una pantalla de catálogo el día que exista— renombraba la entrada
-- y dejaba TODAS las etiquetas viejas en su sitio. El catálogo decía una cosa y el
-- diagrama, el blueprint y el siguiente snapshot congelado decían otra: exactamente la
-- identidad partida que el catálogo existe para eliminar, entrando por la puerta de al
-- lado. Comprobado antes de escribir esto: renombrando la entrada de un canal usado por
-- dos journeys del mismo servicio, el catálogo pasaba a «App móvil (iOS y Android)» y los
-- dos nodos seguían rotulados «App móvil», sin ninguna forma de notarlo.
--
-- Así que la regla baja a la tabla, que es de donde no se sale. Es la misma doctrina que
-- ya rige el resto del grafo: la etiqueta de un nodo con catálogo la DERIVA
-- `journey_nodo_identidad_guard` en vez de aceptarla del formulario, y la auditoría vive
-- en triggers para que el SQL directo también la emita. Faltaba el otro lado de esa
-- derivación: qué pasa con los nodos ya escritos cuando cambia aquello de lo que derivan.

create function catalogo_renombrado_propaga() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tocados int;
begin
  -- Sin pre-chequeo anti-oráculo, y a propósito. Ese pre-chequeo protege a los guards que
  -- pueden DELATAR algo —los que levantan una excepción distinguible sobre filas que el
  -- llamante no debería ni saber que existen—, y este no levanta ninguna ni devuelve nada.
  -- Lo que sí haría aquí es abrir el agujero: un renombrado hecho por el propietario (una
  -- migración, el seed, una reparación) tiene `app_user_id()` nulo, no es miembro de
  -- ningún workspace, y se saltaría la propagación dejando justo las etiquetas rancias
  -- que esto viene a impedir.
  --
  -- SECURITY DEFINER es lo que hace TOTAL la propagación: corre sin RLS, así que alcanza
  -- todos los nodos de la entrada y no solo los que el que renombra podría escribir. La
  -- promesa es del modelo, no un permiso que el llamante ejerce — y sin esto quedaría
  -- atada a que la política de UPDATE de `journey_nodo` no se estreche nunca, que es
  -- precisamente el tipo de acoplamiento invisible que produce un renombrado a medias.
  -- El alcance no depende de nada que el llamante escriba: son las filas de ESTA entrada,
  -- en SU workspace, y para tocarla ya tuvo que pasar la política de `catalogo_update`.
  --
  -- El `is distinct from` no es una optimización: Postgres dispara los triggers igual en
  -- un UPDATE que no cambia nada, así que sin él un nodo que ya mostraba el nombre nuevo
  -- emitiría un `JourneyNodoEditado` que nadie provocó.
  update journey_nodo
  set etiqueta = new.nombre
  where catalogo_id = new.id
    and workspace_id = new.workspace_id
    and etiqueta is distinct from new.nombre;
  get diagnostics tocados = row_count;

  -- El renombrado del catálogo no estaba auditado en absoluto: la única mutación del
  -- modelo que cambia N filas de golpe era la única sin rastro. Los `JourneyNodoEditado`
  -- de cada nodo cuentan el efecto, pero no el acto — ni quién lo hizo, ni cómo se
  -- llamaba antes la entidad, que es la pregunta que se hace quien lee un journey viejo.
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (
    new.workspace_id,
    'CatalogoJourneyRenombrado',
    jsonb_build_object(
      'catalogoId', new.id, 'servicioId', new.servicio_id, 'tipo', new.tipo,
      'nombre', new.nombre, 'nodosActualizados', tocados,
      'antes', jsonb_build_object('nombre', old.nombre)),
    app_user_id(),
    workspace_role(app_user_id(), new.workspace_id));
  return null;
end $$;

-- El `when` deja fuera el UPDATE que reescribe el mismo nombre. Es la misma cautela del
-- `is distinct from` de arriba, un nivel más afuera: sin él, tocar la fila sin cambiarla
-- dejaría un `CatalogoJourneyRenombrado` de un renombrado que no ocurrió.
create trigger catalogo_renombrado
  after update on catalogo_journey
  for each row when (old.nombre is distinct from new.nombre)
  execute function catalogo_renombrado_propaga();
revoke execute on function catalogo_renombrado_propaga() from public;

-- ── Un UPDATE que no cambia nada no es una edición ──
--
-- Postgres dispara los triggers también cuando el UPDATE reescribe la fila con los mismos
-- valores, y este repositorio ya ha pagado ese peaje dos veces esquivándolo desde fuera:
-- el `<>` de la propagación de etiquetas y el `is distinct from` del trigger de arriba.
-- Esquivarlo desde fuera significa acordarse en cada sitio, y ya hay uno donde nadie se
-- acordó: `editarNodo` reescribe siempre la fila del nodo editado —le hace falta para
-- saber por el `count` si la política de escritura le dejó—, así que guardar el formulario
-- sin tocar nada emite un `JourneyNodoEditado` de una edición que no ocurrió. Con la
-- propagación ya en la tabla eso se nota más: el nodo renombrado recibe su etiqueta del
-- trigger y su propio UPDATE se queda sin nada que cambiar, y el historial contaría dos
-- veces un renombrado que pasó una.
--
-- La regla va donde vale para todos: si la fila entra y sale idéntica, no hay hecho que
-- auditar. El resto del cuerpo es el vigente palabra por palabra — `create or replace`
-- reemplaza la función entera, así que se copia y se añade, nunca se reescribe de memoria.
create or replace function journey_grafo_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  fila jsonb;
  previa jsonb;
  ws uuid;
  jid uuid;
  cuerpo jsonb;
  evento text;
begin
  -- Se trabaja sobre jsonb y no sobre el record: las tres tablas tienen columnas
  -- distintas, y plpgsql resuelve TODAS las referencias de campo de una expresión aunque
  -- la rama no se ejecute (`fila.origen_id` reventaría al auditar un nodo).
  fila := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  -- En un UPDATE, la fila vieja también: el evento tiene que decir QUÉ cambió, no solo
  -- que algo cambió. Como el update pisa la fila, un historial append-only que solo
  -- guarde el estado posterior no puede reconstruir la corrección — y auditar una
  -- corrección sin poder leerla es no auditarla.
  previa := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  -- Y si no cambió nada, no hay corrección que contar. La comparación es sobre el jsonb
  -- de la fila entera —las tres tablas caben en la misma expresión, que es la razón de
  -- trabajar así— y ninguna de sus columnas es de coma flotante, así que dos filas
  -- distintas no pueden parecerse por cómo se serializan.
  if previa is not null and previa is not distinct from fila then
    return null;
  end if;
  ws := (fila->>'workspace_id')::uuid;

  if tg_table_name = 'journey_nodo_evidencia' then
    select n.journey_id into jid from journey_nodo n
      where n.id = (fila->>'nodo_id')::uuid and n.workspace_id = ws;
    cuerpo := jsonb_build_object('nodoId', fila->'nodo_id', 'evidenciaId', fila->'evidencia_id');
    evento := case tg_op when 'INSERT' then 'JourneyEvidenciaEnlazada'
                         else 'JourneyEvidenciaDesenlazada' end;
  elsif tg_table_name = 'journey_nodo' then
    jid := (fila->>'journey_id')::uuid;
    cuerpo := jsonb_build_object(
      'nodoId', fila->'id', 'tipo', fila->'tipo', 'etiqueta', fila->'etiqueta',
      'detalle', fila->'detalle', 'responsable', fila->'responsable',
      'faseId', fila->'fase_id', 'orden', fila->'orden');
    if previa is not null then
      cuerpo := cuerpo || jsonb_build_object('antes', jsonb_build_object(
        'etiqueta', previa->'etiqueta', 'detalle', previa->'detalle',
        'faseId', previa->'fase_id', 'orden', previa->'orden',
        'responsable', previa->'responsable'));
    end if;
    evento := case tg_op when 'INSERT' then 'JourneyNodoAgregado'
                         when 'UPDATE' then 'JourneyNodoEditado'
                         else 'JourneyNodoBorrado' end;
  else
    jid := (fila->>'journey_id')::uuid;
    cuerpo := jsonb_build_object(
      'aristaId', fila->'id', 'tipo', fila->'tipo', 'condicion', fila->'condicion',
      'origenId', fila->'origen_id', 'destinoId', fila->'destino_id');
    if previa is not null then
      cuerpo := cuerpo || jsonb_build_object('antes', jsonb_build_object(
        'tipo', previa->'tipo', 'condicion', previa->'condicion'));
    end if;
    evento := case tg_op when 'INSERT' then 'JourneyAristaAgregada'
                         when 'UPDATE' then 'JourneyAristaEditada'
                         else 'JourneyAristaBorrada' end;
  end if;

  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (ws, evento, cuerpo || jsonb_build_object('journeyId', jid),
      app_user_id(), workspace_role(app_user_id(), ws));
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke execute on function journey_grafo_auditoria() from public;

-- ── Reparación de una sola vez ──
-- Una base que ya haya renombrado una entrada por fuera del servicio arrastra etiquetas
-- viejas, y el trigger nuevo solo mira los renombrados que vengan a partir de ahora.
-- Es idempotente: en una base sana no toca ninguna fila.
--
-- Los `JourneyNodoEditado` que emita la reparación llevan `actor_id` nulo, y así se queda:
-- no hubo actor. Ponerle el del último que renombró sería atribuirle una escritura que no
-- hizo, y `actor_id` es nullable justamente para poder decir «el sistema» sin mentir.
do $$
declare
  reparados int;
begin
  update journey_nodo n
  set etiqueta = c.nombre
  from catalogo_journey c
  where c.id = n.catalogo_id and c.workspace_id = n.workspace_id
    and n.etiqueta is distinct from c.nombre;
  get diagnostics reparados = row_count;
  if reparados > 0 then
    raise notice 'catálogo: % etiquetas de nodo estaban desincronizadas y se han puesto al día', reparados;
  end if;
end $$;
