/**
 * Seed de desarrollo: el workspace demo del ejemplo trabajado (Banco Andino, prediseño §19)
 * con sus tres personas como usuarios ACTIVOS (login demo: lucia@whitespace.demo / designio.demo)
 * y el árbol Servicio → Retos → Proyecto. Idempotente con rutas de upgrade: sobre una base ya
 * sembrada asegura credenciales (backfill pre-auth) y siembra el árbol si aún no existe.
 * Corre con la conexión ADMIN.
 */
import postgres, { type TransactionSql } from 'postgres';
import bcrypt from 'bcryptjs';
import {
  checklistParaPerfil,
  ETAPAS_CANONICAS,
  rolAprobadorDeGate,
} from '../src/lib/metodo/metodo.plantillas';
import { costoDeUso, MODELO_PRIMARIO } from '../src/lib/ai/ai.degradacion';
import { PROMPT_VERSION } from '../src/lib/ai/ai.prompts';
import { CONFIANZA_PROPUESTA_NUMERICA, type ContenidoExtraccion } from '../src/lib/ai/ai.schemas';
import {
  LoginSchema,
  PASSWORD_MAX_BYTES,
  ROLES_QUE_INVITAN,
} from '../src/lib/auth/auth.schemas';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Falta DATABASE_URL (conexión admin; ver .env.local.example)');
const sql = postgres(url, { max: 1, onnotice: () => {} });

const PASSWORD_DEMO = 'designio.demo';
const PERSONAS = [
  { email: 'lucia@whitespace.demo', nombre: 'Lucía P.', rol: 'lead-boutique' },
  { email: 'maria@bancoandino.demo', nombre: 'María G.', rol: 'sponsor' },
  { email: 'canales@bancoandino.demo', nombre: 'Gerente de Canales', rol: 'stakeholder' },
] as const;

/**
 * Declara QUIÉN escribe en esta transacción.
 *
 * El seed corre con la conexión admin, y sin esto `app_user_id()` es nulo dentro de los
 * triggers: los guards que auditan sin mirar la membresía dejaban eventos SIN AUTOR —un
 * acta que no dice quién hizo qué es media acta— y los que sí la miran se saltaban su
 * evento entero, lo que obligaba a escribirlo a mano y acababa duplicando el del trigger.
 * Declarado el actor, el seed produce exactamente los mismos eventos que la aplicación.
 *
 * Va con `is_local = true`: el ajuste muere con la transacción, así que ninguna conexión
 * del pool se queda hablando en nombre de Lucía.
 */
async function declararActor(tx: TransactionSql, actorId: string): Promise<void> {
  await tx`select set_config('app.user_id', ${actorId}, true)`;
}

/** Árbol del ejemplo §19: servicio → retos (R-01 activo con métrica; R-02/R-03 candidatos
 * nacidos del post mortem, cerrando el loop J7→J2) → proyecto P-01. */
async function sembrarArbol(tx: TransactionSql, wsId: string, luciaId: string): Promise<void> {
  const [svc] = await tx`insert into servicio (workspace_id, nombre, descripcion, creado_por)
    values (${wsId}, 'Apertura de cuenta nómina digital',
      'Onboarding digital del segmento nómina por convenio', ${luciaId}) returning id`;
  const svcId = svc!.id as string;

  const [r01] = await tx`insert into reto
    (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, metrica_objetivo, creado_por) values
    (${wsId}, ${svcId}, 'R-01', 'Reducir el abandono en la apertura', 'activo', 'peticion-cliente', '62→40', ${luciaId})
    returning id`;
  await tx`insert into reto
    (workspace_id, servicio_ancla_id, codigo, titulo, estado, origen, creado_por) values
    (${wsId}, ${svcId}, 'R-02', 'Completar el backstage', 'candidato', 'post-mortem', ${luciaId}),
    (${wsId}, ${svcId}, 'R-03', 'Abandono de pymes', 'candidato', 'post-mortem', ${luciaId})`;

  await tx`insert into proyecto (workspace_id, reto_id, codigo, titulo, creado_por) values
    (${wsId}, ${r01!.id as string}, 'P-01', 'Rediseño de la verificación', ${luciaId})`;

  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
    (${wsId}, 'ServicioCreado', ${tx.json({ nombre: 'Apertura de cuenta nómina digital' })}, ${luciaId}, 'lead-boutique'),
    (${wsId}, 'RetoCreado', ${tx.json({ codigo: 'R-01', estado: 'activo' })}, ${luciaId}, 'lead-boutique'),
    (${wsId}, 'RetoCreado', ${tx.json({ codigo: 'R-02', estado: 'candidato', origen: 'post-mortem' })}, ${luciaId}, 'lead-boutique'),
    (${wsId}, 'RetoCreado', ${tx.json({ codigo: 'R-03', estado: 'candidato', origen: 'post-mortem' })}, ${luciaId}, 'lead-boutique'),
    (${wsId}, 'ProyectoCreado', ${tx.json({ codigo: 'P-01', reto: 'R-01' })}, ${luciaId}, 'lead-boutique')`;
}

/** Método de P-01 (SPEC-04): criterios de R-01 con ventana y línea base (§19), etapas
 * 0-7 canónicas, gates G0-G7 y checklist del perfil estándar. Idempotente por pieza:
 * en una base migrada, el backfill de la migración ya creó etapas/gates/checklist de
 * P-01 (y se respetan); los criterios son datos de demo y solo los pone el seed. */
async function sembrarMetodo(tx: TransactionSql, wsId: string, luciaId: string): Promise<void> {
  const [p01] = await tx`select p.id, p.reto_id from proyecto p
    where p.workspace_id = ${wsId} and p.codigo = 'P-01'`;
  if (!p01) return;
  const proyectoId = p01.id as string;
  const retoId = p01.reto_id as string;

  await tx`insert into criterio_exito
    (workspace_id, reto_id, kpi, definicion, linea_base_valor, linea_base_fecha,
     objetivo, ventana_dias, creado_por) values
    (${wsId}, ${retoId}, 'Abandono en verificación',
     'Porcentaje que inicia la apertura y no la completa', '62%', '2026-07-15',
     '40%', 90, ${luciaId}),
    (${wsId}, ${retoId}, 'Tiempo a cuenta activa',
     'Días desde el inicio hasta cuenta operativa', '5 días', '2026-07-15',
     '1 día', 90, ${luciaId})`;

  const [yaInstanciado] = await tx`select count(*)::int as n from etapa_instancia
    where workspace_id = ${wsId} and proyecto_id = ${proyectoId}`;
  if ((yaInstanciado!.n as number) === 0) {
    for (const [numero, nombre] of ETAPAS_CANONICAS.entries()) {
      await tx`insert into etapa_instancia (workspace_id, proyecto_id, numero, nombre, estado)
        values (${wsId}, ${proyectoId}, ${numero}, ${nombre}, ${numero <= 1 ? 'en-curso' : 'pendiente'})`;
      const [gate] = await tx`insert into gate_instancia
        (workspace_id, proyecto_id, numero, rol_aprobador)
        values (${wsId}, ${proyectoId}, ${numero}, ${rolAprobadorDeGate(numero)}) returning id`;
      const textos = checklistParaPerfil(numero, 'estandar');
      for (const [orden, texto] of textos.entries()) {
        await tx`insert into checklist_item (workspace_id, gate_id, orden, texto)
          values (${wsId}, ${gate!.id as string}, ${orden}, ${texto})`;
      }
    }
  }

  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
    (${wsId}, 'RetoActivado', ${tx.json({ codigo: 'R-01', proyecto: 'P-01', perfil: 'estandar' })}, ${luciaId}, 'lead-boutique')`;
}

/**
 * Evidencia profunda del ejemplo §19.1 (SPEC-03): el estudio CX y el funnel del banco,
 * curados, con su original adjunto y sus DERECHOS resueltos — y una entrevista sin
 * consentimiento, que es el caso que la spec pide poder demostrar: existe, se ve, y no
 * se puede citar ni exportar como entregable hasta que alguien conceda los derechos.
 *
 * El seed corre como owner (sin contexto RLS) y por eso escribe la evidencia directamente
 * en vez de pasar por la curaduría; los items quedan marcados como aprobados igual que
 * lo haría la app, para que la bandeja cuente la misma historia.
 * Idempotente por su MARCADOR EN `sembrado_registro`, no por lo que encuentre en las
 * tablas de producto. La señal ha fallado ya dos veces por el mismo motivo, y las dos
 * enseñan la misma frase con distinta letra:
 *
 *  1. Fue «hay algún `derecho_uso` en el workspace», y eso la ataba a un dato que otras
 *     funciones también producen: en cuanto `sembrarCadena` empezó a crear los derechos
 *     de sus dos evidencias —y en el camino de upgrade corre ANTES que ésta—, la señal se
 *     activaba sola y el material de la bandeja no se sembraba nunca.
 *  2. Fue «hay algún `item_importacion` en el workspace», que es más estrecho pero sigue
 *     siendo una tabla DE PRODUCTO: cualquiera puede dar de alta material en la bandeja
 *     de un Banco Andino ya existente, y desde ese momento esta función concluye que sus
 *     tres registros ya están y los salta PARA SIEMPRE. Nadie ha borrado nada; el demo
 *     simplemente nunca llega, y no hay forma de distinguirlo de que sí llegó.
 *
 * El arreglo es el mismo que el de `sembrarCadena`, y por eso lo comparte en vez de
 * copiarlo: la procedencia del sembrado no la deduce el seed de la forma de la base, la
 * ESCRIBE donde el rol de aplicación no llega. `sembrado_registro` no tiene política ni
 * grant de escritura para `designio_app`, así que «existe el marcador» solo puede haberlo
 * puesto una corrida del seed.
 *
 * Con una salvedad que conviene decir en vez de dejar implícita, porque esta función corre
 * también en el camino de UPGRADE sobre un Banco Andino ya existente: las bases sembradas
 * por la versión anterior tienen el material y no tienen marcador, y sembrar otra vez ahí
 * lo DUPLICA. Así que la guarda son dos preguntas —el marcador primero, y sólo si falta,
 * la presencia de los registros propios de esta función por su título exacto— y no una.
 * La segunda es la concesión al pasado y se apaga sola; el detalle de por qué emparejar
 * por título es admisible aquí y no en `repararDerechosDeCadena` está junto a ella.
 */
const ARCHIVO_DEMO = `Estudio CX — apertura de cuenta nomina (extracto)

Hallazgo 1: el 62% abandona en el paso de verificacion de identidad.
Hallazgo 2: el tiempo medio hasta cuenta operativa es de 5 dias.
Fuente: panel de 240 solicitudes, julio 2026.
`;

async function sembrarEvidenciaProfunda(
  tx: TransactionSql,
  wsId: string,
  luciaId: string,
): Promise<boolean> {
  const sembrados: { itemId: string; evidenciaId: string }[] = [];
  const material = [
    {
      titulo: 'Estudio CX apertura de cuenta (PDF del proveedor)',
      tipo: 'documento',
      referencia: 'carpeta compartida / CX-2026-Q3',
      contenido: ARCHIVO_DEMO,
      resumen: 'Línea base del abandono: 62% en verificación de identidad',
      esEstadoActual: true,
      recoleccion: 'Estudio CX encargado al proveedor externo',
      derivada: true,
      confianza: 'alta',
      consentimiento: true,
      confidencialidad: 'cliente',
      // Derechos ACORDADOS (§19.1): citable y exportable.
      derechos: {
        estado: 'concedido',
        ambito: 'cliente',
        base: 'Cláusula 7 del contrato de servicios: uso interno y en entregables del workspace',
      },
      conArchivo: true,
    },
    {
      titulo: 'Funnel de apertura Q2 (hoja de cálculo)',
      tipo: 'dataset',
      referencia: 'analítica / funnel-apertura-q2',
      contenido: 'Paso 1: 100% → Paso 2: 91% → Paso 3: 74% → Paso 4: 38%',
      resumen: 'Confirma el punto de fuga en el paso 4',
      esEstadoActual: true,
      recoleccion: 'Extracción de la analítica del canal digital',
      derivada: true,
      confianza: 'alta',
      consentimiento: true,
      confidencialidad: 'cliente',
      derechos: {
        estado: 'concedido',
        ambito: 'cliente',
        base: 'Dato propio del cliente, sin datos personales identificables',
      },
      conArchivo: false,
    },
    {
      titulo: 'Entrevista con solicitante que abandonó (grabación)',
      tipo: 'entrevista',
      referencia: 'grabaciones / E-014',
      contenido:
        'Dice que se detuvo al pedirle una foto del documento por ambas caras y no entendió si podía retomar después.',
      resumen: 'Explica el abandono desde la vivencia del solicitante',
      esEstadoActual: false,
      recoleccion: 'Entrevista 1:1 remota de 25 minutos',
      derivada: false,
      confianza: 'media',
      consentimiento: false,
      confidencialidad: 'restringida',
      // Sin consentimiento registrado: derechos PENDIENTES. Es el criterio de
      // aceptación 3 de SPEC-03, sembrado para poder verlo en la demo.
      derechos: null,
      conArchivo: false,
    },
  ] as const;

  // ── ¿Ya está sembrado? Dos preguntas, y ninguna es «¿hay algo en la bandeja?» ──
  const [marca] = await tx`select 1 from sembrado_registro
    where workspace_id = ${wsId} and clave = ${CLAVE_EVIDENCIA_PROFUNDA}`;
  if (marca) return false;

  // Sin marcador quedan las bases sembradas por una versión anterior, que sí tienen este
  // material y no tienen cómo acreditarlo. Para ésas la pregunta se hace sobre LOS
  // REGISTROS DE ESTA FUNCIÓN —sus títulos exactos, derivados del mismo array que los
  // crea y no de una lista paralela que se desincronice—, no sobre la tabla entera.
  //
  // Emparejar por título está proscrito en `repararDerechosDeCadena` y aquí no lo está, y
  // la diferencia importa: allí decide a quién se le CONCEDEN derechos, así que un acierto
  // falso regala permisos sobre material ajeno. Aquí solo decide si se ESCRIBE material de
  // demo, y el peor acierto falso es no añadirlo. La dirección conservadora es la contraria
  // en cada caso, y por eso la respuesta también.
  //
  // Esta rama se apaga sola: en cuanto una corrida siembra deja marcador, y desde ahí la
  // pregunta vuelve a ser exacta. NO se le escribe marcador a las bases viejas a propósito
  // —sellar en nombre de una corrida que no consta es justo lo que este registro existe
  // para impedir—, así que sigue costando una consulta y diciendo la verdad.
  const heredado = await tx`select 1 from item_importacion
    where workspace_id = ${wsId} and titulo = any(${material.map((m) => m.titulo)})
    limit 1`;
  if (heredado.length > 0) return false;

  for (const m of material) {
    const [item] = await tx`insert into item_importacion
      (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
      values (${wsId}, ${m.titulo}, ${m.contenido}, ${m.tipo}, ${m.referencia}, ${luciaId})
      returning id`;
    const itemId = item!.id as string;

    if (m.conArchivo) {
      await tx`insert into archivo_importado
        (workspace_id, item_id, nombre, tipo_mime, contenido, creado_por)
        values (${wsId}, ${itemId}, 'estudio-cx-extracto.txt', 'text/plain',
                ${Buffer.from(ARCHIVO_DEMO, 'utf-8')}, ${luciaId})`;
    }

    const [fuente] = await tx`insert into fuente (workspace_id, tipo, titulo, referencia, creado_por)
      values (${wsId}, ${m.tipo}, ${m.titulo}, ${m.referencia}, ${luciaId}) returning id`;

    const dimensiones = {
      proveniencia: { tipoFuente: m.tipo, fecha: '2026-07-15', localizacion: m.referencia },
      metodo: { recoleccion: m.recoleccion, derivada: m.derivada, segmentoIds: [] },
      calidad: { confianza: m.confianza, corroboraIds: [], contradiceIds: [] },
      derechos: { consentimiento: m.consentimiento, confidencialidad: m.confidencialidad },
      lineage: null,
    };

    const [evidencia] = await tx`insert into evidencia
      (workspace_id, fuente_id, titulo, resumen, dimensiones, es_estado_actual, creado_por)
      values (${wsId}, ${fuente!.id as string}, ${m.titulo}, ${m.resumen},
              ${tx.json(dimensiones)}, ${m.esEstadoActual}, ${luciaId})
      returning id`;
    const evidenciaId = evidencia!.id as string;

    // Toda evidencia nace con su registro de derechos, aunque sea pendiente.
    if (m.derechos) {
      await tx`insert into derecho_uso
        (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
        values (${wsId}, ${evidenciaId}, ${m.derechos.estado}, ${m.derechos.ambito},
                ${m.derechos.base}, ${luciaId}, now(), ${luciaId})`;
    } else {
      await tx`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
        values (${wsId}, ${evidenciaId}, ${luciaId})`;
    }

    await tx`update item_importacion
      set estado = 'aprobado', decidido_por = ${luciaId}, decidido_en = now(),
          evidencia_id = ${evidenciaId}
      where id = ${itemId}`;

    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
      (${wsId}, 'EvidenciaCurada',
       ${tx.json({ itemId, evidenciaId, esEstadoActual: m.esEstadoActual })},
       ${luciaId}, 'lead-boutique')`;
    sembrados.push({ itemId, evidenciaId });
  }
  // La constancia de ESTA corrida, donde la aplicación no escribe. Lleva los ids además de
  // la clave: hoy la guarda solo pregunta si la fila existe, pero un marcador que no dice
  // QUÉ creó obliga a la siguiente reparación a adivinarlo, que es exactamente el defecto
  // que `repararDerechosDeCadena` existe para no repetir.
  await tx`insert into sembrado_registro (workspace_id, clave, payload)
    values (${wsId}, ${CLAVE_EVIDENCIA_PROFUNDA}, ${tx.json({ sembrados })})
    on conflict (workspace_id, clave) do nothing`;
  return true;
}

/**
 * La BASE documental de cada derecho, atada al PAPEL que esa evidencia cumple en la
 * cadena de demo (la que se cita y la que sostiene el arquetipo), no a su título. El
 * título es texto que cualquiera puede repetir; el papel sale de las relaciones.
 */
const BASE_DERECHO_CITADA =
  'Cláusula 7 del contrato de servicios: analítica agregada, sin datos personales';
const BASE_DERECHO_ARQUETIPO =
  'Consentimiento informado firmado por los seis asesores entrevistados';

/**
 * Concede los derechos (ámbito cliente) de la evidencia de la cadena de demo, IDENTIFICADA
 * POR ID. Quien llama tiene que haber acreditado antes que esos ids son de la cadena.
 *
 * Por qué concedidos y no pendientes: estas dos evidencias son justamente las que sostienen
 * la cadena —una está citada en el insight validado que respalda la decisión de G1, y citar
 * exige derechos vigentes; la otra apoya el arquetipo confirmado—. Dejarlas pendientes deja
 * el demo contradiciéndose: una cita que hoy el propio producto no dejaría crear. El caso
 * «bloqueada a propósito» ya está sembrado y vive donde le toca, en la evidencia sin
 * consentimiento de sembrarEvidenciaProfunda.
 *
 * Por qué hace falta ponerlos a mano: el seed corre como PROPIETARIO, así que el
 * pre-chequeo anti-oráculo de `evidencia_con_derechos_guard` sale antes y no comprueba
 * nada. El guard se salta la comprobación, no la regla.
 *
 * Solo toca lo que está en 'pendiente'. Si un operador denegó estos derechos a mano —o los
 * concedió con otro ámbito— el seed NO le pisa la decisión: repara el estado fail-closed que
 * dejó el backfill, no cualquier estado. Y `pendiente` significa exactamente «nadie ha
 * decidido todavía»: la transición nunca vuelve a ese estado, solo se nace en él.
 */
async function concederDerechosDeCadena(
  tx: TransactionSql,
  wsId: string,
  luciaId: string,
  filas: readonly { evidenciaId: string; base: string }[],
): Promise<void> {
  for (const { evidenciaId, base } of filas) {
    // Falta la fila entera (base sembrada por una versión sin derechos y nunca migrada).
    await tx`insert into derecho_uso
      (workspace_id, evidencia_id, estado, ambito, base, decidido_por, decidido_en, creado_por)
      select ${wsId}, ${evidenciaId}, 'concedido', 'cliente', ${base}, ${luciaId}, now(), ${luciaId}
      where not exists (select 1 from derecho_uso d where d.evidencia_id = ${evidenciaId})`;
    // O existe en 'pendiente' porque la puso el backfill de la migración.
    await tx`update derecho_uso d
      set estado = 'concedido', ambito = 'cliente', base = ${base},
          decidido_por = ${luciaId}, decidido_en = now()
      where d.evidencia_id = ${evidenciaId} and d.workspace_id = ${wsId}
        and d.estado = 'pendiente'`;
  }
}

/**
 * La clave con la que el seed registra la cadena de demo en `sembrado_registro`, y el tipo
 * de evento del aviso que emite cuando decide no tocar nada. Viven aquí, y no sueltos
 * donde se usan, porque la reparación los LEE: son el contrato entre dos corridas
 * distintas del seed.
 */
const CLAVE_CADENA_SEMBRADA = 'cadena-demo';
/** La clave con la que el seed registra el material de bandeja de §19.1. */
const CLAVE_EVIDENCIA_PROFUNDA = 'evidencia-profunda-demo';
const AVISO_CADENA_SIN_PROCEDENCIA = 'DerechosDeCadenaSinRepararPorProcedencia';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deja constancia de la reparación que NO se hizo, nombrando lo que habría tocado.
 *
 * «No concedo» a secas sería un silencio, y quien se encuentre el demo con la evidencia
 * bloqueada necesita saber por qué y sobre qué. El evento nombra la evidencia y el PAPEL
 * que cumple en el grafo —dato que sale de las relaciones, no de un título— y a propósito
 * NO sugiere una base documental: la base es lo que justifica el permiso, y la escribe
 * quien lo concede. Un seed que redactara la justificación estaría haciendo otra vez, por
 * la puerta de al lado, lo que este arreglo existe para impedir.
 *
 * Solo nombra lo que la reparación habría podido tocar: evidencia sin fila de derechos o
 * con la fila en 'pendiente'. Lo ya decidido —concedido o denegado— no entra: nadie iba a
 * pisarlo, así que nombrarlo sería ruido.
 *
 * Idempotente POR CONTENIDO: se reemite solo si cambia el conjunto afectado, para que
 * re-sembrar diez veces no llene la auditoría con el mismo aviso y para que un cambio real
 * sí quede fechado. El orden del array es TOTAL (`order by e.id, u.papel`, no solo por id)
 * porque la igualdad de jsonb sí distingue el orden dentro de un array, y una misma
 * evidencia puede salir en las dos ramas: ordenar solo por id dejaría ese par empatado y el
 * aviso se reemitiría al azar.
 */
async function declinarReparacionDeCadena(tx: TransactionSql, wsId: string): Promise<void> {
  const alcanzables = await tx`
    with citada as (
      select distinct c.evidencia_id as ev, 'citada'::text as papel
      from proyecto p
      join gate_instancia g on g.proyecto_id = p.id and g.workspace_id = p.workspace_id
        and g.numero = 1
      join decision d on d.gate_id = g.id and d.workspace_id = g.workspace_id
      join decision_insight di on di.decision_id = d.id and di.workspace_id = d.workspace_id
      join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
      join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
      where p.workspace_id = ${wsId} and p.codigo = 'P-01'
    ), del_arquetipo as (
      select distinct ae.evidencia_id as ev, 'arquetipo'::text as papel
      from proyecto p
      join arquetipo arq on arq.reto_id = p.reto_id and arq.workspace_id = p.workspace_id
      join arquetipo_evidencia ae on ae.arquetipo_id = arq.id
        and ae.workspace_id = arq.workspace_id
      where p.workspace_id = ${wsId} and p.codigo = 'P-01'
    )
    select e.id, e.titulo, u.papel
    from (select * from citada union all select * from del_arquetipo) u
    join evidencia e on e.id = u.ev and e.workspace_id = ${wsId}
    left join derecho_uso d on d.evidencia_id = e.id and d.workspace_id = ${wsId}
    where d.id is null or d.estado = 'pendiente'
    order by e.id, u.papel`;
  if (alcanzables.length === 0) return;

  const payload = {
    motivo:
      'la cadena de demo de este workspace no la sembró este seed (no hay registro de procedencia), así que no se concede nada: la evidencia alcanzable puede ser material de un usuario y firmarle derechos en nombre de Lucía sería inventar un consentimiento',
    remedio:
      'si estos derechos proceden de verdad, concédelos a mano desde la pantalla de evidencia, con su base documental y su responsable',
    evidencias: alcanzables.map((f) => ({
      evidenciaId: f.id as string,
      titulo: f.titulo as string,
      papel: f.papel as string,
    })),
  };
  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    select ${wsId}, ${AVISO_CADENA_SIN_PROCEDENCIA}, ${tx.json(payload)}, null, null
    where not exists (select 1 from evento_dominio e
      where e.workspace_id = ${wsId} and e.tipo = ${AVISO_CADENA_SIN_PROCEDENCIA}
        and e.payload = ${tx.json(payload)})`;
}

/**
 * Repara los derechos de una base sembrada por una versión ANTERIOR, donde la cadena ya
 * existe pero el backfill de 20260902140000 dejó sus derechos en 'pendiente'.
 *
 * Solo repara LO QUE ESTE SEED REGISTRÓ HABER CREADO. La versión anterior acreditaba la
 * procedencia recorriendo relaciones desde `proyecto.codigo = 'P-01'` y concedía si el
 * camino devolvía exactamente una evidencia. Emparejar por relaciones es mejor que por
 * título, pero seguía siendo una INFERENCIA sobre la FORMA de la base, y hay un caso que
 * la rompe entera: si la cadena de demo nunca se sembró —porque el workspace ya tenía un
 * insight propio y `sembrarCadena` se saltó— pero alguien construyó su decisión sobre el
 * G1 de P-01 citando SU evidencia, el camino devuelve exactamente una: la suya. Y el seed
 * le firmaba derechos de ámbito CLIENTE en nombre de Lucía, que nunca los concedió. La
 * forma de la base no dice quién escribió sus filas.
 *
 * Así que la procedencia ya no se deduce: se LEE. `sembrarCadena` deja constancia de lo
 * que crea —una fila de `sembrado_registro` con los ids de sus dos evidencias— y la
 * reparación concede solo a esos ids. Sin ese registro no hay nada que acreditar y NO SE
 * CONCEDE NADA: fallar cerrado, no adoptar. En su lugar queda un evento que nombra lo que
 * habría tocado, para que un operador lo conceda a mano si de verdad procede — que es como
 * debe entrar un consentimiento en un producto cuya tesis es que conceder el uso es un
 * acto propio, con su base documental y su responsable.
 *
 * Y el registro SÍ es un sello, que es lo que le faltaba a la versión anterior. Vivió un
 * rato en `evento_dominio`, y ahí no lo era: la política `evento_insert` autoriza a
 * CUALQUIER miembro a escribir eventos, mientras que conceder derechos está reservado a
 * lead-boutique y admin-cliente. Un stakeholder podía escribir su propio registro de
 * procedencia y esperar a la siguiente corrida del seed para cobrar derechos de ámbito
 * cliente a nombre de Lucía: una escalada de privilegio con dos pasos y una espera. Ahora
 * vive en `sembrado_registro`, que el rol de aplicación puede leer y NO puede escribir —
 * sin política ni grant de insert/update/delete—, así que la ausencia de otra mano es
 * estructural y no hay que razonar sobre quién mentiría.
 *
 * La concesión sigue acotada además por lo de siempre: solo evidencia DE ESTE workspace y
 * solo mientras su derecho siga en 'pendiente' (lo decidido a mano nunca se pisa).
 */
async function repararDerechosDeCadena(
  tx: TransactionSql,
  wsId: string,
  luciaId: string,
): Promise<void> {
  const [marca] = await tx`select payload from sembrado_registro
    where workspace_id = ${wsId} and clave = ${CLAVE_CADENA_SEMBRADA}`;
  const registro = (marca?.payload ?? {}) as {
    evidenciaCitadaId?: unknown;
    evidenciaArquetipoId?: unknown;
  };
  // La forma de uuid se comprueba ANTES de consultar: el payload es jsonb libre y un
  // `id in ('no-soy-uuid')` no devuelve cero filas, revienta la sentencia y con ella el
  // seed entero. Fallar cerrado aquí significa declinar, no caerse.
  const declarados = [
    { evidenciaId: registro.evidenciaCitadaId, base: BASE_DERECHO_CITADA },
    { evidenciaId: registro.evidenciaArquetipoId, base: BASE_DERECHO_ARQUETIPO },
  ].filter(
    (f): f is { evidenciaId: string; base: string } =>
      typeof f.evidenciaId === 'string' && UUID.test(f.evidenciaId),
  );
  if (declarados.length === 0) {
    await declinarReparacionDeCadena(tx, wsId);
    return;
  }

  // El registro nombra ids, y que esos ids sean de ESTE workspace no se da por supuesto.
  // No porque quepa una falsificación —ya no cabe— sino porque un payload es dato libre y
  // una pieza futura del seed podría escribir ahí un id equivocado; el filtro cuesta una
  // consulta y evita que un registro torcido alcance material de otro tenant.
  const propias = await tx`select id from evidencia
    where workspace_id = ${wsId} and id in ${tx(declarados.map((f) => f.evidenciaId))}`;
  const enElWorkspace = new Set(propias.map((f) => f.id as string));
  const acreditados = declarados.filter((f) => enElWorkspace.has(f.evidenciaId));
  if (acreditados.length === 0) {
    await declinarReparacionDeCadena(tx, wsId);
    return;
  }
  await concederDerechosDeCadena(tx, wsId, luciaId, acreditados);
}

/**
 * Journey as-is del servicio (SPEC-05): un grafo pequeño pero completo — dos fases con
 * sus pasos, el canal donde ocurren, el sistema que los sostiene y la fricción que duele.
 *
 * Deliberadamente SIN evidencia enlazada: la pantalla de validación tiene que mostrar
 * señales de verdad en la demo. Un journey de ejemplo que sale impecable enseñaría a
 * ignorar el informe. Devuelve si lo creó en esta corrida.
 */
async function sembrarJourney(tx: TransactionSql, wsId: string, luciaId: string): Promise<boolean> {
  // El grafo del as-is deja el mismo rastro que el del to-be: su trigger de auditoría no
  // mira la membresía, así que sin actor declarado escribía veinte eventos sin autor.
  await declararActor(tx, luciaId);
  const [svc] = await tx`select id from servicio
    where workspace_id = ${wsId} and nombre = 'Apertura de cuenta nómina digital'`;
  if (!svc) return false;
  const existe = await tx`select 1 from journey where workspace_id = ${wsId}`;
  if (existe.length > 0) return false;
  const svcId = svc.id as string;

  const [r01] = await tx`select id from reto where workspace_id = ${wsId} and codigo = 'R-01'`;
  const [p01] = await tx`select id from proyecto where workspace_id = ${wsId} and codigo = 'P-01'`;
  const [j] = await tx`insert into journey
    (workspace_id, servicio_id, reto_id, proyecto_id, tipo, nombre, descripcion, creado_por) values
    (${wsId}, ${svcId}, ${(r01?.id as string) ?? null}, ${(p01?.id as string) ?? null},
     'as-is', 'Apertura hoy',
     'Desde que el empleado recibe el enlace del convenio hasta su primer movimiento',
     ${luciaId}) returning id`;
  const jId = j!.id as string;

  /** Los tipos que son entidades DEL SERVICIO llevan identidad de catálogo. */
  const CON_CATALOGO = ['touchpoint', 'canal', 'actor', 'sistema'];

  /** Alta de un nodo devolviendo su id: el orden se pasa explícito porque aquí el
   * grafo se escribe entero de una vez y su secuencia es parte del ejemplo. */
  async function nodo(
    tipo: string,
    etiqueta: string,
    orden: number,
    faseId: string | null,
    responsable = '',
  ): Promise<string> {
    let catalogoId: string | null = null;
    if (CON_CATALOGO.includes(tipo)) {
      const [c] = await tx`insert into catalogo_journey
        (workspace_id, servicio_id, tipo, nombre, creado_por)
        values (${wsId}, ${svcId}, ${tipo}, ${etiqueta}, ${luciaId})
        on conflict (workspace_id, servicio_id, tipo, nombre)
          do update set nombre = excluded.nombre
        returning id`;
      catalogoId = c!.id as string;
    }
    const [n] = await tx`insert into journey_nodo
      (workspace_id, journey_id, tipo, etiqueta, fase_id, orden, responsable, catalogo_id, creado_por)
      values (${wsId}, ${jId}, ${tipo}, ${etiqueta}, ${faseId}, ${orden}, ${responsable},
              ${catalogoId}, ${luciaId})
      returning id`;
    return n!.id as string;
  }

  const solicitud = await nodo('fase', 'Solicitud', 0, null);
  const verificacion = await nodo('fase', 'Verificación', 1, null);

  const abre = await nodo('paso', 'Abre el enlace del convenio', 0, solicitud);
  const datos = await nodo('paso', 'Completa sus datos', 1, solicitud);
  const documento = await nodo('paso', 'Sube el documento de identidad', 2, verificacion);
  const espera = await nodo('paso', 'Espera la validación', 3, verificacion);
  const firma = await nodo('paso', 'Firma el contrato', 4, verificacion);

  const app = await nodo('canal', 'App móvil', 0, null);
  const core = await nodo('sistema', 'Core bancario', 0, null, 'Tecnología');
  const buro = await nodo('accion-backstage', 'Valida contra el buró', 0, verificacion, 'Riesgo');
  const rechazo = await nodo('friccion', 'Rechazo sin motivo explicado', 0, verificacion);

  await tx`insert into journey_arista
    (workspace_id, journey_id, origen_id, destino_id, tipo, condicion, creado_por) values
    (${wsId}, ${jId}, ${abre}, ${datos}, 'transicion', '', ${luciaId}),
    (${wsId}, ${jId}, ${datos}, ${documento}, 'transicion', '', ${luciaId}),
    (${wsId}, ${jId}, ${documento}, ${espera}, 'transicion', '', ${luciaId}),
    (${wsId}, ${jId}, ${espera}, ${firma}, 'transicion', 'documento aceptado', ${luciaId}),
    (${wsId}, ${jId}, ${espera}, ${documento}, 'transicion', 'documento rechazado', ${luciaId}),
    (${wsId}, ${jId}, ${abre}, ${app}, 'ocurre-en', '', ${luciaId}),
    (${wsId}, ${jId}, ${core}, ${espera}, 'soporta', '', ${luciaId}),
    (${wsId}, ${jId}, ${buro}, ${espera}, 'soporta', '', ${luciaId}),
    (${wsId}, ${jId}, ${rechazo}, ${espera}, 'duele', '', ${luciaId})`;

  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
    (${wsId}, 'JourneyCreado', ${tx.json({ nombre: 'Apertura hoy', tipo: 'as-is', origen: 'seed' })}, ${luciaId}, 'lead-boutique')`;
  return true;
}

/**
 * La cadena de resultado de demo (SPEC-06): journey to-be, DV-1 aprobada con cuatro
 * elementos de cambio, RL-1 desplegado y constatado con una desviación, y RL-2 con el
 * cuarto elemento pendiente. Es literalmente el ejemplo de los criterios de aceptación
 * 2, 3 y 4 de la spec: la parcialidad explícita se ve, la desviación lleva su razón, y
 * G7 queda BLOQUEADO porque el elemento de RL-2 sigue en estado desconocido.
 *
 * Un demo con la conciliación cuadrada enseñaría a ignorar el tablero. Idempotente: la
 * señal es la presencia de design versions en el workspace. Devuelve si la creó ahora.
 */
/**
 * La cadena de entrega del ejemplo trabajado, sembrada COMO NACE DE VERDAD y no como queda.
 *
 * Son tres transacciones y no una a propósito. Una design version nace en BORRADOR, recibe
 * sus elementos, y se aprueba DESPUÉS —congelando el snapshot en esa misma transición—. El
 * seed insertaba la fila ya 'aprobada' y le colgaba los elementos detrás, que es un estado
 * que el producto no puede producir: se saltaba el guard de transición entero y era, de
 * hecho, un segundo escritor con reglas propias. Desde que un constraint trigger diferido
 * exige que un elemento solo entre en un borrador, ese atajo ya no cuela — y menos mal,
 * porque el fixture estaba mintiendo sobre cómo se crea el dato.
 *
 * Ahora el seed pasa por los MISMOS guards que la aplicación, así que cada `db:seed` es
 * también una prueba de que el camino de aprobación funciona de punta a punta.
 */
async function sembrarEntrega(
  conexion: typeof sql,
  wsId: string,
  luciaId: string,
): Promise<boolean> {
  const yaHay = await conexion`select 1 from design_version where workspace_id = ${wsId}`;
  if (yaHay.length > 0) return false;
  const ids = await conexion.begin(async (tx) => {
    await declararActor(tx, luciaId);
    const [svc] = await tx`select id from servicio
      where workspace_id = ${wsId} and nombre = 'Apertura de cuenta nómina digital'`;
    const [p01] = await tx`select id from proyecto where workspace_id = ${wsId} and codigo = 'P-01'`;
    if (!svc || !p01) return null;
    const svcId = svc.id as string;
    const proyectoId = p01.id as string;

    // ── El to-be: el mismo grafo tipado, con lo que la design version viene a cambiar ──
    const [r01] = await tx`select id from reto where workspace_id = ${wsId} and codigo = 'R-01'`;
    const [j] = await tx`insert into journey
      (workspace_id, servicio_id, reto_id, proyecto_id, tipo, nombre, descripcion, creado_por) values
      (${wsId}, ${svcId}, ${(r01?.id as string) ?? null}, ${proyectoId},
       'to-be', 'Apertura con verificación asistida',
       'El mismo recorrido con la verificación resuelta en la app y el rechazo explicado',
       ${luciaId}) returning id`;
    const jId = j!.id as string;

    /** Los tipos que son entidades DEL SERVICIO llevan identidad de catálogo. */
    const CON_CATALOGO = ['touchpoint', 'canal', 'actor', 'sistema'];
    async function nodo(
      tipo: string,
      etiqueta: string,
      orden: number,
      faseId: string | null,
      responsable = '',
    ): Promise<string> {
      let catalogoId: string | null = null;
      if (CON_CATALOGO.includes(tipo)) {
        // El catálogo da identidad COMPARTIDA dentro del servicio: el core bancario del
        // as-is y el del to-be son el mismo objeto, y por eso el upsert reusa.
        const [c] = await tx`insert into catalogo_journey
          (workspace_id, servicio_id, tipo, nombre, creado_por)
          values (${wsId}, ${svcId}, ${tipo}, ${etiqueta}, ${luciaId})
          on conflict (workspace_id, servicio_id, tipo, nombre)
            do update set nombre = excluded.nombre
          returning id`;
        catalogoId = c!.id as string;
      }
      const [n] = await tx`insert into journey_nodo
        (workspace_id, journey_id, tipo, etiqueta, fase_id, orden, responsable, catalogo_id, creado_por)
        values (${wsId}, ${jId}, ${tipo}, ${etiqueta}, ${faseId}, ${orden}, ${responsable},
                ${catalogoId}, ${luciaId})
        returning id`;
      return n!.id as string;
    }

    const solicitud = await nodo('fase', 'Solicitud', 0, null);
    const verificacion = await nodo('fase', 'Verificación', 1, null);
    const abre = await nodo('paso', 'Abre el enlace del convenio', 0, solicitud);
    const datos = await nodo('paso', 'Completa sus datos', 1, solicitud);
    const video = await nodo('touchpoint', 'Video-verificación asistida', 0, null);
    const verifica = await nodo('paso', 'Se verifica en video con un asesor', 2, verificacion);
    const motivo = await nodo('paso', 'Recibe el motivo del rechazo explicado', 3, verificacion);
    const firma = await nodo('paso', 'Firma el contrato', 4, verificacion);
    const app = await nodo('canal', 'App móvil', 0, null);
    const core = await nodo('sistema', 'Core bancario', 0, null, 'Tecnología');
    const excepciones = await nodo('accion-backstage', 'Revisión manual solo de excepciones', 0, verificacion, 'Riesgo');

    await tx`insert into journey_arista
      (workspace_id, journey_id, origen_id, destino_id, tipo, condicion, creado_por) values
      (${wsId}, ${jId}, ${abre}, ${datos}, 'transicion', '', ${luciaId}),
      (${wsId}, ${jId}, ${datos}, ${verifica}, 'transicion', '', ${luciaId}),
      (${wsId}, ${jId}, ${verifica}, ${firma}, 'transicion', 'identidad confirmada', ${luciaId}),
      (${wsId}, ${jId}, ${verifica}, ${motivo}, 'transicion', 'identidad rechazada', ${luciaId}),
      (${wsId}, ${jId}, ${abre}, ${app}, 'ocurre-en', '', ${luciaId}),
      (${wsId}, ${jId}, ${verifica}, ${video}, 'ocurre-en', '', ${luciaId}),
      (${wsId}, ${jId}, ${core}, ${verifica}, 'soporta', '', ${luciaId}),
      (${wsId}, ${jId}, ${excepciones}, ${verifica}, 'soporta', '', ${luciaId})`;


    // La design version NACE EN BORRADOR y recibe sus elementos aquí. Aprobarla es otra
    // transición y va en su propia transacción, abajo: un elemento solo entra en un borrador
    // (lo impone elemento_cambio_version_editable_guard, que es diferido y mira al COMMIT).
    const [dv] = await tx`insert into design_version
      (workspace_id, proyecto_id, servicio_id, journey_id, titulo, resumen, creado_por) values
      (${wsId}, ${proyectoId}, ${svcId}, ${jId},
       'Verificación asistida y rechazo explicado',
       'Resuelve la verificación dentro de la app y devuelve el motivo del rechazo al cliente',
       ${luciaId}) returning id`;
    const dvId = dv!.id as string;

    async function elemento(
      tipo: string,
      operacion: string,
      titulo: string,
      detalle: string,
      nodoId: string,
      orden: number,
    ): Promise<string> {
      const [e] = await tx`insert into elemento_cambio
        (workspace_id, design_version_id, tipo, operacion, titulo, detalle, nodo_id, orden, creado_por)
        values (${wsId}, ${dvId}, ${tipo}, ${operacion}, ${titulo}, ${detalle}, ${nodoId}, ${orden},
                ${luciaId}) returning id`;
      return e!.id as string;
    }

    const elVideo = await elemento('touchpoint', 'agrega', 'Video-verificación asistida en la app',
      'Un asesor confirma la identidad en video sin salir del flujo', video, 0);
    const elExcepciones = await elemento('proceso-backstage', 'modifica', 'Revisión manual solo de excepciones',
      'Riesgo deja de revisar el 100% y pasa a revisar lo que el motor marca', excepciones, 1);
    const elMotivo = await elemento('politica', 'modifica', 'El motivo del rechazo se explica al cliente',
      'La política de no revelar criterios se sustituye por un motivo accionable', motivo, 2);
    const elCore = await elemento('sistema', 'modifica', 'Integración del core con el proveedor de identidad',
      'El core consulta al proveedor en línea en vez de por lote nocturno', core, 3);

    // La cadena hacia atrás: los elementos citan el insight validado y la decisión de G1.
    const [ins] = await tx`select id from insight where workspace_id = ${wsId} and estado = 'validado' limit 1`;
    const [dec] = await tx`select id from decision where workspace_id = ${wsId} limit 1`;
    if (ins) {
      await tx`insert into elemento_insight (elemento_id, insight_id, workspace_id, creado_por) values
        (${elVideo}, ${ins.id as string}, ${wsId}, ${luciaId}),
        (${elMotivo}, ${ins.id as string}, ${wsId}, ${luciaId})`;
    }
    if (dec) {
      await tx`insert into elemento_decision (elemento_id, decision_id, workspace_id, creado_por) values
        (${elVideo}, ${dec.id as string}, ${wsId}, ${luciaId}),
        (${elExcepciones}, ${dec.id as string}, ${wsId}, ${luciaId})`;
    }

    return { jId, dvId, svcId, elVideo, elExcepciones, elMotivo, elCore };
  });
  if (!ids) return false;
  const { jId, dvId, svcId, elVideo, elExcepciones, elMotivo, elCore } = ids;

  // La APROBACIÓN, en su propia transacción y por el camino real: el guard exige que el
  // snapshot se tome en esta misma transición (xmin), así que congelar y aprobar van
  // juntos — igual que en `aprobarDesignVersion`. Se declara quién actúa porque los
  // guards levantan eventos de dominio con el actor y su rol.
  await conexion.begin(async (tx) => {
    await declararActor(tx, luciaId);
    // ── DV-1 aprobada: el snapshot del grafo congelado es parte de la aprobación ──
    const [snap] = await tx`insert into journey_snapshot
      (workspace_id, journey_id, motivo, grafo, congelado_por) values
      (${wsId}, ${jId}, 'Aprobación de DV-1',
       jsonb_build_object(
         'nodos', coalesce((select jsonb_agg(to_jsonb(n) order by n.orden) from journey_nodo n
           where n.journey_id = ${jId} and n.workspace_id = ${wsId}), '[]'::jsonb),
         'aristas', coalesce((select jsonb_agg(to_jsonb(a) order by a.creado_en) from journey_arista a
           where a.journey_id = ${jId} and a.workspace_id = ${wsId}), '[]'::jsonb),
         'evidencias', '[]'::jsonb),
       ${luciaId}) returning id`;

    await tx`update design_version
      set estado = 'aprobada', snapshot_id = ${snap!.id as string}, aprobada_por = ${luciaId}
      where id = ${dvId} and workspace_id = ${wsId}`;
  });

  const releaseDesplegado = await conexion.begin(async (tx) => {
    await declararActor(tx, luciaId);
    // ── RL-1: tres de los cuatro elementos, desplegado y constatado ──
    // Nace PLANIFICADO y recorre sus transiciones, no se fabrica ya verificado. El alcance de
    // un release que ya salió es FIJO (lo impone release_alcance_fijo_guard, diferido), así
    // que declararlo antes de desplegar no es un detalle de orden: es la única forma en que
    // este dato puede existir. Verificar va al final, cuando ya están sus constataciones.
    const [rl1] = await tx`insert into release
      (workspace_id, design_version_id, titulo, responsable, fecha_objetivo, creado_por) values
      (${wsId}, ${dvId}, 'Verificación en la app', 'Equipo de canales digitales',
       '2026-08-10', ${luciaId}) returning id`;
    const rl1Id = rl1!.id as string;
    await tx`insert into release_elemento (elemento_id, release_id, workspace_id, razon, creado_por) values
      (${elVideo}, ${rl1Id}, ${wsId}, '', ${luciaId}),
      (${elExcepciones}, ${rl1Id}, ${wsId}, '', ${luciaId}),
      (${elMotivo}, ${rl1Id}, ${wsId}, '', ${luciaId})`;


    // ── RL-2: el cuarto elemento, con la razón de su parcialidad (§19.5) ──
    const [rl2] = await tx`insert into release
      (workspace_id, design_version_id, titulo, responsable, fecha_objetivo, creado_por)
      values (${wsId}, ${dvId}, 'Integración en línea con identidad',
       'Equipo de core bancario', '2026-10-15', ${luciaId}) returning id`;
    await tx`insert into release_elemento (elemento_id, release_id, workspace_id, razon, creado_por)
      values (${elCore}, ${rl2!.id as string}, ${wsId}, 'dependencia del área de riesgo', ${luciaId})`;
    return rl1Id;
  });

  // El DESPLIEGUE, en su propia transacción. Las comprobaciones diferidas miran al COMMIT, no
  // a mitad de la transacción, así que declarar el alcance y salir tienen que ser dos commits
  // — que es además lo que son en la vida real: planificar y desplegar son dos actos.
  await conexion.begin(async (tx) => {
    await declararActor(tx, luciaId);
    await tx`update release set estado = 'desplegado', desplegado_en = '2026-08-10'
      where id = ${releaseDesplegado} and workspace_id = ${wsId}`;
  });

  // Y la CONSTATACIÓN, que es el tercer acto: el effective state con la constatación de cada
  // elemento y el release a verificado, inseparables y en la misma transacción.
  await conexion.begin(async (tx) => {
    await declararActor(tx, luciaId);
    const rl1Id = releaseDesplegado;
    // ── ES-1: cómo quedó de verdad, con la desviación y su razón (SYS-07) ──
    const [es] = await tx`insert into effective_state
      (workspace_id, servicio_id, release_id, resumen, constatado_por, constatado_en) values
      (${wsId}, ${svcId}, ${rl1Id},
       'La verificación en video opera desde el 10 de agosto; el motivo del rechazo salió distinto',
       ${luciaId}, '2026-08-20') returning id`;
    await tx`insert into constatacion
      (workspace_id, effective_state_id, elemento_id, resultado, que_quedo_distinto, razon, creado_por) values
      (${wsId}, ${es!.id as string}, ${elVideo}, 'como-aprobado', '', '', ${luciaId}),
      (${wsId}, ${es!.id as string}, ${elExcepciones}, 'como-aprobado', '', '', ${luciaId}),
      (${wsId}, ${es!.id as string}, ${elMotivo}, 'desviado',
       'El motivo llega por correo horas después, no en pantalla: la verificación quedó diferida',
       'Cumplimiento exigió un paso adicional de revisión antes de mostrar el motivo',
       ${luciaId})`;
    // Y solo AHORA se verifica: el guard exige la constatación de cada elemento del release,
    // y el diferido de effective_state exige que el release acabe verificado. Las dos mitades
    // de la operación son inseparables, y el seed las hace en el mismo orden que el servicio.
    await tx`update release set estado = 'verificado'
      where id = ${rl1Id} and workspace_id = ${wsId}`;

    // Del acta de esta cadena no se escribe NADA a mano: la levantan los mismos triggers
    // que en producción —planificar, desplegar, constatar, registrar la desviación y
    // verificar—, ahora que el actor está declarado. Lo que había aquí duplicaba dos de
    // esos eventos (`ReleaseDesplegado` y `ReleaseVerificado`, cuyo guard audita sin
    // mirar la membresía) y dejaba los otros cuatro escritos por una segunda mano con su
    // propio formato de payload. Los pares del acta no se apañan omitiendo la fila que
    // sobra: se apañan diciendo quién escribe, que es lo que le faltaba al seed.
    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
      (${wsId}, 'JourneyCreado', ${tx.json({ nombre: 'Apertura con verificación asistida', tipo: 'to-be', origen: 'seed' })}, ${luciaId}, 'lead-boutique')`;
  });

  // ── El acta de la cadena, contada ──
  // Un evento de más no rompe nada: el seed termina, la pantalla pinta y el rastro miente
  // en silencio. Es justo por eso que esto se comprueba aquí, que es la única red que el
  // seed tiene. Un acto, un evento, y todos con autor.
  const ACTOS = {
    DesignVersionBorrador: 1,
    DesignVersionAprobada: 1,
    ReleasePlanificado: 2,
    ReleaseDesplegado: 1,
    EffectiveStateConstatado: 1,
    DesviacionRegistrada: 1,
    ReleaseVerificado: 1,
  } as const;
  const acta = await conexion`select tipo, count(*)::int as n,
      count(*) filter (where actor_id is null)::int as sin_autor
    from evento_dominio
    where workspace_id = ${wsId} and tipo in ${conexion(Object.keys(ACTOS))}
    group by tipo`;
  const contados = new Map(acta.map((f) => [f.tipo as string, f]));
  for (const [tipo, esperados] of Object.entries(ACTOS)) {
    const f = contados.get(tipo);
    if (!f || f.n !== esperados) {
      throw new Error(
        `seed: el acta de la entrega esperaba ${esperados} evento(s) ${tipo} y tiene ${f?.n ?? 0}`,
      );
    }
    if (f.sin_autor > 0) {
      throw new Error(`seed: ${f.sin_autor} evento(s) ${tipo} sin autor: falta declarar quién escribe`);
    }
  }
  return true;
}

/** Cadena de razonamiento de demo (SPEC-03/04): evidencia curada → insight validado
 * con citas y una contradicción a la vista → decisión aprobada en G1 y un arquetipo
 * confirmado. Es lo que hace demostrable el grafo sin pasar por toda la curaduría.
 * Idempotente: la señal es el insight del workspace — pero los DERECHOS de la cadena se
 * atienden en las dos ramas, porque una base sembrada por una versión anterior ya tiene
 * el insight y aun así necesita repararlos. Al crearla, deja constancia de qué evidencia
 * es suya: sin esa constancia la reparación no tiene forma honesta de saberlo. */
async function sembrarCadena(tx: TransactionSql, wsId: string, luciaId: string): Promise<void> {
  const yaHay = await tx`select 1 from insight where workspace_id = ${wsId}`;
  if (yaHay.length > 0) {
    // Aquí NO se sabe que la cadena esté sembrada: se sabe que el workspace tiene algún
    // insight, que es la señal de idempotencia — y un insight lo crea también un usuario.
    // La distinción importa, porque el caso interesante es el otro: una base sembrada por
    // una versión ANTERIOR a que esta función creara los derechos de sus dos evidencias.
    // Ahí el backfill de la migración 140000 les puso una fila 'pendiente' (fail-closed,
    // correcto en general) y tras el upgrade el demo se contradice: un insight validado
    // cuya cita apunta a evidencia bloqueada, una cita que hoy el propio producto no
    // dejaría crear. Reparar eso es legítimo; adivinar CUÁL evidencia reparar, no. Por eso
    // la reparación lee el registro de procedencia en vez de deducirlo de la forma de la
    // base, y sin registro no concede nada.
    await repararDerechosDeCadena(tx, wsId, luciaId);
    return;
  }

  const [fuente] = await tx`insert into fuente (workspace_id, tipo, titulo, referencia, creado_por)
    values (${wsId}, 'documento', 'Estudio CX apertura de cuenta 2026',
      'Consultora externa · informe interno 2026-06', ${luciaId})
    returning id`;
  const fuenteId = fuente!.id as string;
  const [ev1] = await tx`insert into evidencia
    (workspace_id, fuente_id, titulo, resumen, dimensiones, es_estado_actual, creado_por)
    values (${wsId}, ${fuenteId}, 'Funnel de apertura: 62% de abandono en verificación',
      'Analítica del embudo entre enero y junio',
      ${tx.json({
        proveniencia: { tipoFuente: 'documento', fecha: '2026-06-30', localizacion: 'p. 14' },
        metodo: { recoleccion: 'analitica', derivada: false, segmentoIds: [] },
        calidad: { confianza: 'alta', corroboraIds: [], contradiceIds: [] },
        derechos: { consentimiento: true, confidencialidad: 'cliente' },
      })}, true, ${luciaId})
    returning id`;
  const [ev2] = await tx`insert into evidencia
    (workspace_id, fuente_id, titulo, resumen, dimensiones, es_estado_actual, creado_por)
    values (${wsId}, ${fuenteId}, 'Entrevistas en sucursal: abandono del 20%',
      'Seis entrevistas con asesores de sucursal',
      ${tx.json({
        proveniencia: { tipoFuente: 'entrevista', fecha: '2026-07-02', localizacion: 'sesión 3' },
        metodo: { recoleccion: 'entrevista', derivada: false, segmentoIds: [] },
        calidad: { confianza: 'media', corroboraIds: [], contradiceIds: [] },
        derechos: { consentimiento: true, confidencialidad: 'cliente' },
      })}, false, ${luciaId})
    returning id`;
  const evDigital = ev1!.id as string;
  const evSucursal = ev2!.id as string;
  // Alta: los ids acaban de salir del INSERT, así que la procedencia es certeza y no hay
  // nada que emparejar. Emparejar por título aquí era, además de peligroso, innecesario.
  await concederDerechosDeCadena(tx, wsId, luciaId, [
    { evidenciaId: evDigital, base: BASE_DERECHO_CITADA },
    { evidenciaId: evSucursal, base: BASE_DERECHO_ARQUETIPO },
  ]);
  // Y queda CONSTANCIA de qué evidencia creó ESTA corrida, en `sembrado_registro`, que el
  // rol de aplicación puede leer y NO puede escribir. No es decoración: es lo único que una
  // corrida futura puede leer para reparar sin adivinar. Deducir la procedencia de la FORMA
  // de la base —«el único camino desde P-01 llega aquí»— adopta lo que encuentre, y lo que
  // encuentre puede ser material de un usuario. Ver `repararDerechosDeCadena`, que lo lee.
  await tx`insert into sembrado_registro (workspace_id, clave, payload)
    values (${wsId}, ${CLAVE_CADENA_SEMBRADA}, ${tx.json({
      evidenciaCitadaId: evDigital,
      evidenciaArquetipoId: evSucursal,
    })})
    on conflict (workspace_id, clave) do nothing`;

  const [ins] = await tx`insert into insight (workspace_id, titulo, resumen, estado, validado_por, validado_en, creado_por)
    values (${wsId}, 'La verificación de identidad digital concentra el abandono',
      'El corte por canal muestra que el problema es del canal digital, no del proceso completo',
      'validado', ${luciaId}, now(), ${luciaId})
    returning id`;
  const insightId = ins!.id as string;
  const [af1] = await tx`insert into afirmacion (workspace_id, insight_id, orden, texto, es_hipotesis)
    values (${wsId}, ${insightId}, 0, '62 de cada 100 solicitudes digitales se detienen al cargar el documento', false)
    returning id`;
  await tx`insert into afirmacion (workspace_id, insight_id, orden, texto, es_hipotesis)
    values (${wsId}, ${insightId}, 1, 'El rechazo probablemente crece con documentos vencidos', true)`;
  await tx`insert into cita (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
    values (${wsId}, ${af1!.id as string}, ${evDigital},
      'De cada 100 solicitudes iniciadas en canal digital, 62 se detienen en la carga del documento',
      'p. 14', ${luciaId})`;
  // La contradicción se siembra a la vista: el mismo dato en sucursal no cuadra.
  await tx`insert into contradiccion (workspace_id, insight_id, evidencia_id, descripcion, creado_por)
    values (${wsId}, ${insightId}, ${evSucursal},
      'En sucursal el abandono es del 20%: el problema puede ser del canal, no del requisito',
      ${luciaId})`;

  const [p01] = await tx`select p.id, p.reto_id from proyecto p
    where p.workspace_id = ${wsId} and p.codigo = 'P-01'`;
  if (p01) {
    const [g1] = await tx`select id from gate_instancia
      where proyecto_id = ${p01.id as string} and workspace_id = ${wsId} and numero = 1`;
    if (g1) {
      const [dec] = await tx`insert into decision
        (workspace_id, proyecto_id, gate_id, tipo, titulo, fundamento, decidido_por)
        values (${wsId}, ${p01.id as string}, ${g1.id as string}, 'diseno',
          'Atacar la verificación digital antes que el resto del embudo',
          'El insight validado concentra el abandono ahí; sucursal queda fuera del alcance',
          ${luciaId})
        returning id`;
      await tx`insert into decision_insight (decision_id, insight_id, workspace_id)
        values (${dec!.id as string}, ${insightId}, ${wsId})`;
    }
    const [arq] = await tx`insert into arquetipo
      (workspace_id, reto_id, nombre, definicion, estado, veredicto_razon, creado_por)
      values (${wsId}, ${p01.reto_id as string}, 'Independiente sin firma digital',
        'Trabaja por cuenta propia, sin certificado digital vigente',
        'confirmado', 'Tres de las seis entrevistas encajan con el perfil', ${luciaId})
      returning id`;
    await tx`insert into arquetipo_evidencia (arquetipo_id, evidencia_id, workspace_id)
      values (${arq!.id as string}, ${evSucursal}, ${wsId})`;
    const [seg] = await tx`select id from segmento
      where workspace_id = ${wsId} and nombre = 'independientes'`;
    if (seg) {
      await tx`insert into arquetipo_segmento (arquetipo_id, segmento_id, workspace_id)
        values (${arq!.id as string}, ${seg.id as string}, ${wsId})`;
    }
  }
}

const TITULO_ITEM_AI = 'Notas del análisis de funnel de apertura (julio 2026)';

/** Material de bandeja del que cuelga la propuesta AI de demo. Es texto NO confiable:
 * entra al prompt delimitado como dato y las citas se verifican contra él. */
const MATERIAL_ITEM_AI = [
  'Notas de la sesión de análisis del funnel de apertura (julio 2026).',
  '',
  'De cada 100 personas que inician la apertura, 62 no la completan. El 71% de los abandonos ocurre en la pantalla de carga del documento de identidad.',
  '',
  'Cita del equipo de Riesgo: "cuando el buró no responde en 30 segundos, la solicitud queda en espera y el cliente no recibe ningún aviso".',
  '',
  'El rechazo del documento no explica el motivo: el usuario reintenta con la misma foto una media de 2,4 veces antes de abandonar.',
].join('\n');

/**
 * Propuesta AI pendiente de revisión (SPEC-08): un item de bandeja con su candidato a
 * evidencia esperando que una persona acepte, corrija o rechace. Nada del dominio existe
 * todavía — es exactamente lo que la demo tiene que enseñar (I4).
 *
 * Igual que el journey de demo, la propuesta viene con una IMPERFECCIÓN deliberada: de
 * sus tres citas, una no aparece literal en el material. Una propuesta impecable de
 * ejemplo enseñaría a aceptar sin mirar; esta enseña dónde está la señal de alarma.
 *
 * Idempotente por presencia de propuestas en el workspace (y el item, por título).
 * Devuelve si la creó en esta corrida.
 */
async function sembrarPropuestaAI(
  tx: TransactionSql,
  wsId: string,
  luciaId: string,
): Promise<boolean> {
  const existe = await tx`select 1 from propuesta_ai where workspace_id = ${wsId}`;
  if (existe.length > 0) return false;

  const [yaItem] = await tx`select id from item_importacion
    where workspace_id = ${wsId} and titulo = ${TITULO_ITEM_AI}`;
  let itemId = yaItem?.id as string | undefined;
  if (!itemId) {
    const [item] = await tx`insert into item_importacion
      (workspace_id, titulo, contenido, tipo_fuente, referencia, creado_por)
      values (${wsId}, ${TITULO_ITEM_AI}, ${MATERIAL_ITEM_AI}, 'nota',
              'carpeta compartida / analítica Q3', ${luciaId})
      returning id`;
    itemId = item!.id as string;
    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
      (${wsId}, 'ItemImportado', ${tx.json({ titulo: TITULO_ITEM_AI, origen: 'seed' })},
       ${luciaId}, 'lead-boutique')`;
  }

  const contenido: ContenidoExtraccion = {
    titulo: 'Abandono en la verificación de identidad',
    resumen:
      'El grueso del abandono se concentra en la carga del documento y en la espera del buró, sin aviso al cliente.',
    recoleccion: 'Sesión de análisis del funnel con el equipo de datos y Riesgo',
    fecha: '2026-07-20',
    fechaLocalizacion: 'cabecera de la sesión',
    fechaSinDatoMotivo: '',
    derivada: true,
    confianza: 'media',
    confidencialidad: 'cliente',
    esEstadoActual: true,
    // Lo que el modelo dice de SU propuesta, que es lo que ordena la cola de revisión. No se
    // confunde con `confianza`, que habla de la evidencia: esta propuesta se declara
    // bastante segura y aun así trae una cita inventada — que es justo la lección.
    confianzaPropuesta: 'alta',
    citas: [
      {
        fragmento:
          'El 71% de los abandonos ocurre en la pantalla de carga del documento de identidad.',
        localizacion: 'párrafo 2',
      },
      {
        fragmento:
          'cuando el buró no responde en 30 segundos, la solicitud queda en espera y el cliente no recibe ningún aviso',
        localizacion: 'párrafo 3',
      },
      {
        // Deliberadamente NO literal: la pantalla debe marcarla en rojo.
        fragmento: 'el 71% de los usuarios abandona por falta de confianza en la marca',
        localizacion: 'párrafo 2',
      },
    ],
  };

  // La llamada que la produjo, con su uso y su coste: la observabilidad de costos
  // (RF-09.14) tiene que verse en la demo, no solo existir en el esquema. Vive en su propia
  // fila porque una llamada es una unidad de gasto —aunque devuelva un lote, y aunque no
  // llegue a nacer ninguna propuesta de ella—.
  const [llamada] = await tx`insert into llamada_ai
    (workspace_id, capacidad, item_id, modelo, origen_key, resultado, tokens_entrada,
     tokens_salida, costo_usd, latencia_ms, creado_por)
    values (${wsId}, 'CI', ${itemId}, ${MODELO_PRIMARIO}, 'entorno', 'salida-valida',
            1420, 640, ${costoDeUso(MODELO_PRIMARIO, { entrada: 1420, salida: 640 })},
            1840, ${luciaId})
    returning id`;

  const [propuesta] = await tx`insert into propuesta_ai
    (workspace_id, capacidad, destino, item_id, contenido, contenido_original, confianza,
     modelo, prompt_version, alcance_resumen, origen_key, llamada_id, creado_por)
    values (${wsId}, 'CI', 'evidencia', ${itemId}, ${tx.json(contenido)}, ${tx.json(contenido)},
            -- De la MISMA tabla que usa la generación viva, no un número a mano: el seed
            -- decía 'alta' en el contenido y guardaba 0.55 en la columna, así que la tarjeta
            -- y la métrica hablaban de la misma propuesta con dos cifras distintas. Dos
            -- redacciones del mismo dato dentro de una sola fila.
            ${CONFIANZA_PROPUESTA_NUMERICA[contenido.confianzaPropuesta]},
            ${MODELO_PRIMARIO}, ${PROMPT_VERSION},
            ${`item de bandeja «${TITULO_ITEM_AI}» · ${MATERIAL_ITEM_AI.length} de ${MATERIAL_ITEM_AI.length} caracteres`},
            'entorno', ${llamada!.id as string}, ${luciaId})
    returning id`;

  // El guard de la tabla emite este evento para las escrituras CON contexto de usuario; el
  // seed corre como owner sin contexto y su pre-chequeo lo salta, así que se deja aquí.
  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
    (${wsId}, 'PropuestaAIGenerada',
     ${tx.json({
       propuestaId: propuesta!.id as string,
       capacidad: 'CI',
       destino: 'evidencia',
       modelo: MODELO_PRIMARIO,
       promptVersion: PROMPT_VERSION,
       origenKey: 'entorno',
       origen: 'seed',
     })},
     ${luciaId}, 'lead-boutique')`;
  return true;
}

/** Segundo workspace de Lucía (demo del selector multi-membresía): mínimo pero real —
 * un servicio, sin retos aún. Idempotente por MEMBRESÍA de Lucía + nombre: el nombre
 * de workspace no es único y uno homónimo ajeno no debe saltarse el seed. Devuelve si
 * lo creó en esta corrida. */
/**
 * Devuelve el ID del segundo workspace y si lo acaba de crear.
 *
 * El ID, y no solo un booleano, porque quien concede accesos no puede volver a buscarlo por
 * nombre: `workspace.nombre` no es único y una base de desarrollo puede tener otro
 * «Clínica del Valle» de un cliente distinto. El único id fiable es el que sale de aquí.
 */
/**
 * Las claves con las que el seed sella EN `sembrado_registro` los workspaces que crea.
 *
 * Por qué ahí y no en `evento_dominio`: la política `evento_insert` autoriza a CUALQUIER
 * miembro a escribir eventos con cualquier tipo y cualquier payload, así que un evento
 * `WorkspaceCreado` con `origen: 'seed'` es una afirmación falsificable — la misma que
 * `…300000-la-procedencia-del-sembrado-no-la-escribe-la-app.sql` declaró insuficiente y
 * sustituyó por esta tabla. Lo intenté con el evento en la ronda anterior y una revisión lo
 * cazó: un miembro de un «Banco Andino» ajeno podía fabricar la marca y esperar a la
 * siguiente corrida.
 *
 * `sembrado_registro` no tiene política ni grant de INSERT para el rol de aplicación: solo
 * escribe ahí el propietario, que es quien corre este fichero. La ausencia de otra mano es
 * estructural, no una cuestión de confiar en nadie.
 */
const CLAVE_WS_PRIMARIO = 'workspace:banco-andino';
const CLAVE_WS_SEGUNDO = 'workspace:clinica-del-valle';

/** El workspace que ESTE seed creó bajo esa clave, o null si no consta. */
async function workspaceSellado(
  cliente: typeof sql | TransactionSql,
  clave: string,
): Promise<string | null> {
  const [fila] = await cliente`select workspace_id from sembrado_registro
    where clave = ${clave} order by creado_en asc, workspace_id asc limit 1`;
  return (fila?.workspace_id as string | undefined) ?? null;
}

async function sembrarSegundoWorkspace(
  tx: TransactionSql,
  luciaId: string,
): Promise<{ id: string; creado: boolean; sellado: boolean }> {
  // El SELLO primero: es el único id que acredita que este workspace salió de aquí. El
  // nombre acotado por la membresía de Lucía no vale para eso —esa cuenta demo puede estar
  // invitada a un homónimo ajeno, y entonces las dos condiciones se cumplen a la vez—, así
  // que se queda solo como respuesta a «¿hace falta crearlo?» en bases sembradas por una
  // versión anterior, que no tienen sello. `sellado` dice cuál de las dos cosas pasó, y quien
  // concede accesos solo mira las selladas.
  const yaSellado = await workspaceSellado(tx, CLAVE_WS_SEGUNDO);
  if (yaSellado) return { id: yaSellado, creado: false, sellado: true };
  const [existe] = await tx`select w.id from workspace w
    join miembro m on m.workspace_id = w.id
    where w.nombre = 'Clínica del Valle' and m.usuario_id = ${luciaId}
    order by w.creado_en asc, w.id asc`;
  if (existe) return { id: existe.id as string, creado: false, sellado: false };
  const [ws2] = await tx`insert into workspace (nombre) values ('Clínica del Valle') returning id`;
  const ws2Id = ws2!.id as string;
  await tx`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
    values (${ws2Id}, ${luciaId}, 'Lucía Ferreira', 'lucia@whitespace.demo', 'lead-boutique')`;
  await tx`insert into servicio (workspace_id, nombre, descripcion, creado_por)
    values (${ws2Id}, 'Agendamiento de citas', 'Reserva y confirmación de citas médicas', ${luciaId})`;
  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
    (${ws2Id}, 'WorkspaceCreado', ${tx.json({ nombre: 'Clínica del Valle', origen: 'seed' })}, ${luciaId}, 'lead-boutique')`;
  // Y el SELLO, donde la aplicación no escribe.
  await tx`insert into sembrado_registro (workspace_id, clave, payload)
    values (${ws2Id}, ${CLAVE_WS_SEGUNDO}, ${tx.json({ nombre: 'Clínica del Valle' })})
    on conflict (workspace_id, clave) do nothing`;
  return { id: ws2Id, creado: true, sellado: true };
}

/**
 * La cuenta PROPIA de quien despliega, por variable de entorno y no escrita aquí.
 *
 * Por qué no va en `PERSONAS`: una dirección real metida en el seed queda en el historial
 * del repositorio para siempre y se la lleva cualquiera que clone. Las tres de arriba son
 * de dominios `.demo` inexistentes a propósito; una de verdad no lo es.
 *
 * Idempotente y con la MISMA regla que las demo: si la cuenta ya existe, solo se le pone
 * contraseña cuando no tiene ninguna. Un seed que reescribiera la contraseña en cada
 * arranque convertiría una variable de entorno vieja en una puerta abierta — y este seed
 * corre en CADA despliegue con `SEED_ON_START=true`.
 *
 * Entra como `lead-boutique` en los dos workspaces sembrados, que es lo que hace útil la
 * cuenta: uno solo no ejercita el selector.
 */
type AdminPropio = { email: string; clave: string; nombre: string };

/**
 * Lee y VALIDA la configuración de la cuenta propia, sin tocar la base.
 *
 * Va aparte de la siembra porque el orden importa: `sembrarAdminPropio` corre al final, y
 * comprobar allí las variables significaba que un despliegue limpio con el correo mal escrito
 * creaba los dos workspaces y las tres cuentas demo enteros y DESPUÉS salía con error. El
 * mensaje decía «no se crea nada» y la base decía otra cosa. Esto se llama antes de la
 * primera escritura, así que la promesa se cumple: o la configuración vale, o no se escribe.
 *
 * Devuelve `null` cuando no hay cuenta que sembrar; lanza cuando la hay y está mal.
 */
function leerAdminPropio(): AdminPropio | null {
  const crudo = process.env.SEED_ADMIN_EMAIL?.trim();
  if (!crudo) return null;
  const clave = process.env.SEED_ADMIN_PASSWORD ?? '';

  /*
   * Las dos condiciones que deciden si esta cuenta podrá ENTRAR se comprueban con el mismo
   * contrato que gobierna la puerta, no con una regla escrita aquí. Un seed que crea una
   * cuenta privilegiada y declara «asegurada» sobre algo que el login va a rechazar es peor
   * que un seed que no la crea: nadie va a mirar otra vez.
   *
   * El correo, con el campo de `LoginSchema` —que además normaliza (trim + minúsculas), así
   * que la normalización a mano de antes desaparece con él—. Una errata en la variable creaba
   * la cuenta, la base la aceptaba y el login la rechazaba por formato.
   *
   * La clave, en BYTES y no en caracteres. Medido: 50 caracteres acentuados son 100 bytes;
   * pasaban el `clave.length < 12` de antes, bcrypt los truncaba a 72 en silencio y
   * `autenticar` los rechaza de entrada por pasar de `PASSWORD_MAX_BYTES` — una cuenta
   * imposible de usar, anunciada como lista. El suelo de 12 CARACTERES es propio del seed y
   * más estricto que el del producto (10): una credencial privilegiada que sale en una
   * variable de entorno merece más, no menos.
   */
  const correo = LoginSchema.shape.email.safeParse(crudo);
  if (!correo.success) {
    throw new Error(
      `SEED_ADMIN_EMAIL no es un correo válido (${crudo}): el login lo rechazaría, así que la cuenta nacería inutilizable`,
    );
  }
  const email = correo.data;

  const SEED_PASSWORD_MIN = 12;
  const bytes = new TextEncoder().encode(clave).length;
  if (clave.length < SEED_PASSWORD_MIN) {
    throw new Error(
      `SEED_ADMIN_EMAIL está puesta pero SEED_ADMIN_PASSWORD falta o tiene menos de ${SEED_PASSWORD_MIN} caracteres`,
    );
  }
  if (bytes > PASSWORD_MAX_BYTES) {
    throw new Error(
      `SEED_ADMIN_PASSWORD ocupa ${bytes} bytes y el máximo es ${PASSWORD_MAX_BYTES} (límite de bcrypt): bcrypt la truncaría y el login la rechazaría, así que la cuenta nacería inutilizable`,
    );
  }
  const nombre = process.env.SEED_ADMIN_NOMBRE?.trim() || email.split('@')[0]!;
  return { email, clave, nombre };
}

/**
 * La cuenta PROPIA de quien despliega, ya validada, en los workspaces que el seed acaba de
 * resolver. Los IDs llegan de fuera: buscarlos por nombre no vale ni acotando por la
 * membresía de Lucía —`workspace.nombre` no es único y esa cuenta demo puede estar invitada a
 * otro workspace que se llame igual—, y conceder `lead-boutique` de una persona REAL sobre el
 * tenant de otro cliente es el fallo que no se puede permitir.
 */
async function sembrarAdminPropio(
  cliente: typeof sql,
  admin: AdminPropio | null,
  workspaces: string[],
): Promise<string | null> {
  if (!admin) return null;
  const { email, clave, nombre } = admin;
  // El hash se calcula aquí y no al validar: cuesta CPU y solo hace falta si se va a escribir.
  const hash = await bcrypt.hash(clave, 10);

  /*
   * TODO en UNA transacción, y esto no es prolijidad: sin ella, la cuenta y la primera
   * membresía ya estaban COMMITEADAS cuando una sentencia posterior fallara —por ejemplo un
   * `DS001` al tocar una demo archivada—. El entrypoint corta con `set -e` y el despliegue no
   * arranca, así que nadie ve el fallo; pero apagar el seed en el siguiente despliegue deja
   * viva una cuenta privilegiada a medio crear. Un seed que concede accesos tiene que
   * conceder todo o nada.
   */
  return cliente.begin(async (tx) => {
    /*
     * El alta va con `ON CONFLICT` y relectura. Dos instancias del mismo despliegue arrancan a
     * la vez: las dos pueden ver que el usuario no existe y las dos intentar crearlo. El
     * índice único sobre `lower(email)` rechaza a una, y con `set -e` esa instancia no arranca
     * — por una cuenta que la otra ya había creado bien.
     *
     * Y tiene que ser `ON CONFLICT` y no un `where not exists`: escribí primero lo segundo y
     * NO arregla nada. Un `where not exists` es el mismo «mirar y luego insertar» metido en
     * una sentencia — bajo READ COMMITTED las dos transacciones pueden pasar la comprobación
     * antes de que ninguna haya escrito, y la violación de unicidad ocurre igual. Solo el
     * índice, que es quien arbitra de verdad, puede resolver la carrera.
     *
     * `on conflict (lower(email))` sobre el índice de EXPRESIÓN, comprobado contra el real:
     * la segunda inserción con otra caja de letras devuelve `INSERT 0 0` en vez de un error.
     */
    await tx`insert into usuario (email, nombre, password_hash, estado)
      values (${email}, ${nombre}, ${hash}, 'activo')
      on conflict (lower(email)) do nothing`;
    const [u] = await tx`select id, estado from usuario where lower(email) = ${email}`;
    const id = u!.id as string;
    /*
     * Una cuenta DESACTIVADA no recibe accesos, igual que en el flujo de invitación —que la
     * rechaza explícitamente («la cuenta de ese correo está desactivada; no puede recibir
     * invitaciones»)—. Sin esta guarda, el seed le concedía membresías privilegiadas y, si
     * además no tenía contraseña, el `update` de abajo la devolvía a `activo`: un despliegue
     * posterior deshacía una desactivación deliberada, que es una decisión de producto y no
     * un detalle de arranque.
     *
     * Se falla en vez de saltárselo. Quien pone `SEED_ADMIN_EMAIL` apuntando a una cuenta
     * desactivada tiene un problema que quiere ver.
     */
    if ((u!.estado as string) === 'inactivo') {
      throw new Error(
        `SEED_ADMIN_EMAIL apunta a ${email}, que es una cuenta DESACTIVADA: el seed no la reactiva ni le concede accesos`,
      );
    }
    /*
     * La contraseña solo se escribe si NO había ninguna —este seed corre en cada despliegue, y
     * reescribirla convertiría una variable de entorno vieja en una puerta abierta— y la
     * condición va DENTRO del `update`, no en un `if` sobre lo que se leyó antes.
     *
     * Entre el `select` y el `update` cabe una activación: si esa dirección es una cuenta
     * invitada y la persona está eligiendo su contraseña justo ahora,
     * `activar_usuario_con_token` la confirma en medio y el `update` se la pisaba con el
     * secreto del seed. Leer y decidir por separado deja un hueco; el `where` lo cierra
     * porque la comprobación y la escritura pasan a ser la misma sentencia.
     */
    const [activada] = await tx`update usuario
      set password_hash = ${hash}, estado = 'activo',
          invitacion_token_hash = null, invitacion_expira = null, actualizado_en = now()
      where id = ${id} and password_hash is null
      returning invitacion_origen_ws`;
    /*
     * Y si lo que se acaba de activar era una INVITACIÓN pendiente, su evento, como lo emite
     * `activar_usuario_con_token`. Este `update` consume la invitación —limpia el token y su
     * caducidad— así que sin el evento el historial del workspace que invitó se queda con una
     * invitación pendiente para siempre y una identidad activa que nada explica. La condición
     * es `invitacion_origen_ws`: sin él no había invitación que consumir y no hay a qué
     * workspace contárselo.
     */
    if (activada?.invitacion_origen_ws) {
      await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        values (${activada.invitacion_origen_ws as string}, 'UsuarioActivado',
                ${tx.json({ email, origen: 'seed:SEED_ADMIN_EMAIL' })}, ${id},
                (select rol from miembro
                  where workspace_id = ${activada.invitacion_origen_ws as string}
                    and usuario_id = ${id}))`;
    }

    /*
     * Los DOS workspaces se resuelven aquí y por la FIRMA DEL SEED —tener a Lucía de miembro—,
     * sin fiarse de ningún id de fuera. `workspace` no tiene unicidad por nombre (comprobado:
     * su única restricción es la clave primaria), y el `select … where nombre = 'Banco Andino'`
     * de `main()` no está calificado. Recibir ese id habría dado acceso `lead-boutique` de una
     * persona REAL al workspace de otro cliente que se llamara igual.
     *
     * Una función que concede accesos no puede confiar en que su llamante haya acotado bien.
     */
    const destinos = await tx`select w.id, w.nombre, m.usuario_id as lucia_id, m.rol as lucia_rol
      from workspace w
      join miembro m on m.workspace_id = w.id
      join usuario u2 on u2.id = m.usuario_id
      where w.id in ${tx(workspaces)}
        and lower(u2.email) = 'lucia@whitespace.demo'`;

    const dichos: string[] = [];
    for (const w of destinos) {
      const wsId = w.id as string;
      const luciaRol = w.lucia_rol as string;

      /*
       * El rol de Lucía se LEE; no se afirma. El evento de más abajo escribía
       * `actor_rol = 'lead-boutique'` sin haberlo mirado, así que si su membresía se hubiera
       * cambiado antes de encender `SEED_ADMIN_EMAIL`, la auditoría de una concesión
       * privilegiada quedaba materialmente falsa — y es el único registro que explica de dónde
       * salió ese miembro.
       *
       * Y si el rol que tiene no es de los que dan de alta, no se concede: atribuirle a alguien
       * un alta que su rol no le permite hacer es la misma mentira, escrita entera. Se salta
       * ese workspace con su motivo en vez de abortar el despliegue —igual que la rama de «ya
       * era otro rol»—: una demo con la membresía cambiada no es una emergencia, es un dato.
       *
       * `ROLES_QUE_INVITAN` es el mismo que aplica el servicio de invitación y el espejo de la
       * política `miembro_insert`, que es quien lo impone de verdad.
       */
      if (!(ROLES_QUE_INVITAN as readonly string[]).includes(luciaRol)) {
        dichos.push(
          `${w.nombre as string}: SIN TOCAR, la cuenta del seed (Lucía) es ${luciaRol} y ese rol no da de alta miembros`,
        );
        continue;
      }
      /*
       * Se MIRA antes de escribir, y el `on conflict` se queda de todas formas.
       *
       * El `on conflict` cubre la carrera y no cubre esto: `miembro` tiene un trigger BEFORE
       * INSERT (`a_congelacion_por_disposicion`) que corre ANTES de que Postgres compruebe el
       * conflicto, y sobre un workspace ya dispuesto levanta `DS001`. Medido: con un trigger
       * BEFORE que lanza, `insert … on conflict do nothing` sale por el trigger. O sea que un
       * redespliegue sobre una demo archivada abortaba el seed por una membresía que YA
       * existía y que no hacía falta escribir.
       */
      const [ya] = await tx`select rol from miembro
        where workspace_id = ${wsId} and usuario_id = ${id}`;
      if (ya) {
        // Y si ya estaba con OTRO rol, se dice. Antes el `on conflict do nothing` se lo tragaba
        // y el registro afirmaba «asegurada como lead-boutique» sobre una cuenta que seguía
        // siendo stakeholder: un mensaje que miente es peor que no tener mensaje. No se
        // reescribe el rol — cambiar la membresía de alguien que ya estaba es una decisión de
        // producto, no una comodidad del seed.
        dichos.push(
          ya.rol === 'lead-boutique'
            ? `${w.nombre as string}: ya`
            : `${w.nombre as string}: SIN TOCAR, ya era ${ya.rol as string}`,
        );
        continue;
      }
      /*
       * `returning` para saber si esta transacción fue la que insertó. Dos procesos del mismo
       * despliegue pueden ver los dos que no hay membresía: uno inserta y al otro su
       * `on conflict do nothing` le afecta CERO filas — pero los dos emitían el evento y los
       * dos decían «lead-boutique». Eso duplica la auditoría, y si el que ganó el conflicto
       * fue otro flujo con otro rol, además la miente.
       */
      const [creada] = await tx`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${wsId}, ${id}, ${nombre}, ${email}, 'lead-boutique')
        on conflict do nothing
        returning rol`;
      if (!creada) {
        // Otro la creó entre nuestro `select` y este `insert`: se relee al ganador en vez de
        // afirmar lo que quisimos escribir.
        const [gano] = await tx`select rol from miembro
          where workspace_id = ${wsId} and usuario_id = ${id}`;
        dichos.push(`${w.nombre as string}: la creó otro arranque como ${gano?.rol ?? '¿?'}`);
        continue;
      }
      /*
       * Y su EVENTO, en la misma transacción que la concesión, como hace el flujo de
       * invitación. RF-01.6 exige que toda escritura quede auditada, y una membresía
       * privilegiada que aparece sin rastro es exactamente lo que una auditoría no puede
       * explicar — ni la exportación del workspace, que lee de aquí.
       *
       * El actor es Lucía, que es la identidad con la que este seed escribe todo lo demás, CON
       * EL ROL QUE DE VERDAD TIENE, y el payload dice que vino del seed y por qué variable:
       * quien lo lea sabrá que no fue una invitación, sino un despliegue con
       * `SEED_ADMIN_EMAIL` puesta.
       */
      await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
        values (${wsId}, 'MiembroInvitado',
                ${tx.json({ email, rol: 'lead-boutique', requiereActivacion: false, origen: 'seed:SEED_ADMIN_EMAIL' })},
                ${w.lucia_id as string}, ${luciaRol})`;
      dichos.push(`${w.nombre as string}: lead-boutique`);
    }
    if (dichos.length > 0) return `${email} (${dichos.join('; ')})`;
    // Y se DICE por qué no se concedió nada, que si no parece que sí. El caso normal es una
    // base sembrada por una versión anterior al sello: la cuenta existe y puede entrar, pero
    // no tiene workspaces — y el camino es resembrar en limpio, no aflojar la comprobación.
    return `${email} (cuenta lista, SIN membresías: no hay workspaces sellados por este seed en esta base; una base sembrada antes del sello no acredita cuáles son suyos)`;
  });
}

async function main() {
  // ANTES de la primera escritura. Si `SEED_ADMIN_EMAIL` está puesta y su configuración no
  // vale, esto lanza aquí y la base queda intacta — que es lo que el runbook promete.
  // Validado al final, un despliegue limpio con el correo mal escrito creaba los dos
  // workspaces y las tres cuentas demo enteros y salía con error después.
  const admin = leerAdminPropio();
  const hash = await bcrypt.hash(PASSWORD_DEMO, 10);

  /*
   * El workspace PRIMARIO se resuelve por su SELLO en `sembrado_registro`, que es el único
   * id que acredita que salió de aquí. `workspace.nombre` no tiene unicidad (comprobado: su
   * única restricción es la clave primaria), así que un «Banco Andino» de otro cliente en una
   * base de desarrollo entraba por el `select … where nombre = …` — y ese id gobierna toda la
   * siembra de upgrade y, desde que existe la cuenta propia, una concesión de `lead-boutique`
   * a una persona real.
   *
   * Probé antes con un evento `WorkspaceCreado` de `origen: 'seed'` y una revisión lo cazó:
   * `evento_insert` autoriza a cualquier miembro a escribir eventos con cualquier tipo y
   * payload, así que ese marcador es FALSIFICABLE — exactamente lo que la migración
   * `…300000-la-procedencia-del-sembrado-no-la-escribe-la-app.sql` declaró insuficiente.
   *
   * El nombre se queda como segunda pregunta y solo para una cosa: decidir si hace falta
   * crear el workspace en una base sembrada por una versión anterior, que no tiene sello. Lo
   * que NO se hace es sellarlo entonces: sellar lo que se encontró por nombre metería en el
   * sitio infalsificable justo el dato que se declaró falsificable, que es lo que esa misma
   * migración se negó a hacer al no migrar el marcador viejo. Y lo que tampoco se hace es
   * conceder sobre él: sin sello no hay concesión (ver `sembrarAdminPropio`).
   */
  const primarioSellado = await workspaceSellado(sql, CLAVE_WS_PRIMARIO);
  const existentes = primarioSellado
    ? [{ id: primarioSellado }]
    : await sql`select w.id from workspace w where w.nombre = 'Banco Andino'
        order by w.creado_en asc, w.id asc`;
  if (existentes.length > 0) {
    const wsId = existentes[0]!.id as string;
    const actualizados = await sql`update usuario
      set password_hash = ${hash}, estado = 'activo',
          invitacion_token_hash = null, invitacion_expira = null, actualizado_en = now()
      where lower(email) in ${sql(PERSONAS.map((p) => p.email))}
        and password_hash is null`;

    // Upgrade de bases sembradas antes del árbol (SPEC-02): sembrarlo si no existe.
    const [conServicios] = await sql`select count(*)::int as n from servicio where workspace_id = ${wsId}`;
    let arbolSembrado = false;
    const [lucia] = await sql`select id from usuario where lower(email) = 'lucia@whitespace.demo'`;
    if ((conServicios!.n as number) === 0 && lucia) {
      await sql.begin((tx) => sembrarArbol(tx, wsId, lucia.id as string));
      arbolSembrado = true;
    }

    // Upgrade de bases sembradas antes del método (SPEC-04): los CRITERIOS son la
    // señal (la migración backfillea etapas/gates/checklist, pero los criterios de
    // demo solo los pone el seed).
    const [conCriterios] = await sql`select count(*)::int as n from criterio_exito where workspace_id = ${wsId}`;
    let metodoSembrado = false;
    if ((conCriterios!.n as number) === 0 && lucia) {
      await sql.begin((tx) => sembrarMetodo(tx, wsId, lucia.id as string));
      metodoSembrado = true;
    }
    // Upgrade de bases sembradas antes de la cadena de razonamiento.
    if (lucia) {
      await sql.begin((tx) => sembrarCadena(tx, wsId, lucia.id as string));
    }
    // Upgrade de bases sembradas antes del journey (SPEC-05): la función se auto-guarda
    // por presencia de journeys en el workspace.
    let journeySembrado = false;
    if (lucia) {
      journeySembrado = await sql.begin((tx) => sembrarJourney(tx, wsId, lucia.id as string));
    }
    // Upgrade de bases sembradas antes de la cadena de resultado (SPEC-06): la función
    // se auto-guarda por presencia de design versions en el workspace.
    let entregaSembrada = false;
    if (lucia) {
      entregaSembrada = await sembrarEntrega(sql, wsId, lucia.id as string);
    }

    // Upgrade de bases sembradas antes del selector: el segundo workspace de Lucía
    // (la función se auto-guarda por membresía+nombre, sin chequeo duplicado aquí).
    let segundoSembrado = false;
    let segundoSellado: string | null = null;
    if (lucia) {
      const segundo = await sql.begin((tx) => sembrarSegundoWorkspace(tx, lucia.id as string));
      segundoSembrado = segundo.creado;
      if (segundo.sellado) segundoSellado = segundo.id;
    }
    // Upgrade de bases sembradas antes de los derechos de uso (SPEC-03 profunda) y del
    // pipeline AI (SPEC-08): cada función se auto-guarda por la presencia de su propio
    // rastro en el workspace —derechos y propuestas—, así que las dos son idempotentes por
    // separado y el orden entre ellas no las ata.
    let evidenciaSembrada = false;
    let propuestaSembrada = false;
    if (lucia) {
      evidenciaSembrada = await sql.begin((tx) =>
        sembrarEvidenciaProfunda(tx, wsId, lucia.id as string),
      );
      propuestaSembrada = await sql.begin((tx) => sembrarPropuestaAI(tx, wsId, lucia.id as string));
    }
    // Solo los SELLADOS. Un workspace que este seed encontró por nombre —porque la base
    // viene de una versión sin sello— no acredita ser suyo, y conceder `lead-boutique` de una
    // persona real sobre algo que no acredita ser suyo es el fallo que no se puede permitir.
    // Fallar cerrado también cuando el que falla cerrado es el upgrade.
    const adminPropio = await sembrarAdminPropio(
      sql,
      admin,
      [primarioSellado, segundoSellado].filter((x): x is string => x !== null),
    );
    console.log(
      `seed: el workspace Banco Andino ya existe; credenciales demo aseguradas (${actualizados.count} activadas)` +
        (adminPropio ? `; cuenta propia ${adminPropio}` : '') +
        (arbolSembrado ? '; árbol R-01/R-02/R-03 + P-01 sembrado' : '') +
        (metodoSembrado ? '; método de P-01 sembrado' : '') +
        (journeySembrado ? '; journey as-is sembrado' : '') +
        (entregaSembrada ? '; DV-1 con RL-1/RL-2 y ES-1 sembrada' : '') +
        (segundoSembrado ? '; Clínica del Valle sembrada' : '') +
        (evidenciaSembrada ? '; evidencia §19.1 con derechos de uso sembrada' : '') +
        (propuestaSembrada ? '; propuesta AI pendiente sembrada' : ''),
    );
    return;
  }

  const creado = await sql.begin(async (tx) => {
    const [ws] = await tx`insert into workspace (nombre) values ('Banco Andino') returning id`;
    const wsId = ws!.id as string;

    let luciaId = '';
    for (const p of PERSONAS) {
      const [u] = await tx`insert into usuario (email, nombre, password_hash, estado)
        values (${p.email}, ${p.nombre}, ${hash}, 'activo') returning id`;
      const usuarioId = u!.id as string;
      if (p.email === 'lucia@whitespace.demo') luciaId = usuarioId;
      await tx`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
        values (${wsId}, ${usuarioId}, ${p.nombre}, ${p.email}, ${p.rol})`;
    }

    await tx`insert into segmento (workspace_id, nombre, definicion) values
      (${wsId}, 'empleados corporativos', 'Empleados con cuenta nómina por convenio'),
      (${wsId}, 'pymes', 'Pequeñas y medianas empresas'),
      (${wsId}, 'independientes', 'Trabajadores independientes')`;

    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
      (${wsId}, 'WorkspaceCreado', ${tx.json({ nombre: 'Banco Andino', origen: 'seed' })}, ${luciaId}, 'lead-boutique')`;

    await sembrarArbol(tx, wsId, luciaId);
    await sembrarMetodo(tx, wsId, luciaId);
    await sembrarEvidenciaProfunda(tx, wsId, luciaId);
    await sembrarCadena(tx, wsId, luciaId);
    await sembrarJourney(tx, wsId, luciaId);
    const segundo = await sembrarSegundoWorkspace(tx, luciaId);
    await sembrarPropuestaAI(tx, wsId, luciaId);
    // El SELLO del primario, en la misma transacción que lo crea: si algo de arriba falla, no
    // queda un sello sin workspace ni un workspace sin sello.
    await tx`insert into sembrado_registro (workspace_id, clave, payload)
      values (${wsId}, ${CLAVE_WS_PRIMARIO}, ${tx.json({ nombre: 'Banco Andino' })})
      on conflict (workspace_id, clave) do nothing`;
    return { wsId, luciaId, segundoId: segundo.id };
  });

  // La entrega va FUERA de esa transacción porque necesita varias: la design version nace en
  // borrador, recibe sus elementos, y se aprueba después. Meterla dentro obligaría a que el
  // borrador y su aprobación cayeran en el mismo commit, que es justo el estado que el
  // producto no puede producir y que el guard diferido rechaza.
  await sembrarEntrega(sql, creado.wsId, creado.luciaId);
  const adminPropio = await sembrarAdminPropio(sql, admin, [creado.wsId, creado.segundoId]);
  if (adminPropio) console.log(`seed: cuenta propia ${adminPropio}`);
  console.log(
    `seed: workspace Banco Andino creado (3 usuarios activos, 3 segmentos, árbol R-01/R-02/R-03 + P-01, método G0-G7, 3 evidencias curadas con derechos —una sin consentimiento, bloqueada a propósito—, journey as-is y to-be, DV-1 con RL-1/RL-2 y ES-1, item de bandeja con propuesta AI pendiente) + Clínica del Valle para el selector — login demo: lucia@whitespace.demo / ${PASSWORD_DEMO}`,
  );
}

await main().finally(() => sql.end({ timeout: 5 }));
