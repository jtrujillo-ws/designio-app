import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sql, sqlAdmin } from '@/lib/db';
import {
  pendientesEnWorkspace,
  pendientesParaUsuario,
} from '@/lib/aprobaciones/aprobaciones.queries';
import { contarPendientes } from '@/lib/aprobaciones/aprobaciones.schemas';
import { resumenParaUsuario } from '@/lib/loop/loop.queries';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { describeAuthz } from './helpers';

/**
 * Aprobaciones pendientes: la proyección enseña a cada rol SOLO lo que su rol puede decidir
 * ahora (gates propios con checklist decidido, derechos sin decidir, insights propuestos,
 * design versions en borrador), el resumen del loop cuenta lo mismo, y RLS manda: un
 * miembro de A no ve nada de B, ni preguntando por B a propósito, y la cuenta desactivada
 * no lee.
 */
describeAuthz('aprobaciones pendientes (proyección por rol + aislamiento)', () => {
  const marca = `apr-${crypto.randomUUID().slice(0, 8)}`;
  let wsA = '';
  let wsB = '';
  let leadA = '';
  let sponsorA = '';
  let adminA = '';
  let stakeholderA = '';
  let proyectoA1 = '';
  let proyectoA2 = '';
  let gateG1 = '';
  let gateG0P2 = '';
  let evidenciaA = '';
  let insightA = '';
  let dvConJourney = '';
  let dvSinJourney = '';

  async function usuario(email: string, nombre: string, ws: string, rol: string) {
    const admin = sqlAdmin();
    const [u] = await admin`insert into usuario (email, nombre, estado)
      values (${email}, ${nombre}, 'activo') returning id`;
    const id = u!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${ws}, ${id}, ${nombre}, ${email}, ${rol})`;
    return id;
  }

  /** Un servicio con reto, proyecto y journey to-be: lo mínimo de lo que cuelga todo. */
  async function arbol(ws: string, autor: string, sufijo: string) {
    const admin = sqlAdmin();
    const [s] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, ${`${marca} Servicio ${sufijo}`}, ${autor}) returning id`;
    const servicioId = s!.id as string;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, creado_por)
      values (${ws}, ${servicioId}, ${`R-${sufijo}`}, 'Reto', 'activo', ${autor}) returning id`;
    const retoId = r!.id as string;
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, ${`P-${sufijo}`}, 'Proyecto', ${autor}) returning id`;
    const [j] =
      await admin`insert into journey (workspace_id, servicio_id, tipo, nombre, creado_por)
      values (${ws}, ${servicioId}, 'to-be', ${`${marca} to-be ${sufijo}`}, ${autor}) returning id`;
    return { servicioId, retoId, proyectoId: p!.id as string, journeyId: j!.id as string };
  }

  /** Un gate pendiente con el checklist DECIDIDO (un N/A justificado): espera a su aprobador. */
  async function gateDecidido(ws: string, proyectoId: string, numero: number, autor: string) {
    const admin = sqlAdmin();
    const rol = [0, 3, 5, 6].includes(numero) ? 'sponsor' : 'lead-boutique';
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoId}, ${numero}, ${rol}) returning id`;
    await admin`insert into checklist_item
      (workspace_id, gate_id, orden, texto, estado, na_justificacion, na_aprobado_por)
      values (${ws}, ${g!.id as string}, 0, 'Evidencia suficiente', 'na', 'No aplica', ${autor})`;
    return g!.id as string;
  }

  /** Evidencia curada con su registro de derechos PENDIENTE, insight propuesto y DV en borrador. */
  async function decisionesSueltas(
    ws: string,
    autor: string,
    proyectoId: string,
    servicioId: string,
    journeyId: string | null,
    codigoDv: string,
  ) {
    const admin = sqlAdmin();
    const [f] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'entrevista', ${`${marca} Estudio`}, ${autor}) returning id`;
    const [e] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${f!.id as string}, ${`${marca} Entrevista`}, '{}'::jsonb, ${autor})
      returning id`;
    const evidenciaId = e!.id as string;
    await admin`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
      values (${ws}, ${evidenciaId}, ${autor})`;
    const [i] = await admin`insert into insight (workspace_id, titulo, creado_por)
      values (${ws}, ${`${marca} Hallazgo`}, ${autor}) returning id`;
    const insightId = i!.id as string;
    // Dos afirmaciones: una sin cita (bloquea validar) y una hipótesis (no la exige).
    await admin`insert into afirmacion (workspace_id, insight_id, orden, texto, es_hipotesis)
      values (${ws}, ${insightId}, 0, 'Afirmación sin cita', false),
             (${ws}, ${insightId}, 1, 'Hipótesis declarada', true)`;
    const [dv] = await admin`insert into design_version
      (workspace_id, proyecto_id, servicio_id, journey_id, codigo, titulo, creado_por)
      values (${ws}, ${proyectoId}, ${servicioId}, ${journeyId}, ${codigoDv}, 'Borrador', ${autor})
      returning id`;
    return { evidenciaId, insightId, designVersionId: dv!.id as string };
  }

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [a] = await admin`insert into workspace (nombre) values (${marca + '-A'}) returning id`;
    const [b] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsA = a!.id as string;
    wsB = b!.id as string;

    leadA = await usuario(`${marca}@lead.test`, 'Lead', wsA, 'lead-boutique');
    sponsorA = await usuario(`${marca}@sponsor.test`, 'Sponsor', wsA, 'sponsor');
    adminA = await usuario(`${marca}@admin.test`, 'Admin cliente', wsA, 'admin-cliente');
    stakeholderA = await usuario(`${marca}@stake.test`, 'Stakeholder', wsA, 'stakeholder');

    // Proyecto 1 de A: G0 aprobado, G1 abierto y decidido (espera al lead), G2 con trabajo
    // pendiente, G3 sin checklist. Solo G1 es aprobación.
    const a1 = await arbol(wsA, leadA, 'A1');
    proyectoA1 = a1.proyectoId;
    await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
      values (${wsA}, ${proyectoA1}, 0, 'sponsor', 'aprobado', ${sponsorA}, now())`;
    gateG1 = await gateDecidido(wsA, proyectoA1, 1, leadA);
    const [g2] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${wsA}, ${proyectoA1}, 2, 'lead-boutique') returning id`;
    await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${wsA}, ${g2!.id as string}, 0, 'Insights validados')`;
    await admin`insert into gate_instancia (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${wsA}, ${proyectoA1}, 3, 'sponsor')`;
    // Proyecto 2 de A: G0 abierto y decidido, que espera al SPONSOR.
    const a2 = await arbol(wsA, leadA, 'A2');
    proyectoA2 = a2.proyectoId;
    gateG0P2 = await gateDecidido(wsA, proyectoA2, 0, leadA);

    // Las decisiones sueltas de A: una DV con journey y otra sin él.
    const sueltas = await decisionesSueltas(
      wsA,
      leadA,
      proyectoA1,
      a1.servicioId,
      a1.journeyId,
      'DV-1',
    );
    evidenciaA = sueltas.evidenciaId;
    insightA = sueltas.insightId;
    dvConJourney = sueltas.designVersionId;
    const [dv2] = await admin`insert into design_version
      (workspace_id, proyecto_id, servicio_id, codigo, titulo, creado_por)
      values (${wsA}, ${proyectoA2}, ${a2.servicioId}, 'DV-2', 'Sin journey', ${leadA})
      returning id`;
    dvSinJourney = dv2!.id as string;

    // B tiene de todo pendiente, y ninguno de los de A es miembro.
    const b1 = await arbol(wsB, leadA, 'B1');
    await gateDecidido(wsB, b1.proyectoId, 1, leadA);
    await decisionesSueltas(wsB, leadA, b1.proyectoId, b1.servicioId, b1.journeyId, 'DV-1');
  });

  afterAll(async () => {
    // Si beforeAll falló a medias, limpiar solo lo que sí existe: un id vacío en el IN
    // lanzaría 22P02 y taparía el error real del setup.
    const admin = sqlAdmin();
    const wss = [wsA, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from design_version where workspace_id in ${admin(wss)}`;
      await admin`delete from journey where workspace_id in ${admin(wss)}`;
      await admin`delete from afirmacion where workspace_id in ${admin(wss)}`;
      await admin`delete from insight where workspace_id in ${admin(wss)}`;
      await admin`delete from derecho_uso where workspace_id in ${admin(wss)}`;
      await admin`delete from evidencia where workspace_id in ${admin(wss)}`;
      await admin`delete from fuente where workspace_id in ${admin(wss)}`;
      await admin`delete from checklist_item where workspace_id in ${admin(wss)}`;
      await admin`delete from gate_instancia where workspace_id in ${admin(wss)}`;
      await admin`delete from proyecto where workspace_id in ${admin(wss)}`;
      await admin`delete from reto where workspace_id in ${admin(wss)}`;
      await admin`delete from servicio where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    const usuarios = [leadA, sponsorA, adminA, stakeholderA].filter((id) => id !== '');
    if (usuarios.length > 0) await admin`delete from usuario where id in ${admin(usuarios)}`;
    await cerrarPools();
  });

  it('el lead ve las cuatro clases: su gate, el derecho, el insight y las dos versiones', async () => {
    const p = await pendientesParaUsuario(leadA, wsA);
    expect(p.workspaceId).toBe(wsA);
    // Solo G1 de P-A1: G2 tiene trabajo, G3 no tiene checklist, y G0 de P-A2 espera al sponsor.
    expect(p.gates.map((g) => [g.gateId, g.numero, g.proyectoCodigo, g.retoCodigo])).toEqual([
      [gateG1, 1, 'P-A1', 'R-A1'],
    ]);
    expect(p.derechos.map((d) => [d.evidenciaId, d.fuenteTitulo])).toEqual([
      [evidenciaA, `${marca} Estudio`],
    ]);
    // La hipótesis no exige cita: de dos afirmaciones, una está sin citar.
    expect(p.insights.map((i) => [i.insightId, i.afirmaciones, i.afirmacionesSinCita])).toEqual([
      [insightA, 2, 1],
    ]);
    expect(
      p.designVersions.map((dv) => [
        dv.designVersionId,
        dv.codigo,
        dv.journeyEnlazado,
        dv.conElementos,
      ]),
    ).toEqual([
      [dvConJourney, 'DV-1', true, false],
      [dvSinJourney, 'DV-2', false, false],
    ]);
  });

  it('cada rol recibe solo su clase: el sponsor su gate, el admin los derechos, el stakeholder nada', async () => {
    const sponsor = await pendientesParaUsuario(sponsorA, wsA);
    expect(sponsor.gates.map((g) => [g.gateId, g.numero, g.proyectoCodigo])).toEqual([
      [gateG0P2, 0, 'P-A2'],
    ]);
    expect(sponsor.derechos).toEqual([]);
    expect(sponsor.insights).toEqual([]);
    expect(sponsor.designVersions).toEqual([]);

    const admin = await pendientesParaUsuario(adminA, wsA);
    expect(admin.gates).toEqual([]);
    expect(admin.derechos.map((d) => d.evidenciaId)).toEqual([evidenciaA]);
    expect(admin.insights).toEqual([]);
    expect(admin.designVersions).toEqual([]);

    const stakeholder = await pendientesParaUsuario(stakeholderA, wsA);
    expect(contarPendientes(stakeholder).total).toBe(0);
  });

  it('el contador del lateral (resumen del loop) cuenta lo mismo que la pantalla', async () => {
    for (const [usuarioId, esperado] of [
      [leadA, { gate: 1, derecho: 1, insight: 1, 'design-version': 2 }],
      [sponsorA, { gate: 1, derecho: 0, insight: 0, 'design-version': 0 }],
      [adminA, { gate: 0, derecho: 1, insight: 0, 'design-version': 0 }],
      [stakeholderA, { gate: 0, derecho: 0, insight: 0, 'design-version': 0 }],
    ] as const) {
      const resumen = await resumenParaUsuario(usuarioId, wsA);
      const pantalla = contarPendientes(await pendientesParaUsuario(usuarioId, wsA));
      expect(resumen.pendientesDelRol).toEqual(pantalla);
      expect(resumen.pendientesDelRol.porClase).toEqual(esperado);
    }
    // Y el resumen sigue nombrando TODOS los gates decididos, propios o no.
    const delLead = await resumenParaUsuario(leadA, wsA);
    expect(delLead.aprobaciones.map((a) => [a.numero, a.esMia]).sort()).toEqual([
      [0, false],
      [1, true],
    ]);
  });

  it('un miembro de A no ve nada de B, ni preguntando por B a propósito', async () => {
    const enB = await conUsuario(leadA, (tx) => pendientesEnWorkspace(tx, leadA, wsB));
    expect(contarPendientes(enB).total).toBe(0);
    // Y las tablas de B, directamente, tampoco le enseñan filas.
    const filas = await conUsuario(
      leadA,
      (tx) => tx`select id from design_version where workspace_id = ${wsB}`,
    );
    expect(filas.length).toBe(0);
  });

  it('sin contexto de usuario, las decisiones son invisibles (cero filas)', async () => {
    const filas = await sql()`select id from derecho_uso where workspace_id in (${wsA}, ${wsB})`;
    expect(filas.length).toBe(0);
  });

  it('la capa 2: cuenta activa lee, desactivada con sesión viva no', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${leadA}`;
    try {
      await expect(pendientesParaUsuario(leadA, wsA)).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${leadA}`;
    }
    expect((await pendientesParaUsuario(leadA, wsA)).gates).toHaveLength(1);
  });
});
