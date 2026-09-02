import { afterAll, beforeAll, expect, it } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  activarReto,
  agregarCriterio,
  aprobarGate,
  crearReto,
  editarCriterio,
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
    definicion: 'Porcentaje que inicia la verificación y no la completa',
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

    const creado = await agregarCriterio(leadId, {
      workspaceId: ws,
      retoId,
      ...criterioBase,
      ventanaDias: null, // sin ventana: G0 debe seguir bloqueado y señalarlo
    });
    const criterioId = creado.criterioId;
    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g0.id })).rejects.toThrow(
      /sin ventana/,
    );

    // La reparación de borradores es editarCriterio: sin objetivo no hay vara para el
    // veredicto del post-mortem…
    await editarCriterio(leadId, { workspaceId: ws, criterioId, ...criterioBase, objetivo: '' });
    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g0.id })).rejects.toThrow(
      /sin objetivo/,
    );
    // …valor sin fecha NO es línea base registrada (falta el punto de partida temporal
    // de la ventana, y aquí tampoco hay plan que lo supla)…
    await editarCriterio(leadId, {
      workspaceId: ws,
      criterioId,
      ...criterioBase,
      lineaBaseFecha: null,
    });
    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g0.id })).rejects.toThrow(
      /línea base completa/,
    );
    // …y con el criterio completo, G0 aprueba.
    await editarCriterio(leadId, { workspaceId: ws, criterioId, ...criterioBase });
    const ok = await aprobarGate(sponsorId, { workspaceId: ws, gateId: g0.id });
    expect(ok.numero).toBe(0);

    // Con el G0 aprobado el criterio queda congelado incluso para su curador: es la
    // base del contrato de medición.
    await expect(
      editarCriterio(leadId, { workspaceId: ws, criterioId, ...criterioBase, objetivo: '45%' }),
    ).rejects.toThrow(/congelado/);
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

    // Los gates ORDENAN el método: G4 con su checklist limpio no se aprueba con G2/G3
    // pendientes — el diagnóstico los lista.
    const g4 = p!.gates[4]!;
    for (const item of g4.items) {
      await marcarItem(leadId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', evidenciaId },
      });
    }
    await expect(aprobarGate(leadId, { workspaceId: ws, gateId: g4.id })).rejects.toThrow(
      /anteriores deben aprobarse primero \(pendientes: G2, G3\)/,
    );
    // Y volver a pendiente para no ensuciar los tests que siguen.
    for (const item of g4.items) {
      await marcarItem(leadId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'pendiente' },
      });
    }
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

    // Un N/A decidido por el sponsor queda sellado para curadores: el lead no lo
    // devuelve a pendiente (USING: un ítem en na solo lo alcanza el rol aprobador)…
    await marcarItem(sponsorId, {
      workspaceId: ws,
      itemId: g3.items[0]!.id,
      accion: { tipo: 'na', justificacion: 'Decidido por el sponsor' },
    });
    await expect(
      marcarItem(leadId, {
        workspaceId: ws,
        itemId: g3.items[0]!.id,
        accion: { tipo: 'pendiente' },
      }),
    ).rejects.toThrow(/no puedes marcarlo/);
    // …pero el propio aprobador sí puede revertir su decisión.
    await marcarItem(sponsorId, {
      workspaceId: ws,
      itemId: g3.items[0]!.id,
      accion: { tipo: 'pendiente' },
    });
    const trasRevertir = await proyectoMetodo(leadId, ws, proyectoId);
    expect(trasRevertir!.gates[3]!.items[0]!.estado).toBe('pendiente');

    // Y la simetría: el aprobador tampoco deshace un cumplido de los curadores — su
    // palanca es no aprobar el gate, no borrar trabajo (USING lo deja fuera).
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: g3.items[0]!.id,
      accion: { tipo: 'cumplido', evidenciaId },
    });
    await expect(
      marcarItem(sponsorId, {
        workspaceId: ws,
        itemId: g3.items[0]!.id,
        accion: { tipo: 'pendiente' },
      }),
    ).rejects.toThrow(/no puedes marcarlo/);
    await marcarItem(leadId, {
      workspaceId: ws,
      itemId: g3.items[0]!.id,
      accion: { tipo: 'pendiente' },
    });

    // El stakeholder no marca nada (política de curadores).
    await expect(
      marcarItem(stakeId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', evidenciaId },
      }),
    ).rejects.toThrow(ErrorMetodo);
  });

  it('un gate aprobado no admite altas de checklist y cada marca deja evento con lo previo', async () => {
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const g1 = p!.gates[1]!; // aprobado en el test del rol del gate
    // El guard de fila salta antes que el WITH CHECK: mismo veredicto, mensaje propio.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into checklist_item (workspace_id, gate_id, orden, texto)
        values (${ws}, ${g1.id}, 99, 'colado tras la aprobación')`),
    ).rejects.toThrow(/checklist congelado/);

    // El rastro del N/A revertido vive en el evento: quién lo había aprobado y por qué.
    const admin = sqlAdmin();
    const eventos = await admin`
      select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'ItemMarcado'
        and payload->>'accion' = 'pendiente'
        and payload->'previo'->>'estado' = 'na'
      order by creado_en desc limit 1`;
    expect(eventos.length).toBe(1);
    const previo = (eventos[0]!.payload as { previo: Record<string, string> }).previo;
    expect(previo.naAprobadoPor).toBe(sponsorId);
    expect(previo.naJustificacion).toBe('Decidido por el sponsor');

    // Y el rastro cubre también el SQL directo: la marca cruda deja su evento (lo
    // emite el guard de la transición, no solo marcarItem).
    const p2 = await proyectoMetodo(leadId, ws, proyectoId);
    const item2 = p2!.gates[3]!.items[1]!;
    await conUsuario(leadId, (tx) => tx`update checklist_item
      set estado = 'cumplido', evidencia_id = ${evidenciaId}
      where id = ${item2.id}`);
    const [directo] = await admin`
      select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'ItemMarcado'
        and payload->>'itemId' = ${item2.id}
      order by creado_en desc limit 1`;
    expect((directo!.payload as { accion: string }).accion).toBe('cumplido');
    await conUsuario(leadId, (tx) => tx`update checklist_item
      set estado = 'pendiente', evidencia_id = null where id = ${item2.id}`);
  });

  it('las escrituras directas del método respetan RLS: ni el stakeholder aprueba, ni el aprobador salta la suficiencia', async () => {
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const g4 = p!.gates[4]!;
    const filas = await conUsuario(stakeId, (tx) => tx`
      update gate_instancia set estado = 'aprobado', aprobado_por = ${stakeId}, aprobado_en = now()
      where id = ${g4.id}`);
    expect(filas.count).toBe(0);
    const sigue = await proyectoMetodo(leadId, ws, proyectoId);
    expect(sigue?.gates[4]?.estado).toBe('pendiente');

    // La suficiencia vive en el DATO: el sponsor es el rol de G5 pero su checklist
    // sigue pendiente — el guard del gate (y la política, como respaldo por snapshot)
    // rechaza el salto por SQL directo.
    const g5 = p!.gates[5]!;
    await expect(
      conUsuario(sponsorId, (tx) => tx`
        update gate_instancia set estado = 'aprobado', aprobado_por = ${sponsorId}, aprobado_en = now()
        where id = ${g5.id}`),
    ).rejects.toThrow(/checklist con pendientes/);
  });

  it('la carrera insertar↔aprobar por SQL directo la serializa el guard de fila', async () => {
    const p = await proyectoMetodo(leadId, ws, proyectoId);
    const g2 = p!.gates[2]!;
    for (const item of g2.items) {
      await marcarItem(leadId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'cumplido', evidenciaId },
      });
    }

    // Transacción A (SQL directo, sin candados del servicio): inserta un pendiente y
    // QUEDA ABIERTA con el FOR UPDATE del guard sobre la fila del gate. La aprobación
    // concurrente bloquea en esa fila y, al retomar, su guard re-verifica con snapshot
    // fresco y ve el ítem colado. El rechazo es determinista en cualquier intercalado:
    // si A commitea antes de que B llegue al lock, B lo ve igual.
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    const insercion = conUsuario(leadId, async (tx) => {
      await tx`insert into checklist_item (workspace_id, gate_id, orden, texto)
        values (${ws}, ${g2.id}, 99, 'colado en plena aprobación')`;
      await espera;
    });
    const aprobacion = aprobarGate(leadId, { workspaceId: ws, gateId: g2.id });
    await new Promise((r) => setTimeout(r, 150));
    liberar();
    await insercion;
    await expect(aprobacion).rejects.toThrow(/checklist con pendientes/);
    const sigue = await proyectoMetodo(leadId, ws, proyectoId);
    expect(sigue!.gates[2]!.estado).toBe('pendiente');
  });

  it('whitespace no es contenido para G0 y los guards no se prestan a tablas del rol de app', async () => {
    const r = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-95',
      titulo: 'Reto whitespace',
      descripcion: '',
      origen: 'post-mortem',
      metricaObjetivo: '',
      serviciosAfectados: [],
    });
    const act = await activarReto(leadId, {
      workspaceId: ws,
      retoId: r.retoId,
      perfil: 'rapido',
      proyectoCodigo: 'P-95',
      proyectoTitulo: 'Proyecto whitespace',
    });
    const p = await proyectoMetodo(sponsorId, ws, act.proyectoId);
    const g0 = p!.gates[0]!;
    for (const item of g0.items) {
      await marcarItem(sponsorId, {
        workspaceId: ws,
        itemId: item.id,
        accion: { tipo: 'na', justificacion: 'Cubierto' },
      });
    }
    // Solo posible por SQL directo (el schema recorta): espacios en todos los textos,
    // el KPI incluido.
    const admin = sqlAdmin();
    await admin`insert into criterio_exito
      (workspace_id, reto_id, kpi, definicion, objetivo, linea_base_plan, ventana_dias, creado_por)
      values (${ws}, ${r.retoId}, '   ', '   ', ' ', '  ', 90, ${leadId})`;
    await expect(aprobarGate(sponsorId, { workspaceId: ws, gateId: g0.id })).rejects.toThrow(
      /sin KPI/,
    );
    // El guard de fila repite el veredicto para el SQL directo del propio sponsor.
    await expect(
      conUsuario(sponsorId, (tx) => tx`
        update gate_instancia set estado = 'aprobado', aprobado_por = ${sponsorId}, aprobado_en = now()
        where id = ${g0.id}`),
    ).rejects.toThrow(/criterios incompletos/);

    // El CHECK exige justificación REAL y payload exclusivo para el N/A: espacios no
    // justifican, ni siquiera desde el propio rol aprobador por SQL directo.
    const g1 = p!.gates[1]!;
    await expect(
      conUsuario(leadId, (tx) => tx`update checklist_item
        set estado = 'na', na_justificacion = '   ', na_aprobado_por = ${leadId}
        where id = ${g1.items[0]!.id}`),
    ).rejects.toThrow(/check constraint/);

    // El ciclo del reto es de sentido único: ni el lead salta estados por SQL directo
    // (el reto principal está activo; cerrado exige pasar por en-medicion).
    await expect(
      conUsuario(leadId, (tx) => tx`update reto set estado = 'cerrado' where id = ${retoId}`),
    ).rejects.toThrow(/transición de reto ilegal/);

    // Y los SECURITY DEFINER no se adjuntan a tablas propias del rol de app (EXECUTE
    // revocado de PUBLIC): sin oráculo ni candados sobre gates de otros workspaces.
    await expect(
      conUsuario(leadId, async (tx) => {
        await tx`create temp table sonda (gate_id uuid, workspace_id uuid) on commit drop`;
        await tx`create trigger sonda_t before insert on sonda
          for each row execute function checklist_gate_pendiente_guard()`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('un checklist vacío no es suficiencia y el guard instalado no es oráculo cross-tenant', async () => {
    // Un proyecto colado a mano por el rol de app muere al commit (constraint diferido:
    // proyecto ⇒ método instanciado)…
    await expect(
      conUsuario(leadId, (tx) => tx`insert into proyecto
        (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
        values (${ws}, ${retoId}, 'P-96', 'Huérfano', 'activo', 'rapido', ${leadId})`),
    ).rejects.toThrow(/instanciar su método/);
    // …y una MUESTRA del método tampoco basta: el guard exige la estructura completa
    // (8 etapas, 8 gates, cada gate con checklist), no una etapa suelta.
    await expect(
      conUsuario(leadId, async (tx) => {
        const [pr] = await tx`insert into proyecto
          (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
          values (${ws}, ${retoId}, 'P-96', 'Huérfano', 'activo', 'rapido', ${leadId})
          returning id`;
        await tx`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre)
          values (${ws}, ${pr!.id as string}, 0, 'Definición del objeto y del reto')`;
      }),
    ).rejects.toThrow(/instanciar su método/);
    // …así que el gate SIN ítems del siguiente chequeo solo puede fabricarlo el admin
    // (el guard salta para el owner sin contexto): el NOT EXISTS de pendientes sería
    // vacuamente cierto — lo tapa exigir ≥1 ítem.
    const adminSetup = sqlAdmin();
    const [pr96] = await adminSetup`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${ws}, ${retoId}, 'P-96', 'Huérfano', 'activo', 'rapido', ${leadId})
      returning id`;
    const [g96] = await adminSetup`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${pr96!.id as string}, 1, 'lead-boutique') returning id`;
    const huerfano = g96!.id as string;
    await expect(aprobarGate(leadId, { workspaceId: ws, gateId: huerfano })).rejects.toThrow(
      /checklist instanciado/,
    );
    await expect(
      conUsuario(leadId, (tx) => tx`
        update gate_instancia set estado = 'aprobado', aprobado_por = ${leadId}, aprobado_en = now()
        where id = ${huerfano}`),
    ).rejects.toThrow(/checklist instanciado/);

    // Activo ⇒ método instanciado (constraint diferido al commit): el update crudo
    // solitario aborta y el reto sigue candidato — activarReto, que crea el método en
    // la MISMA transacción antes del commit, es el único camino que pasa.
    const r97 = await crearReto(leadId, {
      workspaceId: ws,
      servicioAnclaId: svcId,
      codigo: 'R-97',
      titulo: 'Reto sin método',
      descripcion: '',
      origen: 'post-mortem',
      metricaObjetivo: '',
      serviciosAfectados: [],
    });
    await expect(
      conUsuario(leadId, (tx) => tx`update reto set estado = 'activo' where id = ${r97.retoId}`),
    ).rejects.toThrow(/instanciar su método/);
    const [sigueCandidato] = await conUsuario(leadId, (tx) => tx`
      select estado from reto where id = ${r97.retoId}`);
    expect(sigueCandidato!.estado).toBe('candidato');

    // Oráculo: un miembro de OTRO workspace que apunte a nuestro reto (G0 aprobado)
    // recibe el error de política de siempre — el pre-chequeo de membresía del guard
    // evita la consulta privilegiada y sus mensajes/candados delatores.
    const admin = sqlAdmin();
    const [wsX] = await admin`insert into workspace (nombre) values (${marca + '-X'}) returning id`;
    const [ux] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '-x@test.demo'}, 'Fisgón', 'activo') returning id`;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsX!.id as string}, ${ux!.id as string}, 'Fisgón', ${marca + '-x@test.demo'}, 'lead-boutique')`;
    try {
      await expect(
        conUsuario(ux!.id as string, (tx) => tx`insert into criterio_exito
          (workspace_id, reto_id, kpi, creado_por)
          values (${ws}, ${retoId}, 'Sonda', ${ux!.id as string})`),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await admin`delete from miembro where workspace_id = ${wsX!.id as string}`;
      await admin`delete from workspace where id = ${wsX!.id as string}`;
    }
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
