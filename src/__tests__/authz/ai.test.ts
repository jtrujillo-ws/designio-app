import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  costoDeUso,
  LIMITE_LLAMADAS_DIA,
  MODELO_FALLBACK,
  MODELO_PRIMARIO,
} from '@/lib/ai/ai.degradacion';
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
import type { IntentoProveedor, ResultadoProveedor } from '@/lib/ai/proveedor.server';
import { describeAuthz } from './helpers';

/** El proveedor es el ÚNICO tercero del pipeline y se sustituye para poder recorrer la
 * generación entera —incluido el lote de propuestas y su lineage— sin red. La resolución
 * de credenciales y la degradación siguen siendo las reales.
 *
 * `duranteLlamada` es el hueco de tiempo en el que el material está EN VUELO: lo que ocurra
 * ahí (una revocación de consentimiento, por ejemplo) pasa con la llamada ya despachada, que
 * es justo el caso que ningún candado puede cubrir y que hay que poder probar. */
const proveedor = vi.hoisted(() => ({
  respuesta: null as ResultadoProveedor | null,
  duranteLlamada: null as (() => Promise<void>) | null,
}));
vi.mock('@/lib/ai/proveedor.server', async (original) => {
  const real = await original<typeof import('@/lib/ai/proveedor.server')>();
  return {
    ...real,
    generarConProveedor: async () => {
      if (proveedor.duranteLlamada) await proveedor.duranteLlamada();
      return proveedor.respuesta;
    },
  };
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
  const USO_CI_COMPLETO = { ...USO_CI, costoUsd: costoDeUso(MODELO_PRIMARIO, USO_CI) };

  /** Un intento contra el proveedor tal como lo devuelve el adaptador: una llamada real, con
   * su modelo, su desenlace, su latencia y su uso. */
  function intento(campos: Partial<IntentoProveedor> = {}): IntentoProveedor {
    return {
      modelo: MODELO_PRIMARIO,
      resultado: 'salida-valida',
      motivo: '',
      latenciaMs: 900,
      uso: USO_CI_COMPLETO,
      ...campos,
    };
  }

  /** Respuesta del proveedor con su uso: es el único momento en que ese dato existe. */
  const RESPUESTA_CI: ResultadoProveedor = {
    ok: true,
    datos: CONTENIDO_CI,
    intentos: [intento()],
  };

  /** El proveedor ATENDIÓ la llamada y se negó a producir contenido: hay `usage` y no hay
   * propuesta. Es el caso que se caía entero de la observabilidad de costos. */
  const RESPUESTA_RECHAZO: ResultadoProveedor = {
    ok: false,
    motivo: 'El proveedor AI se negó a procesar este material.',
    intentos: [
      intento({
        resultado: 'rechazo-proveedor',
        motivo: 'El proveedor AI se negó a procesar este material.',
        latenciaMs: 700,
      }),
    ],
  };

  /** Fallo sin respuesta: no hay uso que registrar y el coste queda en «no se sabe», que no
   * es lo mismo que cero. */
  const RESPUESTA_CAIDO: ResultadoProveedor = {
    ok: false,
    motivo: 'El proveedor AI no está disponible.',
    intentos: [
      intento({
        resultado: 'sin-respuesta',
        motivo: 'El proveedor AI no está disponible.',
        latenciaMs: 25_000,
        uso: null,
      }),
    ],
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

  /** Llamadas de relleno para dejar el presupuesto del workspace con `huecos` libres. Se
   * rellena con LLAMADAS ATENDIDAS porque es lo que el tope cuenta desde que acota el gasto
   * y no la producción; el modelo las marca para poder retirarlas después sin tocar las
   * llamadas de verdad que dejaron los otros tests. */
  const MODELO_RELLENO = 'modelo-de-relleno';

  async function llenarPresupuesto(huecos: number): Promise<void> {
    const admin = sqlAdmin();
    const [fila] = await admin`select count(*)::int as n from llamada_ai
      where workspace_id = ${ws} and creado_en >= date_trunc('day', now())
        and resultado <> 'sin-respuesta'`;
    const faltan = Math.max(0, LIMITE_LLAMADAS_DIA - (fila!.n as number) - huecos);
    if (faltan > 0) {
      await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        select ${ws}, 'C0', ${retoId}, ${MODELO_RELLENO}, 'entorno', 'salida-valida', ${leadId}
        from generate_series(1, ${faltan})`;
    }
  }

  async function vaciarRelleno(): Promise<void> {
    await sqlAdmin()`delete from llamada_ai
      where workspace_id = ${ws} and modelo = ${MODELO_RELLENO}`;
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
      // El registry cuelga del reto y hay pruebas que lo firman para congelar sus
      // criterios; sin esta línea la limpieza muere en el `delete from reto`.
      await admin`delete from entrada_kpi where workspace_id = ${wsL}`;
      await admin`delete from metric_registry where workspace_id = ${wsL}`;
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
                ${MODELO_PRIMARIO}, 'v', 'entorno', ${llamadaId}, ${leadId}, 'aceptada',
                ${leadId})`),
    ).rejects.toThrow(/row-level security|check constraint/);
    // Y el «original» tiene que ser de verdad el original (SYS-17).
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":2}'::jsonb,
                ${MODELO_PRIMARIO}, 'v', 'entorno', ${llamadaId}, ${leadId})`),
    ).rejects.toThrow(/row-level security/);
    // SYS-20: una simulación de revisor AI jamás se materializa como evidencia.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, es_simulacion)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                ${MODELO_PRIMARIO}, 'v', 'entorno', ${llamadaId}, ${leadId}, true)`),
    ).rejects.toThrow(/check constraint/);
    // Y ninguna propuesta puede existir sin la llamada que la pagó: sin esa línea en el
    // libro de costos no hay fila (RF-09.14). Habla primero el guard —que exige además que
    // sea LA llamada que la produjo— y detrás quedaría el NOT NULL de la columna.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, creado_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                ${MODELO_PRIMARIO}, 'v', 'entorno', ${leadId})`),
    ).rejects.toThrow(/la llamada que la produjo|null value in column "llamada_id"/);
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

  it('corregir no reescribe las citas: el testimonio del modelo no se maquilla', async () => {
    const itemId = await nuevoItem('Item con citas que alguien quiere arreglar');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });

    // La cita inventada de CONTENIDO_CI cambiada por una literal del material: la propuesta
    // quedaría impecable y la métrica de grounding, limpia. El formulario del panel reenvía
    // las originales, pero eso era una convención de una pantalla — cualquier cliente que
    // hable con la server function podía mandar otras.
    await expect(
      aceptarPropuesta(leadId, {
        workspaceId: ws,
        propuestaId,
        correccion: {
          ...CONTENIDO_CI,
          citas: [
            { fragmento: 'El 71% de los abandonos', localizacion: 'párrafo 1' },
            { fragmento: 'la carga del documento de identidad', localizacion: 'párrafo 1' },
          ],
        },
      }),
    ).rejects.toThrow(/citas/i);

    // Quitar una cita incómoda tampoco es corregir: la señal desaparecería igual.
    await expect(
      aceptarPropuesta(leadId, {
        workspaceId: ws,
        propuestaId,
        correccion: { ...CONTENIDO_CI, citas: [CONTENIDO_CI.citas[0]!] },
      }),
    ).rejects.toThrow(/citas/i);

    // El suelo es el guard: por SQL crudo tampoco.
    await expect(
      conUsuario(leadId, (tx) => tx`update propuesta_ai
        set estado = 'corregida', revisada_por = ${leadId},
            contenido = jsonb_set(contenido, '{citas}', ${tx.json([
              { fragmento: 'El 71% de los abandonos', localizacion: 'párrafo 1' },
            ])}::jsonb)
        where id = ${propuestaId}`),
    ).rejects.toThrow(/citas/i);

    // Y corregir lo que SÍ se corrige sigue funcionando, con sus citas intactas.
    const r = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId,
      correccion: { ...CONTENIDO_CI, titulo: 'Título corregido, citas intactas' },
    });
    expect(r.estado).toBe('corregida');
    const panel = await panelPropuestas(leadId, ws);
    const decidida = panel.decididas.find((x) => x.id === propuestaId)!;
    expect(decidida.citas.map((c) => c.fragmento)).toEqual(
      CONTENIDO_CI.citas.map((c) => c.fragmento),
    );
    // La cita inventada sigue marcada como no fiel: la señal sobrevive a la corrección.
    expect(decidida.citas.map((c) => c.fiel)).toEqual([true, false]);
  });

  it('una propuesta cuelga de la llamada que la produjo, no de cualquiera', async () => {
    const itemId = await nuevoItem('Item con llamadas cruzadas');
    // Una llamada de OTRA capacidad y otra ancla: la FK la aceptaba (existe y es del
    // workspace) y el panel le habría atribuido su coste y su latencia a esta propuesta.
    const llamadaC0 = await nuevaLlamada({ capacidad: 'C0', retoId });
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, ${tx.json(CONTENIDO_CI)},
                ${tx.json(CONTENIDO_CI)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'entorno',
                ${llamadaC0}, ${leadId})`),
    ).rejects.toThrow(/la llamada que la produjo/i);

    // Y una llamada que no produjo contenido utilizable tampoco vale como origen: colgar
    // una propuesta de una negativa del proveedor sería contabilidad falsa en las dos
    // direcciones (esa llamada no dio nada, y esta propuesta salió de otra parte).
    const [rechazo] = await conUsuario(leadId, (tx) => tx`insert into llamada_ai
      (workspace_id, capacidad, item_id, modelo, origen_key, resultado, motivo, creado_por)
      values (${ws}, 'CI', ${itemId}, ${MODELO_PRIMARIO}, 'entorno', 'rechazo-proveedor',
              'el proveedor se negó', ${leadId})
      returning id`);
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, ${tx.json(CONTENIDO_CI)},
                ${tx.json(CONTENIDO_CI)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'entorno',
                ${rechazo!.id as string}, ${leadId})`),
    ).rejects.toThrow(/la llamada que la produjo/i);

    // Con la llamada correcta —misma capacidad, misma ancla, mismo modelo, misma
    // credencial y con salida válida— la propuesta nace sin problema.
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', destino: 'evidencia', itemId }),
    ).resolves.toBeTruthy();
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

    // Apuntar a la evidencia que YA materializó otra propuesta: la reclama el índice único
    // antes de que hable ningún guard. Un objeto materializado cuelga de una sola propuesta,
    // porque si colgara de dos una de las dos estaría mintiendo sobre quién lo produjo.
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
    ).rejects.toThrow(/propuesta_ai_evidencia_idx/);

    // Y con una evidencia RECIÉN creada, sin dueño y en esta misma transacción —o sea
    // pasando el índice único y la procedencia—, lo que queda en pie es el sello del item:
    // aceptar una extracción sella su item de la bandeja con ESA evidencia (SYS-16).
    await expect(
      conUsuario(leadId, async (tx) => {
        const [f] = await tx`insert into fuente
          (workspace_id, tipo, titulo, referencia, creado_por)
          values (${ws}, 'documento', 'Fuente suelta', 'ref', ${leadId}) returning id`;
        const [e] = await tx`insert into evidencia
          (workspace_id, fuente_id, titulo, resumen, dimensiones, creado_por)
          values (${ws}, ${f!.id as string}, 'Evidencia suelta', '', '{}'::jsonb, ${leadId})
          returning id`;
        await tx`update propuesta_ai
          set estado = 'aceptada', revisada_por = ${leadId}, evidencia_id = ${e!.id as string}
          where id = ${propuestaId}`;
      }),
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
        datos: { criterios: [CONTENIDO_C0, { ...CONTENIDO_C0, kpi: 'Tiempo a cuenta activa' }] },
        intentos: [intento({ modelo: 'modelo-de-prueba', latenciaMs: 1234, uso: null })],
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
        datos: { basura: true },
        intentos: [intento({ modelo: 'm', latenciaMs: 1, uso: null })],
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

  it('una revocación retira el token de despacho de la generación en vuelo', async () => {
    const itemId = await nuevoItem('Entrevista con generación en vuelo', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    // Una generación en vuelo, representada por su reserva (el token de despacho).
    await conUsuario(leadId, (tx) => tx`insert into reserva_ai
      (workspace_id, capacidad, item_id, unidades, creado_por)
      values (${ws}, 'CI', ${itemId}, 1, ${leadId})`);

    // La revocación la registra OTRA persona: quien revoca casi nunca es quien tiene la
    // llamada en curso, y esa es justo la fila que hay que poder retirar.
    await registrarConsentimiento(disenadorId, {
      workspaceId: ws,
      itemId,
      alcance: 'La persona retira el permiso de procesamiento externo',
      procesamientoExterno: false,
    });
    const reservas = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(reservas.length).toBe(0);

    // Un registro que SÍ autoriza no retira nada: solo la retirada del permiso corta.
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'La persona vuelve a autorizar el procesamiento externo',
      procesamientoExterno: true,
    });
    await conUsuario(leadId, (tx) => tx`insert into reserva_ai
      (workspace_id, capacidad, item_id, unidades, creado_por)
      values (${ws}, 'CI', ${itemId}, 1, ${leadId})`);
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Amplía el alcance, sigue autorizando el proveedor externo',
      procesamientoExterno: true,
    });
    const siguen = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(siguen.length).toBe(1);
    await sqlAdmin()`delete from reserva_ai where workspace_id = ${ws} and item_id = ${itemId}`;
  });

  it('revocar mientras el material viaja: la llamada ya salió, pero ninguna propuesta nace', async () => {
    const itemId = await nuevoItem('Entrevista revocada a media llamada', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });

    // El caso que NINGÚN candado puede cubrir y que conviene decir en voz alta: la
    // revocación entra con el material ya despachado. Lo que se promete es lo que sí se
    // cumple — que de ese material no nazca nada— y no que el envío se pueda deshacer.
    proveedor.duranteLlamada = async () => {
      await registrarConsentimiento(disenadorId, {
        workspaceId: ws,
        itemId,
        alcance: 'La persona retira el permiso mientras la llamada está en curso',
        procesamientoExterno: false,
      });
    };
    try {
      await conProveedor(RESPUESTA_CI, async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        ).rejects.toThrow(/consentimiento/i);
      });
    } finally {
      proveedor.duranteLlamada = null;
    }

    // El suelo hizo su trabajo: el guard lee el registro VIGENTE, así que la propuesta no
    // llega a existir aunque el proveedor ya hubiera respondido.
    const propuestas = await conUsuario(leadId, (tx) => tx`select 1 as x from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(propuestas.length).toBe(0);
    // La reserva la retiró la propia revocación, así que el item no queda bloqueado.
    const reservas = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(reservas.length).toBe(0);
    // Y la llamada, que se pagó, queda anotada: el gasto no depende de que el resultado
    // llegue a usarse.
    const llamadas = await conUsuario(leadId, (tx) => tx`select resultado, costo_usd,
        consentimiento_version
      from llamada_ai where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(llamadas.length).toBe(1);
    expect(llamadas[0]!.resultado).toBe('salida-valida');
    expect(Number(llamadas[0]!.costo_usd)).toBeGreaterThan(0);
    // Y anotada CON EL PERMISO que la amparó, que es lo único accionable que queda cuando
    // el material ya salió: la salida viajó bajo el registro nº1 y la revocación es el nº2,
    // así que «qué se envió amparado por un permiso que después se retiró» se responde
    // cruzando el libro con la bitácora (RF-09.4) en vez de reconstruirlo por fechas —que
    // con dos registros del mismo segundo no distingue nada—.
    expect(llamadas[0]!.consentimiento_version).toBe(1);
    const [ultimo] = await conUsuario(leadId, (tx) => tx`select version from consentimiento_item
      where workspace_id = ${ws} and item_id = ${itemId} order by version desc limit 1`);
    expect(ultimo!.version).toBe(2);

    // Y pedirla de nuevo se corta antes de construir el prompt: el vigente sigue siendo el
    // que revoca.
    await conProveedor(RESPUESTA_CI, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/consentimiento/i);
    });
  });

  it('revocar después de generar deja la propuesta obsoleta: no se materializa ni por SQL', async () => {
    const itemId = await nuevoItem('Entrevista revocada antes de revisar', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    const generadas = await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    expect(generadas.generadas).toBe(1);
    const [p] = await conUsuario(leadId, (tx) => tx`select id from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId} and estado = 'propuesta'`);
    const propuestaId = p!.id as string;

    // La propuesta nació con permiso vigente; la persona lo retira DESPUÉS. Es una ventana
    // distinta de la del despacho: aquí no hay nada viajando, hay un objeto de dominio a
    // punto de nacer de un material que ya no está autorizado.
    await registrarConsentimiento(disenadorId, {
      workspaceId: ws,
      itemId,
      alcance: 'La persona retira el permiso de procesamiento externo',
      procesamientoExterno: false,
    });

    // El panel deja de ofrecer los botones de aceptación y dice por qué.
    const panel = await panelPropuestas(leadId, ws);
    const enPanel = panel.pendientes.find((x) => x.id === propuestaId)!;
    expect(enPanel.anclaEstado).toBe('consentimiento-revocado');

    // El servicio lo dice con nombre…
    await expect(
      aceptarPropuesta(leadId, { workspaceId: ws, propuestaId }),
    ).rejects.toThrow(/consentimiento/i);
    // …y el suelo es la base: el guard de la transición lo impide también por SQL crudo,
    // antes incluso de que hablen los CHECK de la tabla.
    await expect(
      conUsuario(leadId, (tx) => tx`update propuesta_ai
        set estado = 'aceptada', revisada_por = ${leadId} where id = ${propuestaId}`),
    ).rejects.toThrow(/consentimiento/i);

    // Nada nació en el dominio y el item sigue pendiente: la curaduría a mano no depende
    // de esto (no manda nada a ningún tercero).
    const evidencias = await conUsuario(leadId, (tx) => tx`select 1 as x from propuesta_ai
      where id = ${propuestaId} and evidencia_id is not null`);
    expect(evidencias.length).toBe(0);
    // Y rechazar, que es la salida, sigue disponible.
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });
  });

  it('la bitácora del panel es la puerta de la revocación, también con propuesta pendiente', async () => {
    const itemId = await nuevoItem('Entrevista de la bitácora del panel', 'entrevista');
    const nota = await nuevoItem('Nota que no es material de personas');

    // Sin registro: aparece con su estado, que es lo que hace registrable el primer
    // consentimiento (y solo el material de personas se lista).
    const inicial = await panelPropuestas(leadId, ws);
    const sinRegistro = inicial.materialDePersonas.find((m) => m.id === itemId);
    expect(sinRegistro).toBeDefined();
    expect(sinRegistro!.version).toBeNull();
    expect(sinRegistro!.autorizaExterno).toBe(false);
    expect(inicial.materialDePersonas.some((m) => m.id === nota)).toBe(false);

    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );

    // Con permiso vigente y una propuesta pendiente, el item ya no es un ancla ofrecible…
    const conPropuesta = await panelPropuestas(leadId, ws);
    expect(conPropuesta.itemsPendientes.some((i) => i.id === itemId)).toBe(false);
    // …y ahí estaba el agujero: el formulario colgaba del selector de generación, así que
    // en este estado —el único en el que una revocación urge— no había forma de registrarla.
    const vigente = conPropuesta.materialDePersonas.find((m) => m.id === itemId)!;
    expect(vigente.autorizaExterno).toBe(true);
    expect(vigente.version).toBe(1);

    // Y la revocación entra por esa puerta, sobre el mismo item.
    const revocacion = await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'La persona retira el permiso',
      procesamientoExterno: false,
    });
    expect(revocacion.version).toBe(2);
    const tras = await panelPropuestas(leadId, ws);
    const retirado = tras.materialDePersonas.find((m) => m.id === itemId)!;
    expect(retirado.autorizaExterno).toBe(false);
    expect(retirado.version).toBe(2);
  });

  it('lo que cambia durante la llamada no deja nacer una propuesta obsoleta', async () => {
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item que otro curador decide a media llamada');
    // Entre `prepararAlcance` y la persistencia hay una llamada entera: cualquier
    // precondición puede dejar de ser cierta. Aquí otro curador cura el item a mano.
    proveedor.duranteLlamada = async () => {
      await admin`update item_importacion
        set estado = 'rechazado', decidido_por = ${disenadorId}, decidido_en = now()
        where id = ${itemId}`;
    };
    try {
      await conProveedor(RESPUESTA_CI, async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        ).rejects.toThrow(/ya fue decidido|ya fue curado/i);
      });
    } finally {
      proveedor.duranteLlamada = null;
    }
    // No nace una propuesta que solo se podría tirar…
    const ninguna = await conUsuario(leadId, (tx) => tx`select 1 as x from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(ninguna.length).toBe(0);
    // …pero la llamada, que se pagó, sí queda anotada: el gasto no depende de que su
    // resultado llegue a usarse.
    const llamadas = await conUsuario(leadId, (tx) => tx`select 1 as x from llamada_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(llamadas.length).toBe(1);
    // Y el suelo es el guard: ni por SQL crudo nace una propuesta sobre un item decidido.
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', destino: 'evidencia', itemId }),
    ).rejects.toThrow(/ya fue decidido/i);
  });

  it('un reto que se congela durante la llamada tampoco deja nacer la propuesta', async () => {
    await enWorkspaceLimpio('congela-en-vuelo', async ({ ws: wsF, curadorId, retoId: retoF }) => {
      const admin = sqlAdmin();
      proveedor.duranteLlamada = async () => {
        const [proyecto] = await admin`insert into proyecto
          (workspace_id, reto_id, codigo, titulo, creado_por)
          values (${wsF}, ${retoF}, 'P-01', 'Proyecto', ${curadorId}) returning id`;
        await admin`insert into etapa_instancia
          (workspace_id, proyecto_id, numero, nombre, estado)
          values (${wsF}, ${proyecto!.id as string}, 0, 'Definición del objeto y del reto',
                  'completada')`;
        await admin`insert into gate_instancia
          (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
          values (${wsF}, ${proyecto!.id as string}, 0, 'sponsor', 'aprobado', ${curadorId},
                  now())`;
      };
      try {
        await conProveedor(
          { ok: true, datos: { criterios: [CONTENIDO_C0] }, intentos: [intento({ uso: null })] },
          async () => {
            await expect(
              generarPropuestas(curadorId, { workspaceId: wsF, capacidad: 'C0', anclaId: retoF }),
            ).rejects.toThrow(/no admite criterios|congelados/i);
          },
        );
      } finally {
        proveedor.duranteLlamada = null;
      }
      const ninguna = await conUsuario(curadorId, (tx) => tx`select 1 as x from propuesta_ai
        where workspace_id = ${wsF} and reto_id = ${retoF}`);
      expect(ninguna.length).toBe(0);
      const llamadas = await conUsuario(curadorId, (tx) => tx`select 1 as x from llamada_ai
        where workspace_id = ${wsF} and reto_id = ${retoF}`);
      expect(llamadas.length).toBe(1);
    });
  });

  it('la llamada se anota aunque la cuenta se desactive con el material en vuelo', async () => {
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item con la cuenta desactivada a media llamada');
    proveedor.duranteLlamada = async () => {
      await admin`update usuario set estado = 'inactivo' where id = ${disenadorId}`;
    };
    try {
      await conProveedor(RESPUESTA_CI, async () => {
        // Persistir propuestas SÍ es actuar, así que se corta…
        await expect(
          generarPropuestas(disenadorId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        ).rejects.toThrow(ErrorAutorizacion);
      });
      // …pero la llamada ya ocurrió y quizá ya se facturó: dejar caer su anotación borraría
      // gasto real del libro y del tope. El hecho consumado se registra igual.
      const [llamada] = await conUsuario(leadId, (tx) => tx`select resultado, costo_usd,
          creado_por from llamada_ai where workspace_id = ${ws} and item_id = ${itemId}`);
      expect(llamada).toBeDefined();
      expect(llamada!.resultado).toBe('salida-valida');
      expect(Number(llamada!.costo_usd)).toBeGreaterThan(0);
      expect(llamada!.creado_por).toBe(disenadorId);
      // Y la reserva se suelta: soltarla tampoco es actuar, y dejarla colgada bloquearía el
      // ancla y abultaría el presupuesto en vuelo hasta que caducara.
      const reservas = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
        where workspace_id = ${ws} and item_id = ${itemId}`);
      expect(reservas.length).toBe(0);
      // Lo que no pasa: la cuenta desactivada no crea propuestas.
      const ninguna = await conUsuario(leadId, (tx) => tx`select 1 as x from propuesta_ai
        where workspace_id = ${ws} and item_id = ${itemId}`);
      expect(ninguna.length).toBe(0);
    } finally {
      proveedor.duranteLlamada = null;
      await admin`update usuario set estado = 'activo' where id = ${disenadorId}`;
    }
  });

  it('«decididas recientes» se ordena por la fecha de la DECISIÓN, no la de la propuesta', async () => {
    await enWorkspaceLimpio('decididas', async ({ ws: wsD, curadorId, retoId: retoD }) => {
      const admin = sqlAdmin();
      const [llamada] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsD}, 'C0', ${retoD}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      // Una propuesta ANTIGUA y otras cincuenta más nuevas, todas del mismo reto.
      const [vieja] = await admin`insert into propuesta_ai
        (workspace_id, capacidad, destino, reto_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, creado_en)
        values (${wsD}, 'C0', 'criterio-exito', ${retoD}, ${admin.json(CONTENIDO_C0)},
                ${admin.json(CONTENIDO_C0)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'entorno',
                ${llamada!.id as string}, ${curadorId}, now() - interval '30 days')
        returning id`;
      const nuevas = await admin`insert into propuesta_ai
        (workspace_id, capacidad, destino, reto_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, creado_en)
        select ${wsD}, 'C0', 'criterio-exito', ${retoD}, ${admin.json(CONTENIDO_C0)},
               ${admin.json(CONTENIDO_C0)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'entorno',
               ${llamada!.id as string}, ${curadorId}, now() - interval '1 day'
        from generate_series(1, 50)
        returning id`;
      // Las nuevas se decidieron ayer; la antigua, ahora mismo.
      await admin`update propuesta_ai set estado = 'rechazada', revisada_por = ${curadorId},
          revisada_en = now() - interval '1 day'
        where id in ${admin(nuevas.map((n) => n.id as string))}`;
      await admin`update propuesta_ai set estado = 'rechazada', revisada_por = ${curadorId},
          revisada_en = now()
        where id = ${vieja!.id as string}`;

      const panel = await panelPropuestas(curadorId, wsD);
      // Con el orden por `creado_en`, la decisión recién tomada quedaba detrás de las
      // cincuenta de propuestas más nuevas: el revisor no veía lo que acababa de hacer.
      expect(panel.decididas[0]!.id).toBe(vieja!.id as string);
      expect(panel.hayMasDecididas).toBe(true);
    });
  });

  it('la excepción del consentimiento no vale para retirar reservas de material que no lo exige', async () => {
    const nota = await nuevoItem('Nota con generación en vuelo de otra persona');
    // Una generación en vuelo del LEAD sobre un item que no es material de personas.
    await conUsuario(leadId, (tx) => tx`insert into reserva_ai
      (workspace_id, capacidad, item_id, unidades, creado_por)
      values (${ws}, 'CI', ${nota}, 2, ${leadId})`);
    try {
      // Otro curador no puede retirarla: para una nota «no hay consentimiento externo
      // vigente» es cierto SIEMPRE —nunca hubo nada que registrar—, así que sin el tipo de
      // fuente en el predicado la excepción se volvía general y cualquiera podía tumbar la
      // reserva de otro con la llamada en vuelo, pagando dos veces por lo mismo.
      const borradas = await conUsuario(disenadorId, (tx) => tx`delete from reserva_ai
        where workspace_id = ${ws} and item_id = ${nota}`);
      expect(borradas.count).toBe(0);
      const siguen = await conUsuario(leadId, (tx) => tx`select 1 as x from reserva_ai
        where workspace_id = ${ws} and item_id = ${nota}`);
      expect(siguen.length).toBe(1);

      // Y el endpoint deja de ser palanca: sobre una nota no hay consentimiento que
      // registrar, así que no se acepta el registro que abriría esa puerta.
      await expect(
        registrarConsentimiento(disenadorId, {
          workspaceId: ws,
          itemId: nota,
          alcance: 'intento de registrar sobre material que no es de personas',
          procesamientoExterno: false,
        }),
      ).rejects.toThrow(/no es material de personas/i);

      // La dueña de la reserva sí la retira (ese caso nunca dependió de la excepción).
      const propias = await conUsuario(leadId, (tx) => tx`delete from reserva_ai
        where workspace_id = ${ws} and item_id = ${nota}`);
      expect(propias.count).toBe(1);
    } finally {
      await sqlAdmin()`delete from reserva_ai where workspace_id = ${ws} and item_id = ${nota}`;
    }
  });

  it('la bandera de capacidad no promete lo que la admisión va a negar', async () => {
    // Un hueco libre y una generación que puede gastar dos: la pantalla decía «AI
    // disponible», la persona pulsaba y se llevaba el rechazo.
    await llenarPresupuesto(1);
    try {
      // Con credencial resuelta: lo que se mide aquí es el presupuesto, no la capacidad.
      await conProveedor(RESPUESTA_CI, async () => {
        const panel = await panelPropuestas(leadId, ws);
        expect(panel.ai.disponible).toBe(false);
        expect(panel.ai.motivo).toMatch(/no alcanza para esta generación/i);
        // Y el número que se MUESTRA sigue siendo lo realmente atendido: son dos números
        // con dos propósitos y fusionarlos para que cuadren sería el error.
        expect(panel.ai.llamadasHoy).toBe(LIMITE_LLAMADAS_DIA - 1);
      });
    } finally {
      await vaciarRelleno();
    }

    // Con sitio para dos, pero ese sitio ya apartado por una generación en vuelo: la
    // decisión cuenta la reserva, el número mostrado no.
    const otro = await nuevoItem('Item de la reserva que llena el hueco');
    await llenarPresupuesto(2);
    await conUsuario(leadId, (tx) => tx`insert into reserva_ai
      (workspace_id, capacidad, item_id, unidades, creado_por)
      values (${ws}, 'CI', ${otro}, 2, ${leadId})`);
    try {
      await conProveedor(RESPUESTA_CI, async () => {
        const panel = await panelPropuestas(leadId, ws);
        expect(panel.ai.disponible).toBe(false);
        expect(panel.ai.llamadasHoy).toBe(LIMITE_LLAMADAS_DIA - 2);
      });
    } finally {
      await sqlAdmin()`delete from reserva_ai where workspace_id = ${ws} and item_id = ${otro}`;
      await vaciarRelleno();
    }
  });

  it('la bitácora alcanza el material de personas también después de curarlo', async () => {
    const itemId = await nuevoItem('Entrevista que se cura y luego se revoca', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    const [p] = await conUsuario(leadId, (tx) => tx`select id from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId} and estado = 'propuesta'`);
    await aceptarPropuesta(leadId, { workspaceId: ws, propuestaId: p!.id as string });

    // El item queda curado y su evidencia existe. La puerta de la revocación no puede
    // cerrarse justo ahora: es cuando una retirada tiene MÁS consecuencias, no menos.
    const panel = await panelPropuestas(leadId, ws);
    const enBitacora = panel.materialDePersonas.find((m) => m.id === itemId);
    expect(enBitacora).toBeDefined();
    expect(enBitacora!.curado).toBe(true);
    expect(enBitacora!.autorizaExterno).toBe(true);

    const revocacion = await registrarConsentimiento(disenadorId, {
      workspaceId: ws,
      itemId,
      alcance: 'La persona retira el permiso después de la curaduría',
      procesamientoExterno: false,
    });
    expect(revocacion.version).toBe(2);
    const tras = await panelPropuestas(leadId, ws);
    expect(tras.materialDePersonas.find((m) => m.id === itemId)!.autorizaExterno).toBe(false);
  });

  it('archivar el reto tras generar deja la propuesta obsoleta, y rechazarla sigue abierto', async () => {
    await enWorkspaceLimpio('reto-archivado', async ({ ws: wsA, curadorId, retoId: retoA }) => {
      const admin = sqlAdmin();
      await conProveedor(
        { ok: true, datos: { criterios: [CONTENIDO_C0] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsA, capacidad: 'C0', anclaId: retoA }),
      );
      const [p] = await conUsuario(curadorId, (tx) => tx`select id from propuesta_ai
        where workspace_id = ${wsA} and reto_id = ${retoA} and estado = 'propuesta'`);
      const propuestaId = p!.id as string;

      // `candidato → archivado` es una transición LEGAL: entre generar y revisar el reto
      // puede dejar de admitir criterios sin que nadie haga nada raro.
      await admin`update reto set estado = 'archivado' where id = ${retoA}`;

      // El panel lo dice con su propio motivo —es el cuarto— en vez de apagar un botón sin
      // explicación.
      const panel = await panelPropuestas(curadorId, wsA);
      const enPanel = panel.pendientes.find((x) => x.id === propuestaId)!;
      expect(enPanel.anclaEstado).toBe('reto-no-admite');

      // Aceptar crearía un criterio bajo un reto archivado: un contrato de medición para
      // algo que nadie va a medir, y algo que la generación no habría admitido. Se exige el
      // mensaje del SERVICIO —el que dice cómo salir— y no solo que reviente: el suelo de la
      // base también revienta, pero varias sentencias más tarde y sin decir qué hacer.
      await expect(
        aceptarPropuesta(curadorId, { workspaceId: wsA, propuestaId }),
      ).rejects.toThrow(/solo puede rechazarse/i);
      const criterios = await conUsuario(curadorId, (tx) => tx`select 1 as x from criterio_exito
        where workspace_id = ${wsA} and reto_id = ${retoA}`);
      expect(criterios.length).toBe(0);

      // El SUELO, sin pasar por el servicio: crear el criterio a mano y sellar la propuesta
      // por SQL. Ninguna política de `criterio_exito` mira el estado del reto, así que el
      // insert pasa; quien lo para es el constraint diferido de materialización, y lo hace
      // en el COMMIT — el último instante posible, que es justo lo que lo vuelve suelo para
      // una ventana que dura días.
      await expect(
        conUsuario(curadorId, async (tx) => {
          const [c] = await tx`insert into criterio_exito
            (workspace_id, reto_id, kpi, definicion, linea_base_plan, objetivo, ventana_dias,
             creado_por)
            values (${wsA}, ${retoA}, 'KPI a mano', 'Definición', 'Plan', 'Objetivo', 30,
                    ${curadorId})
            returning id`;
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${curadorId}, criterio_id = ${c!.id as string}
            where id = ${propuestaId}`;
        }),
      ).rejects.toThrow(/no admite criterios nuevos/i);

      // Y cuando se cumplen LOS DOS motivos de C0 —lo normal en un reto que avanzó: cambió
      // de estado y su G0 se aprobó— el panel reporta el del ciclo de vida, que es el que no
      // tiene vuelta. «Criterios congelados» insinuaría una salida real (reabrir la etapa 0
      // descongela, RF-04.9) que aquí no desbloquea nada: al volver, el reto seguiría
      // archivado. Entre dos motivos ciertos gana el que describe la puerta que ya no se
      // abre.
      const [proyecto] = await admin`insert into proyecto
        (workspace_id, reto_id, codigo, titulo, creado_por)
        values (${wsA}, ${retoA}, 'P-01', 'Proyecto', ${curadorId}) returning id`;
      await admin`insert into etapa_instancia
        (workspace_id, proyecto_id, numero, nombre, estado)
        values (${wsA}, ${proyecto!.id as string}, 0, 'Definición del objeto y del reto',
                'completada')`;
      await admin`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador, estado, aprobado_por, aprobado_en)
        values (${wsA}, ${proyecto!.id as string}, 0, 'sponsor', 'aprobado', ${curadorId},
                now())`;
      const conAmbos = await panelPropuestas(curadorId, wsA);
      expect(conAmbos.pendientes.find((x) => x.id === propuestaId)!.anclaEstado).toBe(
        'reto-no-admite',
      );

      // Y la asimetría que sostiene todo esto: RECHAZAR sigue abierto. Es la salida de una
      // propuesta obsoleta; bloquearla también dejaría la fila muerta para siempre. No lo
      // alcanza ni el servicio (no materializa nada) ni el guard (sale temprano si el estado
      // nuevo no es una aceptación). Con los DOS motivos encima, que es el caso de arriba.
      await rechazarPropuesta(curadorId, { workspaceId: wsA, propuestaId });
      const [decidida] = await conUsuario(curadorId, (tx) => tx`select estado from propuesta_ai
        where id = ${propuestaId}`);
      expect(decidida!.estado).toBe('rechazada');
    });
  });

  it('aceptar no puede adoptar un objeto que ya existía: se exige procedencia, no parecido', async () => {
    const itemId = await nuevoItem('Item curado a mano antes de aceptar');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });

    // El ataque exacto: el curador aprueba el item POR SU CUENTA, con una evidencia hecha a
    // mano y sin lineage de AI, en su propia transacción. Nada de esto es ilegítimo — es la
    // curaduría manual de siempre (SYS-16), y el item queda sellado por él.
    const aMano = await conUsuario(leadId, async (tx) => {
      const [f] = await tx`insert into fuente
        (workspace_id, tipo, titulo, referencia, creado_por)
        values (${ws}, 'nota', 'Fuente a mano', 'ref', ${leadId}) returning id`;
      const [e] = await tx`insert into evidencia
        (workspace_id, fuente_id, titulo, resumen, dimensiones, creado_por)
        values (${ws}, ${f!.id as string}, 'Evidencia a mano', 'La escribió una persona',
                '{}'::jsonb, ${leadId}) returning id`;
      await tx`update item_importacion
        set estado = 'aprobado', decidido_por = ${leadId}, decidido_en = now(),
            evidencia_id = ${e!.id as string}
        where id = ${itemId}`;
      return e!.id as string;
    });

    // Y DESPUÉS marca aceptada la propuesta que seguía pendiente, colgándole esa evidencia.
    // El guard viejo lo dejaba pasar porque su comprobación era un PREDICADO: el item apunta
    // a esa evidencia y la decidió el mismo humano — las dos cosas son ciertas. Lo que no es
    // cierto es que la produjera esta aceptación, y eso es lo que ahora hay que demostrar.
    await expect(
      conUsuario(leadId, (tx) => tx`update propuesta_ai
        set estado = 'aceptada', revisada_por = ${leadId}, evidencia_id = ${aMano}
        where id = ${propuestaId}`),
    ).rejects.toThrow(/esta misma aceptación/i);

    // Lo que estaba en juego no es la fila: es que un objeto hecho a mano constara como
    // materializado por la AI. La propuesta sigue pendiente y su única salida es rechazarla.
    const [viva] = await conUsuario(leadId, (tx) => tx`select estado, evidencia_id
      from propuesta_ai where id = ${propuestaId}`);
    expect(viva!.estado).toBe('propuesta');
    expect(viva!.evidencia_id).toBeNull();
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });
  });

  it('escribir un criterio bloquea la FILA del reto: la transición espera, no se cuela', async () => {
    await enWorkspaceLimpio('candado-fila', async ({ ws: wsF, curadorId, retoId: retoF }) => {
      const admin = sqlAdmin();
      await conUsuario(curadorId, async (tx) => {
        await tx`insert into criterio_exito
          (workspace_id, reto_id, kpi, definicion, linea_base_plan, objetivo, ventana_dias,
           creado_por)
          values (${wsF}, ${retoF}, 'KPI', 'Definición', 'Plan', 'Objetivo', 30, ${curadorId})`;

        // Desde OTRA conexión, la transición que movería el reto bajo los pies de esta
        // escritura. Quien la hace no conoce ningún protocolo —hace `update reto` y ya—, así
        // que lo único que puede detenerla es la fila, no un candado consultivo. Con un
        // `lock_timeout` corto la prueba es determinista: si la fila estuviera libre, esto
        // commitearía en milisegundos; bloqueada, agota el plazo esperando.
        await expect(
          admin.begin(async (t) => {
            await t`set local lock_timeout = '300ms'`;
            await t`update reto set estado = 'archivado' where id = ${retoF}`;
          }),
        ).rejects.toThrow(/lock timeout/i);
      });

      // Y en cuanto la escritura commitea, la transición vuelve a ser posible: el candado
      // ORDENA las dos operaciones, no prohíbe ninguna.
      await admin`update reto set estado = 'archivado' where id = ${retoF}`;
      const [r] = await admin`select estado from reto where id = ${retoF}`;
      expect(r!.estado).toBe('archivado');
    });
  });

  it('dos propuestas no se reparten el mismo criterio: un objeto cuelga de una sola', async () => {
    // El caso simétrico del anterior, y el único que la procedencia NO puede ver: las dos
    // propuestas reclaman un objeto creado en ESTA transacción, así que las dos pasan el
    // `xmin`. También pasan el resto del guard —el criterio cuelga del reto de ambas y lo
    // firma quien acepta—, porque un reto admite varios criterios y varias propuestas. Si
    // colgara de las dos, una de las dos estaría mintiendo sobre quién lo produjo, y la
    // atribución de SPEC-08 se repartiría entre una propuesta real y una prestada.
    const p1 = await nuevaPropuesta(leadId, {
      capacidad: 'C0',
      destino: 'criterio-exito',
      retoId,
    });
    const p2 = await nuevaPropuesta(leadId, {
      capacidad: 'C0',
      destino: 'criterio-exito',
      retoId,
    });
    await expect(
      conUsuario(leadId, async (tx) => {
        const [c] = await tx`insert into criterio_exito
          (workspace_id, reto_id, kpi, definicion, linea_base_plan, objetivo, ventana_dias,
           creado_por)
          values (${ws}, ${retoId}, 'KPI compartido', 'Definición', 'Plan', 'Objetivo', 30,
                  ${leadId})
          returning id`;
        for (const id of [p1, p2]) {
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${leadId}, criterio_id = ${c!.id as string}
            where id = ${id}`;
        }
      }),
    ).rejects.toThrow(/propuesta_ai_criterio_idx/);

    for (const id of [p1, p2]) {
      await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId: id });
    }
  });

  it('una revocación que commitea a media aceptación la para en el commit, no la deja pasar', async () => {
    const itemId = await nuevoItem('Entrevista revocada a media aceptación', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza la entrevista y su procesamiento externo',
      procesamientoExterno: true,
    });
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });

    // Se materializa a mano —o sea SIN el candado por item que toma el servicio—, que es
    // justo el caso que el candado no cubre y el suelo sí tiene que cubrir. En medio, desde
    // otra conexión, la persona retira el permiso y esa revocación COMMITEA.
    //
    // El guard de revisión no puede verla: es BEFORE UPDATE y su snapshot es el de la
    // sentencia que sella, tomado antes. El diferido corre en el COMMIT, con snapshot nuevo,
    // y sí la ve. Sin él, la evidencia entraba con la revocación ya vigente.
    await expect(
      conUsuario(leadId, async (tx) => {
        const [f] = await tx`insert into fuente
          (workspace_id, tipo, titulo, referencia, creado_por)
          values (${ws}, 'entrevista', 'Fuente', 'ref', ${leadId}) returning id`;
        const [e] = await tx`insert into evidencia
          (workspace_id, fuente_id, titulo, resumen, dimensiones, creado_por)
          values (${ws}, ${f!.id as string}, 'Evidencia', '', '{}'::jsonb, ${leadId})
          returning id`;
        await tx`update item_importacion
          set estado = 'aprobado', decidido_por = ${leadId}, decidido_en = now(),
              evidencia_id = ${e!.id as string}
          where id = ${itemId}`;
        await tx`update propuesta_ai
          set estado = 'aceptada', revisada_por = ${leadId}, evidencia_id = ${e!.id as string}
          where id = ${propuestaId}`;

        await registrarConsentimiento(leadId, {
          workspaceId: ws,
          itemId,
          alcance: 'La persona retira el permiso para el procesamiento externo',
          procesamientoExterno: false,
        });
      }),
    ).rejects.toThrow(/no autoriza el procesamiento externo/i);

    // La transacción entera se revirtió: ni evidencia colada ni item sellado.
    const [tras] = await conUsuario(leadId, (tx) => tx`select estado, evidencia_id
      from item_importacion where id = ${itemId}`);
    expect(tras!.estado).toBe('pendiente');
    expect(tras!.evidencia_id).toBeNull();

    // Y por el camino del SERVICIO el revisor recibe el error con NOMBRE, no el del suelo:
    // la lectura va bajo el mismo candado por item que toma registrar un consentimiento.
    await expect(
      aceptarPropuesta(leadId, { workspaceId: ws, propuestaId }),
    ).rejects.toThrow(/solo puede rechazarse/i);
  });

  it('un reto que ya no admite criterios no llega ni a pedirlos: se corta antes de gastar', async () => {
    await enWorkspaceLimpio('admision-archivado', async ({ ws: wsB, curadorId, retoId: retoB }) => {
      const admin = sqlAdmin();
      await admin`update reto set estado = 'archivado' where id = ${retoB}`;

      // La contrapartida del test de arriba en el PRIMER recorrido: allí el reto se cerraba
      // entre generar y aceptar; aquí ya estaba cerrado antes de empezar. El mismo predicado
      // y la misma función, en el momento en el que todavía se puede evitar el gasto — que
      // es la razón de que la columna «antes de llamar» exista.
      await expect(
        conProveedor(
          { ok: true, datos: { criterios: [CONTENIDO_C0] }, intentos: [intento({ uso: null })] },
          () => generarPropuestas(curadorId, { workspaceId: wsB, capacidad: 'C0', anclaId: retoB }),
        ),
      ).rejects.toThrow(/no admite criterios/i);

      // Y «se corta antes de gastar» se comprueba, no se supone: sin llamada anotada no hubo
      // nada que pagar, y sin reserva viva el ancla no queda retenida por un intento que no
      // llegó a ninguna parte.
      const llamadas = await conUsuario(curadorId, (tx) => tx`select 1 as x from llamada_ai
        where workspace_id = ${wsB} and reto_id = ${retoB}`);
      expect(llamadas.length).toBe(0);
      const reservas = await conUsuario(curadorId, (tx) => tx`select 1 as x from reserva_ai
        where workspace_id = ${wsB} and reto_id = ${retoB}`);
      expect(reservas.length).toBe(0);
    });
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

  it('el tope cuenta LLAMADAS atendidas: lo que se paga sin producir nada también gasta', async () => {
    const itemId = await nuevoItem('Item con el presupuesto casi lleno');
    // El tope acota lo que se PAGA. Una negativa del proveedor es una llamada atendida y
    // facturada de la que no nace ninguna propuesta: contando propuestas persistidas, ese
    // gasto era invisible y un material que el modelo rechaza siempre se podía reintentar
    // sin fin. Se deja sitio justo para una generación (que puede gastar hasta dos
    // llamadas: primario y respaldo).
    await llenarPresupuesto(2);
    try {
      const antes = (await panelPropuestas(leadId, ws)).ai.llamadasHoy;
      await conProveedor(RESPUESTA_RECHAZO, async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        ).rejects.toThrow(/se negó a procesar/);
      });
      // El contador se movió sin que naciera ninguna propuesta: eso es lo que el tope
      // basado en producción no veía.
      const despues = (await panelPropuestas(leadId, ws)).ai.llamadasHoy;
      expect(despues).toBe(antes + 1);
      // Y por eso la siguiente ya no entra: queda una llamada y una generación puede
      // gastar dos.
      await conProveedor(RESPUESTA_CI, async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        ).rejects.toThrow(/presupuesto/i);
      });
      const ninguna = await conUsuario(leadId, (tx) => tx`select 1 as x from propuesta_ai
        where workspace_id = ${ws} and item_id = ${itemId}`);
      expect(ninguna.length).toBe(0);
    } finally {
      await vaciarRelleno();
    }
    // Sin el relleno, el mismo item vuelve a poder generarse.
    const r = await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    expect(r.generadas).toBe(1);
  });

  it('un fallo sin respuesta no gasta tope: «no se sabe» no es «se pagó»', async () => {
    const itemId = await nuevoItem('Item con el proveedor caído y el tope al límite');
    await llenarPresupuesto(2);
    try {
      // El proveedor no respondió: la llamada se anota para operabilidad, pero con coste
      // desconocido — cobrarla convertiría una caída del proveedor en un workspace sin
      // capacidad AI el resto del día, justo lo contrario de la degradación segura.
      await conProveedor(RESPUESTA_CAIDO, async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        ).rejects.toThrow(/no está disponible/);
      });
      const r = await conProveedor(RESPUESTA_CI, () =>
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      );
      expect(r.generadas).toBe(1);
    } finally {
      await vaciarRelleno();
    }
  });

  it('las generaciones en curso ocupan presupuesto: N curadores a la vez no lo rebasan', async () => {
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item con una generación en vuelo delante');
    const otro = await nuevoItem('Item de la generación en vuelo');
    // Sitio para dos llamadas y una generación EN CURSO que ya las apartó: el tope no se
    // rebasa aunque todavía no haya ninguna propuesta ni ninguna llamada anotada — es
    // exactamente el estado que el chequeo sobre lo persistido no veía.
    await llenarPresupuesto(2);
    await admin`insert into reserva_ai (workspace_id, capacidad, item_id, unidades, creado_por)
      values (${ws}, 'CI', ${otro}, 2, ${leadId})`;
    try {
      await conProveedor(RESPUESTA_CI, async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        ).rejects.toThrow(/presupuesto/i);
      });
      // El panel informa de lo REALMENTE gastado hoy, no de las reservas en vuelo.
      const panel = await panelPropuestas(leadId, ws);
      expect(panel.ai.llamadasHoy).toBeLessThan(LIMITE_LLAMADAS_DIA);
    } finally {
      await admin`delete from reserva_ai where workspace_id = ${ws}`;
      await vaciarRelleno();
    }
    const r = await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );
    expect(r.generadas).toBe(1);
  });

  it('una reserva caducada no concede capacidad, y lo ya pagado no se tira', async () => {
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item con una reserva zombi de otro');
    const zombi = await nuevoItem('Item de la reserva zombi');
    await llenarPresupuesto(2);
    // Una reserva de OTRA generación que murió a mitad, con ocho huecos apartados: si
    // contara, no habría sitio para nadie. No cuenta — para admitir se ignora — y por eso
    // esta generación entra.
    await admin`insert into reserva_ai
      (workspace_id, capacidad, item_id, unidades, creado_por, creado_en)
      values (${ws}, 'CI', ${zombi}, 8, ${leadId}, now() - interval '10 minutes')`;
    try {
      const r = await conProveedor(RESPUESTA_CI, () =>
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      );
      // Y lo que ya se pagó no se tira: la llamada estaba hecha cuando se fue a persistir,
      // así que negarse a guardar su salida no des-gastaría nada — solo perdería lo
      // comprado. El tope frena donde puede frenar el gasto: en la admisión.
      expect(r.generadas).toBe(1);
      // Consumido ese hueco, la siguiente generación ya no entra.
      await conProveedor(RESPUESTA_CI, async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: zombi }),
        ).rejects.toThrow(/presupuesto/i);
      });
    } finally {
      await admin`delete from reserva_ai where workspace_id = ${ws}`;
      await vaciarRelleno();
    }
  });

  it('dos curadores a la vez sobre el mismo RETO dejan una sola generación en vuelo', async () => {
    await enWorkspaceLimpio('c0-exclusivo', async ({ ws: wsE, curadorId, retoId: retoE }) => {
      const resultados = await conProveedor(
        { ok: true, datos: { criterios: [CONTENIDO_C0] }, intentos: [intento({ uso: null })] },
        () =>
          Promise.allSettled([
            generarPropuestas(curadorId, { workspaceId: wsE, capacidad: 'C0', anclaId: retoE }),
            generarPropuestas(curadorId, { workspaceId: wsE, capacidad: 'C0', anclaId: retoE }),
          ]),
      );
      // Antes, la reserva C0 no guardaba el reto: no excluía nada, las dos llamaban al
      // proveedor y quedaban dos lotes pendientes sobre un ancla que la pantalla ofrece una
      // sola vez. Ahora la segunda se detiene ANTES de llamar.
      expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const perdedora = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(perdedora.reason).toBeInstanceOf(ErrorAI);
      expect((perdedora.reason as ErrorAI).message).toMatch(/en curso|esperando revisión/i);

      // Una sola llamada pagada y un solo lote pendiente.
      const llamadas = await conUsuario(curadorId, (tx) => tx`select 1 as x from llamada_ai
        where workspace_id = ${wsE} and reto_id = ${retoE}`);
      expect(llamadas.length).toBe(1);
      const pendientes = await conUsuario(curadorId, (tx) => tx`select 1 as x from propuesta_ai
        where workspace_id = ${wsE} and reto_id = ${retoE} and estado = 'propuesta'`);
      expect(pendientes.length).toBe(1);

      // Y el suelo es el índice único parcial por reto: ni por SQL crudo caben dos.
      await conUsuario(curadorId, (tx) => tx`insert into reserva_ai
        (workspace_id, capacidad, reto_id, unidades, creado_por)
        values (${wsE}, 'C0', ${retoE}, 2, ${curadorId})`);
      await expect(
        conUsuario(curadorId, (tx) => tx`insert into reserva_ai
          (workspace_id, capacidad, reto_id, unidades, creado_por)
          values (${wsE}, 'C0', ${retoE}, 2, ${curadorId})`),
      ).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  it('una degradación de modelo deja DOS filas en el libro, una por intento', async () => {
    const itemId = await nuevoItem('Item con degradación de modelo');
    const usoRespaldo = { entrada: 100, salida: 20 };
    await conProveedor(
      {
        ok: true,
        datos: CONTENIDO_CI,
        intentos: [
          intento({
            modelo: MODELO_PRIMARIO,
            resultado: 'sin-respuesta',
            motivo: 'El proveedor AI no está disponible.',
            latenciaMs: 25_000,
            uso: null,
          }),
          intento({
            modelo: MODELO_FALLBACK,
            latenciaMs: 800,
            uso: { ...usoRespaldo, costoUsd: costoDeUso(MODELO_FALLBACK, usoRespaldo) },
          }),
        ],
      },
      () => generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
    );

    const llamadas = await conUsuario(leadId, (tx) => tx`select id, modelo, resultado, motivo,
        latencia_ms, costo_usd from llamada_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    // Dos llamadas al proveedor, dos filas: con el `continue` que descartaba el intento
    // caído, la tasa de error por modelo decía que el primario no falla nunca.
    expect(llamadas.length).toBe(2);
    const primario = llamadas.find((l) => l.modelo === MODELO_PRIMARIO)!;
    const respaldo = llamadas.find((l) => l.modelo === MODELO_FALLBACK)!;
    expect(primario.resultado).toBe('sin-respuesta');
    expect(primario.motivo).toMatch(/no está disponible/);
    expect(primario.costo_usd).toBeNull();
    expect(primario.latencia_ms).toBe(25_000);
    // Y la latencia del respaldo es la SUYA: antes la fila superviviente sumaba los dos
    // intentos y la latencia por modelo medía algo que no ocurrió.
    expect(respaldo.resultado).toBe('salida-valida');
    expect(respaldo.latencia_ms).toBe(800);

    // La propuesta cuelga de la llamada que SÍ produjo contenido, y su lineage nombra al
    // modelo que respondió de verdad.
    const [p] = await conUsuario(leadId, (tx) => tx`select llamada_id, modelo from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(p!.llamada_id).toBe(respaldo.id);
    expect(p!.modelo).toBe(MODELO_FALLBACK);

    // El intento caído deja su evento: una llamada pagada de la que no nació nada.
    const [evento] = await sqlAdmin()`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'LlamadaAISinPropuesta'
        and payload->>'llamadaId' = ${primario.id as string}`;
    expect((evento!.payload as { modelo: string }).modelo).toBe(MODELO_PRIMARIO);
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
    // la suma del libro, sin `distinct` ni prorrateos. (Antes hay que decidir lo que ya
    // esperaba revisión sobre este reto: un ancla con propuestas pendientes no admite otra
    // pasada, que es lo que hace avanzar la lista de anclas ofrecidas.)
    const previas = await conUsuario(leadId, (tx) => tx`select id from propuesta_ai
      where workspace_id = ${ws} and reto_id = ${retoId} and estado = 'propuesta'`);
    for (const p of previas) {
      await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId: p.id as string });
    }
    await conProveedor(
      {
        ok: true,
        datos: { criterios: [CONTENIDO_C0, { ...CONTENIDO_C0, kpi: 'KPI del lote' }] },
        intentos: [
          intento({ latenciaMs: 10, uso: { entrada: 500, salida: 100, costoUsd: 0.005 } }),
        ],
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
      {
        ok: true,
        datos: { basura: true },
        intentos: [
          intento({ latenciaMs: 40, uso: { entrada: 90, salida: 10, costoUsd: 0.001 } }),
        ],
      },
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

      // Y la promesa incondicional: con más anclas elegibles que sitio en la lista, NINGÚN
      // orden alcanza —el drenaje ayuda, pero exige trabajar lo que va delante—. Buscar por
      // nombre llega a cualquiera sin drenar nada y sin gastar presupuesto en el camino.
      const buscado = await panelPropuestas(curadorId, wsA, 'Item 58');
      expect(buscado.itemsPendientes.map((i) => i.titulo)).toEqual(['Item 58']);
      expect(buscado.hayMasItems).toBe(false);
      const porCodigo = await panelPropuestas(curadorId, wsA, 'R-052');
      expect(porCodigo.retosAbiertos).toHaveLength(1);
      expect(porCodigo.busqueda).toBe('R-052');
      // El texto se busca LITERAL: un comodín de LIKE escrito por la persona es un carácter
      // más, no un «dámelo todo» que haría creer que la búsqueda no filtra.
      const comodin = await panelPropuestas(curadorId, wsA, '%');
      expect(comodin.itemsPendientes).toHaveLength(0);
    });
  });

  it('los retos también drenan: un reto con criterios propuestos sale de la lista', async () => {
    await enWorkspaceLimpio('drenaje', async ({ ws: wsD, curadorId, retoId: retoD }) => {
      const antes = await panelPropuestas(curadorId, wsD);
      expect(antes.retosAbiertos.some((r) => r.id === retoD)).toBe(true);

      await conProveedor(
        { ok: true, datos: { criterios: [CONTENIDO_C0] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsD, capacidad: 'C0', anclaId: retoD }),
      );

      // Un reto no cambia de estado por generarle criterios, así que sin esta condición se
      // quedaba en la lista para siempre y con más de 50 retos abiertos los de atrás eran
      // inalcanzables: el orden FIFO ordenaba, pero no drenaba.
      const conPendiente = await panelPropuestas(curadorId, wsD);
      expect(conPendiente.retosAbiertos.some((r) => r.id === retoD)).toBe(false);
      // Y el servicio dice lo mismo que el panel: pedir otro lote sobre un ancla que ya
      // espera revisión quemaría presupuesto en algo que nadie ha mirado.
      await conProveedor(
        { ok: true, datos: { criterios: [CONTENIDO_C0] }, intentos: [intento({ uso: null })] },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsD, capacidad: 'C0', anclaId: retoD }),
          ).rejects.toThrow(/esperando revisión/i);
        },
      );

      const [p] = await conUsuario(curadorId, (tx) => tx`select id from propuesta_ai
        where workspace_id = ${wsD} and reto_id = ${retoD} and estado = 'propuesta'`);
      await rechazarPropuesta(curadorId, { workspaceId: wsD, propuestaId: p!.id as string });
      const drenado = await panelPropuestas(curadorId, wsD);
      expect(drenado.retosAbiertos.some((r) => r.id === retoD)).toBe(true);
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
          datos: { criterios: [CONTENIDO_C0, { ...CONTENIDO_C0, kpi: 'Segundo KPI' }] },
          intentos: [intento({ latenciaMs: 120, uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C0', anclaId: retoC }),
      );
      expect(generadas.generadas).toBe(2);

      const antes = await panelPropuestas(curadorId, wsC);
      expect(antes.pendientes.every((p) => p.anclaEstado === 'disponible')).toBe(true);
      // Con criterios propuestos esperando revisión, el reto deja de ofrecerse como ancla:
      // es la condición que DRENA la lista (un reto no cambia de estado por generar).
      expect(antes.retosAbiertos.some((r) => r.id === retoC)).toBe(false);

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
      expect(despues.pendientes.every((x) => x.anclaEstado === 'criterios-congelados')).toBe(true);
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
      const viva = reabierto.pendientes[0]!;
      expect(viva.anclaEstado).toBe('disponible');
      // Sigue sin ofrecerse como ancla mientras esa propuesta espera: las dos condiciones
      // son independientes y ninguna tapa a la otra.
      expect(reabierto.retosAbiertos.some((r) => r.id === retoC)).toBe(false);
      const aceptada = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: viva.id,
      });
      expect(aceptada.estado).toBe('aceptada');
      // Y decidida la última pendiente, el reto vuelve a la lista: la ventana avanza al
      // trabajar, que es justo lo que le faltaba a los retos.
      const drenado = await panelPropuestas(curadorId, wsC);
      expect(drenado.retosAbiertos.some((r) => r.id === retoC)).toBe(true);
    });
  });

  it('el registry firmado congela los criterios con su propio motivo, y no con el del G0', async () => {
    // La SEGUNDA causa de congelado (SPEC-07, SYS-22), que llegó después de la del G0. Se
    // prueba aparte y no como variante de la anterior porque lo que hay que sostener es
    // justamente que NO son la misma: se distinguen en el panel, en el mensaje de admisión
    // y en el `raise` de la base, porque tienen salidas distintas — reabrir la etapa 0
    // descongela el G0 y no descongela una firma, que es de ida.
    await enWorkspaceLimpio('registry', async ({ ws: wsR, curadorId, retoId: retoR }) => {
      const admin = sqlAdmin();
      const generadas = await conProveedor(
        {
          ok: true,
          datos: { criterios: [CONTENIDO_C0] },
          intentos: [intento({ latenciaMs: 90, uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsR, capacidad: 'C0', anclaId: retoR }),
      );
      expect(generadas.generadas).toBe(1);

      // Entre generar y revisar, el reto firma su contrato de medición. El insert directo
      // del registry ya firmado es el atajo del test —el camino real pasa por G6—; el
      // efecto sobre los criterios es el mismo, y es el que se está probando.
      await admin`insert into metric_registry
        (workspace_id, reto_id, estado, firmado_por, firmado_en, creado_por)
        values (${wsR}, ${retoR}, 'firmado', ${curadorId}, now(), ${curadorId})`;

      const panel = await panelPropuestas(curadorId, wsR);
      // El motivo es el SUYO: con un solo valor para las dos causas, la pantalla le habría
      // ofrecido al lead reabrir la etapa 0, que aquí no desbloquea nada.
      expect(panel.pendientes.every((p) => p.anclaEstado === 'registry-firmado')).toBe(true);
      expect(panel.retosAbiertos.some((r) => r.id === retoR)).toBe(false);

      // Y lo que dice la pantalla se confirma contra la base, por los tres caminos:
      // aceptar la propuesta…
      const p = panel.pendientes[0]!;
      await expect(
        aceptarPropuesta(curadorId, { workspaceId: wsR, propuestaId: p.id }),
      ).rejects.toThrow(/registry del reto está firmado/i);
      // …volver a generar sobre ese reto, que se corta en la ADMISIÓN, antes de gastar la
      // llamada y con el motivo correcto…
      await expect(
        generarPropuestas(curadorId, { workspaceId: wsR, capacidad: 'C0', anclaId: retoR }),
      ).rejects.toThrow(/registry de medición de ese reto ya está firmado/i);
      // …y el SQL crudo, que es el suelo. Lo rechaza el guard —que corre antes que el
      // `with check` de la política— y por eso lo que se lee es SU mensaje, el del registry
      // y no el del G0: es la única señal que le dice a quien fuerza la escritura por qué
      // no hay reapertura que le sirva. (Que la POLÍTICA también lo mire, para el UPDATE
      // que el guard no alcanza, lo sostiene la suite de medición.)
      await expect(
        conUsuario(curadorId, (tx) => tx`insert into criterio_exito
          (workspace_id, reto_id, kpi, definicion, linea_base_plan, objetivo, ventana_dias,
           creado_por)
          values (${wsR}, ${retoR}, 'Colado', 'Definición', 'Plan', 'Objetivo', 30,
                  ${curadorId})`),
      ).rejects.toThrow(/registry del reto está firmado/i);

      // Rechazar, que es la salida de toda propuesta obsoleta, sigue abierta.
      await rechazarPropuesta(curadorId, { workspaceId: wsR, propuestaId: p.id });
    });
  });

  it('el asiento reservado del árbol ya no puede apuntar al vacío ni a otro workspace', async () => {
    // `reto_servicio_afectado.propuesta_ai_id` llevaba desde SPEC-02 siendo una columna
    // suelta: anulable, sin FK y con grant de INSERT sin lista de columnas, o sea escribible
    // por la aplicación con cualquier uuid. Hasta esta migración no había tabla a la que
    // apuntar; ahora la hay, y la referencia se comprueba.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item del asiento');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      destino: 'evidencia',
      itemId,
    });
    try {
      // Un uuid inventado ya no entra.
      await expect(
        admin`insert into reto_servicio_afectado
          (reto_id, servicio_id, workspace_id, propuesta_ai_id, creado_por)
          values (${retoId}, ${svcId}, ${ws},
                  '00000000-0000-0000-0000-000000000000', ${leadId})`,
      ).rejects.toThrow(/foreign key|llave foránea/i);

      // Y una propuesta REAL de otro workspace tampoco. La fila de prueba es por lo demás
      // impecable —su reto y su servicio son los del workspace vecino, así que las otras dos
      // FK están satisfechas— y lo ÚNICO que la rechaza es que la propuesta sea de aquí: eso
      // es lo que compra que la FK sea compuesta con `workspace_id`. Con una FK simple a
      // `id`, esta fila entraba.
      const [wsY] = await admin`insert into workspace (nombre)
        values (${marca + '-Y'}) returning id`;
      const wsYId = wsY!.id as string;
      try {
        const [svcY] = await admin`insert into servicio (workspace_id, nombre, creado_por)
          values (${wsYId}, 'Servicio vecino', ${leadId}) returning id`;
        const [retoY] = await admin`insert into reto
          (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
          values (${wsYId}, ${svcY!.id as string}, 'R-81', 'Reto vecino', 'candidato',
                  'peticion-cliente', ${leadId}) returning id`;
        await expect(
          admin`insert into reto_servicio_afectado
            (reto_id, servicio_id, workspace_id, propuesta_ai_id, creado_por)
            values (${retoY!.id as string}, ${svcY!.id as string}, ${wsYId}, ${propuestaId},
                    ${leadId})`,
        ).rejects.toThrow(/foreign key|llave foránea/i);
        // Control: la MISMA fila sin la propuesta ajena entra sin problema, así que lo que
        // la rechazaba no era ninguna de las otras dos referencias.
        await admin`insert into reto_servicio_afectado
          (reto_id, servicio_id, workspace_id, creado_por)
          values (${retoY!.id as string}, ${svcY!.id as string}, ${wsYId}, ${leadId})`;
        await admin`delete from reto_servicio_afectado where workspace_id = ${wsYId}`;
        await admin`delete from reto where workspace_id = ${wsYId}`;
        await admin`delete from servicio where workspace_id = ${wsYId}`;
      } finally {
        await admin`delete from workspace where id = ${wsYId}`;
      }

      // Y el caso normal sigue siendo el asiento VACÍO: MATCH SIMPLE no comprueba nada
      // mientras la columna anulable sea NULL, así que un afectado escrito a mano —que es
      // el único que existe hoy— entra igual que antes.
      await admin`insert into reto_servicio_afectado
        (reto_id, servicio_id, workspace_id, creado_por)
        values (${retoId}, ${svcId}, ${ws}, ${leadId})`;
      const [fila] = await admin`select propuesta_ai_id from reto_servicio_afectado
        where reto_id = ${retoId} and servicio_id = ${svcId}`;
      expect(fila!.propuesta_ai_id).toBe(null);
    } finally {
      await admin`delete from reto_servicio_afectado where workspace_id = ${ws}`;
      await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });
    }
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
