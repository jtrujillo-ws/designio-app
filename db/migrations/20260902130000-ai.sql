-- SPEC-08 — capacidades AI vía el pipeline único PropuestaAI (CTX-08, ADR-0012/I4) y la
-- parte AI de SPEC-09 (degradación segura, RF-09.11/SYS-21).
--
-- La regla que estructura toda esta migración: la AI NUNCA escribe en el dominio. Propone;
-- un humano acepta, corrige o rechaza, y solo entonces —en la MISMA transacción— nace el
-- objeto real firmado por ese humano (SYS-19). El rol `agente-ai` no aparece por ninguna
-- parte: no es un actor que cura ni que aprueba (SYS-18).
--
-- Este slice materializa dos destinos, los únicos con objeto real hoy en el esquema:
--  · CI (extracción de importación, §12) → `evidencia` curada desde un item de la bandeja.
--  · C0 (borrador de reto) → `criterio_exito` del reto, con su ventana (SYS-22).
-- El resto de capacidades (C1-C7, CT) llegan con sus specs; el catálogo ya las nombra para
-- que su alta no reabra el CHECK de la tabla.
--
-- Mismo patrón multi-tenant de la casa: FKs compuestas (id, workspace_id), RLS día 1,
-- atribución fijada en la política, transiciones exigidas por WITH CHECK y efectos
-- (eventos + sellos temporales) emitidos DENTRO del guard que decide.
--
-- Tres tablas acompañan al pipeline y existen por lo mismo —que las promesas del slice se
-- cumplan aunque haya concurrencia, prisa o un proveedor que diga que no—:
-- `consentimiento_item` (RF-09.5: el material de personas no se procesa sin permiso
-- registrado ANTES), `reserva_ai` (RF-09.12: el presupuesto se aparta antes de llamar al
-- proveedor, no después de pagar) y `llamada_ai` (RF-09.14: el libro de las llamadas al
-- proveedor, que se escribe nazca o no una propuesta).

-- ── Consentimiento del material ANTES de procesarlo (RF-09.5) ─────────────────────────
-- Qué material lo exige. Vive en una función y no repartido por consultas: el día que
-- entren audio/vídeo transcritos, la lista se amplía en UN sitio y el bloqueo de la base,
-- el del servicio y el aviso de la UI se mueven juntos. No es SECURITY DEFINER ni lee
-- nada: es un mapa constante sobre su argumento, así que no hay oráculo que revocar.
create function tipo_fuente_exige_consentimiento(tipo text) returns boolean
language sql immutable parallel safe as $$
  select tipo in ('entrevista', 'observacion')
$$;

/*
 * ¿Este item tiene material del que se pueda extraer algo? La bandeja admite importar SOLO
 * la referencia al original, sin texto pegado (RF-03.1), y de ahí no puede salir una
 * evidencia fundada: el contrato de CI obliga al modelo a devolver una evidencia FECHADA y
 * con al menos una cita literal, y no hay herramienta de recuperación que lea la fuente
 * referenciada. Con el cuerpo vacío, lo único que el modelo tiene delante es la ficha
 * (título, tipo, referencia), así que la única forma de cumplir el contrato es inventar —
 * y sale una propuesta con pinta de fundamentada que costó presupuesto.
 *
 * El umbral es un SUELO («hay algo que citar»), no una medida de calidad: por debajo de una
 * frase no hay extracción posible. Vive en la base porque es la base quien lo impone —el
 * guard de propuesta_ai— y porque el servicio y el panel deben preguntar exactamente lo
 * mismo que se va a exigir, sin copiar el predicado en cada consulta.
 *
 * No hay arreglo posterior por diseño: `contenido` no está en el grant de UPDATE de la
 * bandeja (el material importado es inmutable, SYS-17), así que un item solo-referencia se
 * cura a mano o se vuelve a importar con el texto pegado.
 */
create function item_tiene_material_extraible(contenido text) returns boolean
language sql immutable parallel safe as $$
  select length(btrim(coalesce(contenido, ''))) >= 40
$$;

/*
 * El consentimiento de las personas se captura ANTES de procesar (RF-09.5), no se infiere
 * de un texto ni se rellena al final: hasta ahora nacía en `false` al aceptar la propuesta,
 * o sea DESPUÉS de que el material ya hubiera viajado al proveedor.
 *
 * Vive en su propia tabla y no en una columna de `item_importacion` por tres razones:
 *  · append-only por construcción — sin grant de UPDATE/DELETE no hay superficie con la
 *    que reescribir un consentimiento ya registrado, sin necesidad de un guard que lo
 *    defienda ni de ampliar el grant por columna de la bandeja (que hoy solo sella la
 *    decisión de curaduría);
 *  · no mezcla dos transiciones distintas sobre la misma fila: registrar consentimiento y
 *    decidir la curaduría son actos separados, con políticas separadas;
 *  · el registro tiene contenido propio (qué se autorizó y si cubre a un tercero) que no
 *    tiene por qué engordar la tabla caliente de la bandeja.
 *
 * Y es una BITÁCORA VERSIONADA, no un registro único por item. Con una clave primaria
 * (item_id, workspace_id) el primer registro era también el último: una persona que
 * autorizaba solo el uso interno (`procesamiento_externo = false`, entrada legítima) dejaba
 * el item bloqueado PARA SIEMPRE — el append-only impedía corregirlo y la PK impedía añadir
 * el permiso posterior. El consentimiento no es un estado, es una sucesión de hechos
 * fechados: cada registro es una fila nueva y lo que manda es el VIGENTE (el de mayor
 * versión). Así una autorización posterior desbloquea, y una revocación futura (RF-09.4)
 * vuelve a bloquear siendo también un registro nuevo — nunca un UPDATE sobre el anterior.
 */
create table consentimiento_item (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null,
  workspace_id uuid not null references workspace(id),
  -- Orden de la bitácora. Lo asigna el guard y NO está en el grant de insert: si el caller
  -- pudiera escribirlo, podría colar un registro con versión alta y convertir en «vigente»
  -- un hecho que no es el último — que es exactamente la reescritura que el append-only
  -- prohíbe, por la puerta de atrás. Un entero y no el timestamp: `now()` es el de la
  -- transacción, así que dos registros de la misma transacción empatarían y «el más
  -- reciente» dejaría de estar definido.
  version integer not null check (version >= 1),
  -- Qué autorizó la persona, en las palabras de quien lo recogió: es el registro del
  -- consentimiento, no el contrato.
  alcance text not null check (length(btrim(alcance)) between 1 and 1000),
  -- Y si ese consentimiento cubre EXPLÍCITAMENTE el procesamiento por un tercero: un
  -- permiso para grabar y transcribir en interno no autoriza mandar el material a un
  -- proveedor externo (RF-09.5 + condiciones de uso del proveedor, RF-09.9). Registrar
  -- consentimiento no es marcar una casilla: distingue qué se autorizó.
  procesamiento_externo boolean not null,
  registrado_por uuid not null references usuario(id),
  registrado_en timestamptz not null default now(),
  unique (id, workspace_id),
  -- El suelo de la bitácora: dos registros no pueden ocupar la misma posición. Es lo que
  -- convierte «leí el máximo y sumé uno» en una operación segura aunque dos curadores
  -- registren a la vez (el candado consultivo del servicio los serializa; esto es lo que
  -- pasa si alguien llega por otro camino).
  unique (item_id, workspace_id, version),
  foreign key (item_id, workspace_id) references item_importacion (id, workspace_id)
);

alter table consentimiento_item enable row level security;

create policy consentimiento_select on consentimiento_item
  for select using (is_workspace_member(app_user_id(), workspace_id));
-- Lo registra quien conduce la investigación (los mismos curadores que deciden la
-- bandeja) y queda atribuido por la política, no por el caller.
create policy consentimiento_insert on consentimiento_item
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and registrado_por = app_user_id()
  );

-- Posición en la bitácora y auditoría del registro (RF-09.13). El número de versión lo
-- pone el guard —no el caller— porque es lo que decide cuál es el registro vigente, y con
-- él el permiso para procesar. Sin `returning` en ningún lado: el evento se emite dentro
-- del trigger, así que quien registra no necesita poder LEER `evento_dominio`.
create function consentimiento_item_registro_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  -- El sello temporal y la posición los estampa la BASE: ni se antedata un consentimiento
  -- ni se reordena la bitácora desde la app.
  new.registrado_en := now();
  new.version := coalesce(
    (select max(c.version) + 1 from consentimiento_item c
      where c.item_id = new.item_id and c.workspace_id = new.workspace_id),
    1);
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (new.workspace_id, 'ConsentimientoRegistrado',
    jsonb_build_object('itemId', new.item_id, 'version', new.version,
                       'procesamientoExterno', new.procesamiento_externo),
    app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;

create trigger consentimiento_item_registro
  before insert on consentimiento_item
  for each row execute function consentimiento_item_registro_guard();

revoke execute on function consentimiento_item_registro_guard() from public;

-- Sin UPDATE ni DELETE: un consentimiento registrado es un hecho, no un campo editable —
-- lo que cambia el permiso es un registro NUEVO. Y el insert va por columnas: `version` y
-- `registrado_en` los escribe solo el guard, así que la app no puede fabricar un vigente
-- ni fechar hacia atrás. La promesa es estructural, no una convención del servicio.
grant select on consentimiento_item to designio_app;
grant insert (item_id, workspace_id, alcance, procesamiento_externo, registrado_por)
  on consentimiento_item to designio_app;

/*
 * El registro VIGENTE de un item autoriza (o no) el procesamiento externo. Una función y
 * no un predicado copiado en cada consulta: el guard de `propuesta_ai`, el servicio antes
 * de construir el prompt y el marcado del panel tienen que responder EXACTAMENTE lo mismo,
 * o la pantalla ofrecería lo que la base va a rechazar (o al revés, que es peor: material
 * de personas viajando porque una consulta miraba una fila vieja).
 *
 * Sin registros ⇒ false: el permiso se demuestra, no se presume. Y como solo mira el de
 * mayor versión, una revocación posterior vuelve a bloquear sin tocar nada más.
 */
create function consentimiento_externo_vigente(p_item_id uuid, p_workspace_id uuid)
returns boolean language sql stable as $$
  select coalesce(
    (select c.procesamiento_externo from consentimiento_item c
      where c.item_id = p_item_id and c.workspace_id = p_workspace_id
      order by c.version desc limit 1),
    false)
$$;

/*
 * ¿Los criterios de este reto están congelados? Un G0 aprobado certificó exactamente esos
 * criterios (SYS-22) y los cierra… salvo que la etapa 0 esté REABIERTA, que es el cambio
 * para el que existe la reapertura (RF-04.9) y que no desaprueba el gate (SYS-10).
 *
 * El predicado pasa a vivir en UNA función porque ya se le vio la costura: nació en las
 * políticas de `criterio_exito` (SPEC-04), la reapertura le añadió la excepción de la etapa
 * en SPEC-03/04 tocando política y guard… y las lecturas del pipeline AI —qué retos se
 * ofrecen como ancla, qué propuestas siguen siendo aceptables— se quedaron con la versión
 * vieja. El resultado eran errores en las dos direcciones: se ofrecía generar sobre retos
 * ya congelados y se ESCONDÍA la generación en retos legítimamente reabiertos.
 *
 * Con la función, la política y el guard siguen siendo quienes lo IMPONEN y las lecturas
 * anticipan exactamente lo mismo: un panel que ofrece un botón que la base va a rechazar es
 * tan malo como uno que esconde una acción permitida.
 */
create function reto_criterios_congelados(p_reto_id uuid, p_workspace_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
      and e.numero = 0
    where p.reto_id = p_reto_id and p.workspace_id = p_workspace_id
      and g.numero = 0 and g.estado = 'aprobado'
      and e.estado <> 'en-curso')
$$;

-- Y quienes lo imponen pasan a llamarla, para que no queden dos definiciones que puedan
-- volver a separarse. El resto del guard no cambia: el candado por G0 en orden estable
-- (dos guards concurrentes no se cruzan) y el evento de la transición siguen igual.
create or replace function criterio_g0_pendiente_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  perform 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id and g.numero = 0
    order by g.id for update of g;
  if reto_criterios_congelados(new.reto_id, new.workspace_id) then
    raise exception 'el G0 del reto está aprobado: criterios congelados';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id,
      case tg_op when 'INSERT' then 'CriterioDefinido' else 'CriterioEditado' end,
      jsonb_build_object('criterioId', new.id, 'retoId', new.reto_id, 'kpi', new.kpi),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;

drop policy criterio_insert on criterio_exito;
create policy criterio_insert on criterio_exito
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and not reto_criterios_congelados(criterio_exito.reto_id, criterio_exito.workspace_id)
  );
drop policy criterio_update on criterio_exito;
create policy criterio_update on criterio_exito
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and not reto_criterios_congelados(criterio_exito.reto_id, criterio_exito.workspace_id)
  )
  with check (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'));

-- ── Libro de llamadas al proveedor (RF-09.14) ─────────────────────────────────────────
/*
 * Una llamada al proveedor ocurrió, costó dinero y devolvió su `usage` UNA sola vez: ese
 * dato no se puede reconstruir después. Colgarlo de la propuesta hacía que existiera solo
 * si nacía una propuesta, y hay caminos completamente normales en los que la llamada se
 * paga y no nace ninguna: el proveedor se niega a responder (`stop_reason = 'refusal'`),
 * responde algo que no cumple el esquema de la capacidad, o la carrera por el item la gana
 * otro curador. Todas esas llamadas desaparecían de la observabilidad de costos justo
 * cuando más interesa mirarlas.
 *
 * Por eso el libro se escribe SIEMPRE que el proveedor fue invocado, en su propia
 * transacción y ANTES de persistir nada: si el guardado de las propuestas falla después, la
 * llamada sigue anotada. `resultado` describe lo que devolvió el PROVEEDOR, no lo que se
 * llegó a guardar, para que la fila no pueda mentir; cuántas propuestas nacieron de ella se
 * responde con un join desde `propuesta_ai`.
 *
 * Una fila por INTENTO, no por operación: cuando el primario cae por indisponibilidad y
 * responde el respaldo, hubo dos llamadas y las dos se anotan con su modelo, su desenlace y
 * su propia latencia. Con una sola fila, la tasa de error por modelo decía que el primario
 * no falla nunca y la latencia del respaldo arrastraba la espera del intento perdido — la
 * observabilidad por modelo (RF-09.14) medía algo que no había ocurrido.
 *
 * Y al existir la llamada como fila, el coste deja de repetirse en cada propuesta del lote:
 * el gasto del workspace es `sum(costo_usd)` sobre esta tabla, una fila por llamada, sin
 * sumar por `distinct` ni prorratear un entero de tokens entre 1..4 filas.
 */
create table llamada_ai (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  capacidad text not null check (capacidad in ('C0', 'CI')),
  -- El ancla que se procesó: el reporte de costos se lee por capacidad y por objeto, y una
  -- llamada sin propuestas seguiría sin decir sobre qué se gastó si no viviera aquí.
  item_id uuid,
  reto_id uuid,
  -- El modelo que respondió (puede ser el de respaldo tras una degradación) y la credencial
  -- que lo pagó: sin esto, el gasto no se puede atribuir en BYOAI (RF-09.9).
  modelo text not null,
  origen_key text not null check (origen_key in ('workspace', 'entorno')),
  -- Qué devolvió el proveedor. 'salida-valida' es «contenido que pasó el esquema de la
  -- capacidad»; lo demás son llamadas pagadas de las que no puede nacer nada.
  resultado text not null check (resultado in
    ('salida-valida', 'rechazo-proveedor', 'fuera-de-contrato', 'sin-respuesta')),
  motivo text not null default '' check (length(motivo) <= 500),
  -- Uso medido, no estimado. Los dos contadores viajan juntos o no viaja ninguno: medio
  -- `usage` no es un uso, es un número que engaña al sumarlo.
  tokens_entrada integer check (tokens_entrada is null or tokens_entrada >= 0),
  tokens_salida integer check (tokens_salida is null or tokens_salida >= 0),
  -- Al precio VIGENTE cuando se llamó: una tarifa nueva no reescribe el histórico. null si
  -- el modelo no tiene tarifa registrada — «no se sabe» no es «salió gratis».
  costo_usd numeric(12, 6) check (costo_usd is null or costo_usd >= 0),
  latencia_ms integer check (latencia_ms is null or latencia_ms >= 0),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (item_id, workspace_id) references item_importacion (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  check ((capacidad = 'CI') = (item_id is not null)),
  check ((capacidad = 'C0') = (reto_id is not null)),
  check ((tokens_entrada is null) = (tokens_salida is null)),
  -- Una llamada que no dio contenido utilizable DICE por qué: es la mitad del valor de
  -- anotarla (la otra es cuánto costó).
  check (resultado = 'salida-valida' or length(btrim(motivo)) > 0)
);
create index llamada_ai_ws_idx on llamada_ai (workspace_id, creado_en);

alter table llamada_ai enable row level security;

create policy llamada_select on llamada_ai
  for select using (is_workspace_member(app_user_id(), workspace_id));
-- La registra quien pidió la generación, y queda atribuida por la política: el gasto tiene
-- dueño (los mismos curadores que pueden pedir propuestas).
create policy llamada_insert on llamada_ai
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );

-- Una llamada que no produjo contenido utilizable deja rastro auditable: es dinero gastado
-- sin objeto que lo justifique y no debería haber que deducirlo de la ausencia de filas.
-- Se emite DENTRO del guard para que una escritura cruda lo produzca igual, y sin
-- `returning` (quien registra no necesita leer `evento_dominio`).
create function llamada_ai_registro_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.resultado <> 'salida-valida' then
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'LlamadaAISinPropuesta',
      jsonb_build_object('llamadaId', new.id, 'capacidad', new.capacidad,
                         'modelo', new.modelo, 'resultado', new.resultado,
                         'motivo', new.motivo, 'costoUsd', new.costo_usd),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

create trigger llamada_ai_registro
  before insert on llamada_ai
  for each row execute function llamada_ai_registro_guard();

revoke execute on function llamada_ai_registro_guard() from public;

-- Sin UPDATE ni DELETE: lo que costó una llamada ya hecha no se reescribe ni se borra.
grant select, insert on llamada_ai to designio_app;

create table propuesta_ai (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  capacidad text not null check (capacidad in
    ('C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'CT', 'CI')),
  -- Destino en el grafo: qué objeto REAL nace si un humano acepta.
  destino text not null check (destino in ('evidencia', 'criterio-exito')),

  -- Ancla del AlcanceDeContexto (RF-02.7): el objeto del workspace del que se derivó el
  -- prompt. Exactamente uno y del tipo que exige el destino — nada fuera del alcance entra
  -- al prompt y nada del prompt escapa a otro tenant (las FKs son compuestas).
  item_id uuid,
  reto_id uuid,

  -- Salida ESTRUCTURADA tipada por capacidad (Zod en la app: ContenidoCISchema/C0).
  -- `contenido_original` es la propuesta tal como la emitió el modelo y no cambia jamás
  -- (SYS-17: insumo de la tasa de corrección humana); `contenido` es lo que se materializa.
  contenido jsonb not null check (jsonb_typeof(contenido) = 'object'),
  contenido_original jsonb not null check (jsonb_typeof(contenido_original) = 'object'),
  confianza numeric check (confianza is null or (confianza >= 0 and confianza <= 1)),
  -- SYS-20: marca imborrable de los revisores AI por arquetipo (C4). No hay grant de
  -- UPDATE sobre esta columna: ni el rol de aplicación puede quitarla.
  es_simulacion boolean not null default false,

  estado text not null default 'propuesta'
    check (estado in ('propuesta', 'aceptada', 'corregida', 'rechazada')),

  -- ── Lineage (SYS-19, RF-09.9): con qué se generó y qué key sirvió ──
  -- Sin grant de UPDATE: el lineage de una propuesta es inmutable para la app.
  modelo text not null,
  prompt_version text not null,
  alcance_resumen text not null default '',
  -- BYOAI: qué credencial sirvió la llamada. Hoy la app resuelve siempre 'entorno'
  -- (el almacenamiento de la key por workspace espera al secret manager, RF-09.6);
  -- el catálogo ya admite 'workspace' para que ese día no haya migración de datos.
  origen_key text not null check (origen_key in ('workspace', 'entorno')),

  -- La llamada de la que salió. NOT NULL y con FK: ninguna propuesta puede existir sin su
  -- línea en el libro de costos, y una llamada que devolvió un lote (C0 propone varios
  -- criterios) es UNA fila de gasto con varias propuestas colgando. El uso, el coste y la
  -- latencia viven allí y no repetidos aquí: son de la llamada, no de cada propuesta, y
  -- repetirlos obligaba a sumar por `distinct` para no contar cuatro veces lo que se pagó
  -- una. Lo que sí es de la propuesta —modelo, versión de prompt, credencial, alcance— se
  -- queda: es su LINEAGE (SYS-19) y la evidencia materializada lo copia.
  llamada_id uuid not null,

  -- ── Revisión humana y materialización ──
  revisada_por uuid references usuario(id),
  revisada_en timestamptz,
  -- Punteros TIPADOS al objeto materializado (no un uuid polimórfico): la FK compuesta
  -- garantiza que existe, que es del tenant y que no puede borrarse por debajo.
  evidencia_id uuid,
  criterio_id uuid,

  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),

  unique (id, workspace_id),
  foreign key (item_id, workspace_id) references item_importacion (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  foreign key (llamada_id, workspace_id) references llamada_ai (id, workspace_id),
  foreign key (evidencia_id, workspace_id) references evidencia (id, workspace_id),
  foreign key (criterio_id, workspace_id) references criterio_exito (id, workspace_id),

  -- Destino ⇔ ancla ⇔ objeto materializado: el estado inválido es IMPOSIBLE (MOD), no
  -- una validación que algún camino futuro pueda saltarse.
  check ((destino = 'evidencia') = (item_id is not null)),
  check ((destino = 'criterio-exito') = (reto_id is not null)),
  check (evidencia_id is null or destino = 'evidencia'),
  check (criterio_id is null or destino = 'criterio-exito'),
  check (capacidad <> 'CI' or destino = 'evidencia'),
  check (capacidad <> 'C0' or destino = 'criterio-exito'),
  -- SYS-20: una simulación de revisor AI jamás se materializa como evidencia.
  check (not es_simulacion or destino <> 'evidencia'),

  -- Pendiente ⇒ sin revisor, sin sello y sin rastro en el dominio; decidida ⇒ con quién
  -- y cuándo. Y aceptada/corregida ⇒ EXACTAMENTE el objeto que su destino declara:
  -- ninguna propuesta puede quedar «aceptada» sin haber creado nada (SYS-19), ni una
  -- rechazada arrastrar un objeto creado a su sombra.
  check (estado <> 'propuesta' or (revisada_por is null and revisada_en is null)),
  check (estado = 'propuesta' or (revisada_por is not null and revisada_en is not null)),
  check ((estado in ('aceptada', 'corregida')) = (coalesce(evidencia_id, criterio_id) is not null)),
  -- 'aceptada' es aceptación LITERAL; editar es 'corregida', y ese es el dato que
  -- alimenta la tasa de corrección humana (SYS-17/§17).
  check (estado <> 'aceptada' or contenido = contenido_original)
);

create index propuesta_ai_ws_idx on propuesta_ai (workspace_id, estado, creado_en);
-- Un item tiene COMO MUCHO una propuesta pendiente, y el índice lo impone además de
-- servir la consulta («este item ya tiene propuesta pendiente» sin recorrer el
-- workspace). Que sea único y parcial es el punto: dos curadores concurrentes veían
-- cada uno un snapshot sin propuesta pendiente y ambos insertaban — un predicado sobre
-- un snapshot no es un candado, un índice único sí. La segunda escritura falla aunque
-- ninguna de las dos haya visto a la otra; el gasto duplicado en el proveedor lo corta
-- antes la reserva de más abajo. Decidir la propuesta libera el hueco: el índice solo
-- cubre `estado = 'propuesta'`, así que un item rechazado admite otra pasada.
create unique index propuesta_ai_item_pendiente_idx on propuesta_ai (workspace_id, item_id)
  where item_id is not null and estado = 'propuesta';

-- ── RLS ──
-- Lectura: cualquier miembro (el cliente también ve qué propuso la AI y quién decidió).
-- Escritura: SOLO curadores de la boutique (lead-boutique/diseñador) — los mismos que
-- curan la bandeja (RF-03.4) y definen criterios. Pedir una generación es una acción
-- humana atribuida; revisarla, también. `agente-ai` no aparece: no propone por su cuenta
-- ni decide (SYS-18).

alter table propuesta_ai enable row level security;

create policy propuesta_select on propuesta_ai
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy propuesta_insert on propuesta_ai
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    -- Toda propuesta NACE pendiente y sin decisión: sin esto se podría insertar directo
    -- una 'aceptada' con revisor forjado, saltándose la política de revisión (que solo
    -- cubre UPDATE) y con ella la firma humana del objeto materializado.
    and estado = 'propuesta'
    and revisada_por is null
    and revisada_en is null
    and evidencia_id is null
    and criterio_id is null
    -- SYS-17 desde el alta: el «original» es de verdad lo que el modelo dijo.
    and contenido = contenido_original
  );

-- La revisión es una TRANSICIÓN completa: solo alcanza pendientes y solo deja la fila
-- decidida y atribuida al humano del contexto. Decidida ⇒ inmutable (el USING ya no la
-- alcanza): la propuesta original se conserva aunque se corrija.
create policy propuesta_revisar on propuesta_ai
  for update
  using (
    estado = 'propuesta'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (
    estado in ('aceptada', 'corregida', 'rechazada')
    and revisada_por = app_user_id()
    and revisada_en is not null
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

-- ── Guard de la transición: sello temporal, inmutabilidad del original y auditoría ──
-- Los efectos van CON la transición y no en el servicio, para que el SQL crudo los
-- produzca igual (idioma de la casa; mismo patrón que gate_aprobar_suficiencia_guard).
create function propuesta_ai_revision_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
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

    -- La llamada referenciada tiene que ser LA QUE PRODUJO esta propuesta, no una
    -- cualquiera del workspace. La FK sola comprobaba existencia y tenant, así que por SQL
    -- crudo se podía colgar una extracción de una llamada C0, de otra ancla, de otro modelo
    -- o —lo peor para el libro— de un intento que terminó en negativa o sin respuesta: el
    -- panel atribuiría entonces un coste y una latencia que no son los suyos, y el gasto
    -- por capacidad dejaría de cuadrar. Se exige la coincidencia completa.
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
  if new.destino = 'evidencia'
     and new.contenido -> 'citas' is distinct from new.contenido_original -> 'citas' then
    raise exception 'las citas de una propuesta AI no se corrigen: son el rastro de lo que el modelo dijo haber leído';
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
    jsonb_strip_nulls(jsonb_build_object(
      'propuestaId', new.id, 'capacidad', new.capacidad, 'destino', new.destino,
      'modelo', new.modelo, 'evidenciaId', new.evidencia_id, 'criterioId', new.criterio_id)),
    app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;

create trigger propuesta_ai_revision
  before insert or update on propuesta_ai
  for each row execute function propuesta_ai_revision_guard();

-- ── Guard de materialización: el objeto lo FIRMA quien aceptó, y cierra su ancla ──
-- Los CHECKs de arriba exigen que exista un objeto; este exige que sea EL objeto correcto:
--  · CI ⇒ el item de la bandeja queda sellado como aprobado, con ESA evidencia y por el
--    MISMO humano que aceptó — la curaduría humana obligatoria (SYS-16) no se esquiva
--    aceptando una propuesta, y una evidencia AI no puede colarse sin pasar por bandeja.
--  · C0 ⇒ el criterio cuelga del reto de la propuesta y lo firma quien aceptó (SYS-19).
-- Diferido al commit porque el servicio materializa y sella en sentencias posteriores de
-- la misma transacción; una UPDATE cruda solitaria aborta.
create function propuesta_ai_materializacion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
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
  return null;
end $$;

create constraint trigger propuesta_ai_materializacion
  after update on propuesta_ai
  deferrable initially deferred
  for each row execute function propuesta_ai_materializacion_guard();

-- EXECUTE es de PUBLIC por defecto: sin esto, una sesión del rol de app podría adjuntar
-- estos SECURITY DEFINER a una tabla temporal propia y usarlos como oráculo de existencia
-- sobre items o criterios de OTROS workspaces.
revoke execute on function propuesta_ai_revision_guard() from public;
revoke execute on function propuesta_ai_materializacion_guard() from public;

-- ── Reserva del presupuesto AI: se aparta ANTES de llamar al proveedor ────────────────
/*
 * El presupuesto por workspace (RF-09.12) se contaba sobre lo PERSISTIDO y se comprobaba
 * en una transacción que commiteaba antes de la llamada, y el insert posterior no volvía
 * a mirar nada: N curadores concurrentes pasaban todos el mismo chequeo con 59/60 y cada
 * uno persistía su lote. El tope prometido se rebasaba por un margen arbitrario y, peor,
 * el gasto en el proveedor ya se había hecho.
 *
 * Una fila de reserva ocupa el hueco durante la llamada: se toma bajo candado consultivo
 * del workspace, se retira al terminar la generación y caduca sola, así que un proceso
 * muerto a mitad no bloquea el workspace para siempre.
 *
 * Lo que la reserva NO es (y sí era en su primera versión) es la contabilidad del gasto.
 * El tope diario cuenta LLAMADAS ATENDIDAS —las filas de `llamada_ai`—, porque es donde
 * está el dinero: una negativa del proveedor o una salida fuera de contrato se pagan y no
 * producen propuesta, y contando propuestas se podía reintentar sin fin sin mover el
 * contador. Así que retirar la reserva ya no «devuelve» nada: solo dice que esa generación
 * dejó de estar en vuelo, y lo que se gastó por el camino ya está anotado en el libro.
 *
 * Y hace de token de exclusión por ancla —item para CI, reto para C0—: dos curadores no
 * pueden tener a la vez una generación en curso sobre el mismo objeto, así que el gasto
 * duplicado se corta ANTES de la llamada (el índice único parcial de propuesta_ai es el
 * suelo para CI, pero llega cuando el dinero ya se gastó).
 */
create table reserva_ai (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  capacidad text not null check (capacidad in ('C0', 'CI')),
  -- El ancla que se está procesando. Las DOS columnas, no solo el item: la reserva es
  -- también el token de exclusión por ancla, y con `item_id` a secas las generaciones C0
  -- no excluían nada — dos curadores podían despachar sobre el mismo reto a la vez, pagar
  -- dos veces y dejar dos lotes pendientes sobre un ancla que la pantalla promete ofrecer
  -- una sola vez. El mismo agujero que ya estaba tapado para CI.
  item_id uuid,
  reto_id uuid,
  -- Cuántas LLAMADAS al proveedor puede llegar a hacer esta generación (primario y, si el
  -- primero cae por indisponibilidad, respaldo). Es lo que se aparta del presupuesto: el
  -- tope diario acota lo que se PAGA, y se paga por llamada atendida, no por propuesta.
  unidades smallint not null check (unidades between 1 and 8),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (item_id, workspace_id) references item_importacion (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  check ((capacidad = 'CI') = (item_id is not null)),
  check ((capacidad = 'C0') = (reto_id is not null))
);
create index reserva_ai_ws_idx on reserva_ai (workspace_id, creado_en);
-- Un índice parcial POR COLUMNA y no uno sobre un `coalesce` de las dos: cada uno dice su
-- promesa por separado —«un item, una generación en vuelo» y «un reto, una generación en
-- vuelo»— y así un reto puede tener en curso su C0 mientras un item cualquiera tiene el
-- suyo, sin estorbarse por compartir una clave sintética.
create unique index reserva_ai_item_idx on reserva_ai (workspace_id, item_id)
  where item_id is not null;
create unique index reserva_ai_reto_idx on reserva_ai (workspace_id, reto_id)
  where reto_id is not null;

-- Ventana de vida de una reserva: cuatro veces el timeout duro del proveedor. Se define
-- una sola vez y AQUÍ para que el conteo del servicio y la limpieza no puedan divergir;
-- ninguna llamada puede sobrevivirla (el SDK aborta a los 25 s).
create function reserva_ai_ventana() returns interval
language sql immutable parallel safe as $$ select interval '100 seconds' $$;

alter table reserva_ai enable row level security;

create policy reserva_select on reserva_ai
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy reserva_insert on reserva_ai
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );
-- Se libera la PROPIA reserva; las ajenas, solo cuando ya caducaron (recolección de
-- basura de un proceso muerto). Sin esto, un curador podría liberar la reserva viva de
-- otro y devolver el presupuesto al mismo agujero que esta tabla cierra.
--
-- Y un tercer caso, que es el que convierte una revocación de consentimiento en algo con
-- efecto: la reserva de un item cuyo consentimiento VIGENTE ya no autoriza el procesamiento
-- externo se puede retirar aunque la haya apartado otra persona. Es coherente con quién
-- puede registrar la revocación —los mismos curadores— y necesario: quien revoca casi nunca
-- es quien tiene la generación en vuelo, y sin esto el `delete` afectaría a cero filas y el
-- material saldría igual. La reserva es el token de despacho; retirar el permiso retira el
-- token.
create policy reserva_delete on reserva_ai
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and (
      creado_por = app_user_id()
      or creado_en <= now() - reserva_ai_ventana()
      or (item_id is not null and not consentimiento_externo_vigente(item_id, workspace_id))
    )
  );

-- Sin UPDATE: una reserva no se edita, se consume o se libera.
grant select, insert, delete on reserva_ai to designio_app;

-- ── Grants mínimos (UPDATE por columna: solo la transición y su materialización) ──
grant select, insert on propuesta_ai to designio_app;
-- Fuera del grant y por tanto sin superficie: capacidad, destino, item_id, reto_id,
-- contenido_original, confianza, es_simulacion, modelo, prompt_version, alcance_resumen,
-- origen_key, llamada_id, creado_por — el lineage y el original son inmutables
-- (SYS-17/19), y una propuesta no puede reapuntar a otra llamada que la pagó.
-- `revisada_en` tampoco: lo estampa el guard, no el caller.
grant update (estado, contenido, revisada_por, evidencia_id, criterio_id)
  on propuesta_ai to designio_app;
