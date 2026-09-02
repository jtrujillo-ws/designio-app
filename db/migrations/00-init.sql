-- 00-init: extensiones base. El rol de aplicación lo crea db/migrate.ts (bootstrap),
-- para no versionar credenciales en SQL. Las migraciones son forward-only con ledger.
-- pgvector es deseable (búsqueda semántica intra-workspace) pero no bloqueante en local:
-- si la imagen no lo trae, se avisa y se sigue; en CI y nube la imagen sí lo incluye.
do $$
begin
  create extension if not exists vector;
exception when others then
  raise notice 'pgvector no disponible en esta instancia; se continúa sin la extensión';
end
$$;
