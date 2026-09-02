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
// request con datos fallaría con el contenedor "sano". /healthz la verifica; una vez
// verde queda verde: el healthcheck gatea el ROLLOUT — un blip de la base en runtime
// no debe tumbar un contenedor que ya arrancó bien.
let appDbVerificada = false;
async function appDbLista(): Promise<boolean> {
  if (appDbVerificada) return true;
  const url = process.env.DATABASE_URL_APP;
  if (!url) {
    console.error('healthz: falta DATABASE_URL_APP');
    return false;
  }
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
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
