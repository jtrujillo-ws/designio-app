-- RF-03.10 / RF-04.5 / RF-06.3 / SYS-14 — EL PREDICADO DEL RAZONAMIENTO, TAMBIÉN EN UN
-- SOLO SITIO.
--
-- `20260902340000` sacó el PROTOCOLO a `razonamiento_usable_guard` y con eso las dos rutas
-- de escritura dejaron de divergir. Faltaba la otra mitad, y se vio enseguida: el selector
-- de motivos de la design version, añadido en la misma ronda, reprodujo del guard **la
-- comprobación de derechos y no la del estado del insight**. Un enlace heredado a un
-- insight `propuesto` cuyas citas siguen teniendo derechos salía habilitado en el picker,
-- el enlace se creaba, y el rechazo llegaba al certificar G5.
--
-- Es exactamente el mismo error una capa más arriba: la pantalla espeja MEDIA regla. Y la
-- causa es la misma: mientras el predicado viva dentro de un guard que levanta
-- excepciones, quien quiera mirarlo antes no tiene más remedio que reescribirlo.
--
-- Así que el predicado sale a una función de SOLO LECTURA que devuelve el motivo (o null),
-- y la usan los dos lados: el guard la llama y levanta, las proyecciones la llaman y la
-- pintan. La pantalla deja de espejar la regla — la INVOCA.
create function razonamiento_sin_respaldo(
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
begin
  -- 1. La evidencia citada directamente sigue siendo usable.
  select evidencia_motivo_bloqueo(e.id, e.workspace_id, 'cliente')
    into v_bloqueo
    from evidencia e
    where e.workspace_id = p_ws and e.id = any(p_evidencias)
      and not evidencia_usable(e.id, e.workspace_id, 'cliente')
    limit 1;
  if found then
    return 'cita evidencia sin derechos vigentes — '
           || coalesce(v_bloqueo, 'derechos insuficientes');
  end if;

  -- 2. Toda decisión se traza a insights VALIDADOS. La política `decision_insight_insert`
  -- cierra la entrada desde 20260902260000, pero una política gobierna lo que se escribe a
  -- partir de ahora: los enlaces heredados solo los alcanza el consumo.
  if exists (
    select 1 from decision_insight di
    join insight i on i.id = di.insight_id and i.workspace_id = di.workspace_id
    where di.workspace_id = p_ws and di.decision_id = any(p_decisiones)
      and i.estado <> 'validado'
  ) then
    return 'se traza a una decisión con un insight que no está validado — valídalo o rehaz la decisión';
  end if;

  -- 3. Toda afirmación no-hipótesis tiene al menos una cita usable, por las dos vías. Se
  -- trae la primera que falla para NOMBRARLA (SYS-14). «Al menos una usable» y no «ninguna
  -- bloqueada»: una afirmación con dos citas sigue sostenida si a una le quedan derechos.
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
          and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'))
    order by r.orden
    limit 1;
  if v_afirmacion is not null then
    return 'se apoya en la afirmación «' || v_afirmacion
           || '», que ya no tiene ninguna cita con derechos vigentes — '
           || coalesce(evidencia_motivo_bloqueo(v_evidencia, p_ws, 'cliente'),
                       'derechos insuficientes');
  end if;

  return null;
end $$;
comment on function razonamiento_sin_respaldo(uuid, uuid[], uuid[], uuid[]) is
'Por qué NO se puede consumir este razonamiento, o null si sí se puede. Solo lectura: la llaman el guard (que levanta con el motivo) y las proyecciones de los pickers (que lo pintan). Que sea una sola redacción es lo que impide que una pantalla espeje media regla.';

-- El rol de aplicación SÍ la ejecuta: la necesitan las proyecciones. No es un oráculo —usa
-- `evidencia_usable` y `evidencia_motivo_bloqueo`, que llevan la puerta de membresía— y de
-- un workspace ajeno devuelve el mismo null que devolvería si todo estuviera en orden.
grant execute on function razonamiento_sin_respaldo(uuid, uuid[], uuid[], uuid[]) to designio_app;

-- ── Y el guard pasa a ser candados + esta función ──
-- Copia íntegra de la versión viva (20260902340000): lo único que cambia es que las tres
-- comprobaciones salen a `razonamiento_sin_respaldo`. El orden de los candados no se toca.
create or replace function razonamiento_usable_guard(
  p_ws uuid,
  p_insights uuid[],
  p_decisiones uuid[],
  p_evidencias uuid[],
  p_contexto text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_motivo text;
begin
  -- ═══ 1. CANDADO SOBRE LAS DECISIONES ═══
  -- Va PRIMERO porque de estas filas se DERIVA el conjunto de derechos de abajo: bloquear
  -- el resultado sin bloquear la fuente deja el fantasma abierto. `for share` y no
  -- `for update`: dos aprobaciones distintas no tienen por qué esperarse. Orden por id.
  perform d.id
    from decision d
    where d.workspace_id = p_ws and d.id = any(p_decisiones)
    order by d.id
    for share;

  -- ═══ 2. CANDADO SOBRE LOS DERECHOS QUE SE VAN A LEER ═══
  -- Quien revoca hace `update derecho_uso`, que ya toma el candado en conflicto sin
  -- cooperar con ningún protocolo. Va ANTES de decidir: bloquear después de comprobar deja
  -- exactamente la misma ventana.
  perform du.evidencia_id
    from derecho_uso du
    where du.workspace_id = p_ws
      and du.evidencia_id in (
        select e.id from evidencia e where e.workspace_id = p_ws and e.id = any(p_evidencias)
        union
        select c.evidencia_id
          from afirmacion a
          join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
          where a.workspace_id = p_ws and a.insight_id = any(p_insights)
        union
        select c.evidencia_id
          from decision_insight di
          join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
          join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
          where di.workspace_id = p_ws and di.decision_id = any(p_decisiones)
      )
    order by du.evidencia_id
    for share;

  -- ═══ 3. Y EL PREDICADO, QUE ES EL MISMO QUE MIRAN LOS PICKERS ═══
  v_motivo := razonamiento_sin_respaldo(p_ws, p_insights, p_decisiones, p_evidencias);
  if v_motivo is not null then
    raise exception 'no se puede aprobar: % %', p_contexto, v_motivo using errcode = 'DR001';
  end if;
end $$;
