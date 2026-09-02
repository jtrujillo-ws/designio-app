import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import {
  agregarElemento,
  aprobarDesignVersion,
  asignarElemento,
  borrarElemento,
  cadenaDeRelease,
  constatarEffectiveState,
  crearDesignVersion,
  designVersionCompleta,
  designVersionsDelWorkspace,
  desplegarRelease,
  editarElemento,
  enlazarJourney,
  ErrorEntrega,
  planificarRelease,
  tableroDeConciliacion,
} from '@/lib/entrega/entrega.servicio';
import { calcularDiff, conciliacionCompleta } from '@/lib/entrega/entrega.diff';
import { describeAuthz } from './helpers';

/**
 * SPEC-06 bajo RLS: la design version se congela al aprobarse (SYS-05), el release
 * declara su parcialidad y cuelga de una DV aprobada (SYS-06), toda desviación lleva
 * razón (SYS-07, por CHECK) y G7 no pasa con la conciliación incompleta (RF-06.7).
 *
 * Los miembros LEEN la cadena entera —es lo que el cliente audita— y el lead la opera.
 */
// Fechas RELATIVAS a la corrida: el guard rechaza despliegues y constataciones futuras,
// así que fijarlas en el calendario haría que el test caducara.
const dia = (delta: number) =>
  new Date(Date.now() + delta * 86_400_000).toISOString().slice(0, 10);
const HOY = dia(0);
const AYER = dia(-1);

describeAuthz('entrega: design version, releases parciales, effective state y G7', () => {
  const marca = `ent-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let leadId = '';
  let disId = '';
  let stakeId = '';
  let servicioId = '';
  let otroServicioId = '';
  let retoId = '';
  let proyectoId = '';
  let otroProyectoId = '';
  let toBeId = '';
  let asIsId = '';
  let nodoToBe = '';
  let nodoToBe2 = '';
  let nodoAsIs = '';
  let insightValidadoId = '';
  let insightPropuestoId = '';
  let decisionId = '';
  let decisionAjenaId = '';
  let catVideo = '';
  let dv1 = '';
  let dv2 = '';
  let elVideo = '';
  let elPolitica = '';
  let elCore = '';
  let rl1 = '';
  let rl2 = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;

    for (const [alias, rol] of [
      ['lead', 'lead-boutique'],
      ['dis', 'disenador'],
      ['stake', 'stakeholder'],
    ] as const) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
      else if (alias === 'dis') disId = id;
      else stakeId = id;
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, ${alias}, ${`${marca}-${alias}@test.demo`}, ${rol})`;
    }

    const [s] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Apertura de cuenta', ${leadId}) returning id`;
    servicioId = s!.id as string;
    const [s2] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Otro servicio', ${leadId}) returning id`;
    otroServicioId = s2!.id as string;

    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, creado_por)
      values (${ws}, ${servicioId}, 'R-90', 'Reducir el abandono', 'activo', ${leadId}) returning id`;
    retoId = r!.id as string;
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-90', 'Rediseño', ${leadId}) returning id`;
    proyectoId = p!.id as string;
    const [p2] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-91', 'Proyecto vecino', ${leadId}) returning id`;
    otroProyectoId = p2!.id as string;

    // Criterio completo: G0 no se aprueba sin él (SYS-22), y el test de G7 necesita la
    // escalera de gates entera.
    await admin`insert into criterio_exito
      (workspace_id, reto_id, kpi, definicion, linea_base_valor, linea_base_fecha, objetivo,
       ventana_dias, creado_por)
      values (${ws}, ${retoId}, 'Abandono', 'Porcentaje que abandona', '62%', '2026-07-15',
              '40%', 90, ${leadId})`;
    for (let n = 0; n <= 7; n++) {
      const [g] = await admin`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador)
        values (${ws}, ${proyectoId}, ${n}, ${[0, 3, 5, 6].includes(n) ? 'sponsor' : 'lead-boutique'})
        returning id`;
      await admin`insert into checklist_item
        (workspace_id, gate_id, orden, texto, estado, na_justificacion, na_aprobado_por)
        values (${ws}, ${g!.id as string}, 0, 'Ítem del test', 'na', 'fuera de alcance del test',
                ${leadId})`;
    }

    const [jt] = await admin`insert into journey
      (workspace_id, servicio_id, reto_id, proyecto_id, tipo, nombre, creado_por)
      values (${ws}, ${servicioId}, ${retoId}, ${proyectoId}, 'to-be', 'Apertura objetivo',
              ${leadId}) returning id`;
    toBeId = jt!.id as string;
    const [ja] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${servicioId}, 'as-is', 'Apertura hoy', ${leadId}) returning id`;
    asIsId = ja!.id as string;

    const [cat] = await admin`insert into catalogo_journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${servicioId}, 'touchpoint', 'Video-verificación', ${leadId}) returning id`;
    catVideo = cat!.id as string;
    const [n1] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, catalogo_id, creado_por)
      values (${ws}, ${toBeId}, 'touchpoint', 'Video-verificación', ${catVideo}, ${leadId})
      returning id`;
    nodoToBe = n1!.id as string;
    const [n2] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, creado_por)
      values (${ws}, ${toBeId}, 'paso', 'Recibe el motivo del rechazo', ${leadId}) returning id`;
    nodoToBe2 = n2!.id as string;
    const [n3] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, creado_por)
      values (${ws}, ${asIsId}, 'paso', 'Paso del as-is', ${leadId}) returning id`;
    nodoAsIs = n3!.id as string;

    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'documento', 'Estudio CX', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Funnel de apertura', '{}'::jsonb, ${leadId})
      returning id`;
    const [iv] = await admin`insert into insight
      (workspace_id, titulo, estado, validado_por, validado_en, creado_por)
      values (${ws}, 'La verificación concentra el abandono', 'validado', ${leadId}, now(), ${leadId})
      returning id`;
    insightValidadoId = iv!.id as string;
    const [af] = await admin`insert into afirmacion (workspace_id, insight_id, orden, texto)
      values (${ws}, ${insightValidadoId}, 0, '62 de cada 100 se detienen') returning id`;
    await admin`insert into cita
      (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
      values (${ws}, ${af!.id as string}, ${ev!.id as string}, '62 de cada 100', 'p. 14', ${leadId})`;
    const [ip] = await admin`insert into insight (workspace_id, titulo, creado_por)
      values (${ws}, 'Insight sin validar', ${leadId}) returning id`;
    insightPropuestoId = ip!.id as string;

    const [g1] = await admin`select id from gate_instancia
      where proyecto_id = ${proyectoId} and workspace_id = ${ws} and numero = 1`;
    const [d] = await admin`insert into decision
      (workspace_id, proyecto_id, gate_id, tipo, titulo, decidido_por)
      values (${ws}, ${proyectoId}, ${g1!.id as string}, 'diseno',
              'Atacar la verificación digital', ${leadId}) returning id`;
    decisionId = d!.id as string;
    const [gAjeno] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${otroProyectoId}, 1, 'lead-boutique') returning id`;
    const [dAjena] = await admin`insert into decision
      (workspace_id, proyecto_id, gate_id, tipo, titulo, decidido_por)
      values (${ws}, ${otroProyectoId}, ${gAjeno!.id as string}, 'otra', 'Decisión vecina', ${leadId})
      returning id`;
    decisionAjenaId = dAjena!.id as string;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    await admin`delete from constatacion where workspace_id = ${ws}`;
    await admin`delete from effective_state where workspace_id = ${ws}`;
    await admin`delete from release_elemento where workspace_id = ${ws}`;
    await admin`delete from release where workspace_id = ${ws}`;
    await admin`delete from elemento_decision where workspace_id = ${ws}`;
    await admin`delete from elemento_insight where workspace_id = ${ws}`;
    await admin`delete from elemento_cambio where workspace_id = ${ws}`;
    // La cadena de superación es una autorreferencia, pero NO se corta antes: una design
    // version aprobada es inmutable hasta para el owner (lo impone el guard de
    // transición), y un DELETE que se lleva los dos extremos en la misma sentencia deja
    // la FK satisfecha al final de ella.
    await admin`delete from design_version where workspace_id = ${ws}`;
    await admin`delete from journey_snapshot where workspace_id = ${ws}`;
    await admin`delete from journey_arista where workspace_id = ${ws}`;
    await admin`delete from journey_nodo where workspace_id = ${ws}`;
    await admin`delete from journey where workspace_id = ${ws}`;
    await admin`delete from catalogo_journey where workspace_id = ${ws}`;
    await admin`delete from decision_insight where workspace_id = ${ws}`;
    await admin`delete from decision where workspace_id = ${ws}`;
    await admin`delete from cita where workspace_id = ${ws}`;
    await admin`delete from afirmacion where workspace_id = ${ws}`;
    await admin`delete from insight where workspace_id = ${ws}`;
    await admin`delete from evidencia where workspace_id = ${ws}`;
    await admin`delete from fuente where workspace_id = ${ws}`;
    await admin`delete from checklist_item where workspace_id = ${ws}`;
    await admin`delete from gate_instancia where workspace_id = ${ws}`;
    await admin`delete from etapa_instancia where workspace_id = ${ws}`;
    await admin`delete from criterio_exito where workspace_id = ${ws}`;
    await admin`delete from proyecto where workspace_id = ${ws}`;
    await admin`delete from reto where workspace_id = ${ws}`;
    await admin`delete from servicio where workspace_id = ${ws}`;
    await admin`delete from evento_dominio where workspace_id = ${ws}`;
    await admin`delete from miembro where workspace_id = ${ws}`;
    await admin`delete from workspace where id = ${ws}`;
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  it('el curador crea la design version en borrador; el stakeholder no, aunque la lea', async () => {
    const r = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId,
      journeyId: toBeId,
      titulo: 'Verificación asistida',
      resumen: 'Resuelve la verificación dentro de la app',
      superaA: null,
    });
    dv1 = r.designVersionId;

    await expect(
      crearDesignVersion(stakeId, {
        workspaceId: ws,
        proyectoId,
        servicioId,
        journeyId: toBeId,
        titulo: 'Intrusa',
        resumen: '',
        superaA: null,
      }),
    ).rejects.toThrow(ErrorEntrega);

    const dv = await designVersionCompleta(stakeId, ws, dv1);
    expect(dv!.codigo).toMatch(/^DV-\d+$/);
    expect(dv!.estado).toBe('borrador');
    expect((await designVersionsDelWorkspace(stakeId, ws)).map((v) => v.id)).toEqual([dv1]);
  });

  it('los elementos de cambio se ordenan solos y citan lo que los motiva', async () => {
    const a = await agregarElemento(disId, {
      workspaceId: ws,
      designVersionId: dv1,
      tipo: 'touchpoint',
      operacion: 'agrega',
      titulo: 'Video-verificación asistida en la app',
      detalle: '',
      nodoId: nodoToBe,
      decisionIds: [decisionId],
      insightIds: [insightValidadoId],
    });
    elVideo = a.elementoId;
    const b = await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv1,
      tipo: 'politica',
      operacion: 'modifica',
      titulo: 'El motivo del rechazo se explica al cliente',
      detalle: '',
      nodoId: nodoToBe2,
      decisionIds: [],
      insightIds: [],
    });
    elPolitica = b.elementoId;
    const c = await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv1,
      tipo: 'sistema',
      operacion: 'modifica',
      titulo: 'Integración del core con el proveedor de identidad',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });
    elCore = c.elementoId;

    const dv = await designVersionCompleta(leadId, ws, dv1);
    expect(dv!.elementos.map((e) => e.orden)).toEqual([0, 1, 2]);
    expect(dv!.elementos[0]!.decisiones.map((d) => d.id)).toEqual([decisionId]);
    expect(dv!.elementos[0]!.insights.map((i) => i.id)).toEqual([insightValidadoId]);
    expect(dv!.elementos[0]!.nodoEtiqueta).toBe('Video-verificación');
  });

  it('lo que motiva un elemento tiene que ser citable, y el nodo, del journey de la DV', async () => {
    await expect(
      agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dv1,
        tipo: 'canal',
        operacion: 'agrega',
        titulo: 'Con insight sin validar',
        detalle: '',
        nodoId: null,
        decisionIds: [],
        insightIds: [insightPropuestoId],
      }),
    ).rejects.toThrow(/todavía no está validado/);

    await expect(
      agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dv1,
        tipo: 'canal',
        operacion: 'agrega',
        titulo: 'Con decisión de otro proyecto',
        detalle: '',
        nodoId: null,
        decisionIds: [decisionAjenaId],
        insightIds: [],
      }),
    ).rejects.toThrow(/no existe en el proyecto/);

    // Mismo workspace, así que la FK compuesta está contenta: lo cierra el guard.
    await expect(
      agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dv1,
        tipo: 'paso',
        operacion: 'agrega',
        titulo: 'Con nodo del as-is',
        detalle: '',
        nodoId: nodoAsIs,
        decisionIds: [],
        insightIds: [],
      }),
    ).rejects.toThrow(/no pertenece al journey/);

    const dv = await designVersionCompleta(leadId, ws, dv1);
    expect(dv!.elementos).toHaveLength(3);
  });

  it('aprobar la congela: solo el lead, y en la misma transacción congela el snapshot', async () => {
    await expect(
      aprobarDesignVersion(disId, { workspaceId: ws, designVersionId: dv1, motivo: '' }),
    ).rejects.toThrow(ErrorEntrega);

    const admin = sqlAdmin();
    const [antes] = await admin`select count(*)::int as n from journey_snapshot
      where journey_id = ${toBeId}`;

    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv1,
      motivo: 'Aprobación de DV-1',
    });

    const [despues] = await admin`select count(*)::int as n from journey_snapshot
      where journey_id = ${toBeId}`;
    // RF-06.3: aprobar y congelar son el mismo hecho, no dos pasos que pueden separarse.
    expect(despues!.n as number).toBe((antes!.n as number) + 1);

    const dv = await designVersionCompleta(leadId, ws, dv1);
    expect(dv!.estado).toBe('aprobada');
    expect(dv!.snapshotId).not.toBeNull();
    expect(dv!.aprobadaEn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const eventos = await admin`select tipo from evento_dominio
      where workspace_id = ${ws} and tipo = 'DesignVersionAprobada'`;
    expect(eventos).toHaveLength(1);
  });

  it('aprobada es inmutable (SYS-05): editar o borrar un elemento se rechaza y ofrece la salida', async () => {
    await expect(
      editarElemento(leadId, {
        workspaceId: ws,
        elementoId: elVideo,
        tipo: 'touchpoint',
        operacion: 'agrega',
        titulo: 'Editado a mano',
        detalle: '',
        nodoId: nodoToBe,
      }),
    ).rejects.toThrow(/crea una versión nueva/);

    await expect(borrarElemento(leadId, ws, elVideo)).rejects.toThrow(/crea una versión nueva/);

    await expect(
      agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dv1,
        tipo: 'rol',
        operacion: 'agrega',
        titulo: 'Colado después de aprobar',
        detalle: '',
        nodoId: null,
        decisionIds: [],
        insightIds: [],
      }),
    ).rejects.toThrow(/ya está aprobada/);
  });

  it('el release declara su parcialidad, cuelga de una DV aprobada y cada elemento va a uno solo', async () => {
    // SYS-06: nada de releases sobre borradores.
    const borrador = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: otroServicioId,
      journeyId: null,
      titulo: 'Borrador de otro servicio',
      resumen: '',
      superaA: null,
    });
    await expect(
      planificarRelease(leadId, {
        workspaceId: ws,
        designVersionId: borrador.designVersionId,
        titulo: 'Sobre un borrador',
        responsable: 'Alguien',
        fechaObjetivo: '2026-10-15',
        elementos: [],
      }),
    ).rejects.toThrow(/APROBADA/);

    // Y solo el lead planifica: el diseñador produce el artefacto, no opera la entrega.
    await expect(
      planificarRelease(disId, {
        workspaceId: ws,
        designVersionId: dv1,
        titulo: 'Del diseñador',
        responsable: 'Alguien',
        fechaObjetivo: '2026-10-15',
        elementos: [],
      }),
    ).rejects.toThrow(ErrorEntrega);

    const r1 = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv1,
      titulo: 'Verificación en la app',
      responsable: 'Equipo de canales',
      fechaObjetivo: AYER,
      elementos: [
        { elementoId: elVideo, razon: '' },
        { elementoId: elPolitica, razon: '' },
      ],
    });
    rl1 = r1.releaseId;

    const r2 = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv1,
      titulo: 'Integración en línea',
      responsable: 'Equipo de core',
      fechaObjetivo: dia(45),
      elementos: [{ elementoId: elCore, razon: 'dependencia del área de riesgo' }],
    });
    rl2 = r2.releaseId;

    // Exactamente uno: la PK del elemento en release_elemento, no una convención.
    await expect(
      asignarElemento(leadId, { workspaceId: ws, releaseId: rl2, elementoId: elVideo, razon: '' }),
    ).rejects.toThrow(/exactamente uno/);

    const dv = await designVersionCompleta(leadId, ws, dv1);
    expect(dv!.releases.map((r) => r.codigo)).toEqual(['RL-1', 'RL-2']);
    // Criterio de aceptación 2: el elemento diferido sigue VISIBLE, con su razón.
    const enRl2 = dv!.releases.find((r) => r.id === rl2)!;
    expect(enRl2.elementos).toEqual([
      { elementoId: elCore, razon: 'dependencia del área de riesgo' },
    ]);
  });

  it('desplegar exige elementos declarados y una fecha que no sea futura', async () => {
    const vacio = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv1,
      titulo: 'Release vacío',
      responsable: 'Nadie',
      fechaObjetivo: dia(20),
      elementos: [],
    });
    await expect(
      desplegarRelease(leadId, {
        workspaceId: ws,
        releaseId: vacio.releaseId,
        desplegadoEn: AYER,
      }),
    ).rejects.toThrow(/sin elementos declarados/);

    await expect(
      desplegarRelease(leadId, { workspaceId: ws, releaseId: rl1, desplegadoEn: dia(30) }),
    ).rejects.toThrow(/no puede ser futura/);

    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rl1,
      desplegadoEn: AYER,
    });
    const dv = await designVersionCompleta(leadId, ws, dv1);
    expect(dv!.releases.find((r) => r.id === rl1)!.estado).toBe('desplegado');

    const admin = sqlAdmin();
    await admin`delete from release where id = ${vacio.releaseId} and workspace_id = ${ws}`;
  });

  it('SYS-07: la desviación sin razón la rechaza la BASE, no el servicio', async () => {
    await expect(
      constatarEffectiveState(leadId, {
        workspaceId: ws,
        releaseId: rl1,
        constatadoEn: HOY,
        resumen: '',
        constataciones: [
          { elementoId: elVideo, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
          {
            elementoId: elPolitica,
            resultado: 'desviado',
            queQuedoDistinto: 'El motivo llega por correo',
            razon: '   ',
          },
        ],
      }),
    ).rejects.toThrow(ErrorEntrega);

    // Verificar tampoco pasa si falta constatar algún elemento del release (RF-06.6).
    await expect(
      constatarEffectiveState(leadId, {
        workspaceId: ws,
        releaseId: rl1,
        constatadoEn: HOY,
        resumen: '',
        constataciones: [
          { elementoId: elVideo, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
        ],
      }),
    ).rejects.toThrow(/TODOS los elementos/);

    const r = await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rl1,
      constatadoEn: HOY,
      resumen: 'La verificación en video opera; el motivo salió distinto',
      constataciones: [
        { elementoId: elVideo, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
        {
          elementoId: elPolitica,
          resultado: 'desviado',
          queQuedoDistinto: 'El motivo llega por correo horas después, no en pantalla',
          razon: 'Cumplimiento exigió un paso adicional antes de mostrarlo',
        },
      ],
    });
    expect(r.effectiveStateId).toBeTruthy();

    const dv = await designVersionCompleta(leadId, ws, dv1);
    const release = dv!.releases.find((x) => x.id === rl1)!;
    expect(release.estado).toBe('verificado');
    expect(release.effectiveState!.codigo).toMatch(/^ES-\d+$/);
    const desviacion = release.effectiveState!.constataciones.find(
      (c) => c.elementoId === elPolitica,
    )!;
    expect(desviacion.resultado).toBe('desviado');
    expect(desviacion.razon).toMatch(/Cumplimiento/);

    const admin = sqlAdmin();
    const eventos = await admin`select tipo from evento_dominio
      where workspace_id = ${ws} and tipo = 'DesviacionRegistrada'`;
    expect(eventos).toHaveLength(1);
  });

  it('G7 se bloquea mientras haya un elemento en estado desconocido (RF-06.7)', async () => {
    const admin = sqlAdmin();
    const tablero = await tableroDeConciliacion(leadId, ws, dv1);
    expect(tablero!.filas.map((f) => f.estado).sort()).toEqual([
      'constatado',
      'desviado',
      'en-release',
    ]);
    expect(conciliacionCompleta(tablero!.filas)).toBe(false);

    // La escalera de gates: G7 no se decide con anteriores pendientes.
    for (let n = 0; n <= 6; n++) {
      await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proyectoId} and workspace_id = ${ws} and numero = ${n}`;
    }
    await expect(
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proyectoId} and workspace_id = ${ws} and numero = 7`,
    ).rejects.toThrow(/estado desconocido/);

    // El elemento diferido sale y se constata: el hueco se cierra por el camino honesto.
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rl2,
      desplegadoEn: HOY,
    });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rl2,
      constatadoEn: HOY,
      resumen: '',
      constataciones: [
        {
          elementoId: elCore,
          resultado: 'no-implementado',
          queQuedoDistinto: 'La integración en línea no llegó a salir',
          razon: 'Riesgo no liberó el entorno del proveedor a tiempo',
        },
      ],
    });

    const cerrado = await tableroDeConciliacion(leadId, ws, dv1);
    // 'no-implementado' es una respuesta CONOCIDA: el gate exige honestidad, no éxito.
    expect(conciliacionCompleta(cerrado!.filas)).toBe(true);
    await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
      where proyecto_id = ${proyectoId} and workspace_id = ${ws} and numero = 7`;
    const [g7] = await admin`select estado from gate_instancia
      where proyecto_id = ${proyectoId} and workspace_id = ${ws} and numero = 7`;
    expect(g7!.estado).toBe('aprobado');
  });

  it('la cadena del release se navega en los dos sentidos (RF-06.9, §19.7)', async () => {
    const cadena = await cadenaDeRelease(leadId, ws, rl1);
    // Hacia adelante: qué pasos del journey afectó RL-1.
    expect(cadena!.pasos.map((p) => p.etiqueta).sort()).toEqual([
      'Recibe el motivo del rechazo',
      'Video-verificación',
    ]);
    // Hacia atrás: hasta la cita con su localización exacta.
    expect(cadena!.citas).toHaveLength(1);
    expect(cadena!.citas[0]).toMatchObject({ localizacion: 'p. 14', fragmento: '62 de cada 100' });
  });

  it('un servicio tiene como mucho UNA design version aprobada; la nueva supera a la anterior', async () => {
    const suelta = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId,
      journeyId: toBeId,
      titulo: 'Sin declarar a quién supera',
      resumen: '',
      superaA: null,
    });
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: suelta.designVersionId,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Algo',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });
    await expect(
      aprobarDesignVersion(leadId, {
        workspaceId: ws,
        designVersionId: suelta.designVersionId,
        motivo: '',
      }),
    ).rejects.toThrow(/debe declarar a cuál supera/);

    // El ciclo siguiente trabaja sobre un to-be NUEVO: otros nodos, misma identidad de
    // catálogo para el touchpoint que ya existe. Es el caso en el que emparejar por id de
    // fila o por nodo se rompe y solo el catálogo aguanta.
    const admin = sqlAdmin();
    const [jt2] = await admin`insert into journey
      (workspace_id, servicio_id, reto_id, proyecto_id, tipo, nombre, creado_por)
      values (${ws}, ${servicioId}, ${retoId}, ${proyectoId}, 'to-be', 'Apertura objetivo v2',
              ${leadId}) returning id`;
    const toBe2 = jt2!.id as string;
    const [n4] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, catalogo_id, creado_por)
      values (${ws}, ${toBe2}, 'touchpoint', 'Video-verificación', ${catVideo}, ${leadId})
      returning id`;

    const nueva = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId,
      journeyId: toBe2,
      titulo: 'Segunda versión',
      resumen: '',
      superaA: dv1,
    });
    dv2 = nueva.designVersionId;
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv2,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Cambio de la segunda versión',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });
    // Retirar lo que DV-1 puso: nodo distinto, título distinto, misma cosa.
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv2,
      tipo: 'touchpoint',
      operacion: 'retira',
      titulo: 'Video-verificación asistida (se retira)',
      detalle: '',
      nodoId: n4!.id as string,
      decisionIds: [],
      insightIds: [],
    });
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv2,
      motivo: '',
    });

    const anterior = await designVersionCompleta(leadId, ws, dv1);
    expect(anterior!.estado).toBe('superada');
    expect(anterior!.superadaPor!.id).toBe(dv2);
    // Va la ÚLTIMA del hilo a propósito: superar a DV-1 es de ida (la transición
    // 'superada' → 'aprobada' no existe), así que ningún test posterior podría contar
    // con DV-1 aprobada.
  });

  it('el estado efectivo vigente se pliega por identidad lógica, no por fila de elemento', async () => {
    const dv = await designVersionCompleta(leadId, ws, dv2);
    // Lo que viaja es la HISTORIA del servicio, en orden: una constatación por elemento
    // de DV-1, con su operación y su identidad. Cada elemento_cambio tiene como mucho una
    // constatación en toda su vida, así que aquí no hay nada que deduplicar por id.
    expect(dv!.vigente!.constataciones.map((c) => c.elementoId)).toEqual([
      elVideo,
      elPolitica,
      elCore,
    ]);
    expect(dv!.vigente!.constataciones[0]).toMatchObject({
      operacion: 'agrega',
      resultado: 'como-aprobado',
      catalogoId: catVideo,
    });

    const diff = calcularDiff(dv!.elementos, dv!.vigente);
    // El retiro empareja con lo que DV-1 dejó puesto pese a que el nodo es otro (el to-be
    // del ciclo nuevo) y el título también: la identidad es la del catálogo del servicio.
    const retiro = diff.filas.find((f) => f.operacionDeclarada === 'retira')!;
    expect(retiro.precedente?.elementoId).toBe(elVideo);
    expect(retiro.senal).toBeNull();
    // Y «se mantiene» trae UNA fila por elemento lógico no tocado: la política desviada.
    // El elemento no implementado de RL-2 no está (nunca llegó a existir) y el touchpoint
    // tampoco (lo toca esta versión).
    expect(diff.seMantiene.map((s) => s.elementoId)).toEqual([elPolitica]);
  });

  it('G7 no se aprueba sobre la nada: sin design version aprobada no hay tablero que cerrar', async () => {
    const admin = sqlAdmin();
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-92', 'Proyecto sin design version', ${leadId}) returning id`;
    const sinDv = p!.id as string;
    for (let n = 0; n <= 7; n++) {
      const [g] = await admin`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador)
        values (${ws}, ${sinDv}, ${n}, ${[0, 3, 5, 6].includes(n) ? 'sponsor' : 'lead-boutique'})
        returning id`;
      await admin`insert into checklist_item
        (workspace_id, gate_id, orden, texto, estado, na_justificacion, na_aprobado_por)
        values (${ws}, ${g!.id as string}, 0, 'Ítem del test', 'na', 'fuera de alcance del test',
                ${leadId})`;
    }
    for (let n = 0; n <= 6; n++) {
      await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${sinDv} and workspace_id = ${ws} and numero = ${n}`;
    }
    // El checklist está en orden y la escalera de gates también; lo que falta es el
    // objeto que G7 certifica. Antes pasaba: el «no hay elementos en estado desconocido»
    // era vacuamente cierto porque no había ningún elemento.
    await expect(
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${sinDv} and workspace_id = ${ws} and numero = 7`,
    ).rejects.toThrow(/ninguna design version aprobada con elementos/);
    // Es la misma regla que la app ya aplicaba del lado puro.
    expect(conciliacionCompleta([])).toBe(false);
  });

  it('«se puede enlazar después» es un camino real: el borrador sin journey se enlaza y se aprueba', async () => {
    const admin = sqlAdmin();
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${otroServicioId}, 'to-be', 'Objetivo del otro servicio', ${leadId})
      returning id`;
    const toBeOtro = j!.id as string;
    const [nOtro] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, creado_por)
      values (${ws}, ${toBeOtro}, 'paso', 'Paso del otro objetivo', ${leadId}) returning id`;
    const [j2] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${otroServicioId}, 'to-be', 'Otro objetivo del otro servicio', ${leadId})
      returning id`;
    const toBeOtro2 = j2!.id as string;

    // El guard cierra el atajo de nacer mal enlazado: el to-be es el de SU servicio.
    await expect(
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId,
        servicioId,
        journeyId: toBeOtro,
        titulo: 'Con el journey de otro servicio',
        resumen: '',
        superaA: null,
      }),
    ).rejects.toThrow(/to-be de su servicio/);

    const suelta = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: otroServicioId,
      journeyId: null,
      titulo: 'Nace sin journey',
      resumen: '',
      superaA: null,
    });
    const sinJourney = suelta.designVersionId;

    // La pantalla ofrece exactamente lo que el guard acepta: los to-be de SU servicio.
    const antes = await designVersionCompleta(leadId, ws, sinJourney);
    expect(antes!.journeyId).toBeNull();
    expect(antes!.journeysEnlazables.map((x) => x.id).sort()).toEqual(
      [toBeOtro, toBeOtro2].sort(),
    );

    // El stakeholder no enlaza: la política solo alcanza a curadores.
    await expect(
      enlazarJourney(stakeId, {
        workspaceId: ws,
        designVersionId: sinJourney,
        journeyId: toBeOtro,
      }),
    ).rejects.toThrow(ErrorEntrega);
    // Y el curador tampoco puede enlazar cualquier cosa.
    await expect(
      enlazarJourney(disId, { workspaceId: ws, designVersionId: sinJourney, journeyId: toBeId }),
    ).rejects.toThrow(/to-be de su servicio/);

    await enlazarJourney(disId, {
      workspaceId: ws,
      designVersionId: sinJourney,
      journeyId: toBeOtro,
    });
    const despues = await designVersionCompleta(leadId, ws, sinJourney);
    expect(despues!.journeyId).toBe(toBeOtro);

    // Y con el enlace puesto, el borrador que estaba muerto se puede aprobar.
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: sinJourney,
      tipo: 'paso',
      operacion: 'agrega',
      titulo: 'Algo que cambia en el otro servicio',
      detalle: '',
      nodoId: nOtro!.id as string,
      decisionIds: [],
      insightIds: [],
    });
    // Reenlazar AHORA dejaría ese elemento apuntando a un nodo fuera del grafo que la
    // design version aprueba: el guard lo para y pide revisar los enlaces primero.
    await expect(
      enlazarJourney(disId, {
        workspaceId: ws,
        designVersionId: sinJourney,
        journeyId: toBeOtro2,
      }),
    ).rejects.toThrow(/journey anterior/);
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: sinJourney,
      motivo: '',
    });
    const aprobada = await designVersionCompleta(leadId, ws, sinJourney);
    expect(aprobada!.estado).toBe('aprobada');
    expect(aprobada!.snapshotId).not.toBeNull();

    // Aprobada, el enlace deja de moverse: la política solo alcanza borradores y, donde
    // la RLS no llega —el UPDATE que no cambia de estado, que el USING de «superar» y el
    // WITH CHECK de «aprobar» dejarían pasar entre los dos—, el guard de transición
    // sostiene la inmutabilidad de SYS-05.
    await expect(
      enlazarJourney(leadId, { workspaceId: ws, designVersionId: sinJourney, journeyId: toBeOtro }),
    ).rejects.toThrow(/inmutable/);
    // Ni siquiera repuntando snapshot y journey A LA VEZ por SQL directo, que es la
    // versión peligrosa del mismo hueco: con los dos coherentes entre sí, el WITH CHECK
    // de «aprobar» no tiene nada que objetar, y la versión aprobada acabaría diciendo que
    // aprobó otro grafo.
    const [snapAjeno] = await admin`insert into journey_snapshot
      (workspace_id, journey_id, motivo, grafo, congelado_por)
      values (${ws}, ${toBeOtro2}, 'snapshot de otro grafo', '{}'::jsonb, ${leadId})
      returning id`;
    await expect(
      conUsuario(leadId, (tx) => tx`update design_version
        set journey_id = ${toBeOtro2}, snapshot_id = ${snapAjeno!.id as string}
        where id = ${sinJourney} and workspace_id = ${ws}`),
    ).rejects.toThrow(/inmutable/);
    // Y el grant por columna deja fuera todo lo demás de un borrador.
    const otroBorrador = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: otroServicioId,
      journeyId: null,
      titulo: 'Título original',
      resumen: '',
      superaA: null,
    });
    await expect(
      conUsuario(leadId, (tx) => tx`update design_version set titulo = 'Colado'
        where id = ${otroBorrador.designVersionId} and workspace_id = ${ws}`),
    ).rejects.toThrow(/permission denied/);
  });

  it('nada de esto cruza el workspace', async () => {
    const admin = sqlAdmin();
    const [otro] = await admin`insert into workspace (nombre) values (${marca + '-ajeno'})
      returning id`;
    const otroWs = otro!.id as string;
    try {
      // El lead no es miembro del workspace ajeno: la RLS no le da ni una fila.
      const filas = await conUsuario(leadId, async (tx) => {
        return tx`select id from design_version where workspace_id = ${otroWs}`;
      });
      expect(filas).toHaveLength(0);
      // Y pedir la DV propia CON el workspace ajeno tampoco la encuentra.
      expect(await designVersionCompleta(leadId, otroWs, dv1)).toBeNull();
    } finally {
      await admin`delete from workspace where id = ${otroWs}`;
    }
  });
});
