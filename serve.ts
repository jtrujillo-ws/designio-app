/**
 * Servidor de producción (Bun.serve, puerto 8080 — contrato de Cloud Run):
 * 1) estáticos desde dist/client (assets con caché inmutable);
 * 2) todo lo demás va al worker SSR exportado por dist/server/server.js.
 * Las migraciones se aplican en el entrypoint del contenedor, antes de arrancar esto.
 */
import { join } from 'node:path';

const CLIENT_DIR = join(import.meta.dir, 'dist', 'client');
const SERVER_ENTRY = join(import.meta.dir, 'dist', 'server', 'server.js');

type FetchHandler = { fetch(request: Request): Response | Promise<Response> };
const { default: ssr } = (await import(SERVER_ENTRY)) as { default: FetchHandler };

const port = Number(process.env.PORT ?? 8080);

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico') {
      const file = Bun.file(join(CLIENT_DIR, url.pathname));
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
