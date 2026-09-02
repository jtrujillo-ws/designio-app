-- 00-init: extensiones base. El rol de aplicación lo crea db/migrate.ts (bootstrap),
-- para no versionar credenciales en SQL. Las migraciones son forward-only con ledger.
-- Piso soportado: PostgreSQL 15 (gen_random_uuid() es builtin del core desde PG 13,
-- sin pgcrypto).
-- pgvector es deseable (búsqueda semántica intra-workspace) pero no bloqueante en local:
-- si la imagen no lo trae, se avisa y se sigue; en CI y nube la imagen sí lo incluye.
do $$
begin
  create extension if not exists vector;
exception when others then
  raise notice 'pgvector no disponible en esta instancia; se continúa sin la extensión';
end
$$;
