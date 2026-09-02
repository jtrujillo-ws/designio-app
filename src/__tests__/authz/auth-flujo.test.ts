import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import {
  activarConToken,
  autenticar,
  crearInvitacion,
  ErrorAutorizacion,
  ErrorInvitacion,
  listarMiembros,
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
  const emailLeadB = `${marca}-leadb@test.demo`;
  const emailStake = `${marca}-stake@test.demo`;
  const emailInvitada = `${marca}-inv@test.demo`;
  const emailPendiente = `${marca}-pend@test.demo`;
  const emailColada = `${marca}-colada@test.demo`;
  const PASSWORD_LEAD = 'ClaveDeLead123';
  let ws = '';
  let wsB = '';
  let leadId = '';
  let leadBId = '';
  let stakeId = '';
  let coladaId = '';
  let invitadaId = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const hash = await hashPassword(PASSWORD_LEAD);
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;
    const [wb] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsB = wb!.id as string;

    const [lead] = await admin`insert into usuario (email, nombre, password_hash, estado)
      values (${emailLead}, 'Lead Test', ${hash}, 'activo') returning id`;
    leadId = lead!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${leadId}, 'Lead Test', ${emailLead}, 'lead-boutique')`;

    // Lead de OTRO tenant: para verificar que no puede reclamar cuentas pendientes ajenas.
    const [leadB] = await admin`insert into usuario (email, nombre, password_hash, estado)
      values (${emailLeadB}, 'Lead B Test', ${hash}, 'activo') returning id`;
    leadBId = leadB!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsB}, ${leadBId}, 'Lead B Test', ${emailLeadB}, 'lead-boutique')`;

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
    await admin`delete from evento_dominio where workspace_id in (${ws}, ${wsB})`;
    await admin`delete from miembro where workspace_id in (${ws}, ${wsB})`;
    await admin`delete from workspace where id in (${ws}, ${wsB})`;
    await admin`delete from usuario where email in
      (${emailLead}, ${emailLeadB}, ${emailStake}, ${emailInvitada}, ${emailPendiente}, ${emailColada})`;
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
    expect(inv.reemision).toBe(false);

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

  it('re-emisión, y el token de una cuenta pendiente NUNCA sale hacia otro workspace (anti-takeover)', async () => {
    // ws origina la invitación de una cuenta que queda pendiente.
    const primera = await crearInvitacion(leadId, {
      workspaceId: ws,
      email: emailPendiente,
      nombre: 'Pendiente Test',
      rol: 'stakeholder',
    });
    expect(primera.token).toBeTruthy();

    // El workspace de ORIGEN puede re-emitir el enlace (recupera invitaciones perdidas)…
    const reemitida = await crearInvitacion(leadId, {
      workspaceId: ws,
      email: emailPendiente,
      nombre: 'Pendiente Test',
      rol: 'stakeholder',
    });
    expect(reemitida.reemision).toBe(true);
    expect(reemitida.token).toBeTruthy();
    // …y el enlace anterior queda invalidado.
    expect(await activarConToken(primera.token!, 'ClaveCualquiera1')).toBeNull();

    // Otro tenant invita el mismo email: agrega SU membresía pero no recibe token
    // ni pisa el enlace del origen — no puede reclamar la cuenta pendiente.
    const ajena = await crearInvitacion(leadBId, {
      workspaceId: wsB,
      email: emailPendiente,
      nombre: 'Pendiente Test',
      rol: 'stakeholder',
    });
    expect(ajena.usuarioId).toBe(primera.usuarioId);
    expect(ajena.requiereActivacion).toBe(true);
    expect(ajena.token).toBeNull();

    // El enlace vigente del origen sigue funcionando y, al activar, la persona
    // (dueña real de la cuenta) ve las membresías de ambos workspaces.
    const activada = await activarConToken(reemitida.token!, 'ClaveDePendiente1');
    expect(activada?.id).toBe(primera.usuarioId);
    const perfil = await usuarioConMembresias(primera.usuarioId);
    expect(perfil?.membresias.map((m) => m.workspaceId).sort()).toEqual([ws, wsB].sort());
  });

  it('una cuenta migrada (origen null) la adopta el primer workspace que la invita', async () => {
    const emailMigrada = `${marca}-migrada@test.demo`;
    const admin = sqlAdmin();
    // Simula el backfill pre-auth de la migración: invitado sin origen ni token.
    const [u] = await admin`insert into usuario (email, nombre, estado)
      values (${emailMigrada}, 'Migrada Test', 'invitado') returning id`;
    const migradaId = u!.id as string;
    try {
      const inv = await crearInvitacion(leadId, {
        workspaceId: ws,
        email: emailMigrada,
        nombre: 'Migrada Test',
        rol: 'stakeholder',
      });
      expect(inv.usuarioId).toBe(migradaId);
      expect(inv.token).toBeTruthy(); // adoptó el origen y emitió enlace

      // Desde la adopción, otro tenant ya no recibe ni pisa el token.
      const ajena = await crearInvitacion(leadBId, {
        workspaceId: wsB,
        email: emailMigrada,
        nombre: 'Migrada Test',
        rol: 'stakeholder',
      });
      expect(ajena.token).toBeNull();

      const activada = await activarConToken(inv.token!, 'ClaveMigrada123');
      expect(activada?.id).toBe(migradaId);
    } finally {
      await admin`delete from miembro where usuario_id = ${migradaId}`;
      await admin`delete from usuario where id = ${migradaId}`;
    }
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
    expect(inv.reemision).toBe(false);
  });

  it('una cuenta desactivada con sesión viva no muta NI lee datos de gestión (re-check de estado)', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${leadId}`;
    try {
      await expect(
        crearInvitacion(leadId, {
          workspaceId: ws,
          email: `${marca}-tarde@test.demo`,
          nombre: 'Tarde Test',
          rol: 'disenador',
        }),
      ).rejects.toThrow(ErrorAutorizacion);
      await expect(listarMiembros(leadId, ws)).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${leadId}`;
    }
  });

  it('re-invitar a un miembro ya activo es un error de dominio claro', async () => {
    await expect(
      crearInvitacion(leadId, {
        workspaceId: ws,
        email: emailInvitada,
        nombre: 'Diseñadora Test',
        rol: 'disenador',
      }),
    ).rejects.toThrow(ErrorInvitacion);
  });
});
