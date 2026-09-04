-- El libro se abre ANTES de despachar: una llamada pagada no puede desaparecer (RF-09.14).
--
-- El defecto: la fila de `llamada_ai` se escribía al VOLVER del proveedor. Si el proveedor
-- atendía la llamada —y por tanto la cobraba— y la transacción que la anotaba fallaba de
-- forma transitoria, el `catch` descartaba la única copia del intento y la limpieza soltaba
-- la reserva. El gasto desaparecía del coste Y del tope diario, y el usuario podía
-- reintentar. La promesa «el libro registra TODA invocación» dependía de que una transacción
-- POSTERIOR a la llamada saliera bien, que es exactamente al revés de como se sostiene una
-- promesa.
--
-- Se invierte el orden: cada intento abre su línea antes de salir, con el estado nuevo
-- `despachada`, y al volver se CIERRA con su desenlace. Si el apunte previo falla, no hay
-- despacho — no se gasta lo que no se puede anotar. Y si falla el cierre, la fila se queda
-- en `despachada`: sigue contando para el tope y conserva ancla, modelo, credencial y
-- consentimiento; lo único que se pierde es el detalle del desenlace.

-- ── El estado nuevo ──
--
-- `despachada` es el estado con el que NACE toda fila. Una que se queda ahí significa
-- exactamente lo que dice —salió, y su desenlace no consta— y CUENTA para el tope, porque el
-- contador de atendidas excluye solo `sin-respuesta`. Es la dirección segura: ante la duda de
-- si el proveedor cobró, se asume que sí.
alter table llamada_ai drop constraint llamada_ai_resultado_check;
alter table llamada_ai add constraint llamada_ai_resultado_check
  check (resultado in
    ('despachada', 'salida-valida', 'rechazo-proveedor', 'fuera-de-contrato', 'sin-respuesta'));

-- El motivo se exigía a todo lo que no fuera `salida-valida`, y una línea recién abierta no
-- tiene motivo que dar todavía: su desenlace no ha ocurrido. Se exime a `despachada` y solo a
-- ella; los tres desenlaces sin contenido siguen teniendo que decir por qué.
alter table llamada_ai drop constraint llamada_ai_check4;
alter table llamada_ai add constraint llamada_ai_motivo_del_desenlace_check
  check (resultado in ('salida-valida', 'despachada') or length(btrim(motivo)) > 0);

-- ── Cerrar la línea es el ÚNICO update, y va en un solo sentido ──
--
-- `using` fija el ORIGEN (solo se puede tocar una fila despachada) y `with check` fija el
-- DESTINO (no puede quedarse despachada). Juntos: de `despachada` a un desenlace, una vez y
-- nunca al revés. Así la garantía vieja —lo que costó una llamada cerrada no se reescribe—
-- sigue en pie, que era la razón de que esta tabla no tuviera UPDATE ninguno.
create policy llamada_completar on llamada_ai
  for update
  using (
    resultado = 'despachada'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  )
  with check (
    resultado <> 'despachada'
    and workspace_role(app_user_id(), workspace_id) in ('lead-boutique', 'disenador')
  );

-- Solo las seis columnas del desenlace. `creado_en` sigue fuera por el mismo motivo que en el
-- insert —es el reloj con el que se cuenta el tope diario—, y también quedan fuera el ancla,
-- el modelo, la credencial y el consentimiento: son lo que la línea ya afirmó al abrirse, y
-- poder reescribirlos convertiría el apunte previo en una promesa vacía.
grant update (resultado, motivo, tokens_entrada, tokens_salida, costo_usd, latencia_ms)
  on llamada_ai to designio_app;

-- ── El guard, que ahora también corre en el UPDATE ──
--
-- Objetos que redefine esta migración, listados porque `create or replace` reemplaza la
-- función ENTERA: `llamada_ai_registro_guard` (cuerpo copiado del árbol migrado con
-- `pg_get_functiondef`, con el bloque del evento como único cambio) y el trigger
-- `llamada_ai_registro`, que pasa de `before insert` a `before insert or update`.

CREATE OR REPLACE FUNCTION public.llamada_ai_registro_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- ── El evento se emite al CERRAR la línea, no al abrirla ──
  --
  -- Antes se emitía en el INSERT, mirando `new.resultado`. Con el apunte previo ese INSERT
  -- es SIEMPRE `despachada`, así que ahí el desenlace todavía no se conoce: emitir entonces
  -- anotaría «llamada sin propuesta» en toda llamada, incluidas las que acaban bien. El
  -- desenlace se conoce exactamente en el UPDATE que cierra, y ahí es donde va.
  --
  -- La condición mira el TRÁNSITO (`old` → `new`) y no solo el estado nuevo: así el evento
  -- se emite UNA vez por línea, cuando deja de estar despachada, y no cada vez que alguien
  -- toque la fila. La política de completar ya impide el segundo cierre, pero un evento de
  -- auditoría no puede depender de que otra regla lo esté cubriendo.
  if tg_op = 'UPDATE'
     and old.resultado = 'despachada'
     and new.resultado <> 'salida-valida' then
    insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (new.workspace_id, 'LlamadaAISinPropuesta',
      jsonb_build_object('llamadaId', new.id, 'capacidad', new.capacidad,
                         'modelo', new.modelo, 'resultado', new.resultado,
                         'motivo', new.motivo, 'costoUsd', new.costo_usd),
      app_user_id(), workspace_role(app_user_id(), new.workspace_id));
  end if;
  return new;
end $function$;

drop trigger llamada_ai_registro on llamada_ai;
create trigger llamada_ai_registro
  before insert or update on llamada_ai
  for each row execute function llamada_ai_registro_guard();

revoke execute on function llamada_ai_registro_guard() from public;
