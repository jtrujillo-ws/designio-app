import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  agregarAfirmacion,
  agregarCita,
  crearInsight,
  ErrorInsight,
  insightsCitables,
  insightsDelWorkspace,
  registrarContradiccion,
  validarInsight,
} from '@/lib/insight/insight.servicio';
import { describeAuthz } from './helpers';

/**
 * SPEC-03 (RF-03.9) — el insight se sostiene o no se valida: toda afirmación que no
 * está marcada como hipótesis exige al menos una cita, validado es inmutable, y la
 * contradicción la registra cualquier miembro (también contra un insight ya validado).
 */
describeAuthz('insights: afirmaciones, citas y contradicciones', () => {
  const marca = `ins-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let wsAjeno = '';
  let leadId = '';
  let stakeId = '';
  let evidenciaId = '';
  let evidenciaAjenaId = '';
  let insightId = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;
    const [wb] = await admin`insert into workspace (nombre) values (${marca + '-ajeno'}) returning id`;
    wsAjeno = wb!.id as string;

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

    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente insight', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Entrevistas de apertura', '{}'::jsonb, ${leadId})
      returning id`;
    evidenciaId = ev!.id as string;
    // Citar exige DERECHOS vigentes para el ámbito cliente (RF-03.10): la cita copia el
    // fragmento del original, así que crearla es publicar el material. La evidencia de
    // este workspace de prueba los tiene concedidos; el caso contrario lo cubre la suite
    // de evidencia profunda. (El insert directo como admin se salta el constraint trigger
    // que lo exigiría desde la app: por eso hay que ponerlo a mano.)
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${ws}, ${evidenciaId}, 'concedido', 'cliente', 'Contrato de prueba',
              ${leadId}, now(), ${leadId})`;

    const [fuenteB] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${wsAjeno}, 'nota', 'Fuente ajena', ${leadId}) returning id`;
    const [evB] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${wsAjeno}, ${fuenteB!.id as string}, 'Evidencia ajena', '{}'::jsonb, ${leadId})
      returning id`;
    evidenciaAjenaId = evB!.id as string;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    for (const w of [ws, wsAjeno].filter(Boolean)) {
      await admin`delete from evento_dominio where workspace_id = ${w}`;
      await admin`delete from cita where workspace_id = ${w}`;
      await admin`delete from contradiccion where workspace_id = ${w}`;
      await admin`delete from afirmacion where workspace_id = ${w}`;
      await admin`delete from insight where workspace_id = ${w}`;
      await admin`delete from derecho_uso where workspace_id = ${w}`;
      await admin`delete from evidencia where workspace_id = ${w}`;
      await admin`delete from fuente where workspace_id = ${w}`;
      await admin`delete from miembro where workspace_id = ${w}`;
      await admin`delete from workspace where id = ${w}`;
    }
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  it('un curador propone el insight; un stakeholder no', async () => {
    const r = await crearInsight(leadId, {
      workspaceId: ws,
      titulo: 'La verificación pierde a los independientes',
      resumen: 'El abandono se concentra en el paso de documentos',
    });
    insightId = r.insightId;

    await expect(
      crearInsight(stakeId, { workspaceId: ws, titulo: 'Intruso', resumen: '' }),
    ).rejects.toThrow(/row-level security/);
  });

  it('validar exige cita en toda afirmación que no sea hipótesis', async () => {
    // Sin afirmaciones no hay nada que sostener.
    await expect(validarInsight(leadId, ws, insightId)).rejects.toThrow(/sin afirmaciones/);

    const conCita = await agregarAfirmacion(leadId, {
      workspaceId: ws,
      insightId,
      texto: 'El 62% abandona en la verificación de identidad',
      esHipotesis: false,
    });
    // Afirmación soportada pero AÚN sin cita: el guard lo dice con precisión.
    await expect(validarInsight(leadId, ws, insightId)).rejects.toThrow(/al menos una cita/);

    await agregarCita(leadId, {
      workspaceId: ws,
      afirmacionId: conCita.afirmacionId,
      evidenciaId,
      fragmento: 'De cada 100 solicitudes, 62 se detienen en la carga del documento',
      localizacion: 'p. 14',
    });

    // Una hipótesis DECLARADA no necesita cita: el método permite extrapolar, no
    // permite disfrazar la extrapolación de hallazgo.
    await agregarAfirmacion(leadId, {
      workspaceId: ws,
      insightId,
      texto: 'Probablemente el rechazo aumenta con documentos vencidos',
      esHipotesis: true,
    });

    await validarInsight(leadId, ws, insightId);
    const { insights: pagina } = await insightsDelWorkspace(leadId, ws);
    const insight = pagina[0];
    expect(insight!.estado).toBe('validado');
    expect(insight!.afirmaciones).toHaveLength(2);
    expect(insight!.afirmaciones[0]!.citas[0]!.localizacion).toBe('p. 14');
  });

  it('validado es inmutable: no admite afirmaciones, citas ni revalidación', async () => {
    await expect(
      agregarAfirmacion(leadId, { workspaceId: ws, insightId, texto: 'Tardía', esHipotesis: true }),
    ).rejects.toThrow(ErrorInsight);
    await expect(validarInsight(leadId, ws, insightId)).rejects.toThrow(/ya está validado/);
  });

  it('la contradicción la registra cualquier miembro, incluso contra un insight validado', async () => {
    // El stakeholder no cura, pero SÍ puede decir «esto no cuadra»: es el portal.
    await registrarContradiccion(stakeId, {
      workspaceId: ws,
      insightId,
      evidenciaId,
      descripcion: 'En sucursal el abandono es del 20%, no del 62%',
    });
    const { insights: paginaStake } = await insightsDelWorkspace(stakeId, ws);
    const insight = paginaStake[0];
    expect(insight!.contradicciones).toHaveLength(1);

    // La misma evidencia no se registra dos veces sobre el mismo insight.
    await expect(
      registrarContradiccion(stakeId, {
        workspaceId: ws,
        insightId,
        evidenciaId,
        descripcion: 'Repetida',
      }),
    ).rejects.toThrow(/ya está registrada/);
  });

  it('las FKs compuestas cierran el paso a citar evidencia de otro workspace', async () => {
    const otro = await crearInsight(leadId, { workspaceId: ws, titulo: 'Otro', resumen: '' });
    const af = await agregarAfirmacion(leadId, {
      workspaceId: ws,
      insightId: otro.insightId,
      texto: 'Afirmación con cita cruzada',
      esHipotesis: false,
    });
    await expect(
      agregarCita(leadId, {
        workspaceId: ws,
        afirmacionId: af.afirmacionId,
        evidenciaId: evidenciaAjenaId,
        fragmento: 'Robado',
        localizacion: 'p. 1',
      }),
    ).rejects.toThrow(/no existe en este workspace/);
  });

  it('el picker solo ofrece insights validados y no arrastra la ficha completa', async () => {
    // El test anterior dejó un insight propuesto sin validar: si apareciera aquí, el
    // checklist podría citar razonamiento que nadie sostuvo todavía.
    const { insights, hayMas } = await insightsCitables(stakeId, ws);
    expect(insights.map((i) => i.id)).toEqual([insightId]);
    expect(hayMas).toBe(false);
    // La proyección es id + título y nada más: es lo que la hace barata.
    expect(Object.keys(insights[0]!).sort()).toEqual(['id', 'titulo']);
  });

  it('sin contexto de usuario los insights son invisibles; la cuenta desactivada tampoco lee', async () => {
    const filas = await conUsuario(stakeId, (tx) => tx`
      select id from insight where workspace_id = ${wsAjeno}`);
    expect(filas.length).toBe(0);

    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${leadId}`;
    try {
      await expect(insightsDelWorkspace(leadId, ws)).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${leadId}`;
    }
  });
});
