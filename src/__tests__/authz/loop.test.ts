import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, sqlAdmin } from '@/lib/db';
import { resumenParaUsuario } from '@/lib/loop/loop.queries';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { describeAuthz } from './helpers';

/**
 * La proyección de la pantalla Loop: cuenta lo que espera a alguien (bandeja sin curar,
 * gates abiertos con checklist decidido), dice qué gates firmó cada proyecto y elige el
 * mismo «primer servicio» que el árbol. Y respeta RLS: un miembro de A no ve nada de B,
 * ni preguntando por su servicio a propósito.
 */
describeAuthz('resumen del loop (proyección + aislamiento)', () => {
  const marca = `loop-${crypto.randomUUID().slice(0, 8)}`;
  let wsA = '';
  let wsB = '';
  let userA = '';
  let sponsorA = '';
  let svcA1 = '';
  let svcA2 = '';
  let proyectoA = '';
  let svcB = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [a] = await admin`insert into workspace (nombre) values (${marca + '-A'}) returning id`;
    const [b] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsA = a!.id as string;
    wsB = b!.id as string;

    const [ua] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '@a.test'}, 'Usuario Loop', 'activo') returning id`;
    userA = ua!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsA}, ${userA}, 'Usuario Loop', ${marca + '@a.test'}, 'lead-boutique')`;
    const [us] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '@sponsor.test'}, 'Sponsor Loop', 'activo') returning id`;
    sponsorA = us!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsA}, ${sponsorA}, 'Sponsor Loop', ${marca + '@sponsor.test'}, 'sponsor')`;

    // Dos servicios en A, en este orden de creación: el primero es «el actual».
    const [s1] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsA}, ${marca + ' Servicio 1'}, ${userA}) returning id`;
    svcA1 = s1!.id as string;
    const [s2] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsA}, ${marca + ' Servicio 2'}, ${userA}) returning id`;
    svcA2 = s2!.id as string;

    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, creado_por)
      values (${wsA}, ${svcA1}, 'R-L1', 'Reto del loop', 'activo', ${userA}) returning id`;
    const retoA = r!.id as string;
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${wsA}, ${retoA}, 'P-L1', 'Proyecto del loop', ${userA}) returning id`;
    proyectoA = p!.id as string;

    // G0 ya aprobado (se inserta así: el guard de suficiencia vigila las actualizaciones).
    await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
      values (${wsA}, ${proyectoA}, 0, 'sponsor', 'aprobado', ${userA}, now())`;
    // G1 abierto con su checklist DECIDIDO (un N/A justificado): espera al lead.
    const [g1] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${wsA}, ${proyectoA}, 1, 'lead-boutique') returning id`;
    await admin`insert into checklist_item
      (workspace_id, gate_id, orden, texto, estado, na_justificacion, na_aprobado_por)
      values (${wsA}, ${g1!.id as string}, 0, 'Evidencia suficiente', 'na', 'No aplica en este reto', ${userA})`;
    // G2 pendiente con un ítem sin decidir: todavía es trabajo, no aprobación.
    const [g2] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${wsA}, ${proyectoA}, 2, 'lead-boutique') returning id`;
    await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${wsA}, ${g2!.id as string}, 0, 'Insights validados')`;
    // G3–G7 pendientes y sin checklist: un checklist vacío no es suficiencia.
    for (const numero of [3, 4, 5, 6, 7]) {
      await admin`insert into gate_instancia (workspace_id, proyecto_id, numero, rol_aprobador)
        values (${wsA}, ${proyectoA}, ${numero}, ${numero === 3 || numero === 5 || numero === 6 ? 'sponsor' : 'lead-boutique'})`;
    }

    // Bandeja: dos sin curar en A, uno en B.
    await admin`insert into item_importacion
      (workspace_id, titulo, contenido, tipo_fuente, creado_por) values
      (${wsA}, 'Pegado 1', 'texto', 'nota', ${userA}),
      (${wsA}, 'Pegado 2', 'texto', 'nota', ${userA}),
      (${wsB}, 'Pegado ajeno', 'texto', 'nota', ${userA})`;

    const [sb] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsB}, ${marca + ' Servicio B'}, ${userA}) returning id`;
    svcB = sb!.id as string;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    const wss = [wsA, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from checklist_item where workspace_id in ${admin(wss)}`;
      await admin`delete from gate_instancia where workspace_id in ${admin(wss)}`;
      await admin`delete from item_importacion where workspace_id in ${admin(wss)}`;
      await admin`delete from proyecto where workspace_id in ${admin(wss)}`;
      await admin`delete from reto where workspace_id in ${admin(wss)}`;
      await admin`delete from servicio where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    const usuarios = [userA, sponsorA].filter((id) => id !== '');
    if (usuarios.length > 0) await admin`delete from usuario where id in ${admin(usuarios)}`;
    await cerrarPools();
  });

  it('elige el primer servicio como el árbol y cuenta lo que espera', async () => {
    const resumen = await resumenParaUsuario(userA, wsA);
    expect(resumen.servicioId).toBe(svcA1);
    expect(resumen.hayEvidencia).toBe(false);
    expect(resumen.importacionPendientes).toBe(2);

    expect(resumen.proyectos).toHaveLength(1);
    const p = resumen.proyectos[0]!;
    expect(p.proyectoId).toBe(proyectoA);
    expect(p.servicioId).toBe(svcA1);
    expect(p.aprobados).toEqual([0]);
    expect(p.retoEstado).toBe('activo');
    expect(p.medicionAbierta).toBe(false);
    expect(p.reviewCompletado).toBe(false);

    // Solo G1: es el gate ABIERTO y su checklist está decidido. G2 tiene trabajo pendiente y
    // G3–G7 ni son el abierto ni tienen checklist.
    expect(
      resumen.aprobaciones.map((a) => [a.numero, a.rolAprobador, a.proyectoCodigo, a.esMia]),
    ).toEqual([[1, 'lead-boutique', 'P-L1', true]]);
    // El sponsor ve la misma aprobación (espera al lead), pero no como suya.
    const delSponsor = await resumenParaUsuario(sponsorA, wsA);
    expect(delSponsor.aprobaciones.map((a) => [a.numero, a.esMia])).toEqual([[1, false]]);
    // Sin design versions ni registry, no hay release ni métricas que decir.
    expect(resumen.release).toBeNull();
    expect(resumen.metricas).toBeNull();
  });

  it('con un servicio pedido habla de ese servicio, y con uno ajeno se cae al primero', async () => {
    const otro = await resumenParaUsuario(userA, wsA, svcA2);
    expect(otro.servicioId).toBe(svcA2);
    // Los proyectos son de TODO el workspace (el árbol los pinta todos), pero el release y
    // las métricas son del servicio pedido, que no tiene nada.
    expect(otro.proyectos).toHaveLength(1);
    expect(otro.release).toBeNull();
    expect(otro.metricas).toBeNull();

    // El servicio de B no existe para un miembro de A: la proyección no lo confirma y habla
    // del primero de A, que es exactamente a lo que se cae la pantalla.
    const ajeno = await resumenParaUsuario(userA, wsA, svcB);
    expect(ajeno.servicioId).toBe(svcA1);
  });

  it('un miembro de A no ve nada de B, ni preguntando directo por su workspace', async () => {
    const resumenB = await resumenParaUsuario(userA, wsB);
    expect(resumenB.servicioId).toBeNull();
    expect(resumenB.importacionPendientes).toBe(0);
    expect(resumenB.proyectos).toHaveLength(0);
    expect(resumenB.aprobaciones).toHaveLength(0);
    expect(resumenB.hayEvidencia).toBe(false);
  });

  it('aplica la capa 2: cuenta desactivada con sesión viva no lee', async () => {
    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${userA}`;
    try {
      await expect(resumenParaUsuario(userA, wsA)).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${userA}`;
    }
  });
});
