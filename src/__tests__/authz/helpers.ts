import { describe } from 'vitest';

/**
 * Los tests de autorización corren contra un Postgres REAL con migraciones aplicadas.
 * Sin DATABASE_URL(+_APP) se auto-omiten — y se dice explícitamente: un test omitido
 * no es un check verde (contrato operativo del stack interno).
 */
export const tieneDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL_APP);

export const describeAuthz: typeof describe = ((nombre: string, fn: () => void) => {
  if (!tieneDb) {
    console.warn(`⚠ suite authz OMITIDA (sin DATABASE_URL/DATABASE_URL_APP): ${nombre}`);
    return describe.skip(nombre, fn);
  }
  return describe(nombre, fn);
}) as typeof describe;
