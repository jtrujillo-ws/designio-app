/**
 * Seed de desarrollo: el workspace demo del ejemplo trabajado (Banco Andino, prediseño §19).
 * Idempotente: si el workspace ya existe, no hace nada. Corre con la conexión ADMIN.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Falta DATABASE_URL (conexión admin; ver .env.local.example)');
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main() {
  const existentes = await sql`select id from workspace where nombre = 'Banco Andino'`;
  if (existentes.length > 0) {
    console.log('seed: el workspace Banco Andino ya existe; nada que hacer');
    return;
  }

  await sql.begin(async (tx) => {
    const [ws] = await tx`insert into workspace (nombre) values ('Banco Andino') returning id`;
    const wsId = ws!.id as string;

    const [lead] = await tx`insert into miembro (workspace_id, nombre, email, rol) values
      (${wsId}, 'Lucía P.', 'lucia@whitespace.demo', 'lead-boutique') returning id`;
    await tx`insert into miembro (workspace_id, nombre, email, rol) values
      (${wsId}, 'María G.', 'maria@bancoandino.demo', 'sponsor'),
      (${wsId}, 'Gerente de Canales', 'canales@bancoandino.demo', 'stakeholder')`;

    await tx`insert into segmento (workspace_id, nombre, definicion) values
      (${wsId}, 'empleados corporativos', 'Empleados con cuenta nómina por convenio'),
      (${wsId}, 'pymes', 'Pequeñas y medianas empresas'),
      (${wsId}, 'independientes', 'Trabajadores independientes')`;

    await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol) values
      (${wsId}, 'WorkspaceCreado', ${tx.json({ nombre: 'Banco Andino', origen: 'seed' })}, ${lead!.id as string}, 'lead-boutique')`;
  });
  console.log('seed: workspace Banco Andino creado (3 miembros, 3 segmentos)');
}

await main().finally(() => sql.end({ timeout: 5 }));
