-- SYS-01/02 — LA PREMISA DE TODOS LOS PROTOCOLOS DE ESTA BASE, ESCRITA Y APLICADA.
--
-- Media docena de guards de este esquema serializan con candado —consultivo, de fila, o
-- los dos— y después RELEEN para decidir. Eso funciona porque bajo READ COMMITTED cada
-- sentencia abre instantánea nueva, así que la relectura ve lo que la otra transacción
-- commiteó mientras se esperaba. Medido, para no razonarlo de memoria:
--
--   read committed   select     -> lee el valor nuevo
--   read committed   for share  -> lee el valor nuevo
--   repeatable read  select     -> lee el VIEJO          ← la relectura es decorativa
--   repeatable read  for share  -> aborta 40001
--
-- Bajo REPEATABLE READ la premisa es falsa, y el nivel de aislamiento **lo elige quien
-- llama**. Tres hallazgos distintos han salido ya de esa grieta, y el candado de fila solo
-- cubre uno de los tres: aborta si alguien ESCRIBIÓ la fila, no si solo la bloqueó, y no
-- puede hacer nada contra un fantasma —una fila insertada después de la instantánea
-- sencillamente no está en la foto, y RR no detecta fantasmas: eso solo lo hace
-- SERIALIZABLE—.
--
-- ── Por qué esta forma y no «hacer cada protocolo RR-seguro» ──
-- La alternativa es que cada protocolo fuerce una escritura real sobre la fila compartida
-- (una columna de versión) para que RR se entere. Se puede, son 26 guards de seis slices
-- distintos, y sobre todo: **no es verificable**. «¿Te acordaste de incrementar la versión
-- en el insertor?» no es una pregunta que un test pueda hacer. «¿Esta tabla con guard que
-- serializa tiene puesta la comprobación?» sí lo es, y es el patrón con el que este
-- repositorio convierte un deseo en invariante.
--
-- Así que la premisa deja de suponerse: se comprueba, y una escritura fuera de READ
-- COMMITTED falla EN VOZ ALTA en vez de colarse en silencio.
--
-- ── Y no rompe la exportación, que es lo que hacía falta que no rompiera ──
-- La exportación corre en `repeatable read` a propósito —un recibo cosido de treinta
-- instantes no acredita nada— y escribe exactamente una fila: su evento de auditoría en
-- `evento_dominio`, tabla append-only sin ningún guard que serialice y por tanto FUERA del
-- conjunto que se deriva abajo. La premisa queda partida limpiamente: lo que necesita RR
-- solo lee, lo que muta bajo un protocolo exige RC.
create function exigir_aislamiento_de_escritura() returns trigger
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
    raise exception 'esta escritura exige aislamiento READ COMMITTED y la transacción está en «%». Los guards de esta tabla serializan con candado y vuelven a leer, y fuera de READ COMMITTED una sentencia posterior no toma instantánea nueva: la relectura vería una foto anterior al cambio que está esperando ver, y la escritura se colaría en silencio. Abre la transacción en read committed, o usa un aislamiento más fuerte solo para LEER (así lo hace la exportación)', v_nivel
      using errcode = 'IS001';
  end if;
  return null;
end $$;
comment on function exigir_aislamiento_de_escritura() is
'Hace explícita —y exigible— la premisa de la que dependen los guards que serializan con candado y releen: que cada sentencia abra instantánea nueva, que solo es cierto bajo READ COMMITTED.';

revoke execute on function exigir_aislamiento_de_escritura() from public;

-- ── El conjunto de tablas NO se escribe a mano: se deriva ──
-- Una lista escrita a mano se queda corta el día que alguien cuelgue un guard nuevo. Se
-- recorre el catálogo: toda tabla con un trigger cuya función toma candado —consultivo o
-- de fila— depende de la semántica de relectura y por tanto necesita la comprobación. Un
-- test estructural repite exactamente esta derivación, así que si mañana aparece una tabla
-- que cumple el criterio y no tiene el trigger, se para ahí y no en producción.
do $$
declare r record;
begin
  for r in
    -- El CTE va `materialized` a propósito, y no es cosmética: sin él el planificador
    -- puede evaluar `pg_get_functiondef` como filtro sobre `pg_proc` ANTES del join, y
    -- esa función revienta sobre los agregados del catálogo («"avg" is an aggregate
    -- function», 42809). Pasó en CI —Postgres 15— y no en local —16—, que es exactamente
    -- la clase de diferencia que un plan distinto produce. Materializar primero el
    -- conjunto de funciones que SON de trigger deja a `pg_get_functiondef` sin agregados
    -- que mirar.
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
    order by 1
  loop
    execute format(
      'create trigger aislamiento_de_escritura
         before insert or update or delete on %s
         for each statement execute function exigir_aislamiento_de_escritura()', r.tabla);
  end loop;
end $$;
