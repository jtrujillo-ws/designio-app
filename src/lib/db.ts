import './server-only';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { ErrorConfiguracion } from './configuracion.server';

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
  if (!value) {
    throw new ErrorConfiguracion(`Falta la variable de entorno ${name} (ver .env.local.example)`);
  }
  return value;
}

/*
 * Que la variable EXISTA no la hace una cadena de conexión. Medido con el valor que un
 * despliegue real llegó a tener —«postgres.railway.internal / 5432», el host y el puerto en
 * vez de la URL—: `postgres()` lanza un `TypeError` al construir el pool, antes de la primera
 * consulta. Sin este envoltorio ese TypeError salía tal cual por la server function de login y
 * la pantalla lo presentaba como «intenta de nuevo», que es un reintento que no puede
 * funcionar nunca.
 *
 * El nombre de la variable entra en el mensaje y el valor NO: un DSN lleva la contraseña
 * dentro, y este mensaje acaba en el registro del servidor. Y el error del parser tampoco se
 * adjunta como `cause`: medido, ante un DSN de libpq —«host=… password=…»— ese error sale con
 * la cadena ENTERA en su mensaje. `serve.ts` ya suprime este mismo error por lo mismo.
 */
function pool(nombre: string, url: string): Sql {
  try {
    return postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10 });
  } catch {
    throw new ErrorConfiguracion(
      `${nombre} no es una cadena de conexión válida (se espera postgres://usuario:clave@host:puerto/base)`,
    );
  }
}

let appSql: Sql | undefined;
let adminSql: Sql | undefined;

/** Conexión de la aplicación (rol no privilegiado, RLS activo). */
export function sql(): Sql {
  appSql ??= pool('DATABASE_URL_APP', requireEnv('DATABASE_URL_APP'));
  return appSql;
}

/** Conexión administrativa. Solo migraciones, seed, jobs de sistema y export. */
export function sqlAdmin(): Sql {
  adminSql ??= pool('DATABASE_URL', requireEnv('DATABASE_URL'));
  return adminSql;
}

/**
 * Ejecuta `fn` dentro de una transacción con el contexto RLS del usuario dado.
 * Es el ÚNICO camino legítimo para leer/escribir datos de cliente desde la app.
 *
 * `aislamiento: 'repeatable read'` para las operaciones que leen MUCHAS tablas y tienen
 * que devolver una foto coherente (la exportación). El nivel se fija en el propio BEGIN
 * y no con un `set transaction` posterior porque Postgres prohíbe cambiarlo después de la
 * primera sentencia — y aquí la primera es el `set_config` del contexto RLS. Bajo
 * READ COMMITTED cada sentencia abre su propio snapshot, así que un cambio commiteado a
 * mitad de una lectura larga deja piezas de dos instantes distintos en la misma respuesta.
 *
 * Es para operaciones de SOLO LECTURA, y no es una recomendación: desde
 * `20260902330000` la base RECHAZA (`IS001`) escribir fuera de READ COMMITTED en toda
 * tabla cuyos guards serializan con candado y releen — que es la mayoría de las que
 * gobiernan reglas. La razón es que esos guards dependen de que cada sentencia abra
 * instantánea nueva, y eso solo es cierto bajo READ COMMITTED; bajo un nivel más fuerte la
 * relectura ve una foto anterior al cambio que espera ver y la escritura se cuela en
 * silencio. La exportación encaja porque lo único que escribe es su evento de auditoría, y
 * `evento_dominio` es append-only y no tiene ningún guard que serialice.
 */
export async function conUsuario<T>(
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
  opciones?: { aislamiento?: 'repeatable read' },
): Promise<T> {
  const cuerpo = async (tx: TransactionSql) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  };
  const inicio = opciones?.aislamiento;
  return (
    inicio ? sql().begin(`isolation level ${inicio}`, cuerpo) : sql().begin(cuerpo)
  ) as Promise<T>;
}

/** Cierra los pools (tests y apagado ordenado). */
export async function cerrarPools(): Promise<void> {
  await Promise.all([appSql?.end({ timeout: 5 }), adminSql?.end({ timeout: 5 })]);
  appSql = undefined;
  adminSql = undefined;
}
