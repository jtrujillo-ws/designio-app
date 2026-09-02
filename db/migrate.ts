/**
 * Migraciones forward-only con ledger (patrón del stack interno):
 * - db/migrations/*.sql se aplican en orden de nombre, exactamente una vez.
 * - El ledger es public.schema_migrations; idempotente (seguro en el arranque del contenedor).
 * - Corre con la conexión ADMIN (DATABASE_URL). Bootstrap: crea el rol de aplicación
 *   no privilegiado si no existe (password por env; default solo-desarrollo).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Falta DATABASE_URL (conexión admin; ver .env.local.example)');

const sql = postgres(url, { max: 1, onnotice: () => {} });

const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

async function main() {
  await sql`create table if not exists schema_migrations (
    id text primary key,
    aplicado_en timestamptz not null default now()
  )`;

  // Bootstrap del rol de aplicación (no privilegiado): las migraciones le otorgan permisos.
  // El default de desarrollo JAMÁS aplica en producción: sin APP_DB_PASSWORD ahí, se aborta
  // (el Dockerfile fija NODE_ENV=production; en nube el secret viene de Secret Manager).
  const [rol] = await sql`select 1 from pg_roles where rolname = 'designio_app'`;
  if (!rol) {
    let appPassword = process.env.APP_DB_PASSWORD;
    if (!appPassword) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'Falta APP_DB_PASSWORD: en producción el rol designio_app no puede crearse con la credencial de desarrollo',
        );
      }
      console.warn('APP_DB_PASSWORD no definido: usando la credencial de DESARROLLO para designio_app');
      appPassword = 'designio_app_dev';
    }
    await sql.unsafe(`create role designio_app login password '${appPassword.replaceAll("'", "''")}'`);
    console.log('rol designio_app creado (no privilegiado)');
  }

  const archivos = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const aplicadas = new Set(
    (await sql`select id from schema_migrations`).map((r) => r.id as string),
  );

  for (const archivo of archivos) {
    if (aplicadas.has(archivo)) continue;
    const contenido = await readFile(join(MIGRATIONS_DIR, archivo), 'utf-8');
    console.log(`aplicando ${archivo}…`);
    await sql.begin(async (tx) => {
      await tx.unsafe(contenido);
      await tx`insert into schema_migrations (id) values (${archivo})`;
    });
  }
  console.log(`migraciones al día (${archivos.length} en total, ${archivos.length - aplicadas.size} aplicadas ahora)`);
}

await main().finally(() => sql.end({ timeout: 5 }));
