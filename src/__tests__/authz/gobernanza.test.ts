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
      await admin`delete from reapertura_insight where workspace_id = ${ws}`;
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

    // Una decisión inexistente no cumple nada.
    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: g1.items[1]!.id,
        accion: { tipo: 'cumplido', objetoClase: 'decision', objetoId: crypto.randomUUID() },
      }),
    ).rejects.toThrow(/no existe en este proyecto/);

    // Y una decisión REAL de OTRO proyecto del mismo workspace tampoco: la FK compuesta
    // solo garantiza el workspace, así que sin el guard esta petición fabricada cumpliría
    // un gate del proyecto A con la cadena del proyecto B.
    const admin = sqlAdmin();
    const [p2] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, ${'P-AJENO-' + marca}, 'Proyecto vecino', ${leadId}) returning id`;
    const [gAjeno] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${p2!.id as string}, 1, 'lead-boutique') returning id`;
    const [dAjena] = await admin`insert into decision
      (workspace_id, proyecto_id, gate_id, tipo, titulo, decidido_por)
      values (${ws}, ${p2!.id as string}, ${gAjeno!.id as string}, 'otra',
              'Decisión del vecino', ${leadId}) returning id`;

    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: g1.items[1]!.id,
        accion: { tipo: 'cumplido', objetoClase: 'decision', objetoId: dAjena!.id as string },
      }),
    ).rejects.toThrow(/no existe en este proyecto/);
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

    // Sin declarar insights: la reapertura dice que se movió el suelo entero.
    const r = await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId,
      etapaNumero: 1,
      motivo: 'Llegaron entrevistas nuevas que cambian el diagnóstico',
      insightIds: [],
    });
    expect(r.decisionesMarcadas).toBe(2);

    const g = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    expect(g!.decisiones.every((d) => d.estado === 'en-revision')).toBe(true);
    expect(g!.reaperturas).toHaveLength(1);
    expect(g!.reaperturas[0]!.decisionesMarcadas).toBe(2);
    expect(g!.reaperturas[0]!.alcance).toBe('etapa-completa');
    expect(g!.reaperturas[0]!.insights).toEqual([]);

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
        insightIds: [],
      }),
    ).rejects.toThrow(ErrorGobernanza);
  });

  it('declarar qué insight cambió acota la marca a las decisiones que se apoyan en él', async () => {
    // Un segundo insight validado, y una decisión en G3 que se apoya SOLO en él.
    const otro = await crearInsight(leadId, {
      workspaceId: ws,
      titulo: 'Los independientes no tienen el documento a mano',
      resumen: '',
    });
    const af = await agregarAfirmacion(leadId, {
      workspaceId: ws,
      insightId: otro.insightId,
      texto: 'El 40% intenta la apertura fuera de su casa',
      esHipotesis: false,
    });
    await agregarCita(leadId, {
      workspaceId: ws,
      afirmacionId: af.afirmacionId,
      evidenciaId,
      fragmento: 'Ocho de veinte lo intentaron desde el trabajo',
      localizacion: 'p. 3',
    });
    await validarInsight(leadId, ws, otro.insightId);

    const dependiente = await registrarDecision(leadId, {
      workspaceId: ws,
      gateId: gateG3,
      tipo: 'diseno',
      titulo: 'Permitir subir el documento después',
      fundamento: '',
      insightIds: [otro.insightId],
    });

    // Antes de reabrir, todas vigentes (el test anterior revalidó la única marcada
    // que quedaba en revisión; se revalidan las demás para partir de un estado limpio).
    const previa = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    for (const d of previa!.decisiones.filter((x) => x.estado === 'en-revision')) {
      await revalidarDecision(leadId, ws, d.id);
    }

    const r = await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId,
      etapaNumero: 1,
      motivo: 'Una entrevista contradice el segundo insight',
      insightIds: [otro.insightId],
    });
    // Solo la decisión que se apoya en el insight declarado, no la etapa entera.
    expect(r.decisionesMarcadas).toBe(1);

    const g = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    expect(g!.decisiones.find((d) => d.id === dependiente.decisionId)!.estado).toBe('en-revision');
    expect(g!.decisiones.filter((d) => d.estado === 'en-revision')).toHaveLength(1);
    const ultima = g!.reaperturas[0]!;
    expect(ultima.alcance).toBe('declarado');
    expect(ultima.insights.map((i) => i.id)).toEqual([otro.insightId]);

    // Declarar un insight que no existe revierte la reapertura entera.
    await expect(
      reabrirEtapa(leadId, {
        workspaceId: ws,
        proyectoId,
        etapaNumero: 1,
        motivo: 'Declaración falsa',
        insightIds: [crypto.randomUUID()],
      }),
    ).rejects.toThrow(/no existe en este workspace/);
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

  it('una decisión no se apoya en un insight que nadie validó', async () => {
    const propuesto = await crearInsight(leadId, {
      workspaceId: ws,
      titulo: 'Sospecha sin sostener',
      resumen: '',
    });
    // El picker solo ofrece validados, pero el endpoint acepta cualquier uuid: sin el
    // filtro, una decisión aprobada podría apoyarse entera en algo que nadie sostuvo.
    await expect(
      registrarDecision(leadId, {
        workspaceId: ws,
        gateId: gateG1,
        tipo: 'otra',
        titulo: 'Decisión sin cadena',
        fundamento: '',
        insightIds: [propuesto.insightId],
      }),
    ).rejects.toThrow(/todavía no está validado/);
  });

  it('con G2 aprobado no se cuelan arquetipos nuevos; la reapertura abre la puerta', async () => {
    // Se resuelve la hipótesis pendiente y se aprueba G2 de verdad.
    const g = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    const pendiente = g!.arquetipos.find((a) => a.estado === 'hipotesis')!;
    await darVeredictoArquetipo(disenadorId, {
      workspaceId: ws,
      arquetipoId: pendiente.id,
      estado: 'refutado',
      razon: 'No apareció en ninguna de las veinte entrevistas',
    });
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    await aprobarGate(leadId, { workspaceId: ws, gateId: p!.gates[2]!.id });

    // Un arquetipo nuevo ahora quedaría sin resolver para siempre: G2 es inmutable y su
    // guard solo corre al aprobar, así que nadie volvería a mirarlo.
    await expect(
      crearArquetipo(disenadorId, {
        workspaceId: ws,
        retoId,
        nombre: 'Colado después de G2',
        definicion: '',
        segmentoIds: [],
      }),
    ).rejects.toThrow(ErrorGobernanza);

    // La vía existe y queda trazada: reabrir la etapa 2.
    await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId,
      etapaNumero: 2,
      motivo: 'Apareció un perfil que no habíamos visto',
      insightIds: [],
    });
    const nuevo = await crearArquetipo(disenadorId, {
      workspaceId: ws,
      retoId,
      nombre: 'Perfil tardío',
      definicion: '',
      segmentoIds: [],
    });
    expect(nuevo.arquetipoId).toBeTruthy();
  });

  it('un ítem no se cumple con un insight que nadie validó', async () => {
    const propuesto = await crearInsight(leadId, {
      workspaceId: ws,
      titulo: 'Sin validar todavía',
      resumen: '',
    });
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const item = p!.gates[3]!.items[0]!;
    // Igual que con las decisiones: el picker filtra, el endpoint acepta cualquier uuid,
    // y la regla vive en la base para que el SQL directo tampoco la esquive.
    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', objetoClase: 'insight', objetoId: propuesto.insightId },
      }),
    ).rejects.toThrow(/todavía no está validado/);
  });

  it('un gate no se aprueba con ítems cumplidos sobre decisiones en revisión', async () => {
    // Se parte de un estado limpio y se cumple un ítem de G3 citando una decisión.
    const previa = await gobernanzaDeProyecto(leadId, ws, proyectoId);
    for (const d of previa!.decisiones.filter((x) => x.estado === 'en-revision')) {
      await revalidarDecision(leadId, ws, d.id);
    }
    const vigente = (await gobernanzaDeProyecto(leadId, ws, proyectoId))!.decisiones.find(
      (d) => d.gateNumero === 3,
    )!;
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const g3 = p!.gates[3]!;
    for (const item of g3.items) {
      if (item.estado === 'cumplido') continue;
      await marcarItem(leadId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', objetoClase: 'evidencia', objetoId: evidenciaId },
      });
    }
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: g3.items[0]!.id,
      accion: { tipo: 'cumplido', objetoClase: 'decision', objetoId: vigente.id },
    });

    // Una reapertura de la etapa 3 pone esa decisión en revisión. El ítem sigue
    // 'cumplido' —no se tira el trabajo— pero deja de contar como suficiencia.
    await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId,
      etapaNumero: 3,
      motivo: 'Llegó una restricción de cumplimiento',
      insightIds: [],
    });
    // G3 lo aprueba el sponsor (rolAprobadorDeGate), pero el guard le para igual.
    await expect(
      aprobarGate(sponsorId, { workspaceId: ws, gateId: g3.id }),
    ).rejects.toThrow(/decisiones en revisión/);

    // Revalidar la decisión desbloquea el gate sin tocar el checklist.
    await revalidarDecision(leadId, ws, vigente.id);
    const tras = await proyectoMetodo(leadId, ws, proyectoId);
    expect(tras!.gates[3]!.items[0]!.estado).toBe('cumplido');
  });

  it('reabrir la etapa 0 SÍ deja cambiar los criterios que motivaron la reapertura', async () => {
    // G0 está aprobado desde el test de G2: sin reapertura, los criterios están cerrados.
    await expect(
      agregarCriterio(leadId, {
        workspaceId: ws,
        retoId,
        kpi: 'A destiempo',
        definicion: 'x',
        lineaBaseValor: '1',
        lineaBaseFecha: '2026-07-15',
        lineaBasePlan: '',
        objetivo: '2',
        ventanaDias: 30,
        fechaPostMortem: null,
      }),
    ).rejects.toThrow();

    await reabrirEtapa(leadId, {
      workspaceId: ws,
      proyectoId,
      etapaNumero: 0,
      motivo: 'El sponsor corrigió la línea base',
      insightIds: [],
    });

    // Y ahora sí: es exactamente el cambio para el que existe la reapertura. La
    // aprobación de G0 sigue en pie — reabrir cuestiona, no borra.
    const c = await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId,
      kpi: 'Abandono corregido',
      definicion: 'Porcentaje real medido en sucursal',
      lineaBaseValor: '58%',
      lineaBaseFecha: '2026-08-01',
      lineaBasePlan: '',
      objetivo: '40%',
      ventanaDias: 90,
      fechaPostMortem: null,
    });
    expect(c.criterioId).toBeTruthy();
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    expect(p!.gates[0]!.estado).toBe('aprobado');
    expect(p!.etapas[0]!.estado).toBe('en-curso');
  });

});
