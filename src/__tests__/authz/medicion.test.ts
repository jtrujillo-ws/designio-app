import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TransactionSql } from 'postgres';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  activarReto,
  agregarCriterio,
  aprobarGate,
  crearReto,
  ErrorMetodo,
  marcarItem,
  proyectoMetodo,
} from '@/lib/metodo/metodo.servicio';
import {
  abrirMedicion,
  abrirOutcomeReview,
  abrirRegistry,
  agregarEntrada,
  cargarSnapshotsCsv,
  completarOutcomeReview,
  editarEntrada,
  ErrorMedicion,
  firmarRegistry,
  registrarResultado,
  registrarSnapshot,
  seguimientoDeImpacto,
} from '@/lib/medicion/medicion.servicio';
import {
  medicionPorAbrir,
  postMortemPorAbrir,
  ResultadoCriterioSchema,
  ventanasCerradas,
} from '@/lib/medicion/medicion.schemas';
import { reabrirEtapa } from '@/lib/metodo/gobernanza.servicio';
import { describeAuthz } from './helpers';

/**
 * SPEC-07 — medición temporal e impacto: Metric Registry firmado en G6 y congelado
 * (SYS-22), snapshots append-only por formulario y CSV (SYS-23), outcome review que no
 * se habilita antes de cerrar la ventana y veredicto del catálogo cerrado que cierra
 * reto y proyecto (SYS-24, SYS-08).
 */
describeAuthz('medición: registry, snapshots y outcome review', () => {
  const marca = `med-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let leadId = '';
  let sponsorId = '';
  let stakeId = '';
  let sponsorMiembroId = '';
  let stakeMiembroId = '';
  let disMiembroId = '';
  let svcId = '';
  let retoId = '';
  let proyectoId = '';
  let evidenciaId = '';
  let registryId = '';
  let criterioAbandonoId = '';
  let criterioReintentosId = '';
  let objetivoReintentosPrevio = '';
  let criterioAjenoId = '';
  let entradaAbandonoId = '';
  let entradaReintentosId = '';
  let reviewId = '';
  // Proyecto que simula haber pasado G6 ANTES de que este esquema existiera.
  let retoHeredadoId = '';
  let proyectoHeredadoId = '';
  let criterioHeredadoId = '';
  let registryHeredadoId = '';
  // Reto que YA venía midiendo fuera del sistema: su entrada es la única MENSUAL sin serie
  // propia, así que es donde se fija la aritmética de calendario de la cadencia.
  let proyectoViejoId = '';
  let entradaViejaId = '';

  /**
   * Corre `accion` mientras OTRA sesión retiene algo durante 300 ms, y responde si tuvo
   * que esperar a que lo soltara. Es la forma de probar un candado sin simular la carrera
   * —eso sería no determinista—: se espera a que la retención esté TOMADA antes de lanzar
   * al contendiente, así que lo que se mide es quién espera a quién y no quién abrió
   * antes su conexión. El resultado de `accion` da igual: puede fallar por su motivo de
   * dominio y aun así haber esperado.
   */
  async function esperaA(
    retener: (tx: TransactionSql) => Promise<unknown>,
    accion: () => Promise<unknown>,
  ): Promise<boolean> {
    let soltado = false;
    let avisarTomado = () => {};
    const tomado = new Promise<void>((resolve) => {
      avisarTomado = resolve;
    });
    const reteniendo = sqlAdmin().begin(async (tx) => {
      await retener(tx);
      avisarTomado();
      await new Promise((resolve) => setTimeout(resolve, 300));
      soltado = true;
    });
    await tomado;
    const espero = await accion().then(
      () => soltado,
      () => soltado,
    );
    await reteniendo;
    return espero;
  }

  /** Fecha calendárica relativa a la de la BASE. El test del último día de la ventana
   * compara días EXACTOS (cero restantes), y ahí un desfase de huso entre el proceso y el
   * servidor movería el corte justo en el caso que se quiere fijar. */
  async function fechaDeBase(dias: number): Promise<string> {
    const [f] = await sqlAdmin()`select (current_date + ${dias}::int)::text as f`;
    return f!.f as string;
  }

  /** Fecha CALENDÁRICA relativa a hoy (AAAA-MM-DD): los márgenes de los tests son de
   * varios días, así que un desfase de huso entre el proceso y la base no los mueve. */
  function fecha(dias: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }

  /** Deja el checklist de un gate limpio y lo aprueba con SU rol aprobador. */
  async function aprobarGateNumero(numero: number, deProyecto = ''): Promise<void> {
    const p = await proyectoMetodo(leadId, ws, deProyecto === '' ? proyectoId : deProyecto);
    const gate = p!.gates[numero]!;
    for (const item of gate.items) {
      if (item.estado === 'cumplido') continue;
      await marcarItem(leadId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: evidenciaId },
      });
    }
    const quien = gate.rolAprobador === 'sponsor' ? sponsorId : leadId;
    await aprobarGate(quien, { workspaceId: ws, gateId: gate.id });
  }

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;

    const personas = [
      ['lead', 'lead-boutique'],
      ['dis', 'disenador'],
      ['sponsor', 'sponsor'],
      ['stake', 'stakeholder'],
    ] as const;
    for (const [alias, rol] of personas) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
      if (alias === 'sponsor') sponsorId = id;
      if (alias === 'stake') stakeId = id;
      const [m] = await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, ${alias}, ${`${marca}-${alias}@test.demo`}, ${rol}) returning id`;
      // El propietario del DATO es una persona del cliente (RF-07.1): aquí, el sponsor.
      // El diseñador está para probar justamente que la boutique NO puede serlo.
      if (alias === 'sponsor') sponsorMiembroId = m!.id as string;
      if (alias === 'stake') stakeMiembroId = m!.id as string;
      if (alias === 'dis') disMiembroId = m!.id as string;
    }

    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, ${marca + ' Servicio'}, ${leadId}) returning id`;
    svcId = svc!.id as string;

    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente medición', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Evidencia medición', '{}'::jsonb, ${leadId})
      returning id`;
    evidenciaId = ev!.id as string;

    // Reto activo con su método y DOS criterios de éxito con ventana propia (SYS-22).
    const r = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-70',
      titulo: 'Reducir el abandono en la apertura',
      descripcion: '',
      origen: 'peticion-cliente',
      metricaObjetivo: '62→40',
      serviciosAfectados: [],
    });
    retoId = r.retoId;
    const act = await activarReto(leadId, {
      workspaceId: ws,
      retoId,
      perfil: 'rapido',
      proyectoCodigo: 'P-70',
      proyectoTitulo: 'Rediseño de la verificación',
    });
    proyectoId = act.proyectoId;

    const c1 = await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId,
      kpi: 'Abandono en verificación',
      definicion: 'Porcentaje que inicia la verificación y no la completa',
      lineaBaseValor: '62',
      lineaBaseFecha: fecha(-120),
      lineaBasePlan: '',
      objetivo: '40',
      // 31 y no 30 porque su entrada se compromete a una cadencia MENSUAL y la firma exige
      // que quepa un mes de CALENDARIO desde el inicio de la ventana: con 30 días el
      // contrato pasaría o fallaría según el mes en que corriese la suite, que es
      // exactamente la aritmética que este slice dejó de usar.
      ventanaDias: 31,
      fechaPostMortem: null,
    });
    criterioAbandonoId = c1.criterioId;
    const c2 = await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId,
      kpi: 'Reintentos por solicitud',
      definicion: 'Intentos medios hasta completar la verificación',
      lineaBaseValor: '2.4',
      lineaBaseFecha: fecha(-120),
      lineaBasePlan: '',
      objetivo: '1.5',
      ventanaDias: 60,
      fechaPostMortem: null,
    });
    criterioReintentosId = c2.criterioId;
    // Con el G0 todavía pendiente y sin registry, el criterio se corrige. Esta corrección
    // la comprueba después el recorrido del rastro: `objetivo` es la promesa contra la que
    // se dicta el veredicto y el evento la perdía, igual que perdía `ventana_dias`.
    objetivoReintentosPrevio = '1.5';
    await conUsuario(leadId, (tx) => tx`update criterio_exito set objetivo = '1.2'
      where id = ${criterioReintentosId} and workspace_id = ${ws}`);
    await aprobarGateNumero(0);
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    if (ws) {
      await admin`delete from resultado_criterio where workspace_id = ${ws}`;
      await admin`delete from outcome_review where workspace_id = ${ws}`;
      await admin`delete from snapshot where workspace_id = ${ws}`;
      await admin`delete from entrada_kpi where workspace_id = ${ws}`;
      await admin`delete from metric_registry where workspace_id = ${ws}`;
      await admin`delete from evento_dominio where workspace_id = ${ws}`;
      await admin`delete from checklist_item where workspace_id = ${ws}`;
      await admin`delete from gate_instancia where workspace_id = ${ws}`;
      await admin`delete from etapa_instancia where workspace_id = ${ws}`;
      await admin`delete from criterio_exito where workspace_id = ${ws}`;
      await admin`delete from reapertura_insight where workspace_id = ${ws}`;
      await admin`delete from reapertura_etapa where workspace_id = ${ws}`;
      await admin`delete from proyecto where workspace_id = ${ws}`;
      await admin`delete from reto_servicio_afectado where workspace_id = ${ws}`;
      await admin`delete from reto where workspace_id = ${ws}`;
      await admin`delete from evidencia where workspace_id = ${ws}`;
      await admin`delete from fuente where workspace_id = ${ws}`;
      await admin`delete from servicio where workspace_id = ${ws}`;
      await admin`delete from miembro where workspace_id = ${ws}`;
      await admin`delete from workspace where id = ${ws}`;
    }
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  it('el registry lo abren los curadores sobre un reto activo; el stakeholder no', async () => {
    await expect(abrirRegistry(stakeId, { workspaceId: ws, retoId })).rejects.toThrow(ErrorMedicion);

    const r = await abrirRegistry(leadId, { workspaceId: ws, retoId });
    registryId = r.registryId;

    // 1:1 con el reto (RF-07.1): un segundo contrato de medición no existe.
    await expect(abrirRegistry(leadId, { workspaceId: ws, retoId })).rejects.toThrow(
      /ya tiene su Metric Registry/,
    );
  });

  it('cada entrada KPI responde a un criterio del MISMO reto y el stakeholder no la escribe', async () => {
    const a = await agregarEntrada(leadId, {
      workspaceId: ws,
      registryId,
      criterioId: criterioAbandonoId,
      nombre: 'Abandono %',
      definicion: 'Solicitudes abandonadas / iniciadas, canal digital',
      fuente: 'Panel de embudo del core bancario',
      dimensiones: 'canal, segmento',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'mensual',
      dashboardUrl: 'https://dashboards.bancoandino.demo/embudo',
      lineaBaseValor: '62',
      lineaBaseFecha: fecha(-120),
      ventanaInicio: fecha(-10),
      fechaPostMortem: fecha(40),
    });
    entradaAbandonoId = a.entradaId;

    // Un criterio de OTRO reto no es referenciable: mediría otra promesa.
    const ajeno = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-71',
      titulo: 'Otro reto',
      descripcion: '',
      origen: 'post-mortem',
      metricaObjetivo: '',
      serviciosAfectados: [],
    });
    const criterioAjeno = await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId: ajeno.retoId,
      kpi: 'KPI ajeno',
      definicion: 'de otro reto',
      lineaBaseValor: '1',
      lineaBaseFecha: fecha(-30),
      lineaBasePlan: '',
      objetivo: '0',
      ventanaDias: 30,
      fechaPostMortem: null,
    });
    criterioAjenoId = criterioAjeno.criterioId;
    await expect(
      agregarEntrada(leadId, {
        workspaceId: ws,
        registryId,
        criterioId: criterioAjenoId,
        nombre: 'KPI colado',
        definicion: '',
        fuente: '',
        dimensiones: '',
        propietarioMiembroId: null,
        frecuencia: 'mensual',
        dashboardUrl: '',
        lineaBaseValor: null,
        lineaBaseFecha: null,
        ventanaInicio: null,
        fechaPostMortem: null,
      }),
    ).rejects.toThrow(/el criterio no es de este reto/);

    // El stakeholder lee el registry pero no lo escribe.
    const visto = await conUsuario(stakeId, (tx) => tx`select id from entrada_kpi
      where id = ${entradaAbandonoId} and workspace_id = ${ws}`);
    expect(visto.length).toBe(1);
    await expect(
      agregarEntrada(stakeId, {
        workspaceId: ws,
        registryId,
        criterioId: criterioReintentosId,
        nombre: 'KPI del stakeholder',
        definicion: '',
        fuente: '',
        dimensiones: '',
        propietarioMiembroId: null,
        frecuencia: 'mensual',
        dashboardUrl: '',
        lineaBaseValor: null,
        lineaBaseFecha: null,
        ventanaInicio: null,
        fechaPostMortem: null,
      }),
    ).rejects.toThrow(/Sin permiso|row-level security|no puedes editarlo/);
  });

  it('el registry se firma EN G6: ni antes de los gates anteriores ni por otro rol', async () => {
    // «Se firma en G6» con G1-G5 pendientes es firmar en el kickoff.
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /faltan los gates anteriores \(G1, G2, G3, G4, G5\)/,
    );
    for (const numero of [1, 2, 3, 4, 5]) {
      await aprobarGateNumero(numero);
    }
    // El lead opera el método, pero el COMPROMISO del dato es del cliente: firma el rol
    // aprobador de G6 (sponsor, §13.2).
    await expect(firmarRegistry(leadId, { workspaceId: ws, registryId })).rejects.toThrow(
      /Solo el rol sponsor firma/,
    );
  });

  it('firmar exige contrato COMPLETO: criterio sin KPI, entrada incompleta o post-mortem prematuro', async () => {
    // Un criterio de éxito sin KPI que lo responda garantiza un «no concluyente».
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /criterios sin entrada KPI \(SYS-22\): Reintentos por solicitud/,
    );

    const b = await agregarEntrada(leadId, {
      workspaceId: ws,
      registryId,
      criterioId: criterioReintentosId,
      nombre: 'Reintentos medios',
      definicion: 'Media de intentos por solicitud completada',
      fuente: 'Log de verificación',
      dimensiones: '',
      // Sin propietario del dato: la firma debe rechazarlo (RF-07.4).
      propietarioMiembroId: null,
      frecuencia: 'semanal',
      dashboardUrl: '',
      lineaBaseValor: '2.4',
      lineaBaseFecha: fecha(-120),
      ventanaInicio: fecha(-5),
      fechaPostMortem: fecha(90),
    });
    entradaReintentosId = b.entradaId;
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /entradas incompletas \(SYS-22\): Reintentos medios/,
    );

    // Post-mortem previsto ANTES del cierre de la ventana: comprometerse a un veredicto
    // sobre datos que aún no existen.
    await editarEntrada(leadId, {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      criterioId: criterioReintentosId,
      nombre: 'Reintentos medios',
      definicion: 'Media de intentos por solicitud completada',
      fuente: 'Log de verificación',
      dimensiones: '',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'semanal',
      dashboardUrl: '',
      lineaBaseValor: '2.4',
      lineaBaseFecha: fecha(-120),
      ventanaInicio: fecha(-5),
      fechaPostMortem: fecha(10),
    });
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /el post-mortem se prevé después del cierre de la ventana/,
    );
    // Y «después» es ESTRICTO: fecharlo EL DÍA del cierre promete para hoy un veredicto
    // que el sistema no dejará dictar hasta mañana, porque ese día todavía se mide. La
    // ventana de este criterio es [-5, +55] (60 días), así que el 55 tampoco vale.
    await editarEntrada(leadId, {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      criterioId: criterioReintentosId,
      nombre: 'Reintentos medios',
      definicion: 'Media de intentos por solicitud completada',
      fuente: 'Log de verificación',
      dimensiones: '',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'semanal',
      dashboardUrl: '',
      lineaBaseValor: '2.4',
      lineaBaseFecha: fecha(-120),
      ventanaInicio: fecha(-5),
      fechaPostMortem: fecha(55),
    });
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /el post-mortem se prevé después del cierre de la ventana/,
    );
    await editarEntrada(leadId, {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      criterioId: criterioReintentosId,
      nombre: 'Reintentos medios',
      definicion: 'Media de intentos por solicitud completada',
      fuente: 'Log de verificación',
      dimensiones: '',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'semanal',
      dashboardUrl: '',
      lineaBaseValor: '2.4',
      lineaBaseFecha: fecha(-120),
      ventanaInicio: fecha(-5),
      fechaPostMortem: fecha(90),
    });
  });

  it('completo no es lo mismo que COHERENTE: la firma rechaza el contrato imposible', async () => {
    // El test anterior comprueba que los campos ESTÉN. Estos dos comprueban que digan algo
    // posible ENTRE SÍ: un contrato con todos los huecos rellenos puede seguir siendo
    // imposible de cumplir, y firmarlo lo congela sin reparación posible.
    const reintentos = {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      criterioId: criterioReintentosId,
      nombre: 'Reintentos medios',
      definicion: 'Media de intentos por solicitud completada',
      fuente: 'Log de verificación',
      dimensiones: '',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'semanal' as const,
      dashboardUrl: '',
      lineaBaseValor: '2.4',
      lineaBaseFecha: fecha(-120),
      ventanaInicio: fecha(-5),
      fechaPostMortem: fecha(90),
    };

    // 1. La línea base es el ANTES de lo que se mide, así que no puede estar fechada
    // después de que la medición empiece. Firmado el contrato, los snapshots quedan
    // acotados a la ventana mientras la proyección y el post-mortem los comparan contra una
    // «línea base» cronológicamente posterior: la historia base→resultado, al revés.
    await editarEntrada(leadId, { ...reintentos, lineaBaseFecha: fecha(-1) });
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /la línea base es posterior al inicio de la ventana/,
    );

    // 2. Y la cadencia comprometida tiene que CABER en la ventana al menos una vez: una
    // entrada trimestral sobre una ventana de 60 días promete una entrega que vence
    // después del cierre, así que no llega ninguna y el post-mortem la lee «vencida» por
    // construcción — un «no concluyente» pactado de antemano, que es justo lo que la firma
    // existe para impedir.
    //
    // Va con la línea base EN el día que abre la ventana, y eso prueba de paso el borde de
    // la regla anterior: ese día todavía es el «antes» de la primera medición, así que si
    // el corte fuera estricto el rechazo hablaría de la línea base y no de la cadencia.
    await editarEntrada(leadId, {
      ...reintentos,
      lineaBaseFecha: fecha(-5),
      frecuencia: 'trimestral',
    });
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /la cadencia comprometida no cabe en la ventana del criterio/,
    );

    // 3. Y «caber» se mide con la MISMA aritmética con la que después se juzga la cadencia:
    // CALENDARIO, no un largo mínimo en días. Un mínimo fijo (28 días un mes) es una
    // segunda verdad sobre el mismo compromiso, y basta que discrepe una vez para que la
    // firma bendiga lo que la lectura llamará vacío. Con fechas ABSOLUTAS, porque el caso
    // vive justo en el día de diferencia: mensual desde el 1 de agosto con ventana de 29
    // días cierra el 30 de agosto y su primera entrega vence el 1 de septiembre — dos días
    // después. El mínimo lo aceptaba (29 ≥ 28) y lo congelaba.
    const adminCadencia = sqlAdmin();
    await adminCadencia`update criterio_exito set ventana_dias = 29
      where id = ${criterioReintentosId}`;
    const agosto = {
      ...reintentos,
      frecuencia: 'mensual' as const,
      lineaBaseFecha: '2026-06-01',
      ventanaInicio: '2026-08-01',
      fechaPostMortem: '2026-09-15',
    };
    await editarEntrada(leadId, agosto);
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /la cadencia comprometida no cabe en la ventana del criterio/,
    );

    // Y el borde por el otro lado, que es lo que separa la regla de una prohibición: con un
    // día más la ventana cierra el 1 de septiembre —el día en que vence la primera entrega,
    // y el último día de la ventana todavía mide—, así que el compromiso SÍ se puede
    // cumplir. Se comprueba por el MOTIVO y sin firmar, que aquí congelaría el contrato que
    // los tests siguientes necesitan en borrador: con el post-mortem fechado DENTRO de la
    // ventana, el rechazo que llega es el suyo — señal de que la cadencia ya pasó.
    await adminCadencia`update criterio_exito set ventana_dias = 31
      where id = ${criterioReintentosId}`;
    await editarEntrada(leadId, { ...agosto, fechaPostMortem: '2026-08-20' });
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /el post-mortem se prevé después del cierre de la ventana/,
    );

    // Y se deja el contrato como estaba, que es el que firman los tests siguientes.
    await adminCadencia`update criterio_exito set ventana_dias = 60
      where id = ${criterioReintentosId}`;
    await editarEntrada(leadId, reintentos);
  });

  it('el dueño del dato es una PERSONA DEL CLIENTE: al escribir la entrada y al firmar', async () => {
    // El compromiso del dato es del cliente (RF-07.1, §8.1): con un lead o un diseñador
    // como dueño, el registry firmado dice que la boutique se compromete consigo misma a
    // transcribir — exactamente lo que G6 existe para sustituir.
    const admin = sqlAdmin();

    // 1) El servidor no OFRECE lo que la base rechaza: el selector del seguimiento trae
    //    solo el lado cliente, así que el error normal ni se puede cometer.
    const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
    expect(seg!.propietariosPosibles.map((m) => m.rol).sort()).toEqual(['sponsor', 'stakeholder']);
    expect(seg!.propietariosPosibles.some((m) => m.id === disMiembroId)).toBe(false);

    // 2) Y si se pide igualmente, la política de la entrada dice que no — al crear…
    await expect(
      agregarEntrada(leadId, {
        workspaceId: ws,
        registryId,
        criterioId: criterioAbandonoId,
        nombre: 'KPI con dueño de la boutique',
        definicion: 'x',
        fuente: 'x',
        dimensiones: '',
        propietarioMiembroId: disMiembroId,
        frecuencia: 'mensual',
        dashboardUrl: '',
        lineaBaseValor: '1',
        lineaBaseFecha: fecha(-120),
        ventanaInicio: fecha(-10),
        fechaPostMortem: fecha(40),
      }),
    ).rejects.toThrow(/dueño del dato/);
    // …y al editar (aquí el rechazo solo puede ser este: el USING ya validó rol y
    // borrador, y el criterio de la entrada no se edita).
    await expect(
      editarEntrada(leadId, {
        workspaceId: ws,
        entradaId: entradaReintentosId,
        criterioId: criterioReintentosId,
        nombre: 'Reintentos medios',
        definicion: 'Media de intentos por solicitud completada',
        fuente: 'Log de verificación',
        dimensiones: '',
        propietarioMiembroId: disMiembroId,
        frecuencia: 'semanal',
        dashboardUrl: '',
        lineaBaseValor: '2.4',
        lineaBaseFecha: fecha(-120),
        ventanaInicio: fecha(-5),
        fechaPostMortem: fecha(90),
      }),
    ).rejects.toThrow(/persona del cliente/);
    // Y por SQL directo tampoco: quien manda es el WITH CHECK, no el mensaje.
    await expect(
      conUsuario(leadId, (tx) => tx`update entrada_kpi
        set propietario_miembro_id = ${disMiembroId} where id = ${entradaAbandonoId}`),
    ).rejects.toThrow(/row-level security/);
    const [intacto] = await conUsuario(leadId, (tx) => tx`select propietario_miembro_id
      from entrada_kpi where id = ${entradaAbandonoId}`);
    expect(intacto!.propietario_miembro_id).toBe(sponsorMiembroId);

    // 3) La firma lo vuelve a exigir, y no por redundancia: la entrada guarda una
    //    REFERENCIA al miembro, no una copia de su rol, y entre redactar el registry y
    //    firmarlo en G6 pasan semanas. Aquí se simula que la persona comprometida cambió
    //    de lado en ese intervalo: lo que el contrato afirma es lo que sea cierto cuando
    //    se congela, así que el guard lo comprueba en ese momento y no antes.
    await editarEntrada(leadId, {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      criterioId: criterioReintentosId,
      nombre: 'Reintentos medios',
      definicion: 'Media de intentos por solicitud completada',
      fuente: 'Log de verificación',
      dimensiones: '',
      propietarioMiembroId: stakeMiembroId,
      frecuencia: 'semanal',
      dashboardUrl: '',
      lineaBaseValor: '2.4',
      lineaBaseFecha: fecha(-120),
      ventanaInicio: fecha(-5),
      fechaPostMortem: fecha(90),
    });
    await admin`update miembro set rol = 'disenador' where id = ${stakeMiembroId}`;
    try {
      await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
        /persona del cliente \(RF-07\.1\): Reintentos medios/,
      );
    } finally {
      await admin`update miembro set rol = 'stakeholder' where id = ${stakeMiembroId}`;
    }
    // Se devuelve el compromiso al sponsor, que es quien lo sostiene en el resto del ciclo.
    await editarEntrada(leadId, {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      criterioId: criterioReintentosId,
      nombre: 'Reintentos medios',
      definicion: 'Media de intentos por solicitud completada',
      fuente: 'Log de verificación',
      dimensiones: '',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'semanal',
      dashboardUrl: '',
      lineaBaseValor: '2.4',
      lineaBaseFecha: fecha(-120),
      ventanaInicio: fecha(-5),
      fechaPostMortem: fecha(90),
    });
  });

  it('en borrador, el criterio del KPI se CORRIGE: es el error fácil y no hay borrado', async () => {
    // Elegir el criterio equivocado al crear el KPI no tenía reparación: el selector lo
    // bloqueaba al editar, `criterio_id` estaba fuera del grant de update y `entrada_kpi`
    // no tiene política ni grant de DELETE. La única salida era firmar el contrato con un
    // KPI que mide una promesa que nadie hizo — y no es una etiqueta: del criterio sale
    // `ventana_dias`, o sea la VENTANA que decide qué snapshots se aceptan.
    const campos = {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      nombre: 'Reintentos medios',
      definicion: 'Media de intentos por solicitud completada',
      fuente: 'Log de verificación',
      dimensiones: '',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'semanal' as const,
      dashboardUrl: '',
      lineaBaseValor: '2.4',
      lineaBaseFecha: fecha(-120),
      ventanaInicio: fecha(-5),
      fechaPostMortem: fecha(90),
    };
    const ventanaDeReintentos = async () =>
      (await seguimientoDeImpacto(leadId, ws, proyectoId))!.entradas.find(
        (e) => e.id === entradaReintentosId,
      )!;

    await editarEntrada(leadId, { ...campos, criterioId: criterioAbandonoId });
    const reapuntada = await ventanaDeReintentos();
    expect(reapuntada.criterioId).toBe(criterioAbandonoId);
    // Y con el criterio se mueve la ventana, que es lo que hacía cara la equivocación.
    expect(reapuntada.criterioVentanaDias).toBe(31);

    // Lo que el WITH CHECK sigue impidiendo —y que ahora deja de ser letra muerta, porque
    // por fin hay un `criterio_id` que puede moverse—: apuntar al criterio de OTRO reto.
    await expect(
      editarEntrada(leadId, { ...campos, criterioId: criterioAjenoId }),
    ).rejects.toThrow(/no es de este reto/);

    await editarEntrada(leadId, { ...campos, criterioId: criterioReintentosId });
    const devuelta = await ventanaDeReintentos();
    expect(devuelta.criterioId).toBe(criterioReintentosId);
    expect(devuelta.criterioVentanaDias).toBe(60);
  });

  it('G6 no se aprueba sin registry firmado; firmado queda congelado y deja rastro', async () => {
    // SYS-22 en el gate: aprobar el plan de implementación sin contrato de medición
    // firmado deja el loop abierto por diseño.
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const g6 = p!.gates[6]!;
    for (const item of g6.items) {
      await marcarItem(leadId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: evidenciaId },
      });
    }
    // El rechazo del SERVICIO tiene que ser del contrato del módulo y decir CÓMO salir. Si
    // sale de la base como `raise` (P0001) sin traducir, la server function lo relanza y la
    // pantalla enseña su mensaje genérico de reintento: el sponsor ve el checklist entero
    // en verde y no tiene forma de adivinar que lo que falta está en otra sección.
    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g6.id })).rejects.toThrow(
      ErrorMetodo,
    );
    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g6.id })).rejects.toThrow(
      /fírmalo en el seguimiento de impacto/,
    );
    // Y la regla es del GUARD, no del servicio: por SQL directo el rechazo es el mismo.
    // Esta comprobación es deliberadamente redundante con la de arriba porque
    // `gate_aprobar_suficiencia_guard` lo reescribe entero cada `create or replace`: si
    // alguien lo reemplaza y se deja esta regla por el camino, es la línea que cae — y cae
    // aunque el servicio siguiera comprobándolo por su cuenta.
    await expect(
      conUsuario(sponsorId, (tx) => tx`update gate_instancia
        set estado = 'aprobado', aprobado_por = ${sponsorId}, aprobado_en = now()
        where id = ${g6.id}`),
    ).rejects.toThrow(/Metric Registry no está firmado/);

    // La ventana tiene DOS piezas en tablas distintas —el inicio en la entrada, el largo en
    // `criterio_exito.ventana_dias`, que el registry no copia a propósito—, y la lista de
    // completitud solo enumeraba columnas de `entrada_kpi`: comprobaba media ventana. G0
    // exige el largo, pero G0 corre ANTES, y reabrir la etapa 0 —el camino de reparación de
    // SPEC-04.9— permite devolverlo a nulo sin que el gate vuelva a pendiente. Firmar así
    // TAPIA el reto: sin ventana el review no se abre nunca (la ventana está «abierta» para
    // siempre), el snapshot exige el largo no nulo, el criterio ya no se arregla porque el
    // registry está firmado, y sin review no hay veredicto, sin veredicto el reto no cierra
    // y sin cierre el proyecto tampoco. El encierro del preámbulo, para filas nuevas y sin
    // columna de perdón. Aquí se pone a nulo con el rol admin para fijar la regla del GUARD
    // sin arrastrar una reapertura por el resto de la suite.
    const adminVentana = sqlAdmin();
    await adminVentana`update criterio_exito set ventana_dias = null
      where id = ${criterioAbandonoId}`;
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /criterios sin ventana declarada/,
    );
    // Las dos reglas de coherencia que existían justo para esto tampoco saltaban, y por una
    // razón que es el patrón y no el caso: escritas como «rechaza si la incoherencia es
    // cierta», un nulo en cualquier lado vuelve el predicado NULL, la fila no agrega y la
    // regla se evapora en silencio — justo cuando falta un dato, que es cuando más falta
    // hace. Ahora enuncian el hecho que TIENE que ser cierto y rechazan cuando no se puede
    // demostrar. Con esta lista de completitud delante ya no les llegan nulos; el
    // `coalesce` es lo que hace que sigan sin llegarles si alguien toca la lista.
    await adminVentana`update criterio_exito set ventana_dias = 31
      where id = ${criterioAbandonoId}`;

    const firma = await firmarRegistry(sponsorId, { workspaceId: ws, registryId });
    expect(firma.entradas).toBe(2);

    const admin = sqlAdmin();
    const [evento] = await admin`select actor_id, actor_rol, payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'MetricRegistryFirmado' order by creado_en desc limit 1`;
    expect(evento!.actor_id).toBe(sponsorId);
    expect(evento!.actor_rol).toBe('sponsor');
    const cuerpoFirma = evento!.payload as Record<string, unknown>;
    expect(cuerpoFirma.entradas).toBe(2);
    // Toda columna con grant entra en el payload: `estado` y `firmado_por` lo tienen, y el
    // sello lo pone el guard. Que la política ate `firmado_por` a `app_user_id()` los hace
    // deducibles del `actor_id` SOLO mientras la política se evalúe; el rastro dice lo que
    // quedó en la fila, no lo que otra capa promete que dice.
    expect(cuerpoFirma.estado).toBe('firmado');
    expect(cuerpoFirma.firmadoPor).toBe(sponsorId);
    expect(cuerpoFirma.firmadoEn).not.toBeNull();

    // Firmado = congelado: ni el curador agrega ni edita entradas (es el contrato que
    // el cliente firmó, no un documento vivo).
    await expect(
      agregarEntrada(leadId, {
        workspaceId: ws,
        registryId,
        criterioId: criterioAbandonoId,
        nombre: 'KPI tardío',
        definicion: '',
        fuente: '',
        dimensiones: '',
        propietarioMiembroId: null,
        frecuencia: 'mensual',
        dashboardUrl: '',
        lineaBaseValor: null,
        lineaBaseFecha: null,
        ventanaInicio: null,
        fechaPostMortem: null,
      }),
    ).rejects.toThrow(/row-level security|firmado/);
    await expect(
      editarEntrada(leadId, {
        workspaceId: ws,
        entradaId: entradaAbandonoId,
        criterioId: criterioAbandonoId,
        nombre: 'Abandono % (retocado)',
        definicion: 'otra cosa',
        fuente: 'otra fuente',
        dimensiones: '',
        propietarioMiembroId: sponsorMiembroId,
        frecuencia: 'mensual',
        dashboardUrl: '',
        lineaBaseValor: '10',
        lineaBaseFecha: fecha(-120),
        ventanaInicio: fecha(-10),
        fechaPostMortem: fecha(40),
      }),
    ).rejects.toThrow(/firmado/);
    // El criterio, que en borrador SÍ se corregía, queda congelado con lo demás: el USING
    // filtra la fila y el UPDATE directo no toca ninguna (la forma silenciosa de decir no).
    const reapuntada = await conUsuario(leadId, (tx) => tx`update entrada_kpi
      set criterio_id = ${criterioAbandonoId} where id = ${entradaReintentosId}`);
    expect(reapuntada.count).toBe(0);
    const [sigueEnSuCriterio] = await conUsuario(leadId, (tx) => tx`select criterio_id
      from entrada_kpi where id = ${entradaReintentosId}`);
    expect(sigueEnSuCriterio!.criterio_id).toBe(criterioReintentosId);
    // Ni siquiera el sponsor que lo firmó lo re-firma o lo devuelve a borrador.
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /ya está firmado/,
    );
    const revertido = await conUsuario(sponsorId, (tx) => tx`update metric_registry
      set estado = 'borrador' where id = ${registryId}`);
    expect(revertido.count).toBe(0);

    await aprobarGateNumero(6);
    // Aprobado el plan, el proyecto ENTRA en implementación (§7: activo → en
    // implementación → en medición → cerrado). Sin este efecto ese estado no lo escribía
    // nadie: G7 saltaba de 'activo' directo a 'en-medicion' y el tablero decía «activo»
    // durante toda la etapa 7, que es cuando de verdad se está implementando.
    const [tras] = await conUsuario(leadId, (tx) => tx`select estado from proyecto
      where id = ${proyectoId}`);
    expect(tras!.estado).toBe('en-implementacion');
    // `aprobado_en` está en el grant y el WITH CHECK solo le exige no ser nulo: la fecha de
    // aprobación la propone la aplicación y nada la ata al instante real, así que es
    // exactamente la clase de dato que el rastro tiene que conservar tal cual quedó.
    const [gateEvt] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'GateAprobado' order by creado_en desc limit 1`;
    const cuerpoGate = gateEvt!.payload as Record<string, unknown>;
    expect(cuerpoGate.numero).toBe(6);
    expect(cuerpoGate.estado).toBe('aprobado');
    expect(cuerpoGate.aprobadoPor).not.toBeNull();
    expect(cuerpoGate.aprobadoEn).not.toBeNull();

    const [transicion] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'ProyectoTransicionado'
      order by creado_en desc limit 1`;
    expect((transicion!.payload as { de: string; a: string })).toMatchObject({
      de: 'activo',
      a: 'en-implementacion',
    });
  });

  it('firmado el registry, los criterios ya no se mueven ni reabriendo la etapa 0', async () => {
    // La excepción de la reapertura existe para corregir el compromiso ANTES de acordar
    // cómo se mide. Con el registry firmado, `objetivo` y `ventana_dias` son el contrato
    // que el post mortem va a leer — y el registry no copia la ventana a propósito.
    await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId,
      etapaNumero: 0,
      motivo: 'Intento de mover el objetivo a toro pasado',
      insightIds: [],
    });

    await expect(
      agregarCriterio(leadId, {
        workspaceId: ws,
        retoId,
        kpi: 'Criterio colado tras la firma',
        definicion: 'x',
        lineaBaseValor: '1',
        lineaBaseFecha: '2026-07-15',
        lineaBasePlan: '',
        objetivo: '2',
        ventanaDias: 30,
        fechaPostMortem: null,
      }),
    ).rejects.toThrow(/registry del reto está firmado/);

    // Ni por SQL directo: la política mira el registry además de la etapa. Un UPDATE
    // que el USING filtra no lanza — simplemente no toca ninguna fila, que es la forma
    // silenciosa de decir que no. Se comprueba por el valor, no por la excepción.
    const [c] = await conUsuario(leadId, (tx) => tx`select id, objetivo from criterio_exito
      where reto_id = ${retoId} order by creado_en limit 1`);
    const tocadas = await conUsuario(leadId, (tx) => tx`update criterio_exito
      set objetivo = '5%' where id = ${c!.id as string}`);
    expect(tocadas.count).toBe(0);
    const [tras] = await conUsuario(leadId, (tx) => tx`select objetivo from criterio_exito
      where id = ${c!.id as string}`);
    expect(tras!.objetivo).toBe(c!.objetivo);
  });

  it('abrir la medición exige registry firmado y G7 aprobado, y mueve reto Y proyecto', async () => {
    // Otro reto activo con método pero sin registry: el guard de la base lo frena
    // también por SQL directo (SYS-22).
    const otro = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-72',
      titulo: 'Reto sin registry',
      descripcion: '',
      origen: 'post-mortem',
      metricaObjetivo: '',
      serviciosAfectados: [],
    });
    await activarReto(leadId, {
      workspaceId: ws,
      retoId: otro.retoId,
      perfil: 'rapido',
      proyectoCodigo: 'P-72',
      proyectoTitulo: 'Proyecto sin registry',
    });
    await expect(
      abrirMedicion(leadId, { workspaceId: ws, retoId: otro.retoId }),
    ).rejects.toThrow(/Metric Registry firmado en G6/);
    await expect(
      conUsuario(leadId, (tx) => tx`update reto set estado = 'en-medicion'
        where id = ${otro.retoId}`),
    ).rejects.toThrow(/Metric Registry firmado en G6/);

    // Y con el registry firmado y el G6 aprobado TAMPOCO se abre: el ciclo canónico
    // (§5.2) da este paso a G7, después de conciliar los releases contra la design
    // version y constatar el effective state. Abrir en G6 admitiría snapshots de una
    // implementación que nadie ha verificado y se saltaría el último gate del método.
    await expect(abrirMedicion(leadId, { workspaceId: ws, retoId })).rejects.toThrow(
      /G7 aprobado/,
    );
    // El guard de la base lo repite para el SQL directo, en las DOS piezas que se mueven.
    await expect(
      conUsuario(leadId, (tx) => tx`update reto set estado = 'en-medicion'
        where id = ${retoId}`),
    ).rejects.toThrow(/G7 aprobado/);
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-medicion'
        where id = ${proyectoId}`),
    ).rejects.toThrow(/al aprobarse su G7/);

    await aprobarGateNumero(7);

    // Con G7 aprobado el proyecto TAMPOCO se mueve solo: §5.2 mueve los dos juntos, así
    // que el proyecto sigue a su reto y no al revés. Sin esta precondición un lead dejaba
    // el proyecto midiendo con el reto todavía activo — un tablero que miente y una serie
    // que la política del snapshot rechazaría igual, porque ella sí mira el reto.
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-medicion'
        where id = ${proyectoId}`),
    ).rejects.toThrow(/pasa a medición con su reto/);

    // Y el RETO tampoco se mueve solo, que es la mitad simétrica y la que faltaba. Con el
    // G7 aprobado este update pasaba el guard de transición —que solo mira registry y
    // gate— y dejaba el reto midiendo con el proyecto todavía en implementación; desde ese
    // instante `snapshot_insert` («registry firmado + reto en medición») acepta datos. El
    // par lo sostenía únicamente `abrirMedicion`, y una promesa que solo cumple el
    // servicio dura hasta el próximo camino que escriba la tabla. Lo rechaza un constraint
    // trigger DIFERIDO: tiene que correr al COMMIT porque los dos movimientos legítimos
    // son dos sentencias y el reto va primero por obligación —el guard del proyecto exige
    // que su reto ya mida—, así que una comprobación inmediata rechazaría al propio
    // `abrirMedicion` en su primera sentencia.
    await expect(
      conUsuario(leadId, (tx) => tx`update reto set estado = 'en-medicion'
        where id = ${retoId}`),
    ).rejects.toThrow(/mueve los dos a la vez/);

    // La otra mitad del invariante: un reto midiendo sin NINGÚN proyecto que mida es la
    // misma mentira por el otro lado. Con el proyecto pausado, ningún proyecto queda en
    // 'activo' ni en 'en-implementacion' —la primera comprobación pasa— y es la segunda la
    // que habla. `abrirMedicion` ya lo rechazaba contando los movidos; ahora también el
    // SQL directo.
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'pausado'
      where id = ${proyectoId}`);
    await expect(
      conUsuario(leadId, (tx) => tx`update reto set estado = 'en-medicion'
        where id = ${retoId}`),
    ).rejects.toThrow(/sin ningún proyecto en medición/);
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-implementacion'
      where id = ${proyectoId}`);

    // Y una máquina de estados que solo vive en el UPDATE no es una máquina de estados: el
    // guard de transición es `before update of estado`, así que por INSERT no se dispara y
    // `proyecto_insert` no miraba el estado de la fila que nace. Con el grant de tabla, el
    // rol de app escribe esa columna: un proyecto podía NACER midiendo —sin G7 y sin
    // registry, las dos condiciones por las que el guard levanta en el camino UPDATE— o
    // nacer 'cerrado', o sea inmutable de nacimiento. Todas sus hermanas fijaban ya el
    // estado inicial; esta era la única que no.
    //
    // Se comprueba por el MENSAJE y no solo por el rechazo, y ahí está el matiz: un insert
    // pelado ya fallaba, pero por otra razón —el constraint trigger diferido que exige
    // instanciar el método— y solo al COMMIT. Esa puerta la abre cualquiera que además
    // instancie sus ocho etapas y ocho gates, que es exactamente lo que hace la activación
    // y está al alcance del rol de app. Lo que tiene que hablar es la política, en la
    // sentencia, diciendo que el estado inicial no se elige.
    for (const estadoIlegal of ['en-medicion', 'cerrado', 'en-implementacion', 'pausado']) {
      await expect(
        conUsuario(leadId, (tx) => tx`insert into proyecto
          (workspace_id, reto_id, codigo, titulo, estado, creado_por)
          values (${ws}, ${retoId}, ${'P-NACE-' + estadoIlegal}, 'Proyecto que nace hecho',
                  ${estadoIlegal}, ${leadId})`),
      ).rejects.toThrow(/row-level security/);
    }
    // Y nacer 'activo' lo rechaza el método, no la política: la puerta del estado inicial
    // es lo único que este slice añade.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into proyecto
        (workspace_id, reto_id, codigo, titulo, estado, creado_por)
        values (${ws}, ${retoId}, 'P-NACE-activo', 'Proyecto sin método',
                'activo', ${leadId})`),
    ).rejects.toThrow(/instanciar su método/);

    // Las dos marcas del perdón histórico se cierran en la PUERTA y no en el grant: los
    // `grant insert` son de TABLA y un grant de tabla cubre las columnas añadidas después,
    // así que no había que actualizar nada — bastaba insertar una fila nueva con el perdón
    // puesto. Se exige que nazcan en false, y con eso el conjunto perdonado vuelve a ser el
    // que escribió la migración y solo puede encoger.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into reto
        (workspace_id, servicio_ancla_id, codigo, titulo, origen, creado_por,
         medicion_sin_registry)
        values (${ws}, ${svcId}, 'R-PERDON', 'Reto que nace perdonado', 'peticion-cliente',
                ${leadId}, true)`),
    ).rejects.toThrow(/row-level security/);

    // El stakeholder no mueve el método.
    await expect(abrirMedicion(stakeId, { workspaceId: ws, retoId })).rejects.toThrow(
      /no puedes abrir su medición/,
    );

    const abierto = await abrirMedicion(leadId, { workspaceId: ws, retoId });
    expect(abierto.proyectos).toBe(1);
    const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
    expect(seg?.retoEstado).toBe('en-medicion');
    expect(seg?.proyectoEstado).toBe('en-medicion');
    // La transición del proyecto deja su propio rastro, como la del reto.
    const admin = sqlAdmin();
    const [trans] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'ProyectoTransicionado'
      order by creado_en desc limit 1`;
    expect((trans!.payload as { de: string; a: string }).a).toBe('en-medicion');
  });

  it('el snapshot lo carga el curador o el PROPIETARIO del dato, nunca el resto', async () => {
    // El stakeholder no es propietario de ninguna entrada: lee el seguimiento, no escribe.
    await expect(
      registrarSnapshot(stakeId, {
        workspaceId: ws,
        entradaId: entradaAbandonoId,
        valor: '55',
        fecha: fecha(-3),
        nota: '',
      }),
    ).rejects.toThrow(/No puedes cargar snapshots/);

    // El sponsor SÍ: es el propietario del dato comprometido en G6 (RF-07.4).
    const propio = await registrarSnapshot(sponsorId, {
      workspaceId: ws,
      entradaId: entradaAbandonoId,
      valor: '55',
      fecha: fecha(-8),
      nota: 'Corte mensual del panel',
    });
    expect(propio.snapshotId).toBeTruthy();
    await registrarSnapshot(leadId, {
      workspaceId: ws,
      entradaId: entradaAbandonoId,
      valor: '49',
      fecha: fecha(-1),
      nota: '',
    });

    const seg = await seguimientoDeImpacto(stakeId, ws, proyectoId);
    const abandono = seg!.entradas.find((e) => e.id === entradaAbandonoId)!;
    expect(abandono.snapshots.map((s) => s.valor)).toEqual(['55', '49']);
    expect(abandono.lineaBaseValor).toBe('62');
    expect(abandono.criterioObjetivo).toBe('40');
    expect(abandono.estadoSnapshot).toBe('recibido');
    expect(abandono.propietarioNombre).toBe('sponsor');
    // Días restantes de ventana (RF-07.5): ventana de 30 días abierta hace 10.
    expect(abandono.diasRestantes).toBeGreaterThan(0);
    // La entrada semanal aún no recibió nada, pero tampoco venció (5 días < 7).
    const reintentos = seg!.entradas.find((e) => e.id === entradaReintentosId)!;
    expect(reintentos.estadoSnapshot).toBe('esperado');
  });

  it('los snapshots son APPEND-ONLY: sin política ni grant de update/delete (SYS-23)', async () => {
    const [uno] = await conUsuario(leadId, (tx) => tx`select id, valor from snapshot
      where entrada_kpi_id = ${entradaAbandonoId} order by fecha limit 1`);
    await expect(
      conUsuario(leadId, (tx) => tx`update snapshot set valor = 1
        where id = ${uno!.id as string}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      conUsuario(leadId, (tx) => tx`delete from snapshot where id = ${uno!.id as string}`),
    ).rejects.toThrow(/permission denied/);
    // Y la ausencia es estructural, no un accidente de grants: la tabla no tiene
    // políticas de UPDATE ni DELETE que alguien pueda «completar» más tarde.
    const admin = sqlAdmin();
    const politicas = await admin`select cmd from pg_policies
      where schemaname = 'public' and tablename = 'snapshot' and cmd in ('UPDATE', 'DELETE')`;
    expect(politicas.length).toBe(0);
    // El valor sigue intacto: corregir es un snapshot NUEVO.
    const [sigue] = await conUsuario(leadId, (tx) => tx`select valor from snapshot
      where id = ${uno!.id as string}`);
    expect(sigue!.valor).toBe(uno!.valor);
  });

  it('el CSV acepta las filas válidas y rechaza las malas con motivo, sin sobreescribir nada', async () => {
    const csv = [
      'fecha,valor,nota',
      `${fecha(-6)},52,corte semanal`,
      `,48`, // sin fecha
      `2026-02-30,44`, // fecha inexistente (el parser ISO de V8 la rodaría a marzo)
      `${fecha(-4)},cuarenta`, // valor no numérico
      `${fecha(-2)},46`,
      // La ventana firmada («Abandono %») abre hace 10 días y dura 30: estas dos son
      // formalmente correctas y aun así no miden lo acordado. Se rechazan POR FILA, no
      // tumbando la tanda — que es lo que haría la política si llegaran hasta ella.
      `${fecha(-30)},60`, // anterior a la apertura de la ventana
      `${fecha(3)},20`, // fechada en el futuro
    ].join('\n');
    const r = await cargarSnapshotsCsv(sponsorId, {
      workspaceId: ws,
      entradaId: entradaAbandonoId,
      csv,
    });
    expect(r.insertados).toBe(2);
    expect(r.rechazadas.map((f) => f.linea)).toEqual([3, 4, 5, 7, 8]);
    expect(r.rechazadas[0]!.motivo).toMatch(/Falta la fecha/);
    expect(r.rechazadas[1]!.motivo).toMatch(/Fecha inválida/);
    expect(r.rechazadas[2]!.motivo).toMatch(/no numérico/);
    expect(r.rechazadas[3]!.motivo).toMatch(/anterior a la ventana firmada/);
    expect(r.rechazadas[4]!.motivo).toMatch(/Fecha en el futuro/);

    const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
    const abandono = seg!.entradas.find((e) => e.id === entradaAbandonoId)!;
    // Serie completa y ordenada por fecha del DATO; nada se pisó (SYS-23).
    expect(abandono.snapshots.map((s) => s.valor)).toEqual(['55', '52', '46', '49']);
    expect(abandono.snapshots.filter((s) => s.origen === 'csv').length).toBe(2);

    const admin = sqlAdmin();
    const [evento] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'SnapshotsCargados' order by creado_en desc limit 1`;
    expect((evento!.payload as { insertados: number }).insertados).toBe(2);

    // ── El fichero que va a llegar de verdad: `;` de delimitador y coma decimal ──
    // No son dos rarezas independientes, son EL MISMO formato: una hoja de cálculo en
    // configuración regional española exporta con `;` precisamente porque la coma está
    // ocupada por el decimal. Partir cada fila por «cualquiera de los separadores
    // admitidos» hacía de `55,2` dos campos y guardaba 55 con la nota «2 …»: sin error, sin
    // fila rechazada y sin nada en el rastro. Un número plausible y distinto del que el
    // fichero decía, alimentando el resultado del criterio y el veredicto — que es lo que
    // este slice existe para poder defender. Por eso lo que se fija aquí no es que la fila
    // entre, sino QUÉ VALOR queda escrito.
    const csvEuropeo = [
      'fecha;valor;nota',
      `${fecha(-5)};55,2;corte con coma decimal`,
      // Y lo que no se adivina se rechaza diciéndolo: un número agrupado tiene DOS
      // separadores y no hay forma de saber cuál es cuál.
      `${fecha(-3)};1.234,5;miles agrupados`,
      // La nota que no cabe se RECHAZA, no se recorta: recortarla reportaba la fila como
      // insertada y guardaba un texto distinto del que el fichero decía, sin nada en
      // `rechazadas`. Y no es un campo cualquiera —la nota explica una CORRECCIÓN, que en
      // una serie append-only es el único sitio donde consta por qué un número cambió—.
      `${fecha(-4)};44;${'x'.repeat(501)}`,
    ].join('\n');
    const euro = await cargarSnapshotsCsv(sponsorId, {
      workspaceId: ws,
      entradaId: entradaAbandonoId,
      csv: csvEuropeo,
    });
    expect(euro.insertados).toBe(1);
    expect(euro.rechazadas.map((f) => f.linea)).toEqual([3, 4]);
    expect(euro.rechazadas[0]!.motivo).toMatch(/más de un separador decimal/);
    expect(euro.rechazadas[1]!.motivo).toMatch(/Nota de 501 caracteres/);
    const segEuro = await seguimientoDeImpacto(leadId, ws, proyectoId);
    const conComa = segEuro!.entradas
      .find((e) => e.id === entradaAbandonoId)!
      .snapshots.find((sn) => sn.nota === 'corte con coma decimal')!;
    expect(conComa.valor).toBe('55.2');
    // ── Reenviar la misma carga NO duplica la serie ──
    // Es el daño peor de esta pantalla y es permanente: los snapshots son append-only, sin
    // política ni grant de DELETE, así que un duplicado no se puede sacar. Y no lo puede
    // impedir un unique sobre (entrada, fecha), porque insertar otro dato del mismo día es
    // la ÚNICA forma que existe de CORREGIR uno mal tecleado — prohibirlo dejaría cada
    // errata sin arreglo posible. Lo que separa los dos casos es la intención, y la fila la
    // lleva escrita: por CSV no se escribe sobre una fecha que ya tiene dato; corregir es un
    // acto de uno en uno, desde el formulario y con su nota.
    const reenvio = await cargarSnapshotsCsv(sponsorId, {
      workspaceId: ws,
      entradaId: entradaAbandonoId,
      csv: csvEuropeo,
    });
    expect(reenvio.insertados).toBe(0);
    expect(reenvio.rechazadas.some((f) => /Ya hay un dato de/.test(f.motivo))).toBe(true);
    // Y la regla es de la BASE, no del diagnóstico: por SQL directo el rechazo llega igual.
    await expect(
      conUsuario(sponsorId, (tx) => tx`insert into snapshot
        (workspace_id, entrada_kpi_id, valor, fecha, origen, nota, creado_por)
        values (${ws}, ${entradaAbandonoId}, 9, ${fecha(-5)}::date, 'csv', '', ${sponsorId})`),
    ).rejects.toThrow(/una carga no corrige/);
    // Lo que SÍ sigue existiendo es corregir: mismo día, dato nuevo, por el formulario y con
    // su nota. Si esto dejara de poder hacerse, el arreglo sería peor que el problema.
    const correccion = await registrarSnapshot(sponsorId, {
      workspaceId: ws,
      entradaId: entradaAbandonoId,
      valor: '55.9',
      fecha: fecha(-5),
      nota: 'corrige el corte anterior: la extracción venía con el filtro puesto',
    });
    expect(correccion.snapshotId).toBeTruthy();

    // Y en el textarea queda SOLO lo que hay que reintentar, con su cabecera, para que el
    // reintento se lea igual: el delimitador sale del primer renglón con contenido.
    expect(euro.csvRestante.split('\n')[0]).toBe('fecha;valor;nota');
    expect(euro.csvRestante).toContain('1.234,5');
    expect(euro.csvRestante).not.toContain('corte con coma decimal');

    // Fixture: la serie que leen los tests siguientes es la de arriba, así que estos cortes
    // —que solo existían para fijar el valor y la corrección— se retiran. Solo el admin
    // puede (SYS-23).
    await admin`delete from snapshot where id in (${conComa.id}, ${correccion.snapshotId})`;
  });

  it('el ÚLTIMO día de la ventana todavía mide: el review no se abre y el snapshot entra', async () => {
    // Los dos extremos de la ventana son inclusivos —el día que abre y el que cierra son
    // días medidos— y `snapshot_insert` lo respeta. El predicado del review usaba `>`, así
    // que daba la ventana por cerrada ESE MISMO día: el lead abría y completaba el post
    // mortem a primera hora, cerraba el reto de forma irreversible (SYS-08) y el snapshot
    // legítimo de esa tarde se quedaba sin sitio. El contrato firmado lo admitía y el
    // sistema ya no. Aquí se fija el corte por los dos lados.
    const admin = sqlAdmin();
    const [previas] = await admin`select
      (select ventana_inicio::text from entrada_kpi where id = ${entradaAbandonoId}) as abandono,
      (select ventana_inicio::text from entrada_kpi where id = ${entradaReintentosId}) as reintentos`;
    // Se simula que HOY es el último día de AMBAS ventanas (31 y 60 días de criterio). Las
    // entradas están congeladas por la firma, así que solo el rol admin las mueve.
    await admin`update entrada_kpi set ventana_inicio = ${await fechaDeBase(-31)}
      where id = ${entradaAbandonoId}`;
    await admin`update entrada_kpi set ventana_inicio = ${await fechaDeBase(-60)}
      where id = ${entradaReintentosId}`;
    let tardio = '';
    try {
      const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
      expect(seg!.entradas.map((e) => e.diasRestantes)).toEqual([0, 0]);
      // El espejo del cliente no da la ventana por cerrada…
      expect(ventanasCerradas(seg!.entradas)).toBe(false);
      // …y la base tampoco, que es quien manda.
      await expect(abrirOutcomeReview(leadId, { workspaceId: ws, retoId })).rejects.toThrow(
        /se habilita al cerrar la ventana del último criterio/,
      );
      // El diagnóstico lo dice con la palabra del corte, en vez de «faltan 0 días».
      await expect(abrirOutcomeReview(leadId, { workspaceId: ws, retoId })).rejects.toThrow(
        /cierra hoy/,
      );

      // La otra mitad: el dato de HOY sí entra — es exactamente el que un review
      // prematuro habría dejado fuera para siempre.
      const hoy = await registrarSnapshot(sponsorId, {
        workspaceId: ws,
        entradaId: entradaAbandonoId,
        valor: '47',
        fecha: await fechaDeBase(0),
        nota: 'último día de la ventana',
      });
      tardio = hoy.snapshotId;
      // Y un día después la puerta se cierra por los dos lados a la vez.
      await admin`update entrada_kpi set ventana_inicio = ${await fechaDeBase(-32)}
        where id = ${entradaAbandonoId}`;
      await expect(
        registrarSnapshot(sponsorId, {
          workspaceId: ws,
          entradaId: entradaAbandonoId,
          valor: '46',
          fecha: await fechaDeBase(0),
          nota: '',
        }),
      ).rejects.toThrow(/posterior a la ventana firmada/);
    } finally {
      // Fixture: se deshace el viaje en el tiempo y el snapshot que solo existía para
      // probar el corte, de modo que la serie que construyeron los tests anteriores siga
      // siendo la que leen los siguientes. Solo el rol admin puede borrarlo: para el rol
      // de aplicación los snapshots son append-only (SYS-23), como comprueba su test.
      if (tardio) await admin`delete from snapshot where id = ${tardio}`;
      await admin`update entrada_kpi set ventana_inicio = ${previas!.abandono as string}
        where id = ${entradaAbandonoId}`;
      await admin`update entrada_kpi set ventana_inicio = ${previas!.reintentos as string}
        where id = ${entradaReintentosId}`;
    }
  });

  it('el outcome review NO se habilita antes de cerrar la ventana del último criterio', async () => {
    await expect(abrirOutcomeReview(leadId, { workspaceId: ws, retoId })).rejects.toThrow(
      /se habilita al cerrar la ventana del último criterio/,
    );
    // El rechazo nombra las ventanas abiertas y cuánto falta: es el diagnóstico que
    // convierte un «no puedes» en una fecha.
    await expect(abrirOutcomeReview(leadId, { workspaceId: ws, retoId })).rejects.toThrow(
      /Reintentos medios/,
    );

    // Se simula el paso del tiempo (única forma de cerrar una ventana en un test): las
    // entradas están congeladas por la firma, así que solo el rol admin las mueve.
    const admin = sqlAdmin();
    await admin`update entrada_kpi set ventana_inicio = ${fecha(-100)}
      where registry_id = ${registryId}`;

    // Con las ventanas cerradas, la entrada semanal sin datos aparece VENCIDA (RF-07.4).
    const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
    const reintentos = seg!.entradas.find((e) => e.id === entradaReintentosId)!;
    expect(reintentos.estadoSnapshot).toBe('vencido');
    expect(reintentos.diasRestantes).toBeLessThanOrEqual(0);

    // El espejo de la pantalla son DOS condiciones y no una: con las ventanas ya vencidas
    // pero el reto todavía sin abrir su medición, `review_insert` rechaza cada clic — así
    // que el botón no se ofrece. Media condición es un botón que miente.
    expect(postMortemPorAbrir({ retoEstado: 'en-medicion', entradas: seg!.entradas })).toBe(true);
    expect(postMortemPorAbrir({ retoEstado: 'activo', entradas: seg!.entradas })).toBe(false);
    expect(ventanasCerradas(seg!.entradas)).toBe(true);

    // El stakeholder no abre el post-mortem aunque la ventana esté cerrada.
    await expect(abrirOutcomeReview(stakeId, { workspaceId: ws, retoId })).rejects.toThrow(
      ErrorMedicion,
    );
    const abierto = await abrirOutcomeReview(leadId, { workspaceId: ws, retoId });
    reviewId = abierto.reviewId;
  });

  it('el snapshot cae DENTRO de la ventana firmada y nunca en el futuro', async () => {
    // Las ventanas ya se movieron a [-100, -70] y [-100, -40] (test anterior) y el reto
    // sigue midiendo: las tres puertas son alcanzables. Un valor fuera de la ventana no
    // mide lo que se acordó medir (I5: la medición es temporal y ACOTADA), y uno fechado
    // por delante se cuela como «última recepción» de la proyección —dejando la cadencia
    // en «recibido» sin que nadie haya aportado nada— y como candidato a resultado final
    // del criterio en el outcome review.
    const base = { workspaceId: ws, entradaId: entradaAbandonoId, valor: '5', nota: '' };
    await expect(registrarSnapshot(sponsorId, { ...base, fecha: fecha(1) })).rejects.toThrow(
      /Fecha en el futuro/,
    );
    await expect(registrarSnapshot(sponsorId, { ...base, fecha: fecha(-150) })).rejects.toThrow(
      /anterior a la ventana firmada/,
    );
    await expect(registrarSnapshot(leadId, { ...base, fecha: fecha(-60) })).rejects.toThrow(
      /posterior a la ventana firmada/,
    );

    // Y la puerta es de la BASE, no del mensaje: por SQL directo la política los rechaza
    // igual, tanto al propietario del dato como al curador.
    for (const [quien, dia] of [
      [sponsorId, 1],
      [sponsorId, -150],
      [leadId, -60],
    ] as const) {
      await expect(
        conUsuario(quien, (tx) => tx`insert into snapshot
          (workspace_id, entrada_kpi_id, valor, fecha, origen, creado_por)
          values (${ws}, ${entradaAbandonoId}, 5, ${fecha(dia)}::date, 'formulario', ${quien})`),
      ).rejects.toThrow(/row-level security/);
    }

    // Nada entró: la serie sigue siendo la de siempre (SYS-23 no admite «casi»).
    const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
    const abandono = seg!.entradas.find((e) => e.id === entradaAbandonoId)!;
    expect(abandono.snapshots.map((s) => s.valor)).toEqual(['55', '52', '46', '49']);
  });

  it('cerrada la ventana, la cadencia deja de correr: lo que cumplió no vence por calendario', async () => {
    // La ventana de «Reintentos medios» es [-100, -40] y la frecuencia comprometida es
    // SEMANAL. Los dos snapshots entran por el camino normal: caen dentro de la ventana
    // firmada y el reto sigue midiendo.
    const seguido = async () =>
      (await seguimientoDeImpacto(leadId, ws, proyectoId))!.entradas.find(
        (e) => e.id === entradaReintentosId,
      )!;

    // Un solo dato al principio y nada más: la cadencia se incumplió DENTRO de la ventana
    // y eso no lo borra el calendario — sigue vencido, y para siempre.
    await registrarSnapshot(leadId, {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      valor: '2.3',
      fecha: fecha(-95),
      nota: '',
    });
    const aMedias = await seguido();
    expect(aMedias.diasRestantes).toBeLessThanOrEqual(0);
    expect(aMedias.estadoSnapshot).toBe('vencido');

    // El caso del borde, que es el que distingue una regla de una aproximación: con el
    // último dato en -47 y cadencia semanal, la siguiente entrega vencía el -40 — el
    // ÚLTIMO día de la ventana, que es un día medido y que ya pasó. No llegó, así que la
    // cadencia se incumplió: «cerrado» diría que se cumplió lo comprometido y sería falso.
    await registrarSnapshot(leadId, {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      valor: '2.0',
      fecha: fecha(-47),
      nota: '',
    });
    expect((await seguido()).estadoSnapshot).toBe('vencido');

    // Y ahora un dato pegado al cierre de la ventana: se aportó lo comprometido hasta el
    // final. El estado es TERMINAL, no «vencido»: comparar la próxima fecha prevista
    // (-42 + 7 = -35) contra HOY la deja atrás por 35 días y marcaría vencido todo KPI
    // recurrente cumplido, en un proyecto que ya es historia y donde la política rechaza
    // cualquier snapshot posterior. Se compara contra el FIN de la ventana (-40).
    await registrarSnapshot(leadId, {
      workspaceId: ws,
      entradaId: entradaReintentosId,
      valor: '1.6',
      fecha: fecha(-42),
      nota: 'último corte de la ventana',
    });
    const alCierre = await seguido();
    expect(alCierre.ultimaFecha).toBe(fecha(-42));
    expect(alCierre.estadoSnapshot).toBe('cerrado');
    // «Cerrado» dice que la medición TERMINÓ habiendo llegado lo comprometido, no solo que
    // terminó: este mismo KPI, con la ventana ya cerrada y sin un solo dato, se leyó
    // «vencido» en el test anterior — y con razón, porque ya no puede llegar ninguno.
  });

  it('el resultado por criterio apunta a un snapshot REAL de SU criterio o dice por qué falta', async () => {
    const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
    const abandono = seg!.entradas.find((e) => e.id === entradaAbandonoId)!;
    const ultimo = abandono.snapshots.at(-1)!;

    // Un snapshot de OTRO KPI como «resultado» sería una cifra inventada con FK.
    await expect(
      registrarResultado(leadId, {
        workspaceId: ws,
        reviewId,
        criterioId: criterioReintentosId,
        snapshotFinalId: ultimo.id,
        lectura: 'copiado del otro KPI',
        sinDatosMotivo: '',
      }),
    ).rejects.toThrow(/no es de este criterio/);

    await registrarResultado(leadId, {
      workspaceId: ws,
      reviewId,
      criterioId: criterioAbandonoId,
      snapshotFinalId: ultimo.id,
      lectura: 'De 62 a 49: mejora sostenida tras el rediseño de la verificación',
      sinDatosMotivo: '',
    });
    // Sin snapshot final, el motivo es OBLIGATORIO (criterio de aceptación 3).
    await expect(
      conUsuario(leadId, (tx) => tx`insert into resultado_criterio
        (workspace_id, review_id, criterio_id) values (${ws}, ${reviewId}, ${criterioReintentosId})`),
    ).rejects.toThrow(/check constraint/);
    await registrarResultado(leadId, {
      workspaceId: ws,
      reviewId,
      criterioId: criterioReintentosId,
      snapshotFinalId: null,
      lectura: '',
      sinDatosMotivo:
        'La serie del log llegó a medias: ningún corte comparable con la línea base al cierre',
    });

    const stake = await seguimientoDeImpacto(stakeId, ws, proyectoId);
    expect(stake!.review!.resultados.length).toBe(2);
    expect(stake!.review!.resultados.find((r) => r.criterioId === criterioAbandonoId)!.valorFinal)
      .toBe('49');
  });

  it('las escrituras de la medición se citan en la FILA DEL RETO, también por SQL directo', async () => {
    // El barrido de pares deja cinco escrituras cuyo predicado puede invalidar una
    // transición ajena que commitee en medio. Se citan en la fila del reto —el objeto del
    // que cuelga todo— y aquí se comprueba reteniendo ESA fila desde otra sesión, sin
    // tomar ningún candado consultivo: si solo se citaran en el candado del servicio,
    // ninguna esperaría y el SQL directo seguiría colándose. (La tercera, la entrada KPI
    // contra la firma, se comprueba donde su registry todavía es borrador.)
    const filaDelReto = (tx: TransactionSql) =>
      tx`select 1 from reto where id = ${retoId} and workspace_id = ${ws} for update`;

    // 1) El snapshot contra la completación del review («reto en medición»).
    expect(
      await esperaA(filaDelReto, () =>
        registrarSnapshot(sponsorId, {
          workspaceId: ws,
          entradaId: entradaAbandonoId,
          valor: '48',
          fecha: fecha(-75),
          nota: 'cita en la fila del reto',
        }),
      ),
    ).toBe(true);

    // 2) El resultado por criterio contra esa misma completación («review en borrador»).
    expect(
      await esperaA(filaDelReto, () =>
        registrarResultado(leadId, {
          workspaceId: ws,
          reviewId,
          criterioId: criterioAbandonoId,
          snapshotFinalId: null,
          lectura: '',
          sinDatosMotivo: 'cita en la fila del reto',
        }),
      ),
    ).toBe(true);

    // El resultado del criterio se deja como estaba: con su snapshot final de la serie.
    const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
    const abandono = seg!.entradas.find((e) => e.id === entradaAbandonoId)!;
    await registrarResultado(leadId, {
      workspaceId: ws,
      reviewId,
      criterioId: criterioAbandonoId,
      snapshotFinalId: abandono.snapshots.at(-1)!.id,
      lectura: 'De 62 a 48: mejora sostenida tras el rediseño de la verificación',
      sinDatosMotivo: '',
    });
  });

  it('un resultado no puede traer valor final Y motivo de falta de dato a la vez', async () => {
    // «Al menos uno» dejaba pasar una fila que se contradice dentro de un post mortem
    // auditado: un valor final y, al lado, la explicación de que no hay dato. Es una
    // propiedad de la FILA, así que la impone el CHECK y no la disciplina del formulario.
    const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
    const abandono = seg!.entradas.find((e) => e.id === entradaAbandonoId)!;
    await expect(
      conUsuario(leadId, (tx) => tx`update resultado_criterio
        set sin_datos_motivo = 'y además no hay dato'
        where review_id = ${reviewId} and criterio_id = ${criterioAbandonoId}`),
    ).rejects.toThrow(/check constraint/);
    // Y el contrato del schema dice lo mismo antes de llegar a la base.
    expect(
      ResultadoCriterioSchema.safeParse({
        workspaceId: ws,
        reviewId,
        criterioId: criterioAbandonoId,
        snapshotFinalId: abandono.snapshots.at(-1)!.id,
        lectura: '',
        sinDatosMotivo: 'no hay dato',
      }).success,
    ).toBe(false);
  });

  it('el resultado por criterio se serializa con la completación: mismo candado del reto', async () => {
    // El upsert del resultado y la completación tocan FILAS DISTINTAS, así que ninguna
    // bloquea a la otra por filas: sin candado, este guardado podía evaluar su «solo
    // borrador» contra un snapshot anterior al cierre y commitear DESPUÉS, dejando el post
    // mortem firmado sobre una lectura que su propio trigger jamás vio. Se comprueba que
    // registrarResultado toma de verdad el candado del reto —el mismo que toma
    // completarOutcomeReview— reteniéndolo desde otra sesión: si no lo tomara, terminaría
    // de inmediato en vez de esperar a que se suelte.
    const espero = await esperaA(
      (tx) => tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`,
      () =>
        registrarResultado(leadId, {
          workspaceId: ws,
          reviewId,
          criterioId: criterioAbandonoId,
          snapshotFinalId: null,
          lectura: 'edición concurrente del borrador',
          sinDatosMotivo: 'se corrige a continuación',
        }),
    );
    expect(espero).toBe(true);

    // Y se deja el resultado del criterio como estaba: con su snapshot final de la serie.
    const seg = await seguimientoDeImpacto(leadId, ws, proyectoId);
    const abandono = seg!.entradas.find((e) => e.id === entradaAbandonoId)!;
    await registrarResultado(leadId, {
      workspaceId: ws,
      reviewId,
      criterioId: criterioAbandonoId,
      snapshotFinalId: abandono.snapshots.at(-1)!.id,
      lectura: 'De 62 a 49: mejora sostenida tras el rediseño de la verificación',
      sinDatosMotivo: '',
    });
  });

  it('toda escritura de la medición deja su evento, y lo deja la BASE', async () => {
    // Doctrina del repositorio (y del grafo del journey): el evento lo emite un TRIGGER y
    // no el servicio, para que el SQL directo y cualquier ruta futura también lo produzcan.
    // El inventario completo —qué escritura emite qué, y qué queda fuera a propósito— vive
    // en la migración, junto a la función que lo cumple; aquí se recorre entero.
    const admin = sqlAdmin();
    const de = async (tipo: string) =>
      admin`select payload, actor_id, actor_rol from evento_dominio
        where workspace_id = ${ws} and tipo = ${tipo} order by creado_en`;
    const cuerpos = async (tipo: string) =>
      (await de(tipo)).map((e) => e.payload as Record<string, unknown>);

    // El contrato: apertura del registry, alta de entrada y corrección del borrador.
    expect((await cuerpos('MetricRegistryAbierto')).some((p) => p.registryId === registryId))
      .toBe(true);
    expect(
      (await cuerpos('EntradaKpiAgregada')).some(
        (p) => p.entradaId === entradaAbandonoId && p.nombre === 'Abandono %',
      ),
    ).toBe(true);
    // La edición trae el ANTES: sin él el rastro diría que alguien tocó el contrato pero no
    // qué movió, y lo que se mueve aquí es el compromiso.
    const editadas = await cuerpos('EntradaKpiEditada');
    expect(
      editadas.some((p) => {
        const antes = p.antes as Record<string, unknown> | undefined;
        return p.entradaId === entradaReintentosId && antes !== undefined
          && antes.fechaPostMortem !== p.fechaPostMortem;
      }),
    ).toBe(true);
    // Toda columna con `grant update` entra en el payload, y no una selección de las que
    // parecen importantes: `definicion`, `fuente`, `dimensiones` y `dashboard_url` son
    // texto libre que la edición PISA, así que corregir SOLO una de ellas emitía un evento
    // con el antes y el después idénticos — el rastro decía que alguien tocó el contrato y
    // era incapaz de decir qué, y el texto anterior ya no estaba en la fila ni en ninguna
    // otra parte. Se prueba con la columna sola, que es el caso que se perdía.
    const [defPrevia] = await admin`select definicion from entrada_kpi
      where id = ${entradaAbandonoId}`;
    const definicionNueva = 'Redefinido a mano: % que abandona tras el segundo intento';
    await admin`update entrada_kpi set definicion = ${definicionNueva}
      where id = ${entradaAbandonoId}`;
    const soloDefinicion = (await de('EntradaKpiEditada')).at(-1)!;
    const cuerpoDefinicion = soloDefinicion.payload as Record<string, unknown>;
    expect(cuerpoDefinicion.definicion).toBe(definicionNueva);
    expect((cuerpoDefinicion.antes as Record<string, unknown>).definicion).toBe(
      defPrevia!.definicion,
    );
    // Y las cuatro claves existen en los dos lados aunque no se hayan movido: comparar dos
    // eventos consecutivos es lo que dice qué cambió, y para eso los dos tienen que hablar
    // del mismo conjunto de campos.
    for (const clave of ['definicion', 'fuente', 'dimensiones', 'dashboardUrl']) {
      expect(clave in cuerpoDefinicion).toBe(true);
      expect(clave in (cuerpoDefinicion.antes as Record<string, unknown>)).toBe(true);
    }

    // El criterio tiene el mismo eje y era el más grave: el evento llevaba SOLO el `kpi` de
    // sus ocho columnas editables y ningún `antes`. `objetivo` es la promesa contra la que
    // se dicta el veredicto y `ventana_dias` es la ventana que decide qué snapshots entran
    // —el registry no la copia a propósito, así que la ÚNICA copia es esa fila—: moverlas
    // era indistinguible de renombrar el KPI. La corrección la hizo el fixture, con el G0
    // todavía pendiente, que es cuando el criterio se puede corregir.
    const criterios = await cuerpos('CriterioEditado');
    const editado = criterios.find((c) => c.criterioId === criterioReintentosId)!;
    expect(editado.objetivo).toBe('1.2');
    expect((editado.antes as Record<string, unknown>).objetivo).toBe(objetivoReintentosPrevio);
    expect(editado.ventanaDias).toBe(60);

    // Y las correcciones a mano del fixture —rol admin, sin sesión de aplicación— también
    // dejaron el suyo. Ese es el punto entero de que el rastro sea de la base: no depende
    // de que se entre por el servicio, y un `update` directo tampoco es invisible.
    expect((await de('EntradaKpiEditada')).some((e) => e.actor_id === null)).toBe(true);

    // La serie: un evento por FILA, del formulario y del CSV. Son TRES del CSV: dos de la
    // primera tanda y la del fichero europeo, cuya fila retiró el fixture después de fijar
    // su valor — el rastro no se va con ella, que es el punto de que lo emita la base.
    const snaps = await cuerpos('SnapshotRegistrado');
    expect(snaps.filter((p) => p.origen === 'csv').length).toBe(3);
    expect(snaps.filter((p) => p.origen === 'formulario').length).toBeGreaterThan(0);
    // …y ADEMÁS el de la tanda, que es la única excepción honesta al «lo emite la base»:
    // cuenta las filas RECHAZADAS, que no llegan a ser filas de ninguna tabla y por tanto
    // ningún trigger puede verlas. Dos tandas: la primera con sus cinco rechazos y la del
    // fichero europeo con el suyo, el número agrupado que no se adivina.
    const tandas = await cuerpos('SnapshotsCargados');
    expect(tandas.length).toBe(2);
    expect(tandas[0]!.rechazadas).toBe(5);
    expect(tandas[1]!.rechazadas).toBe(2);

    // El post-mortem: apertura del review y resultado por criterio.
    expect((await cuerpos('OutcomeReviewAbierto')).some((p) => p.reviewId === reviewId)).toBe(true);
    const registrados = await cuerpos('ResultadoCriterioRegistrado');
    expect(registrados.some((p) => p.criterioId === criterioAbandonoId)).toBe(true);
    // Un nulo es INFORMACIÓN y se conserva: la fila lleva por CHECK exactamente uno de los
    // dos —snapshot final o motivo de la falta—, así que quitar la clave nula del payload
    // borraría de qué tipo de resultado se trataba.
    const sinDato = registrados.find((p) => p.criterioId === criterioReintentosId)!;
    expect('snapshotFinalId' in sinDato).toBe(true);
    expect(sinDato.snapshotFinalId).toBeNull();

    // Y la prueba de que el rastro es de la BASE: una corrección por SQL DIRECTO, sin pasar
    // por ninguna función del servicio, también lo deja — con su antes y con su autor.
    const [previo] = await admin`select id, lectura from resultado_criterio
      where review_id = ${reviewId} and criterio_id = ${criterioAbandonoId}`;
    const corregida = 'corregido por SQL directo, sin pasar por el servicio';
    await conUsuario(leadId, (tx) => tx`update resultado_criterio set lectura = ${corregida}
      where id = ${previo!.id as string} and workspace_id = ${ws}`);
    const ultima = (await de('ResultadoCriterioEditado')).at(-1)!;
    const cuerpo = ultima.payload as Record<string, unknown>;
    expect(cuerpo.lectura).toBe(corregida);
    expect((cuerpo.antes as Record<string, unknown>).lectura).toBe(previo!.lectura);
    expect(ultima.actor_id).toBe(leadId);
    expect(ultima.actor_rol).toBe('lead-boutique');

    // Se deja el borrador del review como estaba: lo que se probaba era el rastro.
    await conUsuario(leadId, (tx) => tx`update resultado_criterio
      set lectura = ${previo!.lectura as string}
      where id = ${previo!.id as string} and workspace_id = ${ws}`);

    // Y el post mortem se REDACTA en sitio, que es un UPDATE legal que NO es la transición:
    // `review_completar` lo admite explícitamente en su WITH CHECK (`estado = 'borrador'`) y
    // el grant da las columnas del contenido. Auditar solo el INSERT dejaba invisible quién
    // cambió la contribución, los factores, las hipótesis o los aprendizajes del borrador
    // —y el evento de completación tampoco los conservaba—: el rastro del post mortem, que
    // es de donde sale el veredicto de un reto, era el único del slice que se podía
    // reescribir sin dejar huella.
    const [borradorPrevio] = await admin`select contribucion, aprendizajes
      from outcome_review where id = ${reviewId}`;
    const redactado = 'contribución reescrita por SQL directo, sin pasar por el servicio';
    await conUsuario(leadId, (tx) => tx`update outcome_review set contribucion = ${redactado}
      where id = ${reviewId} and workspace_id = ${ws}`);
    const edicion = (await de('OutcomeReviewEditado')).at(-1)!;
    const cuerpoEdicion = edicion.payload as Record<string, unknown>;
    expect(cuerpoEdicion.reviewId).toBe(reviewId);
    expect(cuerpoEdicion.contribucion).toBe(redactado);
    const antesEdicion = cuerpoEdicion.antes as Record<string, unknown>;
    expect(antesEdicion.contribucion).toBe(borradorPrevio!.contribucion);
    // El «antes» es la narrativa ENTERA, no solo la columna que se movió: comparar dos
    // eventos consecutivos es lo que dice qué cambió, y para eso los dos tienen que hablar
    // del mismo conjunto de campos.
    expect(antesEdicion.aprendizajes).toBe(borradorPrevio!.aprendizajes);
    expect(edicion.actor_id).toBe(leadId);
    expect(edicion.actor_rol).toBe('lead-boutique');
    // Redactar el borrador NO es completarlo: el evento del cierre no se emite aquí.
    expect((await de('OutcomeReviewCompletado')).length).toBe(0);

    // Se deja como estaba, igual que el resultado: lo que se probaba era el rastro.
    await conUsuario(leadId, (tx) => tx`update outcome_review
      set contribucion = ${borradorPrevio!.contribucion as string}
      where id = ${reviewId} and workspace_id = ${ws}`);
  });

  it('el veredicto es del catálogo cerrado, honesto con los datos y exige justificar la causalidad', async () => {
    const admin = sqlAdmin();
    // Catálogo CERRADO en la base (SYS-24): un quinto valor no existe ni por SQL directo.
    await expect(
      conUsuario(leadId, (tx) => tx`update outcome_review
        set veredicto = 'éxito rotundo' where id = ${reviewId}`),
    ).rejects.toThrow(/check constraint/);
    // El lenguaje causal no es el default: el flag SIN justificación lo rechaza el CHECK.
    await expect(
      conUsuario(leadId, (tx) => tx`update outcome_review
        set diseno_experimental_suficiente = true where id = ${reviewId}`),
    ).rejects.toThrow(/check constraint/);

    // «Logrado» con un criterio sin dato final es la presión por demostrar éxito que la
    // spec nombra como riesgo: el guard lo frena y ofrece los veredictos honestos.
    await expect(
      completarOutcomeReview(leadId, {
        workspaceId: ws,
        reviewId,
        veredicto: 'logrado',
        contribucion: 'El rediseño contribuyó a la caída del abandono',
        factoresExternos: '',
        hipotesisAbiertas: '',
        aprendizajes: '',
        disenoExperimentalSuficiente: false,
        disenoExperimentalJustificacion: '',
      }),
    ).rejects.toThrow(/sin dato final/);

    // Y el stakeholder no dicta veredictos.
    await expect(
      completarOutcomeReview(stakeId, {
        workspaceId: ws,
        reviewId,
        veredicto: 'no-concluyente',
        contribucion: 'nada que decir',
        factoresExternos: '',
        hipotesisAbiertas: '',
        aprendizajes: '',
        disenoExperimentalSuficiente: false,
        disenoExperimentalJustificacion: '',
      }),
    ).rejects.toThrow(ErrorMedicion);
    const [sigueBorrador] = await admin`select estado from outcome_review where id = ${reviewId}`;
    expect(sigueBorrador!.estado).toBe('borrador');
  });

  it('el proyecto no cierra por su cuenta: lo cierra el outcome review completado', async () => {
    // Con el proyecto en medición, cualquier lead con el rol de app podía pasarlo a
    // 'cerrado' sin post mortem: quedaba un proyecto INMUTABLE (SYS-08) mientras su reto
    // seguía midiendo y aceptando snapshots, saltándose la operación que cierra ambos
    // objetos con veredicto (RF-07.10). El guard lo ata a la única mano que escribe
    // `reto.veredicto` —la completación del review—, así que no hay atajo por SQL directo.
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'cerrado'
        where id = ${proyectoId}`),
    ).rejects.toThrow(/outcome review de su reto/);
    const [sigue] = await conUsuario(leadId, (tx) => tx`select estado from proyecto
      where id = ${proyectoId}`);
    expect(sigue!.estado).toBe('en-medicion');
    // El reto tampoco: cerrarlo exige el veredicto, que no tiene grant para el rol de app.
    const [reto] = await conUsuario(leadId, (tx) => tx`select estado from reto
      where id = ${retoId}`);
    expect(reto!.estado).toBe('en-medicion');
  });

  it('completar el review cierra el reto CON veredicto y el proyecto, ambos inmutables', async () => {
    // Cerrar sin veredicto es imposible incluso por SQL directo: reto.veredicto no tiene
    // grant para el rol de app y el guard lo exige (SYS-24).
    await expect(
      conUsuario(leadId, (tx) => tx`update reto set estado = 'cerrado' where id = ${retoId}`),
    ).rejects.toThrow(/exige el veredicto del outcome review/);

    const admin = sqlAdmin();
    const edicionesDelReview = () => admin`select 1 from evento_dominio
      where workspace_id = ${ws} and tipo = 'OutcomeReviewEditado'
        and payload->>'reviewId' = ${reviewId}`;
    const edicionesAntesDelCierre = await edicionesDelReview();

    const r = await completarOutcomeReview(leadId, {
      workspaceId: ws,
      reviewId,
      veredicto: 'parcialmente-logrado',
      contribucion:
        'El abandono cayó de 62 a 49 tras el rediseño; la serie es consistente con la contribución del cambio',
      factoresExternos: 'Campaña de nómina del cliente en el mismo trimestre',
      hipotesisAbiertas: '¿Cuánto pesa el canal sucursal en el resto del embudo?',
      aprendizajes: 'El dueño del dato debe tener acceso directo al panel',
      disenoExperimentalSuficiente: false,
      disenoExperimentalJustificacion: '',
    });
    expect(r.veredicto).toBe('parcialmente-logrado');

    const seg = await seguimientoDeImpacto(stakeId, ws, proyectoId);
    expect(seg!.retoEstado).toBe('cerrado');
    expect(seg!.retoVeredicto).toBe('parcialmente-logrado');
    expect(seg!.proyectoEstado).toBe('cerrado');
    expect(seg!.review!.estado).toBe('completado');
    expect(seg!.review!.disenoExperimentalSuficiente).toBe(false);

    const edicionesTrasCierre = await edicionesDelReview();
    const [evento] = await admin`select actor_id, payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'OutcomeReviewCompletado' order by creado_en desc limit 1`;
    expect(evento!.actor_id).toBe(leadId);
    const cuerpoCierre = evento!.payload as Record<string, unknown>;
    expect(cuerpoCierre.veredicto).toBe('parcialmente-logrado');
    // La completación congela el RAZONAMIENTO además del veredicto: la misma sentencia
    // escribe contribución, factores, hipótesis y aprendizajes. Sin ellos en el evento, el
    // rastro decía QUÉ se dictaminó y perdía CON QUÉ se dictaminó, que es la mitad que un
    // post mortem existe para dejar. Y con su «antes», porque completar también reescribe
    // lo que hubiera en el borrador.
    expect(cuerpoCierre.aprendizajes).toBe('El dueño del dato debe tener acceso directo al panel');
    expect(cuerpoCierre.factoresExternos).toBe(
      'Campaña de nómina del cliente en el mismo trimestre',
    );
    expect(cuerpoCierre.disenoExperimentalSuficiente).toBe(false);
    const antesCierre = cuerpoCierre.antes as Record<string, unknown>;
    expect(antesCierre.veredicto).toBeNull();
    // Las tres columnas del grant que faltaban en la narrativa: el estado —que la
    // transición mueve— y la FIRMA del post mortem. El WITH CHECK solo ata
    // `completado_por`/`completado_en` en la rama de la completación, así que en un
    // borrador se pueden escribir sueltas y sin ellas aquí no dejarían rastro.
    expect(antesCierre.estado).toBe('borrador');
    expect(cuerpoCierre.estado).toBe('completado');
    expect(cuerpoCierre.completadoPor).toBe(leadId);
    expect(cuerpoCierre.completadoEn).not.toBeNull();
    // Un solo evento por escritura: la transición NO emite además el de la edición en
    // sitio, aunque toque las mismas columnas y el trigger de auditoría corra en los dos.
    expect(edicionesTrasCierre.length).toBe(edicionesAntesDelCierre.length);

    // Cerrado = inmutable (SYS-08): ni snapshots nuevos, ni proyecto reabierto, ni
    // review reescrito.
    await expect(
      registrarSnapshot(leadId, {
        workspaceId: ws,
        entradaId: entradaAbandonoId,
        valor: '30',
        fecha: fecha(0),
        nota: 'tardío',
      }),
    ).rejects.toThrow(/el reto ya no está en medición/);
    const reabierto = await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'activo'
      where id = ${proyectoId}`);
    expect(reabierto.count).toBe(0);
    const reescrito = await conUsuario(leadId, (tx) => tx`update outcome_review
      set contribucion = 'otra historia' where id = ${reviewId}`);
    expect(reescrito.count).toBe(0);
    await expect(
      registrarResultado(leadId, {
        workspaceId: ws,
        reviewId,
        criterioId: criterioAbandonoId,
        snapshotFinalId: null,
        lectura: '',
        sinDatosMotivo: 'reescribir la historia',
      }),
    ).rejects.toThrow(ErrorMedicion);
  });

  it('un proyecto CERRADO no se reabre', async () => {
    // El proyecto quedó cerrado al completar el outcome review: reabrir una etapa lo
    // devolvería a 'en-curso' y marcaría en revisión decisiones que ya son historia
    // (SYS-08). El trabajo posterior es un reto nuevo.
    await expect(
      reabrirEtapa(leadId, {
        workspaceId: ws,
        proyectoId,
        etapaNumero: 3,
        motivo: 'Reabrir lo ya cerrado',
        insightIds: [],
      }),
    ).rejects.toThrow();
  });

  it('reabrir una etapa se serializa con el cierre del post mortem: candado y fila', async () => {
    // El proyecto principal cerró al completarse el outcome review. La política nueva
    // («el proyecto no está cerrado») es un predicado sobre un SNAPSHOT, no un candado:
    // reabrir toca `etapa_instancia`/`decision` y completar toca `outcome_review`/`reto`/
    // `proyecto`, así que nada obliga a los dos caminos a verse. La completación cierra el
    // proyecto y commitea; la reapertura, que evaluó su predicado antes, commitea después
    // una etapa `en-curso` y decisiones `en-revision` sobre historia inmutable (SYS-08).
    const reapertura = () =>
      reabrirEtapa(leadId, {
        workspaceId: ws,
        proyectoId,
        etapaNumero: 3,
        motivo: 'Reabrir mientras el post mortem cierra',
        insightIds: [],
      });

    // 1) El candado del servicio: el MISMO del reto que toma completarOutcomeReview.
    expect(
      await esperaA(
        (tx) => tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`,
        reapertura,
      ),
    ).toBe(true);

    // 2) Y la FILA del proyecto, que es lo que las dos operaciones se disputan: el guard
    //    la bloquea, así que el SQL directo tampoco se cuela por el hueco.
    expect(
      await esperaA((tx) => tx`select 1 from proyecto where id = ${proyectoId} for update`, reapertura),
    ).toBe(true);

    // 3) Y el motivo lo dicta la base, no un 0-filas silencioso.
    await expect(reapertura()).rejects.toThrow(/el proyecto está cerrado/);
  });

  it('firmar el registry se serializa con la edición de criterios: candado y fila del G0', async () => {
    // Se fabrica un proyecto con la HISTORIA que este esquema no contempla: G0-G6
    // aprobados cuando la regla «G6 exige registry firmado» todavía no existía. Es la
    // única forma de tener una firma de verdad que probar aquí, porque el registry
    // principal ya está firmado y la firma es de ida.
    const admin = sqlAdmin();
    const heredado = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-73',
      titulo: 'Proyecto que pasó G6 antes de este esquema',
      descripcion: '',
      origen: 'peticion-cliente',
      metricaObjetivo: '8→4',
      serviciosAfectados: [],
    });
    retoHeredadoId = heredado.retoId;
    const act = await activarReto(leadId, {
      workspaceId: ws,
      retoId: retoHeredadoId,
      perfil: 'rapido',
      proyectoCodigo: 'P-73',
      proyectoTitulo: 'Implementación ya planificada',
    });
    proyectoHeredadoId = act.proyectoId;
    const c = await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId: retoHeredadoId,
      kpi: 'Tiempo de respuesta',
      definicion: 'Minutos medios hasta la primera respuesta',
      lineaBaseValor: '8',
      lineaBaseFecha: fecha(-200),
      lineaBasePlan: '',
      objetivo: '4',
      ventanaDias: 30,
      fechaPostMortem: null,
    });
    criterioHeredadoId = c.criterioId;
    // El guard que hoy exige el registry en G6 es `before update`, así que se apaga solo
    // para ESCRIBIR ese pasado: es lo único que la base no deja inventar de otra forma.
    await admin`alter table gate_instancia disable trigger gate_aprobar_suficiencia`;
    try {
      await admin`update gate_instancia
        set estado = 'aprobado', aprobado_por = ${leadId}, aprobado_en = now()
        where proyecto_id = ${proyectoHeredadoId} and numero <= 6`;
    } finally {
      await admin`alter table gate_instancia enable trigger gate_aprobar_suficiencia`;
    }
    await admin`update etapa_instancia set estado = 'completada'
      where proyecto_id = ${proyectoHeredadoId} and numero <= 6`;
    // …y lo que la MIGRACIÓN habría marcado al desplegarse sobre esa historia.
    await admin`update gate_instancia set aprobado_sin_registry = true
      where proyecto_id = ${proyectoHeredadoId} and numero = 6`;

    const reg = await abrirRegistry(leadId, { workspaceId: ws, retoId: retoHeredadoId });
    registryHeredadoId = reg.registryId;
    const firmar = () =>
      firmarRegistry(sponsorId, { workspaceId: ws, registryId: registryHeredadoId });

    // Firmar CONGELA los criterios, así que tiene que excluirse con quien los muta. Los
    // dos caminos tomaban candados distintos (reto contra registry) y tocan tablas
    // distintas: la firma validaba el criterio viejo y commiteaba, y la edición en vuelo
    // commiteaba después su `objetivo` o su `ventana_dias` nuevos — el contrato cambiaba
    // justo después de firmarse, que es lo único que la firma existe para impedir.
    // 1) El candado del servicio: el MISMO del reto que toman agregar/editarCriterio.
    expect(
      await esperaA(
        (tx) =>
          tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoHeredadoId}, 42))`,
        firmar,
      ),
    ).toBe(true);

    // 2) Y la cita en la BASE, para el SQL directo: la misma fila del G0 que bloquea
    //    `criterio_g0_pendiente_guard`. Se elige el gate y no los criterios porque un
    //    criterio NUEVO no existe todavía como fila que bloquear, y su INSERT pasa por
    //    ese mismo guard.
    expect(
      await esperaA(
        (tx) => tx`select 1 from gate_instancia
          where proyecto_id = ${proyectoHeredadoId} and numero = 0 for update`,
        firmar,
      ),
    ).toBe(true);

    // 3) Y la tercera cita del barrido, que necesita un registry todavía en BORRADOR:
    //    escribir una entrada KPI contra la firma. Sin ella, la firma valida el contrato
    //    y una entrada en vuelo lo muta justo después de congelarse.
    expect(
      await esperaA(
        (tx) => tx`select 1 from reto
          where id = ${retoHeredadoId} and workspace_id = ${ws} for update`,
        () =>
          agregarEntrada(leadId, {
            workspaceId: ws,
            registryId: registryHeredadoId,
            criterioId: criterioHeredadoId,
            nombre: 'KPI que llega mientras se firma',
            definicion: 'x',
            fuente: 'x',
            dimensiones: '',
            propietarioMiembroId: sponsorMiembroId,
            frecuencia: 'mensual',
            dashboardUrl: '',
            lineaBaseValor: '1',
            lineaBaseFecha: fecha(-200),
            ventanaInicio: fecha(-3),
            fechaPostMortem: fecha(40),
          }),
      ),
    ).toBe(true);
    // Esa entrada entró de verdad (el registry seguía en borrador), así que se retira para
    // que el test de la firma heredada siga contando una sola.
    await sqlAdmin()`delete from entrada_kpi
      where registry_id = ${registryHeredadoId} and nombre = 'KPI que llega mientras se firma'`;

    // El rechazo de esos intentos es el del CONTENIDO: la política dejó pasar la firma
    // (G6 heredado) y habló el guard, que es lo que hace válido el bloqueo de arriba.
    await expect(firmar()).rejects.toThrow(/no tiene entradas KPI/);
  });

  it('un proyecto que pasó G6 antes de este esquema firma su registry; sin la marca, no', async () => {
    // Sin una salida, este slice dejaba varado a todo proyecto activo con G6 ya aprobado:
    // su registry nace borrador, la firma exige G6 pendiente, un gate aprobado es
    // inmutable y la reapertura no lo devuelve a pendiente — y sin registry firmado no
    // hay medición. La marca de la migración es esa salida, y solo para esas filas.
    const admin = sqlAdmin();
    await admin`update gate_instancia set aprobado_sin_registry = false
      where proyecto_id = ${proyectoHeredadoId} and numero = 6`;
    await expect(
      firmarRegistry(sponsorId, { workspaceId: ws, registryId: registryHeredadoId }),
    ).rejects.toThrow(/El G6 ya fue aprobado/);
    await admin`update gate_instancia set aprobado_sin_registry = true
      where proyecto_id = ${proyectoHeredadoId} and numero = 6`;

    // Lo que se perdona es el MOMENTO, no el contenido: el contrato se redacta y se firma
    // de verdad, con su guard de completitud intacto.
    await agregarEntrada(leadId, {
      workspaceId: ws,
      registryId: registryHeredadoId,
      criterioId: criterioHeredadoId,
      nombre: 'Minutos hasta primera respuesta',
      definicion: 'Media por solicitud atendida',
      fuente: 'Cola de soporte',
      dimensiones: '',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'semanal',
      dashboardUrl: '',
      lineaBaseValor: '8',
      lineaBaseFecha: fecha(-200),
      ventanaInicio: fecha(-3),
      fechaPostMortem: fecha(40),
    });
    const firma = await firmarRegistry(sponsorId, {
      workspaceId: ws,
      registryId: registryHeredadoId,
    });
    expect(firma.entradas).toBe(1);

    // Y la marca del gate era MEDIA historia. G6 no es solo un permiso: es el momento en
    // que el proyecto entra en implementación (§7), y ese efecto lo pone un trigger que
    // solo mira los `pendiente → aprobado` FUTUROS — así que este proyecto se quedó en
    // 'activo' con su plan ya acordado. Tras su G7 pasaba directo de 'activo' a medición,
    // saltándose entera la fase que su propio G6 significaba. El par ya no existe, así que
    // ni por SQL directo: una regla que gobierna las transiciones nuevas tiene que venir
    // con el movimiento de lo que ya estaba en el estado anterior.
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-medicion'
        where id = ${proyectoHeredadoId}`),
    ).rejects.toThrow(/transición de proyecto ilegal: activo → en-medicion/);
    // Ese movimiento es el que hace la migración con el MISMO predicado que su sentencia
    // (proyecto 'activo' con G6 aprobado), y con él el camino vuelve a ser el del método.
    await admin`update proyecto p set estado = 'en-implementacion'
      where p.id = ${proyectoHeredadoId} and p.estado = 'activo'
        and exists (select 1 from gate_instancia g
          where g.proyecto_id = p.id and g.workspace_id = p.workspace_id
            and g.numero = 6 and g.estado = 'aprobado')`;
    const [faseHeredada] = await conUsuario(leadId, (tx) => tx`select estado from proyecto
      where id = ${proyectoHeredadoId}`);
    expect(faseHeredada!.estado).toBe('en-implementacion');

    // Y deja de estar varado: con el contrato firmado, su G7 se aprueba y la medición abre.
    await aprobarGateNumero(7, proyectoHeredadoId);
    // El camino NORMAL —reto activo— sigue ofreciéndose en la pantalla: el espejo del
    // cliente ensancha el predicado, no lo cambia de sitio.
    const segNormal = await seguimientoDeImpacto(leadId, ws, proyectoHeredadoId);
    expect(segNormal!.retoEstado).toBe('activo');
    expect(segNormal!.proyectoEstado).toBe('en-implementacion');
    expect(medicionPorAbrir(segNormal!)).toBe(true);
    const abierto = await abrirMedicion(leadId, { workspaceId: ws, retoId: retoHeredadoId });
    expect(abierto.proyectos).toBe(1);
  });

  it('un reto que YA estaba midiendo sin contrato deja de estar encerrado', async () => {
    // El ciclo anterior admitía `activo → en-medicion` sin registry, porque la medición no
    // existía. Este slice les quitaba la única salida: cerrar exige veredicto, el veredicto
    // exige review, el review exige registry firmado, y el registry no se podía ni abrir
    // sobre un reto que no está 'activo' — que además no vuelve a 'activo' ni se archiva.
    const admin = sqlAdmin();
    const viejo = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-74',
      titulo: 'Reto que ya venía midiendo fuera del sistema',
      descripcion: '',
      origen: 'peticion-cliente',
      metricaObjetivo: '30→20',
      serviciosAfectados: [],
    });
    const actVieja = await activarReto(leadId, {
      workspaceId: ws,
      retoId: viejo.retoId,
      perfil: 'rapido',
      proyectoCodigo: 'P-74',
      proyectoTitulo: 'Rediseño ya implantado',
    });
    const criterioViejo = await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId: viejo.retoId,
      kpi: 'Llamadas por solicitud',
      definicion: 'Contactos hasta resolver',
      lineaBaseValor: '30',
      lineaBaseFecha: fecha(-200),
      lineaBasePlan: '',
      objetivo: '20',
      // Igual que el criterio de abandono: su entrada es MENSUAL, así que la ventana tiene
      // que contener un mes de calendario cuente el mes que cuente. El test de la cadencia
      // la fija después en 30 con fechas absolutas, que es donde ese día de diferencia es
      // justo lo que se quiere medir.
      ventanaDias: 31,
      fechaPostMortem: null,
    });
    // Se apagan los DOS triggers de la transición para escribir el pasado que la base ya
    // no permite: pasar a medición sin registry firmado (guard de transición) y dejando el
    // proyecto atrás (par indivisible, que es justo el estado que estas filas tienen y por
    // el que hay que repararlas).
    await admin`alter table reto disable trigger reto_estado_transicion`;
    await admin`alter table reto disable trigger reto_medicion_par_indivisible`;
    try {
      await admin`update reto set estado = 'en-medicion' where id = ${viejo.retoId}`;
    } finally {
      await admin`alter table reto enable trigger reto_estado_transicion`;
      await admin`alter table reto enable trigger reto_medicion_par_indivisible`;
    }

    // Control: SIN la marca de la migración, el reto sigue encerrado — un reto que llegue
    // a medición por el camino normal ya trae registry, así que esta rama no le sirve.
    await expect(abrirRegistry(leadId, { workspaceId: ws, retoId: viejo.retoId })).rejects.toThrow(
      ErrorMedicion,
    );
    await admin`update reto set medicion_sin_registry = true where id = ${viejo.retoId}`;

    // Con ella, el contrato se abre y el camino vuelve a ser el normal.
    const reg = await abrirRegistry(leadId, { workspaceId: ws, retoId: viejo.retoId });
    await expect(
      abrirMedicion(leadId, { workspaceId: ws, retoId: viejo.retoId }),
    ).rejects.toThrow(/Metric Registry firmado en G6/);
    const entradaVieja = await agregarEntrada(leadId, {
      workspaceId: ws,
      registryId: reg.registryId,
      criterioId: criterioViejo.criterioId,
      nombre: 'Llamadas medias',
      definicion: 'Contactos hasta resolver, por solicitud',
      fuente: 'Central telefónica',
      dimensiones: '',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'mensual',
      dashboardUrl: '',
      lineaBaseValor: '30',
      lineaBaseFecha: fecha(-200),
      // La ventana que llevaba corriendo, declarada ahora: ya cerró.
      ventanaInicio: fecha(-40),
      fechaPostMortem: fecha(5),
    });
    entradaViejaId = entradaVieja.entradaId;
    proyectoViejoId = actVieja.proyectoId;
    for (const n of [0, 1, 2, 3, 4, 5]) {
      await aprobarGateNumero(n, actVieja.proyectoId);
    }
    const firma = await firmarRegistry(sponsorId, {
      workspaceId: ws,
      registryId: reg.registryId,
    });
    expect(firma.entradas).toBe(1);
    // ── El ciclo de vida del proyecto, con `pausado` de por medio ──
    // Con el proyecto PARADO, aprobar el gate que autoriza implementar es una
    // contradicción: se rechaza la aprobación entera en vez de dejarla pasar sin efecto.
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'pausado'
      where id = ${actVieja.proyectoId}`);
    await expect(aprobarGateNumero(6, actVieja.proyectoId)).rejects.toThrow(
      /con el proyecto parado/,
    );
    // Y el gate sigue PENDIENTE: lo que se descarta es el no-op silencioso, que dejaba el
    // gate aprobado y el proyecto quieto para siempre.
    const [g6Parado] = await conUsuario(leadId, (tx) => tx`select estado from gate_instancia
      where proyecto_id = ${actVieja.proyectoId} and numero = 6`);
    expect(g6Parado!.estado).toBe('pendiente');

    // Y la mitad que una sola sesión no ve: DECIDIR sobre una instantánea y ESCRIBIR sobre
    // un candado. El guard leía `proyecto.estado` sin bloquear y actualizaba después sin
    // pedir estado en el `where`. Con otra sesión pausando el proyecto en medio, la lectura
    // veía 'activo' y no levantaba, el update esperaba, y al soltarse casaba igual — y
    // `pausado → en-implementacion` es un par LEGAL cuya única precondición, «G6 aprobado»,
    // la cumple la propia sentencia en vuelo. La pausa se borraba sin que nadie la
    // deshiciera. Ahora el estado va en el `where` —así el UPDATE reevalúa DESPUÉS del
    // candado, que es lo único que ve la pausa ajena— y el post-chequeo de lo afectado
    // convierte el cero en el rechazo de la aprobación entera.
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'activo'
      where id = ${actVieja.proyectoId}`);
    let avisarPausado = () => {};
    const pausado = new Promise<void>((resolve) => {
      avisarPausado = resolve;
    });
    const pausando = sqlAdmin().begin(async (tx) => {
      await tx`update proyecto set estado = 'pausado' where id = ${actVieja.proyectoId}`;
      avisarPausado();
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await pausado;
    await expect(aprobarGateNumero(6, actVieja.proyectoId)).rejects.toThrow(
      /con el proyecto parado/,
    );
    await pausando;
    // La pausa sigue puesta y el gate sigue pendiente: nadie deshizo lo que el otro decidió.
    const [trasCarrera] = await conUsuario(leadId, (tx) => tx`select estado from proyecto
      where id = ${actVieja.proyectoId}`);
    expect(trasCarrera!.estado).toBe('pausado');
    const [g6TrasCarrera] = await conUsuario(leadId, (tx) => tx`select estado
      from gate_instancia where proyecto_id = ${actVieja.proyectoId} and numero = 6`);
    expect(g6TrasCarrera!.estado).toBe('pendiente');

    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'activo'
      where id = ${actVieja.proyectoId}`);
    await aprobarGateNumero(6, actVieja.proyectoId);
    const [enImplementacion] = await conUsuario(leadId, (tx) => tx`select estado from proyecto
      where id = ${actVieja.proyectoId}`);
    expect(enImplementacion!.estado).toBe('en-implementacion');

    // Implementando también se puede parar — y retomar es DETERMINISTA: con el G6 aprobado
    // vuelve a implementación, no a 'activo', que sería andar hacia atrás en el método y
    // dejarlo saltar a medición saltándose la fase que acaba de empezar.
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'pausado'
      where id = ${actVieja.proyectoId}`);
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'activo'
        where id = ${actVieja.proyectoId}`),
    ).rejects.toThrow(/vuelve a implementación/);
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-implementacion'
      where id = ${actVieja.proyectoId}`);

    await aprobarGateNumero(7, actVieja.proyectoId);

    // La reparación tiene que estar OFRECIDA, no solo existir. La pantalla decide con el
    // espejo del cliente, y escrito como «el reto está activo» a secas no se dibujaba
    // nunca para el ÚNICO caso que necesita esta operación: el reto heredado ya mide, así
    // que jamás está activo. La salida existía en el servicio y era inalcanzable desde el
    // producto —y sin ella el proyecto se queda fuera de medición y su outcome review no
    // puede completarse, porque el guard del cierre exige que el proyecto esté midiendo.
    const segAntes = await seguimientoDeImpacto(leadId, ws, actVieja.proyectoId);
    expect(segAntes!.medicionSinRegistry).toBe(true);
    expect(segAntes!.retoEstado).toBe('en-medicion');
    expect(segAntes!.proyectoEstado).toBe('en-implementacion');
    expect(medicionPorAbrir(segAntes!)).toBe(true);

    // El reto ya está donde toca; lo que faltaba era su PROYECTO, que bajo el ciclo
    // anterior ni siquiera tenía grant para moverse. La operación lo termina en vez de
    // negarse, que es lo que dejaba el tablero mintiendo sin forma de arreglarlo.
    const abierto = await abrirMedicion(leadId, { workspaceId: ws, retoId: viejo.retoId });
    expect(abierto.proyectos).toBe(1);
    const seg = await seguimientoDeImpacto(leadId, ws, actVieja.proyectoId);
    expect(seg!.retoEstado).toBe('en-medicion');
    expect(seg!.proyectoEstado).toBe('en-medicion');
    // Y deja de ofrecerse en cuanto no queda nada que abrir. La marca del perdón histórico
    // no se borra al reparar —la escribió la migración y nadie la vuelve a escribir—, así
    // que un espejo que mirara solo la marca seguiría dibujando el botón para que fallara.
    // Lo que decide es el PROYECTO, que es lo que la operación mueve.
    expect(medicionPorAbrir(seg!)).toBe(false);
    // Y ya no está encerrado: con la ventana cerrada, el post mortem se abre y podrá
    // dictar un veredicto de verdad en vez de quedarse sin salida.
    const review = await abrirOutcomeReview(leadId, { workspaceId: ws, retoId: viejo.retoId });
    expect(review.reviewId).toBeTruthy();
    // Y sin la marca —un reto que llegó a medición por el camino normal, con su registry
    // firmado antes— la operación dice que ya está abierta en vez de mover nada.
    await admin`update reto set medicion_sin_registry = false where id = ${viejo.retoId}`;
    await expect(abrirMedicion(leadId, { workspaceId: ws, retoId: viejo.retoId })).rejects.toThrow(
      /ya está abierta/,
    );
  });

  it('la cadencia es un compromiso de CALENDARIO: «mensual» es el mes siguiente, no 30 días', async () => {
    // Convertir «mensual»/«trimestral» a 30/90 días fijos hace que la fecha prometida
    // dependa de la longitud del mes: un dato del 1 de agosto vencía el 31 y entraba en
    // mora el 1 de septiembre —antes de que tocara el de septiembre—, y uno del 31 de enero
    // no vencía hasta el 2 de marzo en vez del 28 de febrero. La cadencia es un compromiso
    // de calendario, no aritmética: `+ interval '1 month'` respeta el fin de mes y `+ 30`
    // no.
    //
    // El caso se fija con fechas ABSOLUTAS y sobre la ventana ya CERRADA, que es la única
    // rama donde los dos extremos de la comparación son datos del CONTRATO («la próxima
    // entrega vencía dentro de la ventana») y no `current_date`. Con fechas relativas a hoy
    // la diferencia entre 30 días y un mes solo se manifiesta si el mes recién pasado tiene
    // 31, así que el test pasaría o fallaría según el día en que se ejecutase — que es
    // exactamente el defecto que se está corrigiendo. La aritmética es la MISMA expresión
    // (`cad.paso`) en las cuatro ramas del estado, así que fijarla aquí la fija entera.
    //
    // Ventana [2026-03-01, 2026-03-31]: un mes de calendario y 30 días de aritmética, que es
    // donde las dos reglas se separan. Con el dato el día que abre, la cadencia mensual
    // promete el siguiente el 1 de abril, o sea DESPUÉS del cierre: no se debe ninguno más y
    // la medición terminó cumplida. Con 30 días fijos habría una entrega vencida el 31 de
    // marzo —el último día de la ventana— que el contrato nunca prometió.
    const admin = sqlAdmin();
    const [previa] = await admin`select
      (select ventana_inicio::text from entrada_kpi where id = ${entradaViejaId}) as inicio,
      (select c.ventana_dias from criterio_exito c
        join entrada_kpi e on e.criterio_id = c.id where e.id = ${entradaViejaId}) as dias`;
    // La ventana se fija ENTERA aquí —inicio y largo— en vez de heredar el largo del
    // fixture: los 30 días son la mitad del caso (marzo tiene 31), y un test que depende de
    // un número escrito trescientas líneas más arriba deja de decir lo que prueba.
    await admin`update entrada_kpi set ventana_inicio = '2026-03-01'
      where id = ${entradaViejaId}`;
    await admin`update criterio_exito set ventana_dias = 30
      where id = (select criterio_id from entrada_kpi where id = ${entradaViejaId})`;
    const leer = async () =>
      (await seguimientoDeImpacto(leadId, ws, proyectoViejoId))!.entradas.find(
        (e) => e.id === entradaViejaId,
      )!;
    try {
      // Control: la ventana cerrada sin un solo dato es 'vencido' pase lo que pase, así que
      // el estado que distingue las dos reglas necesita la serie cumplida.
      expect((await leer()).estadoSnapshot).toBe('vencido');

      // El dato entra por el camino normal: cae dentro de la ventana firmada y lo carga el
      // propietario del dato, aunque la ventana ya sea historia.
      await registrarSnapshot(sponsorId, {
        workspaceId: ws,
        entradaId: entradaViejaId,
        valor: '24',
        fecha: '2026-03-01',
        nota: 'primer corte del mes',
      });
      const llamadas = await leer();
      expect(llamadas.ultimaFecha).toBe('2026-03-01');
      expect(llamadas.estadoSnapshot).toBe('cerrado');
    } finally {
      // Fixture: la ventana vuelve a donde estaba y el snapshot que solo existía para fijar
      // el corte se va con ella. Solo el rol admin puede borrarlo (SYS-23).
      await admin`delete from snapshot where entrada_kpi_id = ${entradaViejaId}`;
      await admin`update entrada_kpi set ventana_inicio = ${previa!.inicio as string}
        where id = ${entradaViejaId}`;
      await admin`update criterio_exito set ventana_dias = ${previa!.dias as number}
        where id = (select criterio_id from entrada_kpi where id = ${entradaViejaId})`;
    }
  });

  it('el ciclo del proyecto es de sentido único y ningún estado inventado entra', async () => {
    // Otro proyecto activo del workspace (el del reto sin registry) para probar los
    // pares: activo→cerrado se salta la medición; «terminado» no existe.
    const [otro] = await conUsuario(leadId, (tx) => tx`select id from proyecto
      where workspace_id = ${ws} and codigo = 'P-72'`);
    const otroId = otro!.id as string;
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'cerrado' where id = ${otroId}`),
    ).rejects.toThrow(/transición de proyecto ilegal: activo → cerrado/);
    // Un estado inventado ni siquiera llega al CHECK del catálogo: el guard de pares
    // habla primero (y el CHECK queda de respaldo para cualquier ruta futura).
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'terminado' where id = ${otroId}`),
    ).rejects.toThrow(/transición de proyecto ilegal: activo → terminado/);
    // Y entrar en implementación exige el G6 APROBADO: el estado no se elige, se gana.
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-implementacion'
        where id = ${otroId}`),
    ).rejects.toThrow(/al aprobarse su G6/);
    // Pausar y retomar sí es reversible (el método admite pausas del cliente).
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'pausado' where id = ${otroId}`);
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'activo' where id = ${otroId}`);
    // Y el stakeholder no mueve proyectos.
    const filas = await conUsuario(stakeId, (tx) => tx`update proyecto set estado = 'pausado'
      where id = ${otroId}`);
    expect(filas.count).toBe(0);
  });

  it('el veredicto obligatorio no aborta el deploy sobre un reto cerrado heredado', async () => {
    const admin = sqlAdmin();
    const donde = { conname: 'reto_cerrado_con_veredicto' };
    // En una base LIMPIA no hay nada que arrastrar y la migración lo valida en el acto:
    // el constraint queda plenamente confiable donde puede estarlo.
    const [antes] = await admin`select convalidated from pg_constraint
      where conname = ${donde.conname} and conrelid = 'reto'::regclass`;
    expect(antes!.convalidated).toBe(true);

    // Y se reproduce el deploy sobre una base CON historia: el ciclo anterior admitía
    // `en-medicion → cerrado` cuando la columna `veredicto` ni existía, así que esas filas
    // son legales y validar el CHECK contra ellas abortaría la migración entera —y con
    // ella el arranque, porque cada archivo corre en UNA transacción. El DDL de PostgreSQL
    // es transaccional: la simulación completa se revierte y el esquema queda intacto.
    const centinela = 'revertir la simulación del deploy';
    await expect(
      admin.begin(async (tx) => {
        await tx`set local lock_timeout = '30s'`;
        await tx`alter table reto drop constraint reto_cerrado_con_veredicto`;
        const [heredado] = await tx`insert into reto
          (workspace_id, servicio_ancla_id, codigo, titulo, estado, creado_por)
          values (${ws}, ${svcId}, 'R-HEREDADO', 'Cerrado antes de que hubiera post mortem',
                  'cerrado', ${leadId})
          returning id`;
        const heredadoId = heredado!.id as string;

        // 1) El deploy NO aborta: el constraint entra NOT VALID, que es la forma que
        //    PostgreSQL tiene de decir «esto se exige a todo lo nuevo y no afirmo nada
        //    sobre lo ya escrito».
        await tx`alter table reto add constraint reto_cerrado_con_veredicto
          check (estado <> 'cerrado' or veredicto is not null) not valid`;
        const [recien] = await tx`select convalidated from pg_constraint
          where conname = ${donde.conname} and conrelid = 'reto'::regclass`;
        expect(recien!.convalidated).toBe(false);

        // 2) A la fila histórica no se le inventa un veredicto: el catálogo de SYS-24
        //    tiene cuatro valores y ninguno significa «se cerró antes de que existiera el
        //    post mortem». «No concluyente» afirmaría que lo hubo y no concluyó, y
        //    contaminaría la métrica de loop cerrado (§17). Ausencia se codifica null.
        const [fila] = await tx`select veredicto from reto where id = ${heredadoId}`;
        expect(fila!.veredicto).toBeNull();

        // 3) NOT VALID no es «apagado»: toda escritura NUEVA sí se exige.
        await expect(
          tx.savepoint((sp) => sp`insert into reto
            (workspace_id, servicio_ancla_id, codigo, titulo, estado, creado_por)
            values (${ws}, ${svcId}, 'R-NUEVO', 'Cierre sin veredicto', 'cerrado', ${leadId})`),
        ).rejects.toThrow(/reto_cerrado_con_veredicto/);

        // 4) Validar sigue fallando mientras quede deuda: por eso la migración cuenta esas
        //    filas ANTES y solo valida cuando no hay ninguna (si las hay, lo dice en un
        //    notice y sigue adelante en vez de tumbar el despliegue).
        await expect(
          tx.savepoint(
            (sp) => sp`alter table reto validate constraint reto_cerrado_con_veredicto`,
          ),
        ).rejects.toThrow(/reto_cerrado_con_veredicto/);

        // 5) Y saldada la deuda —aquí, con el veredicto que su post mortem tardío dictó—
        //    el VALIDATE pasa sin más DDL: la salida documentada existe y funciona.
        await tx`update reto set veredicto = 'no-concluyente' where id = ${heredadoId}`;
        await tx`alter table reto validate constraint reto_cerrado_con_veredicto`;
        const [saldado] = await tx`select convalidated from pg_constraint
          where conname = ${donde.conname} and conrelid = 'reto'::regclass`;
        expect(saldado!.convalidated).toBe(true);

        throw new Error(centinela);
      }),
    ).rejects.toThrow(centinela);

    // El esquema quedó como estaba: la simulación se revirtió entera.
    const [despues] = await admin`select convalidated from pg_constraint
      where conname = ${donde.conname} and conrelid = 'reto'::regclass`;
    expect(despues!.convalidated).toBe(true);
    const [heredados] = await admin`select count(*)::int as n from reto
      where workspace_id = ${ws} and codigo = 'R-HEREDADO'`;
    expect(heredados!.n).toBe(0);
  });

  it('aislamiento cross-tenant: otro workspace no ve ni escribe esta medición', async () => {
    const admin = sqlAdmin();
    const [wsX] = await admin`insert into workspace (nombre) values (${marca + '-X'}) returning id`;
    const [ux] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '-x@test.demo'}, 'Fisgón', 'activo') returning id`;
    const wsXId = wsX!.id as string;
    const uxId = ux!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsXId}, ${uxId}, 'Fisgón', ${marca + '-x@test.demo'}, 'lead-boutique')`;
    try {
      // Ni lectura de la serie…
      const filas = await conUsuario(uxId, (tx) => tx`select id from snapshot
        where workspace_id = ${ws}`);
      expect(filas.length).toBe(0);
      expect(await seguimientoDeImpacto(uxId, ws, proyectoId)).toBeNull();
      // …ni escritura apuntando a nuestro registry (el pre-chequeo de membresía de los
      // guards evita además cualquier mensaje delator).
      await expect(
        conUsuario(uxId, (tx) => tx`insert into snapshot
          (workspace_id, entrada_kpi_id, valor, fecha, origen, creado_por)
          values (${ws}, ${entradaAbandonoId}, 1, current_date, 'formulario', ${uxId})`),
      ).rejects.toThrow(/row-level security/);
      await expect(
        abrirRegistry(uxId, { workspaceId: ws, retoId }),
      ).rejects.toThrow(ErrorMedicion);
    } finally {
      await admin`delete from miembro where workspace_id = ${wsXId}`;
      await admin`delete from workspace where id = ${wsXId}`;
      await admin`delete from usuario where id = ${uxId}`;
    }
  });

  it('con el reto midiendo, retomar un proyecto pausado entra en MEDICIÓN y no por detrás', async () => {
    // El par «reto midiendo ⇔ proyecto midiendo» lo sostiene un constraint trigger que solo
    // corre cuando el reto ENTRA en medición, así que no ve nada de lo que pase DESPUÉS. Con
    // un reto de VARIOS proyectos, uno pausado se queda atrás a propósito («parar es del
    // cliente»), y retomarlo lo devolvía a 'activo' o a 'en-implementacion' —por detrás de un
    // reto que ya mide— sin que nadie levantara. Y de ahí no se salía: `abrirMedicion` se
    // niega a correr otra vez sobre un reto que ya mide y no es heredado, y el cierre del
    // post mortem no cierra un reto cuyo proyecto no está midiendo. El reto se quedaba sin
    // poder terminar por el camino normal del producto, que es el precio real del hueco.
    const admin = sqlAdmin();
    const r = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-75',
      titulo: 'Reto con dos frentes a la vez',
      descripcion: '',
      origen: 'peticion-cliente',
      metricaObjetivo: '9→5',
      serviciosAfectados: [],
    });
    const a = await activarReto(leadId, {
      workspaceId: ws,
      retoId: r.retoId,
      perfil: 'rapido',
      proyectoCodigo: 'P-75A',
      proyectoTitulo: 'Frente que llega a medición',
    });
    const c = await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId: r.retoId,
      kpi: 'Incidencias por semana',
      definicion: 'Incidencias abiertas por el cliente cada semana',
      lineaBaseValor: '9',
      lineaBaseFecha: fecha(-200),
      lineaBasePlan: '',
      objetivo: '5',
      ventanaDias: 30,
      fechaPostMortem: null,
    });
    for (const n of [0, 1, 2, 3, 4, 5]) {
      await aprobarGateNumero(n, a.proyectoId);
    }
    const reg = await abrirRegistry(leadId, { workspaceId: ws, retoId: r.retoId });
    await agregarEntrada(leadId, {
      workspaceId: ws,
      registryId: reg.registryId,
      criterioId: c.criterioId,
      nombre: 'Incidencias semanales',
      definicion: 'Incidencias abiertas por el cliente',
      fuente: 'Mesa de ayuda',
      dimensiones: '',
      propietarioMiembroId: sponsorMiembroId,
      frecuencia: 'semanal',
      dashboardUrl: '',
      lineaBaseValor: '9',
      lineaBaseFecha: fecha(-200),
      // Ventana ya CERRADA: así el post mortem de este reto se puede abrir y el caso llega
      // hasta el final del método, que es donde se ve el encierro.
      ventanaInicio: fecha(-40),
      fechaPostMortem: fecha(5),
    });
    await firmarRegistry(sponsorId, { workspaceId: ws, registryId: reg.registryId });
    await aprobarGateNumero(6, a.proyectoId);
    await aprobarGateNumero(7, a.proyectoId);

    // El SEGUNDO proyecto del reto: la activación solo sabe crear el primero, así que este
    // se escribe con el rol admin y con sus gates ya aprobados —lo único que el caso
    // necesita de él es su G7, que es lo que le permitirá seguir al reto al retomarse—.
    const [b] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${r.retoId}, 'P-75B', 'Frente que se para a mitad', ${leadId})
      returning id`;
    const bId = b!.id as string;
    await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
      select workspace_id, ${bId}, numero, rol_aprobador, 'aprobado', ${leadId}, now()
      from gate_instancia where proyecto_id = ${a.proyectoId}`;
    // ── El G7 es del CONJUNTO, no del proyecto que se está mirando ──
    // La apertura mueve TODOS los proyectos en implementación y el guard rechaza al que no
    // tenga el suyo, así que basta un hermano sin G7 para que la apertura entera falle. Una
    // pantalla que mirase solo el gate del proyecto abierto anunciaría lista una acción que
    // la base va a negar — el mismo patrón del espejo, en otra puerta.
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-implementacion'
      where id = ${bId}`);
    await admin`update gate_instancia set estado = 'pendiente', aprobado_por = null,
      aprobado_en = null where proyecto_id = ${bId} and numero = 7`;
    const segSinG7 = await seguimientoDeImpacto(leadId, ws, a.proyectoId);
    expect(segSinG7!.proyectosSinG7).toEqual(['P-75B']);
    await expect(abrirMedicion(leadId, { workspaceId: ws, retoId: r.retoId })).rejects.toThrow(
      /Falta el G7 en \(P-75B\)/,
    );

    // Se para ANTES de abrir la medición. Que un pausado se quede atrás es deliberado
    // —parar es del cliente— pero solo vale si TODAVÍA PUEDE SEGUIR al reto: sin su G7 el
    // proyecto quedaría atrapado en un triángulo cerrado —retomarlo con el reto midiendo
    // exige entrar en medición, medir exige su G7, G7 exige G6 y aprobar G6 con el proyecto
    // parado se rechaza— y, atrapado él, el outcome review no puede cerrar el reto: lo que
    // se pierde no es un proyecto, es el final del reto. Se comprueba AL ABRIR, que es el
    // único momento en el que la salida —retomarlo y cerrar sus gates— todavía existe.
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'pausado'
      where id = ${bId}`);
    await expect(abrirMedicion(leadId, { workspaceId: ws, retoId: r.retoId })).rejects.toThrow(
      /P-75B/,
    );
    await expect(abrirMedicion(leadId, { workspaceId: ws, retoId: r.retoId })).rejects.toThrow(
      /Retómalos y cierra sus gates antes de abrir la medición/,
    );
    // Y la regla es de la BASE, no del diagnóstico: por SQL directo, moviendo el par entero
    // a mano —que es lo único que llega hasta la tercera comprobación, porque las dos
    // primeras hablan antes—, el rechazo llega igual al COMMIT.
    await expect(
      conUsuario(leadId, async (tx) => {
        await tx`update reto set estado = 'en-medicion' where id = ${r.retoId}`;
        await tx`update proyecto set estado = 'en-medicion' where id = ${a.proyectoId}`;
      }),
    ).rejects.toThrow(/no podría seguir al reto ni dejarlo cerrar/);
    // Y la salida existe y es la normal: se le cierra el gate que le faltaba y ya puede
    // quedarse atrás, porque ahora sí podrá volver. (Aquí con el guard de suficiencia
    // apagado, porque este segundo proyecto se fabricó con sus gates y sin checklist; el
    // camino real es aprobarlo por el servicio como hace su hermano.)
    await admin`alter table gate_instancia disable trigger gate_aprobar_suficiencia`;
    try {
      await admin`update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId},
        aprobado_en = now() where proyecto_id = ${bId} and numero = 7`;
    } finally {
      await admin`alter table gate_instancia enable trigger gate_aprobar_suficiencia`;
    }

    // ── El candado compartido, por lo que un candado hace: ESPERAR ──
    // Los dos guards del par son diferidos, y «diferido» no es «excluyente»: corren en la
    // fase de commit y su `select` va antes de que el commit propio sea visible para nadie,
    // así que dos que lleguen a la vez se miran sin verse. Lo que los serializa es que los
    // DOS piden el mismo candado del reto como primera sentencia. Se comprueba en los dos
    // lados y sin dejar rastro: `set constraints all immediate` dispara los diferidos dentro
    // de la transacción —así que la comprobación corre, y espera, sin commitear nada— y el
    // `throw` deshace el resto. Lo que se mide es quién espera a quién.
    const candadoDelReto = (tx: TransactionSql) =>
      tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${r.retoId}, 42))`;
    const disparaDiferidos = (mover: (tx: TransactionSql) => Promise<unknown>) => () =>
      conUsuario(leadId, async (tx) => {
        await mover(tx);
        await tx`set constraints all immediate`;
        throw new Error('deshacer');
      }).catch(() => undefined);
    // El lado del PROYECTO: retomarlo espera a quien tenga el reto.
    expect(
      await esperaA(
        candadoDelReto,
        disparaDiferidos(
          (tx) => tx`update proyecto set estado = 'en-implementacion' where id = ${bId}`,
        ),
      ),
    ).toBe(true);
    // Y el lado del RETO: abrir la medición, igual.
    expect(
      await esperaA(
        candadoDelReto,
        disparaDiferidos(async (tx) => {
          await tx`update reto set estado = 'en-medicion' where id = ${r.retoId}`;
          await tx`update proyecto set estado = 'en-medicion' where id = ${a.proyectoId}`;
        }),
      ),
    ).toBe(true);

    // ── La carrera SIMULTÁNEA, que es la que ningún intercalado secuencial enseña ──
    // Las reglas que sostienen el par del lado del proyecto son predicados sobre una
    // INSTANTÁNEA, así que la red es el espejo DIFERIDO. Pero «diferido» no es
    // «excluyente»: los dos guards corren en la fase de commit y su `select` se ejecuta
    // antes de que el commit de su propia transacción sea visible para nadie. Si las dos
    // llegan a la vez, cada una mira, ve el estado VIEJO, y las dos pasan — un proyecto sin
    // abrir bajo un reto que ya mide, otra vez y en silencio. Lo que las serializa es el
    // candado compartido del reto que los dos guards piden como PRIMERA sentencia: el
    // segundo espera, vuelve a mirar con snapshot nuevo y sí ve lo que el primero dejó.
    //
    // Las dos transacciones se sostienen hasta que las DOS están listas y se sueltan a la
    // vez. Forzar un orden de commit —soltar una cuando la otra ya terminó— probaría el
    // caso secuencial, que ya pasaba sin candado y diría que sí cuando la respuesta es no.
    // Y las dos van por SQL crudo a propósito: `abrirMedicion` toma el candado del reto al
    // empezar, así que por el servicio esta carrera ni se plantea.
    let listoProyecto = () => {};
    const proyectoListo = new Promise<void>((resolve) => {
      listoProyecto = resolve;
    });
    let listaApertura = () => {};
    const aperturaLista = new Promise<void>((resolve) => {
      listaApertura = resolve;
    });
    let soltar = () => {};
    const barrera = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    const tardia = conUsuario(leadId, async (tx) => {
      await tx`update proyecto set estado = 'en-implementacion' where id = ${bId}`;
      listoProyecto();
      await barrera;
    });
    const apertura = conUsuario(leadId, async (tx) => {
      await tx`update reto set estado = 'en-medicion' where id = ${r.retoId}`;
      await tx`update proyecto set estado = 'en-medicion' where id = ${a.proyectoId}`;
      listaApertura();
      await barrera;
    });
    await Promise.all([proyectoListo, aperturaLista]);
    soltar();
    const [resProyecto, resApertura] = await Promise.allSettled([tardia, apertura]);
    // Exactamente UNA sobrevive. Cuál, da igual —lo decide quién coge antes el candado— y
    // por eso no se fija: lo que se fija es que no sobrevivan las dos.
    const motivos = [resProyecto, resApertura]
      .filter((x): x is PromiseRejectedResult => x.status === 'rejected')
      .map((x) => String(x.reason));
    expect(motivos.length).toBe(1);
    expect(motivos[0]).toMatch(/(no puede quedarse sin abrir|mueve los dos a la vez)/);
    // Y el invariante queda entero gane quien gane, que es lo que se está protegiendo y no
    // el reparto: nunca un proyecto sin abrir bajo un reto que mide.
    const [par] = await conUsuario(leadId, (tx) => tx`select r.estado as reto,
      (select count(*) from proyecto p where p.reto_id = r.id and p.workspace_id = r.workspace_id
        and p.estado in ('activo', 'en-implementacion')) as sin_abrir
      from reto r where r.id = ${r.retoId}`);
    expect((par!.reto as string) === 'en-medicion' && Number(par!.sin_abrir) > 0).toBe(false);

    // Y se converge al mismo sitio para seguir el guion, gane quien gane.
    if (resApertura.status === 'rejected') {
      await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'pausado'
        where id = ${bId}`);
      const abierto = await abrirMedicion(leadId, { workspaceId: ws, retoId: r.retoId });
      expect(abierto.proyectos).toBe(1);
    }
    const [trasCarrera] = await conUsuario(leadId, (tx) => tx`select estado from proyecto
      where id = ${bId}`);
    expect(trasCarrera!.estado).toBe('pausado');

    // Retomar POR DETRÁS ya no existe, en los DOS destinos que tenía la reanudación.
    for (const destino of ['activo', 'en-implementacion']) {
      await expect(
        conUsuario(leadId, (tx) => tx`update proyecto set estado = ${destino}
          where id = ${bId}`),
      ).rejects.toThrow(/el reto ya está midiendo/);
    }

    // Y que no era una molestia estética: con el proyecto atrás no había salida. La
    // operación que mueve el par se niega a correr otra vez…
    await expect(abrirMedicion(leadId, { workspaceId: ws, retoId: r.retoId })).rejects.toThrow(
      /ya está abierta/,
    );
    // …y el post mortem, que es el final del método, tampoco cierra el reto.
    const review = await abrirOutcomeReview(leadId, { workspaceId: ws, retoId: r.retoId });
    await registrarResultado(leadId, {
      workspaceId: ws,
      reviewId: review.reviewId,
      criterioId: c.criterioId,
      snapshotFinalId: null,
      lectura: '',
      sinDatosMotivo: 'El frente parado se llevó la instrumentación: no hay corte comparable',
    });
    const completar = () =>
      completarOutcomeReview(leadId, {
        workspaceId: ws,
        reviewId: review.reviewId,
        veredicto: 'no-concluyente',
        contribucion: 'Con un frente parado a mitad de ventana no se puede atribuir el cambio',
        factoresExternos: '',
        hipotesisAbiertas: '',
        aprendizajes: '',
        disenoExperimentalSuficiente: false,
        disenoExperimentalJustificacion: '',
      });
    await expect(completar()).rejects.toThrow(/no está en medición/);

    // Y la OTRA puerta del par, la de las filas que NACEN: `proyecto_insert` comprueba «el
    // reto está activo» contra su instantánea, así que el insert que ganó la carrera
    // commitea un proyecto 'activo' bajo un reto que ya mide, y ninguna regla de transición
    // puede verlo porque no hubo transición. El espejo diferido cubre también esa puerta.
    // Se prueba por su MECÁNICA, con el rol admin: no pasa por la política —igual que no la
    // detiene el insert que la evaluó contra el estado viejo— y aun así muere al COMMIT.
    await expect(
      admin.begin(
        (tx) => tx`insert into proyecto
          (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
          values (${ws}, ${r.retoId}, 'P-75C', 'Frente que llega tarde', 'activo',
                  'rapido', ${leadId})`,
      ),
    ).rejects.toThrow(/su proyecto no puede quedarse sin abrir/);

    // La reanudación tiene UN destino y es la fase en la que está el reto.
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-medicion'
      where id = ${bId}`);
    const [tras] = await conUsuario(leadId, (tx) => tx`select estado from proyecto
      where id = ${bId}`);
    expect(tras!.estado).toBe('en-medicion');
    // Y con los dos frentes midiendo el reto SÍ termina: el flujo normal del producto llega
    // hasta el veredicto en vez de quedarse encerrado.
    const veredicto = await completar();
    expect(veredicto.veredicto).toBe('no-concluyente');
    const cerrados = await conUsuario(leadId, (tx) => tx`select estado from proyecto
      where reto_id = ${r.retoId} order by codigo`);
    expect(cerrados.map((p) => p.estado as string)).toEqual(['cerrado', 'cerrado']);

    // ── Y el relleno de la migración NO toca a los proyectos de un reto que ya terminó ──
    // El ciclo anterior cerraba el reto sin poder mover el estado del proyecto —no tenía
    // grant para esa columna—, así que en una base con historia hay retos CERRADOS con su
    // G6 aprobado y su proyecto todavía en 'activo'. Ese es el reto de este test una vez
    // cerrado, así que la forma se puede fabricar sobre él.
    const [d] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${r.retoId}, 'P-75D', 'Frente de un reto que ya terminó', ${leadId})
      returning id`;
    const dId = d!.id as string;
    // Con su G6 y su G7 aprobados, para que el callejón se vea entero y no se quede en el
    // primer rechazo: ni siquiera teniendo el gate que abre la medición hay salida.
    await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
      values (${ws}, ${dId}, 6, 'sponsor', 'aprobado', ${leadId}, now()),
             (${ws}, ${dId}, 7, 'lead-boutique', 'aprobado', ${leadId}, now())`;
    // El predicado EXACTO del relleno no lo alcanza: pide además que su reto siga VIVO.
    const alcanzados = await admin`select p.codigo from proyecto p
      where p.estado = 'activo'
        and exists (select 1 from reto r
          where r.id = p.reto_id and r.workspace_id = p.workspace_id
            and r.estado in ('activo', 'en-medicion'))
        and exists (select 1 from gate_instancia g
          where g.proyecto_id = p.id and g.workspace_id = p.workspace_id
            and g.numero = 6 and g.estado = 'aprobado')`;
    expect(alcanzados.some((p) => (p.codigo as string) === 'P-75D')).toBe(false);
    // Y no solo el predicado copiado aquí: se ejecuta el relleno TAL CUAL está escrito en la
    // migración, dentro de una transacción que se revierte, y este proyecto se queda donde
    // está. Sin la condición del reto, esa misma sentencia lo movería. (Se revierte porque
    // la sentencia es global por diseño —una migración no filtra por workspace— y las
    // suites corren en paralelo; el `lock_timeout` hace que una contención se vea en vez de
    // esperar callando.)
    const fuente = await readFile('db/migrations/20260902110000-medicion.sql', 'utf8');
    const desde = fuente.indexOf('do $$', fuente.indexOf('-- …y la marca sola no basta'));
    const relleno = fuente.slice(desde, fuente.indexOf('end $$;', desde) + 'end $$;'.length);
    expect(relleno).toContain('ProyectoTransicionado');
    await admin
      .begin(async (tx) => {
        await tx`set local lock_timeout = '5s'`;
        await tx.unsafe(relleno);
        const [trasRelleno] = await tx`select estado from proyecto where id = ${dId}`;
        expect(trasRelleno!.estado).toBe('activo');
        throw new Error('deshacer el relleno de prueba');
      })
      .catch((e: unknown) => {
        if (!String(e).includes('deshacer el relleno de prueba')) throw e;
      });
    // Y por qué importa, recorrido hasta el final: movido a implementación por la migración,
    // ese proyecto quedaría con la historia falsificada —trabajo implementándose bajo un
    // reto que terminó— y VARADO para siempre, porque desde ahí no hay salida ninguna.
    await conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-implementacion'
      where id = ${dId}`);
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'cerrado' where id = ${dId}`),
    ).rejects.toThrow(/transición de proyecto ilegal: en-implementacion → cerrado/);
    await expect(
      conUsuario(leadId, (tx) => tx`update proyecto set estado = 'en-medicion' where id = ${dId}`),
    ).rejects.toThrow(/pasa a medición con su reto/);

  });

  it('una cuenta desactivada con sesión viva no lee el seguimiento ni carga snapshots', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${sponsorId}`;
    try {
      await expect(seguimientoDeImpacto(sponsorId, ws, proyectoId)).rejects.toThrow(
        ErrorAutorizacion,
      );
      await expect(
        registrarSnapshot(sponsorId, {
          workspaceId: ws,
          entradaId: entradaAbandonoId,
          valor: '10',
          fecha: fecha(-1),
          nota: '',
        }),
      ).rejects.toThrow(ErrorAutorizacion);
      await expect(
        cargarSnapshotsCsv(sponsorId, {
          workspaceId: ws,
          entradaId: entradaAbandonoId,
          csv: `${fecha(-1)},10`,
        }),
      ).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${sponsorId}`;
    }
  });
});
