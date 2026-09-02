-- SPEC-06 (ADR-0004) — La cadena de trazabilidad y los cuatro objetos de resultado:
-- design version con elementos de cambio, releases PARCIALES, effective state con
-- desviaciones y la conciliación que bloquea G7.
--
-- El diff NO tiene tabla (RF-06.2, y la tabla de decisiones tácticas del domain model):
-- se CALCULA contra el effective state vigente del servicio. Almacenarlo sería guardar
-- una respuesta que caduca en cuanto cambia cualquiera de sus dos lados.
--
-- `release` es palabra clave NO RESERVADA en Postgres (solo lo es en `release savepoint`)
-- y sirve como nombre de tabla sin comillas — verificado en 16. Se usa el nombre canónico
-- del agregado (I1/SYS-09: el vocabulario de resultados no se renombra) en vez de un
-- sinónimo; «Entrega» es el nombre del CONTEXTO (CTX-05), y es el que lleva el módulo
-- TypeScript (src/lib/entrega/), no el objeto.
--
-- Mismo patrón de la casa: FKs compuestas (id, workspace_id), RLS desde el día 1,
-- atribución fijada en la política, transiciones exigidas por el WITH CHECK y efectos
-- (sellos, cambios de estado y eventos) dentro del guard que decide, para que el SQL
-- crudo los produzca igual.

-- ── Design version: qué se decidió construir o cambiar (CTX-04, RF-06.1) ──
-- Estados de §3.3: borrador → aprobada (inmutable) → superada.
create table design_version (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  proyecto_id uuid not null,
  -- El servicio cuyo effective state cambia: es el eje del diff (RF-06.2) y del estado
  -- vigente (RF-06.10). Va aquí y no derivado del reto porque un reto afecta a varios
  -- servicios (n:m) y una design version cambia UNO.
  servicio_id uuid not null,
  -- El grafo to-be que esta versión aprueba. Opcional en borrador (la DV puede abrirse
  -- antes de que el to-be exista); OBLIGATORIO al aprobar, porque aprobar congela su
  -- snapshot (RF-06.3 / RF-05.8).
  journey_id uuid,
  codigo text not null check (codigo ~ '^DV-[0-9]+$'),
  titulo text not null check (btrim(titulo) <> ''),
  resumen text not null default '',
  estado text not null default 'borrador'
    check (estado in ('borrador', 'aprobada', 'superada')),
  -- SYS-05: «toda modificación posterior crea una nueva versión y marca la anterior como
  -- superada». La versión NUEVA declara a cuál supera; al aprobarse, aquella pasa a
  -- 'superada' en la misma transacción.
  supera_a uuid,
  snapshot_id uuid,
  aprobada_por uuid references usuario(id),
  aprobada_en timestamptz,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, codigo),
  foreign key (proyecto_id, workspace_id) references proyecto (id, workspace_id),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id),
  foreign key (journey_id, workspace_id) references journey (id, workspace_id),
  foreign key (supera_a, workspace_id) references design_version (id, workspace_id),
  foreign key (snapshot_id, workspace_id) references journey_snapshot (id, workspace_id),
  -- Aprobar es inseparable de congelar: sin snapshot no hay aprobación (RF-06.3).
  check (estado = 'borrador'
    or (aprobada_por is not null and aprobada_en is not null and snapshot_id is not null)),
  check (estado <> 'borrador'
    or (aprobada_por is null and aprobada_en is null and snapshot_id is null)),
  check (supera_a is null or supera_a <> id)
);
create index design_version_proyecto_idx on design_version (workspace_id, proyecto_id);
-- SYS-05 en el MODELO, no en el servicio: un servicio tiene como mucho UNA design
-- version aprobada. Aprobar DV-2 sin superar a DV-1 no es un flujo mal implementado:
-- es una fila que la base rechaza.
create unique index design_version_vigente_uniq
  on design_version (workspace_id, servicio_id) where estado = 'aprobada';
-- La historia es una CADENA, no un árbol: una design version tiene como mucho una
-- sucesora. Parcial sobre las no-borrador a propósito — dos borradores pueden competir
-- por suceder a la misma DV (y uno quedarse en el camino), pero solo uno llega a
-- aprobarse. Sin el parcial, un borrador abandonado bloquearía la sucesión para siempre
-- y no hay DELETE que lo saque de en medio.
create unique index design_version_sucesion_uniq
  on design_version (workspace_id, supera_a)
  where supera_a is not null and estado <> 'borrador';

-- ── Elemento de cambio: la unidad del diff (RF-06.1) ──
-- Tipado a propósito (§3.2 lo enumera): sin tipo, el diff es una lista de frases y la
-- conciliación no puede agrupar ni comparar entre retos.
create table elemento_cambio (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  design_version_id uuid not null,
  tipo text not null check (tipo in (
    'touchpoint', 'proceso-backstage', 'canal', 'politica', 'sistema', 'paso', 'rol')),
  -- Lo que el autor DECLARA hacer. El diff (RF-06.2) contrasta esta declaración contra
  -- el effective state vigente y señala las que no cuadran: por eso se guarda la
  -- declaración y no el resultado del contraste.
  operacion text not null check (operacion in ('agrega', 'modifica', 'retira')),
  titulo text not null check (btrim(titulo) <> ''),
  detalle text not null default '',
  -- El nodo del grafo (SPEC-05) que materializa el cambio: es lo que permite responder
  -- «qué pasos del journey afectó RL-1» (§19.7, criterio de aceptación 5).
  --
  -- SIN FK, a propósito, y es la única columna de este esquema que renuncia a una. Una FK
  -- restrictiva desde aquí invierte la relación que RF-05.8 establece: el grafo de trabajo
  -- NO se cierra al congelar —lo inmutable es el snapshot—, y un elemento de una design
  -- version aprobada es inmutable (sus políticas solo alcanzan borradores). Con la FK, en
  -- cuanto una versión aprobada enlazaba un nodo, ese nodo ya no se podía borrar nunca:
  -- ni desenlazándolo (la versión es inmutable) ni de ninguna otra forma. El objeto
  -- congelado le prohibía cambiar al vivo, que es exactamente el cierre que la spec
  -- rechaza.
  --
  -- Lo que se conserva es el ID, y con él la referencia histórica — que se resuelve contra
  -- el SNAPSHOT de la versión que lo aprobó (nodo_congelado, más abajo), no contra la fila
  -- viva. Leer la fila viva ya era leer otra cosa: el journey sigue editándose, y desde
  -- SPEC-05.1 renombrar una entrada de catálogo reescribe la etiqueta de todos sus nodos,
  -- así que el «paso» que una design version aprobada dice haber cambiado podía cambiar de
  -- nombre por debajo sin que nadie tocara la design version.
  --
  -- La integridad que la FK daba de verdad —que el nodo sea de este workspace y del
  -- journey de esta design version— no se pierde: nunca la dio la FK (que solo garantizaba
  -- el workspace), la da elemento_cambio_nodo_guard en cada escritura. Lo único que se
  -- suelta es «la fila sigue existiendo», que es justo lo que no debe ser un invariante.
  --
  -- Mientras la versión sigue en BORRADOR, «la fila sigue existiendo» tampoco es un
  -- invariante que haga falta: el borrador se edita contra el grafo vivo, y si el nodo se
  -- borra el enlace queda colgando y se corrige —`nodo_id` está en el grant de columna—.
  -- Lo que sí es un invariante es que al APROBAR el snapshot pueda responder por cada
  -- nodo enlazado, y eso lo exige design_version_transicion_guard en la transición, que
  -- es cuando la versión se vuelve inmutable y deja de poder corregirse.
  nodo_id uuid,
  orden integer not null default 0,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (design_version_id, workspace_id) references design_version (id, workspace_id)
);
create index elemento_cambio_dv_idx on elemento_cambio (workspace_id, design_version_id, orden);
create index elemento_cambio_nodo_idx on elemento_cambio (workspace_id, nodo_id);

-- Qué MOTIVA el elemento (RF-06.1). Dos tablas y no una columna polimórfica: cada
-- enlace tiene su FK compuesta real, y la navegación hacia atrás (RF-06.9) es un join,
-- no un case.
create table elemento_decision (
  elemento_id uuid not null,
  decision_id uuid not null,
  workspace_id uuid not null references workspace(id),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  primary key (elemento_id, decision_id),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  foreign key (decision_id, workspace_id) references decision (id, workspace_id)
);
create index elemento_decision_dec_idx on elemento_decision (workspace_id, decision_id);

create table elemento_insight (
  elemento_id uuid not null,
  insight_id uuid not null,
  workspace_id uuid not null references workspace(id),
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  primary key (elemento_id, insight_id),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  foreign key (insight_id, workspace_id) references insight (id, workspace_id)
);
create index elemento_insight_ins_idx on elemento_insight (workspace_id, insight_id);

-- ── Release: subconjunto de una design version aprobada (CTX-05, SYS-06) ──
-- Estados de §3.3: planificado → desplegado → verificado.
create table release (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  -- SYS-06: EXACTAMENTE una design version, y aprobada (lo exige la política de insert).
  design_version_id uuid not null,
  codigo text not null check (codigo ~ '^RL-[0-9]+$'),
  titulo text not null check (btrim(titulo) <> ''),
  -- RF-06.4: dueño y fecha. Sin dueño, «parcialidad explícita» es una lista sin nadie
  -- que responda por ella.
  responsable text not null check (btrim(responsable) <> ''),
  fecha_objetivo date not null,
  estado text not null default 'planificado'
    check (estado in ('planificado', 'desplegado', 'verificado')),
  -- Fecha REAL del despliegue (RF-06.5), calendárica: la pone quien lo registra porque
  -- puede ser anterior al registro; el guard impide que sea futura.
  desplegado_en date,
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, codigo),
  foreign key (design_version_id, workspace_id) references design_version (id, workspace_id),
  check (estado = 'planificado' or desplegado_en is not null),
  check (estado <> 'planificado' or desplegado_en is null)
);
create index release_dv_idx on release (workspace_id, design_version_id);

-- ── Parcialidad explícita (SYS-06, §19.5) ──
-- La PK es el ELEMENTO, no el par: cada elemento va a como mucho UN release, y eso es
-- una constraint, no una convención del servicio. El «exactamente uno» de RF-06.4 lo
-- completa G7, que no aprueba con elementos sin estado conocido.
create table release_elemento (
  elemento_id uuid primary key,
  release_id uuid not null,
  workspace_id uuid not null references workspace(id),
  -- Por qué este elemento cae en ESTE release y no antes (criterio de aceptación 2:
  -- «pendiente asignado a RL-2 con su razón»). Opcional: la razón obligatoria es la de
  -- la desviación (SYS-07), no la del plan.
  razon text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  foreign key (release_id, workspace_id) references release (id, workspace_id)
);
create index release_elemento_rel_idx on release_elemento (workspace_id, release_id);

-- ── Effective state: qué quedó funcionando (CTX-05, RF-06.6) ──
-- Cada constatación es un REGISTRO NUEVO (historia, no mutación); «vigente» es el más
-- reciente por servicio (RF-06.10).
create table effective_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  servicio_id uuid not null,
  release_id uuid not null,
  codigo text not null check (codigo ~ '^ES-[0-9]+$'),
  resumen text not null default '',
  constatado_por uuid not null references usuario(id),
  constatado_en date not null,
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, codigo),
  -- Release "1" → "0..1" EffectiveState (domain model): un release se constata una vez.
  unique (release_id),
  foreign key (servicio_id, workspace_id) references servicio (id, workspace_id),
  foreign key (release_id, workspace_id) references release (id, workspace_id)
);
create index effective_state_servicio_idx
  on effective_state (workspace_id, servicio_id, constatado_en desc);

-- ── Constatación por elemento, con la desviación dentro (RF-06.6, SYS-07) ──
-- La «Desviación» del modelo NO es otra tabla: es una constatación cuyo resultado no es
-- 'como-aprobado'. Separarlas permitiría constatar un elemento como desviado sin
-- desviación, que es justo el estado que SYS-07 prohíbe.
create table constatacion (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  effective_state_id uuid not null,
  elemento_id uuid not null,
  resultado text not null check (resultado in ('como-aprobado', 'desviado', 'no-implementado')),
  que_quedo_distinto text not null default '',
  razon text not null default '',
  creado_por uuid not null references usuario(id),
  creado_en timestamptz not null default now(),
  unique (id, workspace_id),
  unique (effective_state_id, elemento_id),
  foreign key (effective_state_id, workspace_id) references effective_state (id, workspace_id),
  foreign key (elemento_id, workspace_id) references elemento_cambio (id, workspace_id),
  -- SYS-07 como CHECK y no como validación del servicio: toda desviación registra el
  -- elemento (la FK) y una razón NO VACÍA. btrim porque el whitespace no es una razón.
  check (resultado = 'como-aprobado'
    or (btrim(que_quedo_distinto) <> '' and btrim(razon) <> '')),
  -- Y al revés: «como aprobado» con texto de desviación sería una desviación escondida.
  check (resultado <> 'como-aprobado'
    or (btrim(que_quedo_distinto) = '' and btrim(razon) = ''))
);
create index constatacion_es_idx on constatacion (workspace_id, effective_state_id);
create index constatacion_elemento_idx on constatacion (workspace_id, elemento_id);

-- ══ RLS ══
-- Lectura: todo miembro. La cadena evidencia→resultado es lo que el cliente audita; un
-- effective state que el sponsor no puede leer no demuestra nada.
-- Escritura: el LEAD opera el método (§13.2). Los elementos de cambio los escriben los
-- curadores (lead/diseñador: producen el artefacto); el plan de releases, el despliegue
-- y la constatación son del lead. El sponsor aprueba GATES (G5/G6/G7), no objetos: su
-- palanca sobre una design version es no aprobar el gate que la certifica.

alter table design_version enable row level security;
alter table elemento_cambio enable row level security;
alter table elemento_decision enable row level security;
alter table elemento_insight enable row level security;
alter table release enable row level security;
alter table release_elemento enable row level security;
alter table effective_state enable row level security;
alter table constatacion enable row level security;

create policy design_version_select on design_version
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy elemento_cambio_select on elemento_cambio
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy elemento_decision_select on elemento_decision
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy elemento_insight_select on elemento_insight
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy release_select on release
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy release_elemento_select on release_elemento
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy effective_state_select on effective_state
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy constatacion_select on constatacion
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- La DV nace en BORRADOR y sin sellos: la política lo exige, así que no existe el camino
-- de colar una versión ya «aprobada» sin pasar por la transición que congela.
create policy design_version_insert on design_version
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and estado = 'borrador'
    and aprobada_por is null
    and aprobada_en is null
    and snapshot_id is null
  );

-- Aprobar: borrador → aprobada, atribuida, CON snapshot congelado. El snapshot se
-- inserta en una sentencia anterior de la misma transacción, así que este predicado ya
-- lo ve: la congelación de RF-06.3 es parte del permiso, no una cortesía del servicio.
create policy design_version_aprobar on design_version
  for update
  using (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  )
  with check (
    estado = 'aprobada'
    and aprobada_por = app_user_id()
    and aprobada_en is not null
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from journey_snapshot s
      where s.id = design_version.snapshot_id
        and s.workspace_id = design_version.workspace_id
        and s.journey_id = design_version.journey_id)
  );

-- Superar: aprobada → superada. Es el otro lado de SYS-05 y lo ejecuta la misma
-- transacción que aprueba la sucesora.
create policy design_version_superar on design_version
  for update
  using (
    estado = 'aprobada'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  )
  with check (
    estado = 'superada'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );

-- Enlazar el journey to-be DESPUÉS de abrir el borrador. `journey_id` es opcional en
-- borrador a propósito (la DV puede abrirse antes de que el to-be exista), pero sin este
-- camino esa opción era una trampa: el borrador que nacía sin journey no podía aprobarse
-- —aprobar congela el snapshot, y sin grafo no hay snapshot— ni borrarse —no hay DELETE
-- sobre design_version, porque los cuatro objetos de resultado son el registro de lo que
-- pasó—, así que se quedaba muerto en la lista para siempre.
--
-- Alcanza SOLO borradores: una design version aprobada es inmutable y su snapshot ya
-- congeló el grafo que aprobó; reapuntarla a otro journey reescribiría a qué se
-- comprometió. Y el grant por columna (más abajo) deja fuera todo lo demás, así que
-- «de una DV en borrador solo se puede reenlazar el journey» es estructural, no una
-- disciplina del servicio.
--
-- El USING que esto abre (borrador + curador) puede emparejarse con el WITH CHECK de
-- otra política —así funciona la RLS: los predicados se OR-ean entre políticas— pero no
-- abre ninguna transición nueva: 'borrador' → 'superada' ya era emparejable con el USING
-- de design_version_aprobar, y lo que la cierra es el CHECK de la tabla (una no-borrador
-- exige sellos) y `design_version_transicion_guard`, que enumera los pares legales.
create policy design_version_enlazar_journey on design_version
  for update
  using (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (
    estado = 'borrador'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

-- Criterio de aceptación 1: sobre una DV aprobada, editar un elemento se RECHAZA. No es
-- un chequeo del servicio con un mensaje amable — es que las tres políticas del elemento
-- solo alcanzan design versions en borrador.
create policy elemento_cambio_insert on elemento_cambio
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_cambio_update on elemento_cambio
  for update
  using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  )
  with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_cambio_delete on elemento_cambio
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from design_version dv
      where dv.id = elemento_cambio.design_version_id
        and dv.workspace_id = elemento_cambio.workspace_id
        and dv.estado = 'borrador')
  );

create policy elemento_decision_insert on elemento_decision
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_decision.elemento_id
        and ec.workspace_id = elemento_decision.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_decision_delete on elemento_decision
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_decision.elemento_id
        and ec.workspace_id = elemento_decision.workspace_id
        and dv.estado = 'borrador')
  );

create policy elemento_insight_insert on elemento_insight
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_insight.elemento_id
        and ec.workspace_id = elemento_insight.workspace_id
        and dv.estado = 'borrador')
  );
create policy elemento_insight_delete on elemento_insight
  for delete using (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (select 1 from elemento_cambio ec
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where ec.id = elemento_insight.elemento_id
        and ec.workspace_id = elemento_insight.workspace_id
        and dv.estado = 'borrador')
  );

-- SYS-06 en la política de alta: un release solo cuelga de una design version APROBADA.
-- Nace planificado y sin fecha real (las filas nacen en su estado inicial).
create policy release_insert on release
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and estado = 'planificado'
    and desplegado_en is null
    and exists (select 1 from design_version dv
      where dv.id = release.design_version_id
        and dv.workspace_id = release.workspace_id
        and dv.estado = 'aprobada')
  );
create policy release_desplegar on release
  for update
  using (estado = 'planificado' and workspace_role(app_user_id(), workspace_id) = 'lead-boutique')
  with check (
    estado = 'desplegado'
    and desplegado_en is not null
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );
create policy release_verificar on release
  for update
  using (estado = 'desplegado' and workspace_role(app_user_id(), workspace_id) = 'lead-boutique')
  with check (
    estado = 'verificado'
    and workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
  );

-- El alcance de un release se declara mientras está PLANIFICADO. Una vez desplegado,
-- mover elementos dentro o fuera reescribiría qué se implementó.
--
-- AÑADIR alcance exige además que la design version padre siga APROBADA. Sin eso, una
-- pantalla cargada antes de la supersión seguía pudiendo meter trabajo nuevo en una
-- versión ya reemplazada: la política solo miraba el release, y el release no cambia de
-- estado cuando su versión es superada. Desde el arreglo de G7 eso no es inocuo — un
-- release sin resolver de una versión superada BLOQUEA la certificación del proyecto—,
-- así que la puerta se cierra donde se abre.
--
-- QUITAR alcance no lo exige, y la asimetría es deliberada: es exactamente la salida que
-- G7 deja al lead para cerrar lo que la versión superada dejó en vuelo («esto ya no va a
-- salir» = se le quita el alcance al release planificado, y entonces no puede desplegarse
-- nunca). Exigir aquí la versión aprobada dejaría ese trabajo sin forma de cerrarse y el
-- gate bloqueado para siempre. Añadir es abrir trabajo nuevo; quitar es cerrar lo abierto.
create policy release_elemento_insert on release_elemento
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and exists (select 1 from release r
      join design_version dv on dv.id = r.design_version_id and dv.workspace_id = r.workspace_id
      where r.id = release_elemento.release_id
        and r.workspace_id = release_elemento.workspace_id
        and r.estado = 'planificado'
        and dv.estado = 'aprobada')
  );
create policy release_elemento_delete on release_elemento
  for delete using (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and exists (select 1 from release r
      where r.id = release_elemento.release_id
        and r.workspace_id = release_elemento.workspace_id
        and r.estado = 'planificado')
  );

-- Constatar exige un release DESPLEGADO: no se certifica lo que no salió. Sin update ni
-- delete en ninguna de las dos tablas: la constatación es historia (RF-06.6).
create policy effective_state_insert on effective_state
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and constatado_por = app_user_id()
    and exists (select 1 from release r
      where r.id = effective_state.release_id
        and r.workspace_id = effective_state.workspace_id
        and r.estado = 'desplegado')
  );
create policy constatacion_insert on constatacion
  for insert with check (
    workspace_role(app_user_id(), workspace_id) = 'lead-boutique'
    and creado_por = app_user_id()
    and exists (select 1 from effective_state es
      join release r on r.id = es.release_id and r.workspace_id = es.workspace_id
      where es.id = constatacion.effective_state_id
        and es.workspace_id = constatacion.workspace_id
        and r.estado = 'desplegado')
  );

-- ══ Guards ══

-- El nodo que materializa un elemento tiene que ser del grafo que la design version
-- aprueba. La FK compuesta garantiza el workspace y nada más: sin esto, un elemento de
-- la DV del servicio A podría apuntar a un paso del journey del servicio B y la
-- respuesta a «qué pasos afectó RL-1» saldría mintiendo.
create function elemento_cambio_nodo_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_journey uuid;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.nodo_id is null then
    return new;
  end if;
  select dv.journey_id into v_journey from design_version dv
    where dv.id = new.design_version_id and dv.workspace_id = new.workspace_id;
  if v_journey is null then
    raise exception 'para enlazar un nodo, la design version debe declarar su journey to-be';
  end if;
  if not exists (select 1 from journey_nodo n
    where n.id = new.nodo_id and n.workspace_id = new.workspace_id
      and n.journey_id = v_journey) then
    raise exception 'el nodo enlazado no pertenece al journey de esta design version';
  end if;
  return new;
end $$;
create trigger elemento_cambio_nodo
  before insert or update on elemento_cambio
  for each row execute function elemento_cambio_nodo_guard();
revoke execute on function elemento_cambio_nodo_guard() from public;

-- Lo que MOTIVA un elemento tiene que ser citable de verdad: misma doctrina que
-- checklist_objeto_citable_guard (la decisión, del proyecto de la DV; el insight,
-- validado). El picker filtra las dos cosas; el endpoint acepta cualquier uuid.
create function elemento_motivo_citable_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if tg_table_name = 'elemento_decision' then
    if not exists (
      select 1 from decision d
      join elemento_cambio ec on ec.id = new.elemento_id and ec.workspace_id = new.workspace_id
      join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
      where d.id = new.decision_id and d.workspace_id = new.workspace_id
        and d.proyecto_id = dv.proyecto_id) then
      raise exception 'la decisión citada no existe en el proyecto de esta design version';
    end if;
  else
    if not exists (select 1 from insight i
      where i.id = new.insight_id and i.workspace_id = new.workspace_id
        and i.estado = 'validado') then
      raise exception 'el insight citado no existe o todavía no está validado';
    end if;
  end if;
  return new;
end $$;
create trigger elemento_decision_citable
  before insert on elemento_decision
  for each row execute function elemento_motivo_citable_guard();
create trigger elemento_insight_citable
  before insert on elemento_insight
  for each row execute function elemento_motivo_citable_guard();
revoke execute on function elemento_motivo_citable_guard() from public;

-- El nodo TAL COMO ERA cuando la design version lo congeló. La aprobación guarda el grafo
-- entero en journey_snapshot.grafo (nodos serializados con to_jsonb, o sea con todas sus
-- columnas), así que la respuesta histórica no depende de que la fila viva siga existiendo
-- ni de que siga diciendo lo mismo.
--
-- Devuelve null cuando la design version aún no tiene snapshot —está en borrador—, y ahí
-- el llamador cae a la fila viva, que es la correcta: un borrador se edita CONTRA el grafo
-- de trabajo, no contra una foto que todavía no existe.
create function nodo_congelado(p_snapshot uuid, p_workspace uuid, p_nodo uuid)
returns jsonb language sql stable as $$
  select nodo
  from journey_snapshot s,
       lateral jsonb_array_elements(s.grafo->'nodos') as nodo
  where s.id = p_snapshot and s.workspace_id = p_workspace
    and nodo->>'id' = p_nodo::text
  limit 1
$$;
revoke execute on function nodo_congelado(uuid, uuid, uuid) from public;
grant execute on function nodo_congelado(uuid, uuid, uuid) to designio_app;

-- ¿Este reto APLICA a este servicio? Anclado en él, o declarado como que lo afecta.
-- Es el MISMO criterio que journey_anclaje_guard (SPEC-05) lleva inline: «aplica» es una
-- definición del dominio, y dos versiones divergentes de ella serían dos verdades sobre el
-- mismo hecho. Aquí se le pone nombre para no volver a escribirla en los dos sitios que la
-- necesitan; cuando el guard del journey se reescriba, debería adoptar esta.
create function reto_aplica_a_servicio(p_reto uuid, p_workspace uuid, p_servicio uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from reto r
    where r.id = p_reto and r.workspace_id = p_workspace
      and (r.servicio_ancla_id = p_servicio
           or exists (select 1 from reto_servicio_afectado rsa
             where rsa.reto_id = r.id and rsa.workspace_id = r.workspace_id
               and rsa.servicio_id = p_servicio)))
$$;
revoke execute on function reto_aplica_a_servicio(uuid, uuid, uuid) from public;

-- El proyecto que produce la design version y el servicio que cambia tienen que
-- pertenecer al mismo reto. Ninguna FK lo dice: design_version referencia proyecto y
-- servicio por separado, y los dos existen en el workspace.
--
-- Sin esto, una design version del servicio B podía colgar de un proyecto A cuyo reto ni
-- ancla ni declara a B. Y no es cosmético: gate_aprobar_suficiencia_guard acota G7 por
-- `dv.proyecto_id`, así que el proyecto A se certificaría con trabajo hecho para un
-- servicio que su reto no toca — el gate diría «la implementación de A está conciliada»
-- mirando elementos que no son de A.
--
-- La comprobación NO puede delegarse en el journey: un to-be sin proyecto es legítimo
-- (SPEC-05 lo permite y esta migración lo usa), así que el chequeo de anclaje del journey
-- se salta entero cuando `j.proyecto_id is null`. La relación hay que derivarla por el
-- RETO del proyecto, que es donde vive de verdad.
--
-- Aquí también el `supera_a`: la transición exige que la superada sea del MISMO servicio,
-- pero eso se descubría al aprobar, cuando ya es tarde — `supera_a` no está en el grant de
-- columna y no hay DELETE sobre design_version, así que un borrador que apunta a la
-- versión de otro servicio no se puede corregir ni borrar. Igual que el journey sin
-- enlazar: la comprobación se adelanta al nacimiento, que es cuando aún hay salida.
create function design_version_anclaje_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- Sobre una versión que ya no es borrador manda el guard de transición, que la declara
    -- inmutable; y si `supera_a` no se mueve no hay nada nuevo que validar.
    if old.estado <> 'borrador' or new.supera_a is not distinct from old.supera_a then
      return new;
    end if;
  else
    -- Solo en el alta: ni `proyecto_id` ni `servicio_id` están en el grant de columna, así
    -- que después de nacer no pueden moverse y revalidarlos sería trabajo muerto.
    if not exists (
      select 1 from proyecto p
      where p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        and reto_aplica_a_servicio(p.reto_id, p.workspace_id, new.servicio_id)) then
      raise exception 'el proyecto de la design version cuelga de un reto que no ancla este servicio ni lo declara afectado';
    end if;
  end if;
  if new.supera_a is not null and not exists (
    select 1 from design_version dv
    where dv.id = new.supera_a and dv.workspace_id = new.workspace_id
      and dv.servicio_id = new.servicio_id) then
    raise exception 'una design version solo supera a otra del MISMO servicio (SYS-05)';
  end if;
  -- Y al revés: si el servicio YA tiene una versión aprobada, la nueva tiene que declarar
  -- a cuál supera. Sin esto el borrador nacía sin `supera_a`, y la aprobación chocaba
  -- mucho más tarde contra el índice único parcial de SYS-05 — con la versión ya escrita y
  -- sin forma de corregirla desde la app hasta que `supera_a` entró en el grant.
  if new.supera_a is null and exists (
    select 1 from design_version dv
    where dv.workspace_id = new.workspace_id and dv.servicio_id = new.servicio_id
      and dv.estado = 'aprobada') then
    raise exception 'este servicio ya tiene una design version aprobada: la nueva debe declarar a cuál supera (SYS-05)';
  end if;
  return new;
end $$;
create trigger design_version_anclaje
  before insert or update on design_version
  for each row execute function design_version_anclaje_guard();
revoke execute on function design_version_anclaje_guard() from public;

-- El journey que una design version declara tiene que ser el to-be de SU servicio, se
-- declare al abrirla o se enlace después. La FK compuesta solo garantiza el workspace: sin
-- esto, un borrador podía nacer apuntando al as-is, o al to-be de otro servicio, y la
-- pantalla anunciaba «to-be: X» hasta que la aprobación —mucho más tarde— lo desmintiera.
-- Misma doctrina que `elemento_motivo_citable_guard`: el picker filtra, pero el endpoint
-- acepta cualquier uuid, así que la regla vive en la base.
--
-- Las mismas dos comprobaciones que hace `design_version_transicion_guard` al aprobar, y
-- ahí siguen: esto adelanta el veredicto al momento del enlace (que es cuando el autor
-- puede corregirlo), no lo sustituye — entre enlazar y aprobar, el journey puede haber
-- cambiado de proyecto.
create function design_version_journey_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.journey_id is null then
    return new;
  end if;
  -- Aprobar y superar no tocan el journey: sin esto, cada transición pagaría dos
  -- consultas por una respuesta que ya no puede haber cambiado.
  if tg_op = 'UPDATE' and new.journey_id is not distinct from old.journey_id then
    return new;
  end if;
  -- Sobre una design version que ya NO estaba en borrador no hay nada que validar aquí:
  -- es inmutable, y ese —no «el journey no es el de tu servicio»— es el veredicto que su
  -- autor tiene que leer. Lo dice design_version_transicion_guard, que corre después
  -- (los triggers de un mismo evento van por orden alfabético de nombre).
  if tg_op = 'UPDATE' and old.estado <> 'borrador' then
    return new;
  end if;
  if not exists (select 1 from journey j
    where j.id = new.journey_id and j.workspace_id = new.workspace_id
      and j.tipo = 'to-be' and j.servicio_id = new.servicio_id) then
    raise exception 'el journey de la design version debe ser el to-be de su servicio';
  end if;
  if exists (select 1 from journey j
    where j.id = new.journey_id and j.workspace_id = new.workspace_id
      and j.proyecto_id is not null and j.proyecto_id <> new.proyecto_id) then
    raise exception 'el journey to-be está anclado a otro proyecto';
  end if;
  -- Cambiar el journey de un borrador que ya enlazó elementos a nodos del anterior
  -- dejaría esos enlaces apuntando fuera del grafo que la design version aprueba: la
  -- respuesta a «qué pasos del journey afectó RL-1» (§19.7) saldría de un grafo que esta
  -- versión no congela. El guard del elemento no puede verlo —solo mira la fila que se
  -- escribe, y aquí no se escribe ninguna—, así que lo mira este. No se limpian solos a
  -- propósito: borrar el trabajo de otro en silencio es peor que pedir que lo revise.
  if tg_op = 'UPDATE' and exists (
    select 1 from elemento_cambio ec
    join journey_nodo n on n.id = ec.nodo_id and n.workspace_id = ec.workspace_id
    where ec.design_version_id = new.id and ec.workspace_id = new.workspace_id
      and n.journey_id <> new.journey_id) then
    raise exception 'hay elementos enlazados a nodos del journey anterior: quita esos enlaces antes de cambiar el journey';
  end if;
  return new;
end $$;
create trigger design_version_journey
  before insert or update on design_version
  for each row execute function design_version_journey_guard();
revoke execute on function design_version_journey_guard() from public;

-- Alta de la design version: rastro con actor y rol del MISMO snapshot que la autorizó.
-- El pre-chequeo deja pasar al owner (seed/backfill) sin fabricar eventos anónimos.
create function design_version_alta_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'DesignVersionBorrador',
      jsonb_build_object('designVersionId', new.id, 'codigo', new.codigo,
                         'servicioId', new.servicio_id, 'proyectoId', new.proyecto_id),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger design_version_alta
  after insert on design_version
  for each row when (new.estado = 'borrador')
  execute function design_version_alta_auditoria();
revoke execute on function design_version_alta_auditoria() from public;

-- SYS-05 en la transición. Los efectos van AQUÍ y no en el servicio para que el UPDATE
-- crudo los produzca igual: sello temporal, exigencias de aprobación y evento.
create function design_version_transicion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.estado = old.estado then
    -- SYS-05 donde no llegan las políticas: una design version que ya no está en borrador
    -- es INMUTABLE, y un UPDATE que no cambia de estado es justo el que las políticas no
    -- pueden rechazar. Los predicados de RLS se OR-ean ENTRE políticas: el USING de
    -- design_version_superar (aprobada + lead) selecciona la fila y el WITH CHECK de
    -- design_version_aprobar (sigue aprobada, mismo autor, con snapshot del journey) la
    -- deja pasar, sin que ninguna de las dos haya autorizado nada — la transición que
    -- cada una describe no está ocurriendo. Por ahí, el lead podía repuntar una versión
    -- aprobada a otro journey con otro snapshot y reescribir a qué se comprometió.
    -- Una política es un predicado sobre un snapshot, no un candado ni una máquina de
    -- estados; la máquina de estados es esto.
    if old.estado <> 'borrador' then
      raise exception 'una design version aprobada es inmutable (SYS-05): crea una versión nueva que la supere';
    end if;
    -- Sobre un BORRADOR sí hay UPDATEs legítimos —enlazar el journey, declarar a quién
    -- supera—, y cada uno tiene su guard. Los dos SELLOS que la aprobación escribe
    -- (`snapshot_id`, `aprobada_por`) están además en el grant de columna, así que se
    -- miró si hacía falta congelarlos aquí: NO hace falta, y por eso no hay regla. El
    -- CHECK de la tabla («estado <> borrador o los tres sellos son null») ya impide
    -- sembrarlos de antemano, que era el ataque —aprobar congelando el snapshot de una
    -- aprobación ANTERIOR del mismo grafo, y certificar así un to-be viejo—. Un CHECK no
    -- se puede emparejar entre políticas ni saltar con una transición legal: es el sitio
    -- más fuerte donde podía estar. Hay test que lo fija.
    return new;
  end if;
  if (old.estado, new.estado) not in (('borrador', 'aprobada'), ('aprobada', 'superada')) then
    raise exception 'transición de design version ilegal: % → %', old.estado, new.estado;
  end if;

  if new.estado = 'aprobada' then
    -- El sello lo pone la BASE: un update directo no puede retro ni post-datar lo que
    -- desde este instante es inmutable.
    new.aprobada_en := now();
    if new.journey_id is null then
      raise exception 'aprobar congela el snapshot del to-be: la design version debe declarar su journey';
    end if;
    if not exists (select 1 from journey j
      where j.id = new.journey_id and j.workspace_id = new.workspace_id
        and j.tipo = 'to-be' and j.servicio_id = new.servicio_id) then
      raise exception 'el journey de la design version debe ser el to-be de su servicio';
    end if;
    -- El anclaje proyecto↔servicio se comprueba OTRA VEZ al aprobar, y no por
    -- desconfianza del guard de alta: los servicios afectados por un reto se declaran y se
    -- retiran (reto_servicio_afectado no es inmutable), así que una design version que
    -- nació coherente puede dejar de serlo. Aprobar es el momento en que pasa a ser
    -- certificable por G7, y es ahí donde la relación tiene que seguir siendo cierta.
    if not exists (
      select 1 from proyecto p
      where p.id = new.proyecto_id and p.workspace_id = new.workspace_id
        and reto_aplica_a_servicio(p.reto_id, p.workspace_id, new.servicio_id)) then
      raise exception 'el proyecto de la design version ya no cuelga de un reto que afecte a este servicio';
    end if;
    -- El journey guarda su proyecto desde SPEC-05 (es opcional). Si lo declara, tiene
    -- que ser el mismo: dos proyectos del mismo reto tocando el mismo servicio podrían
    -- congelar cada uno el grafo del otro sin que ninguna FK se queje.
    if exists (select 1 from journey j
      where j.id = new.journey_id and j.workspace_id = new.workspace_id
        and j.proyecto_id is not null and j.proyecto_id <> new.proyecto_id) then
      raise exception 'el journey to-be está anclado a otro proyecto';
    end if;
    -- Una design version sin elementos no es una design version: no hay diff, no hay
    -- plan de releases y G7 se aprobaría vacuamente.
    if not exists (select 1 from elemento_cambio ec
      where ec.design_version_id = new.id and ec.workspace_id = new.workspace_id) then
      raise exception 'no se puede aprobar una design version sin elementos de cambio';
    end if;
    -- Y que el snapshot que se congela pueda RESPONDER por cada nodo enlazado. Sin FK en
    -- `elemento_cambio.nodo_id`, entre que un borrador enlaza un nodo y alguien aprueba,
    -- ese nodo puede haberse borrado del grafo de trabajo. Que el borrador se apoye en la
    -- fila viva es lo CORRECTO —se edita contra el grafo vivo, y RF-05.8 dice que ese
    -- grafo sigue editable—, así que la respuesta no es volver a hacer imborrable el nodo:
    -- eso reintroduce por otra puerta el cierre que quitar la FK vino a deshacer, y encima
    -- desde el objeto más provisional que hay. Lo que no puede pasar es que la versión se
    -- CONGELE prometiendo una identidad de nodo que su propio snapshot no contiene: «qué
    -- pasos del journey afectó RL-1» (§19.7) saldría vacío para siempre, y la versión ya
    -- es inmutable. Aprobar es el instante en que el borrador deja de serlo y en que todo
    -- lo demás se revalida (el journey, el anclaje, los elementos); esto es una condición
    -- más de esa lista.
    --
    -- Se comprueba contra el SNAPSHOT y no contra journey_nodo a propósito. El snapshot se
    -- insertó en una sentencia anterior de esta misma transacción y es lo que la pregunta
    -- histórica va a leer, así que la comprobación ES la promesa, palabra por palabra.
    -- Contra la fila viva habría además una carrera —borrar el nodo después de congelar y
    -- antes del update— que rechazaría una aprobación cuyo snapshot sí tiene el nodo.
    if new.snapshot_id is not null and exists (
      select 1 from elemento_cambio ec
      where ec.design_version_id = new.id and ec.workspace_id = new.workspace_id
        and ec.nodo_id is not null
        and nodo_congelado(new.snapshot_id, new.workspace_id, ec.nodo_id) is null
    ) then
      raise exception 'hay elementos enlazados a nodos que ya no están en el journey: desenlázalos antes de aprobar (RF-05.8)';
    end if;
    if new.supera_a is not null and not exists (select 1 from design_version dv
      where dv.id = new.supera_a and dv.workspace_id = new.workspace_id
        and dv.servicio_id = new.servicio_id and dv.estado = 'superada') then
      raise exception 'la design version superada debe quedar marcada como superada en la misma transacción';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'DesignVersionAprobada',
        jsonb_build_object('designVersionId', new.id, 'codigo', new.codigo,
                           'servicioId', new.servicio_id, 'snapshotId', new.snapshot_id,
                           'superaA', new.supera_a),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  else
    -- Superar cambia UNA cosa: el estado. Todo lo demás es el registro de lo que esta
    -- versión aprobó, y sigue teniendo que responder por ello mucho después — el snapshot
    -- es lo que contesta «qué pasos afectó RL-1» (§19.7), y `supera_a` es la cadena de
    -- SYS-05. La transición es LEGAL, así que el rechazo de «mismo estado» de arriba no
    -- dispara y las políticas solo miran el par de estados; el `using` de
    -- design_version_superar y su `with check` dejan pasar la sentencia entera, carga
    -- incluida. Los otros dos guards se apartan a propósito cuando la fila ya no es
    -- borrador, así que aquí no queda nadie más: la lista va explícita.
    if new.journey_id is distinct from old.journey_id
      or new.snapshot_id is distinct from old.snapshot_id
      or new.aprobada_por is distinct from old.aprobada_por
      or new.supera_a is distinct from old.supera_a then
      raise exception 'superar una design version solo cambia su estado: lo que aprobó es inmutable (SYS-05)';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'DesignVersionSuperada',
        jsonb_build_object('designVersionId', new.id, 'codigo', new.codigo,
                           'servicioId', new.servicio_id),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger design_version_transicion
  before update on design_version
  for each row execute function design_version_transicion_guard();
revoke execute on function design_version_transicion_guard() from public;

-- El release nace planificado y deja su rastro; la DV aprobada la exige la política.
create function release_alta_auditoria() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'ReleasePlanificado',
      jsonb_build_object('releaseId', new.id, 'codigo', new.codigo,
                         'designVersionId', new.design_version_id,
                         'responsable', new.responsable,
                         'fechaObjetivo', to_char(new.fecha_objetivo, 'YYYY-MM-DD')),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger release_alta
  after insert on release
  for each row execute function release_alta_auditoria();
revoke execute on function release_alta_auditoria() from public;

-- Un elemento solo entra en un release de SU design version. La FK compuesta garantiza
-- el workspace: sin esto, RL-1 de DV-1 podría «incluir» un elemento de DV-2 y la
-- conciliación de las dos saldría cuadrada por elementos que nunca les pertenecieron.
create function release_elemento_misma_dv_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if not exists (
    select 1 from release r
    join elemento_cambio ec on ec.id = new.elemento_id and ec.workspace_id = new.workspace_id
    where r.id = new.release_id and r.workspace_id = new.workspace_id
      and r.design_version_id = ec.design_version_id) then
    raise exception 'el elemento no pertenece a la design version de este release';
  end if;
  return new;
end $$;
create trigger release_elemento_misma_dv
  before insert on release_elemento
  for each row execute function release_elemento_misma_dv_guard();
revoke execute on function release_elemento_misma_dv_guard() from public;

-- Transiciones del release (§3.3) con sus exigencias y sus eventos dentro del guard.
create function release_transicion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.estado = old.estado then
    -- El mismo hueco que en design_version, aquí sobre la fecha REAL del despliegue. Los
    -- predicados de RLS se OR-ean entre políticas: sobre un release ya desplegado, el
    -- `using` de release_verificar (desplegado + lead) selecciona la fila y el
    -- `with check` de release_desplegar (sigue desplegado, con fecha no nula) la deja
    -- pasar. Como `desplegado_en` está en el grant de columna, un UPDATE que no cambia de
    -- estado reescribía la fecha de lo que ya pasó, y el early-return de este guard se
    -- saltaba tanto las comprobaciones de transición como la auditoría: la corrección no
    -- dejaba ni rastro.
    --
    -- Un release 'planificado' no necesita la regla —ningún with check acepta que siga
    -- planificado, así que la RLS ya rechaza ese UPDATE— y dejarlo fuera mantiene la
    -- excepción diciendo exactamente lo que pasa: lo que salió no se reescribe.
    --
    -- Se levanta excepción en vez de emitir un evento: un UPDATE no-op también dispara
    -- los triggers, y auditar «se desplegó» cada vez que alguien escribe la fila sin
    -- cambiarla llenaría el acta de despliegues que nunca ocurrieron. Si algún día hay
    -- que corregir una fecha mal tecleada, será una operación explícita con su política y
    -- su evento propio, no el efecto lateral de un update que no dice nada.
    if old.estado <> 'planificado' then
      raise exception 'un release ya desplegado no se reescribe: su fecha real es el registro de lo que pasó (RF-06.5)';
    end if;
    return new;
  end if;
  if (old.estado, new.estado) not in (
    ('planificado', 'desplegado'),
    ('desplegado', 'verificado')
  ) then
    raise exception 'transición de release ilegal: % → %', old.estado, new.estado;
  end if;

  if new.estado = 'desplegado' then
    if new.desplegado_en > current_date then
      raise exception 'la fecha real de despliegue no puede ser futura';
    end if;
    -- SYS-06: «declara explícitamente qué elementos incluye». Un release vacío
    -- desplegado no declara nada y dejaría la conciliación cuadrando sobre el aire.
    if not exists (select 1 from release_elemento re
      where re.release_id = new.id and re.workspace_id = new.workspace_id) then
      raise exception 'un release sin elementos declarados no se despliega (SYS-06)';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'ReleaseDesplegado',
        jsonb_build_object('releaseId', new.id, 'codigo', new.codigo,
                           'desplegadoEn', to_char(new.desplegado_en, 'YYYY-MM-DD')),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  else
    -- Verificar cambia UNA cosa: el estado. `desplegado_en` es la fecha REAL de lo que
    -- pasó y ya está registrada; aquí no se toca. El rechazo de «mismo estado» de arriba
    -- no cubre esto —la transición es legal, así que ni siquiera llega—, y la política de
    -- verificación solo pide el estado nuevo mientras el grant de columna sigue dejando
    -- escribir la fecha. Peor aún: la comprobación de fecha no futura vive en la rama de
    -- `desplegado`, así que por aquí entraba incluso una fecha del futuro. Congelar la
    -- columna cierra las dos cosas de una vez.
    if new.desplegado_en is distinct from old.desplegado_en then
      raise exception 'verificar no reescribe la fecha real del despliegue (RF-06.5)';
    end if;
    -- RF-06.6: «por cada elemento desplegado, constatación de cómo quedó». La
    -- constatación se inserta en sentencias anteriores de la misma transacción, así que
    -- este predicado ya las ve; por SQL crudo, verificar sin constatar aborta.
    if exists (
      select 1 from release_elemento re
      where re.release_id = new.id and re.workspace_id = new.workspace_id
        and not exists (
          select 1 from constatacion c
          join effective_state es on es.id = c.effective_state_id and es.workspace_id = c.workspace_id
          where c.elemento_id = re.elemento_id and c.workspace_id = re.workspace_id
            and es.release_id = new.id)) then
      raise exception 'verificar exige constatar TODOS los elementos del release (RF-06.6)';
    end if;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'ReleaseVerificado',
        jsonb_build_object('releaseId', new.id, 'codigo', new.codigo),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger release_transicion
  before update on release
  for each row execute function release_transicion_guard();
revoke execute on function release_transicion_guard() from public;

-- El effective state es del servicio de la design version del release: encadenarlo a
-- otro servicio rompería el «vigente por servicio» de RF-06.10 sin que ninguna FK se
-- queje. La fecha de constatación tampoco es futura.
create function effective_state_alta_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_desplegado_en date;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.constatado_en > current_date then
    raise exception 'la fecha de constatación no puede ser futura';
  end if;
  select r.desplegado_en into v_desplegado_en
  from release r
  join design_version dv on dv.id = r.design_version_id and dv.workspace_id = r.workspace_id
  where r.id = new.release_id and r.workspace_id = new.workspace_id
    and dv.servicio_id = new.servicio_id;
  if not found then
    raise exception 'el effective state es del servicio de la design version del release';
  end if;
  -- Una foto de lo que quedó funcionando no puede ser anterior al día en que salió: no
  -- describiría este release, describiría al servicio antes de él. Y el daño no se queda
  -- en esa fila — el estado efectivo vigente se pliega ORDENANDO por `constatado_en`
  -- (RF-06.10), así que una fecha inválida reordena la historia del servicio y hace ganar
  -- a un cambio viejo sobre uno nuevo. La política ya exige el release desplegado, así que
  -- aquí `desplegado_en` nunca es nulo (lo impone el CHECK de la tabla).
  if new.constatado_en < v_desplegado_en then
    raise exception 'la constatación no puede ser anterior al despliegue del release (%)', to_char(v_desplegado_en, 'YYYY-MM-DD');
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'EffectiveStateConstatado',
      jsonb_build_object('effectiveStateId', new.id, 'codigo', new.codigo,
                         'servicioId', new.servicio_id, 'releaseId', new.release_id,
                         'constatadoEn', to_char(new.constatado_en, 'YYYY-MM-DD')),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  return new;
end $$;
create trigger effective_state_alta
  before insert on effective_state
  for each row execute function effective_state_alta_guard();
revoke execute on function effective_state_alta_guard() from public;

-- Solo se constata lo que ESTE release incluyó: una constatación sobre un elemento
-- ajeno cerraría el tablero de conciliación con trabajo que nadie desplegó.
-- La desviación deja su propio evento (SYS-07: el elemento y su razón, a la vista).
create function constatacion_alcance_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if not exists (
    select 1 from effective_state es
    join release_elemento re on re.release_id = es.release_id and re.workspace_id = es.workspace_id
    where es.id = new.effective_state_id and es.workspace_id = new.workspace_id
      and re.elemento_id = new.elemento_id) then
    raise exception 'ese elemento no está incluido en el release que se constata';
  end if;
  if new.resultado <> 'como-aprobado' then
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'DesviacionRegistrada',
        jsonb_build_object('effectiveStateId', new.effective_state_id,
                           'elementoId', new.elemento_id, 'resultado', new.resultado,
                           'queQuedoDistinto', new.que_quedo_distinto, 'razon', new.razon),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;
create trigger constatacion_alcance
  before insert on constatacion
  for each row execute function constatacion_alcance_guard();
revoke execute on function constatacion_alcance_guard() from public;

-- ══ G7 no pasa con la conciliación incompleta (RF-06.7, criterio de aceptación 4) ══
-- El guard de suficiencia se REESCRIBE ENTERO (create or replace no fusiona): esta es la
-- versión vigente —checklist sin pendientes y no vacío, ítems cumplidos con decisiones
-- vigentes, orden de gates, criterios de G0 y arquetipos de G2— más las ramas de G6 y G7,
-- que son las dos que SPEC-06 aporta (el plan y la conciliación).
--
-- Un mismo número de gate admite reglas de specs distintas conviviendo: G6 tendrá también
-- la firma del Metric Registry (SPEC-07/SYS-22) además de esta cobertura de releases. Al
-- integrar no se busca «la regla de G6» en singular —se encuentra una y se pierden las
-- otras—: se copia el cuerpo VIVO entero y se le añade lo propio encima.
--
-- Y lo que NO se copia: los EFECTOS de aprobar un gate que dependen de que el gate ya esté
-- escrito no viven aquí. Este guard es BEFORE, así que dentro de él la fila del gate aún
-- no existe y una precondición que la consulte se rechazaría a sí misma; esos efectos van
-- en triggers AFTER propios sobre gate_instancia. Si aparecen en una versión antigua de
-- este cuerpo, su sitio ya no es este.
--
-- «Vigente» significa vigente EN `agents`, no en la rama propia, y esa es la trampa: las
-- migraciones se aplican por nombre de fichero, así que otra rama con un número MENOR que
-- se mergee después que esta seguirá corriendo antes, y este create or replace borrará su
-- regla sin decir nada. Antes de mergear hay que volver a copiar el cuerpo vivo de la
-- migración más reciente que defina esta función en `agents` y añadirle esta rama —nunca
-- reconstruirlo de memoria—, y el test de la regla ajena es la red que lo detecta: si al
-- integrar se pone rojo, no se toca, es que falta portarla.
--
-- La regla NO se duplica en el WITH CHECK de gate_update_aprobar, igual que la de G2: el
-- predicado de la política se quedó con lo que se comprueba mirando el gate y su
-- checklist. El motivo es que la política no puede DECIR por qué falla, y aquí el porqué
-- es el producto: «estos tres elementos no tienen constatación». El guard corre antes que
-- el WITH CHECK y aborta con el mensaje; que la política no lo repita no abre un camino
-- (el trigger es de la tabla, no del rol).
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
    -- El sello temporal lo pone la BASE, no el caller: un update directo no puede
    -- retro ni post-datar el registro inmutable.
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
    -- Un ítem YA cumplido cuya decisión pasó a 'en-revision' por una reapertura seguía
    -- contando como suficiencia: el gate se aprobaba sobre razonamiento cuestionado. Se
    -- re-chequea al aprobar en vez de resetear los ítems al reabrir — resetear tiraría
    -- trabajo que quizá sigue en pie, y revalidar la decisión desbloquea el gate sin
    -- tocar el checklist.
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
    -- G2 cierra el entendimiento: ningún arquetipo puede seguir siendo hipótesis, y
    -- los confirmados ya traen su evidencia (garantizada por su propio guard).
    if new.numero = 2 and exists (select 1 from arquetipo a
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where a.reto_id = p.reto_id and a.workspace_id = new.workspace_id
        and a.estado = 'hipotesis') then
      raise exception 'no se puede aprobar G2: hay arquetipos sin confirmar ni refutar (RF-04.11)';
    end if;
    -- G6 firma el PLAN (RF-06.4): «cada elemento de la design version queda asignado a
    -- exactamente un release con dueño y fecha». Que el ítem del checklist esté cumplido
    -- no lo demuestra — un ítem cumplido registra un objeto citado o un N/A razonado, y
    -- no deriva nada de release_elemento—, así que sin esto G6 certificaba un plan que
    -- podía no existir. El «exactamente uno» ya lo garantiza la PK de release_elemento; lo
    -- que faltaba era el «cada». Dueño y fecha no hay que comprobarlos: release.responsable
    -- y fecha_objetivo son not null con CHECK, así que estar asignado ya los implica.
    if new.numero = 6 then
      -- El gemelo vacuo, igual que en G7: sin design version aprobada con elementos no hay
      -- plan que firmar, y el «no exists elemento sin release» de abajo sería vacuamente
      -- cierto por no haber ningún elemento que mirar.
      if not exists (
        select 1 from design_version dv
        where dv.proyecto_id = new.proyecto_id and dv.workspace_id = new.workspace_id
          and dv.estado = 'aprobada'
          and exists (select 1 from elemento_cambio ec
            where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id)
      ) then
        raise exception 'no se puede aprobar G6: el proyecto no tiene ninguna design version aprobada con elementos que planificar (RF-06.4)';
      end if;
      if exists (
        select 1 from elemento_cambio ec
        join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
        where dv.proyecto_id = new.proyecto_id and dv.workspace_id = new.workspace_id
          and dv.estado = 'aprobada'
          and not exists (select 1 from release_elemento re
            where re.elemento_id = ec.id and re.workspace_id = ec.workspace_id)
      ) then
        raise exception 'no se puede aprobar G6: hay elementos de la design version sin release asignado (RF-06.4)';
      end if;
    end if;
    -- G7 cierra la implementación: el tablero de conciliación no puede tener NINGÚN
    -- elemento en estado desconocido (RF-06.7). Desconocido es la ausencia de
    -- constatación: sin release asignado, en un release aún planificado, o desplegado
    -- sin constatar. Un elemento constatado como 'no-implementado' NO bloquea — está
    -- explicado, que es lo que el gate exige (honestidad, no perfección).
    -- De las design versions SUPERADAS entra solo lo que dejaron EN VUELO: sus elementos
    -- sin planificar son historia de un ciclo anterior, pero un release suyo sin resolver
    -- sigue siendo trabajo abierto de ESTE proyecto (ver abajo).
    if new.numero = 7 then
      -- Primero, que HAYA tablero. El «no exists elemento en estado desconocido» de
      -- abajo es vacuamente cierto cuando no hay ningún elemento que mirar: un proyecto
      -- sin design version aprobada aprobaba G7 en cuanto su checklist y la escalera de
      -- gates estaban en orden, certificando una implementación que nadie declaró, ni
      -- repartió en releases, ni constató. Es el mismo agujero que tapa exigir ≥1 ítem
      -- de checklist («sin ítems no hay pendientes»), y la misma regla que la app ya
      -- aplica en `conciliacionCompleta([])`: un tablero vacío no está completo, está
      -- vacío. Se exige la design version APROBADA y CON elementos porque es la única
      -- que produce filas de conciliación: una aprobada sin elementos —que la transición
      -- ya no deja nacer, pero que un backfill podría dejar— volvería a vaciar el
      -- predicado sin que se note.
      if not exists (
        select 1 from design_version dv
        where dv.proyecto_id = new.proyecto_id and dv.workspace_id = new.workspace_id
          and dv.estado = 'aprobada'
          and exists (select 1 from elemento_cambio ec
            where ec.design_version_id = dv.id and ec.workspace_id = dv.workspace_id)
      ) then
        raise exception 'no se puede aprobar G7: el proyecto no tiene ninguna design version aprobada con elementos que conciliar (RF-06.7)';
      end if;
      if exists (
        select 1 from elemento_cambio ec
        join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
        where dv.proyecto_id = new.proyecto_id and dv.workspace_id = new.workspace_id
          and dv.estado = 'aprobada'
          and not exists (
            select 1 from constatacion c
            join effective_state es on es.id = c.effective_state_id and es.workspace_id = c.workspace_id
            join release r on r.id = es.release_id and r.workspace_id = es.workspace_id
            where c.elemento_id = ec.id and c.workspace_id = ec.workspace_id
              and r.estado = 'verificado')
      ) then
        raise exception 'no se puede aprobar G7: hay elementos de la design version en estado desconocido (RF-06.7)';
      end if;
      -- Y lo que la versión SUPERADA dejó en vuelo. Excluir entera a la superada dejaba
      -- este agujero: aprobar DV-2 marca DV-1 'superada' y con ella desaparecían del gate
      -- sus releases sin resolver, así que G7 podía certificar «implementación conciliada»
      -- con un release de DV-1 desplegado y sin constatar. Es el mismo argumento que
      -- separó `puedePlanificar` de `puedeCompletar` en la pantalla, y aquí obliga en el
      -- sentido contrario: el effective state del servicio se arma con las constataciones
      -- de TODOS sus releases verificados (RF-06.10), así que un despliegue sin observar
      -- es exactamente un trozo del estado certificado que nadie miró.
      --
      -- Lo que entra es el ELEMENTO en un release sin verificar, no la versión entera: un
      -- elemento de DV-1 que nadie llegó a planificar es una decisión ya reemplazada y
      -- exigirle conciliación ataría G7 a un ciclo cerrado. Y decidir «esto ya no sale»
      -- tiene forma en el modelo sin inventar un estado: se le quita el alcance al release
      -- planificado (la política lo permite mientras siga planificado) y entonces no puede
      -- desplegarse nunca —`release_transicion_guard` no despliega un release vacío—, con
      -- lo que deja de haber nada que observar. Un release VERIFICADO no hace falta
      -- mirarlo: verificarlo ya exigió constatar todos sus elementos.
      if exists (
        select 1 from elemento_cambio ec
        join design_version dv on dv.id = ec.design_version_id and dv.workspace_id = ec.workspace_id
        join release_elemento re on re.elemento_id = ec.id and re.workspace_id = ec.workspace_id
        join release r on r.id = re.release_id and r.workspace_id = re.workspace_id
        where dv.proyecto_id = new.proyecto_id and dv.workspace_id = new.workspace_id
          and dv.estado = 'superada'
          and r.estado <> 'verificado'
      ) then
        raise exception 'no se puede aprobar G7: una design version superada dejó releases sin resolver (RF-06.7)';
      end if;
    end if;
    -- Efectos INSEPARABLES de la transición, también para el UPDATE directo: la etapa
    -- homóloga se completa y el evento inmutable queda con el actor y su rol del
    -- MISMO snapshot. aprobarGate ya no los duplica: esta es la única fuente.
    update etapa_instancia set estado = 'completada'
      where proyecto_id = new.proyecto_id and workspace_id = new.workspace_id
        and numero = new.numero;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'GateAprobado',
        jsonb_build_object('gateId', new.id, 'proyectoId', new.proyecto_id,
                           'numero', new.numero),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ══ El portal alcanza la design version (SPEC-01, RF-01.5) ══
-- La migración del portal dejó el alta pendiente con nombre y apellidos: «design version
-- y post mortem entran al arco cuando lleguen con sus specs». SPEC-06 la trae, y sin este
-- bloque el objeto MÁS comentable de la cadena —lo que se decidió cambiar, que es
-- exactamente sobre lo que el cliente opina— era el único que no admitía hilo.
--
-- Se hace aquí y no editando la migración del portal porque aquella ya está aplicada: las
-- migraciones son forward-only. Y se hace DESPUÉS de crear design_version, que es lo que
-- permite que la FK compuesta exista de verdad.

-- El arco es EXCLUSIVO y el CHECK cuenta cuántas columnas van llenas, así que hay que
-- reemplazarlo: con la columna nueva a null y las otras cuatro también, un hilo de design
-- version daría num_nonnulls = 0 y la fila se rechazaría. Se localiza por su definición y
-- no por un nombre adivinado — el CHECK del portal es anónimo, y su nombre generado es un
-- detalle de implementación que nadie escribió.
do $$
declare v_check text;
begin
  select conname into strict v_check from pg_constraint
  where conrelid = 'hilo_comentario'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%num_nonnulls%';
  execute format('alter table hilo_comentario drop constraint %I', v_check);
end $$;

alter table hilo_comentario add column design_version_id uuid;
alter table hilo_comentario
  add constraint hilo_comentario_objeto_unico
    check (num_nonnulls(reto_id, proyecto_id, gate_id, evidencia_id, design_version_id) = 1),
  add foreign key (design_version_id, workspace_id) references design_version (id, workspace_id);

-- Las columnas generadas no admiten cambio de expresión en 16 (SET EXPRESSION llegó en
-- 17), así que se rehacen. Recalcular no pierde nada: son proyección pura de las columnas
-- del arco, y siguen sin poder escribirse — que es lo que impide falsear a qué objeto
-- apunta un hilo. Al dropearlas se va con ellas el índice que las usa; vuelve idéntico.
alter table hilo_comentario drop column objeto_tipo, drop column objeto_id;
alter table hilo_comentario
  add column objeto_tipo text generated always as (
    case
      when reto_id is not null then 'reto'
      when proyecto_id is not null then 'proyecto'
      when gate_id is not null then 'gate_instancia'
      when evidencia_id is not null then 'evidencia'
      when design_version_id is not null then 'design_version'
    end
  ) stored,
  add column objeto_id uuid generated always as (
    coalesce(reto_id, proyecto_id, gate_id, evidencia_id, design_version_id)
  ) stored;
create index hilo_objeto_idx on hilo_comentario (workspace_id, objeto_tipo, objeto_id, creado_en, id);

-- Sin políticas ni grants nuevos a propósito: las del portal no miran QUÉ objeto cuelga
-- del hilo —quién puede abrirlo y comentarlo es cuestión de rol, no de objeto— y el grant
-- de INSERT es de tabla, así que la columna nueva entra sin ampliar ningún permiso. La
-- design version no añade una regla de portal distinta: añade un objeto al arco.

-- ══ Grants mínimos (UPDATE por columnas) ══
grant select, insert on design_version, elemento_cambio to designio_app;
grant select, insert on elemento_decision, elemento_insight to designio_app;
grant select, insert on release, release_elemento to designio_app;
grant select, insert on effective_state, constatacion to designio_app;
-- La aprobación mueve estado, autor y snapshot, y el borrador puede reenlazar su journey
-- (design_version_enlazar_journey). `aprobada_en` NO está: lo escribe solo el guard, así
-- que la promesa «el sello lo pone la base» es estructural, no una disciplina del
-- servicio. `supera_a` entra por el mismo motivo que `journey_id`: la sucesión se declara
-- al abrir el borrador, pero el servicio puede aprobar otra versión mientras tanto —o la
-- declarada puede perder su propia carrera de sucesión, que el índice parcial admite
-- expresamente— y sin poder reapuntarla el borrador quedaría muerto. Tampoco están
-- `titulo`, `resumen`, `servicio_id` ni `proyecto_id`: de un borrador solo se corrige a
-- qué grafo apunta y a qué versión sucede.
grant update (estado, aprobada_por, snapshot_id, journey_id, supera_a) on design_version to designio_app;
-- El release mueve estado y la fecha real de despliegue; nunca su código, su dueño ni
-- su design version (eso sería otro release).
grant update (estado, desplegado_en) on release to designio_app;
-- El elemento se corrige mientras la DV está en borrador; jamás cambia de design
-- version (la política ya lo impediría; el grant lo hace imposible de intentar).
grant update (tipo, operacion, titulo, detalle, nodo_id, orden) on elemento_cambio to designio_app;
grant delete on elemento_cambio, elemento_decision, elemento_insight to designio_app;
grant delete on release_elemento to designio_app;
-- Sin DELETE en design_version, release, effective_state ni constatacion: los cuatro
-- objetos de resultado son el registro de lo que pasó.
