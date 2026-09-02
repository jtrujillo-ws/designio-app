/**
 * Tripwire server-only: los módulos que jamás deben llegar al navegador lo importan.
 * Si el bundler arrastra un módulo server al cliente, esto detona con un mensaje claro
 * en vez de fallar silenciosamente en producción (defensa 2 de 3 del split server/client;
 * las otras dos: reglas de ESLint y el check de CI sobre el bundle real).
 */
if (typeof window !== 'undefined') {
  throw new Error(
    'Módulo server-only cargado en el navegador. Revisa qué import lo arrastró: ' +
      'los *.functions.ts solo exportan server functions y los helpers server viven aparte.',
  );
}

export const serverOnly = true;
