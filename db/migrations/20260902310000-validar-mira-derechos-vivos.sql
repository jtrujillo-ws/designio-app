-- RF-03.10 / SYS-14 / SYS-17 — VALIDAR UN INSIGHT COMPROBABA QUE LA CITA EXISTE, NO QUE
-- SIRVE. Y validar es irreversible.
--
-- Es la misma familia que el resto de esta rama —«comprobar existencia en vez de
-- vigencia»— pero cae sobre el peor objeto posible: uno INMUTABLE.
--
-- La secuencia: se cita evidencia con derechos vigentes (`evidencia_citable_guard` lo
-- exige, ámbito cliente); después se revocan esos derechos mientras el insight sigue
-- `propuesto`; nada actualiza la fila de la cita, así que su trigger no vuelve a correr; y
-- `insight_validar_guard` solo comprobaba que EXISTE una cita por afirmación no-hipótesis.
-- El insight quedaba validado —y por tanto inmutable— sin respaldo usable.
--
-- Lo que lo convierte en «promesa sin ruta»: aguas abajo todo lo rechaza (el guard del
-- gate re-evalúa derechos vivos, el picker lo marca `sin_respaldo`), y `cita_insert` exige
-- `insight.estado = 'propuesto'`, así que tampoco se le pueden añadir citas de repuesto.
-- El insight quedaba inservible y sin salida DENTRO del producto. La salida que sí existe
-- —y por eso este arreglo no inventa una transición nueva— es que los derechos vuelven:
-- reconcederlos revive el insight entero, y es el único acto de este dominio que va y
-- viene. Lo que no puede pasar es que el objeto inmutable NAZCA roto.
--
-- El arreglo va donde el acto es definitivo: en la transición a `validado`. Mismo
-- predicado que ya usan el guard del gate y `insightsCitables` —toda afirmación no marcada
-- como hipótesis necesita al menos una cita con derechos vigentes para el ámbito cliente—,
-- y mismo ámbito que exigió la cita al crearse, así que una cita legítima con sus derechos
-- vivos no ve ningún rechazo nuevo: lo único que cambia es que la revocación intermedia ya
-- no se cuela.
--
-- ── Y con candado de FILA, no con una lectura a secas ──
-- Comprobar derechos sin bloquear la fila que otro camino muta es un predicado sobre una
-- instantánea, no un cerrojo: `decidirDerechos` podría commitear su revocación entre esta
-- lectura y el commit de la validación. `for share` sobre `derecho_uso` es el mismo
-- candado que toma el guard del gate, y por la misma razón: quien revoca hace `update
-- derecho_uso`, que ya toma el candado en conflicto sin cooperar con ningún protocolo.
-- Además hace que el invariante no dependa del nivel de aislamiento del llamante — bajo
-- `repeatable read` una relectura llana vería la foto vieja y esto daría 40001.
--
-- ── Copia ÍNTEGRA de la versión viva (20260902080000) más la comprobación ──
-- Este `create or replace` reescribe la función entera: lo que no se copie se pierde en
-- silencio. Se conservan tal cual el corte anti-oráculo, el sello `validado_en`, las dos
-- comprobaciones existentes y el evento `InsightValidado`.
-- ── ANTES DE NADA: el predicado de derechos, SIN la puerta anti-oráculo ──
-- `evidencia_usable` lleva desde 20260902190000 un `is_workspace_member(app_user_id(), …)`
-- delante, y hace bien: sin él, un extraño puede usar el motivo del rechazo como oráculo
-- de existencia. Pero eso la vuelve inservible para el código que corre como PROPIETARIO
-- —migraciones, seed, jobs de sistema—, donde `app.user_id` no está puesto: la membresía
-- sale falsa y la función devuelve `false` para TODA evidencia, también para la que tiene
-- los derechos vigentes.
--
-- La cabecera de 190000 ya razonó la mitad de esto: «las backfills anteriores corren antes
-- que ésta y por tanto contra la definición permisiva». Cierto, y con su corolario dentro,
-- que no se escribió: toda backfill AÑADIDA DESPUÉS sí se ve afectada. La primera versión
-- de este fichero lo fue, y lo que escribía era una fila de auditoría append-only: un dato
-- falso que no se limpia después, se exporta y se lee como hecho.
--
-- El arreglo no es copiar el predicado en la backfill —sería la segunda redacción de la
-- regla, que es el defecto que este PR lleva toda la revisión cerrando— sino FACTORIZARLO:
-- `derechos_vigentes` es la regla, y `evidencia_usable` es esa regla MÁS la puerta. Así la
-- puerta pasa de ser un detalle dentro del predicado a ser una capa explícita encima, y
-- quien corre como propietario llama a la de abajo porque el propietario no es un extraño.
create function derechos_vigentes(p_evidencia uuid, p_ws uuid, p_ambito text)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from derecho_uso d
    where d.evidencia_id = p_evidencia
      and d.workspace_id = p_ws
      and d.estado = 'concedido'
      -- Caducado ⇒ ya no hay derechos (fecha calendárica, comparada como día).
      and (d.vence_en is null or d.vence_en >= current_date)
      and case p_ambito
            when 'interno' then d.ambito in ('interno', 'cliente', 'publico')
            when 'cliente' then d.ambito in ('cliente', 'publico')
            when 'publico' then d.ambito = 'publico'
            else false
          end
  )
$$;
comment on function derechos_vigentes(uuid, uuid, text) is
'La REGLA de derechos, sin la puerta de membresía: concedido, no caducado y con ámbito suficiente. La usa `evidencia_usable` (que le añade la puerta anti-oráculo, para el rol de aplicación) y la usan las backfills, que corren como propietario y para las que la puerta significaría «nadie tiene derechos».';

-- Sin grant a nadie: el rol de aplicación tiene que seguir pasando por `evidencia_usable`,
-- que es la que lleva la puerta. Ofrecerle el predicado desnudo sería devolverle el oráculo
-- que 190000 le quitó, por otra puerta.
revoke execute on function derechos_vigentes(uuid, uuid, text) from public;

-- Y `evidencia_usable` pasa a ser, literalmente, «la regla más la puerta». Mismo
-- comportamiento observable que antes; lo que cambia es que la regla ya no está escrita
-- dos veces.
create or replace function evidencia_usable(p_evidencia uuid, p_ws uuid, p_ambito text)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select is_workspace_member(app_user_id(), p_ws)
     and derechos_vigentes(p_evidencia, p_ws, p_ambito)
$$;

create or replace function insight_validar_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_evidencia uuid;
  v_afirmacion text;
begin
  if not is_workspace_member(app_user_id(), new.workspace_id) then
    return new;
  end if;
  if new.estado = 'validado' and old.estado = 'propuesto' then
    new.validado_en := now();
    if not exists (select 1 from afirmacion a
      where a.insight_id = new.id and a.workspace_id = new.workspace_id) then
      raise exception 'un insight sin afirmaciones no se valida';
    end if;
    if exists (select 1 from afirmacion a
      where a.insight_id = new.id and a.workspace_id = new.workspace_id
        and not a.es_hipotesis
        and not exists (select 1 from cita c
          where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id)) then
      raise exception 'toda afirmación no marcada como hipótesis exige al menos una cita';
    end if;

    -- ═══ Y LAS CITAS TIENEN QUE SEGUIR SIRVIENDO, NO SOLO EXISTIR ═══
    -- El candado va PRIMERO y sobre las filas de derechos de toda la evidencia citada por
    -- este insight: se bloquea lo que se va a leer, antes de leerlo. Orden determinista por
    -- id — `for share` no se estorba consigo mismo, pero el orden es gratis.
    perform du.evidencia_id
      from derecho_uso du
      where du.workspace_id = new.workspace_id
        and du.evidencia_id in (
          select c.evidencia_id from afirmacion a
          join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
          where a.insight_id = new.id and a.workspace_id = new.workspace_id)
      order by du.evidencia_id
      for share;

    -- Se trae la PRIMERA afirmación que se queda sin respaldo y su evidencia, para poder
    -- nombrar la dimensión que falta (SYS-14): un motivo genérico no dice qué reparar.
    -- «Al menos una cita usable» y no «ninguna cita bloqueada»: una afirmación con dos
    -- citas sigue sostenida si a una le quedan derechos, y exigir más sería más estricto
    -- que el propio guard del gate, que es quien manda aguas abajo.
    select a.texto,
           (select c.evidencia_id from cita c
             where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
             order by c.creado_en, c.id limit 1)
      into v_afirmacion, v_evidencia
      from afirmacion a
      where a.insight_id = new.id and a.workspace_id = new.workspace_id
        and not a.es_hipotesis
        and not exists (select 1 from cita c
          where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'))
      order by a.orden
      limit 1;
    if v_afirmacion is not null then
      raise exception 'No puedes validar este insight: la afirmación «%» se apoya en evidencia sin derechos vigentes — %. Validar es irreversible y un insight validado no admite citas nuevas, así que se para aquí: reconcede los derechos o cita otra evidencia antes de validar',
        v_afirmacion,
        coalesce(evidencia_motivo_bloqueo(v_evidencia, new.workspace_id, 'cliente'),
                 'derechos insuficientes')
        using errcode = 'DR001';
    end if;

    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'InsightValidado',
        jsonb_build_object('insightId', new.id, 'titulo', new.titulo),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ── Los que ya nacieron rotos quedan NOMBRADOS, no reescritos ──
-- Un insight validado es inmutable: revertirlo aquí borraría un juicio humano ya emitido,
-- que es lo que este dominio no hace. Y no se quedan sin salida: reconceder los derechos
-- de la evidencia citada los revive, porque los derechos son lo único de este dominio que
-- va y viene. El evento nombra el insight y la afirmación exacta que se quedó sin respaldo
-- para que el operador sepa qué mirar, en vez de descubrirlo cuando un gate lo rechace.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select i.workspace_id, 'InsightValidadoSinRespaldoUsable',
       jsonb_build_object('insightId', i.id, 'titulo', i.titulo,
                          'afirmacionSinRespaldo', a.texto),
       null, null
from insight i
join afirmacion a on a.insight_id = i.id and a.workspace_id = i.workspace_id
where i.estado = 'validado'
  and not a.es_hipotesis
  -- `derechos_vigentes` y no `evidencia_usable`: esto corre como propietario, sin
  -- `app.user_id`, y con la puerta puesta marcaría TODA cita como sin respaldo.
  and not exists (select 1 from cita c
    where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
      and derechos_vigentes(c.evidencia_id, c.workspace_id, 'cliente'));
