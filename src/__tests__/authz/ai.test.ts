import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cerrarPools, conUsuario, sqlAdmin } from '@/lib/db';
import { ErrorAutorizacion } from '@/lib/auth/auth.servicio';
import {
  costoDeUso,
  INTENTOS_POR_GENERACION,
  LIMITE_LLAMADAS_DIA,
  MODELO_FALLBACK,
  MODELO_PRIMARIO,
  VENTANA_SALUD_PROVEEDOR_MS,
} from '@/lib/ai/ai.degradacion';
import {
  criteriosQueLlegaronAlModelo,
  materialDeJourney,
  MAX_CRITERIOS_POR_LOTE,
  PROMPT_VERSION,
} from '@/lib/ai/ai.prompts';
import {
  CONFIANZA_PROPUESTA_NUMERICA,
  ESTADOS_ANCLA,
  type EstadoAncla,
  type ContenidoAsistenteGate,
  type ContenidoEntradaKpi,
  type ContenidoCriterio,
  type ContenidoExtraccion,
  type ContenidoInsight,
  type ContenidoOportunidad,
  type ContenidoRemediacionJourney,
  type ContenidoPropuesta,
} from '@/lib/ai/ai.schemas';
import { parsearContenido } from '@/lib/ai/ai.contenido';
import {
  criteriosQueLlegaronConLasOportunidades,
  evidenciaQueLlegoAlModelo,
  MAX_MATERIAL,
} from '@/lib/ai/ai.prompts';
import {
  aceptarPropuesta,
  ErrorAI,
  huellaDelMaterialDelRegistry,
  generarPropuestas,
  panelPropuestas,
  proyeccionDelPanel,
  rechazarPropuesta,
  registrarConsentimiento,
} from '@/lib/ai/ai.servicio';
import type { IntentoProveedor, ResultadoProveedor } from '@/lib/ai/proveedor.server';
import {
  CAPACIDADES,
  CAPACIDADES_ACTIVAS,
  COLUMNA_DE_DESTINO,
  COLUMNAS_DE_ANCLA,
  MAX_REMEDIACIONES,
  type AnclaCapacidad,
  type CapacidadActiva,
  type Destino,
} from '@/lib/ai/ai.schemas';
import type { PendingQuery, Row, TransactionSql } from 'postgres';
import { validarJourney } from '@/lib/journey/journey.mermaid';
import { leerJourneyCompleto, leerJourneysCompletos } from '@/lib/journey/journey.servicio';
import { borrarEntrada } from '@/lib/medicion/medicion.servicio';
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
  antesDelApunte: null as (() => Promise<void>) | null,
}));
vi.mock('@/lib/ai/proveedor.server', async (original) => {
  const real = await original<typeof import('@/lib/ai/proveedor.server')>();
  return {
    ...real,
    generarConProveedor: async (entrada: {
      anotarDespacho: (
        modelo: string,
        puesto: number,
      ) => Promise<{ ok: true; registroId: string } | { ok: false; motivo: string }>;
    }) => {
      const r = proveedor.respuesta!;
      // El doble ABRE la línea de cada intento antes de «despachar», igual que el adaptador
      // real: es el orden que este slice existe para garantizar —no se gasta lo que no se
      // puede anotar— y un doble que se lo saltara dejaría el arreglo sin probar. De aquí
      // salen los `registroId` que después cierra el servicio.
      //
      // Y el apunte es también la puerta del PERMISO: comprueba y anota en la misma
      // transacción. Un doble que lo tratara como un simple insert dejaría sin probar que una
      // revocación llegada justo antes del despacho para el material antes de que salga.
      const intentos = [];
      for (const [puesto, i] of r.intentos.entries()) {
        // El hueco ANTES del apunte: lo que ocurra aquí pasa con la autorización ya leída y
        // ni un byte todavía en el aire. Es el otro lado del de abajo, y el que decide si el
        // material llega a salir — por eso el apunte tiene que volver a preguntar.
        if (proveedor.antesDelApunte) await proveedor.antesDelApunte();
        const apunte = await entrada.anotarDespacho(i.modelo, puesto);
        if (!apunte.ok) return { ok: false as const, motivo: apunte.motivo, intentos };
        // El hueco en el que el material está EN VUELO: lo que ocurra aquí pasa con la
        // llamada ya despachada y su línea ya abierta, que es justo el caso que ningún
        // candado puede cubrir. Va después del apunte para que el orden sea el real.
        if (proveedor.duranteLlamada) await proveedor.duranteLlamada();
        // Cada intento sube sellado con LA LÍNEA que se abrió para él: es la que el servicio
        // cierra después, y la que ya lleva anotada la autorización bajo la que salió.
        intentos.push({ ...i, registroId: apunte.registroId });
      }
      return { ...r, intentos };
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
  let proyectoId = '';
  let gateId = '';
  let requisitoIds: string[] = [];
  let evidenciaDelRetoId = '';
  let insightValidadoDelRetoId = '';
  let registryId = '';
  let criterioDelRegistryId = '';

  const MATERIAL = 'El 71% de los abandonos ocurre en la carga del documento de identidad.';

  const CONTENIDO_CI: ContenidoExtraccion = {
    titulo: 'Abandono en verificación',
    resumen: 'El abandono se concentra en la carga del documento.',
    recoleccion: 'Análisis de funnel',
    fecha: '2026-07-20',
    fechaLocalizacion: 'párrafo 1',
    fechaSinDatoMotivo: '',
    derivada: true,
    confianza: 'media',
    confidencialidad: 'cliente',
    esEstadoActual: true,
    confianzaPropuesta: 'alta',
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
    confianzaPropuesta: 'media',
    // C0 cita la formulación del reto igual que CI cita el material del item: el fixture usa
    // el título, que `materialDeReto` mete en la ficha del bloque, así que es literal.
    citas: [{ fragmento: 'Reto', localizacion: 'título del reto' }],
  };

  /**
   * CT — un informe de gate. Cita el TEXTO de un requisito, que es lo que `materialDeGate`
   * mete en el cuerpo del bloque, así que la cita es literal por el mismo camino que en las
   * otras dos. El id del hueco se rellena en cada caso: depende del gate.
   */
  const CONTENIDO_CT = (requisitoId: string): ContenidoAsistenteGate => ({
    resumen: 'Faltan evidencias en dos requisitos del gate.',
    huecos: [
      {
        checklistItemId: requisitoId,
        queFalta: 'No hay evidencia adjunta que muestre la validación con usuarios',
        comoCerrarlo: 'Adjunta la evidencia de la sesión de validación',
      },
    ],
    confianzaPropuesta: 'media',
    citas: [{ fragmento: 'El journey está validado', localizacion: 'requisito 1' }],
  });

  const CONTENIDO_C6 = (criterioId: string): ContenidoEntradaKpi => ({
    criterioId,
    nombre: 'Tasa de verificación completada en móvil',
    definicion: 'Verificaciones completadas / verificaciones iniciadas, solo en app móvil',
    fuente: 'Eventos de la app, tablero de onboarding',
    dimensiones: 'canal, segmento',
    frecuencia: 'mensual',
    confianzaPropuesta: 'media',
    citas: [{ fragmento: 'Tiempo de verificación', localizacion: 'KPI del criterio' }],
  });

  /**
   * El contenido de prueba de cada capacidad, por su nombre.
   *
   * `Record<CapacidadActiva, …>` y no un ternario: los fixtures escribían
   * `capacidad === 'CI' ? CONTENIDO_CI : CONTENIDO_C0`, que es el mismo idioma binario que
   * todo este slice vino a quitar — con una tercera capacidad, sus propuestas de prueba
   * habrían nacido con el contenido de C0 y los casos habrían medido otra cosa.
   */
  const CONTENIDO_POR_CAPACIDAD: Record<CapacidadActiva, ContenidoPropuesta> = {
    CI: CONTENIDO_CI,
    C0: CONTENIDO_C0,
    // Se resuelve tarde porque `requisitoIds` se llena en el `beforeAll`; quien necesite el
    // hueco apuntando a otro requisito pasa su propio contenido.
    get CT() {
      return CONTENIDO_CT(requisitoIds[0]!);
    },
    /* Igual que CT: se resuelve tarde porque la evidencia se crea en el `beforeAll`, y su id
     * tiene que ser REAL — el guard exige que sea del reto. */
    get C2() {
      return CONTENIDO_C2(evidenciaDelRetoId);
    },
    /*
     * C5 no tiene un contenido de fixture útil por omisión: cada remediación tiene que
     * señalar una señal que `validarJourney` emitió sobre SU journey, y eso depende del grafo
     * concreto. Quien lo necesite lo compone con `remediacionDe(journey)`; esta entrada
     * existe para que el registro esté completo y para que una propuesta de C5 sin contenido
     * explícito falle en voz alta en vez de nacer señalando una señal ajena.
     */
    C5: {
      resumen: 'Fixture sin señales: compón el contenido con remediacionDe(journey).',
      remediaciones: [],
      citas: [{ fragmento: 'NODOS', localizacion: 'cabecera del grafo' }],
      confianzaPropuesta: 'baja',
    } satisfies ContenidoRemediacionJourney,
    /* Igual que CT y C2: se resuelve tarde porque el criterio se crea en el `beforeAll`, y su
     * id tiene que ser REAL — el guard exige que el criterio sea del reto del registry. */
    get C6() {
      return CONTENIDO_C6(criterioDelRegistryId);
    },
    /* Igual que los tres anteriores: se resuelve tarde porque el insight se crea en el
     * `beforeAll`, y su id tiene que ser REAL — la traza se materializa desde las citas, así
     * que un id inventado no llega ni a insertar el enlace. */
    get C3() {
      return CONTENIDO_C3(insightValidadoDelRetoId);
    },
  };

  /**
   * Las columnas de ancla y sus valores, DERIVADOS del registro.
   *
   * Los fixtures escribían `item_id, reto_id` a mano en los dos inserts, que es la misma
   * pareja fija que el servicio dejó de escribir. Con una tercera ancla, las propuestas de
   * prueba nacían sin su enlace y los casos que las usaran medirían un pipeline distinto del
   * que corre.
   */
  function anclasDeFixture(
    tx: TransactionSql,
    anclas: Partial<Record<AnclaCapacidad['columna'], string>> = {},
  ): { columnas: PendingQuery<Row[]>; valores: PendingQuery<Row[]> } {
    const unir = (partes: PendingQuery<Row[]>[]) => partes.reduce((a, b) => tx`${a}, ${b}`);
    return {
      columnas: unir(COLUMNAS_DE_ANCLA.map((c) => tx`${tx(c)}`)),
      valores: unir(COLUMNAS_DE_ANCLA.map((c) => tx`${anclas[c] ?? null}`)),
    };
  }

  /**
   * Un gate PENDIENTE nuevo con su checklist. Cada caso de CT necesita el suyo: el índice
   * parcial `propuesta_ai_gate_pendiente_idx` no deja dos informes sin leer sobre el mismo
   * gate, que es justamente lo que ese índice existe para impedir.
   *
   * Con su PROYECTO propio, y eso no es aspaviento: `gate_instancia` exige `(proyecto_id,
   * numero)` único y acota el número a 0..7, así que un proyecto da para ocho gates y el del
   * fixture ya gasta uno. Un proyecto por caso quita el techo y además aísla: dos casos no
   * comparten el contador ni el orden en que corrieron.
   *
   * El gate es siempre el 3 porque su rol aprobador lo fija un CHECK por número —0, 3, 5 y 6
   * los aprueba el sponsor— y con proyecto propio no hace falta variarlo.
   *
   * Devuelve también el CONTENIDO de un informe suyo: el hueco tiene que señalar un requisito
   * DE ESTE gate o el guard lo rechaza, así que dejar que cada caso lo componga a mano era
   * una trampa puesta a propósito para uno mismo.
   */
  let siguienteProyecto = 81;
  async function nuevoGate(): Promise<{
    gateId: string;
    requisitos: string[];
    contenido: ContenidoAsistenteGate;
  }> {
    const admin = sqlAdmin();
    const codigo = `P-${siguienteProyecto++}`;
    const [proy] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, ${codigo}, ${`Proyecto ${codigo}`}, ${leadId}) returning id`;
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proy!.id as string}, 3, 'sponsor') returning id`;
    const gid = g!.id as string;
    const req = await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${ws}, ${gid}, 1, 'El journey está validado con usuarios reales'),
             (${ws}, ${gid}, 2, 'El blueprint declara sus puntos de fallo')
      returning id`;
    const requisitos = req.map((c) => c.id as string);
    return { gateId: gid, requisitos, contenido: CONTENIDO_CT(requisitos[0]!) };
  }

  /**
   * C2 — un insight con su afirmación y la cita que la sostiene.
   *
   * El fragmento es LITERAL del resumen de la evidencia, que es lo que `materialDeInsights`
   * mete en el cuerpo del bloque: así la presencia se mide de verdad y no por casualidad.
   */
  const CONTENIDO_C2 = (evidenciaId: string): ContenidoInsight => ({
    titulo: 'La verificación documental es donde se pierde la gente',
    resumen: 'El abandono se concentra en la carga del documento, no en el alta.',
    afirmaciones: [
      {
        texto: 'La mayoría de los abandonos ocurre al cargar el documento',
        esHipotesis: false,
        citas: [{ evidenciaId, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' }],
      },
    ],
    contradicciones: [],
    confianzaPropuesta: 'media',
  });
  const CONTENIDO_C3 = (insightId: string): ContenidoOportunidad => ({
    pregunta: '¿Cómo podríamos verificar sin pedir un documento que no está a mano?',
    prioridad: 700,
    prioridadRazon:
      'Mueve el criterio del tiempo de verificación: es donde se pierde la mayoría.',
    citas: [
      { insightId, fragmento: 'Quien no lleva el documento encima', localizacion: 'resumen' },
    ],
    confianzaPropuesta: 'media',
  });
  /**
   * Un journey mínimo con SEÑALES de verdad: dos pasos encadenados dentro de una fase.
   *
   * Se construye para que `validarJourney` emita algo —el segundo paso no tiene salida, y
   * ninguno de los dos tiene evidencia enlazada— y NO se le escriben las señales a mano: lo
   * que C5 comprueba es que las remediaciones señalen señales que esa función produce, así
   * que el fixture tiene que producirlas de verdad o la prueba mediría su propia copia.
   *
   * `conSalida` cierra el ciclo para el caso contrario: un grafo del que la validación no
   * tiene nada que decir. Ése es el que prueba que no se llama al proveedor por gusto.
   */
  let siguienteJourney = 1;
  async function nuevoJourney(
    ctx: { ws: string; actorId: string; servicioId: string; retoId: string },
    opciones: { limpio?: boolean } = {},
  ): Promise<{ journeyId: string; nodos: { fase: string; uno: string; dos: string } }> {
    const admin = sqlAdmin();
    const { ws, actorId: leadId, servicioId: svcId, retoId } = ctx;
    const n = siguienteJourney++;
    const [j] = await admin`insert into journey
      (workspace_id, servicio_id, reto_id, tipo, nombre, descripcion, creado_por)
      values (${ws}, ${svcId}, ${retoId}, 'as-is', ${`Alta de cuenta ${n}`}, '', ${leadId})
      returning id`;
    const journeyId = j!.id as string;
    const [fase] = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, detalle, orden, responsable, creado_por)
      values (${ws}, ${journeyId}, 'fase', 'Alta', '', 0, '', ${leadId}) returning id`;
    const pasos = await admin`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, detalle, fase_id, orden, responsable, creado_por)
      values (${ws}, ${journeyId}, 'paso', 'Recibir documento', '', ${fase!.id as string}, 0,
              'Front', ${leadId}),
             (${ws}, ${journeyId}, 'paso', 'Verificar identidad', '', ${fase!.id as string}, 1,
              'Back', ${leadId})
      returning id`;
    const [uno, dos] = pasos.map((x) => x.id as string);
    await admin`insert into journey_arista
      (workspace_id, journey_id, origen_id, destino_id, tipo, condicion, creado_por)
      values (${ws}, ${journeyId}, ${uno!}, ${dos!}, 'transicion', '', ${leadId})`;
    if (opciones.limpio) {
      /*
       * Para que la validación no tenga NADA que decir hacen falta las dos cosas: que el
       * último paso tenga salida —se añade un tercero y se cierra— y que todos los pasos
       * lleven evidencia. Se pregunta por el resultado (cero señales) en la propia prueba, no
       * se da por hecho aquí.
       */
      const [tres] = await admin`insert into journey_nodo
        (workspace_id, journey_id, tipo, etiqueta, detalle, fase_id, orden, responsable, creado_por)
        values (${ws}, ${journeyId}, 'paso', 'Entregar cuenta', '', ${fase!.id as string}, 2,
                'Front', ${leadId}) returning id`;
      await admin`insert into journey_arista
        (workspace_id, journey_id, origen_id, destino_id, tipo, condicion, creado_por)
        values (${ws}, ${journeyId}, ${dos!}, ${tres!.id as string}, 'transicion', '', ${leadId})`;
      /*
       * Una evidencia PROPIA, con su fuente y su registro de derechos (SPEC-03, trigger
       * diferido). No se reutiliza «la primera del workspace»: en un workspace efímero no hay
       * ninguna, y el `if (ev)` que lo cubría dejaba el journey sin enlazar y el fixture
       * mentía — salía con tres señales `paso-sin-evidencia` diciéndose limpio.
       */
      const [fuente] = await admin`insert into fuente
        (workspace_id, tipo, titulo, referencia, creado_por)
        values (${ws}, 'documento', 'Fuente del journey', 'ref', ${leadId}) returning id`;
      const [ev] = await admin`insert into evidencia
        (workspace_id, fuente_id, titulo, resumen, dimensiones, creado_por)
        values (${ws}, ${fuente!.id as string}, 'Evidencia del journey', '', '{}'::jsonb,
                ${leadId}) returning id`;
      await admin`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
        values (${ws}, ${ev!.id as string}, ${leadId})`;
      for (const nodo of [uno!, dos!, tres!.id as string]) {
        await admin`insert into journey_nodo_evidencia
          (workspace_id, nodo_id, evidencia_id, creado_por)
          values (${ws}, ${nodo}, ${ev!.id as string}, ${leadId})`;
      }
    }
    return { journeyId, nodos: { fase: fase!.id as string, uno: uno!, dos: dos! } };
  }

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
      // Lo rellena el doble al abrir la línea; aquí solo tiene que existir para el tipo.
      registroId: '',
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
    capacidad: CapacidadActiva;
    anclas: Partial<Record<AnclaCapacidad['columna'], string>>;
  }): Promise<string> {
    const [l] = await conUsuario(
      leadId,
      (tx) => tx`
      insert into llamada_ai (workspace_id, capacidad, ${anclasDeFixture(tx).columnas},
                              modelo, origen_key,
                              resultado, tokens_entrada, tokens_salida, costo_usd,
                              latencia_ms, consentimiento_version, creado_por)
      values (${ws}, ${campos.capacidad}, ${anclasDeFixture(tx, campos.anclas).valores},
              ${MODELO_PRIMARIO}, 'entorno', 'salida-valida', 1200, 300,
              ${costoDeUso(MODELO_PRIMARIO, USO_CI)}, 900,
              -- La misma regla que aplica el servicio, y que la base exige en las dos
              -- direcciones: se cita el permiso vigente si el tipo de fuente lo exige, y no
              -- se cita nada si no. Escrita aquí para que el fixture no tenga que saberla
              -- item por item.
              (select case when tipo_fuente_exige_consentimiento(i.tipo_fuente)
                        then (select max(c.version) from consentimiento_item c
                               where c.item_id = i.id and c.workspace_id = i.workspace_id)
                      end
                 from item_importacion i
                where i.id = ${campos.anclas.item_id ?? null} and i.workspace_id = ${ws}),
              ${leadId})
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
      capacidad: CapacidadActiva;
      anclas: Partial<Record<AnclaCapacidad['columna'], string>>;
      /** Solo para forzar un estado que el registro NO declara (probar un CHECK de la base).
       * En el uso normal se omite y sale de `CAPACIDADES`, que es lo que hace el servicio. */
      destino?: Destino | null;
      contenido?: ContenidoPropuesta;
    },
  ): Promise<string> {
    const contenido = campos.contenido ?? CONTENIDO_POR_CAPACIDAD[campos.capacidad];
    const destino =
      campos.destino === undefined ? CAPACIDADES[campos.capacidad].destino : campos.destino;
    const llamadaId = await nuevaLlamada({ capacidad: campos.capacidad, anclas: campos.anclas });
    const [p] = await conUsuario(
      actorId,
      (tx) => tx`
      insert into propuesta_ai
        (workspace_id, capacidad, destino, ${anclasDeFixture(tx).columnas},
         contenido, contenido_original,
         confianza, modelo, prompt_version, alcance_resumen, huella_material,
         alcance_evidencia, alcance_insights, origen_key,
         llamada_id, creado_por)
      values (${ws}, ${campos.capacidad}, ${destino},
              ${anclasDeFixture(tx, campos.anclas).valores},
              ${tx.json(contenido)}, ${tx.json(contenido)},
              0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'alcance de prueba',
              -- La huella que la base exige a las capacidades que la declaran. NO es la del
              -- material de verdad: componerlo aquí sería copiar en el fixture el prompt que
              -- se está probando. Las que la leen dirán «material cambiado», que es lo que
              -- corresponde a una fila escrita a mano sin pasar por la generación.
              'huella-del-material',
              -- Y el alcance de evidencia, que C2 declara igual que la huella. Sale de la
              -- consulta real cuando la propuesta cuelga de un reto: escribir aquí una lista
              -- a mano fijaría en el fixture justo lo que el suelo compara contra la base.
              -- Para las demás capacidades no aplica y va nulo, como el CHECK permite.
              ${campos.anclas.reto_id ? ALCANCE_DEL_RETO(tx, ws, campos.anclas.reto_id) : null},
              -- Y el alcance de INSIGHTS, que C3 declara igual. Sale de la misma función que
              -- usan el guard y el panel —no de una lista escrita aquí— por lo mismo que el de
              -- evidencia: una copia en el fixture fijaría justo lo que el suelo compara.
              -- Solo para C3: el CHECK deja nulo a las demás.
              ${
                campos.capacidad === 'C3' && campos.anclas.reto_id
                  ? tx`array(select v.id from insights_validados_del_reto(
                        ${campos.anclas.reto_id}, ${ws}) as v(id))`
                  : null
              },
              'entorno', ${llamadaId}, ${actorId})
      returning id`);
    return p!.id as string;
  }

  /**
   * Una transacción que escribe, SE QUEDA CON EL CANDADO y no commitea hasta que se la suelta
   * — y, con ella, la espera DETERMINISTA a que otra transacción se pare detrás.
   *
   * Cada una de estas sondas eran antes dos plazos fijos: 150 ms para dar por hecho que el
   * candado ya estaba tomado, y 1500 ms para dar por hecho que la contendiente ya estaba
   * esperándolo. El segundo se rompió en la CI, que corre las 730 en cuatro procesos contra un
   * Postgres compartido: si la contendiente no llega a PEDIR el candado dentro del plazo, se
   * suelta antes de que nadie lo pida y lo que la sonda mide deja de ser la espera. Y entonces
   * la prueba no falla por lo suyo — falla porque el rechazo entra por otra puerta, la lectura
   * SIN candado que hay antes, y trae otro mensaje.
   *
   * `pg_blocking_pids` cambia el plazo por una pregunta que contesta la base: ¿hay alguien
   * esperando por ESTE backend? Vale igual para los candados de fila —donde se espera por el
   * xid— que para los de aviso. La sonda pasa así a afirmar lo que su prosa dice: que la otra
   * transacción ESPERÓ. El presupuesto solo acota el caso patológico; agotado, se sigue como
   * antes y es la aserción de la sonda la que cuenta qué pasó.
   */
  async function esperaAQueAlguienEspere(pid: number, presupuestoMs = 10_000): Promise<void> {
    const admin = sqlAdmin();
    const limite = Date.now() + presupuestoMs;
    for (;;) {
      const [f] = await admin`select count(*)::int as n from pg_stat_activity
        where ${pid} = any (pg_blocking_pids(pid))`;
      if ((f!.n as number) > 0 || Date.now() > limite) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function candadoEnVuelo(escribir: (tx: TransactionSql) => Promise<unknown>) {
    const admin = sqlAdmin();
    let soltar: () => void = () => {};
    const enVuelo = new Promise<void>((r) => {
      soltar = r;
    });
    let anunciar: (pid: number) => void = () => {};
    const tomado = new Promise<number>((r) => {
      anunciar = r;
    });
    const terminado = admin.begin(async (tx) => {
      const [p] = await tx`select pg_backend_pid()::int as pid`;
      await escribir(tx);
      anunciar(p!.pid as number);
      await enVuelo;
    });
    const guardia = terminado.then(
      () => {
        throw new Error('el candado en vuelo se soltó antes de llegar a tomarse');
      },
      (e: Error) => {
        throw new Error(`la escritura del candado en vuelo falló: ${e.message}`);
      },
    );
    guardia.catch(() => {}); // gana `tomado`: no dejar suelto el rechazo del perdedor
    // No se vuelve hasta que la escritura SALIÓ. Esto es lo que sustituye al plazo de 150 ms.
    const pid = await Promise.race([tomado, guardia]);
    return {
      terminado,
      soltar,
      esperaAQueAlguienEspere: (presupuestoMs?: number) =>
        esperaAQueAlguienEspere(pid, presupuestoMs),
    };
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
      // El linaje va de la fila materializada HACIA la propuesta, así que hay que soltarlo
      // antes de borrarla. Es la contrapartida de que la columna sea inescribible por la
      // aplicación: solo una conexión de administración puede deshacer el vínculo.
      await admin`update evidencia set propuesta_ai_id = null where workspace_id = ${wsL}`;
      await admin`update criterio_exito set propuesta_ai_id = null where workspace_id = ${wsL}`;
      // `insight` y `propuesta_ai` se referencian en los DOS sentidos —la propuesta apunta al
      // objeto que materializó y el objeto lleva el sello de su procedencia—, así que el ciclo
      // se rompe soltando el sello y borrando la propuesta primero; el insight se va después,
      // con su descendencia, de la hoja a la raíz.
      await admin`update insight set propuesta_ai_id = null where workspace_id = ${wsL}`;
      // Y `entrada_kpi`, que es el CUARTO destino y llegó con C6. Faltaba porque hasta ahora
      // ninguna sonda de este arnés había aceptado una propuesta de C6 dentro de un workspace
      // efímero: sin esta línea la limpieza muere en la FK del sello, y el fallo aparece como
      // un `miembro_usuario_id_fkey` al final, que no dice nada de dónde está.
      await admin`update entrada_kpi set propuesta_ai_id = null where workspace_id = ${wsL}`;
      await admin`update oportunidad set propuesta_ai_id = null where workspace_id = ${wsL}`;
      await admin`delete from propuesta_ai where workspace_id = ${wsL}`;
      await admin`delete from llamada_ai where workspace_id = ${wsL}`;
      await admin`delete from reserva_ai where workspace_id = ${wsL}`;
      await admin`delete from consentimiento_item where workspace_id = ${wsL}`;
      await admin`delete from item_importacion where workspace_id = ${wsL}`;
      // El registry cuelga del reto y hay pruebas que lo firman para congelar sus
      // criterios; sin esta línea la limpieza muere en el `delete from reto`.
      await admin`delete from entrada_kpi where workspace_id = ${wsL}`;
      await admin`delete from metric_registry where workspace_id = ${wsL}`;
      await admin`delete from derecho_uso where workspace_id = ${wsL}`;
      await admin`delete from criterio_exito where workspace_id = ${wsL}`;
      // Y la oportunidad con su traza, que es el QUINTO destino y llega con C3. Va aquí y no
      // más abajo porque apunta a los dos lados: su traza cuelga de `insight` —que se borra
      // justo debajo— y ella misma del `reto`, que se borra al final.
      await admin`delete from oportunidad_insight where workspace_id = ${wsL}`;
      await admin`delete from oportunidad where workspace_id = ${wsL}`;
      await admin`delete from cita where workspace_id = ${wsL}`;
      await admin`delete from contradiccion where workspace_id = ${wsL}`;
      await admin`delete from afirmacion where workspace_id = ${wsL}`;
      await admin`delete from insight where workspace_id = ${wsL}`;
      // El enlace reto→arquetipo→evidencia por delante de sus dos extremos, y el arquetipo
      // por delante del reto. La evidencia NO va aquí: la sujeta también el grafo del journey,
      // que se borra más abajo.
      await admin`delete from arquetipo_evidencia where workspace_id = ${wsL}`;
      await admin`delete from arquetipo where workspace_id = ${wsL}`;
      // El journey cuelga del reto por FK compuesta, así que va antes que él. Y su grafo
      // antes que él: nodos, aristas y los enlaces a evidencia.
      // El snapshot cuelga del journey por FK compuesta: va antes que el grafo.
      await admin`delete from journey_snapshot where workspace_id = ${wsL}`;
      await admin`delete from journey_nodo_evidencia where workspace_id = ${wsL}`;
      await admin`delete from journey_arista where workspace_id = ${wsL}`;
      await admin`delete from journey_nodo where workspace_id = ${wsL}`;
      await admin`delete from journey where workspace_id = ${wsL}`;
      // La evidencia y su fuente van DESPUÉS del grafo: el journey «limpio» del fixture las
      // enlaza a sus pasos, y `journey_nodo_evidencia` las sujeta por FK.
      await admin`delete from evidencia where workspace_id = ${wsL}`;
      await admin`delete from fuente where workspace_id = ${wsL}`;
      await admin`delete from checklist_item where workspace_id = ${wsL}`;
      await admin`delete from gate_instancia where workspace_id = ${wsL}`;
      await admin`delete from etapa_instancia where workspace_id = ${wsL}`;
      await admin`delete from proyecto where workspace_id = ${wsL}`;
      await admin`delete from reto where workspace_id = ${wsL}`;
      await admin`delete from servicio where workspace_id = ${wsL}`;
      await admin`delete from miembro where workspace_id = ${wsL}`;
      // Otra vez los eventos, y no es redundante: los escriben TRIGGERS, así que los borrados
      // de arriba dejan los suyos. El primer barrido limpia lo que la prueba produjo; éste,
      // lo que produjo la limpieza.
      await admin`delete from evento_dominio where workspace_id = ${wsL}`;
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
    // Un proyecto con un gate PENDIENTE y su checklist: el ancla de CT. Los dos requisitos
    // están en estados distintos a propósito —uno pendiente y sin objeto, otro cumplido con
    // evidencia sería otro fixture— para que el material que ve el modelo tenga las dos
    // formas de línea.
    const [proy] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${ws}, ${retoId}, 'P-80', 'Proyecto AI', ${leadId}) returning id`;
    proyectoId = proy!.id as string;
    const [g] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${ws}, ${proyectoId}, 3, 'sponsor') returning id`;
    gateId = g!.id as string;
    const req = await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${ws}, ${gateId}, 1, 'El journey está validado con usuarios reales'),
             (${ws}, ${gateId}, 2, 'El blueprint declara sus puntos de fallo')
      returning id`;
    requisitoIds = req.map((c) => c.id as string);
    /*
     * La evidencia del reto, por el ÚNICO camino que hay: `evidencia` no cuelga de un reto,
     * cuelga del workspace, y lo que la ata a uno son sus ARQUETIPOS. Sin este enlace, C2 no
     * ofrecería el reto y su generación se negaría — que es correcto, y por eso el fixture lo
     * monta en vez de darlo por hecho.
     */
    const [arq] = await admin`insert into arquetipo
      (workspace_id, reto_id, nombre, definicion, creado_por)
      values (${ws}, ${retoId}, 'Titular primerizo', 'Abre su primera cuenta', ${leadId})
      returning id`;
    const [fte] = await admin`insert into fuente
      (workspace_id, tipo, titulo, referencia, creado_por)
      values (${ws}, 'documento', 'Funnel de verificación', 'ref-funnel', ${leadId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, resumen, dimensiones, creado_por)
      values (${ws}, ${fte!.id as string}, 'Abandono en verificación',
              'El 71% de los abandonos ocurre al cargar el documento.', '{}'::jsonb, ${leadId})
      returning id`;
    evidenciaDelRetoId = ev!.id as string;
    /*
     * Con derechos CONCEDIDOS y de ámbito cliente, no con el `derecho_uso` por defecto: citar
     * una evidencia exige que sea usable (SPEC-03/SYS-14, `evidencia_citable_guard`), y el
     * registro nace `pendiente`/`interno`, que no lo es. Materializar un insight es escribir
     * `cita`, así que sin esto la aceptación de C2 muere en el guard de derechos — que es la
     * conducta correcta y tiene su propio caso; aquí lo que se mide es otra cosa.
     */
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${ws}, ${evidenciaDelRetoId}, 'concedido', 'cliente',
              'Consentimiento del participante', ${leadId}, now(), ${leadId})`;

    /*
     * Y el ancla de C6: el contrato de medición del reto, en borrador, con un criterio real al
     * que una entrada KPI pueda responder. El criterio tiene que existir de verdad porque el
     * guard de la materialización exige que sea del reto DEL REGISTRY, y la cita se mide contra
     * su texto.
     */
    const [crit] = await admin`insert into criterio_exito
      (workspace_id, reto_id, kpi, definicion, objetivo, ventana_dias, linea_base_plan, creado_por)
      values (${ws}, ${retoId}, 'Tiempo de verificación',
              'Minutos medianos desde iniciar hasta completar la verificación',
              'Bajar de 8 a 4 minutos', 90, 'Medir dos semanas antes del release', ${leadId})
      returning id`;
    criterioDelRegistryId = crit!.id as string;
    const [mr] = await admin`insert into metric_registry (workspace_id, reto_id, creado_por)
      values (${ws}, ${retoId}, ${leadId}) returning id`;
    registryId = mr!.id as string;
    await admin`insert into arquetipo_evidencia (workspace_id, arquetipo_id, evidencia_id)
      values (${ws}, ${arq!.id as string}, ${evidenciaDelRetoId})`;
    /*
     * Un insight VALIDADO del reto, que es el material de C3.
     *
     * «Del reto» no es una columna: un insight pertenece a un reto si alguna de sus
     * afirmaciones cita evidencia que cuelga de un arquetipo suyo. Por eso el fixture tiene
     * que montar la cadena entera —afirmación → cita → esa evidencia— y no basta con crear un
     * insight en el workspace: `insights_validados_del_reto` lo recorrería y no lo
     * encontraría, y las propuestas de C3 del fixture nacerían con un id que el guard rechaza.
     */
    const [ins] = await admin`insert into insight
      (workspace_id, titulo, resumen, estado, validado_por, validado_en, creado_por)
      values (${ws}, 'La verificación excluye a quien no tiene el documento a mano',
              'Quien no lleva el documento encima abandona y no vuelve.',
              'validado', ${leadId}, now(), ${leadId})
      returning id`;
    insightValidadoDelRetoId = ins!.id as string;
    const [af] = await admin`insert into afirmacion
      (workspace_id, insight_id, orden, texto, es_hipotesis)
      values (${ws}, ${insightValidadoDelRetoId}, 0,
              'El abandono se concentra en la carga del documento', false)
      returning id`;
    await admin`insert into cita
      (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
      values (${ws}, ${af!.id as string}, ${evidenciaDelRetoId},
              'El 71% de los abandonos', 'resumen', ${leadId})`;
  });

  afterAll(async () => {
    const admin = sqlAdmin();
    if (ws) {
      await admin`delete from evento_dominio where workspace_id = ${ws}`;
      await admin`delete from reserva_ai where workspace_id = ${ws}`;
      await admin`update evidencia set propuesta_ai_id = null where workspace_id = ${ws}`;
      await admin`update criterio_exito set propuesta_ai_id = null where workspace_id = ${ws}`;
      // Y la oportunidad, que es el QUINTO destino con sello. Cada uno que llega añade su
      // línea aquí, y olvidarla no falla donde está: la limpieza muere en la FK y el error
      // sale al final nombrando otra tabla.
      await admin`update oportunidad set propuesta_ai_id = null where workspace_id = ${ws}`;
      // Ver la nota de `enWorkspaceLimpio`: el sello va de la propuesta al insight y del
      // insight a la propuesta, así que se suelta antes de borrar ninguno de los dos.
      await admin`update insight set propuesta_ai_id = null where workspace_id = ${ws}`;
      // Y lo mismo con la entrada KPI, que es el cuarto objeto sellado. El sello va en los dos
      // sentidos —`propuesta_ai.entrada_kpi_id` y `entrada_kpi.propuesta_ai_id`—, así que hay
      // que soltarlo antes de borrar cualquiera de los dos extremos.
      await admin`update entrada_kpi set propuesta_ai_id = null where workspace_id = ${ws}`;
      await admin`delete from propuesta_ai where workspace_id = ${ws}`;
      await admin`delete from llamada_ai where workspace_id = ${ws}`;
      await admin`delete from consentimiento_item where workspace_id = ${ws}`;
      await admin`delete from item_importacion where workspace_id = ${ws}`;
      // El contrato de medición, por delante de los criterios: `entrada_kpi` referencia a los
      // dos, y el registry al reto.
      await admin`delete from entrada_kpi where workspace_id = ${ws}`;
      await admin`delete from metric_registry where workspace_id = ${ws}`;
      await admin`delete from criterio_exito where workspace_id = ${ws}`;
      await admin`delete from cita where workspace_id = ${ws}`;
      await admin`delete from contradiccion where workspace_id = ${ws}`;
      await admin`delete from afirmacion where workspace_id = ${ws}`;
      await admin`delete from insight where workspace_id = ${ws}`;
      // El registro de derechos de SPEC-03 cuelga de la evidencia por FK: sin esta línea la
      // limpieza muere al borrarla. Va aquí y no antes porque toda evidencia que este
      // fichero crea nace ya con el suyo, que es justo lo que exige el trigger diferido.
      await admin`delete from derecho_uso where workspace_id = ${ws}`;
      // El enlace reto→arquetipo→evidencia que monta el fixture de C2 va por delante de sus
      // dos extremos: `arquetipo_evidencia` referencia la evidencia (y el arquetipo, el reto),
      // así que sin estas dos líneas la limpieza muere en la FK y deja el workspace en pie.
      await admin`delete from arquetipo_evidencia where workspace_id = ${ws}`;
      await admin`delete from evidencia where workspace_id = ${ws}`;
      await admin`delete from fuente where workspace_id = ${ws}`;
      await admin`delete from arquetipo where workspace_id = ${ws}`;
      await admin`delete from journey_snapshot where workspace_id = ${ws}`;
      await admin`delete from journey_nodo_evidencia where workspace_id = ${ws}`;
      await admin`delete from journey_arista where workspace_id = ${ws}`;
      await admin`delete from journey_nodo where workspace_id = ${ws}`;
      await admin`delete from journey where workspace_id = ${ws}`;
      await admin`delete from checklist_item where workspace_id = ${ws}`;
      await admin`delete from gate_instancia where workspace_id = ${ws}`;
      await admin`delete from etapa_instancia where workspace_id = ${ws}`;
      await admin`delete from proyecto where workspace_id = ${ws}`;
      await admin`delete from reto where workspace_id = ${ws}`;
      await admin`delete from servicio where workspace_id = ${ws}`;
      await admin`delete from miembro where workspace_id = ${ws}`;
      // Otra vez los eventos: los escriben TRIGGERS, así que los borrados de arriba —el del
      // journey, entre otros— dejan los suyos después del primer barrido.
      await admin`delete from evento_dominio where workspace_id = ${ws}`;
      await admin`delete from workspace where id = ${ws}`;
    }
    await admin`delete from usuario where email like ${marca + '-%@test.demo'}`;
    await cerrarPools();
  });

  it('la propuesta nace pendiente, atribuida y con su original intacto; un stakeholder no la crea', async () => {
    const itemId = await nuevoItem('Notas de funnel');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      anclas: { item_id: itemId },
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
      nuevaPropuesta(stakeId, { capacidad: 'CI', anclas: { item_id: itemId } }),
    ).rejects.toThrow(/row-level security/);
    // Y el rol `agente-ai` tampoco: no es un actor que proponga por su cuenta (SYS-18).
    await expect(
      nuevaPropuesta(agenteId, { capacidad: 'CI', anclas: { item_id: itemId } }),
    ).rejects.toThrow(/row-level security/);
  });

  it('una propuesta no puede nacer ya decidida ni con un «original» distinto de lo propuesto', async () => {
    const itemId = await nuevoItem('Item para altas forzadas');
    const llamadaId = await nuevaLlamada({ capacidad: 'CI', anclas: { item_id: itemId } });
    // Nacer aceptada saltaría la firma humana, y ahora se corta una capa ANTES de la
    // política: `estado` y `revisada_por` no están en el grant de INSERT —solo en el de
    // UPDATE—, así que la aplicación ni siquiera tiene superficie para nombrarlos al dar de
    // alta. El DEFAULT pone 'propuesta' y no hay forma de decir otra cosa.
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, estado, revisada_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                ${MODELO_PRIMARIO}, 'v', 'entorno', ${llamadaId}, ${leadId}, 'aceptada',
                ${leadId})`),
    ).rejects.toThrow(/permission denied/i);
    // Y el suelo sigue debajo del grant, que es lo que importa: por la vía privilegiada —sin
    // RLS y sin grants— la fila tampoco entra, porque una propuesta decidida sin objeto
    // materializado es un estado que los CHECK hacen imposible (SYS-19).
    await expect(
      sqlAdmin()`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, estado, revisada_por,
         revisada_en)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                ${MODELO_PRIMARIO}, 'v', 'entorno', ${llamadaId}, ${leadId}, 'aceptada',
                ${leadId}, now())`,
    ).rejects.toThrow(/check constraint/i);
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

  it('la evidencia aceptada nace con su registro de derechos, y nace PENDIENTE', async () => {
    // SPEC-03 exige que toda evidencia tenga su fila en `derecho_uso` al commit, y la
    // materialización de una propuesta la crea en la MISMA transacción. Sin esto, aceptar
    // una extracción fallaba siempre: la capacidad entera quedaba inservible.
    //
    // Y nace PENDIENTE, igual que en la curaduría a mano. Esa paridad es la regla: aceptar
    // una propuesta ES la escritura humana, con los MISMOS controles, no un atajo alrededor
    // de uno que la ruta manual sí impone. Conceder el uso es otro acto, con su base
    // documental y su responsable — y jamás se deriva de lo que dijera el modelo ni de los
    // metadatos del item, que sería fabricar consentimiento a partir de un texto.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item con derechos por decidir');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      anclas: { item_id: itemId },
    });
    const { objetoId } = await aceptarPropuesta(leadId, { workspaceId: ws, propuestaId });
    try {
      const [derecho] = await admin`select estado, ambito, base, decidido_por, decidido_en,
                                           creado_por
        from derecho_uso where evidencia_id = ${objetoId} and workspace_id = ${ws}`;
      expect(derecho).toBeDefined();
      expect(derecho!.estado).toBe('pendiente');
      expect(derecho!.ambito).toBe('interno');
      expect(derecho!.base).toBe('');
      expect(derecho!.decidido_por).toBe(null);
      expect(derecho!.decidido_en).toBe(null);
      // Lo firma quien aceptó, que es quien acaba de curar.
      expect(derecho!.creado_por).toBe(leadId);
      // Y la consecuencia que importa: la evidencia existe pero todavía NO se puede usar
      // hacia el cliente. Fail-closed, exactamente igual que si la hubiera curado a mano.
      const [usable] = await admin`select
        evidencia_usable(${objetoId as string}, ${ws}, 'cliente') as ok`;
      expect(usable!.ok).toBe(false);
    } finally {
      // Este test comparte workspace, y el siguiente comprueba que empieza SIN evidencias:
      // lo que se materializa aquí se retira aquí.
      const [ev] = await admin`select fuente_id from evidencia where id = ${objetoId}`;
      await admin`update evidencia set propuesta_ai_id = null where id = ${objetoId}`;
      await admin`delete from propuesta_ai where id = ${propuestaId}`;
      await admin`delete from llamada_ai where item_id = ${itemId}`;
      await admin`delete from item_importacion where id = ${itemId}`;
      await admin`delete from derecho_uso where evidencia_id = ${objetoId}`;
      await admin`delete from evidencia where id = ${objetoId}`;
      await admin`delete from fuente where id = ${ev!.fuente_id as string}`;
    }
  });

  it('aceptar materializa la evidencia firmada por el humano y sella el item (SYS-16/SYS-19)', async () => {
    const itemId = await nuevoItem('Item que se acepta');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      anclas: { item_id: itemId },
    });

    // Antes de aceptar, la propuesta no ha materializado NADA. La sonda pregunta por esta
    // propuesta y no por «el workspace no tiene evidencia», que medía otra cosa: aquel conteo
    // solo daba cero mientras el fixture no creara evidencia por su cuenta, y desde que C2
    // ancla en el reto —y la evidencia solo llega a un reto por sus arquetipos— el workspace
    // nace con la suya. Preguntar por el vínculo es lo que la prueba quería decir.
    const antes = await conUsuario(leadId, (tx) => tx`
      select 1 as x from evidencia where propuesta_ai_id = ${propuestaId}`);
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
      anclas: { item_id: itemId },
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
      anclas: { item_id: otroItem },
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
      anclas: { item_id: itemId },
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
    // La cita inventada sigue marcada como no presenteLiteral: la señal sobrevive a la corrección.
    expect(decidida.citas.map((c) => c.presenteLiteral)).toEqual([true, false]);
  });

  it('una propuesta cuelga de la llamada que la produjo, no de cualquiera', async () => {
    const itemId = await nuevoItem('Item con llamadas cruzadas');
    // Una llamada de OTRA capacidad y otra ancla: la FK la aceptaba (existe y es del
    // workspace) y el panel le habría atribuido su coste y su latencia a esta propuesta.
    const llamadaC0 = await nuevaLlamada({ capacidad: 'C0', anclas: { reto_id: retoId } });
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
      nuevaPropuesta(leadId, { capacidad: 'CI', anclas: { item_id: itemId } }),
    ).resolves.toBeTruthy();
  });

  it('rechazar no toca el dominio: el item sigue pendiente de curaduría manual (SYS-21)', async () => {
    const itemId = await nuevoItem('Item que se rechaza');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      anclas: { item_id: itemId },
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
      anclas: { reto_id: retoId },
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
      anclas: { item_id: itemId },
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
    const ajena = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId: await nuevaPropuesta(leadId, {
        capacidad: 'CI',
        anclas: { item_id: otroItem },
      }),
    });
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
        // Toda evidencia nace con su registro de derechos (SPEC-03, trigger diferido). El
        // fixture lo pone para que la evidencia sea VÁLIDA y lo que rechace la transacción
        // sea la regla que este test mide, no la de otro slice.
        await tx`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
          values (${ws}, ${e!.id as string}, ${leadId})`;
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
      anclas: { item_id: itemId },
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

  it('la presencia literal de las citas se mide contra el material real del alcance', async () => {
    const panel = await panelPropuestas(leadId, ws);
    const conCitas = [...panel.pendientes, ...panel.decididas].find((p) => p.citas.length === 2);
    expect(conCitas).toBeDefined();
    // Una cita literal del material y otra inventada: la pantalla las distingue.
    expect(conCitas!.citas.map((c) => c.presenteLiteral)).toEqual([true, false]);
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
      anclas: { item_id: item!.id as string },
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
    expect(p.citas.map((c) => c.presenteLiteral)).toEqual([true, false]);
  });

  // ── RF-09.5: consentimiento ANTES de que el material salga hacia el proveedor ──

  /**
   * Y el mensaje va donde la persona pueda ACTUAR.
   *
   * El candado del consentimiento se toma primero —leerlo y apartar la reserva tienen que ser
   * atómicos—, pero eso no decide qué se dice. Con la comprobación delante de la preparación,
   * una petición rancia contra un item YA CURADO recibía «registra el consentimiento»: una
   * instrucción que no lleva a ninguna parte, porque después de registrarlo el item sigue
   * curado y la generación falla igual. Lo cazó una revisión sobre el arreglo anterior.
   *
   * Lo que se sujeta es la PRECEDENCIA: primero lo que hay que arreglar primero.
   */
  it('a un item ya curado le dice que está curado, no que registre el consentimiento', async () => {
    const itemId = await nuevoItem('Entrevista ya curada', 'entrevista');
    // Se cura a mano, y sin consentimiento: las dos cosas mal a la vez.
    // Un item decidido lleva quién y cuándo: el CHECK de la tabla lo exige, y esta prueba
    // tiene que montar un estado que la base admita para medir algo real.
    await sqlAdmin()`update item_importacion
      set estado = 'rechazado', decidido_por = ${leadId}, decidido_en = now()
      where id = ${itemId} and workspace_id = ${ws}`;
    await conProveedor(RESPUESTA_CI, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
      ).rejects.toThrow(/ya fue curado/i);
    });
    // Y cuando el item SÍ está disponible, el consentimiento vuelve a ser lo que falta.
    const pendiente = await nuevoItem('Entrevista pendiente sin consentimiento', 'entrevista');
    await conProveedor(RESPUESTA_CI, async () => {
      await expect(
        generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: pendiente }),
      ).rejects.toThrow(/consentimiento/i);
    });
  });

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
      nuevaPropuesta(leadId, { capacidad: 'CI', anclas: { item_id: itemId } }),
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
    expect(panel.candidatas.CI.lista.find((i) => i.id === itemId)?.consentimientoPendiente).toBe(true);
    // También en la base: el guard lee lo mismo que el servicio, no «si existe algún
    // registro» — que con la revocación seguiría diciendo que sí.
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', anclas: { item_id: itemId } }),
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

  it('una revocación entre autorizar y despachar para el material ANTES de que salga', async () => {
    // El otro lado de «revocar mientras el material viaja». Allí la llamada ya había salido y
    // lo único que queda es no dejar nacer la propuesta; aquí todavía no ha salido nada, así
    // que la promesa que toca es más fuerte: el material NO se despacha.
    //
    // El hueco es real y es el que abre este slice: la autorización se leía en una
    // transacción y la línea del libro se abría en otra, así que entre las dos cabía una
    // revocación commiteada. La FK del consentimiento no la atrapa —la versión citada sigue
    // existiendo, solo ha dejado de ser la vigente— y el guard solo exige que se cite alguna.
    // Por eso el apunte vuelve a preguntar, en su propia transacción: es la última parada
    // antes del despacho, y ahora es la única.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Entrevista revocada justo antes de salir', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    try {
      let despachos = 0;
      await conProveedor(RESPUESTA_CI, async () => {
        proveedor.antesDelApunte = async () => {
          await registrarConsentimiento(disenadorId, {
            workspaceId: ws,
            itemId,
            alcance: 'La persona retira el permiso de procesamiento externo',
            procesamientoExterno: false,
          });
        };
        proveedor.duranteLlamada = async () => {
          despachos += 1;
        };
        try {
          await expect(
            generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
          ).rejects.toThrow(/consentimiento/i);
        } finally {
          proveedor.antesDelApunte = null;
          proveedor.duranteLlamada = null;
        }
      });

      // Ni un byte en el aire: el material no llegó a salir.
      expect(despachos).toBe(0);
      // Y no queda línea de gasto: no se abre el libro para una llamada que no ocurre.
      const lineas = await admin`select 1 as x from llamada_ai
        where workspace_id = ${ws} and item_id = ${itemId}`;
      expect(lineas.length).toBe(0);
      const propuestas = await admin`select 1 as x from propuesta_ai where item_id = ${itemId}`;
      expect(propuestas.length).toBe(0);
    } finally {
      await admin`delete from propuesta_ai where item_id = ${itemId}`;
      await admin`delete from reserva_ai where item_id = ${itemId}`;
      await admin`delete from llamada_ai where item_id = ${itemId}`;
      await admin`delete from consentimiento_item where item_id = ${itemId}`;
      await admin`delete from item_importacion where id = ${itemId}`;
    }
  });

  it('quien deja de ser curador a mitad de camino tampoco despacha, y se le dice por qué', async () => {
    // La otra mitad de la autorización que el apunte tiene que rehacer. `prepararAlcance`
    // exige rol curador y commitea; entre aquel commit y el despacho cabe una degradación a
    // stakeholder, y quien ya no puede pedir propuestas tampoco puede mandar material a un
    // tercero. La política de inserción lo rechaza igual —es el suelo—, pero por esa vía la
    // persona solo recibiría un «vuelve a intentarlo» que además es falso: reintentar no
    // devuelve un rol. Se comprueba donde se decide el permiso, y se dice con sus palabras.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Entrevista de quien pierde el rol a media llamada', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    const [miembro] = await admin`select id, rol from miembro
      where usuario_id = ${disenadorId} and workspace_id = ${ws}`;
    try {
      let despachos = 0;
      await conProveedor(RESPUESTA_CI, async () => {
        proveedor.antesDelApunte = async () => {
          await admin`update miembro set rol = 'stakeholder' where id = ${miembro!.id as string}`;
        };
        proveedor.duranteLlamada = async () => {
          despachos += 1;
        };
        try {
          await expect(
            generarPropuestas(disenadorId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
          ).rejects.toThrow(/lead-boutique o diseñador/i);
        } finally {
          proveedor.antesDelApunte = null;
          proveedor.duranteLlamada = null;
        }
      });
      expect(despachos).toBe(0);
      const lineas = await admin`select 1 as x from llamada_ai
        where workspace_id = ${ws} and item_id = ${itemId}`;
      expect(lineas.length).toBe(0);
    } finally {
      await admin`update miembro set rol = ${miembro!.rol as string}
        where id = ${miembro!.id as string}`;
      await admin`delete from propuesta_ai where item_id = ${itemId}`;
      await admin`delete from reserva_ai where item_id = ${itemId}`;
      await admin`delete from llamada_ai where item_id = ${itemId}`;
      await admin`delete from consentimiento_item where item_id = ${itemId}`;
      await admin`delete from item_importacion where id = ${itemId}`;
    }
  });

  it('perder el rol con la llamada EN VUELO no borra su coste: el cierre es un hecho consumado', async () => {
    // El otro extremo del mismo reloj. Antes del apunte, perder el rol impide despachar — eso
    // es autorizar. Después del apunte el material YA salió y el proveedor YA cobró, y lo
    // único que queda es anotar lo que pasó. Son dos preguntas distintas, y `cerrarLlamadas`
    // ya lo tenía dicho: se salta `exigirCuentaActiva` a propósito porque aquí no se actúa.
    //
    // La política de completar no lo tenía. Exigía rol curador, así que una degradación con la
    // llamada en vuelo escondía la fila del UPDATE —filtra, no rechaza— y la línea se quedaba
    // en `despachada` para siempre: sin desenlace, sin tokens, sin coste y sin su evento. Una
    // llamada pagada perdiendo su rastro es exactamente lo que este slice existe para impedir.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Entrevista de quien se degrada a media llamada', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    const [miembro] = await admin`select id, rol from miembro
      where usuario_id = ${disenadorId} and workspace_id = ${ws}`;
    try {
      await conProveedor(RESPUESTA_CI, async () => {
        // La degradación ocurre con la línea ya abierta y el material en el aire.
        proveedor.duranteLlamada = async () => {
          await admin`update miembro set rol = 'stakeholder' where id = ${miembro!.id as string}`;
        };
        try {
          // La generación NO llega a término, y eso es lo correcto: persistir el lote sí es
          // una escritura de dominio —nacen `propuesta_ai`— y quien ya no es curador no puede
          // hacerla. Lo que este caso exige es que el GASTO no se pierda por el camino.
          await expect(
            generarPropuestas(disenadorId, {
              workspaceId: ws,
              capacidad: 'CI',
              anclaId: itemId,
            }),
          ).rejects.toThrow();
        } finally {
          proveedor.duranteLlamada = null;
        }
      });

      // La línea se cerró con su desenlace y su coste: el gasto no se pierde.
      const [linea] = await admin`select resultado, costo_usd, tokens_entrada, cerrado_en
        from llamada_ai where workspace_id = ${ws} and item_id = ${itemId}`;
      expect(linea!.resultado).toBe('salida-valida');
      expect(linea!.costo_usd).not.toBeNull();
      expect(linea!.tokens_entrada).not.toBeNull();
      expect(linea!.cerrado_en).not.toBeNull();
      // Y ninguna propuesta nació: el dominio no cambia por una llamada que nadie podía pedir.
      const propuestas = await admin`select 1 as x from propuesta_ai where item_id = ${itemId}`;
      expect(propuestas.length).toBe(0);
    } finally {
      await admin`update miembro set rol = ${miembro!.rol as string}
        where id = ${miembro!.id as string}`;
      await admin`delete from propuesta_ai where item_id = ${itemId}`;
      await admin`delete from reserva_ai where item_id = ${itemId}`;
      await admin`delete from llamada_ai where item_id = ${itemId}`;
      await admin`delete from consentimiento_item where item_id = ${itemId}`;
      await admin`delete from item_importacion where id = ${itemId}`;
    }
  });

  it('un cierre fallido tras una llamada sin propuesta no se traga: queda registrado', async () => {
    // El momento en que el fallo se conoce era el único, y un `catch` vacío lo descartaba: la
    // fila se queda en `despachada` para siempre, el trigger no llega a emitir
    // `LlamadaAISinPropuesta` y no hay ninguna ruta de reconciliación que las recoja después.
    // La persona sigue leyendo el motivo del PROVEEDOR —que es lo que explica lo que pasó, y
    // un detalle de la base no la ayuda a decidir—, pero el servidor se entera.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item cuyo cierre se pierde tras un rechazo', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    const registrado = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await conProveedor(RESPUESTA_RECHAZO, async () => {
        // La línea se cierra POR FUERA mientras la llamada está en vuelo, así que el cierre
        // legítimo ya no la alcanza: la política filtra y el UPDATE toca cero filas.
        proveedor.duranteLlamada = async () => {
          await admin`update llamada_ai set resultado = 'sin-respuesta', motivo = 'cerrada por fuera'
            where workspace_id = ${ws} and item_id = ${itemId} and resultado = 'despachada'`;
        };
        try {
          // Lo que la persona lee sigue siendo el motivo del proveedor.
          await expect(
            generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
          ).rejects.toThrow(/se negó a procesar/);
        } finally {
          proveedor.duranteLlamada = null;
        }
      });

      // Y el fallo del cierre consta, con lo que hace falta para encontrar la línea.
      const dicho = registrado.mock.calls.map((c) => String(c[0])).join('\n');
      expect(dicho).toMatch(/no se pudieron cerrar las líneas/i);
      expect(dicho).toContain(ws);
    } finally {
      registrado.mockRestore();
      await admin`delete from propuesta_ai where item_id = ${itemId}`;
      await admin`delete from reserva_ai where item_id = ${itemId}`;
      await admin`delete from llamada_ai where item_id = ${itemId}`;
      await admin`delete from consentimiento_item where item_id = ${itemId}`;
      await admin`delete from item_importacion where id = ${itemId}`;
    }
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

    // El servicio lo dice con nombre, y con un error de DOMINIO: quien rechaza aquí es un
    // guard de la base, así que sin traducción el revisor se llevaría un PostgresError
    // crudo a la pantalla (`mensajeDe` devuelve null para P0001 y la server function
    // relanza al error boundary). Se comprueba la CLASE además del texto, porque el texto
    // es el mismo en los dos casos y no distingue el error traducido del que se escapa.
    const alAceptar = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId,
    }).catch((e: unknown) => e);
    expect(alAceptar).toBeInstanceOf(ErrorAI);
    expect((alAceptar as ErrorAI).message).toMatch(/consentimiento/i);
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
    expect(conPropuesta.candidatas.CI.lista.some((i) => i.id === itemId)).toBe(false);
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
      nuevaPropuesta(leadId, { capacidad: 'CI', anclas: { item_id: itemId } }),
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
      // Una propuesta ANTIGUA y otras cincuenta más nuevas, todas del mismo reto. CADA UNA
      // con su propia llamada, que es como nacen de verdad: un lote sale de una llamada y
      // tiene techo, así que colgar cincuenta y una de la misma —como hacía este fixture—
      // describía algo que el sistema no puede producir. Un fixture que monta un estado
      // imposible prueba sobre un mundo que no existe.
      const [llamadaVieja] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsD}, 'C0', ${retoD}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const [vieja] = await admin`insert into propuesta_ai
        (workspace_id, capacidad, destino, reto_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, creado_en)
        values (${wsD}, 'C0', 'criterio-exito', ${retoD}, ${admin.json(CONTENIDO_C0)},
                ${admin.json(CONTENIDO_C0)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'entorno',
                ${llamadaVieja!.id as string}, ${curadorId}, now() - interval '30 days')
        returning id`;
      const nuevas = await admin`
        with l as (
          insert into llamada_ai
            (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
          select ${wsD}, 'C0', ${retoD}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                 ${curadorId}
          from generate_series(1, 50)
          returning id
        )
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original, modelo,
           prompt_version, origen_key, llamada_id, creado_por, creado_en)
        select ${wsD}, 'C0', 'criterio-exito', ${retoD}, ${admin.json(CONTENIDO_C0)},
               ${admin.json(CONTENIDO_C0)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'entorno',
               l.id, ${curadorId}, now() - interval '1 day'
        from l
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

  it('una llamada despachada consta y cuenta aunque su cierre no llegue a escribirse', async () => {
    // La propiedad que este slice existe para dar: el libro registra TODA invocación, y ya no
    // depende de que una transacción POSTERIOR a la llamada salga bien. Se comprueba mirando
    // el estado intermedio real —la fila abierta antes de despachar— y lo que significa.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item cuya llamada se queda a medio anotar', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    try {
      // Dentro del hueco «en vuelo» la línea YA existe, en `despachada`: ése es el momento en
      // el que antes no había nada escrito y un fallo se llevaba el gasto por delante.
      let enVuelo: { resultado: string; modelo: string; costo: unknown } | null = null;
      await conProveedor(RESPUESTA_CI, async () => {
        proveedor.duranteLlamada = async () => {
          const [f] = await admin`select resultado, modelo, costo_usd from llamada_ai
            where workspace_id = ${ws} and item_id = ${itemId}`;
          enVuelo = f
            ? { resultado: f.resultado as string, modelo: f.modelo as string, costo: f.costo_usd }
            : null;
        };
        try {
          await generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId });
        } finally {
          proveedor.duranteLlamada = null;
        }
      });

      expect(enVuelo).not.toBeNull();
      expect(enVuelo!.resultado).toBe('despachada');
      // Y ya trae lo que la línea AFIRMA al abrirse: con qué modelo salió. Lo que todavía no
      // consta es el desenlace —ni el coste—, que es justo lo que el cierre añade.
      expect(enVuelo!.modelo).toBe(MODELO_PRIMARIO);
      expect(enVuelo!.costo).toBeNull();

      // Una fila que se QUEDE en `despachada` cuenta para el tope. Es la dirección segura
      // —ante la duda de si el proveedor cobró, se asume que sí— y hay que comprobarlo contra
      // el contador de verdad, porque si no un cierre perdido regalaría cuota. Se mide con el
      // número que enseña el panel, antes y después de dejar una línea abierta a mano.
      const mide = () =>
        conProveedor(RESPUESTA_CI, async () => (await panelPropuestas(leadId, ws)).ai.llamadasHoy);
      const antes = await mide();

      // (a) Una línea EN VUELO, con la reserva de su generación viva, no se cuenta dos veces:
      // la reserva ya apartó el hueco. Sumar las dos cobraba el doble por la misma generación
      // durante hasta dos timeouts.
      const [reserva] = await admin`insert into reserva_ai
        (workspace_id, capacidad, reto_id, unidades, creado_por)
        values (${ws}, 'C0', ${retoId}, 2, ${leadId}) returning id`;
      const [cubierta] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, reserva_id, creado_por)
        values (${ws}, 'C0', ${retoId}, ${MODELO_RELLENO}, 'entorno', 'despachada',
                ${reserva!.id as string}, ${leadId})
        returning id`;
      expect(await mide()).toBe(antes);

      // (b) Y en cuanto la reserva desaparece, la MISMA fila cuenta — en el acto, sin esperar
      // a que venza ningún reloj. Cuando el cierre falla, la limpieza retira la reserva de
      // inmediato; si la exclusión mirase el tiempo transcurrido, durante el resto de la
      // ventana no contaría ni la reserva ni la llamada pagada, y fallos repetidos dejarían
      // reintentar por encima del cupo — justo el fallo posterior al despacho que este cambio
      // existe para contener.
      await admin`delete from reserva_ai where id = ${reserva!.id as string}`;
      expect(await mide()).toBe(antes + 1);

      // (c) Y no vuelve a dejar de contar cuando el ancla se reintenta. Una reserva NUEVA
      // presupuesta la generación nueva, no la vieja: si la exclusión mirase solo el ancla, el
      // reintento volvería a esconder la llamada ya pagada, y con fallos repetidos se
      // acumularían líneas huérfanas invisibles mientras una sola reserva las tapa a todas.
      // La reserva que cuenta es LA SUYA, la que apartó su hueco, y por eso viaja en la fila.
      const [otra] = await admin`insert into reserva_ai
        (workspace_id, capacidad, reto_id, unidades, creado_por)
        values (${ws}, 'C0', ${retoId}, 2, ${leadId}) returning id`;
      expect(await mide()).toBe(antes + 1);
      await admin`delete from reserva_ai where id = ${otra!.id as string}`;
      await admin`delete from llamada_ai where id = ${cubierta!.id as string}`;

      // Cerrada: el desenlace y el coste ya constan, en la MISMA fila que se abrió antes.
      const [cerrada] = await admin`select resultado, costo_usd, intento from llamada_ai
        where workspace_id = ${ws} and item_id = ${itemId}`;
      expect(cerrada!.resultado).toBe('salida-valida');
      expect(cerrada!.costo_usd).not.toBeNull();
      expect(cerrada!.intento).toBe(0);
    } finally {
      await admin`delete from propuesta_ai where item_id = ${itemId}`;
      await admin`delete from reserva_ai where item_id = ${itemId}`;
      await admin`delete from llamada_ai where item_id = ${itemId}`;
      // Las líneas que este test abre a mano son C0 y NO tienen `item_id`, así que el barrido
      // de arriba no las alcanzaría. Se borran por su modelo de relleno: si una aserción cae
      // antes del borrado en línea, una fila `despachada` huérfana quedaría en el workspace
      // compartido inflando `llamadasHoy` para todos los tests que vienen después.
      await admin`delete from llamada_ai
        where workspace_id = ${ws} and modelo = ${MODELO_RELLENO}`;
      await admin`delete from consentimiento_item where item_id = ${itemId}`;
      await admin`delete from item_importacion where id = ${itemId}`;
    }
  });

  it('una línea EN VUELO no borra un aviso de caída, y el sello de cierre es el que ordena', async () => {
    // Dos consecuencias del libro anticipado sobre la señal de salud, las dos medidas:
    //
    //  (a) `creado_en` pasó a ser la hora del DESPACHO. Si la salud se ordenara por él, una
    //      línea recién abierta sería «lo más reciente» y taparía una caída real justo cuando
    //      alguien pide otra generación — o sea, justo cuando el aviso hace falta.
    //  (b) el reloj que ordena es `cerrado_en`, el de la OBSERVACIÓN, que lo estampa el guard.
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca + ' vuelo'})
      returning id`;
    const wsV = w!.id as string;
    try {
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${wsV}, ${leadId}, 'lead', ${`${marca}-vuelo@test.demo`}, 'lead-boutique')`;
      const [svcV] = await admin`insert into servicio (workspace_id, nombre, creado_por)
        values (${wsV}, 'Servicio en vuelo', ${leadId}) returning id`;
      const [retoV] = await admin`insert into reto
        (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
        values (${wsV}, ${svcV!.id as string}, 'R-V2', 'Reto en vuelo', 'candidato',
                'peticion-cliente', ${leadId})
        returning id`;
      const salud = () =>
        conProveedor(RESPUESTA_CI, async () => (await panelPropuestas(leadId, wsV)).ai);

      // Una caída observada hace un instante.
      const [caida] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, motivo, creado_por)
        values (${wsV}, 'C0', ${retoV!.id as string}, ${MODELO_RELLENO}, 'entorno',
                'despachada', '', ${leadId})
        returning id`;
      await admin`update llamada_ai set resultado = 'sin-respuesta', motivo = 'no respondió'
        where id = ${caida!.id as string}`;
      expect((await salud()).proveedorResponde).toBe(false);
      // El guard selló la observación: es lo que ordena, y no puede quedarse en null.
      const [sellada] = await admin`select cerrado_en from llamada_ai
        where id = ${caida!.id as string}`;
      expect(sellada!.cerrado_en).not.toBeNull();

      // (a) Ahora alguien despacha otra: la línea nace con `creado_en` MÁS NUEVO que la caída.
      // Si la salud ordenara por el despacho, esto la taparía. No debe.
      await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsV}, 'C0', ${retoV!.id as string}, ${MODELO_RELLENO}, 'entorno',
                'despachada', ${leadId})`;
      const conVuelo = await salud();
      expect(conVuelo.proveedorResponde).toBe(false);
      expect(conVuelo.advertencia).toMatch(/no respondió al último intento/i);
    } finally {
      await admin`delete from llamada_ai where workspace_id = ${wsV}`;
      await admin`delete from reto where workspace_id = ${wsV}`;
      await admin`delete from servicio where workspace_id = ${wsV}`;
      await admin`delete from miembro where workspace_id = ${wsV}`;
      await admin`delete from workspace where id = ${wsV}`;
    }
  });

  it('un cierre que no alcanza su línea FALLA, en vez de dejar una propuesta sin gasto', async () => {
    // La política de completar FILTRA en vez de rechazar: un update que ya no alcanza su fila
    // sale sin error y con cero filas tocadas. Sin comprobar el recuento, eso pasaba por un
    // cierre bueno — y la propuesta se persistía apuntando a una línea que seguía
    // `despachada`, sin coste ni latencia, que el panel mostraría así para siempre y el
    // contador cobraría como despacho abierto.
    //
    // Se provoca cerrando la línea POR FUERA mientras la llamada está en vuelo, que es el
    // hueco real: entre el apunte y el cierre no hay transacción que los una.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item cuya línea se cierra por detrás', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    try {
      const error = await conProveedor(RESPUESTA_CI, async () => {
        proveedor.duranteLlamada = async () => {
          await admin`update llamada_ai set resultado = 'sin-respuesta', motivo = 'cerrada por fuera'
            where workspace_id = ${ws} and item_id = ${itemId} and resultado = 'despachada'`;
        };
        try {
          return await generarPropuestas(leadId, {
            workspaceId: ws,
            capacidad: 'CI',
            anclaId: itemId,
          }).then(() => null);
        } catch (e) {
          return e;
        } finally {
          proveedor.duranteLlamada = null;
        }
      });
      expect(error).toBeInstanceOf(ErrorAI);
      expect((error as ErrorAI).message).toMatch(/no se pudo cerrar la línea/i);

      // Y lo que importa: NO quedó una propuesta colgada de una línea sin desenlace.
      const propuestas = await admin`select id from propuesta_ai
        where workspace_id = ${ws} and item_id = ${itemId}`;
      expect(propuestas.length).toBe(0);
    } finally {
      await admin`delete from propuesta_ai where item_id = ${itemId}`;
      await admin`delete from reserva_ai where item_id = ${itemId}`;
      await admin`delete from llamada_ai where item_id = ${itemId}`;
      await admin`delete from consentimiento_item where item_id = ${itemId}`;
      await admin`delete from item_importacion where id = ${itemId}`;
    }
  });

  it('un curador no puede cerrar la línea que abrió otro', async () => {
    // `llamada_insert` fija `creado_por = app_user_id()`; la política de completar nació sin
    // ese anclaje, y esa asimetría era un agujero: cualquier curador del workspace podía
    // escribirle a la línea de OTRO un desenlace y un coste inventados, que el libro
    // atribuiría a quien la abrió. Y de paso dejaba al cierre legítimo sin fila que tocar.
    const admin = sqlAdmin();
    const [abierta] = await conUsuario(leadId, (tx) => tx`insert into llamada_ai
      (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
      values (${ws}, 'C0', ${retoId}, ${MODELO_RELLENO}, 'entorno', 'despachada', ${leadId})
      returning id`);
    const id = abierta!.id as string;
    try {
      // El OTRO curador del workspace (diseñador, mismo rol de escritura) no la alcanza.
      const ajenas = await conUsuario(disenadorId, (tx) => tx`update llamada_ai
        set resultado = 'fuera-de-contrato', motivo = 'escrito por quien no la abrió',
            costo_usd = 99
        where id = ${id} returning id`);
      expect(ajenas.length).toBe(0);
      const [intacta] = await admin`select resultado, costo_usd, creado_por from llamada_ai
        where id = ${id}`;
      expect(intacta!.resultado).toBe('despachada');
      expect(intacta!.costo_usd).toBeNull();
      expect(intacta!.creado_por).toBe(leadId);

      // Y quien la abrió sí la cierra: la puerta se cierra al ajeno, no a todos.
      const propias = await conUsuario(leadId, (tx) => tx`update llamada_ai
        set resultado = 'salida-valida', costo_usd = 1 where id = ${id} returning id`);
      expect(propias.length).toBe(1);
    } finally {
      await admin`delete from llamada_ai where id = ${id}`;
    }
  });

  it('una escritura cruda que nace con desenlace sigue dejando su evento', async () => {
    // La migración base puso este evento DENTRO del guard para que el SQL crudo lo produjera
    // igual. Mover la emisión al UPDATE a secas habría retirado ese suelo en silencio: el
    // grant de insert incluye `resultado`, así que una fila puede nacer ya en `sin-respuesta`
    // sin pasar nunca por `despachada`. Las dos vías, entonces.
    const admin = sqlAdmin();
    const antes = await conUsuario(leadId, (tx) => tx`select count(*)::int as n
      from evento_dominio where workspace_id = ${ws} and tipo = 'LlamadaAISinPropuesta'`);
    const [cruda] = await conUsuario(leadId, (tx) => tx`insert into llamada_ai
      (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, motivo, creado_por)
      values (${ws}, 'C0', ${retoId}, ${MODELO_RELLENO}, 'entorno', 'sin-respuesta',
              'nació con desenlace', ${leadId})
      returning id`);
    try {
      const despues = await conUsuario(leadId, (tx) => tx`select count(*)::int as n
        from evento_dominio where workspace_id = ${ws} and tipo = 'LlamadaAISinPropuesta'`);
      expect((despues[0]!.n as number)).toBe((antes[0]!.n as number) + 1);

      // Y nace SELLADA: una fila con desenlace y sin hora de observación afirmaría dos cosas
      // incompatibles, y la señal de salud la ordenaría por el reloj equivocado.
      const [sellada] = await admin`select cerrado_en from llamada_ai
        where id = ${cruda!.id as string}`;
      expect(sellada!.cerrado_en).not.toBeNull();
    } finally {
      await admin`delete from llamada_ai where id = ${cruda!.id as string}`;
    }
  });

  it('una línea cerrada no se puede volver a cerrar: el tránsito es de un solo sentido', async () => {
    // `using` fija el origen y `with check` el destino. Sin el segundo, una línea ya cerrada
    // podría reescribirse pasando por «despachada», que es la puerta trasera que el grant de
    // UPDATE abriría si nadie la cerrara.
    const admin = sqlAdmin();
    const [l] = await admin`insert into llamada_ai
      (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
      values (${ws}, 'C0', ${retoId}, ${MODELO_RELLENO}, 'entorno', 'despachada', ${leadId})
      returning id`;
    const id = l!.id as string;
    try {
      // Primer cierre: pasa.
      const cerrada = await conUsuario(leadId, (tx) => tx`update llamada_ai
        set resultado = 'salida-valida', costo_usd = 1 where id = ${id} returning id`);
      expect(cerrada.length).toBe(1);

      // Segundo cierre: la fila ya no está en `despachada`, así que el `using` no la alcanza.
      const otraVez = await conUsuario(leadId, (tx) => tx`update llamada_ai
        set costo_usd = 0 where id = ${id} returning id`);
      expect(otraVez.length).toBe(0);

      // Y no se puede dejar abierta otra vez para reescribirla después: lo impide el
      // `with check`, que sí rechaza en vez de filtrar.
      await admin`update llamada_ai set resultado = 'despachada', motivo = '' where id = ${id}`;
      await expect(
        conUsuario(leadId, (tx) => tx`update llamada_ai set resultado = 'despachada'
          where id = ${id}`),
      ).rejects.toThrow(/row-level security|política|policy/i);
    } finally {
      await admin`delete from llamada_ai where id = ${id}`;
    }
  });

  it('el motivo del guard llega a la pantalla también al GENERAR, no solo al aceptar', async () => {
    // El `catch` de la persistencia traducía el 23505 y el P0001 del consentimiento, y dejaba
    // escapar los demás `raise` del guard como PostgresError crudo. `mensajeDe` no traduce
    // P0001, así que devolvía null y la pantalla enseñaba «No se pudo pedir la propuesta;
    // intenta de nuevo» en vez del motivo — que es justo el dato que dice qué hacer. La
    // aceptación ya lo traducía; era la generación la mitad que faltaba.
    //
    // Se recorre la carrera real: el item se cura A MANO mientras la llamada está en vuelo,
    // así que el guard rechaza al persistir y no antes.
    const itemId = await nuevoItem('Item que alguien cura mientras la AI piensa', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    const admin = sqlAdmin();
    try {
      const error = await conProveedor(RESPUESTA_CI, async () => {
        proveedor.duranteLlamada = async () => {
          // 'rechazado' es la decisión que no exige evidencia: basta con que el item deje de
          // estar 'pendiente' para que el guard rechace la propuesta al persistirla.
          await admin`update item_importacion set estado = 'rechazado', decidido_por = ${leadId},
              decidido_en = now() where id = ${itemId}`;
        };
        try {
          return await generarPropuestas(leadId, {
            workspaceId: ws,
            capacidad: 'CI',
            anclaId: itemId,
          }).then(() => null);
        } catch (e) {
          return e;
        } finally {
          proveedor.duranteLlamada = null;
        }
      });
      // Un ErrorAI, que es lo que la capa de servidor sabe traducir a {ok:false, error}: no
      // un PostgresError que acabe en el boundary del router.
      expect(error).toBeInstanceOf(ErrorAI);
      // Y el texto es el del guard, no un genérico: nombra QUÉ pasó con el item.
      expect((error as ErrorAI).message).toMatch(/decidido|admite propuestas/i);
    } finally {
      await admin`delete from propuesta_ai where item_id = ${itemId}`;
      await admin`delete from reserva_ai where item_id = ${itemId}`;
      await admin`delete from llamada_ai where item_id = ${itemId}`;
      await admin`delete from consentimiento_item where item_id = ${itemId}`;
      await admin`delete from item_importacion where id = ${itemId}`;
    }
  });

  it('el respaldo lo cuenta el ACTO HUMANO, sobre todo el workspace y no sobre una página', async () => {
    // La presencia literal de las citas mide una subcadena y no verifica nada por sí sola:
    // una alucinación bien citada saca 2/2 «presentes». La medida que alguien sostiene es
    // ésta —cuántas propuestas pasó una PERSONA a objeto real, con su nombre en la fila
    // (SYS-19)—, así que se comprueba que sale de lo que decidió gente y no de otra cosa.
    const admin = sqlAdmin();
    const antes = await conProveedor(RESPUESTA_CI, async () => {
      const panel = await panelPropuestas(leadId, ws);
      return panel.respaldo;
    });

    // Una propuesta SIN decidir no cuenta en ninguno de los tres: `propuesta` no es un
    // veredicto, y derivar los rechazos restando la habría repartido en silencio.
    const sinDecidir = await nuevoItem('Item cuya propuesta se queda esperando', 'entrevista');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId: sinDecidir,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    await conProveedor(RESPUESTA_CI, () =>
      generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: sinDecidir }),
    );
    const enEspera = await conProveedor(RESPUESTA_CI, async () => {
      const panel = await panelPropuestas(leadId, ws);
      return panel.respaldo;
    });
    expect(enEspera).toEqual(antes);

    // Aceptarla la mueve a «respaldada», y el que la sostiene es quien firmó.
    const [p] = await conUsuario(leadId, (tx) => tx`select id from propuesta_ai
      where workspace_id = ${ws} and item_id = ${sinDecidir} and estado = 'propuesta'`);
    const propuestaId = p!.id as string;
    await aceptarPropuesta(leadId, { workspaceId: ws, propuestaId });
    const tras = await conProveedor(RESPUESTA_CI, async () => {
      const panel = await panelPropuestas(leadId, ws);
      return panel.respaldo;
    });
    expect(tras.aceptadas + tras.corregidas).toBe(antes.aceptadas + antes.corregidas + 1);
    expect(tras.rechazadas).toBe(antes.rechazadas);

    // Y el nombre está en la fila: el respaldo no es anónimo, o no sería de nadie.
    const [firmada] = await admin`select revisada_por, revisada_en from propuesta_ai
      where id = ${propuestaId}`;
    expect(firmada!.revisada_por).toBe(leadId);
    expect(firmada!.revisada_en).not.toBeNull();

    // El recuento es del WORKSPACE entero, no de la página de decididas recientes: un
    // recuento por página no es un recuento, y este número se lee como medida.
    const [total] = await conUsuario(leadId, (tx) => tx`select count(*)::int as n
      from propuesta_ai where workspace_id = ${ws} and revisada_por is not null`);
    expect(tras.aceptadas + tras.corregidas + tras.rechazadas).toBe(total!.n as number);
  });

  it('el cupo del workspace manda, y la constante del código es solo el respaldo', async () => {
    const admin = sqlAdmin();
    // El gasto de hoy se LEE, no se supone: este workspace lo comparten los tests de este
    // fichero y fijar un número a mano ataría la prueba al orden en que corren.
    await admin`insert into llamada_ai
      (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
      select ${ws}, 'C0', ${retoId}, ${MODELO_RELLENO}, 'entorno', 'salida-valida', ${leadId}
      from generate_series(1, 3)`;
    // El gasto se lee del PANEL, no de una consulta propia: la regla de qué cuenta vive en
    // `presupuestoDeHoy` —y desde el libro anticipado excluye además las líneas en vuelo que
    // ya cubre una reserva—, así que reescribirla aquí era tener dos redacciones de la misma
    // regla esperando a divergir. Divergieron.
    const usadas = await conProveedor(RESPUESTA_CI, async () =>
      (await panelPropuestas(leadId, ws)).ai.llamadasHoy,
    );
    // Con el respaldo global esto no agotaría nada: si el cupo pactado no se leyera, todo lo
    // de abajo pasaría en verde y el defecto seguiría vivo. Ése era el estado anterior —el
    // parámetro `limiteDiario` existía y las dos llamadas vivas le pasaban la constante—,
    // así que este test falla sin el arreglo.
    expect(usadas).toBeGreaterThan(0);
    expect(usadas).toBeLessThan(LIMITE_LLAMADAS_DIA);
    await admin`update workspace set limite_llamadas_ai_dia = ${usadas} where id = ${ws}`;
    try {
      await conProveedor(RESPUESTA_CI, async () => {
        const panel = await panelPropuestas(leadId, ws);
        expect(panel.ai.disponible).toBe(false);
        // El motivo CITA el cupo pactado, no el del despliegue: quien lee «de N» sabe cuál es
        // su tope; con «de 60» leería que le sobra presupuesto y que algo se rompió.
        expect(panel.ai.motivo).toContain(`de ${usadas} llamadas al proveedor`);
        expect(panel.ai.motivo).not.toContain(`de ${LIMITE_LLAMADAS_DIA} llamadas`);
        // Y el gasto que cita el motivo es el MISMO que enseña la tarjeta: nunca un total
        // por encima del tope. Con las reservas sumadas antes de entrar, esta línea decía
        // «61, de 60» justo encima de un «59/60».
        expect(panel.ai.motivo).toContain(`${panel.ai.llamadasHoy}`);
        expect(panel.ai.llamadasHoy).toBeLessThanOrEqual(panel.ai.limiteDiario);
        expect(panel.ai.limiteDiario).toBe(usadas);

        // Y la ADMISIÓN dice lo mismo que la bandera: la pantalla no ofrece lo que el
        // servicio va a negar, y el servicio no acepta lo que la pantalla apagó.
        const itemId = await nuevoItem(
          'Item que pide propuesta con el cupo del workspace agotado',
          'entrevista',
        );
        await registrarConsentimiento(leadId, {
          workspaceId: ws,
          itemId,
          alcance: 'Autoriza el procesamiento por el proveedor AI',
          procesamientoExterno: true,
        });
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'CI', anclaId: itemId }),
        ).rejects.toThrow(ErrorAI);
      });

      // Un cupo MÁS ALTO que el gasto vuelve a abrir la capacidad, con el mismo gasto: lo
      // que cambió es el pacto, no lo consumido.
      await admin`update workspace set limite_llamadas_ai_dia = ${usadas + 10} where id = ${ws}`;
      await conProveedor(RESPUESTA_CI, async () => {
        const panel = await panelPropuestas(leadId, ws);
        expect(panel.ai.disponible).toBe(true);
        expect(panel.ai.limiteDiario).toBe(usadas + 10);
        expect(panel.ai.llamadasHoy).toBe(usadas);
      });

      // NULL no es «sin tope»: es «sin cupo pactado», y entonces rige el respaldo. El corte
      // suave sigue existiendo — no se apaga dejando el campo vacío.
      await admin`update workspace set limite_llamadas_ai_dia = null where id = ${ws}`;
      await conProveedor(RESPUESTA_CI, async () => {
        const panel = await panelPropuestas(leadId, ws);
        expect(panel.ai.limiteDiario).toBe(LIMITE_LLAMADAS_DIA);
      });
    } finally {
      await admin`update workspace set limite_llamadas_ai_dia = null where id = ${ws}`;
      await vaciarRelleno();
    }
  });

  it('una caída del proveedor se ve en el panel, sale del libro y la borra la siguiente respuesta', async () => {
    // Workspace PROPIO: la señal es «el intento más reciente de este workspace», así que
    // probarla sobre el libro compartido del fichero la ataría al orden en que corren los
    // demás tests —cualquier llamada suya sería más reciente que una caída antedatada—.
    // Con un libro entero bajo control, cada aserción dice lo que parece decir.
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca + ' salud'})
      returning id`;
    const wsS = w!.id as string;
    try {
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${wsS}, ${leadId}, 'lead', ${`${marca}-salud@test.demo`}, 'lead-boutique')`;
      const [svcS] = await admin`insert into servicio (workspace_id, nombre, creado_por)
        values (${wsS}, 'Servicio de salud', ${leadId}) returning id`;
      const [retoS] = await admin`insert into reto
        (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
        values (${wsS}, ${svcS!.id as string}, 'R-S1', 'Reto de salud', 'candidato',
                'peticion-cliente', ${leadId})
        returning id`;
      const retoS_id = retoS!.id as string;

      // Una llamada que no dio contenido utilizable DICE por qué: lo exige el CHECK de
      // `llamada_ai`, así que el fixture lo respeta en vez de esquivarlo.
      // `cerrado_en` va explícito además de `creado_en`: es el reloj que ordena la salud, y el
      // guard solo lo estampa cuando viene vacío — precisamente para que una escritura
      // administrativa como ésta pueda fechar la observación donde de verdad ocurrió.
      const anotar = (resultado: string, haceSegundos: number) => admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, motivo, creado_por,
         creado_en, cerrado_en)
        values (${wsS}, 'C0', ${retoS_id}, ${MODELO_RELLENO}, 'entorno', ${resultado},
                ${resultado === 'salida-valida' ? '' : 'anotado por la prueba de salud'},
                ${leadId}, now() - make_interval(secs => ${haceSegundos}),
                now() - make_interval(secs => ${haceSegundos}))`;
      const salud = () =>
        conProveedor(RESPUESTA_CI, async () => {
          const panel = await panelPropuestas(leadId, wsS);
          return panel.ai;
        });

      // Sin ningún intento todavía no hay nada que reportar: «no se sabe» es «responde».
      expect((await salud()).proveedorResponde).toBe(true);

      // El defecto: el panel decía «disponible» justo después de una operación que reportó
      // caída, porque el estado se derivaba solo de credencial, cupo y reservas.
      await anotar('sin-respuesta', 5);
      const caido = await salud();
      expect(caido.proveedorResponde).toBe(false);
      expect(caido.advertencia).toMatch(/no respondió al último intento/i);
      // Y la capacidad NO se apaga: hay credencial y hay presupuesto, que es lo único que
      // este proceso puede establecer. Si se apagara, nadie podría averiguar que el
      // proveedor volvió —lo único que lo averigua es llamarlo—.
      expect(caido.disponible).toBe(true);

      // Una respuesta POSTERIOR la borra al instante: no hay purga que recordar y el
      // interruptor no se queda pegado. La observación más reciente es la única que habla
      // del presente.
      await anotar('salida-valida', 1);
      const repuesto = await salud();
      expect(repuesto.proveedorResponde).toBe(true);
      expect(repuesto.advertencia).toBe('');

      // Un rechazo del proveedor o una salida fuera de contrato NO son caídas: el tercero
      // contestó, y de hecho cobró. Pintarlo de rojo por un material que el modelo se niega
      // a procesar confundiría un problema del material con uno de disponibilidad.
      await admin`delete from llamada_ai where workspace_id = ${wsS}`;
      await anotar('rechazo-proveedor', 2);
      expect((await salud()).proveedorResponde).toBe(true);
      await admin`delete from llamada_ai where workspace_id = ${wsS}`;
      await anotar('fuera-de-contrato', 2);
      expect((await salud()).proveedorResponde).toBe(true);

      // Y CADUCA por tiempo: pasada la ventana, una caída vieja deja de decir nada del
      // presente —nadie sabe que un tercero SIGUE caído sin volver a llamarlo— y no hace
      // falta que nadie la limpie.
      await admin`delete from llamada_ai where workspace_id = ${wsS}`;
      await anotar('sin-respuesta', Math.round(VENTANA_SALUD_PROVEEDOR_MS / 1000) + 60);
      expect((await salud()).proveedorResponde).toBe(true);
      // Justo dentro de la ventana sí cuenta: el corte está donde dice la constante.
      await admin`delete from llamada_ai where workspace_id = ${wsS}`;
      await anotar('sin-respuesta', Math.round(VENTANA_SALUD_PROVEEDOR_MS / 1000) - 30);
      expect((await salud()).proveedorResponde).toBe(false);
    } finally {
      await admin`delete from llamada_ai where workspace_id = ${wsS}`;
      await admin`delete from reto where workspace_id = ${wsS}`;
      await admin`delete from servicio where workspace_id = ${wsS}`;
      await admin`delete from miembro where workspace_id = ${wsS}`;
      await admin`delete from workspace where id = ${wsS}`;
    }
  });

  it('el puesto del intento está acotado a lo que una generación puede gastar', async () => {
    // La columna se documenta como «0 primario, 1 respaldo» y el desempate del último intento
    // se apoya en eso. Con un CHECK de `>= 0` a secas la base aceptaba un 7, así que el
    // comentario prometía una propiedad que nada establecía — y un puesto fuera de rango
    // escrito por error sesga el orden sin que nada chille.
    //
    // Los dos números salen de INTENTOS_POR_GENERACION, que es lo que ata el CHECK al código
    // que lo hace necesario: si algún día una generación puede gastar tres llamadas, este
    // test cae y obliga a mover también la base.
    const admin = sqlAdmin();
    const anotar = (puesto: number) => admin`insert into llamada_ai
      (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, motivo, intento,
       creado_por)
      values (${ws}, 'C0', ${retoId}, ${MODELO_RELLENO}, 'entorno', 'sin-respuesta',
              'prueba del techo del puesto', ${puesto}, ${leadId})`;
    try {
      // El último puesto válido entra…
      await anotar(INTENTOS_POR_GENERACION - 1);
      // …y el primero que ya no puede existir, no.
      await expect(anotar(INTENTOS_POR_GENERACION)).rejects.toThrow(/intento|check/i);
    } finally {
      await vaciarRelleno();
    }
  });

  it('una degradación que acaba bien NO avisa de caída, aunque los dos intentos compartan reloj', async () => {
    // El primario cae y el respaldo responde: la generación fue CORRECTA y el panel no puede
    // decir que el proveedor no responde. Las dos filas se escriben en la misma transacción,
    // así que su `creado_en` es idéntico —`now()` es la hora de inicio— y el desempate
    // decide. Cuando era `id desc` (uuid v4, aleatorio) el primario fallido salía elegido
    // como «último intento» aproximadamente la mitad de las veces: un orden total, pero no
    // cronológico. Se repite varias veces justamente porque el fallo era probabilístico —una
    // sola pasada lo habría visto en verde uno de cada dos intentos—.
    const admin = sqlAdmin();
    const [w] = await admin`insert into workspace (nombre) values (${marca + ' degradada'})
      returning id`;
    const wsD = w!.id as string;
    try {
      await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${wsD}, ${leadId}, 'lead', ${`${marca}-degr@test.demo`}, 'lead-boutique')`;
      const [svcD] = await admin`insert into servicio (workspace_id, nombre, creado_por)
        values (${wsD}, 'Servicio degradado', ${leadId}) returning id`;
      const [retoD] = await admin`insert into reto
        (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
        values (${wsD}, ${svcD!.id as string}, 'R-D1', 'Reto degradado', 'candidato',
                'peticion-cliente', ${leadId})
        returning id`;

      for (let vuelta = 0; vuelta < 8; vuelta++) {
        await admin`delete from llamada_ai where workspace_id = ${wsD}`;
        // Los dos intentos de UNA generación, en una sola transacción y en orden.
        await admin.begin(async (tx) => {
          for (const [puesto, i] of [
            { modelo: MODELO_PRIMARIO, resultado: 'sin-respuesta', motivo: 'el primario no respondió' },
            { modelo: MODELO_FALLBACK, resultado: 'salida-valida', motivo: '' },
          ].entries()) {
            await tx`insert into llamada_ai
              (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, motivo,
               intento, creado_por)
              values (${wsD}, 'C0', ${retoD!.id as string}, ${i.modelo}, 'entorno',
                      ${i.resultado}, ${i.motivo}, ${puesto}, ${leadId})`;
          }
        });
        // Las dos filas comparten reloj exacto: si no lo hicieran, este test no probaría nada.
        const relojes = await admin`select distinct creado_en from llamada_ai
          where workspace_id = ${wsD}`;
        expect(relojes.length).toBe(1);

        await conProveedor(RESPUESTA_CI, async () => {
          const panel = await panelPropuestas(leadId, wsD);
          expect(panel.ai.proveedorResponde).toBe(true);
          expect(panel.ai.advertencia).toBe('');
        });
      }

      // Y al revés: si el ÚLTIMO puesto es el que cayó, sí avisa. El desempate no está
      // ignorando la caída, está eligiendo bien cuál fue la última.
      await admin`delete from llamada_ai where workspace_id = ${wsD}`;
      await admin.begin(async (tx) => {
        for (const [puesto, i] of [
          { modelo: MODELO_PRIMARIO, resultado: 'salida-valida', motivo: '' },
          { modelo: MODELO_FALLBACK, resultado: 'sin-respuesta', motivo: 'el respaldo tampoco' },
        ].entries()) {
          await tx`insert into llamada_ai
            (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, motivo,
             intento, creado_por)
            values (${wsD}, 'C0', ${retoD!.id as string}, ${i.modelo}, 'entorno',
                    ${i.resultado}, ${i.motivo}, ${puesto}, ${leadId})`;
        }
      });
      await conProveedor(RESPUESTA_CI, async () => {
        const panel = await panelPropuestas(leadId, wsD);
        expect(panel.ai.proveedorResponde).toBe(false);
      });
    } finally {
      await admin`delete from llamada_ai where workspace_id = ${wsD}`;
      await admin`delete from reto where workspace_id = ${wsD}`;
      await admin`delete from servicio where workspace_id = ${wsD}`;
      await admin`delete from miembro where workspace_id = ${wsD}`;
      await admin`delete from workspace where id = ${wsD}`;
    }
  });

  it('la caída de un workspace no apaga el panel del otro', async () => {
    // El aislamiento no hay que construirlo: `llamada_ai` lleva `workspace_id`, así que la
    // señal nace por inquilino. Es la razón de derivarla del libro en vez de cachearla en el
    // proceso, donde este aislamiento habría que decidirlo, escribirlo y probarlo a mano —y
    // donde un interruptor pegado apagaría la capacidad de todos a la vez.
    const admin = sqlAdmin();
    const [otroWs] = await admin`insert into workspace (nombre) values ('Vecino con AI caída')
      returning id`;
    const vecino = otroWs!.id as string;
    try {
      // El lead de este test NO es miembro del vecino, que es justo el caso: su panel no
      // puede enterarse de una caída ajena ni siquiera indirectamente.
      const [svcV] = await admin`insert into servicio (workspace_id, nombre, creado_por)
        values (${vecino}, 'Servicio del vecino', ${leadId}) returning id`;
      const [retoV] = await admin`insert into reto
        (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
        values (${vecino}, ${svcV!.id as string}, 'R-V1', 'Reto del vecino', 'candidato',
                'peticion-cliente', ${leadId})
        returning id`;
      await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, motivo, creado_por)
        values (${vecino}, 'C0', ${retoV!.id as string}, ${MODELO_RELLENO}, 'entorno',
                'sin-respuesta', 'caída del vecino', ${leadId})`;

      await conProveedor(RESPUESTA_CI, async () => {
        const mio = await panelPropuestas(leadId, ws);
        expect(mio.ai.proveedorResponde).toBe(true);
        expect(mio.ai.advertencia).toBe('');
      });
    } finally {
      await admin`delete from llamada_ai where workspace_id = ${vecino}`;
      await admin`delete from reto where workspace_id = ${vecino}`;
      await admin`delete from servicio where workspace_id = ${vecino}`;
      await admin`delete from workspace where id = ${vecino}`;
    }
  });

  it('el inquilino no puede subirse su propio cupo: la promesa es del grant, no del código', async () => {
    // Un cupo que el propio workspace pudiera escribir no es un cupo. `designio_app` tiene
    // sobre `workspace` únicamente SELECT, así que no hay ruta de aplicación —ni pantalla,
    // ni SQL crudo con la identidad del lead— que lo toque. Se comprueba por la vía cruda
    // justamente porque una pantalla que hoy no existe no prueba nada sobre mañana.
    await expect(
      conUsuario(leadId, (tx) => tx`update workspace set limite_llamadas_ai_dia = 9999
        where id = ${ws}`),
    ).rejects.toThrow(/permission denied|no autorizado/i);

    // Y la base tampoco admite un cupo imposible por la vía administrativa: el CHECK es el
    // suelo, así que la validación de TS es la última línea y no la única.
    await expect(
      sqlAdmin()`update workspace set limite_llamadas_ai_dia = 0 where id = ${ws}`,
    ).rejects.toThrow(/limite_llamadas_ai_dia/);

    // El suelo no es 1, es INTENTOS_POR_GENERACION. Una generación reserva sus dos intentos
    // antes de llamar, así que con cupo 1 el hueco nunca alcanza: la capacidad quedaría
    // apagada para siempre detrás de un mensaje que se lee como «vuelve mañana». El número
    // sale de la constante, que es lo que ata este CHECK al código que lo hace necesario.
    await expect(
      sqlAdmin()`update workspace set limite_llamadas_ai_dia = ${INTENTOS_POR_GENERACION - 1}
        where id = ${ws}`,
    ).rejects.toThrow(/limite_llamadas_ai_dia/);

    // Y con EXACTAMENTE el mínimo sí se puede generar: el suelo está donde deja pasar, no un
    // hueco por encima.
    await sqlAdmin()`update workspace set limite_llamadas_ai_dia = ${INTENTOS_POR_GENERACION}
      where id = ${ws}`;
    try {
      await conProveedor(RESPUESTA_CI, async () => {
        const panel = await panelPropuestas(leadId, ws);
        expect(panel.ai.limiteDiario).toBe(INTENTOS_POR_GENERACION);
      });
    } finally {
      await sqlAdmin()`update workspace set limite_llamadas_ai_dia = null where id = ${ws}`;
    }
    const [tras] = await sqlAdmin()`select limite_llamadas_ai_dia from workspace where id = ${ws}`;
    expect(tras!.limite_llamadas_ai_dia).toBeNull();
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
      anclas: { item_id: itemId },
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
      // Toda evidencia nace con su registro de derechos (SPEC-03, trigger diferido). El
      // fixture lo pone para que la evidencia sea VÁLIDA y lo que rechace la transacción
      // sea la regla que este test mide, no la de otro slice.
      await tx`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
        values (${ws}, ${e!.id as string}, ${leadId})`;
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
      anclas: { reto_id: retoId },
    });
    const p2 = await nuevaPropuesta(leadId, {
      capacidad: 'C0',
      anclas: { reto_id: retoId },
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
      anclas: { item_id: itemId },
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
        // Toda evidencia nace con su registro de derechos (SPEC-03, trigger diferido). El
        // fixture lo pone para que la evidencia sea VÁLIDA y lo que rechace la transacción
        // sea la regla que este test mide, no la de otro slice.
        await tx`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
          values (${ws}, ${e!.id as string}, ${leadId})`;
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
      nuevaPropuesta(leadId, { capacidad: 'CI', anclas: { item_id: soloRef } }),
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
    expect(panel.candidatas.CI.lista.find((i) => i.id === itemId)?.consentimientoPendiente).toBe(true);
    // Y no se derrama: un item que no es de personas se ofrece sin marca.
    expect(panel.candidatas.CI.lista.find((i) => i.id === notaId)?.consentimientoPendiente).toBe(false);
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
      nuevaPropuesta(leadId, { capacidad: 'CI', anclas: { item_id: itemId } }),
    ).rejects.toThrow(/duplicate key|unique/i);

    // Decidida la primera, el hueco se libera: el índice solo cubre las pendientes.
    const [p] = await conUsuario(leadId, (tx) => tx`select id from propuesta_ai
      where workspace_id = ${ws} and item_id = ${itemId} and estado = 'propuesta'`);
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId: p!.id as string });
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', anclas: { item_id: itemId } }),
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

    // Lo que costó una llamada YA CERRADA no se reescribe ni se borra desde la app. La
    // garantía es la misma de siempre, pero desde el libro anticipado la impone otra pieza y
    // conviene que el test lo diga: antes era la AUSENCIA de grant de UPDATE; ahora el grant
    // existe —hace falta para cerrar la línea— y quien cierra la puerta es el `using` de
    // `llamada_completar`, que solo alcanza a las filas en `despachada`.
    //
    // Por eso esto NO lanza: la política no rechaza, FILTRA. La fila ya cerrada queda fuera
    // del alcance del update y no se toca ninguna, que es un rechazo igual de firme y con
    // otra forma. Se comprueba contando filas afectadas, no esperando una excepción.
    const tocadas = await conUsuario(leadId, (tx) => tx`update llamada_ai set costo_usd = 0
      where id = ${fila!.llamada_id as string} returning id`);
    expect(tocadas.length).toBe(0);
    const [intacta] = await sqlAdmin()`select costo_usd from llamada_ai
      where id = ${fila!.llamada_id as string}`;
    expect(Number(intacta!.costo_usd)).toBeCloseTo(costoDeUso(MODELO_PRIMARIO, USO_CI)!, 6);

    // El DELETE sí sigue siendo permiso denegado: nunca hubo grant y no lo hay ahora.
    await expect(
      conUsuario(leadId, (tx) => tx`delete from llamada_ai
        where id = ${fila!.llamada_id as string}`),
    ).rejects.toThrow(/permission denied/);

    // Y las columnas que la línea AFIRMÓ al abrirse tampoco se pueden reescribir: el modelo,
    // el ancla, la credencial y el consentimiento quedaron fuera del grant a propósito.
    // Poder cambiarlos después convertiría el apunte previo en una promesa vacía.
    await expect(
      conUsuario(leadId, (tx) => tx`update llamada_ai set modelo = 'otro'
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
      // Una llamada POR propuesta: un lote sale de una sola llamada y tiene techo, así que
      // colgar n de la misma describía un estado que el sistema no puede producir.
      const filas = await admin`
        with l as (
          insert into llamada_ai
            (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
          select ${wsP}, 'C0', ${retoP}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                 ${curadorId}
          from generate_series(1, ${n})
          returning id
        ),
        numeradas as (select id, (row_number() over ())::int as g from l)
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original, modelo,
           prompt_version, origen_key, llamada_id, creado_por, creado_en)
        select ${wsP}, 'C0', 'criterio-exito', ${retoP}, ${admin.json(CONTENIDO_C0)},
               ${admin.json(CONTENIDO_C0)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'entorno',
               n.id, ${curadorId},
               now() - make_interval(mins => ${desdeMinutos} - n.g)
        from numeradas n
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
      expect(panel.candidatas.CI.lista.length).toBe(50);
      expect(panel.candidatas.CI.hayMas).toBe(true);
      expect(panel.candidatas.C0.lista.length).toBe(50);
      expect(panel.candidatas.C0.hayMas).toBe(true);
      // El MÁS ANTIGUO encabeza la lista. Con el orden inverso, los items viejos caían
      // fuera del corte y ninguna acción del producto volvía a acercarlos: seguían
      // pendientes y elegibles, pero imposibles de elegir.
      expect(panel.candidatas.CI.lista[0]!.titulo).toBe('Item 01');
      expect(panel.candidatas.CI.lista.at(-1)!.titulo).toBe('Item 50');
      expect(panel.candidatas.CI.lista.some((i) => i.titulo === 'Item 60')).toBe(false);

      // Y la ventana avanza al drenar la cabeza: curar los diez primeros a mano hace
      // entrar solos a los que faltaban. Eso es lo que convierte el corte en una ventana
      // y no en un agujero.
      await admin`update item_importacion
        set estado = 'rechazado', decidido_por = ${curadorId}, decidido_en = now()
        where workspace_id = ${wsA} and titulo <= 'Item 10'`;
      const despues = await panelPropuestas(curadorId, wsA);
      expect(despues.candidatas.CI.lista[0]!.titulo).toBe('Item 11');
      expect(despues.candidatas.CI.lista.some((i) => i.titulo === 'Item 60')).toBe(true);
      expect(despues.candidatas.CI.hayMas).toBe(false);

      // Y la promesa incondicional: con más anclas elegibles que sitio en la lista, NINGÚN
      // orden alcanza —el drenaje ayuda, pero exige trabajar lo que va delante—. Buscar por
      // nombre llega a cualquiera sin drenar nada y sin gastar presupuesto en el camino.
      const buscado = await panelPropuestas(curadorId, wsA, 'Item 58');
      expect(buscado.candidatas.CI.lista.map((i) => i.titulo)).toEqual(['Item 58']);
      expect(buscado.candidatas.CI.hayMas).toBe(false);
      const porCodigo = await panelPropuestas(curadorId, wsA, 'R-052');
      expect(porCodigo.candidatas.C0.lista).toHaveLength(1);
      expect(porCodigo.busqueda).toBe('R-052');
      // El texto se busca LITERAL: un comodín de LIKE escrito por la persona es un carácter
      // más, no un «dámelo todo» que haría creer que la búsqueda no filtra.
      const comodin = await panelPropuestas(curadorId, wsA, '%');
      expect(comodin.candidatas.CI.lista).toHaveLength(0);
    });
  });

  it('los retos también drenan: un reto con criterios propuestos sale de la lista', async () => {
    await enWorkspaceLimpio('drenaje', async ({ ws: wsD, curadorId, retoId: retoD }) => {
      const antes = await panelPropuestas(curadorId, wsD);
      expect(antes.candidatas.C0.lista.some((r) => r.id === retoD)).toBe(true);

      await conProveedor(
        { ok: true, datos: { criterios: [CONTENIDO_C0] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsD, capacidad: 'C0', anclaId: retoD }),
      );

      // Un reto no cambia de estado por generarle criterios, así que sin esta condición se
      // quedaba en la lista para siempre y con más de 50 retos abiertos los de atrás eran
      // inalcanzables: el orden FIFO ordenaba, pero no drenaba.
      const conPendiente = await panelPropuestas(curadorId, wsD);
      expect(conPendiente.candidatas.C0.lista.some((r) => r.id === retoD)).toBe(false);
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
      expect(drenado.candidatas.C0.lista.some((r) => r.id === retoD)).toBe(true);
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
      const marcado = panel.candidatas.CI.lista.find((i) => i.id === (soloRef!.id as string));
      // Se ofrece MARCADO: la pantalla explica que no hay texto que citar y por dónde
      // sigue el trabajo (la bandeja), en vez de esconder el item sin decir por qué.
      expect(marcado?.sinMaterial).toBe(true);
      expect(
        panel.candidatas.CI.lista.find((i) => i.id === (conTexto!.id as string))?.sinMaterial,
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
      expect(antes.candidatas.C0.lista.some((r) => r.id === retoC)).toBe(false);

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
      expect(despues.candidatas.C0.lista.some((r) => r.id === retoC)).toBe(false);

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
      expect(reabierto.candidatas.C0.lista.some((r) => r.id === retoC)).toBe(false);
      const aceptada = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: viva.id,
      });
      expect(aceptada.estado).toBe('aceptada');
      // Y decidida la última pendiente, el reto vuelve a la lista: la ventana avanza al
      // trabajar, que es justo lo que le faltaba a los retos.
      const drenado = await panelPropuestas(curadorId, wsC);
      expect(drenado.candidatas.C0.lista.some((r) => r.id === retoC)).toBe(true);
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
      expect(panel.candidatas.C0.lista.some((r) => r.id === retoR)).toBe(false);

      // Y lo que dice la pantalla se confirma contra la base, por los tres caminos:
      // aceptar la propuesta… y con un error de DOMINIO, no con el del driver. Esto es lo
      // que se había roto: el `catch` de `materializarCriterio` reconocía la palabra
      // «congelados» —la del mensaje del G0— y el `raise` del registry no la lleva, así que
      // el PostgresError crudo llegaba entero a la pantalla de revisión. Comprobar solo el
      // texto habría pasado igual, porque el mensaje que se lee es el mismo: lo que
      // distingue una cosa de la otra es la CLASE.
      const p = panel.pendientes[0]!;
      const alAceptar = await aceptarPropuesta(curadorId, {
        workspaceId: wsR,
        propuestaId: p.id,
      }).catch((e: unknown) => e);
      expect(alAceptar).toBeInstanceOf(ErrorAI);
      expect((alAceptar as ErrorAI).message).toMatch(/registry de medición de ese reto/i);
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

  it('el libro no puede afirmar un consentimiento que no existe, no es del item o denegaba', async () => {
    // `consentimiento_version` es el sustrato de la remediación de RF-09.4: «qué salió, a
    // qué proveedor y bajo qué permiso». Un entero suelto lo convertía en una afirmación
    // que nadie comprueba, y un número en el que se confía sin poder verificarlo es peor
    // que no tenerlo. Aquí se prueba que está ATADO, en las cuatro direcciones.
    const admin = sqlAdmin();
    const entrevista = await nuevoItem('Entrevista atada', 'entrevista');
    const otra = await nuevoItem('Otra entrevista', 'entrevista');
    const nota = await nuevoItem('Nota sin personas', 'nota');
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId: entrevista,
      alcance: 'Autoriza el procesamiento por el proveedor AI',
      procesamientoExterno: true,
    });
    // En el otro item, una v1 que NIEGA y una v2 que autoriza: existen las dos y son
    // reales, y ninguna de las dos puede amparar una salida del PRIMER item.
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId: otra,
      alcance: 'Solo uso interno: no autoriza al proveedor',
      procesamientoExterno: false,
    });
    await registrarConsentimiento(leadId, {
      workspaceId: ws,
      itemId: otra,
      alcance: 'Ahora sí autoriza al proveedor',
      procesamientoExterno: true,
    });

    const llamada = (itemId: string, version: number | null) => admin`insert into llamada_ai
      (workspace_id, capacidad, item_id, modelo, origen_key, resultado, motivo,
       consentimiento_version, creado_por)
      values (${ws}, 'CI', ${itemId}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida', '',
              ${version}, ${leadId})
      returning id`;

    // 1) Una versión que no existe para nadie.
    await expect(llamada(entrevista, 9)).rejects.toThrow(/foreign key|llave foránea/i);
    // 2) Una versión que existe, que AUTORIZA… pero es de OTRO item. La FK es compuesta con
    //    `item_id`, así que la v2 de `otra` no ampara una salida de `entrevista`.
    await expect(llamada(entrevista, 2)).rejects.toThrow(/foreign key|llave foránea/i);
    // 3) La versión existe, es de su item… y DENEGABA el procesamiento externo. Es el caso
    //    que una FK simple a la bitácora no habría visto, y el que más importa: material
    //    personal figurando como amparado por un permiso que decía que no.
    await expect(llamada(otra, 1)).rejects.toThrow(/foreign key|llave foránea/i);
    // 4) Y las dos direcciones del «null significa no aplicaba»: material de personas sin
    //    citar permiso, y material que no lo exige citando uno.
    await expect(llamada(entrevista, null)).rejects.toThrow(/falta consentimiento_version/i);
    await expect(llamada(nota, 1)).rejects.toThrow(/no exige consentimiento/i);

    // Y el guard NO responde a quien no es de aquí: sus mensajes distinguen «este material
    // exige consentimiento» de «no lo exige» y de «esa versión no existe», así que
    // contestarle a un no-miembro convertiría el guard en un oráculo — sondeando uuids se
    // aprendería si un item de otro tenant existe y de qué tipo es, aunque la política
    // rechace el insert justo después. Lo que se filtraría no es la fila, es la respuesta.
    const [wsZ] = await admin`insert into workspace (nombre) values (${marca + '-Z'}) returning id`;
    const [uz] = await admin`insert into usuario (email, nombre, estado)
      values (${marca + '-z@test.demo'}, 'De otra casa', 'activo') returning id`;
    await admin`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
      values (${wsZ!.id as string}, ${uz!.id as string}, 'De otra casa',
              ${marca + '-z@test.demo'}, 'lead-boutique')`;
    try {
      const forastero = conUsuario(uz!.id as string, (tx) => tx`insert into llamada_ai
        (workspace_id, capacidad, item_id, modelo, origen_key, resultado, motivo,
         consentimiento_version, creado_por)
        values (${ws}, 'CI', ${entrevista}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                '', null, ${uz!.id as string})`);
      await expect(forastero).rejects.toThrow(/row-level security/i);
      // Y en concreto: NO se lleva el diagnóstico que sí recibe quien sí es de aquí.
      await expect(forastero).rejects.not.toThrow(/falta consentimiento_version/i);
    } finally {
      await admin`delete from miembro where workspace_id = ${wsZ!.id as string}`;
      await admin`delete from workspace where id = ${wsZ!.id as string}`;
      await admin`delete from usuario where id = ${uz!.id as string}`;
    }

    // Control: los dos casos buenos entran.
    const [buena] = await llamada(entrevista, 1);
    const [sinPersonas] = await llamada(nota, null);
    const [leida] = await admin`select consentimiento_version, consentimiento_autoriza_externo
      from llamada_ai where id = ${buena!.id as string}`;
    expect(leida!.consentimiento_version).toBe(1);
    // La columna que lleva la constante dentro de la FK la deriva la BASE: no está en el
    // insert de nadie, así que no se puede mentir en ella.
    expect(leida!.consentimiento_autoriza_externo).toBe(true);
    await admin`delete from llamada_ai where id in
      (${buena!.id as string}, ${sinPersonas!.id as string})`;
  });

  it('la procedencia es una relación, no una coincidencia de transacción', async () => {
    // `xmin` demuestra «nació en esta transacción», y el linaje AFIRMA «la produjo esta
    // propuesta». En el hueco cabía todo esto: crear a mano una evidencia que no tiene nada
    // que ver, sellar con ella el item que cuadra y marcar la propuesta como aceptada —
    // todo en un commit, así que todos los predicados de `xmin` pasaban. Y el daño no es
    // solo de auditoría: contenido escrito a mano quedaba contado como aceptado tal cual
    // del modelo, que es la métrica con la que se decide si esta capacidad sirve.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item de la procedencia');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      anclas: { item_id: itemId },
      contenido: CONTENIDO_CI,
    });

    // El ataque, con la misma forma exacta que usa el servicio y en una sola transacción.
    await expect(
      conUsuario(leadId, async (tx) => {
        const [f] = await tx`insert into fuente (workspace_id, tipo, titulo, referencia,
            creado_por)
          values (${ws}, 'nota', 'Fuente a mano', 'ref', ${leadId}) returning id`;
        const [e] = await tx`insert into evidencia
          (workspace_id, fuente_id, titulo, resumen, dimensiones, es_estado_actual, creado_por)
          values (${ws}, ${f!.id as string}, 'Título que me he inventado',
                  'Resumen que no propuso nadie',
                  ${tx.json({
                    proveniencia: { tipoFuente: 'nota', fecha: '2026-07-20', localizacion: 'ref' },
                    metodo: { recoleccion: 'a mano', derivada: false, segmentoIds: [] },
                    calidad: { confianza: 'alta', corroboraIds: [], contradiceIds: [] },
                    derechos: { consentimiento: false, confidencialidad: 'interna' },
                  })},
                  true, ${leadId}) returning id`;
        const evidenciaId = e!.id as string;
        // Toda evidencia nace con su registro de derechos (SPEC-03, trigger diferido). El
        // fixture lo pone para que la evidencia sea VÁLIDA y lo que rechace la transacción
        // sea la regla que este test mide, no la de otro slice.
        await tx`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
          values (${ws}, ${evidenciaId}, ${leadId})`;
        await tx`update item_importacion
          set estado = 'aprobado', decidido_por = ${leadId}, decidido_en = now(),
              evidencia_id = ${evidenciaId}
          where id = ${itemId} and workspace_id = ${ws}`;
        await tx`update propuesta_ai
          set estado = 'aceptada', revisada_por = ${leadId}, evidencia_id = ${evidenciaId}
          where id = ${propuestaId} and workspace_id = ${ws}`;
      }),
    ).rejects.toThrow(/no dice lo que dice la propuesta/i);

    // Y la variante fina, que es la que se escapaba: los tres campos de columna coinciden
    // con la propuesta —así que la comprobación de arriba pasa— y lo falsificado vive DENTRO
    // de `dimensiones`, que también se copia verbatim en cinco de sus claves más el lineage.
    // Una fecha, una confianza o un modelo distintos convierten la evidencia en otra cosa
    // mientras la propuesta consta como aceptada tal cual.
    await expect(
      conUsuario(leadId, async (tx) => {
        const [f] = await tx`insert into fuente (workspace_id, tipo, titulo, referencia,
            creado_por)
          values (${ws}, 'nota', 'Fuente a mano', 'ref', ${leadId}) returning id`;
        const [e] = await tx`insert into evidencia
          (workspace_id, fuente_id, titulo, resumen, dimensiones, es_estado_actual, creado_por)
          values (${ws}, ${f!.id as string}, ${CONTENIDO_CI.titulo}, ${CONTENIDO_CI.resumen},
                  ${tx.json({
                    proveniencia: { tipoFuente: 'nota', fecha: '2020-01-01', localizacion: 'ref' },
                    metodo: { recoleccion: 'otra cosa', derivada: false, segmentoIds: [] },
                    calidad: { confianza: 'alta', corroboraIds: [], contradiceIds: [] },
                    derechos: { consentimiento: false, confidencialidad: 'interna' },
                    lineage: { modelo: 'otro-modelo', promptVersion: 'v0' },
                  })},
                  ${CONTENIDO_CI.esEstadoActual}, ${leadId}) returning id`;
        const evidenciaId = e!.id as string;
        // Toda evidencia nace con su registro de derechos (SPEC-03, trigger diferido). El
        // fixture lo pone para que la evidencia sea VÁLIDA y lo que rechace la transacción
        // sea la regla que este test mide, no la de otro slice.
        await tx`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
          values (${ws}, ${evidenciaId}, ${leadId})`;
        await tx`update item_importacion
          set estado = 'aprobado', decidido_por = ${leadId}, decidido_en = now(),
              evidencia_id = ${evidenciaId}
          where id = ${itemId} and workspace_id = ${ws}`;
        await tx`update propuesta_ai
          set estado = 'aceptada', revisada_por = ${leadId}, evidencia_id = ${evidenciaId}
          where id = ${propuestaId} and workspace_id = ${ws}`;
      }),
    ).rejects.toThrow(/no dice lo que dice la propuesta/i);

    // Y por el camino bueno, el vínculo queda ESCRITO en la fila materializada — no en la
    // propuesta, que es la que afirma— y lo escribe el guard: la aplicación no tiene grant
    // sobre esa columna ni para ponerla ni para quitarla.
    const r = await aceptarPropuesta(leadId, { workspaceId: ws, propuestaId });
    expect(r.estado).toBe('aceptada');
    const [ev] = await conUsuario(leadId, (tx) => tx`select titulo, dimensiones,
        propuesta_ai_id from evidencia where id = ${r.objetoId}`);
    expect(ev!.propuesta_ai_id).toBe(propuestaId);
    // El título es el de la propuesta, que es lo que la proyección exige — y las claves del
    // jsonb que también se copian, también.
    expect(ev!.titulo).toBe(CONTENIDO_CI.titulo);
    const dim = ev!.dimensiones as Record<string, Record<string, unknown>>;
    expect(dim.proveniencia!.fecha).toBe(CONTENIDO_CI.fecha);
    expect(dim.metodo!.recoleccion).toBe(CONTENIDO_CI.recoleccion);
    expect(dim.calidad!.confianza).toBe(CONTENIDO_CI.confianza);
    expect(dim.derechos!.confidencialidad).toBe(CONTENIDO_CI.confidencialidad);
    expect(dim.lineage!.modelo).toBe(MODELO_PRIMARIO);
    await expect(
      conUsuario(leadId, (tx) => tx`update evidencia set propuesta_ai_id = null
        where id = ${r.objetoId}`),
    ).rejects.toThrow(/permission denied/i);

    // Y el objeto no puede pasar a colgar de OTRA propuesta: el índice único lo impide para
    // siempre, no solo dentro de la transacción que lo creó.
    const otroItem = await nuevoItem('Otro item de la procedencia');
    const otraPropuesta = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      anclas: { item_id: otroItem },
      contenido: CONTENIDO_CI,
    });
    await expect(
      conUsuario(leadId, (tx) => tx`update propuesta_ai
        set estado = 'aceptada', revisada_por = ${leadId}, evidencia_id = ${r.objetoId}
        where id = ${otraPropuesta} and workspace_id = ${ws}`),
    ).rejects.toThrow();
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId: otraPropuesta });
    await admin`update evidencia set propuesta_ai_id = null where workspace_id = ${ws}`;
  });

  it('corregir antes de aceptar sigue siendo legítimo: la proyección mira lo corregido', async () => {
    // La contrapartida imprescindible de la comprobación anterior. «Aprobar incluye
    // enmendar» (I4), así que un guard que exigiera el contenido ORIGINAL convertiría cada
    // corrección en un fallo. Se compara contra `contenido`, que la corrección reescribe en
    // la misma sentencia que dispara el guard — de ahí que el objeto materializado sea el
    // corregido y la propuesta salga `corregida`, que es justo el dato que hay que medir.
    const itemId = await nuevoItem('Item que se corrige antes de aceptar');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      anclas: { item_id: itemId },
      contenido: CONTENIDO_CI,
    });
    const r = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId,
      // Las citas se reenvían intactas: son lo único que la corrección no puede tocar.
      correccion: { ...CONTENIDO_CI, titulo: 'Título corregido por la curadora' },
    });
    expect(r.estado).toBe('corregida');
    const [ev] = await conUsuario(leadId, (tx) => tx`select titulo, propuesta_ai_id
      from evidencia where id = ${r.objetoId}`);
    expect(ev!.titulo).toBe('Título corregido por la curadora');
    expect(ev!.propuesta_ai_id).toBe(propuestaId);
    await sqlAdmin()`update evidencia set propuesta_ai_id = null where id = ${r.objetoId}`;
  });

  it('una ventana de medio día no se guarda como un día: la rechaza el contrato, no el navegador', async () => {
    // El `step={1}` del input es una ayuda al usuario y no llega al servidor. Lo que sostiene
    // el dato es el esquema, y para que pueda hacerlo el valor tiene que llegarle ENTERO:
    // con `parseInt` el 2.5 se convertía en 2 antes de que Zod lo viera, así que quien
    // escribía dos días y medio guardaba dos sin enterarse. En una ventana de medición ese
    // día decide qué snapshots entran.
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'C0',
      anclas: { reto_id: retoId },
      contenido: CONTENIDO_C0,
    });
    await expect(
      aceptarPropuesta(leadId, {
        workspaceId: ws,
        propuestaId,
        correccion: { ...CONTENIDO_C0, ventanaDias: 2.5 },
      }),
    ).rejects.toThrow(/no cumple el formato/i);
    // Y el entero equivalente sí entra: lo que se rechaza es la fracción, no la corrección.
    const r = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId,
      correccion: { ...CONTENIDO_C0, ventanaDias: 3 },
    });
    expect(r.estado).toBe('corregida');
    const [c] = await conUsuario(leadId, (tx) => tx`select ventana_dias from criterio_exito
      where id = ${r.objetoId}`);
    expect(c!.ventana_dias).toBe(3);
    await sqlAdmin()`update criterio_exito set propuesta_ai_id = null where id = ${r.objetoId}`;
  });

  it('sin fecha en el material la propuesta nace igual, y fecharla es trabajo del humano', async () => {
    // La contradicción que esto cierra: `item_importacion` no garantiza que el material
    // traiga una fecha calendárica, el prompt prohíbe inventarlas y el esquema exigía una.
    // Al modelo solo le quedaban dos salidas — fabricarla, y se persistía como proveniencia
    // de la evidencia, o devolver algo que se descarta.
    const itemId = await nuevoItem('Item sin fecha en el material');
    const sinFecha = {
      ...CONTENIDO_CI,
      fecha: null,
      fechaLocalizacion: '',
      fechaSinDatoMotivo: 'el material no menciona ninguna fecha',
    };
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      anclas: { item_id: itemId },
      contenido: sinFecha,
    });

    // El panel la ofrece con la ausencia dicha y su motivo: «no consta» no es «no lo escribí».
    const panel = await panelPropuestas(leadId, ws);
    const p = panel.pendientes.find((x) => x.id === propuestaId)!;
    expect((p.contenido as ContenidoExtraccion).fecha).toBeNull();
    expect((p.contenido as ContenidoExtraccion).fechaSinDatoMotivo).toMatch(/no menciona/i);

    // Aceptarla TAL CUAL no puede ser: una evidencia se sitúa en el tiempo. Y lo dice con el
    // motivo del modelo, para que la curadora sepa qué buscar.
    const alAceptar = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId,
    }).catch((e: unknown) => e);
    expect(alAceptar).toBeInstanceOf(ErrorAI);
    expect((alAceptar as ErrorAI).message).toMatch(/no trae fecha del material/i);
    expect((alAceptar as ErrorAI).message).toMatch(/no menciona/i);

    // Fecharla al corregir sí, que es lo que I4 llama aprobar: aprobar incluye enmendar. Y
    // queda contada como CORRECCIÓN, que es exactamente lo que hay que poder medir.
    const r = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId,
      correccion: {
        ...sinFecha,
        fecha: '2026-07-01',
        fechaLocalizacion: 'acta de la sesión',
        fechaSinDatoMotivo: '',
      },
    });
    expect(r.estado).toBe('corregida');
    const [ev] = await conUsuario(leadId, (tx) => tx`select dimensiones from evidencia
      where id = ${r.objetoId}`);
    const dim = ev!.dimensiones as Record<string, Record<string, unknown>>;
    expect(dim.proveniencia!.fecha).toBe('2026-07-01');
    await sqlAdmin()`update evidencia set propuesta_ai_id = null where id = ${r.objetoId}`;
  });

  it('la fecha es un XOR: ni las dos cosas ni ninguna', async () => {
    // El esquema es la puerta, así que se prueba por el esquema y no por el formulario.
    const base = { ...CONTENIDO_CI };
    // Las dos a la vez: un dato que se contradice a sí mismo.
    expect(() =>
      parsearContenido('CI', { ...base, fecha: '2026-07-20', fechaSinDatoMotivo: 'no la trae' }),
    ).toThrow();
    // Ninguna: la ausencia sin motivo es «no lo escribí», que es justo lo que no vale.
    expect(() =>
      parsearContenido('CI', { ...base, fecha: null, fechaLocalizacion: '', fechaSinDatoMotivo: '' }),
    ).toThrow();
    // Y una fecha sin sitio en el material es indistinguible de una inventada.
    expect(() => parsearContenido('CI', { ...base, fechaLocalizacion: '' })).toThrow();
    // Los dos casos legítimos pasan.
    expect(() => parsearContenido('CI', base)).not.toThrow();
    expect(() =>
      parsearContenido('CI', {
        ...base,
        fecha: null,
        fechaLocalizacion: '',
        fechaSinDatoMotivo: 'el material no la menciona',
      }),
    ).not.toThrow();
  });

  it('C0 también cita, y su presencia literal se mide contra la formulación del reto', async () => {
    // Sin citas, C0 no salía MAL en la medición de grounding de RF-09.10: salía EXCLUIDA, en
    // silencio. Y una capacidad que no puede salir mal en la métrica de calidad es la que
    // más falta hace medir. Además I4 lo pide con todas las letras: la AI propone Y CITA.
    await enWorkspaceLimpio('citas-c0', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      await admin`update reto set descripcion = ${'Los clientes abandonan la verificación de identidad antes de terminarla.'},
          metrica_objetivo = 'Bajar el abandono al 40%'
        where id = ${retoC}`;
      const generadas = await conProveedor(
        {
          ok: true,
          datos: {
            criterios: [
              {
                ...CONTENIDO_C0,
                citas: [
                  // Literal de la descripción del reto…
                  {
                    fragmento: 'abandonan la verificación de identidad',
                    localizacion: 'descripción del reto',
                  },
                  // …y una inventada, para que el panel las distinga.
                  { fragmento: 'esto no está en el reto', localizacion: 'descripción del reto' },
                ],
              },
            ],
          },
          intentos: [intento({ latenciaMs: 70, uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C0', anclaId: retoC }),
      );
      expect(generadas.generadas).toBe(1);

      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes[0]!;
      // Las citas se pintan y se miden, igual que las de CI: una presente y una inventada.
      expect(p.citas.map((c) => c.presenteLiteral)).toEqual([true, false]);
      // Y la confianza declarada llega a la columna que ordena la revisión, que antes se
      // quedaba en nulo para TODA propuesta no sembrada.
      expect(p.confianza).toBe(CONFIANZA_PROPUESTA_NUMERICA[CONTENIDO_C0.confianzaPropuesta]);

      // Corregir un criterio C0 no permite reescribir ni sus citas ni su confianza.
      const contenido = p.contenido as ContenidoCriterio;
      await expect(
        aceptarPropuesta(curadorId, {
          workspaceId: wsC,
          propuestaId: p.id,
          correccion: {
            ...contenido,
            citas: [{ fragmento: 'inventada a mano', localizacion: 'ninguna' }],
          },
        }),
      ).rejects.toThrow(/no se corrigen/i);
      await expect(
        aceptarPropuesta(curadorId, {
          workspaceId: wsC,
          propuestaId: p.id,
          correccion: { ...contenido, confianzaPropuesta: 'alta' },
        }),
      ).rejects.toThrow(/no se corrigen/i);
    });
  });

  it('la cola pone lo más DUDOSO primero, con la antigüedad de desempate', async () => {
    // Persistir `confianza` argumentando que «ordena la revisión humana» y después no ordenar
    // por ella no entrega esa conducta. Pero la DIRECCIÓN importa tanto como ordenar: la
    // revisión humana es el recurso escaso, y lo escaso se gasta donde más rinde. Lo que el
    // modelo declara muy seguro es lo que menos probablemente cambie al mirarlo; lo dudoso es
    // donde el ojo humano decide de verdad.
    await enWorkspaceLimpio('orden', async ({ ws: wsO, curadorId }) => {
      const admin = sqlAdmin();
      const niveles = ['baja', 'alta', 'media'] as const;
      for (const nivel of niveles) {
        const [i] = await admin`insert into item_importacion
          (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
          values (${wsO}, ${`Item ${nivel}`}, ${MATERIAL}, 'nota', 'ref', ${curadorId})
          returning id`;
        await conProveedor(
          {
            ok: true,
            datos: { ...CONTENIDO_CI, confianzaPropuesta: nivel },
            intentos: [intento({ latenciaMs: 50, uso: null })],
          },
          () =>
            generarPropuestas(curadorId, {
              workspaceId: wsO,
              capacidad: 'CI',
              anclaId: i!.id as string,
            }),
        );
      }

      const panel = await panelPropuestas(curadorId, wsO);
      // Se generaron en orden baja → alta → media; la cola las devuelve de menor a mayor.
      expect(panel.pendientes.map((p) => p.confianza)).toEqual([
        CONFIANZA_PROPUESTA_NUMERICA.baja,
        CONFIANZA_PROPUESTA_NUMERICA.media,
        CONFIANZA_PROPUESTA_NUMERICA.alta,
      ]);
      // Y el total es el total, no lo que cabe: con el corte, lo que queda detrás son ahora las
      // MÁS fiables, que siguen siendo trabajo pendiente aunque ya no sean lo que más urge.
      expect(panel.totalPendientes).toBe(3);
      expect(panel.hayMasPendientes).toBe(false);

      // ── Los nulos NO se promueven al invertir ──
      // «Sin confianza declarada» no es «confianza cero»: son las sembradas o las escritas por
      // SQL crudo. Con el orden ascendente, tratarlas como el valor más dudoso posible las
      // pondría en cabeza — que es justo la mentira que `nulls last` existe para no contar.
      const [iSin] = await admin`insert into item_importacion
        (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
        values (${wsO}, 'Item sin confianza declarada', ${MATERIAL}, 'nota', 'ref', ${curadorId})
        returning id`;
      const [lSin] = await admin`insert into llamada_ai
        (workspace_id, capacidad, item_id, modelo, origen_key, resultado, creado_por)
        values (${wsO}, 'CI', ${iSin!.id as string}, ${MODELO_PRIMARIO}, 'entorno',
                'salida-valida', ${curadorId})
        returning id`;
      await admin`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por)
        values (${wsO}, 'CI', 'evidencia', ${iSin!.id as string}, ${admin.json(CONTENIDO_CI)},
                ${admin.json(CONTENIDO_CI)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'entorno',
                ${lSin!.id as string}, ${curadorId})`;
      const conNulo = await panelPropuestas(curadorId, wsO);
      expect(conNulo.pendientes.map((p) => p.confianza)).toEqual([
        CONFIANZA_PROPUESTA_NUMERICA.baja,
        CONFIANZA_PROPUESTA_NUMERICA.media,
        CONFIANZA_PROPUESTA_NUMERICA.alta,
        null,
      ]);
    });
  });

  it('los relojes del slice no los escribe quien se mide con ellos', async () => {
    // Tres relojes que gobiernan decisiones y que la aplicación NO puede escribir, porque
    // `creado_en` está fuera de los tres grants de INSERT: el tope diario del workspace se
    // cuenta sobre `llamada_ai.creado_en` (RF-09.12), la caducidad del arrendamiento sobre
    // `reserva_ai.creado_en` —admisión, despacho y fencing— y el orden de la cola FIFO
    // sobre `propuesta_ai.creado_en`. Con el grant puesto, una llamada nacía fechada ayer y
    // no contaba para hoy, y una reserva nacía inmortal y bloqueaba su ancla para siempre.
    const itemId = await nuevoItem('Item de los relojes');
    const ayer = new Date(Date.now() - 36 * 3600 * 1000);
    await expect(
      conUsuario(leadId, (tx) => tx`insert into llamada_ai
        (workspace_id, capacidad, item_id, modelo, origen_key, resultado, motivo,
         creado_por, creado_en)
        values (${ws}, 'CI', ${itemId}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida', '',
                ${leadId}, ${ayer})`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      conUsuario(leadId, (tx) => tx`insert into reserva_ai
        (workspace_id, capacidad, item_id, unidades, creado_por, creado_en)
        values (${ws}, 'CI', ${itemId}, 1, ${leadId}, ${new Date(Date.now() + 9e8)})`),
    ).rejects.toThrow(/permission denied/i);
    const llamadaId = await nuevaLlamada({ capacidad: 'CI', anclas: { item_id: itemId } });
    await expect(
      conUsuario(leadId, (tx) => tx`insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, contenido, contenido_original, modelo,
         prompt_version, origen_key, llamada_id, creado_por, creado_en)
        values (${ws}, 'CI', 'evidencia', ${itemId}, '{"a":1}'::jsonb, '{"a":1}'::jsonb,
                ${MODELO_PRIMARIO}, 'v', 'entorno', ${llamadaId}, ${leadId}, ${ayer})`),
    ).rejects.toThrow(/permission denied/i);

    // Y sin nombrarlo, las mismas filas entran: lo estampa el DEFAULT, que es la única mano
    // sin motivos para mentir. Se comprueba que la fecha es de AHORA y no la que se pidió.
    await conUsuario(leadId, (tx) => tx`insert into reserva_ai
      (workspace_id, capacidad, item_id, unidades, creado_por)
      values (${ws}, 'CI', ${itemId}, 1, ${leadId})`);
    const [r] = await conUsuario(leadId, (tx) => tx`select creado_en from reserva_ai
      where workspace_id = ${ws} and item_id = ${itemId}`);
    expect(Date.now() - new Date(r!.creado_en as string).getTime()).toBeLessThan(60_000);
    await sqlAdmin()`delete from reserva_ai where workspace_id = ${ws} and item_id = ${itemId}`;
    await sqlAdmin()`delete from llamada_ai where id = ${llamadaId}`;
  });

  it('una reserva caducada ya no autoriza a guardar el lote: el relevo no queda duplicado', async () => {
    // Fencing de arrendamiento. El caso: un proceso se duerme más que la ventana entre que
    // el proveedor responde y que se persisten las propuestas. Para entonces otra petición
    // pudo recolectar su reserva caducada y despachar sobre la MISMA ancla; con un borrado
    // incondicional, el dormido insertaba igual y quedaban dos lotes vivos.
    //
    // Se prueba con C0 a propósito: es el que no tiene red estructural. `propuesta_ai` sí
    // impide dos pendientes por ITEM con un índice único parcial, pero el equivalente por
    // RETO no puede existir — C0 persiste un LOTE y sus propias filas hermanas violarían
    // ese índice—, así que aquí el token de exclusividad es la reserva y punto.
    await enWorkspaceLimpio('fencing', async ({ ws: wsF, curadorId, retoId: retoF }) => {
      const admin = sqlAdmin();
      // El sueño del proceso, simulado envejeciendo su propia reserva mientras el material
      // está en vuelo: es el mismo hueco de tiempo, visto desde el reloj.
      proveedor.duranteLlamada = async () => {
        await admin`update reserva_ai set creado_en = now() - reserva_ai_ventana() * 2
          where workspace_id = ${wsF} and reto_id = ${retoF}`;
      };
      try {
        await conProveedor(
          {
            ok: true,
            datos: { criterios: [CONTENIDO_C0] },
            intentos: [intento({ latenciaMs: 80, uso: null })],
          },
          async () => {
            await expect(
              generarPropuestas(curadorId, {
                workspaceId: wsF,
                capacidad: 'C0',
                anclaId: retoF,
              }),
            ).rejects.toThrow(/reserva de esta generación caducó/i);
          },
        );
      } finally {
        proveedor.duranteLlamada = null;
      }

      // Ninguna propuesta nació…
      const propuestas = await conUsuario(curadorId, (tx) => tx`select 1 as x
        from propuesta_ai where workspace_id = ${wsF} and reto_id = ${retoF}`);
      expect(propuestas.length).toBe(0);
      // …y la llamada, que se pagó, sigue anotada: el fencing tira el lote, no el libro.
      const llamadas = await conUsuario(curadorId, (tx) => tx`select resultado
        from llamada_ai where workspace_id = ${wsF} and reto_id = ${retoF}`);
      expect(llamadas.length).toBe(1);
      // Y la reserva caducada no se queda bloqueando el ancla: el `catch` de la generación
      // la retira igual, así que el reto vuelve a admitir una generación nueva.
      const reservas = await conUsuario(curadorId, (tx) => tx`select 1 as x
        from reserva_ai where workspace_id = ${wsF} and reto_id = ${retoF}`);
      expect(reservas.length).toBe(0);
    });
  });

  it('una llamada de CI respalda como mucho UNA propuesta', async () => {
    // `llamada_id` afirma «la llamada que ME produjo». Con dos propuestas de extracción
    // colgadas de la misma llamada esa frase solo puede ser cierta en una: la otra hereda un
    // coste, una latencia y un uso que no son suyos, el coste por propuesta se divide entre
    // filas que nadie pagó y el recuento de propuestas generadas crece sin gasto detrás.
    //
    // El índice de «una pendiente por item» NO lo cubría: solo alcanza a las pendientes, así
    // que decidir la primera dejaba libre el hueco para colgar una segunda de la llamada ya
    // pagada. Este test recorre exactamente ese camino.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item de una sola llamada');
    const llamadaId = await nuevaLlamada({ capacidad: 'CI', anclas: { item_id: itemId } });
    const insertar = () =>
      conUsuario(leadId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, item_id, contenido, contenido_original,
           modelo, prompt_version, alcance_resumen, origen_key, llamada_id, creado_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, ${tx.json(CONTENIDO_CI)},
                ${tx.json(CONTENIDO_CI)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                'alcance de prueba', 'entorno', ${llamadaId}, ${leadId})
        returning id`);

    const [primera] = await insertar();
    const propuestaId = primera!.id as string;
    try {
      // Se decide la primera, que es lo que liberaba el hueco del índice de pendientes.
      await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });
      await expect(insertar()).rejects.toThrow(/propuesta_ai_llamada_orden_idx|duplicate key|llave duplicada/i);

      // Control: con SU PROPIA llamada, la segunda propuesta entra. Lo que la rechazaba era
      // compartir la llamada, no nada del item ni del estado.
      const otraLlamada = await nuevaLlamada({ capacidad: 'CI', anclas: { item_id: itemId } });
      const [segunda] = await conUsuario(
        leadId,
        (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, item_id, contenido, contenido_original,
           modelo, prompt_version, alcance_resumen, origen_key, llamada_id, creado_por)
        values (${ws}, 'CI', 'evidencia', ${itemId}, ${tx.json(CONTENIDO_CI)},
                ${tx.json(CONTENIDO_CI)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                'alcance de prueba', 'entorno', ${otraLlamada}, ${leadId})
        returning id`);
      await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId: segunda!.id as string });
    } finally {
      await admin`delete from propuesta_ai where item_id = ${itemId}`;
      await admin`delete from llamada_ai where item_id = ${itemId}`;
      await admin`delete from item_importacion where id = ${itemId}`;
    }
  });

  it('C0 reparte una llamada entre su lote, y el lote tiene techo', async () => {
    // La asimetría con CI es deliberada y es la misma que la de la reserva: C0 persiste un
    // LOTE de una sola llamada, así que sus filas hermanas comparten `llamada_id`
    // legítimamente y el índice tiene que dejarlas pasar.
    //
    // Pero «legítimo» no es «sin límite», y ése era el agujero: el índice era PARCIAL de CI,
    // así que una llamada C0 podía respaldar propuestas sin fin. Cada propuesta afirma «esta
    // llamada ME produjo», y con más filas que criterios la frase deja de ser cierta en casi
    // todas: heredan un coste y un uso que no son suyos.
    //
    // «Único» y «sin restricción» no eran las dos únicas opciones. Con el PUESTO en el lote,
    // la cota vuelve a ser una regla de fila que Postgres impone sin preguntar «cuántas hay
    // ya» —la pregunta sobre el conjunto que dos transacciones responden a la vez sobre
    // snapshots distintos, y que ningún guard puede cerrar—.
    const admin = sqlAdmin();
    const llamadaId = await nuevaLlamada({ capacidad: 'C0', anclas: { reto_id: retoId } });
    const insertar = (orden: number) =>
      conUsuario(leadId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
           modelo, prompt_version, alcance_resumen, origen_key, llamada_id, orden, creado_por)
        values (${ws}, 'C0', 'criterio-exito', ${retoId}, ${tx.json(CONTENIDO_C0)},
                ${tx.json(CONTENIDO_C0)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                'alcance de prueba', 'entorno', ${llamadaId}, ${orden}, ${leadId})
        returning id`);
    const ids: string[] = [];
    try {
      // EXACTAMENTE el máximo entra. El número sale de la constante de TS, no de un literal:
      // es lo que ata los dos lados, porque la base no puede importarla y su CHECK lleva el
      // número escrito. Si alguien mueve uno de los dos, este test cae.
      for (let orden = 0; orden < MAX_CRITERIOS_POR_LOTE; orden++) {
        const [f] = await insertar(orden);
        ids.push(f!.id as string);
      }
      expect(ids.length).toBe(MAX_CRITERIOS_POR_LOTE);

      // Y UNA MÁS no. Por las dos vías, que son dos reglas distintas y conviene no
      // confundirlas: un puesto FUERA del rango lo rechaza el CHECK…
      await expect(insertar(MAX_CRITERIOS_POR_LOTE)).rejects.toThrow(/orden|check/i);
      // …y un puesto REPETIDO lo rechaza el índice único. Sin la segunda, bastaría con
      // colgar todas en el puesto 0 para tener un lote infinito dentro del rango.
      await expect(insertar(0)).rejects.toThrow(
        /propuesta_ai_llamada_orden_idx|duplicate key|llave duplicada/i,
      );

      // CI, en cambio, queda fijada al puesto 0 por CHECK: una extracción es un lote de uno,
      // y por eso el índice GENERAL sustituye al parcial sin perder lo que aquél garantizaba.
      const itemCI = await nuevoItem('Item que intenta un puesto que no le toca');
      const llamadaCI = await nuevaLlamada({ capacidad: 'CI', anclas: { item_id: itemCI } });
      await expect(
        conUsuario(leadId, (tx) => tx`
          insert into propuesta_ai
            (workspace_id, capacidad, destino, item_id, contenido, contenido_original,
             modelo, prompt_version, alcance_resumen, origen_key, llamada_id, orden, creado_por)
          values (${ws}, 'CI', 'evidencia', ${itemCI}, ${tx.json(CONTENIDO_CI)},
                  ${tx.json(CONTENIDO_CI)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                  'alcance de prueba', 'entorno', ${llamadaCI}, 1, ${leadId})
          returning id`),
      ).rejects.toThrow(/propuesta_ai_ci_puesto_unico|check/i);
      await admin`delete from llamada_ai where id = ${llamadaCI}`;
      await admin`delete from item_importacion where id = ${itemCI}`;
    } finally {
      for (const id of ids) await admin`delete from propuesta_ai where id = ${id}`;
      await admin`delete from llamada_ai where id = ${llamadaId}`;
    }
  });

  it('el asiento del árbol no lo puede escribir la aplicación mientras nada pueda llenarlo', async () => {
    // La FK impide apuntar al vacío o a otro tenant, pero no que se apunte a una propuesta
    // cualquiera de ESTE workspace. Como hoy ninguna capacidad materializa un afectado
    // —`destino` ni siquiera lo contempla—, cualquier valor ahí es una afirmación
    // necesariamente falsa: la columna sale del grant hasta que exista quien la llene.
    const admin = sqlAdmin();
    const itemId = await nuevoItem('Item del asiento sin grant');
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CI',
      anclas: { item_id: itemId },
    });
    try {
      await expect(
        conUsuario(leadId, (tx) => tx`
          insert into reto_servicio_afectado
            (reto_id, servicio_id, workspace_id, propuesta_ai_id, creado_por)
          values (${retoId}, ${svcId}, ${ws}, ${propuestaId}, ${leadId})`),
      ).rejects.toThrow(/permission denied|permiso denegado/i);

      // Control: la MISMA fila sin la columna entra, así que lo que la rechazaba era el
      // grant de esa columna y no la política ni ninguna de las otras referencias.
      await conUsuario(leadId, (tx) => tx`
        insert into reto_servicio_afectado (reto_id, servicio_id, workspace_id, creado_por)
        values (${retoId}, ${svcId}, ${ws}, ${leadId})`);
      const [fila] = await admin`select propuesta_ai_id from reto_servicio_afectado
        where reto_id = ${retoId} and servicio_id = ${svcId}`;
      expect(fila!.propuesta_ai_id).toBe(null);
    } finally {
      await admin`delete from reto_servicio_afectado where workspace_id = ${ws}`;
      await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });
    }
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
      anclas: { item_id: itemId },
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
      anclas: { item_id: itemId },
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
      anclas: { item_id: itemId },
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
  /*
   * El ancla que cada capacidad DECLARA tiene que existir en las tres tablas del pipeline.
   *
   * Es la misma inversión que el registro: la lista de columnas válidas no se escribe aquí,
   * se le pregunta al catálogo. Una capacidad futura que cuelgue de un objeto nuevo —un
   * journey, una design version— necesita su columna en las tres, y este caso lo dice ANTES
   * de que el primer `insert` lo descubra en caliente, con la llamada al proveedor ya pagada.
   */
  it('cada capacidad declara un ancla que existe en reserva_ai, llamada_ai y propuesta_ai', async () => {
    const admin = sqlAdmin();
    const filas = await admin`
      select table_name as tabla, column_name as columna
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('reserva_ai', 'llamada_ai', 'propuesta_ai')`;
    // Que esté mirando algo: con cero filas, todo lo de abajo pasaría sin comprobar nada.
    expect(filas.length).toBeGreaterThan(20);
    const columnas = new Set(filas.map((f) => `${f.tabla as string}.${f.columna as string}`));

    const faltan: string[] = [];
    for (const capacidad of CAPACIDADES_ACTIVAS) {
      const { columna } = CAPACIDADES[capacidad].ancla;
      for (const tabla of ['reserva_ai', 'llamada_ai', 'propuesta_ai']) {
        if (!columnas.has(`${tabla}.${columna}`)) faltan.push(`${capacidad}: ${tabla}.${columna}`);
      }
    }
    expect(faltan).toEqual([]);
  });

  /**
   * Y NINGÚN sello de procedencia lo puede escribir la aplicación. Se le pregunta al catálogo.
   *
   * `propuesta_ai_id` es lo que hace que un objeto materializado diga de qué propuesta viene
   * (SYS-19). Lo estampa el guard de revisión, que es `security definer` y el único sitio que
   * sabe que la materialización fue legítima; si el llamante puede escribirlo, la proveniencia
   * es una declaración voluntaria y deja de sostener nada.
   *
   * Esto se ha roto DOS veces por la misma vía, y la vía no es olvidarse del `revoke`: es que
   * un `grant insert` de TABLA cubre también las columnas futuras. Añadir la columna se la
   * regala al llamante sin que nadie escriba una línea, y no hay compilador ni tipo que lo eche
   * de menos — solo el catálogo lo sabe. Por eso se pregunta aquí y no se enumera a mano: la
   * próxima capacidad que materialice un objeto nuevo trae su tabla, y esta prueba la incluye
   * sola.
   */
  it('ninguna tabla deja que la aplicación escriba su sello de procedencia', async () => {
    const admin = sqlAdmin();
    const selladas = await admin`select table_name as tabla
      from information_schema.columns
      where table_schema = 'public' and column_name = 'propuesta_ai_id'
      order by table_name`;
    // Que esté mirando algo: con cero tablas selladas, lo de abajo pasaría sin comprobar nada.
    // Se nombran las que hay para que se vea QUÉ cubre, y se comprueba por contención y no por
    // igualdad: una capacidad nueva trae su tabla sellada y no tiene que tocar esta lista — la
    // comprobación de abajo la incluye sola, que es el punto entero de preguntarle al catálogo.
    const tablas = selladas.map((f) => f.tabla as string);
    expect(tablas).toEqual(
      expect.arrayContaining(['criterio_exito', 'evidencia', 'insight', 'reto_servicio_afectado']),
    );

    // `column_privileges` incluye lo que llega POR el grant de tabla, que es justo la vía por
    // la que se cuela: preguntarlo aquí cubre las dos rutas con una sola consulta.
    const escribibles = await admin`select table_name as tabla, privilege_type as privilegio
      from information_schema.column_privileges
      where table_schema = 'public' and grantee = 'designio_app'
        and column_name = 'propuesta_ai_id' and privilege_type in ('INSERT', 'UPDATE')
      order by table_name, privilege_type`;
    expect(
      escribibles.map((f) => `${f.tabla as string}.${f.privilegio as string}`),
      'la aplicación puede firmar una procedencia que no ocurrió',
    ).toEqual([]);
  });

  /**
   * Toda ancla declarada entra en la comprobación de LINAJE de la llamada.
   *
   * `propuesta_ai_revision_guard` exige que una propuesta cuelgue de la llamada que la
   * produjo, y compara el ancla ENUMERANDO columnas. Con una capacidad cuya ancla no está en
   * esa lista, todas sus filas tienen null en las comparadas y la condición pasa siempre: una
   * llamada válida de esa capacidad para el objeto A se puede colgar de una propuesta del
   * objeto B, y la atribución de coste queda corrompida sin que nada chille.
   *
   * La comparación se añade por capacidad —cada migración trae la de su ancla, aditiva como
   * sus CHECK— porque reescribir aquel guard obliga a copiar sus casi doscientas líneas en
   * cada migración, y la siguiente que las copie sin la línea ajena la revoca en silencio.
   * Eso es exactamente lo que costó el vocabulario de capacidades, y esto es lo que impide
   * que vuelva a pasar: se pregunta al catálogo por el texto de TODOS los guards de la tabla
   * y se exige que cada columna declarada aparezca comparada en alguno.
   */
  it('cada columna de ancla se compara contra la llamada en algún guard de propuesta_ai', async () => {
    const admin = sqlAdmin();
    const filas = await admin`
      select pg_get_functiondef(p.oid) as fuente
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = 'propuesta_ai'::regclass and not t.tgisinternal`;
    // Que esté mirando algo: sin triggers, todo lo de abajo pasaría sin comprobar nada.
    expect(filas.length).toBeGreaterThan(0);
    const fuente = filas.map((f) => (f.fuente as string).replace(/\s+/g, ' ')).join('\n');

    const sinComparar = COLUMNAS_DE_ANCLA.filter(
      (c) => !fuente.includes(`l.${c} is not distinct from new.${c}`),
    );
    expect(
      sinComparar,
      'un ancla declarada que ningún guard compara contra la llamada: una llamada de ese ' +
        'objeto se puede colgar de la propuesta de otro',
    ).toEqual([]);
  });

  /*
   * El VOCABULARIO de capacidades es uno, y las tres tablas del pipeline lo dicen igual.
   *
   * `propuesta_ai` declaraba las diez de SPEC-08 §30 —C0..C7, CT, CI, el alcance MVP cerrado
   * que RF-08.1 nombra una por una— y `reserva_ai` y `llamada_ai` declaraban dos. Que la
   * tabla de SALIDA fuera la permisiva y las de entrada las estrictas ya iba al revés; lo que
   * lo vuelve urgente es que la Fase 1 entra por CUATRO ramas a la vez.
   *
   * Con el vocabulario enumerado tabla por tabla, cada rama escribe su «suelta la restricción
   * y vuélvela a poner con la mía dentro» sin saber de las otras. Medido contra la base real,
   * aplicando dos de esas migraciones en el orden en que se fusionarían:
   *
   *   tras fusionar CT:  check (capacidad in ('C0','CI','CT'))
   *   tras fusionar C2:  check (capacidad in ('C0','CI','C2'))
   *
   * CT desaparece, y desaparece EN VERDE: las dos aplican sin error, git no ve conflicto
   * porque son ficheros distintos, y la capacidad queda revocada hasta que alguien intente
   * generar con ella. Este caso es lo que lo convierte en rojo el día que pase.
   *
   * Comprueba las dos mitades: que los tres conjuntos sean el MISMO —cualquier migración que
   * toque uno y se olvide de los otros cae aquí—, y que ese conjunto contenga todo lo que la
   * aplicación declara activo, que es la dirección por la que se rompe de verdad: una
   * capacidad viva en `CAPACIDADES_ACTIVAS` que la base rechaza al reservar.
   */
  it('las tres tablas del pipeline declaran el MISMO vocabulario de capacidades', async () => {
    const admin = sqlAdmin();
    /*
     * Por NOMBRE exacto y por tipo, no con un `like '%_capacidad_check'`. Una revisión lo
     * señaló y tiene razón en el mecanismo: en `LIKE`, el guion bajo es un comodín de UN
     * carácter, no un guion bajo. Medido: «xxYcapacidadZcheck» casa con ese patrón. Hoy no
     * hay ninguna restricción que se cuele por ahí —y `conrelid in (…)` ya acotaba a las tres
     * tablas—, pero un patrón que casa de más en una prueba cuyo trabajo es COMPARAR
     * conjuntos es exactamente la clase de laxitud que la vuelve verde por accidente.
     *
     * Nombrarlas es además lo mismo que hace su migración al soltarlas: si alguien renombra
     * una, las dos fallan a la vez y en voz alta, en vez de encontrar «cero coincidencias» y
     * seguir. Y `contype = 'c'` porque lo que se compara son CHECK: un índice o una FK que
     * llegara a llamarse igual no tiene `pg_get_constraintdef` comparable.
     */
    const filas = await admin`
      select conrelid::regclass::text as tabla, pg_get_constraintdef(oid) as definicion
      from pg_constraint
      where contype = 'c'
        and conname in ('reserva_ai_capacidad_check', 'llamada_ai_capacidad_check',
                        'propuesta_ai_capacidad_check')
        and conrelid in ('reserva_ai'::regclass, 'llamada_ai'::regclass,
                         'propuesta_ai'::regclass)`;
    // Las tres, ni una menos: si una migración futura BORRA su restricción en vez de
    // rehacerla, el vocabulario deja de estar sujeto ahí y este caso pasaría sin verlo.
    expect(filas.map((f) => f.tabla as string).sort()).toEqual([
      'llamada_ai',
      'propuesta_ai',
      'reserva_ai',
    ]);

    // Los literales de la definición. Es texto del catálogo, no de nadie de fuera.
    const vocabularios = new Map(
      filas.map((f) => [
        f.tabla as string,
        [...(f.definicion as string).matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
      ]),
    );
    const dePropuesta = vocabularios.get('propuesta_ai')!;
    // Y que haya leído algo: una definición de la que no se saca ningún literal dejaría tres
    // listas vacías, iguales entre sí, y el caso pasaría en verde sin haber comparado nada.
    expect(dePropuesta.length).toBeGreaterThan(1);
    expect(vocabularios.get('reserva_ai')).toEqual(dePropuesta);
    expect(vocabularios.get('llamada_ai')).toEqual(dePropuesta);

    const desconocidas = CAPACIDADES_ACTIVAS.filter((c) => !dePropuesta.includes(c));
    expect(
      desconocidas,
      'una capacidad activa en la aplicación que el vocabulario de la base no admite: ' +
        'su primera reserva la rechaza',
    ).toEqual([]);
  });

  /**
   * Ninguna CAPACIDAD hereda el juicio de otra, y la que el panel no sabe juzgar no se acepta.
   *
   * Dos rondas de revisión sobre el mismo sitio. La primera: el CASE de `ancla_estado` decía
   * `when p.item_id is not null then <lo del item>` y a continuación, SIN preguntar por
   * `p.reto_id`, las tres ramas del reto — todo lo que no fuera un item caía en ellas. Medido
   * con las dos columnas en null, respondía «reto-no-admite»: un motivo falso, y de los que
   * mandan al revisor a reabrir la etapa 0, que ahí no desbloquea nada.
   *
   * La segunda, sobre el arreglo de la primera: indexarlo por COLUMNA seguía siendo la clave
   * equivocada. Dos capacidades pueden colgar del mismo reto —C2 y C3 lo harán— y no comparten
   * sus puertas: C0 se congela con el G0 (SYS-22) y una capacidad posterior no tendría por qué.
   * Con el CASE preguntando por la columna, la segunda heredaba las puertas de la primera y no
   * faltaba ninguna entrada que el compilador echara de menos.
   *
   * Ahora cada rama pregunta por `p.capacidad`. No se puede montar la fila en `propuesta_ai`
   * —sus CHECK atan capacidad, destino y ancla, que es justo lo que se quiere de ellos—, así
   * que se evalúa el CASE REAL, el que compone `proyeccionDelPanel`, sobre un `p` sintético.
   */
  it('no le presta a una capacidad el motivo de otra, y la desconocida no es aceptable', async () => {
    const item = await nuevoItem('Item para medir el motivo de la capacidad');
    await conUsuario(leadId, async (tx) => {
      const proyeccion = proyeccionDelPanel(tx);
      /*
       * Un `p` sintético con las columnas que el CASE mira, y los joins que el panel hace.
       *
       * Las columnas salen de `COLUMNAS_DE_ANCLA`, no escritas a mano. Estaban escritas —dos
       * castings fijos, `item_id` y `reto_id`— y este mismo caso lo cobró en cuanto llegó la
       * tercera: el CASE real empezó a mirar `p.gate_id` y la fila sintética no lo tenía, así
       * que la prueba reventaba con «column p.gate_id does not exist». Reventar es el buen
       * desenlace y por eso se arregla generalizando y no añadiendo un tercer casting: la
       * lista que recorre el panel y la que monta esta fila tienen que ser LA MISMA, o la
       * próxima ancla vuelve a encontrarse con una fila a la que le falta su columna.
       */
      const motivoDe = async (
        capacidad: string,
        anclas: Partial<Record<AnclaCapacidad['columna'], string>>,
        /* Solo lo que el CASE del panel mira del contenido: los huecos de CT y su id. Se
         * tipa por lo que ES y no como `unknown` —que `tx.json` no acepta— ni como un
         * `Record` suelto: lo que esta fila sintética trae tiene que poder leerse igual que
         * lo que trae la de verdad. */
        contenido: { huecos?: { checklistItemId: string }[] } = {},
      ): Promise<string | null> => {
        const columnas = COLUMNAS_DE_ANCLA.map(
          (c) => tx`${anclas[c] ?? null}::uuid as ${tx(c)}`,
        ).reduce((a, b) => tx`${a}, ${b}`);
        /*
         * `contenido` también viaja en la fila sintética. Lo cobró la misma clase de cambio
         * que las columnas de ancla: el motivo de CT pasó a mirar los huecos del informe para
         * saber si un requisito señalado ya se cerró, y esta fila no lo tenía —«column
         * p.contenido does not exist»—. Lo que el CASE lee, la fila lo trae.
         */
        const [f] = await tx`
          select case ${proyeccion.motivo} else null end as estado
          from (select ${capacidad}::text as capacidad, ${columnas},
                       ${tx.json(contenido)}::jsonb as contenido,
                       -- Y el alcance sellado, por la misma razón que «contenido»: el motivo de
                       -- C2 pasó a mirar si el reto tiene evidencia fuera de él. Va NULO porque
                       -- esa rama pregunta por el alcance de una propuesta concreta y lo que
                       -- este censo mide es el ENRUTADO del motivo, no la completitud de
                       -- ninguna; nulo la deja inerte, que es la respuesta correcta para una
                       -- fila sintética que no representa a ninguna propuesta.
                       null::uuid[] as alcance_evidencia,
                       -- Y el de C3, por lo mismo: su motivo mira si el reto tiene insights
                       -- validados fuera del alcance. Nulo por la misma razón — lo que este
                       -- censo mide es el ENRUTADO, no la completitud de ninguna propuesta.
                       null::uuid[] as alcance_insights,
            null::uuid as entrada_kpi_id,
                       ${ws}::uuid as workspace_id) p
          ${proyeccion.joins}`;
        return (f!.estado as string | null) ?? null;
      };

      // Una capacidad que este panel no sabe pintar: lo dice CALLANDO. `filaDePanel` lee ese
      // null como 'ancla-ausente', que solo admite rechazar. Antes respondía con el motivo del
      // vecino — primero el del reto por caer en su rama, después el de quien compartiera
      // columna.
      // C1 y C7 hacen aquí el papel que hacían C3 y C4 antes de activarse: una capacidad del
      // catálogo que este panel todavía no pinta. Cuando les toque, el sustituto será otra —y
      // el día que no quede ninguna inactiva, este caso se retira en vez de fingirse.
      expect(await motivoDe('C1', { reto_id: retoId })).toBeNull();
      expect(await motivoDe('C1', { item_id: item })).toBeNull();
      expect(await motivoDe('C4', {})).toBeNull();
      // Y una capacidad desconocida sobre el ancla NUEVA tampoco hereda la de CT.
      expect(await motivoDe('C7', { gate_id: gateId })).toBeNull();

      // Y cada capacidad responde SOLO con motivos suyos: se comprueban los conjuntos, no un
      // valor concreto, porque lo que se sujeta es que las ramas no se crucen y no en qué
      // estado dejó el fixture a cada fila.
      const DE_CI = ['disponible', 'item-curado', 'consentimiento-revocado'];
      const DE_C0 = ['disponible', 'reto-no-admite', 'registry-firmado', 'criterios-congelados'];
      const DE_CT = ['disponible', 'gate-decidido', 'checklist-avanzado'];
      const DE_C3 = [
        'disponible',
        'portafolio-cerrado',
        'insight-no-validado',
        'alcance-incompleto',
      ];
      expect(DE_CI).toContain(await motivoDe('CI', { item_id: item }));
      expect(DE_C0).toContain(await motivoDe('C0', { reto_id: retoId }));
      expect(DE_CT).toContain(await motivoDe('CT', { gate_id: gateId }));
      // El de CI no puede ser NUNCA uno exclusivo de C0 (que es lo que pasaba).
      expect(DE_C0.slice(1)).not.toContain(await motivoDe('CI', { item_id: item }));
      // Ni el de CT uno de los otros dos: el ancla nueva entró por el mismo sitio por donde
      // se cruzaban las dos primeras, así que se mide igual.
      expect([...DE_CI.slice(1), ...DE_C0.slice(1)]).not.toContain(
        await motivoDe('CT', { gate_id: gateId }),
      );
      expect(DE_CT.slice(1)).not.toContain(await motivoDe('C0', { reto_id: retoId }));
      /*
       * Y C3, que es el caso que este censo existe para vigilar: comparte la columna del ancla
       * con C0 —y con C2—, así que es exactamente donde una rama escrita «para el reto» en vez
       * de «para esta capacidad» se cruzaría. Se mide en los dos sentidos.
       */
      expect(DE_C3).toContain(await motivoDe('C3', { reto_id: retoId }));
      expect(DE_C3.slice(1)).not.toContain(await motivoDe('C0', { reto_id: retoId }));
      expect(DE_C0.slice(1)).not.toContain(await motivoDe('C3', { reto_id: retoId }));

      /*
       * Y el motivo que distingue un informe VIVO de uno que ya no describe el gate: con el
       * mismo gate pendiente, un informe cuyo hueco señala un requisito CERRADO sale
       * «checklist-avanzado», y el mismo informe sobre uno pendiente sale «disponible». Es el
       * par que prueba que mira el contenido y no el gate.
       */
      const conRequisitoAbierto = { huecos: [{ checklistItemId: requisitoIds[0]! }] };
      expect(await motivoDe('CT', { gate_id: gateId }, conRequisitoAbierto)).toBe('disponible');
      await sqlAdmin()`update checklist_item
        set estado = 'na', na_justificacion = 'no aplica', na_aprobado_por = ${leadId}
        where id = ${requisitoIds[0]!} and workspace_id = ${ws}`;
      try {
        expect(await motivoDe('CT', { gate_id: gateId }, conRequisitoAbierto)).toBe(
          'checklist-avanzado',
        );
      } finally {
        await sqlAdmin()`update checklist_item
          set estado = 'pendiente', na_justificacion = '', na_aprobado_por = null
          where id = ${requisitoIds[0]!} and workspace_id = ${ws}`;
      }
    });
  });

  /**
   * Y las anclas OFRECIDAS también son de la capacidad, no de su columna.
   *
   * Comprobado sobre las dos activas: la cola de CI trae items de bandeja y la de C0 trae
   * retos, y ninguna de las dos está vacía por accidente. Lo que esto sujeta es que el panel
   * las resuelva POR CAPACIDAD: con la lista elegida por la columna del ancla, una segunda
   * capacidad sobre `reto_id` recibía la cola de C0 —que excluye los retos con criterios
   * congelados— y sus anclas válidas no aparecían en el selector.
   */
  it('resuelve las anclas ofrecidas por capacidad, cada una con su elegibilidad', async () => {
    const item = await nuevoItem('Item ofrecible a CI');
    const panel = await panelPropuestas(leadId, ws);
    expect(Object.keys(panel.candidatas).sort()).toEqual([...CAPACIDADES_ACTIVAS].sort());
    expect(panel.candidatas.CI.lista.some((c) => c.id === item)).toBe(true);
    // La cola de CI son items: ninguno de sus ids puede ser un reto, y al revés.
    expect(panel.candidatas.C0.lista.some((c) => c.id === item)).toBe(false);
    expect(panel.candidatas.CI.lista.some((c) => c.id === retoId)).toBe(false);
    // Y la de CT son gates pendientes, que no son ni lo uno ni lo otro.
    expect(panel.candidatas.CT.lista.some((c) => c.id === gateId)).toBe(true);
    expect(panel.candidatas.CT.lista.some((c) => c.id === item || c.id === retoId)).toBe(false);
    expect(panel.candidatas.CI.lista.some((c) => c.id === gateId)).toBe(false);
    expect(panel.candidatas.C0.lista.some((c) => c.id === gateId)).toBe(false);
  });

  /**
   * El camino REAL de CT, de punta a punta: se prepara, se llama y nace el informe.
   *
   * Lo que este caso sujeta y ninguno de los otros: que la generación pase por `PREPARAR.CT`
   * —que lee el gate y su checklist—, que la propuesta nazca colgada de `gate_id` y SIN
   * destino, y que las citas del informe se midan contra el material que el modelo leyó de
   * verdad. Eso último es lo que se rompe en silencio si la proyección del panel y la
   * consulta del prompt dejan de coincidir: las citas empezarían a salir ausentes sin que
   * nada fallara.
   */
  it('CT genera su informe por el camino real: cuelga del gate y nace sin destino', async () => {
    // En workspace propio: el tope diario de llamadas es POR WORKSPACE, y en el compartido lo
    // que dejaron los casos anteriores lo agota. Aquí se mide la generación, no el vecindario.
    await enWorkspaceLimpio('ct-camino-real', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const [proy] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, creado_por)
      values (${wsC}, ${retoC}, 'P-CT', 'Proyecto CT', ${curadorId}) returning id`;
      const [gate] = await admin`insert into gate_instancia
      (workspace_id, proyecto_id, numero, rol_aprobador)
      values (${wsC}, ${proy!.id as string}, 3, 'sponsor') returning id`;
      const req = await admin`insert into checklist_item (workspace_id, gate_id, orden, texto)
      values (${wsC}, ${gate!.id as string}, 1, 'El journey está validado con usuarios reales'),
             (${wsC}, ${gate!.id as string}, 2, 'El blueprint declara sus puntos de fallo')
      returning id`;
      const g = {
        gateId: gate!.id as string,
        contenido: CONTENIDO_CT(req[0]!.id as string),
      };
      await conProveedor(
        {
          ok: true,
          datos: g.contenido as unknown as Record<string, unknown>,
          intentos: [intento({ modelo: 'modelo-de-prueba', latenciaMs: 321, uso: null })],
        },
        async () => {
          const lote = await generarPropuestas(curadorId, {
            workspaceId: wsC,
            capacidad: 'CT',
            anclaId: g.gateId,
          });
          // Sin lote: una llamada de CT produce UN informe, no una lista.
          expect(lote.generadas).toBe(1);
        },
      );

      const [nacida] = await conUsuario(
        curadorId,
        (tx) => tx`
      select p.estado, p.destino, p.gate_id, p.item_id, p.reto_id, p.es_simulacion,
             l.capacidad as llamada_capacidad, l.gate_id as llamada_gate,
             l.consentimiento_version
      from propuesta_ai p
      join llamada_ai l on l.id = p.llamada_id and l.workspace_id = p.workspace_id
      where p.workspace_id = ${wsC} and p.gate_id = ${g.gateId}`,
      );
      expect(nacida!.estado).toBe('propuesta');
      // Informativa: sin destino y sin ancla en las otras dos columnas.
      expect(nacida!.destino).toBeNull();
      expect(nacida!.gate_id).toBe(g.gateId);
      expect(nacida!.item_id).toBeNull();
      expect(nacida!.reto_id).toBeNull();
      expect(nacida!.es_simulacion).toBe(false);
      // El libro de costos anotó la misma ancla: el gasto por capacidad y por objeto se lee de
      // ahí, y una llamada sin ancla no diría sobre qué se gastó.
      expect(nacida!.llamada_gate).toBe(g.gateId);
      expect(nacida!.llamada_capacidad).toBe('CT');
      // CT no procesa material de personas, así que no cita ningún consentimiento — y la base
      // lo exige en las dos direcciones.
      expect(nacida!.consentimiento_version).toBeNull();

      /*
       * Y la presencia literal, que es donde se nota si el material del panel y el del prompt
       * dejaron de ser el mismo texto. La cita del fixture es un fragmento del TEXTO de un
       * requisito, que viaja en el cuerpo del bloque; si la proyección del panel dejara de
       * traer el checklist —o lo trajera en otro orden, o filtrado—, esto saldría `false` sin
       * que ninguna otra prueba lo dijera.
       */
      const panel = await panelPropuestas(curadorId, wsC);
      const informe = panel.pendientes.find((x) => x.capacidad === 'CT');
      expect(informe, 'el informe de CT no llegó al panel').toBeDefined();
      expect(informe!.destino).toBeNull();
      expect(informe!.anclaEstado).toBe('disponible');
      expect(informe!.citas.every((c) => c.presenteLiteral)).toBe(true);

      await rechazarPropuesta(curadorId, { workspaceId: wsC, propuestaId: informe!.id });
    });
  });

  /**
   * C5 no VALIDA: remedia. Y esa distinción es la capacidad entera.
   *
   * La validación de RF-05.6 ya existe y es determinista (`validarJourney`). Lo que se le
   * pide al modelo es qué hacer con las señales que esa función emitió, y lo que el servicio
   * comprueba es que cada remediación señale una señal REAL — el único campo de su salida que
   * se puede contrastar contra algo.
   *
   * Estos tres casos cubren las tres mitades de eso: que el camino real funcione y cuelgue
   * del journey, que un grafo sin señales NO se mande al proveedor, y que una señal inventada
   * tire el informe entero.
   */
  it('C5 genera su remediación por el camino real: cuelga del journey y nace sin destino', async () => {
    await enWorkspaceLimpio('c5-camino-real', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });

      /*
       * Las señales se PIDEN a la misma función que las produce en producción, no se escriben
       * a mano: lo que hay que comprobar es que el servicio acepte una remediación de una
       * señal real, y con una escrita a mano la prueba mediría su propia copia.
       */
      const senales = await conUsuario(curadorId, async (tx) => {
        const grafo = await leerJourneyCompleto(tx, wsC, j.journeyId);
        return validarJourney(grafo!);
      });
      expect(senales.length, 'el fixture tiene que producir señales de verdad').toBeGreaterThan(0);

      const contenido: ContenidoRemediacionJourney = {
        resumen: 'Al grafo le faltan salidas y evidencia enlazada.',
        remediaciones: senales.slice(0, 3).map((x) => ({
          nodoId: x.nodoId,
          codigo: x.codigo,
          comoCerrarlo: 'Encadena el paso con el siguiente de su fase',
        })),
        // La cita es un fragmento literal del material que arma `materialDeJourney`.
        citas: [{ fragmento: 'Recibir documento', localizacion: 'nodos del grafo' }],
        confianzaPropuesta: 'media',
      };

      await conProveedor(
        {
          ok: true,
          datos: contenido as unknown as Record<string, unknown>,
          intentos: [intento({ modelo: 'modelo-de-prueba', latenciaMs: 210, uso: null })],
        },
        async () => {
          const lote = await generarPropuestas(curadorId, {
            workspaceId: wsC,
            capacidad: 'C5',
            anclaId: j.journeyId,
          });
          expect(lote.generadas).toBe(1);
        },
      );

      const [nacida] = await conUsuario(curadorId, (tx) => tx`
        select p.estado, p.destino, p.journey_id, p.item_id, p.reto_id, p.gate_id,
               l.capacidad as llamada_capacidad, l.journey_id as llamada_journey
        from propuesta_ai p
        join llamada_ai l on l.id = p.llamada_id and l.workspace_id = p.workspace_id
        where p.workspace_id = ${wsC} and p.journey_id = ${j.journeyId}`);
      expect(nacida!.estado).toBe('propuesta');
      expect(nacida!.destino).toBeNull();
      expect(nacida!.journey_id).toBe(j.journeyId);
      expect(nacida!.item_id).toBeNull();
      expect(nacida!.reto_id).toBeNull();
      expect(nacida!.gate_id).toBeNull();
      expect(nacida!.llamada_journey).toBe(j.journeyId);
      expect(nacida!.llamada_capacidad).toBe('C5');

      // Y la presencia literal contra el material que el modelo leyó: si la proyección del
      // panel dejara de traer el grafo —o lo trajera con otra forma—, esto saldría false.
      const panel = await panelPropuestas(curadorId, wsC);
      const informe = panel.pendientes.find((x) => x.capacidad === 'C5');
      expect(informe, 'la remediación no llegó al panel').toBeDefined();
      expect(informe!.destino).toBeNull();
      expect(informe!.citas.every((c) => c.presenteLiteral)).toBe(true);
      // Y la cola de C5 son journeys: el suyo sale de la lista mientras el informe espera.
      expect(panel.candidatas.C5.lista.some((c) => c.id === j.journeyId)).toBe(false);
      await rechazarPropuesta(curadorId, { workspaceId: wsC, propuestaId: informe!.id });
      const tras = await panelPropuestas(curadorId, wsC);
      expect(tras.candidatas.C5.lista.some((c) => c.id === j.journeyId)).toBe(true);
    });
  });

  /**
   * Un grafo SIN señales no se manda al proveedor.
   *
   * No es una optimización: la respuesta ya se sabe. `validarJourney` acaba de decir que no
   * hay nada que cerrar, y pagar una llamada para que un modelo lo repita es comprar una
   * opinión sobre un hecho — la misma regla que niega CI sobre un item sin material.
   *
   * Se comprueba que el proveedor NO se llamó, no solo que la llamada falló: fallar después
   * de pagar sería el mismo defecto con mejor cara.
   */
  it('un journey sin señales no llega al proveedor: la respuesta ya la da la validación', async () => {
    await enWorkspaceLimpio('c5-sin-senales', async (ctx) => {
    const { ws, curadorId: leadId } = ctx;
    const limpio = await nuevoJourney({ ...ctx, actorId: leadId }, { limpio: true });
    const sinSenales = await conUsuario(leadId, async (tx) => {
      const grafo = await leerJourneyCompleto(tx, ws, limpio.journeyId);
      return validarJourney(grafo!);
    });
    expect(sinSenales, 'el fixture «limpio» tiene que salir sin señales').toEqual([]);

    const llamadasAntes = await conUsuario(leadId, (tx) => tx`
      select count(*)::int as n from llamada_ai where workspace_id = ${ws}`);
    await conProveedor(
      { ok: true, datos: {}, intentos: [intento({ uso: null })] },
      async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'C5', anclaId: limpio.journeyId }),
        ).rejects.toThrow(/ninguna señal abierta/);
      },
    );
    const llamadasDespues = await conUsuario(leadId, (tx) => tx`
      select count(*)::int as n from llamada_ai where workspace_id = ${ws}`);
    expect(llamadasDespues[0]!.n, 'se abrió una línea en el libro: hubo despacho').toBe(
      llamadasAntes[0]!.n,
    );
    });
  });

  /**
   * Un journey cuyas señales SE CIERRAN mientras la llamada está en vuelo no admite el informe.
   *
   * Aquí este caso probaba otra cosa: que un SNAPSHOT tomado a mitad de la generación cerrara
   * el journey. Estaba mal planteado de raíz —lo inmutable es la foto, no el grafo (RF-05.8),
   * y su propia migración lo dice—, así que probaba un corte que no debía existir. Lo tiene su
   * caso propio ahora, del otro lado: con snapshot, C5 sigue disponible.
   *
   * Lo que SÍ deja obsoleto un informe es que alguien cierre las señales por su cuenta, que
   * además es el desenlace bueno. `REVALIDAR.C5` lo comprueba antes de despachar; entre esa
   * transacción y la que persiste cabe la edición, y ahí es donde se para. Es el mismo suelo
   * que CT pone para el gate decidido, con el predicado que le toca a esta capacidad.
   */
  it('un journey cuyas señales se cerraron mientras se generaba no admite el informe', async () => {
    await enWorkspaceLimpio('c5-senales-cerradas', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      expect(senales.length).toBeGreaterThan(0);
      const admin = sqlAdmin();

      proveedor.duranteLlamada = async () => {
        // Alguien arregla el grafo a mano: se borran los pasos y con ellos sus señales. Es lo
        // que C5 quería conseguir, solo que sin C5 y mientras C5 estaba en vuelo.
        await admin`delete from journey_arista where journey_id = ${j.journeyId}`;
        await admin`delete from journey_nodo where journey_id = ${j.journeyId}`;
      };
      try {
        await conProveedor(
          {
            ok: true,
            datos: informeCompleto(senales) as unknown as Record<string, unknown>,
            intentos: [intento({ uso: null })],
          },
          async () => {
            await expect(
              generarPropuestas(curadorId, {
                workspaceId: wsC,
                capacidad: 'C5',
                anclaId: j.journeyId,
              }),
            ).rejects.toThrow(/cambió mientras se generaba/);
          },
        );
      } finally {
        proveedor.duranteLlamada = null;
      }

      const quedan = await conUsuario(curadorId, (tx) => tx`
        select count(*)::int as n from propuesta_ai
        where workspace_id = ${wsC} and journey_id = ${j.journeyId}`);
      expect(quedan[0]!.n).toBe(0);
    });
  });

  /**
   * Una remediación que señala una señal que la validación NO emitió tira el informe entero.
   *
   * Es lo único que esta capacidad puede falsificar —el resto de su salida es prosa sobre
   * señales ciertas— y es de lo más caro: manda a alguien a arreglar un grafo que estaba
   * bien. Se descarta el informe COMPLETO y no las remediaciones sobrantes: recortar la
   * salida de un modelo y guardar el resto deja una propuesta que nadie escribió, con su
   * `contenido_original` diciendo otra cosa (SYS-17).
   */
  it('una remediación de una señal inexistente descarta el informe entero', async () => {
    await enWorkspaceLimpio('c5-senal-inventada', async (ctx) => {
    const { ws, curadorId: leadId } = ctx;
    const j = await nuevoJourney({ ...ctx, actorId: leadId });
    const contenido: ContenidoRemediacionJourney = {
      resumen: 'Informe con una avería inventada.',
      remediaciones: [
        // El nodo existe; la señal sobre ÉL no. Un nodo inventado también fallaría, pero
        // probaría menos: bastaría con comprobar que el id está en el grafo.
        { nodoId: j.nodos.uno, codigo: 'arquetipo-refutado', comoCerrarlo: 'Algo' },
      ],
      citas: [{ fragmento: 'Recibir documento', localizacion: 'nodos del grafo' }],
      confianzaPropuesta: 'alta',
    };
    await conProveedor(
      {
        ok: true,
        datos: contenido as unknown as Record<string, unknown>,
        intentos: [intento({ uso: null })],
      },
      async () => {
        await expect(
          generarPropuestas(leadId, { workspaceId: ws, capacidad: 'C5', anclaId: j.journeyId }),
        ).rejects.toThrow(/la validación de este journey no emitió/);
      },
    );
    // Y no quedó propuesta ninguna: media respuesta no es revisable.
    const quedan = await conUsuario(leadId, (tx) => tx`
      select count(*)::int as n from propuesta_ai
      where workspace_id = ${ws} and journey_id = ${j.journeyId}`);
    expect(quedan[0]!.n).toBe(0);
    });
  });

  /**
   * CT no se aprueba, y NO porque la pantalla no pinte el botón (RF-08.4).
   *
   * «Carece de acción aprobar» tiene que ser una imposibilidad y no una convención de una
   * pantalla, porque la server function la puede llamar cualquier cliente. Se comprueba en
   * los DOS suelos, de fuera adentro:
   *
   *  · el servicio corta con un motivo que se puede leer, y
   *  · la base no admite el estado ni aunque alguien llegue por SQL directo — el CHECK
   *    `(estado in ('aceptada','corregida')) = (coalesce(evidencia_id, criterio_id) is not null)`
   *    ya estaba y no hubo que tocarlo: sin destino no hay objeto que enlazar.
   *
   * Y se comprueba que la propuesta SIGUE viva después del intento: un corte que dejara la
   * fila a medio sellar sería peor que no cortar.
   */
  it('una propuesta informativa no se acepta: ni por el servicio ni por la base', async () => {
    const g = await nuevoGate();
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CT',
      anclas: { gate_id: g.gateId },
      contenido: g.contenido,
    });
    await expect(aceptarPropuesta(leadId, { workspaceId: ws, propuestaId })).rejects.toThrow(
      /INFORMATIVA/,
    );

    // Nada se movió: sigue pendiente, sin revisor y sin objeto.
    const [tras] = await conUsuario(
      leadId,
      (tx) => tx`
      select estado, destino, revisada_por, evidencia_id, criterio_id
      from propuesta_ai where id = ${propuestaId} and workspace_id = ${ws}`,
    );
    expect(tras!.estado).toBe('propuesta');
    expect(tras!.destino).toBeNull();
    expect(tras!.revisada_por).toBeNull();

    /*
     * Y el suelo, medido con la conexión de DUEÑO: es la que se salta RLS y los grants por
     * columna, así que lo único que le queda delante es el CHECK — que es lo que aquí se
     * quiere medir. Con la conexión de la aplicación el intento muere antes, en el grant, y
     * la prueba diría «no tiene permiso» en vez de «ese estado no existe para esta fila».
     * Las dos cosas son ciertas y hacen falta las dos; ésta es la de más abajo.
     */
    await expect(
      sqlAdmin()`update propuesta_ai
        set estado = 'aceptada', revisada_por = ${leadId}, revisada_en = now()
        where id = ${propuestaId} and workspace_id = ${ws}`,
    ).rejects.toThrow(/check constraint/);
  });

  /** Lo que SÍ admite: leerla y descartarla. Es la única decisión de su ciclo, y sigue
   * exigiendo revisor y fecha — descartar un informe es una decisión, no un olvido. */
  it('una propuesta informativa sí se rechaza, y eso la cierra', async () => {
    const g = await nuevoGate();
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CT',
      anclas: { gate_id: g.gateId },
      contenido: g.contenido,
    });
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });
    const [tras] = await conUsuario(
      leadId,
      (tx) => tx`
      select estado, revisada_por, revisada_en
      from propuesta_ai where id = ${propuestaId} and workspace_id = ${ws}`,
    );
    expect(tras!.estado).toBe('rechazada');
    expect(tras!.revisada_por).toBe(leadId);
    expect(tras!.revisada_en).not.toBeNull();
  });

  /**
   * La gramática de `destino` en la base, ahora que admite la ausencia.
   *
   * Volver una columna anulable vuelve sospechoso todo CHECK que la compare con un literal:
   * en SQL una comparación con `null` da `null`, y un CHECK que da `null` PASA. Lo que estos
   * casos sujetan es que el conjunto siga cerrado por los dos lados, y se afirma POR NOMBRE
   * de restricción: decir solo «falla» dejaría pasar el día en que falle por otra cosa —que
   * es justo lo que me pasó midiendo esto y por lo que la migración cambió de explicación—.
   */
  it('el destino y su ausencia están atados en la base, en las dos direcciones', async () => {
    /*
     * Una CI SIN destino. La rechazan DOS restricciones a la vez —`destino_ci` («una CI va a
     * evidencia») y `destino_informativo` («sin destino, el ancla es la del gate»)— y
     * Postgres informa de la que evalúa primero, que no es un orden que este repositorio
     * fije. Así que se afirma el conjunto: cae por una de las dos, no por otra cosa.
     */
    const itemId = await nuevoItem('Item para medir el destino ausente');
    await expect(
      nuevaPropuesta(leadId, { capacidad: 'CI', anclas: { item_id: itemId }, destino: null }),
    ).rejects.toThrow(/propuesta_ai_destino_(ci|informativo)/);

    // Y una CT CON destino: su CHECK propio lo prohíbe, así que la ausencia no es un
    // descuido que se pueda rellenar.
    const g = await nuevoGate();
    await expect(
      nuevaPropuesta(leadId, {
        capacidad: 'CT',
        anclas: { gate_id: g.gateId },
        contenido: g.contenido,
        destino: 'evidencia',
      }),
    ).rejects.toThrow(/propuesta_ai_destino_(ct|informativo)/);

    /*
     * Y el corte que de verdad sostiene RF-08.4, con la fila que lo pone a prueba: una
     * propuesta INFORMATIVA sellada como aceptada, con revisor y con un `evidencia_id`.
     *
     * Ésa cumple todo lo demás —incluido el CHECK que ata «aceptada» con tener objeto, que
     * lo cumple porque objeto TIENE—, así que lo único que la para es que el objeto sea de un
     * destino que no existe. Medido: con el CHECK escrito como `destino = 'evidencia'`, la
     * tabla la aceptaba. Va por el DUEÑO, que es quien se salta RLS y los grants por columna:
     * lo que aquí se mide es el suelo, no el permiso.
     */
    const sellada = await nuevoGate();
    const informe = await nuevaPropuesta(leadId, {
      capacidad: 'CT',
      anclas: { gate_id: sellada.gateId },
      contenido: sellada.contenido,
    });
    const [ev] = await sqlAdmin()`select id from evidencia where workspace_id = ${ws} limit 1`;
    expect(ev, 'hace falta una evidencia real: con un id inventado moriría en la FK').toBeDefined();
    await expect(
      sqlAdmin()`update propuesta_ai
        set estado = 'aceptada', revisada_por = ${leadId}, revisada_en = now(),
            evidencia_id = ${ev!.id as string}
        where id = ${informe} and workspace_id = ${ws}`,
    ).rejects.toThrow(/propuesta_ai_objeto_evidencia/);
  });

  /**
   * Un hueco señala un requisito DE ESTE GATE, o la propuesta no entra.
   *
   * Es el único campo verificable que tiene un hueco: `queFalta` y `comoCerrarlo` son prosa y
   * no se contrastan contra nada. Un id inventado —o el de otro gate— manda a quien lee el
   * informe a buscar un requisito que ahí no está, que es peor que no decir nada.
   *
   * Lo impone un trigger y no el servicio, por lo mismo que el resto de guards de este
   * esquema: el camino de la aplicación no es el único.
   */
  it('un hueco que señala un requisito ajeno al gate no entra', async () => {
    // DOS gates con su checklist: el id ajeno existe y es de este workspace, así que lo
    // único que lo hace ajeno es el gate. Un uuid inventado también fallaría, pero probaría
    // menos — un `exists` sobre la tabla entera lo habría atrapado igual.
    const propio = await nuevoGate();
    const otro = await nuevoGate();

    await expect(
      nuevaPropuesta(leadId, {
        capacidad: 'CT',
        anclas: { gate_id: propio.gateId },
        contenido: {
          ...CONTENIDO_CT(propio.requisitos[0]!),
          huecos: [
            { checklistItemId: otro.requisitos[0]!, queFalta: 'Algo', comoCerrarlo: 'Algo' },
          ],
        },
      }),
    ).rejects.toThrow(/no pertenece a este gate/);

    // Y el mismo informe con un requisito PROPIO entra sin más: lo que se rechaza es el
    // señalamiento ajeno, no la forma del contenido.
    const buena = await nuevaPropuesta(leadId, {
      capacidad: 'CT',
      anclas: { gate_id: propio.gateId },
      contenido: CONTENIDO_CT(propio.requisitos[1]!),
    });
    expect(buena).toMatch(/^[0-9a-f-]{36}$/);

    // Un informe SIN huecos —«no falta nada»— también entra: es el resultado bueno, y el
    // guard no puede confundir «ningún hueco» con «un hueco sin requisito».
    const vacia = await nuevaPropuesta(leadId, {
      capacidad: 'CT',
      anclas: { gate_id: otro.gateId },
      contenido: { ...otro.contenido, huecos: [] },
    });
    expect(vacia).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * Un hueco SIN `checklistItemId` tampoco entra, y ése es el que se colaba.
   *
   * Con `select … into ajeno` a secas, el hueco malformado SÍ lo seleccionaba el `not exists`
   * —nada casa con `lower(null)`— pero `ajeno` recibía null, así que el `if ajeno is not null`
   * no disparaba: el trigger admitía exactamente lo que existe para rechazar. El esquema de
   * Zod lo tapa por el camino de la aplicación; esto es el SUELO, y se prueba por donde el
   * esquema no pasa, o sea escribiendo el jsonb a mano.
   */
  it('un hueco sin checklistItemId no entra: el guard distingue «no hay» de «es null»', async () => {
    const admin = sqlAdmin();
    const g = await nuevoGate();
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'CT',
      anclas: { gate_id: g.gateId },
      contenido: g.contenido,
    });
    // Por el DUEÑO y con `update`: la aplicación no puede escribir esto —su esquema lo
    // rechaza— y lo que se mide es que la base tampoco lo admita.
    for (const malo of ['{"queFalta":"x","comoCerrarlo":"y"}', '{"checklistItemId":null}']) {
      await expect(
        sqlAdmin()`update propuesta_ai
          set contenido = jsonb_set(contenido, '{huecos}', ${admin.json([JSON.parse(malo)])}::jsonb)
          where id = ${propuestaId} and workspace_id = ${ws}`,
      ).rejects.toThrow(/no pertenece a este gate/);
    }
  });

  /**
   * Un gate decidido MIENTRAS la llamada estaba en vuelo no admite el informe que llega.
   *
   * `REVALIDAR.CT` lo comprueba antes de despachar, y entre esa transacción y la que
   * persiste cabe la aprobación. Sin este corte nacía un informe ya obsoleto que además
   * ocupaba el hueco del gate por el índice parcial: solo se podía marcar como leído.
   */
  it('un gate aprobado mientras se generaba no admite el informe', async () => {
    const admin = sqlAdmin();
    const g = await nuevoGate();
    // Un gate no se aprueba con el checklist pendiente —lo impone la base, y es correcto—,
    // así que sus requisitos se cierran como N/A con su justificación y su aprobador. La
    // prueba mide el guard del informe, no el del gate.
    await admin`update checklist_item
      set estado = 'na', na_justificacion = 'no aplica a esta demo', na_aprobado_por = ${leadId}
      where gate_id = ${g.gateId} and workspace_id = ${ws}`;
    await admin`update gate_instancia
      set estado = 'aprobado', aprobado_por = ${leadId}, aprobado_en = now()
      where id = ${g.gateId} and workspace_id = ${ws}`;
    await expect(
      nuevaPropuesta(leadId, {
        capacidad: 'CT',
        anclas: { gate_id: g.gateId },
        contenido: g.contenido,
      }),
    ).rejects.toThrow(/ya se decidió/);
  });

  /* ══════════════════════ C2 — insights propuestos con sus citas ══════════════════════ */

  /**
   * Enlaza evidencia a un reto por el ÚNICO camino que este esquema tiene y devuelve su id.
   *
   * No es azúcar: `evidencia` cuelga del workspace, no del reto, y lo que la ata a uno son sus
   * ARQUETIPOS. Un fixture que se saltara ese camino —creando evidencia del workspace y ya—
   * dejaría a C2 sin material, y la generación se negaría con razón; escribirlo aquí una vez
   * es lo que evita que cada caso lo dé por hecho de una manera distinta.
   */
  /**
   * El alcance de evidencia de un reto, como fragmento SQL para los inserts DIRECTOS.
   *
   * `propuesta_ai.alcance_evidencia` la escribe el servicio con el conjunto que compuso el
   * material; una prueba que pasa por la superficie SQL tiene que escribirla también, y
   * escribirla A MANO sería fijar en la prueba una lista que el suelo compara contra la
   * consulta real. Sale de la misma consulta, evaluada por la base en la misma sentencia.
   */
  const ALCANCE_DEL_RETO = (tx: TransactionSql, wsId: string, retoId: string) => tx`array(
    select distinct ae.evidencia_id
      from arquetipo a
      join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
     where a.reto_id = ${retoId} and a.workspace_id = ${wsId})`;

  async function evidenciaDelReto(
    wsC: string,
    retoC: string,
    actorId: string,
    campos: {
      titulo: string;
      resumen: string;
      /** Enlazada al reto pero SIN derechos de cliente: no entra en el material, así que el
       * modelo no la ve y el alcance no la nombra — y es justo la que mira la completitud. */
      sinDerechos?: boolean;
    },
  ): Promise<string> {
    const admin = sqlAdmin();
    const [arq] = await admin`insert into arquetipo
      (workspace_id, reto_id, nombre, definicion, creado_por)
      values (${wsC}, ${retoC}, ${'Arquetipo de ' + campos.titulo}, 'Definición', ${actorId})
      returning id`;
    const [fte] = await admin`insert into fuente
      (workspace_id, tipo, titulo, referencia, creado_por)
      values (${wsC}, 'documento', ${campos.titulo}, 'ref', ${actorId}) returning id`;
    const [ev] = await admin`insert into evidencia
      (workspace_id, fuente_id, titulo, resumen, dimensiones, creado_por)
      values (${wsC}, ${fte!.id as string}, ${campos.titulo}, ${campos.resumen}, '{}'::jsonb,
              ${actorId})
      returning id`;
    const evId = ev!.id as string;
    // Concedidos y de ámbito cliente: citar exige evidencia usable, y el registro por
    // defecto nace `pendiente`/`interno`. Ver la nota del fixture compartido.
    await admin`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      values (${wsC}, ${evId},
              ${campos.sinDerechos ? 'pendiente' : 'concedido'},
              ${campos.sinDerechos ? 'interno' : 'cliente'},
              ${campos.sinDerechos ? '' : 'Consentimiento del participante'},
              ${campos.sinDerechos ? null : actorId},
              ${campos.sinDerechos ? null : admin`now()`},
              ${actorId})`;
    await admin`insert into arquetipo_evidencia (workspace_id, arquetipo_id, evidencia_id)
      values (${wsC}, ${arq!.id as string}, ${evId})`;
    return evId;
  }

  /**
   * El camino REAL de C2, de punta a punta, y hasta el objeto materializado.
   *
   * Es el caso que hacía falta escribir antes que ningún otro, porque C2 es la primera
   * capacidad que COMPARTE columna de ancla (el reto, con C0) y la primera que materializa un
   * objeto COMPUESTO. Las dos cosas rompían el suelo en sitios que ninguna prueba tocaba y que
   * el compilador no podía echar de menos —enumeraciones de SQL escritas cuando el conjunto
   * era más pequeño—. Medido contra la base, esto fallaba en CINCO puntos distintos antes de
   * las correcciones de su migración:
   *
   *   1. `llamada_ai_check1`  — (capacidad='C0') = (reto_id is not null): la llamada no entra.
   *   2. `reserva_ai_check1`  — lo mismo al reservar el presupuesto.
   *   3. `propuesta_ai_destino_check` — el vocabulario de destinos no conocía 'insight'.
   *   4. `propuesta_ai_check9` — «aceptada ⇔ hay objeto» contaba evidencia y criterio y no el
   *      insight, así que aceptar era imposible.
   *   5. El `else` del guard de materialización sellaba `criterio_exito` para todo lo que no
   *      fuera evidencia, y el insight caía ahí.
   *
   * Ninguno se veía desde TypeScript y ninguno lo habría dicho una prueba de unidad: hay que
   * recorrer el camino entero contra la base real.
   */
  it('C2 genera insights por el camino real y aceptar materializa el objeto entero', async () => {
    await enWorkspaceLimpio('c2-camino-real', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const evId = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Abandono en verificación',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento de identidad.',
      });
      const otraId = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Encuesta de salida',
        resumen: 'Quien abandona dice que no sabía qué documento subir.',
      });

      const propuesto = {
        titulo: 'La verificación documental es donde se pierde la gente',
        resumen: 'El abandono se concentra en la carga del documento, no en el alta.',
        afirmaciones: [
          {
            texto: 'La mayoría de los abandonos ocurre al cargar el documento',
            esHipotesis: false,
            citas: [
              // Literal del resumen de la evidencia: es lo que `materialDeInsights` mete en
              // el cuerpo del bloque, así que la presencia se mide de verdad…
              {
                evidenciaId: evId,
                fragmento: 'El 71% de los abandonos',
                localizacion: 'resumen',
              },
              // …y una inventada, para que el panel las distinga.
              { evidenciaId: evId, fragmento: 'esto no está en la evidencia', localizacion: 'resumen' },
            ],
          },
          {
            texto: 'Bastaría con decir antes qué documento sirve',
            esHipotesis: true,
            citas: [
              { evidenciaId: otraId, fragmento: 'no sabía qué documento subir', localizacion: 'resumen' },
            ],
          },
        ],
        contradicciones: [
          { evidenciaId: otraId, descripcion: 'La encuesta apunta a información, no a fricción técnica' },
        ],
        confianzaPropuesta: 'media' as const,
      };

      const generadas = await conProveedor(
        {
          ok: true,
          datos: { insights: [propuesto] },
          intentos: [intento({ modelo: 'modelo-de-prueba', latenciaMs: 210, uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      expect(generadas.generadas).toBe(1);

      const [nacida] = await conUsuario(
        curadorId,
        (tx) => tx`
        select p.estado, p.destino, p.reto_id, p.item_id, p.gate_id, p.insight_id,
               l.capacidad as llamada_capacidad, l.reto_id as llamada_reto
        from propuesta_ai p
        join llamada_ai l on l.id = p.llamada_id and l.workspace_id = p.workspace_id
        where p.workspace_id = ${wsC} and p.capacidad = 'C2'`,
      );
      expect(nacida!.estado).toBe('propuesta');
      expect(nacida!.destino).toBe('insight');
      expect(nacida!.reto_id).toBe(retoC);
      expect(nacida!.item_id).toBeNull();
      expect(nacida!.gate_id).toBeNull();
      // Pendiente todavía no tiene objeto: el insight nace al aceptar, no al proponer.
      expect(nacida!.insight_id).toBeNull();
      // Y el libro de costos anotó la misma ancla, que es de donde sale el gasto por objeto.
      expect(nacida!.llamada_capacidad).toBe('C2');
      expect(nacida!.llamada_reto).toBe(retoC);

      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2');
      expect(p, 'la propuesta de C2 no llegó al panel').toBeDefined();
      expect(p!.destino).toBe('insight');
      expect(p!.anclaEstado).toBe('disponible');
      /*
       * Las TRES citas, en su orden y con su medida. Es lo que se rompe en silencio si el
       * material del panel y el del prompt dejan de ser el mismo texto — y además comprueba
       * que las citas de C2 se leen DONDE ESTÁN: viven dentro de cada afirmación, no en
       * `contenido.citas`, así que un lector escrito para las otras tres capacidades habría
       * devuelto una lista vacía y esto pasaría en verde sin medir nada.
       */
      expect(p!.citas.map((c) => c.presenteLiteral)).toEqual([true, false, true]);

      const { objetoId } = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: p!.id,
      });

      // El insight ENTERO: cabecera, afirmaciones en orden con su marca de hipótesis, las
      // citas de cada una y la contradicción señalada. Aceptar una propuesta de C2 no escribe
      // una fila, escribe un árbol, y un árbol a medias no es el objeto que se revisó.
      const [ins] = await conUsuario(curadorId, (tx) => tx`
        select titulo, resumen, estado, creado_por, propuesta_ai_id, validado_por
        from insight where id = ${objetoId}`);
      expect(ins!.titulo).toBe(propuesto.titulo);
      expect(ins!.resumen).toBe(propuesto.resumen);
      // Nace PROPUESTO, no validado: validar es otra decisión humana, con su propio guard de
      // derechos (SPEC-05). Aceptar la propuesta AI no la anticipa.
      expect(ins!.estado).toBe('propuesto');
      expect(ins!.validado_por).toBeNull();
      // El autor es el humano que aceptó, no la AI (I4/SYS-18)…
      expect(ins!.creado_por).toBe(curadorId);
      // …y el sello de procedencia dice de qué propuesta viene (SYS-19). Lo escribe el guard:
      // la columna está fuera de todo grant, así que ningún camino de la aplicación lo toca.
      expect(ins!.propuesta_ai_id).toBe(p!.id);

      const afs = await conUsuario(curadorId, (tx) => tx`
        select id, orden, texto, es_hipotesis from afirmacion
        where insight_id = ${objetoId} order by orden`);
      expect(afs.map((a) => [a.orden, a.texto, a.es_hipotesis])).toEqual(
        propuesto.afirmaciones.map((a, i) => [i, a.texto, a.esHipotesis]),
      );
      const citas = await conUsuario(curadorId, (tx) => tx`
        select c.evidencia_id, c.fragmento, c.localizacion, c.creado_por, a.orden
        from cita c join afirmacion a on a.id = c.afirmacion_id
        where a.insight_id = ${objetoId} order by a.orden, c.fragmento`);
      expect(citas.length).toBe(3);
      expect(citas.every((c) => c.creado_por === curadorId)).toBe(true);
      expect(citas.map((c) => c.evidencia_id)).toEqual([evId, evId, otraId]);
      const contras = await conUsuario(curadorId, (tx) => tx`
        select evidencia_id, descripcion from contradiccion where insight_id = ${objetoId}`);
      expect(contras.map((c) => [c.evidencia_id, c.descripcion])).toEqual([
        [otraId, propuesto.contradicciones[0]!.descripcion],
      ]);

      const [decidida] = await conUsuario(curadorId, (tx) => tx`
        select estado, revisada_por, insight_id from propuesta_ai where id = ${p!.id}`);
      expect(decidida!.estado).toBe('aceptada');
      expect(decidida!.revisada_por).toBe(curadorId);
      expect(decidida!.insight_id).toBe(objetoId);
    });
  });
  /**
   * Un insight VALIDADO del reto, en un workspace efímero. «Del reto» no es una columna: se
   * llega por afirmación → cita → evidencia → arquetipo → reto, así que la cadena entera hace
   * falta o `insights_validados_del_reto` no lo encuentra. Devuelve su id.
   */
  async function insightValidadoDelReto(
    wsC: string,
    evidenciaId: string,
    actorId: string,
    campos: { titulo: string; resumen: string; fragmento: string },
  ): Promise<string> {
    const admin = sqlAdmin();
    const [ins] = await admin`insert into insight
      (workspace_id, titulo, resumen, estado, validado_por, validado_en, creado_por)
      values (${wsC}, ${campos.titulo}, ${campos.resumen}, 'validado', ${actorId}, now(),
              ${actorId})
      returning id`;
    const insightId = ins!.id as string;
    const [af] = await admin`insert into afirmacion
      (workspace_id, insight_id, orden, texto, es_hipotesis)
      values (${wsC}, ${insightId}, 0, ${campos.titulo}, false) returning id`;
    await admin`insert into cita
      (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
      values (${wsC}, ${af!.id as string}, ${evidenciaId}, ${campos.fragmento}, 'resumen',
              ${actorId})`;
    return insightId;
  }

  /**
   * La puerta de G3 montada pero SIN firmar: el portafolio sigue abierto y la firma queda a un
   * `update` de distancia. Devuelve el id del gate.
   *
   * Se monta con las réplicas desactivadas —lo que se mide es la VENTANA, no el camino de ocho
   * gates que lleva hasta ella, que tiene sus propias pruebas—. Partirlo en dos es lo que
   * permite firmar EN VUELO, que es el caso para el que existe el guard diferido.
   */
  async function puertaDeG3(wsC: string, retoC: string, actorId: string): Promise<string> {
    const admin = sqlAdmin();
    const [p] = await admin`insert into proyecto
      (workspace_id, reto_id, codigo, titulo, estado, perfil, creado_por)
      values (${wsC}, ${retoC}, 'P-G3', 'Proyecto', 'activo', 'rapido', ${actorId}) returning id`;
    return await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
        values (${wsC}, ${p!.id as string}, 3, 'Conceptualización', 'completada')`;
      const [g] = await tx`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador, estado)
        values (${wsC}, ${p!.id as string}, 3, 'sponsor', 'pendiente') returning id`;
      return g!.id as string;
    });
  }

  /** El `update` que firma esa puerta y con ella cierra el portafolio. Sin las réplicas no
   * pasaría: aprobar un gate tiene sus propias exigencias, que no son lo que aquí se mide. */
  const firmaDeG3 = (tx: TransactionSql, wsC: string, gateId: string, actorId: string) =>
    tx`set local session_replication_role = replica`.then(
      () => tx`update gate_instancia set estado = 'aprobado', aprobado_por = ${actorId},
                 aprobado_en = now()
               where id = ${gateId} and workspace_id = ${wsC}`,
    );

  /** Un criterio de éxito real para el reto: C3 no se ofrece sin al menos uno entero en el
   * material, porque la razón de cada prioridad tiene que nombrar el que movería. */
  async function criterioDelReto(wsC: string, retoC: string, actorId: string): Promise<string> {
    const [c] = await sqlAdmin()`insert into criterio_exito
      (workspace_id, reto_id, kpi, definicion, objetivo, ventana_dias, linea_base_plan, creado_por)
      values (${wsC}, ${retoC}, 'Tiempo de verificación',
              'Minutos medianos desde iniciar hasta completar la verificación',
              'Bajar de 8 a 4 minutos', 90, 'Medir dos semanas antes del release', ${actorId})
      returning id`;
    return c!.id as string;
  }

  /**
   * Una propuesta de C3 pendiente, nacida por el camino REAL sobre un reto con un insight
   * validado. Devuelve lo que los casos de caducidad necesitan mover después.
   */
  async function propuestaC3Pendiente(ctx: { ws: string; curadorId: string; retoId: string }) {
    const evId = await evidenciaDelReto(ctx.ws, ctx.retoId, ctx.curadorId, {
      titulo: 'Abandono en verificación',
      resumen: 'El 71% de los abandonos ocurre al cargar el documento de identidad.',
    });
    const insightId = await insightValidadoDelReto(ctx.ws, evId, ctx.curadorId, {
      titulo: 'La verificación excluye a quien no tiene el documento a mano',
      resumen: 'Quien no lleva el documento encima abandona y no vuelve.',
      fragmento: 'El 71% de los abandonos',
    });
    await criterioDelReto(ctx.ws, ctx.retoId, ctx.curadorId);
    await conProveedor(
      {
        ok: true,
        datos: { oportunidades: [CONTENIDO_C3(insightId)] },
        intentos: [intento({ uso: null })],
      },
      () =>
        generarPropuestas(ctx.curadorId, {
          workspaceId: ctx.ws,
          capacidad: 'C3',
          anclaId: ctx.retoId,
        }),
    );
    const [guardada] = await sqlAdmin()`select id from propuesta_ai
      where workspace_id = ${ctx.ws} and capacidad = 'C3'`;
    expect(guardada, 'no se generó la propuesta de C3').toBeDefined();
    return { evId, insightId, propuestaId: guardada!.id as string };
  }

  /**
   * El camino REAL de C3, de punta a punta, y hasta la traza materializada.
   *
   * C3 es la primera capacidad cuyo objeto materializado NO SE COPIA de la propuesta: la HMW
   * lleva su pregunta y su prioridad, pero su apoyo —`oportunidad_insight`— se deriva de las
   * citas, y eso es una tabla más que nace en la aceptación. Es también el quinto destino, y
   * cada destino nuevo estrena las mismas costuras: el vocabulario de `destino`, el CHECK de
   * «decidida ⇒ exactamente un objeto», la columna de sello y la rama del despachador de
   * procedencia. Esa última faltaba, y la encontró el `else` que grita, no el compilador.
   *
   * Lo que este caso sujeta y ninguna sonda de SQL directo puede sujetar: que el servicio
   * escriba lo que el guard exige. Las sondas miden el SUELO —que por SQL crudo no se pueda
   * mentir—; ésta mide que el camino de producción no se caiga contra su propio suelo.
   */
  it('C3 propone HMW por el camino real y aceptar materializa la oportunidad con su traza', async () => {
    await enWorkspaceLimpio('c3-camino-real', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const evId = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Abandono en verificación',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento de identidad.',
      });
      const insA = await insightValidadoDelReto(wsC, evId, curadorId, {
        titulo: 'La verificación excluye a quien no tiene el documento a mano',
        resumen: 'Quien no lleva el documento encima abandona y no vuelve.',
        fragmento: 'El 71% de los abandonos',
      });
      const insB = await insightValidadoDelReto(wsC, evId, curadorId, {
        titulo: 'El aviso del documento llega cuando ya es tarde',
        resumen: 'El recordatorio sale cuando la persona ya cerró la aplicación.',
        fragmento: 'El 71% de los abandonos',
      });
      await criterioDelReto(wsC, retoC, curadorId);

      // Dos citas a DOS insights distintos: la traza que debe nacer tiene dos filas, y así el
      // «exactamente los citados» se mide contra un conjunto y no contra un elemento.
      const propuesta = {
        pregunta: '¿Cómo podríamos verificar sin pedir un documento que no está a mano?',
        prioridad: 700,
        prioridadRazon: 'Mueve el criterio del tiempo de verificación: es donde se pierde la mayoría.',
        citas: [
          { insightId: insA, fragmento: 'Quien no lleva el documento encima', localizacion: 'resumen' },
          // Una segunda cita AL MISMO insight: la traza va por `insightId` DISTINTO, así que
          // esto no puede producir una tercera fila ni tumbar la comprobación por conteo.
          { insightId: insA, fragmento: 'abandona y no vuelve', localizacion: 'resumen' },
          { insightId: insB, fragmento: 'ya cerró la aplicación', localizacion: 'resumen' },
        ],
        confianzaPropuesta: 'media' as const,
      };

      const generadas = await conProveedor(
        {
          ok: true,
          datos: { oportunidades: [propuesta] },
          intentos: [intento({ modelo: 'modelo-de-prueba', latenciaMs: 190, uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C3', anclaId: retoC }),
      );
      expect(generadas.generadas).toBe(1);

      const admin = sqlAdmin();
      const [nacida] = await admin`
        select p.estado, p.destino, p.reto_id, p.oportunidad_id, p.alcance_insights,
               l.capacidad as llamada_capacidad, l.reto_id as llamada_reto
        from propuesta_ai p
        join llamada_ai l on l.id = p.llamada_id and l.workspace_id = p.workspace_id
        where p.workspace_id = ${wsC} and p.capacidad = 'C3'`;
      expect(nacida!.estado).toBe('propuesta');
      expect(nacida!.destino).toBe('oportunidad');
      expect(nacida!.reto_id).toBe(retoC);
      // Pendiente todavía no tiene objeto: la HMW nace al aceptar, no al proponer.
      expect(nacida!.oportunidad_id).toBeNull();
      // El alcance guarda lo que el modelo LEYÓ, y los dos insights caben de sobra.
      expect([...(nacida!.alcance_insights as string[])].sort()).toEqual([insA, insB].sort());
      expect(nacida!.llamada_capacidad).toBe('C3');
      expect(nacida!.llamada_reto).toBe(retoC);

      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C3');
      expect(p, 'la propuesta de C3 no llegó al panel').toBeDefined();
      expect(p!.destino).toBe('oportunidad');
      expect(p!.anclaEstado).toBe('disponible');
      // Las tres citas se leen donde están —en `contenido.citas`, con `insightId`— y se miden
      // contra el material que se le dio al modelo, no contra el texto de la propuesta.
      expect(p!.citas.map((c) => c.presenteLiteral)).toEqual([true, true, true]);

      const { objetoId } = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: p!.id,
      });

      const [hmw] = await conUsuario(curadorId, (tx) => tx`
        select pregunta, prioridad, prioridad_razon, estado, creado_por, propuesta_ai_id
        from oportunidad where id = ${objetoId}`);
      expect(hmw!.pregunta).toBe(propuesta.pregunta);
      expect(hmw!.prioridad).toBe(propuesta.prioridad);
      expect(hmw!.prioridad_razon).toBe(propuesta.prioridadRazon);
      // Nace POR DECIDIR: aceptar la propuesta de la AI no la mete en el portafolio, que es
      // una segunda decisión humana con su propio veredicto.
      expect(hmw!.estado).toBe('propuesta');
      // El autor es el humano que aceptó, no la AI (I4/SYS-18)…
      expect(hmw!.creado_por).toBe(curadorId);
      // …y el sello de procedencia lo escribe el guard: la columna está fuera de todo grant.
      expect(hmw!.propuesta_ai_id).toBe(p!.id);

      // La traza: DOS filas, una por insight citado, ni una por cita.
      const traza = await conUsuario(curadorId, (tx) => tx`
        select insight_id from oportunidad_insight where oportunidad_id = ${objetoId}`);
      expect(traza.map((t) => t.insight_id as string).sort()).toEqual([insA, insB].sort());

      const [decidida] = await conUsuario(curadorId, (tx) => tx`
        select estado, revisada_por, oportunidad_id from propuesta_ai where id = ${p!.id}`);
      expect(decidida!.estado).toBe('aceptada');
      expect(decidida!.revisada_por).toBe(curadorId);
      expect(decidida!.oportunidad_id).toBe(objetoId);
    });
  });

  /**
   * Y el TIEMPO, que es lo que separa proponer de aceptar, por sus dos filos.
   *
   * Entre las dos cosas caben días, y lo que pasa en ellos es justo lo que invalida la
   * propuesta. Los dos filos son distintos y por eso se miden en el mismo caso, con el mismo
   * montaje, cambiando solo qué se mueve en medio:
   *
   *   · LA VENTANA se CIERRA. Firmar G3 certifica el portafolio tal como está; sellar después
   *     mete una HMW en un portafolio que un gate ya dio por bueno, sin que su guard vuelva a
   *     correr para desmentirlo.
   *   · EL ALCANCE se QUEDA CORTO. Validar un insight nuevo del reto deja la pregunta escrita
   *     sin conocer parte de lo que el reto ya sabe —posiblemente lo que la reformularía—, y
   *     quien revisa no puede compensarlo leyendo la propuesta: lo que falta no está en ella.
   *
   * En los dos casos el panel lo DICE en vez de ofrecer un botón que siempre vuelve, y aceptar
   * falla de verdad: un estado que no se corresponde con el suelo es peor que no tenerlo.
   */
  it('C3: una HMW propuesta caduca si se firma su G3 o si el reto valida un insight nuevo', async () => {
    const admin = sqlAdmin();

    await enWorkspaceLimpio('c3-ventana', async (ctx) => {
      const { propuestaId } = await propuestaC3Pendiente(ctx);
      const gateId = await puertaDeG3(ctx.ws, ctx.retoId, ctx.curadorId);
      // Con la puerta montada pero SIN firmar, la propuesta sigue viva: sin esta mitad, un
      // panel que dijera «cerrado» por el mero hecho de haber un G3 pasaría la de abajo sin
      // medir nada, y lo que cierra la ventana es la FIRMA, no la puerta.
      const antes = (await panelPropuestas(ctx.curadorId, ctx.ws)).pendientes.find(
        (x) => x.capacidad === 'C3',
      )!;
      expect(antes.anclaEstado).toBe('disponible');

      await admin.begin((tx) => firmaDeG3(tx, ctx.ws, gateId, ctx.curadorId));

      const p = (await panelPropuestas(ctx.curadorId, ctx.ws)).pendientes.find(
        (x) => x.capacidad === 'C3',
      )!;
      expect(p.anclaEstado, 'el panel ofrece aceptar algo que no se puede aceptar').toBe(
        'portafolio-cerrado',
      );
      // Quien para esto por el camino real es la COMPROBACIÓN DEL SERVICIO, no el guard: la
      // firma ya estaba cometida cuando la aceptación empieza, así que se ve en la primera
      // lectura y el mensaje que llega es el suyo. El guard diferido cubre el otro caso —una
      // firma que llega EN VUELO—, y ése se mide con su carrera, más abajo.
      await expect(
        aceptarPropuesta(ctx.curadorId, { workspaceId: ctx.ws, propuestaId }),
      ).rejects.toThrow(/El portafolio de ese reto está cerrado/);
      // Rechazar SÍ sigue abierto: bloquear también esa salida dejaría la fila muerta y su
      // ancla retenida para siempre.
      await rechazarPropuesta(ctx.curadorId, { workspaceId: ctx.ws, propuestaId });
      const [tras] = await admin`select estado from propuesta_ai where id = ${propuestaId}`;
      expect(tras!.estado).toBe('rechazada');
    });

    await enWorkspaceLimpio('c3-alcance', async (ctx) => {
      const { evId, propuestaId } = await propuestaC3Pendiente(ctx);
      // Un insight que se VALIDA después de generar, colgado del mismo reto por la misma
      // evidencia: entra en `insights_validados_del_reto` y no está en `alcance_insights`.
      await insightValidadoDelReto(ctx.ws, evId, ctx.curadorId, {
        titulo: 'El aviso del documento llega cuando ya es tarde',
        resumen: 'El recordatorio sale cuando la persona ya cerró la aplicación.',
        fragmento: 'El 71% de los abandonos',
      });

      const p = (await panelPropuestas(ctx.curadorId, ctx.ws)).pendientes.find(
        (x) => x.capacidad === 'C3',
      )!;
      expect(p.anclaEstado, 'el panel ofrece aceptar algo que no se puede aceptar').toBe(
        'alcance-incompleto',
      );
      // Otra vez es el SERVICIO quien lo para: la validación ya estaba cometida cuando la
      // aceptación empieza a leer. El guard queda debajo para lo que el servicio no puede ver,
      // y ése es el caso que mide la sonda de la firma entre medias.
      await expect(
        aceptarPropuesta(ctx.curadorId, { workspaceId: ctx.ws, propuestaId }),
      ).rejects.toThrow(/Los insights validados de ese reto cambiaron/);
    });
  });

  /**
   * Y la firma que llega ENTRE MEDIAS, que es para lo que existe el guard DIFERIDO.
   *
   * El caso de arriba lo para la comprobación del servicio, porque la firma ya estaba cometida
   * cuando la aceptación empieza a leer. Éste es el otro, y hay que montarlo con cuidado
   * porque la carrera obvia NO lo produce: medido, con la firma en vuelo sujeta por un candado
   * y la aceptación real corriendo contra ella, la aceptación SELLA — y con razón. El guard
   * toma el candado del RETO y la firma escribe en `gate_instancia`, que son filas distintas:
   * no hay conflicto, nadie espera a nadie, y la aceptación commitea ANTES que la firma. Ése
   * es el orden benigno: la HMW ya estaba dentro cuando G3 se firmó, así que G3 la vio.
   *
   * El orden que sí hace daño es el contrario, y no es una carrera sino una secuencia: la
   * aceptación INSERTA la HMW con el portafolio abierto —y la política del insert, que corre
   * con el snapshot de esa sentencia, la deja pasar—, la firma se cometea desde otra conexión,
   * y solo después se sella la propuesta. Ahí el guard diferido es lo único que queda debajo:
   * corre en el COMMIT, donde una firma que llegó en medio sí se ve, y es lo que impide meter
   * una HMW en un portafolio que un gate acaba de dar por bueno.
   *
   * Es el mismo eje TIEMPO que ya obligó a C2 a volver a mirar los derechos de sus citas y a
   * C6 la firma de su registry, en su tercer instante: no el de generar ni el de guardar, sino
   * el de sellar.
   */
  /**
   * CENSO: todo estado de ancla que el SQL del panel emite tiene que estar en el registro.
   *
   * Éste es el agujero por el que C3 se coló: su CASE devolvía `portafolio-cerrado` e
   * `insight-no-validado`, que no estaban en `ESTADOS_ANCLA`. Nadie se enteró porque el valor
   * llega desde SQL como texto y `filaDePanel` lo mete al tipo con un cast: el compilador no
   * ve nada, la aceptación queda deshabilitada —eso sí funcionaba— y `MOTIVO_ANCLA[estado]`
   * devuelve `undefined`, así que quien revisa se queda sin explicación ni salida.
   *
   * Se mide sobre el TEXTO del registro y no llamando a los callbacks: `estado` devuelve un
   * fragmento de plantilla, no una cadena, y ejecutarlo pediría una conexión por capacidad
   * para no leer, al final, más que estos literales. Lo que devuelve `estadoDeLaFila` no hace
   * falta censarlo: eso sí está tipado como `EstadoAncla` y lo sujeta el compilador.
   *
   * El modo de fallo está invertido a propósito, que es la lección del censo de husos: si la
   * extracción deja de encontrar literales, la prueba CAE en vez de pasar en vacío.
   */
  it('todo estado de ancla que emite el SQL del panel está declarado en ESTADOS_ANCLA', async () => {
    const fuente = await readFile(
      new URL('../../lib/ai/ai.servicio.ts', import.meta.url),
      'utf8',
    );
    const desde = fuente.indexOf('const CAPACIDAD_EN_EL_PANEL');
    expect(desde, 'no se encontró el registro del panel: el censo no mide nada').toBeGreaterThan(
      -1,
    );
    const region = fuente.slice(desde, fuente.indexOf('\n};', desde));
    const emitidos = [
      ...new Set([...region.matchAll(/(?:then|else)\s+'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!)),
    ].sort();
    // Sin esto, una extracción rota devolvería la lista vacía y el censo pasaría en vacío.
    expect(
      emitidos.length,
      'la extracción no encontró literales: el censo dejó de medir',
    ).toBeGreaterThan(8);
    expect(emitidos.filter((e) => !ESTADOS_ANCLA.includes(e as EstadoAncla))).toEqual([]);
  });

  /**
   * Y el material que CAMBIA sin que cambie el conjunto de ids.
   *
   * La formulación del reto, el título o el resumen de un insight ya validado, o el texto de
   * un criterio: nada de eso mueve `insights_validados_del_reto`, así que el CASE del panel
   * —que mira ese conjunto— seguía diciendo `disponible`. Pero la huella del material sí se
   * mueve, y la comprobación de la aceptación la compara: el botón se ofrecía y aceptar
   * fallaba SIEMPRE. Es la tarjeta que se puede pulsar y nunca funciona, el mismo defecto que
   * C6 corrigió con su `estadoDeLaFila`.
   *
   * Y «no se sabe» tiene motivo propio: si la propuesta viene de otro render del prompt, decir
   * «los insights cambiaron» sería inventarse una alarma y mandar a quien revisa a buscar una
   * edición que nadie hizo. La salida es la misma —rechazar y pedir otro lote—, el motivo no.
   */
  it('C3: si el material cambia bajo una propuesta pendiente, el panel deja de ofrecerla', async () => {
    const admin = sqlAdmin();
    await enWorkspaceLimpio('c3-material-cambiado', async (ctx) => {
      const { insightId, propuestaId } = await propuestaC3Pendiente(ctx);
      // Antes de tocar nada: sin esta mitad, un panel que dijera siempre «cambiados» pasaría
      // la de abajo sin medir nada.
      const antes = (await panelPropuestas(ctx.curadorId, ctx.ws)).pendientes.find(
        (x) => x.capacidad === 'C3',
      )!;
      expect(antes.anclaEstado).toBe('disponible');

      // El resumen del insight, que NO mueve el conjunto de ids validados y SÍ la huella.
      await admin`update insight set resumen = 'Otro resumen, entero y distinto.'
        where id = ${insightId}`;

      const p = (await panelPropuestas(ctx.curadorId, ctx.ws)).pendientes.find(
        (x) => x.capacidad === 'C3',
      )!;
      expect(p.anclaEstado, 'el panel ofrece aceptar algo que no se puede aceptar').toBe(
        'insights-cambiados',
      );
      // Y no es decoración: aceptar falla de verdad, que es lo que el estado anuncia.
      await expect(
        aceptarPropuesta(ctx.curadorId, { workspaceId: ctx.ws, propuestaId }),
      ).rejects.toThrow(/Los insights validados de ese reto cambiaron/);
    });
  });

  /**
   * C3 no se pide sobre un material que no cabe entero, ni sobre uno que no trae contra qué
   * priorizar. Las dos son la misma regla: no se pregunta lo que no se ha enseñado.
   *
   *   · UN SOLO insight fuera basta. `alcance_insights` guarda solo los que llegaron enteros
   *     —tiene que ser honesto, ésa fue la corrección de C2— y el suelo exige que ese conjunto
   *     CONTENGA todos los validados del reto. Con uno fuera es un subconjunto estricto desde
   *     el primer instante: el panel la marca `alcance-incompleto` nada más nacer y aceptarla
   *     no puede prosperar NUNCA. Lo que quedaba era una tarjeta que solo se puede rechazar,
   *     con la llamada ya pagada. El caso de «ninguno cabe» era esto mismo visto en su extremo.
   *
   *   · Y SIN CRITERIOS no hay prioridad que argumentar. El sistema exige que cada razón
   *     nombre el criterio que la pregunta movería, y `prioridadRazon` es prosa libre: sin
   *     criterios delante el modelo cumple inventándose uno, y lo inventado se materializa con
   *     aspecto de argumento. Es la misma puerta que C6 cierra sobre un reto sin criterios.
   *
   * En los dos casos se comprueba además que NO se apuntó llamada: el corte va antes de pagar,
   * que es la mitad que convierte «se rechaza igual» en «no se gastó».
   */
  it('C3 no se despacha con un insight recortado ni sin criterios contra los que priorizar', async () => {
    const admin = sqlAdmin();
    await enWorkspaceLimpio('c3-insight-recortado', async (ctx) => {
      const evId = await evidenciaDelReto(ctx.ws, ctx.retoId, ctx.curadorId, {
        titulo: 'Abandono en verificación',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento de identidad.',
      });
      await criterioDelReto(ctx.ws, ctx.retoId, ctx.curadorId);
      await insightValidadoDelReto(ctx.ws, evId, ctx.curadorId, {
        titulo: 'La verificación excluye a quien no tiene el documento a mano',
        resumen: 'Quien no lleva el documento encima abandona y no vuelve.',
        fragmento: 'El 71% de los abandonos',
      });
      // Sin éste, el lote saldría: es el que no cabe, y basta con él.
      await insightValidadoDelReto(ctx.ws, evId, ctx.curadorId, {
        titulo: 'El relato largo del participante',
        resumen: 'Relato sin parar. '.repeat(MAX_MATERIAL / 10),
        fragmento: 'El 71% de los abandonos',
      });

      await conProveedor(
        { ok: true, datos: { oportunidades: [] }, intentos: [intento({ uso: null })] },
        async () => {
          await expect(
            generarPropuestas(ctx.curadorId, {
              workspaceId: ctx.ws,
              capacidad: 'C3',
              anclaId: ctx.retoId,
            }),
          ).rejects.toThrow(/no caben enteros en el material/);
        },
      );
      const [n] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${ctx.ws}`;
      expect(n!.n, 'se apuntó una llamada que no se hizo').toBe(0);
    });

    await enWorkspaceLimpio('c3-sin-criterios', async (ctx) => {
      const evId = await evidenciaDelReto(ctx.ws, ctx.retoId, ctx.curadorId, {
        titulo: 'Abandono en verificación',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento de identidad.',
      });
      await insightValidadoDelReto(ctx.ws, evId, ctx.curadorId, {
        titulo: 'La verificación excluye a quien no tiene el documento a mano',
        resumen: 'Quien no lleva el documento encima abandona y no vuelve.',
        fragmento: 'El 71% de los abandonos',
      });
      // Con insight y SIN criterio: lo único que falta es contra qué priorizar.
      await conProveedor(
        { ok: true, datos: { oportunidades: [] }, intentos: [intento({ uso: null })] },
        async () => {
          await expect(
            generarPropuestas(ctx.curadorId, {
              workspaceId: ctx.ws,
              capacidad: 'C3',
              anclaId: ctx.retoId,
            }),
          ).rejects.toThrow(/no tiene criterios de éxito/);
        },
      );
      const [n] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${ctx.ws}`;
      expect(n!.n, 'se apuntó una llamada que no se hizo').toBe(0);
      // Y con el criterio puesto SÍ sale: sin esta mitad, un corte que rechazara siempre
      // pasaría la de arriba sin medir nada.
      await criterioDelReto(ctx.ws, ctx.retoId, ctx.curadorId);
      await conProveedor(
        { ok: true, datos: { oportunidades: [] }, intentos: [intento({ uso: null })] },
        async () => {
          const r = await generarPropuestas(ctx.curadorId, {
            workspaceId: ctx.ws,
            capacidad: 'C3',
            anclaId: ctx.retoId,
          });
          expect(r.generadas).toBe(0);
        },
      );
    });
  });

  /**
   * Y la función que lo decide, medida aparte: los criterios de C3 van DETRÁS de los insights,
   * así que son los primeros que el recorte se come.
   *
   * Hermana y no la misma que la de C6 —allí los criterios SON el material y van delante—: son
   * dos cuerpos distintos y se recortan en sitios distintos, así que una sola función mediría
   * un texto que en la otra capacidad nadie manda.
   */
  it('C3: el recorte del material decide si queda algún criterio contra el que priorizar', () => {
    const criterio = {
      id: 'c3d4e5f6-0000-4000-8000-00000000000b',
      kpi: 'K',
      definicion: 'D',
      objetivo: 'O',
      ventanaDias: 30,
      lineaBasePlan: 'P',
    };
    const reto = {
      codigo: 'R-01',
      titulo: 'T',
      descripcion: 'x'.repeat(MAX_MATERIAL),
      insights: [{ id: 'c3d4e5f6-0000-4000-8000-00000000000c', titulo: 'I', resumen: 'R' }],
      criterios: [criterio],
    };
    // Con la descripción ocupando el presupuesto entero no llega NINGUNO.
    const recortado = criteriosQueLlegaronConLasOportunidades(reto);
    expect(recortado.ids).toEqual([]);
    expect(recortado.fuera).toBe(1);
    // Y sin recorte llegan enteros, que es la otra mitad: sin ella, una función que devolviera
    // siempre la lista vacía pasaría igual.
    const llano = criteriosQueLlegaronConLasOportunidades({ ...reto, descripcion: 'D' });
    expect(llano.ids).toEqual([criterio.id]);
    expect(llano.fuera).toBe(0);
  });

  it('C3: una firma de G3 cometida entre el insert y el sello impide materializar la HMW', async () => {
    await enWorkspaceLimpio('c3-firma-entre-medias', async (ctx) => {
      const admin = sqlAdmin();
      const { insightId, propuestaId } = await propuestaC3Pendiente(ctx);
      const gateId = await puertaDeG3(ctx.ws, ctx.retoId, ctx.curadorId);
      const contenido = CONTENIDO_C3(insightId);

      await expect(
        conUsuario(ctx.curadorId, async (tx) => {
          const [o] = await tx`insert into oportunidad
            (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
            values (${ctx.ws}, ${ctx.retoId}, ${contenido.pregunta}, ${contenido.prioridad},
                    ${contenido.prioridadRazon}, ${ctx.curadorId})
            returning id`;
          await tx`insert into oportunidad_insight (workspace_id, oportunidad_id, insight_id)
            values (${ctx.ws}, ${o!.id as string}, ${insightId})`;
          // La firma, desde OTRA conexión y ya cometida, justo aquí.
          await admin.begin((t2) => firmaDeG3(t2, ctx.ws, gateId, ctx.curadorId));
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${ctx.curadorId},
                oportunidad_id = ${o!.id as string}
            where id = ${propuestaId} and workspace_id = ${ctx.ws}`;
        }),
      ).rejects.toThrow(/el portafolio de ese reto se cerró mientras esta HMW esperaba revisión/);

      // Y no queda nada a medias: la transacción entera se fue, así que ni HMW ni traza.
      const filas = await admin`select 1 from oportunidad where workspace_id = ${ctx.ws}`;
      expect(filas.length).toBe(0);
      const [sigue] = await admin`select estado from propuesta_ai where id = ${propuestaId}`;
      expect(sigue!.estado).toBe('propuesta');
    });
  });

  /** Las señales que la validación produce sobre un journey, pedidas a la MISMA función que
   * las produce en producción. Se usa para armar informes completos sin copiar el catálogo. */
  async function senalesDe(
    actorId: string,
    wsId: string,
    journeyId: string,
  ): Promise<{ nodoId: string; codigo: string }[]> {
    return conUsuario(actorId, async (tx) => {
      const g = await leerJourneyCompleto(tx, wsId, journeyId);
      return validarJourney(g!).map((x) => ({ nodoId: x.nodoId, codigo: x.codigo }));
    });
  }

  /** Un informe COMPLETO: una remediación por cada señal abierta, que es lo que el contrato
   * pide. Se deriva de las señales reales, nunca de una lista escrita a mano. */
  function informeCompleto(
    senales: { nodoId: string; codigo: string }[],
  ): ContenidoRemediacionJourney {
    return {
      resumen: 'Cómo cerrar lo que la validación señala.',
      remediaciones: senales.map((s) => ({
        nodoId: s.nodoId,
        codigo: s.codigo as ContenidoRemediacionJourney['remediaciones'][number]['codigo'],
        comoCerrarlo: 'Encadénalo con el paso siguiente de su fase.',
      })),
      citas: [{ fragmento: 'Recibir documento', localizacion: 'nodos del grafo' }],
      confianzaPropuesta: 'alta',
    };
  }

  /**
   * Un journey con SNAPSHOT sigue admitiendo remediación, y eso es lo que RF-05.8 dice.
   *
   * Aquí había un corte por snapshot —en la cola, en el estado del ancla, en `PREPARAR` y en
   * `REVALIDAR`— con el argumento de que «un snapshot fija el grafo aprobado». Es un error de
   * lectura, y su migración lo dice con todas las letras: «el journey de trabajo sigue
   * editable para el ciclo siguiente», «el grafo de trabajo no se cierra nunca; lo que queda
   * fijo es cada snapshot». Lo inmutable es la FOTO, no el modelo.
   *
   * El efecto era permanente y silencioso: en cuanto un journey pasaba su primera design
   * version, desaparecía de C5 para siempre — justo el que más ciclos lleva y más señales
   * acumula. Y no habría fallado nunca: la cola simplemente no lo ofrecía.
   */
  it('un journey con snapshot sigue ofreciéndose a C5: lo inmutable es la foto, no el grafo', async () => {
    await enWorkspaceLimpio('c5-con-snapshot', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const admin = sqlAdmin();
      await admin`insert into journey_snapshot
        (workspace_id, journey_id, motivo, grafo, congelado_por)
        values (${wsC}, ${j.journeyId}, 'design version aprobada', '{}'::jsonb, ${curadorId})`;

      const panel = await panelPropuestas(curadorId, wsC);
      expect(
        panel.candidatas.C5.lista.some((c) => c.id === j.journeyId),
        'el journey con snapshot desapareció de la cola de C5',
      ).toBe(true);

      // Y la generación tampoco lo rechaza: el camino entero sigue abierto.
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      expect(senales.length).toBeGreaterThan(0);
      const generadas = await conProveedor(
        {
          ok: true,
          datos: informeCompleto(senales) as unknown as Record<string, unknown>,
          intentos: [intento({ uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
      );
      expect(generadas.generadas).toBe(1);
    });
  });

  /**
   * Una cita a evidencia que NO es del reto no entra, y da igual que exista y sea del tenant.
   *
   * La FK compuesta ya comprueba las dos cosas; lo que falta es el ALCANCE. Una cita a
   * evidencia ajena manda a quien revisa a buscar el sostén donde no está, y es lo único de
   * la salida de C2 que se puede contrastar contra algo — el fragmento y la localización son
   * texto, y del texto solo se mide si aparece.
   */
  it('una cita del insight no puede señalar evidencia que no es del reto', async () => {
    await enWorkspaceLimpio('c2-evidencia-ajena', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const propia = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La del reto',
        resumen: 'Un dato del reto.',
      });
      // Del MISMO workspace, sin arquetipo que la ate a este reto: existe, es del tenant y no
      // está en el material que el modelo leyó.
      const [otroReto] = await admin`insert into reto
        (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
        select ${wsC}, servicio_ancla_id, 'R-99', 'Otro reto', 'candidato', 'peticion-cliente',
               ${curadorId}
        from reto where id = ${retoC} returning id`;
      const ajena = await evidenciaDelReto(wsC, otroReto!.id as string, curadorId, {
        titulo: 'La de otro reto',
        resumen: 'Un dato que no es de este reto.',
      });

      const conCita = (evidenciaId: string): ContenidoInsight => ({
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ evidenciaId, fragmento: 'Un dato', localizacion: 'resumen' }],
          },
        ],
        contradicciones: [],
        confianzaPropuesta: 'media',
      });

      // La de su reto entra…
      const llamada = await conUsuario(curadorId, (tx) => tx`
        insert into llamada_ai (workspace_id, capacidad, reto_id, modelo, origen_key,
                                resultado, creado_por)
        values (${wsC}, 'C2', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId})
        returning id`);
      const escribir = (contenido: ContenidoInsight) =>
        conUsuario(curadorId, (tx) => tx`
          insert into propuesta_ai
            (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
             confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key, llamada_id,
             creado_por)
          values (${wsC}, 'C2', 'insight', ${retoC}, ${tx.json(contenido)},
                  ${tx.json(contenido)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                  'alcance', 'huella-del-material', ${ALCANCE_DEL_RETO(tx, wsC, retoC)}, 'entorno', ${llamada[0]!.id as string}, ${curadorId})
          returning id`);
      await expect(escribir(conCita(propia))).resolves.toBeDefined();
      // …y la ajena no.
      await expect(escribir(conCita(ajena))).rejects.toThrow(/no es de este reto/);

      // Y una cita SIN `evidenciaId` tampoco pasa por el hueco: sin la bandera aparte del
      // valor, el `select … into` la habría seleccionado dejando el motivo en null y el `if`
      // no habría disparado.
      const sinId = {
        ...conCita(propia),
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ fragmento: 'Un dato', localizacion: 'resumen' }],
          },
        ],
      } as unknown as ContenidoInsight;
      await expect(escribir(sinId)).rejects.toThrow(/no es de este reto/);

      /*
       * Y EL SUELO: sin afirmaciones, o con una afirmación sin citas, tampoco.
       *
       * El esquema de la aplicación ya lo exige, y eso es exactamente por lo que hace falta en
       * la base: por esta misma superficie SQL, un curador podía escribir `afirmaciones: []`
       * —o una afirmación con `citas: []`— y entonces el barrido de arriba no tenía nada que
       * mirar y el guard de materialización comparaba cero contra cero y daba la paridad por
       * buena. Quedaba sellado un insight ATRIBUIDO A LA AI sin una sola cita, que es lo que
       * esta rebanada existe para impedir.
       */
      const sinAfirmaciones = { ...conCita(propia), afirmaciones: [] } as ContenidoInsight;
      await expect(escribir(sinAfirmaciones)).rejects.toThrow(/al menos una afirmación/);
      const sinCitas = {
        ...conCita(propia),
        afirmaciones: [{ texto: 'A', esHipotesis: false, citas: [] }],
      } as ContenidoInsight;
      await expect(escribir(sinCitas)).rejects.toThrow(/al menos una cita/);
    });
  });
  /**
   * Y un journey LIMPIO no se ofrece, que es lo que su rótulo prometía.
   *
   * El selector dice «Journey con señales abiertas» y su cola vacía dice «no hay journeys con
   * señales de validación abiertas», pero no filtraba por señales: ofrecía cualquiera y
   * `PREPARAR.C5` lo rechazaba después. Una opción que no puede llevar a ninguna parte, con un
   * rótulo que decía lo contrario. El coste de filtrarlo es leer los grafos del prefiltro, y
   * está acotado; el de no filtrarlo lo paga quien pulsa.
   */
  /**
   * La huella es del MATERIAL, no del grafo crudo: lo que el modelo no vio no la mueve.
   *
   * En cuanto el cuerpo se recorta, las dos cosas dejan de ser la misma. Con la huella sobre
   * el grafo, un journey grande cuya conectividad cabe pero cuyas etiquetas de cola no
   * cambiaba de huella al editar la etiqueta de un nodo que el modelo NUNCA vio: el prompt era
   * idéntico byte a byte, la respuesta pagada se descartaba igual, y un informe ya escrito se
   * marcaba «journey cambiado» por una edición que no le afectaba.
   *
   * Va por el camino REAL —se genera el informe y se lee el panel—, porque medir el texto del
   * material solo probaría la premisa: lo que hay que sujetar es que la huella salga de él.
   *
   * El relleno son `emocion` DENTRO de la fase del fixture, no pasos: aportan bulto sin emitir
   * ni una señal —no son transitables, no exigen responsable, y con fase no quedan huérfanos—,
   * así que el techo de `MAX_REMEDIACIONES` no se toca y el caso mide lo que dice medir.
   */
  it('editar un nodo que el recorte dejó fuera no marca el informe como obsoleto', async () => {
    await enWorkspaceLimpio('c5-huella-del-material', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const admin = sqlAdmin();
      const relleno: string[] = [];
      for (let i = 0; i < 40; i++) {
        const [n] = await admin`insert into journey_nodo
          (workspace_id, journey_id, tipo, etiqueta, detalle, fase_id, orden, responsable,
           creado_por)
          values (${wsC}, ${j.journeyId}, 'emocion',
                  ${`Emoción de relleno ${i} — ${'texto largo de relleno '.repeat(30)}`}, '',
                  ${j.nodos.fase}, ${200 + i}, '', ${curadorId})
          returning id`;
        relleno.push(n!.id as string);
      }

      // El fixture tiene que ser el caso por los dos lados: el cuerpo se recorta, y las
      // señales siguen siendo las mismas que sin relleno.
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      const material = await conUsuario(curadorId, async (tx) => {
        const g = await leerJourneyCompleto(tx, wsC, j.journeyId);
        return materialDeJourney({
          nombre: g!.nombre,
          servicio: g!.servicioNombre,
          tipo: g!.tipo,
          grafo: {
            nodos: g!.nodos.map((n) => ({
              id: n.id,
              tipo: n.tipo,
              etiqueta: n.etiqueta,
              fase: '',
              faseId: n.faseId ?? '',
              responsable: n.responsable ?? '',
              evidencias: n.evidencias.length,
            })),
            aristas: [],
            senales: [],
          },
        });
      });
      expect(material.truncado, 'el cuerpo no llega al techo: el caso no existe').toBe(true);

      await conProveedor(
        {
          ok: true,
          datos: informeCompleto(senales) as unknown as Record<string, unknown>,
          intentos: [intento({ uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
      );
      const recien = await panelPropuestas(curadorId, wsC);
      expect(recien.pendientes.find((x) => x.capacidad === 'C5')!.anclaEstado).toBe('disponible');

      // El ÚLTIMO relleno quedó fuera del recorte: el resto se escribe detrás del núcleo y el
      // recorte cae a mitad de las emociones, así que la última no llega.
      const invisible = relleno[relleno.length - 1]!;
      expect(material.texto).not.toContain(`[${invisible}] emocion ·`);
      await admin`update journey_nodo set etiqueta = 'Renombrado donde nadie lo ve'
        where id = ${invisible} and workspace_id = ${wsC}`;
      const tras = await panelPropuestas(curadorId, wsC);
      expect(
        tras.pendientes.find((x) => x.capacidad === 'C5')!.anclaEstado,
        'una edición que el modelo no vio marca el informe como obsoleto',
      ).toBe('disponible');

      // Y la otra mitad: editar lo que SÍ se ve sí lo marca.
      await admin`update journey_nodo set etiqueta = 'Comprobar quién eres'
        where id = ${j.nodos.dos} and workspace_id = ${wsC}`;
      const visible = await panelPropuestas(curadorId, wsC);
      const informe = visible.pendientes.find((x) => x.capacidad === 'C5')!;
      expect(informe.anclaEstado).toBe('journey-cambiado');

      /*
       * Y UNA HUELLA DE OTRO RENDER NO ES COMPARABLE. Desde que se calcula sobre el material
       * —el texto ya recortado— un cambio del prompt la mueve sin que el grafo se haya tocado.
       * Sin mirar `prompt_version`, el día de un despliegue toda propuesta viva de C5 se
       * marcaría «journey cambiado» a la vez, culpando al grafo de un cambio del renderizador.
       * No saber no puede volverse una alarma.
       */
      await admin`update propuesta_ai set prompt_version = 'ai-de-otro-despliegue'
        where id = ${informe.id} and workspace_id = ${wsC}`;
      const otroRender = await panelPropuestas(curadorId, wsC);
      expect(
        otroRender.pendientes.find((x) => x.capacidad === 'C5')!.anclaEstado,
        'una huella de otro render se lee como si el grafo hubiera cambiado',
      ).toBe('disponible');
    });
  });

  /**
   * Las citas de C2 tampoco se corrigen — y esta es la que menos se podía dar por hecha.
   *
   * La regla del guard de revisión comparaba `contenido -> 'citas'`, que es donde las guardan
   * CI, C0 y CT. Las de C2 viven DENTRO de cada afirmación, así que esa comparación daba null
   * contra null —iguales— y la regla pasaba EN VACÍO: las citas de C2 habrían sido editables
   * el mismo día que existieron, borrando justo la señal que la corrección no puede tocar.
   *
   * Una regla escrita contra una ruta fija del contenido no protege a quien lo guarda en otro
   * sitio, y no lo dice: pasa.
   */
  it('las citas de C2 no se corrigen aunque vivan dentro de las afirmaciones', async () => {
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'C2',
      anclas: { reto_id: retoId },
    });
    const original = CONTENIDO_C2(evidenciaDelRetoId);
    // Cada afirmación lleva al menos una cita: el contrato lo exige y sin ella el esquema
    // rechazaría la corrección antes de que hablara ninguna regla de citas.
    const segunda = {
      texto: 'Segunda afirmación',
      esHipotesis: true,
      citas: [
        {
          evidenciaId: evidenciaDelRetoId,
          fragmento: 'la carga del documento',
          localizacion: 'resumen',
        },
      ],
    };

    // Corregir el TEXTO de una afirmación sí se puede: eso es corregir.
    await expect(
      aceptarPropuesta(leadId, {
        workspaceId: ws,
        propuestaId,
        correccion: {
          ...original,
          afirmaciones: [{ ...original.afirmaciones[0]!, texto: 'Reescrito por quien revisa' }],
        },
      }),
    ).resolves.toMatchObject({ estado: 'corregida' });

    // Cambiar el FRAGMENTO de una cita, no. Se pide la SALIDA además del asunto, por lo mismo
    // que en las contradicciones: las dos capas dicen «no se corrigen» y la clase tampoco las
    // separa (todo P0001 sale como `ErrorAI`), pero solo el servicio puede decir qué hacer con
    // la propuesta. El suelo tiene su sonda más abajo.
    const otra = await nuevaPropuesta(leadId, { capacidad: 'C2', anclas: { reto_id: retoId } });
    await expect(
      aceptarPropuesta(leadId, {
        workspaceId: ws,
        propuestaId: otra,
        correccion: {
          ...original,
          afirmaciones: [
            {
              ...original.afirmaciones[0]!,
              citas: [
                {
                  ...original.afirmaciones[0]!.citas[0]!,
                  fragmento: 'un fragmento que el modelo no dijo',
                },
              ],
            },
          ],
        },
      }),
    ).rejects.toThrow(/no se corrigen[^]*rechaza la propuesta/i);

    // Y REORDENAR las afirmaciones tampoco: la comparación es posicional a propósito, porque
    // `afirmacion` tiene único `(insight_id, orden)` y mover una afirmación mueve su sitio en
    // el objeto que se materializa.
    const tercera = await nuevaPropuesta(leadId, {
      capacidad: 'C2',
      anclas: { reto_id: retoId },
      contenido: {
        ...original,
        afirmaciones: [original.afirmaciones[0]!, segunda],
      },
    });
    await expect(
      aceptarPropuesta(leadId, {
        workspaceId: ws,
        propuestaId: tercera,
        correccion: {
          ...original,
          afirmaciones: [segunda, original.afirmaciones[0]!],
        },
      }),
    ).rejects.toThrow(/no se corrigen/i);

    /*
     * Y EL SUELO, por separado — con lo que de verdad demuestra y sin pedirle más.
     *
     * Los tres casos de arriba entran por `aceptarPropuesta`, así que la que habla es la regla
     * del SERVICIO. Medido neutralizando cada una por su lado: con `CITAS_DEL_CONTENIDO.C2`
     * leyendo `contenido.citas` —lista vacía en los dos lados— la comparación del servicio
     * pasa y rechaza el guard de la base; con el guard mirando `contenido -> 'citas'` rechaza
     * el servicio. Cada uno tapa al otro, y ninguno de esos casos dice cuál de los dos existe.
     *
     * Se escribe DIRECTAMENTE contra la tabla, y con la conexión de administración, que es lo
     * que este caso puede afirmar de verdad: el ROL DE APLICACIÓN no llega a este guard ni
     * queriendo —medido: su política de UPDATE exige estado decidido, revisor y fecha, así que
     * una escritura de solo `contenido` la rechaza la RLS antes—, y una corrección completa
     * por SQL crudo tropieza antes con el CHECK del objeto materializado. Lo que queda debajo
     * de todo eso es este trigger, y es quien responde por el seed, los backfills, las
     * migraciones y cualquier grant futuro que abra la puerta que hoy está cerrada. El guard
     * de revisión no estorba: para quien no es miembro sale por su pre-chequeo anti-oráculo,
     * y éste no tiene ninguno, a propósito.
     */
    const suelo = await nuevaPropuesta(leadId, { capacidad: 'C2', anclas: { reto_id: retoId } });
    const admin = sqlAdmin();
    const conCitaCambiada = {
      ...original,
      afirmaciones: [
        {
          ...original.afirmaciones[0]!,
          citas: [{ ...original.afirmaciones[0]!.citas[0]!, fragmento: 'otro fragmento' }],
        },
      ],
    };
    await expect(
      admin`update propuesta_ai set contenido = ${admin.json(conCitaCambiada)}
        where id = ${suelo} and workspace_id = ${ws}`,
    ).rejects.toThrow(/no se corrigen/i);
    // Y lo que NO es una cita sí se puede reescribir por ahí: sin esto, un guard que
    // rechazara toda escritura de `contenido` pasaría este caso sin haber distinguido nada.
    await expect(
      admin`update propuesta_ai
        set contenido = ${admin.json({ ...original, titulo: 'Otro título' })}
        where id = ${suelo} and workspace_id = ${ws}`,
    ).resolves.toBeDefined();
  });

  /**
   * Un G0 aprobado congela los CRITERIOS, no los insights.
   *
   * El guard de revisión cerraba con `if new.reto_id is not null and (congelados or no
   * admite)`, que era exacto mientras colgar del reto fuera ser C0. Con C2 en el mismo reto
   * pasaba a prohibir insights por una puerta que no es la suya — y no en el panel, donde
   * `ELEGIBILIDAD.C2` sí distingue, sino en el INSERT: después de haber pagado la llamada.
   *
   * Se mide con las dos mitades, que es lo que demuestra que la puerta cambió de llave y no
   * simplemente se abrió: en el MISMO reto congelado, C2 entra y C0 sigue rechazada.
   */
  it('un reto con sus criterios congelados sigue admitiendo insights, y no criterios', async () => {
    await enWorkspaceLimpio('c2-g0-congelado', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const evId = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Dato del reto',
        resumen: 'Un dato del reto.',
      });
      /*
       * El reto firma su contrato de medición, que es lo que congela sus criterios (SYS-22).
       * El insert directo del registry ya firmado es el atajo que este fichero ya usa —el
       * camino real pasa por G6—, y el efecto sobre los criterios es el mismo.
       *
       * Se congela por aquí y no llevando el reto a `en-medicion` porque ese estado no se
       * alcanza a mano: `candidato → en-medicion` no es una transición legal y el camino
       * canónico exige el registry firmado en G6 y el G7 aprobado. La puerta que se está
       * midiendo es la misma —`reto_criterios_congelados` y `reto_admite_criterios` entran
       * las dos en la misma condición—, y ésta se monta con una fila.
       */
      await admin`insert into metric_registry
        (workspace_id, reto_id, estado, firmado_por, firmado_en, creado_por)
        values (${wsC}, ${retoC}, 'firmado', ${curadorId}, now(), ${curadorId})`;
      expect(
        (await admin`select reto_criterios_congelados(${retoC}::uuid, ${wsC}::uuid) as x`)[0]!.x,
      ).toBe(true);

      const generadas = await conProveedor(
        {
          ok: true,
          datos: {
            insights: [
              {
                titulo: 'T',
                resumen: 'R',
                afirmaciones: [
                  {
                    texto: 'A',
                    esHipotesis: false,
                    citas: [
                      { evidenciaId: evId, fragmento: 'Un dato', localizacion: 'resumen' },
                    ],
                  },
                ],
                contradicciones: [],
                confianzaPropuesta: 'media',
              },
            ],
          },
          intentos: [intento({ latenciaMs: 55, uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      expect(generadas.generadas).toBe(1);

      // Y la otra mitad: C0 sobre ESE MISMO reto sigue cerrada. Si la corrección hubiera
      // quitado la puerta en vez de cambiarle la llave, esto pasaría y nadie lo diría.
      await expect(
        generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C0', anclaId: retoC }),
      ).rejects.toThrow(ErrorAI);
    });
  });
  /**
   * Dos fases con el MISMO NOMBRE no son la misma fase.
   *
   * El grafo que ve el modelo sustituía `faseId` por la ETIQUETA de la fase, y nada impide dos
   * fases llamadas igual. Con solo el rótulo, sus hijos son indistinguibles: «muévelo a la fase
   * Alta» no dice a cuál. Y la huella tampoco los distinguía, así que mover un nodo señalado de
   * una «Alta» a la otra dejaba el material idéntico —un informe que ya no describe la
   * agrupación seguía saliendo al día en el panel—.
   *
   * Se mide por la HUELLA, que es lo que gobierna la obsolescencia: el traslado tiene que
   * cambiarla. Y las señales se comprueban idénticas antes y después, para que el caso no pase
   * por la puerta de «cambiaron las señales», que es otra regla.
   */
  it('mover un nodo entre dos fases del mismo nombre cambia el material que ve el modelo', async () => {
    await enWorkspaceLimpio('c5-dos-fases-igual', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const admin = sqlAdmin();
      // Una segunda fase con EXACTAMENTE el mismo rótulo que la del fixture.
      const [otra] = await admin`insert into journey_nodo
        (workspace_id, journey_id, tipo, etiqueta, detalle, orden, responsable, creado_por)
        values (${wsC}, ${j.journeyId}, 'fase', 'Alta', '', 5, '', ${curadorId})
        returning id`;

      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      const material = async () =>
        conUsuario(curadorId, async (tx) => {
          const g = await leerJourneyCompleto(tx, wsC, j.journeyId);
          return materialDeJourney({
            nombre: g!.nombre,
            servicio: g!.servicioNombre,
            tipo: g!.tipo,
            grafo: {
              nodos: g!.nodos.map((n) => ({
                id: n.id,
                tipo: n.tipo,
                etiqueta: n.etiqueta,
                fase: 'Alta',
                faseId: n.faseId ?? '',
                responsable: n.responsable ?? '',
                evidencias: n.evidencias.length,
              })),
              aristas: g!.aristas.map((a) => ({
                origen: a.origenId,
                destino: a.destinoId,
                tipo: a.tipo,
                condicion: a.condicion ?? '',
              })),
              senales: [],
            },
          }).texto;
        });

      const antes = await material();
      await admin`update journey_nodo set fase_id = ${otra!.id as string}
        where id = ${j.nodos.dos} and workspace_id = ${wsC}`;
      const despues = await material();

      // Las señales son las MISMAS: sin esto, el caso podría estar pasando por otra regla.
      expect(await senalesDe(curadorId, wsC, j.journeyId)).toEqual(senales);
      expect(despues, 'el traslado entre dos fases homónimas no se ve en el material').not.toBe(
        antes,
      );
    });
  });

  /**
   * Un nodoId en MAYÚSCULA es el mismo nodo, y el informe tiene que valer igual.
   *
   * `z.string().uuid()` admite el hexadecimal en mayúscula y Postgres almacena la forma
   * canónica. Un id válido copiado así del material pasaba la validación y luego no acertaba
   * ninguna comparación: `COMPROBAR.C5` empareja las señales remediadas con las que la
   * validación emitió, y una clave en mayúscula no está entre ellas — el informe se descartaba
   * entero por «señal inventada», DESPUÉS de pagarlo, y el mensaje culpaba al modelo de algo
   * que había hecho bien. Del lado de la pantalla, el mapa de etiquetas se indexa por el id que
   * devuelve la base, así que la remediación tampoco decía a qué nodo aplica.
   *
   * Es el mismo defecto que la revisión encontró en las citas de C2 (#35), en el otro
   * identificador que el modelo copia del material.
   */
  it('un nodoId en mayúscula no descarta el informe: el id se normaliza al parsear', async () => {
    await enWorkspaceLimpio('c5-uuid-en-mayuscula', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      expect(senales.length).toBeGreaterThan(0);

      const gritado = informeCompleto(
        senales.map((s) => ({ ...s, nodoId: s.nodoId.toUpperCase() })),
      );
      // El fixture tiene que ser el caso: si el uuid no tuviera letras, esto no probaría nada.
      expect(senales.some((s) => s.nodoId.toUpperCase() !== s.nodoId)).toBe(true);

      await conProveedor(
        {
          ok: true,
          datos: gritado as unknown as Record<string, unknown>,
          intentos: [intento({ uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
      );

      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C5')!;
      // Guardado en canónico, no como vino…
      const remediaciones = (p.contenido as ContenidoRemediacionJourney).remediaciones;
      expect(remediaciones.map((r) => r.nodoId).sort()).toEqual(
        senales.map((s) => s.nodoId).sort(),
      );
      // …y por eso la pantalla sabe a qué nodo aplica cada remediación.
      expect(p.etiquetas[senales[0]!.nodoId]).toBeTruthy();
    });
  });

  /**
   * Sin evidencia enlazada no se llama al proveedor, y el mensaje dice DÓNDE se enlaza.
   *
   * El contrato de C2 obliga a que cada afirmación cite un fragmento literal. Sin evidencia,
   * la única salida que lo cumple sale de la formulación del reto —o sea inventada, con
   * aspecto de fundamentada y pagada—. Es el mismo caso que el item importado solo con su
   * referencia, y la respuesta es la misma. La negativa se comprueba por el LIBRO: sin ella
   * aparecería una línea de coste, que es la forma en que esto costaría dinero.
   */
  it('un reto sin evidencia enlazada no se ofrece a C2 y su generación se niega', async () => {
    await enWorkspaceLimpio('c2-sin-evidencia', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const panel = await panelPropuestas(curadorId, wsC);
      expect(panel.candidatas.C2.lista.some((c) => c.id === retoC)).toBe(false);
      // Y C0, que cuelga del MISMO reto, sí lo ofrece: lo que falta es evidencia, no reto.
      expect(panel.candidatas.C0.lista.some((c) => c.id === retoC)).toBe(true);

      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      await conProveedor(
        {
          ok: true,
          datos: { insights: [] },
          intentos: [intento({ latenciaMs: 10, uso: null })],
        },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
          ).rejects.toThrow(/ARQUETIPOS/);
        },
      );
      const [tras] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(tras!.n).toBe(antes!.n);
    });
  });

  /**
   * Cada COLUMNA de ancla enumera en la base las capacidades que la declaran — las tres tablas.
   *
   * La hermana de «las tres tablas declaran el mismo vocabulario», para el otro eje. Las
   * restricciones de ancla estaban escritas como equivalencias «una capacidad ⇔ una columna»,
   * que es exacto mientras cada columna tenga una sola dueña. C2 es la primera que comparte
   * una —cuelga del reto, igual que C0— y ahí la equivalencia pasa a MENTIR: medido contra la
   * base, `llamada_ai_check1` rechazaba toda llamada de C2 antes de que existiera este caso.
   *
   * Ahora la restricción es por columna y lleva la lista. El modo de fallo que queda es que la
   * lista se quede corta, y es exactamente el que esta prueba cierra: la lista de la base se
   * compara contra la que declara la aplicación en `CAPACIDADES[c].ancla.columna`, que es de
   * donde salen los inserts. Una capacidad nueva que no se añada a su migración enrojece aquí
   * en vez de descubrirse cuando su primera reserva la rechace.
   */
  it('cada columna de ancla enumera en la base las capacidades que la declaran', async () => {
    const admin = sqlAdmin();
    const TABLAS = ['reserva_ai', 'llamada_ai', 'propuesta_ai'];
    // Por nombre exacto, igual que la prueba del vocabulario y por la misma razón: en `LIKE`
    // el guion bajo casa con cualquier carácter, y un patrón que casa de más en una prueba
    // que COMPARA conjuntos es lo que la vuelve verde por accidente.
    const nombres = TABLAS.flatMap((t) => COLUMNAS_DE_ANCLA.map((c) => `${t}_ancla_${c.replace(/_id$/, '')}`));
    const filas = await admin`
      select conrelid::regclass::text as tabla, conname, pg_get_constraintdef(oid) as definicion
      from pg_constraint
      where contype = 'c' and conname in ${admin(nombres)}`;
    // Una por tabla y por columna, ni una menos: una migración que BORRE la suya en vez de
    // rehacerla dejaría el ancla sin sujetar y este caso pasaría sin verlo.
    expect(filas.map((f) => f.conname as string).sort()).toEqual([...nombres].sort());

    for (const columna of COLUMNAS_DE_ANCLA) {
      const declaran = CAPACIDADES_ACTIVAS.filter(
        (c) => CAPACIDADES[c].ancla.columna === columna,
      ).sort();
      for (const tabla of TABLAS) {
        const fila = filas.find((f) => f.conname === `${tabla}_ancla_${columna.replace(/_id$/, '')}`)!;
        const definicion = fila.definicion as string;
        // Los literales de la definición, que son texto del catálogo y no de nadie de fuera.
        // Se cruzan con el vocabulario activo: una capacidad del alcance MVP que la base ya
        // liste y la aplicación todavía no active no es un defecto, y afirmar sobre ella sería
        // afirmar lo que esta prueba no puede saber.
        const enLaBase = [...definicion.matchAll(/'([^']+)'/g)]
          .map((m) => m[1] as string)
          .filter((c) => (CAPACIDADES_ACTIVAS as readonly string[]).includes(c))
          .sort();
        expect(
          enLaBase,
          `${tabla}.${columna}: la base y la aplicación no declaran las mismas capacidades ` +
            'ancladas ahí — la que falte no puede escribir su fila, y la que sobre puede ' +
            'colgar de un ancla que no declara',
        ).toEqual(declaran);
      }
    }
  });

  /**
   * Y la EXCLUSIÓN por ancla, que es la misma trampa escrita como índice.
   *
   * Los índices únicos que impiden dos trabajos a la vez sobre el mismo objeto estaban por
   * COLUMNA —`unique (workspace_id, reto_id)`—, que con una capacidad por columna dice «no se
   * paga dos veces por el mismo objeto». Con dos capacidades ahí pasa a decir que pedir
   * insights y pedir criterios sobre el mismo reto son el MISMO trabajo: medido, con una
   * generación de C0 en vuelo la reserva de C2 moría en `reserva_ai_reto_idx`.
   *
   * La corrección fue meter la capacidad en la clave. Lo que esta prueba cierra es que no se
   * quede a medias: un índice único que lleve una columna de ancla y no distinga la capacidad
   * —ni en la clave ni en su predicado— es una exclusión entre pipelines independientes. Se
   * pregunta al catálogo por TODOS los índices únicos de las tres tablas, no por una lista
   * escrita a mano, porque el modo de fallo es justo el índice que nadie se acordó de mirar.
   */
  it('ningún índice único excluye por ancla sin distinguir la capacidad', async () => {
    const admin = sqlAdmin();
    const filas = await admin`
      select c.relname as tabla,
             ic.relname as indice,
             array_agg(a.attname order by k.ord) as columnas,
             coalesce(pg_get_expr(i.indpred, i.indrelid), '') as predicado
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class c on c.oid = i.indrelid
      join lateral unnest(i.indkey) with ordinality as k(attnum, ord) on true
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indisunique
        and c.relname in ('reserva_ai', 'llamada_ai', 'propuesta_ai')
      group by 1, 2, 4`;
    // Que esté mirando algo: sin índices, la lista vacía pasaría sin comprobar nada.
    expect(filas.length).toBeGreaterThan(0);

    const ciegos = filas
      .filter((f) => {
        const columnas = f.columnas as string[];
        const ancla = COLUMNAS_DE_ANCLA.filter((c) => columnas.includes(c));
        if (ancla.length === 0) return false;
        return !columnas.includes('capacidad') && !(f.predicado as string).includes('capacidad');
      })
      .map((f) => `${f.tabla as string}.${f.indice as string}`)
      .sort();
    expect(
      ciegos,
      'un índice único sobre una columna de ancla que no distingue la capacidad: dos ' +
        'capacidades ancladas ahí se excluyen entre sí, y son pipelines independientes',
    ).toEqual([]);
  });

  /**
   * Y el VOCABULARIO DE DESTINOS, por lo mismo y en el otro extremo del pipeline.
   *
   * `propuesta_ai.destino` traía `check (destino in ('evidencia','criterio-exito'))` desde la
   * migración original. CT no lo rozó —su destino es NULL y un `in (…)` sobre null da null,
   * que pasa—, así que la enumeración corta llegó viva hasta la primera capacidad que
   * materializa un objeto nuevo. Medido: sin la corrección, TODA propuesta de C2 la rechazaba
   * ese CHECK.
   */
  it('el vocabulario de destinos de la base cubre lo que declara la aplicación', async () => {
    const admin = sqlAdmin();
    const [fila] = await admin`
      select pg_get_constraintdef(oid) as definicion from pg_constraint
      where contype = 'c' and conname = 'propuesta_ai_destino_vocabulario'
        and conrelid = 'propuesta_ai'::regclass`;
    expect(fila, 'la restricción del vocabulario de destinos no existe').toBeDefined();
    const enLaBase = [...(fila!.definicion as string).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(enLaBase.length).toBeGreaterThan(1);
    const declarados = [
      ...new Set(
        CAPACIDADES_ACTIVAS.map((c) => CAPACIDADES[c].destino).filter(
          (d): d is Destino => d !== null,
        ),
      ),
    ];
    const desconocidos = declarados.filter((d) => !enLaBase.includes(d));
    expect(
      desconocidos,
      'un destino que la aplicación declara y la base no admite: su primera propuesta lo rechaza',
    ).toEqual([]);

    // Y la columna del objeto materializado, que enumeraba lo mismo por su lado: «aceptada ⇔
    // hay objeto» contaba dos columnas y no la tercera, así que una propuesta de C2 aceptada
    // era imposible. Se comprueba que las TRES estén nombradas, que es lo que faltaba.
    const [objeto] = await admin`
      select pg_get_constraintdef(oid) as definicion from pg_constraint
      where contype = 'c' and conname = 'propuesta_ai_objeto_materializado'
        and conrelid = 'propuesta_ai'::regclass`;
    expect(objeto, 'la restricción del objeto materializado no existe').toBeDefined();
    for (const d of declarados) {
      expect(
        objeto!.definicion as string,
        `el destino «${d}» no entra en la cuenta del objeto materializado: aceptarlo sería imposible`,
      ).toContain(COLUMNA_DE_DESTINO[d]);
    }
  });

  /**
   * Una cita se mide contra LA EVIDENCIA QUE NOMBRA, no contra todas juntas.
   *
   * El material de C2 son varios documentos y cada cita dice de cuál sale. Midiendo contra el
   * pajar completo, «esto está en la evidencia B» salía PRESENTE porque su texto estaba en la
   * A — y eso no es un verde cualquiera: la presencia literal es la única señal contrastable
   * que tiene quien revisa (el fragmento y la localización son texto), así que un verde
   * prestado le dice que confíe en una cita que le manda a otro documento.
   *
   * Las dos mitades en el mismo caso: la cita bien puesta sale presente, y la que nombra el
   * documento equivocado —con un fragmento que SÍ existe, pero en el otro— sale ausente.
   */
  it('la presencia literal de una cita se mide contra la evidencia que nombra', async () => {
    await enWorkspaceLimpio('c2-cita-por-evidencia', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const a = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Analítica del funnel',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const b = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Encuesta de salida',
        resumen: 'Quien abandona dice que no sabía qué documento subir.',
      });

      const contenido: ContenidoInsight = {
        titulo: 'Dónde se pierde la gente',
        resumen: 'El abandono se concentra en la carga del documento.',
        afirmaciones: [
          {
            texto: 'La mayoría abandona al cargar el documento',
            esHipotesis: false,
            citas: [
              // Bien puesta: el fragmento es de A y la cita nombra a A.
              { evidenciaId: a, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' },
              // Mal puesta: el fragmento existe —está en A— pero la cita dice que es de B.
              // Con el pajar completo esto salía en verde, que es el defecto.
              { evidenciaId: b, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' },
              // Y una que nombra evidencia que el modelo no vio se resuelve igual: ausente.
              // (Va con el id de la propia B para no chocar con el guard de evidencia ajena;
              //  lo que la hace ausente es su fragmento, que no está en ningún documento.)
              { evidenciaId: b, fragmento: 'esto no está en ninguna parte', localizacion: 'resumen' },
            ],
          },
        ],
        contradicciones: [],
        confianzaPropuesta: 'media',
      };

      await conProveedor(
        {
          ok: true,
          datos: { insights: [contenido] },
          intentos: [intento({ uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      expect(p.citas.map((c) => c.presenteLiteral)).toEqual([true, false, false]);
      // Y la proyección dice CONTRA QUÉ se midió cada una: sin eso, quien revisa ve el verde
      // pero no de qué documento habla, que es la mitad de la señal.
      expect(p.citas.map((c) => c.alcanceId)).toEqual([a, b, b]);
    });
  });

  /**
   * Y cuando la evidencia enlazada del reto cambia, la presencia literal deja de tener
   * veredicto — igual que en C5 y por la misma razón, que aquí es MENOS visible.
   *
   * En C5 la obsolescencia se ve: alguien editó el grafo del que habla el informe. En C2 basta
   * con que cambie el CONTEXTO. El material son varios documentos concatenados y el recorte de
   * `MAX_MATERIAL` es global y depende del orden, así que a un documento NO CITADO que ordena
   * antes le caducan los derechos —o se enlaza uno nuevo que ordena antes— y el trozo del
   * documento CITADO que el panel recompone hoy ya no es el que el modelo leyó. Ahí el verde
   * miente en los dos sentidos: un fragmento que el recorte de hoy acaba de dejar visible sale
   * PRESENTE aunque el modelo no lo tuviera delante, y una cita legítima cuyo trozo el recorte
   * de hoy esconde sale AUSENTE.
   *
   * La huella que C2 guarda al nacer —la misma que la revalidación previa al despacho ya
   * necesitaba— es lo que permite dar la tercera respuesta. Y la comparación que la lee es la
   * de la CAPACIDAD: escrita para el journey de C5, sobre una fila de C2 habría comparado
   * contra un grafo vacío y habría marcado cambiada toda propuesta de C2.
   */
  it('la presencia literal de una cita de C2 no se afirma si la evidencia del reto cambió', async () => {
    await enWorkspaceLimpio('c2-material-cambiado', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Analítica del funnel',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      await conProveedor(
        { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );

      // Recién nacida, la cita se mide y sale presente: sin esto, el caso podría estar
      // midiendo un fixture cuyo fragmento nunca apareció.
      const recien = await panelPropuestas(curadorId, wsC);
      expect(recien.pendientes.find((x) => x.capacidad === 'C2')!.citas[0]!.presenteLiteral).toBe(
        true,
      );

      // Alguien enlaza otro documento al mismo reto. La cita sigue apuntando al mismo sitio y
      // el reto sigue disponible: lo único que cambió es el material que el panel recompone.
      // Ordena ANTES por título, que es justo el caso que mueve el recorte del citado.
      await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'AAA · Acta de la sesión',
        resumen: 'Nada que ver con el funnel.',
      });

      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      /*
       * Y deja de ser aceptable, que es un cambio de esta ronda y no un detalle: aquí ponía
       * `disponible` con el comentario «la cita apunta a evidencia real y citable, lo que se
       * pierde es la SEÑAL, no la propuesta». Dejó de ser verdad cuando el sello pasó a exigir
       * que los insights hubieran VISTO toda la evidencia del reto — el documento recién
       * enlazado no lo vieron—, y el estado del panel se quedó atrás porque se calculaba sin
       * mirar esa condición. La aserción vieja documentaba el hueco en vez de cerrarlo.
       */
      expect(p.anclaEstado).toBe('alcance-incompleto');
      await expect(
        aceptarPropuesta(curadorId, { workspaceId: wsC, propuestaId: p.id }),
      ).rejects.toThrow(/no llegaron a ver/);
      expect(
        p.citas.map((c) => c.presenteLiteral),
        'el panel afirma sobre un material que ya no es el que vio el modelo',
      ).toEqual([null]);
    });
  });

  /**
   * «Ningún insight» es una RESPUESTA, y hasta ahora no era representable.
   *
   * El prompt de C2 dice «hasta N» y le prohíbe expresamente proponer lo que la evidencia no
   * sostenga; el sobre del lote exigía uno como mínimo a los dos lados —el esquema que se le
   * pide al proveedor y el que valida su respuesta—. Con esos dos a la vez, una evidencia que
   * no sostiene ningún insight responsable no tiene salida legal: el modelo se inventa uno, o
   * su respuesta ya pagada se descarta como `fuera-de-contrato` por haber obedecido.
   *
   * Medido antes de arreglarlo: `generarPropuestas` lanzaba «La respuesta del proveedor AI no
   * cumplió el esquema de la capacidad y se descartó», y el intento quedaba reetiquetado.
   *
   * El suelo se declara ahora por capacidad, que es donde vive la pregunta: C5 mantiene el uno
   * —se niega a llamar con cero señales, así que ninguna petición real tiene la lista vacía por
   * respuesta— y C2 baja a cero. La llamada se cierra como `salida-valida`, porque es lo que
   * describe: el proveedor contestó lo que se le pidió.
   */
  it('un lote vacío de C2 es una respuesta válida, no una salida fuera de contrato', async () => {
    await enWorkspaceLimpio('c2-lote-vacio', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Acta de una reunión interna',
        resumen: 'Se acordó volver a mirarlo el mes que viene.',
      });
      const r = await conProveedor(
        { ok: true, datos: { insights: [] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      expect(r.generadas).toBe(0);

      const [l] = await conUsuario(curadorId, (tx) => tx`
        select resultado from llamada_ai
        where workspace_id = ${wsC} and capacidad = 'C2'`);
      // El libro describe lo que devolvió el PROVEEDOR, y devolvió lo que se le pidió.
      expect(l!.resultado as string).toBe('salida-valida');

      // Y no nace ninguna fila: cero propuestas es cero, no una vacía.
      const filas = await conUsuario(curadorId, (tx) => tx`
        select 1 from propuesta_ai where workspace_id = ${wsC} and capacidad = 'C2'`);
      expect(filas.length).toBe(0);
    });
  });

  /*
   * (Aquí vivía «una cita a evidencia que ya no está en el material no se mide contra el
   * resto». Se retira porque su ruta dejó de ser alcanzable, no porque estorbara.)
   *
   * Aquel caso llegaba al `pajarDeLaCita` nulo por el único hueco que quedaba: la huella no
   * comparable tras un cambio de versión del prompt, que resolvía la presencia como medible y
   * dejaba a una cita sin documento midiéndose contra los demás. Desde que `materialVigente`
   * solo mide cuando la huella dice que SÍ, ese hueco no existe: con la huella igual, el
   * material es el mismo byte a byte, así que el conjunto de documentos también, y una cita no
   * puede nombrar uno que falte. Y con la huella distinta no se mide nada.
   *
   * Lo que protegía sigue protegido, y en un sitio donde no hace falta alcanzarlo para que
   * valga: el TIPO exige `materialVigente` a toda capacidad que declare `pajarDeLaCita`, así
   * que la que venga no puede recortar el pajar por documento sin poder decir si ese recorte
   * sigue siendo el del modelo. Comprobado quitando `materialVigente` de C2: el compilador se
   * niega.
   */

  /**
   * La misma evidencia enlazada por DOS arquetipos del mismo reto se cuenta una vez.
   *
   * La clave de `arquetipo_evidencia` es `(arquetipo_id, evidencia_id)`, así que nada impide
   * que dos arquetipos del mismo reto compartan una entrevista — y es lo normal. El join la
   * devolvía repetida: el documento salía dos veces en el material que ve el modelo, el
   * recuento del alcance mentía, y el presupuesto de caracteres se gastaba en copias hasta
   * truncar evidencia que sí era única.
   */
  it('la evidencia que cuelga de dos arquetipos del mismo reto no se duplica', async () => {
    await enWorkspaceLimpio('c2-evidencia-duplicada', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Entrevista compartida',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      // Un segundo arquetipo del MISMO reto que enlaza LA MISMA evidencia.
      const [otro] = await admin`insert into arquetipo
        (workspace_id, reto_id, nombre, definicion, creado_por)
        values (${wsC}, ${retoC}, 'Segundo arquetipo', 'Definición', ${curadorId}) returning id`;
      await admin`insert into arquetipo_evidencia (workspace_id, arquetipo_id, evidencia_id)
        values (${wsC}, ${otro!.id as string}, ${ev})`;

      const contenido: ContenidoInsight = {
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ evidenciaId: ev, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' }],
          },
        ],
        contradicciones: [],
        confianzaPropuesta: 'media',
      };
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );

      const [p] = await conUsuario(curadorId, (tx) => tx`
        select alcance_resumen from propuesta_ai
        where workspace_id = ${wsC} and capacidad = 'C2'`);
      // El resumen del alcance es lo que queda escrito de lo que se le mandó al modelo: si
      // dijera «2 evidencias» estaría contando el mismo documento dos veces.
      expect(p!.alcance_resumen as string).toContain('1 evidencias');
    });
  });

  /**
   * Y cuando el grafo cambia, la presencia literal de las citas deja de tener veredicto.
   *
   * El panel recompone el pajar a partir del grafo de HOY, y contra ese texto mide si cada
   * cita aparece literal. Después de una edición ajena ese texto ya no es el que vio el
   * modelo: un fragmento que la edición acaba de añadir sale en VERDE —el reviewer lee que la
   * cita está respaldada por un texto que el modelo nunca tuvo delante— y una cita legítima
   * cuyo nodo la edición borró sale en ROJO. Las dos mentiras caben en un booleano.
   *
   * `null` es la tercera respuesta, y es la única honesta. La huella que C5 guarda al nacer es
   * lo que permite darla: sin ella, la capacidad no puede saber si su material sigue siendo el
   * suyo — y las que no lo declaran siguen midiendo como siempre.
   */
  it('la presencia literal de una cita de C5 no se afirma si el grafo cambió', async () => {
    await enWorkspaceLimpio('c5-presencia-sin-veredicto', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      await conProveedor(
        {
          ok: true,
          datos: informeCompleto(senales) as unknown as Record<string, unknown>,
          intentos: [intento({ uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
      );

      // Recién nacido, el pajar ES el del modelo y la cita tiene veredicto: sin esto, el caso
      // podría estar midiendo una propuesta que nunca lo tuvo.
      const antes = await panelPropuestas(curadorId, wsC);
      const recien = antes.pendientes.find((x) => x.capacidad === 'C5')!;
      expect(recien.citas.length).toBeGreaterThan(0);
      expect(recien.citas.every((c) => c.presenteLiteral !== null)).toBe(true);

      // Alguien edita el grafo. La cita no cambió —no se pueden corregir— pero su pajar sí.
      await sqlAdmin()`update journey_nodo set etiqueta = 'Comprobar quién eres'
        where id = ${j.nodos.dos} and workspace_id = ${wsC}`;

      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C5')!;
      expect(
        p.citas.map((c) => c.presenteLiteral),
        'el panel afirma sobre un material que el modelo no vio',
      ).toEqual(p.citas.map(() => null));
      // Y la fila sigue diciendo POR QUÉ, que es la otra mitad de lo mismo.
      expect(p.anclaEstado).toBe('journey-cambiado');
    });
  });

  /**
   * Leer los grafos EN LOTE tiene que dar exactamente la misma proyección.
   *
   * El barrido de candidatos leía un grafo por journey mirado, y con el tope en trescientos
   * eso son hasta trescientas idas y vueltas —cada una con sus agregados anidados— antes de
   * que la pantalla de propuestas pinte nada. Pasa a leer el lote de una vez.
   *
   * Y por eso hay UNA sola definición de la proyección, con la forma en singular delegando en
   * la de plural: de aquí sale la HUELLA del material de C5, así que dos consultas que se
   * desincronizaran en una coma de `order by` declararían obsoleto un informe que está al día
   * y rechazarían una respuesta ya pagada. Esta prueba es lo que sujeta esa igualdad.
   */
  it('leer los grafos en lote da la misma proyección que leerlos de uno en uno', async () => {
    await enWorkspaceLimpio('c5-lectura-en-lote', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const a = await nuevoJourney({ ...ctx, actorId: curadorId });
      const b = await nuevoJourney({ ...ctx, actorId: curadorId }, { limpio: true });

      const sueltos = await conUsuario(curadorId, async (tx) => ({
        a: await leerJourneyCompleto(tx, wsC, a.journeyId),
        b: await leerJourneyCompleto(tx, wsC, b.journeyId),
      }));
      const lote = await conUsuario(curadorId, (tx) =>
        leerJourneysCompletos(tx, wsC, [a.journeyId, b.journeyId]),
      );

      expect(lote.length).toBe(2);
      const porId = new Map(lote.map((g) => [g.id, g]));
      // Igualdad ESTRUCTURAL, no por id: un orden distinto en los nodos o en las aristas es
      // una huella distinta, y `toEqual` sobre el objeto entero es lo que lo dice.
      expect(porId.get(a.journeyId)).toEqual(sueltos.a);
      expect(porId.get(b.journeyId)).toEqual(sueltos.b);
      // Y la huella que de verdad se compara sale igual: es el uso, no la forma.
      expect(sueltos.a!.nodos.length).toBeGreaterThan(0);
    });
  });

  it('la cola de C5 solo ofrece journeys con señales abiertas, como dice su rótulo', async () => {
    await enWorkspaceLimpio('c5-cola-honesta', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const sucio = await nuevoJourney({ ...ctx, actorId: curadorId });
      const limpio = await nuevoJourney({ ...ctx, actorId: curadorId }, { limpio: true });
      // El fixture tiene que cumplir lo que promete, y se le pregunta a la función.
      expect(await senalesDe(curadorId, wsC, limpio.journeyId)).toEqual([]);
      expect((await senalesDe(curadorId, wsC, sucio.journeyId)).length).toBeGreaterThan(0);

      const panel = await panelPropuestas(curadorId, wsC);
      const cola = panel.candidatas.C5.lista.map((c) => c.id);
      expect(cola).toContain(sucio.journeyId);
      expect(cola, 'un journey sin señales se ofrece y luego se rechaza').not.toContain(
        limpio.journeyId,
      );
    });
  });

  /**
   * Dos contradicciones sobre la MISMA evidencia se rechazan al parsear.
   *
   * `contradiccion` tiene `unique (insight_id, evidencia_id)`, así que ese contenido se
   * persistía, se enseñaba, se revisaba… y su aceptación fallaba SIEMPRE en el segundo insert.
   * Quien revisa se quedaba con una propuesta que solo podía rechazar y sin manera de saber
   * por qué —el formulario no edita las contradicciones—, con la llamada ya pagada. Se corta
   * en el contrato, que es donde se puede decir el motivo.
   */
  it('un insight con dos contradicciones sobre la misma evidencia no llega a nacer', async () => {
    await enWorkspaceLimpio('c2-contradicciones-repetidas', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido = {
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ evidenciaId: ev, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' }],
          },
        ],
        contradicciones: [
          { evidenciaId: ev, descripcion: 'Va en contra por un lado' },
          { evidenciaId: ev, descripcion: 'Y también por otro' },
        ],
        confianzaPropuesta: 'media',
      };
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
          ).rejects.toThrow(/no cumplió el esquema/);
        },
      );
      const quedan = await conUsuario(curadorId, (tx) => tx`
        select count(*)::int as n from propuesta_ai where workspace_id = ${wsC}`);
      expect(quedan[0]!.n).toBe(0);
    });
  });

  /**
   * Y las CONTRADICCIONES no se corrigen, por lo mismo que las citas y por una razón propia.
   *
   * Son la otra mitad contrastable de la salida de C2 —señalan un documento por su id— y son,
   * además, la evidencia que va EN CONTRA. I4 pide señalarla precisamente porque esconderla es
   * la manera más limpia de vender una conclusión, así que dejar que quien revisa la reescriba
   * al «corregir» sería devolverle esa manera con otro nombre.
   *
   * Y cerraba un agujero de alcance: nada comprobaba que la evidencia nueva fuera del reto
   * —`contradiccion` solo lleva la FK del tenant—, así que una corrección podía apuntar a
   * cualquiera del workspace y la aceptación la materializaba.
   */
  it('las contradicciones de un insight no se corrigen', async () => {
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'C2',
      anclas: { reto_id: retoId },
      contenido: {
        ...CONTENIDO_C2(evidenciaDelRetoId),
        contradicciones: [
          { evidenciaId: evidenciaDelRetoId, descripcion: 'La encuesta apunta a otra cosa' },
        ],
      },
    });
    const original = {
      ...CONTENIDO_C2(evidenciaDelRetoId),
      contradicciones: [
        { evidenciaId: evidenciaDelRetoId, descripcion: 'La encuesta apunta a otra cosa' },
      ],
    };
    /*
     * Por su SALIDA, no solo por el asunto. La regla vive en dos capas —el servicio y el guard
     * de la base— y las dos dicen lo mismo, así que una sonda que mire «contradicciones … no
     * se corrigen» pasa con cualquiera de las dos apagada. La clase tampoco separa: medido,
     * `aceptarPropuesta` traduce CUALQUIER P0001 a `ErrorAI`, así que el rechazo del suelo
     * también llega como error de dominio (lo cual es correcto y es lo que esa traducción
     * existe para dar).
     *
     * Lo que sí las separa es la SALIDA que ofrece el mensaje: la del servicio dice qué hacer
     * con la propuesta, y la del guard no puede —una restricción de la base no sabe que hay
     * una pantalla de revisión al otro lado—. El suelo tiene su propia sonda más abajo.
     */
    await expect(
      aceptarPropuesta(leadId, {
        workspaceId: ws,
        propuestaId,
        correccion: { ...original, contradicciones: [] },
      }),
    ).rejects.toThrow(/no se corrigen[^]*rechaza el insight/i);

    // Y el suelo, con la conexión de administración por lo mismo que el de las citas: el rol
    // de aplicación no llega a este guard —su política de UPDATE exige estado decidido,
    // revisor y fecha—, así que lo que este caso puede afirmar es que el trigger está debajo.
    const admin = sqlAdmin();
    await expect(
      admin`update propuesta_ai
        set contenido = ${admin.json({ ...original, contradicciones: [] })}
        where id = ${propuestaId} and workspace_id = ${ws}`,
    ).rejects.toThrow(/contradicciones .* no se corrigen/i);
  });

  /**
   * Evidencia sin derechos vigentes NO llega al prompt, ni ofrece el reto, ni se cita.
   *
   * `evidencia_citable_guard` exige derechos concedidos de ámbito cliente para escribir una
   * `cita` (SPEC-03/SYS-14). Enseñarle al modelo un documento sin ellos es pedirle que cite lo
   * que la aceptación va a rechazar — y no al pedirlo: después de pagar la llamada Y de que
   * alguien revise el insight, dejando una propuesta que solo se puede tirar.
   *
   * El mismo predicado que impone la escritura, aplicado antes de gastar, en los cuatro sitios
   * que miran esa evidencia. Aquí se comprueban los dos extremos: con el reto SOLO con
   * evidencia bloqueada no se ofrece ni se genera, y desbloqueándola vuelve entera.
   */
  it('la evidencia sin derechos vigentes no se ofrece a C2 ni entra en su material', async () => {
    await enWorkspaceLimpio('c2-sin-derechos', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Entrevista sin permiso',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      await admin`update derecho_uso set estado = 'pendiente', ambito = 'interno', base = '',
          decidido_por = null, decidido_en = null
        where evidencia_id = ${ev} and workspace_id = ${wsC}`;
      expect(
        (await admin`select evidencia_usable(${ev}::uuid, ${wsC}::uuid, 'cliente') as x`)[0]!.x,
      ).toBe(false);

      // Ni se ofrece…
      const panel = await panelPropuestas(curadorId, wsC);
      expect(panel.candidatas.C2.lista.some((c) => c.id === retoC)).toBe(false);

      // …ni se gasta forzándolo. Se mide por el LIBRO: negarse después de pagar sería el mismo
      // defecto con mejor cara.
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      await conProveedor(
        { ok: true, datos: { insights: [] }, intentos: [intento({ uso: null })] },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
          ).rejects.toThrow(/derechos de uso vigentes/);
        },
      );
      const [tras] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(tras!.n).toBe(antes!.n);

      // Y con los derechos repuestos vuelve entera: lo que cierra la puerta son los derechos,
      // no el enlace — sin esta mitad, un filtro que dejara el reto fuera para siempre pasaría.
      await admin`update derecho_uso set estado = 'concedido', ambito = 'cliente',
          base = 'Consentimiento renovado', decidido_por = ${curadorId}, decidido_en = now()
        where evidencia_id = ${ev} and workspace_id = ${wsC}`;
      const repuesto = await panelPropuestas(curadorId, wsC);
      expect(repuesto.candidatas.C2.lista.some((c) => c.id === retoC)).toBe(true);
    });
  });

  /**
   * El pajar de una cita es SU documento y nada más — ni la formulación del reto.
   *
   * La primera versión de este arreglo componía el pajar por evidencia con `materialDeInsights`,
   * que lleva delante la ficha del reto y su descripción. Así, una cita que decía «esto está en
   * la evidencia B» y en realidad copiaba la DESCRIPCIÓN DEL RETO salía presente contra
   * cualquier evidencia: el mismo falso verde, una capa más adentro. El pajar es el documento
   * que la cita nombra.
   */
  it('una cita que copia la formulación del reto no cuenta como presente en una evidencia', async () => {
    await enWorkspaceLimpio('c2-pajar-estricto', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      await admin`update reto
        set descripcion = 'Los clientes abandonan la verificación de identidad antes de terminarla.'
        where id = ${retoC}`;
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Analítica del funnel',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });

      const contenido: ContenidoInsight = {
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [
              // De la evidencia: presente.
              { evidenciaId: ev, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' },
              // De la DESCRIPCIÓN DEL RETO, atribuida a la evidencia: ausente. El fragmento
              // existe en el material del prompt —por eso el caso mide algo— pero no en el
              // documento que la cita nombra.
              {
                evidenciaId: ev,
                fragmento: 'abandonan la verificación de identidad',
                localizacion: 'resumen',
              },
            ],
          },
        ],
        contradicciones: [],
        confianzaPropuesta: 'media',
      };
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      expect(p.citas.map((c) => c.presenteLiteral)).toEqual([true, false]);
      // Y el panel dice cómo se llama el documento contra el que se midió, no solo su uuid.
      expect(p.etiquetas[ev]).toBe('Analítica del funnel');
    });
  });
  /**
   * Un informe que deja señales SIN remediar se descarta entero.
   *
   * La comprobación miraba que ninguna remediación fuera inventada, y eso deja pasar tres
   * cosas distintas que se pagan igual: la lista vacía, la que se salta señales y la que
   * repite una con dos consejos. La segunda es la peor de leer, porque no parece rota: quien
   * la lee cree que el grafo tiene menos averías de las que tiene, y el informe se ve
   * completo. El contrato pide una por señal, así que se comprueba la igualdad.
   */
  it('un informe que no cubre todas las señales se descarta, y se dice cuántas faltan', async () => {
    await enWorkspaceLimpio('c5-informe-corto', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      expect(senales.length).toBeGreaterThan(1);

      // Le falta la última: el informe se ve entero y no lo está.
      const corto = informeCompleto(senales.slice(0, -1));
      await conProveedor(
        {
          ok: true,
          datos: corto as unknown as Record<string, unknown>,
          intentos: [intento({ uso: null })],
        },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
          ).rejects.toThrow(/sin remediar/);
        },
      );

      // Y el que REPITE una señal también: dos consejos para la misma avería es una
      // contradicción sin criterio para elegir.
      const repetido = informeCompleto([...senales, senales[0]!]);
      await conProveedor(
        {
          ok: true,
          datos: repetido as unknown as Record<string, unknown>,
          intentos: [intento({ uso: null })],
        },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
          ).rejects.toThrow(/dos remediaciones para la misma señal/);
        },
      );

      const quedan = await conUsuario(curadorId, (tx) => tx`
        select count(*)::int as n from propuesta_ai
        where workspace_id = ${wsC} and journey_id = ${j.journeyId}`);
      expect(quedan[0]!.n).toBe(0);

      /*
       * Y EL LIBRO LO DICE. La comprobación semántica corría dentro de la transacción que
       * persiste, o sea DESPUÉS de que la línea se cerrara como `salida-valida`: el libro
       * afirmaba que esa llamada produjo una salida válida, no nacía propuesta, y el evento
       * `LlamadaAISinPropuesta` no salía —su trigger mira el tránsito desde `despachada`—.
       * Las respuestas de C5 fuera de contrato quedaban sistemáticamente sin contar.
       *
       * Y no se puede arreglar después: `llamada_completar` lleva
       * `using (resultado = 'despachada')`, así que una línea cerrada no la toca la
       * aplicación. La única manera de que el libro diga la verdad es preguntar antes.
       */
      const lineas = await sqlAdmin()`select resultado, motivo from llamada_ai
        where workspace_id = ${wsC} and journey_id = ${j.journeyId}
        order by creado_en desc, id desc`;
      expect(lineas.length).toBeGreaterThan(0);
      expect(
        lineas.map((l) => l.resultado as string),
        'el libro anota como salida válida una respuesta que se descartó',
      ).toEqual(lineas.map(() => 'fuera-de-contrato'));
      expect(lineas[0]!.motivo as string).toMatch(/dos remediaciones para la misma señal/);

      const eventos = await sqlAdmin()`select count(*)::int as n from evento_dominio
        where workspace_id = ${wsC} and tipo = 'LlamadaAISinPropuesta'`;
      expect(eventos[0]!.n, 'nadie registra que esa llamada no dejó propuesta').toBe(
        lineas.length,
      );
    });
  });

  /**
   * La aceptación no puede omitir ni cambiar las CONTRADICCIONES.
   *
   * El guard de materialización comprobaba la cabecera, las afirmaciones y sus citas, y dejaba
   * fuera las contradicciones: con los grants que la aplicación tiene, quien escriba por SQL
   * podía omitirlas y sellar la propuesta como aceptada igual. Y son justo la parte que más
   * tienta omitir —la evidencia que va EN CONTRA—, así que el hueco estaba donde más importa.
   *
   * Se prueba por el camino que el hueco permitía: aceptar de verdad y borrar las
   * contradicciones DENTRO de la misma transacción es imposible desde el servicio, así que se
   * mide el guard sobre la fila ya materializada — borrar una contradicción y volver a sellar.
   */
  it('un insight materializado sin sus contradicciones no se puede sellar', async () => {
    await enWorkspaceLimpio('c2-contradicciones-selladas', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido: ContenidoInsight = {
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ evidenciaId: ev, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' }],
          },
        ],
        contradicciones: [{ evidenciaId: ev, descripcion: 'Va en contra por esto' }],
        confianzaPropuesta: 'media',
      };
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      const { objetoId } = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: p.id,
      });
      // La aceptación buena las materializó: sin esto, el caso de abajo podría estar pasando
      // porque no hay contradicciones que comprobar.
      const [hay] = await admin`select count(*)::int as n from contradiccion
        where insight_id = ${objetoId}`;
      expect(hay!.n).toBe(1);

      // Y ahora el guard, sobre una segunda propuesta a la que le falta la contradicción que
      // dice tener. Se fuerza el sello por SQL, que es lo que el hueco permitía.
      const [otra] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C2', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const [prop] = await conUsuario(curadorId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
           confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key, llamada_id, creado_por)
        values (${wsC}, 'C2', 'insight', ${retoC}, ${tx.json(contenido)}, ${tx.json(contenido)},
                0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'alcance', 'huella-del-material', ${ALCANCE_DEL_RETO(tx, wsC, retoC)}, 'entorno',
                ${otra!.id as string}, ${curadorId})
        returning id`);
      await expect(
        conUsuario(curadorId, async (tx) => {
          // La cabecera coincide con el contenido CORREGIDO: si no, el guard se para antes en
          // la paridad del título y este caso mediría esa regla en vez de la de abajo.
          const [ins] = await tx`insert into insight
            (workspace_id, titulo, resumen, estado, creado_por)
            values (${wsC}, 'T corregido', 'R', 'propuesto', ${curadorId}) returning id`;
          const [af] = await tx`insert into afirmacion
            (workspace_id, insight_id, orden, texto, es_hipotesis)
            values (${wsC}, ${ins!.id as string}, 0, 'A', false) returning id`;
          await tx`insert into cita
            (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
            values (${wsC}, ${af!.id as string}, ${ev}, 'El 71% de los abandonos', 'resumen',
                    ${curadorId})`;
          // …y NINGUNA contradicción, aunque el contenido declara una.
          // Sin `revisada_en`: no hay grant para esa columna —la escribe el guard de revisión—
          // y escribirla muere antes con «permission denied», que mediría otra cosa.
          await tx`update propuesta_ai
            set estado = 'corregida', revisada_por = ${curadorId},
                insight_id = ${ins!.id as string},
                contenido = ${tx.json({ ...contenido, titulo: 'T corregido' })}
            where id = ${prop!.id as string} and workspace_id = ${wsC}`;
        }),
      ).rejects.toThrow(/contradicciones del insight materializado/);
    });
  });

  /**
   * Y el ÚLTIMO instante: aceptar. Tercer punto de la misma línea de tiempo.
   *
   * Entre que la propuesta se guarda y que alguien la acepta pasan horas o días, y en ese
   * hueco se enlaza evidencia nueva al reto. La pantalla ya lo dice —la presencia literal pasa
   * a «no se puede comprobar»—, pero la propuesta sigue `disponible` y la aceptación sella
   * igual: un insight que nunca vio ese documento, que en C2 puede ser justo el que lo
   * CONTRADICE.
   *
   * Y quien revisa NO puede compensarlo. Las contradicciones son inmutables desde una ronda
   * anterior de este mismo PR —para que nadie pueda quitarlas al corregir—, y esa decisión,
   * que protege la señal, quita aquí la salida de añadir a mano la que falta. Por eso el
   * desenlace correcto es rechazar la propuesta y volver a pedirla, no dejar que se selle.
   *
   * Se comprueba por el CONJUNTO de ids y no por la huella: la huella es de un texto con
   * formato y recorte, y no hay SQL que lo reconstruya —escribirlo dos veces sería la
   * divergencia entre redacciones hermanas que este PR ya corrigió varias veces—. El conjunto
   * sí, y responde a la pregunta que importa: ¿había, al sellar, evidencia del reto que el
   * insight no llegó a ver?
   *
   * La sonda va por SQL DIRECTO en las dos mitades: escribe la propuesta y la acepta por la
   * superficie concedida. Lo que se afirma es que el SUELO aguanta, no que el servicio se
   * porte bien.
   */
  it('una evidencia enlazada tras generar impide sellar el insight', async () => {
    await enWorkspaceLimpio('c2-enlace-antes-de-aceptar', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido = CONTENIDO_C2(ev);
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C2', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const [pr] = await conUsuario(curadorId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
           confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key,
           llamada_id, creado_por)
        values (${wsC}, 'C2', 'insight', ${retoC}, ${tx.json(contenido as never)},
                ${tx.json(contenido as never)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                'alcance', 'huella', ${ALCANCE_DEL_RETO(tx, wsC, retoC)}, 'entorno',
                ${l!.id as string}, ${curadorId})
        returning id`);
      const propuestaId = pr!.id as string;

      // …y AHORA se enlaza al reto un documento que la propuesta no pudo ver.
      const [arqNuevo] = await admin`insert into arquetipo
        (workspace_id, reto_id, nombre, definicion, creado_por)
        values (${wsC}, ${retoC}, 'Arquetipo tardío', 'Definición', ${curadorId}) returning id`;
      const [fte] = await admin`insert into fuente
        (workspace_id, tipo, titulo, referencia, creado_por)
        values (${wsC}, 'documento', 'La contradicción', 'ref', ${curadorId}) returning id`;
      const [ev2] = await admin`insert into evidencia
        (workspace_id, fuente_id, titulo, resumen, dimensiones, creado_por)
        values (${wsC}, ${fte!.id as string}, 'La contradicción',
                'En cambio el 12% dice que el documento nunca fue el problema.', '{}'::jsonb,
                ${curadorId}) returning id`;
      await admin`insert into derecho_uso
        (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
        values (${wsC}, ${ev2!.id as string}, 'concedido', 'cliente', 'Consentimiento',
                ${curadorId}, now(), ${curadorId})`;
      await admin`insert into arquetipo_evidencia (workspace_id, arquetipo_id, evidencia_id)
        values (${wsC}, ${arqNuevo!.id as string}, ${ev2!.id as string})`;

      // Sellar por la superficie SQL concedida, que es el escritor que este suelo cierra.
      await expect(
        conUsuario(curadorId, async (tx) => {
          const [ins] = await tx`insert into insight
            (workspace_id, titulo, resumen, estado, creado_por)
            values (${wsC}, ${contenido.titulo}, ${contenido.resumen}, 'propuesto', ${curadorId})
            returning id`;
          const [af] = await tx`insert into afirmacion
            (workspace_id, insight_id, orden, texto, es_hipotesis)
            values (${wsC}, ${ins!.id as string}, 0, ${contenido.afirmaciones[0]!.texto}, false)
            returning id`;
          await tx`insert into cita
            (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
            values (${wsC}, ${af!.id as string}, ${ev},
                    ${contenido.afirmaciones[0]!.citas[0]!.fragmento},
                    ${contenido.afirmaciones[0]!.citas[0]!.localizacion}, ${curadorId})`;
          // `CONTENIDO_C2` no declara contradicciones, así que no se insertan: el guard las
          // compara en los dos sentidos y una de más lo pararía por otra regla — que es
          // exactamente el error de medición que hay que evitar aquí.
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${curadorId}, insight_id = ${ins!.id as string}
            where id = ${propuestaId} and workspace_id = ${wsC}`;
        }),
      ).rejects.toThrow(/no llegaron a ver/);

      // Y la propuesta sigue donde estaba: viva, para rechazarla o rehacerla.
      const [p] = await admin`select estado from propuesta_ai where id = ${propuestaId}`;
      expect(p!.estado).toBe('propuesta');
    });
  });

  /**
   * Y tampoco deja nacer una propuesta que va a morir: el guard del INSERT también espera.
   *
   * El barrido de citas lee el derecho vigente al persistir, y eso cierra la ventana ancha. La
   * fina no: una revocación en vuelo no la ve ese snapshot, así que nace una propuesta que
   * llega al panel ya `evidencia-no-citable` y que aceptar rechazará SIEMPRE con DR001 — con
   * la llamada pagada y alguien delante intentando revisarla.
   *
   * Mismo protocolo que los otros dos sitios: `for share` sobre las filas de `derecho_uso` de
   * la evidencia del reto, antes de leerlas.
   */
  it('una revocación en vuelo impide que nazca una propuesta ya muerta', async () => {
    await enWorkspaceLimpio('c2-revocacion-al-persistir', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C2', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;

      const revocacion = await candadoEnVuelo((tx) => tx`update derecho_uso
          set estado = 'denegado', ambito = 'interno', base = 'El participante retiró el permiso',
              decidido_por = ${curadorId}, decidido_en = now()
          where evidencia_id = ${ev} and workspace_id = ${wsC}`);

      const persistencia = conUsuario(curadorId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
           confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key,
           llamada_id, creado_por)
        values (${wsC}, 'C2', 'insight', ${retoC}, ${tx.json(CONTENIDO_C2(ev) as never)},
                ${tx.json(CONTENIDO_C2(ev) as never)}, 0.6, ${MODELO_PRIMARIO},
                ${PROMPT_VERSION}, 'alcance', 'huella', ${ALCANCE_DEL_RETO(tx, wsC, retoC)}, 'entorno', ${l!.id as string},
                ${curadorId})`);
      const veredicto = persistencia.then(
        () => 'nació',
        (e: Error) => `rechazó: ${e.message}`,
      );

      await revocacion.esperaAQueAlguienEspere();
      revocacion.soltar();
      await revocacion.terminado;

      expect(
        await veredicto,
        'nació una propuesta que la aceptación va a rechazar siempre con DR001',
      ).toMatch(/ya no se puede citar al cliente/);

      const filas = await admin`select 1 from propuesta_ai
        where workspace_id = ${wsC} and capacidad = 'C2'`;
      expect(filas.length).toBe(0);
    });
  }, 20000);

  /**
   * Y el ARCHIVO en vuelo tampoco deja nacer la propuesta. Quinto sitio de la misma familia.
   *
   * El guard del INSERT ya preguntaba por el archivo del reto —eso cierra la ventana ancha—,
   * y lo preguntaba con un `exists` a secas. Un archivado EN VUELO no lo ve ese snapshot: la
   * lectura devuelve la versión activa anterior sin esperar, y la clave ajena de la propuesta
   * NO ordena nada, porque `estado` no es columna de clave y el UPDATE que archiva solo toma
   * `for no key update`. La propuesta commitea después del archivo y nace ya
   * `reto-archivado`: visible en el panel, imposible de aceptar, con la llamada pagada.
   *
   * El candado va además ANTES que el de `derecho_uso`, y eso no es cosmético: el trigger de
   * las citas de C2 dispara primero (`a_propuesta_ai_c2_citas` ordena antes que
   * `propuesta_ai_revision`) y ya tomaba los derechos, así que sin el reto por delante esta
   * ruta pedía los dos candados al revés que todas las demás.
   */
  it('un archivado en vuelo impide que nazca una propuesta sobre un reto cerrado', async () => {
    await enWorkspaceLimpio('c2-archivado-al-persistir', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C2', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;

      const archivado = await candadoEnVuelo((tx) => tx`update reto set estado = 'archivado'
          where id = ${retoC} and workspace_id = ${wsC}`);

      const persistencia = conUsuario(curadorId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
           confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key,
           llamada_id, creado_por)
        values (${wsC}, 'C2', 'insight', ${retoC}, ${tx.json(CONTENIDO_C2(ev) as never)},
                ${tx.json(CONTENIDO_C2(ev) as never)}, 0.6, ${MODELO_PRIMARIO},
                ${PROMPT_VERSION}, 'alcance', 'huella', ${ALCANCE_DEL_RETO(tx, wsC, retoC)}, 'entorno', ${l!.id as string},
                ${curadorId})`);
      const veredicto = persistencia.then(
        () => 'nació',
        (e: Error) => `rechazó: ${e.message}`,
      );

      await archivado.esperaAQueAlguienEspere();
      archivado.soltar();
      await archivado.terminado;

      expect(
        await veredicto,
        'nació una propuesta sobre un reto que se estaba archivando',
      ).toMatch(/archivado/);

      const filas = await admin`select 1 from propuesta_ai
        where workspace_id = ${wsC} and capacidad = 'C2'`;
      expect(filas.length).toBe(0);
    });
  }, 20000);

  /**
   * Y no es solo cosa de C2: la misma carrera con C0, que es la que MIDE el candado del guard
   * del INSERT.
   *
   * Medido, y conviene dejarlo escrito porque cambia lo que demuestra cada sonda: con una
   * propuesta de C2, quitar CUALQUIERA de los dos candados por separado deja la prueba en
   * verde — el guard de las citas de C2 dispara antes y toma el mismo `for share` sobre la
   * misma fila, así que se tapan el uno al otro. Solo quitando los dos a la vez nace la
   * propuesta. Es decir: la sonda de C2 mide «hay candado en esta ruta», no cuál.
   *
   * `propuesta_ai_c2_citas_guard` se va por la puerta de atrás en cuanto la capacidad no es
   * C2 (`if new.capacidad <> 'C2' then return new`), y C0 y CT también cuelgan del reto. Para
   * ellas el único candado es el del guard del INSERT, así que esta es la sonda que se apaga
   * sola en rojo cuando se le quita.
   */
  it('el archivado en vuelo también ordena una propuesta de C0, que no pasa por el guard de citas', async () => {
    await enWorkspaceLimpio('c0-archivado-al-persistir', async ({ ws: wsD, curadorId, retoId: retoD }) => {
      const admin = sqlAdmin();
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsD}, 'C0', ${retoD}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;

      const archivado = await candadoEnVuelo((tx) => tx`update reto set estado = 'archivado'
          where id = ${retoD} and workspace_id = ${wsD}`);

      const persistencia = conUsuario(curadorId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
           modelo, prompt_version, alcance_resumen, origen_key, llamada_id, creado_por)
        values (${wsD}, 'C0', 'criterio-exito', ${retoD}, ${tx.json(CONTENIDO_C0)},
                ${tx.json(CONTENIDO_C0)}, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                'alcance', 'entorno', ${l!.id as string}, ${curadorId})`);
      const veredicto = persistencia.then(
        () => 'nació',
        (e: Error) => `rechazó: ${e.message}`,
      );

      await archivado.esperaAQueAlguienEspere();
      archivado.soltar();
      await archivado.terminado;

      expect(
        await veredicto,
        'nació una propuesta de C0 sobre un reto que se estaba archivando',
      ).toMatch(/archivado/);

      const filas = await admin`select 1 from propuesta_ai
        where workspace_id = ${wsD} and capacidad = 'C0'`;
      expect(filas.length).toBe(0);
    });
  }, 20000);

  /**
   * Y lo que el registry YA MEDÍA también caduca en vuelo, por las dos puertas.
   *
   * El prompt de C6 lleva dos cosas de naturaleza distinta: el MATERIAL —el reto y sus
   * criterios, aquello contra lo que se propone— y el estado del CONTRATO —lo que ya se mide,
   * para no repetirlo—. La huella del material ya se comprobaba antes de despachar y antes de
   * guardar; la otra mitad no se comprobaba en ninguna de las dos, así que una `entrada_kpi`
   * añadida en ese rato dejaba al lote proponiéndola otra vez. Y ese duplicado, si es un
   * SINÓNIMO y no el mismo nombre, no lo detecta nadie: `nombre-ocupado` compara nombres.
   *
   * La huella de las entradas va APARTE de `huella_material` y, sobre todo, NO se persiste —y
   * eso no es una omisión, es lo que la hace segura—. Aceptar una fila del lote inserta una
   * entrada, así que las entradas cambian fila a fila: una huella guardada y comprobada al
   * aceptar dejaría a la segunda fila sin poder aceptarse en cuanto se acepta la primera. La
   * tercera mitad de esta sonda es justamente ésa.
   */
  it('C6: una entrada añadida en vuelo para el lote, y aceptar una fila no tumba a su hermana', async () => {
    await enWorkspaceLimpio('c6-entradas-en-vuelo', async ({ ws: wsV, curadorId, retoId: retoV }) => {
      const admin = sqlAdmin();
      const [crit] = await admin`insert into criterio_exito
        (workspace_id, reto_id, kpi, definicion, objetivo, ventana_dias, linea_base_plan,
         creado_por)
        values (${wsV}, ${retoV}, 'Tiempo de verificación', 'Definición', 'Objetivo', 30, 'Plan',
                ${curadorId}) returning id`;
      const criterioV = crit!.id as string;
      const [mr] = await admin`insert into metric_registry (workspace_id, reto_id, creado_por)
        values (${wsV}, ${retoV}, ${curadorId}) returning id`;
      const registryV = mr!.id as string;

      // Una entrada que el prompt SÍ verá: el lote nace sabiendo que existe.
      const entrar = (nombre: string) => admin`insert into entrada_kpi
        (workspace_id, registry_id, criterio_id, nombre, definicion, frecuencia, creado_por)
        values (${wsV}, ${registryV}, ${criterioV}, ${nombre}, 'Definición previa', 'mensual',
                ${curadorId})`;
      await entrar('Minutos de verificación');

      const RESPUESTA_C6 = {
        ok: true as const,
        datos: {
          entradas: [
            { ...CONTENIDO_C6(criterioV), nombre: 'Tasa en móvil' },
            { ...CONTENIDO_C6(criterioV), nombre: 'Tasa en tableta' },
          ],
        },
        intentos: [intento({ modelo: MODELO_PRIMARIO, latenciaMs: 12, uso: null })],
      };
      const pedirLote = () =>
        generarPropuestas(curadorId, { workspaceId: wsV, capacidad: 'C6', anclaId: registryV });

      // ── 1. Añadida ANTES del despacho: no se llama al proveedor ──
      let despachos = 0;
      await conProveedor(RESPUESTA_C6, async () => {
        proveedor.antesDelApunte = async () => {
          await entrar('Abandono en la carga');
        };
        proveedor.duranteLlamada = async () => {
          despachos += 1;
        };
        try {
          await expect(pedirLote()).rejects.toThrow(/entradas de ese Metric Registry cambiaron/i);
        } finally {
          proveedor.antesDelApunte = null;
          proveedor.duranteLlamada = null;
        }
      });
      expect(despachos, 'el material salió hacia el proveedor con el contrato ya movido').toBe(0);
      expect(
        (await admin`select 1 as x from llamada_ai where workspace_id = ${wsV}`).length,
        'se abrió línea de gasto para una llamada que no ocurrió',
      ).toBe(0);

      // ── 2. Añadida EN VUELO: la llamada se paga, pero el lote no se guarda ──
      await conProveedor(RESPUESTA_C6, async () => {
        proveedor.duranteLlamada = async () => {
          await entrar('Reintentos por expediente');
        };
        try {
          await expect(pedirLote()).rejects.toThrow(/entradas de ese Metric Registry cambiaron/i);
        } finally {
          proveedor.duranteLlamada = null;
        }
      });
      expect(
        (await admin`select 1 as x from propuesta_ai where workspace_id = ${wsV}`).length,
        'se guardó un lote armado sin saber lo que el registry ya medía',
      ).toBe(0);

      // ── 3. Y la mitad que sostiene la decisión de no persistir esa huella ──
      // Sin nada moviéndose, el lote nace; y ACEPTAR la primera fila —que crea una entrada, o
      // sea que mueve las entradas— tiene que dejar aceptable a la segunda. Sin esto, todo lo
      // de arriba podría estar escrito comprobando la huella también al aceptar, y el lote
      // sería irrevisable a partir de la primera fila.
      await conProveedor(RESPUESTA_C6, pedirLote);
      const pendientes = await admin`select id from propuesta_ai
        where workspace_id = ${wsV} and estado = 'propuesta' order by creado_en asc, id asc`;
      expect(pendientes.length).toBe(2);
      for (const fila of pendientes) {
        const r = await aceptarPropuesta(curadorId, {
          workspaceId: wsV,
          propuestaId: fila.id as string,
        });
        expect(r.estado).toBe('aceptada');
      }
      const nombres = await admin`select nombre from entrada_kpi
        where workspace_id = ${wsV} and registry_id = ${registryV} order by nombre asc`;
      expect(nombres.map((n) => n.nombre as string)).toContain('Tasa en móvil');
      expect(nombres.map((n) => n.nombre as string)).toContain('Tasa en tableta');
    });
  }, 30000);

  /**
   * Y el archivado en vuelo también ordena una propuesta de C6, cuyo reto vive DETRÁS del
   * registry.
   *
   * `propuesta_ai_un_ancla` deja `reto_id` nulo cuando el ancla es el registry, así que el
   * guard del INSERT preguntaba por una columna vacía y se saltaba el candado entero: ni la
   * clave de aviso del reto, ni el `for share` sobre su fila. Y el estado del reto sí decide
   * aquí, porque `registry_admite_entradas` lo mira por dentro. Medido contra la base: con un
   * archivado en vuelo la propuesta de C6 NACE —no espera a nadie— y queda en el panel
   * imposible de aceptar, con la llamada ya pagada. Es exactamente lo que las dos sondas de
   * arriba impiden para el ancla que sí es un reto.
   *
   * El reto se resuelve por `metric_registry.reto_id`, que es la relación de verdad; copiarlo
   * en la propuesta sería un segundo sitio donde puede decir otra cosa.
   */
  it('el archivado en vuelo también ordena una propuesta de C6, anclada en el registry', async () => {
    await enWorkspaceLimpio('c6-archivado-al-persistir', async ({ ws: wsE, curadorId, retoId: retoE }) => {
      const admin = sqlAdmin();
      const [crit] = await admin`insert into criterio_exito
        (workspace_id, reto_id, kpi, definicion, objetivo, ventana_dias, linea_base_plan,
         creado_por)
        values (${wsE}, ${retoE}, 'KPI', 'Definición', 'Objetivo', 30, 'Plan', ${curadorId})
        returning id`;
      const [mr] = await admin`insert into metric_registry (workspace_id, reto_id, creado_por)
        values (${wsE}, ${retoE}, ${curadorId}) returning id`;
      const registryE = mr!.id as string;
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, registry_id, modelo, origen_key, resultado, creado_por)
        values (${wsE}, 'C6', ${registryE}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const contenido = CONTENIDO_C6(crit!.id as string);

      const archivado = await candadoEnVuelo((tx) => tx`update reto set estado = 'archivado'
          where id = ${retoE} and workspace_id = ${wsE}`);

      const persistencia = conUsuario(curadorId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, registry_id, contenido, contenido_original,
           confianza, modelo, prompt_version, alcance_resumen, huella_material, origen_key,
           llamada_id, creado_por)
        values (${wsE}, 'C6', 'entrada-kpi', ${registryE}, ${tx.json(contenido as never)},
                ${tx.json(contenido as never)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                'alcance', 'huella', 'entorno', ${l!.id as string}, ${curadorId})`);
      const veredicto = persistencia.then(
        () => 'nació',
        (e: Error) => `rechazó: ${e.message}`,
      );

      await archivado.esperaAQueAlguienEspere();
      archivado.soltar();
      await archivado.terminado;

      expect(
        await veredicto,
        'nació una propuesta de C6 sobre un reto que se estaba archivando',
      ).toMatch(/archivado/);
      const filas = await admin`select 1 from propuesta_ai
        where workspace_id = ${wsE} and capacidad = 'C6'`;
      expect(filas.length).toBe(0);
    });
  }, 20000);

  /**
   * Y el ORDEN de los dos candados, leído del catálogo.
   *
   * Que el reto se bloquee en algún sitio no basta: donde el conjunto de `derecho_uso` que se
   * bloquea SE DERIVA del reto, el reto tiene que bloquearse ANTES. Es el mismo argumento por
   * el que `razonamiento_usable_guard` bloquea las decisiones antes que los derechos que salen
   * de ellas —bloquear el resultado sin bloquear la fuente deja el fantasma abierto— y es
   * además lo que mantiene UN solo orden: el guard de las citas de C2 dispara antes que el del
   * INSERT (`a_propuesta_ai_c2_citas` ordena por nombre delante de `propuesta_ai_revision`), así
   * que sin su propio candado del reto esa ruta pedía los dos al revés que el guard diferido,
   * que la revalidación previa al despacho y que `bloquearReto`. Dos órdenes distintos sobre el
   * mismo par de tablas es la definición de un abrazo mortal esperando a que coincidan.
   *
   * No se prueba provocando el interbloqueo —una prueba cuyo verde dependa de ganar una carrera
   * no prueba nada—, sino leyendo el cuerpo de cada función de `pg_proc`, que es lo que de
   * verdad corre y no lo que dice el fichero de la migración.
   *
   * El candado del reto vale en sus DOS formas, porque las dos existen en este esquema: la fila
   * (`from reto … for share`) y el advisory por clave (`designio:reto:…`, que es el que toma
   * `gate_aprobar_suficiencia_guard`). Exigir solo la primera daría rojo sobre una función que
   * respeta el protocolo, y eso enseña a ignorar la prueba.
   */
  it('donde los derechos bloqueados salen del reto, el reto se bloquea primero', async () => {
    const admin = sqlAdmin();
    const funciones = await admin<{ proname: string; prosrc: string }[]>`
      select p.proname, p.prosrc
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosrc like '%for share%'
       order by p.proname`;

    const bloqueDerechos = (src: string) => /\bfrom\s+derecho_uso\b[\s\S]*?for share/.exec(src);
    const candadoDelReto = (src: string) => {
      const fila = /\bfrom\s+reto\b[\s\S]*?for share/.exec(src);
      const advisory = /pg_advisory_xact_lock\([^)]*designio:reto:/.exec(src);
      const posiciones = [fila?.index, advisory?.index].filter((x): x is number => x !== undefined);
      return posiciones.length ? Math.min(...posiciones) : -1;
    };

    const derivadasDelReto: string[] = [];
    const sinCandadoDelReto: string[] = [];
    const invertidas: string[] = [];
    for (const f of funciones) {
      const derechos = bloqueDerechos(f.prosrc);
      if (!derechos) continue;
      const reto = candadoDelReto(f.prosrc);
      // Que el conjunto de derechos se derive del reto se ve en el propio bloque: es su
      // subconsulta la que lo nombra.
      if (/reto_id/.test(derechos[0])) {
        derivadasDelReto.push(f.proname);
        if (reto < 0) sinCandadoDelReto.push(f.proname);
      }
      if (reto >= 0 && reto > derechos.index) invertidas.push(f.proname);
    }

    // Anti-vacío: si el reconocedor deja de ver los bloques —porque cambie la forma de
    // escribirlos— esta prueba pasaría en verde sin mirar nada, que es el modo de fallo que
    // hay que evitar. Hoy son `propuesta_ai_c2_citas_guard` y `gate_aprobar_suficiencia_guard`.
    expect(derivadasDelReto.length, 'el reconocedor no encontró ninguna función que derive derechos del reto')
      .toBeGreaterThanOrEqual(2);
    expect(sinCandadoDelReto, 'estas funciones bloquean derechos derivados del reto sin bloquear el reto')
      .toEqual([]);
    expect(invertidas, 'estas funciones piden derecho_uso antes que el reto').toEqual([]);
  });

  /**
   * Una revocación EN VUELO no deja que el material salga hacia el proveedor.
   *
   * `REVALIDAR.C2` recompone la huella del material justo antes de despachar, y eso cierra la
   * ventana ancha: la revocación ya commiteada. La fina no: una que está en vuelo no la ve este
   * snapshot, la huella cuadra, y esa revocación puede commitear antes de que `abrirLlamada`
   * cierre su transacción y despache.
   *
   * Es el peor desenlace del pipeline y el único IRREVERSIBLE — material del cliente saliendo
   * hacia un tercero después de que le retiraran el permiso, y lo que ya salió no se puede
   * retirar. Todo lo demás de este PR se arregla rechazando o rehaciendo; esto no.
   *
   * Se mide por el LIBRO y por el despacho: la revocación toma su candado y se queda abierta;
   * la generación entra y espera en el `for share`; se suelta la revocación, la generación
   * despierta, recompone la huella, la ve distinta y NO llama. Sin el candado no espera:
   * despacha con la evidencia revocada dentro.
   */
  it('una revocación en vuelo impide que el material salga hacia el proveedor', async () => {
    await enWorkspaceLimpio('c2-revocacion-antes-de-despachar', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      // `duranteLlamada` es el hueco en el que el material ESTÁ EN EL AIRE: corre después de
      // que el apunte haya salido bien, así que contar aquí es contar despachos de verdad.
      // (`antesDelApunte` corre antes de la comprobación del permiso y no mide eso.)
      let despachos = 0;
      proveedor.duranteLlamada = async () => {
        despachos += 1;
      };
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;

      const revocacion = await candadoEnVuelo((tx) => tx`update derecho_uso
          set estado = 'denegado', ambito = 'interno', base = 'El participante retiró el permiso',
              decidido_por = ${curadorId}, decidido_en = now()
          where evidencia_id = ${ev} and workspace_id = ${wsC}`);

      try {
        const generacion = conProveedor(
          { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
          () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
        );
        const veredicto = generacion.then(
          () => 'generó',
          (e: Error) => `rechazó: ${e.message}`,
        );
        await revocacion.esperaAQueAlguienEspere();
        revocacion.soltar();
        await revocacion.terminado;
        expect(await veredicto).toMatch(/cambió mientras se preparaba|no se llamó al proveedor/);
      } finally {
        proveedor.duranteLlamada = null;
      }

      // Ni un byte en el aire, y sin línea en el libro: no se abre para una llamada que no
      // ocurre. Sin el candado, esto despacha con la evidencia revocada dentro.
      expect(despachos, 'se despachó el material con la evidencia revocada dentro').toBe(0);
      const [tras] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(tras!.n).toBe(antes!.n);
    });
  }, 20000);

  /**
   * Y el ARCHIVO del reto EN VUELO, que es el cuarto sitio donde se hace la misma pregunta.
   *
   * `REVALIDAR.C2` ya volvía a preguntar por el archivo justo antes de despachar —eso cierra la
   * ventana ancha—, pero lo preguntaba con un `select` a secas, una línea por encima del
   * candado de `derecho_uso` que cerró la ventana fina de la revocación. Un archivado en vuelo
   * no lo ve ese snapshot: la lectura devuelve la versión activa anterior sin esperar, la
   * huella del material no cambia —archivar solo toca `estado`— y el despacho se cuela por
   * delante del archivo. Se paga el análisis de un trabajo que este mismo camino declara
   * cerrado, y la propuesta que vuelva del proveedor la va a rechazar el suelo.
   *
   * Volver a preguntar en el momento correcto no basta: hace falta preguntarlo BAJO CANDADO, y
   * hace falta hacerlo en TODOS los sitios donde se hace la misma pregunta. Este es el cuarto:
   * el guard del insert, el guard diferido de la aceptación, los derechos de aquí — y el reto
   * de aquí, que se había quedado fuera.
   *
   * Se mide por el despacho y por el LIBRO: el archivado toma su candado y se queda abierto; la
   * generación entra y espera en el `for share`; se suelta el archivado, la generación
   * despierta, relee el reto y ve `archivado`, y no llama. Sin el candado no espera: despacha.
   */
  it('un archivado en vuelo impide que se despache el análisis de un reto cerrado', async () => {
    await enWorkspaceLimpio('c2-archivado-antes-de-despachar', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      // `duranteLlamada` —y no `antesDelApunte`— por lo mismo que en la revocación: es el hueco
      // en el que el material ESTÁ EN EL AIRE, después de que el apunte haya salido bien.
      let despachos = 0;
      proveedor.duranteLlamada = async () => {
        despachos += 1;
      };
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;

      const archivado = await candadoEnVuelo((tx) => tx`update reto set estado = 'archivado'
          where id = ${retoC} and workspace_id = ${wsC}`);

      try {
        const generacion = conProveedor(
          { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
          () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
        );
        const veredicto = generacion.then(
          () => 'generó',
          (e: Error) => `rechazó: ${e.message}`,
        );
        await archivado.esperaAQueAlguienEspere();
        archivado.soltar();
        await archivado.terminado;
        expect(await veredicto).toMatch(/se archivó mientras se preparaba/);
      } finally {
        proveedor.duranteLlamada = null;
      }

      expect(despachos, 'se despachó el análisis de un reto que se estaba archivando').toBe(0);
      const [tras] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(tras!.n).toBe(antes!.n);
    });
  }, 20000);

  /**
   * Y el ENLACE NUEVO en vuelo: el fantasma que los candados de fila no cubren.
   *
   * `REVALIDAR.C2` recompone la huella del material y dice, en su propio comentario, que así
   * cubre «una evidencia desenlazada, otra NUEVA, un resumen editado». Las dos primeras
   * mitades son ciertas; la tercera no lo era bajo concurrencia. `for share` bloquea FILAS
   * QUE EXISTEN: un `insert into arquetipo_evidencia` que todavía no ha commiteado no está en
   * ninguna de ellas, así que la lectura no lo ve y no espera. La llamada sale con el
   * material viejo, el enlace commitea detrás, y la propuesta que vuelve se armó sin una
   * evidencia que en ese momento ya sostenía al reto — que en C2 puede ser justo la que
   * contradice el insight.
   *
   * Y no basta con bloquear los arquetipos existentes: un arquetipo NUEVO con su enlace son
   * dos transacciones que caben enteras en la ventana, y su fila tampoco existía al leer. Lo
   * que cubre las dos formas del fantasma es el candado por CLAVE, no por fila: el mismo
   * `designio:reto:` que toma `gate_aprobar_suficiencia_guard` cuando decide sobre filas de
   * otras tablas, y por el mismo motivo que aquél lo toma en el GUARD y no solo en el
   * servicio — quien escribe por SQL directo no coopera con ningún protocolo.
   */
  it('un enlace de evidencia en vuelo no deja que se despache material viejo', async () => {
    await enWorkspaceLimpio('c2-enlace-en-vuelo', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      // La SEGUNDA evidencia queda preparada pero SIN enlazar: enlazarla es lo que ocurre en
      // vuelo. Su arquetipo es nuevo, así que la sonda cubre la forma difícil del fantasma
      // —fila que no existía al leer— y no solo la de un enlace sobre un arquetipo ya visto.
      const [arqNuevo] = await admin`insert into arquetipo
        (workspace_id, reto_id, nombre, definicion, creado_por)
        values (${wsC}, ${retoC}, 'Arquetipo tardío', 'Definición', ${curadorId}) returning id`;
      const [fte] = await admin`insert into fuente
        (workspace_id, tipo, titulo, referencia, creado_por)
        values (${wsC}, 'documento', 'La contradicción', 'ref', ${curadorId}) returning id`;
      const [ev2] = await admin`insert into evidencia
        (workspace_id, fuente_id, titulo, resumen, dimensiones, creado_por)
        values (${wsC}, ${fte!.id as string}, 'La contradicción',
                'En cambio el 12% dice que el documento nunca fue el problema.', '{}'::jsonb,
                ${curadorId}) returning id`;
      await admin`insert into derecho_uso
        (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
        values (${wsC}, ${ev2!.id as string}, 'concedido', 'cliente', 'Consentimiento',
                ${curadorId}, now(), ${curadorId})`;

      let despachos = 0;
      proveedor.duranteLlamada = async () => {
        despachos += 1;
      };
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;

      const enlace = await candadoEnVuelo((tx) => tx`insert into arquetipo_evidencia (workspace_id, arquetipo_id, evidencia_id)
          values (${wsC}, ${arqNuevo!.id as string}, ${ev2!.id as string})`);

      try {
        const generacion = conProveedor(
          { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
          () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
        );
        const veredicto = generacion.then(
          () => 'generó',
          (e: Error) => `rechazó: ${e.message}`,
        );
        await enlace.esperaAQueAlguienEspere();
        enlace.soltar();
        await enlace.terminado;
        expect(await veredicto).toMatch(/cambió mientras se preparaba/);
      } finally {
        proveedor.duranteLlamada = null;
      }

      expect(despachos, 'se despachó material sin la evidencia que ya sostenía al reto').toBe(0);
      const [tras] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(tras!.n).toBe(antes!.n);
    });
  }, 20000);

  /**
   * Y el ORDEN de los dos candados por clave, que es lo que costó el candado del reto.
   *
   * El guard de congelación toma `designio:workspace:` en COMPARTIDO y corre el primero en
   * toda escritura, así que el orden del sistema es workspace → reto. Si el despacho pidiera
   * solo el del reto, lo pediría al revés: reto primero y workspace después, porque el del
   * workspace se lo acaba pidiendo su propio insert en `llamada_ai`. Enfrente hay una
   * transacción que los pide en el orden bueno y en EXCLUSIVA: `ejecutar_disposicion` toma el
   * del workspace y después borra `arquetipo`, con lo que pasa por el trigger nuevo y pide el
   * del reto. Dos órdenes sobre el mismo par es un abrazo mortal esperando a que coincidan.
   *
   * La ventana es ESTRECHA y por eso la sonda usa `antesDelApunte`: la transacción de
   * `prepararAlcance` también escribe (la reserva) y también pide el del workspace, así que
   * una sonda que tomara el candado antes de empezar bloquearía ahí —sin haber tomado nada— y
   * no mediría nada. Se comprobó: esa primera versión seguía en verde con el arreglo quitado.
   * El hueco bueno es el de justo antes del apunte, con la preparación ya commiteada.
   */
  it('el despacho pide el candado del workspace antes que el del reto', async () => {
    await enWorkspaceLimpio('c2-orden-de-candados', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });

      let otra: Promise<unknown> = Promise.resolve();
      let loTiene: () => void = () => {};
      const yaLoTiene = new Promise<void>((r) => {
        loTiene = r;
      });
      // El mismo par y en el mismo orden que `ejecutar_disposicion`: el del workspace en
      // exclusiva, y después el del reto (que allí llega por el borrado de `arquetipo`).
      proveedor.antesDelApunte = async () => {
        otra = admin.begin(async (tx) => {
          const [p] = await tx`select pg_backend_pid()::int as pid`;
          await tx`select pg_advisory_xact_lock(
            hashtextextended('designio:workspace:' || ${wsC}::text, 42))`;
          loTiene();
          // Hasta que el apunte esté PARADO detrás de este candado: con el orden bueno se
          // queda esperando el del workspace sin haber tomado nada; con el malo ya tiene el
          // del reto y espera el del workspace. Era un plazo de 800 ms, y un plazo aquí se
          // agota bajo carga antes de que el apunte llegue a pedir nada — dejando la sonda
          // midiendo un adelantamiento que no ocurrió.
          await esperaAQueAlguienEspere(p!.pid as number);
          await tx`select pg_advisory_xact_lock(
            hashtextextended('designio:reto:' || ${retoC}::text, 42))`;
        });
        await yaLoTiene;
      };

      let resultado: string;
      let laOtraTermino: string;
      try {
        const generacion = conProveedor(
          { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
          () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
        );
        resultado = await generacion.then(
          () => 'generó',
          (e: Error) => `rechazó: ${e.message}`,
        );
        laOtraTermino = await otra.then(
          () => 'commiteó',
          (e: Error) => `abortó: ${e.message}`,
        );
      } finally {
        proveedor.antesDelApunte = null;
      }

      // Un interbloqueo aborta a UNA de las dos, y cuál es no lo elige nadie: por eso se
      // miran las dos. Del lado del despacho no llega la palabra «deadlock» —el servicio
      // traduce el fallo del apunte a su mensaje de dominio—, así que lo que se afirma es lo
      // que de verdad se quiere: las dos terminan. Medido con el candado del workspace
      // quitado: «rechazó: No se pudo abrir la línea del libro de costos para esta llamada».
      const veredictos = { despacho: resultado, disposicion: laOtraTermino };
      expect(veredictos, 'el despacho y la disposición se pidieron los candados en órdenes distintos')
        .toEqual({ despacho: 'generó', disposicion: 'commiteó' });
    });
  }, 20000);

  /**
   * Un uuid en mayúscula es el MISMO uuid, también en el suelo.
   *
   * El guard del INSERT normaliza con `lower(...)` —lo hace explícitamente— y el guard diferido
   * de materialización comparaba verbatim contra el texto del uuid, que Postgres guarda siempre
   * en minúscula. Las dos mitades del suelo discrepaban, y el resultado no era un rechazo
   * ruidoso: era una propuesta que ENTRA y que después no se puede aceptar nunca.
   *
   * Una ronda anterior cerró esto para la salida del proveedor normalizando al parsear
   * (`IdCopiadoDelMaterial`). La superficie SQL concedida no pasa por el parser, así que allí
   * seguía vivo — y es el mismo modo de fallo que ya obligó a mover la regla de las citas al
   * suelo: lo que solo está en el contrato no protege a quien escribe por debajo.
   *
   * Medido antes del arreglo: `entra = ENTRÓ`, `acepta = rechazó` («las afirmaciones y las
   * citas del insight materializado no dicen lo que dice la propuesta»), sobre una propuesta
   * cuyo único pecado era escribir el uuid en mayúscula.
   */
  it('un uuid en mayúscula por la superficie SQL no deja la propuesta muerta', async () => {
    await enWorkspaceLimpio('c2-uuid-mayuscula-suelo', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido = {
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [
              {
                evidenciaId: ev.toUpperCase(),
                fragmento: 'El 71% de los abandonos',
                localizacion: 'resumen',
              },
            ],
          },
        ],
        contradicciones: [{ evidenciaId: ev.toUpperCase(), descripcion: 'Va en contra' }],
        confianzaPropuesta: 'media',
      };
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C2', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const [pr] = await conUsuario(curadorId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
           confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key,
           llamada_id, creado_por)
        values (${wsC}, 'C2', 'insight', ${retoC}, ${tx.json(contenido as never)},
                ${tx.json(contenido as never)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                'alcance', 'huella', ${ALCANCE_DEL_RETO(tx, wsC, retoC)}, 'entorno', ${l!.id as string}, ${curadorId})
        returning id`);
      const propuestaId = pr!.id as string;

      // Y se puede aceptar: las dos mitades del suelo dicen ahora lo mismo. Sin el `lower` del
      // guard diferido, esto muere con «no dicen lo que dice la propuesta» y la propuesta se
      // queda sin ninguna salida salvo rechazarla.
      await conUsuario(curadorId, async (tx) => {
        const [ins] = await tx`insert into insight
          (workspace_id, titulo, resumen, estado, creado_por)
          values (${wsC}, 'T', 'R', 'propuesto', ${curadorId}) returning id`;
        const [af] = await tx`insert into afirmacion
          (workspace_id, insight_id, orden, texto, es_hipotesis)
          values (${wsC}, ${ins!.id as string}, 0, 'A', false) returning id`;
        await tx`insert into cita
          (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
          values (${wsC}, ${af!.id as string}, ${ev}, 'El 71% de los abandonos', 'resumen',
                  ${curadorId})`;
        await tx`insert into contradiccion
          (workspace_id, insight_id, evidencia_id, descripcion, creado_por)
          values (${wsC}, ${ins!.id as string}, ${ev}, 'Va en contra', ${curadorId})`;
        await tx`update propuesta_ai
          set estado = 'aceptada', revisada_por = ${curadorId}, insight_id = ${ins!.id as string}
          where id = ${propuestaId} and workspace_id = ${wsC}`;
      });

      const [sellada] = await admin`select estado from propuesta_ai
        where id = ${propuestaId} and workspace_id = ${wsC}`;
      expect(sellada!.estado as string).toBe('aceptada');
    });
  });

  /**
   * El `xmin` no distingue INSERTAR de ACTUALIZAR, y esa era la grieta del sello.
   *
   * La procedencia se apoyaba en «esta fila nació en esta misma transacción», comprobado con
   * `i.xmin = pg_current_xact_id()`. Pero Postgres le pone a la tupla ACTUALIZADA el id de la
   * transacción que la actualiza, así que una cabecera vieja a la que esta misma transacción le
   * hace un UPDATE permitido pasa la comprobación como si acabara de nacer.
   *
   * Medido: un insight escrito a mano en otra transacción, con la cabecera que la propuesta
   * dice —para que la paridad de contenido no lo pare antes—, más sus afirmaciones y citas
   * creadas aquí, más el UPDATE de validación (que es legítimo), se sellaba con la procedencia
   * de la propuesta. SYS-19 dice justo lo contrario.
   *
   * Se cierra exigiendo que el insight siga `propuesto`. Por qué eso basta está medido en el
   * caso de abajo y no citado de memoria: no existe UPDATE concedido que refresque el `xmin`
   * dejando la fila en `propuesto`.
   */
  it('una propuesta no puede sellar un insight que ya existía', async () => {
    await enWorkspaceLimpio('c2-xmin-preexistente', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido = CONTENIDO_C2(ev);
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;

      // Un insight VIEJO, de otra transacción, con la cabecera que la propuesta dice.
      const [viejo] = await conUsuario(curadorId, (tx) => tx`insert into insight
        (workspace_id, titulo, resumen, estado, creado_por)
        values (${wsC}, ${contenido.titulo}, ${contenido.resumen}, 'propuesto', ${curadorId})
        returning id`);
      const insightViejo = viejo!.id as string;

      await expect(
        conUsuario(curadorId, async (tx) => {
          const [af] = await tx`insert into afirmacion
            (workspace_id, insight_id, orden, texto, es_hipotesis)
            values (${wsC}, ${insightViejo}, 0, ${contenido.afirmaciones[0]!.texto}, false)
            returning id`;
          await tx`insert into cita
            (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
            values (${wsC}, ${af!.id as string}, ${ev},
                    ${contenido.afirmaciones[0]!.citas[0]!.fragmento},
                    ${contenido.afirmaciones[0]!.citas[0]!.localizacion}, ${curadorId})`;
          // El UPDATE permitido, que es lo que refresca el xmin de la cabecera vieja.
          await tx`update insight
            set estado = 'validado', validado_por = ${curadorId}, validado_en = now()
            where id = ${insightViejo} and workspace_id = ${wsC}`;
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${curadorId}, insight_id = ${insightViejo}
            where id = ${p.id} and workspace_id = ${wsC}`;
        }),
        'una propuesta se apropió de un insight que ya existía (SYS-19)',
      ).rejects.toThrow(/creado esta misma aceptación/);

      // Y la aceptación legítima sigue funcionando: nace `propuesto` y validar es un acto
      // humano POSTERIOR, en otra transacción, así que la condición no le estorba.
      const { objetoId } = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: p.id,
      });
      expect(objetoId).not.toBe(insightViejo);
      const [nuevo] = await admin`select estado, propuesta_ai_id from insight
        where id = ${objetoId} and workspace_id = ${wsC}`;
      expect(nuevo!.estado as string).toBe('propuesto');
      expect(nuevo!.propuesta_ai_id).toBe(p.id);
    });
  });

  /**
   * Y por qué basta con exigir `propuesto`: NO HAY UPDATE que refresque el xmin sin sacarlo.
   *
   * El arreglo de arriba se apoya en un invariante de otro sitio, y en este PR eso ha salido
   * mal cinco veces —un `grant` de tabla que cubría columnas futuras, un índice único que no
   * cerraba lo que su comentario decía, un recuento que solo significa algo sin repetidas—.
   * Así que este no se cita: se mide contra el catálogo y contra la base.
   *
   * La superficie de UPDATE del rol de aplicación sobre `insight` es (estado, validado_por,
   * validado_en) y su única política de UPDATE exige, en el `with check`, que la fila quede
   * `validado`. Si alguien amplía eso, este caso se pone rojo y no hay que acordarse de nada.
   */
  it('el rol de aplicación no puede refrescar un insight dejándolo propuesto', async () => {
    await enWorkspaceLimpio('c2-superficie-de-update', async ({ ws: wsC, curadorId }) => {
      const admin = sqlAdmin();
      // Las columnas concedidas, del catálogo: si aparece una más, hay que volver a pensar.
      const columnas = await admin`
        select column_name from information_schema.column_privileges
        where grantee = 'designio_app' and table_name = 'insight' and privilege_type = 'UPDATE'
        order by column_name`;
      expect(
        columnas.map((c) => c.column_name as string),
        'la superficie de UPDATE sobre insight creció: el sello de procedencia se apoya en ella',
      ).toEqual(['estado', 'validado_en', 'validado_por']);

      const [ins] = await conUsuario(curadorId, (tx) => tx`insert into insight
        (workspace_id, titulo, resumen, estado, creado_por)
        values (${wsC}, 'T', 'R', 'propuesto', ${curadorId}) returning id`);

      // Y el intento de refrescar la fila DEJÁNDOLA propuesta no pasa la política.
      await expect(
        conUsuario(curadorId, (tx) => tx`update insight
          set estado = 'propuesto'
          where id = ${ins!.id as string} and workspace_id = ${wsC}`),
      ).rejects.toThrow();
    });
  });

  /**
   * Y la contradicción repetida, por lo mismo y con el mismo agujero.
   *
   * El `unique (insight_id, evidencia_id)` de `contradiccion` NO lo cierra, y esa era la
   * suposición que el propio comentario del guard dejaba escrita: las dos filas materializadas
   * pueden ser de evidencias DISTINTAS —la revisada y una colada—, así que el índice ni se
   * entera. Lo que falla es lo de siempre: con la misma contradicción propuesta dos veces, el
   * recuento cuadra y las dos entradas repetidas encuentran la misma fila. Medido:
   * `entra = ENTRÓ`, `sella = SELLÓ`, con una contradicción que nadie propuso dentro del
   * insight aceptado — y las contradicciones son justo la parte que más tienta manipular,
   * porque son la evidencia que va en contra.
   *
   * Se corta por `evidenciaId`, que es la clave que ya usan el índice y el contrato: dos
   * contradicciones sobre el mismo documento no son dos, son una escrita dos veces.
   */
  it('una contradicción repetida no entra tampoco por la superficie SQL', async () => {
    await enWorkspaceLimpio('c2-contradiccion-repetida', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const a = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Analítica',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const b = await evidenciaDelReto(wsC, retoC, curadorId, { titulo: 'B', resumen: 'Contra.' });
      const c = await evidenciaDelReto(wsC, retoC, curadorId, { titulo: 'C', resumen: 'Otra.' });
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C2', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const conContradicciones = (contradicciones: unknown[]) => ({
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ evidenciaId: a, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' }],
          },
        ],
        contradicciones,
        confianzaPropuesta: 'media',
      });
      const escribir = (contenido: unknown) =>
        conUsuario(curadorId, (tx) => tx`
          insert into propuesta_ai
            (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
             confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key,
             llamada_id, creado_por)
          values (${wsC}, 'C2', 'insight', ${retoC}, ${tx.json(contenido as never)},
                  ${tx.json(contenido as never)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                  'alcance', 'huella', ${ALCANCE_DEL_RETO(tx, wsC, retoC)}, 'entorno', ${l!.id as string}, ${curadorId})
          returning id`);

      await expect(
        escribir(
          conContradicciones([
            { evidenciaId: b, descripcion: 'Va en contra' },
            { evidenciaId: b, descripcion: 'Va en contra' },
          ]),
        ),
        'la superficie SQL admite un recuento de contradicciones que ya no significa nada',
      ).rejects.toThrow(/repite una contradicción/);

      // Y dos contradicciones sobre documentos DISTINTOS sí entran: lo que se corta es la
      // repetición, no la pluralidad.
      await expect(
        escribir(
          conContradicciones([
            { evidenciaId: b, descripcion: 'Va en contra' },
            { evidenciaId: c, descripcion: 'Y esta también' },
          ]),
        ),
      ).resolves.toBeDefined();
    });
  });

  /**
   * La cita repetida también la corta la BASE, no solo el contrato.
   *
   * `ContenidoInsightSchema` ya la rechaza, y eso cubre el camino de la aplicación. La
   * superficie SQL concedida no pasa por ahí, y el guard diferido compara las citas por
   * EXISTENCIA más el recuento: con la misma cita propuesta dos veces, materializar una que
   * coincide y otra que NADIE propuso cuadra el recuento —dos y dos— y las dos entradas
   * repetidas encuentran la misma fila. Medido antes del arreglo: `entra=ENTRÓ`, `sella=SELLÓ`.
   * Un insight aceptado con una cita que ningún humano revisó.
   *
   * Se corta donde el recuento vuelve a significar lo que dice: sin repetidas, «tantas como
   * dice la propuesta» más «cada una existe» ES la igualdad de conjuntos. Y va en el guard del
   * INSERT y no en el diferido, porque así la propuesta mala no llega ni a nacer.
   */
  it('una cita repetida no entra tampoco por la superficie SQL', async () => {
    await enWorkspaceLimpio('c2-cita-repetida-suelo', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento. Y el 12% en el alta.',
      });
      const cita = { evidenciaId: ev, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' };
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C2', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const escribir = (contenido: unknown) =>
        conUsuario(curadorId, (tx) => tx`
          insert into propuesta_ai
            (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
             confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key,
             llamada_id, creado_por)
          values (${wsC}, 'C2', 'insight', ${retoC}, ${tx.json(contenido as never)},
                  ${tx.json(contenido as never)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                  'alcance', 'huella', ${ALCANCE_DEL_RETO(tx, wsC, retoC)}, 'entorno', ${l!.id as string}, ${curadorId})
          returning id`);

      await expect(
        escribir({
          titulo: 'T',
          resumen: 'R',
          afirmaciones: [{ texto: 'A', esHipotesis: false, citas: [cita, cita] }],
          contradicciones: [],
          confianzaPropuesta: 'media',
        }),
        'la superficie SQL admite una propuesta cuyo recuento de citas ya no significa nada',
      ).rejects.toThrow(/repite la misma cita/);

      // Y el MISMO documento con OTRO fragmento sí entra: citar dos veces la misma evidencia
      // es legítimo, y por eso esto no puede ser un índice único.
      await expect(
        escribir({
          titulo: 'T',
          resumen: 'R',
          afirmaciones: [
            {
              texto: 'A',
              esHipotesis: false,
              citas: [cita, { ...cita, fragmento: 'Y el 12% en el alta' }],
            },
          ],
          contradicciones: [],
          confianzaPropuesta: 'media',
        }),
      ).resolves.toBeDefined();
    });
  });

  /**
   * Y el derecho de CITA no se le exige a una contradicción, que no cita.
   *
   * El barrido que rechaza una cita a evidencia ajena o no citable recorría las dos ramas
   * —citas y contradicciones— aplicándoles las DOS reglas. La proveniencia sí vale para las
   * dos: una contradicción a evidencia de otro reto está tan mal como una cita, y ahí
   * `contradiccion` solo lleva la FK del tenant, así que este barrido es lo único que lo mira.
   * El derecho de cita no: `evidencia_citable_guard` cuelga de `cita` y NO de `contradiccion`,
   * a propósito, y la aceptación materializa la contradicción sin pedirlo.
   *
   * Así que rechazar la propuesta entera por ahí era descartar trabajo bueno POR EL RELOJ: si
   * la revocación llega durante la llamada, la propuesta muere con el gasto ya hecho; si llega
   * un segundo después de persistir, la misma propuesta es perfectamente aceptable. Medido:
   * `persiste=rechazó`, y el mensaje además llamaba «cita» a una contradicción.
   *
   * Las dos mitades: la contradicción a evidencia sin derechos entra, y la contradicción a
   * evidencia AJENA sigue sin entrar — que es la regla que había que conservar.
   */
  it('una contradicción no necesita el derecho de cita, pero sí ser del reto', async () => {
    await enWorkspaceLimpio('c2-contradiccion-derechos', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const a = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Analítica',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const b = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La que se revoca',
        resumen: 'Aquí dicen que el problema es el precio.',
      });
      // A la evidencia SOLO contradicha se le retiran los derechos antes de persistir, que es
      // lo que pasa cuando la revocación cae durante la llamada al proveedor.
      await admin`update derecho_uso
        set estado = 'denegado', ambito = 'interno', base = 'El participante retiró el permiso',
            decidido_por = ${curadorId}, decidido_en = now()
        where evidencia_id = ${b} and workspace_id = ${wsC}`;
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C2', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const conContradiccionA = (evidenciaId: string) => ({
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ evidenciaId: a, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' }],
          },
        ],
        contradicciones: [{ evidenciaId, descripcion: 'Va en contra' }],
        confianzaPropuesta: 'media',
      });
      const escribir = (contenido: unknown) =>
        conUsuario(curadorId, (tx) => tx`
          insert into propuesta_ai
            (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
             confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key,
             llamada_id, creado_por)
          values (${wsC}, 'C2', 'insight', ${retoC}, ${tx.json(contenido as never)},
                  ${tx.json(contenido as never)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                  'alcance', 'huella', ${ALCANCE_DEL_RETO(tx, wsC, retoC)}, 'entorno', ${l!.id as string}, ${curadorId})
          returning id`);

      // Entra: la contradicción no reproduce nada, así que no pide permiso de publicación.
      await expect(
        escribir(conContradiccionA(b)),
        'se descarta una propuesta pagada por una condición que la aceptación no exige',
      ).resolves.toBeDefined();

      // Y la proveniencia sigue en pie para la misma rama: una evidencia de OTRO reto no.
      const [otroReto] = await admin`insert into reto
        (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por)
        select ${wsC}, servicio_ancla_id, 'R-99', 'Otro reto', 'candidato', 'peticion-cliente',
               ${curadorId}
        from reto where id = ${retoC} returning id`;
      const ajena = await evidenciaDelReto(wsC, otroReto!.id as string, curadorId, {
        titulo: 'De otro reto',
        resumen: 'Nada que ver.',
      });
      await expect(
        escribir(conContradiccionA(ajena)),
        'una contradicción puede señalar evidencia que no es de este reto',
      ).rejects.toThrow(/no es de este reto/);
    });
  });

  /**
   * El NOMBRE de un documento no lo gobiernan los derechos de cita.
   *
   * Las etiquetas del contenido salían de la lista del MATERIAL, que está filtrada por
   * `evidencia_usable(…, 'cliente')` porque es lo que viaja al modelo. Para las citas cuadra
   * de casualidad. Para las CONTRADICCIONES no, y ahí la pantalla decía algo falso.
   *
   * El suelo lo dice claro: `evidencia_citable_guard` cuelga de `cita` y NO de
   * `contradiccion`, y es a propósito — una cita reproduce un fragmento para el cliente y una
   * contradicción solo señala que ese documento va en contra, así que no piden el mismo
   * permiso. Medido sobre una evidencia solo contradicha a la que se le retiran los derechos:
   * la propuesta sigue `disponible`, aceptar FUNCIONA y materializa la contradicción… y la
   * etiqueta venía AUSENTE, así que quien revisa leía «ya no está» del documento que tenía
   * delante y estaba a punto de sellar. Justo en el momento de decidir.
   *
   * Identidad y permiso de cita son preguntas distintas y ahora se hacen por separado. El
   * alcance no se toca —la evidencia de ESTE reto por sus arquetipos, bajo las mismas
   * políticas—: lo único que se cae es el filtro de derechos, que en una etiqueta no pinta
   * nada. De paso mejora también el caso de la cita: cuando a un documento citado se le
   * retiran los derechos, quien revisa ve QUÉ documento perdió el permiso en vez de un id.
   */
  it('la etiqueta de una evidencia contradicha sobrevive a la pérdida de derechos', async () => {
    await enWorkspaceLimpio('c2-etiqueta-contradiccion', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const a = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Analítica del funnel',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const b = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'Encuesta que dice lo contrario',
        resumen: 'Quien contesta dice que el problema es el precio.',
      });
      const contenido: ContenidoInsight = {
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ evidenciaId: a, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' }],
          },
        ],
        contradicciones: [{ evidenciaId: b, descripcion: 'Esta va en contra' }],
        confianzaPropuesta: 'media',
      };
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      // Recién nacida, las dos etiquetas están: sin esto, el caso podría estar pasando porque
      // el fixture nunca las tuvo.
      const recien = await panelPropuestas(curadorId, wsC);
      expect(recien.pendientes.find((x) => x.capacidad === 'C2')!.etiquetas[b]).toBe(
        'Encuesta que dice lo contrario',
      );

      // A la evidencia SOLO contradicha —no citada— se le retiran los derechos de cita.
      await admin`update derecho_uso
        set estado = 'denegado', ambito = 'interno', base = 'El participante retiró el permiso',
            decidido_por = ${curadorId}, decidido_en = now()
        where evidencia_id = ${b} and workspace_id = ${wsC}`;

      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      expect(
        p.etiquetas[b],
        'la pantalla dice «ya no está» de un documento que existe y se va a sellar',
      ).toBe('Encuesta que dice lo contrario');
      // Y la propuesta sigue siendo aceptable, que es lo que hace que la etiqueta importe: la
      // cita apunta a `a`, que conserva sus derechos, y la contradicción no los necesita.
      expect(p.anclaEstado).toBe('disponible');
      const { objetoId } = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: p.id,
      });
      const [c] = await admin`select evidencia_id from contradiccion where insight_id = ${objetoId}`;
      expect(c!.evidencia_id).toBe(b);
    });
  });

  /**
   * Lo mismo con el ARCHIVO del reto: la comprobación diferida también era una foto.
   *
   * El servicio toma `bloquearReto`, pero este guard existe precisamente para quien escribe por
   * SQL directo, que no pasa por el servicio. Sin candado sobre la fila del reto, un archivado
   * en vuelo no lo ve este snapshot y el insight nace en un reto que se está cerrando.
   *
   * `for share` y no `for update`: dos aceptaciones sobre el mismo reto no tienen por qué
   * esperarse, y quien archiva hace un UPDATE que toma FOR NO KEY UPDATE, con el que FOR SHARE
   * ya choca — que es exactamente el orden que hace falta.
   */
  it('un archivado en vuelo ordena la aceptación en vez de colarse detrás', async () => {
    await enWorkspaceLimpio('c2-archivado-en-vuelo', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido = CONTENIDO_C2(ev);
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;

      const archivado = await candadoEnVuelo((tx) => tx`update reto set estado = 'archivado'
          where id = ${retoC} and workspace_id = ${wsC}`);

      const aceptacion = conUsuario(curadorId, async (tx) => {
        const [ins] = await tx`insert into insight
          (workspace_id, titulo, resumen, estado, creado_por)
          values (${wsC}, ${contenido.titulo}, ${contenido.resumen}, 'propuesto', ${curadorId})
          returning id`;
        const [af] = await tx`insert into afirmacion
          (workspace_id, insight_id, orden, texto, es_hipotesis)
          values (${wsC}, ${ins!.id as string}, 0, ${contenido.afirmaciones[0]!.texto}, false)
          returning id`;
        await tx`insert into cita
          (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
          values (${wsC}, ${af!.id as string}, ${ev},
                  ${contenido.afirmaciones[0]!.citas[0]!.fragmento},
                  ${contenido.afirmaciones[0]!.citas[0]!.localizacion}, ${curadorId})`;
        await tx`update propuesta_ai
          set estado = 'aceptada', revisada_por = ${curadorId}, insight_id = ${ins!.id as string}
          where id = ${p.id} and workspace_id = ${wsC}`;
      });
      const veredicto = aceptacion.then(
        () => 'commiteó',
        (e: Error) => `rechazó: ${e.message}`,
      );

      await archivado.esperaAQueAlguienEspere();
      archivado.soltar();
      await archivado.terminado;

      expect(
        await veredicto,
        'la aceptación se coló por delante de un archivado que ya estaba en vuelo',
      ).toMatch(/archivado/);
    });
  }, 20000);

  /**
   * Y volver a preguntar no basta si no se toma el CANDADO: la revocación EN VUELO.
   *
   * El rechequeo del commit cierra la ventana ancha —la revocación que ya commiteó—, y deja
   * una fina: una revocación que está en vuelo y todavía no ha commiteado no la ve este
   * snapshot, así que la comprobación pasa y la aceptación commitea con la revocación
   * pisándole los talones. Volver a preguntar sin candado solo adelanta la foto un poco.
   *
   * Con «for share» sobre las filas de `derecho_uso` que este insight cita, hay un ORDEN: o la
   * revocación commitea primero y la lectura la ve, o espera a que la aceptación termine. Es el
   * protocolo que este repositorio ya tiene escrito para `derecho_uso` en
   * `20260902240000-candados-compartidos.sql`, y que este guard no seguía.
   *
   * El caso lo fabrica de verdad, con dos conexiones: la revocación toma su candado y se queda
   * abierta; la aceptación entra, inserta la cita —su trigger la ve concedida, porque la
   * revocación no ha commiteado— y llega al commit, donde espera. Se suelta la revocación y la
   * aceptación despierta, vuelve a leer y rechaza. Sin el candado no espera: commitea antes,
   * y esta sonda se pone roja.
   */
  it('una revocación en vuelo ordena la aceptación en vez de colarse detrás', async () => {
    await enWorkspaceLimpio('c2-revocacion-en-vuelo', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido = CONTENIDO_C2(ev);
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;

      // La revocación toma su candado de fila y se queda ABIERTA.
      const revocacion = await candadoEnVuelo((tx) => tx`update derecho_uso
          set estado = 'denegado', ambito = 'interno', base = 'El participante retiró el permiso',
              decidido_por = ${curadorId}, decidido_en = now()
          where evidencia_id = ${ev} and workspace_id = ${wsC}`);

      const aceptacion = conUsuario(curadorId, async (tx) => {
        const [ins] = await tx`insert into insight
          (workspace_id, titulo, resumen, estado, creado_por)
          values (${wsC}, ${contenido.titulo}, ${contenido.resumen}, 'propuesto', ${curadorId})
          returning id`;
        const [af] = await tx`insert into afirmacion
          (workspace_id, insight_id, orden, texto, es_hipotesis)
          values (${wsC}, ${ins!.id as string}, 0, ${contenido.afirmaciones[0]!.texto}, false)
          returning id`;
        await tx`insert into cita
          (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
          values (${wsC}, ${af!.id as string}, ${ev},
                  ${contenido.afirmaciones[0]!.citas[0]!.fragmento},
                  ${contenido.afirmaciones[0]!.citas[0]!.localizacion}, ${curadorId})`;
        await tx`update propuesta_ai
          set estado = 'aceptada', revisada_por = ${curadorId}, insight_id = ${ins!.id as string}
          where id = ${p.id} and workspace_id = ${wsC}`;
      });
      const veredicto = aceptacion.then(
        () => 'commiteó',
        (e: Error) => `rechazó: ${e.message}`,
      );

      await revocacion.esperaAQueAlguienEspere();
      revocacion.soltar();
      await revocacion.terminado;

      expect(
        await veredicto,
        'la aceptación se coló por delante de una revocación que ya estaba en vuelo',
      ).toMatch(/DR001/);

      const [tras] = await admin`select estado from propuesta_ai
        where id = ${p.id} and workspace_id = ${wsC}`;
      expect(tras!.estado as string).toBe('propuesta');
    });
  }, 20000);

  /**
   * Y el candado cubre los derechos de TODA la evidencia del reto, no solo la que el insight cita.
   *
   * Las dos comprobaciones de las citas miran lo que el insight nombra; la de completitud mira
   * lo que el reto tiene ENLAZADO y el insight no vio. Con el «for share» puesto solo sobre el
   * subconjunto citado, una CONCESIÓN en vuelo sobre un documento enlazado y no citado no
   * ordenaba nada: la completitud lo leía inutilizable —la concesión no ha commiteado—, pasaba,
   * y el sello caía justo antes de que ese documento pasara a ser citable. Quedaban sellados
   * unos insights que no vieron una evidencia que el reto ya tenía, que es exactamente lo que
   * esta comprobación existe para impedir.
   *
   * Con el candado sobre la unión de los dos conjuntos hay un ORDEN: o la concesión commitea
   * primero y esta lectura la ve, o espera a que la aceptación termine. Sin él no espera:
   * commitea antes, y esta sonda se pone roja.
   */
  it('una concesión en vuelo sobre evidencia enlazada y no citada ordena la aceptación', async () => {
    await enWorkspaceLimpio(
      'c2-concesion-en-vuelo',
      async ({ ws: wsC, curadorId, retoId: retoC }) => {
        const admin = sqlAdmin();
        const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
          titulo: 'La evidencia citada',
          resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
        });
        const dormida = await evidenciaDelReto(wsC, retoC, curadorId, {
          titulo: 'La que todavía no se puede citar',
          resumen: 'Otro participante cuenta justo lo contrario.',
          sinDerechos: true,
        });
        const contenido = CONTENIDO_C2(ev);
        await conProveedor(
          { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
          () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
        );
        const p = (await panelPropuestas(curadorId, wsC)).pendientes.find(
          (x) => x.capacidad === 'C2',
        )!;
        // El alcance no la nombra: no era citable cuando se armó el material.
        const [guardada] = await admin`select alcance_evidencia from propuesta_ai
          where id = ${p.id} and workspace_id = ${wsC}`;
        expect(guardada!.alcance_evidencia).toEqual([ev]);

        // La concesión toma su candado de fila y se queda ABIERTA.
        const concesion = await candadoEnVuelo((tx) => tx`update derecho_uso
            set estado = 'concedido', ambito = 'cliente', base = 'El participante dio el permiso',
                decidido_por = ${curadorId}, decidido_en = now()
            where evidencia_id = ${dormida} and workspace_id = ${wsC}`);

        const aceptacion = conUsuario(curadorId, async (tx) => {
          const [ins] = await tx`insert into insight
            (workspace_id, titulo, resumen, estado, creado_por)
            values (${wsC}, ${contenido.titulo}, ${contenido.resumen}, 'propuesto', ${curadorId})
            returning id`;
          const [af] = await tx`insert into afirmacion
            (workspace_id, insight_id, orden, texto, es_hipotesis)
            values (${wsC}, ${ins!.id as string}, 0, ${contenido.afirmaciones[0]!.texto}, false)
            returning id`;
          await tx`insert into cita
            (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
            values (${wsC}, ${af!.id as string}, ${ev},
                    ${contenido.afirmaciones[0]!.citas[0]!.fragmento},
                    ${contenido.afirmaciones[0]!.citas[0]!.localizacion}, ${curadorId})`;
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${curadorId}, insight_id = ${ins!.id as string}
            where id = ${p.id} and workspace_id = ${wsC}`;
        });
        const veredicto = aceptacion.then(
          () => 'commiteó',
          (e: Error) => `rechazó: ${e.message}`,
        );

        await concesion.esperaAQueAlguienEspere();
        concesion.soltar();
        await concesion.terminado;

        expect(
          await veredicto,
          'la aceptación se coló por delante de una concesión que ya estaba en vuelo',
        ).toMatch(/no llegaron a ver/);

        const [tras] = await admin`select estado from propuesta_ai
          where id = ${p.id} and workspace_id = ${wsC}`;
        expect(tras!.estado as string).toBe('propuesta');
      },
    );
  }, 20000);

  /**
   * Y el derecho de uso se vuelve a preguntar en el COMMIT, no solo al insertar la cita.
   *
   * `evidencia_citable_guard` lo exige al insertar cada cita, y ahí lo lee en el snapshot de SU
   * sentencia. Entre esa lectura y el commit cabe una revocación ajena ya commiteada, y
   * entonces la transacción sella una cita —con su fragmento copiado— cuyo derecho ya no
   * existe. No es una carrera rebuscada: aceptar es una transacción con varias escrituras y
   * una revisión humana justo delante.
   *
   * Medido antes del arreglo: la aceptación COMMITEABA, y `evidencia_usable` daba `false`
   * inmediatamente después sobre esa misma evidencia.
   *
   * Es el mismo argumento por el que este guard ya rehace la comprobación del CONSENTIMIENTO
   * para la evidencia extraída y el ciclo de vida del reto: lo que caduca solo hay que volver a
   * preguntarlo en el último instante, y el guard diferido ES el último instante — corre en el
   * commit y ve lo ajeno ya commiteado.
   */
  it('los derechos de las citas se vuelven a exigir al cerrar la aceptación', async () => {
    await enWorkspaceLimpio('c2-derechos-en-el-commit', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido = CONTENIDO_C2(ev);
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;

      await expect(
        conUsuario(curadorId, async (tx) => {
          const [ins] = await tx`insert into insight
            (workspace_id, titulo, resumen, estado, creado_por)
            values (${wsC}, ${contenido.titulo}, ${contenido.resumen}, 'propuesto', ${curadorId})
            returning id`;
          const [af] = await tx`insert into afirmacion
            (workspace_id, insight_id, orden, texto, es_hipotesis)
            values (${wsC}, ${ins!.id as string}, 0, ${contenido.afirmaciones[0]!.texto}, false)
            returning id`;
          // La cita ENTRA: su trigger lee el derecho en el snapshot de esta sentencia y sigue
          // concedido. Es la mitad que hace que este caso mida la ventana y no otra cosa.
          await tx`insert into cita
            (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
            values (${wsC}, ${af!.id as string}, ${ev},
                    ${contenido.afirmaciones[0]!.citas[0]!.fragmento},
                    ${contenido.afirmaciones[0]!.citas[0]!.localizacion}, ${curadorId})`;
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${curadorId}, insight_id = ${ins!.id as string}
            where id = ${p.id} and workspace_id = ${wsC}`;
          // Y AHORA, desde OTRA conexión y ya commiteado, se retira el derecho — que es la
          // ventana entera: después del trigger de la cita y antes de este commit.
          await admin`update derecho_uso
            set estado = 'denegado', ambito = 'interno', base = 'El participante retiró el permiso',
                decidido_por = ${curadorId}, decidido_en = now()
            where evidencia_id = ${ev} and workspace_id = ${wsC}`;
        }),
        'se selló una cita cuyo derecho de uso ya no existía al commitear',
      ).rejects.toThrow(/DR001/);

      // Y la propuesta sigue viva y pendiente: el rollback la deja donde estaba, así que quien
      // revisa puede rechazarla o esperar a que el derecho vuelva.
      const [tras] = await admin`select estado, insight_id from propuesta_ai
        where id = ${p.id} and workspace_id = ${wsC}`;
      expect(tras!.estado as string).toBe('propuesta');
      expect(tras!.insight_id).toBeNull();
    });
  });

  /**
   * Y tras un despliegue que mueve el contrato, la presencia literal NO se afirma.
   *
   * La huella guardada solo se puede comparar contra una recomposición del mismo render, así
   * que `materialDelPanelEsElDelModelo` devuelve `null` en cuanto `prompt_version` difiere. Ese
   * `null` se resolvía como «vigente», apelando a que era lo que hacían todas las capacidades
   * antes de que ninguna guardara huella — y el precedente no es un argumento: si el render del
   * material cambió, los verdes y los rojos salen de un texto que el modelo no vio, que es
   * exactamente lo que esta maquinaria existe para no hacer.
   *
   * Ahora solo se mide cuando la huella dice que sí. El estado de la fila sigue resolviendo ese
   * mismo `null` en la dirección contraria, y a propósito: nombra una causa, y afirmarla sin
   * saberlo sería una alarma inventada.
   */
  it('tras un cambio de versión del prompt, las citas de C2 no se dan por comprobadas', async () => {
    await enWorkspaceLimpio('c2-render-de-otra-version', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      await conProveedor(
        { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      // Con su propia versión se mide y sale presente: sin esta mitad, el caso pasaría también
      // con un fixture cuyo fragmento no aparece nunca.
      const antes = await panelPropuestas(curadorId, wsC);
      expect(antes.pendientes.find((x) => x.capacidad === 'C2')!.citas[0]!.presenteLiteral).toBe(
        true,
      );

      // El despliegue: la propuesta sigue viva y su huella ya no es comparable.
      await admin`update propuesta_ai set prompt_version = 'ai-de-otro-render'
        where workspace_id = ${wsC} and capacidad = 'C2'`;

      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      expect(
        p.citas.map((c) => c.presenteLiteral),
        'el panel afirma sobre un material que no puede comparar con el que vio el modelo',
      ).toEqual([null]);
      // Y sin inventarse una alarma: el ancla sigue disponible, porque nadie sabe si cambió.
      expect(p.anclaEstado).toBe('disponible');
    });
  });

  /**
   * Un reto ARCHIVADO tampoco admite que se materialice lo que ya tenía propuesto.
   *
   * Al nacer la propuesta esto ya se exige, y por separado de la puerta de los criterios: es
   * lo único de aquella condición que habla del RETO y no de los criterios. Entre nacer y
   * aceptarse caben días, y el ciclo de vida del reto avanza solo —`candidato → archivado` es
   * una transición legal—, así que el guard DIFERIDO tiene que volver a exigirlo. No lo hacía:
   * `reto_admite_criterios` excluye `archivado`, de modo que C0 lo tenía de rebote y C2 no lo
   * tenía en absoluto.
   *
   * Las dos mitades, y son distintas. El SERVICIO ya lo rechazaba por su nombre —lee el estado
   * del ancla y lo dice—, así que la pantalla nunca ofreció esto; lo que faltaba era el SUELO,
   * y ahí el hueco era real: con los grants que la aplicación tiene, quien escriba por SQL
   * montaba el insight entero y sellaba la propuesta como aceptada. Medido antes de arreglarlo:
   * `servicio=rechazó`, `suelo=ACEPTÓ`.
   *
   * Y el arreglo va por ANCLA, no por destino. La regla habla del reto, no de lo que la
   * propuesta materializa; escrita como «si el destino es insight» se queda corta ante la
   * próxima capacidad que ancle en el reto, que es exactamente el error que la puerta de los
   * criterios ya costó una vez en este mismo PR.
   */
  it('un reto archivado no admite que se materialice su propuesta pendiente', async () => {
    await enWorkspaceLimpio('c2-reto-archivado', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido = CONTENIDO_C2(ev);
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      // Antes de archivar es aceptable: sin esto, el caso podría estar midiendo un fixture que
      // nunca lo fue.
      expect(p.anclaEstado).toBe('disponible');

      await admin`update reto set estado = 'archivado'
        where id = ${retoC} and workspace_id = ${wsC}`;

      // El servicio, por su nombre.
      await expect(
        aceptarPropuesta(curadorId, { workspaceId: wsC, propuestaId: p.id }),
      ).rejects.toThrow(/archiv/i);

      // Y el SUELO, por el camino que el hueco permitía: el insight entero montado a mano y la
      // propuesta sellada en la misma transacción, que es lo que los grants dejan hacer.
      await expect(
        conUsuario(curadorId, async (tx) => {
          const [ins] = await tx`insert into insight
            (workspace_id, titulo, resumen, estado, creado_por)
            values (${wsC}, ${contenido.titulo}, ${contenido.resumen}, 'propuesto', ${curadorId})
            returning id`;
          const [af] = await tx`insert into afirmacion
            (workspace_id, insight_id, orden, texto, es_hipotesis)
            values (${wsC}, ${ins!.id as string}, 0, ${contenido.afirmaciones[0]!.texto}, false)
            returning id`;
          await tx`insert into cita
            (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
            values (${wsC}, ${af!.id as string}, ${ev},
                    ${contenido.afirmaciones[0]!.citas[0]!.fragmento},
                    ${contenido.afirmaciones[0]!.citas[0]!.localizacion}, ${curadorId})`;
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${curadorId}, insight_id = ${ins!.id as string}
            where id = ${p.id} and workspace_id = ${wsC}`;
        }),
        'la superficie SQL sella un insight atribuido a un reto ya cerrado',
      ).rejects.toThrow(/archivado/);

      // Y RECHAZAR sigue abierto: bloquear también esa salida dejaría la fila muerta y su
      // ancla retenida para siempre.
      await rechazarPropuesta(curadorId, { workspaceId: wsC, propuestaId: p.id });
      const [cerrada] = await admin`select estado from propuesta_ai
        where id = ${p.id} and workspace_id = ${wsC}`;
      expect(cerrada!.estado as string).toBe('rechazada');
    });
  });

  /**
   * C0 y C2 cuelgan del mismo reto y NO se estorban.
   *
   * La exclusión «un ancla no admite dos trabajos a la vez» estaba escrita por COLUMNA —en la
   * admisión y en el índice único de `reserva_ai`—, y con una capacidad por columna decía lo
   * que se quería. Con las dos en el reto pasa a decir que pedir criterios y pedir insights
   * son el mismo trabajo: medido, un criterio de C0 esperando revisión hacía que la admisión
   * de C2 lo rechazara con el mensaje de C2 («ese reto ya tiene insights propuestos»), que
   * además es falso.
   *
   * Las dos mitades: con la propuesta de C0 pendiente, C2 entra; y una segunda de C2 sobre el
   * mismo reto sigue rechazada, que es la regla que sí hay que conservar.
   */
  it('un criterio de C0 pendiente no impide proponer insights del mismo reto', async () => {
    await enWorkspaceLimpio('c2-junto-a-c0', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const admin = sqlAdmin();
      // Un criterio de C0 esperando revisión sobre ESE reto, por el camino de la base.
      const [l0] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C0', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      await conUsuario(curadorId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
           confianza, modelo, prompt_version, alcance_resumen, origen_key, llamada_id, creado_por)
        values (${wsC}, 'C0', 'criterio-exito', ${retoC}, ${tx.json(CONTENIDO_C0)},
                ${tx.json(CONTENIDO_C0)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                'alcance', 'entorno', ${l0!.id as string}, ${curadorId})`);

      const contenido: ContenidoInsight = {
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ evidenciaId: ev, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' }],
          },
        ],
        contradicciones: [],
        confianzaPropuesta: 'media',
      };
      const generadas = await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      expect(generadas.generadas).toBe(1);

      // Y la regla que sí vale: con SU propia propuesta pendiente, C2 no vuelve a entrar.
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
          ).rejects.toThrow(/insights/i);
        },
      );

      // Y con el criterio de C0 decidido, lo único pendiente sobre el reto es el insight: ahí
      // se ve la otra dirección de la independencia, y va abajo en su propio caso.
    });
  });
  /**
   * Y un informe sobre un grafo que YA NO ES EL QUE VIO el modelo se descarta también.
   *
   * La llamada al proveedor ocurre fuera de toda transacción —a propósito—, así que entre
   * armar el prompt y escribir la fila cabe la edición de otro curador. Comparar la respuesta
   * solo contra una lectura NUEVA del grafo no basta: mientras las señales sobrevivan al
   * cambio, el consejo se acepta aunque hable de nodos que ya no están.
   *
   * Se comprueba en el hueco real: `duranteLlamada` es el instante en que el material está en
   * vuelo, con la línea del libro ya abierta. Y se comprueba que la llamada SÍ se pagó y que
   * la propuesta NO nació — el informe se descarta, que es lo correcto, y el gasto queda
   * anotado, que es lo honesto.
   */
  it('un informe sobre un grafo que cambió mientras se generaba se descarta', async () => {
    await enWorkspaceLimpio('c5-grafo-cambiado', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const admin = sqlAdmin();
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;

      proveedor.duranteLlamada = async () => {
        // Otro curador añade un paso suelto: aparece una señal nueva y el informe en vuelo
        // deja de describir este grafo. El id del paso no hace falta: lo que cambia es el
        // conjunto de señales.
        await admin`insert into journey_nodo
          (workspace_id, journey_id, tipo, etiqueta, detalle, orden, responsable, creado_por)
          values (${wsC}, ${j.journeyId}, 'paso', 'Paso añadido a mitad', '', 9, 'Front',
                  ${curadorId})`;
      };
      try {
        await conProveedor(
          {
            ok: true,
            datos: informeCompleto(senales) as unknown as Record<string, unknown>,
            intentos: [intento({ uso: null })],
          },
          async () => {
            await expect(
              generarPropuestas(curadorId, {
                workspaceId: wsC,
                capacidad: 'C5',
                anclaId: j.journeyId,
              }),
            ).rejects.toThrow(/cambió mientras se generaba/);
          },
        );
      } finally {
        proveedor.duranteLlamada = null;
      }

      const quedan = await conUsuario(curadorId, (tx) => tx`
        select count(*)::int as n from propuesta_ai
        where workspace_id = ${wsC} and journey_id = ${j.journeyId}`);
      expect(quedan[0]!.n).toBe(0);
      // La llamada se despachó y su línea quedó: el gasto ocurrido se anota aunque su salida
      // se tire. Registrar lo que se pagó no puede depender de que el resultado nos guste.
      const [despues] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(despues!.n).toBeGreaterThan(antes!.n);

      /*
       * Y el libro NO culpa al modelo. `resultado` describe lo que devolvió el proveedor, y
       * aquí devolvió lo que se le pidió: lo que cambió fue el grafo, por debajo. Reetiquetar
       * esto como `fuera-de-contrato` —que es lo que hacía el primer arreglo de la ronda
       * anterior, sin distinguir los dos motivos— corrompe la medida de calidad del proveedor
       * y emite `LlamadaAISinPropuesta` por algo que el modelo hizo bien.
       *
       * Se cierra igual, eso sí: dejar la línea en `despachada` la deja contando para el tope,
       * sin desenlace y sin coste, que es peor que cualquiera de las dos etiquetas.
       */
      const lineas = await admin`select resultado from llamada_ai
        where workspace_id = ${wsC} and journey_id = ${j.journeyId}`;
      expect(
        lineas.map((l) => l.resultado as string),
        'el libro culpa al modelo de un cambio del grafo',
      ).toEqual(lineas.map(() => 'salida-valida'));
    });
  });

  /**
   * Y LA INDEPENDENCIA VALE EN LAS DOS DIRECCIONES.
   *
   * La admisión ya scopeaba por capacidad y la cola de C2 también; la de C0 seguía excluyendo
   * el reto en cuanto hubiera CUALQUIER propuesta pendiente. Con un insight de C2 esperando
   * revisión, pedir criterios habría funcionado si se enviaba a mano y el reto desaparecía del
   * selector de C0: una independencia que solo se cumplía en un sentido, y que en el otro se
   * manifiesta como una opción que se esfuma sin motivo que nadie pueda leer.
   *
   * Las dos mitades, otra vez: con el insight pendiente C0 se ofrece, y con un criterio de C0
   * pendiente no —que es la regla que sí hay que conservar—.
   */
  it('un insight de C2 pendiente no esconde el reto de la cola de C0', async () => {
    await enWorkspaceLimpio('c0-junto-a-c2', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      // Antes de nada, el reto SÍ está en la cola de C0: sin esto, lo de abajo podría estar
      // midiendo un reto que nunca estuvo.
      const limpio = await panelPropuestas(curadorId, wsC);
      expect(limpio.candidatas.C0.lista.some((r) => r.id === retoC)).toBe(true);

      await conProveedor(
        { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );

      const conInsight = await panelPropuestas(curadorId, wsC);
      expect(conInsight.pendientes.some((x) => x.capacidad === 'C2')).toBe(true);
      expect(
        conInsight.candidatas.C0.lista.some((r) => r.id === retoC),
        'un insight pendiente esconde el reto de la cola de C0',
      ).toBe(true);

      // Y lo que sí lo esconde es lo SUYO: un criterio de C0 esperando revisión.
      const admin = sqlAdmin();
      const [l0] = await admin`insert into llamada_ai
        (workspace_id, capacidad, reto_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C0', ${retoC}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      await conUsuario(curadorId, (tx) => tx`
        insert into propuesta_ai
          (workspace_id, capacidad, destino, reto_id, contenido, contenido_original,
           confianza, modelo, prompt_version, alcance_resumen, origen_key, llamada_id, creado_por)
        values (${wsC}, 'C0', 'criterio-exito', ${retoC}, ${tx.json(CONTENIDO_C0)},
                ${tx.json(CONTENIDO_C0)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
                'alcance', 'entorno', ${l0!.id as string}, ${curadorId})`);
      const conCriterio = await panelPropuestas(curadorId, wsC);
      expect(conCriterio.candidatas.C0.lista.some((r) => r.id === retoC)).toBe(false);
    });
  });

  /**
   * Una afirmación no repite la misma cita.
   *
   * No añade sostén —es el mismo fragmento del mismo documento— y rompe una garantía: el guard
   * de materialización comprueba que cada cita propuesta exista entre las materializadas, y
   * con duplicados el conteo cuadra mientras las dos entradas repetidas encuentran la misma
   * fila. Queda sitio para colar una cita que nadie revisó.
   */
  it('un insight con la misma cita repetida no llega a nacer', async () => {
    await enWorkspaceLimpio('c2-cita-repetida', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const cita = { evidenciaId: ev, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' };
      await conProveedor(
        {
          ok: true,
          datos: {
            insights: [
              {
                titulo: 'T',
                resumen: 'R',
                afirmaciones: [{ texto: 'A', esHipotesis: false, citas: [cita, { ...cita }] }],
                contradicciones: [],
                confianzaPropuesta: 'media',
              },
            ],
          },
          intentos: [intento({ uso: null })],
        },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
          ).rejects.toThrow(/no cumplió el esquema/);
        },
      );
    });
  });
  /**
   * Un grafo con MÁS señales de las que el informe puede llevar no se manda al proveedor.
   *
   * El contrato admite `MAX_REMEDIACIONES`, así que a un grafo con más se le estaría pidiendo
   * algo que su respuesta no puede contener: o vuelve corta —y la comprobación de arriba la
   * descarta, después de pagarla— o el propio modelo elige qué señales callar, que es peor
   * porque no se nota. Se dice antes de gastar, con lo que hay que hacer.
   *
   * Se comprueba por el LIBRO, no solo por el mensaje: negarse después de pagar sería el mismo
   * defecto con mejor cara.
   */
  it('un journey con más señales de las que caben en un informe no llega al proveedor', async () => {
    await enWorkspaceLimpio('c5-demasiadas-senales', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const admin = sqlAdmin();
      // Pasos sueltos: cada uno trae sus señales (sin entrada, sin salida, sin evidencia).
      // Se añaden hasta pasar el techo, y el número se comprueba con la función, no se supone.
      for (let i = 0; i < MAX_REMEDIACIONES; i++) {
        await admin`insert into journey_nodo
          (workspace_id, journey_id, tipo, etiqueta, detalle, orden, responsable, creado_por)
          values (${wsC}, ${j.journeyId}, 'paso', ${`Paso suelto ${i}`}, '', ${100 + i}, 'Front',
                  ${curadorId})`;
      }
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      expect(senales.length).toBeGreaterThan(MAX_REMEDIACIONES);

      // Se ofrece MARCADO, no escondido: esconderlo dejaba el selector vacío y la pantalla
      // afirmando «no hay journeys con señales abiertas» sobre uno que las tiene de sobra,
      // mientras el único texto que dice qué hacer vivía en un mensaje inalcanzable.
      const panel = await panelPropuestas(curadorId, wsC);
      const ofrecido = panel.candidatas.C5.lista.find((c) => c.id === j.journeyId);
      expect(ofrecido, 'el journey se esconde en vez de decir por qué no se puede').toBeDefined();
      expect(ofrecido!.bloqueo).toMatch(/cierra las más claras a mano/);

      // …y forzarlo tampoco gasta, con EL MISMO texto: una sola redacción, dos caminos.
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      await conProveedor(
        { ok: true, datos: {}, intentos: [intento({ uso: null })] },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
          ).rejects.toThrow(ofrecido!.bloqueo!);
        },
      );
      const [despues] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(despues!.n, 'no se abrió ninguna línea: la llamada no se despachó').toBe(antes!.n);
    });
  });

  /**
   * Lo que el RECORTE se llevó no cuenta como presente.
   *
   * El cuerpo del material se trunca ENTERO a `MAX_MATERIAL`, así que de una evidencia puede
   * haber llegado al modelo un trozo, o nada. La primera versión del pajar por evidencia
   * recomponía la línea del documento aparte, y eso reinicia el presupuesto desde cero: un
   * fragmento de la parte cortada —texto que el modelo NUNCA VIO— salía en verde, que es
   * exactamente lo contrario de lo que la presencia literal existe para decir.
   *
   * Se monta una evidencia larga que agota el presupuesto y una segunda que queda entera
   * fuera. Las dos mitades: lo que sí llegó sale presente, y lo que se cortó no.
   */
  it('un fragmento que el recorte dejó fuera del prompt no sale como presente', async () => {
    await enWorkspaceLimpio('c2-recorte', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const COLA = 'esta frase queda al final del documento largo';
      const primera = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'AAA documento largo',
        resumen: `${'x'.repeat(MAX_MATERIAL)} ${COLA}`,
      });
      const segunda = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'BBB documento que no cabe',
        resumen: 'este documento entero queda fuera del recorte',
      });

      const contenido: ContenidoInsight = {
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [
              // Del principio de la primera: sí llegó.
              { evidenciaId: primera, fragmento: 'xxxxxxxxxx', localizacion: 'resumen' },
              // Del final de la primera: el recorte se lo llevó.
              { evidenciaId: primera, fragmento: COLA, localizacion: 'resumen' },
              // Y la segunda no llegó en absoluto.
              {
                evidenciaId: segunda,
                fragmento: 'este documento entero queda fuera',
                localizacion: 'resumen',
              },
            ],
          },
        ],
        contradicciones: [],
        confianzaPropuesta: 'media',
      };
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      expect(p.citas.map((c) => c.presenteLiteral)).toEqual([true, false, false]);
    });
  });

  /**
   * Revocar los derechos de UNA evidencia entre preparar y despachar para la llamada.
   *
   * La revalidación preguntaba `exists (… evidencia_usable …)`, y esa pregunta pasa aunque la
   * evidencia a la que acaban de revocarle los derechos sea justo una de las que el prompt YA
   * LLEVA DENTRO: el bloque se armó en la transacción anterior y saldría igual hacia el
   * proveedor. Con dos evidencias y una revocada, la vieja comprobación decía «queda una» y
   * despachaba el documento revocado.
   *
   * Se usa el hueco REAL —`antesDelApunte`, que es el instante con la autorización ya leída y
   * ni un byte todavía en el aire— y se mide por el LIBRO: lo que hay que probar es que NO se
   * despachó, no que la llamada fallara después.
   */
  it('revocar los derechos de una evidencia entre preparar y despachar para la llamada', async () => {
    await enWorkspaceLimpio('c2-derechos-en-vuelo', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const a = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'AAA la que se queda',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const b = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'BBB la que se revoca',
        resumen: 'Quien abandona dice que no sabía qué documento subir.',
      });

      let despachos = 0;
      proveedor.antesDelApunte = async () => {
        // Denegar exige decisión completa (`derecho_decision_completa`): quién, cuándo y con
        // qué base. Un `denegado` a medias lo rechaza la base, y con razón.
        await admin`update derecho_uso
          set estado = 'denegado', ambito = 'interno', base = 'El participante retiró el permiso',
              decidido_por = ${curadorId}, decidido_en = now()
          where evidencia_id = ${b} and workspace_id = ${wsC}`;
      };
      proveedor.duranteLlamada = async () => {
        despachos += 1;
      };
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      try {
        await conProveedor(
          { ok: true, datos: { insights: [] }, intentos: [intento({ uso: null })] },
          async () => {
            await expect(
              generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
            ).rejects.toThrow(/cambió mientras se preparaba/);
          },
        );
      } finally {
        proveedor.antesDelApunte = null;
        proveedor.duranteLlamada = null;
      }

      // Ni un byte en el aire, y sin línea en el libro: no se abre para una llamada que no
      // ocurre. Con la comprobación vieja, la evidencia `a` seguía siendo utilizable y esto
      // habría despachado el prompt con `b` dentro.
      expect(despachos, 'se despachó el material con la evidencia revocada dentro').toBe(0);
      const [tras] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(tras!.n).toBe(antes!.n);
      // Y la evidencia que se quedó sigue siendo utilizable: sin esto, el caso podría estar
      // pasando por «el reto se quedó sin evidencia», que es otra regla.
      //
      // Se pregunta CON CONTEXTO DE USUARIO y no con la conexión de administración: la primera
      // línea de `evidencia_usable` es `is_workspace_member(app_user_id(), …)`, y para el
      // administrador `app_user_id()` es nulo — la respuesta sería `false` siempre, y esta
      // sonda diría lo contrario de lo que quiere decir.
      const [usable] = await conUsuario(curadorId, (tx) => tx`
        select evidencia_usable(${a}::uuid, ${wsC}::uuid, 'cliente') as x`);
      expect(usable!.x).toBe(true);
    });
  });

  /**
   * Un grafo editado ENTRE preparar y despachar no llega al proveedor.
   *
   * Esta comparación existía —en `COMPROBAR.C5`—, y allí llega tarde: para entonces la llamada
   * ya salió, ya se pagó y ya está en el libro. Lo único que miraba antes de despachar era que
   * al journey le quedara alguna señal abierta, y eso no dice nada del grafo: renombrar un
   * nodo o mover una transición lo cambia entero dejando las señales idénticas. El resultado
   * era determinista, no una carrera improbable: cualquiera que editara el grafo en ese hueco
   * hacía pagar una llamada cuyo informe se iba a descartar a continuación.
   *
   * Se mide por el LIBRO. El mensaje solo diría que ALGO se rechazó, y las dos versiones lo
   * rechazan; lo que separa la de antes de la de ahora es si se abrió una línea de gasto.
   *
   * Y se renombra un nodo, no se añade uno: las señales quedan EXACTAMENTE iguales —se
   * comprueba abajo—, de modo que la puerta que ya existía no puede ser la que rechaza.
   */
  it('un grafo editado entre preparar y despachar no llega al proveedor', async () => {
    await enWorkspaceLimpio('c5-editado-antes-de-despachar', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const admin = sqlAdmin();
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;

      // El hueco ANTES del apunte: la autorización ya está leída y ni un byte en el aire.
      proveedor.antesDelApunte = async () => {
        await admin`update journey_nodo set etiqueta = 'Comprobar quién eres'
          where id = ${j.nodos.dos} and workspace_id = ${wsC}`;
      };
      try {
        await conProveedor(
          {
            ok: true,
            datos: informeCompleto(senales) as unknown as Record<string, unknown>,
            intentos: [intento({ uso: null })],
          },
          async () => {
            await expect(
              generarPropuestas(curadorId, {
                workspaceId: wsC,
                capacidad: 'C5',
                anclaId: j.journeyId,
              }),
            ).rejects.toThrow(/cambió mientras se preparaba/);
          },
        );
      } finally {
        proveedor.antesDelApunte = null;
      }

      const [despues] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(despues!.n, 'no se abrió ninguna línea: la llamada no se despachó').toBe(antes!.n);
      const quedan = await conUsuario(curadorId, (tx) => tx`
        select count(*)::int as n from propuesta_ai
        where workspace_id = ${wsC} and journey_id = ${j.journeyId}`);
      expect(quedan[0]!.n).toBe(0);
      // Las señales son las MISMAS: sin esto, el caso podría estar pasando por la puerta que
      // ya existía —«se cerraron las señales»— y no probaría nada nuevo.
      expect(await senalesDe(curadorId, wsC, j.journeyId)).toEqual(senales);
    });
  });


  /**
   * Un uuid en MAYÚSCULA es el mismo uuid, y aceptarlo tiene que funcionar igual.
   *
   * `z.string().uuid()` admite el hexadecimal en mayúscula y Postgres almacena la forma
   * canónica —minúscula—. Un id válido copiado así pasaba la validación, pasaba el guard del
   * insert (que compara con `lower(...)` en su alcance) y luego no encontraba nada: el guard
   * diferido compara el id propuesto contra el almacenado tal cual, así que CADA intento de
   * aceptar esa propuesta —por lo demás perfecta— se deshacía entero, y quien revisa se
   * encontraba una tarjeta que no se deja aceptar sin ninguna razón visible.
   *
   * Se comprueba el camino completo hasta el objeto materializado, y de paso el otro lado
   * silencioso del mismo defecto: el mapa de etiquetas del panel se indexa por el id que
   * devuelve la base, así que una clave en mayúscula tampoco acertaba ninguna.
   */
  it('un evidenciaId en mayúscula se acepta igual: el id se normaliza al parsear', async () => {
    await enWorkspaceLimpio('c2-uuid-en-mayuscula', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia en mayúscula',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const gritado = ev.toUpperCase();
      // El fixture tiene que ser el caso: si el uuid no tuviera letras, esto no probaría nada.
      expect(gritado).not.toBe(ev);

      const contenido = CONTENIDO_C2(gritado);
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      // Guardado en canónico, no como vino.
      expect((p.contenido as ContenidoInsight).afirmaciones[0]!.citas[0]!.evidenciaId).toBe(ev);
      // Y el panel sabe de qué documento habla la cita, que es el otro lado del mismo defecto.
      expect(p.etiquetas[ev]).toBe('La evidencia en mayúscula');

      const { objetoId } = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: p.id,
      });
      const [cita] = await sqlAdmin()`select c.evidencia_id from cita c
        join afirmacion a on a.id = c.afirmacion_id and a.workspace_id = c.workspace_id
        where a.insight_id = ${objetoId} and a.workspace_id = ${wsC}`;
      expect(cita!.evidencia_id).toBe(ev);
    });
  });

  /**
   * El SELLO de procedencia no se puede escribir desde la aplicación.
   *
   * `insight.propuesta_ai_id` es lo que hace que un insight diga de qué propuesta viene
   * (SYS-19), y el comentario de la migración decía que la columna estaba «fuera de todo
   * grant». No lo estaba: `insight` tenía un `grant insert` DE TABLA, y un grant de tabla
   * cubre también las columnas futuras — así que añadir la columna se la regalaba al llamante.
   * Medido antes de arreglarlo: `designio_app` bajo un curador insertaba un insight escrito a
   * mano sellado contra una propuesta PENDIENTE, incluso de otra capacidad, y se quedaba con
   * dos cosas que no eran suyas: la proveniencia y la plaza única del índice, de modo que la
   * aceptación legítima posterior fallaba con «ese objeto ya cuelga de otra propuesta».
   *
   * Es exactamente lo que ya se hizo con `evidencia` y `criterio_exito` cuando les llegó su
   * sello, y el argumento estaba escrito en la misma migración, una tabla más arriba.
   *
   * Las tres mitades se comprueban juntas porque separadas no dicen nada: que el sello se
   * rechace, que el insight SIN sello siga entrando —lo que se cierra es la columna, no la
   * tabla— y que la aceptación legítima siga sellando, que es lo que el guard hace y este
   * grant no puede estorbar.
   */
  it('un insight escrito a mano no puede sellarse con la procedencia de una propuesta', async () => {
    await enWorkspaceLimpio('c2-sello-fuera-del-grant', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia del sello',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      await conProveedor(
        { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;

      await expect(
        conUsuario(curadorId, (tx) => tx`insert into insight
          (workspace_id, titulo, resumen, estado, creado_por, propuesta_ai_id)
          values (${wsC}, 'Insight escrito a mano', '', 'propuesto', ${curadorId}, ${p.id})`),
        'la aplicación puede firmar una procedencia que no ocurrió',
      ).rejects.toThrow(/permission denied/i);

      // Sin la columna sí entra: un insight a mano es una cosa legítima, lo que no lo es es
      // que diga venir de una propuesta.
      await conUsuario(curadorId, (tx) => tx`insert into insight
        (workspace_id, titulo, resumen, estado, creado_por)
        values (${wsC}, 'Insight escrito a mano', '', 'propuesto', ${curadorId})`);

      // Y la aceptación legítima sella igual: el guard es `security definer` y el grant del
      // llamante no le quita nada.
      const { objetoId } = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: p.id,
      });
      const [sellado] = await sqlAdmin()`select propuesta_ai_id from insight
        where id = ${objetoId} and workspace_id = ${wsC}`;
      expect(sellado!.propuesta_ai_id).toBe(p.id);
    });
  });
  /**
   * Un derecho CADUCADO para el reloj de pared no sale hacia el proveedor, y lo dice por su
   * nombre.
   *
   * Todo lo demás que puede invalidar el material lo escribe alguien, y por eso los candados de
   * la revalidación lo ordenan. La caducidad llega sola, sin tomar ningún candado — y
   * `evidencia_usable` la mide con `current_date`, que es la fecha de INICIO de la transacción
   * y no avanza aunque la transacción espere.
   *
   * Lo que esta sonda mide es la mitad reproducible: que la caducidad se caza en la
   * revalidación con su PROPIO mensaje, y no disuelta en el genérico de «la evidencia cambió»
   * —que manda a buscar a un culpable que aquí no existe y propone la salida equivocada—. La
   * otra mitad, que la comparación use el reloj de pared y no el de la transacción, no se puede
   * montar en la suite sin cruzar la medianoche de verdad: va argumentada en el código, no
   * probada aquí, y conviene decirlo en vez de dejarlo pasar.
   */
  it('un derecho caducado se caza antes de despachar, con su propio motivo', async () => {
    await enWorkspaceLimpio(
      'c2-derecho-caducado',
      async ({ ws: wsC, curadorId, retoId: retoC }) => {
        const admin = sqlAdmin();
        // DOS documentos: uno vigente, que es lo que mantiene al reto con material citable —si
        // caducara el único, el rechazo lo daría la puerta de «este reto no tiene evidencia
        // citable» y esta sonda no llegaría a medir lo suyo—, y otro caducado.
        const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
          titulo: 'La evidencia vigente',
          resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
        });
        const caduca = await evidenciaDelReto(wsC, retoC, curadorId, {
          titulo: 'La evidencia con fecha',
          resumen: 'Un permiso que vence hoy.',
        });
        // Vence HOY, que es el caso donde las dos preguntas discrepan: `evidencia_usable` dice
        // que sí —hoy todavía se puede citar— y este camino dice que no, porque mañana, cuando
        // alguien revise, ya no. Con «ayer» la sonda no mediría esto: el documento saldría del
        // material y el rechazo lo daría la puerta de «este reto no tiene evidencia citable».
        await admin`update derecho_uso set vence_en = current_date
          where evidencia_id = ${caduca} and workspace_id = ${wsC}`;
        // Por el rol de aplicación y no por administración: `evidencia_usable` lleva su propio
        // anti-oráculo —`is_workspace_member(app_user_id(), …)`— y sin contexto de usuario
        // contesta `false` a todo, así que preguntarla con `sqlAdmin()` mediría eso y no esto.
        const [sigueCitable] = await conUsuario(
          curadorId,
          (tx) => tx`select evidencia_usable(${caduca}, ${wsC}, 'cliente') as usable`,
        );
        expect(sigueCitable!.usable, 'el supuesto de la sonda: hoy todavía es citable').toBe(true);

        const [antes] = await admin`select count(*)::int as n from llamada_ai
          where workspace_id = ${wsC}`;
        await conProveedor(
          {
            ok: true,
            datos: { insights: [CONTENIDO_C2(ev)] },
            intentos: [intento({ uso: null })],
          },
          async () => {
            await expect(
              generarPropuestas(curadorId, {
                workspaceId: wsC,
                capacidad: 'C2',
                anclaId: retoC,
              }),
            ).rejects.toThrow(/vence hoy/);
          },
        );
        const [tras] = await admin`select count(*)::int as n from llamada_ai
          where workspace_id = ${wsC}`;
        expect(tras!.n, 'se apuntó una llamada que no se hizo').toBe(antes!.n);
      },
    );
  });

  /**
   * El alcance que se sella dice lo que el modelo LEYÓ, no lo que se consultó para él.
   *
   * El cuerpo de C2 es la concatenación de todos los documentos del reto y se recorta ENTERO a
   * `MAX_MATERIAL`: pasado ese punto, la cola se queda fuera —el documento en el que cae el
   * corte, a medias; los siguientes, del todo—. Y media evidencia no es una evidencia leída: la
   * contradicción que el análisis tenía que encontrar puede estar justo en el trozo cortado.
   */
  it('el alcance del material solo apunta la evidencia que llegó entera', () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const llegado = evidenciaQueLlegoAlModelo({
      codigo: 'R-01',
      titulo: 'Reto',
      descripcion: 'Formulación del reto',
      evidencia: [
        { id: id(1), titulo: 'A', resumen: 'a'.repeat(100) },
        // En ésta cae el corte: llega a medias, y a medias no cuenta.
        { id: id(2), titulo: 'B', resumen: 'b'.repeat(MAX_MATERIAL) },
        // Y ésta no llega en absoluto.
        { id: id(3), titulo: 'C', resumen: 'c'.repeat(100) },
      ],
    });
    expect(llegado.ids).toEqual([id(1)]);
    expect(llegado.fuera).toBe(2);
    expect(llegado.caracteres).toBeGreaterThan(MAX_MATERIAL);
  });

  /**
   * Y el alcance que se GUARDA deja fuera lo que el recorte no dejó llegar, así que el sello
   * no se puede dar.
   *
   * El recorte no es un error —el prompt se lo dice al modelo y el panel mide cada cita contra
   * el trozo que sobrevivió—, así que la propuesta se genera y se revisa igual. Lo que no puede
   * pasar es que el alcance MIENTA: apuntando todo lo consultado, el guard diferido comparaba
   * la evidencia de hoy con una lista que decía haberla visto entera, y sellaba unos insights
   * que no pudieron encontrar la contradicción que estaba en el trozo cortado. Con el alcance
   * honesto, quien intenta aceptarlos se topa con el suelo — que es donde tenía que pararse.
   */
  it('el alcance guardado excluye la evidencia que el recorte dejó fuera, y sin ella no se sella', async () => {
    await enWorkspaceLimpio(
      'c2-alcance-tras-el-recorte',
      async ({ ws: wsC, curadorId, retoId: retoC }) => {
        const admin = sqlAdmin();
        const cabe = await evidenciaDelReto(wsC, retoC, curadorId, {
          titulo: 'AAA la que sí cabe',
          resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
        });
        // Ordena DESPUÉS —el material va por título— y se lleva el cuerpo por delante del
        // techo, así que es ella la que el recorte se come.
        const noCabe = await evidenciaDelReto(wsC, retoC, curadorId, {
          titulo: 'ZZZ la que se queda fuera',
          resumen: 'Relato del participante sin parar. '.repeat(700),
        });

        await conProveedor(
          {
            ok: true,
            datos: { insights: [CONTENIDO_C2(cabe)] },
            intentos: [intento({ uso: null })],
          },
          () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
        );

        const [guardada] = await admin`select id, alcance_evidencia from propuesta_ai
          where workspace_id = ${wsC} and capacidad = 'C2'`;
        expect(guardada, 'no se generó la propuesta').toBeDefined();
        expect(
          guardada!.alcance_evidencia,
          'el alcance apuntó un documento que el recorte no dejó llegar',
        ).toEqual([cabe]);
        expect(guardada!.alcance_evidencia).not.toContain(noCabe);

        // Y el panel lo DICE, en vez de ofrecer un botón que siempre vuelve: el guard rechaza
        // esa aceptación de forma determinista, así que una tarjeta «disponible» sería una
        // tarjeta aceptable que no se deja aceptar.
        const p = (await panelPropuestas(curadorId, wsC)).pendientes.find(
          (x) => x.capacidad === 'C2',
        )!;
        expect(p.anclaEstado, 'el panel ofrece aceptar algo que no se puede aceptar').toBe(
          'alcance-incompleto',
        );

        // Y no es decoración: aceptar falla de verdad, que es lo que el estado anuncia.
        await expect(
          aceptarPropuesta(curadorId, { workspaceId: wsC, propuestaId: guardada!.id as string }),
        ).rejects.toThrow(/no llegaron a ver/);
      },
    );
  });

  /**
   * Un journey cuya TOPOLOGÍA A REMEDIAR no cabe en el material no se ofrece ni se despacha.
   *
   * Que las señales sobrevivan al recorte fue media corrección. El encargo es «di cómo cerrar
   * cada una de estas N señales», y eso es irrespondible sin el nodo de cada señal y sin ver
   * por dónde se entra y se sale de él: en un grafo grande, el modelo recibía «el paso X no
   * tiene salida» sin el paso X y sin una sola transición. El contrato le exige una
   * remediación por señal igual, así que la única salida que le quedaba era inventarla — y
   * `COMPROBAR.C5` la acepta, porque cubre exactamente la señal que se le pidió.
   *
   * `nucleoDeRemediacion` pone ese núcleo delante, así que sobrevive salvo que él SOLO ya no
   * quepa. Ese caso —el que aquí se fabrica poniendo el cuerpo largo en el nodo señalado— se
   * dice antes de gastar y no se ofrece en la cola, que es el mismo criterio que el techo de
   * señales de arriba: no ofrecer lo que la admisión va a rechazar.
   */
  it('un journey cuya topología a remediar no cabe no se ofrece ni llega al proveedor', async () => {
    await enWorkspaceLimpio('c5-nucleo-que-no-cabe', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const admin = sqlAdmin();
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      expect(senales.length).toBeGreaterThan(0);

      // Antes de engordarlo, el journey SÍ se ofrece: es lo que hace que la comprobación de
      // abajo mida el techo del material y no que el fixture nunca estuviera en la cola.
      const cola = await panelPropuestas(curadorId, wsC);
      expect(cola.candidatas.C5.lista.some((c) => c.id === j.journeyId)).toBe(true);

      // El nodo que una señal nombra se lleva el cuerpo largo: el núcleo pasa del techo sin
      // que cambie ni el número de señales ni el de nodos.
      await admin`update journey_nodo set etiqueta = ${'Paso descrito sin parar. '.repeat(1200)}
        where id = ${senales[0]!.nodoId} and workspace_id = ${wsC}`;
      expect(await senalesDe(curadorId, wsC, j.journeyId)).toEqual(senales);

      // Se ofrece MARCADO, no escondido, por lo mismo que el techo de señales.
      const panel = await panelPropuestas(curadorId, wsC);
      const ofrecido = panel.candidatas.C5.lista.find((c) => c.id === j.journeyId);
      expect(ofrecido, 'el journey se esconde en vez de decir por qué no se puede').toBeDefined();
      expect(ofrecido!.bloqueo).toMatch(/sin ver la conectividad que se le pide remediar/);

      // …y forzarlo tampoco gasta, con EL MISMO texto.
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      await conProveedor(
        { ok: true, datos: {}, intentos: [intento({ uso: null })] },
        async () => {
          await expect(
            generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
          ).rejects.toThrow(ofrecido!.bloqueo!);
        },
      );
      const [despues] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(despues!.n, 'no se abrió ninguna línea: la llamada no se despachó').toBe(antes!.n);
    });
  });

  /**
   * Revocar los derechos MIENTRAS la llamada viaja: la respuesta llega, y ninguna propuesta nace.
   *
   * Es el hueco que ningún candado puede cubrir, y el suelo de CI ya lo dice con sus palabras:
   * «el guard lee el registro VIGENTE, así que la propuesta no llega a existir aunque el
   * proveedor ya hubiera respondido». C2 lee otra cosa —el derecho de uso de cada evidencia
   * citada, no el consentimiento de un item—, y sin esa lectura nacía una propuesta que
   * `materializarInsight` iba a rechazar SIEMPRE con DR001 al insertar la cita: una tarjeta
   * aceptable que no se deja aceptar, con un código de error por toda explicación.
   *
   * Y la llamada QUEDA ANOTADA con su coste: el gasto ocurrido se registra aunque su salida se
   * tire. Es la misma regla que en todo el slice, y lo que separa este caso del de arriba —el
   * de la revocación ANTES de despachar, donde no hay línea porque no hubo despacho—.
   *
   * QUIÉN rechaza cambió, y conviene dejarlo dicho porque el mensaje que se espera aquí es
   * otro. Antes llegaba hasta el INSERT de la cita y lo paraba el suelo con su DR001
   * traducido; ahora lo corta antes `COMPROBAR.C2`, que compara la huella del material dentro
   * de la transacción que va a escribir. Es mejor por dos motivos: llega antes —sin intentar
   * escribir nada— y su mensaje dice qué hacer con la propuesta, que es lo que una restricción
   * de la base no puede decir. El suelo NO se queda sin sonda: lo pinta «una revocación en
   * vuelo impide que nazca una propuesta ya muerta», que escribe la fila por SQL directo y no
   * pasa por el servicio.
   */
  it('revocar los derechos con la llamada en vuelo: la propuesta de C2 no llega a nacer', async () => {
    await enWorkspaceLimpio('c2-derechos-tras-despachar', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia que se revoca en vuelo',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;

      // El hueco con el material YA despachado: la línea del libro está abierta y los bytes
      // en el aire. Lo que se promete no es deshacer el envío, es que de él no nazca nada.
      proveedor.duranteLlamada = async () => {
        await admin`update derecho_uso
          set estado = 'denegado', ambito = 'interno', base = 'El participante retiró el permiso',
              decidido_por = ${curadorId}, decidido_en = now()
          where evidencia_id = ${ev} and workspace_id = ${wsC}`;
      };
      try {
        await conProveedor(
          {
            ok: true,
            datos: { insights: [CONTENIDO_C2(ev)] },
            intentos: [intento({ uso: null })],
          },
          async () => {
            await expect(
              generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
            ).rejects.toThrow(/cambió mientras el proveedor respondía/);
          },
        );
      } finally {
        proveedor.duranteLlamada = null;
      }

      const propuestas = await conUsuario(curadorId, (tx) => tx`
        select 1 as x from propuesta_ai
        where workspace_id = ${wsC} and reto_id = ${retoC}`);
      expect(propuestas.length, 'nació una propuesta que aceptar fallaría siempre').toBe(0);
      // Y la llamada, que se pagó, queda: registrar el gasto no depende de que el resultado
      // llegue a usarse. Sin esta mitad, un rechazo ANTES de despachar pasaría igual.
      const [tras] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(tras!.n).toBeGreaterThan(antes!.n);
    });
  });

  /**
   * Y una evidencia que se enlaza MIENTRAS el proveedor responde.
   *
   * El candado previo al despacho se suelta al commitear el apunte, y la llamada viaja fuera
   * de toda transacción —a propósito: un tercero lento no retiene una conexión—. En ese hueco
   * cabe enlazar evidencia nueva al reto. La propuesta vuelve, se persiste y se acepta sin
   * haber visto ese documento.
   *
   * Y no lo tapaba nada de lo que ya había, aunque el comentario de `COMPROBAR.C2` afirmara lo
   * contrario: los guards de la base comprueban la evidencia que la respuesta SÍ citó —que sea
   * del reto, que tenga derechos— y la materialización compara la descendencia contra lo
   * propuesto. Las tres cosas son ciertas y ninguna mira lo que la respuesta NO PUDO citar.
   * En C2 eso importa el doble: el documento que llega tarde puede ser justo el que
   * CONTRADICE el insight, que es lo que I4 existe para no dejar esconder.
   *
   * Es lo mismo que C5 hace con su grafo, por el mismo canal (`huellaMaterial`) y a la misma
   * altura del pipeline. Que una de las dos lo usara y la otra no era divergencia entre
   * hermanos, no una diferencia de fondo.
   */
  it('una evidencia enlazada mientras responde el proveedor impide guardar la propuesta', async () => {
    await enWorkspaceLimpio('c2-enlace-mientras-responde', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const [arqNuevo] = await admin`insert into arquetipo
        (workspace_id, reto_id, nombre, definicion, creado_por)
        values (${wsC}, ${retoC}, 'Arquetipo tardío', 'Definición', ${curadorId}) returning id`;
      const [fte] = await admin`insert into fuente
        (workspace_id, tipo, titulo, referencia, creado_por)
        values (${wsC}, 'documento', 'La contradicción', 'ref', ${curadorId}) returning id`;
      const [ev2] = await admin`insert into evidencia
        (workspace_id, fuente_id, titulo, resumen, dimensiones, creado_por)
        values (${wsC}, ${fte!.id as string}, 'La contradicción',
                'En cambio el 12% dice que el documento nunca fue el problema.', '{}'::jsonb,
                ${curadorId}) returning id`;
      await admin`insert into derecho_uso
        (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
        values (${wsC}, ${ev2!.id as string}, 'concedido', 'cliente', 'Consentimiento',
                ${curadorId}, now(), ${curadorId})`;

      const [antes] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      // El hueco con el material YA despachado: el apunte commiteó y soltó sus candados.
      proveedor.duranteLlamada = async () => {
        await admin`insert into arquetipo_evidencia (workspace_id, arquetipo_id, evidencia_id)
          values (${wsC}, ${arqNuevo!.id as string}, ${ev2!.id as string})`;
      };
      try {
        await conProveedor(
          { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
          async () => {
            await expect(
              generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
            ).rejects.toThrow(/cambió mientras el proveedor respondía/);
          },
        );
      } finally {
        proveedor.duranteLlamada = null;
      }

      // Ni una propuesta armada sin ver el documento que ya sostenía al reto…
      const propuestas = await admin`select 1 from propuesta_ai
        where workspace_id = ${wsC} and reto_id = ${retoC}`;
      expect(propuestas.length).toBe(0);
      // …y la llamada SÍ queda anotada: el gasto ocurrió aunque su salida se tire. Es la misma
      // regla que en todo el slice, y lo que separa este caso del de antes de despachar.
      const [tras] = await admin`select count(*)::int as n from llamada_ai
        where workspace_id = ${wsC}`;
      expect(tras!.n).toBe(antes!.n + 1);
    });
  }, 20000);

  /**
   * El grafo puede cambiar SIN que cambien sus señales, y el informe deja de describirlo.
   *
   * La huella cubría solo las claves `(nodoId, codigo)`, y eso es la mitad: renombrar un nodo,
   * cambiar la condición de una transición o rehacer la topología de alrededor deja las mismas
   * señales y cambia todo lo que el consejo describe. Quien lee entonces una remediación que
   * habla de «Verificar identidad» sobre un nodo que ahora se llama otra cosa no tiene manera
   * de saber que está leyendo sobre un grafo que ya no existe.
   *
   * Se renombra un nodo a mitad de la llamada: las señales quedan idénticas —se comprueba— y
   * el informe se descarta igual.
   */
  it('un informe se descarta si el grafo cambió aunque sus señales sean las mismas', async () => {
    await enWorkspaceLimpio('c5-grafo-renombrado', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      const admin = sqlAdmin();

      proveedor.duranteLlamada = async () => {
        await admin`update journey_nodo set etiqueta = 'Comprobar quién eres'
          where id = ${j.nodos.dos} and workspace_id = ${wsC}`;
      };
      try {
        await conProveedor(
          {
            ok: true,
            datos: informeCompleto(senales) as unknown as Record<string, unknown>,
            intentos: [intento({ uso: null })],
          },
          async () => {
            await expect(
              generarPropuestas(curadorId, {
                workspaceId: wsC,
                capacidad: 'C5',
                anclaId: j.journeyId,
              }),
            ).rejects.toThrow(/cambió mientras se generaba/);
          },
        );
      } finally {
        proveedor.duranteLlamada = null;
      }

      // Y las señales eran EXACTAMENTE las mismas: sin esto, el caso podría estar pasando por
      // el mismo camino que el de «las señales se cerraron» y no probaría nada nuevo.
      expect(await senalesDe(curadorId, wsC, j.journeyId)).toEqual(senales);
    });
  });


  /**
   * Y si los derechos se caen DESPUÉS, el panel lo dice en vez de ofrecer lo imposible.
   *
   * El guard del insert cubre lo de antes de nacer; entre nacer y revisarse cabe la vida
   * entera de un derecho de uso —se retira, caduca, el documento se va—. El estado del ancla
   * de C2 era «archivado o disponible», así que la pantalla habilitaba aceptar y corregir, y
   * aceptar falla SIEMPRE: `evidencia_citable_guard` rechaza la cita con DR001. Es el
   * equivalente exacto del `consentimiento-revocado` de CI.
   *
   * Se comprueba de los dos lados: que el panel lo diga, y que aceptar de verdad falle. Sin lo
   * segundo el estado sería una decoración; sin lo primero, quien revisa se lo encuentra a
   * golpes.
   */
  it('una propuesta de C2 cuya evidencia dejó de ser citable se marca en el panel', async () => {
    await enWorkspaceLimpio('c2-derechos-tras-nacer', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const admin = sqlAdmin();
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia que se revoca después',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      await conProveedor(
        { ok: true, datos: { insights: [CONTENIDO_C2(ev)] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );

      // Recién nacida, la propuesta es aceptable: sin esto, el caso podría estar midiendo un
      // fixture que nunca estuvo disponible.
      const recien = await panelPropuestas(curadorId, wsC);
      expect(recien.pendientes.find((x) => x.capacidad === 'C2')!.anclaEstado).toBe('disponible');

      await admin`update derecho_uso
        set estado = 'denegado', ambito = 'interno', base = 'El participante retiró el permiso',
            decidido_por = ${curadorId}, decidido_en = now()
        where evidencia_id = ${ev} and workspace_id = ${wsC}`;

      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      expect(p.anclaEstado, 'el panel ofrece aceptar algo que no se puede aceptar').toBe(
        'evidencia-no-citable',
      );
      // Y no es una decoración: aceptar falla de verdad, que es lo que el estado anuncia.
      await expect(
        aceptarPropuesta(curadorId, { workspaceId: wsC, propuestaId: p.id }),
      ).rejects.toThrow(/DR001|derecho/i);

      // Y cuando el derecho vuelve, la propuesta vuelve a poder aceptarse sin tocar nada: el
      // estado se calcula vivo, no se marca en la fila.
      await admin`update derecho_uso
        set estado = 'concedido', ambito = 'cliente', base = 'El participante lo autoriza de nuevo'
        where evidencia_id = ${ev} and workspace_id = ${wsC}`;
      const vuelta = await panelPropuestas(curadorId, wsC);
      expect(vuelta.pendientes.find((x) => x.capacidad === 'C2')!.anclaEstado).toBe('disponible');
    });
  });
  /**
   * Un informe ya escrito se marca OBSOLETO cuando alguien cierra sus señales después.
   *
   * `COMPROBAR.C5` solo corre al escribir, y entre escribir y revisar cabe la vida entera del
   * grafo —incluido el desenlace bueno, que alguien arregle lo que el informe señalaba—. El
   * estado del ancla de C5 era la constante «disponible», así que la pantalla no avisaba
   * nunca, mientras CT sí avisa de su equivalente: quien revisa podía aplicar un consejo que
   * ya no describe el journey.
   *
   * No se puede preguntar en SQL —las señales son una función pura del grafo—, así que se
   * calcula sobre la misma fila que el panel ya trae, sin abrir ninguna consulta más.
   */
  it('un informe cuyas señales se cerraron después se marca obsoleto en el panel', async () => {
    await enWorkspaceLimpio('c5-informe-obsoleto', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      await conProveedor(
        {
          ok: true,
          datos: informeCompleto(senales) as unknown as Record<string, unknown>,
          intentos: [intento({ uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
      );

      // Recién nacido, el informe describe el grafo que hay.
      const antes = await panelPropuestas(curadorId, wsC);
      const informe = antes.pendientes.find((x) => x.capacidad === 'C5')!;
      expect(informe.anclaEstado).toBe('disponible');
      // Y ya dice a QUÉ nodo aplica cada remediación: sin esto, media docena de tarjetas con
      // el mismo código de señal son indistinguibles.
      expect(informe.etiquetas[j.nodos.dos]).toBe('Verificar identidad');

      // Alguien arregla el grafo a mano — que es lo que el informe pedía.
      const admin = sqlAdmin();
      await admin`delete from journey_arista where journey_id = ${j.journeyId}`;
      await admin`delete from journey_nodo where journey_id = ${j.journeyId}`;

      const despues = await panelPropuestas(curadorId, wsC);
      const obsoleto = despues.pendientes.find((x) => x.capacidad === 'C5')!;
      expect(
        obsoleto.anclaEstado,
        'el informe sigue diciéndose al día sobre un grafo que ya no es el suyo',
      ).toBe('journey-cambiado');
    });
  });

  /**
   * Y también cuando el grafo cambia SIN que cambien sus señales.
   *
   * La primera versión de este aviso comparaba las claves `(nodoId, codigo)` de lo que el
   * informe remedia, y eso es la mitad —la misma mitad que ya se corrigió del otro lado, en la
   * comprobación de la escritura—: renombrar un nodo, cambiar la condición de una transición o
   * rehacer la topología de alrededor las deja idénticas y cambia todo lo que el consejo
   * describe. Quien lee una remediación sobre «Verificar identidad» no tiene manera de saber
   * que ese nodo se llama otra cosa.
   *
   * Se compara contra la HUELLA guardada al nacer la propuesta, que es lo que hace la pregunta
   * respondible meses después. Y se comprueba que las señales siguen siendo las mismas: sin
   * eso, este caso podría estar pasando por el camino del anterior.
   */
  it('un informe se marca obsoleto si el grafo cambió aunque sus señales sigan iguales', async () => {
    await enWorkspaceLimpio('c5-obsoleto-por-renombre', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      await conProveedor(
        {
          ok: true,
          datos: informeCompleto(senales) as unknown as Record<string, unknown>,
          intentos: [intento({ uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
      );
      const antes = await panelPropuestas(curadorId, wsC);
      expect(antes.pendientes.find((x) => x.capacidad === 'C5')!.anclaEstado).toBe('disponible');

      await sqlAdmin()`update journey_nodo set etiqueta = 'Comprobar quién eres'
        where id = ${j.nodos.dos} and workspace_id = ${wsC}`;
      // Las señales, idénticas: lo único que cambió es lo que el consejo describe.
      expect(await senalesDe(curadorId, wsC, j.journeyId)).toEqual(senales);

      const despues = await panelPropuestas(curadorId, wsC);
      expect(
        despues.pendientes.find((x) => x.capacidad === 'C5')!.anclaEstado,
        'el informe se dice al día sobre un grafo que se renombró bajo sus pies',
      ).toBe('journey-cambiado');
    });
  });

  /**
   * Y el evento de la aceptación dice QUÉ insight se creó.
   *
   * `jsonb_strip_nulls` se lleva `evidenciaId` y `criterioId` por nulos, así que sin
   * `insightId` el evento de una aceptación de C2 no nombraba el objeto que documenta — un
   * registro append-only que no puede decir qué se creó no documenta nada. Es la misma
   * enumeración corta de siempre, esta vez en la bitácora.
   */
  it('el evento de una aceptación de C2 nombra el insight materializado', async () => {
    await enWorkspaceLimpio('c2-evento-insight', async ({ ws: wsC, curadorId, retoId: retoC }) => {
      const ev = await evidenciaDelReto(wsC, retoC, curadorId, {
        titulo: 'La evidencia',
        resumen: 'El 71% de los abandonos ocurre al cargar el documento.',
      });
      const contenido: ContenidoInsight = {
        titulo: 'T',
        resumen: 'R',
        afirmaciones: [
          {
            texto: 'A',
            esHipotesis: false,
            citas: [{ evidenciaId: ev, fragmento: 'El 71% de los abandonos', localizacion: 'resumen' }],
          },
        ],
        contradicciones: [],
        confianzaPropuesta: 'media',
      };
      await conProveedor(
        { ok: true, datos: { insights: [contenido] }, intentos: [intento({ uso: null })] },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C2', anclaId: retoC }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const p = panel.pendientes.find((x) => x.capacidad === 'C2')!;
      const { objetoId } = await aceptarPropuesta(curadorId, {
        workspaceId: wsC,
        propuestaId: p.id,
      });

      const [evento] = await sqlAdmin()`select payload from evento_dominio
        where workspace_id = ${wsC} and tipo = 'PropuestaAIAceptada'
          and payload->>'propuestaId' = ${p.id}`;
      expect(
        (evento!.payload as { insightId?: string }).insightId,
        'el evento no dice qué insight se creó',
      ).toBe(objetoId);
    });
  });
  /**
   * La cola sigue buscando por debajo de los journeys limpios.
   *
   * Filtrar por señales fuera del SQL obliga a paginar el prefiltro: con un `limit` fijo, un
   * workspace cuyos journeys RECIENTES estén todos limpios devolvía la lista vacía y el panel
   * decía «no hay journeys con señales abiertas» —con el aviso de «hay más» en falso— aunque
   * hubiera uno más viejo que sí. Decir «no hay» sin haber mirado es la única respuesta que no
   * se puede dar.
   *
   * El orden de la cola es por fecha descendente, así que el journey con señales se crea
   * PRIMERO y los limpios después: así queda debajo de todos ellos, que es el caso.
   */
  it('la cola encuentra un journey con señales por debajo de varios limpios', async () => {
    await enWorkspaceLimpio('c5-cola-profunda', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const conSenales = await nuevoJourney({ ...ctx, actorId: curadorId });
      for (let i = 0; i < 3; i++) {
        await nuevoJourney({ ...ctx, actorId: curadorId }, { limpio: true });
      }
      expect((await senalesDe(curadorId, wsC, conSenales.journeyId)).length).toBeGreaterThan(0);

      const panel = await panelPropuestas(curadorId, wsC);
      expect(
        panel.candidatas.C5.lista.map((c) => c.id),
        'la cola se paró en los limpios y no llegó al que sí tiene señales',
      ).toContain(conSenales.journeyId);
    });
  });

  /**
   * Las DOS proyecciones del grafo ordenan igual, y por eso la huella es una huella.
   *
   * `leerJourneyCompleto` (que arma el prompt) y la del panel (que lo recompone para saber si
   * el informe sigue al día) alimentan las dos `huellaDelGrafo`. Si ordenan distinto, la huella
   * guardada al generar y la recalculada al pintar difieren sobre un grafo IDÉNTICO: el panel
   * declararía obsoleto un informe que está al día, y la comprobación de escritura rechazaría
   * una respuesta ya pagada por un cambio que no hubo.
   *
   * Ordenar por `(tipo, orden)` no es un orden total: nada impide dos nodos del mismo tipo con
   * el mismo orden —no hay único sobre ellos— y ahí Postgres puede devolverlos en cualquier
   * orden, distinto entre dos lecturas. El fixture crea el empate a propósito; sin él, este
   * caso pasaría con o sin desempate y no mediría nada.
   */
  it('las dos lecturas del grafo producen la MISMA huella, incluso con órdenes empatados', async () => {
    await enWorkspaceLimpio('c5-huella-estable', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const admin = sqlAdmin();
      // Dos pasos más con el MISMO orden que los que ya hay: el empate que el orden por
      // (tipo, orden) no puede deshacer.
      await admin`insert into journey_nodo
        (workspace_id, journey_id, tipo, etiqueta, detalle, orden, responsable, creado_por)
        values (${wsC}, ${j.journeyId}, 'paso', 'Empatado A', '', 0, 'Front', ${curadorId}),
               (${wsC}, ${j.journeyId}, 'paso', 'Empatado B', '', 0, 'Back', ${curadorId})`;

      const leerDosVeces = () =>
        conUsuario(curadorId, async (tx) => {
          const g = await leerJourneyCompleto(tx, wsC, j.journeyId);
          return JSON.stringify({ nodos: g!.nodos, aristas: g!.aristas });
        });
      const delPrompt = await leerDosVeces();
      // Y la del panel, por el camino real: se genera y se lee la fila proyectada.
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      await conProveedor(
        {
          ok: true,
          datos: informeCompleto(senales) as unknown as Record<string, unknown>,
          intentos: [intento({ uso: null })],
        },
        () => generarPropuestas(curadorId, { workspaceId: wsC, capacidad: 'C5', anclaId: j.journeyId }),
      );
      const panel = await panelPropuestas(curadorId, wsC);
      const informe = panel.pendientes.find((x) => x.capacidad === 'C5')!;

      // Si las dos proyecciones no ordenaran igual, el panel diría «cambiado» sobre un grafo
      // que nadie tocó entre las dos lecturas.
      expect(
        informe.anclaEstado,
        'el panel declara obsoleto un informe sobre un grafo que no cambió',
      ).toBe('disponible');
      // Y la lectura del prompt sigue siendo determinista entre dos llamadas seguidas.
      expect(await leerDosVeces()).toBe(delPrompt);
    });
  });

  /**
   * Una propuesta de C5 sin su huella no puede existir.
   *
   * La columna es anulable porque las demás capacidades no la declaran, pero para C5 no hay
   * fila legítima sin ella: la capacidad y la columna llegan en el mismo par de migraciones,
   * así que no hay filas anteriores que perdonar. Sin el CHECK, una escritura directa que la
   * omitiera dejaba un informe que se dice al día PASE LO QUE PASE — `estadoDeLaFila` no puede
   * afirmar nada sin huella, y con razón. Un hueco así no es ruidoso: es silencioso.
   */
  it('una propuesta de C5 sin huella del material la rechaza la base', async () => {
    await enWorkspaceLimpio('c5-sin-huella', async (ctx) => {
      const { ws: wsC, curadorId } = ctx;
      const j = await nuevoJourney({ ...ctx, actorId: curadorId });
      const senales = await senalesDe(curadorId, wsC, j.journeyId);
      const admin = sqlAdmin();
      const [l] = await admin`insert into llamada_ai
        (workspace_id, capacidad, journey_id, modelo, origen_key, resultado, creado_por)
        values (${wsC}, 'C5', ${j.journeyId}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
                ${curadorId}) returning id`;
      const contenido = informeCompleto(senales);
      const escribir = (huella: string | null) =>
        conUsuario(curadorId, (tx) => tx`
          insert into propuesta_ai
            (workspace_id, capacidad, destino, journey_id, contenido, contenido_original,
             confianza, modelo, prompt_version, alcance_resumen, huella_material,
           alcance_evidencia, origen_key,
             llamada_id, creado_por)
          values (${wsC}, 'C5', null, ${j.journeyId}, ${tx.json(contenido)},
                  ${tx.json(contenido)}, 0.6, ${MODELO_PRIMARIO}, ${PROMPT_VERSION}, 'alcance',
                  ${huella}, null, 'entorno', ${l!.id as string}, ${curadorId})
          returning id`);
      await expect(escribir(null)).rejects.toThrow(/propuesta_ai_huella_del_material/);
      // Y con huella entra: sin esta mitad, un CHECK que rechazara todo pasaría igual.
      await expect(escribir('una huella cualquiera')).resolves.toBeDefined();
    });
  });

  /**
   * C6 — el borrador del Metric Registry, propuesto contra los criterios que promete medir.
   *
   * Cinco puertas, y cada una es una regla que la capacidad no comparte con sus hermanas:
   * dónde cuelga, contra qué se mide una cita, qué exige materializar, qué la deja obsoleta y
   * qué NO propone.
   */
  /**
   * La huella REAL del material de un registry, escrita sobre una propuesta del fixture.
   *
   * `nuevaPropuesta` escribe `'huella-del-material'` a propósito —componer el material a mano
   * sería fijar en el fixture el prompt que se está probando—, y eso valía mientras la huella
   * solo apagara el verde de la presencia literal. Desde que además BLOQUEA la aceptación de
   * C6, una propuesta con huella falsa no se puede aceptar y las sondas del pipeline medirían
   * el bloqueo en vez de lo suyo.
   *
   * Se compone llamando a la MISMA función que usa el servicio, no copiándola: lo que el
   * fixture no puede hacer es inventarse el texto, y esto no se lo inventa.
   */
  const conHuellaReal = async (propuestaId: string) => {
    const { huella } = await conUsuario(leadId, (tx) =>
      huellaDelMaterialDelRegistry(tx, ws, registryId),
    );
    await sqlAdmin()`update propuesta_ai set huella_material = ${huella}
      where id = ${propuestaId}`;
    return propuestaId;
  };

  it('C6: la entrada del registry nace del criterio que cita, y se sella con su procedencia', async () => {
    const admin = sqlAdmin();
    const propuestaId = await conHuellaReal(
      await nuevaPropuesta(leadId, { capacidad: 'C6', anclas: { registry_id: registryId } }),
    );

    // 1. El ANCLA es el registry, no el reto: la fila cuelga de la columna que su capacidad
    //    declara, y de ninguna otra. Es lo que `propuesta_ai_un_ancla` impone y lo que el
    //    insert generado desde `COLUMNAS_DE_ANCLA` escribe sin que nadie lo enumere.
    const [fila] = await admin`select registry_id, reto_id, item_id, gate_id, journey_id, destino
      from propuesta_ai where id = ${propuestaId}`;
    expect(fila!.registry_id).toBe(registryId);
    expect([fila!.reto_id, fila!.item_id, fila!.gate_id, fila!.journey_id]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(fila!.destino).toBe('entrada-kpi');

    // 2. Aceptarla crea la entrada, con los seis campos copiados TAL CUAL y los demás
    //    vacíos: el dueño del dato, la línea base y la ventana no los propone la AI.
    const r = await aceptarPropuesta(leadId, { workspaceId: ws, propuestaId });
    const [entrada] = await admin`select * from entrada_kpi where id = ${r.objetoId}`;
    expect(entrada!.registry_id).toBe(registryId);
    expect(entrada!.criterio_id).toBe(criterioDelRegistryId);
    expect(entrada!.nombre).toBe('Tasa de verificación completada en móvil');
    expect(entrada!.frecuencia).toBe('mensual');
    expect(
      [
        entrada!.propietario_miembro_id,
        entrada!.linea_base_valor,
        entrada!.linea_base_fecha,
        entrada!.ventana_inicio,
        entrada!.fecha_post_mortem,
      ],
      'la AI rellenó un compromiso que nadie adquirió',
    ).toEqual([null, null, null, null, null]);
    // 3. Y el SELLO de procedencia, que es la mitad permanente de SYS-19: de qué propuesta
    //    salió esta fila. Lo escribe el guard, no la aplicación — la columna no está en el
    //    grant.
    expect(entrada!.propuesta_ai_id).toBe(propuestaId);
    const [sellada] = await admin`select estado, entrada_kpi_id from propuesta_ai
      where id = ${propuestaId}`;
    expect(sellada!.estado).toBe('aceptada');
    expect(sellada!.entrada_kpi_id).toBe(r.objetoId);
  });

  /**
   * Y el criterio al que responde una entrada NO se corrige.
   *
   * Aquí hubo una contradicción mía: `TESTIMONIO_ADICIONAL.C6` decía `null` —«elegir el
   * criterio equivocado es el error que más se corrige»— y a la vez `CITAS_DEL_CONTENIDO.C6`
   * deriva de ese campo el `alcanceId` de cada cita, que la comparación de la corrección SÍ
   * compara. Las dos reglas decían cosas opuestas y la que ganaba lo hacía por accidente, con
   * el mensaje equivocado: «las citas no se corrigen» sobre una corrección que no las tocaba.
   *
   * Gana el blindaje, y no por resolver el empate hacia el lado estricto: los fragmentos se
   * copiaron de UN criterio, y reapuntarlos a otro conservándolos es quedarse con el sostén de
   * A para afirmar sobre B. Es lo mismo que C2 hace con el `evidenciaId` de sus citas.
   */
  it('C6: el criterio de una entrada no se reapunta al corregir, y el resto sí', async () => {
    const admin = sqlAdmin();
    // Un segundo criterio REAL del mismo reto: el destino al que un revisor querría reapuntar.
    const [otro] = await admin`insert into criterio_exito
      (workspace_id, reto_id, kpi, definicion, objetivo, ventana_dias, linea_base_plan, creado_por)
      values (${ws}, ${retoId}, 'Otro criterio', 'Definición', 'Objetivo', 30, 'Plan', ${leadId})
      returning id`;
    // Con nombre propio: `unique (registry_id, nombre)` es real, y el caso de arriba ya dejó
    // materializada una entrada con el del fixture. Compartir registry entre casos es lo que
    // hace que esa colisión sea una conducta de verdad y no una molestia del arnés.
    const inicial = {
      ...CONTENIDO_C6(criterioDelRegistryId),
      nombre: 'Tasa de verificación completada en escritorio',
    };
    const propuestaId = await conHuellaReal(
      await nuevaPropuesta(leadId, {
        capacidad: 'C6',
        anclas: { registry_id: registryId },
        contenido: inicial,
      }),
    );

    await expect(
      aceptarPropuesta(leadId, {
        workspaceId: ws,
        propuestaId,
        correccion: { ...inicial, criterioId: otro!.id as string },
      }),
    ).rejects.toThrow(/no se corrige/i);

    // Y lo que SÍ es redacción se corrige, que es la otra mitad: sin ella, este caso pasaría
    // igual con la corrección entera tapiada.
    const r = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId,
      correccion: { ...inicial, definicion: 'Verificaciones completas / iniciadas, en móvil' },
    });
    expect(r.estado).toBe('corregida');
    const [entrada] = await admin`select definicion, criterio_id from entrada_kpi
      where id = ${r.objetoId}`;
    expect(entrada!.definicion).toBe('Verificaciones completas / iniciadas, en móvil');
    expect(entrada!.criterio_id).toBe(criterioDelRegistryId);

    // Y el evento de la revisión NOMBRA el objeto creado. La lista de columnas del payload se
    // quedó corta cuando llegó C2 y se volvió a quedar corta con esta: `jsonb_strip_nulls` se
    // lleva las nulas, así que un objeto sin su clave es un registro que no documenta nada.
    const [evento] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'PropuestaAICorregida'
        and payload->>'propuestaId' = ${propuestaId}`;
    expect((evento!.payload as Record<string, unknown>).entradaKpiId).toBe(r.objetoId);

    // Y el SELLO no es una edición. La aceptación inserta la entrada —`EntradaKpiAgregada`,
    // correcto— y el guard diferido le escribe después su `propuesta_ai_id`, que dispara la
    // rama de UPDATE del mismo trigger de auditoría. Medido antes de arreglarlo: cada
    // aceptación de C6 dejaba un `EntradaKpiEditada` con el «antes» idéntico al «después», o
    // sea una edición que nadie hizo, en la única tabla cuyo rastro sirve para decir quién
    // movió el contrato de medición.
    const rastro = await admin`select tipo from evento_dominio
      where workspace_id = ${ws} and payload->>'entradaId' = ${r.objetoId}
      order by creado_en`;
    expect(
      rastro.map((f) => f.tipo),
      'el sello de procedencia se apuntó como una edición del contrato',
    ).toEqual(['EntradaKpiAgregada']);
  });

  /**
   * Y una entrada no puede responder a un criterio que el modelo no llegó a ver ENTERO.
   *
   * El cuerpo es la formulación del reto más todos los criterios, y se recorta ENTERO a
   * `MAX_MATERIAL`: con una descripción larga por delante, la cola se queda fuera —el criterio
   * donde cae el corte, a medias; los siguientes, del todo—. Un `criterioId` de uno de ésos
   * pasa el suelo de la base —el criterio ES del reto del registry, y eso sigue siendo cierto—
   * y sin embargo el KPI no pudo leer la promesa que dice medir.
   *
   * Se mide sobre la función que lo decide y sobre las dos puertas que la consumen.
   */
  it('C6: el recorte del material decide qué criterios se pueden responder', async () => {
    const largo = 'x'.repeat(MAX_MATERIAL);
    const conRecorte = {
      codigo: 'R-01',
      titulo: 'T',
      descripcion: largo,
      criterios: [
        {
          id: 'c3d4e5f6-0000-4000-8000-00000000000a',
          kpi: 'K',
          definicion: 'D',
          objetivo: 'O',
          ventanaDias: 30,
          lineaBasePlan: 'P',
        },
      ],
    };
    // Con la descripción ocupando el presupuesto entero, NINGÚN criterio llega: la lista de
    // los que se pueden responder está vacía y el conteo de los que se quedaron fuera es 1.
    const recortado = criteriosQueLlegaronAlModelo(conRecorte);
    expect(recortado.ids).toEqual([]);
    expect(recortado.fuera).toBe(1);
    // Y sin recorte llegan enteros, que es la otra mitad: sin ella, una función que devolviera
    // siempre la lista vacía pasaría igual.
    const llano = criteriosQueLlegaronAlModelo({ ...conRecorte, descripcion: 'D' });
    expect(llano.ids).toEqual(['c3d4e5f6-0000-4000-8000-00000000000a']);
    expect(llano.fuera).toBe(0);
  });

  /**
   * Y el registry FIRMADO cierra la puerta en los dos momentos que importan: al proponer y al
   * aceptar. Son dos escrituras distintas y entre ellas cabe la firma entera, que es el acto
   * de G6 — una entrada colada en un contrato ya firmado es un KPI que nadie acordó dentro de
   * lo que sí se acordó.
   */
  it('C6: un registry firmado no admite propuestas nuevas ni deja aceptar las pendientes', async () => {
    const admin = sqlAdmin();
    // Una propuesta que nace ANTES de la firma, para medir la segunda mitad.
    const pendiente = await nuevaPropuesta(leadId, {
      capacidad: 'C6',
      anclas: { registry_id: registryId },
    });

    await admin`update metric_registry set estado = 'firmado', firmado_por = ${leadId},
      firmado_en = now() where id = ${registryId}`;
    try {
      // Al PROPONER: el guard del insert lo rechaza aunque la fila venga por SQL directo.
      await expect(
        nuevaPropuesta(leadId, { capacidad: 'C6', anclas: { registry_id: registryId } }),
      ).rejects.toThrow(/ya no admite entradas/);

      // Y al ACEPTAR: la propuesta que ya existía queda obsoleta y solo se puede rechazar.
      await expect(
        aceptarPropuesta(leadId, { workspaceId: ws, propuestaId: pendiente }),
      ).rejects.toThrow(/ya no admite entradas/);

      // Rechazar SÍ sigue abierto: bloquear también esa salida dejaría la fila muerta y su
      // ancla retenida para siempre.
      await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId: pendiente });
      const [tras] = await admin`select estado from propuesta_ai where id = ${pendiente}`;
      expect(tras!.estado).toBe('rechazada');
    } finally {
      await admin`update metric_registry set estado = 'borrador', firmado_por = null,
        firmado_en = null where id = ${registryId}`;
    }
  });

  /**
   * C3 — LA TRAZA ES LA CITA, comprobado en los dos sentidos.
   *
   * `oportunidad_insight` se materializa desde los `insightId` distintos de las citas: no hay
   * una segunda lista que declare el apoyo. Por la superficie SQL concedida se puede escribir
   * la oportunidad y sus enlaces a mano, así que el guard diferido tiene que comprobar que
   * sean EXACTAMENTE los citados — ni uno más ni uno menos.
   *
   * Los dos sentidos importan por razones distintas y por eso se miden por separado:
   *   · uno de MÁS es apoyo que nadie citó, o sea inventado, y el evento lo archiva como si la
   *     AI lo hubiera propuesto;
   *   · uno de MENOS deja la HMW apoyada en menos de lo que su propio texto dice, y ahí lo que
   *     se pierde es la traza que G3 certifica.
   */
  it('C3: la traza de una oportunidad es exactamente lo que citó, ni de más ni de menos', async () => {
    const admin = sqlAdmin();
    // Un segundo insight validado del reto, para poder enlazar «de más».
    const [otro] = await admin`insert into insight
      (workspace_id, titulo, resumen, estado, validado_por, validado_en, creado_por)
      values (${ws}, 'El aviso llega tarde', 'El recordatorio sale cuando ya se fue.',
              'validado', ${leadId}, now(), ${leadId})
      returning id`;
    const otroInsight = otro!.id as string;
    const [af] = await admin`insert into afirmacion
      (workspace_id, insight_id, orden, texto, es_hipotesis)
      values (${ws}, ${otroInsight}, 0, 'El recordatorio sale tarde', false) returning id`;
    await admin`insert into cita
      (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
      values (${ws}, ${af!.id as string}, ${evidenciaDelRetoId}, 'El 71% de los abandonos',
              'resumen', ${leadId})`;

    // Se sella a mano, por la superficie concedida: lo que se mide es el SUELO, no que el
    // servicio se porte bien. `enlaces` decide qué traza se escribe.
    const sellarConTraza = async (enlaces: string[]) => {
      const propuestaId = await nuevaPropuesta(leadId, {
        capacidad: 'C3',
        anclas: { reto_id: retoId },
      });
      try {
        await conUsuario(leadId, async (tx) => {
          // Copiada TAL CUAL de la propuesta: desde que el guard comprueba también la
          // proyección —pregunta, prioridad y razón—, una HMW con texto de relleno cae ahí
          // antes de llegar a la traza, y este caso mediría esa otra regla.
          const [o] = await tx`insert into oportunidad
            (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
            values (${ws}, ${retoId}, ${CONTENIDO_C3(insightValidadoDelRetoId).pregunta},
                    ${CONTENIDO_C3(insightValidadoDelRetoId).prioridad},
                    ${CONTENIDO_C3(insightValidadoDelRetoId).prioridadRazon}, ${leadId})
            returning id`;
          for (const insightId of enlaces) {
            await tx`insert into oportunidad_insight (workspace_id, oportunidad_id, insight_id)
              values (${ws}, ${o!.id as string}, ${insightId})`;
          }
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${leadId},
                oportunidad_id = ${o!.id as string}
            where id = ${propuestaId} and workspace_id = ${ws}`;
        });
        return 'selló';
      } catch (e) {
        return `rechazó: ${(e as Error).message.slice(0, 80)}`;
      } finally {
        // El orden lo imponen las dos FK, que apuntan en sentidos opuestos: la propuesta a la
        // oportunidad (el objeto materializado) y la oportunidad a la propuesta (el sello de
        // procedencia). Se suelta el sello, se borra la propuesta —que es quien apunta al
        // objeto— y después el objeto. Soltar `oportunidad_id` a secas no vale: el CHECK
        // «decidida ⇒ exactamente un objeto» lo rechaza mientras el estado siga aceptada.
        await admin`update oportunidad set propuesta_ai_id = null where workspace_id = ${ws}`;
        await admin`delete from propuesta_ai where id = ${propuestaId}`;
        await admin`delete from oportunidad_insight where workspace_id = ${ws}`;
        await admin`delete from oportunidad where workspace_id = ${ws}`;
      }
    };

    // El contenido del fixture cita SOLO a `insightValidadoDelRetoId`.
    expect(await sellarConTraza([insightValidadoDelRetoId, otroInsight])).toMatch(/no es la de sus citas/);
    expect(await sellarConTraza([])).toMatch(/al menos un insight|no es la de sus citas/);
    // Y la buena: exactamente el citado. Sin esta mitad, un guard que rechazara SIEMPRE
    // pasaría las dos de arriba.
    expect(await sellarConTraza([insightValidadoDelRetoId])).toBe('selló');

    await admin`delete from cita where afirmacion_id = ${af!.id as string}`;
    await admin`delete from afirmacion where id = ${af!.id as string}`;
    await admin`delete from insight where id = ${otroInsight}`;
  });

  /**
   * Y la PROCEDENCIA: la oportunidad y su traza nacen en la aceptación.
   *
   * `xmin` dice «esta transacción escribió esta versión» y NO distingue insertar de
   * actualizar, y `oportunidad` sí admite un UPDATE que conserva el estado —repriorizar—. Por
   * eso el guard exige además `creado_en = now()`, que la base pone y ningún grant mueve: sin
   * él, repriorizar una HMW vieja dentro de la aceptación la sellaría como recién nacida, y lo
   * que quedaría mal atribuido es que una pregunta escrita A MANO conste como propuesta por la
   * AI — que es de lo que viven la tasa de corrección y el rastro de quién produjo qué.
   */
  it('C3: una oportunidad que ya existía no se puede sellar, ni repriorizándola aquí', async () => {
    const admin = sqlAdmin();
    const [vieja] = await admin`insert into oportunidad
      (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
      values (${ws}, ${retoId}, '¿Cómo podríamos hacer esto a mano?', 3, 'la escribió una
              persona', ${leadId})
      returning id`;
    const viejaId = vieja!.id as string;
    await admin`insert into oportunidad_insight (workspace_id, oportunidad_id, insight_id)
      values (${ws}, ${viejaId}, ${insightValidadoDelRetoId})`;
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'C3',
      anclas: { reto_id: retoId },
    });
    try {
      // Apropiársela tal cual.
      await expect(
        conUsuario(leadId, (tx) => tx`update propuesta_ai
          set estado = 'aceptada', revisada_por = ${leadId},
              oportunidad_id = ${viejaId}
          where id = ${propuestaId} and workspace_id = ${ws}`),
      ).rejects.toThrow(/haber NACIDO en esta misma aceptación/);
      // Y tocándola en la misma transacción, que es lo que `xmin` solo no distingue.
      await expect(
        conUsuario(leadId, async (tx) => {
          await tx`update oportunidad set prioridad = 9
            where id = ${viejaId} and workspace_id = ${ws}`;
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${leadId},
                oportunidad_id = ${viejaId}
            where id = ${propuestaId} and workspace_id = ${ws}`;
        }),
      ).rejects.toThrow(/haber NACIDO en esta misma aceptación/);
      // Y la propuesta sigue por revisar: la transacción entera se fue.
      const [sigue] = await admin`select estado from propuesta_ai where id = ${propuestaId}`;
      expect(sigue!.estado as string).toBe('propuesta');
    } finally {
      await admin`delete from propuesta_ai where id = ${propuestaId}`;
      await admin`delete from oportunidad_insight where oportunidad_id = ${viejaId}`;
      await admin`delete from oportunidad where id = ${viejaId}`;
    }
  });

  /**
   * Y el PARECIDO: la HMW sellada tiene que decir lo que dice la propuesta.
   *
   * Los otros cuatro destinos ya lo comprueban —evidencia, criterio, insight y entrada KPI—, y
   * la oportunidad se había quedado solo con su PREDICADO: cuelga del reto, la firma quien
   * aceptó, nace por decidir y su traza es la citada. Todo eso lo cumple una HMW que pregunte
   * OTRA COSA. Por la superficie SQL concedida —o por un camino futuro del servicio que
   * construya mal la transacción— quedaba una propuesta constando como aceptada mientras el
   * objeto que se le atribuye dice algo distinto: procedencia corrupta, y la tasa de
   * corrección midiendo texto que el modelo no escribió.
   *
   * Los tres campos que la propuesta DICTA, y solo esos: la pregunta, la prioridad y su razón.
   * El veredicto y su razón no se comparan porque la propuesta no los dice — nacen vacíos y
   * los pone la decisión humana, que es otra puerta.
   */
  it('C3: la HMW materializada tiene que decir lo que dice la propuesta', async () => {
    const admin = sqlAdmin();
    const contenido = CONTENIDO_C3(insightValidadoDelRetoId);
    // `campos` decide qué se escribe en la fila; lo que no venga, se copia de la propuesta.
    const sellarConCampos = async (campos: {
      pregunta?: string;
      prioridad?: number;
      prioridadRazon?: string;
    }) => {
      const propuestaId = await nuevaPropuesta(leadId, {
        capacidad: 'C3',
        anclas: { reto_id: retoId },
      });
      try {
        await conUsuario(leadId, async (tx) => {
          const [o] = await tx`insert into oportunidad
            (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
            values (${ws}, ${retoId}, ${campos.pregunta ?? contenido.pregunta},
                    ${campos.prioridad ?? contenido.prioridad},
                    ${campos.prioridadRazon ?? contenido.prioridadRazon}, ${leadId})
            returning id`;
          await tx`insert into oportunidad_insight (workspace_id, oportunidad_id, insight_id)
            values (${ws}, ${o!.id as string}, ${insightValidadoDelRetoId})`;
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${leadId},
                oportunidad_id = ${o!.id as string}
            where id = ${propuestaId} and workspace_id = ${ws}`;
        });
        return 'selló';
      } catch (e) {
        return `rechazó: ${(e as Error).message.slice(0, 80)}`;
      } finally {
        await admin`update oportunidad set propuesta_ai_id = null where workspace_id = ${ws}`;
        await admin`delete from propuesta_ai where id = ${propuestaId}`;
        await admin`delete from oportunidad_insight where workspace_id = ${ws}`;
        await admin`delete from oportunidad where workspace_id = ${ws}`;
      }
    };

    // Los tres, uno a uno: cada campo por separado, o un guard que solo mirara la pregunta
    // pasaría los otros dos sin que nadie lo notara.
    expect(await sellarConCampos({ pregunta: '¿Cómo podríamos preguntar otra cosa?' })).toMatch(
      /no dice lo que dice la propuesta/,
    );
    expect(await sellarConCampos({ prioridad: 1 })).toMatch(/no dice lo que dice la propuesta/);
    expect(await sellarConCampos({ prioridadRazon: 'Otra razón cualquiera' })).toMatch(
      /no dice lo que dice la propuesta/,
    );
    // Y la buena: copiada tal cual, sella. Sin esta mitad, un guard que rechazara SIEMPRE
    // pasaría las tres de arriba.
    expect(await sellarConCampos({})).toBe('selló');
  });


  /**
   * Y lo CITADO tiene que caber dentro del alcance sellado.
   *
   * El alcance se comprobaba en un solo sentido —que estuvieran TODOS los validados del reto—
   * y esa mitad sola no dice nada de lo que la propuesta cita. La política de
   * `oportunidad_insight` admite cualquier insight VALIDADO DEL WORKSPACE, no del reto, así
   * que por la superficie concedida se podía citar uno ajeno, enlazarlo, entregar un
   * `alcance_insights` completo —lo es: contiene todos los del reto— y sellar. La HMW quedaba
   * atribuida a material que el modelo nunca recibió, con la traza y el alcance diciendo cada
   * uno una verdad distinta.
   *
   * El caso se monta con un insight validado que no cuelga de NINGÚN reto —sin afirmación ni
   * cita, `insights_validados_del_reto` no lo devuelve para ninguno—, que es la forma más
   * limpia de «ajeno» y la que la política sí deja enlazar.
   */
  it('C3: una HMW no puede citar un insight que no entró en su alcance', async () => {
    const admin = sqlAdmin();
    const [aj] = await admin`insert into insight
      (workspace_id, titulo, resumen, estado, validado_por, validado_en, creado_por)
      values (${ws}, 'Un insight de otro sitio', 'No cuelga de ningún reto.',
              'validado', ${leadId}, now(), ${leadId})
      returning id`;
    const ajenoId = aj!.id as string;
    const contenido = CONTENIDO_C3(ajenoId);
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'C3',
      anclas: { reto_id: retoId },
      contenido,
    });
    try {
      // El alcance que se guardó es COMPLETO —tiene todos los validados del reto—, así que la
      // comprobación de «no falta ninguno» pasa: lo único que puede parar esto es la otra
      // mitad.
      const [p] = await admin`select alcance_insights from propuesta_ai where id = ${propuestaId}`;
      expect(p!.alcance_insights as string[]).toContain(insightValidadoDelRetoId);
      expect(p!.alcance_insights as string[]).not.toContain(ajenoId);

      await expect(
        conUsuario(leadId, async (tx) => {
          const [o] = await tx`insert into oportunidad
            (workspace_id, reto_id, pregunta, prioridad, prioridad_razon, creado_por)
            values (${ws}, ${retoId}, ${contenido.pregunta}, ${contenido.prioridad},
                    ${contenido.prioridadRazon}, ${leadId})
            returning id`;
          await tx`insert into oportunidad_insight (workspace_id, oportunidad_id, insight_id)
            values (${ws}, ${o!.id as string}, ${ajenoId})`;
          await tx`update propuesta_ai
            set estado = 'aceptada', revisada_por = ${leadId},
                oportunidad_id = ${o!.id as string}
            where id = ${propuestaId} and workspace_id = ${ws}`;
        }),
      ).rejects.toThrow(/cita insights que no entraron en el material/);
    } finally {
      await admin`update oportunidad set propuesta_ai_id = null where workspace_id = ${ws}`;
      await admin`delete from propuesta_ai where id = ${propuestaId}`;
      await admin`delete from oportunidad_insight where workspace_id = ${ws}`;
      await admin`delete from oportunidad where workspace_id = ${ws}`;
      await admin`delete from insight where id = ${ajenoId}`;
    }
  });

  /**
   * Y la entrada que salió de una propuesta SIGUE pudiendo quitarse del borrador.
   *
   * `entrada_kpi` es el primero de los cuatro destinos cuyo objeto tiene un camino de BORRADO
   * en el producto: `borrarEntrada` existe porque una entrada que sobra —o que se pactó y
   * después no— bloquearía la firma del contrato, y firmar es lo que hace G6. Los otros tres
   * no se borran nunca, así que el enlace del sello nunca había chocado con nada.
   *
   * Con el sello puesto sí choca, y hacia el lado peor: la salida que existe para no bloquear
   * la firma se cierra JUSTO para las entradas que propuso la AI, y el mensaje que llega es una
   * violación de clave ajena. La forma de la regla queda dicha por sus dos mitades: la entrada
   * se va, y la propuesta se queda —aceptada, con su rastro—.
   */
  it('C6: una entrada del registry se puede quitar del borrador aunque la haya propuesto la AI', async () => {
    const admin = sqlAdmin();
    const propuestaId = await conHuellaReal(
      await nuevaPropuesta(leadId, { capacidad: 'C6', anclas: { registry_id: registryId } }),
    );
    // Con nombre propio: el registry del fixture es uno solo —`metric_registry` es único por
    // reto— y `unique (registry_id, nombre)` no admite dos entradas iguales.
    const r = await aceptarPropuesta(leadId, {
      workspaceId: ws,
      propuestaId,
      correccion: {
        ...CONTENIDO_C6(criterioDelRegistryId),
        nombre: 'Tasa de verificación completada en tableta',
      },
    });

    await borrarEntrada(leadId, { workspaceId: ws, entradaId: r.objetoId });
    const quedan = await admin`select id from entrada_kpi where id = ${r.objetoId}`;
    expect(quedan.length, 'la salida que existe para no bloquear la firma').toBe(0);

    // Y la propuesta se queda: quitar la entrada no borra que se aceptó, ni quién la aceptó.
    // El puntero se va con el objeto —no queda a qué apuntar—, y el hecho vive donde tiene que
    // vivir: en el evento, que es append-only y sí conserva el id.
    const [tras] = await admin`select estado, revisada_por, entrada_kpi_id from propuesta_ai
      where id = ${propuestaId}`;
    expect(tras!.estado).toBe('corregida');
    expect(tras!.revisada_por).toBe(leadId);
    expect(tras!.entrada_kpi_id).toBeNull();
    const [evento] = await admin`select payload from evento_dominio
      where workspace_id = ${ws} and tipo = 'PropuestaAICorregida'
        and payload->>'propuestaId' = ${propuestaId}`;
    expect(
      (evento!.payload as Record<string, unknown>).entradaKpiId,
      'el rastro de qué objeto creó esta propuesta no se borra con el objeto',
    ).toBe(r.objetoId);
  });

  /**
   * Y el criterio tampoco se reapunta por SQL DIRECTO, que es donde la regla tenía que estar.
   *
   * La ronda anterior blindó `criterioId` en `TESTIMONIO_ADICIONAL.C6` y eso cierra el
   * formulario. Pero el guard de la base comparaba contra `contenido_original` solo las citas
   * de primer nivel y la confianza, y `criterioId` no es ninguna de las dos: por la superficie
   * SQL concedida, una «corrección» podía reapuntar la entrada a otro criterio CONSERVANDO las
   * citas, y el resto del suelo no lo veía —el criterio nuevo es del reto del registry, y la
   * proyección compara contra `contenido`, que es el ya corregido—. La entrada quedaba sellada
   * respondiendo a una promesa cuyos fragmentos nunca se leyeron.
   *
   * La comparación se añade SIN condicionar al destino, como la de las citas y por lo mismo:
   * para las capacidades cuyo contenido no lleva `criterioId` los dos lados son nulos y la
   * regla no dice nada, así que atarla a C6 solo la dejaría corta ante la siguiente.
   */
  it('C6: reapuntar el criterio por SQL directo tampoco sella la entrada', async () => {
    const admin = sqlAdmin();
    const [otro] = await admin`insert into criterio_exito
      (workspace_id, reto_id, kpi, definicion, objetivo, ventana_dias, linea_base_plan, creado_por)
      values (${ws}, ${retoId}, 'Criterio de al lado', 'Definición', 'Objetivo', 30, 'Plan',
              ${leadId}) returning id`;
    const otroId = otro!.id as string;
    const propuestaId = await nuevaPropuesta(leadId, {
      capacidad: 'C6',
      anclas: { registry_id: registryId },
    });
    // El contenido con el criterio cambiado y las citas INTACTAS: es la forma que el guard de
    // las citas no ve, porque no toca ninguna cita.
    const corregido = {
      ...CONTENIDO_C6(criterioDelRegistryId),
      criterioId: otroId,
      nombre: 'Tasa de verificación completada en quiosco',
    };

    await expect(
      conUsuario(leadId, async (tx) => {
        const [entrada] = await tx`insert into entrada_kpi
          (workspace_id, registry_id, criterio_id, nombre, definicion, fuente, dimensiones,
           frecuencia, dashboard_url, creado_por)
          values (${ws}, ${registryId}, ${otroId}, ${corregido.nombre}, ${corregido.definicion},
                  ${corregido.fuente}, ${corregido.dimensiones}, ${corregido.frecuencia}, '',
                  ${leadId}) returning id`;
        await tx`update propuesta_ai
          set estado = 'corregida', revisada_por = ${leadId},
              contenido = ${tx.json(corregido)}::jsonb,
              entrada_kpi_id = ${entrada!.id as string}
          where id = ${propuestaId} and workspace_id = ${ws}`;
      }),
    ).rejects.toThrow(/no se corrige|no se reapunta/i);

    // Y la propuesta sigue pendiente: la transacción entera se fue, entrada incluida.
    const [tras] = await admin`select estado from propuesta_ai where id = ${propuestaId}`;
    expect(tras!.estado).toBe('propuesta');
    const restos = await admin`select id from entrada_kpi
      where registry_id = ${registryId} and criterio_id = ${otroId}`;
    expect(restos.length).toBe(0);
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });
  });

  /**
   * Y un criterio que se MUEVE después de la llamada cierra la aceptación.
   *
   * La huella del material se guardaba y solo la leía el panel, para apagar el verde de la
   * presencia literal. Pero un registry en borrador se abre ANTES de G0, y hasta G0 los
   * criterios se editan: entre generar el lote y revisarlo, `editarCriterio` puede cambiar la
   * definición, el objetivo o la ventana del criterio al que la entrada responde. Medido: la
   * propuesta seguía `disponible` y la aceptación materializaba el KPI — un contrato de
   * medición, permanente y atado a ese criterio, escrito contra una promesa que ya no existe.
   *
   * Se cierra en los DOS sitios donde se puede: el panel lo dice con su motivo, y el
   * materializador lo rechaza. En la base no tiene suelo, y eso va escrito en la tabla de
   * precondiciones: el material es el texto ya compuesto y recortado, así que no hay SQL que
   * lo recalcule. Por eso no basta con el panel — un aviso de pantalla lo salta cualquier
   * cliente que hable con la server function.
   */
  it('C6: si los criterios se mueven después de la llamada, la entrada ya no se acepta', async () => {
    const admin = sqlAdmin();
    // Nombre propio, como las demás: el registry del fixture es uno solo y los casos de
    // arriba ya dejaron entradas materializadas dentro.
    const contenido = {
      ...CONTENIDO_C6(criterioDelRegistryId),
      nombre: 'Tasa de verificación completada en tótem',
    };
    const propuestaId = await conHuellaReal(
      await nuevaPropuesta(leadId, {
        capacidad: 'C6',
        anclas: { registry_id: registryId },
        contenido,
      }),
    );
    // Con el material intacto, la propuesta está disponible: sin esta mitad, un panel que
    // dijera siempre «cambiado» pasaría igual.
    const antes = (await panelPropuestas(leadId, ws)).pendientes.find((x) => x.id === propuestaId);
    expect(antes!.anclaEstado).toBe('disponible');

    // El criterio se mueve. Es el acto legítimo que abre el hueco: hasta G0 se editan, y el
    // registry en borrador existe antes de G0.
    await admin`update criterio_exito set objetivo = 'Bajar de 8 a 3 minutos'
      where id = ${criterioDelRegistryId}`;

    const tras = (await panelPropuestas(leadId, ws)).pendientes.find((x) => x.id === propuestaId);
    expect(tras!.anclaEstado, 'el panel seguía diciendo disponible').toBe('criterios-cambiados');
    // Y el verde de la presencia literal se apaga: contra un material que el modelo no leyó,
    // «aparece» o «no aparece» son las dos respuestas equivocadas.
    expect(tras!.citas.map((c) => c.presenteLiteral)).toEqual(tras!.citas.map(() => null));
    await expect(
      aceptarPropuesta(leadId, { workspaceId: ws, propuestaId }),
    ).rejects.toThrow(/cambiaron después de que el modelo los leyera/);
    // Y corregir el texto tampoco la salva: lo que se movió está fuera de la propuesta.
    await expect(
      aceptarPropuesta(leadId, {
        workspaceId: ws,
        propuestaId,
        correccion: { ...contenido, definicion: 'Otra definición del mismo KPI' },
      }),
    ).rejects.toThrow(/cambiaron después de que el modelo los leyera/);

    // RECHAZAR sigue abierto, que es la asimetría que sostiene la tabla entera: si el bloqueo
    // alcanzara al rechazo, la fila quedaría muerta reteniendo su ancla.
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });
    const [fin] = await admin`select estado from propuesta_ai where id = ${propuestaId}`;
    expect(fin!.estado).toBe('rechazada');
  });

  /**
   * Y un despliegue del PROMPT no apaga la comprobación: la deja en «no se sabe», y eso no
   * es permiso.
   *
   * La huella es del texto YA COMPUESTO, así que un cambio del renderizador la mueve sin que
   * nadie haya tocado un criterio; por eso la comparación se hace solo contra el mismo
   * `prompt_version`. Pero «no se puede comparar» no puede resolverse aceptando: una propuesta
   * de C6 que sobreviva a un despliegue quedaba sin ninguna comprobación del material, y a
   * partir de ahí editar el criterio y aceptar volvía a materializar un KPI contra una promesa
   * distinta — el mismo daño de la ronda anterior, por la puerta que abrió su mitigación.
   *
   * El MISMO desconocimiento se resuelve de tres formas distintas, y las tres están dichas
   * donde toca: en la presencia literal no puede volverse un veredicto (verde ni rojo), en el
   * estado de la fila de C5 no puede volverse una alarma —C5 no materializa nada—, y aquí no
   * puede volverse un permiso, porque lo que se firma es un contrato de medición permanente.
   *
   * Y el panel lo dice con su propio motivo: `criterios-cambiados` afirma que se movieron, y
   * eso aquí sería inventarse una alarma. La salida es la misma —rechazar y pedir otro lote—,
   * pero el motivo que se enseña tiene que ser el que ocurrió.
   */
  it('C6: una propuesta de otro render del prompt no se acepta, y el panel dice por qué', async () => {
    const admin = sqlAdmin();
    const contenido = {
      ...CONTENIDO_C6(criterioDelRegistryId),
      nombre: 'Tasa de verificación completada en caja',
    };
    const propuestaId = await conHuellaReal(
      await nuevaPropuesta(leadId, {
        capacidad: 'C6',
        anclas: { registry_id: registryId },
        contenido,
      }),
    );
    // El despliegue: la fila se queda con la versión con la que nació y el código avanza. Se
    // simula moviendo la de la FILA, que es lo mismo visto desde la comparación.
    await admin`update propuesta_ai set prompt_version = 'ai-2000-01-01.1'
      where id = ${propuestaId}`;

    const enPanel = (await panelPropuestas(leadId, ws)).pendientes.find(
      (x) => x.id === propuestaId,
    );
    expect(enPanel!.anclaEstado).toBe('material-no-comparable');
    await expect(
      aceptarPropuesta(leadId, { workspaceId: ws, propuestaId }),
    ).rejects.toThrow(/no se puede comprobar/i);

    // Y rechazar sigue abierto, como en todas las filas de la tabla de precondiciones.
    await rechazarPropuesta(leadId, { workspaceId: ws, propuestaId });
    const [fin] = await admin`select estado from propuesta_ai where id = ${propuestaId}`;
    expect(fin!.estado).toBe('rechazada');
  });

  /**
   * Y la entrada materializada tiene que haber NACIDO en esa aceptación.
   *
   * `xmin` dice «esta transacción escribió esta versión de la fila» y no distingue insertar de
   * actualizar, así que una entrada vieja EDITADA aquí pasaría como recién nacida — y con ella
   * quedaría atribuido a la AI un KPI escrito a mano. El insight cerró ese hueco con «y sigue
   * propuesto»; `entrada_kpi` no tiene estado con el que decirlo, así que lo dice su fecha:
   * `creado_en` la pone la base y está fuera del grant, de modo que ningún UPDATE concedido la
   * mueve.
   *
   * Se mide por lo que de verdad lo sostiene: que la columna NO se pueda escribir.
   */
  it('C6: `creado_en` de una entrada KPI no está al alcance del rol de aplicación', async () => {
    const admin = sqlAdmin();
    const [grant] = await admin`select bool_or(privilege_type = 'INSERT') as puede
      from information_schema.column_privileges
      where table_name = 'entrada_kpi' and column_name = 'creado_en'
        and grantee = 'designio_app'`;
    expect(
      grant?.puede ?? false,
      'con creado_en en el grant, «nació en esta aceptación» deja de ser comprobable',
    ).toBe(false);
    const [gid] = await admin`select bool_or(privilege_type = 'INSERT') as puede
      from information_schema.column_privileges
      where table_name = 'entrada_kpi' and column_name = 'id' and grantee = 'designio_app'`;
    expect(gid?.puede ?? false).toBe(false);
  });

});
