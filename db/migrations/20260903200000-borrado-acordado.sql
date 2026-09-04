-- SPEC-01 RF-01.9 (borrado o archivo posterior a la exportación según el acuerdo, con
-- constancia verificable) + SPEC-09 RF-09.4 (retención, exportación y borrado alcanzan
-- también a los objetos derivados: insights, propuestas AI, índices, renders).
--
-- ═══ LA TENSIÓN, RESUELTA A PROPÓSITO ═══
-- `evento_dominio` es la auditoría append-only y es `workspace_id not null references
-- workspace(id)`: el libro que probaría el borrado cuelga de la fila que el borrado
-- destruiría. No se puede borrar todo y conservar la constancia dentro del mismo ámbito.
-- Se resuelve así, y conviene decir por qué cada pieza y no las alternativas:
--
--  · **La fila `workspace` no se destruye nunca: queda como LÁPIDA.** Un `workspace` es
--    `(id, nombre, creado_en)`; el contenido son las ~50 tablas que cuelgan de él.
--    Destruir la fila destruiría el ancla de toda referencia del esquema —incluida la
--    constancia que acredita la destrucción— y dejaría el borrado sin libro. Conservarla
--    no es una concesión: es la dirección donde estuvo, y es lo que permite que la
--    constancia mantenga su FK compuesta, su RLS por membresía y su sitio en el catálogo
--    de exportación. El `nombre` sí se sustituye por una etiqueta que no nombra a nadie:
--    el nombre de la organización es dato del cliente.
--  · **El `evento_dominio` del workspace SÍ se borra**: es contenido, y viajó en la
--    exportación que RF-01.8 exige entregar antes. Tras un borrado, el libro de ese
--    workspace contiene el `WorkspaceDispuesto` que emite este guard después de vaciar, y
--    normalmente nada más.
--
--    «Normalmente» y no «exactamente», porque hay una ventana medida y conviene decirla en
--    vez de prometer de más: `evento_dominio` y `exportacion_registro` quedan FUERA de la
--    congelación —un workspace archivado tiene que seguir auditando y poder re-exportarse—,
--    así que no toman el candado del workspace y una EXPORTACIÓN YA EN VUELO puede confirmar
--    sus dos filas después de que este guard vació y recontó. Sus conteos no las incluyen.
--
--    La ventana es estrecha y se cierra sola: escribir en esas dos exige membresía, y el
--    borrado la destruye, así que solo alcanza a transacciones que ya habían pasado su
--    comprobación. Y no se tapa metiéndolas en el candado, que era lo primero que se probó:
--    el guard que lo hace las convierte en tablas que serializan y releen, y eso les impone
--    READ COMMITTED — con lo que la exportación, que corre en REPEATABLE READ a propósito
--    para que su manifiesto salga de una sola foto (SYS-04), dejaría de funcionar. Medido: 18
--    casos en rojo. Cerrarla de verdad pide mover el registro de la exportación a su propia
--    transacción READ COMMITTED, que es cirugía en el slice de exportación y no en éste.
--  · **La constancia no depende de que la base la guarde.** Tras un borrado se destruyen
--    también los `miembro`, así que `is_workspace_member` es falso y RLS le niega al
--    cliente hasta la lápida: lo único que hace la constancia verificable PARA ÉL es su
--    `sello`, un sha256 de columna GENERADA que puede recomputar fuera de estas paredes.
--    Es el mismo sustrato que `archivo_importado.sha256`: identidad por hash, no por
--    promesa. Por eso el guard la DEVUELVE a quien la ejecuta, en el mismo acto.
--  · Se descartó el libro de nivel plataforma fuera del ámbito borrado: duplicaría la
--    auditoría en dos tablas con dos RLS distintas para conservar una sola fila.
--
-- ═══ «SEGÚN EL ACUERDO» = DATO, NO UNA RAMA DEL CÓDIGO ═══
-- `acuerdo_disposicion` es una bitácora versionada append-only —el patrón de
-- `consentimiento_item`—: manda el registro vigente, cambiar de opinión es una fila nueva
-- y nunca un UPDATE. El código no tiene rama por cliente: lee la modalidad vigente. Y la
-- constancia ata su modalidad a la del acuerdo por FK compuesta, el mismo truco con el que
-- `llamada_ai.consentimiento_version` quedó atada a un registro que de verdad autorizaba:
-- un número que nadie comprueba es peor que no tener número.
--
-- ═══ EL LÍMITE FÍSICO, DECLARADO ═══
-- Ningún candado abarca una petición HTTP fuera de transacción, y los bytes enviados no se
-- des-envían. El borrado hacia un proveedor externo es REMEDIACIÓN —ir a pedir que lo
-- borren— y no prevención. Por eso la constancia lleva `remediacion`: qué material salió a
-- qué modelo y cuánto de ello era material de personas, calculado desde `llamada_ai` ANTES
-- de vaciar el libro. `llamada_ai` se escribió para esto; aquí se cobra.

-- ── Premisa del sello, comprobada en vez de supuesta ──────────────────────────────────
-- El sello es una columna GENERADA, y Postgres exige que su expresión sea IMMUTABLE.
-- `convert_to(texto, 'UTF8')` está marcada STABLE porque depende del server_encoding… que
-- se fija al crear la base y no cambia jamás. Dentro de esta base la función es
-- determinista, que es exactamente lo que la columna generada necesita. La premisa no se
-- supone: se comprueba aquí, como se hizo con la del aislamiento (20260902330000).
do $$
begin
  if current_setting('server_encoding') <> 'UTF8' then
    raise exception 'esta migración exige una base en UTF8 (server_encoding = %): el sello de la constancia se declara IMMUTABLE apoyándose en que el encoding de la base es fijo, y con otro encoding esa premisa no es comprobable aquí', current_setting('server_encoding');
  end if;
end $$;

create function sello_constancia(p_carga text) returns text
language sql immutable parallel safe as $$
  select encode(sha256(convert_to(p_carga, 'UTF8')), 'hex')
$$;
comment on function sello_constancia(text) is
'sha256 hex de la carga canónica de una constancia. IMMUTABLE por la premisa comprobada en 20260903200000: el server_encoding de una base es fijo.';

-- ── Qué cubre una constancia, y qué NO ────────────────────────────────────────────────
/*
 * Vive en una función y viaja DENTRO del documento sellado porque un alcance que solo
 * estuviera en la documentación no acompaña al papel que el cliente conserva, y es
 * justamente cuando ya no tiene acceso cuando necesita saber qué se le borró y qué no.
 *
 * Y es lo que MÁS caro sale si miente, porque miente con un sello al lado. La primera
 * versión de este texto decía «cubre TODA fila» y enumeraba dos ausencias —las cuentas y
 * el material externo—, cuando en realidad sobreviven CINCO cosas: aquellas dos, el
 * acuerdo, esta misma constancia y la fila del workspace convertida en lápida, más el
 * evento que la propia disposición escribe. Una constancia así acreditaba una eliminación
 * más amplia que la ejecutada. Cada excepción existía por una razón escrita en su sitio;
 * lo que faltaba era decirlas donde el cliente las lee.
 *
 * Toma la MODALIDAD porque las dos no hacen lo mismo y un solo texto no puede ser exacto
 * para las dos: un borrado destruye el conjunto de `tablas_alcanzadas_por_borrado()`, y un
 * archivo no destruye nada y congela el de `tablas_congelables()`, que es MÁS PEQUEÑO —la
 * auditoría y el registro de exportaciones siguen escribiéndose a propósito—. Con un texto
 * único, el recibo de un archivo declaraba congelado un libro que sigue aceptando
 * escrituras.
 *
 * Las ausencias, y por qué cada una:
 *  · las CUENTAS de usuario son identidad de plataforma: la misma persona puede ser
 *    miembro de otros workspaces (en el propio seed lo es), así que la disposición de UN
 *    workspace no puede decidir el destino de una identidad que otros siguen usando. Por
 *    eso `usuario` no lleva `workspace_id` y queda fuera del conjunto cerrado por FK; el
 *    borrado de una cuenta es otra operación, con su propio acuerdo, y no ésta;
 *  · el material ya despachado a un proveedor no lo alcanza ningún candado de esta base;
 *  · el ACUERDO y la CONSTANCIA son lo que acredita el borrado: destruirlas sería destruir
 *    la prueba de lo que se hizo, y por eso `tablas_alcanzadas_por_borrado()` las excluye;
 *  · la fila de `workspace` sobrevive vaciada porque de su identificador cuelga todo lo
 *    demás, esta constancia incluida (la FK existe y es lo que la hace consultable);
 *  · y el evento que escribe la propia disposición, que es lo único que queda en el libro.
 */
create function alcance_de_constancia(p_modalidad text) returns text
language sql immutable parallel safe as $$
  select case p_modalidad
    when 'borrado' then 'Alcance (whitespace-constancia/1, borrado): se destruyó TODA fila del workspace nombrado —sus objetos, sus objetos derivados (propuestas AI, insights, journeys, design versions, mediciones) y su auditoría—, sobre el conjunto derivado del catálogo vivo de la base y no de una lista escrita a mano. SOBREVIVEN, y cada excepción es una decisión: (1) las cuentas de usuario, identidad de plataforma que puede pertenecer a otros workspaces, así que su borrado es otra operación con su propio acuerdo; (2) el material ya despachado a proveedores externos, que figura en «remediacion» y solo se retira pidiéndoselo al proveedor, porque los bytes enviados no se des-envían; (3) el acuerdo que autoriza este borrado y esta misma constancia —las tablas «acuerdo_disposicion» y «constancia_disposicion», que por eso mismo NO figuran en los conteos: lo que el borrado no alcanza no se cuenta—, que son lo que lo acredita y no pueden destruirse a sí mismas —por eso el acuerdo viaja aquí entero y sellado—; (4) la fila del propio workspace, vaciada de contenido (nombre sustituido por una lápida y cupo de llamadas AI anulado) y conservada solo como el identificador del que cuelga esta constancia; y (5) el evento de auditoría que escribe esta misma disposición, que es lo que queda en el libro tras el vaciado —y, si una exportación de este workspace estaba EN VUELO al ejecutarse, también su evento y su registro, que confirman después del recuento y que por eso no figuran en los conteos: es una ventana estrecha y declarada, no una omisión—.'
    when 'archivo' then 'Alcance (whitespace-constancia/1, archivo): NO se destruyó ninguna fila. Los conteos dicen cuántas quedan CONSERVADAS del workspace nombrado —sus objetos, sus objetos derivados (propuestas AI, insights, journeys, design versions, mediciones) y su auditoría—, sobre el conjunto derivado del catálogo vivo de la base y no de una lista escrita a mano. El acuerdo («acuerdo_disposicion») y esta constancia («constancia_disposicion») quedan fuera de esos conteos: el conjunto que se cuenta es el que un borrado alcanzaría, y a ellas no las alcanza. Quedan además CONGELADAS —ni altas, ni cambios, ni bajas— todas MENOS: (1) la auditoría («evento_dominio») y el registro de exportaciones («exportacion_registro»), que siguen aceptando escrituras porque un archivo tiene que poder decir quién lo consulta y quién lo re-exporta; (2) el acuerdo, porque registrar uno nuevo es lo que revierte un archivo, y esta constancia, que nadie puede escribir de todos modos; y (3) en «miembro», la BAJA: el alta y el cambio sí se congelan, pero revocarle el acceso a quien se fue de la organización tiene que poder hacerse siempre, o el archivo sería un permiso perpetuo. La fila del propio workspace (su nombre y su cupo de llamadas AI) ni se cuenta ni se congela: no pertenece al conjunto derivado. Fuera de alcance quedan, igual que en un borrado, las cuentas de usuario —identidad de plataforma que puede pertenecer a otros workspaces— y el material ya despachado a proveedores externos, que figura en «remediacion». Los conteos son el estado EN EL INSTANTE de certificar, comparable con el manifiesto de la exportación: después, esta misma disposición escribe su evento de auditoría, y si otra exportación de este workspace estaba EN VUELO al ejecutarse, confirmará también su evento y su fila de registro. Fuera de eso, ninguna diferencia en ninguna tabla.'

  end
$$;

-- ── La exportación previa tiene que ser INFALSIFICABLE ────────────────────────────────
/*
 * RF-01.9 exige que el archivo completo se entregue ANTES de disponer, y hasta aquí esa
 * condición se comprobaba mirando un `evento_dominio` de tipo `WorkspaceExportado`. Eso no
 * vale como prueba: la aplicación tiene grant de INSERT sobre `tipo` y `payload` y la política
 * solo pide membresía, así que CUALQUIER miembro podía escribirse el evento a mano y simular
 * una exportación que nunca se generó ni se entregó. Con eso desbloqueaba el archivo y —con la
 * segunda firma— el borrado irreversible. El esquema ya lo tenía dicho en otro sitio: la
 * migración de la procedencia del sembrado declara explícitamente que el tipo y el payload de
 * un evento son falsificables, y por eso movió su marcador a una tabla propia.
 *
 * Se hace lo mismo. La condición pasa a apoyarse en una fila que la aplicación NO puede
 * fabricar: sin grant ni política de INSERT, la escribe únicamente `registrar_exportacion`,
 * que es la misma función que autoriza la exportación. Es la diferencia entre un sello y una
 * afirmación.
 *
 * El evento se sigue emitiendo: es la auditoría legible de RF-01.6 y no cambia. Lo que cambia
 * es qué se acepta como PRUEBA.
 */
create table exportacion_registro (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  ambito text not null check (ambito in ('archivo', 'entregable')),
  ejecutado_por uuid not null references usuario(id),
  ejecutado_rol text not null,
  creado_en timestamptz not null default now(),
  -- La fila NACE incompleta —la escribe `registrar_exportacion` al autorizar— y la completa
  -- `confirmar_exportacion` al final. Solo una fila COMPLETA acredita algo: una exportación
  -- autorizada y abandonada a medias deja la fila sin completar, y la transacción que la
  -- abandona la borra al deshacerse. Es también el instante que la constancia sella como
  -- «exportado_en», porque lo que RF-01.9 pide es que la entrega haya TERMINADO antes.
  completado_en timestamptz,
  /*
   * Qué acuerdo de disposición VIO esta exportación, leído dentro de su propia instantánea.
   * `null` = no había ninguno.
   *
   * Sustituye a comparar relojes, que era una inferencia y se quedaba corta. La exportación
   * corre en REPEATABLE READ y no toma el candado del workspace, así que puede arrancar antes
   * de que el acuerdo commitee y terminar después: entonces `creado_en > acordado_en` es
   * cierto y su instantánea NO contiene ni la fila del acuerdo ni el `DisposicionAcordada`
   * que el guard escribe en la misma transacción. Al archivo le faltaban las dos cosas, y tras
   * un borrado esa auditoría desaparece para siempre.
   *
   * Un hecho de visibilidad no se infiere: se anota. Lo escribe `confirmar_exportacion`, bajo
   * la instantánea de la exportación, y la disposición exige que coincida con la versión que
   * ejecuta. Eso no deja ventana: o la exportación vio el acuerdo, o no vale.
   */
  acuerdo_version_visto integer check (acuerdo_version_visto is null
                                       or acuerdo_version_visto >= 1),
  unique (id, workspace_id)
);
comment on table exportacion_registro is
'Qué exportaciones se ejecutaron de verdad. Escribible SOLO por el propietario, a través de registrar_exportacion: es lo que la convierte en prueba de que la entrega previa a una disposición ocurrió, en vez de en una afirmación que cualquier miembro puede escribir.';

create index exportacion_registro_ws_idx
  on exportacion_registro (workspace_id, ambito, completado_en desc)
  where completado_en is not null;

alter table exportacion_registro enable row level security;

-- SELECT sí —SYS-04 exige que el archivo del propietario lleve todo lo del workspace, y la
-- exportación corre bajo RLS con el rol de aplicación, así que una tabla ilegible rompería la
-- exportación entera—. Lo que no existe, y es todo el punto, es política ni grant de INSERT,
-- UPDATE o DELETE.
create policy exportacion_registro_select on exportacion_registro
  for select using (is_workspace_member(app_user_id(), workspace_id));
grant select on exportacion_registro to designio_app;

/*
 * ── Quién escribe el registro, y por qué el evento ya no sirve de puerta ──
 *
 * La primera versión de esto dejaba la escritura en `confirmar_exportacion` y la condicionaba
 * a que ESTA transacción hubiera pasado por `registrar_exportacion`… comprobándolo contra el
 * `evento_dominio` que aquélla escribe. Y ese evento es justo el dato que el bloque de arriba
 * acaba de declarar FALSIFICABLE: la aplicación tiene grant de INSERT sobre `evento_dominio`
 * —incluidos `actor_id` y `actor_rol`— y su política solo pide membresía. Reproducido: un
 * `lead-boutique` abre transacción, se escribe a mano un `WorkspaceExportado` con su propio
 * actor y ámbito, llama a `confirmar_exportacion`, el `xmin` casa, y nace el registro que
 * desbloquea la disposición sin haber exportado nada. El agujero era el mismo que la tabla
 * venía a cerrar, una vuelta más abajo.
 *
 * Ahora la fila la escribe `registrar_exportacion` —la función que AUTORIZA— y
 * `confirmar_exportacion` solo la COMPLETA, exigiendo que la escribiera esta misma
 * transacción. Eso sí es infalsificable por el rol de aplicación, porque sobre
 * `exportacion_registro` no hay grant ni política de INSERT para nadie salvo el dueño. El
 * evento se sigue emitiendo —es la auditoría legible de RF-01.6— pero deja de sostener nada.
 *
 * ── Y qué NO acredita, dicho aquí en vez de dejarlo entender ──
 * Que el rol de aplicación tenga EXECUTE sobre `registrar_exportacion` es forzoso: esa
 * llamada ES la exportación. Así que un miembro con rol de exportación puede llamar a las dos
 * funciones por SQL crudo y producir una fila completa sin construir ni entregar un solo byte.
 * No es un descuido que se pueda cerrar desde aquí, y tampoco compra nada: esa misma persona
 * puede lanzar la exportación de verdad y tirar el resultado. Lo que la fila acredita es lo
 * que dice y nada más —que alguien CON AUTORIDAD DE EXPORTACIÓN pasó por la función que
 * autoriza, en una transacción que llegó al final—. La entrega ocurre fuera y la haría el
 * mismo rol; para acreditarla haría falta un recibo firmado por quien recibe, que es la misma
 * firma que a la constancia todavía le falta. Queda anotado junto a ella y no se finge aquí.
 */
create or replace function registrar_exportacion(p_ws uuid, p_ambito text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rol text;
begin
  if p_ambito not in ('archivo', 'entregable') then
    raise exception 'ámbito de exportación desconocido: %', p_ambito;
  end if;
  v_rol := workspace_role(app_user_id(), p_ws);
  if coalesce(v_rol, '') not in ('lead-boutique', 'admin-cliente') then
    raise exception 'solo lead-boutique o admin-cliente ejecutan la exportación del workspace'
      using errcode = 'insufficient_privilege';
  end if;
  -- Y con la cuenta activa: una desactivada a mitad de sesión conserva su membresía, así que
  -- `workspace_role` le sigue respondiendo. La exportación es la puerta que desbloquea una
  -- disposición, así que aquí también.
  if not cuenta_activa() then
    raise exception 'la cuenta que ejecuta la exportación no está activa'
      using errcode = 'insufficient_privilege';
  end if;
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (p_ws, 'WorkspaceExportado', jsonb_build_object('ambito', p_ambito),
          app_user_id(), v_rol);
  -- La mitad nueva: el registro nace aquí, incompleto. Nadie más puede escribir esta fila.
  insert into exportacion_registro (workspace_id, ambito, ejecutado_por, ejecutado_rol)
  values (p_ws, p_ambito, app_user_id(), v_rol);
  return v_rol;
end $$;

create function confirmar_exportacion(p_ws uuid, p_ambito text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer;
begin
  -- Se identifica por `xmin`, que es qué transacción escribió la fila, y no por su reloj:
  -- comparar `creado_en` contra `now()` —el inicio de la transacción— casaría también con
  -- una fila de otra transacción concurrente que arrancara a la vez. `xmin` responde
  -- exactamente la pregunta que hay que hacer. Vale porque `conUsuario` abre UNA transacción
  -- y nadie usa savepoints: con ellos `xmin` sería el subxid y esto dejaría de casar.
  --
  -- Y no se vuelve a comprobar el rol: lo comprobó `registrar_exportacion` al escribir la
  -- fila que este update busca, y `ejecutado_rol` lo guarda. Repetirlo sería dar por buena la
  -- respuesta de `workspace_role` AHORA para una fila autorizada ANTES; con la fila delante,
  -- la autorización ya está acreditada.
  update exportacion_registro
     set completado_en = clock_timestamp(),
         -- Bajo REPEATABLE READ —como corre la exportación— toda la transacción comparte
         -- instantánea, así que este `max` es literalmente «el último acuerdo que este
         -- archivo pudo ver», se lea antes o después del volcado.
         acuerdo_version_visto = (select max(a.version) from acuerdo_disposicion a
                                  where a.workspace_id = p_ws)
   where workspace_id = p_ws and ambito = p_ambito
     and completado_en is null
     and xmin = pg_current_xact_id()::xid;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'no se puede sellar una exportación que esta misma transacción no autorizó: el registro acredita una exportación completa, no una llamada suelta (filas completadas: %)', v_n
      using errcode = 'DS004';
  end if;
end $$;

-- ── Y NO se migran los eventos viejos ─────────────────────────────────────────────────
-- Copiar aquí los `WorkspaceExportado` que ya existan sería meter en el sitio infalsificable
-- justo el dato que se acaba de declarar falsificable: el ataque quedaría consumado por la
-- migración. Una base con exportaciones previas se queda sin registro de ellas, y lo que eso
-- significa es que hay que volver a exportar antes de disponer — que es exactamente la
-- conducta correcta cuando la prueba anterior no era prueba. Fallar cerrado también cuando el
-- que falla cerrado es el upgrade.

-- ── El acuerdo, como bitácora versionada (RF-01.9 «según el acuerdo») ─────────────────
create table acuerdo_disposicion (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  -- Posición en la bitácora. La asigna el guard y NO está en el grant: si el caller
  -- pudiera escribirla, colaría un registro con versión alta y convertiría en «vigente»
  -- un acuerdo que no es el último — la reescritura que el append-only prohíbe, por la
  -- puerta de atrás. Un entero y no el timestamp: `now()` es el de la transacción, así que
  -- dos registros de la misma transacción empatarían.
  version integer not null check (version >= 1),
  modalidad text not null check (modalidad in ('archivo', 'borrado')),
  -- La REFERENCIA al acuerdo —cláusula, número de contrato, acta— en las palabras de quien
  -- lo registró; no el acuerdo entero. El tope es corto a propósito: esta columna
  -- SOBREVIVE al borrado (es lo único que nombra a las partes después, porque un contrato
  -- nombra a quien lo firma), así que sin tope sería una puerta trasera por la que colar
  -- texto libre que el borrado no alcanza. Y pasa por el mismo predicado que el material
  -- importado —controles C0/C1 y overrides bidi— invocado, no reescrito: es texto que se
  -- pinta y que perdura, la superficie exacta donde el bidi engaña.
  -- Y en UNA SOLA LÍNEA. `texto_importado_limpio` prohíbe los controles pero deja pasar
  -- tabulador, LF y CR a propósito —está pensado para material importado, que es
  -- multilínea—, y aquí eso sería una puerta: esta referencia se COPIA dentro de la carga
  -- canónica de la constancia, que es un campo por renglón, así que un salto de línea
  -- dejaría el documento sellado ambiguo —la misma carga podría leerse como dos juegos de
  -- campos distintos— y permitiría dibujar dentro del recibo campos que no se pactaron. Una
  -- referencia contractual («cláusula 4.2 del MSA 2026-114») no necesita renglones.
  --
  -- Y con U+2028 y U+2029 dentro, que no son controles C0 ni C1 y por eso los deja pasar
  -- `texto_importado_limpio`: SON separadores de línea Unicode, así que un `<pre>` los pinta
  -- como un salto. Sin ellos, la referencia dibujaba en pantalla lo que parecían campos de
  -- más mientras el sello seguía verificando sobre los mismos bytes — la invariante de un
  -- campo por renglón rota por la VISTA y no por la carga, que para un documento que una
  -- persona LEE es exactamente igual de grave.
  base text not null check (
    length(btrim(base)) between 1 and 300 and texto_importado_limpio(base)
    and base !~ '[\n\r\u2028\u2029]'),
  -- El rol de la parte que lo registró, sellado AQUÍ y no reconstruido después: los roles
  -- cambian, y un acuerdo dice quién era quién CUANDO se acordó. Es la mitad que hace
  -- comprobable la doble firma del borrado. Lo escribe el guard y está fuera del grant.
  acordado_rol text not null check (acordado_rol in ('lead-boutique', 'admin-cliente')),
  -- La RETENCIÓN de RF-09.4, como dato: antes de esta fecha la disposición no se ejecuta.
  -- Es lo que impide que un borrado irreversible sea un clic: hay acuerdo, hay espera y
  -- hay exportación entregada, las tres comprobadas por el mismo predicado.
  efectivo_desde date not null,
  acordado_por uuid not null references usuario(id),
  acordado_en timestamptz not null default now(),
  unique (id, workspace_id),
  -- El suelo de la bitácora: dos registros no pueden ocupar la misma posición. Es lo que
  -- convierte «leí el máximo y sumé uno» en algo seguro aunque dos partes registren a la
  -- vez (el servicio las serializa con el candado del workspace; esto es lo que pasa si
  -- alguien llega por otro camino).
  unique (workspace_id, version),
  -- Redundante como clave (`modalidad` depende funcionalmente de las dos de arriba) y aun
  -- así necesaria: es lo que hace EXPRESABLE la FK de la constancia, que no cita un
  -- acuerdo cualquiera sino el que pactó ESA modalidad. Una FK solo puede apuntar a un
  -- índice único, así que la condición viaja como columna dentro de la clave. Sin esto,
  -- «se ejecutó lo acordado» tendría que comprobarlo un guard, y un guard es una
  -- comprobación que hay que acordarse de escribir.
  unique (workspace_id, version, modalidad)
);

-- ── La constancia verificable (RF-01.9) ───────────────────────────────────────────────
create table constancia_disposicion (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  acuerdo_version integer not null check (acuerdo_version >= 1),
  /*
   * ── Y el acuerdo ENTERO, no solo su número ──
   * Un `acuerdo_version = 2` no dice nada fuera de esta base. Y fuera de esta base es
   * exactamente donde vive una constancia: tras un borrado no queda membresía, así que lo
   * único que le queda a cada parte es el documento sellado que conserva. Con la versión
   * sola, ese documento acreditaba QUE se ejecutó una disposición y no CUÁL — ni bajo qué
   * base contractual, ni desde cuándo podía ejecutarse, ni quién puso la primera firma. La
   * doble firma es la garantía central de un borrado irreversible; sin el firmante dentro
   * del sello, la constancia acredita una sola de las dos voluntades: la de quien ejecutó.
   *
   * Se COPIAN, no se referencian: la fila del acuerdo sobrevive al borrado, pero solo la
   * ve quien la firmó (su RLS), y el sello tiene que valer con el papel en la mano y sin
   * base delante. Un recibo que hay que ir a cotejar contra el sistema que certifica su
   * propia destrucción no es un recibo.
   */
  acuerdo_base text not null check (
    length(btrim(acuerdo_base)) between 1 and 300
    and acuerdo_base !~ '[\n\r\u2028\u2029]'),
  -- La fecha efectiva viaja como TEXTO en ISO, y no como `date`, por la misma razón que los
  -- dos instantes: lo que entra en el sello tiene que ser BYTES fijos. `date::text` y
  -- `to_char(date, …)` son STABLE —dependen de `DateStyle`, que es de sesión—, así que
  -- Postgres los rechaza en una columna generada (medido) y, aunque los aceptara, el mismo
  -- día daría dos textos distintos según quién mirara. Se guarda el renglón que el documento
  -- enseña, formateado una vez al emitirlo.
  acuerdo_efectivo_desde text not null
    check (acuerdo_efectivo_desde ~ '^\d{4}-\d{2}-\d{2}$'),
  acuerdo_por uuid not null references usuario(id),
  acuerdo_rol text not null check (acuerdo_rol in ('lead-boutique', 'admin-cliente')),
  modalidad text not null check (modalidad in ('archivo', 'borrado')),
  -- El instante de la exportación que la precede. RF-01.9 dice «posterior a la
  -- exportación», así que el recibo nombra CUÁL: sin esto, «se exportó antes» sería una
  -- afirmación sin referente. El guard lo lee de `evento_dominio` antes de vaciarlo, y no
  -- hay FK que apunte allí a propósito — el referente lo destruye la misma operación que
  -- se está certificando, y esa es justamente la razón de que el sello exista.
  exportado_en timestamptz not null,
  -- El inventario que la disposición ALCANZÓ, por tabla, derivado en vivo del catálogo:
  -- filas destruidas en un `borrado`, filas conservadas y congeladas en un `archivo`. La
  -- modalidad viaja en la misma fila y dentro del sello, así que no hay ambigüedad. Es la
  -- otra mitad del recibo de #15 —«cuántas EXISTÍAN y cuántas viajaron»— cerrada por el
  -- otro extremo, y es lo que hace COMPROBABLE a RF-09.4: el cliente cruza estos conteos
  -- con los de su manifiesto de exportación, tabla por tabla, derivados los dos del mismo
  -- catálogo vivo. Los objetos derivados —propuestas AI, insights, renders— entran solos,
  -- porque el conjunto no se escribe a mano.
  conteos jsonb not null,
  -- Lo que YA salió hacia fuera y este borrado no puede alcanzar: llamadas por modelo.
  remediacion jsonb not null,
  -- Cuántos ítems de la bandeja tuvieron material despachado, y cuántas de esas llamadas
  -- iban amparadas por un consentimiento (o sea: llevaban material de personas, RF-09.5).
  -- Ese es exactamente el conjunto que hay que ir a pedir al proveedor.
  remediacion_items integer not null check (remediacion_items >= 0),
  remediacion_con_consentimiento integer not null check (remediacion_con_consentimiento >= 0),
  ejecutado_por uuid not null references usuario(id),
  ejecutado_rol text not null,
  -- `clock_timestamp()` y no `now()`, que es el inicio de la TRANSACCIÓN. Bajo READ
  -- COMMITTED —que esta disposición exige— cada sentencia abre instantánea nueva, así que una
  -- transacción que arranca mientras una exportación válida está en vuelo ve su confirmación
  -- posterior y ejecuta correctamente… y sellaba un `ejecutado_en` ANTERIOR a su propio
  -- `exportado_en`. El documento se contradecía a sí mismo: certificaba haberse ejecutado
  -- antes de la exportación que declara previa. El instante que se sella tiene que ser el de
  -- escribir la fila, no el de abrir la transacción que la escribe.
  ejecutado_en timestamptz not null default clock_timestamp(),
  -- QUÉ cubre esta constancia y qué NO, dicho dentro del documento sellado y no en una
  -- página de ayuda que nadie conserva. Se almacena por fila —aunque hoy sea constante— y
  -- viaja dentro del sello porque una constancia emitida bajo este contrato tiene que
  -- seguir diciendo lo que ESTE contrato cubría, aunque una versión posterior cubra otra
  -- cosa. Lo escribe el guard; no hay grant de insert con el que contradecirlo.
  -- El tope subió de 1000 a 2000 cuando el texto pasó a decir la verdad: enumerar las cinco
  -- cosas que sobreviven a un borrado, y las cuatro que un archivo no congela, no cabe en lo
  -- que sí cabía la versión que afirmaba «TODA fila» con dos excepciones. Un tope sigue
  -- habiendo —esto es un recibo, no un anexo— y una sola línea, que es lo que mantiene
  -- inequívoca la carga sellada: cada campo ocupa exactamente un renglón.
  alcance text not null check (
    length(btrim(alcance)) between 1 and 2000
    and alcance !~ '[\n\r\u2028\u2029]'),
  -- ── El sello ──
  -- Columna GENERADA y no un trigger, y la diferencia es operativa, no estética: el
  -- borrado corre con `session_replication_role = replica` (ver abajo), así que un trigger
  -- que calculara el sello NO se dispararía durante la única operación que escribe aquí.
  -- Una columna generada no es un trigger: se aplica siempre.
  -- Qué prueba y qué NO, dicho con precisión porque la diferencia importa: es un sha256 SIN
  -- clave, así que da INTEGRIDAD, no autenticidad. Sirve para que el cliente compruebe que el
  -- documento que tiene coincide con el sello que le entregaron —contra copias corrompidas,
  -- truncadas o editadas conservando el sello original—. NO acredita que lo emitiera Designio,
  -- y no resiste a un adversario que controle el documento ENTERO: quien altere la carga puede
  -- recalcular el hash y sustituir también el sello. Para eso haría falta firmarlo con una
  -- clave cuya pública se publique, o anclar el digest en un registro independiente; queda
  -- anotado como el siguiente paso y no se finge aquí. Que la fila no se pueda reescribir lo garantiza
  -- otra cosa: no hay grant ni política de UPDATE/DELETE, ni de INSERT.
  sello text generated always as (sello_constancia(
    'whitespace-constancia/1' || E'\n'
    || id::text || E'\n'
    || workspace_id::text || E'\n'
    || modalidad || E'\n'
    || acuerdo_version::text || E'\n'
    || acuerdo_base || E'\n'
    || acuerdo_efectivo_desde || E'\n'
    || acuerdo_por::text || E'\n'
    || acuerdo_rol || E'\n'
    || extract(epoch from timezone('UTC', ejecutado_en))::text || E'\n'
    || ejecutado_por::text || E'\n'
    || ejecutado_rol || E'\n'
    || extract(epoch from timezone('UTC', exportado_en))::text || E'\n'
    || conteos::text || E'\n'
    || remediacion::text || E'\n'
    || remediacion_items::text || E'\n'
    || remediacion_con_consentimiento::text || E'\n'
    || alcance
  )) stored,
  unique (id, workspace_id),
  -- Un acuerdo se ejecuta UNA vez. Volver a disponer exige registrar un acuerdo nuevo,
  -- que es lo que hace que la bitácora cuente la historia entera.
  unique (workspace_id, acuerdo_version),
  -- «Se ejecutó exactamente lo que se acordó», atado y no afirmado.
  foreign key (workspace_id, acuerdo_version, modalidad)
    references acuerdo_disposicion (workspace_id, version, modalidad)
);

create index constancia_disposicion_ws_idx
  on constancia_disposicion (workspace_id, acuerdo_version desc);

-- ── El conjunto de tablas NO se escribe a mano: se deriva ─────────────────────────────
-- Es la misma disciplina que el catálogo de exportación y que la derivación de
-- 20260902330000, y aquí es la que hace CIERTO a RF-09.4: «el borrado alcanza también a
-- los objetos derivados» no puede depender de que alguien se acuerde de añadir la tabla
-- nueva de su slice a una lista. Se lee del catálogo de Postgres —no de
-- `information_schema`, que filtra por privilegios del que pregunta y daría un conjunto
-- distinto según quién llame— y un test estructural repite la derivación.
create function tablas_del_workspace() returns table (tabla text)
language sql stable as $$
  select c.relname::text
  from pg_class c
  join pg_attribute a on a.attrelid = c.oid
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and a.attname = 'workspace_id' and not a.attisdropped and a.attnum > 0
  order by 1
$$;

-- Lo que el borrado alcanza: todo lo del workspace MENOS la constancia y el acuerdo que la
-- sostiene. `evento_dominio` NO está excluida: la auditoría es contenido del cliente, ya
-- viajó en su exportación, y dejarla dentro sería «borramos todo menos el registro de todo
-- lo que hiciste», que es lo contrario de lo que se acordó.
create function tablas_alcanzadas_por_borrado() returns table (tabla text)
language sql stable as $$
  select t.tabla from tablas_del_workspace() t
  where t.tabla not in ('acuerdo_disposicion', 'constancia_disposicion')
$$;

-- Lo que la congelación cubre: todo lo del workspace MENOS las dos tablas de la
-- disposición (o un workspace archivado no podría acordar después su borrado) y MENOS
-- `evento_dominio` (un archivo tiene que seguir auditando quién lo consulta y quién lo
-- re-exporta; congelar el libro cegaría justo el periodo en que más importa mirarlo).
create function tablas_congelables() returns table (tabla text)
language sql stable as $$
  select t.tabla from tablas_del_workspace() t
  where t.tabla not in ('acuerdo_disposicion', 'constancia_disposicion', 'evento_dominio',
                        'exportacion_registro')
$$;

-- ── Por qué aquí NO hay un ayudante SECURITY DEFINER ──────────────────────────────────
-- Lo hubo. Las dos políticas se necesitaban mutuamente —la del acuerdo mira la constancia
-- para no cerrarle la puerta a quien la ejecutó, y la de la constancia miraba el acuerdo
-- para no cerrársela a quien lo firmó—, y una RLS que consulta la tabla cuya RLS la
-- consulta a ella es recursión infinita, que Postgres detecta y rechaza. Se cortaba con una
-- función SECURITY DEFINER, que salta la RLS por diseño y hay que vigilar como tal.
--
-- Copiar el acuerdo dentro de la constancia disolvió el ciclo por su causa: la política de
-- la constancia ya no tiene que ir a preguntar quién firmó, porque el firmante está EN LA
-- FILA. Queda una referencia de ida (la del acuerdo hacia la constancia) y ninguna de
-- vuelta, así que el ayudante sobra — y una función que salta la RLS que sobra se borra, no
-- se conserva por si acaso. Un test comprueba que no vuelve a existir.

-- ── La disposición vigente, en UN sitio ───────────────────────────────────────────────
-- Devuelve la fila entera y no solo la modalidad porque quien la consulta necesita
-- explicar POR QUÉ y DESDE CUÁNDO. Que la devuelva entera es lo que evita que el guard de
-- congelación reescriba el predicado para poder redactar su mensaje.
create function disposicion_vigente(p_ws uuid) returns constancia_disposicion
language sql stable as $$
  select c.* from constancia_disposicion c
  where c.workspace_id = p_ws
    and c.acuerdo_version = (select max(a.version) from acuerdo_disposicion a
                             where a.workspace_id = p_ws)
$$;

/*
 * ── Y por qué eso no basta: un borrado no se deshace registrando papel ──
 * `disposicion_vigente` devolvía la ÚLTIMA constancia sin mirar si su acuerdo seguía siendo
 * el vigente, y eso rompía la promesa que esta migración escribe en su primera página: que un
 * `archivo` es reversible registrando un acuerdo nuevo. No lo era. Tras archivar, registrar
 * otro acuerdo dejaba la constancia vieja gobernando, así que los guards seguían rechazando
 * toda escritura con DS001 —y con un mensaje que mandaba a registrar un acuerdo nuevo, que es
 * exactamente lo que la persona acababa de hacer—. Ejecutar el acuerdo nuevo solo añadía otra
 * constancia congelada: la única salida real era borrar.
 *
 * Atarla al acuerdo vigente lo arregla, y abre un agujero por el otro lado si se hace a
 * secas: un BORRADO sí es definitivo, así que su congelación no puede levantarse registrando
 * papel encima. Por eso la pregunta se parte en dos, que son dos preguntas distintas:
 *  · «¿rige ahora una disposición?» → la constancia del acuerdo vigente;
 *  · «¿este workspace se borró alguna vez?» → esto, que no caduca nunca.
 */
create function workspace_borrado(p_ws uuid) returns constancia_disposicion
language sql stable as $$
  select c.* from constancia_disposicion c
  where c.workspace_id = p_ws and c.modalidad = 'borrado'
  order by c.ejecutado_en limit 1
$$;

-- ── Congelación: lo que el acuerdo decide tiene efecto observable ─────────────────────
/*
 * Si `archivo` no impidiera nada, la modalidad sería una etiqueta y el acuerdo dejaría de
 * ser dato. Y en `borrado` la congelación es lo que impide que la constancia PASE a
 * mentir: sin ella se podría repoblar un workspace vaciado y el recibo seguiría diciendo
 * cero. Un mismo mecanismo cubre las dos.
 *
 * ── Por qué el candado, y por qué compartido ──
 * El candado NO está aquí para decidir: está para que la disposición y los escritores en
 * vuelo se excluyan. Sin él, un escritor que commitea entre el recuento de la disposición
 * y su commit deja filas vivas en un workspace cuya constancia acaba de certificar que no
 * queda ninguna — y ningún recuento posterior lo atraparía, porque ya se hizo. Se toma el
 * consultivo COMPARTIDO del workspace (la fuente de la que deriva el conjunto entero que
 * la disposición va a leer) y la disposición toma el EXCLUSIVO del mismo objeto: los
 * escritores no se estorban entre sí y sí se excluyen con ella. Consultivo y no de fila
 * porque un consultivo y uno de fila sobre el mismo objeto no se ven entre sí, y el resto
 * de esta base ya serializa con consultivos `designio:<objeto>:`.
 *
 * Y va ANTES de comprobar. Bloquear después dejaría exactamente la misma ventana: quien
 * lee y luego espera decide con la foto vieja, y esperar sin releer es esperar para nada.
 *
 * ── Por qué el trigger se llama `a_…` ──
 * Postgres dispara los triggers de fila en orden de NOMBRE. Este tiene que tomar el
 * candado del workspace antes de que cualquier otro guard de la misma tabla tome los
 * suyos (fila del reto, del item, del gate…): si otro llegara primero, un escritor podría
 * quedarse esperando el candado del workspace mientras retiene una fila que la disposición
 * necesita borrar — abrazo mortal, detectado por Postgres pero evitable. El prefijo `a_`
 * lo pone delante de todos los que hay, y un test estructural comprueba que sigue siendo
 * el primero en cada tabla cubierta: así deja de ser una convención frágil.
 */
create function congelacion_por_disposicion_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- LOS DOS workspaces de la operación, no uno. En un UPDATE hay origen y destino, y mirar
  -- solo el destino deja abierta la puerta de atrás: quien sea miembro de los dos puede MOVER
  -- una fila fuera de un workspace archivado a uno vivo, el guard comprueba el activo y lo da
  -- por bueno. La promesa «se conserva para consulta y no admite escrituras» se rompería por
  -- EXTRACCIÓN en vez de por escritura, que es la misma pérdida por otra puerta. `segmento` es
  -- la superficie exacta: su grant de UPDATE incluye `workspace_id` y su política es solo de
  -- membresía. Y el otro caso que cierra: una actualización concurrente que saca filas de un
  -- workspace mientras se está borrando, sin competir nunca por su candado.
  --
  -- Ordenados, que no es cosmética: al tomar DOS candados hace falta un orden total o dos
  -- movimientos en sentidos opuestos se abrazan. Se ordena por el uuid, que es el mismo orden
  -- para todo el mundo.
  v_wss uuid[] := case tg_op
    when 'INSERT' then array[new.workspace_id]
    when 'DELETE' then array[old.workspace_id]
    else case when new.workspace_id is distinct from old.workspace_id
           then array(select unnest(array[old.workspace_id, new.workspace_id]) order by 1)
           else array[new.workspace_id] end
  end;
  v_ws uuid;
  v_disp constancia_disposicion;
begin
  foreach v_ws in array v_wss loop
    -- Anti-oráculo, y por workspace. En un INSERT los triggers BEFORE corren ANTES del WITH
    -- CHECK de la política, así que sin esto un no-miembro que intentara escribir en un
    -- workspace ajeno aprendería si está archivado o borrado —la política lo rechazaría igual,
    -- pero lo que se filtra no es la fila, es la respuesta—. Se distingue al llamante por
    -- `session_user` y no por `current_user`, que bajo SECURITY DEFINER es siempre el dueño: la
    -- escritura privilegiada sí recibe la regla, que es el suelo del SQL directo.
    --
    -- `continue` y no `return`: en un movimiento entre dos workspaces, no ser miembro de uno no
    -- puede callar la regla del otro.
    if session_user = 'designio_app'
       and not is_workspace_member(app_user_id(), v_ws) then
      continue;
    end if;

    perform pg_advisory_xact_lock_shared(hashtextextended('designio:workspace:' || v_ws, 42));
    -- Primero lo que no caduca. Un borrado es definitivo, así que su congelación NO se
    -- levanta registrando un acuerdo encima; si se preguntara solo por el acuerdo vigente,
    -- bastaría con registrar papel para poder repoblar un workspace cuya constancia certifica
    -- que quedó vacío — y entonces el recibo pasaría a mentir, que es lo que la congelación
    -- existe para impedir.
    v_disp := workspace_borrado(v_ws);
    if v_disp.id is not null then
      raise exception 'este workspace se borró por acuerdo el % : solo queda su constancia (sello %)',
        to_char(v_disp.ejecutado_en, 'YYYY-MM-DD'), v_disp.sello using errcode = 'DS001';
    end if;
    -- Y después lo que sí: un archivo rige mientras su acuerdo siga siendo el vigente. En
    -- cuanto se registra uno nuevo, la congelación se levanta — que es la reversibilidad que
    -- la modalidad promete, y el mensaje de abajo indica.
    v_disp := disposicion_vigente(v_ws);
    if v_disp.id is not null and v_disp.modalidad = 'archivo' then
      raise exception 'este workspace está archivado por acuerdo desde el % : se conserva para consulta y no admite escrituras. Cambiar su disposición exige registrar un acuerdo nuevo',
        to_char(v_disp.ejecutado_en, 'YYYY-MM-DD') using errcode = 'DS001';
    end if;
  end loop;
  return case tg_op when 'DELETE' then old else new end;
end $$;

revoke execute on function congelacion_por_disposicion_guard() from public;

do $$
declare
  r record;
  v_eventos text;
begin
  for r in select tabla from tablas_congelables() loop
    -- ── Excepción DECLARADA, no un efecto colateral de la derivación ──
    -- En `miembro` la congelación cubre INSERT y UPDATE, pero NO DELETE. Revocar un acceso
    -- tiene que poder hacerse siempre: un workspace archivado durante años no puede
    -- quedarse sin forma de quitarle la entrada a quien se fue de la organización cliente,
    -- y congelar esa salida convertiría el archivo en un permiso perpetuo. Dar entrada
    -- NUEVA a un workspace ya dispuesto sí es una escritura que el acuerdo cerró, así que
    -- el INSERT se congela igual. (Hoy el rol de aplicación ni siquiera tiene grant de
    -- DELETE sobre `miembro`, así que el efecto práctico es sobre el camino administrativo;
    -- se escribe la excepción para que el día que ese grant exista, la salida ya esté.)
    v_eventos := case r.tabla
                   when 'miembro' then 'insert or update'
                   else 'insert or update or delete'
                 end;
    execute format(
      'create trigger a_congelacion_por_disposicion
         before %s on %I
         for each row execute function congelacion_por_disposicion_guard()',
      v_eventos, r.tabla);
  end loop;
end $$;


-- ── Registrar un acuerdo: la posición y el sello temporal los pone la base ────────────
create function acuerdo_disposicion_registro_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  -- La cuenta activa, por el mismo motivo que en la ejecución y en la exportación: el grant de
  -- insert sobre esta tabla permite registrar un acuerdo por SQL crudo, y `is_workspace_member`
  -- no mira `usuario.estado`. Un acuerdo es la primera de las dos firmas de un borrado.
  if not cuenta_activa() then
    raise exception 'la cuenta que registra el acuerdo de disposición no está activa'
      using errcode = 'insufficient_privilege';
  end if;
  -- EL CANDADO VA AQUÍ, no solo en el servicio. El grant de insert permite escribir en esta
  -- tabla por SQL directo, saltándose la capa que lo tomaba, y entonces el registro puede
  -- confirmar con una ejecución EN VUELO — después de que validó el acuerdo anterior y antes
  -- de que relea el vigente—, haciéndole ejecutar un acuerdo nuevo sin volver a comprobar su
  -- retención, su exportación, su doble firma ni la modalidad que se vio en la pantalla.
  --
  -- El guard es el camino que cubre TODO insert; el servicio solo cubre el suyo. Es la misma
  -- lección que la de la exportación falsificable: lo que sostiene una promesa tiene que estar
  -- donde no se pueda rodear. Y de paso hace estructural lo que el índice único de
  -- `(workspace_id, version)` solo atrapaba a posteriori: leer el máximo y sumar uno es seguro
  -- porque nadie más está leyéndolo a la vez.
  perform pg_advisory_xact_lock(hashtextextended('designio:workspace:' || new.workspace_id, 42));
  -- `clock_timestamp()` y no `now()`: `now()` es el inicio de la TRANSACCIÓN, y entre ese
  -- instante y este insert cabe una espera —la del candado de arriba, o la comprobación de la
  -- cuenta— durante la cual una exportación puede confirmar. Con `now()` el acuerdo quedaría
  -- fechado ANTES de esa exportación, y la comprobación de «la exportación es posterior al
  -- acuerdo» la aceptaría: se dispondría sin haber exportado el estado que se acordó disponer.
  -- El reloj del acto, no el de la puerta.
  new.acordado_en := clock_timestamp();
  new.acordado_rol := workspace_role(app_user_id(), new.workspace_id);
  new.version := coalesce(
    (select max(a.version) + 1 from acuerdo_disposicion a
      where a.workspace_id = new.workspace_id),
    1);
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (new.workspace_id, 'DisposicionAcordada',
    jsonb_build_object('version', new.version, 'modalidad', new.modalidad,
                       'efectivoDesde', new.efectivo_desde, 'base', new.base,
                       'acordadoRol', new.acordado_rol),
    app_user_id(), new.acordado_rol);
  return new;
end $$;

create trigger acuerdo_disposicion_registro
  before insert on acuerdo_disposicion
  for each row execute function acuerdo_disposicion_registro_guard();

-- Va AQUÍ, y no antes: esta derivación mira el cuerpo de los guards ya instalados, así que
-- tiene que correr cuando estén TODOS. El del registro del acuerdo toma candado y relee, y
-- colocándola más arriba se lo saltaba en silencio — la clase de omisión que esta derivación
-- existe precisamente para no cometer.
-- ── Consecuencia derivada, no descubierta: la premisa del aislamiento se amplía ───────
-- El guard de arriba toma candado y RELEE, así que cae exactamente dentro del criterio que
-- 20260902330000 fijó: toda tabla cuyos guards serializan y releen depende de que cada
-- sentencia abra instantánea nueva, y eso solo es cierto bajo READ COMMITTED. Bajo un
-- nivel más fuerte el guard tomaría el candado, esperaría a la disposición y después
-- releería una foto ANTERIOR a ella: la escritura se colaría en un workspace ya dispuesto,
-- en silencio. La comprobación se instala con LA MISMA derivación de aquella migración
-- —no una lista— sobre las tablas que aún no la tienen, y su test estructural sigue siendo
-- el juez. La consecuencia de fondo es correcta y conviene decirla en voz alta: a partir de
-- aquí, toda escritura de dominio exige READ COMMITTED. La exportación no se ve afectada
-- porque lo único que escribe es su evento en `evento_dominio`, que queda fuera.
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

revoke execute on function acuerdo_disposicion_registro_guard() from public;

-- ── El predicado ÚNICO: por qué NO se puede ejecutar ──────────────────────────────────
/*
 * Devuelve el motivo, o null si se puede. Existe una sola vez porque lo INVOCAN los dos
 * lados: el guard para rechazar y la pantalla para no ofrecer. Un espejo copiado a mano en
 * la app se queda corto en cuanto alguien toca esta función, y aquí quedarse corto
 * significa ofrecer un botón que destruye un workspace y que la base va a rechazar — o
 * peor, esconder una disposición legítimamente ejecutable.
 *
 * SECURITY DEFINER porque tiene que leer `evento_dominio` (cuya política de SELECT exige
 * rol) y la bitácora completa, con pre-chequeo anti-oráculo: a quien no es miembro se le
 * responde lo mismo que a quien pregunta por un workspace inexistente.
 */
create function disposicion_motivo_no_ejecutable(p_ws uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_rol text;
  v_ac acuerdo_disposicion;
  v_disp constancia_disposicion;
  v_export timestamptz;
begin
  if not is_workspace_member(app_user_id(), p_ws) then
    return 'El workspace no existe o no eres miembro';
  end if;
  v_rol := workspace_role(app_user_id(), p_ws);
  if coalesce(v_rol, '') not in ('lead-boutique', 'admin-cliente') then
    return 'Solo el admin del cliente o el lead de la boutique ejecutan la disposición acordada';
  end if;
  if not cuenta_activa() then
    return 'Tu cuenta no está activa: una disposición acordada la ejecuta una persona en activo';
  end if;

  -- Lo irreversible se pregunta a la función que no caduca, y no al acuerdo vigente: si no,
  -- registrar un acuerdo nuevo sobre un workspace ya borrado haría desaparecer este motivo y
  -- dejaría ejecutar una segunda disposición sobre una lápida.
  v_disp := workspace_borrado(p_ws);
  if v_disp.id is not null then
    return format('Este workspace se borró por acuerdo el %s: no queda nada de lo que disponer',
      to_char(v_disp.ejecutado_en, 'YYYY-MM-DD'));
  end if;

  select * into v_ac from acuerdo_disposicion a
    where a.workspace_id = p_ws order by a.version desc limit 1;
  if not found then
    return 'No hay acuerdo de disposición registrado: el acuerdo se registra antes de ejecutarlo, y es él quien dice si corresponde archivo o borrado (RF-01.9)';
  end if;
  if exists (select 1 from constancia_disposicion c
             where c.workspace_id = p_ws and c.acuerdo_version = v_ac.version) then
    return 'El acuerdo vigente ya se ejecutó: disponer otra vez exige registrar un acuerdo nuevo';
  end if;
  if v_ac.efectivo_desde > current_date then
    return format('El acuerdo vigente es efectivo a partir del %s: la retención acordada todavía no se ha cumplido',
      to_char(v_ac.efectivo_desde, 'YYYY-MM-DD'));
  end if;

  -- ── Doble firma para el BORRADO ──
  -- La palabra de RF-01.9 es «acordado», y si la misma parte puede escribir la fila del
  -- acuerdo Y ejecutarla, «acuerdo» es la afirmación de una sola parte: exactamente la
  -- clase de afirmación sin atar que el resto de este esquema no acepta. Así que quien
  -- registra y quien ejecuta tienen que ser partes DISTINTAS —la organización cliente
  -- (admin-cliente, RF-01.4) y la boutique que opera (lead-boutique, RF-01.1)—, y la
  -- constancia acredita entonces dos voluntades.
  --
  -- Se comprueban LAS DOS COSAS —el rol y la identidad— y no solo el rol, que es lo que
  -- había. El argumento escrito aquí era «roles distintos implica personas distintas: una
  -- persona tiene exactamente una membresía por workspace», y es falso EN EL TIEMPO: la
  -- unicidad impide dos roles a la vez, no cambiar de rol entre un acto y el otro. El acuerdo
  -- congela `acordado_rol` al firmarse, así que quien registró el borrado como admin-cliente y
  -- pasó después a lead-boutique aparecía como «la otra parte» y podía ejecutar el borrado
  -- irreversible aportando él solo las dos firmas. La identidad no cambia con el rol, y por eso
  -- es ella la que cierra el caso.
  --
  -- El `archivo` no lo exige y no es una inconsistencia: es reversible, no destruye nada, y
  -- pedir dos firmas para cerrar un workspace a escrituras sería trámite sin riesgo detrás.
  if v_ac.modalidad = 'borrado' and app_user_id() = v_ac.acordado_por then
    return 'Un borrado acordado exige constancia de las DOS partes, y este acuerdo lo registraste tú: lo ejecuta la otra parte del contrato, aunque tu rol haya cambiado desde entonces';
  end if;
  if v_ac.modalidad = 'borrado' and v_rol = v_ac.acordado_rol then
    return format('Un borrado acordado exige constancia de las dos partes: el acuerdo vigente lo registró %s, así que lo ejecuta la otra parte (%s)',
      v_ac.acordado_rol,
      case v_ac.acordado_rol when 'admin-cliente' then 'lead-boutique' else 'admin-cliente' end);
  end if;

  -- «Posterior a la exportación» (RF-01.9), comprobado y no supuesto. Y posterior AL
  -- ACUERDO, que es la mitad que se escapa: un archivo entregado antes de pactar la
  -- disposición no refleja lo que se acordó disponer, así que certificar sobre él sería
  -- certificar sobre otra cosa.
  -- Alias `xp` y no `r`: `ejecutar_disposicion` declara una variable `record r` para recorrer
  -- las tablas, y en plpgsql la variable GANA al alias de la consulta. Con `r` aquí, la
  -- referencia se resuelve contra el record sin asignar y revienta en tiempo de ejecución.
  --
  -- ── Una exportación vale como prueba si cumple LAS DOS cosas ──
  -- Haber TERMINADO —lo que RF-01.9 pide es la entrega, y una fila sin completar es una
  -- exportación autorizada y abandonada— y haber VISTO el acuerdo que se va a ejecutar.
  --
  -- Lo segundo se comprueba contra un HECHO anotado y no contra un reloj. Comparar
  -- `creado_en > acordado_en` era una inferencia, y dejaba una ventana real: la exportación
  -- corre en REPEATABLE READ y no toma el candado del workspace, así que puede arrancar entre
  -- que el guard del acuerdo fija `acordado_en` con `clock_timestamp()` y que esa transacción
  -- COMMITEA. Su instantánea no contiene entonces ni la fila del acuerdo ni el
  -- `DisposicionAcordada` que el mismo guard escribe, así que al archivo le faltan las dos —y
  -- tras un borrado esa auditoría no está en ninguna otra parte—, mientras el reloj decía que
  -- todo estaba en orden.
  --
  -- `confirmar_exportacion` anota qué acuerdo vio, bajo la instantánea de la exportación, y
  -- aquí se exige que sea EXACTAMENTE el que se ejecuta. Sin ventana y sin inferencia.
  select max(xp.completado_en) into v_export from exportacion_registro xp
    where xp.workspace_id = p_ws and xp.ambito = 'archivo'
      and xp.completado_en is not null
      and xp.acuerdo_version_visto = v_ac.version;
  if v_export is null then
    -- Se distingue «no hay ninguna» de «la que hay no sirve»: el remedio es el mismo, pero
    -- quien ya exportó merece saber por qué no le vale.
    if exists (select 1 from exportacion_registro xp
               where xp.workspace_id = p_ws and xp.ambito = 'archivo'
                 and xp.completado_en is not null) then
      return format('La última exportación completa del archivo no llegó a VER el acuerdo vigente (el #%s): se generó sobre una foto que no lo incluye, así que no refleja lo que se acordó disponer. Vuelve a exportar el archivo completo y ejecútalo después',
        v_ac.version);
    end if;
    return 'Falta la exportación previa: el archivo completo del workspace se entrega ANTES de disponer de él (RF-01.8/01.9)';
  end if;
  return null;
end $$;

-- ── Ejecutar la disposición ───────────────────────────────────────────────────────────
/*
 * ── Por qué el borrado corre con los triggers de dominio apagados ──
 * Un borrado acordado NO es una operación DENTRO del dominio: es su fin. Los guards de
 * este esquema existen para arbitrar la operación de un workspace vivo, y medidos contra
 * la base real, varios lo IMPEDIRÍAN o lo ensuciarían: `archivo_item_candado` rechaza
 * quitar el original de un item ya curado, `bloqueo_por_reto` rechaza borrar KPI de un
 * reto congelado, y los triggers de auditoría de journey y medición REINYECTARÍAN eventos
 * en el libro mientras se vacía. Pedirle a cada guard que sepa distinguir «me están
 * borrando» sería repartir esta decisión por 26 sitios y, sobre todo, no sería verificable
 * —el mismo argumento con el que 20260902330000 eligió comprobar la premisa en vez de
 * hacer RR-seguro cada protocolo—.
 *
 * `session_replication_role = replica` (transaction-local: `set_config(..., true)`) apaga
 * los triggers de usuario Y los de las FK durante el vaciado. Que se apaguen los de las FK
 * es seguro por una invariante de esta base, verificada contra `pg_constraint` y no
 * recordada: TODA FK entre tablas con `workspace_id` incluye `workspace_id` en los dos
 * lados, y NINGUNA tabla sin `workspace_id` referencia a una que lo tenga. El conjunto de
 * filas de un workspace es CERRADO por FK, así que borrarlo entero no deja nada colgando
 * en ninguna parte — es la invariante de tenancy de la casa cobrando intereses. Además, no
 * tener que ordenar el borrado esquiva el ciclo real que hay en el grafo
 * (`evidencia` ↔ `propuesta_ai`), que ninguna ordenación topológica puede resolver.
 *
 * Y la red de seguridad no se pierde: se cambia por una MÁS fuerte. Al terminar se recuenta
 * toda tabla con `workspace_id` —derivada en vivo— y si algo queda, la transacción entera
 * aborta. Una FK solo habría atrapado el caso en que la tabla olvidada apuntara a algo
 * borrado; el recuento atrapa la tabla olvidada, punto. Que es exactamente la promesa de
 * RF-09.4.
 */
/*
 * ── El predicado del aislamiento, en UNA función y no repetido ──
 * `20260902330000` lo dejó dicho dentro del trigger que lo impone. Aquí hace falta el MISMO
 * juicio fuera de un trigger —`ejecutar_disposicion` serializa con candado y vuelve a leer,
 * igual que los guards, pero sus escrituras caen en tablas que la derivación no cubre— y
 * copiar la condición sería tener dos criterios que pueden discrepar. Se extrae, y el trigger
 * pasa a invocarla: misma regla, mismo mensaje, un solo sitio donde cambiarla.
 */
/*
 * ── La cuenta activa, comprobada también EN LA BASE ──
 * `is_workspace_member` y `workspace_role` miran `miembro` y nada más: una cuenta puesta en
 * `inactivo` que conserve su fila de membresía pasa todas las puertas SQL. Con el grant que
 * el rol de aplicación tiene sobre estas funciones, eso alcanzaba para registrar el acuerdo,
 * autorizar y confirmar la exportación y ejecutar el borrado por SQL crudo, saltándose
 * `exigirCuentaActiva`, que solo vive en el servicio. Cuarta aparición del mismo patrón: una
 * promesa sostenida donde el grant permite rodearla.
 *
 * Se cierra AQUÍ, en las puertas de la disposición, y no dentro de `is_workspace_member`:
 * aquella la invocan las políticas RLS de 54 tablas, así que meterle el estado de la cuenta
 * cambia el comportamiento de todo el esquema y es un cambio que merece su propia medida y su
 * propio slice. Queda anotado; lo que este PR cierra es lo que este PR abre.
 *
 * ── Y sin parámetro, y sin grant ──
 * La primera versión de esta función tomaba el usuario como argumento y se concedía a
 * `designio_app`. Eso es un ORÁCULO, y del mismo modelo exacto que ya se corrigió en este
 * mismo archivo: siendo SECURITY DEFINER salta la RLS de `usuario` por diseño, así que con el
 * sujeto en la firma cualquiera con el grant preguntaba por uuids ajenos y distinguía una
 * cuenta activa de una inactiva o inexistente. Es el defecto de `firmo_esta_disposicion`
 * reintroducido con otro nombre, y por eso el remedio es el mismo: el usuario se deriva DENTRO
 * de `app_user_id()`, y lo único preguntable es sobre uno mismo.
 *
 * El grant, además, no hacía falta: las cuatro puertas que la invocan son SECURITY DEFINER y
 * corren como el dueño. Se concedía por inercia, copiando el de `exigir_read_committed`, que
 * sí lo necesita porque a aquélla la llama un trigger que NO es definer.
 */
create function cuenta_activa() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from usuario u where u.id = app_user_id() and u.estado = 'activo')
$$;
revoke execute on function cuenta_activa() from public;
comment on function cuenta_activa() is
'Si la cuenta de QUIEN LLAMA sigue activa. SECURITY DEFINER porque `usuario` no es legible por el rol de aplicación; sin parámetro y sin grant, para que no sirva de oráculo sobre cuentas ajenas.';

create function exigir_read_committed(p_operacion text) returns void
language plpgsql as $$
declare
  v_nivel text := current_setting('transaction_isolation');
begin
  -- `read uncommitted` pasa porque Postgres lo trata exactamente como `read committed`.
  -- `serializable` NO pasa, y se dice por qué en vez de suponerlo: es muy probable que SSI
  -- aborte por sí solo las dependencias rw que RR ignora, pero este repositorio no lo usa
  -- en ninguna parte y no se ha medido. Fallar cerrado; abrirlo después es una línea y su
  -- test.
  if v_nivel not in ('read committed', 'read uncommitted') then
    raise exception '% exige aislamiento READ COMMITTED y la transacción está en «%». Aquí se serializa con candado y se vuelve a leer, y fuera de READ COMMITTED una sentencia posterior no toma instantánea nueva: la relectura vería una foto anterior al cambio que está esperando ver, y la decisión se tomaría sobre ella. Abre la transacción en read committed, o usa un aislamiento más fuerte solo para LEER (así lo hace la exportación)', p_operacion, v_nivel
      using errcode = 'IS001';
  end if;
end $$;
revoke execute on function exigir_read_committed(text) from public;
-- Y se concede al rol de aplicación, que es quien la ejecuta de hecho: el trigger de
-- aislamiento NO es SECURITY DEFINER —tiene que ver el nivel de la transacción de QUIEN
-- escribe— así que corre como el invocante, y sin este grant toda escritura sobre una tabla
-- cubierta moría con un 42501 que el servicio traduce a un mensaje de rol equivocado. No hay
-- nada que proteger aquí: la función solo mira el aislamiento de la transacción que la llama.
grant execute on function exigir_read_committed(text) to designio_app;

create or replace function exigir_aislamiento_de_escritura() returns trigger
language plpgsql as $$
begin
  perform exigir_read_committed('esta escritura');
  return null;
end $$;

/*
 * ── Por qué la versión esperada viaja hasta AQUÍ ──
 * El servicio ya la comparaba, y no bastaba: `ejecutar_disposicion` está concedida a
 * `designio_app`, así que un lead o un admin con SQL crudo entra por debajo de esa
 * comparación. Si la otra parte registra y exporta un acuerdo nuevo entre que la pantalla se
 * pintó y la llamada llega, la función elegía el ÚLTIMO —el que quien ejecuta nunca vio— y lo
 * ejecutaba: otra base contractual, otra retención, y en el peor caso un borrado. Es el mismo
 * defecto que ya se cobró el candado del registro: una promesa sostenida en el servicio,
 * que el grant permite rodear. Ahora la condición vive donde vive el permiso.
 *
 * ── Y por qué se rechaza REPEATABLE READ ──
 * Reproducido, y es el peor caso que ha dado este PR: con el acuerdo vigente ya sustituido por
 * un «archivo», una transacción REPEATABLE READ cuya instantánea es anterior ejecutó el
 * «borrado» viejo y destruyó el workspace. El candado hace esperar, pero fuera de READ
 * COMMITTED esperar no sirve de nada: la sentencia siguiente no abre instantánea nueva, así
 * que se relee la misma foto que había antes de esperar. La derivación del aislamiento no lo
 * atrapa por dos caminos distintos —el borrado apaga los triggers con
 * `session_replication_role = replica`, y el archivo solo escribe en tablas que la derivación
 * excluye—, así que la exigencia va explícita y ANTES de la primera lectura.
 */
create function ejecutar_disposicion(p_ws uuid, p_version_esperada integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := app_user_id();
  v_rol text;
  v_motivo text;
  v_ac acuerdo_disposicion;
  v_export timestamptz;
  v_conteos jsonb := '{}'::jsonb;
  v_remediacion jsonb := '{}'::jsonb;
  v_items integer := 0;
  v_con_consentimiento integer := 0;
  v_previo text;
  v_restantes text[] := '{}';
  v_constancia constancia_disposicion;
  v_n bigint;
  r record;
begin
  -- Lo PRIMERO, antes de leer nada: si la instantánea ya está fijada, esperar el candado no
  -- vuelve a mirar, y todo lo que sigue decidiría sobre una foto vieja.
  perform exigir_read_committed('la disposición acordada');
  -- Y la cuenta tiene que seguir activa. Va aquí y no solo en el servicio porque esta función
  -- está concedida al rol de aplicación: una cuenta desactivada a mitad de sesión que conserve
  -- su membresía pasaba `is_workspace_member` sin más y llegaba hasta el borrado.
  if not cuenta_activa() then
    raise exception 'la cuenta que ejecuta la disposición no está activa'
      using errcode = 'insufficient_privilege';
  end if;

  -- Anti-oráculo: a quien no es miembro se le responde lo mismo que a quien
  -- pregunta por un workspace que no existe.
  if session_user = 'designio_app'
     and not is_workspace_member(v_actor, p_ws) then
    raise exception 'El workspace no existe o no eres miembro'
      using errcode = 'insufficient_privilege';
  end if;
  if v_actor is null then
    raise exception 'la disposición se ejecuta con contexto de usuario (app.user_id): queda atribuida a quien la ejecuta y firmada con su rol'
      using errcode = 'DS002';
  end if;

  -- CANDADO PRIMERO, y del mismo objeto que los escritores toman en compartido. Después
  -- —nunca antes— se comprueba: bajo READ COMMITTED la sentencia siguiente abre
  -- instantánea nueva, así que lo que se lee ya incluye lo que commiteó quien nos hizo
  -- esperar.
  perform pg_advisory_xact_lock(hashtextextended('designio:workspace:' || p_ws, 42));

  v_motivo := disposicion_motivo_no_ejecutable(p_ws);
  if v_motivo is not null then
    raise exception '%', v_motivo using errcode = 'DS002';
  end if;

  -- El rol se lee AHORA, antes de destruir `miembro`: después no habría rol que firmar.
  v_rol := workspace_role(v_actor, p_ws);
  select * into v_ac from acuerdo_disposicion a
    where a.workspace_id = p_ws order by a.version desc limit 1;
  -- Alias `xp` y no `r`: `ejecutar_disposicion` declara una variable `record r` para recorrer
  -- las tablas, y en plpgsql la variable GANA al alias de la consulta. Con `r` aquí, la
  -- referencia se resuelve contra el record sin asignar y revienta en tiempo de ejecución.
  -- La versión que quien ejecuta CONFIRMÓ, comprobada aquí y no solo en el servicio. Va
  -- después del candado a propósito: comprobarla antes sería compararla con una foto que el
  -- candado todavía no ha dejado quieta. Y basta la versión, sin la modalidad: `unique
  -- (workspace_id, version)` hace que una versión identifique una fila y solo una, así que si
  -- la versión coincide, todo lo demás coincide por construcción.
  --
  -- `is distinct from` y no `<>`, y un rechazo explícito del nulo antes: con `<>`, un
  -- `ejecutar_disposicion(ws, NULL)` producía NULL, que plpgsql no toma por verdadero, así
  -- que el `if` no disparaba y la función seguía adelante ejecutando el acuerdo vigente —la
  -- garantía entera eludida pasando nada—. El nulo se rechaza aparte porque merece su propio
  -- mensaje: no es «confirmaste otra versión», es «no confirmaste ninguna».
  if p_version_esperada is null then
    raise exception 'la disposición se ejecuta confirmando QUÉ acuerdo se vio: falta la versión esperada'
      using errcode = 'DS002';
  end if;
  if v_ac.version is distinct from p_version_esperada then
    raise exception 'el acuerdo vigente es el #% («%») y se confirmó el #%: no se ejecuta lo que no se vio. Vuelve a mirarlo y confírmalo',
      v_ac.version, v_ac.modalidad, p_version_esperada using errcode = 'DS002';
  end if;

  select max(xp.completado_en) into v_export from exportacion_registro xp
    where xp.workspace_id = p_ws and xp.ambito = 'archivo'
      and xp.completado_en is not null
      and xp.acuerdo_version_visto = v_ac.version;

  -- Remediación ANTES de tocar nada: lo que ya salió hacia un proveedor no lo alcanza este
  -- borrado, y el libro que lo sabe es de los que se vacían.
  select coalesce(jsonb_object_agg(s.modelo, s.n), '{}'::jsonb) into v_remediacion
    from (select l.modelo, count(*)::int as n from llamada_ai l
          where l.workspace_id = p_ws group by l.modelo) s;
  select count(distinct l.item_id)::int,
         count(*) filter (where l.consentimiento_version is not null)::int
    into v_items, v_con_consentimiento
    from llamada_ai l where l.workspace_id = p_ws;

  if v_ac.modalidad = 'borrado' then
    -- ── Dependencia de RUNTIME, declarada en vez de invisible ──
    -- Apagar los triggers durante el vaciado exige que el DUEÑO de esta función sea
    -- superusuario (bajo SECURITY DEFINER, `current_user` es el dueño; medido: el rol de
    -- aplicación y un dueño no-superusuario reciben «permission denied to set parameter»).
    -- Hoy se cumple —la conexión admin es el superusuario del plugin, ver
    -- docs/06-diseno-tecnico/despliegue-railway.md—, pero `create function` no falla nunca
    -- por esto: fallaría la LLAMADA, en producción, el día que la base se mueva a un
    -- gestionado donde la admin no lo sea. Así que se comprueba aquí y se falla con un
    -- error propio que nombra la causa y el remedio.
    if not exists (select 1 from pg_roles where rolname = current_user and rolsuper) then
      raise exception 'el borrado acordado exige que el dueño de estas funciones (%) sea superusuario: el vaciado apaga los triggers de dominio con session_replication_role, y ese parámetro solo lo puede fijar un superusuario. Ver docs/06-diseno-tecnico/despliegue-railway.md (conexión admin)', current_user
        using errcode = 'DS003';
    end if;
    v_previo := current_setting('session_replication_role');
    perform set_config('session_replication_role', 'replica', true);
    for r in select tabla from tablas_alcanzadas_por_borrado() loop
      execute format('delete from %I where workspace_id = $1', r.tabla) using p_ws;
      get diagnostics v_n = row_count;
      if v_n > 0 then
        v_conteos := v_conteos || jsonb_build_object(r.tabla, v_n);
      end if;
    end loop;
    -- La lápida: la fila sobrevive porque de ella cuelga todo, incluida la constancia; su
    -- CONTENIDO no, porque es dato del cliente. El nombre nombra a la organización, y el cupo
    -- de llamadas AI es una condición pactada con ella — nada de eso tiene por qué sobrevivir
    -- al borrado de lo que gobernaba.
    --
    -- Y se enumeran una a una a propósito, en vez de decir «la fila queda como estaba menos el
    -- nombre»: `workspace` ya no es `(id, nombre, creado_en)` como suponía la primera versión
    -- de esta migración —el cupo llegó después, y el archivo del propietario lo trata como dato
    -- suyo—, así que lo que sobrevive tiene que ser una decisión escrita y no lo que quede por
    -- omisión. El test que deriva las columnas de la base es quien obliga a revisar esto cuando
    -- nazca la siguiente.
    update workspace set nombre = 'Workspace borrado por acuerdo', limite_llamadas_ai_dia = null
      where id = p_ws;
    -- La verificación que sustituye a las FK apagadas, y que es más fuerte que ellas.
    for r in select tabla from tablas_alcanzadas_por_borrado() loop
      execute format('select count(*) from %I where workspace_id = $1', r.tabla)
        into v_n using p_ws;
      if v_n > 0 then v_restantes := v_restantes || r.tabla; end if;
    end loop;
    perform set_config('session_replication_role', v_previo, true);
    if array_length(v_restantes, 1) > 0 then
      raise exception 'el borrado no alcanzó a %: la disposición se aborta entera en vez de emitir una constancia que no se cumple',
        array_to_string(v_restantes, ', ') using errcode = 'DS002';
    end if;
  else
    -- Archivo: no se destruye nada. El recibo dice qué queda conservado y congelado, con
    -- el mismo conjunto derivado, para que los dos conteos sean comparables.
    for r in select tabla from tablas_alcanzadas_por_borrado() loop
      execute format('select count(*) from %I where workspace_id = $1', r.tabla)
        into v_n using p_ws;
      if v_n > 0 then
        v_conteos := v_conteos || jsonb_build_object(r.tabla, v_n);
      end if;
    end loop;
  end if;

  insert into constancia_disposicion
    (workspace_id, acuerdo_version, acuerdo_base, acuerdo_efectivo_desde, acuerdo_por,
     acuerdo_rol, modalidad, exportado_en, conteos, remediacion,
     remediacion_items, remediacion_con_consentimiento, ejecutado_por, ejecutado_rol,
     alcance)
  values (p_ws, v_ac.version, v_ac.base,
          -- `to_char` aquí y no en la columna generada: es STABLE, y aquí eso no estorba
          -- porque el valor se congela al escribirlo. Formato fijo, sin nombres de mes, así
          -- que ni `DateStyle` ni `lc_time` lo mueven.
          to_char(v_ac.efectivo_desde, 'YYYY-MM-DD'), v_ac.acordado_por, v_ac.acordado_rol,
          v_ac.modalidad, v_export, v_conteos, v_remediacion,
          v_items, v_con_consentimiento, v_actor, v_rol,
          alcance_de_constancia(v_ac.modalidad))
  returning * into v_constancia;

  -- El evento va DESPUÉS del vaciado, así que sobrevive: tras un borrado, el libro de este
  -- workspace dice exactamente una cosa. Se emite aquí dentro para que el SQL crudo lo
  -- produzca igual, y sin necesidad de que quien ejecuta pueda leer `evento_dominio`.
  insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
  values (p_ws, 'WorkspaceDispuesto',
    jsonb_build_object('modalidad', v_constancia.modalidad,
                       'acuerdoVersion', v_constancia.acuerdo_version,
                       'constanciaId', v_constancia.id,
                       'sello', v_constancia.sello,
                       'conteos', v_constancia.conteos),
    v_actor, v_rol);

  return to_jsonb(v_constancia);
end $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────────────
-- acuerdo_disposicion:
--  · SELECT — miembros (el acuerdo que gobierna sus datos no se le oculta a nadie de casa).
--  · INSERT — quien administra u opera el workspace, el mismo par que ya ejecuta la
--    exportación; la atribución la fija la política, no el caller.
--  · Sin UPDATE ni DELETE: cambiar el acuerdo es un registro NUEVO.
-- constancia_disposicion:
--  · SELECT — miembros.
--  · NINGUNA política de escritura, y ningún grant: la constancia solo la escribe el guard
--    que la decide. La aplicación no tiene superficie con la que fabricar una.
alter table acuerdo_disposicion enable row level security;
alter table constancia_disposicion enable row level security;

-- La membresía manda mientras haya membresía; y quien ejecutó una disposición conserva la
-- lectura del acuerdo que la ordenó, por el mismo motivo que conserva la constancia.
create policy acuerdo_select on acuerdo_disposicion
  for select using (
    is_workspace_member(app_user_id(), workspace_id)
    -- Quien FIRMÓ un acuerdo lo sigue leyendo, haya membresía o no. Un contrato nombra a
    -- quien lo firma, y el borrado destruye las membresías: sin esto, la parte que pactó la
    -- disposición perdería el papel que acredita lo que pactó, que es al revés de para qué
    -- se registra.
    or acordado_por = app_user_id()
    or exists (select 1 from constancia_disposicion c
               where c.workspace_id = acuerdo_disposicion.workspace_id
                 and c.ejecutado_por = app_user_id())
  );

create policy acuerdo_insert on acuerdo_disposicion
  for insert with check (
    workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'admin-cliente')
    and acordado_por = app_user_id()
  );

-- ── Por qué la lectura no es SOLO por membresía ──
-- Tras un borrado se destruyen los `miembro`, así que `is_workspace_member` es falso para
-- todo el mundo: una RLS por membresía sobre una tabla en la que ya nadie puede ser miembro
-- sería una promesa que nadie puede ejercer. El documento sellado que el guard DEVUELVE en el
-- acto es verificable fuera de esta base recomputando su sha256, y eso es lo que lo hace útil
-- cuando ya no queda acceso; esta fila es la copia consultable.
--
-- Y la conservan LAS DOS PARTES que firmaron, no solo quien ejecutó. Decir «el cliente ya
-- tiene su copia porque la recibe al ejecutar» sería cierto en un archivo, pero se contradice
-- con la propia regla de la doble firma: un BORRADO lo registra una parte y lo ejecuta la
-- OTRA, así que en el caso más común —el cliente pacta el borrado, la boutique lo ejecuta— la
-- respuesta inmediata llega a la boutique y el cliente se queda sin nada en cuanto se
-- destruyen las membresías. Justamente la parte que más necesita el recibo.
--
create policy constancia_select on constancia_disposicion
  for select using (
    is_workspace_member(app_user_id(), workspace_id)
    or ejecutado_por = app_user_id()
    -- Y quien FIRMÓ el acuerdo que esta constancia ejecutó, leído de la propia fila. Se ata
    -- al acuerdo CONCRETO —es el que se copió al emitirla— y no a haber firmado alguno:
    -- quien pactó una disposición anterior que no llegó a ejecutarse no gana con ella una
    -- ventana a lo que pasó después.
    or acuerdo_por = app_user_id()
  );

-- ── Grants mínimos ────────────────────────────────────────────────────────────────────
-- `version` y `acordado_en` quedan FUERA del insert: los escribe el guard. Con el grant
-- puesto, un acuerdo podría nacer con versión alta —convirtiéndose en «vigente» sin serlo—
-- o fechado hacia atrás. Mismo criterio que `consentimiento_item.version`.
grant select on acuerdo_disposicion to designio_app;
grant insert (workspace_id, modalidad, base, efectivo_desde, acordado_por)
  on acuerdo_disposicion to designio_app;
grant select on constancia_disposicion to designio_app;

revoke execute on function
  confirmar_exportacion(uuid, text),
  sello_constancia(text),
  alcance_de_constancia(text),
  tablas_del_workspace(),
  tablas_alcanzadas_por_borrado(),
  tablas_congelables(),
  disposicion_vigente(uuid),
  workspace_borrado(uuid),
  disposicion_motivo_no_ejecutable(uuid),
  ejecutar_disposicion(uuid, integer)
from public;
grant execute on function
  confirmar_exportacion(uuid, text),
  disposicion_vigente(uuid),
  workspace_borrado(uuid),
  disposicion_motivo_no_ejecutable(uuid),
  ejecutar_disposicion(uuid, integer)
to designio_app;
