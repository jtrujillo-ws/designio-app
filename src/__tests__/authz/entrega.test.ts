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
  declararSuperaA,
  desasignarElemento,
  designVersionCompleta,
  designVersionsDelWorkspace,
  desplegarRelease,
  editarElemento,
  enlazarJourney,
  ErrorEntrega,
  PAGINA_DESIGN_VERSIONS,
  planificarRelease,
  tableroDeConciliacion,
  versionAprobadaDelServicio,
} from '@/lib/entrega/entrega.servicio';
import { calcularDiff, conciliacionCompleta } from '@/lib/entrega/entrega.diff';
import { abrirHilo, hilosDeObjetos } from '@/lib/portal/portal.servicio';
import { borrarNodo } from '@/lib/journey/journey.servicio';
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

/**
 * ¿La operación sigue esperando el candado? Los dos manejadores se enganchan a la
 * promesa EN EL ACTO —y no como una rama de un Promise.race— para que su eventual
 * rechazo nunca quede sin observar: una promesa rechazada que nadie mira tumba la corrida
 * entera aunque el test que la creó haya pasado.
 */
async function siguePendiente(operacion: Promise<unknown>): Promise<boolean> {
  let termino = false;
  const marcar = () => {
    termino = true;
  };
  operacion.then(marcar, marcar);
  await new Promise((r) => setTimeout(r, 250));
  return !termino;
}

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
  // Fixtures de las carreras: servicio propio para que ningún otro test compita por el
  // índice único de «una design version aprobada por servicio».
  let dvCarrera = '';
  let elCarreraA = '';
  let elCarreraB = '';
  let rlCarrera = '';
  let dvSucesora = '';
  let elSucesora = '';

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
    // R-90 ancla en `servicioId` y declara AFECTADO a `otroServicioId`: es la relación que
    // hace legítimo que un proyecto de este reto produzca design versions de los dos
    // servicios, y la que el guard de anclaje comprueba.
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${otroServicioId}, ${ws}, ${leadId})`;
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
    // Los hilos del portal cuelgan de la design version desde SPEC-06: se van primero o
    // la FK compuesta impide borrarla.
    await admin`delete from comentario where workspace_id = ${ws}`;
    await admin`delete from hilo_comentario where workspace_id = ${ws}`;
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
    await admin`delete from reto_servicio_afectado where workspace_id = ${ws}`;
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
    const pagina = await designVersionsDelWorkspace(stakeId, ws);
    expect(pagina.versiones.map((v) => v.id)).toEqual([dv1]);
    expect(pagina.siguiente).toBeNull();
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
    // El servicio ya tiene DV-1 aprobada, así que una versión nueva que no declare a cuál
    // supera se rechaza YA EN EL ALTA: antes nacía y solo se descubría inaprobable contra
    // el índice único, con `supera_a` fuera del grant y sin DELETE para deshacerlo.
    await expect(
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId,
        servicioId,
        journeyId: toBeId,
        titulo: 'Sin declarar a quién supera',
        resumen: '',
        superaA: null,
      }),
    ).rejects.toThrow(/ya tiene una design version aprobada/);

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

  it('G7 no se aprueba sobre la nada: sin design version vigente no hay tablero que cerrar', async () => {
    // El caso llega por el camino real: el proyecto SÍ tuvo su design version, firmó G6
    // con el plan completo, y para cuando pide G7 otro proyecto ya la ha superado. Su
    // tablero se queda sin filas —los elementos de una superada son historia de un ciclo
    // anterior y el guard los excluye a propósito—, y sin filas el «no hay elementos en
    // estado desconocido» sería vacuamente cierto.
    const admin = sqlAdmin();
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-92', 'Proyecto superado por otro', ${leadId}) returning id`;
    const proy = p!.id as string;
    for (let n = 0; n <= 7; n++) {
      const [g] = await admin`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador)
        values (${ws}, ${proy}, ${n}, ${[0, 3, 5, 6].includes(n) ? 'sponsor' : 'lead-boutique'})
        returning id`;
      await admin`insert into checklist_item
        (workspace_id, gate_id, orden, texto, estado, na_justificacion, na_aprobado_por)
        values (${ws}, ${g!.id as string}, 0, 'Ítem del test', 'na', 'fuera de alcance del test',
                ${leadId})`;
    }
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio del ciclo corto', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'Objetivo del ciclo corto', ${leadId}) returning id`;
    const journeyId = j!.id as string;

    const propia = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La del proyecto que la pierde',
      resumen: '',
      superaA: null,
    });
    const suyo = await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: propia.designVersionId,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Elemento del ciclo corto',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: propia.designVersionId,
      motivo: '',
    });
    await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: propia.designVersionId,
      titulo: 'Plan del ciclo corto',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: suyo.elementoId, razon: '' }],
    });
    for (let n = 0; n <= 6; n++) {
      await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proy} and workspace_id = ${ws} and numero = ${n}`;
    }

    // Otro proyecto se lleva el servicio al ciclo siguiente y supera la versión.
    const sucesora = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: svcId,
      journeyId,
      titulo: 'La del proyecto que sigue',
      resumen: '',
      superaA: propia.designVersionId,
    });
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: sucesora.designVersionId,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Elemento del ciclo siguiente',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: sucesora.designVersionId,
      motivo: '',
    });

    await expect(
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 7`,
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

    // El guard cierra el atajo de nacer mal enlazado: el to-be es el de SU servicio. Se
    // prueba sobre `otroServicioId`, que todavía no tiene ninguna aprobada: si no, saltaría
    // antes la regla de sucesión y no se estaría probando esto.
    await expect(
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId,
        servicioId: otroServicioId,
        journeyId: toBeId,
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
    // Y el grant por columna deja fuera todo lo demás de un borrador. (Declara a cuál
    // supera porque el servicio ya tiene la recién aprobada: sin eso no nacería.)
    const otroBorrador = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: otroServicioId,
      journeyId: null,
      titulo: 'Título original',
      resumen: '',
      superaA: sinJourney,
    });
    await expect(
      conUsuario(leadId, (tx) => tx`update design_version set titulo = 'Colado'
        where id = ${otroBorrador.designVersionId} and workspace_id = ${ws}`),
    ).rejects.toThrow(/permission denied/);
  });

  it('aprobar espera a las mutaciones de elementos en vuelo: nada entra tras la congelación', async () => {
    const admin = sqlAdmin();
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio de la carrera', ${leadId}) returning id`;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svc!.id as string}, ${ws}, ${leadId})`;
    const [jt] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svc!.id as string}, 'to-be', 'Objetivo de la carrera', ${leadId})
      returning id`;
    const creada = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: svc!.id as string,
      journeyId: jt!.id as string,
      titulo: 'La que se aprueba mientras la editan',
      resumen: '',
      superaA: null,
    });
    dvCarrera = creada.designVersionId;
    elCarreraA = (
      await agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dvCarrera,
        tipo: 'canal',
        operacion: 'agrega',
        titulo: 'Elemento declarado antes de aprobar',
        detalle: '',
        nodoId: null,
        decisionIds: [],
        insightIds: [],
      })
    ).elementoId;

    // Transacción A (SQL directo): toma el candado de la DESIGN VERSION —el mismo que
    // toma agregarElemento— , inserta un elemento y QUEDA ABIERTA. La aprobación
    // concurrente escribe otra fila, así que ningún candado de fila la detiene: si no
    // pidiera este candado, congelaría y aprobaría mientras A sigue en vuelo, y el
    // elemento de A acabaría dentro de una versión ya inmutable.
    // El intercalado se fija a mano: A avisa cuando YA tiene el candado, y solo entonces
    // arranca la aprobación. Sin ese aviso el test podría pasar por el intercalado
    // contrario (la aprobación llegando primero al candado), que no prueba nada.
    let listo!: () => void;
    const tomado = new Promise<void>((r) => (listo = r));
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const enVuelo = conUsuario(leadId, async (tx) => {
      await tx`select pg_advisory_xact_lock(
        hashtextextended('designio:dv-elemento:' || ${dvCarrera}, 42))`;
      const [fila] = await tx`insert into elemento_cambio
        (workspace_id, design_version_id, tipo, operacion, titulo, orden, creado_por)
        values (${ws}, ${dvCarrera}, 'politica', 'agrega', 'Colado en plena aprobación', 1,
                ${leadId})
        returning id`;
      elCarreraB = fila!.id as string;
      listo();
      await espera;
    });
    await tomado;
    const aprobacion = aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dvCarrera,
      motivo: '',
    });
    try {
      expect(await siguePendiente(aprobacion)).toBe(true);
    } finally {
      liberar();
    }
    await enVuelo;
    await aprobacion;

    const dv = await designVersionCompleta(leadId, ws, dvCarrera);
    expect(dv!.estado).toBe('aprobada');
    // El elemento en vuelo quedó DENTRO de lo aprobado, que es el único desenlace honesto:
    // o entra antes de congelar, o lo rechaza la política por versión ya aprobada.
    expect(dv!.elementos.map((e) => e.titulo)).toContain('Colado en plena aprobación');
    expect(dv!.elementos).toHaveLength(2);
  });

  it('el alcance del release no se mueve mientras el release se despliega (SYS-06)', async () => {
    const plan = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvCarrera,
      titulo: 'Release de la carrera',
      responsable: 'Equipo de la carrera',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elCarreraA, razon: '' }],
    });
    rlCarrera = plan.releaseId;

    // Transacción A: candado del release y despliegue por SQL directo, abierta. Avisa al
    // tener el candado para que el intercalado no dependa del planificador.
    let listo!: () => void;
    const tomado = new Promise<void>((r) => (listo = r));
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const despliegue = conUsuario(leadId, async (tx) => {
      await tx`select pg_advisory_xact_lock(
        hashtextextended('designio:release:' || ${rlCarrera}, 42))`;
      await tx`update release set estado = 'desplegado', desplegado_en = ${AYER}::date
        where id = ${rlCarrera} and workspace_id = ${ws}`;
      listo();
      await espera;
    });
    await tomado;
    // Asignar mira el estado del release desde su propia política: sin candado leería
    // 'planificado' —el despliegue de A aún no está commiteado— y el elemento entraría en
    // un release ya desplegado.
    const asignacion = asignarElemento(leadId, {
      workspaceId: ws,
      releaseId: rlCarrera,
      elementoId: elCarreraB,
      razon: 'llega tarde',
    });
    try {
      expect(await siguePendiente(asignacion)).toBe(true);
    } finally {
      liberar();
    }
    await despliegue;
    await expect(asignacion).rejects.toThrow(ErrorEntrega);

    const dv = await designVersionCompleta(leadId, ws, dvCarrera);
    const release = dv!.releases.find((r) => r.id === rlCarrera)!;
    expect(release.estado).toBe('desplegado');
    expect(release.elementos.map((e) => e.elementoId)).toEqual([elCarreraA]);
  });

  it('la fecha real de un release desplegado no se reescribe por un UPDATE sin transición', async () => {
    // El `using` de release_verificar selecciona la fila y el `with check` de
    // release_desplegar la deja pasar: entre las dos políticas, un UPDATE que no cambia el
    // estado llegaba a la fila con `desplegado_en` dentro del grant de columna.
    await expect(
      conUsuario(leadId, (tx) => tx`update release set desplegado_en = ${dia(-30)}::date
        where id = ${rlCarrera} and workspace_id = ${ws}`),
    ).rejects.toThrow(/no se reescribe/);
    const admin = sqlAdmin();
    const [r] = await admin`select to_char(desplegado_en, 'YYYY-MM-DD') as f from release
      where id = ${rlCarrera} and workspace_id = ${ws}`;
    expect(r!.f).toBe(AYER);
    // Y el UPDATE no-op tampoco fabrica auditoría: el guard aborta antes de emitir nada.
    const eventos = await admin`select count(*)::int as n from evento_dominio
      where workspace_id = ${ws} and tipo = 'ReleaseDesplegado'
        and payload->>'releaseId' = ${rlCarrera}`;
    expect(eventos[0]!.n as number).toBe(1);
  });

  it('un release desplegado se constata aunque su design version quede superada', async () => {
    // El caso que la pantalla apagaba entero: DV-2 aprueba mientras un release de DV-1 ya
    // salió y nadie lo ha constatado. La base y el servicio lo permiten —y tienen que
    // permitirlo—: ese release cambió el servicio de verdad, y su constatación es la
    // única vía para que eso entre en el effective state contra el que se calcula el diff
    // de las versiones siguientes (RF-06.10).
    const sucesora = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: (
        await sqlAdmin()`select servicio_id from design_version
          where id = ${dvCarrera} and workspace_id = ${ws}`
      )[0]!.servicio_id as string,
      journeyId: (
        await sqlAdmin()`select journey_id from design_version
          where id = ${dvCarrera} and workspace_id = ${ws}`
      )[0]!.journey_id as string,
      titulo: 'La que supera a la de la carrera',
      resumen: '',
      superaA: dvCarrera,
    });
    dvSucesora = sucesora.designVersionId;
    elSucesora = (
      await agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dvSucesora,
        tipo: 'canal',
        operacion: 'agrega',
        titulo: 'Cambio del ciclo siguiente',
        detalle: '',
        nodoId: null,
        decisionIds: [],
        insightIds: [],
      })
    ).elementoId;
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: sucesora.designVersionId,
      motivo: '',
    });
    expect((await designVersionCompleta(leadId, ws, dvCarrera))!.estado).toBe('superada');

    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlCarrera,
      constatadoEn: HOY,
      resumen: 'Salió antes de que el diseño se reemplazara',
      constataciones: [
        { elementoId: elCarreraA, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
      ],
    });

    const superada = await designVersionCompleta(leadId, ws, dvCarrera);
    expect(superada!.releases.find((r) => r.id === rlCarrera)!.estado).toBe('verificado');
    // Y lo constatado entra en el estado efectivo del SERVICIO: la sucesora lo ve como
    // vigente, que es justo lo que se perdía si el release se quedaba sin constatar.
    const siguiente = await designVersionCompleta(leadId, ws, sucesora.designVersionId);
    expect(siguiente!.vigente!.constataciones.map((c) => c.elementoId)).toEqual([elCarreraA]);
  });

  it('la design version entra al arco del portal: el cliente comenta lo que se decidió cambiar', async () => {
    const admin = sqlAdmin();
    const abierto = await abrirHilo(stakeId, {
      workspaceId: ws,
      objeto: { tipo: 'design_version', id: dv1 },
      cuerpo: '¿La verificación en video cubre a quien no tiene smartphone?',
    });
    const { hilos } = await hilosDeObjetos(leadId, ws, [{ tipo: 'design_version', id: dv1 }]);
    expect(hilos.map((h) => h.id)).toEqual([abierto.hiloId]);
    expect(hilos[0]!.objetoTipo).toBe('design_version');
    // El rol CONGELADO del portal: el stakeholder comenta en el canal que es suyo.
    expect(hilos[0]!.comentarios[0]!.autorRol).toBe('stakeholder');

    // El arco sigue siendo EXCLUSIVO tras ampliarlo: un hilo no cuelga de dos objetos.
    await expect(
      admin`insert into hilo_comentario
        (workspace_id, proyecto_id, design_version_id, abierto_por)
        values (${ws}, ${proyectoId}, ${dv1}, ${leadId})`,
    ).rejects.toThrow(/hilo_comentario_objeto_unico/);

    // Y la columna generada nombra el objeto nuevo, así que la auditoría también.
    const [ev] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'HiloAbierto'
        and payload->>'hiloId' = ${abierto.hiloId}`;
    expect((ev!.payload as { objetoTipo: string }).objetoTipo).toBe('design_version');
  });

  it('el proyecto y el servicio de una design version cuelgan del MISMO reto', async () => {
    const admin = sqlAdmin();
    // Un servicio del workspace que R-90 ni ancla ni declara afectado.
    const [ajeno] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio ajeno al reto', ${leadId}) returning id`;
    const servicioAjeno = ajeno!.id as string;

    // Las dos FKs están contentas —proyecto y servicio existen en el workspace— y el
    // journey no puede decir nada: un to-be sin proyecto es legítimo, así que el chequeo
    // de anclaje del journey se salta entero. La relación la impone el reto del proyecto.
    await expect(
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId,
        servicioId: servicioAjeno,
        journeyId: null,
        titulo: 'Cambia un servicio que este reto no toca',
        resumen: '',
        superaA: null,
      }),
    ).rejects.toThrow(/no ancla este servicio ni lo declara afectado/);

    // Declararlo afectado lo vuelve legítimo: la regla es la relación, no una lista fija.
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${servicioAjeno}, ${ws}, ${leadId})`;
    const valida = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: servicioAjeno,
      journeyId: null,
      titulo: 'Ahora el reto sí lo declara afectado',
      resumen: '',
      superaA: null,
    });
    expect(valida.designVersionId).toBeTruthy();

    // Y superar solo alcanza a versiones del MISMO servicio. Se comprueba al nacer y no
    // solo al aprobar porque `supera_a` no está en el grant de columna y no hay DELETE:
    // el borrador mal apuntado sería una fila muerta para siempre.
    await expect(
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId,
        servicioId: servicioAjeno,
        journeyId: null,
        titulo: 'Supera a la de otro servicio',
        resumen: '',
        superaA: dv1,
      }),
    ).rejects.toThrow(/MISMO servicio/);
  });

  it('el grafo vivo se sigue editando tras congelarlo, y la referencia histórica la sostiene el snapshot', async () => {
    // RF-05.8: aprobar congela un SNAPSHOT; el journey de trabajo continúa editable para
    // el ciclo siguiente. Con una FK restrictiva desde el elemento inmutable, enlazar un
    // nodo lo volvía imborrable para siempre — el objeto congelado prohibiéndole cambiar
    // al vivo.
    const cadenaAntes = await cadenaDeRelease(leadId, ws, rl1);
    expect(cadenaAntes!.pasos.map((p) => p.etiqueta).sort()).toEqual([
      'Recibe el motivo del rechazo',
      'Video-verificación',
    ]);

    // El nodo que DV-1 enlazó se borra del grafo vivo: es un ciclo nuevo y el paso ya no
    // está. Antes esto fallaba con violación de FK y no había forma de deshacerlo (la
    // design version aprobada es inmutable).
    await borrarNodo(leadId, ws, nodoToBe2);
    const [quedan] = await sqlAdmin()`select count(*)::int as n from journey_nodo
      where id = ${nodoToBe2} and workspace_id = ${ws}`;
    expect(quedan!.n as number).toBe(0);

    // Y la cadena sigue respondiendo lo mismo: el paso salió del snapshot, no de la fila.
    const cadenaDespues = await cadenaDeRelease(leadId, ws, rl1);
    expect(cadenaDespues!.pasos.map((p) => p.etiqueta).sort()).toEqual([
      'Recibe el motivo del rechazo',
      'Video-verificación',
    ]);
    const dv = await designVersionCompleta(leadId, ws, dv1);
    expect(dv!.elementos.find((e) => e.id === elPolitica)!.nodoEtiqueta).toBe(
      'Recibe el motivo del rechazo',
    );
  });

  it('la constatación no puede ser anterior al despliegue que describe', async () => {
    const plan = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvSucesora,
      titulo: 'Release con fechas',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elSucesora, razon: '' }],
    });
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: plan.releaseId,
      desplegadoEn: AYER,
    });
    // Una foto de lo que quedó funcionando no puede ser anterior al día en que salió: no
    // describiría este release. Y como el pliegue del estado vigente ORDENA por
    // constatado_en, la fecha inválida además reordenaría la historia del servicio.
    await expect(
      constatarEffectiveState(leadId, {
        workspaceId: ws,
        releaseId: plan.releaseId,
        constatadoEn: dia(-10),
        resumen: '',
        constataciones: [
          { elementoId: elSucesora, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
        ],
      }),
    ).rejects.toThrow(/anterior al despliegue/);
    // El mismo día sí: constatar lo que acaba de salir es legítimo.
    const r = await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: plan.releaseId,
      constatadoEn: AYER,
      resumen: '',
      constataciones: [
        { elementoId: elSucesora, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
      ],
    });
    expect(r.effectiveStateId).toBeTruthy();
  });

  it('reenlazar el journey espera a los elementos en vuelo, y no solo a la aprobación', async () => {
    const admin = sqlAdmin();
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio del reenlace', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [ja] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'Objetivo A', ${leadId}) returning id`;
    const [jb] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'Objetivo B', ${leadId}) returning id`;
    const [nodoA] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, creado_por)
      values (${ws}, ${ja!.id as string}, 'paso', 'Paso del objetivo A', ${leadId}) returning id`;
    const creada = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: svcId,
      journeyId: ja!.id as string,
      titulo: 'La que reenlaza mientras la editan',
      resumen: '',
      superaA: null,
    });

    // Transacción A: toma el candado de la design version y enlaza un elemento a un nodo
    // del journey ACTUAL, y queda en vuelo. Contra la aprobación, reenlazar se serializaría
    // solo con el candado de fila —las dos escriben la misma—, pero su otro contendiente
    // escribe otra tabla y usa el candado consultivo: un candado de fila y uno consultivo
    // sobre el mismo objeto no se ven entre sí.
    let listo!: () => void;
    const tomado = new Promise<void>((r) => (listo = r));
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const enVuelo = conUsuario(leadId, async (tx) => {
      await tx`select pg_advisory_xact_lock(
        hashtextextended('designio:dv-elemento:' || ${creada.designVersionId}, 42))`;
      await tx`insert into elemento_cambio
        (workspace_id, design_version_id, tipo, operacion, titulo, nodo_id, orden, creado_por)
        values (${ws}, ${creada.designVersionId}, 'paso', 'agrega', 'Cuelga del objetivo A',
                ${nodoA!.id as string}, 0, ${leadId})`;
      listo();
      await espera;
    });
    await tomado;
    const reenlace = enlazarJourney(leadId, {
      workspaceId: ws,
      designVersionId: creada.designVersionId,
      journeyId: jb!.id as string,
    });
    try {
      expect(await siguePendiente(reenlace)).toBe(true);
    } finally {
      liberar();
    }
    await enVuelo;
    // Al soltar, el reenlace ya ve el elemento y lo rechaza. Sin el candado habría
    // commiteado, dejando un elemento colgado de un nodo fuera del grafo de su design
    // version — y la aprobación no revalida enlace por enlace.
    await expect(reenlace).rejects.toThrow(/journey anterior/);
    const dv = await designVersionCompleta(leadId, ws, creada.designVersionId);
    expect(dv!.journeyId).toBe(ja!.id as string);
  });

  it('G6 no firma un plan que no existe ni uno con elementos sin release (RF-06.4)', async () => {
    const admin = sqlAdmin();
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-94', 'Proyecto del plan', ${leadId}) returning id`;
    const proyG6 = p!.id as string;
    for (let n = 0; n <= 7; n++) {
      const [g] = await admin`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador)
        values (${ws}, ${proyG6}, ${n}, ${[0, 3, 5, 6].includes(n) ? 'sponsor' : 'lead-boutique'})
        returning id`;
      await admin`insert into checklist_item
        (workspace_id, gate_id, orden, texto, estado, na_justificacion, na_aprobado_por)
        values (${ws}, ${g!.id as string}, 0, 'Ítem del test', 'na', 'fuera de alcance del test',
                ${leadId})`;
    }
    const aprobarGateCrudo = (n: number) =>
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proyG6} and workspace_id = ${ws} and numero = ${n}`;
    for (let n = 0; n <= 5; n++) await aprobarGateCrudo(n);

    // Sin design version aprobada no hay plan que firmar: el gemelo vacuo de la regla,
    // igual que en G7. El ítem del checklist está cumplido y no demuestra nada — registra
    // un objeto citado o un N/A, no deriva cobertura de release_elemento.
    await expect(aprobarGateCrudo(6)).rejects.toThrow(
      /ninguna design version aprobada con elementos que planificar/,
    );

    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio del plan', ${leadId}) returning id`;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svc!.id as string}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svc!.id as string}, 'to-be', 'Objetivo del plan', ${leadId}) returning id`;
    const dvPlan = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyG6,
      servicioId: svc!.id as string,
      journeyId: j!.id as string,
      titulo: 'La del plan',
      resumen: '',
      superaA: null,
    });
    const uno = await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dvPlan.designVersionId,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Elemento con release',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });
    const dos = await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dvPlan.designVersionId,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Elemento que se queda fuera del plan',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dvPlan.designVersionId,
      motivo: '',
    });

    // Con la versión aprobada pero un elemento sin release, G6 sigue sin poder firmarse:
    // RF-06.4 dice «CADA elemento asignado a exactamente un release con dueño y fecha».
    const plan = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvPlan.designVersionId,
      titulo: 'Plan parcial',
      responsable: 'Equipo del plan',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: uno.elementoId, razon: '' }],
    });
    await expect(aprobarGateCrudo(6)).rejects.toThrow(/sin release asignado/);

    await asignarElemento(leadId, {
      workspaceId: ws,
      releaseId: plan.releaseId,
      elementoId: dos.elementoId,
      razon: 'cierra el plan',
    });
    await aprobarGateCrudo(6);
    const [g6] = await admin`select estado from gate_instancia
      where proyecto_id = ${proyG6} and workspace_id = ${ws} and numero = 6`;
    expect(g6!.estado).toBe('aprobado');
  });

  it('la sucesión declarada se corrige: perder la carrera no deja un borrador muerto', async () => {
    const admin = sqlAdmin();
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio de la sucesión', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'Objetivo de la sucesión', ${leadId}) returning id`;
    const journeyId = j!.id as string;

    const nueva = (titulo: string, superaA: string | null) =>
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId,
        servicioId: svcId,
        journeyId,
        titulo,
        resumen: '',
        superaA,
      });
    const conElemento = async (designVersionId: string) => {
      await agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId,
        tipo: 'canal',
        operacion: 'agrega',
        titulo: 'Algo',
        detalle: '',
        nodoId: null,
        decisionIds: [],
        insightIds: [],
      });
      return designVersionId;
    };

    // Dos borradores nacen como «la primera del servicio»: legítimo, todavía no hay
    // ninguna aprobada. Uno de los dos gana la carrera.
    const perdedora = await conElemento((await nueva('La que pierde la carrera', null)).designVersionId);
    const ganadora = await conElemento((await nueva('La que gana la carrera', null)).designVersionId);
    await aprobarDesignVersion(leadId, { workspaceId: ws, designVersionId: ganadora, motivo: '' });

    // A partir de ahí, un alta nueva TIENE que declarar a cuál supera: el guard lo exige
    // en el nacimiento en vez de dejar que lo descubra el índice único al aprobar.
    await expect(nueva('Otra primera imposible', null)).rejects.toThrow(
      /ya tiene una design version aprobada/,
    );

    // Y la que perdió no está muerta: se reapunta y se aprueba.
    await expect(
      aprobarDesignVersion(leadId, { workspaceId: ws, designVersionId: perdedora, motivo: '' }),
    ).rejects.toThrow(/debe declarar a cuál supera/);
    await declararSuperaA(leadId, {
      workspaceId: ws,
      designVersionId: perdedora,
      superaA: ganadora,
    });
    await aprobarDesignVersion(leadId, { workspaceId: ws, designVersionId: perdedora, motivo: '' });
    expect((await designVersionCompleta(leadId, ws, ganadora))!.estado).toBe('superada');
    expect((await designVersionCompleta(leadId, ws, perdedora))!.estado).toBe('aprobada');
    // Y la sucesión solo se corrige mientras sea borrador.
    await expect(
      declararSuperaA(leadId, { workspaceId: ws, designVersionId: perdedora, superaA: null }),
    ).rejects.toThrow(/inmutable/);
  });

  it('aprobar revalida los nodos del borrador: no se congela una promesa que el snapshot no puede cumplir', async () => {
    // `elemento_cambio.nodo_id` no tiene FK a propósito: el registro histórico se resuelve
    // contra el snapshot, no contra la fila viva, y una FK volvía imborrable para siempre
    // todo nodo que una versión aprobada enlazara. Pero un BORRADOR sí se apoya en la fila
    // viva —se edita contra el grafo de trabajo, que RF-05.8 mantiene editable—, así que
    // entre enlazar y aprobar el nodo puede desaparecer. La salida NO es volver a hacerlo
    // imborrable (sería reintroducir el cierre por otra puerta, y encima por culpa del
    // objeto más provisional que hay): es revalidar al APROBAR, que es el instante en que
    // el borrador deja de poder corregirse.
    const admin = sqlAdmin();
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio del nodo que se va', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'Objetivo con nodo efímero', ${leadId}) returning id`;
    const journeyId = j!.id as string;
    const [n] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, creado_por)
      values (${ws}, ${journeyId}, 'paso', 'Paso que se va a borrar', ${leadId}) returning id`;
    const nodoId = n!.id as string;
    const [n2] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, creado_por)
      values (${ws}, ${journeyId}, 'paso', 'Paso que se queda', ${leadId}) returning id`;

    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: svcId,
      journeyId,
      titulo: 'La que enlaza un nodo efímero',
      resumen: '',
      superaA: null,
    });
    const colgante = await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      tipo: 'paso',
      operacion: 'modifica',
      titulo: 'Elemento del paso efímero',
      detalle: '',
      nodoId,
      decisionIds: [],
      insightIds: [],
    });
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      tipo: 'paso',
      operacion: 'modifica',
      titulo: 'Elemento del paso que se queda',
      detalle: '',
      nodoId: n2!.id as string,
      decisionIds: [],
      insightIds: [],
    });

    // El grafo de trabajo sigue su camino: el nodo se borra y el enlace del borrador queda
    // colgando. Nadie vuelve a escribir el elemento, así que elemento_cambio_nodo_guard
    // —que es BEFORE INSERT/UPDATE del elemento— no corre otra vez.
    await borrarNodo(leadId, ws, nodoId);
    const suelto = await designVersionCompleta(leadId, ws, dv.designVersionId);
    const roto = suelto!.elementos.find((e) => e.id === colgante.elementoId)!;
    expect(roto.nodoId).toBe(nodoId);
    // La pantalla lo ve: hay nodo enlazado y no hay etiqueta que resolver.
    expect(roto.nodoEtiqueta).toBeNull();

    // Y aprobar se rechaza: el snapshot que congelaría esta versión no contiene el nodo,
    // así que «qué pasos del journey afectó RL-1» (§19.7) saldría vacío para siempre sobre
    // una versión que ya no se puede corregir.
    await expect(
      aprobarDesignVersion(leadId, { workspaceId: ws, designVersionId: dv.designVersionId, motivo: '' }),
    ).rejects.toThrow(/nodos que ya no están en el journey/);
    const sigue = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(sigue!.estado).toBe('borrador');
    expect(sigue!.snapshotId).toBeNull();

    // El borrador SÍ se corrige —esa es la diferencia con una versión aprobada—: se
    // desenlaza el nodo y la aprobación pasa. El elemento sigue existiendo: no se limpia
    // solo, porque borrar el trabajo de otro en silencio es peor que pedir que lo revise.
    await editarElemento(leadId, {
      workspaceId: ws,
      elementoId: colgante.elementoId,
      tipo: 'paso',
      operacion: 'modifica',
      titulo: 'Elemento del paso efímero',
      detalle: '',
      nodoId: null,
    });
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    const aprobada = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(aprobada!.estado).toBe('aprobada');
    // El otro elemento conserva su nodo, y ahora lo resuelve el snapshot congelado.
    expect(
      aprobada!.elementos.find((e) => e.titulo === 'Elemento del paso que se queda')!.nodoEtiqueta,
    ).toBe('Paso que se queda');
  });

  it('G7 espera a los releases que la versión superada dejó en vuelo (RF-06.7)', async () => {
    // El otro lado del argumento que separó `puedePlanificar` de `puedeCompletar`: si un
    // release de DV-1 se puede constatar tras la supersión —porque el effective state del
    // servicio se arma con TODOS sus releases verificados (RF-06.10)—, entonces excluir de
    // G7 a las versiones superadas dejaba certificar «implementación conciliada» con un
    // despliegue de DV-1 sin observar.
    const admin = sqlAdmin();
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-96', 'Proyecto con vuelo pendiente', ${leadId}) returning id`;
    const proy = p!.id as string;
    for (let n = 0; n <= 7; n++) {
      const [g] = await admin`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador)
        values (${ws}, ${proy}, ${n}, ${[0, 3, 5, 6].includes(n) ? 'sponsor' : 'lead-boutique'})
        returning id`;
      await admin`insert into checklist_item
        (workspace_id, gate_id, orden, texto, estado, na_justificacion, na_aprobado_por)
        values (${ws}, ${g!.id as string}, 0, 'Ítem del test', 'na', 'fuera de alcance del test',
                ${leadId})`;
    }
    const aprobarGateCrudo = (n: number) =>
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proy} and workspace_id = ${ws} and numero = ${n}`;

    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio con releases en vuelo', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'Objetivo del vuelo', ${leadId}) returning id`;
    const journeyId = j!.id as string;

    const nuevoElemento = async (designVersionId: string, titulo: string) =>
      (
        await agregarElemento(leadId, {
          workspaceId: ws,
          designVersionId,
          tipo: 'canal',
          operacion: 'agrega',
          titulo,
          detalle: '',
          nodoId: null,
          decisionIds: [],
          insightIds: [],
        })
      ).elementoId;

    // DV-1 con dos elementos, cada uno en su release: uno se queda planificado y el otro
    // sale sin constatar. G6 firma el plan con los dos asignados.
    const primera = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La primera del servicio',
      resumen: '',
      superaA: null,
    });
    const elPlanificado = await nuevoElemento(primera.designVersionId, 'Lo que se quedó en el plan');
    const elDesplegado = await nuevoElemento(primera.designVersionId, 'Lo que salió sin constatar');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      motivo: '',
    });
    const rlPlanificado = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      titulo: 'El que no llegó a salir',
      responsable: 'Equipo de core',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elPlanificado, razon: 'dependencia externa' }],
    });
    const rlDesplegado = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      titulo: 'El que salió',
      responsable: 'Equipo de canales',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elDesplegado, razon: '' }],
    });
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rlDesplegado.releaseId,
      desplegadoEn: AYER,
    });
    for (let n = 0; n <= 6; n++) await aprobarGateCrudo(n);

    // El ciclo siguiente supera a la primera y se concilia entero.
    const segunda = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La segunda del servicio',
      resumen: '',
      superaA: primera.designVersionId,
    });
    const elSegunda = await nuevoElemento(segunda.designVersionId, 'Lo de la segunda versión');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: segunda.designVersionId,
      motivo: '',
    });
    const rlSegunda = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: segunda.designVersionId,
      titulo: 'El de la segunda',
      responsable: 'Equipo de canales',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elSegunda, razon: '' }],
    });
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rlSegunda.releaseId,
      desplegadoEn: HOY,
    });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlSegunda.releaseId,
      constatadoEn: HOY,
      resumen: '',
      constataciones: [
        { elementoId: elSegunda, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
      ],
    });
    const [estadoPrimera] = await admin`select estado from design_version
      where id = ${primera.designVersionId} and workspace_id = ${ws}`;
    expect(estadoPrimera!.estado).toBe('superada');

    // La versión VIGENTE está conciliada y su tablero no tiene huecos… y aun así G7 no
    // pasa: la superada dejó un despliegue sin observar y un plan sin cerrar.
    const tableroVigente = await tableroDeConciliacion(leadId, ws, segunda.designVersionId);
    expect(conciliacionCompleta(tableroVigente!.filas)).toBe(true);
    await expect(aprobarGateCrudo(7)).rejects.toThrow(/superada dejó releases sin resolver/);

    // Salida 1, la del despliegue: ya cambió el servicio, así que se constata. Es lo que
    // mete ese cambio en el effective state contra el que se calcula el diff siguiente.
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlDesplegado.releaseId,
      constatadoEn: AYER,
      resumen: '',
      constataciones: [
        {
          elementoId: elDesplegado,
          resultado: 'desviado',
          queQuedoDistinto: 'Salió sin el aviso al cliente',
          razon: 'El proveedor no expuso el webhook a tiempo',
        },
      ],
    });
    // Sigue bloqueado por el release que nunca salió: no basta con cerrar lo desplegado.
    await expect(aprobarGateCrudo(7)).rejects.toThrow(/superada dejó releases sin resolver/);

    // Salida 2, la del plan: «esto ya no va a salir» tiene forma en el modelo sin inventar
    // un estado de release — se le quita el alcance, y entonces la base no lo deja
    // desplegar nunca (un release sin elementos no sale, SYS-06).
    await desasignarElemento(leadId, ws, elPlanificado);
    await expect(
      desplegarRelease(leadId, {
        workspaceId: ws,
        releaseId: rlPlanificado.releaseId,
        desplegadoEn: HOY,
      }),
    ).rejects.toThrow(/sin elementos declarados no se despliega/);

    await aprobarGateCrudo(7);
    const [g7] = await admin`select estado from gate_instancia
      where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 7`;
    expect(g7!.estado).toBe('aprobado');
  });

  it('la lista de design versions se pagina y el candidato a suceder se pide por servicio', async () => {
    // Un corte duro esconde justo lo que hace falta: con más versiones de las que cabían
    // en la respuesta, la aprobada VIGENTE de un servicio podía quedar fuera, el selector
    // de «supera a» se quedaba sin opciones y el alta mandaba `superaA = null` — que
    // design_version_anclaje_guard rechaza porque sí existe una aprobada. Crear la versión
    // siguiente de ese servicio se volvía imposible.
    const admin = sqlAdmin();
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio del fondo de la lista', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'Objetivo del fondo', ${leadId}) returning id`;
    const journeyId = j!.id as string;

    const vieja = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: svcId,
      journeyId,
      titulo: 'La aprobada que se hunde en la lista',
      resumen: '',
      superaA: null,
    });
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: vieja.designVersionId,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Elemento de la que se hunde',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: vieja.designVersionId,
      motivo: '',
    });

    // Una página entera de versiones POSTERIORES la empuja fuera del primer tramo. Van
    // por SQL crudo: lo que se prueba es la lectura, y pasar por el alta real sería
    // cincuenta transacciones para el mismo fixture.
    const [ultima] = await admin`select max(substring(codigo from 4)::int) as n
      from design_version where workspace_id = ${ws}`;
    let siguienteCodigo = (ultima!.n as number) + 1;
    for (let i = 0; i < PAGINA_DESIGN_VERSIONS + 1; i++) {
      await admin`insert into design_version
        (workspace_id, proyecto_id, servicio_id, journey_id, codigo, titulo, creado_por)
        values (${ws}, ${proyectoId}, ${servicioId}, ${toBeId},
                ${'DV-' + siguienteCodigo}, ${'Relleno ' + i}, ${leadId})`;
      siguienteCodigo += 1;
    }

    const primera = await designVersionsDelWorkspace(leadId, ws);
    expect(primera.versiones).toHaveLength(PAGINA_DESIGN_VERSIONS);
    expect(primera.siguiente).not.toBeNull();
    // La aprobada del servicio NO está en la primera página: es exactamente el caso que
    // dejaba el formulario sin candidato.
    expect(primera.versiones.map((v) => v.id)).not.toContain(vieja.designVersionId);

    // El cursor la alcanza: paginar no la esconde, la pone detrás.
    const vistas: string[] = primera.versiones.map((v) => v.id);
    let cursor = primera.siguiente;
    let vueltas = 0;
    while (cursor !== null && vueltas < 20) {
      const pagina = await designVersionsDelWorkspace(leadId, ws, cursor);
      vistas.push(...pagina.versiones.map((v) => v.id));
      cursor = pagina.siguiente;
      vueltas += 1;
    }
    expect(vistas).toContain(vieja.designVersionId);
    // Keyset limpio: ninguna fila repetida entre páginas.
    expect(new Set(vistas).size).toBe(vistas.length);

    // Y el selector no depende de nada de eso: pregunta por el servicio y SYS-05 garantiza
    // que la respuesta es cero o una.
    const vigente = await versionAprobadaDelServicio(leadId, ws, svcId);
    expect(vigente).toMatchObject({ id: vieja.designVersionId });
    // Y un servicio sin versiones responde «ninguna», que es lo que hace que el selector
    // ofrezca «no supera a ninguna (primera del servicio)» sin adivinarlo.
    const [virgen] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio sin design versions', ${leadId}) returning id`;
    expect(await versionAprobadaDelServicio(leadId, ws, virgen!.id as string)).toBeNull();

    // Con el candidato en la mano, la versión siguiente del servicio se crea: el guard de
    // anclaje la acepta porque declara a cuál supera.
    const sucesora = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: svcId,
      journeyId,
      titulo: 'La siguiente del servicio del fondo',
      resumen: '',
      superaA: vigente!.id,
    });
    expect(sucesora.designVersionId).toBeTruthy();
  });

  it('una transición legal no es un salvoconducto: cada una congela lo que no le toca', async () => {
    // La clase entera, no tres casos sueltos. Toda transición de este slice es un UPDATE
    // sobre una fila con columnas en el grant, y su política solo mira el PAR DE ESTADOS.
    // Como la transición es LEGAL, el rechazo de «mismo estado» ni siquiera llega, y la
    // sentencia entra con toda la carga extra que quiera: el que decide qué queda
    // congelado tiene que ser el guard, que es la máquina de estados.
    const admin = sqlAdmin();
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio de las columnas congeladas', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'To-be de las columnas congeladas', ${leadId})
      returning id`;
    const journeyId = j!.id as string;

    const crearConElemento = async (titulo: string, superaA: string | null) => {
      const dv = await crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId,
        servicioId: svcId,
        journeyId,
        titulo,
        resumen: '',
        superaA,
      });
      await agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dv.designVersionId,
        tipo: 'canal',
        operacion: 'agrega',
        titulo: `Elemento de ${titulo}`,
        detalle: '',
        nodoId: null,
        decisionIds: [],
        insightIds: [],
      });
      return dv.designVersionId;
    };

    const dvA = await crearConElemento('DV congelada A', null);
    await aprobarDesignVersion(leadId, { workspaceId: ws, designVersionId: dvA, motivo: '' });
    const snapshotA = (await designVersionCompleta(leadId, ws, dvA))!.snapshotId!;
    expect(snapshotA).toBeTruthy();

    // ── 1. BORRADOR: los sellos no se ponen a mano ────────────────────────────────────
    // `snapshot_id` y `aprobada_por` están en el grant porque los escribe la aprobación, y
    // sobre un borrador hay UPDATEs legítimos (enlazar journey, declarar sucesión) que
    // ninguna política acota columna a columna. El ataque sería sembrar el snapshot de una
    // aprobación ANTERIOR del mismo grafo: al aprobar, la política solo exige que el
    // snapshot sea de su journey —no que se acabe de tomar—, así que la versión se
    // congelaría sobre un to-be viejo, certificando un diseño distinto del que aprobó.
    //
    // No hace falta regla nueva en el guard: lo para el CHECK de la tabla, que exige los
    // tres sellos nulos mientras el estado es borrador. Se fija aquí porque es la pieza
    // que sostiene ese hueco, y quien la quite tiene que ver caer este test — un CHECK no
    // se empareja entre políticas ni se cuela con una transición legal, así que es el
    // sitio más fuerte donde podía estar.
    const dvB = await crearConElemento('DV congelada B', dvA);
    await expect(
      conUsuario(leadId, (tx) => tx`update design_version set snapshot_id = ${snapshotA}
        where id = ${dvB} and workspace_id = ${ws}`),
    ).rejects.toThrow(/violates check constraint/);
    await expect(
      conUsuario(leadId, (tx) => tx`update design_version set aprobada_por = ${leadId}
        where id = ${dvB} and workspace_id = ${ws}`),
    ).rejects.toThrow(/violates check constraint/);
    // Y lo que SÍ se corrige en borrador sigue corrigiéndose: el guard no cierra la puerta
    // que la rama abrió, solo la de los sellos.
    await enlazarJourney(leadId, { workspaceId: ws, designVersionId: dvB, journeyId });
    expect((await designVersionCompleta(leadId, ws, dvB))!.snapshotId).toBeNull();

    // ── 2. aprobada → superada: solo cambia el estado ─────────────────────────────────
    // La transición es legal, así que ni el rechazo de «mismo estado» ni los otros dos
    // guards (que se apartan cuando la fila ya no es borrador) miran nada. Sin esto, la
    // misma sentencia que supera reescribía el snapshot que contesta «qué pasos afectó
    // RL-1» (§19.7) y la cadena de SYS-05.
    // Los valores de la carga son VÁLIDOS uno a uno: otro snapshot real, otro journey
    // real, otro usuario, otra versión. Anularlos habría caído en el CHECK de sellos («no
    // borrador ⇒ los tres no nulos») sin llegar nunca al guard, y el test habría pasado
    // sin probarlo. Repuntar es además el ataque de verdad: dejar la fila coherente pero
    // diciendo que aprobó otra cosa.
    const [otroSvc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio del snapshot ajeno', ${leadId}) returning id`;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${otroSvc!.id as string}, ${ws}, ${leadId})`;
    const [otroJ] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${otroSvc!.id as string}, 'to-be', 'To-be ajeno', ${leadId}) returning id`;
    const otroJourney = otroJ!.id as string;
    const dvAjena = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: otroSvc!.id as string,
      journeyId: otroJourney,
      titulo: 'DV del snapshot ajeno',
      resumen: '',
      superaA: null,
    });
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dvAjena.designVersionId,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Elemento ajeno',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dvAjena.designVersionId,
      motivo: '',
    });
    const snapshotAjeno = (await designVersionCompleta(leadId, ws, dvAjena.designVersionId))!
      .snapshotId!;

    // Una a una y como LEAD autenticado, que es quien tiene la política de supersión: lo
    // que se prueba es que el guard las para, no que la RLS no llegue.
    const superarCon = (columna: string, valor: string) =>
      conUsuario(leadId, (tx) => tx`update design_version
        set estado = 'superada', ${tx.unsafe(columna)} = ${valor}
        where id = ${dvA} and workspace_id = ${ws}`);
    for (const [columna, valor] of [
      ['snapshot_id', snapshotAjeno],
      ['journey_id', otroJourney],
      ['aprobada_por', disId],
      ['supera_a', dvB],
    ] as [string, string][]) {
      await expect(superarCon(columna, valor)).rejects.toThrow(/solo cambia su estado/);
    }
    // Y la supersión de verdad —la que hace la aprobación de la sucesora, en la misma
    // transacción— sigue pasando y deja intacto lo que aquella versión aprobó.
    await aprobarDesignVersion(leadId, { workspaceId: ws, designVersionId: dvB, motivo: '' });
    const superada = await designVersionCompleta(leadId, ws, dvA);
    expect(superada!.estado).toBe('superada');
    expect(superada!.snapshotId).toBe(snapshotA);

    // ── 3. desplegado → verificado: la fecha real de lo que pasó no se reescribe ───────
    const elB = (await designVersionCompleta(leadId, ws, dvB))!.elementos[0]!.id;
    const plan = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvB,
      titulo: 'Release de la fecha congelada',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elB, razon: '' }],
    });
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: plan.releaseId,
      desplegadoEn: AYER,
    });
    // La comprobación va ANTES que la de «constatar todos los elementos» a propósito: si
    // fuera después, sobre un release ya constatado por completo la fecha se colaría. Y
    // por aquí entraba incluso una fecha FUTURA, porque el «no futura» vive en la rama de
    // desplegado y esta transición no pasa por ella.
    for (const fecha of [HOY, dia(30)]) {
      await expect(
        conUsuario(leadId, (tx) => tx`update release
          set estado = 'verificado', desplegado_en = ${fecha}::date
          where id = ${plan.releaseId} and workspace_id = ${ws}`),
      ).rejects.toThrow(/no reescribe la fecha real del despliegue/);
    }
    const trasIntentos = await designVersionCompleta(leadId, ws, dvB);
    const rel = trasIntentos!.releases.find((r) => r.id === plan.releaseId)!;
    expect(rel.estado).toBe('desplegado');
    expect(rel.desplegadoEn).toBe(AYER);
  });

  it('planificar y ampliar el alcance esperan a la supersión; quitarlo no', async () => {
    // La política del release y la del alcance exigen la design version APROBADA, pero una
    // política es un predicado sobre un snapshot: mientras la aprobación de la sucesora
    // —que marca `superada` a la actual— sigue sin commitear, la vieja todavía parece
    // aprobada. Y la FK NO serializa: insertar el release toma FOR KEY SHARE sobre la fila
    // de la design version y la supersión solo cambia una columna no-clave (FOR NO KEY
    // UPDATE), y esos dos modos no entran en conflicto. Las dos commitean y queda trabajo
    // nuevo colgado de un diseño superado — que desde el arreglo de G7 BLOQUEA el gate.
    const admin = sqlAdmin();
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio de la supersión en vuelo', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'To-be de la supersión en vuelo', ${leadId})
      returning id`;
    const journeyId = j!.id as string;

    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: svcId,
      journeyId,
      titulo: 'La que va a ser superada en vuelo',
      resumen: '',
      superaA: null,
    });
    const elUno = (
      await agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dv.designVersionId,
        tipo: 'canal',
        operacion: 'agrega',
        titulo: 'Elemento que ya está en el release',
        detalle: '',
        nodoId: null,
        decisionIds: [],
        insightIds: [],
      })
    ).elementoId;
    const elDos = (
      await agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dv.designVersionId,
        tipo: 'canal',
        operacion: 'agrega',
        titulo: 'Elemento que llega tarde',
        detalle: '',
        nodoId: null,
        decisionIds: [],
        insightIds: [],
      })
    ).elementoId;
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    const yaPlanificado = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      titulo: 'Release que ya existía',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elUno, razon: '' }],
    });

    // Transacción A: toma el candado del SERVICIO —el mismo que toman aprobar y los dos
    // caminos del alcance— y supera la versión, y queda abierta. Avisa al TENER el
    // candado: sin ese aviso el test podría pasar por el intercalado contrario, en el que
    // los contendientes llegan primero, y eso no prueba nada.
    let listo!: () => void;
    const tomado = new Promise<void>((r) => (listo = r));
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const supersion = conUsuario(leadId, async (tx) => {
      await tx`select pg_advisory_xact_lock(
        hashtextextended('designio:design-version:' || ${svcId}, 42))`;
      await tx`update design_version set estado = 'superada'
        where id = ${dv.designVersionId} and workspace_id = ${ws}`;
      listo();
      await espera;
    });
    await tomado;

    // Los dos caminos que AÑADEN trabajo esperan: planificar un release nuevo y meter un
    // elemento en el que ya estaba planificado.
    const planNuevo = planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      titulo: 'Release colado en plena supersión',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elDos, razon: '' }],
    });
    const alcanceTardio = asignarElemento(leadId, {
      workspaceId: ws,
      releaseId: yaPlanificado.releaseId,
      elementoId: elDos,
      razon: 'llega tarde',
    });
    try {
      expect(await siguePendiente(planNuevo)).toBe(true);
      expect(await siguePendiente(alcanceTardio)).toBe(true);
    } finally {
      liberar();
    }
    await supersion;
    // Al soltar, los dos releen el estado real y los dos se niegan.
    await expect(planNuevo).rejects.toThrow(ErrorEntrega);
    await expect(alcanceTardio).rejects.toThrow(ErrorEntrega);

    const trasCarrera = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(trasCarrera!.estado).toBe('superada');
    expect(trasCarrera!.releases).toHaveLength(1);
    expect(
      trasCarrera!.releases[0]!.elementos.map((e) => e.elementoId),
    ).toEqual([elUno]);

    // Y la asimetría que sostiene a G7: QUITAR alcance sigue permitido sobre una versión
    // superada. Es la salida que el gate le deja al lead para cerrar lo que quedó en vuelo
    // («esto ya no va a salir»); exigir aquí la versión aprobada dejaría ese release sin
    // forma de cerrarse y G7 bloqueado para siempre.
    await desasignarElemento(leadId, ws, elUno);
    const trasVaciar = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(trasVaciar!.releases[0]!.elementos).toHaveLength(0);
  });

  it('un effective state no se registra a medias: nadie podría terminarlo después', async () => {
    // La atomicidad de «effective state + constataciones + verificar» vivía SOLO en
    // `constatarEffectiveState`, y el grant es una superficie, no un camino: la política
    // de effective_state autoriza el primer paso a solas —lead, release desplegado— y
    // nadie exigía los otros dos. El agravante es `unique (release_id)`: la fila a medias
    // no es media escritura, es una que NADIE puede terminar ni sustituir, porque el
    // reintento por el camino normal choca contra la unique y el release se queda
    // desplegado para siempre, con G7 bloqueado y sin salida desde la pantalla.
    const admin = sqlAdmin();
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio del effective state a medias', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'To-be del effective state a medias', ${leadId})
      returning id`;
    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId,
      servicioId: svcId,
      journeyId: j!.id as string,
      titulo: 'La que se constata entera o nada',
      resumen: '',
      superaA: null,
    });
    const elementos: string[] = [];
    for (const titulo of ['Primer elemento del release', 'Segundo elemento del release']) {
      elementos.push(
        (
          await agregarElemento(leadId, {
            workspaceId: ws,
            designVersionId: dv.designVersionId,
            tipo: 'canal',
            operacion: 'agrega',
            titulo,
            detalle: '',
            nodoId: null,
            decisionIds: [],
            insightIds: [],
          })
        ).elementoId,
      );
    }
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    const plan = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      titulo: 'Release que se constata entero',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: elementos.map((elementoId) => ({ elementoId, razon: '' })),
    });
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: plan.releaseId,
      desplegadoEn: AYER,
    });

    // El insert suelto que la política autoriza. Falla en el COMMIT, no en la sentencia:
    // es un constraint trigger diferido, porque en el instante del insert las
    // constataciones aún no existen ni pueden existir.
    const insertarES = (codigo: string) =>
      conUsuario(leadId, async (tx) => {
        const [es] = await tx`insert into effective_state
          (workspace_id, servicio_id, release_id, codigo, resumen, constatado_por, constatado_en)
          values (${ws}, ${svcId}, ${plan.releaseId}, ${codigo}, '', ${leadId}, ${HOY}::date)
          returning id`;
        return es!.id as string;
      });
    await expect(insertarES('ES-9001')).rejects.toThrow(/CADA elemento de su release/);

    // Y a medias tampoco: una constatación de dos no es una conciliación, es la mitad que
    // conviene. Aquí el primer elemento sí entra, así que lo que se prueba es el conjunto.
    await expect(
      conUsuario(leadId, async (tx) => {
        const [es] = await tx`insert into effective_state
          (workspace_id, servicio_id, release_id, codigo, resumen, constatado_por, constatado_en)
          values (${ws}, ${svcId}, ${plan.releaseId}, 'ES-9002', '', ${leadId}, ${HOY}::date)
          returning id`;
        await tx`insert into constatacion
          (workspace_id, effective_state_id, elemento_id, resultado, creado_por)
          values (${ws}, ${es!.id as string}, ${elementos[0]!}, 'como-aprobado', ${leadId})`;
      }),
    ).rejects.toThrow(/CADA elemento de su release/);

    // Lo que importa del arreglo tanto como el rechazo: la salida sigue abierta. Los dos
    // intentos revirtieron enteros, así que `unique (release_id)` está libre y el camino
    // normal termina el trabajo. Cerrar la puerta no deja al release sin forma de cerrarse
    // — que es justo lo que habría pasado si la fila a medias hubiera llegado a existir.
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: plan.releaseId,
      constatadoEn: HOY,
      resumen: 'Los dos salieron como se aprobaron',
      constataciones: elementos.map((elementoId) => ({
        elementoId,
        resultado: 'como-aprobado' as const,
        queQuedoDistinto: '',
        razon: '',
      })),
    });
    const completa = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(completa!.releases.find((r) => r.id === plan.releaseId)!.estado).toBe('verificado');
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
