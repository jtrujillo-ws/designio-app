-- SYS-14 / RF-03.10 — LA PUERTA DE MEMBRESÍA, FUERA DEL PREDICADO CRUDO.
--
-- `20260902360000` dejó dicho el reparto correcto: «`derechos_vigentes` es la regla y
-- `evidencia_usable` es la regla MÁS la puerta; la regla va sin grant y la puerta es lo
-- único que el rol de aplicación puede llamar». Y dejó dicha también la trampa: «la puerta
-- NO puede ir en la función que llama el guard, porque el guard corre como propietario y
-- muchas veces sin `app.user_id`».
--
-- El predicado crudo del razonamiento se quedó del lado equivocado de ese reparto: llama a
-- `evidencia_usable` y a `evidencia_motivo_bloqueo`, que llevan la puerta dentro. Medido
-- sobre el seed, como propietario y sin `app.user_id` fijado:
--
--   derechos_vigentes(e)  = true          -- la evidencia SÍ tiene derechos vigentes
--   evidencia_usable(e)   = false         -- pero la puerta dice que no eres miembro
--   razonamiento_sin_respaldo(...)
--     => 'cita evidencia sin derechos vigentes — derechos insuficientes'
--
-- O sea que el crudo responde que faltan derechos cuando los derechos están vivos. Falla
-- CERRADO, y por eso se aplazó y no rompió nada: hoy el único llamante es el guard, y el
-- guard corre con `app.user_id` puesto. Pero el aplazamiento tenía fecha de caducidad —
-- cualquier guard futuro que lo consulte hereda el rechazo, y lo hereda EN SILENCIO,
-- porque el síntoma es un rechazo perfectamente plausible que nombra los derechos.
--
-- Se arregla como el esquema ya resolvió el mismo problema una vez: la regla abajo, la
-- puerta arriba, y el crudo leyendo la regla.
--
-- Y falta la mitad que no existía: `derechos_vigentes` es la regla sin puerta del PERMISO,
-- pero del MOTIVO no había versión sin puerta. Se crea, y `evidencia_motivo_bloqueo` pasa a
-- ser lo que ya es su hermana: la regla más la puerta.

-- ── 1. El motivo, sin puerta ──
--
-- La fecha se compara con el calendario de la BASE y no con el de quien llama —
-- `timezone('UTC', now())::date` es un `timestamp` sin huso del que el `::date` ya no tiene
-- de dónde moverse—. Es el mismo arreglo que el resto del esquema usa para los instantes
-- que entran en un sello, y va aquí desde el principio a propósito: esta migración lleva un
-- sello POSTERIOR al del PR que arregla el calendario en las otras cuatro funciones, así
-- que escribirla con `current_date` habría revertido aquel arreglo al aplicarse después.
create function evidencia_motivo_bloqueo_crudo(p_evidencia uuid, p_ws uuid, p_ambito text)
returns text
language sql stable security definer set search_path = public, pg_temp as
$$
  select case
    when derechos_vigentes(p_evidencia, p_ws, p_ambito) then null
    when d.evidencia_id is null then
      'la evidencia no existe en este workspace o no tiene registro de derechos'
    when d.estado = 'pendiente' then
      'derechos pendientes: nadie ha registrado la base (consentimiento o cláusula) que autoriza este uso'
    when d.estado = 'denegado' then
      'derechos denegados: ' || d.base
    when d.vence_en is not null and d.vence_en < timezone('UTC', now())::date then
      'los derechos vencieron el ' || to_char(d.vence_en, 'YYYY-MM-DD')
    else
      'los derechos concedidos alcanzan solo el ámbito «' || d.ambito ||
      '» y este uso exige «' || p_ambito || '»'
  end
  from (select p_evidencia as ev) param
  left join derecho_uso d on d.evidencia_id = param.ev and d.workspace_id = p_ws
$$;
comment on function evidencia_motivo_bloqueo_crudo(uuid, uuid, text) is
'El motivo por el que una evidencia no es usable, SIN la puerta anti-oráculo: dice la verdad a quien la llame. La llaman los guards, que corren como propietario y muchas veces sin `app.user_id`. Para las proyecciones está `evidencia_motivo_bloqueo`, que es ésta más la puerta.';
revoke execute on function evidencia_motivo_bloqueo_crudo(uuid, uuid, text) from public;

-- ── 2. El motivo público: la regla MÁS la puerta ──
--
-- Deja de llevar la regla dentro. La propiedad anti-oráculo no cambia —para quien no es
-- miembro sigue siendo `null`, indistinguible de «se puede usar»— pero ahora está escrita
-- en un solo sitio y encima de la regla, no mezclada con ella.
create or replace function evidencia_motivo_bloqueo(p_evidencia uuid, p_ws uuid, p_ambito text)
returns text
language sql stable security definer set search_path = public, pg_temp as
$$
  select case
    when is_workspace_member(app_user_id(), p_ws)
      then evidencia_motivo_bloqueo_crudo(p_evidencia, p_ws, p_ambito)
  end
$$;

-- ── 3. El predicado crudo lee la REGLA ──
--
-- Cuatro llamadas: dos al permiso y dos al motivo. Las cuatro pasan a la versión sin
-- puerta. El cuerpo no cambia en nada más.
create or replace function razonamiento_sin_respaldo(
  p_ws uuid,
  p_insights uuid[],
  p_decisiones uuid[],
  p_evidencias uuid[]
) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_bloqueo text;
  v_afirmacion text;
  v_evidencia uuid;
  v_decision text;
begin
  -- 1. La evidencia citada directamente sigue siendo usable.
  select evidencia_motivo_bloqueo_crudo(e.id, e.workspace_id, 'cliente')
    into v_bloqueo
    from evidencia e
    where e.workspace_id = p_ws and e.id = any(p_evidencias)
      and not derechos_vigentes(e.id, e.workspace_id, 'cliente')
    limit 1;
  if found then
    return 'cita evidencia sin derechos vigentes — '
           || coalesce(v_bloqueo, 'derechos insuficientes');
  end if;

  -- 2. NINGUNA decisión del razonamiento está EN REVISIÓN.
  select d.titulo into v_decision
    from decision d
    where d.workspace_id = p_ws and d.id = any(p_decisiones) and d.estado <> 'vigente'
    order by d.decidido_en, d.id
    limit 1;
  if v_decision is not null then
    return 'se apoya en la decisión «' || v_decision
           || '», que una reapertura dejó en revisión (SYS-10) — revalídala o rehaz el razonamiento';
  end if;

  -- 3. Ninguna decisión alcanzada se traza a un insight sin validar.
  if exists (
    select 1 from decision_insight di
    join insight i on i.id = di.insight_id and i.workspace_id = di.workspace_id
    where di.workspace_id = p_ws and di.decision_id = any(p_decisiones)
      and i.estado <> 'validado'
  ) then
    return 'se traza a una decisión con un insight que no está validado — valídalo o rehaz la decisión';
  end if;

  -- 4. Toda afirmación no hipotética alcanzada conserva al menos una cita con derechos.
  with alcanzado as (
    select a.id, a.texto, a.orden, a.workspace_id, a.es_hipotesis
      from afirmacion a
      where a.workspace_id = p_ws and a.insight_id = any(p_insights)
    union
    select a.id, a.texto, a.orden, a.workspace_id, a.es_hipotesis
      from decision_insight di
      join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
      where di.workspace_id = p_ws and di.decision_id = any(p_decisiones)
  )
  select r.texto,
         (select c.evidencia_id from cita c
           where c.afirmacion_id = r.id and c.workspace_id = r.workspace_id
           order by c.creado_en, c.id limit 1)
    into v_afirmacion, v_evidencia
    from alcanzado r
    where not r.es_hipotesis
      and not exists (select 1 from cita c
        where c.afirmacion_id = r.id and c.workspace_id = r.workspace_id
          and derechos_vigentes(c.evidencia_id, c.workspace_id, 'cliente'))
    order by r.orden
    limit 1;
  if v_afirmacion is not null then
    return 'se apoya en la afirmación «' || v_afirmacion
           || '», que ya no tiene ninguna cita con derechos vigentes — '
           || coalesce(evidencia_motivo_bloqueo_crudo(v_evidencia, p_ws, 'cliente'),
                       'derechos insuficientes');
  end if;

  return null;
end $$;
