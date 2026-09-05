import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { arbolParaUsuario } from '@/lib/arbol/arbol.queries';
import { crearServicio, ErrorArbol } from '@/lib/arbol/arbol.servicio';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { describeAuthz } from './helpers';

/**
 * El alta de servicio abre la superficie MÍNIMA sobre `servicio` (SPEC-02, ADR-0002): quien
 * arranca el engagement lo crea, activo y firmado; los demás roles no, ni por SQL directo;
 * un miembro de A no crea en B; el nombre no se repite en el workspace; y el evento queda con
 * el rol que autorizó el alta. Update y delete siguen cerrados.
 */
describeAuthz('alta de servicio (política + aislamiento)', () => {
  const marca = `svc-${crypto.randomUUID().slice(0, 8)}`;
  let wsA = '';
  let wsB = '';
  let lead = '';
  let adminCliente = '';
  let disenador = '';
  let sponsor = '';

  async function usuario(nombre: string, ws: string, rol: string): Promise<string> {
    const admin = sqlAdmin();
    const email = `${marca}-${nombre}@a.test`;
    const [u] = await admin`insert into usuario (email, nombre, estado)
      values (${email}, ${nombre}, 'activo') returning id`;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${u!.id as string}, ${nombre}, ${email}, ${rol})`;
    return u!.id as string;
  }

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [a] = await admin`insert into workspace (nombre) values (${marca + '-A'}) returning id`;
    const [b] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsA = a!.id as string;
    wsB = b!.id as string;
    lead = await usuario('Lead', wsA, 'lead-boutique');
    adminCliente = await usuario('Admin cliente', wsA, 'admin-cliente');
    disenador = await usuario('Diseñador', wsA, 'disenador');
    sponsor = await usuario('Sponsor', wsA, 'sponsor');
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    const wss = [wsA, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from evento_dominio where workspace_id in ${admin(wss)}`;
      await admin`delete from servicio where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    const usuarios = [lead, adminCliente, disenador, sponsor].filter((id) => id !== '');
    if (usuarios.length > 0) await admin`delete from usuario where id in ${admin(usuarios)}`;
    await cerrarPools();
  });

  it('el lead crea un servicio activo, firmado, y aparece en el árbol con su evento', async () => {
    const { servicioId } = await crearServicio(lead, {
      workspaceId: wsA,
      nombre: `${marca} Apertura de cuenta`,
      descripcion: 'Onboarding digital',
    });
    const arbol = await arbolParaUsuario(lead, wsA);
    const s = arbol?.servicios.find((x) => x.id === servicioId);
    expect(s?.nombre).toBe(`${marca} Apertura de cuenta`);
    expect(s?.estado).toBe('activo');
    expect(s?.retos).toEqual([]);

    const [fila] =
      await sqlAdmin()`select creado_por, descripcion from servicio where id = ${servicioId}`;
    expect(fila!.creado_por).toBe(lead);
    expect(fila!.descripcion).toBe('Onboarding digital');

    const eventos = await sqlAdmin()`select actor_id, actor_rol, payload from evento_dominio
      where workspace_id = ${wsA} and tipo = 'ServicioCreado'`;
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.actor_id).toBe(lead);
    expect(eventos[0]!.actor_rol).toBe('lead-boutique');
    expect((eventos[0]!.payload as { servicioId: string }).servicioId).toBe(servicioId);
  });

  it('el admin del cliente también da de alta; el diseñador y el sponsor no', async () => {
    const { servicioId } = await crearServicio(adminCliente, {
      workspaceId: wsA,
      nombre: `${marca} Reposición de tarjeta`,
      descripcion: '',
    });
    expect(servicioId).toBeTruthy();
    for (const quien of [disenador, sponsor]) {
      await expect(
        crearServicio(quien, { workspaceId: wsA, nombre: `${marca} intruso`, descripcion: '' }),
      ).rejects.toThrow(/permission denied|permiso|policy/i);
    }
  });

  it('el nombre no se repite en el workspace, ni cambiando mayúsculas', async () => {
    await expect(
      crearServicio(lead, {
        workspaceId: wsA,
        nombre: `${marca} APERTURA DE CUENTA`,
        descripcion: '',
      }),
    ).rejects.toThrow(ErrorArbol);
  });

  it('un miembro de A no crea en B, y nadie firma por otro', async () => {
    await expect(
      crearServicio(lead, { workspaceId: wsB, nombre: `${marca} ajeno`, descripcion: '' }),
    ).rejects.toThrow(/permission denied|permiso|policy/i);
    // La política exige creado_por = quien escribe: un insert directo firmado por otro
    // miembro no pasa aunque el rol sí pueda crear.
    await expect(
      conUsuario(
        lead,
        (tx) => tx`insert into servicio (workspace_id, nombre, creado_por)
        values (${wsA}, ${marca + ' firmado por otro'}, ${adminCliente})`,
      ),
    ).rejects.toThrow(/policy|permiso/i);
    // Y tampoco nace archivado: solo se abre 'activo'.
    await expect(
      conUsuario(
        lead,
        (tx) => tx`insert into servicio (workspace_id, nombre, estado, creado_por)
        values (${wsA}, ${marca + ' archivado'}, 'archivado', ${lead})`,
      ),
    ).rejects.toThrow(/policy|permiso/i);
  });

  it('update y delete siguen sin superficie para el rol de aplicación', async () => {
    const [s] = await sqlAdmin()`select id from servicio where workspace_id = ${wsA} limit 1`;
    await expect(
      conUsuario(
        lead,
        (tx) => tx`update servicio set nombre = 'alterado' where id = ${s!.id as string}`,
      ),
    ).rejects.toThrow(/permission denied|permiso/i);
    await expect(
      conUsuario(lead, (tx) => tx`delete from servicio where id = ${s!.id as string}`),
    ).rejects.toThrow(/permission denied|permiso/i);
  });

  it('aplica la capa 2: cuenta desactivada con sesión viva no crea', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${lead}`;
    try {
      await expect(
        crearServicio(lead, { workspaceId: wsA, nombre: `${marca} inactivo`, descripcion: '' }),
      ).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${lead}`;
    }
  });
});
