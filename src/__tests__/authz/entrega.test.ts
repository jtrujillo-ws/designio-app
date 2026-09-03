import { readFileSync } from 'node:fs';
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
  moverElemento,
  ErrorEntrega,
  PAGINA_DESIGN_VERSIONS,
  planificarRelease,
  proyectosCertificados,
  tableroDeConciliacion,
  versionAprobadaDelServicio,
} from '@/lib/entrega/entrega.servicio';
import { calcularDiff, conciliacionCompleta, plegarEstadoVigente } from '@/lib/entrega/entrega.diff';
import {
  AgregarElementoSchema,
  ConstatarSchema,
  DesplegarReleaseSchema,
  MAXIMO_MOTIVOS_POR_ELEMENTO,
  PlanificarReleaseSchema,
} from '@/lib/entrega/entrega.schemas';
import { aprobarGate, ErrorMetodo } from '@/lib/metodo/metodo.servicio';
import { revalidarDecision } from '@/lib/metodo/gobernanza.servicio';
import { abrirHilo, hilosDeObjetos } from '@/lib/portal/portal.servicio';
import { borrarNodo, journeysDelWorkspace } from '@/lib/journey/journey.servicio';
import { arbolParaUsuario } from '@/lib/arbol/arbol.queries';
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
//
// Y se componen en UTC (`toISOString`), así que las escrituras declaran `desfaseUtcMinutos: 0`:
// el guard juzga «no futura» en el calendario que le declaran (ver hoy_del_cliente en la
// migración), y un test que compone en UTC tiene que decir que escribe en UTC. El test del
// calendario, más abajo, es el que ejercita los husos de verdad.
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
  // G0, G3, G5 y G6 los aprueba el SPONSOR (lo fija un CHECK de gate_instancia, y la
  // política exige que el rol del que aprueba sea ese). Sin este miembro, las carreras de
  // G6 tendrían que montarse con SQL de administrador y dejarían de probar el camino real.
  let sponsorId = '';
  let servicioId = '';
  let otroServicioId = '';
  let retoId = '';
  let proyectoId = '';
  let otroProyectoId = '';
  /**
   * P-90 (`proyectoId`) es el proyecto del recorrido completo y acaba CERTIFICADO: el test
   * de G7 le aprueba la escalera entera. Desde ese momento no vuelve a aprobar design
   * versions —lo prohíbe `gate_certificado_del_proyecto`, porque G6 y G7 afirman algo sobre
   * el conjunto de sus versiones aprobadas y ese 'aprobado' no se reevalúa (SPEC-04)—, así
   * que todo lo que viene después trabaja sobre P-93. No es un apaño del test: es
   * exactamente la salida que la regla deja, el ciclo siguiente en otro proyecto.
   */
  let proyectoAbierto = '';
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
      ['sponsor', 'sponsor'],
    ] as const) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
      else if (alias === 'dis') disId = id;
      else if (alias === 'sponsor') sponsorId = id;
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
    const [p3] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-93', 'Ciclo siguiente, sin certificar', ${leadId}) returning id`;
    proyectoAbierto = p3!.id as string;

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
        desfaseUtcMinutos: 0,
      }),
    ).rejects.toThrow(/sin elementos declarados/);

    await expect(
      desplegarRelease(leadId, { workspaceId: ws, releaseId: rl1, desplegadoEn: dia(30), desfaseUtcMinutos: 0 }),
    ).rejects.toThrow(/no puede ser futura/);

    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rl1,
      desplegadoEn: AYER,
      desfaseUtcMinutos: 0,
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
        desfaseUtcMinutos: 0,
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
        desfaseUtcMinutos: 0,
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
      desfaseUtcMinutos: 0,
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
      desfaseUtcMinutos: 0,
    });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rl2,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
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
        proyectoId: proyectoAbierto,
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
      values (${ws}, ${servicioId}, ${retoId}, ${proyectoAbierto}, 'to-be', 'Apertura objetivo v2',
              ${leadId}) returning id`;
    const toBe2 = jt2!.id as string;
    const [n4] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, catalogo_id, creado_por)
      values (${ws}, ${toBe2}, 'touchpoint', 'Video-verificación', ${catVideo}, ${leadId})
      returning id`;

    const nueva = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyectoAbierto,
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

  it('que otro proyecto le supere la versión no deja al proyecto sin poder certificar', async () => {
    // El gate pregunta por el trabajo DEL PROYECTO; la supersión dice cuál es la versión
    // vigente PARA EL SERVICIO. Son dos preguntas distintas y durante un tiempo las
    // contestaba el mismo filtro (`estado = 'aprobada'`): en cuanto otro proyecto superaba
    // la versión de este —flujo soportado, y la salida que la regla del proyecto
    // certificado ofrece—, sus propios gates dejaban de ver su único trabajo y el proyecto
    // se volvía INCERTIFICABLE, sin que abrir otra versión arreglara nada (solo trasladaba
    // el bloqueo). Ahora el conjunto es «de qué responde este proyecto», del que solo sale
    // lo que el propio proyecto reemplazó.
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
      proyectoId: proyectoAbierto,
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

    // Y G7 lo rechaza, pero por el motivo BUENO: su elemento sigue en un release
    // planificado, o sea en estado desconocido. Antes lo rechazaba diciendo que no había
    // tablero —y no había forma de que lo hubiera nunca—.
    const aprobarG7 = () =>
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 7`;
    await expect(aprobarG7()).rejects.toThrow(/en estado desconocido/);

    // La salida es la del método, no una excepción: se cierra el trabajo propio con
    // honestidad. 'no-implementado' es una respuesta CONOCIDA (el gate exige honestidad, no
    // perfección), y con ella el proyecto certifica lo suyo aunque el servicio haya seguido
    // sin él.
    const [rl] = await admin`select id from release
      where design_version_id = ${propia.designVersionId} and workspace_id = ${ws}`;
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rl!.id as string,
      desplegadoEn: HOY,
      desfaseUtcMinutos: 0,
    });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rl!.id as string,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: '',
      constataciones: [
        {
          elementoId: suyo.elementoId,
          resultado: 'no-implementado',
          queQuedoDistinto: 'El ciclo pasó a otro proyecto antes de salir',
          razon: 'La versión se superó desde el proyecto siguiente',
        },
      ],
    });
    await aprobarG7();
    const [g7] = await admin`select estado from gate_instancia
      where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 7`;
    expect(g7!.estado).toBe('aprobado');
  });

  it('un tablero sin filas no está completo: está vacío (RF-06.7)', async () => {
    // La defensa del gemelo vacuo sigue en pie, y ahora solo la alcanza lo que su comentario
    // nombra: un backfill que deje una design version sin elementos. Por el camino normal ya
    // no se llega —la transición no aprueba una versión sin elementos y G6 exige el mismo
    // conjunto que G7—, y por eso se monta con SQL de administrador: sin este test, quitar
    // la comprobación no rompería nada.
    const admin = sqlAdmin();
    const proy = await proyectoConGates('P-104', 'Proyecto al que le vacían el tablero');
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del tablero vacío');
    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La que se queda sin elementos',
      resumen: '',
      superaA: null,
    });
    const el = await elementoSuelto(dv.designVersionId, 'Elemento que después no estará');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      titulo: 'Plan que se firma',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: el, razon: '' }],
    });
    await aprobarGatesHasta(proy, 6);

    await admin`delete from release_elemento where elemento_id = ${el} and workspace_id = ${ws}`;
    await admin`delete from elemento_cambio where id = ${el} and workspace_id = ${ws}`;
    await expect(
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 7`,
    ).rejects.toThrow(/ninguna design version con elementos que conciliar/);
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
        proyectoId: proyectoAbierto,
        servicioId: otroServicioId,
        journeyId: toBeId,
        titulo: 'Con el journey de otro servicio',
        resumen: '',
        superaA: null,
      }),
    ).rejects.toThrow(/to-be de su servicio/);

    const suelta = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyectoAbierto,
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
      proyectoId: proyectoAbierto,
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
      proyectoId: proyectoAbierto,
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
      proyectoId: proyectoAbierto,
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
      desfaseUtcMinutos: 0,
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
        proyectoId: proyectoAbierto,
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
      proyectoId: proyectoAbierto,
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
        proyectoId: proyectoAbierto,
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
      desfaseUtcMinutos: 0,
    });
    // Una foto de lo que quedó funcionando no puede ser anterior al día en que salió: no
    // describiría este release. Y como el pliegue del estado vigente ORDENA por
    // constatado_en, la fecha inválida además reordenaría la historia del servicio.
    await expect(
      constatarEffectiveState(leadId, {
        workspaceId: ws,
        releaseId: plan.releaseId,
        constatadoEn: dia(-10),
        desfaseUtcMinutos: 0,
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
      desfaseUtcMinutos: 0,
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
      proyectoId: proyectoAbierto,
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
      /ninguna design version con elementos que planificar/,
    );
    // Y por el camino de la app llega el MISMO motivo, no un fallo genérico: el porqué es
    // el producto de este guard, y sin traducir el P0001 la pantalla no lo enseñaba.
    const [g6Crudo] = await admin`select id from gate_instancia
      where proyecto_id = ${proyG6} and workspace_id = ${ws} and numero = 6`;
    const fallo = await aprobarGate(sponsorId, {
      workspaceId: ws,
      gateId: g6Crudo!.id as string,
    }).catch((e: unknown) => e);
    // Del TIPO depende que la pantalla lo enseñe: el mapeador de las server functions
    // devuelve el mensaje de un ErrorMetodo y deja escapar cualquier otro como fallo
    // genérico. Que el texto coincida no basta si llega como error de Postgres.
    expect(fallo).toBeInstanceOf(ErrorMetodo);
    expect((fallo as Error).message).toMatch(/ninguna design version con elementos que planificar/);

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

    // ── Y lo que G6 certificó sigue siendo cierto ────────────────────────────────────
    // La aprobación de un gate es inmutable y la reapertura de etapa NO la deshace, así
    // que si se le quita el release a un elemento cubierto, el gate se queda diciendo algo
    // falso y no hay ningún camino por el que vuelva a evaluarse.
    await expect(
      desasignarElemento(leadId, ws, dos.elementoId),
    ).rejects.toThrow(/muévelo a otro release/);
    const trasIntento = await designVersionCompleta(leadId, ws, dvPlan.designVersionId);
    expect(
      trasIntento!.releases.find((r) => r.id === plan.releaseId)!.elementos,
    ).toHaveLength(2);

    // Pero REORDENAR el plan sigue siendo posible, que es lo que impide que el arreglo se
    // convierta en una puerta cerrada para siempre: mover es borrar y volver a insertar en
    // la MISMA transacción, y la invariante se comprueba al commit, no entre sentencias.
    const segundo = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvPlan.designVersionId,
      titulo: 'Segunda tanda del plan',
      responsable: 'Equipo del plan',
      fechaObjetivo: HOY,
      elementos: [],
    });
    // `moverElemento` y no `asignarElemento`: asignar sigue significando «no tenía
    // release», y que un segundo asignar se rechace es como se expresa el «exactamente
    // uno» de SYS-06 (hay test). Mover es una operación propia.
    await expect(
      asignarElemento(leadId, {
        workspaceId: ws,
        releaseId: segundo.releaseId,
        elementoId: dos.elementoId,
        razon: '',
      }),
    ).rejects.toThrow(/exactamente uno/);
    await moverElemento(leadId, {
      workspaceId: ws,
      releaseId: segundo.releaseId,
      elementoId: dos.elementoId,
      razon: 'se mueve a la segunda tanda',
    });
    const trasMover = await designVersionCompleta(leadId, ws, dvPlan.designVersionId);
    expect(
      trasMover!.releases.find((r) => r.id === plan.releaseId)!.elementos.map((e) => e.elementoId),
    ).toEqual([uno.elementoId]);
    expect(
      trasMover!.releases.find((r) => r.id === segundo.releaseId)!.elementos.map((e) => e.elementoId),
    ).toEqual([dos.elementoId]);
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
        proyectoId: proyectoAbierto,
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
      proyectoId: proyectoAbierto,
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
      desfaseUtcMinutos: 0,
    });

    // El ciclo siguiente supera a la primera y se concilia entero. Ocurre ANTES de firmar
    // la escalera de gates y no es un detalle de orden: un proyecto que ya certificó G6 o
    // G7 no aprueba design versions nuevas —volverían falso lo que el gate afirma sobre el
    // conjunto de sus versiones aprobadas, y esa aprobación no se deshace (SPEC-04)—. Es
    // también el orden que describe RF-06.3: la design version se aprueba en la ventana
    // G5/G6 y G6 firma DESPUÉS el plan que la cubre.
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
      desfaseUtcMinutos: 0,
    });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlSegunda.releaseId,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: '',
      constataciones: [
        { elementoId: elSegunda, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
      ],
    });
    // Ahora sí la escalera: G6 firma un plan donde cada elemento de la versión VIGENTE
    // —la segunda— tiene release. Los de la superada son historia de un ciclo anterior y
    // el gate no los mira; lo que sí sigue abierto son sus releases, y eso es lo que G7
    // tiene que ver más abajo.
    for (let n = 0; n <= 6; n++) await aprobarGateCrudo(n);

    const [estadoPrimera] = await admin`select estado from design_version
      where id = ${primera.designVersionId} and workspace_id = ${ws}`;
    expect(estadoPrimera!.estado).toBe('superada');

    // La versión VIGENTE está conciliada y su tablero no tiene huecos… y aun así G7 no
    // pasa: la superada dejó un despliegue sin observar y un plan sin cerrar.
    const tableroVigente = await tableroDeConciliacion(leadId, ws, segunda.designVersionId);
    expect(conciliacionCompleta(tableroVigente!.filas)).toBe(true);
    await expect(aprobarGateCrudo(7)).rejects.toThrow(/superada dejó releases sin resolver/);
    // Y la pantalla dice LO MISMO que el gate, no lo que deduzca del tablero de esta
    // versión: su tablero está completo y aun así el proyecto está bloqueado, por la que se
    // superó a sí mismo. Cuando el espejo se escribía a mano, este caso salía como «no
    // bloquea» y mandaba al lead a mirar donde no era.
    const vistaBloqueada = await designVersionCompleta(leadId, ws, segunda.designVersionId);
    expect(vistaBloqueada!.bloqueoDeG7).toMatch(/superada dejó releases sin resolver/);

    // Salida 1, la del despliegue: ya cambió el servicio, así que se constata. Es lo que
    // mete ese cambio en el effective state contra el que se calcula el diff siguiente.
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlDesplegado.releaseId,
      constatadoEn: AYER,
      desfaseUtcMinutos: 0,
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
        desfaseUtcMinutos: 0,
      }),
    ).rejects.toThrow(/sin elementos declarados no se despliega/);

    const vistaLibre = await designVersionCompleta(leadId, ws, segunda.designVersionId);
    expect(vistaLibre!.bloqueoDeG7).toBeNull();
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
      proyectoId: proyectoAbierto,
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
      proyectoId: proyectoAbierto,
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
        proyectoId: proyectoAbierto,
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
    // Esta variante —sembrar el sello en una sentencia y aprobar en otra— la para el
    // CHECK de la tabla, que exige los tres sellos nulos mientras el estado es borrador.
    // OJO: eso es TODO lo que para. Un CHECK se evalúa sobre la fila resultante, así que
    // sobre una aprobación (estado ya 'aprobada') no dice nada; el ataque en UNA sentencia
    // lo cubre `design_version_transicion_guard` exigiendo que el snapshot se tome en la
    // propia transición, y tiene su test aparte. Los dos hacen falta y prueban cosas
    // distintas: confundirlos me costó borrar una vez la regla del guard.
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
      proyectoId: proyectoAbierto,
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
      desfaseUtcMinutos: 0,
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
      proyectoId: proyectoAbierto,
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
    // La sucesora que la va a reemplazar, en borrador y con su elemento: sin ella la
    // supersión de abajo no sería la de verdad.
    const sucesora = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyectoAbierto,
      servicioId: svcId,
      journeyId,
      titulo: 'La que la reemplaza en vuelo',
      resumen: '',
      superaA: dv.designVersionId,
    });
    const sucesoraEnVuelo = sucesora.designVersionId;
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: sucesoraEnVuelo,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Elemento de la sucesora',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
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
      // La supersión ENTERA, que es lo que esta transacción dice simular: aprobar la
      // sucesora marca superada a la anterior y aprueba la nueva en la MISMA transacción.
      // Se escribe a mano —y no llamando a `aprobarDesignVersion`— porque hay que dejarla
      // abierta a mitad, que es justo lo que el servicio no permite. Marcar superada a
      // secas ya no vale: sin sucesora aprobada al commit, el constraint diferido lo
      // rechaza, y con razón.
      await tx`update design_version set estado = 'superada'
        where id = ${dv.designVersionId} and workspace_id = ${ws}`;
      const [snap] = await tx`insert into journey_snapshot
        (workspace_id, journey_id, motivo, grafo, congelado_por)
        values (${ws}, ${journeyId}, 'sucesión en vuelo',
                jsonb_build_object('nodos', '[]'::jsonb, 'aristas', '[]'::jsonb,
                                   'evidencias', '[]'::jsonb),
                ${leadId})
        returning id`;
      await tx`update design_version
        set estado = 'aprobada', aprobada_por = ${leadId}, snapshot_id = ${snap!.id as string}
        where id = ${sucesoraEnVuelo} and workspace_id = ${ws}`;
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
    expect(trasCarrera!.superadaPor!.id).toBe(sucesoraEnVuelo);
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
      proyectoId: proyectoAbierto,
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
      desfaseUtcMinutos: 0,
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

    // Y el caso que parecía a salvo: TODAS las constataciones puestas, pero el release
    // sin verificar. El callejón es idéntico —la unique rechaza el reintento y no hay
    // forma de retomar—, así que la invariante tiene que nombrar la operación entera y no
    // solo su parte más visible. Que las constataciones estén completas no es el final de
    // constatar: verificar el release lo es.
    await expect(
      conUsuario(leadId, async (tx) => {
        const [es] = await tx`insert into effective_state
          (workspace_id, servicio_id, release_id, codigo, resumen, constatado_por, constatado_en)
          values (${ws}, ${svcId}, ${plan.releaseId}, 'ES-9003', '', ${leadId}, ${HOY}::date)
          returning id`;
        for (const elementoId of elementos) {
          await tx`insert into constatacion
            (workspace_id, effective_state_id, elemento_id, resultado, creado_por)
            values (${ws}, ${es!.id as string}, ${elementoId}, 'como-aprobado', ${leadId})`;
        }
      }),
    ).rejects.toThrow(/termina verificando el release/);

    // Lo que importa del arreglo tanto como el rechazo: la salida sigue abierta. Los dos
    // intentos revirtieron enteros, así que `unique (release_id)` está libre y el camino
    // normal termina el trabajo. Cerrar la puerta no deja al release sin forma de cerrarse
    // — que es justo lo que habría pasado si la fila a medias hubiera llegado a existir.
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: plan.releaseId,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
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

  it('aprobar congela el to-be de AHORA: un snapshot de antes no vale (RF-06.3)', async () => {
    // El CHECK «borrador ⇒ los tres sellos nulos» NO cubre esto, y creerlo fue un error
    // propio que este test existe para no repetir: un CHECK se evalúa sobre la fila
    // RESULTANTE, y la de una aprobación ya tiene `estado = 'aprobada'`, así que ese CHECK
    // ni se mira. Solo restringe a las filas que SIGUEN siendo borrador — o sea, sembrar
    // el sello en DOS sentencias. El ataque de verdad va en UNA: aprobar y apuntar de paso
    // a un snapshot viejo del mismo journey. Ahí el CHECK pasa, la política pasa (su
    // `with check` solo exige que el snapshot sea de ese journey, nada sobre cuándo se
    // tomó) y la versión queda inmutable certificando un grafo que no es el to-be vigente.
    const admin = sqlAdmin();
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, 'Servicio del snapshot rancio', ${leadId}) returning id`;
    const svcId = svc!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', 'To-be que sigue cambiando', ${leadId}) returning id`;
    const journeyId = j!.id as string;
    // Un snapshot ANTERIOR del mismo journey. En producción lo deja cualquier congelación
    // previa de ese grafo; aquí se pone a mano porque lo que se prueba es qué acepta la
    // transición, no cómo llegó a existir.
    const [viejo] = await admin`insert into journey_snapshot
      (workspace_id, journey_id, motivo, grafo, congelado_por)
      values (${ws}, ${journeyId}, 'de un ciclo anterior',
              ${admin.json({ nodos: [], aristas: [] })}, ${leadId}) returning id`;
    const snapshotViejo = viejo!.id as string;

    // Primera del servicio, así que `supera_a` es null y la cadena de SYS-05 no interfiere:
    // lo único que puede rechazar el UPDATE de abajo es la frescura del snapshot.
    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyectoAbierto,
      servicioId: svcId,
      journeyId,
      titulo: 'La que intenta congelar un grafo viejo',
      resumen: '',
      superaA: null,
    });
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Elemento sin nodo',
      detalle: '',
      nodoId: null,
      decisionIds: [],
      insightIds: [],
    });

    // EL ATAQUE, en una sola sentencia. Separarlo en dos lo pararía el CHECK y el test
    // mentiría: hay que dejarlo así.
    await expect(
      conUsuario(leadId, (tx) => tx`update design_version
        set estado = 'aprobada', aprobada_por = ${leadId}, snapshot_id = ${snapshotViejo}
        where id = ${dv.designVersionId} and workspace_id = ${ws}`),
    ).rejects.toThrow(/snapshot debe tomarse en la misma transición/);
    const sigue = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(sigue!.estado).toBe('borrador');
    expect(sigue!.snapshotId).toBeNull();

    // Y el camino normal aprueba, congelando un snapshot NUEVO: el viejo sigue donde
    // estaba, sin que nadie lo haya reutilizado.
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    const aprobada = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(aprobada!.estado).toBe('aprobada');
    expect(aprobada!.snapshotId).not.toBeNull();
    expect(aprobada!.snapshotId).not.toBe(snapshotViejo);
  });

  /**
   * Un proyecto listo para firmar gates por el camino REAL: las ocho instancias con su
   * checklist resuelto y el rol aprobador que el CHECK de la tabla impone (sponsor en G0,
   * G3, G5 y G6; el lead en el resto). El checklist va en 'na' razonado
   * porque lo que se prueba aquí es la suficiencia de ENTREGA (el plan y la conciliación),
   * no la del checklist, que tiene sus propios tests en el módulo del método.
   */
  const proyectoConGates = async (codigo: string, titulo: string): Promise<string> => {
    const admin = sqlAdmin();
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, ${codigo}, ${titulo}, ${leadId}) returning id`;
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
    return proy;
  };

  /** Un servicio nuevo del reto R-90 con su to-be: el par mínimo que una design version
   * necesita para nacer y para congelarse. Servicio propio en cada test para que ninguno
   * compita por «una sola design version aprobada por servicio» (SYS-05). */
  const servicioConToBe = async (
    nombre: string,
  ): Promise<{ servicioId: string; journeyId: string }> => {
    const admin = sqlAdmin();
    const [s] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, ${nombre}, ${leadId}) returning id`;
    const svcId = s!.id as string;
    await admin`insert into reto_servicio_afectado
      (reto_id, servicio_id, workspace_id, creado_por)
      values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, 'to-be', ${'To-be de ' + nombre}, ${leadId}) returning id`;
    return { servicioId: svcId, journeyId: j!.id as string };
  };

  const elementoSuelto = async (designVersionId: string, titulo: string): Promise<string> =>
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

  const aprobarGatesHasta = async (proy: string, hasta: number): Promise<void> => {
    const admin = sqlAdmin();
    for (let n = 0; n <= hasta; n++) {
      await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proy} and workspace_id = ${ws} and numero = ${n}`;
    }
  };

  it('firmar G6 y quitarle el release a un elemento no pueden cruzarse (RF-06.4)', async () => {
    // La carrera es entre dos caminos que escriben TABLAS distintas —gate_instancia y
    // release_elemento— y que además deciden en momentos distintos: la aprobación de G6
    // comprueba la cobertura DENTRO de su update, y el borrado la comprueba en un
    // constraint trigger DIFERIDO, o sea al COMMIT y con su propio snapshot. Sin candado
    // compartido, la aprobación ve la asignación todavía visible y el trigger diferido ve
    // el gate todavía pendiente: las dos pasan y queda un G6 firmando un plan con un
    // elemento descubierto. El candado de fila no las cruza, y los que ya tenían —reto y
    // gate de un lado, release del otro— no se ven entre sí.
    const admin = sqlAdmin();
    const proy = await proyectoConGates('P-97', 'Proyecto del plan en disputa');
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del plan en disputa');
    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La del plan en disputa',
      resumen: '',
      superaA: null,
    });
    const elCubierto = await elementoSuelto(dv.designVersionId, 'Lo que el plan cubre');
    const elEnDisputa = await elementoSuelto(dv.designVersionId, 'Lo que alguien quiere sacar');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      titulo: 'El plan completo',
      responsable: 'Equipo del plan',
      fechaObjetivo: HOY,
      elementos: [
        { elementoId: elCubierto, razon: '' },
        { elementoId: elEnDisputa, razon: '' },
      ],
    });
    await aprobarGatesHasta(proy, 5);
    const [g6] = await admin`select id from gate_instancia
      where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 6`;
    const g6Id = g6!.id as string;

    // Transacción A: la aprobación de G6 tal cual la hace `aprobarGate` —candado de reto,
    // candado de gate y el UPDATE— y QUEDA ABIERTA. El intercalado se fija a mano: A avisa
    // cuando ya tiene los candados, y solo entonces arranca el borrado. Sin el aviso el
    // test podría pasar por el intercalado contrario, que no prueba nada.
    let listo!: () => void;
    const tomado = new Promise<void>((r) => (listo = r));
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const enVuelo = conUsuario(sponsorId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`;
      await tx`select pg_advisory_xact_lock(hashtextextended('designio:gate:' || ${g6Id}, 42))`;
      const filas = await tx`update gate_instancia
        set estado = 'aprobado', aprobado_por = ${sponsorId}, aprobado_en = now()
        where id = ${g6Id} and workspace_id = ${ws} and estado = 'pendiente'`;
      if (filas.count !== 1) throw new Error('la aprobación de G6 no alcanzó su gate');
      listo();
      await espera;
    });
    await tomado;

    const quitar = desasignarElemento(leadId, ws, elEnDisputa);
    try {
      expect(await siguePendiente(quitar)).toBe(true);
    } finally {
      liberar();
    }
    await enVuelo;
    // Serializadas, el desenlace es el único coherente: G6 firmó un plan completo, y por
    // eso el borrado ya no puede vaciarlo. La salida sigue existiendo —mover el elemento a
    // otro release es borrar e insertar en la MISMA transacción— y es la que el mensaje
    // ofrece.
    // Y llega como error de DOMINIO, no como fallo de Postgres. Importa el tipo: este
    // guard es DIFERIDO, así que revienta en el COMMIT —fuera del callback, donde ningún
    // `try` de la transacción lo ve— y sin traducirlo ahí el handler no lo reconoce y lanza
    // en vez de devolver `{ ok: false, error }`: la pantalla enseñaba un fallo de servidor
    // en lugar de la salida que el mensaje ofrece.
    const fallo = await quitar.catch((e: unknown) => e);
    expect(fallo).toBeInstanceOf(ErrorEntrega);
    expect((fallo as Error).message).toMatch(/G6 aprobó un plan que cubre este elemento/);
    const [gate] = await admin`select estado from gate_instancia
      where id = ${g6Id} and workspace_id = ${ws}`;
    expect(gate!.estado).toBe('aprobado');
    const cubierto = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(cubierto!.releases[0]!.elementos.map((e) => e.elementoId).sort()).toEqual(
      [elCubierto, elEnDisputa].sort(),
    );
  });

  it('un proyecto que ya certificó no aprueba diseño nuevo: el ciclo siguiente va en otro proyecto', async () => {
    // G6 y G7 no afirman algo sobre UNA design version: afirman algo sobre el conjunto de
    // las aprobadas del proyecto —cada elemento con release (RF-06.4), ninguno en estado
    // desconocido (RF-06.7)—. Aprobar una sucesora mueve ese conjunto: saca a la cubierta y
    // mete a la nueva, sin releases y sin constatar. Y el gate no se reevalúa nunca: la
    // reapertura reabre la ETAPA, no el gate (SPEC-04).
    const proy = await proyectoConGates('P-98', 'Proyecto que firma su plan');
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del ciclo cerrado');
    const primera = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La que el plan cubre',
      resumen: '',
      superaA: null,
    });
    const elPrimera = await elementoSuelto(primera.designVersionId, 'Lo que se planifica');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      motivo: '',
    });
    await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      titulo: 'El plan que se firma',
      responsable: 'Equipo del ciclo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elPrimera, razon: '' }],
    });

    // El borrador de la sucesora nace ANTES de firmar: es el caso que la comprobación del
    // alta no puede atrapar, y por eso la regla vive también en la aprobación.
    const enVuelo = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La sucesora que se quedó a medias',
      resumen: '',
      superaA: primera.designVersionId,
    });
    await elementoSuelto(enVuelo.designVersionId, 'Diseño posterior a la firma');

    await aprobarGatesHasta(proy, 5);
    const admin = sqlAdmin();
    const [g6] = await admin`select id from gate_instancia
      where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 6`;
    await aprobarGate(sponsorId, { workspaceId: ws, gateId: g6!.id as string });
    expect(await proyectosCertificados(leadId, ws)).toContain(proy);

    // La pantalla lo sabe ANTES de intentarlo: es el único blocante de la aprobación que no
    // se resuelve trabajando en esta versión, así que el botón se apaga y lo explica en vez
    // de ofrecer un callejón con forma de botón.
    const vistaDelBorrador = await designVersionCompleta(leadId, ws, enVuelo.designVersionId);
    expect(vistaDelBorrador!.proyectoCertificadoPor).toBe(6);

    // Aprobarla dejaría a G6 firmando un plan que ya no cubre nada.
    await expect(
      aprobarDesignVersion(leadId, {
        workspaceId: ws,
        designVersionId: enVuelo.designVersionId,
        motivo: '',
      }),
    ).rejects.toThrow(/ya certificó G6 y esa aprobación no se deshace/);

    // Y el borrador nuevo ni siquiera nace aquí: enterarse al aprobar dejaría una fila que
    // no se puede aprobar, ni borrar (no hay DELETE), ni mudar de proyecto (`proyecto_id`
    // no está en el grant de columna). Adelantarlo al alta es lo que conserva la salida.
    await expect(
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId: proy,
        servicioId: svcId,
        journeyId,
        titulo: 'La que no debe nacer aquí',
        resumen: '',
        superaA: primera.designVersionId,
      }),
    ).rejects.toThrow(/ya certificó G6: la design version siguiente va en el proyecto del ciclo siguiente/);

    // LA SALIDA, y no es un apaño: `supera_a` está restringido por SERVICIO y no por
    // proyecto justo para esto. El ciclo siguiente se abre en otro proyecto del reto y la
    // cadena del servicio continúa ahí.
    const siguiente = await proyectoConGates('P-99', 'Proyecto del ciclo siguiente');
    const sucesora = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: siguiente,
      servicioId: svcId,
      journeyId,
      titulo: 'La del ciclo siguiente',
      resumen: '',
      superaA: primera.designVersionId,
    });
    await elementoSuelto(sucesora.designVersionId, 'Lo que trae el ciclo nuevo');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: sucesora.designVersionId,
      motivo: '',
    });
    const anterior = await designVersionCompleta(leadId, ws, primera.designVersionId);
    expect(anterior!.estado).toBe('superada');
    expect(anterior!.superadaPor!.id).toBe(sucesora.designVersionId);
    // Y en el proyecto del ciclo siguiente el botón está encendido: nada que certificar
    // todavía.
    const vistaSucesora = await designVersionCompleta(leadId, ws, sucesora.designVersionId);
    expect(vistaSucesora!.proyectoCertificadoPor).toBeNull();
  });

  it('firmar G6 y aprobar la sucesora tampoco pueden cruzarse', async () => {
    // La otra mitad de la misma carrera, en el sentido contrario: el guard del gate no ve
    // la sucesora todavía sin commitear y el guard de la sucesora no ve el gate todavía sin
    // commitear, así que las dos pasan y queda G6 certificando un plan completo sobre un
    // conjunto de versiones que ya no es el suyo. Aquí el rechazo tampoco puede llegar
    // después: la aprobación del gate no se deshace.
    const admin = sqlAdmin();
    const proy = await proyectoConGates('P-102', 'Proyecto que firma mientras sucede');
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio de la firma en carrera');
    const primera = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La que el plan cubre',
      resumen: '',
      superaA: null,
    });
    const elPrimera = await elementoSuelto(primera.designVersionId, 'Lo que el plan cubre');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      motivo: '',
    });
    await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      titulo: 'El plan que se firma',
      responsable: 'Equipo de la firma',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elPrimera, razon: '' }],
    });
    const sucesora = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La que llega a la vez que la firma',
      resumen: '',
      superaA: primera.designVersionId,
    });
    await elementoSuelto(sucesora.designVersionId, 'Lo que la firma no cubriría');
    await aprobarGatesHasta(proy, 5);
    const [g6] = await admin`select id from gate_instancia
      where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 6`;
    const g6Id = g6!.id as string;

    let listo!: () => void;
    const tomado = new Promise<void>((r) => (listo = r));
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const enVuelo = conUsuario(sponsorId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`;
      await tx`select pg_advisory_xact_lock(hashtextextended('designio:gate:' || ${g6Id}, 42))`;
      const filas = await tx`update gate_instancia
        set estado = 'aprobado', aprobado_por = ${sponsorId}, aprobado_en = now()
        where id = ${g6Id} and workspace_id = ${ws} and estado = 'pendiente'`;
      if (filas.count !== 1) throw new Error('la aprobación de G6 no alcanzó su gate');
      listo();
      await espera;
    });
    await tomado;

    const aprobacion = aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: sucesora.designVersionId,
      motivo: '',
    });
    try {
      expect(await siguePendiente(aprobacion)).toBe(true);
    } finally {
      liberar();
    }
    await enVuelo;
    await expect(aprobacion).rejects.toThrow(/ya certificó G6 y esa aprobación no se deshace/);
    const sigue = await designVersionCompleta(leadId, ws, sucesora.designVersionId);
    expect(sigue!.estado).toBe('borrador');
    const anterior = await designVersionCompleta(leadId, ws, primera.designVersionId);
    expect(anterior!.estado).toBe('aprobada');
  });

  it('crear el borrador mientras se firma el gate no deja una fila en el callejón', async () => {
    // La comprobación del alta existe para que nadie se quede con un borrador que no puede
    // aprobar, ni borrar, ni mudar de proyecto. Si esa comprobación se puede colar mientras
    // el gate se firma, no evita el callejón: lo aplaza. Por eso el alta toma el mismo
    // candado, aunque su chequeo no sea la invariante sino el aviso.
    const admin = sqlAdmin();
    const proy = await proyectoConGates('P-103', 'Proyecto que firma mientras alguien abre');
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del alta en carrera');
    const primera = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La que el plan cubre',
      resumen: '',
      superaA: null,
    });
    const elPrimera = await elementoSuelto(primera.designVersionId, 'Lo que el plan cubre');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      motivo: '',
    });
    await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      titulo: 'El plan que se firma',
      responsable: 'Equipo del alta',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elPrimera, razon: '' }],
    });
    await aprobarGatesHasta(proy, 5);
    const [g6] = await admin`select id from gate_instancia
      where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 6`;
    const g6Id = g6!.id as string;

    let listo!: () => void;
    const tomado = new Promise<void>((r) => (listo = r));
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const enVuelo = conUsuario(sponsorId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`;
      await tx`select pg_advisory_xact_lock(hashtextextended('designio:gate:' || ${g6Id}, 42))`;
      const filas = await tx`update gate_instancia
        set estado = 'aprobado', aprobado_por = ${sponsorId}, aprobado_en = now()
        where id = ${g6Id} and workspace_id = ${ws} and estado = 'pendiente'`;
      if (filas.count !== 1) throw new Error('la aprobación de G6 no alcanzó su gate');
      listo();
      await espera;
    });
    await tomado;

    const alta = crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La que no debe llegar a nacer',
      resumen: '',
      superaA: primera.designVersionId,
    });
    try {
      expect(await siguePendiente(alta)).toBe(true);
    } finally {
      liberar();
    }
    await enVuelo;
    await expect(alta).rejects.toThrow(/ya certificó G6: la design version siguiente va en el proyecto del ciclo siguiente/);
    // Y no quedó ninguna fila: el aviso llega antes de escribir, que es de lo que se trata.
    const [cuantas] = await admin`select count(*)::int as n from design_version
      where proyecto_id = ${proy} and workspace_id = ${ws}`;
    expect(cuantas!.n).toBe(1);
  });

  it('G7 mira la cadena del SERVICIO: lo que dejó en vuelo el proyecto anterior también cuenta', async () => {
    // La cadena de versiones de un servicio atraviesa proyectos —`supera_a` está
    // restringido por servicio, no por proyecto—, así que filtrar los pendientes al
    // proyecto que pide el gate deja fuera justo lo que la salida del hallazgo anterior
    // produce: DV-A del proyecto A, superada desde el proyecto B, con releases que todavía
    // pueden salir o constatarse y mover el estado compartido del servicio.
    const admin = sqlAdmin();
    const [pa] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-100', 'Proyecto que deja vuelo', ${leadId}) returning id`;
    const proyA = pa!.id as string;
    const proyB = await proyectoConGates('P-101', 'Proyecto que hereda la cadena');
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio de la cadena entre proyectos');

    const dvA = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyA,
      servicioId: svcId,
      journeyId,
      titulo: 'La del proyecto A',
      resumen: '',
      superaA: null,
    });
    const elSale = await elementoSuelto(dvA.designVersionId, 'Lo que salió sin constatar');
    const elNoSale = await elementoSuelto(dvA.designVersionId, 'Lo que se quedó en el plan');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dvA.designVersionId,
      motivo: '',
    });
    const rlSale = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvA.designVersionId,
      titulo: 'El de A que salió',
      responsable: 'Equipo de A',
      fechaObjetivo: AYER,
      elementos: [{ elementoId: elSale, razon: '' }],
    });
    const rlQuieto = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvA.designVersionId,
      titulo: 'El de A que no llegó a salir',
      responsable: 'Equipo de A',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elNoSale, razon: 'dependencia externa' }],
    });
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rlSale.releaseId,
      desplegadoEn: AYER,
      desfaseUtcMinutos: 0,
    });

    // El proyecto B se lleva el servicio al ciclo siguiente y lo concilia ENTERO.
    const dvB = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyB,
      servicioId: svcId,
      journeyId,
      titulo: 'La del proyecto B',
      resumen: '',
      superaA: dvA.designVersionId,
    });
    const elB = await elementoSuelto(dvB.designVersionId, 'Lo que trae B');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dvB.designVersionId,
      motivo: '',
    });
    const rlB = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvB.designVersionId,
      titulo: 'El de B',
      responsable: 'Equipo de B',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elB, razon: '' }],
    });
    await desplegarRelease(leadId, { workspaceId: ws, releaseId: rlB.releaseId, desplegadoEn: HOY, desfaseUtcMinutos: 0 });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlB.releaseId,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: '',
      constataciones: [
        { elementoId: elB, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
      ],
    });
    await aprobarGatesHasta(proyB, 6);

    // El tablero de B está completo y aun así G7 no pasa: la superada es de OTRO proyecto,
    // pero del MISMO servicio, y su vuelo sigue abierto.
    const tablero = await tableroDeConciliacion(leadId, ws, dvB.designVersionId);
    expect(conciliacionCompleta(tablero!.filas)).toBe(true);
    const aprobarG7 = () =>
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proyB} and workspace_id = ${ws} and numero = 7`;
    await expect(aprobarG7()).rejects.toThrow(/responsabilidad de su proyecto/);

    // Lo desplegado se constata…
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlSale.releaseId,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: '',
      constataciones: [
        {
          elementoId: elSale,
          resultado: 'desviado',
          queQuedoDistinto: 'Salió sin el aviso',
          razon: 'El proveedor llegó tarde',
        },
      ],
    });
    await expect(aprobarG7()).rejects.toThrow(/responsabilidad de su proyecto/);

    // …y lo que no salió NO se cierra quitándole el alcance, que es la diferencia con la
    // superada dentro del mismo proyecto. Aquella es un ciclo cerrado a conciencia y sus
    // elementos sin planificar son decisiones reemplazadas; ésta sigue siendo trabajo de A,
    // que puede planificarlo y desplegarlo DESPUÉS y mover el estado del servicio que este
    // gate acaba de certificar. Vaciar el release no lo resuelve: lo deja sin resolver.
    await desasignarElemento(leadId, ws, elNoSale);
    await expect(aprobarG7()).rejects.toThrow(/responsabilidad de su proyecto/);

    // La salida es la honesta, y es la que además CONGELA el alcance sin regla nueva:
    // constatado el elemento vía un release verificado, no queda ninguno que asignar (uno
    // por elemento) ni release planificado donde meterlo.
    await asignarElemento(leadId, {
      workspaceId: ws,
      releaseId: rlQuieto.releaseId,
      elementoId: elNoSale,
      razon: 'se cierra explicándolo',
    });
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rlQuieto.releaseId,
      desplegadoEn: HOY,
      desfaseUtcMinutos: 0,
    });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlQuieto.releaseId,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: '',
      constataciones: [
        {
          elementoId: elNoSale,
          resultado: 'no-implementado',
          queQuedoDistinto: 'No llegó a construirse',
          razon: 'El ciclo pasó al proyecto siguiente antes de empezarlo',
        },
      ],
    });

    await aprobarG7();
    // Y el alcance de A queda cerrado por construcción: su release está verificado, así que
    // ninguna reasignación puede reabrir trabajo que B ya certificó como conciliado.
    await expect(
      asignarElemento(leadId, {
        workspaceId: ws,
        releaseId: rlQuieto.releaseId,
        elementoId: elSale,
        razon: 'intento de reabrir',
      }),
    ).rejects.toThrow(ErrorEntrega);
    const [g7] = await admin`select estado from gate_instancia
      where proyecto_id = ${proyB} and workspace_id = ${ws} and numero = 7`;
    expect(g7!.estado).toBe('aprobado');
  });

  it('una design version no se congela sobre decisiones en revisión (RF-04.9)', async () => {
    const admin = sqlAdmin();
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoAbierto}, 1, 'lead-boutique') returning id`;
    const [d] = await admin`insert into decision
      (workspace_id, proyecto_id, gate_id, tipo, titulo, decidido_por)
      values (${ws}, ${proyectoAbierto}, ${g!.id as string}, 'diseno',
              'Mover la verificación al canal digital', ${leadId}) returning id`;
    const decisionEnRevision = d!.id as string;
    // Es el estado que deja `reabrirEtapa` (RF-04.9: la reapertura marca las decisiones
    // aguas abajo). Se escribe directo para no montar las ocho etapas del proyecto solo
    // para llegar a él; el camino de VUELTA sí es el real (`revalidarDecision`).
    const enRevision = () => admin`update decision set estado = 'en-revision'
      where id = ${decisionEnRevision} and workspace_id = ${ws}`;
    await enRevision();

    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio de la decisión revisada');
    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyectoAbierto,
      servicioId: svcId,
      journeyId,
      titulo: 'La que se apoya en una decisión',
      resumen: '',
      superaA: null,
    });

    // El picker no la ofrece, y el guard tampoco la acepta: las dos mitades dicen lo mismo.
    const antes = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(antes!.decisionesDelProyecto.map((x) => x.id)).not.toContain(decisionEnRevision);
    await expect(
      agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dv.designVersionId,
        tipo: 'politica',
        operacion: 'modifica',
        titulo: 'Citando una decisión en revisión',
        detalle: '',
        nodoId: null,
        decisionIds: [decisionEnRevision],
        insightIds: [],
      }),
    ).rejects.toThrow(/ya no está vigente/);

    // Revalidada, se cita con normalidad.
    await revalidarDecision(leadId, ws, decisionEnRevision);
    const conCita = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(conCita!.decisionesDelProyecto.map((x) => x.id)).toContain(decisionEnRevision);
    await elementoSuelto(dv.designVersionId, 'Elemento sin motivos');
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      tipo: 'politica',
      operacion: 'modifica',
      titulo: 'Lo que la decisión motiva',
      detalle: '',
      nodoId: null,
      decisionIds: [decisionEnRevision],
      insightIds: [],
    });

    // Y aquí está el agujero que el filtro del picker NO tapa: la decisión se cita estando
    // vigente y la reapertura llega DESPUÉS. Como la versión aprobada es inmutable, sin
    // revalidar al aprobar entraría en la cadena «decisión aprobada → design version» con
    // su base explícitamente en revisión y ya no habría forma de corregirlo.
    await enRevision();
    await expect(
      aprobarDesignVersion(leadId, {
        workspaceId: ws,
        designVersionId: dv.designVersionId,
        motivo: '',
      }),
    ).rejects.toThrow(/citan decisiones en revisión/);

    // La salida es la misma que la del gate con ítems cumplidos: revalidar desbloquea sin
    // tirar el trabajo. No se resetea nada.
    await revalidarDecision(leadId, ws, decisionEnRevision);
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    const aprobada = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(aprobada!.estado).toBe('aprobada');
  });

  it('lo que G6 firmó sigue cubierto aunque otro proyecto supere la versión', async () => {
    // El vigilante de la cobertura y el propio G6 tienen que hablar del MISMO conjunto: si
    // el gate pasó a preguntar «de qué responde este proyecto» y el guard diferido se
    // quedaba en «cuál manda en el servicio», bastaba con que otro proyecto superara la
    // versión para poder vaciar el plan que G6 acababa de firmar — sin que nada avisara.
    const admin = sqlAdmin();
    const proyA = await proyectoConGates('P-105', 'Proyecto que firmó su plan');
    const [pb] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-106', 'Proyecto que se lleva el servicio', ${leadId})
      returning id`;
    const proyB = pb!.id as string;
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del plan heredado');

    const dvA = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyA,
      servicioId: svcId,
      journeyId,
      titulo: 'La que A planificó',
      resumen: '',
      superaA: null,
    });
    const elA = await elementoSuelto(dvA.designVersionId, 'Lo que A dejó cubierto');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dvA.designVersionId,
      motivo: '',
    });
    await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvA.designVersionId,
      titulo: 'El plan de A',
      responsable: 'Equipo de A',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elA, razon: '' }],
    });
    await aprobarGatesHasta(proyA, 6);

    // B se lleva el servicio al ciclo siguiente. El plan de A no se deshace por eso.
    const dvB = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyB,
      servicioId: svcId,
      journeyId,
      titulo: 'La que B se lleva',
      resumen: '',
      superaA: dvA.designVersionId,
    });
    await elementoSuelto(dvB.designVersionId, 'Lo que B trae');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dvB.designVersionId,
      motivo: '',
    });

    await expect(desasignarElemento(leadId, ws, elA)).rejects.toThrow(
      /G6 aprobó un plan que cubre este elemento/,
    );
    // Y sigue asignado: el rechazo del constraint diferido revierte la transacción entera.
    const cubierto = await designVersionCompleta(leadId, ws, dvA.designVersionId);
    expect(cubierto!.releases[0]!.elementos.map((e) => e.elementoId)).toEqual([elA]);
  });

  it('un to-be anclado a otro proyecto no lo congela esta design version', async () => {
    // El selector del alta ofrece los to-be DEL SERVICIO, y un servicio puede tener uno por
    // cada proyecto que lo toca: sin filtrar por el proyecto elegido, la pantalla ofrecía el
    // de A con B seleccionado y el alta se estrellaba contra el guard. Aquí se fija lo que
    // la pantalla tiene que respetar (la regla) y el dato con el que puede respetarlo (el
    // proyecto del journey en la lista) — sin ese dato, filtrar no era posible.
    const admin = sqlAdmin();
    const { servicioId: svcId } = await servicioConToBe('Servicio con to-be de dos proyectos');
    const [jAjeno] = await admin`insert into journey
      (workspace_id, servicio_id, reto_id, proyecto_id, tipo, nombre, creado_por)
      values (${ws}, ${svcId}, ${retoId}, ${otroProyectoId}, 'to-be', 'To-be del proyecto vecino',
              ${leadId}) returning id`;
    const journeyAjeno = jAjeno!.id as string;

    await expect(
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId: proyectoAbierto,
        servicioId: svcId,
        journeyId: journeyAjeno,
        titulo: 'La que quiere congelar el grafo de otro',
        resumen: '',
        superaA: null,
      }),
    ).rejects.toThrow(/anclado a otro proyecto/);

    // Y la lista trae el anclaje, que es lo único que le permite al selector no ofrecerlo.
    // Los to-be SIN proyecto valen para cualquiera, y así los reporta.
    const pagina = await journeysDelWorkspace(leadId, ws, null, {
      servicioId: svcId,
      tipo: 'to-be',
    });
    const anclados = new Map(pagina.journeys.map((j) => [j.id, j.proyectoId]));
    expect(anclados.get(journeyAjeno)).toBe(otroProyectoId);
    expect([...anclados.values()]).toContain(null);
  });

  it('una versión no queda superada sin nadie que la reemplace (SYS-05)', async () => {
    // `estado` está en el grant de columna y la política de supersión solo mira el par de
    // estados, así que un UPDATE suelto las pasaba las dos y dejaba al servicio SIN versión
    // vigente. Y ese estado NO TIENE SALIDA: el selector de «supera a» solo ofrece
    // aprobadas —mismo predicado que el guard de anclaje— y `aprobarDesignVersion` exige
    // mover la predecesora de 'aprobada' a 'superada', que ahí ya no alcanza ninguna fila.
    // Misma familia que el effective state a medias, y misma respuesta: se endurece la
    // invariante para que el estado sea inalcanzable, no se construye una reparación.
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio sin sucesora');
    const primera = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyectoAbierto,
      servicioId: svcId,
      journeyId,
      titulo: 'La que nadie reemplaza',
      resumen: '',
      superaA: null,
    });
    await elementoSuelto(primera.designVersionId, 'Elemento de la primera');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: primera.designVersionId,
      motivo: '',
    });

    // EL ATAQUE: la transición es legal y la política la deja pasar; lo que no hay es quien
    // la suceda. Revienta al COMMIT, que es cuando la condición se puede exigir entera.
    await expect(
      conUsuario(leadId, (tx) => tx`update design_version set estado = 'superada'
        where id = ${primera.designVersionId} and workspace_id = ${ws}`),
    ).rejects.toThrow(/no hay ninguna versión aprobada que suceda a esta/);
    const sigue = await designVersionCompleta(leadId, ws, primera.designVersionId);
    expect(sigue!.estado).toBe('aprobada');

    // Y el camino normal pasa, que es el otro extremo que hay que fijar: la supersión
    // ocurre DENTRO de la transacción que aprueba a la sucesora, donde al marcar superada
    // la sucesora todavía es un borrador. Por eso el constraint es diferido.
    const siguienteCiclo = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyectoAbierto,
      servicioId: svcId,
      journeyId,
      titulo: 'La que sí la reemplaza',
      resumen: '',
      superaA: primera.designVersionId,
    });
    await elementoSuelto(siguienteCiclo.designVersionId, 'Elemento del ciclo siguiente');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: siguienteCiclo.designVersionId,
      motivo: '',
    });
    const superada = await designVersionCompleta(leadId, ws, primera.designVersionId);
    expect(superada!.estado).toBe('superada');
    expect(superada!.superadaPor!.id).toBe(siguienteCiclo.designVersionId);
  });

  it('el proyecto puede terminar el plan de la versión que sigue siendo suya', async () => {
    // El conjunto de responsabilidad y el permiso de actuar tienen que coincidir. Si otro
    // proyecto supera la versión de A ANTES de que A firme su G6, esa versión sigue dentro
    // del conjunto que responde A —a propósito, o A no podría certificar nunca— pero pasa a
    // 'superada'; con el filtro de «aprobada» en las políticas del release y del alcance, A
    // quedaba obligado a cubrir un elemento que tenía prohibido planificar. Callejón.
    const admin = sqlAdmin();
    const proyA = await proyectoConGates('P-107', 'Proyecto al que le quitan el ciclo a medias');
    const [pb] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-108', 'Proyecto que adelanta el ciclo', ${leadId}) returning id`;
    const proyB = pb!.id as string;
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del plan a medio hacer');

    const dvA = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyA,
      servicioId: svcId,
      journeyId,
      titulo: 'La de A, con el plan a medias',
      resumen: '',
      superaA: null,
    });
    const elPlanificado = await elementoSuelto(dvA.designVersionId, 'Lo que A ya había planificado');
    const elSinPlan = await elementoSuelto(dvA.designVersionId, 'Lo que A no llegó a planificar');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dvA.designVersionId,
      motivo: '',
    });
    const rlPrimero = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvA.designVersionId,
      titulo: 'Lo que A alcanzó a planificar',
      responsable: 'Equipo de A',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: elPlanificado, razon: '' }],
    });

    // B se adelanta y supera la versión de A antes de que A firme nada.
    const dvB = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyB,
      servicioId: svcId,
      journeyId,
      titulo: 'La de B',
      resumen: '',
      superaA: dvA.designVersionId,
    });
    await elementoSuelto(dvB.designVersionId, 'Lo que B trae');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dvB.designVersionId,
      motivo: '',
    });

    // A sigue pudiendo cerrar SU plan: asignar al release que ya tenía y planificar uno
    // nuevo. Las dos cosas estaban prohibidas y las dos son las que su G6 le exige.
    await asignarElemento(leadId, {
      workspaceId: ws,
      releaseId: rlPrimero.releaseId,
      elementoId: elSinPlan,
      razon: 'se cierra con el primero',
    });
    const rlSegundo = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvA.designVersionId,
      titulo: 'El que A abre para cerrar',
      responsable: 'Equipo de A',
      fechaObjetivo: HOY,
      elementos: [],
    });
    expect(rlSegundo.releaseId).toBeTruthy();

    // Y con el plan completo, G6 firma. Antes era inalcanzable.
    await aprobarGatesHasta(proyA, 6);
    const [g6] = await admin`select estado from gate_instancia
      where proyecto_id = ${proyA} and workspace_id = ${ws} and numero = 6`;
    expect(g6!.estado).toBe('aprobado');

    // El contraste que mantiene la regla original en pie: sobre una versión que el PROPIO
    // proyecto reemplazó, añadir alcance sigue prohibido — eso sí es un ciclo cerrado a
    // conciencia. Lo fija el test de «planificar y ampliar el alcance esperan a la
    // supersión», que supera dentro del mismo proyecto.
  });

  it('el contenido del snapshot lo escribe la base: un grafo inventado no se congela', async () => {
    // `xmin` contesta «¿es de ahora?»; esto contesta «¿es de verdad?». La política de
    // journey_snapshot solo comprueba rol y autor, así que por SQL directo un lead podía
    // insertar en la misma transacción un grafo INVENTADO y aprobarlo: la frescura la
    // pasaba, y con incluir el id del nodo enlazado pasaba también la revalidación de
    // nodos, mientras omitía aristas y falseaba etiquetas. La versión quedaba inmutable
    // certificando un grafo que nunca existió.
    const admin = sqlAdmin();
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del grafo inventado');
    const [n1] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, creado_por)
      values (${ws}, ${journeyId}, 'paso', 'La etiqueta de verdad', ${leadId}) returning id`;
    const [n2] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, creado_por)
      values (${ws}, ${journeyId}, 'paso', 'El segundo paso', ${leadId}) returning id`;
    await admin`insert into journey_arista
      (workspace_id, journey_id, origen_id, destino_id, tipo, creado_por)
      values (${ws}, ${journeyId}, ${n1!.id as string}, ${n2!.id as string}, 'transicion',
              ${leadId})`;

    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proyectoAbierto,
      servicioId: svcId,
      journeyId,
      titulo: 'La que se aprueba con SQL crudo',
      resumen: '',
      superaA: null,
    });
    await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      tipo: 'paso',
      operacion: 'modifica',
      titulo: 'Toca el primer paso',
      detalle: '',
      nodoId: n1!.id as string,
      decisionIds: [],
      insightIds: [],
    });

    // EL ATAQUE, entero y en una sola transacción: snapshot fabricado —el id del nodo
    // enlazado está, para pasar la revalidación, pero la etiqueta es otra, el segundo nodo
    // no está y la arista tampoco— y aprobación apuntando a él.
    const inventado = {
      nodos: [{ id: n1!.id as string, etiqueta: 'La etiqueta que nunca existió' }],
      aristas: [],
      evidencias: [],
    };
    await conUsuario(leadId, async (tx) => {
      const [snap] = await tx`insert into journey_snapshot
        (workspace_id, journey_id, motivo, grafo, congelado_por)
        values (${ws}, ${journeyId}, 'con el grafo inventado', ${tx.json(inventado)}, ${leadId})
        returning id`;
      await tx`update design_version
        set estado = 'aprobada', aprobada_por = ${leadId}, snapshot_id = ${snap!.id as string}
        where id = ${dv.designVersionId} and workspace_id = ${ws}`;
    });

    // La aprobación vale —el grafo es real y la transición es legítima—, pero lo congelado
    // es lo que había, no lo que el llamante trajo.
    const completa = await designVersionCompleta(leadId, ws, dv.designVersionId);
    expect(completa!.estado).toBe('aprobada');
    const [snapshot] = await admin`select grafo from journey_snapshot
      where id = ${completa!.snapshotId!} and workspace_id = ${ws}`;
    const grafo = snapshot!.grafo as {
      nodos: { id: string; etiqueta: string }[];
      aristas: unknown[];
      evidencias: unknown[];
    };
    expect(grafo.nodos.map((n) => n.etiqueta).sort()).toEqual([
      'El segundo paso',
      'La etiqueta de verdad',
    ]);
    expect(grafo.aristas).toHaveLength(1);
  });

  it('en una cadena de tres, el del medio sigue respondiendo por lo que dejó el primero', async () => {
    // El ámbito de la superada se derivaba de «los servicios de los que este proyecto tiene
    // la APROBADA vigente», y eso se rompe un eslabón más arriba: en A → B → C, cuando C
    // supera a la de B, B deja de tener aprobada de ese servicio, el brazo por servicio se
    // queda vacío y la de A se cae del ámbito de B — que entonces certificaba G7 sin
    // responder por el trabajo abierto de A. La aprobada vigente es solo un caso particular
    // de la responsabilidad.
    const admin = sqlAdmin();
    const [pa] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-109', 'Primero de la cadena', ${leadId}) returning id`;
    const proyA = pa!.id as string;
    const proyB = await proyectoConGates('P-110', 'Segundo de la cadena');
    const [pc] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-111', 'Tercero de la cadena', ${leadId}) returning id`;
    const proyC = pc!.id as string;
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio de la cadena de tres');

    const nueva = async (proy: string, titulo: string, superaA: string | null) => {
      const dv = await crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId: proy,
        servicioId: svcId,
        journeyId,
        titulo,
        resumen: '',
        superaA,
      });
      const el = await elementoSuelto(dv.designVersionId, `Elemento de ${titulo}`);
      await aprobarDesignVersion(leadId, {
        workspaceId: ws,
        designVersionId: dv.designVersionId,
        motivo: '',
      });
      return { id: dv.designVersionId, elementoId: el };
    };

    const dvA = await nueva(proyA, 'la de A', null);
    // A deja su elemento en un release planificado: trabajo abierto que todavía puede salir.
    const rlA = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvA.id,
      titulo: 'El que A no llegó a desplegar',
      responsable: 'Equipo de A',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: dvA.elementoId, razon: '' }],
    });

    const dvB = await nueva(proyB, 'la de B', dvA.id);
    const rlB = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvB.id,
      titulo: 'El de B',
      responsable: 'Equipo de B',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: dvB.elementoId, razon: '' }],
    });
    await desplegarRelease(leadId, { workspaceId: ws, releaseId: rlB.releaseId, desplegadoEn: HOY, desfaseUtcMinutos: 0 });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlB.releaseId,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: '',
      constataciones: [
        { elementoId: dvB.elementoId, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
      ],
    });

    // C se lleva el servicio: la de B pasa a superada y B se queda sin aprobada de S.
    await nueva(proyC, 'la de C', dvB.id);
    await aprobarGatesHasta(proyB, 6);

    // La versión de A la superó OTRO proyecto, así que sigue a cargo del suyo — y eso es
    // exactamente lo que la pantalla necesita saber para dejarle planificar y cerrar.
    const vistaA = await designVersionCompleta(leadId, ws, dvA.id);
    expect(vistaA!.estado).toBe('superada');
    expect(vistaA!.aCargoDelProyecto).toBe(true);

    const aprobarG7B = () =>
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proyB} and workspace_id = ${ws} and numero = 7`;
    await expect(aprobarG7B()).rejects.toThrow(/responsabilidad de su proyecto/);

    // Se cierra el trabajo de A —lo hace quien puede, que aquí es el mismo lead— y entonces
    // B certifica: nada del servicio puede moverse ya sin que alguien lo constate.
    await desplegarRelease(leadId, { workspaceId: ws, releaseId: rlA.releaseId, desplegadoEn: HOY, desfaseUtcMinutos: 0 });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlA.releaseId,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: '',
      constataciones: [
        {
          elementoId: dvA.elementoId,
          resultado: 'no-implementado',
          queQuedoDistinto: 'Se quedó sin construir',
          razon: 'El ciclo pasó a los proyectos siguientes',
        },
      ],
    });
    await aprobarG7B();
    const [g7] = await admin`select estado from gate_instancia
      where proyecto_id = ${proyB} and workspace_id = ${ws} and numero = 7`;
    expect(g7!.estado).toBe('aprobado');
  });

  it('el trabajo abierto de un ciclo POSTERIOR no bloquea al del medio', async () => {
    // El reverso del test de arriba, y el borde por el que el ámbito se pasó de ancho:
    // «todas las superadas del servicio del que respondo» se traga a los DESCENDIENTES.
    // En A → B → C → D, en cuanto D supera a la de C, la de C —con trabajo sin resolver—
    // entraba en el ámbito de B. Pero C no es trabajo que B heredara: es POSTERIOR a B.
    //
    // La prueba de que estaba mal es que el resultado del gate de B cambiaba por un hecho
    // sin ninguna relación con B: esa misma versión de C, igual de sin resolver, NO lo
    // bloqueaba mientras era la vigente; empezaba a bloquearlo en cuanto D la superaba.
    // Un G7 que se vuelve inaprobable por lo que hagan los ciclos siguientes no certifica
    // nada. El ámbito es LINAJE —lo que uno reemplazó, hacia atrás—, no «el servicio».
    const admin = sqlAdmin();
    const [pa] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-120', 'A de la cadena de cuatro', ${leadId}) returning id`;
    const proyA = pa!.id as string;
    const proyB = await proyectoConGates('P-121', 'B de la cadena de cuatro');
    // C nace CON gates: al final se comprueba que el ámbito no se pierde, sino que aterriza
    // en el proyecto al que le toca — y para eso su G7 tiene que existir de verdad.
    const proyC = await proyectoConGates('P-122', 'C de la cadena de cuatro');
    const [pd] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-123', 'D de la cadena de cuatro', ${leadId}) returning id`;
    const proyD = pd!.id as string;
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio de la cadena de cuatro');

    const nueva = async (proy: string, titulo: string, superaA: string | null) => {
      const dv = await crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId: proy,
        servicioId: svcId,
        journeyId,
        titulo,
        resumen: '',
        superaA,
      });
      const el = await elementoSuelto(dv.designVersionId, `Elemento de ${titulo}`);
      await aprobarDesignVersion(leadId, {
        workspaceId: ws,
        designVersionId: dv.designVersionId,
        motivo: '',
      });
      return { id: dv.designVersionId, elementoId: el };
    };

    // Cierre completo de un elemento: release, despliegue y constatación.
    const cerrar = async (dvId: string, elementoId: string, titulo: string) => {
      const rl = await planificarRelease(leadId, {
        workspaceId: ws,
        designVersionId: dvId,
        titulo,
        responsable: 'Equipo',
        fechaObjetivo: HOY,
        elementos: [{ elementoId, razon: '' }],
      });
      await desplegarRelease(leadId, { workspaceId: ws, releaseId: rl.releaseId, desplegadoEn: HOY, desfaseUtcMinutos: 0 });
      await constatarEffectiveState(leadId, {
        workspaceId: ws,
        releaseId: rl.releaseId,
        constatadoEn: HOY,
        desfaseUtcMinutos: 0,
        resumen: '',
        constataciones: [
          { elementoId, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
        ],
      });
    };

    // A y B cierran lo suyo: B no debe nada hacia atrás.
    const dvA = await nueva(proyA, 'la de A', null);
    await cerrar(dvA.id, dvA.elementoId, 'El de A');
    const dvB = await nueva(proyB, 'la de B', dvA.id);
    await cerrar(dvB.id, dvB.elementoId, 'El de B');

    // C se lleva el servicio y deja su elemento SIN resolver, en un release planificado.
    const dvC = await nueva(proyC, 'la de C', dvB.id);
    await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dvC.id,
      titulo: 'El que C no llegó a desplegar',
      responsable: 'Equipo de C',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: dvC.elementoId, razon: '' }],
    });
    await aprobarGatesHasta(proyB, 6);

    const aprobarG7B = () =>
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proyB} and workspace_id = ${ws} and numero = 7`;
    // La MISMA redacción que levanta el guard, preguntada directamente: si el ámbito se
    // pasa de ancho, aquí sale el motivo antes de que el update lo confirme.
    const bloqueoDeG7 = async (proy: string): Promise<string | null> => {
      const [f] = await admin`select g7_motivo_de_bloqueo(${proy}, ${ws}) as motivo`;
      return (f!.motivo as string | null) ?? null;
    };

    // Mientras la de C es la VIGENTE, su trabajo abierto no bloquea a B. Nadie lo discute.
    expect(await bloqueoDeG7(proyB)).toBeNull();

    // Y ahora D supera a la de C. Para B no ha cambiado NADA: ni su linaje, ni su trabajo,
    // ni lo que heredó. Su G7 tiene que seguir aprobándose.
    await nueva(proyD, 'la de D', dvC.id);
    expect(await bloqueoDeG7(proyB)).toBeNull();
    await aprobarG7B();
    const [g7B] = await admin`select estado from gate_instancia
      where proyecto_id = ${proyB} and workspace_id = ${ws} and numero = 7`;
    expect(g7B!.estado).toBe('aprobado');

    // Y el que SÍ responde por lo que C dejó abierto es C, no B: el ámbito no se pierde,
    // se coloca donde toca.
    await aprobarGatesHasta(proyC, 6);
    await expect(
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proyC} and workspace_id = ${ws} and numero = 7`,
    ).rejects.toThrow(/estado desconocido/);
  });

  it('dentro de una design version, un nodo —y un catálogo— son UN solo cambio', async () => {
    // La identidad lógica la define «clave»: catálogo si lo hay, si no el nodo. Sin esta
    // unicidad dos elementos de la MISMA versión podían apuntar al mismo sitio, aprobarse y
    // salir en un release, y ahí el modelo y la clave se contradicen: el pliegue los trata
    // como UNO —una constatación machaca a la otra, y un 'retira' borra el estado que
    // representaban las dos— mientras el diff y G7 siguen contando DOS filas.
    //
    // Es la simetría del fallo que cerró la identidad por tipo, con el signo cambiado: allí
    // eran dos cosas distintas compartiendo clave y se arreglaron distinguiéndolas; aquí
    // comparten clave con razón y no hay nada que las separe. Tocar «clave» no es salida:
    // meter el id la haría única por fila y destruiría el reconocimiento ENTRE versiones,
    // que es lo único que existe para hacer.
    const admin = sqlAdmin();
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio de la identidad');
    const proy = await proyectoConGates('P-128', 'Proyecto de la identidad');
    // Un nodo de entidad EXIGE catálogo (lo impone un CHECK del journey), así que las dos
    // formas de la identidad se montan con entradas de catálogo de verdad.
    const entrada = async (nombre: string): Promise<string> => {
      const [c] = await admin`insert into catalogo_journey
        (workspace_id, servicio_id, tipo, nombre, creado_por)
        values (${ws}, ${svcId}, 'touchpoint', ${nombre}, ${leadId}) returning id`;
      return c!.id as string;
    };
    const catA = await entrada('Mostrador');
    const catB = await entrada('Buzón');
    const nodoDe = async (tipo: string, etiqueta: string, catalogo: string | null) => {
      const [n] = await admin`insert into journey_nodo
        (workspace_id, journey_id, tipo, etiqueta, catalogo_id, creado_por)
        values (${ws}, ${journeyId}, ${tipo}, ${etiqueta}, ${catalogo}, ${leadId})
        returning id`;
      return n!.id as string;
    };
    // Dos nodos DISTINTOS contra la MISMA entrada: un journey lo admite de sobra —el mismo
    // touchpoint en dos momentos del recorrido— y por eso el catálogo necesita su propia
    // comprobación, que no cabe en el índice.
    const nodoA1 = await nodoDe('touchpoint', 'Mostrador al entrar', catA);
    const nodoA2 = await nodoDe('touchpoint', 'Mostrador al salir', catA);
    const nodoB = await nodoDe('touchpoint', 'Buzón de salida', catB);
    const nodoPaso = await nodoDe('paso', 'Un paso sin catálogo', null);

    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La de la identidad',
      resumen: '',
      superaA: null,
    });
    const conNodo = (titulo: string, nodoId: string) =>
      agregarElemento(leadId, {
        workspaceId: ws,
        designVersionId: dv.designVersionId,
        tipo: 'touchpoint',
        operacion: 'agrega',
        titulo,
        detalle: '',
        nodoId,
        decisionIds: [],
        insightIds: [],
      });

    await conNodo('El cambio del mostrador', nodoA1);
    // Mismo NODO: lo para el índice único, y llega como error de dominio con la salida.
    await expect(conNodo('Otra cosa del mismo nodo', nodoA1)).rejects.toThrow(/UN elemento/);
    // Mismo CATÁLOGO por otro nodo: lo para el guard.
    await expect(conNodo('El mismo mostrador por otro nodo', nodoA2)).rejects.toThrow(
      /entrada de catálogo/,
    );
    // Y lo que NO se prohíbe: otra entrada, y un nodo sin catálogo, son otros elementos.
    await conNodo('El cambio del buzón', nodoB);
    await conNodo('El cambio del paso', nodoPaso);

    // La colisión puede APARECER después: fundir dos entradas de catálogo repetidas es una
    // limpieza normal del journey, y deja a dos elementos que nacieron distintos
    // compartiendo identidad sin que nadie tocara la design version. Por eso se revalida al
    // aprobar, que es el último instante en que el borrador todavía se puede corregir.
    await admin`update journey_nodo set catalogo_id = ${catA}
      where id = ${nodoB} and workspace_id = ${ws}`;
    await expect(
      aprobarDesignVersion(leadId, {
        workspaceId: ws,
        designVersionId: dv.designVersionId,
        motivo: '',
      }),
    ).rejects.toThrow(/misma entrada de catálogo/);

    // Deshecha la fusión, la versión aprueba: la regla no deja al borrador sin salida.
    await admin`update journey_nodo set catalogo_id = ${catB}
      where id = ${nodoB} and workspace_id = ${ws}`;
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
  });

  it('los códigos de serie son CANÓNICOS: el orden depende de leerlos como número', async () => {
    // Desde que el orden lo da el número interpretado y no el sello, un código no canónico
    // es carga estructural: 'DV-01' y 'DV-1' pasan la unicidad de TEXTO pero valen lo mismo
    // como número, y entonces el keyset de la lista pierde el orden total que asume —puede
    // saltarse filas en el borde de una página— y la elección del ES vigente del mismo día
    // vuelve a ser no determinista. Se cierra donde nace, en el CHECK.
    const admin = sqlAdmin();
    const [dvOk] = await admin`select id, codigo, proyecto_id, servicio_id, workspace_id
      from design_version where workspace_id = ${ws} limit 1`;
    const proyectoDe = dvOk!.proyecto_id as string;
    const servicioDe = dvOk!.servicio_id as string;

    const conCodigo = (codigo: string) =>
      admin`insert into design_version
        (workspace_id, proyecto_id, servicio_id, codigo, titulo, creado_por)
        values (${ws}, ${proyectoDe}, ${servicioDe}, ${codigo}, 'La del código raro', ${leadId})`;

    // Cero a la izquierda: el gemelo silencioso de otro código.
    await expect(conCodigo('DV-01')).rejects.toThrow();
    // Sin número, o con un cero que ninguna serie emite.
    await expect(conCodigo('DV-0')).rejects.toThrow();
    // Y una tirada que desbordaría el int al interpretarla.
    await expect(conCodigo('DV-1234567890')).rejects.toThrow();

    // Lo que la serie sí emite de verdad pasa, y se lee como su número.
    const [n] = await admin`select numero_de_serie(${dvOk!.codigo as string}) as n`;
    expect(n!.n).toBeGreaterThan(0);
  });

  it('un elemento cita VARIOS motivos, y la lectura los devuelve todos', async () => {
    // El formulario mandaba un solo id por relación aunque el esquema y la persistencia
    // admiten hasta MAXIMO_MOTIVOS_POR_ELEMENTO, y no había otra pantalla para añadir los
    // que faltasen. Al usuario le quedaban dos salidas y las dos malas: guardar la
    // trazabilidad recortada —que es justo lo que este producto vende, y como la versión se
    // CONGELA al aprobarse la omisión queda fija—, o partir el cambio en dos elementos para
    // colgarle la segunda motivación. Lo segundo deja dos filas donde hay UN cambio, y de
    // ahí en adelante el pliegue cuenta dos y el diff enseña un alta que nunca ocurrió.
    //
    // El arreglo es de PANTALLA, así que este test no lo prueba: prueba el ida y vuelta del
    // que la pantalla depende —que varias citas se guardan y VUELVEN todas—, que es lo que
    // se rompería sin avisar si alguien tocara la proyección.
    const admin = sqlAdmin();
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio de la cadena larga');
    const proy = await proyectoConGates('P-127', 'Proyecto de la cadena larga');
    const [g1] = await admin`select id from gate_instancia
      where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 1`;
    const decisiones: string[] = [];
    for (const titulo of ['Primera razón', 'Segunda razón', 'Tercera razón']) {
      const [d] = await admin`insert into decision
        (workspace_id, proyecto_id, gate_id, tipo, titulo, decidido_por)
        values (${ws}, ${proy}, ${g1!.id as string}, 'diseno', ${titulo}, ${leadId}) returning id`;
      decisiones.push(d!.id as string);
    }
    const insights: string[] = [];
    for (const titulo of ['Primer hallazgo', 'Segundo hallazgo']) {
      const [i] = await admin`insert into insight
        (workspace_id, titulo, estado, validado_por, validado_en, creado_por)
        values (${ws}, ${titulo}, 'validado', ${leadId}, now(), ${leadId}) returning id`;
      insights.push(i!.id as string);
    }

    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La de los muchos motivos',
      resumen: '',
      superaA: null,
    });
    const el = await agregarElemento(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      tipo: 'canal',
      operacion: 'agrega',
      titulo: 'Un cambio con varias razones',
      detalle: '',
      nodoId: null,
      decisionIds: decisiones,
      insightIds: insights,
    });

    const vista = await designVersionCompleta(leadId, ws, dv.designVersionId);
    const guardado = vista!.elementos.find((e) => e.id === el.elementoId)!;
    expect(guardado.decisiones.map((d) => d.id).sort()).toEqual([...decisiones].sort());
    expect(guardado.insights.map((i) => i.id).sort()).toEqual([...insights].sort());

    // Y el tope que la pantalla espeja es EL DEL ESQUEMA, no un número copiado al JSX.
    const base = {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      tipo: 'canal' as const,
      operacion: 'agrega' as const,
      titulo: 'Da igual',
    };
    const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
    expect(
      AgregarElementoSchema.safeParse({ ...base, decisionIds: ids(MAXIMO_MOTIVOS_POR_ELEMENTO) })
        .success,
    ).toBe(true);
    expect(
      AgregarElementoSchema.safeParse({
        ...base,
        decisionIds: ids(MAXIMO_MOTIVOS_POR_ELEMENTO + 1),
      }).success,
    ).toBe(false);
    expect(
      AgregarElementoSchema.safeParse({
        ...base,
        insightIds: ids(MAXIMO_MOTIVOS_POR_ELEMENTO + 1),
      }).success,
    ).toBe(false);
  });

  it('el estado efectivo llega al ÁRBOL, que es donde se busca un servicio (RF-06.10)', async () => {
    // RF-06.10 pide el estado operativo DERIVADO del servicio. Existía —lo calcula el
    // detalle de una design version—, pero solo ahí: para verlo había que saber ya qué
    // design version mirar, o sea tener la respuesta antes de la pregunta. El árbol es donde
    // se busca un servicio, así que es donde el dato tiene que estar.
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio con estado operativo');
    const { servicioId: svcVirgen } = await servicioConToBe('Servicio que nadie ha tocado');
    const proy = await proyectoConGates('P-126', 'Proyecto del estado operativo');
    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La que deja estado',
      resumen: '',
      superaA: null,
    });
    const el = await elementoSuelto(dv.designVersionId, 'Lo que cambia de verdad');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    const rl = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      titulo: 'El que sale',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: el, razon: '' }],
    });

    const servicioEnElArbol = async (id: string) => {
      const arbol = await arbolParaUsuario(leadId, ws);
      return arbol!.servicios.find((s) => s.id === id)!;
    };

    // Antes de constatar no hay estado efectivo, y decirlo con null es más honesto que
    // fingir uno vacío: el release ha salido pero nadie ha mirado todavía cómo quedó.
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rl.releaseId,
      desplegadoEn: HOY,
      desfaseUtcMinutos: 0,
    });
    expect((await servicioEnElArbol(svcId)).estadoEfectivo).toBeNull();

    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rl.releaseId,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: 'La atención pasó a ser asistida',
      constataciones: [
        { elementoId: el, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
      ],
    });

    const conEstado = await servicioEnElArbol(svcId);
    expect(conEstado.estadoEfectivo).not.toBeNull();
    expect(conEstado.estadoEfectivo!.resumen).toBe('La atención pasó a ser asistida');
    expect(conEstado.estadoEfectivo!.constatadoEn).toBe(HOY);
    // Y de qué versión salió, que es lo que hace que el código ubique algo.
    const [dvCodigo] = await sqlAdmin()`select codigo from design_version
      where id = ${dv.designVersionId} and workspace_id = ${ws}`;
    expect(conEstado.estadoEfectivo!.designVersionCodigo).toBe(dvCodigo!.codigo as string);
    // El código es el que la MISMA función elige como vigente, no uno cualquiera.
    const [vigente] = await sqlAdmin()`select codigo from effective_state
      where id = effective_state_vigente_del_servicio(${svcId}, ${ws})`;
    expect(conEstado.estadoEfectivo!.codigo).toBe(vigente!.codigo as string);

    // Un servicio que nadie ha tocado no inventa estado.
    expect((await servicioEnElArbol(svcVirgen)).estadoEfectivo).toBeNull();
  });

  it('una fecha que no existe se rechaza en el borde, no en el ::date de Postgres', async () => {
    // El patrón de antes comprobaba la FORMA y no el CALENDARIO, así que '2026-02-31' pasaba
    // el validador, llegaba al `::date` y reventaba con un 22008 que ni `comoErrorDeDominio`
    // ni `mensajeDe` traducen: el llamador recibía un fallo genérico —con un código de la
    // base asomando— en vez del `{ ok: false, error }` del contrato.
    //
    // Ahora las tres fechas del módulo usan el MISMO esquema que ya validaba el calendario
    // en el resto del repositorio. Se prueban las tres: si mañana nace un campo de fecha con
    // otro patrón, este test no lo ve, pero al menos las que hay comparten redacción.
    const base = { workspaceId: crypto.randomUUID(), releaseId: crypto.randomUUID() };
    const imposibles = ['2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10'];
    const bisiesto = '2028-02-29';

    for (const fecha of imposibles) {
      expect(
        PlanificarReleaseSchema.safeParse({
          workspaceId: base.workspaceId,
          designVersionId: crypto.randomUUID(),
          titulo: 'Da igual',
          responsable: 'Da igual',
          fechaObjetivo: fecha,
        }).success,
      ).toBe(false);
      expect(
        DesplegarReleaseSchema.safeParse({ ...base, desplegadoEn: fecha }).success,
      ).toBe(false);
      expect(
        ConstatarSchema.safeParse({
          ...base,
          constatadoEn: fecha,
          constataciones: [{ elementoId: crypto.randomUUID(), resultado: 'como-aprobado' }],
        }).success,
      ).toBe(false);
    }

    // Y un 29 de febrero de año bisiesto SÍ existe: rechazar de más sería el otro fallo.
    expect(DesplegarReleaseSchema.safeParse({ ...base, desplegadoEn: bisiesto }).success).toBe(
      true,
    );
  });

  it('el orden del pliegue es la SERIE, no el sello: la que empieza antes puede numerar después', async () => {
    // `creado_en` cae por defecto en `now()`, que en Postgres es el instante de INICIO de la
    // transacción; el código de ES se asigna bajo `bloquearSerie`, un candado que se toma
    // DESPUÉS. Los dos relojes se contradicen en cuanto hay espera: una transacción que
    // empezó ANTES y se quedó esperando obtiene un número MAYOR con un sello MENOR.
    //
    // Y donde el orden decide el estado eso no es cosmético: el effective state vigente es
    // el PLIEGUE cronológico de las constataciones del servicio (RF-06.10), así que si dos
    // caen en la misma fecha de calendario y se desempatan por el sello, el pliegue aplica
    // ES-2 primero y deja que ES-1 lo pise. Estado vigente equivocado y diff equivocado
    // detrás, sin ninguna excepción que lo delate.
    //
    // La inversión se monta de verdad, y sale determinista porque `bloquearRelease` se toma
    // ANTES que `bloquearSerie`: se retiene el candado del release A, se lanza la
    // constatación de A —que se queda esperando ahí, con su `now()` ya fijado— y mientras
    // tanto la de B entra entera y se lleva ES-1. Al soltar, A numera ES-2 con un sello
    // anterior al de B.
    const admin = sqlAdmin();
    const proy = await proyectoConGates('P-125', 'Proyecto del desempate');
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del desempate');
    const dv1 = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La que deja la historia',
      resumen: '',
      superaA: null,
    });
    // Mismo tipo y mismo título: sin catálogo ni nodo, comparten IDENTIDAD LÓGICA, que es
    // lo que hace que el pliegue tenga que elegir uno y el orden decida cuál.
    const elA = await elementoSuelto(dv1.designVersionId, 'Atención telefónica');
    const elB = await elementoSuelto(dv1.designVersionId, 'Atención telefónica');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv1.designVersionId,
      motivo: '',
    });

    const releaseCon = async (titulo: string, elementoId: string): Promise<string> => {
      const rl = await planificarRelease(leadId, {
        workspaceId: ws,
        designVersionId: dv1.designVersionId,
        titulo,
        responsable: 'Equipo',
        fechaObjetivo: HOY,
        elementos: [{ elementoId, razon: '' }],
      });
      await desplegarRelease(leadId, {
        workspaceId: ws,
        releaseId: rl.releaseId,
        desplegadoEn: HOY,
        desfaseUtcMinutos: 0,
      });
      return rl.releaseId;
    };
    const rlA = await releaseCon('El que espera el candado', elA);
    const rlB = await releaseCon('El que se cuela', elB);

    // Se retiene el candado del release A hasta que la constatación de A esté esperándolo.
    let listo!: () => void;
    const tomado = new Promise<void>((r) => (listo = r));
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const reteniendo = conUsuario(leadId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('designio:release:' || ${rlA}, 42))`;
      listo();
      await espera;
    });
    await tomado;

    const constatarA = constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rlA,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: 'La que empezó antes',
      constataciones: [
        { elementoId: elA, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
      ],
    });
    try {
      // Con su `now()` ya fijado y sin número todavía.
      expect(await siguePendiente(constatarA)).toBe(true);
      // B entra entera mientras A espera: se lleva ES-1 con un sello POSTERIOR.
      await constatarEffectiveState(leadId, {
        workspaceId: ws,
        releaseId: rlB,
        constatadoEn: HOY,
        desfaseUtcMinutos: 0,
        resumen: 'La que empezó después',
        constataciones: [
          {
            elementoId: elB,
            resultado: 'desviado',
            queQuedoDistinto: 'Quedó distinto',
            razon: 'Lo dice la que numeró primero',
          },
        ],
      });
    } finally {
      liberar();
    }
    await reteniendo;
    await constatarA;

    // La inversión existe de verdad: A numeró DESPUÉS y su sello es ANTERIOR. Los números
    // concretos no se fijan —la serie es del workspace y otros tests ya gastaron códigos—,
    // se comprueba la RELACIÓN, que es lo que el desempate mira.
    const [inversion] = await admin`
      select (select codigo from effective_state where release_id = ${rlA}) as codigo_a,
             (select codigo from effective_state where release_id = ${rlB}) as codigo_b,
             (select numero_de_serie(codigo) from effective_state where release_id = ${rlA})
               > (select numero_de_serie(codigo) from effective_state where release_id = ${rlB})
                 as numero_posterior,
             (select creado_en from effective_state where release_id = ${rlA})
               < (select creado_en from effective_state where release_id = ${rlB}) as sello_anterior`;
    expect(inversion!.numero_posterior).toBe(true);
    expect(inversion!.sello_anterior).toBe(true);

    // Y ahora lo que importa: el pliegue tiene que aplicar ES-1 y luego ES-2, así que gana
    // la constatación de A. Ordenando por el sello ganaba la de B.
    const dv2 = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La que lee la historia',
      resumen: '',
      superaA: dv1.designVersionId,
    });
    const vista = await designVersionCompleta(leadId, ws, dv2.designVersionId);
    // El ES vigente es el ÚLTIMO de la serie, no el del sello más nuevo.
    expect(vista!.vigente!.codigo).toBe(inversion!.codigo_a as string);
    // La historia llega en orden de serie…
    expect(vista!.vigente!.constataciones.map((c) => c.elementoId)).toEqual([elB, elA]);
    // …y por tanto el pliegue deja vigente lo que dijo la ÚLTIMA de la serie.
    const plegado = [...plegarEstadoVigente(vista!.vigente!.constataciones).values()];
    expect(plegado).toHaveLength(1);
    expect(plegado[0]!.elementoId).toBe(elA);
    expect(plegado[0]!.resultado).toBe('como-aprobado');
  });

  it('la fecha se juzga en el calendario de QUIEN ESCRIBE, no en el de la base (RF-06.5, RF-06.6)', async () => {
    // «No puede ser futura» no significa nada sin decir «futura ¿en qué calendario?», y las
    // dos mitades contestaban distinto: la pantalla propone el día LOCAL del usuario y el
    // guard lo juzgaba contra el de la BASE. Al este de UTC, pasada la medianoche local, la
    // fecha correcta se rechazaba por futura y al usuario solo le quedaba escribir AYER —
    // sobre escrituras inmutables, así que el día equivocado se queda y encima reordena el
    // effective state vigente del servicio (RF-06.10).
    const admin = sqlAdmin();

    // «Hoy» en un huso dado, compuesto como lo compone la pantalla: la hora UTC desplazada.
    const hoyEn = (min: number) => new Date(Date.now() + min * 60_000).toISOString().slice(0, 10);
    const siguiente = (f: string) => {
      const d = new Date(`${f}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const hoyDeLaBase = (desfase: number): Promise<string> =>
      admin.begin(async (tx) => {
        await tx`select set_config('app.desfase_utc_minutos', ${String(desfase)}, true)`;
        const [f] = await tx`select to_char(hoy_del_cliente(), 'YYYY-MM-DD') as hoy`;
        return f!.hoy as string;
      }) as Promise<string>;

    // La propiedad que faltaba: las dos mitades contestan lo MISMO en cada calendario.
    for (const desfase of [-720, -300, 0, 120, 330, 840]) {
      expect(await hoyDeLaBase(desfase)).toBe(hoyEn(desfase));
    }
    // Un desfase que no es de este mundo no regala días: se acota a los husos reales.
    expect(await hoyDeLaBase(100_000)).toBe(hoyEn(840));
    expect(await hoyDeLaBase(-100_000)).toBe(hoyEn(-720));
    // Y quien no declara calendario se juzga en el de la base, como siempre.
    const [sinDeclarar] = await admin`select to_char(hoy_del_cliente(), 'YYYY-MM-DD') as hoy`;
    expect(sinDeclarar!.hoy as string).toBe(hoyEn(0));

    // Y el guard de punta a punta, en el huso más adelantado que existe: su HOY se acepta
    // —aunque en UTC pueda ser todavía mañana— y su MAÑANA se sigue rechazando, que es la
    // mitad de la regla que no se puede perder al arreglar la otra.
    const proy = await proyectoConGates('P-124', 'Proyecto del calendario');
    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del calendario');
    const dv = await crearDesignVersion(leadId, {
      workspaceId: ws,
      proyectoId: proy,
      servicioId: svcId,
      journeyId,
      titulo: 'La del calendario',
      resumen: '',
      superaA: null,
    });
    const el = await elementoSuelto(dv.designVersionId, 'Elemento del calendario');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    const rl = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      titulo: 'El del calendario',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: el, razon: '' }],
    });

    const desfase = 840;
    const hoyDelCliente = hoyEn(desfase);

    await expect(
      desplegarRelease(leadId, {
        workspaceId: ws,
        releaseId: rl.releaseId,
        desplegadoEn: siguiente(hoyDelCliente),
        desfaseUtcMinutos: desfase,
      }),
    ).rejects.toThrow(/futura/);
    await desplegarRelease(leadId, {
      workspaceId: ws,
      releaseId: rl.releaseId,
      desplegadoEn: hoyDelCliente,
      desfaseUtcMinutos: desfase,
    });

    // La constatación es la otra fecha inmutable y va por el mismo camino.
    const constatacion = { elementoId: el, resultado: 'como-aprobado' as const, queQuedoDistinto: '', razon: '' };
    await expect(
      constatarEffectiveState(leadId, {
        workspaceId: ws,
        releaseId: rl.releaseId,
        constatadoEn: siguiente(hoyDelCliente),
        desfaseUtcMinutos: desfase,
        resumen: '',
        constataciones: [constatacion],
      }),
    ).rejects.toThrow(/futura/);
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rl.releaseId,
      constatadoEn: hoyDelCliente,
      desfaseUtcMinutos: desfase,
      resumen: '',
      constataciones: [constatacion],
    });
  });

  it('el proyecto que firmó su G6 antes de esta migración no se queda encerrado', async () => {
    // `design_version` NACE en esta migración, así que ningún proyecto tenía una cuando
    // aprobó su G6 — cosa perfectamente legal entonces. Sin perdón, el guard de alta le
    // prohíbe crear la primera («ya certificó») y G7 le exige una con elementos: encerrado
    // para siempre, y la salida del mensaje no le sirve porque el G7 que necesita es el
    // suyo. Este test va el ÚLTIMO de los que tocan gates a propósito: ejecuta el update de
    // la migración tal cual, y ese alcanza a todas las aprobaciones que ya existan.
    const admin = sqlAdmin();
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-112', 'Proyecto anterior al esquema', ${leadId}) returning id`;
    const proy = p!.id as string;
    // La forma HEREDADA, fabricada: los gates nacen ya aprobados, que es como se veían las
    // filas de antes. Se insertan en ese estado y no se actualizan porque un UPDATE pasaría
    // por el guard de suficiencia — y ese, con las reglas nuevas, es justo el que no las
    // habría dejado aprobarse.
    for (let n = 0; n <= 7; n++) {
      const [g] = await admin`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
        values (${ws}, ${proy}, ${n}, ${[0, 3, 5, 6].includes(n) ? 'sponsor' : 'lead-boutique'},
                ${n <= 6 ? 'aprobado' : 'pendiente'},
                ${n <= 6 ? leadId : null}, ${n <= 6 ? new Date() : null})
        returning id`;
      await admin`insert into checklist_item
        (workspace_id, gate_id, orden, texto, estado, na_justificacion, na_aprobado_por)
        values (${ws}, ${g!.id as string}, 0, 'Ítem del test', 'na', 'fuera de alcance del test',
                ${leadId})`;
    }

    const { servicioId: svcId, journeyId } = await servicioConToBe('Servicio del proyecto heredado');
    const alta = () =>
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId: proy,
        servicioId: svcId,
        journeyId,
        titulo: 'La primera del proyecto heredado',
        resumen: '',
        superaA: null,
      });

    // Antes del perdón, encerrado: es el estado en el que quedaría al desplegar.
    await expect(alta()).rejects.toThrow(/ya certificó G6/);

    // El perdón es el UPDATE de la migración, leído del propio archivo y ejecutado tal cual:
    // si lo reescribiera aquí, el test aprobaría una regla que no es la que se despliega.
    const migracion = readFileSync('db/migrations/20260902120000-design-version.sql', 'utf8');
    const bloque = migracion
      .split('-- perdon-historico:inicio')[1]!
      .split('-- perdon-historico:fin')[0]!
      .trim();
    expect(bloque).toMatch(/^update gate_instancia g set previo_a_design_version = true/);
    await admin.unsafe(bloque);

    // Y ahora el proyecto redacta su versión y llega a G7 por el camino normal, con todos
    // los guards en pie: el perdón es del MOMENTO, no del contenido.
    const dv = await alta();
    const el = await elementoSuelto(dv.designVersionId, 'Lo que el proyecto heredado declara');
    await aprobarDesignVersion(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      motivo: '',
    });
    const rl = await planificarRelease(leadId, {
      workspaceId: ws,
      designVersionId: dv.designVersionId,
      titulo: 'El plan del proyecto heredado',
      responsable: 'Equipo',
      fechaObjetivo: HOY,
      elementos: [{ elementoId: el, razon: '' }],
    });
    // Y puede CORREGIR su plan, no solo empezarlo. El guard de cobertura pregunta por la
    // certificación con la misma función que la define, así que respeta el perdón igual: si
    // decidiera por su cuenta mirando «G6 aprobado», el proyecto perdonado podría asignar el
    // elemento y ya no podría sacarlo — justo la capacidad que el perdón viene a devolverle.
    await desasignarElemento(leadId, ws, el);
    await asignarElemento(leadId, {
      workspaceId: ws,
      releaseId: rl.releaseId,
      elementoId: el,
      razon: 'se vuelve a colocar',
    });

    const aprobarG7 = () =>
      admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}
        where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 7`;
    // G7 no se regala: sigue exigiendo el tablero completo.
    await expect(aprobarG7()).rejects.toThrow(/en estado desconocido/);
    await desplegarRelease(leadId, { workspaceId: ws, releaseId: rl.releaseId, desplegadoEn: HOY, desfaseUtcMinutos: 0 });
    await constatarEffectiveState(leadId, {
      workspaceId: ws,
      releaseId: rl.releaseId,
      constatadoEn: HOY,
      desfaseUtcMinutos: 0,
      resumen: '',
      constataciones: [
        { elementoId: el, resultado: 'como-aprobado', queQuedoDistinto: '', razon: '' },
      ],
    });
    await aprobarG7();
    const [g7] = await admin`select estado from gate_instancia
      where proyecto_id = ${proy} and workspace_id = ${ws} and numero = 7`;
    expect(g7!.estado).toBe('aprobado');

    // Y no es puerta trasera: la marca no la puede poner el rol de la app. La columna está
    // fuera del grant, que en gate_instancia es por columnas.
    await expect(
      conUsuario(leadId, (tx) => tx`update gate_instancia set previo_a_design_version = true
        where proyecto_id = ${proy} and workspace_id = ${ws}`),
    ).rejects.toThrow(/permission denied/);

    // EL CASO HERMANO, que es el que sujeta el perdón por arriba: un proyecto heredado que
    // ya había aprobado su G7 sigue CERTIFICADO. Su G7 es una certificación emitida y no
    // puede volver a correr, así que dejarle crear design versions nuevas por debajo sería
    // aflojarla — peor que el encierro que esto viene a deshacer. Se queda como está: sin
    // design version y sin poder crear ninguna. Deuda declarada, no agujero.
    const [pCerrado] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-113', 'Proyecto heredado ya cerrado', ${leadId}) returning id`;
    const proyCerrado = pCerrado!.id as string;
    for (let n = 0; n <= 7; n++) {
      await admin`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
        values (${ws}, ${proyCerrado}, ${n},
                ${[0, 3, 5, 6].includes(n) ? 'sponsor' : 'lead-boutique'},
                'aprobado', ${leadId}, ${new Date()})`;
    }
    // El perdón se ejecuta OTRA VEZ, tal cual: es idempotente y este proyecto no entra.
    await admin.unsafe(bloque);
    const [g6Cerrado] = await admin`select previo_a_design_version from gate_instancia
      where proyecto_id = ${proyCerrado} and workspace_id = ${ws} and numero = 6`;
    expect(g6Cerrado!.previo_a_design_version).toBe(false);

    const { servicioId: svcCerrado, journeyId: jCerrado } =
      await servicioConToBe('Servicio del proyecto ya cerrado');
    await expect(
      crearDesignVersion(leadId, {
        workspaceId: ws,
        proyectoId: proyCerrado,
        servicioId: svcCerrado,
        journeyId: jCerrado,
        titulo: 'La que no debe nacer bajo un ciclo cerrado',
        resumen: '',
        superaA: null,
      }),
    ).rejects.toThrow(/ya certificó G6/);
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
