import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  agregarArista,
  agregarNodo,
  borrarNodo,
  congelarSnapshot,
  crearJourney,
  desenlazarEvidenciaDeNodo,
  editarArista,
  editarNodo,
  enlazarEvidenciaANodo,
  ErrorJourney,
  journeyCompleto,
  journeysDelWorkspace,
  PAGINA_JOURNEYS,
} from '@/lib/journey/journey.servicio';
import { describeAuthz } from './helpers';

/**
 * SPEC-05 — el grafo del journey bajo RLS: los miembros lo leen (es el lenguaje común
 * con el cliente) y los curadores lo escriben, siempre — el grafo de trabajo no se
 * cierra al congelar (RF-05.8); lo inmutable es el snapshot. Los guards cierran lo que
 * las FKs compuestas no ven: que una arista o una fase crucen de journey dentro del
 * mismo workspace, y que los extremos de una arista no encajen con su tipo.
 */
describeAuthz('journey: grafo tipado, snapshots y aislamiento', () => {
  const marca = `jou-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let leadId = '';
  let stakeId = '';
  let servicioId = '';
  let evidenciaId = '';
  let journeyId = '';
  let otroJourneyId = '';
  let faseId = '';
  let pasoId = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;

    for (const [alias, rol] of [
      ['lead', 'lead-boutique'],
      ['stake', 'stakeholder'],
    ] as const) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
      else stakeId = id;
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, ${alias}, ${`${marca}-${alias}@test.demo`}, ${rol})`;
    }

    const [s] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Apertura de cuenta', ${leadId}) returning id`;
    servicioId = s!.id as string;

    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente journey', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Observación en sucursal', '{}'::jsonb, ${leadId})
      returning id`;
    evidenciaId = ev!.id as string;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    // Los eventos van AL FINAL: los triggers de auditoría generan más mientras se
    // desmonta el grafo, así que borrarlos primero dejaría filas nuevas colgando.
    await admin`delete from journey_nodo_evidencia where workspace_id = ${ws}`;
    await admin`delete from journey_snapshot where workspace_id = ${ws}`;
    await admin`delete from journey_arista where workspace_id = ${ws}`;
    await admin`update journey_nodo set fase_id = null where workspace_id = ${ws}`;
    await admin`delete from journey_nodo where workspace_id = ${ws}`;
    await admin`delete from journey where workspace_id = ${ws}`;
    await admin`delete from catalogo_journey where workspace_id = ${ws}`;
    await admin`delete from evidencia where workspace_id = ${ws}`;
    await admin`delete from fuente where workspace_id = ${ws}`;
    await admin`delete from arquetipo where workspace_id = ${ws}`;
    await admin`delete from proyecto where workspace_id = ${ws}`;
    await admin`delete from reto_servicio_afectado where workspace_id = ${ws}`;
    await admin`delete from reto where workspace_id = ${ws}`;
    await admin`delete from servicio where workspace_id = ${ws}`;
    await admin`delete from evento_dominio where workspace_id = ${ws}`;
    await admin`delete from miembro where workspace_id = ${ws}`;
    await admin`delete from workspace where id = ${ws}`;
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  it('el curador crea el journey; el stakeholder no, aunque lo lea', async () => {
    const r = await crearJourney(leadId, {
      workspaceId: ws,
      servicioId,
      retoId: null,
      proyectoId: null,
      tipo: 'as-is',
      nombre: 'Alta digital hoy',
      descripcion: 'Desde el interés hasta la primera transacción',
    });
    journeyId = r.journeyId;

    const otro = await crearJourney(leadId, {
      workspaceId: ws,
      servicioId,
      retoId: null,
      proyectoId: null,
      tipo: 'to-be',
      nombre: 'Alta digital objetivo',
      descripcion: '',
    });
    otroJourneyId = otro.journeyId;

    await expect(
      crearJourney(stakeId, {
        workspaceId: ws,
        servicioId,
        retoId: null,
        proyectoId: null,
        tipo: 'as-is',
        nombre: 'Intruso',
        descripcion: '',
      }),
    ).rejects.toThrow(ErrorJourney);

    // Leer sí: el journey es lo que se conversa con el cliente.
    const lista = await journeysDelWorkspace(stakeId, ws);
    expect(lista.journeys.map((j) => j.id).sort()).toEqual([journeyId, otroJourneyId].sort());
    // Dos journeys caben de sobra en la página: no hay recorte que anunciar.
    expect(lista.siguiente).toBeNull();
  });

  it('la lista de journeys se pagina: ninguno queda fuera de alcance', async () => {
    // Esta pantalla es la ÚNICA puerta al grafo, así que caer fuera del corte equivalía a
    // desaparecer del producto. El keyset recorre todo sin repetir ni saltar.
    const admin = sqlAdmin();
    const paginables = `${marca}-pag`;
    for (let i = 0; i < PAGINA_JOURNEYS + 3; i += 1) {
      await admin`insert into journey (workspace_id, servicio_id, tipo, nombre, creado_por)
        values (${ws}, ${servicioId}, 'as-is', ${`${paginables}-${String(i).padStart(3, '0')}`},
                ${leadId})`;
    }

    const vistos: string[] = [];
    let cursor: string | null = null;
    let vueltas = 0;
    do {
      const pagina: Awaited<ReturnType<typeof journeysDelWorkspace>> =
        await journeysDelWorkspace(leadId, ws, cursor);
      expect(pagina.journeys.length).toBeLessThanOrEqual(PAGINA_JOURNEYS);
      vistos.push(...pagina.journeys.map((j) => j.id));
      cursor = pagina.siguiente;
      vueltas += 1;
      // La primera página tiene que anunciar el recorte: si no, el resto es inalcanzable.
      if (vueltas === 1) expect(cursor).not.toBeNull();
    } while (cursor !== null && vueltas < 10);

    // Ni repetidos ni saltados: el conjunto visitado es exactamente el del workspace.
    expect(new Set(vistos).size).toBe(vistos.length);
    const [total] = await admin`select count(*)::int as n from journey
      where workspace_id = ${ws}`;
    expect(vistos.length).toBe(total!.n as number);
  });

  it('el orden se calcula por tipo dentro del journey', async () => {
    const fase = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'fase',
      etiqueta: 'Descubrimiento',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: '',
    });
    faseId = fase.nodoId;
    const paso = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'paso',
      etiqueta: 'Abre la app',
      arquetipoId: null,
      detalle: '',
      faseId,
      responsable: '',
    });
    pasoId = paso.nodoId;
    const segundo = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'paso',
      etiqueta: 'Sube el documento',
      arquetipoId: null,
      detalle: '',
      faseId,
      responsable: '',
    });

    const j = await journeyCompleto(leadId, ws, journeyId);
    const pasos = j!.nodos.filter((n) => n.tipo === 'paso');
    expect(pasos.map((p) => p.orden)).toEqual([0, 1]);
    // La fase arranca en 0 aunque haya pasos: el contador es por tipo.
    expect(j!.nodos.find((n) => n.id === faseId)!.orden).toBe(0);
    expect(pasos.find((p) => p.id === segundo.nodoId)!.orden).toBe(1);
  });

  it('mover un nodo a una posición ocupada abre hueco en vez de empatar', async () => {
    // Un empate en `orden` rompe la tesis del slice: `porSecuencia` desempata por id y el
    // render de la fase ordenaba solo por `orden`, así que el diagrama y el blueprint
    // podían colocar el movimiento en posiciones distintas. El alta ya serializa
    // `max(orden) + 1` para no empatar; editar tenía que hacer lo propio.
    const tercero = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'paso',
      etiqueta: 'Firma el contrato',
      arquetipoId: null,
      detalle: '',
      faseId,
      responsable: '',
    });
    const antes = await journeyCompleto(leadId, ws, journeyId);
    const pasosAntes = antes!.nodos.filter((n) => n.tipo === 'paso');
    expect(pasosAntes.map((p) => p.orden)).toEqual([0, 1, 2]);

    // El tercero se mueve al puesto 0, que ya ocupa el primero.
    await editarNodo(leadId, {
      workspaceId: ws,
      nodoId: tercero.nodoId,
      etiqueta: 'Firma el contrato',
      detalle: '',
      faseId,
      responsable: '',
      orden: 0,
    });

    const secuencia = async () => {
      const j = await journeyCompleto(leadId, ws, journeyId);
      const ps = j!.nodos.filter((n) => n.tipo === 'paso');
      // Ni un empate en ninguna de las comprobaciones.
      const ordenes = ps.map((p) => p.orden);
      expect(new Set(ordenes).size).toBe(ordenes.length);
      return [...ps].sort((a, b) => a.orden - b.orden).map((p) => p.etiqueta);
    };

    // Subir: el movido queda de verdad primero, que es lo que el curador pidió.
    expect(await secuencia()).toEqual(['Firma el contrato', 'Abre la app', 'Sube el documento']);

    // BAJAR es el caso que un desplazamiento «de la posición pedida en adelante» hace mal:
    // deja abierto el hueco que el nodo libera y el movimiento se queda corto. Devolver el
    // primero al puesto 2 tiene que dejarlo el ÚLTIMO, no en medio.
    await editarNodo(leadId, {
      workspaceId: ws,
      nodoId: tercero.nodoId,
      etiqueta: 'Firma el contrato',
      detalle: '',
      faseId,
      responsable: '',
      orden: 2,
    });
    expect(await secuencia()).toEqual(['Abre la app', 'Sube el documento', 'Firma el contrato']);

    // Y un movimiento de una sola posición hacia abajo sí cambia el orden visible: con el
    // desplazamiento incondicional no cambiaba nada en absoluto.
    await editarNodo(leadId, {
      workspaceId: ws,
      nodoId: pasoId,
      etiqueta: 'Abre la app',
      detalle: '',
      faseId,
      responsable: '',
      orden: 1,
    });
    expect(await secuencia()).toEqual(['Sube el documento', 'Abre la app', 'Firma el contrato']);
  });

  it('el guard impide que una arista o una fase crucen de journey', async () => {
    const ajeno = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId: otroJourneyId,
      tipo: 'paso',
      etiqueta: 'Paso del otro journey',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: '',
    });

    // Mismo workspace, así que las FKs compuestas están contentas: lo cierra el guard.
    await expect(
      agregarArista(leadId, {
        workspaceId: ws,
        journeyId,
        origenId: pasoId,
        destinoId: ajeno.nodoId,
        tipo: 'transicion',
        condicion: '',
      }),
    ).rejects.toThrow(/mismo journey/);

    await expect(
      agregarNodo(leadId, {
        workspaceId: ws,
        journeyId: otroJourneyId,
        tipo: 'paso',
        etiqueta: 'Colgado de una fase ajena',
        arquetipoId: null,
        detalle: '',
        faseId,
        responsable: '',
      }),
    ).rejects.toThrow(/nodo de tipo fase del mismo journey/);
  });

  it('borrar un nodo se lleva sus aristas y deja sueltos a los que colgaban de él', async () => {
    const suelto = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'paso',
      etiqueta: 'Paso efímero',
      arquetipoId: null,
      detalle: '',
      faseId,
      responsable: '',
    });
    await agregarArista(leadId, {
      workspaceId: ws,
      journeyId,
      origenId: pasoId,
      destinoId: suelto.nodoId,
      tipo: 'transicion',
      condicion: '',
    });

    await borrarNodo(leadId, ws, suelto.nodoId);
    const j = await journeyCompleto(leadId, ws, journeyId);
    expect(j!.nodos.some((n) => n.id === suelto.nodoId)).toBe(false);
    // La arista que lo citaba se fue con él: no quedan flechas al vacío.
    expect(j!.aristas.some((a) => a.destinoId === suelto.nodoId)).toBe(false);
  });

  it('el guard rechaza aristas cuyos extremos no encajan con su tipo', async () => {
    const sistema = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'sistema',
      etiqueta: 'Core bancario',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: 'Tecnología',
    });

    // Una transición es secuencia: un sistema no «sigue» a un paso.
    await expect(
      agregarArista(leadId, {
        workspaceId: ws,
        journeyId,
        origenId: sistema.nodoId,
        destinoId: pasoId,
        tipo: 'transicion',
        condicion: '',
      }),
    ).rejects.toThrow(/transición va entre pasos o decisiones/);

    // 'soporta' sí: el sistema sostiene al paso. Y la dirección importa.
    await agregarArista(leadId, {
      workspaceId: ws,
      journeyId,
      origenId: sistema.nodoId,
      destinoId: pasoId,
      tipo: 'soporta',
      condicion: '',
    });
    await expect(
      agregarArista(leadId, {
        workspaceId: ws,
        journeyId,
        origenId: pasoId,
        destinoId: sistema.nodoId,
        tipo: 'soporta',
        condicion: '',
      }),
    ).rejects.toThrow(/soporta va de un sistema/);

    // Y una fase no participa en ninguna arista: agrupa por fase_id.
    await expect(
      agregarArista(leadId, {
        workspaceId: ws,
        journeyId,
        origenId: pasoId,
        destinoId: faseId,
        tipo: 'dependencia',
        condicion: '',
      }),
    ).rejects.toThrow(/una fase agrupa por fase_id/);
  });

  it('toda mutación del grafo deja rastro en la auditoría, también por SQL directo', async () => {
    const admin = sqlAdmin();
    const antes = await admin`select count(*)::int as n from evento_dominio
      where workspace_id = ${ws} and tipo like 'Journey%'`;

    const efimero = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'touchpoint',
      etiqueta: 'SMS de confirmación',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: '',
    });
    await editarNodo(leadId, {
      workspaceId: ws,
      nodoId: efimero.nodoId,
      etiqueta: 'SMS de aviso',
      detalle: '',
      faseId: null,
      responsable: '',
      orden: 0,
    });
    await borrarNodo(leadId, ws, efimero.nodoId);

    const tipos = await admin`select tipo from evento_dominio
      where workspace_id = ${ws} and tipo like 'Journey%'
      order by creado_en desc limit 3`;
    expect(tipos.map((t) => t.tipo as string).sort()).toEqual(
      ['JourneyNodoAgregado', 'JourneyNodoBorrado', 'JourneyNodoEditado'].sort(),
    );
    expect(antes[0]!.n as number).toBeLessThan(
      (await admin`select count(*)::int as n from evento_dominio
        where workspace_id = ${ws} and tipo like 'Journey%'`)[0]!.n as number,
    );
  });

  it('congelar guarda el grafo entero CON su evidencia y deja el journey editable', async () => {
    await enlazarEvidenciaANodo(leadId, ws, pasoId, evidenciaId);

    await expect(congelarSnapshot(stakeId, ws, journeyId, 'sin permiso')).rejects.toThrow(
      ErrorJourney,
    );
    await congelarSnapshot(leadId, ws, journeyId, 'aprobado en G4');

    const j = await journeyCompleto(leadId, ws, journeyId);
    expect(j!.snapshots).toHaveLength(1);
    expect(j!.snapshots[0]!.motivo).toBe('aprobado en G4');

    // El snapshot guarda el grafo, no una promesa de grafo — y con la cadena de
    // evidencia dentro, que es lo que hace auditable lo aprobado.
    const [snap] = await conUsuario(leadId, (tx) => tx`
      select grafo from journey_snapshot where journey_id = ${journeyId}`);
    const grafo = snap!.grafo as {
      nodos: unknown[];
      aristas: unknown[];
      evidencias: { nodoId: string; evidenciaId: string }[];
    };
    expect(grafo.nodos.length).toBe(j!.nodos.length);
    expect(grafo.aristas.length).toBe(j!.aristas.length);
    expect(grafo.evidencias).toEqual([
      expect.objectContaining({ nodoId: pasoId, evidenciaId }),
    ]);

    // RF-05.8: el grafo de trabajo SIGUE editable para el ciclo siguiente.
    const siguiente = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'paso',
      etiqueta: 'Paso del ciclo siguiente',
      arquetipoId: null,
      detalle: '',
      faseId,
      responsable: '',
    });
    expect(siguiente.nodoId).toBeTruthy();
    await editarNodo(leadId, {
      workspaceId: ws,
      nodoId: pasoId,
      etiqueta: 'Abre la app (revisado)',
      detalle: '',
      faseId,
      responsable: '',
      orden: 0,
    });

    // Y se puede congelar otra vez: cada snapshot es una foto, no un candado.
    await congelarSnapshot(leadId, ws, journeyId, 'DV-2');
    const j2 = await journeyCompleto(leadId, ws, journeyId);
    expect(j2!.snapshots).toHaveLength(2);
    expect(j2!.nodos.find((n) => n.id === pasoId)!.etiqueta).toBe('Abre la app (revisado)');
  });

  it('las entidades comparten identidad de catálogo entre journeys; renombrarlas renombra en todas partes', async () => {
    // El MISMO sistema en dos journeys distintos: la promesa del grafo tipado es poder
    // preguntar «qué pasos dependen del sistema X», y con texto libre eso es comparar
    // cadenas —y renombrarlo crearía una identidad nueva.
    const enUno = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'sistema',
      etiqueta: 'Core bancario',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: 'Tecnología',
    });
    const enOtro = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId: otroJourneyId,
      tipo: 'sistema',
      etiqueta: 'Core bancario',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: 'Tecnología',
    });

    const j1 = await journeyCompleto(leadId, ws, journeyId);
    const j2 = await journeyCompleto(leadId, ws, otroJourneyId);
    const cat1 = j1!.nodos.find((n) => n.id === enUno.nodoId)!.catalogoId;
    const cat2 = j2!.nodos.find((n) => n.id === enOtro.nodoId)!.catalogoId;
    expect(cat1).toBeTruthy();
    expect(cat1).toBe(cat2);

    // Renombrar en un journey renombra la entidad, no solo esa aparición.
    await editarNodo(leadId, {
      workspaceId: ws,
      nodoId: enUno.nodoId,
      etiqueta: 'Core bancario (T24)',
      detalle: '',
      faseId: null,
      responsable: 'Tecnología',
      orden: 0,
    });
    const [cat] = await conUsuario(leadId, (tx) => tx`
      select nombre from catalogo_journey where id = ${cat1}`);
    expect(cat!.nombre).toBe('Core bancario (T24)');

    // Un paso NO lleva catálogo: existe dentro de su journey y no se comparte.
    expect(j1!.nodos.find((n) => n.tipo === 'paso')!.catalogoId).toBeNull();

    // Y la etiqueta la pone el CATÁLOGO, igual que el arquetipo pone la suya: un update
    // directo que cambie solo el nodo dejaría el grafo mostrando y congelando un nombre
    // mientras las consultas por catálogo lo identifican por otro.
    await conUsuario(leadId, (tx) => tx`
      update journey_nodo set etiqueta = 'Nombre suelto que no es el del catálogo'
      where id = ${enOtro.nodoId} and workspace_id = ${ws}`);
    const trasElIntento = await journeyCompleto(leadId, ws, otroJourneyId);
    expect(trasElIntento!.nodos.find((n) => n.id === enOtro.nodoId)!.etiqueta).toBe(
      'Core bancario (T24)',
    );
  });

  it('guardar sin cambiar nada no es una edición y no deja evento', async () => {
    // Postgres dispara los triggers también cuando el UPDATE reescribe la fila con los
    // mismos valores. `editarNodo` reescribe SIEMPRE la fila del nodo —le hace falta el
    // `count` para saber si la política de escritura le dejó—, así que abrir el formulario
    // y guardarlo tal cual emitía un `JourneyNodoEditado` de algo que no pasó. Un
    // historial que registra ediciones que nadie hizo no es más completo, es menos fiable.
    const admin = sqlAdmin();
    const nodo = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'paso',
      etiqueta: 'Firma el contrato',
      arquetipoId: null,
      detalle: 'En la app',
      faseId: null,
      responsable: 'Cliente',
    });
    const [antes] = await admin`select count(*)::int as n from evento_dominio
      where workspace_id = ${ws} and tipo = 'JourneyNodoEditado'`;

    const igual = {
      workspaceId: ws,
      nodoId: nodo.nodoId,
      etiqueta: 'Firma el contrato',
      detalle: 'En la app',
      faseId: null,
      responsable: 'Cliente',
      orden: (await journeyCompleto(leadId, ws, journeyId))!.nodos.find(
        (n) => n.id === nodo.nodoId,
      )!.orden,
    };
    await editarNodo(leadId, igual);
    const [sinCambio] = await admin`select count(*)::int as n from evento_dominio
      where workspace_id = ${ws} and tipo = 'JourneyNodoEditado'`;
    expect(sinCambio!.n as number).toBe(antes!.n as number);

    // Y cambiar UNA cosa sí deja su evento, con el antes y el después: la guarda filtra el
    // ruido, no las ediciones.
    await editarNodo(leadId, { ...igual, detalle: 'En la app, con OTP' });
    const [evento] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'JourneyNodoEditado'
        and payload->>'nodoId' = ${nodo.nodoId}`;
    expect(evento!.payload).toMatchObject({
      detalle: 'En la app, con OTP',
      antes: { detalle: 'En la app' },
    });
  });

  it('renombrar la entrada de catálogo DIRECTAMENTE también renombra en todas partes, y deja rastro', async () => {
    // El caso que el servicio no cubría. `editarNodo` renombraba el catálogo y después,
    // con una sentencia propia, los nodos hermanos — pero el rol de la app tiene
    // `grant update (nombre) on catalogo_journey`, así que renombrar por SQL directo
    // dejaba la entrada con el nombre nuevo y TODOS los nodos con el viejo. El catálogo y
    // el grafo decían cosas distintas sobre la misma entidad, que es exactamente la
    // identidad partida que el catálogo existe para eliminar.
    const uno = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'canal',
      etiqueta: 'App móvil',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: 'Canales',
    });
    const otro = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId: otroJourneyId,
      tipo: 'canal',
      etiqueta: 'App móvil',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: 'Canales',
    });
    const antes = await journeyCompleto(leadId, ws, journeyId);
    const catId = antes!.nodos.find((n) => n.id === uno.nodoId)!.catalogoId as string;

    // Otra entrada del mismo servicio: la propagación tiene que alcanzar a los nodos de
    // ESTA entrada y a ninguno más.
    const ajeno = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'canal',
      etiqueta: 'Sucursal',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: 'Canales',
    });

    await conUsuario(leadId, (tx) => tx`
      update catalogo_journey set nombre = 'App móvil (iOS y Android)'
      where id = ${catId} and workspace_id = ${ws}`);

    const j1 = await journeyCompleto(leadId, ws, journeyId);
    const j2 = await journeyCompleto(leadId, ws, otroJourneyId);
    expect(j1!.nodos.find((n) => n.id === uno.nodoId)!.etiqueta).toBe('App móvil (iOS y Android)');
    expect(j2!.nodos.find((n) => n.id === otro.nodoId)!.etiqueta).toBe('App móvil (iOS y Android)');
    expect(j1!.nodos.find((n) => n.id === ajeno.nodoId)!.etiqueta).toBe('Sucursal');

    // El acto queda auditado, y no solo su efecto: los `JourneyNodoEditado` de cada nodo
    // cuentan que una etiqueta cambió, pero no quién renombró la entidad ni cómo se
    // llamaba antes — que es lo que se pregunta quien lee un journey viejo.
    const admin = sqlAdmin();
    const eventos = await admin`
      select payload, actor_id, actor_rol from evento_dominio
      where workspace_id = ${ws} and tipo = 'CatalogoJourneyRenombrado'
        and payload->>'catalogoId' = ${catId}`;
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.payload).toMatchObject({
      catalogoId: catId,
      tipo: 'canal',
      nombre: 'App móvil (iOS y Android)',
      nodosActualizados: 2,
      antes: { nombre: 'App móvil' },
    });
    expect(eventos[0]!.actor_id).toBe(leadId);
    expect(eventos[0]!.actor_rol).toBe('lead-boutique');

    // Reescribir la fila con el MISMO nombre no es un renombrado. Postgres dispara los
    // triggers igual en un update que no cambia nada, así que sin el `when` del trigger
    // esto dejaría un renombrado que nadie hizo, y sin el `is distinct from` de la
    // propagación, un `JourneyNodoEditado` por cada aparición de la entidad.
    const [nodosAntes] = await admin`
      select count(*) as n from evento_dominio
      where workspace_id = ${ws} and tipo = 'JourneyNodoEditado'`;
    await conUsuario(leadId, (tx) => tx`
      update catalogo_journey set nombre = 'App móvil (iOS y Android)'
      where id = ${catId} and workspace_id = ${ws}`);
    const [renombrados] = await admin`
      select count(*) as n from evento_dominio
      where workspace_id = ${ws} and tipo = 'CatalogoJourneyRenombrado'
        and payload->>'catalogoId' = ${catId}`;
    const [nodosDespues] = await admin`
      select count(*) as n from evento_dominio
      where workspace_id = ${ws} and tipo = 'JourneyNodoEditado'`;
    expect(Number(renombrados!.n)).toBe(1);
    expect(Number(nodosDespues!.n)).toBe(Number(nodosAntes!.n));

    // Y el stakeholder no renombra: la política de escritura del catálogo es de curadores,
    // así que su update no alcanza ninguna fila y la entidad no se mueve.
    await conUsuario(stakeId, (tx) => tx`
      update catalogo_journey set nombre = 'Renombrado por quien no debe'
      where id = ${catId} and workspace_id = ${ws}`);
    const [cat] = await admin`select nombre from catalogo_journey where id = ${catId}`;
    expect(cat!.nombre).toBe('App móvil (iOS y Android)');
  });

  it('el proyecto del journey tiene que ser del reto del journey', async () => {
    // Las FKs compuestas garantizan el workspace y nada más. Un journey anclado al reto R
    // y al proyecto de S diría una cosa por cada lado, y la conciliación de la design
    // version (SPEC-06) elegiría mal.
    const admin = sqlAdmin();
    const [r1] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${ws}, ${servicioId}, ${`${marca}-RA`}, 'Reto A', ${leadId}) returning id`;
    const [r2] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${ws}, ${servicioId}, ${`${marca}-RB`}, 'Reto B', ${leadId}) returning id`;
    const [p2] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${r2!.id as string}, ${`${marca}-PB`}, 'Proyecto de B', ${leadId}) returning id`;

    await expect(
      crearJourney(leadId, {
        workspaceId: ws,
        servicioId,
        retoId: r1!.id as string,
        proyectoId: p2!.id as string,
        tipo: 'to-be',
        nombre: 'Cruzado',
        descripcion: '',
      }),
    ).rejects.toThrow(/otro reto/);

    // Y el reto tiene que APLICAR al servicio del journey: anclado en él o declarado
    // como que lo afecta. Sin esto, un journey del servicio B colgado del reto de A
    // expondría bajo B los proyectos y arquetipos de A.
    const [otroServ] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio ajeno al reto', ${leadId}) returning id`;
    await expect(
      crearJourney(leadId, {
        workspaceId: ws,
        servicioId: otroServ!.id as string,
        retoId: r2!.id as string,
        proyectoId: null,
        tipo: 'to-be',
        nombre: 'Reto de otro servicio',
        descripcion: '',
      }),
    ).rejects.toThrow(/no está anclado a este servicio/);

    // Declararlo como afectado lo habilita: es la relación que el árbol ya modela para
    // el caso multiservicio, y el selector la ofrece por eso mismo.
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${r2!.id as string}, ${otroServ!.id as string}, ${ws}, ${leadId})`;
    const afectado = await crearJourney(leadId, {
      workspaceId: ws,
      servicioId: otroServ!.id as string,
      retoId: r2!.id as string,
      proyectoId: null,
      tipo: 'to-be',
      nombre: 'Reto que afecta a este servicio',
      descripcion: '',
    });
    expect(afectado.journeyId).toBeTruthy();

    // Y un proyecto sin reto deja el anclaje a medias: el reto se deriva del proyecto,
    // así que omitirlo sería guardar dos verdades incompletas.
    await expect(
      crearJourney(leadId, {
        workspaceId: ws,
        servicioId,
        retoId: null,
        proyectoId: p2!.id as string,
        tipo: 'to-be',
        nombre: 'Huérfano',
        descripcion: '',
      }),
    ).rejects.toThrow(/anclado también a su reto/);

    // El par coherente sí entra.
    const ok = await crearJourney(leadId, {
      workspaceId: ws,
      servicioId,
      retoId: r2!.id as string,
      proyectoId: p2!.id as string,
      tipo: 'to-be',
      nombre: 'Alta objetivo de B',
      descripcion: '',
    });
    const leido = await journeyCompleto(leadId, ws, ok.journeyId);
    expect(leido!.proyectoId).toBe(p2!.id as string);
  });

  it('la identidad de catálogo llega hasta el servicio: otro servicio, otra entidad', async () => {
    // El «Core bancario» de Apertura de cuenta y el de Reclamaciones se llaman igual y no
    // son lo mismo. Compartir identidad entre servicios haría que renombrar en uno
    // renombrara en el otro, y que «qué pasos dependen del Core» devolviera pasos de un
    // servicio que nadie preguntó.
    const admin = sqlAdmin();
    const [otroServicio] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Reclamaciones', ${leadId}) returning id`;
    const ajeno = await crearJourney(leadId, {
      workspaceId: ws,
      servicioId: otroServicio!.id as string,
      retoId: null,
      proyectoId: null,
      tipo: 'as-is',
      nombre: 'Reclamar hoy',
      descripcion: '',
    });
    const nodo = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId: ajeno.journeyId,
      tipo: 'sistema',
      etiqueta: 'Core bancario (T24)',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: 'Tecnología',
    });
    const suyo = await journeyCompleto(leadId, ws, ajeno.journeyId);
    const catAjeno = suyo!.nodos.find((n) => n.id === nodo.nodoId)!.catalogoId;
    expect(catAjeno).toBeTruthy();

    const original = await journeyCompleto(leadId, ws, journeyId);
    const catPropio = original!.nodos.find((n) => n.tipo === 'sistema')!.catalogoId;
    expect(catAjeno).not.toBe(catPropio);

    // Repuntar el nodo al catálogo del otro servicio no es que esté prohibido por una
    // política: el rol de la app NO TIENE el grant sobre `catalogo_id`. La identidad la
    // resuelve el servicio al crear el nodo y nadie más la toca, ni con SQL crudo.
    await expect(
      conUsuario(leadId, (tx) => tx`
        update journey_nodo set catalogo_id = ${catPropio} where id = ${nodo.nodoId}`),
    ).rejects.toThrow(/permission denied/);

    // Y el tipo va DENTRO de la clave foránea, así que tampoco cuadra por debajo del rol
    // de la app: un nodo 'sistema' no puede colgar de una entrada de catálogo 'actor'.
    const actor = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId: ajeno.journeyId,
      tipo: 'actor',
      etiqueta: 'Gestor de reclamaciones',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: '',
    });
    const conActor = await journeyCompleto(leadId, ws, ajeno.journeyId);
    const catActor = conActor!.nodos.find((n) => n.id === actor.nodoId)!.catalogoId;
    await expect(
      admin`update journey_nodo set catalogo_id = ${catActor} where id = ${nodo.nodoId}`,
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('el nodo arquetipo apunta al arquetipo curado del reto, no a una copia', async () => {
    // RF-05: el arquetipo del journey es EL arquetipo (SPEC-04.11). Si fuera una entrada
    // de catálogo más, un arquetipo refutado seguiría vivo en el diagrama como si nada.
    const admin = sqlAdmin();
    const [reto] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${ws}, ${servicioId}, ${`${marca}-R1`}, 'Abandono en el alta', ${leadId})
      returning id`;
    const [otroReto] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, creado_por)
      values (${ws}, ${servicioId}, ${`${marca}-R2`}, 'Otro reto', ${leadId})
      returning id`;
    const [arq] = await admin`insert into arquetipo (workspace_id, reto_id, nombre, creado_por)
      values (${ws}, ${reto!.id as string}, 'Migrante bancarizado', ${leadId}) returning id`;
    const [arqAjeno] = await admin`insert into arquetipo (workspace_id, reto_id, nombre, creado_por)
      values (${ws}, ${otroReto!.id as string}, 'De otro reto', ${leadId}) returning id`;

    const anclado = await crearJourney(leadId, {
      workspaceId: ws,
      servicioId,
      retoId: reto!.id as string,
      proyectoId: null,
      tipo: 'as-is',
      nombre: 'Alta con arquetipo',
      descripcion: '',
    });

    const nodo = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId: anclado.journeyId,
      tipo: 'arquetipo',
      etiqueta: 'Migrante bancarizado',
      arquetipoId: arq!.id as string,
      detalle: '',
      faseId: null,
      responsable: '',
    });
    const completo = await journeyCompleto(leadId, ws, anclado.journeyId);
    const puesto = completo!.nodos.find((n) => n.id === nodo.nodoId)!;
    expect(puesto.arquetipoId).toBe(arq!.id as string);
    // Y no duplica identidad en el catálogo: el arquetipo ya tiene la suya.
    expect(puesto.catalogoId).toBeNull();

    // Un arquetipo de OTRO reto no entra, aunque sea del mismo workspace.
    await expect(
      agregarNodo(leadId, {
        workspaceId: ws,
        journeyId: anclado.journeyId,
        tipo: 'arquetipo',
        etiqueta: 'De otro reto',
        arquetipoId: arqAjeno!.id as string,
        detalle: '',
        faseId: null,
        responsable: '',
      }),
    ).rejects.toThrow(/otro reto/);

    // Y en un journey sin reto no hay arquetipo al que anclarse.
    await expect(
      agregarNodo(leadId, {
        workspaceId: ws,
        journeyId,
        tipo: 'arquetipo',
        etiqueta: 'Migrante bancarizado',
        arquetipoId: arq!.id as string,
        detalle: '',
        faseId: null,
        responsable: '',
      }),
    ).rejects.toThrow(/otro reto|anclarlo/);

    // La etiqueta se DERIVA del arquetipo, no se teclea: si se pudiera escribir, el
    // diagrama y los snapshots mostrarían un nombre inventado para un arquetipo real.
    const conNombreFalso = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId: anclado.journeyId,
      tipo: 'arquetipo',
      etiqueta: 'Nombre inventado que no es el suyo',
      arquetipoId: arq!.id as string,
      detalle: '',
      faseId: null,
      responsable: '',
    });
    const tras = await journeyCompleto(leadId, ws, anclado.journeyId);
    expect(tras!.nodos.find((n) => n.id === conNombreFalso.nodoId)!.etiqueta).toBe(
      'Migrante bancarizado',
    );
    // Y editarla tampoco la mueve.
    await editarNodo(leadId, {
      workspaceId: ws,
      nodoId: conNombreFalso.nodoId,
      etiqueta: 'Otro nombre inventado',
      detalle: '',
      faseId: null,
      responsable: '',
      orden: 1,
    });
    const trasEditar = await journeyCompleto(leadId, ws, anclado.journeyId);
    expect(trasEditar!.nodos.find((n) => n.id === conNombreFalso.nodoId)!.etiqueta).toBe(
      'Migrante bancarizado',
    );

    // Un arquetipo REFUTADO no entra: el veredicto dice que ese perfil no describe a
    // nadie, y dibujarlo en el journey lo resucitaría.
    const [refutado] = await admin`insert into arquetipo
      (workspace_id, reto_id, nombre, estado, veredicto_razon, creado_por)
      values (${ws}, ${reto!.id as string}, 'Perfil descartado', 'refutado',
        'La evidencia lo contradice', ${leadId}) returning id`;
    await expect(
      agregarNodo(leadId, {
        workspaceId: ws,
        journeyId: anclado.journeyId,
        tipo: 'arquetipo',
        etiqueta: 'Perfil descartado',
        arquetipoId: refutado!.id as string,
        detalle: '',
        faseId: null,
        responsable: '',
      }),
    ).rejects.toThrow(/refutado/);

    // Lo que YA estaba puesto se queda cuando el veredicto llega después —el grafo es
    // historia y borrarlo por detrás sería reescribirla— y la proyección lo delata para
    // que la validación pueda reportarlo.
    await admin`update arquetipo set estado = 'refutado',
      veredicto_razon = 'Refutado más tarde' where id = ${arq!.id as string}`;
    const conDeriva = await journeyCompleto(leadId, ws, anclado.journeyId);
    expect(conDeriva!.nodos.find((n) => n.id === nodo.nodoId)!.arquetipoEstado).toBe('refutado');
    // Y el selector deja de ofrecerlo, porque la proyección trae el estado.
    expect(conDeriva!.arquetipos.filter((a) => a.estado !== 'refutado')).toEqual([]);
  });

  it('el tipo y la condición de una relación se corrigen sin borrarla', async () => {
    const sistema = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'sistema',
      etiqueta: 'Motor de reglas',
      arquetipoId: null,
      detalle: '',
      faseId: null,
      responsable: 'Riesgo',
    });
    const a = await agregarArista(leadId, {
      workspaceId: ws,
      journeyId,
      origenId: sistema.nodoId,
      destinoId: pasoId,
      tipo: 'soporta',
      condicion: '',
    });

    await editarArista(leadId, {
      workspaceId: ws,
      aristaId: a.aristaId,
      tipo: 'dependencia',
      condicion: 'solo si el documento es extranjero',
    });
    const j = await journeyCompleto(leadId, ws, journeyId);
    const editada = j!.aristas.find((x) => x.id === a.aristaId)!;
    expect(editada.tipo).toBe('dependencia');
    expect(editada.condicion).toBe('solo si el documento es extranjero');

    // El guard de extremos corre TAMBIÉN al editar: un tipo cuyos extremos no encajan
    // se rechaza igual que en el alta.
    await expect(
      editarArista(leadId, {
        workspaceId: ws,
        aristaId: a.aristaId,
        tipo: 'transicion',
        condicion: '',
      }),
    ).rejects.toThrow(/transición va entre pasos o decisiones/);

    // Y la edición deja su propio rastro, distinto del par borrado/alta — con el estado
    // ANTERIOR dentro. El update pisa la fila, así que un historial append-only que solo
    // guardara el estado posterior no podría decir QUÉ cambió: auditar una corrección sin
    // poder leerla es no auditarla.
    const [ev] = await sqlAdmin()`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'JourneyAristaEditada'
        and payload->>'aristaId' = ${a.aristaId}`;
    expect(ev).toBeDefined();
    const payload = ev!.payload as Record<string, unknown>;
    expect(payload.tipo).toBe('dependencia');
    expect(payload.condicion).toBe('solo si el documento es extranjero');
    const previo = payload.antes as Record<string, unknown>;
    expect(previo.tipo).toBe('soporta');
    expect(previo.condicion).toBe('');
  });

  it('quitar un enlace de evidencia no obliga a borrar el nodo entero', async () => {
    const conEnlace = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'paso',
      etiqueta: 'Paso con evidencia mal enlazada',
      arquetipoId: null,
      detalle: '',
      faseId,
      responsable: '',
    });
    await enlazarEvidenciaANodo(leadId, ws, conEnlace.nodoId, evidenciaId);
    const antes = await journeyCompleto(leadId, ws, journeyId);
    expect(antes!.nodos.find((n) => n.id === conEnlace.nodoId)!.evidencias).toHaveLength(1);

    await desenlazarEvidenciaDeNodo(leadId, ws, conEnlace.nodoId, evidenciaId);
    const despues = await journeyCompleto(leadId, ws, journeyId);
    expect(despues!.nodos.find((n) => n.id === conEnlace.nodoId)!.evidencias).toEqual([]);
    // El nodo sigue ahí: corregir un enlace no cuesta el paso ni sus aristas.
    expect(despues!.nodos.some((n) => n.id === conEnlace.nodoId)).toBe(true);

    await expect(
      desenlazarEvidenciaDeNodo(leadId, ws, conEnlace.nodoId, evidenciaId),
    ).rejects.toThrow(ErrorJourney);
  });

  it('quien no es miembro no ve el grafo; la cuenta desactivada tampoco lee', async () => {
    const admin = sqlAdmin();
    const [u] = await admin`insert into usuario (email, nombre, estado)
      values (${`${marca}-fuera@test.demo`}, 'fuera', 'activo') returning id`;
    const fueraId = u!.id as string;

    // Sin membresía no hay nada que leer: ni el journey, ni sus nodos.
    expect(await journeyCompleto(fueraId, ws, journeyId)).toBeNull();
    expect((await journeysDelWorkspace(fueraId, ws)).journeys).toEqual([]);
    const nodos = await conUsuario(fueraId, (tx) => tx`
      select id from journey_nodo where workspace_id = ${ws}`);
    expect(nodos.length).toBe(0);

    await admin`update usuario set estado = 'inactivo' where id = ${leadId}`;
    try {
      await expect(journeyCompleto(leadId, ws, journeyId)).rejects.toThrow(ErrorAutorizacion);
      await expect(journeysDelWorkspace(leadId, ws)).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${leadId}`;
    }
  });
});
