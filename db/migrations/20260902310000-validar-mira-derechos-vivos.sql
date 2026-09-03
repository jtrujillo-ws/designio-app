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
  and not exists (select 1 from cita c
    where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
      and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'));
