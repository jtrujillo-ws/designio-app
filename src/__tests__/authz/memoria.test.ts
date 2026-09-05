import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sql, sqlAdmin } from '@/lib/db';
import { construirMemoria, memoriaParaUsuario } from '@/lib/memoria/memoria.queries';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { describeAuthz } from './helpers';

/**
 * Biblioteca del cliente — la proyección de la memoria del workspace respeta RLS
 * (SYS-01/02): un miembro de A lee su memoria entera y no una fila de B, ni siquiera
 * preguntando directo; sin contexto de usuario no hay filas; y la cuenta desactivada con
 * sesión viva no lee (capa 2). Además fija QUÉ es memoria: solo insights validados, solo
 * decisiones vigentes, solo candidatos nacidos del post mortem.
 */
describeAuthz('biblioteca del cliente (proyección de la memoria + aislamiento)', () => {
  const marca = `mem-${crypto.randomUUID().slice(0, 8)}`;
  let wsA = '';
  let wsB = '';
  let userA = '';
  let segIndep = '';
  let segPymes = '';
  let retoA = '';
  let proyectoA = '';
  let retoCerradoA = '';
  let arqConfirmado = '';
  let arqHipotesis = '';
  let insightValidado = '';
  let decisionVigente = '';

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [a] = await admin`insert into workspace (nombre) values (${marca + '-A'}) returning id`;
    const [b] = await admin`insert into workspace (nombre) values (${marca + '-B'}) returning id`;
    wsA = a!.id as string;
    wsB = b!.id as string;

    const [ua] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '@a.test'}, 'Usuario Memoria', 'activo') returning id`;
    userA = ua!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsA}, ${userA}, 'Usuario Memoria', ${marca + '@a.test'}, 'lead-boutique')`;

    // ── Workspace A: la memoria completa ──
    const [s1] = await admin`insert into segmento (workspace_id, nombre, definicion)
      values (${wsA}, 'independientes', 'Trabajadores por cuenta propia') returning id`;
    segIndep = s1!.id as string;
    const [s2] = await admin`insert into segmento (workspace_id, nombre, definicion)
      values (${wsA}, 'pymes', 'Empresas pequeñas') returning id`;
    segPymes = s2!.id as string;

    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsA}, ${marca + ' Servicio'}, ${userA}) returning id`;
    const svcA = svc!.id as string;

    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, creado_por)
      values (${wsA}, ${svcA}, 'R-M1', 'Reto con arquetipos', 'activo', ${userA}) returning id`;
    retoA = r!.id as string;
    const [p] = await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${wsA}, ${retoA}, 'P-M1', 'Proyecto con memoria', ${userA}) returning id`;
    proyectoA = p!.id as string;

    // Un arquetipo confirmado mapeado a DOS segmentos y una hipótesis sin segmento.
    const [ac] = await admin`insert into arquetipo
      (workspace_id, reto_id, nombre, definicion, estado, veredicto_razon, creado_por)
      values (${wsA}, ${retoA}, 'Independiente sin firma digital', 'Sin certificado vigente',
              'confirmado', 'Tres de seis entrevistas encajan', ${userA}) returning id`;
    arqConfirmado = ac!.id as string;
    await admin`insert into arquetipo_segmento (arquetipo_id, segmento_id, workspace_id)
      values (${arqConfirmado}, ${segIndep}, ${wsA}), (${arqConfirmado}, ${segPymes}, ${wsA})`;
    const [ah] = await admin`insert into arquetipo (workspace_id, reto_id, nombre, creado_por)
      values (${wsA}, ${retoA}, 'Pyme con contador externo', ${userA}) returning id`;
    arqHipotesis = ah!.id as string;

    // Un insight validado (memoria) y uno propuesto (todavía no).
    const [iv] = await admin`insert into insight
      (workspace_id, titulo, resumen, estado, validado_por, validado_en, creado_por)
      values (${wsA}, 'Fricción documental', 'El abandono se concentra al subir documentos',
              'validado', ${userA}, now(), ${userA}) returning id`;
    insightValidado = iv!.id as string;
    await admin`insert into insight (workspace_id, titulo, creado_por)
      values (${wsA}, 'Insight propuesto', ${userA})`;

    // Una decisión vigente (memoria) y una en revisión (cuestionada: no).
    const [g1] =
      await admin`insert into gate_instancia (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${wsA}, ${proyectoA}, 1, 'lead-boutique') returning id`;
    const gateA = g1!.id as string;
    const [dv] = await admin`insert into decision
      (workspace_id, proyecto_id, gate_id, tipo, titulo, fundamento, decidido_por)
      values (${wsA}, ${proyectoA}, ${gateA}, 'diseno', 'Atacar la verificación digital',
              'El insight validado concentra el abandono ahí', ${userA}) returning id`;
    decisionVigente = dv!.id as string;
    await admin`insert into decision
      (workspace_id, proyecto_id, gate_id, tipo, titulo, estado, decidido_por)
      values (${wsA}, ${proyectoA}, ${gateA}, 'alcance', 'Decisión cuestionada', 'en-revision',
              ${userA})`;

    // Un reto cerrado con outcome review completado (veredicto) y un candidato de cada
    // origen: solo el del post mortem es memoria.
    const [rc] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, veredicto, creado_por)
      values (${wsA}, ${svcA}, 'R-M0', 'Reto ya cerrado', 'cerrado', 'parcialmente-logrado',
              ${userA}) returning id`;
    retoCerradoA = rc!.id as string;
    await admin`insert into proyecto (workspace_id, reto_id, codigo, titulo, estado, creado_por)
      values (${wsA}, ${retoCerradoA}, 'P-M0', 'Proyecto cerrado', 'cerrado', ${userA})`;
    await admin`insert into outcome_review
      (workspace_id, reto_id, estado, veredicto, contribucion, aprendizajes,
       completado_por, completado_en, creado_por)
      values (${wsA}, ${retoCerradoA}, 'completado', 'parcialmente-logrado',
              'El abandono bajó a la mitad del objetivo', 'La sucursal no era el problema',
              ${userA}, now(), ${userA})`;
    await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
      values (${wsA}, ${svcA}, 'R-M2', 'Candidato del post mortem', 'candidato', 'post-mortem',
              ${userA}),
             (${wsA}, ${svcA}, 'R-M3', 'Candidato pedido por el cliente', 'candidato',
              'peticion-cliente', ${userA})`;

    // ── Workspace B: la misma forma, para que el aislamiento tenga algo que ocultar ──
    const [sb] = await admin`insert into segmento (workspace_id, nombre)
      values (${wsB}, 'ajenos') returning id`;
    const [svcB] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsB}, ${marca + ' Servicio B'}, ${userA}) returning id`;
    const [rb] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, creado_por)
      values (${wsB}, ${svcB!.id as string}, 'R-M1', 'Reto ajeno', 'activo', ${userA}) returning id`;
    const [ab] = await admin`insert into arquetipo (workspace_id, reto_id, nombre, creado_por)
      values (${wsB}, ${rb!.id as string}, 'Arquetipo ajeno', ${userA}) returning id`;
    await admin`insert into arquetipo_segmento (arquetipo_id, segmento_id, workspace_id)
      values (${ab!.id as string}, ${sb!.id as string}, ${wsB})`;
    await admin`insert into insight
      (workspace_id, titulo, estado, validado_por, validado_en, creado_por)
      values (${wsB}, 'Insight ajeno validado', 'validado', ${userA}, now(), ${userA})`;
    await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
      values (${wsB}, ${svcB!.id as string}, 'R-M2', 'Candidato ajeno', 'candidato', 'post-mortem',
              ${userA})`;
  });

  afterAll(async () => {
    // Si beforeAll falló a medias, limpiar solo lo que sí existe: un id vacío en el
    // IN lanzaría 22P02 y taparía el error real del setup.
    const admin = sqlAdmin();
    const wss = [wsA, wsB].filter((id) => id !== '');
    if (wss.length > 0) {
      await admin`delete from evento_dominio where workspace_id in ${admin(wss)}`;
      await admin`delete from outcome_review where workspace_id in ${admin(wss)}`;
      await admin`delete from decision where workspace_id in ${admin(wss)}`;
      await admin`delete from gate_instancia where workspace_id in ${admin(wss)}`;
      await admin`delete from arquetipo_segmento where workspace_id in ${admin(wss)}`;
      await admin`delete from arquetipo where workspace_id in ${admin(wss)}`;
      await admin`delete from insight where workspace_id in ${admin(wss)}`;
      await admin`delete from proyecto where workspace_id in ${admin(wss)}`;
      await admin`delete from reto where workspace_id in ${admin(wss)}`;
      await admin`delete from servicio where workspace_id in ${admin(wss)}`;
      await admin`delete from segmento where workspace_id in ${admin(wss)}`;
      await admin`delete from miembro where workspace_id in ${admin(wss)}`;
      await admin`delete from workspace where id in ${admin(wss)}`;
    }
    if (userA) await admin`delete from usuario where id = ${userA}`;
    await cerrarPools();
  });

  it('proyecta la memoria completa de A: arquetipos con reto y proyecto, y solo lo que ya es memoria', async () => {
    const m = await memoriaParaUsuario(userA, wsA);
    expect(m).not.toBeNull();
    expect(m!.workspaceNombre).toBe(marca + '-A');
    expect(m!.segmentos.map((s) => s.nombre)).toEqual(['independientes', 'pymes']);

    expect(m!.arquetipos.map((a) => a.id)).toEqual([arqConfirmado, arqHipotesis]);
    const confirmado = m!.arquetipos.find((a) => a.id === arqConfirmado)!;
    expect(confirmado.estado).toBe('confirmado');
    expect(confirmado.veredictoRazon).toBe('Tres de seis entrevistas encajan');
    expect(confirmado.reto).toEqual({
      id: retoA,
      codigo: 'R-M1',
      titulo: 'Reto con arquetipos',
      estado: 'activo',
    });
    expect(confirmado.proyecto).toEqual({ id: proyectoA, codigo: 'P-M1' });
    expect(confirmado.segmentoIds).toEqual([segIndep, segPymes]);
    const hipotesis = m!.arquetipos.find((a) => a.id === arqHipotesis)!;
    expect(hipotesis.estado).toBe('hipotesis');
    expect(hipotesis.segmentoIds).toEqual([]);

    // Solo el validado; el propuesto no es memoria.
    expect(m!.insights.map((i) => i.id)).toEqual([insightValidado]);
    expect(m!.insights[0]!.validadoEn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Solo la vigente; la que está en revisión, no.
    expect(m!.decisiones.map((d) => d.id)).toEqual([decisionVigente]);
    expect(m!.decisiones[0]!.gateNumero).toBe(1);
    expect(m!.decisiones[0]!.proyecto).toEqual({
      id: proyectoA,
      codigo: 'P-M1',
      titulo: 'Proyecto con memoria',
    });

    // El reto cerrado trae el veredicto del outcome review y su narrativa.
    expect(m!.retosCerrados).toHaveLength(1);
    const cerrado = m!.retosCerrados[0]!;
    expect(cerrado.id).toBe(retoCerradoA);
    expect(cerrado.veredicto).toBe('parcialmente-logrado');
    expect(cerrado.contribucion).toBe('El abandono bajó a la mitad del objetivo');
    expect(cerrado.aprendizajes).toBe('La sucursal no era el problema');
    expect(cerrado.cerradoEn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cerrado.proyecto?.codigo).toBe('P-M0');

    // Solo el candidato del post mortem: el pedido por el cliente es pipeline, no memoria.
    expect(m!.retosCandidatos.map((r) => r.codigo)).toEqual(['R-M2']);
  });

  it('memoriaParaUsuario aplica la capa 2: cuenta activa lee, desactivada con sesión viva no', async () => {
    const m = await memoriaParaUsuario(userA, wsA);
    expect(m?.arquetipos.length).toBeGreaterThan(0);

    const admin = sqlAdmin();
    await admin`update usuario set estado = 'inactivo' where id = ${userA}`;
    try {
      await expect(memoriaParaUsuario(userA, wsA)).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${userA}`;
    }
  });

  it('sin contexto de usuario, la memoria es invisible (cero filas)', async () => {
    const filas = await sql()`select id from arquetipo where workspace_id in (${wsA}, ${wsB})`;
    expect(filas.length).toBe(0);
  });

  it('un miembro de A no lee la memoria de B, ni siquiera preguntando directo', async () => {
    // Por la puerta de la función: el workspace no es visible y se responde null.
    expect(await memoriaParaUsuario(userA, wsB)).toBeNull();

    // Y por la proyección directa con el id de B: la RLS deja cada sección vacía.
    const m = await conUsuario(userA, (tx) => construirMemoria(tx, wsB, 'B'));
    expect(m.segmentos).toHaveLength(0);
    expect(m.arquetipos).toHaveLength(0);
    expect(m.insights).toHaveLength(0);
    expect(m.decisiones).toHaveLength(0);
    expect(m.retosCerrados).toHaveLength(0);
    expect(m.retosCandidatos).toHaveLength(0);
  });
});
