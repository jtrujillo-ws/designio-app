import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sql, sqlAdmin } from '@/lib/db';
import { arbolParaUsuario, construirArbol } from '@/lib/arbol/arbol.queries';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { describeAuthz } from './helpers';

/**
 * SPEC-02 — la proyección del árbol respeta RLS (SYS-01/02), el servicio ancla no se
 * duplica con la relación «afecta», la app no puede escribir el árbol todavía, y las
 * FKs compuestas impiden colgar nodos de otro workspace incluso desde código admin.
 */
describeAuthz('árbol de navegación (proyección + aislamiento)', () => {
  const marca = `arbol-${crypto.randomUUID().slice(0, 8)}`;
  let wsA = '';
  let wsB = '';
  let userA = '';
  let svcA1 = '';
  let svcA2 = '';
  let retoA = '';
  let svcB = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [a] = await admin`insert into workspace (nombre) values (${marca + '-A'}) returning id`;
    const [b] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsA = a!.id as string;
    wsB = b!.id as string;

    const [ua] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '@a.test'}, 'Usuario Árbol', 'activo') returning id`;
    userA = ua!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsA}, ${userA}, 'Usuario Árbol', ${marca + '@a.test'}, 'lead-boutique')`;

    const [s1] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsA}, ${marca + ' Servicio 1'}, ${userA}) returning id`;
    svcA1 = s1!.id as string;
    const [s2] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsA}, ${marca + ' Servicio 2'}, ${userA}) returning id`;
    svcA2 = s2!.id as string;

    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, metrica_objetivo, creado_por)
      values (${wsA}, ${svcA1}, 'R-T1', 'Reto de prueba', 'activo', '10→5', ${userA}) returning id`;
    retoA = r!.id as string;
    await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${wsA}, ${retoA}, 'P-T1', 'Proyecto de prueba', ${userA})`;
    // R-T1 ancla en Servicio 1 y AFECTA a Servicio 2 (RF-02.3).
    await admin`insert into reto_servicio_afectado (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoA}, ${svcA2}, ${wsA}, ${userA})`;
    // Arista redundante que duplica el ancla (el esquema hoy la acepta): la proyección
    // debe IGNORARLA — criterio de aceptación 1 de SPEC-02, ninguna relación duplicada.
    await admin`insert into reto_servicio_afectado (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoA}, ${svcA1}, ${wsA}, ${userA})`;

    const [sb] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsB}, ${marca + ' Servicio B'}, ${userA}) returning id`;
    svcB = sb!.id as string;
    await admin`insert into reto (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${wsB}, ${svcB}, 'R-T1', 'Reto ajeno', ${userA})`;
  });

  afterAll(async () => {
    // Si beforeAll falló a medias, limpiar solo lo que sí existe: un id vacío en el
    // IN lanzaría 22P02 y taparía el error real del setup.
    const admin = sqlAdmin();
    const wss = [wsA, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from reto_servicio_afectado where workspace_id in ${admin(wss)}`;
      await admin`delete from proyecto where workspace_id in ${admin(wss)}`;
      await admin`delete from reto where workspace_id in ${admin(wss)}`;
      await admin`delete from servicio where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    if (userA) await admin`delete from usuario where id = ${userA}`;
    await cerrarPools();
  });

  it('proyecta el árbol completo: ancla con proyecto anidado y «afecta» sin duplicar', async () => {
    const arbol = await conUsuario(userA, (tx) => construirArbol(tx, wsA, marca + '-A'));
    expect(arbol.servicios).toHaveLength(2);

    const s1 = arbol.servicios.find((s) => s.id === svcA1)!;
    expect(s1.retos.map((r) => r.codigo)).toEqual(['R-T1']);
    expect(s1.retos[0]!.metricaObjetivo).toBe('10→5');
    expect(s1.retos[0]!.proyectos.map((p) => p.codigo)).toEqual(['P-T1']);
    expect(s1.retosQueAfectan).toHaveLength(0);

    const s2 = arbol.servicios.find((s) => s.id === svcA2)!;
    expect(s2.retos).toHaveLength(0); // no duplicado: el ancla vive en Servicio 1
    expect(s2.retosQueAfectan.map((r) => r.codigo)).toEqual(['R-T1']);

    // La arista redundante que duplica el ancla NO aparece como «afecta» en Servicio 1.
    expect(s1.retosQueAfectan).toHaveLength(0);
  });

  it('arbolParaUsuario aplica la capa 2: cuenta activa lee, desactivada con sesión viva no', async () => {
    const arbol = await arbolParaUsuario(userA, wsA);
    expect(arbol?.servicios.length).toBeGreaterThan(0);

    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${userA}`;
    try {
      await expect(arbolParaUsuario(userA, wsA)).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${userA}`;
    }
  });

  it('sin contexto de usuario, el árbol es invisible (cero filas)', async () => {
    const filas = await sql()`select id from servicio where workspace_id in (${wsA}, ${wsB})`;
    expect(filas.length).toBe(0);
  });

  it('un miembro de A no ve el árbol de B, ni siquiera preguntando directo', async () => {
    const arbolB = await conUsuario(userA, (tx) => construirArbol(tx, wsB, 'B'));
    expect(arbolB.servicios).toHaveLength(0);
    const retosB = await conUsuario(userA, (tx) => tx`select id from reto where workspace_id = ${wsB}`);
    expect(retosB.length).toBe(0);
  });

  it('el rol de aplicación no puede escribir NINGUNA tabla del árbol (sin grant hasta que lleguen sus funciones)', async () => {
    await expect(
      conUsuario(userA, (tx) => tx`insert into servicio (workspace_id, nombre, creado_por)
        values (${wsA}, 'intruso', ${userA})`),
    ).rejects.toThrow(/permission denied|permiso/i);
    await expect(
      conUsuario(userA, (tx) => tx`insert into reto (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
        values (${wsA}, ${svcA1}, 'R-XX', 'intruso', ${userA})`),
    ).rejects.toThrow(/permission denied|permiso/i);
    await expect(
      conUsuario(userA, (tx) => tx`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
        values (${wsA}, ${retoA}, 'P-XX', 'intruso', ${userA})`),
    ).rejects.toThrow(/permission denied|permiso/i);
    await expect(
      conUsuario(userA, (tx) => tx`insert into reto_servicio_afectado (reto_id, servicio_id, workspace_id, creado_por)
        values (${retoA}, ${svcA2}, ${wsA}, ${userA})`),
    ).rejects.toThrow(/permission denied|permiso/i);
    await expect(
      conUsuario(userA, (tx) => tx`update reto set titulo = 'alterado' where id = ${retoA}`),
    ).rejects.toThrow(/permission denied|permiso/i);
    await expect(
      conUsuario(userA, (tx) => tx`delete from servicio where id = ${svcA1}`),
    ).rejects.toThrow(/permission denied|permiso/i);
  });

  it('las FKs compuestas rechazan colgar un reto de un servicio de otro workspace (aun como admin)', async () => {
    const admin = sqlAdmin();
    await expect(
      admin`insert into reto (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
        values (${wsB}, ${svcA1}, 'R-X', 'Cruce ilegal', ${userA})`,
    ).rejects.toThrow(/foreign key/i);
  });
});
