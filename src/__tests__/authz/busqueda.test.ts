import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { buscarEnWorkspace, buscarParaUsuario } from '@/lib/busqueda/busqueda.queries';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { describeAuthz } from './helpers';

/**
 * El buscador del workspace respeta RLS (SYS-01/02): un miembro de A encuentra lo de A y
 * nada de B aunque pregunte por B; los comodines del texto no abren la búsqueda; el reto
 * lleva a su proyecto; y la capa 2 de cuenta activa se aplica como en el árbol.
 */
describeAuthz('búsqueda del workspace (RLS + destinos)', () => {
  const marca = `busq-${crypto.randomUUID().slice(0, 8)}`;
  let wsA = '';
  let wsB = '';
  let userA = '';
  let svcA = '';
  let retoA = '';
  let proyA = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [a] = await admin`insert into workspace (nombre) values (${marca + '-A'}) returning id`;
    const [b] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsA = a!.id as string;
    wsB = b!.id as string;

    const [ua] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '@a.test'}, 'Usuario Búsqueda', 'activo') returning id`;
    userA = ua!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsA}, ${userA}, 'Usuario Búsqueda', ${marca + '@a.test'}, 'lead-boutique')`;

    const [s] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsA}, ${marca + ' Apertura de cuenta'}, ${userA}) returning id`;
    svcA = s!.id as string;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, creado_por)
      values (${wsA}, ${svcA}, 'R-B1', ${marca + ' Abandono 100% móvil'}, 'activo', ${userA})
      returning id`;
    retoA = r!.id as string;
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${wsA}, ${retoA}, 'P-B1', ${marca + ' Verificación diferida'}, ${userA}) returning id`;
    proyA = p!.id as string;
    await admin`insert into journey (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${wsA}, ${svcA}, 'as-is', ${marca + ' Journey as-is'}, ${userA})`;

    const [sb] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsB}, ${marca + ' Apertura ajena'}, ${userA}) returning id`;
    await admin`insert into reto (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${wsB}, ${sb!.id as string}, 'R-B1', ${marca + ' Reto ajeno'}, ${userA})`;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    const wss = [wsA, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from journey where workspace_id in ${admin(wss)}`;
      await admin`delete from proyecto where workspace_id in ${admin(wss)}`;
      await admin`delete from reto where workspace_id in ${admin(wss)}`;
      await admin`delete from servicio where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    if (userA) await admin`delete from usuario where id = ${userA}`;
    await cerrarPools();
  });

  it('encuentra por título y por código, en el orden del árbol, con su destino', async () => {
    const { resultados, hayMas } = await conUsuario(userA, (tx) =>
      buscarEnWorkspace(tx, wsA, marca),
    );
    expect(hayMas).toBe(false);
    expect(resultados.map((r) => r.clase)).toEqual(['servicio', 'reto', 'proyecto', 'journey']);

    const reto = resultados.find((r) => r.clase === 'reto')!;
    expect(reto.destino).toEqual({ to: '/proyecto/$proyectoId', params: { proyectoId: proyA } });
    const proyecto = resultados.find((r) => r.clase === 'proyecto')!;
    expect(proyecto.codigo).toBe('P-B1');
    expect(proyecto.destino).toEqual({
      to: '/proyecto/$proyectoId',
      params: { proyectoId: proyA },
    });

    const porCodigo = await conUsuario(userA, (tx) => buscarEnWorkspace(tx, wsA, 'p-b1'));
    expect(porCodigo.resultados.map((r) => r.id)).toEqual([proyA]);
  });

  it('los comodines del texto se buscan literales', async () => {
    const con = await conUsuario(userA, (tx) => buscarEnWorkspace(tx, wsA, '100%'));
    expect(con.resultados.map((r) => r.id)).toEqual([retoA]);
    // Sin escape, «%%%» casaría con todo el workspace.
    const solo = await conUsuario(userA, (tx) => buscarEnWorkspace(tx, wsA, '%%%'));
    expect(solo.resultados).toHaveLength(0);
  });

  it('un miembro de A no encuentra nada de B, ni siquiera preguntando por B', async () => {
    const enA = await conUsuario(userA, (tx) => buscarEnWorkspace(tx, wsA, 'ajen'));
    expect(enA.resultados).toHaveLength(0);
    const enB = await conUsuario(userA, (tx) => buscarEnWorkspace(tx, wsB, marca));
    expect(enB.resultados).toHaveLength(0);
  });

  it('aplica la capa 2: cuenta desactivada con sesión viva no busca', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${userA}`;
    try {
      await expect(buscarParaUsuario(userA, wsA, marca)).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${userA}`;
    }
  });
});
