import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sql, sqlAdmin } from '@/lib/db';
import { describeAuthz } from './helpers';

/**
 * SYS-01/02 — aislamiento entre tenants con RLS activo, verificado en ambas capas:
 * una query sin contexto devuelve cero filas; un miembro de A jamás ve datos de B;
 * la auditoría es append-only para el rol de aplicación.
 */
describeAuthz('aislamiento por tenant (RLS activo)', () => {
  let wsA = '';
  let wsB = '';
  let userA = '';
  const marca = `authz-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [a] = await admin`insert into workspace (nombre) values (${marca + '-A'}) returning id`;
    const [b] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsA = a!.id as string;
    wsB = b!.id as string;
    const [ua] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '@a.test'}, 'Usuario A', 'activo') returning id`;
    userA = ua!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsA}, ${userA}, 'Usuario A', ${marca + '@a.test'}, 'lead-boutique')`;
    await admin`insert into segmento (workspace_id, nombre) values (${wsA}, ${marca + '-seg-A'})`;
    await admin`insert into segmento (workspace_id, nombre) values (${wsB}, ${marca + '-seg-B'})`;
    await admin`insert into evento_dominio (workspace_id, tipo) values (${wsA}, 'AuthzTest')`;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    await admin`delete from evento_dominio where workspace_id in (${wsA}, ${wsB})`;
    await admin`delete from segmento where workspace_id in (${wsA}, ${wsB})`;
    await admin`delete from miembro where workspace_id in (${wsA}, ${wsB})`;
    await admin`delete from workspace where id in (${wsA}, ${wsB})`;
    await admin`delete from usuario where id = ${userA}`;
    await cerrarPools();
  });

  it('sin contexto de usuario, la conexión de la app ve cero filas', async () => {
    const filas = await sql()`select id from workspace where id in (${wsA}, ${wsB})`;
    expect(filas.length).toBe(0);
  });

  it('un miembro de A ve su workspace y solo el suyo', async () => {
    const filas = await conUsuario(userA, (tx) => tx`select id from workspace where id in (${wsA}, ${wsB})`);
    expect(filas.map((f) => f.id)).toEqual([wsA]);
  });

  it('un miembro de A no ve los segmentos de B (cero filas, sin filtración de existencia)', async () => {
    const filas = await conUsuario(userA, (tx) => tx`select id from segmento where workspace_id = ${wsB}`);
    expect(filas.length).toBe(0);
  });

  it('un miembro de A no puede insertar segmentos en B (with check lo rechaza)', async () => {
    await expect(
      conUsuario(userA, (tx) => tx`insert into segmento (workspace_id, nombre) values (${wsB}, 'intruso')`),
    ).rejects.toThrow();
  });

  it('la auditoría es append-only para la app: update y delete se rechazan', async () => {
    await expect(
      conUsuario(userA, (tx) => tx`update evento_dominio set tipo = 'alterado' where workspace_id = ${wsA}`),
    ).rejects.toThrow(/permission denied|permiso/i);
    await expect(
      conUsuario(userA, (tx) => tx`delete from evento_dominio where workspace_id = ${wsA}`),
    ).rejects.toThrow(/permission denied|permiso/i);
  });

  it('la app puede leer y escribir DENTRO de su tenant (RLS no bloquea el caso legítimo)', async () => {
    const filas = await conUsuario(userA, async (tx) => {
      await tx`insert into evento_dominio (workspace_id, tipo, actor_id, actor_rol)
        values (${wsA}, 'AuthzTestApp', ${userA}, 'lead-boutique')`;
      return tx`select tipo from evento_dominio where workspace_id = ${wsA} order by creado_en`;
    });
    expect(filas.map((f) => f.tipo)).toContain('AuthzTestApp');
  });
});
