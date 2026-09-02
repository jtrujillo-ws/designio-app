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
  let svcId = '';
  let retoId = '';
  let proyectoId = '';
  let evidenciaId = '';
  let registryId = '';
  let criterioAbandonoId = '';
  let criterioReintentosId = '';
  let entradaAbandonoId = '';
  let entradaReintentosId = '';
  let reviewId = '';

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
      if (alias === 'sponsor') sponsorMiembroId = m!.id as string;
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
    await expect(
      agregarEntrada(leadId, {
        workspaceId: ws,
        registryId,
        criterioId: criterioAjeno.criterioId,
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
      /post-mortem antes del cierre de la ventana/,
    );
    await editarEntrada(leadId, {
      workspaceId: ws,
      entradaId: entradaReintentosId,
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
    // Ni siquiera el sponsor que lo firmó lo re-firma o lo devuelve a borrador.
    await expect(firmarRegistry(sponsorId, { workspaceId: ws, registryId })).rejects.toThrow(
      /ya está firmado/,
    );
    const revertido = await conUsuario(sponsorId, (tx) => tx`update metric_registry
      set estado = 'borrador' where id = ${registryId}`);
    expect(revertido.count).toBe(0);

    await aprobarGateNumero(6);
  });

  it('abrir la medición exige registry firmado y G6 aprobado, y mueve reto Y proyecto', async () => {
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
    ].join('\n');
    const r = await cargarSnapshotsCsv(sponsorId, {
      workspaceId: ws,
      entradaId: entradaAbandonoId,
      csv,
    });
    expect(r.insertados).toBe(2);
    expect(r.rechazadas.map((f) => f.linea)).toEqual([3, 4, 5]);
    expect(r.rechazadas[0]!.motivo).toMatch(/Falta la fecha/);
    expect(r.rechazadas[1]!.motivo).toMatch(/Fecha inválida/);
    expect(r.rechazadas[2]!.motivo).toMatch(/no numérico/);

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
      sinDatosMotivo: 'El cliente no aportó el log de verificación durante la ventana',
    });

    const stake = await seguimientoDeImpacto(stakeId, ws, proyectoId);
    expect(stake!.review!.resultados.length).toBe(2);
    expect(stake!.review!.resultados.find((r) => r.criterioId === criterioAbandonoId)!.valorFinal)
      .toBe('49');
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
