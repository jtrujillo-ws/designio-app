import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { crearInsight, agregarAfirmacion, agregarCita, validarInsight } from '@/lib/insight/insight.servicio';
import {
  activarReto,
  agregarCriterio,
  aprobarGate,
  crearReto,
  marcarItem,
  proyectoMetodo,
} from '@/lib/metodo/metodo.servicio';
import {
  apoyarArquetipo,
  crearArquetipo,
  darVeredictoArquetipo,
  ErrorGobernanza,
  gobernanzaDeProyecto,
  reabrirEtapa,
  registrarDecision,
  revalidarDecision,
} from '@/lib/metodo/gobernanza.servicio';
import { describeAuthz } from './helpers';

/**
 * SPEC-04 — gobernanza: decisiones trazables a insights (RF-04.10), arquetipos con
 * evidencia obligatoria que gobiernan G2 (RF-04.11) y reapertura que marca aguas abajo
 * sin borrar historia (RF-04.9, SYS-10).
 */
describeAuthz('gobernanza: decisiones, arquetipos y reaperturas', () => {
  const marca = `gob-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let leadId = '';
  let sponsorId = '';
  let disenadorId = '';
  let svcId = '';
  let retoId = '';
  let proyectoId = '';
  let evidenciaId = '';
  let insightId = '';
  let gateG1 = '';
  let gateG3 = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;

    for (const [alias, rol] of [
      ['lead', 'lead-boutique'],
      ['sponsor', 'sponsor'],
      ['dis', 'disenador'],
    ] as const) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
      if (alias === 'sponsor') sponsorId = id;
      if (alias === 'dis') disenadorId = id;
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, ${alias}, ${`${marca}-${alias}@test.demo`}, ${rol})`;
    }

    await admin`insert into segmento (workspace_id, nombre, definicion)
      values (${ws}, 'independientes', 'Trabajadores por cuenta propia')`;

    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, ${marca + ' Servicio'}, ${leadId}) returning id`;
    svcId = svc!.id as string;

    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente gobernanza', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Diario de campo', '{}'::jsonb, ${leadId})
      returning id`;
    evidenciaId = ev!.id as string;

    // Un insight VALIDADO: sin él no hay decisión trazable.
    const ins = await crearInsight(leadId, { workspaceId: ws, titulo: 'Fricción documental', resumen: '' });
    insightId = ins.insightId;
    const af = await agregarAfirmacion(leadId, {
      workspaceId: ws,
      insightId,
      texto: 'La carga de documentos concentra el abandono',
      esHipotesis: false,
    });
    await agregarCita(leadId, {
      workspaceId: ws,
      afirmacionId: af.afirmacionId,
      evidenciaId,
      fragmento: 'Ocho de diez usuarios abandonan al subir el documento',
      localizacion: 'sesión 3',
    });
    await validarInsight(leadId, ws, insightId);

    const reto = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-70',
      titulo: 'Reto de gobernanza',
      descripcion: '',
      origen: 'hallazgo-medicion',
      metricaObjetivo: '',
      serviciosAfectados: [],
    });
    retoId = reto.retoId;
    const act = await activarReto(leadId, {
      workspaceId: ws,
      retoId,
      perfil: 'estandar',
      proyectoCodigo: 'P-70',
      proyectoTitulo: 'Proyecto de gobernanza',
    });
    proyectoId = act.proyectoId;
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    gateG1 = p!.gates[1]!.id;
    gateG3 = p!.gates[3]!.id;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    if (ws) {
      await admin`delete from evento_dominio where workspace_id = ${ws}`;
      await admin`delete from reapertura_etapa where workspace_id = ${ws}`;
      // El checklist cita insights y decisiones: se borra ANTES que ellos.
      await admin`delete from checklist_item where workspace_id = ${ws}`;
      await admin`delete from decision_insight where workspace_id = ${ws}`;
      await admin`delete from decision where workspace_id = ${ws}`;
      await admin`delete from arquetipo_evidencia where workspace_id = ${ws}`;
      await admin`delete from arquetipo_segmento where workspace_id = ${ws}`;
      await admin`delete from arquetipo where workspace_id = ${ws}`;
      await admin`delete from cita where workspace_id = ${ws}`;
      await admin`delete from contradiccion where workspace_id = ${ws}`;
      await admin`delete from afirmacion where workspace_id = ${ws}`;
      await admin`delete from insight where workspace_id = ${ws}`;
      await admin`delete from gate_instancia where workspace_id = ${ws}`;
      await admin`delete from etapa_instancia where workspace_id = ${ws}`;
      await admin`delete from criterio_exito where workspace_id = ${ws}`;
      await admin`delete from proyecto where workspace_id = ${ws}`;
      await admin`delete from reto_servicio_afectado where workspace_id = ${ws}`;
      await admin`delete from reto where workspace_id = ${ws}`;
      await admin`delete from evidencia where workspace_id = ${ws}`;
      await admin`delete from fuente where workspace_id = ${ws}`;
      await admin`delete from servicio where workspace_id = ${ws}`;
      await admin`delete from segmento where workspace_id = ${ws}`;
      await admin`delete from miembro where workspace_id = ${ws}`;
      await admin`delete from workspace where id = ${ws}`;
    }
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  it('la decisión exige al menos un insight REAL: uno inventado revierte todo', async () => {
    await expect(
      registrarDecision(leadId, {
        workspaceId: ws,
        gateId: gateG1,
        tipo: 'pasa-muere',
        titulo: 'Decisión sin cadena',
        fundamento: '',
        insightIds: [crypto.randomUUID()],
      }),
    ).rejects.toThrow(/no existe en este workspace/);

    // Y nada quedó a medio camino: la sentencia es atómica.
    const g = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    expect(g!.decisiones).toHaveLength(0);

    const d = await registrarDecision(leadId, {
      workspaceId: ws,
      gateId: gateG1,
      tipo: 'pasa-muere',
      titulo: 'Rediseñar la carga de documentos',
      fundamento: 'La evidencia concentra el abandono ahí',
      insightIds: [insightId],
    });
    expect(d.decisionId).toBeTruthy();

    // El diseñador no decide: el método lo opera el lead (§13.2).
    await expect(
      registrarDecision(disenadorId, {
        workspaceId: ws,
        gateId: gateG1,
        tipo: 'diseno',
        titulo: 'Intruso',
        fundamento: '',
        insightIds: [insightId],
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('un ítem de gate se cumple citando un insight o una decisión, no solo evidencia', async () => {
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const g1 = p!.gates[1]!;
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: g1.items[0]!.id,
      accion: { tipo: 'cumplido', objetoClase: 'insight', objetoId: insightId },
    });
    const tras = await proyectoMetodo(leadId, ws, proyectoId);
    const item = tras!.gates[1]!.items[0]!;
    expect(item.objetoClase).toBe('insight');
    expect(item.objetoTitulo).toBe('Fricción documental');

    // Un objeto de otro tipo pero inexistente lo para la FK compuesta.
    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: g1.items[1]!.id,
        accion: { tipo: 'cumplido', objetoClase: 'decision', objetoId: crypto.randomUUID() },
      }),
    ).rejects.toThrow(/no existe en este workspace/);
  });

  it('confirmar un arquetipo exige evidencia; G2 no aprueba con hipótesis colgando', async () => {
    const g = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    const segmentoId = g!.segmentosDisponibles[0]!.id;
    const a = await crearArquetipo(disenadorId, {
      workspaceId: ws,
      retoId,
      nombre: 'Independiente sin firma digital',
      definicion: 'Trabaja por cuenta propia y no tiene certificado',
      segmentoIds: [segmentoId],
    });

    // Confirmar SIN evidencia: el guard de la base lo rechaza.
    await expect(
      darVeredictoArquetipo(disenadorId, {
        workspaceId: ws,
        arquetipoId: a.arquetipoId,
        estado: 'confirmado',
        razon: 'Se ve en las entrevistas',
      }),
    ).rejects.toThrow(/exige evidencia enlazada/);

    await apoyarArquetipo(disenadorId, {
      workspaceId: ws,
      arquetipoId: a.arquetipoId,
      evidenciaId,
    });
    await darVeredictoArquetipo(disenadorId, {
      workspaceId: ws,
      arquetipoId: a.arquetipoId,
      estado: 'confirmado',
      razon: 'Tres de cinco entrevistados encajan',
    });

    // Un segundo arquetipo SIN veredicto bloquea G2 aunque su checklist esté limpio.
    await crearArquetipo(disenadorId, {
      workspaceId: ws,
      retoId,
      nombre: 'Asalariado con nómina',
      definicion: '',
      segmentoIds: [],
    });
    // Los gates ordenan el método: para que el guard llegue a evaluar los arquetipos,
    // G0 y G1 deben estar aprobados primero.
    await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId,
      kpi: 'Abandono en verificación',
      definicion: 'Porcentaje que inicia y no completa',
      lineaBaseValor: '62%',
      lineaBaseFecha: '2026-07-15',
      lineaBasePlan: '',
      objetivo: '40%',
      ventanaDias: 90,
      fechaPostMortem: null,
    });
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    for (const numero of [0, 1, 2]) {
      for (const item of p!.gates[numero]!.items) {
        if (item.estado === 'cumplido') continue;
        await marcarItem(leadId, {
          workspaceId: ws,
          itemId: item.id,
          accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: evidenciaId },
        });
      }
    }
    await aprobarGate(sponsorId, { workspaceId: ws, gateId: p!.gates[0]!.id });
    await aprobarGate(leadId, { workspaceId: ws, gateId: p!.gates[1]!.id });

    // Ahora sí: G2 con checklist limpio pero un arquetipo todavía en hipótesis.
    await expect(aprobarGate(leadId, { workspaceId: ws, gateId: p!.gates[2]!.id })).rejects.toThrow(
      /arquetipos sin confirmar/,
    );

    const proyeccion = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    expect(proyeccion!.arquetipos).toHaveLength(2);
    expect(proyeccion!.arquetipos.find((x) => x.estado === 'confirmado')!.evidencias).toHaveLength(1);
  });

  it('reabrir una etapa marca las decisiones aguas abajo y NO borra la aprobación', async () => {
    // Una decisión en G3 (aguas abajo de la etapa 1) y otra en G1 (la propia etapa).
    await registrarDecision(leadId, {
      workspaceId: ws,
      gateId: gateG3,
      tipo: 'diseno',
      titulo: 'Concepto de verificación diferida',
      fundamento: '',
      insightIds: [insightId],
    });

    const r = await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId,
      etapaNumero: 1,
      motivo: 'Llegaron entrevistas nuevas que cambian el diagnóstico',
    });
    expect(r.decisionesMarcadas).toBe(2);

    const g = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    expect(g!.decisiones.every((d) => d.estado === 'en-revision')).toBe(true);
    expect(g!.reaperturas).toHaveLength(1);
    expect(g!.reaperturas[0]!.decisionesMarcadas).toBe(2);

    // La etapa vuelve a curso; la historia del gate permanece intacta.
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    expect(p!.etapas[1]!.estado).toBe('en-curso');

    // El lead revalida lo que sigue en pie.
    const enRevision = g!.decisiones[0]!;
    await revalidarDecision(leadId, ws, enRevision.id);
    const g2 = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    expect(g2!.decisiones.find((d) => d.id === enRevision.id)!.estado).toBe('vigente');

    // El sponsor no reabre: no opera el método.
    await expect(
      reabrirEtapa(sponsorId, {
        workspaceId: ws,
        proyectoId,
        etapaNumero: 2,
        motivo: 'Intruso',
      }),
    ).rejects.toThrow(ErrorGobernanza);
  });

  it('las escrituras directas de gobernanza respetan RLS', async () => {
    // Un stakeholder no existe en este workspace; el sponsor sí, y aun así no puede
    // insertar decisiones por SQL directo (la política exige lead + autoría propia).
    await expect(
      conUsuario(sponsorId, (tx) => tx`insert into decision
        (workspace_id, proyecto_id, gate_id, tipo, titulo, decidido_por)
        values (${ws}, ${proyectoId}, ${gateG1}, 'otra', 'Colada', ${sponsorId})`),
    ).rejects.toThrow(/row-level security/);

    // Ni firmar una decisión con la identidad de otro.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into decision
        (workspace_id, proyecto_id, gate_id, tipo, titulo, decidido_por)
        values (${ws}, ${proyectoId}, ${gateG1}, 'otra', 'Firmada por otro', ${sponsorId})`),
    ).rejects.toThrow(/row-level security/);
  });
});
