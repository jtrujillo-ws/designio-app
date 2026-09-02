import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import { costoDeUso, LIMITE_PROPUESTAS_DIA, MODELO_PRIMARIO } from '@/lib/ai/ai.degradacion';
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
  registrarConsentimiento,
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

  /** Item de bandeja pendiente (setup con la conexión admin, como el resto de la suite).
   * `tipoFuente` decide si su material es de personas: 'entrevista' exige consentimiento
   * registrado antes de cualquier procesamiento AI (RF-09.5). `contenido` se puede vaciar
   * para reproducir el item importado SOLO con la referencia al original. */
  async function nuevoItem(
    titulo: string,
    tipoFuente = 'nota',
    contenido = MATERIAL,
  ): Promise<string> {
    const [i] = await sqlAdmin()`insert into item_importacion
      (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
      values (${ws}, ${titulo}, ${contenido}, ${tipoFuente}, 'ref', ${leadId})
      returning id`;
    return i!.id as string;
  }

  const USO_CI = { entrada: 1200, salida: 300 };

  /** Respuesta del proveedor con su uso: es el único momento en que ese dato existe. */
  const RESPUESTA_CI: ResultadoProveedor = {
    ok: true,
    modelo: MODELO_PRIMARIO,
    latenciaMs: 900,
    datos: CONTENIDO_CI,
    uso: { ...USO_CI, costoUsd: costoDeUso(MODELO_PRIMARIO, USO_CI) },
  };

  /** El proveedor ATENDIÓ la llamada y se negó a producir contenido: hay `usage` y no hay
   * propuesta. Es el caso que se caía entero de la observabilidad de costos. */
  const RESPUESTA_RECHAZO: ResultadoProveedor = {
    ok: false,
    motivo: 'El proveedor AI se negó a procesar este material.',
    causa: 'rechazo-proveedor',
    modelo: MODELO_PRIMARIO,
    latenciaMs: 700,
    uso: { ...USO_CI, costoUsd: costoDeUso(MODELO_PRIMARIO, USO_CI) },
  };

  /** Fallo sin respuesta: no hay uso que registrar y el coste queda en «no se sabe», que no
   * es lo mismo que cero. */
  const RESPUESTA_CAIDO: ResultadoProveedor = {
    ok: false,
    motivo: 'El proveedor AI no está disponible.',
    causa: 'sin-respuesta',
    modelo: MODELO_PRIMARIO,
    latenciaMs: 25_000,
    uso: null,
  };

  /** Llamada al proveedor de mentira: ninguna propuesta puede existir sin su línea en el
   * libro de costos (la FK lo impone), tampoco las que fabrican los tests. Se registra
   * SIEMPRE como el lead —es andamiaje— para que cada aserción siga hablando de la política
   * de `propuesta_ai` y no de la de `llamada_ai`. */
  async function nuevaLlamada(campos: {
    capacidad: 'CI' | 'C0';
    itemId?: string | null;
    retoId?: string | null;
  }): Promise<string> {
    const [l] = await conUsuario(leadId, (tx) => tx`
      insert into llamada_ai (workspace_id, capacidad, item_id, reto_id, modelo, origen_key,
                              resultado, tokens_entrada, tokens_salida, costo_usd,
                              latencia_ms, creado_por)
      values (${ws}, ${campos.capacidad}, ${campos.itemId ?? null}, ${campos.retoId ?? null},
              ${MODELO_PRIMARIO}, 'entorno', 'salida-valida', 1200, 300,
              ${costoDeUso(MODELO_PRIMARIO, USO_CI)}, 900, ${leadId})
      returning id`);
    return l!.id as string;
  }

  /** Corre `fn` con la capacidad AI encendida y la respuesta del proveedor dada. */
  async function conProveedor<T>(respuesta: ResultadoProveedor, fn: () => Promise<T>): Promise<T> {
    const previa = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-de-prueba';
    proveedor.respuesta = respuesta;
    try {
      return await fn();
    } finally {
      proveedor.respuesta = null;
      if (previa === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previa;
    }
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
    const llamadaId = await nuevaLlamada({
      capacidad: campos.capacidad,
      itemId: campos.itemId,
      retoId: campos.retoId,
    });
    const [p] = await conUsuario(actorId, (tx) => tx`
      insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, reto_id, contenido, contenido_original,
         confianza, modelo, prompt_version, alcance_resumen, origen_key, llamada_id, creado_por)
      values (${ws}, ${campos.capacidad}, ${campos.destino}, ${campos.itemId ?? null},
              ${campos.retoId ?? null}, ${tx.json(contenido)}, ${tx.json(contenido)},
              0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'alcance de prueba',
              'entorno', ${llamadaId}, ${actorId})
      returning id`);
    return p!.id as string;
  }

  /** Un workspace propio para lo que se mide POR LISTA: cortes, orden y marcado. En el
   * compartido, los items que van dejando los demás tests entran en la misma ventana y la
   * prueba acabaría diciendo más del vecindario que de la regla. */
  async function enWorkspaceLimpio<T>(
    nombre: string,
    fn: (ctx: { ws: string; curadorId: string; servicioId: string; retoId: string }) => Promise<T>,
  ): Promise<T> {
    const admin = sqlAdmin();
    const email = `${marca}-${nombre}@test.demo`;
    const [w] = await admin`insert into workspace (nombre)
      values (${`${marca}-${nombre}`}) returning id`;
    const wsL = w!.id as string;
    const [u] = await admin`insert into usuario (email, nombre, estado)
      values (${email}, 'Curadora', 'activo') returning id`;
    const curadorId = u!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsL}, ${curadorId}, 'Curadora', ${email}, 'lead-boutique')`;
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsL}, 'Servicio', ${curadorId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
      values (${wsL}, ${svc!.id as string}, 'R-01', 'Reto', 'candidato', 'peticion-cliente',
              ${curadorId}) returning id`;
    try {
      return await fn({
        ws: wsL,
        curadorId,
        servicioId: svc!.id as string,
        retoId: r!.id as string,
      });
    } finally {
      await admin`delete from evento_dominio where workspace_id = ${wsL}`;
      await admin`delete from propuesta_ai where workspace_id = ${wsL}`;
      await admin`delete from llamada_ai where workspace_id = ${wsL}`;
      await admin`delete from reserva_ai where workspace_id = ${wsL}`;
      await admin`delete from consentimiento_item where workspace_id = ${wsL}`;
      await admin`delete from item_importacion where workspace_id = ${wsL}`;
      await admin`delete from criterio_exito where workspace_id = ${wsL}`;
      await admin`delete from checklist_item where workspace_id = ${wsL}`;
      await admin`delete from gate_instancia where workspace_id = ${wsL}`;
      await admin`delete from etapa_instancia where workspace_id = ${wsL}`;
      await admin`delete from proyecto where workspace_id = ${wsL}`;
      await admin`delete from reto where workspace_id = ${wsL}`;
      await admin`delete from servicio where workspace_id = ${wsL}`;
      await admin`delete from miembro where workspace_id = ${wsL}`;
      await admin`delete from workspace where id = ${wsL}`;
      await admin`delete from usuario where id = ${curadorId}`;
    }
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
      await admin`delete from reserva_ai where workspace_id = ${ws}`;
      await admin`delete from propuesta_ai where workspace_id = ${ws}`;
      await admin`delete from llamada_ai where workspace_id = ${ws}`;
      await admin`delete from consentimiento_item where workspace_id = ${ws}`;
      await admin`delete from item_importacion where workspace_id = ${ws}`;
      await admin`delete from criterio_exito where workspace_id = ${ws}`;
      await admin`delete from evidencia where workspace_id = ${ws}`;
      await admin`delete from fuente where workspace_id = ${ws}`;
      await admin`delete from checklist_item where workspace_id = ${ws}`;
      await admin`delete from gate_instancia where workspace_id = ${ws}`;
      await admin`delete from etapa_instancia where workspace_id = ${ws}`;
      await admin`delete from proyecto where workspace_id = ${ws}`;
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
    const llamadaId = await nuevaLlamada({ capacidad: 'CI', itemId });
    // Nacer aceptada saltaría la firma humana: la política de INSERT lo impide.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, estado, revisada_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                'm', 'v', 'entorno', ${llamadaId}, ${leadId}, 'aceptada', ${leadId})`),
    ).rejects.toThrow(/row-level security|check constraint/);
    // Y el «original» tiene que ser de verdad el original (SYS-17).
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":2}'::jsonb,
                'm', 'v', 'entorno', ${llamadaId}, ${leadId})`),
    ).rejects.toThrow(/row-level security/);
    // SYS-20: una simulación de revisor AI jamás se materializa como evidencia.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, es_simulacion)
        values (${ws}, 'C4', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                'm', 'v', 'entorno', ${llamadaId}, ${leadId}, true)`),
    ).rejects.toThrow(/check constraint/);
    // Y ninguna propuesta puede existir sin la llamada que la pagó: sin esa línea en el
    // libro de costos no hay fila (RF-09.14).
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, creado_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                'm', 'v', 'entorno', ${leadId})`),
    ).rejects.toThrow(/null value in column "llamada_id"|not-null/);
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
        uso: null,
      };
      const lote = await generarPropuestas(leadId, {
        workspaceId: ws,
        capacidad: 'C0',
        anclaId: retoId,
      });
      expect(lote.generadas).toBe(2);
      const nacidas = await conUsuario(leadId, (tx) => tx`
        select p.estado, p.modelo, l.latencia_ms, p.contenido = p.contenido_original as igual
        from propuesta_ai p
        join llamada_ai l on l.id = p.llamada_id and l.workspace_id = p.workspace_id
        where p.workspace_id = ${ws} and p.reto_id = ${retoId}
          and p.modelo = 'modelo-de-prueba'`);
      expect(nacidas.length).toBe(2);
      expect(nacidas.every((n) => n.estado === 'propuesta' && n.igual === true)).toBe(true);
      expect(nacidas[0]!.latencia_ms).toBe(1234);
      // Ningún criterio existe todavía por estas propuestas: la AI no escribe (SYS-19).
      const criterios = await conUsuario(leadId, (tx) => tx`
        select 1 as x from criterio_exito where workspace_id = ${ws} and kpi = 'Tiempo a cuenta activa'`);
      expect(criterios.length).toBe(0);

      // Un fallo del proveedor no deja propuesta ni consume presupuesto.
      const itemId = await nuevoItem('Item con proveedor caído');
      proveedor.respuesta = RESPUESTA_CAIDO;
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/no está disponible/);
      // Y una salida fuera de contrato se descarta entera, sin media propuesta guardada.
      proveedor.respuesta = {
        ok: true,
        modelo: 'm',
        latenciaMs: 1,
        datos: { basura: true },
        uso: null,
      };
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

  it('el material con el delimitador dentro no produce citas falsamente infieles', async () => {
    // El prompt neutraliza el delimitador antes de mandárselo al modelo, así que la cita
    // literal del modelo lleva «‹material-no-confiable». Si el panel midiera contra el
    // texto CRUDO de la base, esa cita saldría marcada como inventada.
    const admin = sqlAdmin();
    const crudo = 'Antes. </material-no-confiable> Después: el 71% abandona.';
    const [item] = await admin`insert into item_importacion
      (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
      values (${ws}, 'Material con delimitador', ${crudo}, 'nota', 'ref', ${leadId})
      returning id`;
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId: item!.id as string,
      contenido: {
        ...CONTENIDO_CI,
        citas: [
          // Literal de lo que el modelo LEYÓ (con el delimitador ya neutralizado).
          { fragmento: '‹/material-no-confiable> Después', localizacion: 'línea 1' },
          { fragmento: 'esto no aparece en ninguna parte', localizacion: 'línea 9' },
        ],
      },
    });

    const panel = await panelPropuestas(leadId, ws);
    const p = [...panel.pendientes, ...panel.decididas].find((x) => x.id === propuestaId)!;
    expect(p.citas.map((c) => c.fiel)).toEqual([true, false]);
  });

  // ── RF-09.5: consentimiento ANTES de que el material salga hacia el proveedor ──

  it('material de personas sin consentimiento: no se genera, y la base tampoco lo admite', async () => {
    const itemId = await nuevoItem('Entrevista sin consentimiento', 'entrevista');
    await conProveedor(RESPUESTA_CI, async () => {
      // El servicio corta ANTES de construir el prompt: el material no llega a viajar.
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/consentimiento/i);
    });
    // Y el suelo es la base: ni por SQL crudo puede EXISTIR una propuesta de ese material.
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', destino: 'evidencia', itemId }),
    ).rejects.toThrow(/consentimiento/i);
    // Un item que no es de personas no exige nada: la regla no se derrama sobre el resto.
    const nota = await nuevoItem('Nota sin personas dentro');
    await conProveedor(RESPUESTA_CI, async () => {
      const r = await generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: nota });
      expect(r.generadas).toBe(1);
    });
  });

  it('el consentimiento se registra antes, distingue el procesamiento externo y no se reescribe', async () => {
    const itemId = await nuevoItem('Entrevista con consentimiento', 'entrevista');

    // Un stakeholder no registra consentimientos (misma frontera que curar).
    await expect(
      registrarConsentimiento(stakeId, {
        workspaceId: ws,
        itemId,
        alcance: 'Grabación autorizada',
        procesamientoExterno: true,
      }),
    ).rejects.toThrow(/lead-boutique o diseñador/);

    // Autorizar la grabación NO es autorizar mandarla a un tercero: sigue bloqueada.
    const soloInterno = await nuevoItem('Entrevista solo interna', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId: soloInterno,
      alcance: 'Grabación y transcripción para uso interno',
      procesamientoExterno: false,
    });
    await conProveedor(RESPUESTA_CI, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: soloInterno }),
      ).rejects.toThrow(/consentimiento/i);
    });

    // Con el consentimiento completo, el mismo camino funciona…
    await registrarConsentimiento(disenadorId, {
      workspaceId: ws,
      itemId,
      alcance: 'Grabación, transcripción y procesamiento por proveedor AI',
      procesamientoExterno: true,
    });
    const generadas = await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    expect(generadas.generadas).toBe(1);

    // …y la evidencia materializada HEREDA lo registrado, en vez de nacer siempre en falso.
    const [propuesta] = await conUsuario(leadId, (tx) => tx`select id from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId} and estado = 'propuesta'`);
    const r = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId: propuesta!.id as string,
    });
    const [ev] = await conUsuario(leadId, (tx) => tx`select dimensiones from evidencia
      where id = ${r.objetoId}`);
    expect((ev!.dimensiones as { derechos: { consentimiento: boolean } }).derechos.consentimiento)
      .toBe(true);

    // Append-only: ningún registro se reescribe ni se borra. Lo que cambia el permiso es un
    // registro NUEVO, y ni siquiera el rol de la app puede tocar los anteriores.
    await expect(
      conUsuario(leadId, (tx) => tx`update consentimiento_item set procesamiento_externo = false
        where item_id = ${itemId}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      conUsuario(leadId, (tx) => tx`delete from consentimiento_item where item_id = ${itemId}`),
    ).rejects.toThrow(/permission denied/);
    // Y la posición en la bitácora la escribe solo el guard: si la app pudiera fijarla,
    // podría colar un registro «vigente» que no es el último — la reescritura prohibida
    // por la puerta de atrás.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into consentimiento_item
        (item_id, workspace_id, version, alcance, procesamiento_externo, registrado_por)
        values (${itemId}, ${ws}, 99, 'versión forjada', true, ${leadId})`),
    ).rejects.toThrow(/permission denied/);

    // Y el registro deja rastro auditable de qué se autorizó (RF-09.13).
    const [evento] = await sqlAdmin()`select actor_id, payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'ConsentimientoRegistrado'
        and payload->>'itemId' = ${itemId}`;
    expect(evento!.actor_id).toBe(disenadorId);
    expect((evento!.payload as { procesamientoExterno: boolean }).procesamientoExterno).toBe(true);
  });

  it('la bitácora avanza: un permiso posterior desbloquea y una revocación vuelve a bloquear', async () => {
    const itemId = await nuevoItem('Entrevista que cambia de permiso', 'entrevista');

    // 1) La persona autoriza SOLO el uso interno. Es una entrada legítima —y la que dejaba
    // el item bloqueado PARA SIEMPRE: el append-only impedía corregir el registro y la
    // clave por item impedía añadir el permiso que llegara después.
    const interno = await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Grabación y transcripción para uso interno del equipo',
      procesamientoExterno: false,
    });
    expect(interno.version).toBe(1);
    expect(interno.autorizaExterno).toBe(false);
    await conProveedor(RESPUESTA_CI, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/consentimiento/i);
    });

    // 2) Más tarde autoriza el procesamiento externo: un registro NUEVO, nunca un UPDATE
    // sobre el anterior. Al ser el vigente, desbloquea.
    const externo = await registrarConsentimiento(disenadorId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza además el procesamiento por el proveedor AI (correo del 12/07)',
      procesamientoExterno: true,
    });
    expect(externo.version).toBe(2);
    const generadas = await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    expect(generadas.generadas).toBe(1);

    // 3) Y una revocación (RF-09.4) es otro registro más: sin tocar los anteriores, vuelve
    // a bloquear porque el vigente es el último.
    const revocacion = await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'La persona revoca el permiso de procesamiento externo (llamada del 20/07)',
      procesamientoExterno: false,
    });
    expect(revocacion.version).toBe(3);
    await conProveedor(RESPUESTA_CI, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/consentimiento/i);
    });
    // Y el panel vuelve a marcarlo, igual que si nunca se hubiera registrado nada (la
    // propuesta que quedó pendiente se rechaza: su material dejó de poder procesarse).
    const [viva] = await conUsuario(leadId, (tx) => tx`select id from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId} and estado = 'propuesta'`);
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId: viva!.id as string });
    const panel = await panelPropuestas(leadId, ws);
    expect(panel.itemsPendientes.find((i) => i.id === itemId)?.consentimientoPendiente).toBe(true);
    // También en la base: el guard lee lo mismo que el servicio, no «si existe algún
    // registro» — que con la revocación seguiría diciendo que sí.
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', destino: 'evidencia', itemId }),
    ).rejects.toThrow(/consentimiento/i);

    // Los tres hechos siguen ahí, en orden y con su autor: la bitácora no pierde historia
    // (y el evento de cada registro dice qué versión es).
    const bitacora = await conUsuario(leadId, (tx) => tx`
      select version, procesamiento_externo, registrado_por from consentimiento_item
      where item_id = ${itemId} and workspace_id = ${ws} order by version`);
    expect(bitacora.map((b) => b.version)).toEqual([1, 2, 3]);
    expect(bitacora.map((b) => b.procesamiento_externo)).toEqual([false, true, false]);
    expect(bitacora[1]!.registrado_por).toBe(disenadorId);
    const eventos = await sqlAdmin()`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'ConsentimientoRegistrado'
        and payload->>'itemId' = ${itemId} order by payload->>'version'`;
    expect(eventos.map((e) => (e.payload as { version: number }).version)).toEqual([1, 2, 3]);
  });

  it('un item importado solo con la referencia no llega al proveedor: no hay nada que citar', async () => {
    const soloRef = await nuevoItem('Informe que vive en otra parte', 'documento', '');
    await conProveedor(RESPUESTA_CI, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: soloRef }),
      ).rejects.toThrow(/no hay material que citar/i);
    });
    // Se corta ANTES de gastar: ni llamada al proveedor ni hueco de presupuesto apartado.
    const llamadas = await conUsuario(leadId, (tx) => tx`select 1 as x from llamada_ai
      where workspace_id = ${ws} and item_id = ${soloRef}`);
    expect(llamadas.length).toBe(0);
    const reservas = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
      where workspace_id = ${ws} and item_id = ${soloRef}`);
    expect(reservas.length).toBe(0);

    // El suelo es la base: ni por SQL crudo puede EXISTIR una extracción de un item del que
    // no hay nada que extraer — la cita literal que el contrato exige sería inventada.
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', destino: 'evidencia', itemId: soloRef }),
    ).rejects.toThrow(/material que citar/i);

    // Un cuerpo de dos letras es lo mismo que ninguno: el suelo es «hay algo que citar».
    const casiVacio = await nuevoItem('Item con dos letras', 'nota', 'ok');
    await conProveedor(RESPUESTA_CI, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: casiVacio }),
      ).rejects.toThrow(/no hay material que citar/i);
    });
    // Y la regla no se derrama: un item con material de verdad sigue generando.
    const conTexto = await nuevoItem('Nota con material de sobra');
    const r = await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: conTexto }),
    );
    expect(r.generadas).toBe(1);
  });

  it('el panel marca los items que esperan consentimiento en vez de esconderlos', async () => {
    const itemId = await nuevoItem('Entrevista por marcar', 'entrevista');
    const notaId = await nuevoItem('Nota que no espera nada');
    const panel = await panelPropuestas(leadId, ws);
    expect(panel.itemsPendientes.find((i) => i.id === itemId)?.consentimientoPendiente).toBe(true);
    // Y no se derrama: un item que no es de personas se ofrece sin marca.
    expect(panel.itemsPendientes.find((i) => i.id === notaId)?.consentimientoPendiente).toBe(false);
  });

  // ── RF-09.12: el presupuesto se aparta ANTES de llamar, y una sola propuesta por item ──

  it('la reserva se consume al persistir y se libera si la generación no llega a nacer', async () => {
    const itemId = await nuevoItem('Item con reserva');
    await conProveedor(RESPUESTA_CAIDO, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/no está disponible/);
    });
    // Una llamada fallida no consume presupuesto NI deja el hueco bloqueado.
    const tras = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
      where workspace_id = ${ws}`);
    expect(tras.length).toBe(0);

    // Y una que sí nace consume su reserva en la misma transacción que escribe.
    await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    const despues = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
      where workspace_id = ${ws}`);
    expect(despues.length).toBe(0);
  });

  it('las generaciones en curso ocupan presupuesto: N curadores a la vez no lo rebasan', async () => {
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item con el presupuesto lleno');
    // Ocho generaciones de criterios EN CURSO (8 × 8 = 64 huecos apartados) agotan el
    // tope de hoy aunque todavía no haya ninguna propuesta persistida: es exactamente el
    // estado que el chequeo viejo no veía.
    for (let i = 0; i < 8; i += 1) {
      await admin`insert into reserva_ai (workspace_id, capacidad, unidades, creado_por)
        values (${ws}, 'C0', 8, ${leadId})`;
    }
    try {
      await conProveedor(RESPUESTA_CI, async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        ).rejects.toThrow(/presupuesto/i);
      });
      // El panel sigue contando lo REALMENTE gastado hoy, no las reservas en vuelo.
      const panel = await panelPropuestas(leadId, ws);
      expect(panel.ai.propuestasHoy).toBeLessThan(LIMITE_PROPUESTAS_DIA);
    } finally {
      await admin`delete from reserva_ai where workspace_id = ${ws}`;
    }
    // Liberadas las reservas, el mismo item vuelve a poder generarse.
    const r = await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    expect(r.generadas).toBe(1);
  });

  it('una reserva caducada no bloquea el item para siempre: se recoge y se sigue', async () => {
    const itemId = await nuevoItem('Item con reserva zombi');
    await sqlAdmin()`insert into reserva_ai
      (workspace_id, capacidad, item_id, unidades, creado_por, creado_en)
      values (${ws}, 'CI', ${itemId}, 1, ${leadId}, now() - interval '10 minutes')`;
    const r = await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    expect(r.generadas).toBe(1);
    const quedan = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
      where workspace_id = ${ws}`);
    expect(quedan.length).toBe(0);
  });

  it('dos curadores a la vez sobre el mismo item dejan UNA sola propuesta pendiente', async () => {
    const itemId = await nuevoItem('Item disputado');
    const resultados = await conProveedor(RESPUESTA_CI, () =>
      Promise.allSettled([
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        generarPropuestas(disenadorId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ]),
    );
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const perdedora = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(perdedora.reason).toBeInstanceOf(ErrorAI);

    const pendientes = await conUsuario(leadId, (tx) => tx`select 1 as x from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId} and estado = 'propuesta'`);
    expect(pendientes.length).toBe(1);

    // El suelo es el índice único parcial: ni por SQL crudo caben dos pendientes.
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', destino: 'evidencia', itemId }),
    ).rejects.toThrow(/duplicate key|unique/i);

    // Decidida la primera, el hueco se libera: el índice solo cubre las pendientes.
    const [p] = await conUsuario(leadId, (tx) => tx`select id from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId} and estado = 'propuesta'`);
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId: p!.id as string });
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', destino: 'evidencia', itemId }),
    ).resolves.toBeTruthy();
  });

  // ── El uso de la llamada llega hasta el lineage (RF-09.14) ──

  it('el uso y el coste de la llamada se persisten y llegan al panel', async () => {
    const itemId = await nuevoItem('Item con coste');
    await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    const [fila] = await conUsuario(leadId, (tx) => tx`
      select p.id, l.id as llamada_id, l.tokens_entrada, l.tokens_salida, l.costo_usd,
             l.resultado, l.latencia_ms, l.modelo
      from propuesta_ai p
      join llamada_ai l on l.id = p.llamada_id and l.workspace_id = p.workspace_id
      where p.workspace_id = ${ws} and p.item_id = ${itemId}`);
    expect(fila!.tokens_entrada).toBe(1200);
    expect(fila!.tokens_salida).toBe(300);
    expect(Number(fila!.costo_usd)).toBeCloseTo(costoDeUso(MODELO_PRIMARIO, USO_CI)!, 6);
    expect(fila!.resultado).toBe('salida-valida');
    expect(fila!.latencia_ms).toBe(900);
    expect(fila!.modelo).toBe(MODELO_PRIMARIO);

    const panel = await panelPropuestas(leadId, ws);
    const enPanel = panel.pendientes.find((p) => p.id === (fila!.id as string));
    expect(enPanel!.costoUsd).toBeCloseTo(Number(fila!.costo_usd), 6);
    expect(enPanel!.latenciaMs).toBe(900);

    // El libro no tiene superficie de escritura: lo que costó una llamada ya hecha no se
    // reescribe ni se borra desde la app.
    await expect(
      conUsuario(leadId, (tx) => tx`update llamada_ai set costo_usd = 0
        where id = ${fila!.llamada_id as string}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      conUsuario(leadId, (tx) => tx`delete from llamada_ai
        where id = ${fila!.llamada_id as string}`),
    ).rejects.toThrow(/permission denied/);
    // Y una propuesta no puede reapuntar a otra llamada (el gasto no se muda de sitio).
    await expect(
      conUsuario(leadId, (tx) => tx`update propuesta_ai set llamada_id = gen_random_uuid()
        where id = ${fila!.id as string}`),
    ).rejects.toThrow(/permission denied/);

    // Un lote nacido de UNA llamada cuelga de UNA fila de gasto: el coste del workspace es
    // la suma del libro, sin `distinct` ni prorrateos.
    await conProveedor(
      {
        ok: true,
        modelo: MODELO_PRIMARIO,
        latenciaMs: 10,
        datos: { criterios: [CONTENIDO_C0, { ...CONTENIDO_C0, kpi: 'KPI del lote' }] },
        uso: { entrada: 500, salida: 100, costoUsd: 0.005 },
      },
      () => generarPropuestas(leadId, { workspaceId: ws, capacidad: 'C0', anclaId: retoId }),
    );
    const lote = await conUsuario(leadId, (tx) => tx`select distinct p.llamada_id
      from propuesta_ai p
      join llamada_ai l on l.id = p.llamada_id and l.workspace_id = p.workspace_id
      where p.workspace_id = ${ws} and p.reto_id = ${retoId}
        and p.contenido->>'kpi' in (${CONTENIDO_C0.kpi}, 'KPI del lote')
        and l.costo_usd = 0.005`);
    expect(lote.length).toBe(1);
  });

  it('una llamada sin propuesta también se anota: la negativa del proveedor no es gratis', async () => {
    const itemId = await nuevoItem('Item que el proveedor rechaza');
    await conProveedor(RESPUESTA_RECHAZO, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/se negó a procesar/);
    });

    // La llamada ocurrió, devolvió su `usage` y se pagó: queda en el libro aunque no haya
    // ninguna propuesta que la delate. Antes desaparecía entera.
    const [llamada] = await conUsuario(leadId, (tx) => tx`
      select resultado, motivo, tokens_entrada, tokens_salida, costo_usd, latencia_ms, id
      from llamada_ai where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(llamada!.resultado).toBe('rechazo-proveedor');
    expect(llamada!.motivo).toMatch(/se negó/);
    expect(llamada!.tokens_entrada).toBe(1200);
    expect(Number(llamada!.costo_usd)).toBeCloseTo(costoDeUso(MODELO_PRIMARIO, USO_CI)!, 6);
    expect(llamada!.latencia_ms).toBe(700);

    // Sin propuesta y sin reserva colgando: el hueco del presupuesto vuelve.
    const propuestas = await conUsuario(leadId, (tx) => tx`select 1 as x from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(propuestas.length).toBe(0);
    const reservas = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(reservas.length).toBe(0);

    // Y deja evento auditable: dinero gastado sin objeto que lo justifique (RF-09.13).
    const [evento] = await sqlAdmin()`select actor_id, payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'LlamadaAISinPropuesta'
        and payload->>'llamadaId' = ${llamada!.id as string}`;
    expect(evento!.actor_id).toBe(leadId);
    expect((evento!.payload as { resultado: string }).resultado).toBe('rechazo-proveedor');

    // Una salida fuera de contrato es el mismo caso: respondió, se pagó, no sirve.
    const otro = await nuevoItem('Item con salida fuera de contrato');
    await conProveedor(
      { ok: true, modelo: MODELO_PRIMARIO, latenciaMs: 40, datos: { basura: true },
        uso: { entrada: 90, salida: 10, costoUsd: 0.001 } },
      async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: otro }),
        ).rejects.toThrow(/esquema/);
      },
    );
    const [fallida] = await conUsuario(leadId, (tx) => tx`select resultado, costo_usd
      from llamada_ai where workspace_id = ${ws} and item_id = ${otro}`);
    expect(fallida!.resultado).toBe('fuera-de-contrato');
    expect(Number(fallida!.costo_usd)).toBeCloseTo(0.001, 6);

    // Un fallo SIN respuesta se anota igual, con el coste en null: «no se sabe» no es
    // «salió gratis», y un cero ahí falsearía el reporte.
    const caido = await nuevoItem('Item con proveedor mudo');
    await conProveedor(RESPUESTA_CAIDO, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: caido }),
      ).rejects.toThrow(/no está disponible/);
    });
    const [muda] = await conUsuario(leadId, (tx) => tx`select resultado, costo_usd,
        tokens_entrada from llamada_ai where workspace_id = ${ws} and item_id = ${caido}`);
    expect(muda!.resultado).toBe('sin-respuesta');
    expect(muda!.costo_usd).toBeNull();
    expect(muda!.tokens_entrada).toBeNull();
  });

  // ── El panel pagina pendientes y decididas por separado ──

  it('una propuesta pendiente antigua no queda enterrada bajo las decisiones nuevas', async () => {
    // En su propio workspace: lo que se prueba es el CORTE de las listas, y para eso hace
    // falta pasarse de largo sin ensuciar las cuentas de los demás tests.
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca + '-pag'}) returning id`;
    const wsP = w!.id as string;
    const [u] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '-pag@test.demo'}, 'Curadora', 'activo') returning id`;
    const curadorId = u!.id as string;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsP}, ${curadorId}, 'Curadora', ${marca + '-pag@test.demo'}, 'lead-boutique')`;
    const [svc] = await admin`insert into servicio (workspace_id, nombre, creado_por)
      values (${wsP}, 'Servicio', ${curadorId}) returning id`;
    const [r] = await admin`insert into reto
      (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
      values (${wsP}, ${svc!.id as string}, 'R-01', 'Reto', 'candidato', 'peticion-cliente',
              ${curadorId}) returning id`;
    const retoP = r!.id as string;

    /** Propuestas C0 en bloque, con `creado_en` explícito para poder ordenar la historia.
     * Todas cuelgan de una misma llamada: el libro de costos no admite propuestas huérfanas
     * (FK), y aquí lo que se mide es el corte de las listas, no el gasto. */
    async function sembrar(n: number, desdeMinutos: number): Promise<string[]> {
      const [llamada] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsP}, 'C0', ${retoP}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const filas = await admin`insert into propuesta_ai
        (workspace_id, capacidad, destino, reto_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, creado_en)
        select ${wsP}, 'C0', 'criterio-exito', ${retoP}, ${admin.json(CONTENIDO_C0)},
               ${admin.json(CONTENIDO_C0)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'entorno',
               ${llamada!.id as string}, ${curadorId},
               now() - make_interval(mins => ${desdeMinutos} - g)
        from generate_series(1, ${n}) as g
        returning id`;
      return filas.map((f) => f.id as string);
    }

    try {
      // La más ANTIGUA de todas, pendiente, y 100 pendientes más nuevas por encima.
      const [viejaId] = await sembrar(1, 5000);
      await sembrar(100, 4000);
      // Y 51 decisiones, todas más nuevas que la pendiente antigua.
      const decididas = await sembrar(51, 1000);
      await admin`update propuesta_ai set estado = 'rechazada', revisada_por = ${curadorId},
          revisada_en = now()
        where id in ${admin(decididas)}`;

      const panel = await panelPropuestas(curadorId, wsP);
      // Con un solo corte de 150 antes de partir por estado, las dos filas más antiguas
      // —pendientes— se caían de la lista: invisibles y, por el `not exists` de la
      // generación, sin ninguna otra forma de llegar a ellas.
      expect(panel.pendientes.length).toBe(100);
      expect(panel.pendientes.some((p) => p.id === viejaId)).toBe(true);
      expect(panel.pendientes[0]!.id).toBe(viejaId);
      expect(panel.hayMasPendientes).toBe(true);
      // Las decididas tienen su propio corte y su propio aviso, sin robarle sitio a nadie.
      expect(panel.decididas.length).toBe(50);
      expect(panel.hayMasDecididas).toBe(true);
      expect(panel.decididas.every((p) => p.estado !== 'propuesta')).toBe(true);
    } finally {
      await admin`delete from evento_dominio where workspace_id = ${wsP}`;
      await admin`delete from propuesta_ai where workspace_id = ${wsP}`;
      await admin`delete from llamada_ai where workspace_id = ${wsP}`;
      await admin`delete from reto where workspace_id = ${wsP}`;
      await admin`delete from servicio where workspace_id = ${wsP}`;
      await admin`delete from miembro where workspace_id = ${wsP}`;
      await admin`delete from workspace where id = ${wsP}`;
      await admin`delete from usuario where id = ${curadorId}`;
    }
  });

  // ── Las anclas ofrecidas a la generación: orden, corte y marcas ──

  it('las anclas se ofrecen en FIFO, el recorte se avisa y la ventana avanza sola', async () => {
    await enWorkspaceLimpio('anclas', async ({ ws: wsA, curadorId, servicioId }) => {
      const admin = sqlAdmin();
      // 60 items pendientes y elegibles: más de los que caben en el selector, que es la
      // ÚNICA puerta a la generación.
      await admin`insert into item_importacion
        (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por, creado_en)
        select ${wsA}, 'Item ' || lpad(g::text, 2, '0'), ${MATERIAL}, 'nota', 'ref',
               ${curadorId}, now() - make_interval(mins => 200 - g)
        from generate_series(1, 60) as g`;
      // Y 51 retos con criterios abiertos, por lo mismo.
      await admin`insert into reto
        (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
        select ${wsA}, ${servicioId}, 'R-' || lpad((g + 1)::text, 3, '0'), 'Reto ' || g,
               'candidato', 'peticion-cliente', ${curadorId}
        from generate_series(1, 51) as g`;

      const panel = await panelPropuestas(curadorId, wsA);
      expect(panel.itemsPendientes.length).toBe(50);
      expect(panel.hayMasItems).toBe(true);
      expect(panel.retosAbiertos.length).toBe(50);
      expect(panel.hayMasRetos).toBe(true);
      // El MÁS ANTIGUO encabeza la lista. Con el orden inverso, los items viejos caían
      // fuera del corte y ninguna acción del producto volvía a acercarlos: seguían
      // pendientes y elegibles, pero imposibles de elegir.
      expect(panel.itemsPendientes[0]!.titulo).toBe('Item 01');
      expect(panel.itemsPendientes.at(-1)!.titulo).toBe('Item 50');
      expect(panel.itemsPendientes.some((i) => i.titulo === 'Item 60')).toBe(false);

      // Y la ventana avanza al drenar la cabeza: curar los diez primeros a mano hace
      // entrar solos a los que faltaban. Eso es lo que convierte el corte en una ventana
      // y no en un agujero.
      await admin`update item_importacion
        set estado = 'rechazado', decidido_por = ${curadorId}, decidido_en = now()
        where workspace_id = ${wsA} and titulo <= 'Item 10'`;
      const despues = await panelPropuestas(curadorId, wsA);
      expect(despues.itemsPendientes[0]!.titulo).toBe('Item 11');
      expect(despues.itemsPendientes.some((i) => i.titulo === 'Item 60')).toBe(true);
      expect(despues.hayMasItems).toBe(false);
    });
  });

  it('el selector marca los items sin material en vez de esconderlos', async () => {
    await enWorkspaceLimpio('material', async ({ ws: wsM, curadorId }) => {
      const admin = sqlAdmin();
      const [soloRef] = await admin`insert into item_importacion
        (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
        values (${wsM}, 'Solo referencia', '', 'documento', 'https://ejemplo.test/informe',
                ${curadorId}) returning id`;
      const [conTexto] = await admin`insert into item_importacion
        (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
        values (${wsM}, 'Con material', ${MATERIAL}, 'nota', 'ref', ${curadorId}) returning id`;

      const panel = await panelPropuestas(curadorId, wsM);
      const marcado = panel.itemsPendientes.find((i) => i.id === (soloRef!.id as string));
      // Se ofrece MARCADO: la pantalla explica que no hay texto que citar y por dónde
      // sigue el trabajo (la bandeja), en vez de esconder el item sin decir por qué.
      expect(marcado?.sinMaterial).toBe(true);
      expect(
        panel.itemsPendientes.find((i) => i.id === (conTexto!.id as string))?.sinMaterial,
      ).toBe(false);
    });
  });

  it('un G0 aprobado después de generar deja la propuesta C0 obsoleta, y el panel lo dice', async () => {
    await enWorkspaceLimpio('congelado', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const generadas = await conProveedor(
        {
          ok: true,
          modelo: MODELO_PRIMARIO,
          latenciaMs: 120,
          datos: { criterios: [CONTENIDO_C0, { ...CONTENIDO_C0, kpi: 'Segundo KPI' }] },
          uso: null,
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C0', anclaId: retoC }),
      );
      expect(generadas.generadas).toBe(2);

      const antes = await panelPropuestas(curadorId, wsC);
      expect(antes.pendientes.every((p) => p.anclaDisponible)).toBe(true);
      expect(antes.retosAbiertos.some((r) => r.id === retoC)).toBe(true);

      // Entre generar y revisar, alguien aprueba el G0: ese gate certificó unos criterios
      // y los congeló (SYS-22). El insert directo del gate ya aprobado es el atajo del
      // test; el efecto sobre los criterios es el mismo que por la app.
      const [proyecto] = await admin`insert into proyecto
        (workspace_id, reto_id, codigo, titulo, creado_por)
        values (${wsC}, ${retoC}, 'P-01', 'Proyecto', ${curadorId}) returning id`;
      await admin`insert into etapa_instancia
        (workspace_id, proyecto_id, numero, nombre, estado)
        values (${wsC}, ${proyecto!.id as string}, 0, 'Definición del objeto y del reto',
                'completada')`;
      await admin`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
        values (${wsC}, ${proyecto!.id as string}, 0, 'sponsor', 'aprobado', ${curadorId},
                now())`;

      const despues = await panelPropuestas(curadorId, wsC);
      const p = despues.pendientes[0]!;
      // El fallo estaba aquí: con la disponibilidad derivada solo del item, toda propuesta
      // C0 salía disponible y el panel habilitaba «aceptar» y «corregir y aceptar» sobre
      // algo que la base rechaza siempre.
      expect(despues.pendientes.every((x) => x.anclaDisponible === false)).toBe(true);
      // Y el reto deja de ofrecerse como ancla de generación, por el mismo predicado.
      expect(despues.retosAbiertos.some((r) => r.id === retoC)).toBe(false);

      // Lo que decía la pantalla se confirma contra la base…
      await expect(
        aceptarPropuesta(curadorId, { workspaceId: wsC, propuestaId: p.id }),
      ).rejects.toThrow(/congelados/i);
      // …y rechazar, que es lo único que queda, sigue funcionando.
      await rechazarPropuesta(curadorId, { workspaceId: wsC, propuestaId: p.id });

      // Y el congelado es EXACTAMENTE el de la base, excepción incluida: reabrir la etapa 0
      // (RF-04.9) vuelve a admitir criterios sin desaprobar el gate (SYS-10). Con el
      // predicado viejo copiado a mano, el panel escondía el reto y la generación se negaba
      // justo en el caso para el que existe la reapertura.
      await admin`update etapa_instancia set estado = 'en-curso'
        where workspace_id = ${wsC} and proyecto_id = ${proyecto!.id as string} and numero = 0`;
      const reabierto = await panelPropuestas(curadorId, wsC);
      expect(reabierto.retosAbiertos.some((r) => r.id === retoC)).toBe(true);
      const viva = reabierto.pendientes[0]!;
      expect(viva.anclaDisponible).toBe(true);
      const aceptada = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: viva.id,
      });
      expect(aceptada.estado).toBe('aceptada');
    });
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
