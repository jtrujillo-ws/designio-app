import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sql, sqlAdmin } from '@/lib/db';
import {
  activarConToken,
  autenticar,
  crearInvitacion,
  ErrorAutorizacion,
  ErrorInvitacion,
  listarMiembros,
  usuarioConMembresias,
} from '@/lib/auth/auth.servicio';
import { hashPassword, hashTokenInvitacion } from '@/lib/auth/password.server';
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

  it('el login compara la password en bytes exactos: tras el byte 72 un sufijo no autentica', async () => {
    const email72 = `${marca}-borde72@test.demo`;
    const pass72 = 'a'.repeat(72);
    const admin = sqlAdmin();
    const [u] = await admin`insert into usuario (email, nombre, password_hash, estado)
      values (${email72}, 'Borde Test', ${await hashPassword(pass72)}, 'activo') returning id`;
    try {
      expect((await autenticar(email72, pass72))?.id).toBe(u!.id as string);
      // bcrypt truncaría el sufijo y aceptaría; el corte por bytes lo rechaza.
      expect(await autenticar(email72, `${pass72}x`)).toBeNull();
    } finally {
      await admin`delete from usuario where id = ${u!.id as string}`;
    }
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

    // RF-01.6: la activación queda en la auditoría del workspace que emitió el enlace
    // (una sola vez — el intento repetido de arriba no duplica el evento).
    const eventos = await sqlAdmin()`select actor_rol from evento_dominio
      where workspace_id = ${ws} and tipo = 'UsuarioActivado' and actor_id = ${invitadaId}`;
    expect(eventos.length).toBe(1);
    expect(eventos[0]?.actor_rol).toBe('disenador');

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

  it('una cuenta migrada solo la re-invita su workspace de origen (membresía legacy más antigua)', async () => {
    const emailMigrada = `${marca}-migrada@test.demo`;
    const admin = sqlAdmin();
    // Simula el backfill de la migración: cuenta 'invitado' sin token, con su
    // membresía legacy y ese workspace como origen (lo fija el propio backfill).
    const [u] = await admin`insert into usuario (email, nombre, estado, invitacion_origen_ws)
      values (${emailMigrada}, 'Migrada Test', 'invitado', ${ws}) returning id`;
    const migradaId = u!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${migradaId}, 'Migrada Test', ${emailMigrada}, 'stakeholder')`;
    try {
      // Un tenant ajeno NO puede quedarse con la identidad migrada: agrega su
      // membresía pero jamás recibe el enlace de activación de la cuenta.
      const ajena = await crearInvitacion(leadBId, {
        workspaceId: wsB,
        email: emailMigrada,
        nombre: 'Migrada Test',
        rol: 'stakeholder',
      });
      expect(ajena.usuarioId).toBe(migradaId);
      expect(ajena.token).toBeNull();
      expect(ajena.requiereActivacion).toBe(true);

      // El origen re-invita (el re-onboarding natural de cuentas migradas) y emite.
      const inv = await crearInvitacion(leadId, {
        workspaceId: ws,
        email: emailMigrada,
        nombre: 'Migrada Test',
        rol: 'stakeholder',
      });
      expect(inv.usuarioId).toBe(migradaId);
      expect(inv.reemision).toBe(true);
      expect(inv.token).toBeTruthy();

      const activada = await activarConToken(inv.token!, 'ClaveMigrada123');
      expect(activada?.id).toBe(migradaId);
    } finally {
      await admin`delete from miembro where usuario_id = ${migradaId}`;
      await admin`delete from usuario where id = ${migradaId}`;
    }
  });

  it('la re-emisión se serializa contra la activación: quien llega tarde ve el estado definitivo', async () => {
    const emailRace = `${marca}-race@test.demo`;
    const admin = sqlAdmin();
    const inv = await crearInvitacion(leadId, {
      workspaceId: ws,
      email: emailRace,
      nombre: 'Race Test',
      rol: 'stakeholder',
    });
    expect(inv.token).toBeTruthy();
    const hashRace = await hashPassword('ClaveDeRace123');
    try {
      // Activación en una transacción que retiene el lock de la fila sin commitear…
      let liberar!: () => void;
      const compuerta = new Promise<void>((res) => (liberar = res));
      let lockTomado!: () => void;
      const conLock = new Promise<void>((res) => (lockTomado = res));
      const activacion = sql().begin(async (tx) => {
        const filas = await tx`
          select id from activar_usuario_con_token(${hashTokenInvitacion(inv.token!)}, ${hashRace})`;
        lockTomado();
        await compuerta;
        return filas;
      });
      await conLock;

      // …mientras la re-invitación del origen espera en el FOR UPDATE de preparar_invitacion.
      // Sin el lock leería 'invitado' desfasado y restauraría un token inconsumible
      // sobre la cuenta ya activa; con él, ve el estado definitivo tras el commit.
      const reinvitacion = crearInvitacion(leadId, {
        workspaceId: ws,
        email: emailRace,
        nombre: 'Race Test',
        rol: 'stakeholder',
      }).then(
        () => 'resuelta' as const,
        (e: unknown) => e,
      );
      await new Promise((res) => setTimeout(res, 250));
      liberar();

      const activada = (await activacion) as { id?: string }[];
      expect(activada[0]?.id).toBe(inv.usuarioId);
      expect(await reinvitacion).toBeInstanceOf(ErrorInvitacion);

      const [fila] = await admin`
        select estado, invitacion_token_hash from usuario where id = ${inv.usuarioId}`;
      expect(fila?.estado).toBe('activo');
      expect(fila?.invitacion_token_hash).toBeNull();
    } finally {
      await admin`delete from miembro where email = ${emailRace}`;
      await admin`delete from usuario where email = ${emailRace}`;
    }
  });

  it('dos re-invitaciones simultáneas no se pisan el enlace: solo una emite', async () => {
    const emailDoble = `${marca}-doble@test.demo`;
    const admin = sqlAdmin();
    const primera = await crearInvitacion(leadId, {
      workspaceId: ws,
      email: emailDoble,
      nombre: 'Doble Test',
      rol: 'stakeholder',
    });
    expect(primera.token).toBeTruthy();
    try {
      // Lock externo sobre la fila: garantiza que AMBAS re-invitaciones arrancan su
      // transacción antes de que cualquiera emita (la carrera existe de verdad).
      let liberar!: () => void;
      const compuerta = new Promise<void>((res) => (liberar = res));
      let lockTomado!: () => void;
      const conLock = new Promise<void>((res) => (lockTomado = res));
      const bloqueo = admin.begin(async (tx) => {
        await tx`select id from usuario where lower(email) = ${emailDoble} for update`;
        lockTomado();
        await compuerta;
      });
      await conLock;

      const reinvitar = () =>
        crearInvitacion(leadId, {
          workspaceId: ws,
          email: emailDoble,
          nombre: 'Doble Test',
          rol: 'stakeholder',
        }).then(
          (r) => r as unknown,
          (e: unknown) => e,
        );
      const enVuelo = [reinvitar(), reinvitar()];
      await new Promise((res) => setTimeout(res, 250));
      liberar();
      await bloqueo;
      const resultados = await Promise.all(enVuelo);

      // Determinista sin importar el orden: el primero en tomar el lock re-emite,
      // el rezagado ve un enlace más nuevo que su propio inicio y NO lo pisa.
      const conEnlace = resultados.filter(
        (r) => !(r instanceof Error) && (r as { token: string | null }).token != null,
      );
      const simultaneas = resultados.filter(
        (r) => r instanceof ErrorInvitacion && /simultánea/.test(r.message),
      );
      expect(conEnlace.length).toBe(1);
      expect(simultaneas.length).toBe(1);

      // El enlace del ganador es consumible (el rezagado no lo invalidó). La clave
      // vive en su propia línea: junto al nombre del campo del enlace, el escaneo
      // de secretos del CI la confunde con una credencial real (entropía al borde).
      const claveDelGanador = 'ClaveDoble1234';
      const ganador = conEnlace[0] as { token: string };
      const activada = await activarConToken(ganador.token, claveDelGanador);
      expect(activada?.id).toBe(primera.usuarioId);
    } finally {
      await admin`delete from miembro where email = ${emailDoble}`;
      await admin`delete from usuario where email = ${emailDoble}`;
    }
  });

  it('no se invita un correo cuya cuenta global está desactivada', async () => {
    const emailInactiva = `${marca}-inactiva@test.demo`;
    const admin = sqlAdmin();
    const [u] = await admin`insert into usuario (email, nombre, password_hash, estado)
      values (${emailInactiva}, 'Inactiva Test', ${await hashPassword('ClaveInactiva1')}, 'inactivo') returning id`;
    const inactivaId = u!.id as string;
    try {
      await expect(
        crearInvitacion(leadBId, {
          workspaceId: wsB,
          email: emailInactiva,
          nombre: 'Inactiva Test',
          rol: 'stakeholder',
        }),
      ).rejects.toThrow(/desactivada/);
      // El corte aborta la transacción completa: la membresía no llegó a insertarse.
      const filas = await admin`select 1 as existe from miembro where usuario_id = ${inactivaId}`;
      expect(filas.length).toBe(0);
    } finally {
      await admin`delete from usuario where id = ${inactivaId}`;
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
