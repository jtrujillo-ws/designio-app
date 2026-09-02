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
 * Idempotente por la presencia de derechos en el workspace.
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
  const yaHay = await tx`select 1 from derecho_uso where workspace_id = ${wsId} limit 1`;
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

/** Cadena de razonamiento de demo (SPEC-03/04): evidencia curada → insight validado
 * con citas y una contradicción a la vista → decisión aprobada en G1 y un arquetipo
 * confirmado. Es lo que hace demostrable el grafo sin pasar por toda la curaduría.
 * Idempotente: la señal es el insight del workspace. */
async function sembrarCadena(tx: TransactionSql, wsId: string, luciaId: string): Promise<void> {
  const yaHay = await tx`select 1 from insight where workspace_id = ${wsId}`;
  if (yaHay.length > 0) return;

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
    await sembrarSegundoWorkspace(tx, luciaId);
  });
  console.log(
    `seed: workspace Banco Andino creado (3 usuarios activos, 3 segmentos, árbol R-01/R-02/R-03 + P-01, método G0-G7, 3 evidencias curadas con derechos —una sin consentimiento, bloqueada a propósito—) + Clínica del Valle para el selector — login demo: lucia@whitespace.demo / ${PASSWORD_DEMO}`,
  );
}

await main().finally(() => sql.end({ timeout: 5 }));
