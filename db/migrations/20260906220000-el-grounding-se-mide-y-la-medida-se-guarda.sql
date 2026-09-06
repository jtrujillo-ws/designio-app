-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- RF-08.7 — EL GROUNDING SE MIDE, Y LA MEDIDA SE GUARDA
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- SPEC-08 RF-08.7 pide «muestreo periódico de propuestas ACEPTADAS —fidelidad de citas,
-- afirmaciones no soportadas, tasa de corrección, contradicciones— con reporte por release», y
-- su criterio 4 añade lo que obliga a que esto sea una TABLA y no un informe que se imprime:
-- las cifras van «comparadas contra la corrida anterior». Una corrida que sólo se pinta no
-- cumple ese criterio, porque no deja contra qué comparar la siguiente.
--
-- Y §17 dice cuál es la alarma: «fidelidad que no mejora ENTRE RELEASES del producto». O sea
-- que la comparación no es un extra del criterio 4: es la métrica.
--
-- ── QUÉ ESTAMPA UNA CORRIDA, y por qué no es `release` ──
--
-- «Release del producto» no existe como objeto en este repositorio. `release` sí es una tabla,
-- y es OTRA COSA: el release de una design version dentro de un workspace. Estampar la corrida
-- con ella habría atado una métrica de la capa AI a un objeto del método que se mueve por
-- razones que no tienen nada que ver — y confundir dos cosas que se llaman igual es la avería
-- que este repositorio lleva pagando toda la épica.
--
-- Lo que SÍ existe y es exactamente lo que mueve el grounding es `PROMPT_VERSION`: la constante
-- que cambia cuando cambia el contrato, el sistema o los prompts, y que ya viaja en el lineage
-- de cada propuesta desde la Fase 0. La corrida se estampa con ella. El día que el producto
-- tenga versión propia, esta columna se acompaña; hoy inventarla sería un dato que nadie
-- escribe y que todo el mundo creería.
create table corrida_eval (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  /*
   * La versión de la capa AI que se midió, y a la vez EL FILTRO de la corrida: se miden las
   * propuestas aceptadas cuyo `prompt_version` es ésta, no todas las del workspace.
   *
   * Es lo que hace comparables dos corridas, que es la pregunta de §17 —«fidelidad que no
   * mejora entre releases»—. Midiendo todo lo aceptado, una corrida de hoy respondería con el
   * grounding de tres versiones mezcladas y la mejora de la última quedaría diluida en la
   * inercia de las anteriores; peor aún, la cifra se movería sola cuando lo viejo envejece,
   * sin que nadie hubiera cambiado nada.
   *
   * Y cierra de paso un hueco de medición: `materialDelPanelEsElDelModelo` devuelve «no se
   * sabe» cuando la propuesta es de OTRA versión de prompt, así que una corrida que mirara
   * todo se encontraría el día del cambio de versión con casi todas sus citas sin veredicto —
   * exactamente el día en que §17 quiere comparar.
   *
   * Lo que esto cuesta, y se dice en el informe en vez de esconderlo: la primera corrida
   * después de un cambio de versión mide poco, porque hay pocas propuestas aceptadas de la
   * versión nueva. El denominador guardado es lo que deja verlo.
   */
  prompt_version text not null check (btrim(prompt_version) <> '' and length(prompt_version) <= 100),
  corrida_en timestamptz not null default now(),
  creado_por uuid not null references usuario(id),
  unique (id, workspace_id)
);
create index corrida_eval_ws_idx on corrida_eval (workspace_id, corrida_en desc);

-- ── LA MEDICIÓN, CON SU DENOMINADOR ──
--
-- Se guarda el par y no la tasa. Una tasa sin denominador no se puede comparar entre corridas:
-- un 100 % sobre dos casos y un 100 % sobre doscientos no dicen lo mismo, y §17 pide justamente
-- comparar. Además, dividir al leer deja la división en un solo sitio.
create table medicion_eval (
  corrida_id uuid not null,
  workspace_id uuid not null references workspace(id),
  /*
   * Las CUATRO de §17, y ninguna más: el catálogo vive en el registro de la capa AI y esta
   * lista se compara contra él con un censo, porque es la cuarta vez en esta épica que una
   * enumeración escrita a mano en una migración se queda atrás de lo que declara el código.
   *
   * `suelo-presencia-literal` NO se llama «fidelidad», y ese nombre es la mitad del trabajo.
   * La fuente lo dice en §9: «la presencia de una cita no equivale a grounding correcto», y la
   * fidelidad que ahí se pide es «la cita dice lo que el objeto afirma», que es un juicio. Lo
   * que este repositorio sabe medir sin llamar a nadie es si el fragmento APARECE en el
   * material, que es un suelo: una cita que ni siquiera aparece no puede ser fiel. Publicarlo
   * como «fidelidad» dejaría que el nombre hiciera el trabajo que la medición no hace.
   *
   * Y `contradicciones` SÍ se mide, contra lo que decía la primera versión de este comentario.
   * Escribí aquí que no tenía definición operativa en el repositorio y era falso: `contradiccion`
   * existe desde `20260902080000-insight-decision.sql` —«evidencia que CONTRADICE al insight; se
   * registra y se muestra siempre, jamás bloquea» (RF-03.9)—, el contenido de C2 la lleva como
   * campo obligatorio y `materializarInsight` la escribe al aceptar. Afirmar que faltaba, sin
   * haber mirado la tabla, es exactamente la avería que esta épica lleva pagando: si se afirma,
   * se mide.
   */
  metrica text not null check (metrica in (
    'suelo-presencia-literal',
    'afirmaciones-no-soportadas',
    'correccion-humana',
    'contradicciones'
  )),
  /* La capacidad, o `TODAS` para el agregado del workspace. Se guarda desagregado porque una
   * media entre capacidades esconde justo lo que hay que ver: una que empeora sola. */
  capacidad text not null check (btrim(capacidad) <> '' and length(capacidad) <= 20),
  /*
   * Y los dos NULOS a la vez, que es lo que hace visible una métrica SIN UNIVERSO.
   *
   * No toda métrica tiene algo que contar en toda capacidad: `afirmaciones-no-soportadas` y
   * `contradicciones` se miden sobre objetos —`afirmacion` con sus citas, `contradiccion`— que
   * hoy solo nacen de C2, y las demás capacidades no materializan nada con esa forma. La fila
   * SE ESCRIBE igualmente con las dos cifras en null: la métrica aparece en el informe, con su
   * hueco a la vista y por capacidad, en vez de desaparecer de la tabla y dejar que un informe
   * de tres parezca completo. Un cero diría «medido y salió cero», que es otra cosa.
   *
   * Los dos juntos o ninguno, como `tokens_entrada`/`tokens_salida` en `llamada_ai` y por la
   * misma razón: media medición no es una medición, es un número que engaña al compararlo.
   */
  numerador integer,
  denominador integer,
  /*
   * Y CUÁNTOS CASOS LA CORRIDA NO PUDO JUZGAR.
   *
   * Es la misma razón por la que se guarda el denominador, un paso más allá. Una tasa sin su
   * denominador no se puede comparar; un denominador que EXCLUYÓ casos en silencio tampoco, y
   * ese es el caso real del suelo de presencia: cuando el material que se recompone hoy ya no
   * es el que vio el modelo, la cita no tiene veredicto —medirla contra el estado de hoy pinta
   * en verde lo que una edición ajena añadió y en rojo lo que borró—. Sin esta columna, una
   * corrida en la que todo el material se editó sale `0/0`, que se lee igual que «este
   * workspace no aceptó ninguna propuesta»: dos situaciones opuestas con la misma cara.
   *
   * Nulo exactamente cuando la métrica no tiene universo, para que las tres cifras cuenten la
   * misma historia; cero es la respuesta normal de las métricas que sí saben juzgar todos sus
   * casos, y es un dato, no un hueco.
   */
  sin_veredicto integer,
  primary key (corrida_id, metrica, capacidad),
  foreign key (corrida_id, workspace_id) references corrida_eval (id, workspace_id) on delete cascade,
  constraint medicion_eval_par_completo check (
    (numerador is null) = (denominador is null) and (numerador is null) = (sin_veredicto is null)
  ),
  constraint medicion_eval_rango check (
    numerador is null or (numerador >= 0 and denominador >= numerador and sin_veredicto >= 0)
  )
);

create index medicion_eval_corrida_idx on medicion_eval (workspace_id, corrida_id);

-- ── Y la congelación por disposición, que abre en toda tabla de workspace ──
--
-- Tiene su propio censo en la suite —«el guard de congelación es el PRIMER trigger de fila en
-- cada tabla que cubre»— y fue el que las listó a las dos al correr la suite por primera vez.
-- El prefijo `a_` no es decorativo: Postgres dispara los triggers de fila por orden alfabético
-- de nombre, así que ése es el mecanismo por el que este guard va delante de cualquier otro que
-- se añada después. Un archivo que congela el workspace tiene que congelar TODO lo que lleva su
-- id, y la corrida de grounding lo lleva.
create trigger a_congelacion_por_disposicion
  before insert or update or delete on corrida_eval
  for each row execute function congelacion_por_disposicion_guard();
create trigger a_congelacion_por_disposicion
  before insert or update or delete on medicion_eval
  for each row execute function congelacion_por_disposicion_guard();

alter table corrida_eval enable row level security;
alter table medicion_eval enable row level security;

-- Leerlas es de todo miembro, como la auditoría de lo que la AI hizo: una medida de grounding
-- que sólo ve quien la corre no gobierna nada. Lo que la corrida NO lleva es material: son
-- recuentos, así que aquí no hay pasaje que recortar ni derecho de uso que releer.
create policy corrida_eval_select on corrida_eval
  for select using (is_workspace_member(app_user_id(), workspace_id));
create policy medicion_eval_select on medicion_eval
  for select using (is_workspace_member(app_user_id(), workspace_id));

-- Escribirlas es de quien lleva el workspace. Y sólo INSERT: una corrida es un hecho fechado,
-- así que no se edita ni se borra — corregir una medición es correr otra, que es la misma
-- doctrina del libro de costos y de `evento_dominio`.
create policy corrida_eval_insert on corrida_eval
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and creado_por = app_user_id()
  );
create policy medicion_eval_insert on medicion_eval
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
    and exists (
      select 1 from corrida_eval c
      where c.id = corrida_id and c.workspace_id = medicion_eval.workspace_id
    )
  );

grant select, insert on corrida_eval to designio_app;
grant select, insert on medicion_eval to designio_app;

-- ── Y LA PREMISA DE ESOS GUARDS: READ COMMITTED PARA ESCRIBIR ──
--
-- El guard de congelación toma el candado del workspace y RELEE, y esa relectura sólo dice la
-- verdad si cada sentencia abre instantánea nueva — que es lo que hace READ COMMITTED y no
-- REPEATABLE READ. El nivel lo elige quien llama, así que la premisa se comprueba en la base en
-- vez de confiarse: un cliente que abriera `repeatable read` escribiría con el guard mirando una
-- foto vieja.
--
-- Lo listó el tercer censo que estas dos tablas rompieron al nacer —los otros dos fueron el
-- catálogo de exportación y el orden del guard de congelación—, y los tres dicen lo mismo: una
-- tabla nueva del workspace llega con obligaciones, y la única forma de no olvidarlas es que
-- fallen pruebas que las derivan del catálogo en vez de una lista escrita a mano.
--
-- Mismo bucle idempotente que las migraciones anteriores, y repetido en vez de extraído por la
-- razón que dejó escrita la de la oportunidad: una función «reinstala los triggers de
-- infraestructura» invitaría a llamarla desde sitios donde lo que hace falta es pensar qué tabla
-- se añadió.
do $$
declare r record;
begin
  for r in
    with disparadoras as materialized (
      select distinct t.tgfoid as oid, t.tgrelid::regclass::text as tabla
      from pg_trigger t
      where not t.tgisinternal
    )
    select distinct d.tabla
    from disparadoras d
    join pg_proc p on p.oid = d.oid
    where p.prokind = 'f'
      and p.pronamespace = 'public'::regnamespace
      and pg_get_functiondef(p.oid) ~* '(pg_advisory_xact_lock|for +(share|update|no key update))'
      and p.proname <> 'exigir_aislamiento_de_escritura'
    order by 1
  loop
    if not exists (
      select 1 from pg_trigger t
      where t.tgrelid = r.tabla::regclass and t.tgname = 'aislamiento_de_escritura'
    ) then
      execute format(
        'create trigger aislamiento_de_escritura
           before insert or update or delete on %s
           for each statement execute function exigir_aislamiento_de_escritura()', r.tabla);
    end if;
  end loop;
end $$;
