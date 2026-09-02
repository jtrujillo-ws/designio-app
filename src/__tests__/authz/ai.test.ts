import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { MODELO_PRIMARIO } from '@/lib/ai/ai.degradacion';
import { PROMPT_VERSION } from '@/lib/ai/ai.prompts';
import type {
  ContenidoCriterio,
  ContenidoExtraccion,
  ContenidoPropuesta,
} from '@/lib/ai/ai.schemas';
import {
  aceptarPropuesta,
  ErrorAI,
  generarPropuestas,
  panelPropuestas,
  rechazarPropuesta,
} from '@/lib/ai/ai.servicio';
import type { ResultadoProveedor } from '@/lib/ai/proveedor.server';
import { describeAuthz } from './helpers';

/** El proveedor es el ÚNICO tercero del pipeline y se sustituye para poder recorrer la
 * generación entera —incluido el lote de propuestas y su lineage— sin red. La resolución
 * de credenciales y la degradación siguen siendo las reales. */
const proveedor = vi.hoisted(() => ({ respuesta: null as ResultadoProveedor | null }));
vi.mock('@/lib/ai/proveedor.server', async (original) => {
  const real = await original<typeof import('@/lib/ai/proveedor.server')>();
  return { ...real, generarConProveedor: async () => proveedor.respuesta };
});

/**
 * SPEC-08 + parte AI de SPEC-09: la AI propone y el humano decide (I4). Lo que se
 * verifica aquí es que el dominio NO cambia hasta la aceptación, que el objeto que nace
 * lleva la firma del humano y el lineage de la propuesta (SYS-19), que la propuesta
 * original se conserva aunque se corrija (SYS-17), y que con la AI apagada todo lo demás
 * sigue funcionando (SYS-21).
 */
describeAuthz('AI: PropuestaAI, materialización humana y degradación segura', () => {
  const marca = `ai-${crypto.randomUUID().slice(0, 8)}`;
  let ws = '';
  let leadId = '';
  let disenadorId = '';
  let stakeId = '';
  let agenteId = '';
  let svcId = '';
  let retoId = '';

  const MATERIAL = 'El 71% de los abandonos ocurre en la carga del documento de identidad.';

  const CONTENIDO_CI: ContenidoExtraccion = {
    titulo: 'Abandono en verificación',
    resumen: 'El abandono se concentra en la carga del documento.',
    recoleccion: 'Análisis de funnel',
    fecha: '2026-07-20',
    derivada: true,
    confianza: 'media',
    confidencialidad: 'cliente',
    esEstadoActual: true,
    citas: [
      { fragmento: 'El 71% de los abandonos', localizacion: 'párrafo 1' },
      { fragmento: 'inventado que no está en el material', localizacion: 'párrafo 1' },
    ],
  };

  const CONTENIDO_C0: ContenidoCriterio = {
    kpi: 'Abandono en verificación',
    definicion: 'Porcentaje que inicia y no completa la verificación',
    objetivo: '40%',
    ventanaDias: 90,
    lineaBasePlan: 'Extraer el funnel de analítica de los últimos 90 días',
    razonamiento: 'Es la métrica que el reto declara como objetivo',
  };

  /** Item de bandeja pendiente (setup con la conexión admin, como el resto de la suite). */
  async function nuevoItem(titulo: string): Promise<string> {
    const [i] = await sqlAdmin()`insert into item_importacion
      (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
      values (${ws}, ${titulo}, ${MATERIAL}, 'nota', 'ref', ${leadId})
      returning id`;
    return i!.id as string;
  }

  /** Propuesta pendiente creada por el camino real (RLS del rol de aplicación): la
   * generación llama al proveedor, que en tests no existe — lo que se prueba aquí es el
   * pipeline de revisión y materialización, no la llamada externa. */
  async function nuevaPropuesta(
    actorId: string,
    campos: {
      capacidad: 'CI' | 'C0';
      destino: 'evidencia' | 'criterio-exito';
      itemId?: string | null;
      retoId?: string | null;
      contenido?: ContenidoPropuesta;
    },
  ): Promise<string> {
    const contenido = campos.contenido ?? (campos.capacidad === 'CI' ? CONTENIDO_CI : CONTENIDO_C0);
    const [p] = await conUsuario(actorId, (tx) => tx`
      insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, reto_id, contenido, contenido_original,
         confianza, modelo, prompt_version, alcance_resumen, latencia_ms, origen_key, creado_por)
      values (${ws}, ${campos.capacidad}, ${campos.destino}, ${campos.itemId ?? null},
              ${campos.retoId ?? null}, ${tx.json(contenido)}, ${tx.json(contenido)},
              0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'alcance de prueba', 900,
              'entorno', ${actorId})
      returning id`);
    return p!.id as string;
  }

  beforeAll(async () => {
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca}) returning id`;
    ws = w!.id as string;

    const personas = [
      ['lead', 'lead-boutique'],
      ['dis', 'disenador'],
      ['stake', 'stakeholder'],
      // El actor de plataforma existe en el catálogo de roles: aquí se prueba que NO cura
      // ni decide nada (SYS-18).
      ['agente', 'agente-ai'],
    ] as const;
    for (const [alias, rol] of personas) {
      const [u] = await admin`insert into usuario (email, nombre, estado)
        values (${`${marca}-${alias}@test.demo`}, ${alias}, 'activo') returning id`;
      const id = u!.id as string;
      if (alias === 'lead') leadId = id;
      if (alias === 'dis') disenadorId = id;
      if (alias === 'stake') stakeId = id;
      if (alias === 'agente') agenteId = id;
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${ws}, ${id}, ${alias}, ${`${marca}-${alias}@test.demo`}, ${rol})`;
    }

    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${ws}, ${marca + ' Servicio'}, ${leadId}) returning id`;
    svcId = svc!.id as string;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
      values (${ws}, ${svcId}, 'R-80', 'Reto AI', 'candidato', 'peticion-cliente', ${leadId})
      returning id`;
    retoId = r!.id as string;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    if (ws) {
      await admin`delete from evento_dominio where workspace_id = ${ws}`;
      await admin`delete from propuesta_ai where workspace_id = ${ws}`;
      await admin`delete from item_importacion where workspace_id = ${ws}`;
      await admin`delete from criterio_exito where workspace_id = ${ws}`;
      await admin`delete from evidencia where workspace_id = ${ws}`;
      await admin`delete from fuente where workspace_id = ${ws}`;
      await admin`delete from reto where workspace_id = ${ws}`;
      await admin`delete from servicio where workspace_id = ${ws}`;
      await admin`delete from miembro where workspace_id = ${ws}`;
      await admin`delete from workspace where id = ${ws}`;
    }
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  it('la propuesta nace pendiente, atribuida y con su original intacto; un stakeholder no la crea', async () => {
    const itemId = await nuevoItem('Notas de funnel');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });
    const [fila] = await conUsuario(leadId, (tx) => tx`
      select estado, creado_por, revisada_por, evidencia_id, contenido = contenido_original as igual
      from propuesta_ai where id = ${propuestaId}`);
    expect(fila!.estado).toBe('propuesta');
    expect(fila!.creado_por).toBe(leadId);
    expect(fila!.revisada_por).toBeNull();
    expect(fila!.evidencia_id).toBeNull();
    expect(fila!.igual).toBe(true);

    // El alta deja rastro con el lineage completo (RF-09.9): qué modelo, qué prompt, qué key.
    const admin = sqlAdmin();
    const [evento] = await admin`select payload, actor_id from evento_dominio
      where workspace_id = ${ws} and tipo = 'PropuestaAIGenerada'
        and payload->>'propuestaId' = ${propuestaId}`;
    expect(evento!.actor_id).toBe(leadId);
    expect((evento!.payload as { modelo: string; origenKey: string }).origenKey).toBe('entorno');

    // Un stakeholder no pide propuestas: la política solo alcanza a los curadores.
    await expect(
      nuevaPropuesta(stakeId, { capacidad: 'CI', destino: 'evidencia', itemId }),
    ).rejects.toThrow(/row-level security/);
    // Y el rol `agente-ai` tampoco: no es un actor que proponga por su cuenta (SYS-18).
    await expect(
      nuevaPropuesta(agenteId, { capacidad: 'CI', destino: 'evidencia', itemId }),
    ).rejects.toThrow(/row-level security/);
  });

  it('una propuesta no puede nacer ya decidida ni con un «original» distinto de lo propuesto', async () => {
    const itemId = await nuevoItem('Item para altas forzadas');
    // Nacer aceptada saltaría la firma humana: la política de INSERT lo impide.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, creado_por, estado, revisada_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                'm', 'v', 'entorno', ${leadId}, 'aceptada', ${leadId})`),
    ).rejects.toThrow(/row-level security|check constraint/);
    // Y el «original» tiene que ser de verdad el original (SYS-17).
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, creado_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":2}'::jsonb,
                'm', 'v', 'entorno', ${leadId})`),
    ).rejects.toThrow(/row-level security/);
    // SYS-20: una simulación de revisor AI jamás se materializa como evidencia.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, creado_por, es_simulacion)
        values (${ws}, 'C4', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                'm', 'v', 'entorno', ${leadId}, true)`),
    ).rejects.toThrow(/check constraint/);
  });

  it('aceptar materializa la evidencia firmada por el humano y sella el item (SYS-16/SYS-19)', async () => {
    const itemId = await nuevoItem('Item que se acepta');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });

    // Antes de aceptar, el dominio está intacto: ni fuente ni evidencia.
    const antes = await conUsuario(leadId, (tx) => tx`
      select 1 as x from evidencia where workspace_id = ${ws}`);
    expect(antes.length).toBe(0);

    const r = await aceptarPropuesta(leadId, { workspaceId: ws, propuestaId });
    expect(r.estado).toBe('aceptada');

    const [ev] = await conUsuario(leadId, (tx) => tx`
      select creado_por, titulo, dimensiones, es_estado_actual from evidencia where id = ${r.objetoId}`);
    // El autor es el humano que aceptó, no la AI (I4/SYS-18).
    expect(ev!.creado_por).toBe(leadId);
    expect(ev!.titulo).toBe(CONTENIDO_CI.titulo);
    const dim = ev!.dimensiones as {
      lineage: { modelo: string; promptVersion: string } | null;
      derechos: { consentimiento: boolean };
    };
    // La evidencia dice para siempre que pasó por una transformación AI (SYS-19)…
    expect(dim.lineage?.modelo).toBe(MODELO_PRIMARIO);
    expect(dim.lineage?.promptVersion).toBe(PROMPT_VERSION);
    // …y el consentimiento NO lo infiere la AI (RF-09.5): nace en falso.
    expect(dim.derechos.consentimiento).toBe(false);

    // La curaduría de la bandeja queda sellada por la misma persona y con esa evidencia.
    const [item] = await conUsuario(leadId, (tx) => tx`
      select estado, decidido_por, evidencia_id from item_importacion where id = ${itemId}`);
    expect(item!.estado).toBe('aprobado');
    expect(item!.decidido_por).toBe(leadId);
    expect(item!.evidencia_id).toBe(r.objetoId);

    const [p] = await conUsuario(leadId, (tx) => tx`
      select estado, revisada_por, revisada_en, evidencia_id from propuesta_ai where id = ${propuestaId}`);
    expect(p!.estado).toBe('aceptada');
    expect(p!.revisada_por).toBe(leadId);
    expect(p!.revisada_en).not.toBeNull();
    expect(p!.evidencia_id).toBe(r.objetoId);

    const admin = sqlAdmin();
    const [evento] = await admin`select actor_rol from evento_dominio
      where workspace_id = ${ws} and tipo = 'PropuestaAIAceptada'
        and payload->>'propuestaId' = ${propuestaId}`;
    expect(evento!.actor_rol).toBe('lead-boutique');

    // Decidida = inmutable: ni el mismo curador vuelve sobre ella.
    await expect(aceptarPropuesta(leadId, { workspaceId: ws, propuestaId })).rejects.toThrow(
      /ya fue revisada/,
    );
    await expect(rechazarPropuesta(leadId, { workspaceId: ws, propuestaId })).rejects.toThrow(
      ErrorAI,
    );
  });

  it('corregir conserva el original y se registra como corrección, no como aceptación', async () => {
    const itemId = await nuevoItem('Item que se corrige');
    const propuestaId = await nuevaPropuesta(disenadorId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });
    const r = await aceptarPropuesta(disenadorId, {
      workspaceId: ws,
      propuestaId,
      correccion: { ...CONTENIDO_CI, titulo: 'Título corregido por una persona' },
    });
    expect(r.estado).toBe('corregida');

    const [p] = await conUsuario(disenadorId, (tx) => tx`
      select estado, contenido->>'titulo' as titulo,
             contenido_original->>'titulo' as titulo_original
      from propuesta_ai where id = ${propuestaId}`);
    expect(p!.estado).toBe('corregida');
    expect(p!.titulo).toBe('Título corregido por una persona');
    // SYS-17: lo que la AI dijo de verdad sigue ahí.
    expect(p!.titulo_original).toBe(CONTENIDO_CI.titulo);

    const [ev] = await conUsuario(disenadorId, (tx) => tx`
      select titulo from evidencia where id = ${r.objetoId}`);
    expect(ev!.titulo).toBe('Título corregido por una persona');

    // Una «corrección» idéntica al original no es una corrección.
    const otroItem = await nuevoItem('Item con corrección vacía');
    const otra = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId: otroItem,
    });
    const r2 = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId: otra,
      correccion: { ...CONTENIDO_CI },
    });
    expect(r2.estado).toBe('aceptada');
  });

  it('rechazar no toca el dominio: el item sigue pendiente de curaduría manual (SYS-21)', async () => {
    const itemId = await nuevoItem('Item que se rechaza');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });

    const [item] = await conUsuario(leadId, (tx) => tx`
      select estado, evidencia_id from item_importacion where id = ${itemId}`);
    expect(item!.estado).toBe('pendiente');
    expect(item!.evidencia_id).toBeNull();
    const [p] = await conUsuario(leadId, (tx) => tx`
      select estado, evidencia_id, contenido->>'titulo' as titulo from propuesta_ai where id = ${propuestaId}`);
    expect(p!.estado).toBe('rechazada');
    expect(p!.evidencia_id).toBeNull();
    // La propuesta rechazada se conserva íntegra: es insumo de las métricas de grounding.
    expect(p!.titulo).toBe(CONTENIDO_CI.titulo);
  });

  it('C0: aceptar crea el criterio bajo el reto, firmado por el humano y SIN línea base inventada', async () => {
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'C0',
      destino: 'criterio-exito',
      retoId,
    });
    const r = await aceptarPropuesta(leadId, { workspaceId: ws, propuestaId });
    expect(r.estado).toBe('aceptada');

    const [c] = await conUsuario(leadId, (tx) => tx`
      select reto_id, creado_por, kpi, ventana_dias, linea_base_valor, linea_base_fecha,
             linea_base_plan
      from criterio_exito where id = ${r.objetoId}`);
    expect(c!.reto_id).toBe(retoId);
    expect(c!.creado_por).toBe(leadId);
    expect(c!.kpi).toBe(CONTENIDO_C0.kpi);
    expect(c!.ventana_dias).toBe(90);
    // La AI no inventa mediciones: propone el plan, no el valor (SYS-22 admite ambas vías).
    expect(c!.linea_base_valor).toBeNull();
    expect(c!.linea_base_fecha).toBeNull();
    expect(c!.linea_base_plan).toBe(CONTENIDO_C0.lineaBasePlan);

    // El guard del método emite su propio evento para el criterio nacido de la propuesta.
    const admin = sqlAdmin();
    const [evento] = await admin`select actor_id from evento_dominio
      where workspace_id = ${ws} and tipo = 'CriterioDefinido'
        and payload->>'criterioId' = ${r.objetoId}`;
    expect(evento!.actor_id).toBe(leadId);
  });

  it('por SQL directo tampoco hay escritura AI: aceptar exige materializar el objeto correcto', async () => {
    const itemId = await nuevoItem('Item de escrituras crudas');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });

    // Aceptar sin materializar nada: el CHECK de la tabla lo impide (SYS-19).
    await expect(
      conUsuario(leadId, (tx) => tx`update propuesta_ai
        set estado = 'aceptada', revisada_por = ${leadId} where id = ${propuestaId}`),
    ).rejects.toThrow(/check constraint/);

    // Apuntar a la evidencia de OTRO item: el constraint diferido lo revienta al commit.
    const otroItem = await nuevoItem('Item ya curado a mano');
    const ajena = await aceptarPropuesta(
      leadId,
      {
        workspaceId: ws,
        propuestaId: await nuevaPropuesta(leadId, {
          capacidad: 'CI',
          destino: 'evidencia',
          itemId: otroItem,
        }),
      },
    );
    await expect(
      conUsuario(leadId, (tx) => tx`update propuesta_ai
        set estado = 'aceptada', revisada_por = ${leadId}, evidencia_id = ${ajena.objetoId}
        where id = ${propuestaId}`),
    ).rejects.toThrow(/sella su item de la bandeja/);

    // El lineage y el original no tienen superficie de escritura para el rol de la app.
    await expect(
      conUsuario(leadId, (tx) => tx`update propuesta_ai
        set contenido_original = '{}'::jsonb where id = ${propuestaId}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      conUsuario(leadId, (tx) => tx`update propuesta_ai
        set modelo = 'otro' where id = ${propuestaId}`),
    ).rejects.toThrow(/permission denied/);

    // Ni un stakeholder ni el propio `agente-ai` revisan nada: la política de UPDATE no
    // los alcanza — la AI no cura ni aprueba, ni siquiera su propia propuesta (SYS-18).
    const filas = await conUsuario(stakeId, (tx) => tx`update propuesta_ai
      set estado = 'rechazada', revisada_por = ${stakeId} where id = ${propuestaId}`);
    expect(filas.count).toBe(0);
    const porElAgente = await conUsuario(agenteId, (tx) => tx`update propuesta_ai
      set estado = 'aceptada', revisada_por = ${agenteId} where id = ${propuestaId}`);
    expect(porElAgente.count).toBe(0);
    // Y el stakeholder tampoco decide por el servicio.
    await expect(
      rechazarPropuesta(stakeId, { workspaceId: ws, propuestaId }),
    ).rejects.toThrow(/lead-boutique o diseñador/);
  });

  it('la degradación es total: sin credencial se apaga la capacidad y todo lo demás sigue', async () => {
    const itemId = await nuevoItem('Item con la AI apagada');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });

    const previa = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      // El panel se pinta igual, con la bandera en apagada y su motivo.
      const panel = await panelPropuestas(leadId, ws);
      expect(panel.ai.disponible).toBe(false);
      expect(panel.ai.motivo).toMatch(/credencial/i);
      expect(panel.pendientes.some((p) => p.id === propuestaId)).toBe(true);

      // Generar responde con un error de DOMINIO (contrato {ok:false}), no con una excepción
      // que rompa la pantalla ni con un throw del SDK.
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(ErrorAI);

      // Y lo importante: revisar lo ya propuesto NO depende del proveedor.
      const r = await aceptarPropuesta(leadId, { workspaceId: ws, propuestaId });
      expect(r.estado).toBe('aceptada');
    } finally {
      if (previa === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previa;
    }
  });

  it('generar crea propuestas pendientes con lineage y NO toca el dominio (RF-08.1)', async () => {
    const previa = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-de-prueba';
    try {
      // C0 devuelve un LOTE: una propuesta por criterio, revisable por elemento.
      proveedor.respuesta = {
        ok: true,
        modelo: 'modelo-de-prueba',
        latenciaMs: 1234,
        datos: { criterios: [CONTENIDO_C0, { ...CONTENIDO_C0, kpi: 'Tiempo a cuenta activa' }] },
      };
      const lote = await generarPropuestas(leadId, {
        workspaceId: ws,
        capacidad: 'C0',
        anclaId: retoId,
      });
      expect(lote.generadas).toBe(2);
      const nacidas = await conUsuario(leadId, (tx) => tx`
        select estado, modelo, latencia_ms, contenido = contenido_original as igual
        from propuesta_ai
        where workspace_id = ${ws} and reto_id = ${retoId} and modelo = 'modelo-de-prueba'`);
      expect(nacidas.length).toBe(2);
      expect(nacidas.every((n) => n.estado === 'propuesta' && n.igual === true)).toBe(true);
      expect(nacidas[0]!.latencia_ms).toBe(1234);
      // Ningún criterio existe todavía por estas propuestas: la AI no escribe (SYS-19).
      const criterios = await conUsuario(leadId, (tx) => tx`
        select 1 as x from criterio_exito where workspace_id = ${ws} and kpi = 'Tiempo a cuenta activa'`);
      expect(criterios.length).toBe(0);

      // Un fallo del proveedor no deja rastro ni consume presupuesto.
      const itemId = await nuevoItem('Item con proveedor caído');
      proveedor.respuesta = { ok: false, motivo: 'El proveedor AI no está disponible.' };
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/no está disponible/);
      // Y una salida fuera de contrato se descarta entera, sin media propuesta guardada.
      proveedor.respuesta = { ok: true, modelo: 'm', latenciaMs: 1, datos: { basura: true } };
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/esquema/);
      const ninguna = await conUsuario(leadId, (tx) => tx`
        select 1 as x from propuesta_ai where workspace_id = ${ws} and item_id = ${itemId}`);
      expect(ninguna.length).toBe(0);
    } finally {
      proveedor.respuesta = null;
      if (previa === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previa;
    }
  });

  it('la fidelidad de las citas viaja medida contra el material real del alcance', async () => {
    const panel = await panelPropuestas(leadId, ws);
    const conCitas = [...panel.pendientes, ...panel.decididas].find((p) => p.citas.length === 2);
    expect(conCitas).toBeDefined();
    // Una cita literal del material y otra inventada: la pantalla las distingue.
    expect(conCitas!.citas.map((c) => c.fiel)).toEqual([true, false]);
    expect(conCitas!.modelo).toBe(MODELO_PRIMARIO);
  });

  it('aislamiento: otro workspace no ve ni revisa las propuestas de este', async () => {
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item privado');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });
    const [wsX] = await admin`insert into workspace (nombre) values (${marca + '-X'}) returning id`;
    const [ux] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '-x@test.demo'}, 'Fisgón', 'activo') returning id`;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsX!.id as string}, ${ux!.id as string}, 'Fisgón', ${marca + '-x@test.demo'}, 'lead-boutique')`;
    try {
      const panel = await panelPropuestas(ux!.id as string, ws);
      expect(panel.pendientes.length).toBe(0);
      expect(panel.decididas.length).toBe(0);
      await expect(
        aceptarPropuesta(ux!.id as string, { workspaceId: ws, propuestaId }),
      ).rejects.toThrow(ErrorAI);
    } finally {
      await admin`delete from miembro where workspace_id = ${wsX!.id as string}`;
      await admin`delete from workspace where id = ${wsX!.id as string}`;
    }
  });

  it('una cuenta desactivada con sesión viva no lee ni decide propuestas', async () => {
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item con cuenta caída');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });
    await admin`update usuario set estado = 'inactivo' where id = ${leadId}`;
    try {
      await expect(panelPropuestas(leadId, ws)).rejects.toThrow(ErrorAutorizacion);
      await expect(
        aceptarPropuesta(leadId, { workspaceId: ws, propuestaId }),
      ).rejects.toThrow(ErrorAutorizacion);
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(ErrorAutorizacion);
    } finally {
      await admin`update usuario set estado = 'activo' where id = ${leadId}`;
    }
  });
});
