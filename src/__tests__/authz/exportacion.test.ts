import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import {
  adjuntarArchivo,
  aprobarItem,
  crearItem,
  decidirDerechos,
} from '@/lib/evidencia/evidencia.servicio';
import { bytesABase64 } from '@/lib/evidencia/sanitizacion';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  CATALOGO_EXPORT,
  type EntradaCatalogo,
} from '@/lib/exportacion/exportacion.schemas';
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
  /** El fragmento COPIADO en la cita de la evidencia sin derechos: es el texto del
   * material de terceros, y jamás puede aparecer en un paquete entregable. */
  const FRAGMENTO_BLOQUEADO = 'me negué a darles la foto de mi cédula';
  const FRAGMENTO_CITABLE = 'abandono del 62% en el paso de verificación';
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

    // Cadena de razonamiento sobre AMBAS evidencias: es el séquito que el entregable
    // tiene que podar por derechos. La cita es el caso grave (copia el fragmento del
    // original), pero contradicción y arquetipo_evidencia delatan la misma evidencia.
    const [ins] = await admin`insert into insight (workspace_id, titulo, resumen, creado_por)
      values (${ws}, 'Fricción en verificación', 'Interpretación', ${leadId}) returning id`;
    const insightId = ins!.id as string;
    const [afi] = await admin`insert into afirmacion (workspace_id, insight_id, orden, texto)
      values (${ws}, ${insightId}, 0, 'La verificación expulsa solicitantes') returning id`;
    for (const [evidenciaId, fragmento] of [
      [evConDerechos, FRAGMENTO_CITABLE],
      [evSinDerechos, FRAGMENTO_BLOQUEADO],
    ] as const) {
      await admin`insert into cita
        (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
        values (${ws}, ${afi!.id as string}, ${evidenciaId}, ${fragmento},
                'p. 4 §2', ${leadId})`;
      await admin`insert into contradiccion
        (workspace_id, insight_id, evidencia_id, descripcion, creado_por)
        values (${ws}, ${insightId}, ${evidenciaId}, 'Matiza el hallazgo', ${leadId})`;
    }

    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, ${marca + ' Onboarding'}, ${leadId}) returning id`;
    const [reto] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
      values (${ws}, ${svc!.id as string}, 'R-70', 'Reto export', 'candidato', 'peticion-cliente', ${leadId})
      returning id`;
    const [arq] = await admin`insert into arquetipo (workspace_id, reto_id, nombre, creado_por)
      values (${ws}, ${reto!.id as string}, 'Solicitante primerizo', ${leadId}) returning id`;
    for (const evidenciaId of [evConDerechos, evSinDerechos]) {
      await admin`insert into arquetipo_evidencia (workspace_id, arquetipo_id, evidencia_id)
        values (${ws}, ${arq!.id as string}, ${evidenciaId})`;
    }
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    const wss = [ws, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from evento_dominio where workspace_id in ${admin(wss)}`;
      await admin`delete from arquetipo_evidencia where workspace_id in ${admin(wss)}`;
      await admin`delete from arquetipo where workspace_id in ${admin(wss)}`;
      await admin`delete from cita where workspace_id in ${admin(wss)}`;
      await admin`delete from contradiccion where workspace_id in ${admin(wss)}`;
      await admin`delete from afirmacion where workspace_id in ${admin(wss)}`;
      await admin`delete from insight where workspace_id in ${admin(wss)}`;
      await admin`delete from archivo_importado where workspace_id in ${admin(wss)}`;
      await admin`delete from item_importacion where workspace_id in ${admin(wss)}`;
      await admin`delete from derecho_uso where workspace_id in ${admin(wss)}`;
      await admin`delete from evidencia where workspace_id in ${admin(wss)}`;
      await admin`delete from fuente where workspace_id in ${admin(wss)}`;
      await admin`delete from reto where workspace_id in ${admin(wss)}`;
      await admin`delete from servicio where workspace_id in ${admin(wss)}`;
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

  it('toda tabla que apunte a evidencia declara cómo se poda en el entregable', async () => {
    // La otra mitad del invariante de SYS-04, y la que faltaba: no basta con exportar
    // toda tabla, hay que saber podarla. Mientras la poda tuvo un `default: true`, una
    // tabla nueva con `evidencia_id` viajaba ENTERA sin que nada avisara. Aquí se
    // contrasta la declaración del catálogo con las columnas reales de la base:
    //  · la columna por la que dice podar tiene que existir (podar por una columna
    //    inexistente compara contra `undefined` y descarta o deja pasar todo en silencio);
    //  · y toda tabla con `evidencia_id` o queda FUERA del entregable, o se poda
    //    exactamente por esa columna. No hay tercera opción.
    const admin = sqlAdmin();
    const filas = await admin`select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_name = c.table_name and t.table_schema = c.table_schema
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`;
    const columnasDe = new Map<string, Set<string>>();
    for (const f of filas) {
      const tabla = f.table_name as string;
      const set = columnasDe.get(tabla) ?? new Set<string>();
      set.add(f.column_name as string);
      columnasDe.set(tabla, set);
    }

    const columnaInexistente: string[] = [];
    const apuntaAEvidenciaSinPodar: string[] = [];
    for (const { tabla, poda } of CATALOGO_EXPORT) {
      const columnas = columnasDe.get(tabla) ?? new Set<string>();
      // `fuera` y `todo` no nombran columna: no hay nada que comprobar.
      if (poda.modo !== 'fuera' && poda.modo !== 'todo' && !columnas.has(poda.columna)) {
        columnaInexistente.push(`${tabla}.${poda.columna}`);
      }
      if (
        columnas.has('evidencia_id') &&
        !(
          poda.modo === 'fuera' ||
          (poda.modo === 'porEvidencia' && poda.columna === 'evidencia_id')
        )
      ) {
        apuntaAEvidenciaSinPodar.push(tabla);
      }
    }
    expect(columnaInexistente).toEqual([]);
    expect(apuntaAEvidenciaSinPodar).toEqual([]);
  });

  it('el entregable no exporta hijos cuyos padres se quedaron fuera', async () => {
    // La regla: una fila viaja solo si viaja aquello a lo que apunta. Sin ella, el paquete
    // sale con `afirmacion_id` o `arquetipo_id` colgando —fragmentos permitidos que el
    // receptor no puede asociar a nada— y encima con material copiado que no aporta.
    // Las FKs REALES de la base son la fuente de verdad: así la regla también alcanza a
    // las tablas que otras ramas añadan, sin que nadie tenga que acordarse.
    const admin = sqlAdmin();
    const fks = await admin`select
        c.conrelid::regclass::text as hija,
        c.confrelid::regclass::text as padre
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        and c.conrelid <> c.confrelid`;
    const catalogo: readonly EntradaCatalogo[] = CATALOGO_EXPORT;
    const dentro = new Map(
      catalogo.filter((e) => e.poda.modo !== 'fuera').map((e) => [e.tabla, e]),
    );
    const colgando: string[] = [];
    for (const fk of fks) {
      const hija = fk.hija as string;
      const padre = fk.padre as string;
      const entrada = dentro.get(hija);
      if (!entrada) continue; // la hija no viaja: no puede dejar nada colgando
      if (dentro.has(padre)) continue; // el padre viaja con ella
      // `workspace` y `usuario` no son objetos del catálogo (no llevan workspace_id): el
      // paquete los referencia por id a propósito, igual que cualquier export.
      if (padre === 'workspace' || padre === 'usuario') continue;
      const declarado = entrada.padresAusentes?.some((p) => p.tabla === padre) ?? false;
      if (!declarado) colgando.push(`${hija} → ${padre}`);
    }
    expect(colgando).toEqual([]);

    // Y la excepción declarada tiene que ser real: si alguien la escribe para una FK que
    // no existe, el test también lo dice.
    const declaradasInexistentes: string[] = [];
    for (const entrada of catalogo) {
      for (const p of entrada.padresAusentes ?? []) {
        const existe = fks.some((fk) => fk.hija === entrada.tabla && fk.padre === p.tabla);
        if (!existe) declaradasInexistentes.push(`${entrada.tabla} → ${p.tabla}`);
      }
    }
    expect(declaradasInexistentes).toEqual([]);
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
    // lleva la columna binaria. Los bytes se traen en una segunda pasada, solo para lo
    // que el presupuesto seleccionó: el tamaño anunciado y el contenido devuelto tienen
    // que seguir siendo el mismo archivo.
    expect(paquete.archivos).toHaveLength(2);
    const adjunto = paquete.archivos.find((a) => a.id === archivoId)!;
    expect(adjunto.contenidoBase64).toBe(bytesABase64(PDF));
    expect(adjunto.bytes).toBe(PDF.length);
    expect(adjunto.omitido).toBeNull();
    expect(paquete.manifiesto.adjuntos.incluidos).toBe(2);
    expect(paquete.manifiesto.adjuntos.omitidos).toBe(0);
    expect(paquete.manifiesto.adjuntos.bytesIncluidos).toBe(PDF.length * 2);
    expect(Object.keys(paquete.datos.archivo_importado![0]!)).not.toContain('contenido');

    // El archivo del propietario NO poda por derechos: la cadena de razonamiento entera
    // viaja, incluida la que cita la evidencia bloqueada.
    expect(paquete.datos.cita).toHaveLength(2);
    expect(paquete.datos.contradiccion).toHaveLength(2);
    expect(paquete.datos.arquetipo_evidencia).toHaveLength(2);

    // La ejecución queda registrada en el propio workspace (RF-01.6/01.8).
    const [evento] = await admin`select payload, actor_id, actor_rol, creado_en from evento_dominio
      where workspace_id = ${ws} and tipo = 'WorkspaceExportado'
      order by creado_en desc limit 1`;
    expect(evento!.actor_id).toBe(adminClienteId);
    expect((evento!.payload as { ambito: string }).ambito).toBe('archivo');

    // El manifiesto lleva el instante de la TRANSACCIÓN (`now()`), que es del que deriva
    // el `current_date` con el que `evidencia_usable` decide qué derechos siguen vigentes.
    // La auditoría usa otro reloj a propósito —`clock_timestamp()`, para que varios eventos
    // de una misma transacción conserven su orden real (20260902090000)— y por eso lo que
    // se comprueba es la DESIGUALDAD: el inicio de la transacción no puede ser posterior al
    // instante en que esa misma transacción insertó su evento. Es exactamente la aserción
    // que el código anterior fallaba: `new Date()` se evaluaba tras las treinta y pico
    // consultas del volcado, siempre DESPUÉS del evento.
    const instanteManifiesto = Date.parse(paquete.manifiesto.generadoEn);
    const instanteEvento = (evento!.creado_en as Date).getTime();
    expect(instanteManifiesto).toBeLessThanOrEqual(instanteEvento);
    // Y no es un valor cualquiera de otro momento: pertenece a esta misma exportación.
    expect(instanteEvento - instanteManifiesto).toBeLessThan(1000);
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
    // El receptor tiene que poder decir a QUÉ evidencia respalda cada original. La
    // correspondencia vivía solo en `item_importacion`, que el entregable no lleva —y no
    // puede llevar: sus filas cargan el texto crudo del material. Se publica el enlace.
    expect(paquete.archivos[0]!.evidenciaId).toBe(evConDerechos);
    expect(paquete.datos.item_importacion).toBeUndefined();
    expect(paquete.datos.derecho_uso).toHaveLength(1);

    // El entregable no es el archivo del workspace: no arrastra método ni auditoría.
    expect(paquete.datos.evento_dominio).toBeUndefined();
    expect(paquete.datos.miembro).toBeUndefined();
  });

  it('lo que CITA la evidencia bloqueada tampoco viaja: ni el fragmento ni el vínculo', async () => {
    // Quitar la evidencia y dejar su cita es publicar el material por otra puerta: la
    // cita COPIA el fragmento y su localización exacta para ser legible sin abrir la
    // evidencia, así que una cita superviviente entrega justo lo que RF-03.10 protege.
    // Lo mismo, en menor grado, con contradicción y arquetipo_evidencia: revelan que esa
    // evidencia existe y qué dice de ella el razonamiento.
    const paquete = await exportarWorkspace(leadId, { workspaceId: ws, ambito: 'entregable' });

    // Las anotaciones sobre razonamiento salen ENTERAS del entregable: sus padres
    // (afirmación, insight, arquetipo) no viajan, así que podarlas por derechos dejaba
    // ids colgando. Con ellas se va también el `fragmento` copiado del original.
    expect(paquete.datos.cita).toBeUndefined();
    expect(paquete.datos.contradiccion).toBeUndefined();
    expect(paquete.datos.arquetipo_evidencia).toBeUndefined();

    // La prueba que de verdad importa: el texto del material sin derechos no está en
    // NINGUNA parte del paquete, ni siquiera copiado dentro de otra tabla. Su id sí
    // aparece —en `bloqueadas`, con el motivo—: SYS-14 pide bloquear EXPLICANDO, y lo
    // que se protege es el contenido, no la existencia de la evidencia.
    // Ahora NINGÚN fragmento viaja, ni el permitido: las citas salen enteras del paquete
    // porque su afirmación no viaja. El material copiado deja de estar en el entregable
    // por partida doble — por derechos y por no tener a qué agarrarse.
    const serializado = JSON.stringify(paquete);
    expect(serializado).not.toContain(FRAGMENTO_BLOQUEADO);
    expect(serializado).not.toContain(FRAGMENTO_CITABLE);
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

  it('el paquete se arma sobre UNA sola foto: repeatable read cierra la ventana', async () => {
    // La exportación son treinta y pico consultas. Bajo READ COMMITTED cada una abre su
    // propio snapshot, así que un commit ajeno a media exportación —una revocación de
    // derechos, típicamente— dejaba la evidencia dentro del paquete (el filtro ya se
    // había materializado) y a la vez en `bloqueadas`, con sus citas y sus ficheros.
    // Aquí se comprueba el mecanismo que lo cierra, con una escritura intercalada REAL
    // desde otra conexión mientras la transacción de lectura sigue abierta.
    const admin = sqlAdmin();
    const aislada = await conUsuario(
      leadId,
      async (tx) => {
        const [nivel] = await tx`show transaction_isolation`;
        const [antes] = await tx`select count(*)::int as n from segmento
          where workspace_id = ${ws}`;
        await admin`insert into segmento (workspace_id, nombre)
          values (${ws}, ${marca + ' intercalado'})`;
        const [despues] = await tx`select count(*)::int as n from segmento
          where workspace_id = ${ws}`;
        return {
          nivel: nivel!.transaction_isolation as string,
          antes: antes!.n as number,
          despues: despues!.n as number,
        };
      },
      { aislamiento: 'repeatable read' },
    );
    expect(aislada.nivel).toBe('repeatable read');
    expect(aislada.despues).toBe(aislada.antes);

    // Control, para que la aserción anterior signifique algo: la MISMA secuencia sin el
    // aislamiento sí ve la fila intercalada. Esa es exactamente la ventana por la que se
    // colaba la revocación, y la razón de que el nivel se fije en el propio BEGIN.
    const porDefecto = await conUsuario(leadId, async (tx) => {
      const [antes] = await tx`select count(*)::int as n from segmento
        where workspace_id = ${ws}`;
      await admin`insert into segmento (workspace_id, nombre)
        values (${ws}, ${marca + ' intercalado 2'})`;
      const [despues] = await tx`select count(*)::int as n from segmento
        where workspace_id = ${ws}`;
      return { antes: antes!.n as number, despues: despues!.n as number };
    });
    expect(porDefecto.despues).toBe(porDefecto.antes + 1);
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
