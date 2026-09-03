-- SPEC-07 — Metric Registry, medición temporal y outcome review con veredicto
-- (CTX-06, ADR-0007; SYS-22, SYS-23, SYS-24). Este slice CIERRA el loop: convierte
-- «rediseñamos» en «esto pasó». Registry 1:1 con el reto que se firma en G6, snapshots
-- append-only por formulario o CSV, lectura por criterio contra la línea base, y
-- post-mortem con veredicto del catálogo cerrado que cierra reto y proyecto.
--
-- Deja fuera (con sus specs): el borrador narrativo AI del post-mortem (SPEC-08 —
-- aquí la redacción es HUMANA), las marcas de release en la serie (SPEC-06) y los retos
-- candidatos pre-poblados desde los aprendizajes (RF-07.10, segunda mitad).
--
-- Mismo patrón multi-tenant que el resto: FKs compuestas (id, workspace_id), RLS día 1,
-- autoría fijada en la política, transiciones exigidas por WITH CHECK + guard de fila, y
-- fechas CALENDÁRICAS como date (jamás timestamps: una fecha de snapshot con huso rueda
-- el día en UTC+13/14 y falsea la serie).

-- El propietario del dato es una PERSONA del cliente (RF-07.1): se referencia por FK
-- compuesta contra miembro, que hasta ahora no tenía la unique que eso exige.
alter table miembro add constraint miembro_id_ws_unico unique (id, workspace_id);

-- …y «del cliente» es una partición REAL del catálogo de roles (§13.2): sponsor,
-- stakeholder y admin-cliente son la organización que aporta el dato; lead-boutique y
-- disenador son quienes la acompañan, y agente-ai no es una persona. La lista vive en UNA
-- función y no repetida en cada política y guard que la necesita, por el mismo motivo por
-- el que el registry no copia `ventana_dias`: dos copias serían dos verdades y bastaría
-- olvidar una para que la promesa se deshiciera en silencio. Se define aquí —y no en la
-- migración del workspace, que ya está desplegada— porque las migraciones son forward-only.
--
-- NO es SECURITY DEFINER ni necesita revoke: es un predicado sobre su propio argumento,
-- no lee ninguna tabla y por tanto no puede volverse oráculo de nada. Los helpers que sí
-- consultan por encima de RLS (app_user_id, workspace_role…) son los que se revocan.
create function es_rol_cliente(p_rol text) returns boolean
language sql immutable parallel safe as
$$ select p_rol in ('sponsor', 'stakeholder', 'admin-cliente') $$;

-- ── El veredicto vive en el reto (SYS-24) ──
-- Catálogo CERRADO en el propio CHECK: ni un bug de la app ni SQL directo inventan un
-- quinto valor. Los slugs son la codificación de base; el vocabulario canónico
-- («parcialmente logrado») lo pone la capa de dominio.
alter table reto add column veredicto text
  check (veredicto is null or veredicto in
    ('logrado', 'parcialmente-logrado', 'no-logrado', 'no-concluyente'));
-- Cerrar un reto SIN veredicto sería exactamente el loop abierto que este slice cierra…
-- …pero el ciclo ANTERIOR ya admitía `en-medicion → cerrado` (20260902070000) cuando la
-- columna ni existía: en una base con historia hay retos cerrados LEGALMENTE bajo aquel
-- esquema. Validar el CHECK contra ellos abortaría la migración entera —y el arranque del
-- contenedor con ella, porque cada archivo corre en UNA transacción.
--
-- Política de esas filas: NO se les inventa un veredicto.
--  · Un quinto slug («sin-outcome-review») rompería el catálogo CERRADO que SYS-24 exige
--    y obligaría a la UI, al vocabulario canónico y a la métrica de loop cerrado (§17) a
--    tratar como veredicto algo que no lo es.
--  · «No concluyente» sería una FABRICACIÓN peor: afirma que hubo post mortem y que no
--    pudo concluir, y contamina justo la métrica que cuenta cuántos retos cierran con
--    resultado. «No concluyente» es un veredicto caro y ganado; no un relleno.
-- El veredicto que nunca se dictó se codifica como lo que es: ausencia (null). Y la forma
-- que PostgreSQL tiene de decir «esto se exige a todo lo que se escriba desde ahora y no
-- afirmo nada sobre lo ya escrito» es exactamente NOT VALID — que sigue rechazando todo
-- INSERT y todo UPDATE de esas mismas filas.
alter table reto add constraint reto_cerrado_con_veredicto
  check (estado <> 'cerrado' or veredicto is not null) not valid;
-- Y se valida EN EL ACTO si no hay nada que arrastrar (toda base nueva, el CI y el dev
-- local): así el constraint queda plenamente confiable donde puede estarlo, en vez de
-- quedar NOT VALID para siempre «por si acaso». Con deuda histórica el deploy no aborta:
-- la nombra en un notice y el constraint sigue exigiéndose a cada escritura nueva. Saldarla
-- es decisión de PRODUCTO, no de esta migración: archivar esas filas (`cerrado → archivado`
-- sigue admitiendo veredicto nulo) o dictarles el veredicto por vía administrativa —el
-- outcome review ya no se abre sobre un reto cerrado—. Después basta VALIDATE CONSTRAINT.
do $$
declare
  heredados int;
begin
  select count(*) into heredados from reto where estado = 'cerrado' and veredicto is null;
  if heredados = 0 then
    alter table reto validate constraint reto_cerrado_con_veredicto;
  else
    raise notice
      '% reto(s) cerrados antes de SPEC-07 se quedan sin veredicto: reto_cerrado_con_veredicto queda NOT VALID (exigido en toda escritura nueva); valídalo cuando cierres esa deuda',
      heredados;
  end if;
end $$;
-- …y un veredicto en un reto que sigue vivo sería un resultado sin medición terminada.
alter table reto add constraint reto_veredicto_solo_cerrado
  check (veredicto is null or estado in ('cerrado', 'archivado'));

-- ── Metric Registry: 1:1 con el reto (RF-07.1) ──
-- El registry es el CONTRATO de medición del reto: qué se mide, quién lo aporta y cada
-- cuánto. Nace borrador en la etapa 6 y se FIRMA en G6 (SYS-22); firmado = congelado.
create table metric_registry (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid not null,
  estado text not null default 'borrador' check (estado in ('borrador', 'firmado')),
  firmado_por uuid references usuario(id),
  firmado_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  -- 1:1 con el reto (RF-07.1): un reto tiene UN contrato de medición, no una colección.
  unique (reto_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  check (estado = 'borrador' or (firmado_por is not null and firmado_en is not null))
);

-- ── Entradas KPI del registry (RF-07.1) ──
-- La tabla acepta entradas INCOMPLETAS (el registry se redacta iterando); la completitud
-- la exige la FIRMA, igual que G0 exige criterios completos. Cada entrada responde a un
-- criterio de éxito REAL del reto: un KPI que no responde a ningún criterio es telemetría,
-- no medición de impacto (ADR-0007).
create table entrada_kpi (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  registry_id uuid not null,
  criterio_id uuid not null,
  nombre text not null,
  definicion text not null default '',
  fuente text not null default '',
  -- Cortes/dimensiones del KPI (RF-07.1): texto libre, no un modelo analítico.
  dimensiones text not null default '',
  -- Persona del CLIENTE que se compromete a aportar el dato (RF-07.1/07.4). Que sea del
  -- cliente no lo puede exigir un CHECK —el rol vive en otra tabla— y por eso lo exigen
  -- la política de la entrada al escribir y el guard de la firma al congelar el contrato.
  propietario_miembro_id uuid,
  frecuencia text not null check (frecuencia in ('semanal', 'mensual', 'trimestral', 'unica')),
  dashboard_url text not null default '',
  -- Línea base del KPI: numérica y con fecha, porque contra ella se lee la serie.
  -- (criterio_exito.linea_base_valor es el resumen presentable del compromiso de G0;
  -- esta es la que se compara.)
  linea_base_valor numeric,
  linea_base_fecha date,
  -- Inicio de la ventana: la fecha desde la que este KPI se mide (con SPEC-06 será la
  -- del primer release desplegado; hasta entonces la declara quien firma el plan).
  -- El LARGO de la ventana no se duplica aquí: vive en criterio_exito.ventana_dias,
  -- congelado por G0 (SYS-22) — una segunda copia sería una segunda verdad.
  ventana_inicio date,
  fecha_post_mortem date,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (registry_id, nombre),
  foreign key (registry_id, workspace_id) references metric_registry (id, workspace_id),
  foreign key (criterio_id, workspace_id) references criterio_exito (id, workspace_id),
  foreign key (propietario_miembro_id, workspace_id) references miembro (id, workspace_id)
);
create index entrada_kpi_registry_idx on entrada_kpi (workspace_id, registry_id);
create index entrada_kpi_criterio_idx on entrada_kpi (workspace_id, criterio_id);

-- ── Snapshots: APPEND-ONLY (SYS-23) ──
-- Sin políticas de UPDATE/DELETE y sin grants: corregir un valor es un snapshot NUEVO
-- con su nota, nunca una edición. El origen es cerrado (formulario o CSV): ninguna
-- ingesta continua entra por aquí (ADR-0007, decisión 4).
create table snapshot (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  entrada_kpi_id uuid not null,
  valor numeric not null,
  -- Fecha CALENDÁRICA del dato (no la de carga: creado_en ya registra cuándo entró).
  fecha date not null,
  origen text not null check (origen in ('formulario', 'csv')),
  nota text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (entrada_kpi_id, workspace_id) references entrada_kpi (id, workspace_id)
);
create index snapshot_entrada_idx on snapshot (workspace_id, entrada_kpi_id, fecha);

-- ── Outcome review: el post-mortem con veredicto (RF-07.7 a RF-07.10, SYS-24) ──
-- La estructura SEPARA contribución de causalidad: los campos narrativos hablan de
-- contribución y factores externos, y solo el flag de diseño experimental —con
-- justificación obligatoria por CHECK— habilita lenguaje causal (RF-07.9).
create table outcome_review (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  reto_id uuid not null,
  estado text not null default 'borrador' check (estado in ('borrador', 'completado')),
  veredicto text check (veredicto is null or veredicto in
    ('logrado', 'parcialmente-logrado', 'no-logrado', 'no-concluyente')),
  contribucion text not null default '',
  factores_externos text not null default '',
  hipotesis_abiertas text not null default '',
  aprendizajes text not null default '',
  diseno_experimental_suficiente boolean not null default false,
  diseno_experimental_justificacion text not null default '',
  completado_por uuid references usuario(id),
  completado_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (reto_id),
  foreign key (reto_id, workspace_id) references reto (id, workspace_id),
  -- SYS-24: afirmar «diseño experimental suficiente» sin decir POR QUÉ es exactamente
  -- la puerta trasera al lenguaje causal que la invariante cierra.
  check (not diseno_experimental_suficiente
         or btrim(diseno_experimental_justificacion) <> ''),
  -- Completado = veredicto del catálogo, contribución escrita y firma con fecha.
  check (estado = 'borrador' or (veredicto is not null and completado_por is not null
    and completado_en is not null and btrim(contribucion) <> ''))
);

-- ── Resultado por criterio dentro del review (RF-07.8) ──
-- El valor final NO se teclea: apunta a un snapshot REAL de la serie (o declara por qué
-- no hay dato). Es la diferencia entre un post-mortem y una presentación de resultados.
create table resultado_criterio (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  review_id uuid not null,
  criterio_id uuid not null,
  snapshot_final_id uuid,
  lectura text not null default '',
  -- Criterio de aceptación 3 de SPEC-07: sin datos suficientes, el motivo queda escrito.
  sin_datos_motivo text not null default '',
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (review_id, criterio_id),
  foreign key (review_id, workspace_id) references outcome_review (id, workspace_id),
  foreign key (criterio_id, workspace_id) references criterio_exito (id, workspace_id),
  foreign key (snapshot_final_id, workspace_id) references snapshot (id, workspace_id),
  -- O apunta a un snapshot, O explica por qué no hay dato: EXACTAMENTE uno. Con «al menos
  -- uno» la fila podía traer las dos cosas —un valor final y, a la vez, la explicación de
  -- que no hay dato— y eso no es un formulario descuidado, es un resultado que se
  -- contradice a sí mismo dentro de un post mortem auditado. El XOR lo impide aquí porque
  -- es una propiedad de la FILA, no una disciplina de pantalla.
  check ((snapshot_final_id is not null) <> (btrim(sin_datos_motivo) <> ''))
);
create index resultado_criterio_review_idx on resultado_criterio (workspace_id, review_id);

-- ── Los proyectos que YA pasaron G6 antes de que existiera el Metric Registry ──
-- Este slice ata dos reglas nuevas: G6 no se aprueba sin registry firmado, y el registry
-- se firma con G6 PENDIENTE. Juntas dejan varado a todo proyecto activo que, en una base
-- con historia, ya tuviera su G6 aprobado: su registry nace borrador y no hay forma de
-- firmarlo —un gate aprobado es inmutable y la reapertura de etapa no lo devuelve a
-- pendiente a propósito—, así que `abrirMedicion` y el guard de transición lo frenan para
-- siempre antes de medir. Igual que con el veredicto de los retos ya cerrados, la
-- migración tiene que traer una historia para lo que ya existe.
--
-- La historia es esta columna: marca los G6 que se aprobaron CUANDO LA REGLA NO EXISTÍA,
-- y solo esos pueden firmar su registry a posteriori. Se descartó la alternativa —crear
-- por backfill un registry ya `firmado`— porque sería un contrato vacío: no hay KPIs que
-- inventar, y firmarlo saltándose el guard de completitud diría que el cliente se
-- comprometió con algo que nadie escribió. Aquí el contrato se redacta y se firma de
-- verdad; lo único que se perdona es el MOMENTO.
--
-- Y no es un agujero permanente, por dos razones independientes:
--  1. La columna se escribe UNA vez, aquí. Ningún guard la toca y no está en el grant de
--     UPDATE, que sí es por columna (`gate_instancia` solo concede estado/aprobado_por/
--     aprobado_en). Pero el `grant insert` es de TABLA y un grant de tabla cubre también
--     las columnas añadidas después, así que la fila NUEVA sí podía nacer con el perdón
--     puesto — no había que actualizar nada, bastaba insertar. Lo cierra `gate_insert`, más
--     abajo, exigiendo `aprobado_sin_registry = false` al nacer; con eso el conjunto sí
--     queda congelado en el instante del despliegue y solo puede encoger.
--  2. Aunque se pudiera escribir, el estado que habilita —«G6 aprobado con su registry en
--     borrador»— es inalcanzable para todo proyecto posterior: aprobar G6 exige un registry
--     FIRMADO, el registry es 1:1 con el reto y la firma es de ida. Así que la rama solo
--     puede aplicar a filas que ya existían.
-- Y CUÁNDO DEJA DE APLICAR, que es la parte que se olvida y por la que un perdón acaba
-- valiendo más de lo que debía: la marca no se borra —nadie tiene grant para escribirla—,
-- así que quien la acota es su ÚNICO lector, `registry_firmar`. Esa política es un UPDATE
-- con `using (estado = 'borrador' …)`, de modo que la exención se consume con la firma: un
-- registry firmado ya no es borrador y no vuelve a serlo, y `metric_registry` es 1:1 con el
-- reto (`unique (reto_id)`), así que tampoco hay un segundo contrato al que aplicársela.
-- El perdón vale exactamente una firma, que es el acto que lo hizo falta.
alter table gate_instancia add column aprobado_sin_registry boolean not null default false;
update gate_instancia set aprobado_sin_registry = true
  where numero = 6 and estado = 'aprobado';

-- …y la marca sola no basta, porque G6 no es solo un permiso: es el momento en que el
-- proyecto ENTRA EN IMPLEMENTACIÓN (§7). Ese efecto lo pone un trigger que nace en esta
-- misma migración y que solo observa los `pendiente → aprobado` que vengan DESPUÉS, así
-- que los proyectos cuyo G6 ya estaba aprobado se quedarían en 'activo' teniendo el plan
-- acordado — y tras su G7 pasarían directos de 'activo' a 'en-medicion', saltándose
-- entera la fase que ese trigger existe para representar. Es la misma forma que la marca
-- de arriba y que el veredicto de los retos ya cerrados: una regla nueva gobierna las
-- transiciones futuras y no dice nada de quien YA estaba en el estado anterior, así que
-- la historia hay que moverla aquí, a mano y una sola vez.
--
-- Elegibles son los ACTIVOS y solo ellos: un proyecto pausado se retoma a implementación
-- por su propio par legal —parar es del cliente y una migración no deshace una pausa— y
-- los que ya miden o están cerrados están más adelante, no más atrás. (En la práctica
-- TODO proyecto anterior a este slice está en 'activo', porque el ciclo anterior no tenía
-- grant de UPDATE sobre esa columna; el predicado lo dice igual, para no adivinar sobre
-- una fila que llegara de otra forma.)
--
-- Y elegibles son también, y sobre todo, los de un reto VIVO. Esta condición faltaba y era
-- la peor clase de omisión: la que produce un estado irrecuperable sobre datos que YA
-- existen. El ciclo anterior admitía `en-medicion → cerrado` sin tocar el estado del
-- proyecto —no tenía grant para hacerlo—, así que en una base con historia hay retos
-- CERRADOS con su G6 aprobado y su proyecto todavía en 'activo'. Moverlo a
-- 'en-implementacion' diría que hay trabajo implementándose bajo un reto que terminó, y lo
-- diría PARA SIEMPRE: desde implementación los únicos destinos son 'pausado' y
-- 'en-medicion', y a medición no se llega porque exige que el reto esté midiendo — y un
-- reto cerrado no vuelve. Historia falsificada y fila varada, hechas por la migración.
--
-- Qué se hace con esos proyectos: NADA, y es una decisión, no un olvido. Se quedan en el
-- único estado que el esquema viejo podía dejarles. Se descartó cerrarlos —que es lo que
-- «reflejar una historia terminada» pediría— porque `cerrado` es INMUTABLE (SYS-08) y
-- escribirlo por decreto es una afirmación irreversible que esta migración no tiene
-- mandato para hacer: exactamente el mismo argumento por el que no le inventa un veredicto
-- al reto cerrado que no lo tuvo. Un estado heredado y raro es una deuda declarada; un
-- estado heredado, raro y congelado es una deuda que ya nadie puede saldar. Se nombra en
-- un notice, como aquella, y saldarla es decisión de PRODUCTO.
--
-- Y excluirlos no reabre el atajo por el que se retiró el par `activo → en-medicion`: un
-- proyecto de un reto cerrado no puede llegar a medición por definición —el guard de
-- transición exige que su reto esté midiendo—, así que la post-condición que sostiene esa
-- retirada es la que de verdad hace falta: ningún proyecto de un reto VIVO se queda en
-- 'activo' con su G6 aprobado.
--
-- Y la política de auditoría es EXPLÍCITA, que es la otra mitad de traer una historia. El
-- rastro lo escribe esta sentencia y no el guard de transición —que en este punto del
-- archivo todavía no existe, así que el movimiento es silencioso—, va marcado `heredado`
-- y con actor NULO: ninguna persona hizo esto, lo hizo el despliegue, y un evento que se
-- lo atribuyera a alguien sería peor que no tenerlo. El resto del payload es idéntico al
-- que emite el guard, para que la serie de `ProyectoTransicionado` se lea entera igual.
do $$
declare
  heredados int;
begin
  with movidos as (
    update proyecto p set estado = 'en-implementacion'
      where p.estado = 'activo'
        and exists (select 1 from reto r
          where r.id = p.reto_id and r.workspace_id = p.workspace_id
            and r.estado in ('activo', 'en-medicion'))
        and exists (select 1 from gate_instancia g
          where g.proyecto_id = p.id and g.workspace_id = p.workspace_id
            and g.numero = 6 and g.estado = 'aprobado')
      returning p.id, p.workspace_id
  )
  insert into evento_dominio (workspace_id, tipo, payload)
  select m.workspace_id, 'ProyectoTransicionado',
    jsonb_build_object('proyectoId', m.id, 'de', 'activo', 'a', 'en-implementacion',
                       'heredado', true)
  from movidos m;
  get diagnostics heredados = row_count;
  if heredados > 0 then
    raise notice
      '% proyecto(s) con G6 aprobado antes de SPEC-07 pasan a en-implementacion: es la fase que su aprobación ya significaba (§7)',
      heredados;
  end if;
  -- Y la deuda que se deja declarada en vez de saldada por decreto.
  select count(*) into heredados from proyecto p
    where p.estado = 'activo'
      and exists (select 1 from reto r
        where r.id = p.reto_id and r.workspace_id = p.workspace_id
          and r.estado in ('cerrado', 'archivado'));
  if heredados > 0 then
    raise notice
      '% proyecto(s) siguen en activo bajo un reto ya terminado: el ciclo anterior cerraba el reto sin poder mover el proyecto. NO se les inventa un estado (cerrado es inmutable); saldarlo es decisión de producto',
      heredados;
  end if;
end $$;

-- ── Y los retos que YA estaban midiendo sin contrato de medición ──
-- El mismo problema un paso más allá, y peor: el ciclo anterior (20260902070000) admitía
-- `activo → en-medicion` sin registry porque la medición no existía todavía. Esos retos
-- están midiendo FUERA del sistema, y este slice les quita la única salida que tenían:
-- `en-medicion → cerrado` ahora exige un veredicto que solo escribe el guard del outcome
-- review, el review exige un registry firmado, el registry no se podía ni abrir sobre un
-- reto que no está 'activo' — y `en-medicion` no vuelve a 'activo' ni se archiva. Quedaban
-- encerrados: ni miden aquí, ni cierran, ni se archivan.
--
-- La salida NO es dejarlos cerrar sin veredicto (sería el loop abierto que SYS-24 cierra,
-- y el CHECK nuevo lo rechaza igual) ni archivarlos por decreto (es trabajo vivo, no
-- basura). Es dejarles ABRIR su contrato ahora: firman el registry —su G6 ya está marcado
-- por el bloque de arriba—, declaran la ventana que llevan corriendo, y desde ahí el
-- camino es el normal: snapshots, review y cierre con veredicto de verdad.
--
-- Misma disciplina que la marca del gate, y la misma advertencia: se escribe UNA vez, aquí;
-- ningún guard la toca y no está en el grant de UPDATE (`reto` solo concede `estado`), pero
-- el `grant insert` es de tabla y cubre las columnas nuevas, así que la puerta que hay que
-- cerrar es la de INSERT — lo hace `reto_insert`, más abajo, exigiendo que nazca en false.
-- Y el estado que habilita —«reto en medición sin registry»— es inalcanzable para todo
-- reto posterior, porque abrir la medición exige el registry FIRMADO.
-- Y CUÁNDO DEJA DE APLICAR. Esta marca tampoco se borra, pero a diferencia de la del gate
-- tiene VARIOS lectores, así que la caducidad hay que escribirla en cada uno o la exención
-- se queda abierta para siempre en el que se olvide:
--  · `registry_insert` — la acota el `unique (reto_id)` de `metric_registry`: abre el
--    contrato que falta, y en cuanto existe no hay un segundo que abrir.
--  · los dos guards del par (transición del proyecto y constraint diferido) — los acota
--    `proyecto_puede_seguir_al_reto`: la exención vale mientras al proyecto le falten su G7
--    o el registry firmado, que es justamente mientras NO pueda seguir a su reto.
--  · `abrirMedicion` — lo acota que quede algún proyecto DETRÁS: terminada la reparación no
--    hay movimiento que rematar y la operación vuelve a decir que la medición ya está
--    abierta, que es la verdad.
-- La regla común, que es la que conviene recordar en la próxima marca: un perdón vale
-- exactamente mientras dure la condición que lo hizo necesario, ni un caso más ni uno menos.
alter table reto add column medicion_sin_registry boolean not null default false;
update reto set medicion_sin_registry = true where estado = 'en-medicion';

-- ── «La ventana sigue abierta», en UN solo sitio ──
-- Tres predicados de la base (apertura del review, guard de completación, estado de
-- cadencia de la proyección) y su espejo del cliente deciden exactamente lo mismo. Escrito
-- una vez por sitio, basta que una copia use `>` donde otra usa `>=` para que el sistema
-- se contradiga consigo mismo. Mismo argumento que con `es_rol_cliente` y que con no
-- copiar `ventana_dias`: dos copias son dos verdades.
--
-- Y la verdad es que el ÚLTIMO DÍA de la ventana es un día MEDIDO: `snapshot_insert`
-- acepta `fecha <= ventana_inicio + ventana_dias`, con los dos extremos inclusivos porque
-- el día que abre y el que cierra la ventana se miden. Mientras `current_date` sea ese
-- día, el dato de la jornada todavía puede llegar y la ventana NO está cerrada — de ahí
-- el `>=`. Con `>` el sistema se contradecía: el post mortem se podía abrir y completar a
-- primera hora del último día, cerrando el reto de forma irreversible (SYS-08), y los
-- snapshots legítimos de esa misma tarde se quedaban sin sitio. El contrato firmado los
-- admitía; el sistema ya no.
--
-- Sin ventana declarada tampoco está cerrada: no hay nada que dar por terminado. Esa rama
-- impide abrir el review sobre un registry al que le falta la ventana, y conviene ser
-- exacto sobre lo que eso significa, porque «impedir» aquí quiere decir «PARA SIEMPRE»:
-- devuelve true a perpetuidad, así que un registry FIRMADO sin `ventana_dias` no podría
-- abrir su post mortem nunca, ni cerrar su reto, ni cerrar su proyecto. Este comentario
-- daba por hecho que la firma hacía imposible ese estado; no lo hacía —su lista de
-- completitud enumeraba columnas de `entrada_kpi` y nunca cruzaba al criterio— y ahora sí:
-- `registry_firmar_guard` exige `c.ventana_dias is not null` antes de sellar. La red de
-- seguridad de un estado irrecuperable tiene que ser una regla, no un supuesto.
--
-- STABLE y no IMMUTABLE porque depende de `current_date`. No lee ninguna tabla, así que
-- —como `es_rol_cliente`— no puede volverse oráculo y no necesita el tratamiento
-- anti-oráculo de los helpers SECURITY DEFINER.
create function ventana_de_medicion_abierta(p_inicio date, p_dias integer) returns boolean
language sql stable parallel safe as
$$ select p_inicio is null or p_dias is null or p_inicio + p_dias >= current_date $$;

-- ── El CALENDARIO de la cadencia se deriva del ANCLA, no se encadena ──
-- Tercera vez que este PR tropieza con la misma familia: dos aritméticas distintas sobre el
-- mismo compromiso. Primero fueron los 30/90 días fijos contra meses de calendario. Ahora,
-- la deriva: las fechas prometidas se calculaban ENCADENANDO desde la lectura anterior
-- (`previa + paso`), y encadenar deja que cada entrega real redefina el calendario.
--
-- En fin de mes la deriva es de un solo sentido y no vuelve. Serie mensual 31-ene → 28-feb
-- → 31-mar, entregada PUNTUALMENTE: PostgreSQL evalúa `28-feb + 1 mes` como 28-mar —febrero
-- baja el ancla al 28 y ya no sube—, así que la entrega del 31 de marzo aparecía como
-- retrasada. Con la ventana cerrada ese KPI quedaba `vencido` PARA SIEMPRE, y el registro
-- histórico de un compromiso cumplido decía que no se cumplió. Eso es exactamente lo que
-- lee el outcome review cuando alguien juzga si el compromiso se cumplió, y este slice
-- existe para poder defender ese juicio.
--
-- El arreglo no es el caso de febrero sino la raíz: las fechas prometidas se generan desde
-- `ventana_inicio` —d(n) = inicio + n·paso, SIEMPRE sobre el ancla original—, así que el
-- calendario no se mueve pase lo que pase con las entregas reales. `31-ene + 1 mes` sigue
-- siendo 28-feb, pero `31-ene + 2 meses` vuelve a ser 31-mar en vez de quedarse en 28-mar.
--
-- Y se escribe UNA vez para los DOS sitios que juzgan cadencia —el estado de recepción de
-- la proyección y la coherencia que exige la firma—, por el mismo motivo que
-- `ventana_de_medicion_abierta`: si uno deriva del ancla y el otro encadena, vuelve a haber
-- dos verdades sobre el mismo compromiso y la firma bendice lo que la lectura llamará
-- incumplido.

-- El paso comprometido. 'unica' no tiene cadencia y devuelve null, que es lo que apaga
-- todas las reglas de abajo sin un caso aparte en cada una.
create function paso_de_cadencia(p_frecuencia text) returns interval
language sql immutable parallel safe as
$$ select case p_frecuencia
     when 'semanal' then interval '7 days'
     when 'mensual' then interval '1 month'
     when 'trimestral' then interval '3 months' end $$;

-- Las entregas que el compromiso promete dentro de [p_inicio, p_hasta], con el periodo que
-- cubre cada una. `previo` es el vencimiento ANTERIOR —también derivado del ancla, no
-- `vence - paso`, que en meses no es la operación inversa (28-feb − 1 mes = 28-ene, no
-- 31-ene)—, y el primero es el propio inicio de la ventana.
--
-- La cota del `generate_series` sale del paso más corto (7 días), así que sobra para las
-- tres frecuencias; lo que decide de verdad cuántas entregas hay es el `where`.
create function vencimientos_de_cadencia(p_inicio date, p_frecuencia text, p_hasta date)
returns table (n integer, previo date, vence date)
language sql stable parallel safe as $$
  select i,
    (p_inicio + (i - 1) * paso_de_cadencia(p_frecuencia))::date,
    (p_inicio + i * paso_de_cadencia(p_frecuencia))::date
  from generate_series(1, greatest((p_hasta - p_inicio) / 7 + 1, 1)) as i
  where paso_de_cadencia(p_frecuencia) is not null
    and (p_inicio + i * paso_de_cadencia(p_frecuencia))::date <= p_hasta
$$;

-- ¿Quedó sin cubrir alguna entrega prometida hasta `p_hasta`? Es la pregunta que responden
-- las cuatro ramas del estado de recepción, cambiando solo hasta DÓNDE se juzga: con la
-- ventana abierta, hasta AYER —hoy no ha terminado y el dato de la jornada todavía puede
-- llegar—; cerrada, hasta su último día, que es un día medido.
--
-- El periodo de cada entrega es `(previo, vence]`, con el PRIMERO inclusivo por los dos
-- extremos: el día que abre la ventana es un día medido, así que un corte fechado ahí es la
-- primera entrega y no un dato anterior al compromiso. Es el mismo corte inclusivo que usa
-- toda la ventana de este slice.
--
-- Sin SECURITY DEFINER: lee los snapshots de la entrada que el llamador ya está leyendo, así
-- que corre bajo su RLS y no puede volverse oráculo.
create function cadencia_incumplida(p_entrada uuid, p_ws uuid, p_inicio date,
                                    p_frecuencia text, p_hasta date) returns boolean
language sql stable as $$
  select exists (
    select 1 from vencimientos_de_cadencia(p_inicio, p_frecuencia, p_hasta) v
    where not exists (
      select 1 from snapshot s
      where s.entrada_kpi_id = p_entrada and s.workspace_id = p_ws
        and s.fecha <= v.vence
        and (s.fecha > v.previo or v.n = 1 and s.fecha >= v.previo))
  )
$$;
revoke execute on function cadencia_incumplida(uuid, uuid, date, text, date) from public;
grant execute on function cadencia_incumplida(uuid, uuid, date, text, date) to designio_app;

-- ── RLS ──
-- Lectura: TODO miembro (ver el tablero completo es el punto del portal; el stakeholder
-- lee el impacto aunque no escriba nada). Escrituras:
--  · registry/entradas — curadores (lead/diseñador) mientras el registry es borrador, y
--    con el dueño del dato del lado CLIENTE (RF-07.1) o todavía sin asignar.
--  · firma del registry — SOLO el rol aprobador de G6 (sponsor, §13.2) y solo en G6:
--    con G0-G5 aprobados y G6 aún pendiente. Firmado ⇒ congelado (ninguna política
--    alcanza sus filas).
--  · snapshots — curadores o el PROPIETARIO DEL DATO de esa entrada, solo con el
--    registry firmado y el reto en medición, y solo con FECHA dentro de la ventana
--    firmada y no futura (I5); jamás update ni delete (SYS-23).
--  · outcome review — el lead (opera el método), y solo cuando la ventana del último
--    criterio ya cerró (RF-07.7).

alter table metric_registry enable row level security;
alter table entrada_kpi enable row level security;
alter table snapshot enable row level security;
alter table outcome_review enable row level security;
alter table resultado_criterio enable row level security;

create policy registry_select on metric_registry
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy entrada_select on entrada_kpi
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy snapshot_select on snapshot
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy review_select on outcome_review
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy resultado_select on resultado_criterio
  for select using (is_workspace_member(app_user_id(), workspace_id));

create policy registry_insert on metric_registry
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'borrador'
    and firmado_por is null
    and firmado_en is null
    -- El contrato de medición se redacta con el reto VIVO: ni sobre un candidato sin
    -- método ni sobre uno ya cerrado (SYS-08). Y también sobre uno que YA estaba midiendo
    -- cuando este esquema no existía (ver arriba): es la única forma de que llegue a tener
    -- contrato, y sin ella no puede ni medir aquí ni cerrar. Esa marca la escribió la
    -- migración y nadie puede volver a escribirla.
    and exists (select 1 from reto r
      where r.id = metric_registry.reto_id and r.workspace_id = metric_registry.workspace_id
        and (r.estado = 'activo'
             or (r.estado = 'en-medicion' and r.medicion_sin_registry)))
  );

-- La firma es la transición decisora del registry (SYS-22). El rol se lee del PROPIO
-- gate G6 del proyecto del reto: si el método cambiara su rol aprobador, la firma lo
-- sigue sin tocar esta política.
create policy registry_firmar on metric_registry
  for update
  using (
    estado = 'borrador'
    and exists (select 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      where p.reto_id = metric_registry.reto_id
        and p.workspace_id = metric_registry.workspace_id
        and g.numero = 6
        -- G6 pendiente… o G6 aprobado ANTES de que este esquema existiera (ver arriba):
        -- esa marca la escribió la migración y nadie puede volver a escribirla.
        and (g.estado = 'pendiente' or g.aprobado_sin_registry)
        and workspace_role(app_user_id(), metric_registry.workspace_id) = g.rol_aprobador)
    -- «Se firma EN G6»: no antes. Los gates ordenan el método y el registry se acuerda
    -- con el plan de implementación delante, no en el kickoff.
    and not exists (select 1 from gate_instancia g2
      join proyecto p2 on p2.id = g2.proyecto_id and p2.workspace_id = g2.workspace_id
      where p2.reto_id = metric_registry.reto_id
        and p2.workspace_id = metric_registry.workspace_id
        and g2.numero < 6 and g2.estado <> 'aprobado')
  )
  with check (
    estado = 'firmado'
    and firmado_por = app_user_id()
  );

create policy entrada_insert on entrada_kpi
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from metric_registry r
      where r.id = entrada_kpi.registry_id and r.workspace_id = entrada_kpi.workspace_id
        and r.estado = 'borrador')
    -- El criterio debe ser del MISMO reto del registry: un KPI colgado del criterio de
    -- otro reto mediría otra promesa (la FK compuesta solo garantiza el workspace).
    and exists (select 1 from metric_registry r
      join criterio_exito c on c.reto_id = r.reto_id and c.workspace_id = r.workspace_id
      where r.id = entrada_kpi.registry_id and r.workspace_id = entrada_kpi.workspace_id
        and c.id = entrada_kpi.criterio_id)
    -- RF-07.1: el dueño del dato es una persona del CLIENTE. Se acepta ausente —la entrada
    -- se redacta iterando y la completitud la exige la firma—, pero no de la boutique: un
    -- registry con un lead como dueño del dato convierte el compromiso del cliente en la
    -- transcripción que G6 existe justamente para sustituir. Va en la política y no solo
    -- en el selector porque el selector es una sugerencia y esto es el contrato.
    and (entrada_kpi.propietario_miembro_id is null or exists (select 1 from miembro m
      where m.id = entrada_kpi.propietario_miembro_id
        and m.workspace_id = entrada_kpi.workspace_id and es_rol_cliente(m.rol)))
  );
create policy entrada_update on entrada_kpi
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from metric_registry r
      where r.id = entrada_kpi.registry_id and r.workspace_id = entrada_kpi.workspace_id
        and r.estado = 'borrador')
  )
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from metric_registry r
      join criterio_exito c on c.reto_id = r.reto_id and c.workspace_id = r.workspace_id
      where r.id = entrada_kpi.registry_id and r.workspace_id = entrada_kpi.workspace_id
        and c.id = entrada_kpi.criterio_id)
    and (entrada_kpi.propietario_miembro_id is null or exists (select 1 from miembro m
      where m.id = entrada_kpi.propietario_miembro_id
        and m.workspace_id = entrada_kpi.workspace_id and es_rol_cliente(m.rol)))
  );

-- Snapshots: quien tiene el dato lo aporta. El propietario del dato es SIEMPRE del cliente
-- (RF-07.1, exigido al escribir la entrada y al firmar): sin esta rama, medir dependería
-- de que la boutique transcriba, que es justo el compromiso que G6 formaliza.
create policy snapshot_insert on snapshot
  for insert with check (
    creado_por = app_user_id()
    -- La fecha del DATO no puede ser del futuro. Sin esto, el propietario del dato mete
    -- un valor fechado por delante: la proyección lo toma como la última recepción (y la
    -- cadencia pasa a «recibido» sin que nadie haya aportado nada), y el selector del
    -- outcome review lo ofrece como resultado final del criterio.
    and snapshot.fecha <= current_date
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
-- Deliberadamente SIN update ni delete en snapshot: append-only (SYS-23).

-- ── Una CARGA no corrige: corregir es un acto explícito y de uno en uno ──
-- Aquí hay dos escrituras que la fila no distingue y que significan lo contrario. Con la
-- tabla append-only y sin UPDATE ni DELETE, insertar otro dato para la misma entrada y la
-- misma fecha es la ÚNICA forma que existe de corregir un valor mal tecleado: eso es
-- deliberado y es lo que SYS-23 pide. Y es también, exactamente, lo que produce reenviar
-- un CSV que ya se cargó — un doble clic, un reintento del navegador, volver a pegar el
-- fichero mañana—, con la diferencia de que ahí nadie quiso corregir nada y el duplicado
-- es PERMANENTE, porque no hay borrado que lo saque.
--
-- Por eso se descartó el arreglo que parece obvio: un `unique (entrada_kpi_id, fecha)`
-- convertiría cada errata en incorregible para siempre —prohibiría el caso bueno para
-- frenar el malo— y contradiría la razón por la que esta tabla es append-only.
--
-- Lo que sí separa los dos casos es la INTENCIÓN, y la fila la lleva escrita: `origen`. Una
-- carga masiva es un export de una hoja de cálculo, no una decisión sobre un dato concreto;
-- corregir es un acto de uno en uno, con su nota, y para eso está el formulario. Así que la
-- regla es: por CSV no se escribe sobre una fecha que ya tiene dato. El reenvío accidental
-- se para solo, la corrección sigue existiendo por donde de verdad se declara, y la promesa
-- deja de depender de que una pantalla se acuerde de vaciar un textarea.
--
-- No es SECURITY DEFINER: consulta snapshots de la MISMA entrada, que cualquier miembro del
-- workspace ya puede leer, así que no puede volverse oráculo de nada.
--
-- Y no ve las filas anteriores de su propia sentencia —una carga entra en un solo INSERT y
-- el snapshot del trigger no incluye lo que esa misma orden acaba de escribir—, así que los
-- duplicados DENTRO del fichero los rechaza el servicio, fila a fila y con su motivo, que es
-- además donde ese diagnóstico sirve de algo.
create function snapshot_carga_no_corrige_guard() returns trigger
language plpgsql as $$
begin
  if new.origen = 'csv' and exists (select 1 from snapshot s
    where s.entrada_kpi_id = new.entrada_kpi_id and s.workspace_id = new.workspace_id
      and s.fecha = new.fecha) then
    raise exception 'ya hay un dato de esta entrada para el %: una carga no corrige — corregir es un dato NUEVO desde el formulario, con su nota (SYS-23)', new.fecha;
  end if;
  return new;
end $$;
create trigger snapshot_carga_no_corrige
  before insert on snapshot
  for each row execute function snapshot_carga_no_corrige_guard();
revoke execute on function snapshot_carga_no_corrige_guard() from public;

-- El outcome review se HABILITA al cerrar la ventana del último criterio (RF-07.7): la
-- condición vive en la política, no solo en la pantalla.
create policy review_insert on outcome_review
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and estado = 'borrador'
    and veredicto is null
    and exists (select 1 from reto r
      where r.id = outcome_review.reto_id and r.workspace_id = outcome_review.workspace_id
        and r.estado = 'en-medicion')
    and exists (select 1 from metric_registry r
      where r.reto_id = outcome_review.reto_id and r.workspace_id = outcome_review.workspace_id
        and r.estado = 'firmado')
    and not exists (select 1 from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
      join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
      where r.reto_id = outcome_review.reto_id and r.workspace_id = outcome_review.workspace_id
        and ventana_de_medicion_abierta(e.ventana_inicio, c.ventana_dias))
  );
create policy review_completar on outcome_review
  for update
  using (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  )
  with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    -- Redactar (sigue borrador) o completar (veredicto firmado). El catálogo cerrado lo
    -- exige el CHECK de la tabla; aquí se exige la FIRMA de quien lo dicta.
    and (estado = 'borrador'
      or (estado = 'completado' and veredicto is not null
          and completado_por = app_user_id() and completado_en is not null))
  );

create policy resultado_insert on resultado_criterio
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from outcome_review o
      join criterio_exito c on c.reto_id = o.reto_id and c.workspace_id = o.workspace_id
      where o.id = resultado_criterio.review_id and o.workspace_id = resultado_criterio.workspace_id
        and o.estado = 'borrador' and c.id = resultado_criterio.criterio_id)
    -- El valor final apunta a un snapshot de ESTE criterio o no apunta a nada: un
    -- «resultado» tomado de la serie de otro KPI sería una cifra inventada con FK.
    and (snapshot_final_id is null or exists (select 1 from snapshot s
      join entrada_kpi e on e.id = s.entrada_kpi_id and e.workspace_id = s.workspace_id
      where s.id = resultado_criterio.snapshot_final_id
        and s.workspace_id = resultado_criterio.workspace_id
        and e.criterio_id = resultado_criterio.criterio_id))
  );
create policy resultado_update on resultado_criterio
  for update
  using (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from outcome_review o
      where o.id = resultado_criterio.review_id
        and o.workspace_id = resultado_criterio.workspace_id and o.estado = 'borrador')
  )
  with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and (snapshot_final_id is null or exists (select 1 from snapshot s
      join entrada_kpi e on e.id = s.entrada_kpi_id and e.workspace_id = s.workspace_id
      where s.id = resultado_criterio.snapshot_final_id
        and s.workspace_id = resultado_criterio.workspace_id
        and e.criterio_id = resultado_criterio.criterio_id))
  );

-- ══ EL PUNTO DE CITA: la fila del RETO ══════════════════════════════════════════════
-- Todas las políticas de arriba son predicados sobre un SNAPSHOT. Cuando dos escrituras
-- deciden sobre lo mismo tocando FILAS DISTINTAS, ninguna bloquea a la otra: cada una
-- evalúa su condición contra un snapshot que no ve a la vecina y las dos commitean. El
-- resultado es una escritura sobre un mundo que ya no existe.
--
-- El barrido de todos los pares del slice —cada escritura contra cada transición ajena—
-- deja CINCO que necesitan cita, y los cinco cuelgan del reto (el registry es 1:1 con él,
-- los criterios son suyos, la serie cuelga de sus entradas, el review es 1:1 con él y el
-- proyecto se cierra con él). Por eso el punto de cita es UNO: la fila del reto. Un candado
-- por par sería más superficie de interbloqueo y nadie capaz de razonar el orden.
--
--   entrada_kpi ↔ firma del registry        · «registry en borrador»   → este guard
--   snapshot ↔ completación del review      · «reto en medición»       → este guard
--   resultado_criterio ↔ completación       · «review en borrador»     → este guard
--   firma del registry ↔ criterio_exito     · «criterio del reto»      → filas del G0
--   reapertura de etapa ↔ completación      · «proyecto no cerrado»    → fila del proyecto
--
-- Los dos últimos ya se citan en una fila más fina y probada; se conservan tal cual porque
-- se apoyan en bloqueos que ya existían (el de `criterio_g0_pendiente_guard` es del ciclo
-- del método, no de este slice) y sobreviven mejor a que alguien reemplace esos guards.
--
-- ORDEN DE ADQUISICIÓN, en un solo sitio y para todas las rutas:
--   fila del RETO  →  metric_registry / outcome_review / proyecto / gate_instancia
-- La fila que la propia sentencia actualiza queda bloqueada antes por PostgreSQL, y
-- ninguna ruta bloquea dos filas «propias», así que con esta regla no hay ciclo posible.
-- El candado consultivo del servicio (`designio:reto:`) es el mismo acuerdo un nivel más
-- arriba; este vale además para el SQL directo, que es donde el servicio no llega.
create function bloqueo_por_reto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- Guard COMPARTIDO entre tres tablas con columnas distintas: plpgsql resuelve todas las
  -- referencias de campo aunque su rama no se ejecute, así que la fila se lee por jsonb.
  fila jsonb := to_jsonb(new);
  v_reto uuid;
begin
  -- Pre-chequeo anti-oráculo, como el resto: la consulta privilegiada solo corre para
  -- miembros del workspace declarado; a los demás los rechaza la política.
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  -- Por dónde llega cada escritura hasta su reto. Todas estas pertenencias son
  -- inmutables (ni `registry_id` ni `entrada_kpi_id` ni `review_id` se editan jamás), así
  -- que resolverlas antes de bloquear no abre ninguna carrera nueva.
  if tg_table_name = 'entrada_kpi' then
    select r.reto_id into v_reto from metric_registry r
      where r.id = (fila->>'registry_id')::uuid and r.workspace_id = new.workspace_id;
  elsif tg_table_name = 'snapshot' then
    select r.reto_id into v_reto
      from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
      where e.id = (fila->>'entrada_kpi_id')::uuid and e.workspace_id = new.workspace_id;
  else
    select o.reto_id into v_reto from outcome_review o
      where o.id = (fila->>'review_id')::uuid and o.workspace_id = new.workspace_id;
  end if;
  -- Sin reto no hay nada que bloquear: la FK y la política dirán que la referencia no
  -- existe, y decirlo aquí sería adelantarles un diagnóstico que no nos toca.
  if v_reto is null then
    return new;
  end if;
  perform 1 from reto where id = v_reto and workspace_id = new.workspace_id for update;
  -- Y AQUÍ está el punto: releer el predicado DESPUÉS de esperar. Cada sentencia de
  -- plpgsql toma su propio snapshot, así que esta lectura ya ve lo que commiteó quien
  -- tenía la fila — que es justo lo que la política, atada al snapshot de la sentencia
  -- externa, no puede ver.
  if tg_table_name = 'entrada_kpi' then
    if exists (select 1 from metric_registry r
      where r.id = (fila->>'registry_id')::uuid and r.workspace_id = new.workspace_id
        and r.estado <> 'borrador') then
      raise exception 'el Metric Registry ya está firmado: el contrato quedó congelado (SYS-22)';
    end if;
  elsif tg_table_name = 'snapshot' then
    if not exists (select 1 from reto r
      where r.id = v_reto and r.workspace_id = new.workspace_id and r.estado = 'en-medicion') then
      raise exception 'el reto ya no está en medición: su serie se cerró con el post mortem (SYS-08)';
    end if;
  else
    if exists (select 1 from outcome_review o
      where o.id = (fila->>'review_id')::uuid and o.workspace_id = new.workspace_id
        and o.estado <> 'borrador') then
      raise exception 'el outcome review ya está completado: el post mortem es inmutable (SYS-08)';
    end if;
  end if;
  return new;
end $$;
create trigger entrada_bloqueo_por_reto
  before insert or update on entrada_kpi
  for each row execute function bloqueo_por_reto_guard();
create trigger snapshot_bloqueo_por_reto
  before insert on snapshot
  for each row execute function bloqueo_por_reto_guard();
create trigger resultado_bloqueo_por_reto
  before insert or update on resultado_criterio
  for each row execute function bloqueo_por_reto_guard();
revoke execute on function bloqueo_por_reto_guard() from public;

-- ── El proyecto gana su transición de estado (hasta ahora sin grant ni política) ──
-- La abre este slice porque es el que la necesita: G7 mueve el proyecto a medición y el
-- post-mortem lo cierra. Con el mismo rigor que el reto: rol que opera el método, pares
-- legales en un guard y CERRADO INMUTABLE (SYS-08) ya en el USING. Qué gate habilita cada
-- par y quién puede cerrar viven en el guard y no aquí: una política solo ve la fila
-- NUEVA, y estas dos reglas son sobre el par viejo→nuevo y sobre otra tabla.
create policy proyecto_update_estado on proyecto
  for update
  using (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and estado <> 'cerrado'
  )
  with check (workspace_role(app_user_id(), workspace_id) = 'lead-boutique');

-- ── «¿Este proyecto YA puede entrar en medición con su reto?», en UN solo sitio ──
-- Un perdón histórico vale exactamente mientras dure la condición que lo hizo necesario, ni
-- un caso más ni uno menos. `medicion_sin_registry` exime al proyecto de un reto HEREDADO
-- de la regla «si tu reto mide, tú mides», y la razón de esa exención es concreta: ese
-- proyecto TODAVÍA NO PUEDE seguir a su reto —le falta recorrer G6, firmar el contrato y
-- aprobar G7—, así que exigírselo cerraría la única salida que esas filas tienen.
--
-- Esa razón caduca. En el instante en que el proyecto tiene su G7 aprobado y el registry de
-- su reto firmado, seguir al reto es un movimiento legal y disponible (`pausado` y
-- `en-implementacion` entran los dos en medición por su propio par), y a partir de ahí la
-- exención ya no perdona nada: solo abre una vía para dejar el proyecto por DETRÁS de un
-- reto que ya mide, que es exactamente lo que el perdón existía para evitar. Y como la
-- marca no se borra nunca —la escribió la migración y nadie la vuelve a escribir—, atarla a
-- la marca sola es dejarla abierta para siempre.
--
-- Son las DOS condiciones y no una, porque para el proyecto heredado son independientes: su
-- G6 está aprobado CON la marca `aprobado_sin_registry`, o sea aprobado sin contrato, y la
-- regla que exige el registry firmado para aprobar G6 solo corre en el `pendiente →
-- aprobado` que ese proyecto ya no va a hacer. Así que puede llegar a tener G7 aprobado con
-- el registry todavía sin firmar — y ahí sigue sin poder medir de verdad, porque la
-- política del snapshot exige contrato firmado. Con «G7 aprobado» a secas la exención se
-- cerraría un paso antes de tiempo.
--
-- Se escribe UNA vez y la llaman los dos guards del par, por el mismo motivo que
-- `proyectos_frenan_medicion`: dos redacciones del mismo predicado son dos verdades, y a
-- una de las dos siempre se le queda una condición corta.
--
-- Sin SECURITY DEFINER, como sus dos llamadores: lee gates y registry del MISMO workspace
-- que el actor acaba de escribir, visibles para cualquier miembro, así que corre bajo el
-- RLS de quien llama y no puede volverse oráculo.
create function proyecto_puede_seguir_al_reto(p_proyecto uuid, p_reto uuid, p_ws uuid)
returns boolean
language sql stable as $$
  select exists (select 1 from gate_instancia g
      where g.proyecto_id = p_proyecto and g.workspace_id = p_ws
        and g.numero = 7 and g.estado = 'aprobado')
    and exists (select 1 from metric_registry r
      where r.reto_id = p_reto and r.workspace_id = p_ws and r.estado = 'firmado')
$$;
revoke execute on function proyecto_puede_seguir_al_reto(uuid, uuid, uuid) from public;
grant execute on function proyecto_puede_seguir_al_reto(uuid, uuid, uuid) to designio_app;

-- La máquina de estados del proyecto, ENTERA y en un solo sitio: cada par legal con su
-- precondición al lado. Este slice hizo escribible `proyecto.estado` y al principio declaró
-- solo los pares, dejando las precondiciones en quien escribe — que es justo el reparto que
-- deja a un camino nuevo saltarse lo que el anterior comprobaba. Aquí no hay «quien
-- escribe»: hay una regla por par, y da igual si llega por el servicio o por SQL directo.
--
--   activo            → pausado            · sin precondición (parar es del cliente)
--   en-implementacion → pausado            · sin precondición (también se para implementando)
--   pausado           → activo             · G6 NO aprobado y el reto sin abrir medición
--   pausado           → en-implementacion  · G6 aprobado y el reto sin abrir medición
--   pausado           → en-medicion        · el reto YA midiendo (y su G7 aprobado)
--   activo            → en-implementacion  · G6 aprobado (§7)
--   en-implementacion → en-medicion        · G7 aprobado Y el reto ya midiendo
--   en-medicion       → cerrado            · el reto con veredicto (RF-07.10)
--
-- Y una precondición que vale para TODOS los pares menos el último: el reto no puede haber
-- terminado. Un reto cerrado o archivado congela a sus proyectos donde estén.
--
-- Retomar es DETERMINISTA y tiene UN destino, que sale de dos preguntas en este orden:
-- dónde está el RETO y, si el reto todavía no mide, si el plan ya estaba aprobado. Un
-- proyecto pausado antes del plan vuelve a 'activo', uno pausado durante la implementación
-- vuelve a 'en-implementacion', y cualquiera de los dos vuelve a 'en-medicion' si mientras
-- estaba parado su reto abrió la medición. Sin esa discriminación «reanudar» habría tenido
-- varios destinos posibles y el que eligiera la pantalla se habría convertido en la regla
-- — otra vez la precondición en quien escribe.
--
-- Y `activo → en-medicion` NO está: no es una restricción nueva sino el par que sobraba.
-- Medir exige G7, G7 exige G6 y aprobar G6 mete el proyecto en implementación, así que un
-- proyecto en 'activo' con su G7 aprobado solo podía existir como HISTORIA —G6 aprobado
-- antes de que ese efecto existiera—, y a esa historia la mueve el relleno del preámbulo
-- allí donde el par podría usarse: bajo un reto VIVO. Bajo uno cerrado el relleno no toca
-- nada a propósito, y tampoco hace falta: a medición no se llega sin un reto que mida.
-- Mientras el par siguió declarado, ese proyecto heredado saltaba de 'activo' a medición
-- sin pasar por la fase que su propio G6 significaba; declarar solo los pares alcanzables
-- es lo que hace que la tabla describa el método en vez de dejarle un atajo.
create function proyecto_estado_transicion_guard() returns trigger
language plpgsql as $$
declare
  g6_aprobado boolean;
begin
  if new.estado = old.estado then
    return new;
  end if;
  -- (Las reglas de abajo que consultan `reto` son predicados sobre una instantánea, como
  -- toda lectura sin candado. Quien cierra esa carrera es el espejo DIFERIDO del par, más
  -- abajo, y no un `for update` aquí: ver allí por qué el candado no podía ir en este
  -- guard.)
  -- Ciclo de vida del proyecto (RF-04.12, §7): pausar y retomar es reversible; avanzar en
  -- el método no. Nada sale de 'cerrado' — el trabajo posterior es un reto nuevo (SYS-08).
  if (old.estado, new.estado) not in (
    ('activo', 'pausado'),
    ('en-implementacion', 'pausado'),
    ('pausado', 'activo'),
    ('pausado', 'en-implementacion'),
    ('pausado', 'en-medicion'),
    ('activo', 'en-implementacion'),
    ('en-implementacion', 'en-medicion'),
    ('en-medicion', 'cerrado')
  ) then
    raise exception 'transición de proyecto ilegal: % → %', old.estado, new.estado;
  end if;
  -- El reto que ya TERMINÓ congela a sus proyectos. El relleno del preámbulo deja a
  -- propósito quietos los proyectos 'activo' de un reto cerrado —no les inventa una fase
  -- que nadie vivió—, pero dejarlos quietos solo es una decisión si además QUEDAN quietos:
  -- mientras el par `activo → en-implementacion` siguiera abierto para ellos, cualquier
  -- lead podía empujar esa fila a un estado sin salida. Desde 'en-implementacion' solo se
  -- va a 'pausado' o a 'en-medicion', y medir exige un reto MIDIENDO, cosa que un reto
  -- cerrado no puede volver a ser porque su ciclo es de sentido único. El proyecto quedaba
  -- varado para siempre y encima con la historia falsificada: implementándose bajo un reto
  -- que terminó. Es SYS-08 aplicado al hijo — lo posterior al cierre es un reto NUEVO.
  --
  -- La excepción es una sola y es la del propio cierre: `outcome_review_completar_guard`
  -- escribe el veredicto del reto ANTES de mover el proyecto —tiene que ser en ese orden,
  -- porque cerrar el proyecto exige ese veredicto—, así que el único paso legítimo que
  -- llega aquí con el reto ya cerrado es 'en-medicion' → 'cerrado'.
  if not (old.estado = 'en-medicion' and new.estado = 'cerrado')
    and exists (select 1 from reto r
      where r.id = new.reto_id and r.workspace_id = new.workspace_id
        and r.estado in ('cerrado', 'archivado')) then
    raise exception 'el reto ya terminó: su proyecto se queda como está y lo posterior es un reto nuevo (SYS-08)';
  end if;
  select exists (select 1 from gate_instancia g
    where g.proyecto_id = new.id and g.workspace_id = new.workspace_id
      and g.numero = 6 and g.estado = 'aprobado') into g6_aprobado;
  -- Retomar SIGUE AL RETO, y esta es la primera pregunta porque manda sobre las otras: si
  -- el reto abrió la medición mientras el proyecto estaba parado, el único destino de la
  -- reanudación es 'en-medicion'. El par «reto midiendo ⇔ proyecto midiendo» lo sostiene un
  -- constraint trigger que solo corre cuando el reto ENTRA en medición, así que no ve nada
  -- de lo que pase DESPUÉS: una pausa retomada más tarde dejaba el proyecto por detrás de
  -- su reto sin que nadie levantara. Y eso no era un tablero feo sino un callejón sin
  -- salida — `abrirMedicion` se niega a correr otra vez sobre un reto que ya mide y no es
  -- heredado, y el guard del cierre del outcome review no cierra un reto cuyo proyecto no
  -- está midiendo: el reto se quedaba sin poder terminar por el camino normal del producto.
  -- La mitad que le falta al constraint diferido se comprueba aquí, en la transición del
  -- PROYECTO, que es la que llega tarde.
  --
  -- Con la excepción del reto heredado (`medicion_sin_registry`), que es el único que mide
  -- teniendo por definición su proyecto detrás: ahí «estar detrás» no es la avería sino el
  -- estado que la migración encontró, y el camino de reparación consiste justamente en
  -- recorrer G6 y G7 antes de que `abrirMedicion` termine el movimiento. Prohibir ahí la
  -- reanudación cerraría la única salida que ese reto tiene.
  --
  -- Y la excepción dura lo que dura SU MOTIVO, que es `proyecto_puede_seguir_al_reto`: en
  -- cuanto este proyecto tiene su G7 y el registry firmado, retomarlo a 'en-medicion' es un
  -- par legal y disponible, así que dejarlo volver a 'activo' o a 'en-implementacion' ya no
  -- le abre ninguna salida — le abre la vía de quedarse varado detrás de un reto que mide,
  -- que es lo que el perdón existía para evitar. Atada solo a la marca, que no se borra
  -- nunca, la exención habría valido para siempre.
  if old.estado = 'pausado' and new.estado <> 'en-medicion' and exists (select 1 from reto r
    where r.id = new.reto_id and r.workspace_id = new.workspace_id
      and r.estado = 'en-medicion'
      and (not r.medicion_sin_registry
           or proyecto_puede_seguir_al_reto(new.id, new.reto_id, new.workspace_id))) then
    raise exception 'el reto ya está midiendo: al retomarlo el proyecto entra en medición con él, no por detrás (§5.2)';
  end if;
  -- §7: se entra en implementación al aprobarse el PLAN, no por decisión de nadie.
  if new.estado = 'en-implementacion' and not g6_aprobado then
    raise exception 'el proyecto entra en implementación al aprobarse su G6 (§7)';
  end if;
  -- …y por eso mismo un proyecto que se pausó CON el plan aprobado no puede retomarse a
  -- 'activo': volvería atrás en el método y su siguiente paso se saltaría implementación.
  if old.estado = 'pausado' and new.estado = 'activo' and g6_aprobado then
    raise exception 'este proyecto se pausó con su G6 ya aprobado: al retomarlo vuelve a implementación (§7)';
  end if;
  -- §5.2: el paso a «en medición» es el gate de SEGUIMIENTO (G7), no el del plan (G6).
  -- Antes de G7 no hay releases conciliados contra la design version ni effective state
  -- constatado: medir ahí sería medir una implementación que nadie verificó.
  if new.estado = 'en-medicion' and not exists (select 1 from gate_instancia g
    where g.proyecto_id = new.id and g.workspace_id = new.workspace_id
      and g.numero = 7 and g.estado = 'aprobado') then
    raise exception 'el proyecto pasa a medición al aprobarse su G7 (§5.2)';
  end if;
  -- Y el proyecto NO mide por su cuenta: sigue a su reto. §5.2 los mueve juntos («el
  -- proyecto y el reto pasan a en medición»), así que sin esto un lead dejaba el proyecto
  -- midiendo con su reto todavía activo — un tablero que miente y una serie que la política
  -- del snapshot rechazaría de todos modos, porque ella sí mira el estado del RETO.
  if new.estado = 'en-medicion' and not exists (select 1 from reto r
    where r.id = new.reto_id and r.workspace_id = new.workspace_id
      and r.estado = 'en-medicion') then
    raise exception 'el proyecto pasa a medición con su reto, no antes (§5.2)';
  end if;
  -- RF-07.10: el proyecto cierra CON su reto y por una sola mano, la del outcome review.
  -- `reto.veredicto` no tiene grant para el rol de aplicación —solo lo escribe el guard
  -- del review—, así que exigirlo aquí ata el cierre del proyecto a la completación del
  -- post mortem también por SQL directo. Sin esto, cualquier lead cerraba el proyecto
  -- (inmutable, SYS-08) y dejaba su reto midiendo y aceptando snapshots.
  if new.estado = 'cerrado' and not exists (select 1 from reto r
    where r.id = new.reto_id and r.workspace_id = new.workspace_id
      and r.veredicto is not null) then
    raise exception 'el proyecto cierra al completarse el outcome review de su reto (RF-07.10)';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'ProyectoTransicionado',
      jsonb_build_object('proyectoId', new.id, 'de', old.estado, 'a', new.estado),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger proyecto_estado_transicion
  before update of estado on proyecto
  for each row execute function proyecto_estado_transicion_guard();
revoke execute on function proyecto_estado_transicion_guard() from public;

-- ── Las dos condiciones duras del ciclo del reto que aporta la medición ──
-- Se reemplaza el guard de transición (create or replace conserva el trigger instalado)
-- para sumar, sin perder el rastro ni los pares legales: medir exige registry FIRMADO, y
-- cerrar exige VEREDICTO. Sigue sin ser SECURITY DEFINER a propósito: consulta bajo el
-- RLS del invocante, así que no puede volverse oráculo de otros workspaces.
create or replace function reto_estado_transicion_guard() returns trigger
language plpgsql as $$
begin
  if new.estado = old.estado then
    return new;
  end if;
  if (old.estado, new.estado) not in (
    ('candidato', 'activo'),
    ('candidato', 'archivado'),
    ('activo', 'en-medicion'),
    ('en-medicion', 'cerrado'),
    ('cerrado', 'archivado')
  ) then
    raise exception 'transición de reto ilegal: % → %', old.estado, new.estado;
  end if;
  -- SYS-22: no se mide sin contrato firmado. Sin esto, «en medición» sería una etiqueta
  -- y los snapshots entrarían sin dueño del dato ni frecuencia comprometidos.
  if new.estado = 'en-medicion' and not exists (select 1 from metric_registry r
    where r.reto_id = new.id and r.workspace_id = new.workspace_id and r.estado = 'firmado') then
    raise exception 'abrir la medición exige el Metric Registry firmado en G6 (SYS-22)';
  end if;
  -- §5.2: y exige el G7 APROBADO, que es el gate al que el ciclo canónico le asigna este
  -- paso («releases conciliados contra la design version; effective state constatado;
  -- medición operando. El proyecto y el reto pasan a en medición»). G6 solo acuerda el
  -- plan y firma el contrato de medición: abrir ahí admitiría snapshots de una
  -- implementación aún sin conciliar y se saltaría el último gate del método.
  if new.estado = 'en-medicion' and not exists (select 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = new.id and p.workspace_id = new.workspace_id
      and g.numero = 7 and g.estado = 'aprobado') then
    raise exception 'abrir la medición exige el G7 aprobado: releases conciliados y effective state constatado (§5.2)';
  end if;
  -- SYS-24: el reto cierra CON veredicto. La columna no tiene grant para el rol de app:
  -- la única mano que la escribe es el guard del outcome review, así que exigirla aquí
  -- ata el cierre al post-mortem también para el SQL directo.
  if new.estado = 'cerrado' and new.veredicto is null then
    raise exception 'cerrar un reto exige el veredicto del outcome review (SYS-24)';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'RetoTransicionado',
      jsonb_strip_nulls(jsonb_build_object('retoId', new.id, 'de', old.estado,
                                           'a', new.estado, 'veredicto', new.veredicto)),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;

-- ── Una máquina de estados que solo vive en el UPDATE no es una máquina de estados ──
-- El guard de transición de arriba es `before update of estado`, así que en un INSERT no
-- se dispara. Y `proyecto_insert` comprobaba el rol, la autoría y que el reto estuviera
-- activo — nunca el `estado` de la fila que nace. Con `grant insert on proyecto` a nivel de
-- tabla, el rol de aplicación escribe esa columna: un `insert … values (…, 'en-medicion')`
-- daba un proyecto midiendo sin G7 y sin registry —las dos condiciones por las que el
-- guard levanta en el camino UPDATE— y uno con 'cerrado' nacía inmutable, saltándose la
-- máquina entera por la puerta que nadie miraba.
--
-- Hasta este slice apenas importaba porque `proyecto` no tenía grant de UPDATE y el estado
-- no se movía; en cuanto el estado empieza a significar algo, la puerta de entrada tiene
-- que decir por dónde se entra. Todas sus hermanas ya lo hacían —`reto_insert` fija
-- 'candidato', `gate_insert` 'pendiente' con su aprobación nula, `registry_insert`
-- 'borrador' con la firma nula, `review_insert` 'borrador' sin veredicto—: `proyecto_insert`
-- era la única que no, y una fila que nace en el estado que le apetece hace de la tabla de
-- pares legales una recomendación.
drop policy proyecto_insert on proyecto;
create policy proyecto_insert on proyecto
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    -- Se nace ACTIVO y se avanza por transiciones, que es lo que las deja auditables: cada
    -- par legal deja su `ProyectoTransicionado` y ningún estado se alcanza sin pasar por su
    -- precondición.
    and estado = 'activo'
    -- Solo bajo un reto ACTIVO: ni proyectos que esquivan la activación (candidato)
    -- ni trabajo nuevo colgado de un reto cerrado/archivado. activarReto pasa porque
    -- actualiza el reto a activo en una sentencia anterior de la misma transacción.
    -- (Y esa comprobación NO se basta sola: ver el guard de aquí debajo.)
    and exists (select 1 from reto r
      where r.id = proyecto.reto_id and r.workspace_id = proyecto.workspace_id
        and r.estado = 'activo')
  );

-- ── Y las dos columnas del perdón histórico se cierran en la PUERTA, no en el grant ──
-- El preámbulo de esta migración da dos razones independientes para que esas marcas no
-- sean una puerta trasera permanente, y la primera —«no entran en ningún grant, así que el
-- conjunto queda congelado en el instante del despliegue y solo puede encoger»— era falsa
-- en la mitad que importa: los `grant insert` de `reto` y `gate_instancia` son de TABLA, y
-- un grant de tabla cubre también las columnas añadidas después. Ninguna de las dos se
-- podía UPDATE-ar —ahí sí el grant es por columna— pero las dos se podían escribir en el
-- INSERT, o sea fabricar una fila nueva con el perdón puesto.
--
-- Se cierra donde estaba el agujero: la política de inserción exige que nazcan en false. El
-- conjunto perdonado vuelve a ser el que escribió la migración, y ahora de verdad solo
-- puede encoger. (La segunda razón del preámbulo sigue en pie por su cuenta: los estados
-- que estas marcas habilitan son inalcanzables para cualquier fila posterior.)
drop policy reto_insert on reto;
create policy reto_insert on reto
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'candidato'
    and medicion_sin_registry = false
  );
drop policy gate_insert on gate_instancia;
create policy gate_insert on gate_instancia
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and estado = 'pendiente'
    and aprobado_por is null
    and aprobado_en is null
    and aprobado_sin_registry = false
  );

-- ── «Qué proyectos del reto frenan la medición», en UN solo sitio ──
-- Este predicado se ha escrito ya tres veces en este slice —el guard que rechaza, el
-- diagnóstico del servicio y el espejo de la pantalla— y las tres veces se ha quedado un
-- estado corto: primero media condición, luego una fila en lugar del conjunto, luego un
-- estado de menos dentro del conjunto. No es descuido tres veces: es que mantener
-- sincronizadas a mano tres enumeraciones del mismo conjunto no se puede, y la siguiente
-- ronda encuentra la cuarta. Así que se escribe UNA vez y los tres la llaman.
--
-- Qué es «frenar»: un proyecto que, tras `abrirMedicion`, NO va a estar midiendo. La
-- operación mueve exactamente los que están en 'en-implementacion', así que:
--  · 'activo'                     — no lo mueve nadie: se quedaría sin abrir bajo un reto
--                                   que mide, que es el par roto. Le falta su G6.
--  · 'pausado' SIN su G7          — no puede seguir al reto después (retomar con el reto
--                                   midiendo exige entrar en medición, y eso exige su G7),
--                                   y atrapado él el outcome review no cierra el reto.
--  · 'en-implementacion' SIN G7   — su propio movimiento lo rechaza el guard de transición.
-- Y NO frenan: 'pausado' CON su G7 (puede volver cuando quiera), 'cerrado' y 'en-medicion'.
--
-- `solo_al_entrar` distingue las dos primeras —que solo estorban cuando el reto ENTRA en
-- medición— de la tercera, que impide el movimiento del propio proyecto siempre. Es lo que
-- deja al reto HEREDADO reparar su medición: allí el reto ya mide y sus proyectos están
-- detrás por definición, así que las razones «al entrar» no aplican.
--
-- No es SECURITY DEFINER: lee proyectos y gates del workspace del reto, que cualquier
-- miembro ya puede leer, así que corre bajo el RLS de quien llama y no puede volverse
-- oráculo. La ejecuta el rol de aplicación (el diagnóstico y la proyección la llaman).
create function proyectos_frenan_medicion(p_reto uuid, p_ws uuid)
returns table (codigo text, motivo text, solo_al_entrar boolean)
language sql stable as $$
  select p.codigo,
    case p.estado
      when 'activo' then 'no ha pasado por implementación: le falta aprobar su G6'
      when 'pausado' then 'pausado y sin su G7: no podría seguir al reto ni dejarlo cerrar'
      else 'sin su G7 aprobado' end,
    p.estado <> 'en-implementacion'
  from proyecto p
  where p.reto_id = p_reto and p.workspace_id = p_ws
    and (p.estado = 'activo'
         or (p.estado in ('pausado', 'en-implementacion')
             and not exists (select 1 from gate_instancia g
               where g.proyecto_id = p.id and g.workspace_id = p.workspace_id
                 and g.numero = 7 and g.estado = 'aprobado')))
  order by p.codigo
$$;
revoke execute on function proyectos_frenan_medicion(uuid, uuid) from public;
grant execute on function proyectos_frenan_medicion(uuid, uuid) to designio_app;

-- ── El par «reto midiendo ⇔ proyecto midiendo» es INDIVISIBLE, y lo dice la TABLA ──
-- §5.2 mueve los dos objetos a la vez —«el proyecto y el reto pasan a en medición»— y el
-- guard del proyecto ya exigía su mitad: no entra en medición si su reto no está midiendo.
-- La mitad simétrica faltaba, y con ella el par entero: `grant update (estado) on reto` es
-- una superficie abierta, así que con cualquier G7 aprobado un `update reto set estado =
-- 'en-medicion'` a secas pasaba el guard de transición —que solo miraba el registry y el
-- gate— y desde ese instante `snapshot_insert` («registry firmado + reto en medición»)
-- aceptaba datos con el proyecto todavía en implementación. El tablero mentía y la serie
-- se llenaba, y lo único que sostenía la promesa era que `abrirMedicion` hiciera los dos
-- movimientos juntos. Una promesa que solo cumple el servicio dura hasta el próximo
-- camino que escriba la tabla; la regla baja al dato, que es de donde no se sale.
--
-- DIFERIDO, y no es un detalle de estilo. Los dos movimientos son dos sentencias de la
-- misma transacción, y en ESE orden por obligación: el guard del proyecto exige que el
-- reto ya mida, así que el reto va primero. Una comprobación inmediata rechazaría al
-- propio `abrirMedicion` en su primera sentencia, antes de que el proyecto haya podido
-- moverse. Un `constraint trigger ... deferrable initially deferred` corre al COMMIT,
-- cuando el movimiento del proyecto ya está escrito y esta comprobación puede verlo.
--
-- Las DOS mitades del invariante, porque una sola no dice lo mismo: ningún proyecto del
-- reto se queda en 'activo' ni en 'en-implementacion' (si quedara, ese es exactamente el
-- tablero que miente), y al menos uno está midiendo (si no, el reto mide sin que nadie
-- mida: `abrirMedicion` ya lo rechaza contando los movidos, y por SQL directo también).
-- Un proyecto 'cerrado' puede quedarse atrás sin más: ya terminó. Uno 'pausado' también,
-- pero SOLO si todavía puede seguir al reto después — y esa condición es la tercera
-- comprobación, no una tolerancia. Parar es del cliente, sí; lo que no puede es dejar al
-- reto sin final.
--
-- Y este trigger corre en UN instante, el de la entrada: `when (new.estado = 'en-medicion'
-- and old.estado is distinct from 'en-medicion')` no vuelve a mirar nada después, así que
-- por sí solo no gobierna al proyecto pausado que se retoma MÁS TARDE. Esa mitad la
-- sostiene `proyecto_estado_transicion_guard`, que en ese caso obliga a la reanudación a
-- entrar directamente en medición. Las dos reglas son el mismo invariante mirado desde
-- cada lado del par, y ninguna se basta sola.
--
-- Sin SECURITY DEFINER, como su hermano el guard de transición: consulta los proyectos
-- del MISMO reto que el actor acaba de escribir, todos visibles para cualquier miembro
-- del workspace, así que no puede volverse oráculo de nada que no se pudiera leer ya.
create function reto_medicion_par_indivisible_guard() returns trigger
language plpgsql as $$
declare
  atrapados text;
begin
  -- El punto de cita de las DOS mitades del par, y la primera sentencia de las dos: ver
  -- `proyecto_par_medicion_guard` para el porqué. Es el MISMO candado que toma
  -- `abrirMedicion` al empezar, así que esa ruta lo tiene ya y no paga nada por pedirlo.
  perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || new.id, 42));
  if exists (select 1 from proyecto p
    where p.reto_id = new.id and p.workspace_id = new.workspace_id
      and p.estado in ('activo', 'en-implementacion')) then
    raise exception 'el reto no puede medir con su proyecto sin abrir: la medición mueve los dos a la vez (§5.2)';
  end if;
  if not exists (select 1 from proyecto p
    where p.reto_id = new.id and p.workspace_id = new.workspace_id
      and p.estado = 'en-medicion') then
    raise exception 'el reto no puede medir sin ningún proyecto en medición (§5.2)';
  end if;
  -- Y la tercera, que es la que cierra el triángulo. Dejar atrás a un proyecto pausado
  -- parecía inofensivo —«la operación no los toca a propósito»— pero solo lo es mientras
  -- ese proyecto PUEDA volver. Sin su G7 aprobado no puede, y no por una regla sino por
  -- tres que se cierran entre sí: retomarlo con el reto midiendo exige entrar directamente
  -- en medición (guard de transición), medir exige su G7 (§5.2), G7 exige G6 aprobado
  -- antes (orden de gates) y aprobar G6 con el proyecto parado se rechaza a propósito
  -- (§7). Ninguna de las tres sobra y ninguna tiene lado abierto.
  --
  -- Y lo caro no es el proyecto atrapado sino lo que arrastra: el guard del cierre del
  -- outcome review no cierra el reto mientras quede un proyecto sin cerrar, así que un
  -- pausado que ya no puede volver deja al RETO sin final. Lo mismo que este slice arregló
  -- para la pausa retomada tarde, un paso antes.
  --
  -- Por eso se rechaza AQUÍ, al abrir, y no se descubre después: mientras el reto sigue
  -- 'activo' la salida existe y es normal —retomar el proyecto, que vuelve a 'activo' o a
  -- implementación según su G6, y cerrar sus gates hasta G7—; en cuanto el reto se mueve,
  -- esa salida desaparece. Descubrirlo después es descubrirlo cuando ya no hay ninguna.
  --
  -- Y sale de `proyectos_frenan_medicion`, la MISMA fuente que usan el diagnóstico previo
  -- del servicio y el espejo de la pantalla: mientras hubo tres redacciones del mismo
  -- conjunto, cada ronda encontró un estado que a alguna le faltaba. Aquí, después del
  -- movimiento, lo que la función añade a las dos comprobaciones de arriba es justo el
  -- pausado sin G7 —los otros dos motivos ya los ha rechazado la primera—, pero se
  -- pregunta entero para que añadir un estado mañana no vuelva a olvidarse de este lado.
  select string_agg(f.codigo || ' (' || f.motivo || ')', ', ' order by f.codigo)
    into atrapados
  from proyectos_frenan_medicion(new.id, new.workspace_id) f;
  if atrapados is not null then
    raise exception 'estos proyectos no pueden seguir al reto a medición: retómalos y cierra sus gates antes de abrirla (§5.2): %', atrapados;
  end if;
  return null;
end $$;
create constraint trigger reto_medicion_par_indivisible
  after update of estado on reto
  deferrable initially deferred
  for each row when (new.estado = 'en-medicion' and old.estado is distinct from 'en-medicion')
  execute function reto_medicion_par_indivisible_guard();
revoke execute on function reto_medicion_par_indivisible_guard() from public;

-- ── …y el MISMO invariante desde el lado del proyecto, porque una política no cierra
-- una carrera ──
-- Las reglas que sostienen el par del lado del proyecto —`proyecto_insert` exigiendo un
-- reto 'activo', y el guard de transición negando que una pausa se retome por detrás— son
-- predicados sobre una INSTANTÁNEA. Ninguna impide que el reto cambie mientras deciden:
-- con `abrirMedicion` corriendo en otra sesión, el insert evalúa su `exists` contra el
-- 'activo' viejo, la comprobación diferida del reto corre sin poder ver una fila que aún no
-- existe, y los dos commitean dejando un proyecto 'activo' colgado de un reto que ya mide.
-- El par roto por la puerta de las filas que NACEN, y con él el cierre del outcome review
-- bloqueado. La transición tiene la misma grieta un paso más allá: lee el estado del reto
-- sin bloquearlo y commitea detrás de quien acaba de moverlo.
--
-- El candado inmediato (`select … for update` sobre el reto dentro de los guards del
-- proyecto) cerraba la carrera pero introducía un CICLO: un `BEFORE UPDATE` de fila no
-- puede adelantarse a su propio tuple lock —PostgreSQL bloquea la fila vieja para
-- construir el `old` antes de ejecutar el trigger—, así que ese camino toma
-- `proyecto → reto` mientras `abrirMedicion` toma `reto → proyecto`. Un interbloqueo se
-- detecta y aborta, no corrompe nada, pero cambia un rechazo explicado por un 40P01 y
-- rompe el orden único que este archivo mantiene en todas las demás rutas.
--
-- Se cierra donde no hay orden que romper: DIFERIDO, como su hermano de arriba y por la
-- misma mecánica —al COMMIT cada sentencia toma su propio snapshot, así que ve lo que
-- commiteó el otro—. Con eso quedan cubiertos los dos intercalados SECUENCIALES: si el
-- proyecto commitea primero, es la comprobación del RETO la que ve la fila nueva y rechaza
-- la apertura; si commitea segundo, es esta la que ve el reto midiendo y rechaza el
-- proyecto.
--
-- Pero «diferido» no es «excluyente», y ahí faltaba la mitad. Un constraint trigger
-- diferido corre EN la fase de commit, y su `select` se ejecuta antes de que el commit de
-- su propia transacción sea visible para nadie; entre las dos fases de commit no hay
-- exclusión ninguna. Si las dos llegan a la vez, cada guard mira y ve el estado VIEJO, las
-- dos pasan, y queda otra vez un proyecto sin abrir bajo un reto que mide. Lo comprobé en
-- laboratorio con dos transacciones soltadas a la vez: sin candado, seis de seis veces
-- ninguna de las dos vio a la otra.
--
-- Lo que lo cierra es un candado COMPARTIDO, y el sitio donde cabe sin recrear el ciclo es
-- el propio guard diferido: aquí no hay ningún tuple lock por delante al que adelantarse
-- —esto corre en fase de commit, fuera de toda sentencia—, así que no impone ningún orden
-- contra el `reto → proyecto` de `abrirMedicion`. Los dos guards piden el MISMO candado del
-- reto como primera sentencia: el que lo consigue comprueba y commitea, y el que espera
-- vuelve a mirar después —READ COMMITTED, snapshot nuevo por sentencia— y SÍ ve lo que el
-- otro dejó escrito. La carrera simultánea se convierte así en la secuencial, que es la que
-- ya estaba cubierta. Mismo laboratorio, con candado: seis de seis, el segundo vio al
-- primero.
--
-- Y no reintroduce ciclo, que es lo que hay que argumentar y no suponer. Piden el candado
-- exactamente las transacciones que dejan un proyecto ENTRANDO en 'activo' o
-- 'en-implementacion' (por eso el trigger de UPDATE exige además que el estado CAMBIE: una
-- reescritura del mismo valor no toca el par y no debe pedir nada). Del otro lado, la única
-- ruta que sostiene el candado mientras espera una fila de `proyecto` es `abrirMedicion`,
-- que lo toma al empezar y solo actualiza proyectos 'en-implementacion'; y desde
-- 'en-implementacion' los únicos destinos legales son 'pausado' y 'en-medicion', que no
-- disparan estos triggers. Así que nadie que tenga una fila que el otro quiera puede estar
-- esperando este candado.
--
-- Cubre INSERT y transición a la vez, que son las dos puertas por las que un proyecto llega
-- a 'activo' o 'en-implementacion'. El rechazo inmediato y explicado sigue siendo el de
-- siempre en el caso secuencial —la política para el insert, el guard de transición para la
-- pausa retomada—: esto es la red de la carrera, no el diagnóstico.
--
-- Con la excepción del reto heredado, igual que el guard de transición y con el MISMO
-- alcance: es el único que mide teniendo su proyecto detrás por definición, y ese «detrás»
-- es el estado que encontró la migración, no una avería. Y también aquí la exención dura lo
-- que dura su motivo — `proyecto_puede_seguir_al_reto` —, porque si no las dos mitades del
-- invariante dejarían de decir lo mismo: el guard de transición cerraría la puerta de la
-- reanudación mientras esta seguiría admitiendo la misma fila por la puerta del alta.
create function proyecto_par_medicion_guard() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('designio:reto:' || new.reto_id, 42));
  if exists (select 1 from reto r
    where r.id = new.reto_id and r.workspace_id = new.workspace_id
      and r.estado = 'en-medicion'
      and (not r.medicion_sin_registry
           or proyecto_puede_seguir_al_reto(new.id, new.reto_id, new.workspace_id))) then
    raise exception 'el reto ya está midiendo: su proyecto no puede quedarse sin abrir (§5.2)';
  end if;
  return null;
end $$;
-- Dos triggers y una sola función: el `when` del UPDATE exige además que el estado CAMBIE
-- —una reescritura del mismo valor no mueve el par y pedir el candado por ella es lo único
-- que podría cerrar un ciclo con `abrirMedicion`— y eso obliga a separarlos, porque en el
-- `when` de un INSERT no se puede nombrar `old`.
create constraint trigger proyecto_par_medicion_alta
  after insert on proyecto
  deferrable initially deferred
  for each row when (new.estado in ('activo', 'en-implementacion'))
  execute function proyecto_par_medicion_guard();
create constraint trigger proyecto_par_medicion_transicion
  after update of estado on proyecto
  deferrable initially deferred
  for each row when (new.estado in ('activo', 'en-implementacion')
                     and old.estado is distinct from new.estado)
  execute function proyecto_par_medicion_guard();
revoke execute on function proyecto_par_medicion_guard() from public;

-- ── «Qué le falta a este registry para poder firmarse», en UN solo sitio ──
-- La completitud del contrato la exige el guard de la firma, y por eso mismo la PANTALLA
-- tiene que poder preguntarla ANTES de ofrecer el botón. Un botón habilitado es una promesa
-- de que el envío tiene sentido, y el de firmar se ofrecía siempre: con un criterio sin KPI
-- que lo responda, con una entrada a medias o con fechas incoherentes, el sponsor pulsaba y
-- descubría por un error del servidor lo que la pantalla ya podía saber.
--
-- Es la misma avería que `reparosDelEsquema` arregló para los botones cuyo rechazo venía de
-- Zod, en la superficie que aquél no cubre: aquí quien rechaza es el GUARD. Las dos
-- superficies rechazan la escritura y el espejo tiene que cubrir las dos — es lo que llevó a
-- unir esquema y guard en `faltaParaCompletar` para el post mortem, y la firma se quedó sin
-- su equivalente.
--
-- Lo que NO se hace es copiar la lista al cliente: serían dos redacciones del mismo contrato
-- y la de la pantalla se quedaría corta a la primera que alguien tocara el guard, que es
-- exactamente cómo nacieron las tres redacciones de `proyectos_frenan_medicion` y las dos de
-- la cadencia. Se escribe UNA vez y la leen los dos: el guard —que raise con la primera, en
-- el mismo orden y con el mismo texto de siempre— y la proyección, que las enseña todas.
--
-- Cada reparo NOMBRA la fila que hay que arreglar (el criterio o la entrada), porque apagar
-- el botón sin decir qué falta cambia un error confuso por un callejón mudo.
--
-- El `orden` es el del guard y no es decorativo: es lo que hace que el mensaje que ve quien
-- fuerza la firma por SQL directo siga siendo el mismo de antes, test a test.
--
-- Sin SECURITY DEFINER: llamada desde el guard —que sí lo es— corre con sus privilegios, y
-- llamada desde la proyección corre bajo el RLS de quien mira, que ya puede leer estas filas.
create function reparos_de_firma(p_registry uuid, p_reto uuid, p_ws uuid)
returns table (orden integer, reparo text)
language sql stable as $$
  select 1, 'el registry no tiene entradas KPI (SYS-22)'
  where not exists (select 1 from entrada_kpi e
    where e.registry_id = p_registry and e.workspace_id = p_ws)
  union all
  -- Cada criterio de éxito del reto necesita al menos un KPI que lo responda: firmar con un
  -- criterio huérfano garantizaría un «no concluyente» por construcción.
  select 2, 'criterios sin entrada KPI (SYS-22): ' || l from (
    select string_agg(c.kpi, ', ' order by c.kpi) as l
    from criterio_exito c
    where c.reto_id = p_reto and c.workspace_id = p_ws
      and not exists (select 1 from entrada_kpi e
        where e.criterio_id = c.id and e.workspace_id = c.workspace_id
          and e.registry_id = p_registry)) x where l is not null
  union all
  -- Entrada completa = lo que RF-07.1 exige y la medición usa. btrim en los textos:
  -- whitespace no es contenido, tampoco por SQL directo.
  select 3, 'entradas incompletas (SYS-22): ' || l from (
    select string_agg(e.nombre, ', ' order by e.nombre) as l
    from entrada_kpi e
    where e.registry_id = p_registry and e.workspace_id = p_ws
      and (btrim(e.nombre) = '' or btrim(e.definicion) = '' or btrim(e.fuente) = ''
           or e.propietario_miembro_id is null or e.linea_base_valor is null
           or e.linea_base_fecha is null or e.ventana_inicio is null
           or e.fecha_post_mortem is null)) x where l is not null
  union all
  -- La otra mitad de la ventana, en su propio reparo: el hueco está en el CRITERIO, así que
  -- lo que se nombra es el criterio —la fila que hay que arreglar— y no el KPI que lo
  -- acompaña. Mira TODOS los criterios del reto: a estas alturas son el mismo conjunto que
  -- los que tienen entrada, y entre dos formas equivalentes se prefiere la que sigue siendo
  -- correcta si mañana se reordenan.
  select 4, 'criterios sin ventana declarada (SYS-22): ' || l from (
    select string_agg(c.kpi, ', ' order by c.kpi) as l
    from criterio_exito c
    where c.reto_id = p_reto and c.workspace_id = p_ws and c.ventana_dias is null) x
    where l is not null
  union all
  -- Y ese dueño es una persona del CLIENTE (RF-07.1, §8.1): el reparo anterior exige un id
  -- no nulo, que no dice de QUIÉN es. La entrada guarda una REFERENCIA al miembro, no una
  -- copia de su rol, y entre redactar el registry y firmarlo pasan semanas: lo que el
  -- contrato afirma es lo que sea cierto en el momento en que se congela, y es este.
  select 5, 'el propietario del dato tiene que ser una persona del cliente (RF-07.1): ' || l
  from (
    select string_agg(e.nombre, ', ' order by e.nombre) as l
    from entrada_kpi e
    join miembro m on m.id = e.propietario_miembro_id and m.workspace_id = e.workspace_id
    where e.registry_id = p_registry and e.workspace_id = p_ws
      and not es_rol_cliente(m.rol)) x where l is not null
  union all
  -- ── Completo no es lo mismo que COHERENTE ──
  -- Los reparos de arriba comprueban que los campos ESTÉN. Estos tres comprueban que digan
  -- algo posible entre sí: un contrato con todos los huecos rellenos puede seguir siendo
  -- imposible de cumplir, y firmarlo lo congela sin reparación.
  --
  -- ESCRITOS EN POSITIVO, y el `coalesce(…, false)` no es defensa de más: escritos como
  -- «rechaza si la incoherencia es cierta», un NULL en cualquiera de los dos lados vuelve el
  -- predicado NULL, la fila no agrega, la lista queda NULL y la regla NO SALTA — se evapora
  -- en silencio justo cuando falta un dato, que es cuando más falta hace. Así cada regla
  -- enuncia el hecho que TIENE que ser cierto: en ausencia de prueba, no se firma.
  select 6, 'la línea base es posterior al inicio de la ventana: ' || l from (
    select string_agg(e.nombre, ', ' order by e.nombre) as l
    from entrada_kpi e
    where e.registry_id = p_registry and e.workspace_id = p_ws
      and not coalesce(e.linea_base_fecha <= e.ventana_inicio, false)) x where l is not null
  union all
  -- La cadencia comprometida tiene que CABER en la ventana al menos una vez, y se pregunta
  -- con la MISMA función que después juzgará las entregas de verdad: «cabe al menos una vez»
  -- es «el calendario del compromiso tiene al menos una entrega dentro de la ventana».
  select 7, 'la cadencia comprometida no cabe en la ventana del criterio: ' || l from (
    select string_agg(e.nombre, ', ' order by e.nombre) as l
    from entrada_kpi e
    join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
    where e.registry_id = p_registry and e.workspace_id = p_ws
      and paso_de_cadencia(e.frecuencia) is not null
      and not exists (select 1 from vencimientos_de_cadencia(
        e.ventana_inicio, e.frecuencia, (e.ventana_inicio + c.ventana_dias)::date))) x
    where l is not null
  union all
  -- El post-mortem se prevé DESPUÉS del cierre de la ventana: fecharlo antes sería
  -- comprometerse a un veredicto sobre datos que aún no existen. «Después» es ESTRICTO, por
  -- la misma razón que el review no se abre el último día.
  select 8, 'el post-mortem se prevé después del cierre de la ventana: ' || l from (
    select string_agg(e.nombre, ', ' order by e.nombre) as l
    from entrada_kpi e
    join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
    where e.registry_id = p_registry and e.workspace_id = p_ws
      and not coalesce(e.fecha_post_mortem > e.ventana_inicio + c.ventana_dias, false)) x
    where l is not null
$$;
revoke execute on function reparos_de_firma(uuid, uuid, uuid) from public;
grant execute on function reparos_de_firma(uuid, uuid, uuid) to designio_app;

-- ── …y qué le falta por POSICIÓN EN EL MÉTODO, que es la otra superficie ──
-- Una firma se puede negar por dos sitios y son dos cosas distintas: el GUARD habla del
-- CONTENIDO del contrato (arriba) y la POLÍTICA `registry_firmar`, de dónde está el proyecto
-- en el método — se firma EN G6, así que con los gates anteriores pendientes la fila ni
-- siquiera llega al trigger. Van en funciones separadas a propósito: meter la regla de la
-- política dentro de `reparos_de_firma` pondría dos cosas distintas bajo un mismo nombre, y
-- la lista del guard dejaría de ser la lista del guard.
--
-- Pero para QUIEN MIRA LA PANTALLA la distinción no existe: pulsa y falla. Así que el botón
-- mira las dos, y las dos se escriben una sola vez. Esta la leen el diagnóstico posterior al
-- rechazo (`diagnosticoDeFirma`, que es quien componía estos mensajes a mano) y la
-- proyección, que los enseña ANTES de ofrecer el botón.
--
-- Y era el desenlace peor de los dos: un UPDATE que la política filtra afecta a cero filas y
-- no levanta ninguna excepción que traducir. Lo salva que `firmarRegistry` comprueba el
-- recuento y convierte el cero en este diagnóstico — sin esa comprobación, el acto más
-- solemne de la pantalla habría fallado en silencio.
--
-- El rol NO está aquí: es propiedad de quien mira y no del contrato, la pantalla ya lo
-- espeja con `puedeFirmar`, y una proyección compartida no puede afirmar «tú no puedes».
create function reparos_de_posicion_de_firma(p_registry uuid, p_reto uuid, p_ws uuid)
returns table (orden integer, reparo text)
language sql stable as $$
  select 1, 'El reto no tiene proyecto con método instanciado: no hay G6 que firmar'
  where not exists (select 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = p_reto and p.workspace_id = p_ws and g.numero = 6)
  union all
  -- Un G6 aprobado ANTES de que el Metric Registry existiera SÍ puede firmar (esa marca la
  -- puso la migración y nadie la vuelve a escribir), así que para él este reparo no aplica.
  select 2, 'El G6 ya fue aprobado: el registry debió firmarse antes'
  where exists (select 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = p_reto and p.workspace_id = p_ws and g.numero = 6
      and g.estado = 'aprobado' and not g.aprobado_sin_registry)
  union all
  -- «Se firma EN G6»: no antes. Los gates ordenan el método y el registry se acuerda con el
  -- plan de implementación delante, no en el kickoff. Es la misma condición que la política
  -- `registry_firmar` aplica al filtrar la fila; aquí se NOMBRA para poder decirla.
  select 3, 'El registry se firma EN G6: faltan los gates anteriores (' || l || ')' from (
    select string_agg('G' || g.numero, ', ' order by g.numero) as l
    from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = p_reto and p.workspace_id = p_ws
      and g.numero < 6 and g.estado <> 'aprobado') x where l is not null
$$;
revoke execute on function reparos_de_posicion_de_firma(uuid, uuid, uuid) from public;
grant execute on function reparos_de_posicion_de_firma(uuid, uuid, uuid) to designio_app;

-- ── Guard de la firma del registry (SYS-22) ──
-- La completitud del contrato vive en el DATO: ni el propio sponsor firma por SQL
-- directo un registry sin dueño del dato, sin línea base o con criterios sin KPI.
create function registry_firmar_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  faltan text;
begin
  -- Pre-chequeo anti-oráculo: la consulta privilegiada solo corre para miembros del
  -- workspace declarado; a los demás los rechaza la política, como siempre.
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado = 'firmado' and old.estado = 'borrador' then
    -- El sello temporal lo pone la BASE: un update directo no retro ni post-data la firma.
    new.firmado_en := now();
    -- El punto de cita del slice, y ANTES de comprobar nada: lo que esta firma va a
    -- validar —las entradas y los criterios— lo escriben rutas que bloquean esta misma
    -- fila. Comprobar primero y bloquear después sería validar un contrato y congelar
    -- otro. Va antes que el bloqueo del G0 para respetar el orden reto → gate.
    perform 1 from reto where id = new.reto_id and workspace_id = new.workspace_id
      for update;
    -- Punto de cita con `criterio_g0_pendiente_guard`: LAS MISMAS filas (los G0 del reto),
    -- en el mismo orden. Firmar congela los criterios, pero firmar y editar un criterio
    -- tocan tablas distintas, así que sin este bloqueo la firma valida el criterio VIEJO,
    -- commitea, y la edición que ya estaba en vuelo commitea después su `objetivo` o su
    -- `ventana_dias` nuevos: el contrato firmado cambia justo después de firmarse, que es
    -- lo único que la firma existe para impedir. Con el bloqueo, quien llegue segundo lee
    -- lo que el primero dejó — la firma valida el criterio nuevo, o la edición se
    -- encuentra el registry ya firmado y su propio guard la rechaza.
    --
    -- Se bloquea el GATE y no las filas de `criterio_exito` a propósito: un criterio NUEVO
    -- no existe todavía como fila que bloquear, y su INSERT pasa por el mismo guard y por
    -- el mismo gate. Bloquear los criterios existentes dejaría colarse justo ese caso —un
    -- criterio huérfano de KPI dentro de un contrato ya firmado—.
    --
    -- El candado del servicio (`designio:reto:`) hace lo mismo un nivel más arriba; este
    -- vale además para el SQL directo, que es donde el servicio no llega.
    perform 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id and g.numero = 0
      order by g.id for update of g;
    -- La completitud y la coherencia del contrato viven en `reparos_de_firma`, no aquí:
    -- son las mismas ocho reglas que la PANTALLA necesita para no ofrecer un botón que la
    -- base va a rechazar. Escritas dos veces —una aquí y otra en el cliente— la del cliente
    -- se queda corta a la primera que alguien toque esta lista, que es exactamente cómo
    -- nacieron las tres redacciones de `proyectos_frenan_medicion`.
    --
    -- Se raise con la PRIMERA por orden, que es el mismo orden y el mismo texto que cuando
    -- las ocho comprobaciones estaban escritas aquí en fila: quien fuerza la firma por SQL
    -- directo lee lo mismo que leía antes.
    select r.reparo into faltan
    from reparos_de_firma(new.id, new.reto_id, new.workspace_id) r
    order by r.orden limit 1;
    if faltan is not null then
      raise exception 'no se puede firmar: %', faltan;
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'MetricRegistryFirmado',
        -- Las dos columnas del grant (`estado`, `firmado_por`) y el sello que pone este
        -- guard. Que la política ate `firmado_por` a `app_user_id()` —y por tanto al
        -- `actor_id` del propio evento— hace la clave redundante SOLO mientras la política
        -- se evalúe: una escritura que no pase por RLS la deja libre. El rastro dice lo que
        -- quedó escrito en la fila, no lo que una regla de otra capa promete que dice.
        jsonb_build_object('registryId', new.id, 'retoId', new.reto_id,
          'estado', new.estado, 'firmadoPor', new.firmado_por,
          'firmadoEn', new.firmado_en,
          'entradas', (select count(*) from entrada_kpi e
            where e.registry_id = new.id and e.workspace_id = new.workspace_id)),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger registry_firmar_trg
  before update on metric_registry
  for each row execute function registry_firmar_guard();
revoke execute on function registry_firmar_guard() from public;

-- ── El CONTENIDO del post mortem, escrito una sola vez ──
-- Dos rutas escriben este contenido —la edición del borrador y la completación— y las dos
-- lo tienen que decir con las MISMAS claves: si no, el «antes» que deja una no se puede
-- comparar con el «después» que deja la otra y el rastro queda partido en dos vocabularios.
-- Sobre jsonb y no sobre la fila porque un lado trabaja con `old`/`new` de una tabla
-- concreta y el otro es un guard compartido entre tablas de columnas distintas.
--
-- Devuelve el objeto PLANO a propósito: se funde en la raíz del payload para el «después»
-- y se anida bajo `antes` para el estado previo, que es la misma forma que ya tienen
-- `EntradaKpiEditada` y `ResultadoCriterioEditado`.
--
-- Sin `execute` para nadie: solo lo llaman guards SECURITY DEFINER, que corren como el
-- dueño; el rol de aplicación no necesita —ni debe— poder invocarlo.
create function outcome_review_narrativa(fila jsonb) returns jsonb
language sql immutable parallel safe as $$
  select jsonb_build_object(
    'estado', fila->'estado',
    'veredicto', fila->'veredicto',
    'contribucion', fila->'contribucion',
    'factoresExternos', fila->'factores_externos',
    'hipotesisAbiertas', fila->'hipotesis_abiertas',
    'aprendizajes', fila->'aprendizajes',
    'disenoExperimentalSuficiente', fila->'diseno_experimental_suficiente',
    'disenoExperimentalJustificacion', fila->'diseno_experimental_justificacion',
    -- La FIRMA del post mortem. `completado_en` lo pisa el guard con `now()` al completar,
    -- pero las dos columnas están en el grant y el WITH CHECK solo las ata en la rama de
    -- la completación: en un borrador se pueden escribir sueltas, así que sin ellas aquí
    -- una firma puesta a mano sobre un borrador no dejaría rastro.
    'completadoPor', fila->'completado_por',
    'completadoEn', fila->'completado_en')
$$;
revoke execute on function outcome_review_narrativa(jsonb) from public;

-- ── El CONTENIDO de una entrada del registry, por el mismo motivo ──
-- Y aquí la regla que lo gobierna, que es la que faltaba: **toda columna con `grant
-- update` aparece en el payload, en el valor nuevo y en el `antes`**. El payload llevaba
-- ocho de las doce columnas editables de `entrada_kpi`; las cuatro que faltaban
-- —`definicion`, `fuente`, `dimensiones`, `dashboard_url`— son texto libre que la edición
-- PISA, así que corregir solo una de ellas emitía un evento cuyo antes y después eran
-- idénticos: el rastro decía que alguien tocó el contrato en el instante T y era incapaz
-- de decir qué, y el texto anterior no se podía recuperar de ninguna parte porque la fila
-- ya no lo tiene. Elegir a mano qué columnas «importan» es exactamente el criterio que
-- deja huecos; la lista del grant es la única que no se olvida de nada.
create function entrada_kpi_contenido(fila jsonb) returns jsonb
language sql immutable parallel safe as $$
  select jsonb_build_object(
    'criterioId', fila->'criterio_id',
    'nombre', fila->'nombre',
    'definicion', fila->'definicion',
    'fuente', fila->'fuente',
    'dimensiones', fila->'dimensiones',
    'propietarioMiembroId', fila->'propietario_miembro_id',
    'frecuencia', fila->'frecuencia',
    'dashboardUrl', fila->'dashboard_url',
    'lineaBaseValor', fila->'linea_base_valor',
    'lineaBaseFecha', fila->'linea_base_fecha',
    'ventanaInicio', fila->'ventana_inicio',
    'fechaPostMortem', fila->'fecha_post_mortem')
$$;
revoke execute on function entrada_kpi_contenido(jsonb) from public;

-- ── Guard del cierre del outcome review (RF-07.8/07.10, SYS-24) ──
-- Completar el review es la transición que CIERRA el loop, y sus efectos son
-- inseparables de ella: reto cerrado con veredicto y proyecto cerrado inmutable.
create function outcome_review_completar_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  faltan text;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado = 'completado' and old.estado = 'borrador' then
    new.completado_en := now();
    -- El punto de cita, y lo PRIMERO de todo: este guard decide sobre snapshots y
    -- resultados que otras rutas escriben bloqueando esta misma fila. Si se tomara al
    -- final —al cerrar el reto— las comprobaciones de abajo ya habrían corrido contra un
    -- snapshot viejo y el veredicto se dictaría sobre datos que cambiaron mientras tanto.
    perform 1 from reto where id = new.reto_id and workspace_id = new.workspace_id
      for update;
    -- RF-07.7 de nuevo aquí (la política ya lo exigió al abrir el review): entre la
    -- apertura y el cierre nadie amplió una ventana, pero el dato manda, no el orden.
    if exists (select 1 from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
      join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
      where r.reto_id = new.reto_id and r.workspace_id = new.workspace_id
        and ventana_de_medicion_abierta(e.ventana_inicio, c.ventana_dias)) then
      raise exception 'el outcome review se habilita al cerrar la ventana del último criterio (RF-07.7)';
    end if;
    -- Resultado por criterio, sin elegir cuáles contar (RF-07.8).
    select string_agg(c.kpi, ', ' order by c.kpi) into faltan
    from criterio_exito c
    where c.reto_id = new.reto_id and c.workspace_id = new.workspace_id
      and not exists (select 1 from resultado_criterio rc
        where rc.review_id = new.id and rc.workspace_id = new.workspace_id
          and rc.criterio_id = c.id);
    if faltan is not null then
      raise exception 'el outcome review exige resultado por criterio: faltan %', faltan;
    end if;
    -- «Logrado» con un criterio sin dato final es exactamente la presión por demostrar
    -- éxito que la spec nombra como riesgo: con datos faltantes el veredicto honesto
    -- existe y se llama «no concluyente» (o parcialmente logrado).
    if new.veredicto = 'logrado' and exists (select 1 from resultado_criterio rc
      where rc.review_id = new.id and rc.workspace_id = new.workspace_id
        and rc.snapshot_final_id is null) then
      raise exception 'veredicto «logrado» con criterios sin dato final: usa parcialmente logrado o no concluyente (SYS-24)';
    end if;
    -- El reto cierra con SU veredicto (el guard de transición vuelve a exigirlo y deja su
    -- propio rastro). Esta es la ÚNICA escritura de reto.veredicto del sistema, y va
    -- PRIMERO a propósito: el guard del proyecto exige ese veredicto para dejarlo cerrar,
    -- que es lo que ata el cierre del proyecto a esta completación y a ninguna otra mano.
    -- Tienen que ser dos sentencias, no una CTE: las sub-sentencias de un WITH comparten
    -- snapshot y el guard del proyecto no vería el veredicto recién escrito.
    update reto set estado = 'cerrado', veredicto = new.veredicto
      where id = new.reto_id and workspace_id = new.workspace_id;
    -- El proyecto cierra CON el reto (RF-07.10) y queda inmutable. Se exige que esté en
    -- medición: si alguien lo pausó, el cierre no lo arrastra en silencio.
    update proyecto set estado = 'cerrado'
      where reto_id = new.reto_id and workspace_id = new.workspace_id
        and estado = 'en-medicion';
    if exists (select 1 from proyecto p
      where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id
        and p.estado <> 'cerrado') then
      raise exception 'el proyecto del reto no está en medición: no puede cerrarse con el outcome review';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'OutcomeReviewCompletado',
        -- El veredicto NO es todo lo que esta escritura congela: la misma sentencia fija
        -- la contribución, los factores externos, las hipótesis y los aprendizajes. Sin
        -- ellos aquí, el rastro decía QUÉ se dictaminó y perdía el RAZONAMIENTO con el
        -- que se dictaminó — que es la mitad que un post mortem existe para dejar. Y con
        -- el `antes`, porque completar también REESCRIBE lo que hubiera en el borrador.
        jsonb_build_object('reviewId', new.id, 'retoId', new.reto_id)
          || outcome_review_narrativa(to_jsonb(new))
          || jsonb_build_object('antes', outcome_review_narrativa(to_jsonb(old))),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger outcome_review_completar_trg
  before update on outcome_review
  for each row execute function outcome_review_completar_guard();
revoke execute on function outcome_review_completar_guard() from public;

-- ── G6 no se aprueba sin registry firmado (SYS-22) ──
-- Se reemplaza el guard de suficiencia sumando la regla, sin perder ninguna anterior
-- (checklist sin pendientes y no vacío, orden de gates, criterios de G0, arquetipos G2).
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
    new.aprobado_en := now();
    if exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'pendiente') then
      raise exception 'no se puede aprobar: checklist con pendientes';
    end if;
    if not exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id) then
      raise exception 'no se puede aprobar: el gate no tiene checklist instanciado';
    end if;
    -- Se conserva de la migración anterior: un ítem YA cumplido cuya decisión pasó a
    -- 'en-revision' por una reapertura no cuenta como suficiencia (RF-04.9). Este
    -- `create or replace` reescribe la función entera, así que omitirlo la desharía.
    if exists (select 1 from checklist_item ci
      join decision d on d.id = ci.decision_id and d.workspace_id = ci.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and d.estado <> 'vigente') then
      raise exception 'no se puede aprobar: hay ítems cumplidos con decisiones en revisión';
    end if;
    if exists (select 1 from gate_instancia g2
      where g2.proyecto_id = new.proyecto_id and g2.workspace_id = new.workspace_id
        and g2.numero < new.numero and g2.estado <> 'aprobado') then
      raise exception 'no se puede aprobar G%: los gates anteriores deben aprobarse primero', new.numero;
    end if;
    if new.numero = 0 then
      if not exists (select 1 from criterio_exito c
        join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        where c.reto_id = p.reto_id and c.workspace_id = new.workspace_id) then
        raise exception 'no se puede aprobar G0: sin criterios de éxito (SYS-22)';
      end if;
      if exists (select 1 from criterio_exito c
        join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        where c.reto_id = p.reto_id and c.workspace_id = new.workspace_id
          and (c.ventana_dias is null
               or btrim(c.kpi) = '' or btrim(c.definicion) = '' or btrim(c.objetivo) = ''
               or ((nullif(btrim(c.linea_base_valor), '') is null or c.linea_base_fecha is null)
                   and btrim(c.linea_base_plan) = ''))) then
        raise exception 'no se puede aprobar G0: criterios incompletos (SYS-22)';
      end if;
    end if;
    if new.numero = 2 and exists (select 1 from arquetipo a
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where a.reto_id = p.reto_id and a.workspace_id = new.workspace_id
        and a.estado = 'hipotesis') then
      raise exception 'no se puede aprobar G2: hay arquetipos sin confirmar ni refutar (RF-04.11)';
    end if;
    -- G6 es donde el Metric Registry se acuerda y se FIRMA (SYS-22): aprobar el plan de
    -- implementación sin contrato de medición firmado deja el loop abierto por diseño.
    if new.numero = 6 and not exists (select 1 from metric_registry r
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where r.reto_id = p.reto_id and r.workspace_id = new.workspace_id
        and r.estado = 'firmado') then
      raise exception 'no se puede aprobar G6: el Metric Registry no está firmado (SYS-22)';
    end if;
    -- (El efecto de G6 sobre el proyecto NO va aquí: vive en su propio trigger AFTER, más
    -- abajo, porque su precondición lee la fila del gate que este guard aún no ha escrito.)
    update etapa_instancia set estado = 'completada'
      where proyecto_id = new.proyecto_id and workspace_id = new.workspace_id
        and numero = new.numero;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'GateAprobado',
        -- `aprobado_en` está en el grant y el WITH CHECK solo le exige NO SER NULO: la
        -- fecha de aprobación la propone la aplicación y nada la ata al instante real,
        -- así que es la clase de dato que el rastro tiene que conservar tal cual quedó.
        jsonb_build_object('gateId', new.id, 'proyectoId', new.proyecto_id,
                           'numero', new.numero, 'estado', new.estado,
                           'aprobadoPor', new.aprobado_por, 'aprobadoEn', new.aprobado_en),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ── Aprobar G6 mete el proyecto en implementación ──
-- El efecto que resucita el estado del medio de §7. Va en un trigger AFTER y no dentro de
-- `gate_aprobar_suficiencia_guard` por una razón mecánica que conviene dejar escrita: ese
-- guard es BEFORE, su fila del gate todavía no está escrita, y la precondición del par
-- `→ en-implementacion` es precisamente «G6 aprobado» — leída desde el guard del proyecto,
-- que no vería la aprobación en curso y rechazaría su propio efecto. AFTER es el único
-- momento en que la causa ya es un hecho consultable.
--
-- De regalo, deja de ser rehén del guard compartido: quien reemplace
-- `gate_aprobar_suficiencia_guard` ya no puede llevárselo por delante sin darse cuenta.
--
-- SECURITY DEFINER porque quien aprueba G6 es el SPONSOR, y la política del proyecto solo
-- deja escribir al lead: el efecto es de la BASE, no del rol que dispara el gate.
--
-- Y con el proyecto PAUSADO se rechaza la aprobación entera, que es la tercera cosa que
-- este bloque decide. Aprobar el gate que autoriza implementar mientras el proyecto está
-- parado es una contradicción antes que un problema de mecánica, y es además lo que este
-- mismo slice ya hace en el otro extremo del método, donde el cierre del post mortem se
-- niega a arrastrar un proyecto que alguien pausó.
--
-- CÓMO se rechaza es lo que importa, y la primera versión lo tenía al revés. Leía el estado
-- con un `if not exists (… p.estado = 'activo')` y actualizaba después SIN predicado de
-- estado en el `where`: decidir sobre una instantánea y ejecutar sobre un candado. Con dos
-- sesiones, quien pausa el proyecto y retiene la fila hace que esta lectura vea el estado
-- viejo y no levante; el `update` espera, y al soltarse re-lee bajo READ COMMITTED y casa
-- igual porque no pedía ningún estado. Resultado: `pausado → en-implementacion`, un par que
-- además es legal y cuya única precondición —G6 aprobado— la cumple la propia sentencia en
-- vuelo. La pausa se borraba sin que nadie la deshiciera.
--
-- El descarte que había escrito aquí —«un `where estado = 'activo'` dejaría la aprobación
-- pasar afectando cero filas»— era cierto de esa forma A SECAS, y por eso la conclusión
-- estaba mal: la forma correcta es la que este slice ya usa en `abrirMedicion` y en el
-- guard del cierre, `where` con el estado MÁS post-chequeo de lo afectado. El `where` hace
-- que el UPDATE reevalúe el predicado DESPUÉS del candado —que es lo único que ve la pausa
-- ajena— y el post-chequeo convierte el cero en el rechazo de la aprobación entera. Se
-- comprueba una sola vez, donde se escribe, en lugar de comprobar en un sitio y escribir en
-- otro.
create function proyecto_a_implementacion_tras_g6_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.numero = 6 and new.estado = 'aprobado' and old.estado = 'pendiente' then
    update proyecto set estado = 'en-implementacion'
      where id = new.proyecto_id and workspace_id = new.workspace_id
        and estado = 'activo';
    if not found then
      raise exception 'no se puede aprobar G6 con el proyecto parado: retómalo antes, porque aprobar el plan lo pone en implementación (§7)';
    end if;
  end if;
  return new;
end $$;
create trigger proyecto_a_implementacion_tras_g6
  after update on gate_instancia
  for each row execute function proyecto_a_implementacion_tras_g6_guard();
revoke execute on function proyecto_a_implementacion_tras_g6_guard() from public;

-- ── Dos puertas que la firma del registry y el cierre del proyecto tienen que cerrar ──
-- Ambas nacen de la convivencia entre la reapertura de etapa (SPEC-04.9) y lo que este
-- slice añade: un contrato de medición firmado y un proyecto que se cierra.

-- 1) Un proyecto CERRADO no se reabre. `reapertura_insert` solo miraba el rol, así que
-- un lead podía devolver a 'en-curso' una etapa de un proyecto ya cerrado con veredicto
-- y marcar en revisión decisiones que son historia (SYS-08: cerrado es inmutable, el
-- trabajo posterior es un reto nuevo).
drop policy reapertura_insert on reapertura_etapa;
create policy reapertura_insert on reapertura_etapa
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and reabierto_por = app_user_id()
    and exists (select 1 from proyecto p
      where p.id = reapertura_etapa.proyecto_id
        and p.workspace_id = reapertura_etapa.workspace_id
        and p.estado <> 'cerrado')
  );

-- …pero una política es un predicado sobre un SNAPSHOT, no un candado, y aquí eso no es
-- teórico: la reapertura y la completación del outcome review tocan filas distintas
-- (`etapa_instancia`/`decision` contra `outcome_review`/`reto`/`proyecto`), así que nada
-- las obliga a verse. La completación cierra el proyecto y commitea; la reapertura, que
-- evaluó su predicado contra el snapshot anterior, commitea después una etapa `en-curso`
-- y decisiones `en-revision` sobre un proyecto ya cerrado e inmutable (SYS-08) — el estado
-- que la política de arriba existe para impedir, alcanzado por el camino de al lado.
--
-- El bloqueo va sobre la FILA del proyecto, que es lo que las dos operaciones se disputan
-- y lo que la completación actualiza. Quien llegue segundo espera y vuelve a leer: si el
-- proyecto ya cerró, este guard lo dice —y lo dice también para el SQL directo, que es
-- donde el candado consultivo del servicio no llega—.
create function reapertura_proyecto_abierto_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actual text;
begin
  -- Pre-chequeo anti-oráculo: la consulta privilegiada solo corre para miembros del
  -- workspace declarado; a los demás los rechaza la política, como siempre.
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  select p.estado into actual from proyecto p
    where p.id = new.proyecto_id and p.workspace_id = new.workspace_id
    for update;
  if actual = 'cerrado' then
    raise exception 'el proyecto está cerrado: reabrir una etapa no revive lo que ya es historia (SYS-08)';
  end if;
  return new;
end $$;
create trigger reapertura_proyecto_abierto
  before insert on reapertura_etapa
  for each row execute function reapertura_proyecto_abierto_guard();
revoke execute on function reapertura_proyecto_abierto_guard() from public;

-- 2) Con el registry FIRMADO, los criterios quedan congelados aunque se reabra la etapa 0.
-- La excepción de la reapertura existe para corregir el compromiso ANTES de acordar cómo
-- se mide; una vez firmado, `objetivo` y `ventana_dias` son el contrato que el post
-- mortem va a leer, y el registry no copia la ventana a propósito. Moverlos después de
-- firmar cambiaría la promesa sin que nadie lo viera. Si hay que cambiarlos, el camino
-- es un reto nuevo, no una reapertura.
drop policy criterio_insert on criterio_exito;
drop policy criterio_update on criterio_exito;

create policy criterio_insert on criterio_exito
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and not exists (select 1 from metric_registry r
      where r.reto_id = criterio_exito.reto_id and r.workspace_id = criterio_exito.workspace_id
        and r.estado = 'firmado')
    and not exists (select 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
        and e.numero = 0
      where p.reto_id = criterio_exito.reto_id
        and p.workspace_id = criterio_exito.workspace_id
        and g.numero = 0 and g.estado = 'aprobado'
        and e.estado <> 'en-curso')
  );
create policy criterio_update on criterio_exito
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and not exists (select 1 from metric_registry r
      where r.reto_id = criterio_exito.reto_id and r.workspace_id = criterio_exito.workspace_id
        and r.estado = 'firmado')
    and not exists (select 1 from gate_instancia g
      join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
      join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
        and e.numero = 0
      where p.reto_id = criterio_exito.reto_id
        and p.workspace_id = criterio_exito.workspace_id
        and g.numero = 0 and g.estado = 'aprobado'
        and e.estado <> 'en-curso')
  )
  with check (workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador'));

-- El CONTENIDO del criterio, con la misma regla que las otras dos tablas: entra la lista
-- del `grant update`, no una selección a mano de lo que parece importante.
create function criterio_exito_contenido(fila jsonb) returns jsonb
language sql immutable parallel safe as $$
  select jsonb_build_object(
    'kpi', fila->'kpi',
    'definicion', fila->'definicion',
    'objetivo', fila->'objetivo',
    'ventanaDias', fila->'ventana_dias',
    'lineaBaseValor', fila->'linea_base_valor',
    'lineaBaseFecha', fila->'linea_base_fecha',
    'lineaBasePlan', fila->'linea_base_plan',
    'fechaPostMortem', fila->'fecha_post_mortem')
$$;
revoke execute on function criterio_exito_contenido(jsonb) from public;

-- El guard tiene la misma ceguera y hay que reponerle la condición nueva: habla ANTES
-- que el WITH CHECK, así que sin esto el mensaje sería el de siempre y la firma no
-- aparecería como motivo.
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
  if exists (select 1 from metric_registry r
    where r.reto_id = new.reto_id and r.workspace_id = new.workspace_id
      and r.estado = 'firmado') then
    raise exception 'el registry del reto está firmado: los criterios de medición son el contrato acordado (SYS-22)';
  end if;
  if exists (select 1 from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    join etapa_instancia e on e.proyecto_id = p.id and e.workspace_id = p.workspace_id
      and e.numero = 0
    where p.reto_id = new.reto_id and p.workspace_id = new.workspace_id
      and g.numero = 0 and g.estado = 'aprobado'
      and e.estado <> 'en-curso') then
    raise exception 'el G0 del reto está aprobado: criterios congelados';
  end if;
  -- El criterio se edita ENTERO mientras el G0 sigue pendiente y el registry sin firmar, y
  -- el evento llevaba solo el `kpi` de sus OCHO columnas editables. Dos de las que faltaban
  -- son las que gobiernan toda la medición de este slice: `objetivo` es la promesa contra
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

-- ══ AUDITORÍA: toda mutación de la medición deja rastro, y lo deja la BASE ═════════════
-- Doctrina del repositorio y del grafo del journey (`journey_grafo_auditoria`): el evento
-- lo emite un trigger, no el servicio, para que el SQL directo también lo produzca. Este
-- slice había emitido tres desde el servicio —con la excusa de que la CTE comparte snapshot
-- con la escritura— y eso los deja fuera de cualquier ruta futura y de cualquier `update`
-- a mano. Aquí se completa el inventario y se mudan.
--
-- INVENTARIO de escrituras del slice y su rastro. La columna «dónde» es la parte que
-- importa: un evento en el servicio es una promesa, uno en el trigger es una propiedad.
--
--   TABLA · ESCRITURA        EVENTO                        DÓNDE SE EMITE
--   metric_registry INSERT      · MetricRegistryAbierto        · trigger (era servicio)
--   metric_registry UPDATE      · MetricRegistryFirmado        · guard de la firma (la
--       única actualización legal: el grant es `estado`/`firmado_por` y la política solo
--       admite borrador→firmado, así que no hay UPDATE sin evento que auditar)
--   entrada_kpi     INSERT      · EntradaKpiAgregada           · trigger (no existía)
--   entrada_kpi     UPDATE      · EntradaKpiEditada + `antes`  · trigger (no existía)
--   snapshot        INSERT      · SnapshotRegistrado           · trigger (era servicio)
--   outcome_review  INSERT      · OutcomeReviewAbierto         · trigger (no existía)
--   outcome_review  UPDATE en sitio · OutcomeReviewEditado + `antes` · trigger (no existía)
--   outcome_review  UPDATE transición · OutcomeReviewCompletado + narrativa y `antes`
--       · guard del cierre (el trigger de arriba se aparta en esa escritura para no
--       emitir dos eventos por una sola)
--   resultado_criterio INSERT   · ResultadoCriterioRegistrado  · trigger (no existía)
--   resultado_criterio UPDATE   · ResultadoCriterioEditado + `antes` · trigger (no existía;
--       el upsert por criterio entra por aquí, que es como Postgres resuelve el
--       `on conflict do update`: la corrección del borrador es un UPDATE y se audita)
--   criterio_exito  INSERT/UPDATE · CriterioDefinido/Editado   · guard del G0 (este slice
--       le añade la política de escritura y la congelación por registry firmado; el
--       evento ya lo emitía y sigue donde estaba)
--   reto UPDATE estado/veredicto· RetoTransicionado            · guard de transición
--   proyecto UPDATE estado      · ProyectoTransicionado        · guard de transición, y
--       eso incluye los dos movimientos que dispara otro trigger —a implementación tras
--       G6 y a cerrado tras el post-mortem—: el guard es `before update of estado` y no
--       distingue quién escribe, así que el efecto encadenado también deja su rastro
--   gate_instancia UPDATE       · GateAprobado                 · guard de suficiencia
--
-- FUERA del rastro, que es la otra mitad del inventario y la que hay que justificar:
--  · `etapa_instancia set estado = 'completada'` al aprobarse un gate. Es el único efecto
--    encadenado del slice SIN evento propio, y a propósito: no tiene guard de transición
--    donde emitirlo y no añadiría nada a `GateAprobado` —mismo actor, mismo instante,
--    misma etapa deducible del número del gate—. Es un espejo del gate, no una decisión.
--  · Las dos columnas de perdón histórico las escribe la MIGRACIÓN, sin actor: un evento
--    con `actor_id` nulo afirmaría que alguien lo hizo.
--  · `reapertura_etapa` no es escritura de este slice —solo le añade la puerta «proyecto
--    no cerrado»—; su `EtapaReabierta` vive en el servicio de gobernanza, que es de quien
--    es la tabla. Mudarlo desde aquí sería reescribir el rastro de otro slice de paso.
--  · `SnapshotsCargados` (la tanda de CSV) SIGUE en el servicio, y es la única excepción
--    honesta: cuenta las filas RECHAZADAS, que no llegan a ser filas de ninguna tabla, así
--    que ningún trigger puede verlas. Convive con el `SnapshotRegistrado` por fila: son dos
--    hechos distintos —«alguien pegó una tanda con N buenas y M malas» y «esta medición
--    concreta entró»— y solo el segundo es reconstruible desde los datos.
-- DOS FORMAS DE UPDATE, y el inventario tiene que contemplar las dos. Una fila que solo
-- describe la TRANSICIÓN (pendiente→aprobado, borrador→firmado) se olvida de la EDICIÓN
-- DENTRO del mismo estado, que es otra escritura legal y otro rastro. El `outcome_review`
-- era el caso: su política admite explícitamente dejar `estado = 'borrador'`. Barrido del
-- resto de tablas del inventario, para que la pregunta quede cerrada y no haya que
-- rehacerla:
--  · `metric_registry`: no hay edición en sitio POSIBLE. El grant es `(estado,
--    firmado_por)` —ninguna columna de contenido— y `registry_firmar` exige `estado =
--    'borrador'` en el USING y `'firmado'` en el WITH CHECK: el par hace que todo UPDATE
--    legal SEA la transición. El contenido del contrato vive en `entrada_kpi`, no aquí.
--  · `entrada_kpi` y `resultado_criterio`: ya cubiertos, y precisamente por lo contrario
--    —no tienen transición, solo edición en sitio—. Sus triggers son `insert or update` y
--    su evento lleva `antes` desde el barrido anterior.
--  · `gate_instancia`: transición pura por política (`pendiente` en el USING, `aprobado`
--    en el WITH CHECK), igual que el registry.
--  · `reto` y `proyecto`: el único grant de escritura es `(estado)`, así que la única
--    escritura del rol de aplicación es la transición y su guard la audita. `veredicto`
--    no tiene grant: lo escribe el guard del cierre y nadie más.
--  · `snapshot`: append-only sin política ni grant de UPDATE (SYS-23) — no hay edición
--    que auditar, ni en sitio ni de ninguna otra forma.
--
-- Y EL SEGUNDO EJE, que es el que el primero no ve. El de arriba recorre QUÉ TABLAS
-- auditan la edición; dentro de cada una queda la pregunta de QUÉ COLUMNAS entran en el
-- payload. «Cubierta» a nivel de tabla y falsa a nivel de columna es exactamente lo que
-- pasaba con `entrada_kpi`: auditaba sus ediciones desde el barrido anterior y el evento
-- llevaba 8 de sus 12 columnas editables, así que corregir solo la definición, la fuente,
-- los cortes o el dashboard emitía un evento con el antes y el después IDÉNTICOS. La fila
-- se pisa: si el texto anterior no está en el evento, no está en ninguna parte.
--
-- La regla, para no volver a decidirlo caso por caso: **la lista de columnas del payload
-- es la lista del `grant update`**. No una selección de las que parecen importantes —ese
-- criterio es justo el que dejó fuera `ventana_dias`, que gobierna qué snapshots se
-- aceptan— sino la lista entera, en el valor nuevo y en el `antes`. Si una columna se
-- puede escribir, se puede auditar. Por eso el contenido de cada tabla vive en su propia
-- función (`entrada_kpi_contenido`, `outcome_review_narrativa`, `criterio_exito_contenido`):
-- el «antes» y el «después» salen del mismo sitio y no pueden divergir.
--
-- Barrido del eje, tabla por tabla, con lo que faltaba:
--  · `entrada_kpi` (12 columnas): faltaban `definicion`, `fuente`, `dimensiones` y
--    `dashboard_url`.
--  · `criterio_exito` (8): el evento llevaba SOLO `kpi` y ningún `antes` — faltaban
--    `objetivo` y `ventana_dias` incluidos, que son la promesa y la ventana de todo el
--    slice.
--  · `outcome_review` (10): faltaban `estado` y la firma (`completado_por`,
--    `completado_en`), que el WITH CHECK solo ata en la rama de la completación.
--  · `gate_instancia` (3): faltaban `estado`, `aprobado_por` y `aprobado_en` — y la fecha
--    la propone la aplicación con el único requisito de no ser nula.
--  · `metric_registry` (2 + el sello del guard): faltaban `estado`, `firmado_por` y
--    `firmado_en`.
--  · `resultado_criterio` (3): ya estaban las tres. Es la única que ya cumplía la regla.
--  · `reto` (`estado`, + `veredicto` que escribe el guard) y `proyecto` (`estado`): sus
--    eventos llevan `de`/`a` —el antes y el después de la única columna que se mueve— y el
--    del reto también el veredicto.
create function medicion_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  fila jsonb := to_jsonb(new);
  previa jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  cuerpo jsonb;
  evento text;
begin
  -- Guard compartido entre tablas con columnas distintas: se trabaja sobre jsonb porque
  -- plpgsql resuelve TODAS las referencias de campo aunque su rama no se ejecute.
  if tg_table_name = 'metric_registry' then
    evento := 'MetricRegistryAbierto';
    cuerpo := jsonb_build_object('registryId', fila->'id', 'retoId', fila->'reto_id');
  elsif tg_table_name = 'entrada_kpi' then
    evento := case tg_op when 'INSERT' then 'EntradaKpiAgregada' else 'EntradaKpiEditada' end;
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
      return new;
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
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, evento, cuerpo,
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
-- AFTER: el rastro se emite cuando la escritura ya es un hecho, no cuando se propone.
create trigger registry_auditoria
  after insert on metric_registry for each row execute function medicion_auditoria();
create trigger entrada_auditoria
  after insert or update on entrada_kpi for each row execute function medicion_auditoria();
create trigger snapshot_auditoria
  after insert on snapshot for each row execute function medicion_auditoria();
create trigger review_auditoria
  after insert or update on outcome_review for each row execute function medicion_auditoria();
create trigger resultado_auditoria
  after insert or update on resultado_criterio for each row execute function medicion_auditoria();
revoke execute on function medicion_auditoria() from public;

-- ── Grants mínimos ──
grant select, insert on metric_registry, entrada_kpi, snapshot to designio_app;
grant select, insert on outcome_review, resultado_criterio to designio_app;
-- Solo la FIRMA del registry (jamás su reto ni su autoría).
-- Sin `firmado_en` en el grant: el sello temporal lo pone el guard y NADIE más. Que la
-- columna estuviera aquí dejaba al rol de app proponer una fecha —que el guard pisaba,
-- pero el contrato decía otra cosa— y obligaba a repetirla en el servicio. Sin permiso
-- de escritura, la promesa «un update directo no retro ni post-data la firma» es
-- estructural en vez de depender de que el trigger siga ahí.
grant update (estado, firmado_por) on metric_registry to designio_app;
-- La entrada se corrige ENTERA mientras el registry es borrador —el criterio al que
-- responde incluido—; lo único fuera del grant es `registry_id`, que sí es identidad: la
-- entrada pertenece a ESE contrato de medición y moverla a otro sería otra entrada.
--
-- El criterio, en cambio, es un ATRIBUTO del compromiso, como el dueño del dato o la
-- ventana. Dejarlo fuera del grant lo volvía inmutable de hecho —no hay política ni grant
-- de DELETE en esta tabla—, así que elegir el criterio equivocado al crear el KPI no tenía
-- reparación: la única salida era firmar el contrato con un KPI que mide una promesa que
-- nadie hizo. Y el error es especialmente caro porque el criterio no es una etiqueta: de
-- él sale `ventana_dias`, o sea la VENTANA que gobierna qué snapshots se aceptan.
--
-- Que sea seguro no es una esperanza: el WITH CHECK de `entrada_update` ya revalidaba en
-- cada escritura que el criterio fuera del MISMO reto del registry —esa comprobación
-- estaba ahí escrita para un `criterio_id` mutable y era letra muerta sin este grant—, y
-- mientras el registry es borrador la entrada NO puede tener snapshots (`snapshot_insert`
-- exige el registry firmado), así que cambiar el criterio no mueve el suelo bajo ninguna
-- serie. Firmar es lo que congela; hasta entonces el borrador se corrige.
grant update (nombre, definicion, fuente, dimensiones, criterio_id, propietario_miembro_id,
  frecuencia, dashboard_url, linea_base_valor, linea_base_fecha, ventana_inicio,
  fecha_post_mortem) on entrada_kpi to designio_app;
-- snapshot SIN update ni delete: append-only por ausencia de política Y de grant (SYS-23).
grant update (estado, veredicto, contribucion, factores_externos, hipotesis_abiertas,
  aprendizajes, diseno_experimental_suficiente, diseno_experimental_justificacion,
  completado_por, completado_en) on outcome_review to designio_app;
grant update (snapshot_final_id, lectura, sin_datos_motivo) on resultado_criterio to designio_app;
-- El proyecto gana su transición de estado; reto.veredicto NO recibe grant: lo escribe
-- únicamente el guard del outcome review.
grant update (estado) on proyecto to designio_app;
