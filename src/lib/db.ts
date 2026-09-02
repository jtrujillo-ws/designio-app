import './server-only';
import postgres, { type Sql, type TransactionSql } from 'postgres';

/**
 * Acceso a datos de Designio.
 *
 * Dos conexiones con papeles distintos (diseño técnico · Multi-tenancy y autorización):
 * - `sqlAdmin` (DATABASE_URL): rol administrativo. SOLO migraciones, seed, jobs de sistema
 *   y exportación completa. Jamás sirve requests de negocio.
 * - `sql` (DATABASE_URL_APP): rol de aplicación NO privilegiado. Toda tabla de datos de
 *   cliente tiene RLS activo; una query sin contexto devuelve cero filas por construcción.
 *
 * El contexto de tenant se fija POR TRANSACCIÓN con `conUsuario` (SET LOCAL app.user_id);
 * las políticas resuelven membresía vía helpers SECURITY DEFINER (is_workspace_member, …).
 * Capa 2: cada server function re-valida además tenant/rol para sus reglas de negocio.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name} (ver .env.local.example)`);
  return value;
}

function pool(url: string): Sql {
  return postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10 });
}

let appSql: Sql | undefined;
let adminSql: Sql | undefined;

/** Conexión de la aplicación (rol no privilegiado, RLS activo). */
export function sql(): Sql {
  appSql ??= pool(requireEnv('DATABASE_URL_APP'));
  return appSql;
}

/** Conexión administrativa. Solo migraciones, seed, jobs de sistema y export. */
export function sqlAdmin(): Sql {
  adminSql ??= pool(requireEnv('DATABASE_URL'));
  return adminSql;
}

/**
 * Ejecuta `fn` dentro de una transacción con el contexto RLS del usuario dado.
 * Es el ÚNICO camino legítimo para leer/escribir datos de cliente desde la app.
 */
export async function conUsuario<T>(
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql().begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Cierra los pools (tests y apagado ordenado). */
export async function cerrarPools(): Promise<void> {
  await Promise.all([appSql?.end({ timeout: 5 }), adminSql?.end({ timeout: 5 })]);
  appSql = undefined;
  adminSql = undefined;
}
