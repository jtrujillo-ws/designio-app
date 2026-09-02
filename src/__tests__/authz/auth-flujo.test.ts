import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import {
  activarConToken,
  autenticar,
  crearInvitacion,
  ErrorAutorizacion,
  usuarioConMembresias,
} from '@/lib/auth/auth.servicio';
import { hashPassword } from '@/lib/auth/password.server';
import { describeAuthz } from './helpers';

/**
 * Flujo de auth nativa contra el Postgres real: login por SECURITY DEFINER + bcrypt,
 * invitación con doble capa de autorización (re-check de rol + política RLS de miembro)
 * y activación por token de un solo uso.
 */
describeAuthz('auth nativa (login, invitación, activación)', () => {
  const marca = `auth-${crypto.randomUUID().slice(0, 8)}`;
  const emailLead = `${marca}-lead@test.demo`;
  const emailStake = `${marca}-stake@test.demo`;
  const emailInvitada = `${marca}-inv@test.demo`;
  const emailColada = `${marca}-colada@test.demo`;
  const PASSWORD_LEAD = 'ClaveDeLead123';
  let ws = '';
  let leadId = '';
  let stakeId = '';
  let coladaId = '';
  let invitadaId = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const hash = await hashPassword(PASSWORD_LEAD);
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;

    const [lead] = await admin`insert into usuario (email, nombre, password_hash, estado)
      values (${emailLead}, 'Lead Test', ${hash}, 'activo') returning id`;
    leadId = lead!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${leadId}, 'Lead Test', ${emailLead}, 'lead-boutique')`;

    const [stake] = await admin`insert into usuario (email, nombre, password_hash, estado)
      values (${emailStake}, 'Stake Test', ${hash}, 'activo') returning id`;
    stakeId = stake!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${stakeId}, 'Stake Test', ${emailStake}, 'stakeholder')`;

    // Cuenta ya activa SIN membresía en ws: para el caso "invitar a alguien con cuenta".
    const [colada] = await admin`insert into usuario (email, nombre, password_hash, estado)
      values (${emailColada}, 'Colada Test', ${hash}, 'activo') returning id`;
    coladaId = colada!.id as string;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    await admin`delete from evento_dominio where workspace_id = ${ws}`;
    await admin`delete from miembro where workspace_id = ${ws}`;
    await admin`delete from workspace where id = ${ws}`;
    await admin`delete from usuario where email in (${emailLead}, ${emailStake}, ${emailInvitada}, ${emailColada})`;
    await cerrarPools();
  });

  it('autentica con credenciales correctas (case-insensitive en el email)', async () => {
    const u = await autenticar(emailLead.toUpperCase(), PASSWORD_LEAD);
    expect(u?.id).toBe(leadId);
  });

  it('rechaza password incorrecta y cuenta inexistente con el mismo resultado', async () => {
    expect(await autenticar(emailLead, 'incorrecta-123')).toBeNull();
    expect(await autenticar(`${marca}-nadie@test.demo`, PASSWORD_LEAD)).toBeNull();
  });

  it('un stakeholder no invita: capa 2 (re-check de rol) y capa 1 (política RLS de miembro)', async () => {
    await expect(
      crearInvitacion(stakeId, {
        workspaceId: ws,
        email: `${marca}-x@test.demo`,
        nombre: 'X Test',
        rol: 'disenador',
      }),
    ).rejects.toThrow(ErrorAutorizacion);

    // Saltándose la capa 2: el INSERT directo de la membresía lo rechaza la política.
    await expect(
      conUsuario(stakeId, (tx) => tx`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${coladaId}, 'Colada Test', ${emailColada}, 'disenador')`),
    ).rejects.toThrow(/row-level security/);
  });

  it('lead invita → el token activa la cuenta una sola vez → la invitada entra y ve su workspace', async () => {
    const inv = await crearInvitacion(leadId, {
      workspaceId: ws,
      email: emailInvitada,
      nombre: 'Diseñadora Test',
      rol: 'disenador',
    });
    invitadaId = inv.usuarioId;
    expect(inv.requiereActivacion).toBe(true);
    expect(inv.token).toBeTruthy();

    // Sin activar todavía: sin password no hay login.
    expect(await autenticar(emailInvitada, 'ClaveNueva1234')).toBeNull();

    const activada = await activarConToken(inv.token!, 'ClaveNueva1234');
    expect(activada?.id).toBe(invitadaId);

    // El token se consume al usarse.
    expect(await activarConToken(inv.token!, 'OtraClave12345')).toBeNull();

    const u = await autenticar(emailInvitada, 'ClaveNueva1234');
    expect(u?.id).toBe(invitadaId);

    const perfil = await usuarioConMembresias(invitadaId);
    expect(perfil?.membresias.map((m) => m.workspaceId)).toEqual([ws]);
  });

  it('un token desconocido no activa nada', async () => {
    expect(await activarConToken('token-inventado', 'ClaveValida123')).toBeNull();
  });

  it('invitar a una cuenta ya activa agrega la membresía sin token nuevo', async () => {
    const inv = await crearInvitacion(leadId, {
      workspaceId: ws,
      email: emailColada,
      nombre: 'Colada Test',
      rol: 'stakeholder',
    });
    expect(inv.usuarioId).toBe(coladaId);
    expect(inv.requiereActivacion).toBe(false);
    expect(inv.token).toBeNull();
  });

  it('invitar a quien ya es miembro falla por unicidad (la server function lo traduce)', async () => {
    await expect(
      crearInvitacion(leadId, {
        workspaceId: ws,
        email: emailInvitada,
        nombre: 'Diseñadora Test',
        rol: 'disenador',
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
