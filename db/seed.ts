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

/** Segundo workspace de Lucía (demo del selector multi-membresía): mínimo pero real —
 * un servicio, sin retos aún. Idempotente por nombre. */
async function sembrarSegundoWorkspace(tx: TransactionSql, luciaId: string): Promise<void> {
  const existe = await tx`select 1 from workspace where nombre = 'Clínica del Valle'`;
  if (existe.length > 0) return;
  const [ws2] = await tx`insert into workspace (nombre) values ('Clínica del Valle') returning id`;
  const ws2Id = ws2!.id as string;
  await tx`insert into miembro (workspace_id, usuario_id, nombre, email, rol)
    values (${ws2Id}, ${luciaId}, 'Lucía Ferreira', 'lucia@whitespace.demo', 'lead-boutique')`;
  await tx`insert into servicio (workspace_id, nombre, descripcion, creado_por)
    values (${ws2Id}, 'Agendamiento de citas', 'Reserva y confirmación de citas médicas', ${luciaId})`;
  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
    (${ws2Id}, 'WorkspaceCreado', ${tx.json({ nombre: 'Clínica del Valle', origen: 'seed' })}, ${luciaId}, 'lead-boutique')`;
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
    // Upgrade de bases sembradas antes del selector: el segundo workspace de Lucía.
    let segundoSembrado = false;
    if (lucia) {
      const [ws2] = await sql`select 1 from workspace where nombre = 'Clínica del Valle'`;
      if (!ws2) {
        await sql.begin((tx) => sembrarSegundoWorkspace(tx, lucia.id as string));
        segundoSembrado = true;
      }
    }
    console.log(
      `seed: el workspace Banco Andino ya existe; credenciales demo aseguradas (${actualizados.count} activadas)` +
        (arbolSembrado ? '; árbol R-01/R-02/R-03 + P-01 sembrado' : '') +
        (metodoSembrado ? '; método de P-01 sembrado' : '') +
        (segundoSembrado ? '; Clínica del Valle sembrada' : ''),
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
    await sembrarSegundoWorkspace(tx, luciaId);
  });
  console.log(
    `seed: workspace Banco Andino creado (3 usuarios activos, 3 segmentos, árbol R-01/R-02/R-03 + P-01, método G0-G7) + Clínica del Valle para el selector — login demo: lucia@whitespace.demo / ${PASSWORD_DEMO}`,
  );
}

await main().finally(() => sql.end({ timeout: 5 }));
