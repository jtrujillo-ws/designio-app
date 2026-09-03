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
 * Idempotente por la presencia de MATERIAL EN LA BANDEJA (`item_importacion`), que es lo
 * único que siembra en exclusiva esta función. La señal era antes «hay algún derecho_uso
 * en el workspace», y eso la ataba a un dato que otras funciones también producen: en
 * cuanto sembrarCadena empezó a crear los derechos de sus dos evidencias —y en el camino
 * de upgrade corre ANTES que esta—, la señal se activaba sola y el material de la bandeja
 * no llegaba a sembrarse nunca. Una guarda de idempotencia tiene que mirar lo que la
 * propia función escribe, no un efecto que comparte con otras.
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
  const yaHay = await tx`select 1 from item_importacion where workspace_id = ${wsId} limit 1`;
  if (yaHay.length > 0) return false;

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
  }
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
 * Tipos de evento con los que el seed deja constancia de LO QUE ÉL CREA y del aviso que
 * emite cuando decide no tocar nada. Viven aquí, y no sueltos donde se usan, porque la
 * reparación los LEE: son el contrato entre dos corridas distintas del seed.
 */
const MARCA_CADENA_SEMBRADA = 'CadenaDemoSembrada';
const AVISO_CADENA_SIN_PROCEDENCIA = 'DerechosDeCadenaSinRepararPorProcedencia';

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
 * que crea —evento `CadenaDemoSembrada` con los ids de sus dos evidencias— y la reparación
 * concede solo a esos ids. Sin ese registro no hay nada que acreditar y NO SE CONCEDE
 * NADA: fallar cerrado, no adoptar. En su lugar queda un evento que nombra lo que habría
 * tocado, para que un operador lo conceda a mano si de verdad procede — que es como debe
 * entrar un consentimiento en un producto cuya tesis es que conceder el uso es un acto
 * propio, con su base documental y su responsable.
 *
 * Lo que el registro prueba y lo que no, para no dejar escrita una tranquilidad falsa: es
 * una fila de `evento_dominio`, y la política `evento_insert` permite a cualquier miembro
 * del workspace escribir eventos. No es un sello criptográfico. Lo que cierra es la vía
 * ACCIDENTAL —que la forma de la base coincida por casualidad—; falsificarlo exige que un
 * miembro escriba a propósito un registro de procedencia mintiendo. Y aun entonces la
 * concesión sigue acotada: solo evidencia DE ESTE workspace, y solo mientras su derecho
 * siga en 'pendiente' (lo decidido a mano nunca se pisa).
 */
async function repararDerechosDeCadena(
  tx: TransactionSql,
  wsId: string,
  luciaId: string,
): Promise<void> {
  const [marca] = await tx`select payload from evento_dominio
    where workspace_id = ${wsId} and tipo = ${MARCA_CADENA_SEMBRADA}
      and payload->>'origen' = 'seed'
    order by creado_en, id
    limit 1`;
  const registro = (marca?.payload ?? {}) as {
    evidenciaCitadaId?: unknown;
    evidenciaArquetipoId?: unknown;
  };
  const declarados = [
    { evidenciaId: registro.evidenciaCitadaId, base: BASE_DERECHO_CITADA },
    { evidenciaId: registro.evidenciaArquetipoId, base: BASE_DERECHO_ARQUETIPO },
  ].filter((f): f is { evidenciaId: string; base: string } => typeof f.evidenciaId === 'string');
  if (declarados.length === 0) {
    await declinarReparacionDeCadena(tx, wsId);
    return;
  }

  // El registro nombra ids, y que esos ids sean de ESTE workspace no se da por supuesto:
  // un payload es texto y el evento lo escribe quien puede escribir eventos. Filtrar aquí
  // cuesta una consulta y evita que un registro torcido alcance material de otro tenant.
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
  // Y queda CONSTANCIA de qué evidencia creó ESTA corrida. No es decoración de auditoría:
  // es lo único que una corrida futura puede leer para reparar sin adivinar. Deducir la
  // procedencia de la FORMA de la base —«el único camino desde P-01 llega aquí»— adopta lo
  // que encuentre, y lo que encuentre puede ser material de un usuario. Ver
  // `repararDerechosDeCadena`, que es quien lo lee.
  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (${wsId}, ${MARCA_CADENA_SEMBRADA}, ${tx.json({
      origen: 'seed',
      evidenciaCitadaId: evDigital,
      evidenciaArquetipoId: evSucursal,
    })}, ${luciaId}, 'lead-boutique')`;

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

/** Segundo workspace de Lucía (demo del selector multi-membresía): mínimo pero real —
 * un servicio, sin retos aún. Idempotente por MEMBRESÍA de Lucía + nombre: el nombre
 * de workspace no es único y uno homónimo ajeno no debe saltarse el seed. Devuelve si
 * lo creó en esta corrida. */
async function sembrarSegundoWorkspace(tx: TransactionSql, luciaId: string): Promise<boolean> {
  const existe = await tx`select 1 from workspace w
    join miembro m on m.workspace_id = w.id
    where w.nombre = 'Clínica del Valle' and m.usuario_id = ${luciaId}`;
  if (existe.length > 0) return false;
  const [ws2] = await tx`insert into workspace (nombre) values ('Clínica del Valle') returning id`;
  const ws2Id = ws2!.id as string;
  await tx`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
    values (${ws2Id}, ${luciaId}, 'Lucía Ferreira', 'lucia@whitespace.demo', 'lead-boutique')`;
  await tx`insert into servicio (workspace_id, nombre, descripcion, creado_por)
    values (${ws2Id}, 'Agendamiento de citas', 'Reserva y confirmación de citas médicas', ${luciaId})`;
  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
    (${ws2Id}, 'WorkspaceCreado', ${tx.json({ nombre: 'Clínica del Valle', origen: 'seed' })}, ${luciaId}, 'lead-boutique')`;
  return true;
}

async function main() {
  const hash = await bcrypt.hash(PASSWORD_DEMO, 10);

  const existentes = await sql`select id from workspace where nombre = 'Banco Andino'`;
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
    if (lucia) {
      segundoSembrado = await sql.begin((tx) => sembrarSegundoWorkspace(tx, lucia.id as string));
    }
    // Upgrade de bases sembradas antes de los derechos de uso (SPEC-03 profunda): la
    // función se auto-guarda por la presencia de derechos en el workspace.
    let evidenciaSembrada = false;
    if (lucia) {
      evidenciaSembrada = await sql.begin((tx) =>
        sembrarEvidenciaProfunda(tx, wsId, lucia.id as string),
      );
    }
    console.log(
      `seed: el workspace Banco Andino ya existe; credenciales demo aseguradas (${actualizados.count} activadas)` +
        (arbolSembrado ? '; árbol R-01/R-02/R-03 + P-01 sembrado' : '') +
        (metodoSembrado ? '; método de P-01 sembrado' : '') +
        (journeySembrado ? '; journey as-is sembrado' : '') +
        (entregaSembrada ? '; DV-1 con RL-1/RL-2 y ES-1 sembrada' : '') +
        (segundoSembrado ? '; Clínica del Valle sembrada' : '') +
        (evidenciaSembrada ? '; evidencia §19.1 con derechos de uso sembrada' : ''),
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
    await sembrarSegundoWorkspace(tx, luciaId);
    return { wsId, luciaId };
  });

  // La entrega va FUERA de esa transacción porque necesita varias: la design version nace en
  // borrador, recibe sus elementos, y se aprueba después. Meterla dentro obligaría a que el
  // borrador y su aprobación cayeran en el mismo commit, que es justo el estado que el
  // producto no puede producir y que el guard diferido rechaza.
  await sembrarEntrega(sql, creado.wsId, creado.luciaId);
  console.log(
    `seed: workspace Banco Andino creado (3 usuarios activos, 3 segmentos, árbol R-01/R-02/R-03 + P-01, método G0-G7, 3 evidencias curadas con derechos —una sin consentimiento, bloqueada a propósito—, journey as-is y to-be, DV-1 con RL-1/RL-2 y ES-1) + Clínica del Valle para el selector — login demo: lucia@whitespace.demo / ${PASSWORD_DEMO}`,
  );
}

await main().finally(() => sql.end({ timeout: 5 }));
