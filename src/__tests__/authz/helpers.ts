import { describe } from 'vitest';
import type { TransactionSql } from 'postgres';
import { sqlAdmin } from '@/lib/db';

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

/**
 * Deja una transacción ADMIN abierta después de ejecutar `fn`, y devuelve cómo cerrarla.
 * Es la única forma de comprobar un candado de verdad: hay que tener el conflicto EN
 * VUELO —commiteado ni bloquea ni prueba nada— mientras el otro camino intenta decidir.
 */
export async function enVuelo(
  fn: (tx: TransactionSql) => Promise<void>,
): Promise<{ cerrar: () => Promise<void> }> {
  let listo!: () => void;
  const tomado = new Promise<void>((r) => {
    listo = r;
  });
  let liberar!: () => void;
  const puedeCerrar = new Promise<void>((r) => {
    liberar = r;
  });
  const terminada = sqlAdmin().begin(async (tx) => {
    await fn(tx);
    listo();
    await puedeCerrar;
  });
  await tomado;
  return {
    cerrar: async () => {
      liberar();
      await terminada;
    },
  };
}

/**
 * ¿La promesa sigue SIN resolverse pasado `ms`? Es cómo se comprueba que algo espera por
 * un candado: sin candado compartido, la operación resuelve en milisegundos porque su
 * lectura no choca con nada. Se enganchan los dos manejadores antes de esperar para que
 * un rechazo no quede sin capturar.
 */
export async function sigueEsperando(p: Promise<unknown>, ms = 400): Promise<boolean> {
  let resuelta = false;
  const marcar = () => {
    resuelta = true;
  };
  p.then(marcar, marcar);
  await new Promise((r) => setTimeout(r, ms));
  return !resuelta;
}
