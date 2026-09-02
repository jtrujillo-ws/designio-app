import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  activarReto,
  agregarCriterio,
  aprobarGate,
  crearReto,
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
import { ventanasCerradas } from '@/lib/medicion/medicion.schemas';
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
  let criterioAjenoId = '';
  let entradaAbandonoId = '';
  let entradaReintentosId = '';
  let reviewId = '';

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
  async function aprobarGateNumero(numero: number): Promise<void> {
    const p = await proyectoMetodo(leadId, ws, proyectoId);
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
      ventanaDias: 30,
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
    expect(reapuntada.criterioVentanaDias).toBe(30);

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
    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g6.id })).rejects.toThrow(
      /Metric Registry no está firmado/,
    );

    const firma = await firmarRegistry(sponsorId, { workspaceId: ws, registryId });
    expect(firma.entradas).toBe(2);

    const admin = sqlAdmin();
    const [evento] = await admin`select actor_id, actor_rol, payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'MetricRegistryFirmado' order by creado_en desc limit 1`;
    expect(evento!.actor_id).toBe(sponsorId);
    expect(evento!.actor_rol).toBe('sponsor');
    expect((evento!.payload as { entradas: number }).entradas).toBe(2);

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
    // Se simula que HOY es el último día de AMBAS ventanas (30 y 60 días de criterio). Las
    // entradas están congeladas por la firma, así que solo el rol admin las mueve.
    await admin`update entrada_kpi set ventana_inicio = ${await fechaDeBase(-30)}
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
      await admin`update entrada_kpi set ventana_inicio = ${await fechaDeBase(-31)}
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

  it('el resultado por criterio se serializa con la completación: mismo candado del reto', async () => {
    // El upsert del resultado y la completación tocan FILAS DISTINTAS, así que ninguna
    // bloquea a la otra por filas: sin candado, este guardado podía evaluar su «solo
    // borrador» contra un snapshot anterior al cierre y commitear DESPUÉS, dejando el post
    // mortem firmado sobre una lectura que su propio trigger jamás vio. Se comprueba que
    // registrarResultado toma de verdad el candado del reto —el mismo que toma
    // completarOutcomeReview— reteniéndolo desde otra sesión: si no lo tomara, terminaría
    // de inmediato en vez de esperar a que se suelte.
    const admin = sqlAdmin();
    let soltado = false;
    let avisarTomado = () => {};
    const tomado = new Promise<void>((resolve) => {
      avisarTomado = resolve;
    });
    const reteniendo = admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`;
      avisarTomado();
      await new Promise((resolve) => setTimeout(resolve, 300));
      soltado = true;
    });
    // Se espera a que el candado esté TOMADO antes de lanzar el contendiente: si no, lo
    // que se mediría es quién abre antes su conexión, no quién espera a quién.
    await tomado;
    const esperoAlCandado = registrarResultado(leadId, {
      workspaceId: ws,
      reviewId,
      criterioId: criterioAbandonoId,
      snapshotFinalId: null,
      lectura: 'edición concurrente del borrador',
      sinDatosMotivo: 'se corrige a continuación',
    }).then(() => soltado);
    expect(await esperoAlCandado).toBe(true);
    await reteniendo;

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

    const admin = sqlAdmin();
    const [evento] = await admin`select actor_id, payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'OutcomeReviewCompletado' order by creado_en desc limit 1`;
    expect(evento!.actor_id).toBe(leadId);
    expect((evento!.payload as { veredicto: string }).veredicto).toBe('parcialmente-logrado');

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
    ).rejects.toThrow(/No puedes cargar snapshots/);
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
