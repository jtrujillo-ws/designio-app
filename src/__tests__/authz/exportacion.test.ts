import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, sqlAdmin } from '@/lib/db';
import {
  adjuntarArchivo,
  aprobarItem,
  crearItem,
  decidirDerechos,
} from '@/lib/evidencia/evidencia.servicio';
import { bytesABase64 } from '@/lib/evidencia/sanitizacion';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { CATALOGO_EXPORT } from '@/lib/exportacion/exportacion.schemas';
import { ErrorExportacion, exportarWorkspace } from '@/lib/exportacion/exportacion.servicio';
import { describeAuthz } from './helpers';

/**
 * Exportación del workspace (SPEC-01 RF-01.8 / SYS-04) y del paquete entregable
 * (SPEC-03 RF-03.10). Los dos ámbitos tienen reglas opuestas y ambas se verifican aquí:
 * el archivo del propietario lo lleva TODO; el entregable solo lo que tiene derechos, y
 * declara lo que dejó fuera.
 */
describeAuthz('exportación del workspace: completitud, derechos y aislamiento', () => {
  const marca = `exp-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let wsB = '';
  let leadId = '';
  let adminClienteId = '';
  let stakeId = '';
  let evConDerechos = '';
  let evSinDerechos = '';
  let archivoId = '';

  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const dimensiones = {
    fecha: '2026-07-15',
    recoleccion: 'Estudio del proveedor',
    derivada: true,
    confianza: 'alta' as const,
    consentimiento: true,
    confidencialidad: 'cliente' as const,
    segmentoIds: [],
  };

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;
    const [wb] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsB = wb!.id as string;

    for (const [alias, rol] of [
      ['lead', 'lead-boutique'],
      ['adminc', 'admin-cliente'],
      ['stake', 'stakeholder'],
    ] as const) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
      if (alias === 'adminc') adminClienteId = id;
      if (alias === 'stake') stakeId = id;
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, ${alias}, ${`${marca}-${alias}@test.demo`}, ${rol})`;
    }
    // Material ajeno en B: si el export lo filtrara con un `where` olvidadizo, se vería.
    await admin`insert into segmento (workspace_id, nombre) values (${wsB}, ${marca + ' ajeno'})`;

    // Evidencia CON derechos y con su original adjunto.
    const conDerechos = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Estudio CX del proveedor',
      contenido: 'Abandono del 62% en verificación',
      tipoFuente: 'documento',
      referencia: 'carpeta/CX-2026',
    });
    const adjunto = await adjuntarArchivo(leadId, {
      workspaceId: ws,
      itemId: conDerechos.itemId,
      nombre: 'estudio-cx.pdf',
      tipoMime: 'application/pdf',
      contenidoBase64: bytesABase64(PDF),
    });
    archivoId = adjunto.archivoId;
    evConDerechos = (
      await aprobarItem(leadId, {
        workspaceId: ws,
        itemId: conDerechos.itemId,
        esEstadoActual: true,
        resumen: 'Línea base 62%',
        dimensiones,
      })
    ).evidenciaId;
    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: evConDerechos,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Cláusula 7 del contrato',
      venceEn: null,
    });

    // Evidencia SIN derechos (entrevista sin consentimiento) con su propio adjunto.
    const sinDerechos = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Entrevista E-014',
      contenido: 'Testimonio del solicitante',
      tipoFuente: 'entrevista',
      referencia: 'grabaciones/E-014',
    });
    await adjuntarArchivo(leadId, {
      workspaceId: ws,
      itemId: sinDerechos.itemId,
      nombre: 'transcripcion.pdf',
      tipoMime: 'application/pdf',
      contenidoBase64: bytesABase64(PDF),
    });
    evSinDerechos = (
      await aprobarItem(leadId, {
        workspaceId: ws,
        itemId: sinDerechos.itemId,
        esEstadoActual: false,
        resumen: 'Vivencia del abandono',
        dimensiones: { ...dimensiones, consentimiento: false, confianza: 'media' },
      })
    ).evidenciaId;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    const wss = [ws, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from evento_dominio where workspace_id in ${admin(wss)}`;
      await admin`delete from archivo_importado where workspace_id in ${admin(wss)}`;
      await admin`delete from item_importacion where workspace_id in ${admin(wss)}`;
      await admin`delete from derecho_uso where workspace_id in ${admin(wss)}`;
      await admin`delete from evidencia where workspace_id in ${admin(wss)}`;
      await admin`delete from fuente where workspace_id in ${admin(wss)}`;
      await admin`delete from segmento where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  it('el catálogo de exportación cubre TODAS las tablas del workspace (SYS-04)', async () => {
    // La verificación de SYS-04 es «checklist de export contra el catálogo de objetos»:
    // aquí el catálogo se contrasta con la base real. Si alguien añade una tabla de
    // dominio y no la exporta, este test lo detiene — que es lo que separa un invariante
    // de un deseo.
    const admin = sqlAdmin();
    const tablas = (
      await admin`select c.table_name from information_schema.columns c
        join information_schema.tables t
          on t.table_name = c.table_name and t.table_schema = c.table_schema
        where c.column_name = 'workspace_id' and c.table_schema = 'public'
          and t.table_type = 'BASE TABLE'
        order by 1`
    ).map((f) => f.table_name as string);
    const catalogo = CATALOGO_EXPORT.map((c) => c.tabla).sort();
    expect(catalogo).toEqual(tablas.sort());
  });

  it('el archivo del propietario lo lleva TODO, incluida la evidencia sin derechos', async () => {
    const admin = sqlAdmin();
    const paquete = await exportarWorkspace(adminClienteId, { workspaceId: ws, ambito: 'archivo' });

    expect(paquete.manifiesto.ambito).toBe('archivo');
    expect(paquete.manifiesto.generadoPorRol).toBe('admin-cliente');
    expect(paquete.workspace.id).toBe(ws);

    // SYS-04: los derechos NO filtran el archivo del dueño; viajan como un bloque más.
    const ids = paquete.datos.evidencia!.map((e) => e.id as string);
    expect(ids).toContain(evConDerechos);
    expect(ids).toContain(evSinDerechos);
    expect(paquete.bloqueadas).toHaveLength(0);
    expect(paquete.datos.derecho_uso).toHaveLength(2);

    // Toda tabla del catálogo aparece con su conteo (el recibo verificable).
    for (const { tabla } of CATALOGO_EXPORT) {
      expect(paquete.manifiesto.conteos[tabla]).toBe(paquete.datos[tabla]!.length);
    }
    // La auditoría también se exporta (RF-01.8).
    expect(paquete.manifiesto.conteos.evento_dominio!).toBeGreaterThan(0);

    // Los archivos van con sus bytes y su hash verificable; el dump de la tabla nunca
    // lleva la columna binaria.
    expect(paquete.archivos).toHaveLength(2);
    const adjunto = paquete.archivos.find((a) => a.id === archivoId)!;
    expect(adjunto.contenidoBase64).toBe(bytesABase64(PDF));
    expect(adjunto.omitido).toBeNull();
    expect(Object.keys(paquete.datos.archivo_importado![0]!)).not.toContain('contenido');

    // La ejecución queda registrada en el propio workspace (RF-01.6/01.8).
    const [evento] = await admin`select payload, actor_id, actor_rol from evento_dominio
      where workspace_id = ${ws} and tipo = 'WorkspaceExportado'
      order by creado_en desc limit 1`;
    expect(evento!.actor_id).toBe(adminClienteId);
    expect((evento!.payload as { ambito: string }).ambito).toBe('archivo');
  });

  it('el entregable excluye la evidencia sin derechos y DICE por qué (SYS-14/SYS-17)', async () => {
    const paquete = await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'entregable' });

    const ids = paquete.datos.evidencia!.map((e) => e.id as string);
    expect(ids).toEqual([evConDerechos]);
    // Nunca desaparece en silencio: sale listada con la dimensión que falta.
    expect(paquete.bloqueadas).toHaveLength(1);
    expect(paquete.bloqueadas[0]!.evidenciaId).toBe(evSinDerechos);
    expect(paquete.bloqueadas[0]!.motivo).toContain('derechos pendientes');

    // Y su séquito tampoco viaja: llevarse la fuente o el archivo original de algo que
    // no puede citarse sería el mismo agujero por otra puerta.
    expect(paquete.datos.fuente).toHaveLength(1);
    expect(paquete.archivos).toHaveLength(1);
    expect(paquete.archivos[0]!.id).toBe(archivoId);
    expect(paquete.datos.derecho_uso).toHaveLength(1);

    // El entregable no es el archivo del workspace: no arrastra método ni auditoría.
    expect(paquete.datos.evento_dominio).toBeUndefined();
    expect(paquete.datos.miembro).toBeUndefined();
  });

  it('la exportación la ejecuta quien administra u opera el workspace, no cualquiera', async () => {
    await expect(
      exportarWorkspace(stakeId, { workspaceId: ws, ambito: 'archivo' }),
    ).rejects.toThrow(ErrorExportacion);
    // Y sin permiso no queda evento: el registro es parte de la operación autorizada.
    const admin = sqlAdmin();
    const eventos = await admin`select id from evento_dominio
      where workspace_id = ${ws} and tipo = 'WorkspaceExportado' and actor_id = ${stakeId}`;
    expect(eventos.length).toBe(0);
  });

  it('aislamiento: un workspace ajeno no se exporta ni se filtra dentro del propio', async () => {
    await expect(
      exportarWorkspace(leadId, { workspaceId: wsB, ambito: 'archivo' }),
    ).rejects.toThrow(ErrorExportacion);

    const paquete = await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' });
    const serializado = JSON.stringify(paquete);
    expect(serializado).not.toContain(wsB);
    expect(serializado).not.toContain(marca + ' ajeno');
  });

  it('una cuenta desactivada con sesión viva no exporta (re-check de estado)', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${leadId}`;
    try {
      await expect(
        exportarWorkspace(leadId, { workspaceId: ws, ambito: 'archivo' }),
      ).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${leadId}`;
    }
  });
});
