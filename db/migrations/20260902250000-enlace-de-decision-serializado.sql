-- RF-03.10 / SPEC-04.9 — EL CONJUNTO QUE SE BLOQUEA TAMBIÉN ES MUTABLE. La ronda anterior
-- puso un `for share` sobre `derecho_uso` al aprobar un gate y escribió, con demasiada
-- confianza, que «se bloquea el MISMO conjunto que las comprobaciones recorren». Es cierto
-- de las FILAS y falso del CONJUNTO: cuáles son esas filas se deriva de un `select` que
-- también corre sobre una instantánea, y por lo menos una de las tablas de las que se
-- deriva —`decision_insight`— la escribe otro camino que no comparte candado con nadie.
--
-- Un candado de fila ordena a los que tocan LA MISMA fila; no impide que aparezca una fila
-- NUEVA (un fantasma) que habría cambiado el conjunto. Ésa es la carrera:
--
--   sesión A: aprobar el gate G, cuyo ítem cumplido cita la decisión D. El guard deriva
--             de `decision_insight` los insights de D, de ahí sus citas y de ahí las
--             evidencias; bloquea ESAS filas de `derecho_uso` y comprueba: todo vigente.
--   sesión B: `insert into decision_insight (D, I2)`, donde I2 es un insight validado en
--             su día cuyo respaldo perdió los derechos después. Su política
--             (`decision_insight_insert`, 20260902080000) solo mira el rol: no toca
--             ninguna de las filas que A bloqueó, así que no espera a nada.
--   las dos commitean, y G queda aprobado incumpliendo el predicado exacto que su propio
--   guard acababa de comprobar — porque cuando lo comprobó, el enlace todavía no existía.
--
-- No es la carrera de la revocación otra vez. Allí el conjunto era el correcto y la fila
-- cambiaba debajo; aquí la fila que faltaba nunca entró en el conjunto. Por eso el `for
-- share` de `derecho_uso` no la atrapa ni podría: no hay fila que bloquear.
--
-- ═══ DÓNDE VA EL CANDADO, Y POR QUÉ EN LA DECISIÓN ═══
-- La regla de siempre: donde dos operaciones deciden sobre lo mismo tocando filas
-- distintas, hay que darles un objeto común. El objeto común aquí es la DECISIÓN: A la
-- consume como respaldo de un ítem cumplido y B le cuelga un insight. Así que
--
--   · el guard del gate toma `for share` sobre las filas de `decision` que consume, ANTES
--     de derivar nada de ellas;
--   · un guard nuevo en `decision_insight` toma `for no key update` sobre la fila de la
--     decisión a la que enlaza.
--
-- `for share` × `for no key update` chocan, que es lo que se busca; `for share` consigo
-- mismo no, así que dos aprobaciones de gates que citan la misma decisión no se estorban.
-- Y se elige el candado de FILA y no uno consultivo por el mismo motivo que en 240000, que
-- aquí rinde de más: quien REABRE una decisión hace `update decision`, que ya toma
-- `for no key update` sin saber nada de este protocolo. De regalo, la comprobación
-- «hay ítems cumplidos con decisiones en revisión» —que tenía exactamente el mismo agujero,
-- leyendo `decision.estado` sin bloquear nada— queda cerrada por el mismo candado.
--
-- ═══ QUIÉN RELEE (esperar sin releer es esperar para nada) ═══
-- La columna 4 de 240000 obliga a preguntarlo de cada candado nuevo, y aquí la respuesta
-- es asimétrica a propósito:
--
--   · Si B llega primero: A espera en su `for share`, y al soltarse las sentencias
--     siguientes del guard —cada una con su instantánea nueva, que es la mecánica de
--     plpgsql bajo READ COMMITTED— ya ven el enlace, derivan el conjunto AMPLIADO y
--     rechazan. Relee A, y relee todo lo que importa.
--   · Si A llega primero: B espera y, al soltarse, inserta sobre un gate ya aprobado. Eso
--     NO se rechaza, y no es una omisión: es la misma semántica que este PR sostiene para
--     la revocación posterior a la aprobación — el gate es un predicado sobre el instante
--     en que se aprueba, no una promesa perpetua. Lo que no puede pasar es que las dos
--     cosas ocurran a la vez y ninguna vea a la otra.
--
-- Por eso el guard de `decision_insight` no comprueba nada: no tiene ningún predicado
-- propio que hubiera decidido antes de dormirse, y su único trabajo es impedir que el
-- guard del gate corra a la vez que él. El que decidió antes de esperar es A, y A sí
-- vuelve a leerlo todo. La trampa de «esperar sin releer» aparece cuando el que espera es
-- el que ya había decidido; no es este caso, y conviene dejarlo escrito para que nadie
-- «arregle» este guard añadiéndole comprobaciones que no le tocan.
--
-- ═══ LO QUE NO SE TOCA ═══
--  · `afirmacion` y `cita`, los otros dos eslabones de la cadena, NO necesitan candado, y
--    esto está comprobado contra el esquema vivo, no razonado de memoria:
--      · `afirmacion_insert` exige `insight.estado = 'propuesto'`, y el rol de aplicación
--        no tiene UPDATE ni DELETE sobre `afirmacion`. Una vez validado el insight, sus
--        afirmaciones no cambian.
--      · `insight_validar` es `using (estado = 'propuesto') with check (estado =
--        'validado')` y el UPDATE está concedido solo sobre `estado`, `validado_por` y
--        `validado_en`: un insight validado es inmutable para la aplicación.
--      · sobre `cita` el rol de aplicación tiene INSERT y SELECT, nada más. Una cita nueva
--        solo puede AÑADIR una con derechos vigentes (`evidencia_citable` lo exige), y
--        ninguna se puede borrar, así que un `not exists` nunca puede pasar a verdadero.
--    El único eslabón que puede empeorar el conjunto es el enlace decisión→insight.
--  · Enlazar un insight NO VALIDADO por SQL crudo sigue sin rechazarse aquí: la política
--    `decision_insight_insert` solo mira el rol. NO falla cerrado —lo comprobé después de
--    escribir esto y lo di por bueno sin verificarlo, que es el error que hay que no
--    repetir—: `cita_insert` exige `insight.estado = 'propuesto'` para crear una cita, así
--    que `propuesto` es justamente el estado en el que las citas EXISTEN, y un insight
--    propuesto bien citado atraviesa entero el re-chequeo de derechos de abajo. Lo cierra
--    la migración siguiente, 20260902260000, en la política.

-- ── El guard del gate bloquea también las DECISIONES de las que deriva el conjunto ──
-- Copia ÍNTEGRA de la versión viva (20260902240000) más el candado. Ver la advertencia
-- sobre composición de ramas en 20260902160000: este `create or replace` reescribe la
-- función entera, así que lo que no se copie se pierde — incluida la regla de G6 que
-- llegó en 20260902110000.
create or replace function gate_aprobar_suficiencia_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bloqueo text;
begin
  if new.estado = 'aprobado' and old.estado = 'pendiente' then
    new.aprobado_en := now();

    -- ═══ CANDADO SOBRE LAS DECISIONES QUE ESTE GATE CONSUME ═══
    -- Va ANTES del `for share` de `derecho_uso` porque de estas filas se DERIVA aquel
    -- conjunto: bloquear el resultado sin bloquear la fuente deja el fantasma abierto.
    -- `for share of d` y no a secas: se bloquea la decisión, que es el objeto compartido,
    -- y ni una fila de `checklist_item` de más — ese lado ya lo serializa `designio:gate:`.
    -- Orden determinista por id: dos aprobaciones no se estorban entre sí (`for share` es
    -- compatible consigo mismo), pero el orden es gratis y no hay que volver a pensarlo.
    perform d.id
      from decision d
      join checklist_item ci on ci.decision_id = d.id and ci.workspace_id = d.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and ci.decision_id is not null
      order by d.id
      for share of d;

    -- ═══ CANDADO COMPARTIDO CON QUIEN REVOCA (la mitad que faltaba) ═══
    -- Re-comprobar los derechos al aprobar cerró el eje TIEMPO, pero una comprobación
    -- SIN candado sobre estado que otro camino muta no cierra la ventana: la estrecha.
    -- Bajo READ COMMITTED esto leía `derecho_uso` sin bloquear nada, así que
    -- `decidirDerechos` podía commitear su revocación entre esta lectura y el commit del
    -- gate, y el gate quedaba aprobado sobre un respaldo ya revocado. Es literalmente el
    -- axioma de esta base —una política es un predicado sobre una instantánea, no un
    -- cerrojo— aplicado a un guard en vez de a una política.
    --
    -- El candado es de FILA sobre `derecho_uso`, no consultivo, y la elección es lo
    -- importante: quien revoca hace `update derecho_uso`, que YA toma el candado de fila
    -- en conflicto sin saber nada de este protocolo — también desde SQL crudo. Un
    -- candado consultivo obligaría a cooperar a todo el que escriba, y un consultivo y
    -- uno de fila sobre el mismo objeto no se ven entre sí. `for share` y no
    -- `for update`: dos aprobaciones de gates distintos no tienen por qué esperarse, y
    -- lo único que hay que impedir es que la revocación entre en medio.
    --
    -- Va ANTES de decidir, no después: bloquear tras comprobar deja exactamente la misma
    -- ventana. Y si la revocación ya estaba en vuelo, este `for share` espera a que
    -- commitee y Postgres re-evalúa la fila con la versión nueva (EvalPlanQual), así que
    -- las comprobaciones de abajo leen el estado posterior a la revocación y rechazan.
    -- Se bloquea el mismo conjunto de FILAS que las comprobaciones recorren, ni una más —
    -- y ahora también es el conjunto correcto, porque el `for share` sobre `decision` de
    -- arriba impide que otro camino le añada miembros mientras se decide.
    perform du.evidencia_id
      from derecho_uso du
      where du.workspace_id = new.workspace_id
        and du.evidencia_id in (
          select ci.evidencia_id from checklist_item ci
            where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
              and ci.estado = 'cumplido' and ci.evidencia_id is not null
          union
          select c.evidencia_id from checklist_item ci
            join afirmacion a on a.insight_id = ci.insight_id and a.workspace_id = ci.workspace_id
            join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
              and ci.estado = 'cumplido' and ci.insight_id is not null
          union
          select c.evidencia_id from checklist_item ci
            join decision_insight di on di.decision_id = ci.decision_id and di.workspace_id = ci.workspace_id
            join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
            join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
              and ci.estado = 'cumplido' and ci.decision_id is not null
          union
          select ae.evidencia_id from arquetipo a2
            join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
            join arquetipo_evidencia ae on ae.arquetipo_id = a2.id and ae.workspace_id = a2.workspace_id
            where new.numero = 2 and a2.reto_id = p.reto_id and a2.workspace_id = new.workspace_id
              and a2.estado = 'confirmado'
        )
      -- Orden determinista: dos aprobaciones concurrentes toman las filas comunes en el
      -- mismo orden. `for share` no se estorba consigo mismo, pero el orden es gratis.
      order by du.evidencia_id
      for share;
    if exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'pendiente') then
      raise exception 'no se puede aprobar: checklist con pendientes';
    end if;
    if not exists (select 1 from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id) then
      raise exception 'no se puede aprobar: el gate no tiene checklist instanciado';
    end if;
    if exists (select 1 from checklist_item ci
      join decision d on d.id = ci.decision_id and d.workspace_id = ci.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and d.estado <> 'vigente') then
      raise exception 'no se puede aprobar: hay ítems cumplidos con decisiones en revisión';
    end if;
    select evidencia_motivo_bloqueo(ci.evidencia_id, ci.workspace_id, 'cliente')
      into v_bloqueo
      from checklist_item ci
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and ci.evidencia_id is not null
        and not evidencia_usable(ci.evidencia_id, ci.workspace_id, 'cliente')
      limit 1;
    if found then
      raise exception 'no se puede aprobar: un ítem cumplido cita evidencia sin derechos vigentes — %',
        coalesce(v_bloqueo, 'derechos insuficientes') using errcode = 'DR001';
    end if;
    if exists (select 1 from checklist_item ci
      join afirmacion a on a.insight_id = ci.insight_id and a.workspace_id = ci.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and ci.insight_id is not null
        and not a.es_hipotesis
        and not exists (select 1 from cita c
          where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'))) then
      raise exception 'no se puede aprobar: un ítem cumplido cita un insight cuya afirmación ya no tiene ninguna cita con derechos vigentes'
        using errcode = 'DR001';
    end if;
    if exists (select 1 from checklist_item ci
      join decision_insight di on di.decision_id = ci.decision_id and di.workspace_id = ci.workspace_id
      join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
      where ci.gate_id = new.id and ci.workspace_id = new.workspace_id
        and ci.estado = 'cumplido' and ci.decision_id is not null
        and not a.es_hipotesis
        and not exists (select 1 from cita c
          where c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
            and evidencia_usable(c.evidencia_id, c.workspace_id, 'cliente'))) then
      raise exception 'no se puede aprobar: un ítem cumplido cita una decisión cuyo insight de respaldo ya no tiene ninguna cita con derechos vigentes'
        using errcode = 'DR001';
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
    -- EJE TIEMPO: confirmar un arquetipo exige evidencia enlazada, pero eso se comprobó
    -- cuando se confirmó. Entre aquel momento y éste los derechos pueden haberse revocado,
    -- y G2 se aprueba con el cliente delante sobre un perfil que ya no se sostiene. Mismo
    -- predicado del veredicto, re-evaluado con derechos vivos.
    if new.numero = 2 and exists (select 1 from arquetipo a
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where a.reto_id = p.reto_id and a.workspace_id = new.workspace_id
        and a.estado = 'confirmado'
        and not exists (select 1 from arquetipo_evidencia ae
          where ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
            and evidencia_usable(ae.evidencia_id, ae.workspace_id, 'cliente'))) then
      raise exception 'no se puede aprobar G2: un arquetipo confirmado ya no tiene ninguna evidencia con derechos vigentes que lo sostenga'
        using errcode = 'DR001';
    end if;
    -- ── ABSORBIDO de 20260902110000-medicion.sql, no reescrito ──
    -- G6 es donde el Metric Registry se acuerda y se FIRMA (SYS-22): aprobar el plan de
    -- implementación sin contrato de medición firmado deja el loop abierto por diseño.
    -- Este `create or replace` reescribe la función ENTERA, así que omitirlo la desharía;
    -- es la misma advertencia que ya lleva la rama de decisiones en revisión, con el
    -- mismo motivo. Lo que NO se copia aquí es el efecto de G6 sobre el proyecto
    -- (`en-implementacion`): vive en su propio trigger AFTER
    -- (`proyecto_a_implementacion_tras_g6`) precisamente porque su precondición lee la
    -- fila del gate que este guard, siendo BEFORE, todavía no ha escrito. Traérselo aquí
    -- lo duplicaría y encima en el único momento en que no puede funcionar.
    if new.numero = 6 and not exists (select 1 from metric_registry r
      join proyecto p on p.id = new.proyecto_id and p.workspace_id = new.workspace_id
      where r.reto_id = p.reto_id and r.workspace_id = new.workspace_id
        and r.estado = 'firmado') then
      raise exception 'no se puede aprobar G6: el Metric Registry no está firmado (SYS-22)';
    end if;
    update etapa_instancia set estado = 'completada'
      where proyecto_id = new.proyecto_id and workspace_id = new.workspace_id
        and numero = new.numero;
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (new.workspace_id, 'GateAprobado',
        -- Payload también absorbido de 110000: `aprobado_en` está en el grant y el WITH
        -- CHECK solo le exige no ser nulo, así que la fecha la propone la aplicación y
        -- nada la ata al instante real — es la clase de dato que el rastro conserva tal
        -- cual quedó.
        jsonb_build_object('gateId', new.id, 'proyectoId', new.proyecto_id,
                           'numero', new.numero, 'estado', new.estado,
                           'aprobadoPor', new.aprobado_por, 'aprobadoEn', new.aprobado_en),
        app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $$;

-- ── Y el otro lado del candado: enlazar un insight a una decisión ──
-- El guard es deliberadamente CORTO: toma el candado y se aparta. No valida nada porque no
-- decidió nada antes de esperar (ver la explicación de arriba), y añadirle comprobaciones
-- lo convertiría en una regla de dominio que no le corresponde.
create function decision_insight_candado_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Sin condición y lo primero, igual que `archivo_item_candado_guard`: esperar no le
  -- revela nada a nadie, y ponerlo antes de cualquier pre-chequeo es lo que hace que el
  -- SQL crudo —el único camino que hoy inserta aquí sin crear la decisión a la vez—
  -- participe también.
  --
  -- Cero filas es el resultado NORMAL por el camino del servicio, y es correcto:
  -- `registrarDecision` crea la decisión y sus enlaces en UNA sentencia, y una fila
  -- insertada por un CTE hermano no es visible para este trigger. Una decisión que nace en
  -- esta misma sentencia no puede estar citada todavía por el ítem de ningún gate, así que
  -- no hay nada contra lo que serializarse: `perform` sin filas no es un fallo.
  perform 1 from decision d
    where d.id = new.decision_id and d.workspace_id = new.workspace_id
    for no key update;
  return new;
end $$;

create trigger decision_insight_candado
  before insert on decision_insight
  for each row execute function decision_insight_candado_guard();

revoke execute on function decision_insight_candado_guard() from public;
