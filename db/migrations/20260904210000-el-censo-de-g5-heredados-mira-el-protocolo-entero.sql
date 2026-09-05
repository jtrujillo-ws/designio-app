-- RF-06.3 / SYS-14 — LOS G5 HEREDADOS, NOMBRADOS POR EL PROTOCOLO ENTERO.
--
-- `20260902320000` nombró los G5 ya aprobados que certificaban sobre razonamiento muerto, y
-- dejó dicho el alcance de su censo con precisión: «Lo que el censo comprueba es lo que ESTA
-- migración añade: que toda afirmación no-hipótesis del razonamiento certificado conserve
-- una cita con derechos vigentes. Las otras dos comprobaciones del protocolo llegan a la
-- ruta de G5 en 20260902340000, y su censo le corresponde a esa migración, no a ésta.»
--
-- Ese censo nunca se escribió. Así que hoy hay G5 aprobados que este esquema rechazaría en
-- runtime —porque su razonamiento se apoya en una decisión EN REVISIÓN, o se traza a un
-- insight SIN VALIDAR— y que nadie ha nombrado. No es una puerta abierta: el guard vivo los
-- rechaza. Es que el operador no puede enterarse sin chocarse con ellos.
--
-- ── Por qué este censo sí llama al predicado, y el de `320000` no podía ──
--
-- Aquel dejó escrita la razón: «no llama a `razonamiento_sin_respaldo` […] porque esa
-- función usa `evidencia_usable`, que lleva delante la puerta
-- `is_workspace_member(app_user_id(), …)`. Aquí corre `db/migrate.ts` con la conexión
-- administrativa y sin `app.user_id`, así que la puerta sería falsa siempre y el censo
-- marcaría TODOS los G5 como rotos». Por eso se vio obligado a reescribir el recorrido.
--
-- La migración anterior a ésta saca esa puerta del predicado crudo. Con eso, la razón deja
-- de existir: el censo puede invocar la MISMA función que el guard, que es lo que este
-- repositorio hace en todas partes cuando dos sitios deciden lo mismo. El recorrido —de
-- `elemento_cambio` a `elemento_insight` / `elemento_decision`— sí es propio de la ruta de
-- G5 y se escribe aquí, igual que en el guard.
--
-- ── Qué se emite ──
--
-- Un evento por G5 aprobado cuyo razonamiento NO pasa el protocolo, con el motivo dentro.
-- Cubre las cuatro comprobaciones, no solo las dos que faltaban: un G5 cuyo único problema
-- sea el de las afirmaciones ya lo nombró `320000` y volverá a aparecer aquí, ahora CON su
-- motivo. No se borra ni se deduplica el evento viejo — el registro de dominio es historia,
-- y esta base no reescribe la historia; se distingue por el tipo.
--
-- No se revierte ningún gate, por lo mismo que allí: aprobar es un juicio humano y este
-- dominio no lo deshace. Y hay salida — revalidar la decisión, validar el insight o
-- reconceder los derechos revive el razonamiento entero.
-- ── Y va en una FUNCIÓN, no suelto en el insert ──
--
-- Un bloque de censo corre UNA vez, al aplicar la migración: escrito suelto, no hay forma de
-- comprobarlo sin copiar su consulta en un test —y una copia es exactamente lo que este
-- protocolo lleva tres migraciones evitando—. En una función se puede invocar: la migración
-- la llama para nombrar lo heredado, el test la llama sobre un caso fabricado, y al operador
-- le queda un diagnóstico que puede volver a correr cuando quiera en vez de un evento de una
-- sola noche.
create function g5_sin_razonamiento_usable()
returns table (ws uuid, gate_id uuid, proyecto_id uuid, motivo text)
language sql stable security definer set search_path = public, pg_temp as $$
  select g.workspace_id, g.id, g.proyecto_id, m.motivo
  from gate_instancia g
join lateral (
  select razonamiento_sin_respaldo(
    g.workspace_id,
    array(select ei.insight_id
            from elemento_cambio ec
            join elemento_insight ei on ei.elemento_id = ec.id
              and ei.workspace_id = ec.workspace_id
            where ec.workspace_id = g.workspace_id
              and ec.design_version_id in (
                select design_versions_a_cargo_del_proyecto(g.proyecto_id, g.workspace_id))),
    array(select ed.decision_id
            from elemento_cambio ec
            join elemento_decision ed on ed.elemento_id = ec.id
              and ed.workspace_id = ec.workspace_id
            where ec.workspace_id = g.workspace_id
              and ec.design_version_id in (
                select design_versions_a_cargo_del_proyecto(g.proyecto_id, g.workspace_id))),
    array[]::uuid[]
  ) as motivo
) m on true
  where g.numero = 5 and g.estado = 'aprobado' and m.motivo is not null
$$;
comment on function g5_sin_razonamiento_usable() is
'Los G5 ya aprobados cuyo razonamiento NO pasa el protocolo compartido, con su motivo. Invoca `razonamiento_sin_respaldo` —la misma función que el guard— en vez de reescribir sus comprobaciones; el recorrido de `elemento_cambio` a insights y decisiones sí es propio de la ruta de G5. Diagnóstico de solo lectura: no revierte ningún gate.';
revoke execute on function g5_sin_razonamiento_usable() from public;

insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select ws, 'G5CertificadoSinRazonamientoUsable',
       jsonb_build_object('gateId', gate_id, 'proyectoId', proyecto_id, 'motivo', motivo),
       null::uuid, null::text
from g5_sin_razonamiento_usable();
