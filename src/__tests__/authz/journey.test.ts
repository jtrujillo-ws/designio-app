import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  agregarArista,
  agregarNodo,
  borrarNodo,
  congelarJourney,
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
 * con el cliente), los curadores lo escriben, y SOLO mientras esté en borrador. Los
 * guards cierran lo que las FKs compuestas no ven: que una arista o una fase crucen de
 * journey dentro del mismo workspace.
 */
describeAuthz('journey: grafo tipado, congelado y aislamiento', () => {
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
    await admin`delete from evento_dominio where workspace_id = ${ws}`;
    await admin`delete from journey_nodo_evidencia where workspace_id = ${ws}`;
    await admin`delete from journey_snapshot where workspace_id = ${ws}`;
    await admin`delete from journey_arista where workspace_id = ${ws}`;
    await admin`update journey_nodo set fase_id = null where workspace_id = ${ws}`;
    await admin`delete from journey_nodo where workspace_id = ${ws}`;
    await admin`delete from journey where workspace_id = ${ws}`;
    await admin`delete from evidencia where workspace_id = ${ws}`;
    await admin`delete from fuente where workspace_id = ${ws}`;
    await admin`delete from servicio where workspace_id = ${ws}`;
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

  it('congelar guarda el grafo entero y cierra la edición para siempre', async () => {
    await enlazarEvidenciaANodo(leadId, ws, pasoId, evidenciaId);
    await agregarArista(leadId, {
      workspaceId: ws,
      journeyId,
      origenId: faseId,
      destinoId: pasoId,
      tipo: 'pertenece-a',
      condicion: '',
    });

    await expect(congelarJourney(stakeId, ws, journeyId, 'sin permiso')).rejects.toThrow(
      ErrorJourney,
    );
    await congelarJourney(leadId, ws, journeyId, 'aprobado en G4');

    const j = await journeyCompleto(leadId, ws, journeyId);
    expect(j!.estado).toBe('congelado');
    expect(j!.snapshots).toHaveLength(1);
    expect(j!.snapshots[0]!.motivo).toBe('aprobado en G4');

    // El snapshot guarda el grafo, no una promesa de grafo.
    const [snap] = await conUsuario(leadId, (tx) => tx`
      select grafo from journey_snapshot where journey_id = ${journeyId}`);
    const grafo = snap!.grafo as { nodos: unknown[]; aristas: unknown[] };
    expect(grafo.nodos.length).toBe(j!.nodos.length);
    expect(grafo.aristas.length).toBe(j!.aristas.length);

    // Y a partir de aquí no se toca nada: ni alta, ni edición, ni doble congelado.
    await expect(
      agregarNodo(leadId, {
        workspaceId: ws,
        journeyId,
        tipo: 'paso',
        etiqueta: 'Tardío',
        detalle: '',
        faseId: null,
        responsable: '',
      }),
    ).rejects.toThrow(ErrorJourney);
    await expect(
      editarNodo(leadId, {
        workspaceId: ws,
        nodoId: pasoId,
        etiqueta: 'Renombrado a destiempo',
        detalle: '',
        faseId: null,
        responsable: '',
        orden: 0,
      }),
    ).rejects.toThrow(ErrorJourney);
    await expect(congelarJourney(leadId, ws, journeyId, 'otra vez')).rejects.toThrow(ErrorJourney);
    await expect(enlazarEvidenciaANodo(leadId, ws, pasoId, evidenciaId)).rejects.toThrow(
      ErrorJourney,
    );
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
