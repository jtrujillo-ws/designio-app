/**
 * Servidor de producción (Bun.serve; respeta el PORT que inyecta la plataforma — Railway):
 * 1) /healthz para el healthcheck de despliegue;
 * 2) estáticos desde dist/client (assets con caché inmutable);
 * 3) todo lo demás va al worker SSR exportado por dist/server/server.js.
 * Las migraciones se aplican en el entrypoint del contenedor, antes de arrancar esto.
 */
import { join, sep } from 'node:path';
import postgres from 'postgres';

const CLIENT_DIR = join(import.meta.dir, 'dist', 'client');
const SERVER_ENTRY = join(import.meta.dir, 'dist', 'server', 'server.js');

type FetchHandler = { fetch(request: Request): Response | Promise<Response> };
const { default: ssr } = (await import(SERVER_ENTRY)) as { default: FetchHandler };

// Readiness de la conexión de APLICACIÓN (rol no privilegiado): las migraciones del
// entrypoint solo prueban la conexión admin, así que una DATABASE_URL_APP mal compuesta
// (referencia sin resolver, password del rol incorrecta) pasaría inadvertida y todo
// request con datos fallaría con el contenedor "sano". Y no basta con que AUTENTIQUE:
// si por error apunta a la URL admin, el tráfico de la app correría con un rol que
// BYPASEA RLS — se verifica identidad (designio_app) y ausencia de privilegios de
// bypass antes de dar el verde. Una vez verificada queda verde: el healthcheck gatea
// el ROLLOUT — un blip de la base en runtime no debe tumbar un contenedor que ya
// arrancó bien.
const ROL_APP = 'designio_app';
let appDbVerificada = false;
async function appDbLista(): Promise<boolean> {
  if (appDbVerificada) return true;
  const url = process.env.DATABASE_URL_APP;
  if (!url) {
    console.error('healthz: falta DATABASE_URL_APP');
    return false;
  }
  /*
   * La creación del pool va DENTRO del guardián, y esto costó media hora de diagnóstico en el
   * primer despliegue: `postgres()` valida la URL y LANZA cuando no parsea —medido:
   * `postgres('postgres.railway.internal / 5432')` responde «cannot be parsed as a URL»—. Con
   * la llamada fuera del `try`, esa excepción se escapaba de aquí y del `fetch` entero, así
   * que `/healthz` devolvía un 500 opaco del runtime en vez del 503 que este guardián existe
   * para dar. O sea: el único caso en que la configuración está tan mal que hay MÁS que
   * explicar era justo el que se quedaba sin explicación.
   */
  let sql: ReturnType<typeof postgres>;
  try {
    sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  } catch (e) {
    console.error('healthz: DATABASE_URL_APP no es una URL de conexión válida', e);
    return false;
  }
  try {
    const [quien] = await sql`
      select current_user as usuario,
             (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as bypassa_rls`;
    if (quien?.usuario !== ROL_APP || quien?.bypassa_rls === true) {
      console.error(
        `healthz: DATABASE_URL_APP no usa el rol de aplicación esperado (usuario=${String(quien?.usuario)}, bypassa RLS=${String(quien?.bypassa_rls)}) — ¿quedó apuntando a la URL admin?`,
      );
      return false;
    }
    // Los roles son CLUSTER-wide: la identidad no prueba que la URL apunte a la BASE
    // migrada (misma instancia, base equivocada → el pool luego no encontraría tablas).
    // Tocar una relación conocida falla con 42P01 en la base errónea; bajo RLS sin
    // contexto devuelve 0 filas, que aquí es suficiente y correcto.
    await sql`select count(*) from workspace`;
    appDbVerificada = true;
    return true;
  } catch (e) {
    console.error('healthz: la conexión de aplicación no está lista', e);
    return false;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// PORT validado con fallback explícito: un valor vacío o no numérico jamás debe
// producir NaN ni el puerto 0 (que bindearía uno aleatorio).
const portEnv = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isInteger(portEnv) && portEnv > 0 && portEnv < 65536 ? portEnv : 8080;

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return (await appDbLista())
        ? new Response('ok', { headers: { 'content-type': 'text/plain' } })
        : new Response('app-db no disponible', {
            status: 503,
            headers: { 'content-type': 'text/plain' },
          });
    }
    if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico') {
      // join() normaliza `..`: se verifica que la ruta resuelta siga DENTRO de dist/client
      // (anti path-traversal); cualquier escape cae al SSR como una ruta más.
      const rutaEstatica = join(CLIENT_DIR, url.pathname);
      if (!rutaEstatica.startsWith(CLIENT_DIR + sep)) {
        return ssr.fetch(request);
      }
      const file = Bun.file(rutaEstatica);
      if (await file.exists()) {
        const headers = url.pathname.startsWith('/assets/')
          ? { 'cache-control': 'public, max-age=31536000, immutable' }
          : undefined;
        return new Response(file, { headers });
      }
    }
    return ssr.fetch(request);
  },
});

console.log(`designio escuchando en :${port}`);
