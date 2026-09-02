import { afterAll, beforeAll, expect, it } from 'vitest';
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
import { checklistParaPerfil, ETAPAS_CANONICAS } from '@/lib/metodo/metodo.plantillas';
import { describeAuthz } from './helpers';

/**
 * SPEC-04 — método como código: etapas canónicas idénticas en todo perfil (I1/SYS-09),
 * gates con checklist de suficiencia y aprobación por rol (§13.2), G0 exigiendo
 * criterios completos (SYS-22), y aprobado = inmutable con checklist congelado.
 */
describeAuthz('método: etapas, gates y checklists', () => {
  const marca = `met-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let leadId = '';
  let sponsorId = '';
  let stakeId = '';
  let svcId = '';
  let retoId = '';
  let proyectoId = '';
  let evidenciaId = '';

  const criterioBase = {
    kpi: 'Abandono',
    definicion: '',
    lineaBaseValor: '62%' as string | null,
    lineaBaseFecha: '2026-07-15' as string | null,
    lineaBasePlan: '',
    objetivo: '40%',
    ventanaDias: 90 as number | null,
    fechaPostMortem: null as string | null,
  };

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
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, ${alias}, ${`${marca}-${alias}@test.demo`}, ${rol})`;
    }

    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, ${marca + ' Servicio'}, ${leadId}) returning id`;
    svcId = svc!.id as string;

    // Evidencia curada para enlazar en checklists.
    const [fuente] = await admin`insert into fuente (workspace_id, tipo, titulo, creado_por)
      values (${ws}, 'nota', 'Fuente método', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, dimensiones, creado_por)
      values (${ws}, ${fuente!.id as string}, 'Evidencia método', '{}'::jsonb, ${leadId})
      returning id`;
    evidenciaId = ev!.id as string;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    if (ws) {
      await admin`delete from evento_dominio where workspace_id = ${ws}`;
      await admin`delete from checklist_item where workspace_id = ${ws}`;
      await admin`delete from gate_instancia where workspace_id = ${ws}`;
      await admin`delete from etapa_instancia where workspace_id = ${ws}`;
      await admin`delete from criterio_exito where workspace_id = ${ws}`;
      await admin`delete from evidencia_segmento where workspace_id = ${ws}`;
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

  it('un curador crea el reto candidato con sus servicios afectados; un stakeholder no', async () => {
    const r = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-90',
      titulo: 'Reto de método',
      descripcion: 'Formulación del reto',
      origen: 'peticion-cliente',
      metricaObjetivo: '62→40',
      serviciosAfectados: [svcId], // el ancla se filtra: no se duplica como afectado
    });
    retoId = r.retoId;
    const aristas = await conUsuario(leadId, (tx) => tx`
      select 1 as x from reto_servicio_afectado where reto_id = ${retoId}`);
    expect(aristas.length).toBe(0);

    await expect(
      crearReto(stakeId, {
        workspaceId: ws,
        servicioAnclaId: svcId,
        codigo: 'R-91',
        titulo: 'Intruso',
        descripcion: '',
        origen: 'hallazgo-medicion',
        metricaObjetivo: '',
        serviciosAfectados: [],
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('activar el reto crea las 8 etapas canónicas, los gates con su rol y el checklist del perfil', async () => {
    const r = await activarReto(leadId, {
      workspaceId: ws,
      retoId,
      perfil: 'estandar',
      proyectoCodigo: 'P-90',
      proyectoTitulo: 'Proyecto de método',
    });
    proyectoId = r.proyectoId;

    const p = await proyectoMetodo(leadId, ws, proyectoId);
    expect(p?.etapas.map((e) => e.nombre)).toEqual([...ETAPAS_CANONICAS]);
    expect(p?.gates.map((g) => g.rolAprobador)).toEqual([
      'sponsor', 'lead-boutique', 'lead-boutique', 'sponsor',
      'lead-boutique', 'sponsor', 'sponsor', 'lead-boutique',
    ]);
    expect(p?.gates[0]?.items.map((i) => i.texto)).toEqual(checklistParaPerfil(0, 'estandar'));

    // Reactivar no aplica: ya no está en candidato.
    await expect(
      activarReto(leadId, {
        workspaceId: ws,
        retoId,
        perfil: 'rapido',
        proyectoCodigo: 'P-91',
        proyectoTitulo: 'Doble',
      }),
    ).rejects.toThrow(ErrorMetodo);
  });

  it('el perfil gradúa el checklist, JAMÁS el vocabulario: nombres idénticos, ítems distintos', async () => {
    const r2 = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-92',
      titulo: 'Reto rápido',
      descripcion: '',
      origen: 'post-mortem',
      metricaObjetivo: '',
      serviciosAfectados: [],
    });
    const act = await activarReto(leadId, {
      workspaceId: ws,
      retoId: r2.retoId,
      perfil: 'rapido',
      proyectoCodigo: 'P-92',
      proyectoTitulo: 'Proyecto rápido',
    });
    const rapido = await proyectoMetodo(leadId, ws, act.proyectoId);
    const estandar = await proyectoMetodo(leadId, ws, proyectoId);
    // I1/SYS-09: mismos nombres canónicos…
    expect(rapido?.etapas.map((e) => e.nombre)).toEqual(estandar?.etapas.map((e) => e.nombre));
    // …distinto volumen de suficiencia (G1 estándar exige segmentos cubiertos; rápido no).
    expect(rapido?.gates[1]?.items.length).toBeLessThan(estandar?.gates[1]?.items.length ?? 0);
  });

  it('G0 exige criterios completos (SYS-22): sin criterios o sin ventana no se aprueba', async () => {
    const p = await proyectoMetodo(sponsorId, ws, proyectoId);
    const g0 = p!.gates[0]!;
    // Checklist de G0 fuera del camino: N/A por el sponsor (rol aprobador de G0).
    for (const item of g0.items) {
      await marcarItem(sponsorId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'na', justificacion: 'Cubierto en el kickoff' },
      });
    }

    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g0.id })).rejects.toThrow(
      /al menos un criterio/,
    );

    await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId,
      ...criterioBase,
      ventanaDias: null, // sin ventana: G0 debe seguir bloqueado y señalarlo
    });
    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g0.id })).rejects.toThrow(
      /sin ventana/,
    );

    const admin = sqlAdmin();
    await admin`update criterio_exito set ventana_dias = 90 where workspace_id = ${ws} and reto_id = ${retoId}`;
    const ok = await aprobarGate(sponsorId, { workspaceId: ws, gateId: g0.id });
    expect(ok.numero).toBe(0);
  });

  it('el rol del gate gobierna: el lead no aprueba G0 ni el sponsor G1; los pendientes bloquean listándose', async () => {
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const g1 = p!.gates[1]!;

    // G1 con pendientes: ni el rol correcto puede aprobar, y el mensaje lista el ítem.
    await expect(aprobarGate(leadId, { workspaceId: ws, gateId: g1.id })).rejects.toThrow(
      /pendientes: «Evidencia primaria suficiente/,
    );

    // Cumplir el checklist de G1 con evidencia REAL enlazada.
    for (const item of g1.items) {
      await marcarItem(leadId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', evidenciaId },
      });
    }
    // El sponsor no es el rol de G1 (lead) — bloqueado aunque el checklist esté limpio.
    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g1.id })).rejects.toThrow(
      /Solo el rol lead-boutique/,
    );
    const ok = await aprobarGate(leadId, { workspaceId: ws, gateId: g1.id });
    expect(ok.numero).toBe(1);

    // Aprobado = inmutable y checklist congelado.
    await expect(aprobarGate(leadId, { workspaceId: ws, gateId: g1.id })).rejects.toThrow(
      /ya está aprobado/,
    );
    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: g1.items[0]!.id,
        accion: { tipo: 'pendiente' },
      }),
    ).rejects.toThrow(ErrorMetodo);
  });

  it('cumplido exige objeto real y N/A exige el rol aprobador del gate', async () => {
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const g2 = p!.gates[2]!;
    const item = g2.items[0]!;

    // Evidencia inexistente: la FK compuesta la rechaza.
    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', evidenciaId: crypto.randomUUID() },
      }),
    ).rejects.toThrow(ErrorMetodo);

    // N/A en G2 (rol aprobador: lead): el sponsor ni siquiera alcanza la fila (USING).
    await expect(
      marcarItem(sponsorId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'na', justificacion: 'No aplica' },
      }),
    ).rejects.toThrow(ErrorMetodo);

    // El lead alcanza la fila de G3 (curador) pero el N/A es del sponsor: WITH CHECK.
    const g3 = p!.gates[3]!;
    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: g3.items[0]!.id,
        accion: { tipo: 'na', justificacion: 'No aplica' },
      }),
    ).rejects.toThrow(/Solo el rol aprobador/);

    // El stakeholder no marca nada (política de curadores).
    await expect(
      marcarItem(stakeId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', evidenciaId },
      }),
    ).rejects.toThrow(ErrorMetodo);
  });

  it('las escrituras directas del método respetan RLS: un stakeholder no aprueba gates', async () => {
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const g4 = p!.gates[4]!;
    const filas = await conUsuario(stakeId, (tx) => tx`
      update gate_instancia set estado = 'aprobado', aprobado_por = ${stakeId}, aprobado_en = now()
      where id = ${g4.id}`);
    expect(filas.count).toBe(0);
    const sigue = await proyectoMetodo(leadId, ws, proyectoId);
    expect(sigue?.gates[4]?.estado).toBe('pendiente');
  });

  it('una cuenta desactivada con sesión viva no lee el método ni aprueba (re-check de estado)', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${leadId}`;
    try {
      await expect(proyectoMetodo(leadId, ws, proyectoId)).rejects.toThrow(ErrorAutorizacion);
      const p = await proyectoMetodo(sponsorId, ws, proyectoId);
      await expect(
        aprobarGate(leadId, { workspaceId: ws, gateId: p!.gates[7]!.id }),
      ).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${leadId}`;
    }
  });
});
