import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sql, sqlAdmin } from '@/lib/db';
import { DimensionesEvidenciaSchema } from '@/lib/evidencia/evidencia.schemas';
import {
  aprobarItem,
  crearItem,
  ErrorCuraduria,
  listarBandeja,
  rechazarItem,
} from '@/lib/evidencia/evidencia.servicio';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { describeAuthz } from './helpers';

/**
 * SPEC-03 — bandeja con curaduría humana obligatoria (SYS-16): cualquier miembro humano
 * aporta, solo curadores de la boutique deciden, lo decidido es inmutable para la app
 * (SYS-17), las dimensiones quedan completas (RF-03.5) y el aislamiento entre tenants
 * se mantiene (SYS-01/02).
 */
describeAuthz('bandeja de importación y evidencia (curaduría + aislamiento)', () => {
  const marca = `evid-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let wsB = '';
  let leadId = '';
  let stakeId = '';
  let itemAprobado = '';
  let evidenciaId = '';

  const dimensionesDemo = {
    fecha: new Date('2026-08-01T00:00:00Z'),
    recoleccion: 'Estudio CX del proveedor',
    derivada: true,
    confianza: 'alta' as const,
    consentimiento: false,
    confidencialidad: 'cliente' as const,
    segmentoIds: [],
  };

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;
    const [wb] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsB = wb!.id as string;

    const [lead] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '-lead@test.demo'}, 'Lead Evid', 'activo') returning id`;
    leadId = lead!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${leadId}, 'Lead Evid', ${marca + '-lead@test.demo'}, 'lead-boutique')`;

    const [stake] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '-stake@test.demo'}, 'Stake Evid', 'activo') returning id`;
    stakeId = stake!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${stakeId}, 'Stake Evid', ${marca + '-stake@test.demo'}, 'stakeholder')`;

    // Material ajeno en B para las pruebas de aislamiento.
    await admin`insert into item_importacion (workspace_id, titulo, contenido, tipo_fuente, creado_por)
      values (${wsB}, ${marca + ' ajeno'}, 'contenido ajeno', 'nota', ${leadId})`;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    const wss = [ws, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from evento_dominio where workspace_id in ${admin(wss)}`;
      await admin`delete from item_importacion where workspace_id in ${admin(wss)}`;
      await admin`delete from evidencia where workspace_id in ${admin(wss)}`;
      await admin`delete from fuente where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    await admin`delete from usuario where email in (${marca + '-lead@test.demo'}, ${marca + '-stake@test.demo'})`;
    await cerrarPools();
  });

  it('cualquier miembro humano aporta a la bandeja; el curador la ve pendiente', async () => {
    const r = await crearItem(stakeId, {
      workspaceId: ws,
      titulo: 'Funnel de apertura Q2',
      contenido: 'Paso 1: 100% → Paso 4: 38% (abandono 62%)',
      tipoFuente: 'dataset',
      referencia: 'hoja compartida',
    });
    itemAprobado = r.itemId;

    const bandeja = await listarBandeja(leadId, ws);
    const item = bandeja.find((i) => i.id === itemAprobado);
    expect(item?.estado).toBe('pendiente');
    expect(item?.extracto).toContain('abandono 62%');
  });

  it('la política de la bandeja excluye a no-miembros y a agente-ai, y fija la atribución', async () => {
    const admin = sqlAdmin();
    const [fuera] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '-fuera@test.demo'}, 'Fuera Evid', 'activo') returning id`;
    const fueraId = fuera!.id as string;
    const [agente] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '-agente@test.demo'}, 'Agente Evid', 'activo') returning id`;
    const agenteId = agente!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${agenteId}, 'Agente Evid', ${marca + '-agente@test.demo'}, 'agente-ai')`;
    try {
      // No-miembro y actor de plataforma: la política de INSERT los rechaza.
      await expect(
        conUsuario(fueraId, (tx) => tx`insert into item_importacion
          (workspace_id, titulo, contenido, tipo_fuente, creado_por)
          values (${ws}, 'intruso', 'x', 'nota', ${fueraId})`),
      ).rejects.toThrow(/row-level security/);
      await expect(
        conUsuario(agenteId, (tx) => tx`insert into item_importacion
          (workspace_id, titulo, contenido, tipo_fuente, creado_por)
          values (${ws}, 'bot', 'x', 'nota', ${agenteId})`),
      ).rejects.toThrow(/row-level security/);
      // Atribución no falsificable: creado_por debe ser quien inserta.
      await expect(
        conUsuario(stakeId, (tx) => tx`insert into item_importacion
          (workspace_id, titulo, contenido, tipo_fuente, creado_por)
          values (${ws}, 'suplantado', 'x', 'nota', ${leadId})`),
      ).rejects.toThrow(/row-level security/);
      // fuente/evidencia: un no-curador tampoco inserta directo.
      await expect(
        conUsuario(stakeId, (tx) => tx`insert into fuente (workspace_id, tipo, titulo, creado_por)
          values (${ws}, 'nota', 'directa', ${stakeId})`),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await admin`delete from miembro where usuario_id = ${agenteId}`;
      await admin`delete from usuario where id in (${fueraId}, ${agenteId})`;
    }
  });

  it('ni el curador puede reescribir una propuesta pendiente (grant de UPDATE por columnas)', async () => {
    await expect(
      conUsuario(leadId, (tx) => tx`update item_importacion
        set contenido = 'alterado' where id = ${itemAprobado}`),
    ).rejects.toThrow(/permission denied|permiso/i);
    await expect(
      conUsuario(leadId, (tx) => tx`update item_importacion
        set workspace_id = ${wsB} where id = ${itemAprobado}`),
    ).rejects.toThrow(/permission denied|permiso/i);
  });

  it('un stakeholder no cura: capa 2 (re-check) y capa 1 (la política deja 0 filas)', async () => {
    await expect(
      aprobarItem(stakeId, {
        workspaceId: ws,
        itemId: itemAprobado,
        esEstadoActual: false,
        resumen: '',
        dimensiones: dimensionesDemo,
      }),
    ).rejects.toThrow(ErrorCuraduria);

    // Saltándose la capa 2: el UPDATE directo bajo RLS no alcanza ninguna fila.
    const filas = await conUsuario(stakeId, (tx) => tx`update item_importacion
      set estado = 'aprobado' where id = ${itemAprobado}`);
    expect(filas.count).toBe(0);
    const bandeja = await listarBandeja(leadId, ws);
    expect(bandeja.find((i) => i.id === itemAprobado)?.estado).toBe('pendiente');
  });

  it('aprobar crea fuente + evidencia con las cinco dimensiones y sella el item', async () => {
    const r = await aprobarItem(leadId, {
      workspaceId: ws,
      itemId: itemAprobado,
      esEstadoActual: true,
      resumen: 'Línea base del abandono: 62%',
      dimensiones: dimensionesDemo,
    });
    evidenciaId = r.evidenciaId;

    const [ev] = await conUsuario(leadId, (tx) => tx`
      select e.titulo, e.resumen, e.es_estado_actual, e.dimensiones, f.tipo as fuente_tipo
      from evidencia e join fuente f on f.id = e.fuente_id
      where e.id = ${evidenciaId}`);
    expect(ev?.titulo).toBe('Funnel de apertura Q2');
    expect(ev?.es_estado_actual).toBe(true);
    expect(ev?.fuente_tipo).toBe('dataset');

    const dims = DimensionesEvidenciaSchema.parse(ev!.dimensiones);
    expect(dims.proveniencia.tipoFuente).toBe('dataset');
    expect(dims.proveniencia.localizacion).toBe('hoja compartida');
    expect(dims.calidad.confianza).toBe('alta');
    expect(dims.lineage).toBeNull();

    // Sellado e inmutable: re-decidir falla (capa 2) y el UPDATE directo deja 0 filas (capa 1).
    await expect(
      aprobarItem(leadId, {
        workspaceId: ws,
        itemId: itemAprobado,
        esEstadoActual: false,
        resumen: '',
        dimensiones: dimensionesDemo,
      }),
    ).rejects.toThrow(ErrorCuraduria);
    const filas = await conUsuario(leadId, (tx) => tx`update item_importacion
      set estado = 'pendiente' where id = ${itemAprobado}`);
    expect(filas.count).toBe(0);
  });

  it('rechazar sella el item sin crear evidencia', async () => {
    const r = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Nota irrelevante',
      contenido: 'sin valor probatorio',
      tipoFuente: 'nota',
      referencia: '',
    });
    await rechazarItem(leadId, { workspaceId: ws, itemId: r.itemId });
    const bandeja = await listarBandeja(leadId, ws);
    expect(bandeja.find((i) => i.id === r.itemId)?.estado).toBe('rechazado');
    const evidencias = await conUsuario(leadId, (tx) => tx`
      select id from evidencia where workspace_id = ${ws} and titulo = 'Nota irrelevante'`);
    expect(evidencias.length).toBe(0);
  });

  it('aislamiento: la bandeja y la evidencia de otro workspace son invisibles', async () => {
    const bandejaAjena = await listarBandeja(leadId, wsB);
    expect(bandejaAjena).toHaveLength(0);
    const sinContexto = await sql()`select id from item_importacion where workspace_id in (${ws}, ${wsB})`;
    expect(sinContexto.length).toBe(0);
  });

  it('una cuenta desactivada con sesión viva no lee la bandeja ni aporta (re-check de estado)', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${leadId}`;
    try {
      await expect(listarBandeja(leadId, ws)).rejects.toThrow(ErrorAutorizacion);
      await expect(
        crearItem(leadId, {
          workspaceId: ws,
          titulo: 'Tarde',
          contenido: 'contenido',
          tipoFuente: 'nota',
          referencia: 'ref',
        }),
      ).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${leadId}`;
    }
  });

  it('el bound del contenido también vive en el esquema (100k, contenido no confiable)', async () => {
    await expect(
      crearItem(leadId, {
        workspaceId: ws,
        titulo: 'Demasiado grande',
        contenido: 'x'.repeat(100_001),
        tipoFuente: 'documento',
        referencia: '',
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
