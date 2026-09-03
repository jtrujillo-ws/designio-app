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
  -- Redundante como clave (el `procesamiento_externo` depende funcionalmente de las tres
  -- de arriba) y aun así necesaria: es lo que hace EXPRESABLE la FK de `llamada_ai`, que
  -- no cita una versión cualquiera sino una que autorizara la salida. Una FK solo puede
  -- apuntar a un índice único NO parcial, así que la condición viaja como columna dentro
  -- de la clave en vez de como `where`. Sin esto, «autorizó» tendría que comprobarlo un
  -- guard, y un guard es una comprobación que hay que acordarse de escribir.
  unique (item_id, workspace_id, version, procesamiento_externo),
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
 * ¿Los criterios de este reto están congelados? A día de hoy por DOS causas distintas, y por
 * eso son tres funciones y no una: el predicado compuesto es lo que las políticas y las
 * lecturas necesitan («¿puedo escribir criterios?», una sola respuesta), pero cada causa se
 * explica distinto, caduca por un camino distinto y merece su propio mensaje. Fundirlas
 * daría un único `raise` que mentiría en la mitad de los casos, que es justo lo que este
 * bloque vino a evitar.
 *
 *  · **G0 aprobado** (SPEC-04, SYS-22): el gate certificó EXACTAMENTE esos criterios… salvo
 *    que la etapa 0 esté REABIERTA, que es el cambio para el que existe la reapertura
 *    (RF-04.9) y que no desaprueba el gate (SYS-10). Se descongela reabriendo la etapa.
 *  · **Registry firmado** (SPEC-07, SYS-22): los criterios de medición son el contrato
 *    acordado y la firma es de ida. No se descongela: no hay reapertura que valga.
 *
 * El predicado pasa a vivir en funciones porque ya se le vio la costura: nació en las
 * políticas de `criterio_exito` (SPEC-04), la reapertura le añadió la excepción de la etapa
 * en SPEC-03/04 tocando política y guard, SPEC-07 le añadió el registry tocando otra vez
 * los dos… y las lecturas del pipeline AI —qué retos se ofrecen como ancla, qué propuestas
 * siguen siendo aceptables— se quedaron con la versión vieja. El resultado eran errores en
 * las dos direcciones: se ofrecía generar sobre retos ya congelados y se ESCONDÍA la
 * generación en retos legítimamente reabiertos.
 *
 * Con las funciones, la política y el guard siguen siendo quienes lo IMPONEN y las lecturas
 * anticipan exactamente lo mismo: un panel que ofrece un botón que la base va a rechazar es
 * tan malo como uno que esconde una acción permitida.
 */
create function reto_g0_congela_criterios(p_reto_id uuid, p_workspace_id uuid)
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

create function reto_registry_firmado(p_reto_id uuid, p_workspace_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from metric_registry r
    where r.reto_id = p_reto_id and r.workspace_id = p_workspace_id
      and r.estado = 'firmado')
$$;

-- La unión, que es lo que responde «¿se pueden escribir criterios en este reto?». La llaman
-- las dos políticas de `criterio_exito`, los dos guards de `propuesta_ai` y las lecturas del
-- panel; quien necesite además saber POR QUÉ no, pregunta por la causa concreta.
create function reto_criterios_congelados(p_reto_id uuid, p_workspace_id uuid)
returns boolean language sql stable as $$
  select reto_g0_congela_criterios(p_reto_id, p_workspace_id)
      or reto_registry_firmado(p_reto_id, p_workspace_id)
$$;

-- Y su HERMANO, que responde otra pregunta sobre el mismo reto: si su ciclo de vida sigue
-- en un punto donde caben criterios nuevos. No se fusiona con el de arriba y conviene decir
-- por qué: «congelado» es una decisión del método (un G0 certificó ESTOS criterios, SYS-22)
-- y se revierte reabriendo la etapa 0 (RF-04.9); «ya no admite» es el ciclo de vida del reto
-- (RF-04.12), que es de sentido único y no se revierte nunca. Se explican distinto al
-- revisor y caducan por caminos distintos, así que fundirlos daría un único mensaje que
-- mentiría en la mitad de los casos.
--
-- Vive en una función por lo mismo que el otro: el predicado ya estaba escrito a mano en el
-- guard del INSERT de propuestas, y en cuanto la aceptación pasó a exigirlo también habría
-- pasado a estar en dos sitios — y las lecturas del panel, en un tercero. Quienes lo IMPONEN
-- (los dos guards) y quien lo ANTICIPA (el panel y el servicio) llaman todos aquí.
create function reto_admite_criterios(p_reto_id uuid, p_workspace_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from reto r
    where r.id = p_reto_id and r.workspace_id = p_workspace_id
      and r.estado in ('candidato', 'activo'))
$$;

-- Y quienes lo imponen pasan a llamarlas, para que no queden dos definiciones que puedan
-- volver a separarse. El resto del guard no cambia: el candado por G0 en orden estable
-- (dos guards concurrentes no se cruzan) y el evento de la transición siguen igual.
--
-- ⚠ CUIDADO AL INTEGRAR: lo que sigue REEMPLAZA un cuerpo vivo definido en migraciones
-- anteriores, y lo mismo hacen los dos `drop policy` de más abajo. En base limpia gana la
-- migración de número más alto —esta—, así que si otra rama añade una regla a este guard o
-- a esas políticas en una migración ANTERIOR, esta la borra en silencio: no habrá conflicto
-- de merge que avise, porque los ficheros son distintos.
--
-- Ya pasó una vez y así se hizo, que es la receta: SPEC-07 (`…110000-medicion.sql`) le había
-- añadido al guard la regla del registry firmado y un payload de evento con las ocho
-- columnas editables del criterio más su `antes`. Al reordenar esta migración por detrás de
-- aquella, se cogió el cuerpo VIVO ENTERO de `…110000` y se le volvió a aplicar encima este
-- refactor. Nunca al revés — no partas de esta versión añadiéndole de memoria la regla que
-- recuerdes, porque para entonces puede haber más de una.
--
-- Y la comprobación NO es «mira el guard que te han nombrado». Es, para CADA migración que
-- se mueva de sitio: lista todos los objetos que redefine —funciones, políticas y
-- triggers— y mira quién más los define, porque la lista siempre es más larga de lo que uno
-- recuerda. Este fichero redefine CUATRO cosas que otros también definen (este guard, las
-- dos políticas de `criterio_exito` de más abajo, y el trigger `criterio_g0_pendiente`), y
-- se descubrieron con el bucle, no de memoria. Sirve tal cual:
--
--   grep -hoiE "create (or replace )?(function|policy|trigger) [a-z0-9_]+" db/migrations/*.sql \
--     | awk '{print tolower($NF)}' | sort | uniq -d
--
-- y después, por cada nombre repetido, `grep -l` para ver en qué ficheros está y quién gana
-- (el de número más alto). Sobre la base ya migrada, `select prosrc from pg_proc` dice cuál
-- es el cuerpo VIVO, que es el único que cuenta: leer un fichero no compone los
-- `create or replace` posteriores.
--
-- Y si la regla nueva es otra condición de congelado, va DENTRO de las funciones de arriba:
-- las llaman también las dos políticas de `criterio_exito`, los dos guards de `propuesta_ai`
-- y las lecturas del panel, así que meterla solo aquí volvería a partir el predicado en dos
-- (que es el fallo que este refactor vino a cerrar). Si en cambio es sobre el ESTADO del
-- reto, su sitio es `reto_admite_criterios`.
--
-- Meterla en el compuesto NO exime de darle su propia función-causa y su propio `raise`
-- aquí: `reto_criterios_congelados` solo sabe responder «sí, congelados», así que un único
-- mensaje sería FALSO en cuanto las causas son dos. Por eso hay `reto_g0_congela_criterios`
-- y `reto_registry_firmado` por separado. Causas distintas, mensajes distintos.
--
-- ⚠ Y la consecuencia que se escapa fácil, porque cae FUERA de este fichero: al añadir una
-- causa, los mensajes de cara al usuario que nombran las anteriores pasan a mentir. Cuando
-- entró la del registry hubo que tocar cinco sitios, y son los mismos que habrá que tocar la
-- próxima vez: el `raise` del guard de INSERT de `propuesta_ai` (abajo), los dos `ErrorAI`
-- de `ai.servicio.ts` (admisión y última lectura antes de despachar), el `case` que deriva
-- `anclaEstado` en el panel y el copy de `MOTIVO_ANCLA` en `propuestas.tsx`. Los dos últimos
-- son además un `anclaEstado`, y la doctrina del panel es un motivo por causa CON SU SALIDA:
-- reabrir la etapa 0 (RF-04.9) descongela el caso del G0 y no descongela el del registry
-- (la firma es de ida), así que lo que corresponde es un valor NUEVO en `ESTADOS_ANCLA`
-- —`registry-firmado`, que es como se resolvió— y no reescribir el copy del que ya hay para
-- que valga para dos cosas. Mismo razonamiento por el que `reto-no-admite` no se fundió con
-- `criterios-congelados`.
create or replace function criterio_g0_pendiente_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  -- La FILA del reto, y antes que nada. Quien mueve el ciclo de vida hace `update reto`, que
  -- bloquea esta misma fila SIN saber nada de ningún protocolo — también desde SQL crudo—,
  -- mientras que un candado consultivo obligaría a cooperar a todo el que escriba y, peor,
  -- un consultivo y uno de fila sobre el mismo objeto no se ven entre sí. Por eso aquí es de
  -- fila: es el único que las dos operaciones comparten sin haberlo pactado.
  --
  -- Lo que cierra: el guard diferido de materialización relee el estado del reto en el
  -- COMMIT, y esa lectura sería otra foto si entre ella y el final del commit cupiera una
  -- transición. Tomando la fila AQUÍ —al escribir el criterio, o sea antes— el candado se
  -- retiene hasta el commit y esa transición no puede colarse: o llegó antes y la lectura la
  -- ve, o espera. Sirve igual a los tres caminos que escriben criterios (materializar una
  -- propuesta C0, y agregar o editar a mano), que es donde estaba la misma carrera.
  --
  -- SECURITY DEFINER es lo que lo hace posible: bajo RLS un `for update` exige pasar la
  -- política de UPDATE de `reto`, que un curador no cumple. Mismo motivo por el que este
  -- guard ya bloqueaba los gates desde aquí y no desde el servicio.
  --
  -- ORDEN: fila del reto → gates. Es el mismo que documenta `bloquearReto` hacia el gate, y
  -- el que pide toda ruta que baje del reto a sus objetos; invertirlo aquí abriría un ciclo
  -- con cualquiera que ya lo respete.
  perform 1 from reto r
    where r.id = new.reto_id and r.workspace_id = new.workspace_id for update;
  perform 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id and g.numero = 0
    order by g.id for update of g;
  -- CADA causa con su mensaje, y el orden es el que más ayuda a quien lo lee: la firma del
  -- registry no tiene vuelta atrás, así que se nombra primero. Decirle «reabre la etapa 0»
  -- a quien tiene el contrato firmado sería mandarlo a un trámite que no desbloquea nada.
  -- Los dos van SIEMPRE después del `perform … for update`: esos candados son lo que
  -- serializa la decisión ajena contra la edición de criterios, y decidir antes de bloquear
  -- deja exactamente el hueco que el candado existe para cerrar.
  if reto_registry_firmado(new.reto_id, new.workspace_id) then
    raise exception 'el registry del reto está firmado: los criterios de medición son el contrato acordado (SYS-22)';
  end if;
  if reto_g0_congela_criterios(new.reto_id, new.workspace_id) then
    raise exception 'el G0 del reto está aprobado: criterios congelados';
  end if;
  -- El criterio se edita ENTERO mientras el G0 sigue pendiente y el registry sin firmar, y
  -- el evento llevaba solo el `kpi` de sus OCHO columnas editables. Dos de las que faltaban
  -- son las que gobiernan toda la medición de SPEC-07: `objetivo` es la promesa contra
  -- la que se dicta el veredicto y `ventana_dias` es la ventana que decide qué snapshots se
  -- aceptan —el registry no la copia a propósito, así que la ÚNICA copia es esta fila—.
  -- Cambiarlas dejaba un `CriterioEditado` indistinguible de renombrar el KPI, y sin
  -- `antes` no había forma de saber contra qué se había prometido medir antes del cambio.
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id,
      case tg_op when 'INSERT' then 'CriterioDefinido' else 'CriterioEditado' end,
      jsonb_build_object('criterioId', new.id, 'retoId', new.reto_id)
        || criterio_exito_contenido(to_jsonb(new))
        || case when tg_op = 'UPDATE'
             then jsonb_build_object('antes', criterio_exito_contenido(to_jsonb(old)))
             else '{}'::jsonb end,
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;

-- ⚠ Mismo cuidado que con el guard: esto REEMPLAZA las dos políticas vivas. Al integrar
-- una rama que también las toque, parte de las suyas y vuelve a aplicar la llamada al
-- helper; no de estas. Un `drop policy` + `create policy` no deja rastro de lo que borró.
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
  -- QUÉ AUTORIZACIÓN dejó salir este material, leída bajo el candado por item en la misma
  -- transacción que aprobó el despacho. No es decoración: la llamada al proveedor ocurre
  -- FUERA de toda transacción a propósito, así que una revocación que commitee mientras los
  -- bytes viajan no puede detenerla — eso no lo cierra ningún candado. Lo que sí se puede es
  -- que el sistema SEPA qué salió y bajo qué permiso, que es lo que RF-09.4 necesita para
  -- remediar: una revocación posterior se cruza contra el libro para saber exactamente qué
  -- material hay que ir a buscar.
  --
  -- Y para que eso sea un HECHO y no una afirmación, el número está atado. Un entero suelto
  -- con `> 0` admitía citar una versión inexistente, la de OTRO item, o la de un registro
  -- que DENEGÓ el procesamiento externo — y `llamada_ai` la escribe la aplicación, así que
  -- el libro podía afirmar en falso bajo qué permiso salió material de personas. Un número
  -- que nadie comprueba es peor que no tener número: invita a fiarse de él justo en la
  -- remediación, que es cuando más caro sale equivocarse.
  consentimiento_version integer check (consentimiento_version is null or consentimiento_version > 0),
  -- La mitad «y ese registro AUTORIZABA» de la ligadura, como columna generada para que
  -- viaje dentro de la FK sin que nadie tenga que escribirla (ni pueda mentir en ella): la
  -- app no la menciona y la base la deriva. `true` cuando se cita una versión, `null`
  -- cuando no — y con `null` la FK compuesta no comprueba nada (MATCH SIMPLE), que es
  -- justo la semántica del «no aplicaba».
  consentimiento_autoriza_externo boolean
    generated always as (case when consentimiento_version is null then null else true end) stored,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (item_id, workspace_id) references item_importacion (id, workspace_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  -- Ligadura completa: la versión citada es de ESTE item, de ESTE workspace, existe, y su
  -- registro autorizaba el procesamiento externo. Las cuatro columnas en una sola FK.
  foreign key (item_id, workspace_id, consentimiento_version, consentimiento_autoriza_externo)
    references consentimiento_item (item_id, workspace_id, version, procesamiento_externo),
  check ((capacidad = 'CI') = (item_id is not null)),
  check ((capacidad = 'C0') = (reto_id is not null)),
  -- Una generación C0 no tiene item, así que no hay consentimiento que citar. Sin esto, la
  -- FK se la saltaría entera (item_id null ⇒ MATCH SIMPLE no comprueba) y una llamada C0
  -- podría llevar un número inventado sin que nada lo mirara.
  check (item_id is not null or consentimiento_version is null),
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
  -- Y el evento sigue siendo cosa de miembros, como en el resto de guards: una escritura
  -- privilegiada no tiene rol de workspace que anotar, y el `actor_rol` quedaría vacío.
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
-- Y por COLUMNA, para dejar `creado_en` fuera: es el reloj con el que se cuenta el tope
-- diario del workspace (`creado_en >= date_trunc('day', now())`), así que con el grant
-- puesto una llamada podía nacer fechada ayer y no contar para hoy — el presupuesto de
-- RF-09.12 medido con una regla que el medido escribe. Lo estampa el DEFAULT, que es la
-- única mano que no tiene motivos. Mismo criterio que `consentimiento_item.version`.
grant select on llamada_ai to designio_app;
grant insert (workspace_id, capacidad, item_id, reto_id, modelo, origen_key, resultado,
              motivo, tokens_entrada, tokens_salida, costo_usd, latencia_ms,
              consentimiento_version, creado_por)
  on llamada_ai to designio_app;

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

-- ── El asiento que llevaba reservado desde SPEC-02 ──
-- `reto_servicio_afectado.propuesta_ai_id` nació en `…050000-arbol.sql` como columna suelta:
-- anulable, sin FK y sin nada que la validara, esperando a que existiera la tabla. Ese día
-- es hoy, y sin esta línea se quedaba apuntando al vacío para siempre — y no en teoría: el
-- grant de INSERT de `…070000-metodo.sql` no lleva lista de columnas, así que la aplicación
-- YA podía escribir ahí cualquier uuid, incluido el de una propuesta de OTRO workspace.
--
-- Compuesta con `workspace_id` como el resto del esquema, que es lo que hace imposible el
-- cruce de tenants (una FK simple a `id` lo habría dejado abierto). Y con la semántica que
-- el asiento necesita: MATCH SIMPLE —el default— no comprueba nada mientras la columna
-- anulable sea NULL, así que «sin propuesta detrás» sigue siendo el caso normal y solo se
-- valida cuando alguien la rellena.
--
-- Lo que esto NO promete, dicho para que nadie lo lea de más: que la propuesta apuntada
-- esté ACEPTADA. Hoy ninguna capacidad materializa un afectado —el destino ni siquiera
-- existe en el CHECK de `destino`—, así que no hay ruta que llenar ni guard que escribir; el
-- día que se implemente, esa regla es suya y va donde van las demás, en el guard diferido de
-- materialización.
alter table reto_servicio_afectado
  add constraint reto_servicio_afectado_propuesta_ai_fkey
  foreign key (propuesta_ai_id, workspace_id) references propuesta_ai (id, workspace_id);

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

-- Una llamada de CI respalda COMO MUCHO UNA propuesta. `llamada_id` afirma «la llamada que
-- ME produjo», y con N propuestas colgadas de la misma llamada de extracción esa frase solo
-- puede ser cierta en una de ellas: las demás heredan un coste, una latencia y un `usage`
-- que no son suyos. El daño no es solo de lectura — el coste por propuesta se divide entre
-- filas que nadie pagó y el recuento de propuestas generadas crece sin gasto detrás, que es
-- justo la dirección que esconde el problema.
--
-- El índice parcial es el que lo impone porque el guard no puede: comprueba la fila que
-- entra, y «cuántas hay ya» es una pregunta sobre el conjunto, que bajo READ COMMITTED dos
-- transacciones responden a la vez sobre snapshots distintos. `propuesta_ai_item_pendiente_idx`
-- tampoco lo cubre: solo alcanza a las PENDIENTES, así que decidir la primera dejaba el
-- hueco libre para colgar una segunda de la misma llamada ya pagada.
--
-- Solo CI, y la asimetría es la misma que la de `reserva_ai`: C0 persiste un LOTE —de uno a
-- cuatro criterios de una sola llamada— y sus filas hermanas violarían el índice. Ahí el
-- invariante no es una fila que Postgres pueda rechazar.
create unique index propuesta_ai_llamada_ci_idx on propuesta_ai (workspace_id, llamada_id)
  where capacidad = 'CI';

-- Y un objeto materializado cuelga de UNA sola propuesta. El guard diferido exige que lo
-- haya creado la aceptación que lo reclama, lo que ya impide adoptar algo preexistente;
-- esto cierra el caso simétrico, que el guard no puede ver porque mira una fila a la vez:
-- dos propuestas de la MISMA transacción reclamando el mismo objeto recién creado —las dos
-- pasarían el `xmin`— y la atribución quedaría repartida entre dos, con una de las dos
-- mintiendo. Parcial porque `null` es lo normal: una propuesta pendiente o rechazada no
-- materializa nada.
create unique index propuesta_ai_evidencia_idx on propuesta_ai (workspace_id, evidencia_id)
  where evidencia_id is not null;
create unique index propuesta_ai_criterio_idx on propuesta_ai (workspace_id, criterio_id)
  where criterio_id is not null;

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
    if new.reto_id is not null and (
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
-- ── La procedencia, como RELACIÓN y no como coincidencia ───────────────────────────────
/*
 * `xmin = pg_current_xact_id()` demuestra «esta fila nació en algún punto de esta
 * transacción». Lo que el linaje AFIRMA es más fuerte: «esta fila la produjo esta
 * propuesta». Entre las dos hay hueco, y con los grants de antes se atravesaba entero: un
 * curador podía, en UNA transacción, crear una evidencia escrita a mano, sellar con ella el
 * item que le cuadraba y marcar la propuesta como aceptada. Todos los predicados pasaban,
 * porque todo compartía `xmin`.
 *
 * Y el daño no es solo de auditoría: la tasa de corrección humana es la señal con la que se
 * decide si esta capacidad sirve (§17), y una atribución falsa la corrompe en la dirección
 * FAVORABLE — contenido escrito a mano contado como aceptado tal cual del modelo. Una
 * métrica de calidad que el propio operador puede inflar sin querer no mide nada.
 *
 * `xmin` es la herramienta correcta para «misma transacción» y la equivocada para «misma
 * causa» (SPEC-06 lo usa bien: allí la afirmación ES «en esta transacción»). Se queda,
 * porque «nació aquí» sigue haciendo falta, y se le añaden las dos piezas que faltaban:
 *
 *  1. **La relación**, en una columna que el llamante NO puede escribir. Fuera de todo
 *     grant y estampada solo por el guard que decide, así que «esta fila viene de la
 *     propuesta P» solo puede haberlo escrito la aceptación de P. Única, además: un objeto
 *     no puede colgar de dos propuestas ni una propuesta reclamar un objeto ya reclamado, y
 *     eso deja de valer solo dentro de la transacción para valer siempre.
 *  2. **La proyección**, más abajo en el guard: los campos que la propuesta DICTA los lleva
 *     el objeto tal cual. Sin eso, el punto 1 solo registraría la afirmación del llamante
 *     en un sitio donde no puede reescribirla — que es mejor que nada, pero no es prueba.
 */
alter table evidencia add column propuesta_ai_id uuid;
alter table evidencia add constraint evidencia_propuesta_ai_fkey
  foreign key (propuesta_ai_id, workspace_id) references propuesta_ai (id, workspace_id);
create unique index evidencia_propuesta_ai_idx on evidencia (propuesta_ai_id)
  where propuesta_ai_id is not null;

alter table criterio_exito add column propuesta_ai_id uuid;
alter table criterio_exito add constraint criterio_exito_propuesta_ai_fkey
  foreign key (propuesta_ai_id, workspace_id) references propuesta_ai (id, workspace_id);
create unique index criterio_exito_propuesta_ai_idx on criterio_exito (propuesta_ai_id)
  where propuesta_ai_id is not null;

-- Y los grants pasan a ser por columna, porque un `grant insert` de tabla cubre también las
-- columnas FUTURAS: sin esto, añadir la columna se la habría regalado al llamante y el
-- vínculo no sería vínculo. Un `revoke` por columna no sirve mientras exista el de tabla,
-- así que se retira el de tabla y se vuelve a conceder la lista exacta de antes.
revoke insert on evidencia from designio_app;
grant insert (id, workspace_id, fuente_id, titulo, resumen, dimensiones, es_estado_actual,
              creado_por, creado_en)
  on evidencia to designio_app;
revoke insert on criterio_exito from designio_app;
grant insert (id, workspace_id, reto_id, kpi, definicion, linea_base_valor, linea_base_fecha,
              linea_base_plan, objetivo, ventana_dias, fecha_post_mortem, creado_por,
              creado_en)
  on criterio_exito to designio_app;

-- El guard de congelado no puede despertarse por el sello del linaje: estampar
-- `propuesta_ai_id` no es editar un criterio, y dispararlo emitiría un `CriterioEditado`
-- falso (y podría rechazar la aceptación si el registry se firmó justo entonces). Se acota
-- por columnas: dispara con el alta y con la edición de lo que de verdad es el criterio.
drop trigger criterio_g0_pendiente on criterio_exito;
create trigger criterio_g0_pendiente
  before insert or update of kpi, definicion, linea_base_valor, linea_base_fecha,
    linea_base_plan, objetivo, ventana_dias, fecha_post_mortem, reto_id
  on criterio_exito
  for each row execute function criterio_g0_pendiente_guard();

-- Diferido al commit porque el servicio materializa y sella en sentencias posteriores de
-- la misma transacción; una UPDATE cruda solitaria aborta.
create function propuesta_ai_materializacion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
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
  if new.destino = 'evidencia' then
    update evidencia set propuesta_ai_id = new.id
      where id = new.evidencia_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  else
    update criterio_exito set propuesta_ai_id = new.id
      where id = new.criterio_id and workspace_id = new.workspace_id
        and propuesta_ai_id is null;
    get diagnostics v_filas = row_count;
  end if;
  if v_filas <> 1 then
    raise exception 'ese objeto ya cuelga de otra propuesta AI: un objeto materializado tiene una sola procedencia (SYS-19)';
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
--
-- La excepción va acotada al material que EXIGE consentimiento, y ahí está el detalle que
-- casi se cuela: para una nota o un documento «no hay consentimiento externo vigente» es
-- cierto SIEMPRE —nunca hubo nada que registrar—, así que sin el tipo de fuente en el
-- predicado la excepción se volvía general y cualquier curador podía retirarle a otro una
-- reserva viva sobre cualquier item, con la llamada en vuelo y el gasto duplicado detrás.
-- Una excepción vale lo que vale su predicado.
create policy reserva_delete on reserva_ai
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and (
      creado_por = app_user_id()
      or creado_en <= now() - reserva_ai_ventana()
      or (
        item_id is not null
        and exists (select 1 from item_importacion i
          where i.id = reserva_ai.item_id and i.workspace_id = reserva_ai.workspace_id
            and tipo_fuente_exige_consentimiento(i.tipo_fuente))
        and not consentimiento_externo_vigente(item_id, workspace_id)
      )
    )
  );

-- Sin UPDATE: una reserva no se edita, se consume o se libera. Y `creado_en` fuera del
-- insert por el mismo motivo, aquí todavía más directo: ES el arrendamiento. La caducidad
-- se mide sobre él —la admisión, el despacho y el fencing de la persistencia—, así que
-- poder escribirlo era poder acuñarse una reserva inmortal que bloquea su ancla para
-- siempre, o una nacida caducada que no excluye a nadie.
grant select, delete on reserva_ai to designio_app;
grant insert (workspace_id, capacidad, item_id, reto_id, unidades, creado_por)
  on reserva_ai to designio_app;

-- ── Grants mínimos (UPDATE por columna: solo la transición y su materialización) ──
grant select on propuesta_ai to designio_app;
-- `creado_en` fuera también aquí: es el orden de la cola FIFO que la pantalla drena por el
-- frente, y una propuesta fechada al principio del tiempo se queda delante de todas para
-- siempre. Y `revisada_en` fuera porque lo estampa el guard al decidir, no el caller.
grant insert (workspace_id, capacidad, destino, item_id, reto_id, contenido,
              contenido_original, confianza, es_simulacion, modelo, prompt_version,
              alcance_resumen, origen_key, llamada_id, creado_por)
  on propuesta_ai to designio_app;
-- Fuera del grant y por tanto sin superficie: capacidad, destino, item_id, reto_id,
-- contenido_original, confianza, es_simulacion, modelo, prompt_version, alcance_resumen,
-- origen_key, llamada_id, creado_por — el lineage y el original son inmutables
-- (SYS-17/19), y una propuesta no puede reapuntar a otra llamada que la pagó.
-- `revisada_en` tampoco: lo estampa el guard, no el caller.
grant update (estado, contenido, revisada_por, evidencia_id, criterio_id)
  on propuesta_ai to designio_app;
