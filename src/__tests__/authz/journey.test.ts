import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  agregarArista,
  agregarNodo,
  borrarNodo,
  congelarSnapshot,
  crearJourney,
  editarNodo,
  enlazarEvidenciaANodo,
  ErrorJourney,
  journeyCompleto,
  journeysDelWorkspace,
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
    await admin`delete from evidencia where workspace_id = ${ws}`;
    await admin`delete from fuente where workspace_id = ${ws}`;
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
      tipo: 'as-is',
      nombre: 'Alta digital hoy',
      descripcion: 'Desde el interés hasta la primera transacción',
    });
    journeyId = r.journeyId;

    const otro = await crearJourney(leadId, {
      workspaceId: ws,
      servicioId,
      retoId: null,
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
        tipo: 'as-is',
        nombre: 'Intruso',
        descripcion: '',
      }),
    ).rejects.toThrow(ErrorJourney);

    // Leer sí: el journey es lo que se conversa con el cliente.
    expect((await journeysDelWorkspace(stakeId, ws)).map((j) => j.id).sort()).toEqual(
      [journeyId, otroJourneyId].sort(),
    );
  });

  it('el orden se calcula por tipo dentro del journey', async () => {
    const fase = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId,
      tipo: 'fase',
      etiqueta: 'Descubrimiento',
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

  it('el guard impide que una arista o una fase crucen de journey', async () => {
    const ajeno = await agregarNodo(leadId, {
      workspaceId: ws,
      journeyId: otroJourneyId,
      tipo: 'paso',
      etiqueta: 'Paso del otro journey',
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

  it('quien no es miembro no ve el grafo; la cuenta desactivada tampoco lee', async () => {
    const admin = sqlAdmin();
    const [u] = await admin`insert into usuario (email, nombre, estado)
      values (${`${marca}-fuera@test.demo`}, 'fuera', 'activo') returning id`;
    const fueraId = u!.id as string;

    // Sin membresía no hay nada que leer: ni el journey, ni sus nodos.
    expect(await journeyCompleto(fueraId, ws, journeyId)).toBeNull();
    expect(await journeysDelWorkspace(fueraId, ws)).toEqual([]);
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
