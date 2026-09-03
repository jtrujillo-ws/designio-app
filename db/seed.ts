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
 * Las dos evidencias de la cadena, por TÍTULO: es lo que identifica a la evidencia que
 * esta función siembra, tanto si acaba de crearla como si ya estaba de una corrida
 * anterior. Cada una con la base documental que justifica su concesión.
 */
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
 * Repara los derechos de una base sembrada por una versión ANTERIOR, donde la cadena ya
 * existe pero el backfill de 20260902140000 dejó sus derechos en 'pendiente'.
 *
 * Aquí no hay ids en la mano —esta corrida no creó nada—, así que hay que acreditar la
 * procedencia. Y se acredita por RELACIONES, nunca por título: el título es dato que
 * cualquiera puede escribir, y emparejar por él significaba que una evidencia AJENA
 * bautizada igual —material confidencial de un cliente, por ejemplo— recibía derechos de
 * ámbito cliente firmados por Lucía, que nunca los concedió. En un producto cuya tesis es
 * que conceder el uso es un acto propio, con su base documental y su responsable, un seed
 * que firma consentimiento en nombre de alguien es la contradicción más grande posible.
 *
 * El camino arranca en `proyecto.codigo = 'P-01'`, que es una fila que ESTE seed crea y que
 * tiene clave única `(workspace_id, codigo)`: no hay dos, y nadie puede fabricar una
 * segunda para colarse. Desde ahí, todo por FK:
 *
 *   P-01 → gate 1 → decisión → decision_insight → insight → afirmación → cita → evidencia
 *   P-01 → reto → arquetipo → arquetipo_evidencia → evidencia
 *
 * Y se exige que cada camino devuelva EXACTAMENTE UNA evidencia, que es la forma que este
 * seed produce. Si hay más de una, la base no tiene la forma que esta función sembró y no
 * se toca nada: fail-closed, como todo lo demás en este dominio.
 *
 * Lo que esto NO afirma, para no dejar escrita una tranquilidad falsa: no demuestra que la
 * fila la escribiera esta función. Un lead-boutique que construya a mano su propia decisión
 * sobre el G1 de P-01 citando su propia evidencia entraría en el camino. Lo que sí quita es
 * la vía por la que se colaba material que no tiene NADA que ver con la cadena, y acota lo
 * alcanzable a la evidencia de la que el demo depende estructuralmente — que es justo la
 * que, bloqueada, deja el demo contradiciéndose.
 */
async function repararDerechosDeCadena(
  tx: TransactionSql,
  wsId: string,
  luciaId: string,
): Promise<void> {
  const citadas = await tx`select distinct c.evidencia_id
    from proyecto p
    join gate_instancia g on g.proyecto_id = p.id and g.workspace_id = p.workspace_id
      and g.numero = 1
    join decision d on d.gate_id = g.id and d.workspace_id = g.workspace_id
    join decision_insight di on di.decision_id = d.id and di.workspace_id = d.workspace_id
    join afirmacion a on a.insight_id = di.insight_id and a.workspace_id = di.workspace_id
    join cita c on c.afirmacion_id = a.id and c.workspace_id = a.workspace_id
    where p.workspace_id = ${wsId} and p.codigo = 'P-01'`;
  const deArquetipo = await tx`select distinct ae.evidencia_id
    from proyecto p
    join arquetipo arq on arq.reto_id = p.reto_id and arq.workspace_id = p.workspace_id
    join arquetipo_evidencia ae on ae.arquetipo_id = arq.id and ae.workspace_id = arq.workspace_id
    where p.workspace_id = ${wsId} and p.codigo = 'P-01'`;

  const filas: { evidenciaId: string; base: string }[] = [];
  if (citadas.length === 1) {
    filas.push({ evidenciaId: citadas[0]!.evidencia_id as string, base: BASE_DERECHO_CITADA });
  }
  if (deArquetipo.length === 1) {
    filas.push({
      evidenciaId: deArquetipo[0]!.evidencia_id as string,
      base: BASE_DERECHO_ARQUETIPO,
    });
  }
  await concederDerechosDeCadena(tx, wsId, luciaId, filas);
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

/** Cadena de razonamiento de demo (SPEC-03/04): evidencia curada → insight validado
 * con citas y una contradicción a la vista → decisión aprobada en G1 y un arquetipo
 * confirmado. Es lo que hace demostrable el grafo sin pasar por toda la curaduría.
 * Idempotente: la señal es el insight del workspace — pero los DERECHOS de la cadena se
 * aseguran en las dos ramas, porque una base sembrada por una versión anterior ya tiene
 * el insight y aun así necesita repararlos. */
async function sembrarCadena(tx: TransactionSql, wsId: string, luciaId: string): Promise<void> {
  const yaHay = await tx`select 1 from insight where workspace_id = ${wsId}`;
  if (yaHay.length > 0) {
    // La cadena ya está sembrada, pero puede venir de ANTES de que esta función creara los
    // derechos de sus dos evidencias. En esa base el backfill de la migración 140000 les
    // puso una fila 'pendiente' (fail-closed, correcto en general) y el resultado tras el
    // upgrade es un demo que se contradice: un insight validado cuya cita apunta a
    // evidencia bloqueada, y una cita que hoy el propio producto no dejaría crear. Los
    // derechos de la cadena CONOCIDA se ponen igual, sin volver a sembrar nada.
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
        (segundoSembrado ? '; Clínica del Valle sembrada' : '') +
        (evidenciaSembrada ? '; evidencia §19.1 con derechos de uso sembrada' : ''),
    );
    return;
  }

  await sql.begin(async (tx) => {
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
  });
  console.log(
    `seed: workspace Banco Andino creado (3 usuarios activos, 3 segmentos, árbol R-01/R-02/R-03 + P-01, método G0-G7, 3 evidencias curadas con derechos —una sin consentimiento, bloqueada a propósito—, journey as-is) + Clínica del Valle para el selector — login demo: lucia@whitespace.demo / ${PASSWORD_DEMO}`,
  );
}

await main().finally(() => sql.end({ timeout: 5 }));
