import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_CONFIGURACION_VISIBLE,
  ErrorConfiguracion,
  falloDeDominio,
  respuestaDeConfiguracion,
} from '@/lib/configuracion.server';
import { cerrarPools, sql } from '@/lib/db';
import { firmarSesion } from '@/lib/auth/sesion.server';

/**
 * Entrar tiene TRES desenlaces, y la pantalla trataba dos.
 *
 * Los dos que estaban son del visitante: entró, o sus credenciales no valen. El tercero no es
 * suyo — el despliegue no puede completar un login— y salía como excepción, que el `catch` de
 * la pantalla convertía en «No se pudo iniciar sesión; intenta de nuevo».
 *
 * Eso no es un mensaje impreciso: es una INSTRUCCIÓN que no puede funcionar. Pasó en el
 * despliegue de Railway con `DATABASE_URL_APP` puesta al host y el puerto en vez de a una URL,
 * y se perdió un buen rato revisando una contraseña que estaba bien.
 *
 * Lo que se sujeta aquí es la CLASIFICACIÓN, que es lo único que puede volver atrás: que los
 * fallos de configuración se distingan por su TIPO —no por su texto, que son tres redacciones
 * distintas y habrá una cuarta—, que el detalle no se escape al navegador, y que lo que nadie
 * ha clasificado no se disfrace del tercer desenlace.
 */
describe('el tercer desenlace de entrar: el despliegue, no el visitante', () => {
  const originales = { app: process.env.DATABASE_URL_APP, jwt: process.env.JWT_SECRET };

  afterEach(async () => {
    // Las variables y el pool memoizado vuelven como estaban: este fichero manipula las dos.
    if (originales.app === undefined) delete process.env.DATABASE_URL_APP;
    else process.env.DATABASE_URL_APP = originales.app;
    if (originales.jwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originales.jwt;
    vi.unstubAllEnvs();
    await cerrarPools();
  });

  /**
   * El valor EXACTO que tenía el despliegue. Medido antes de arreglar nada: `postgres()` lanza
   * un `TypeError` («… cannot be parsed as a URL») al CONSTRUIR el pool, antes de la primera
   * consulta — así que salía por la server function de login sin que nada lo clasificara.
   *
   * Que la variable exista no la hace una cadena de conexión, y ese es justo el hueco: la
   * guarda de «falta la variable» no lo veía.
   */
  it('un DSN que no parsea es un fallo de CONFIGURACIÓN, no un TypeError suelto', async () => {
    await cerrarPools();
    process.env.DATABASE_URL_APP = 'postgres.railway.internal / 5432';
    expect(() => sql()).toThrow(ErrorConfiguracion);
  });

  it('y una variable ausente, también', async () => {
    await cerrarPools();
    delete process.env.DATABASE_URL_APP;
    expect(() => sql()).toThrow(ErrorConfiguracion);
  });

  /**
   * El otro sitio, y el peor: se llega DESPUÉS de haber comprobado que la contraseña era
   * buena. «Revisa tus credenciales» ahí miente del todo.
   */
  it('y la clave de firma ausente en producción', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.JWT_SECRET;
    await expect(firmarSesion(crypto.randomUUID())).rejects.toThrow(ErrorConfiguracion);
  });

  /**
   * El mensaje que ve el visitante no lleva el detalle. La pantalla de login es pública, y el
   * detalle nombra variables de entorno —y a veces lleva dentro un DSN con su contraseña—.
   */
  it('no le enseña al visitante ni la variable ni el DSN', async () => {
    await cerrarPools();
    const dsn = 'postgres://usuario:CLAVE-SECRETA@interno.ejemplo:5432/base';
    process.env.DATABASE_URL_APP = 'no-es-una-url';
    const error = (() => {
      try {
        sql();
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ErrorConfiguracion);

    const anotado: unknown[] = [];
    const espia = vi.spyOn(console, 'error').mockImplementation((...a) => void anotado.push(a));
    const r = respuestaDeConfiguracion('login', new ErrorConfiguracion(`DSN roto: ${dsn}`));
    espia.mockRestore();

    expect(r).toEqual({ ok: false, error: ERROR_CONFIGURACION_VISIBLE, reintentable: false });
    expect(r!.error).not.toContain('CLAVE-SECRETA');
    expect(r!.error).not.toContain('DATABASE_URL_APP');
    // Y el detalle SÍ queda donde sirve: en el registro del servidor.
    expect(JSON.stringify(anotado)).toContain('CLAVE-SECRETA');
  });

  /**
   * La otra mitad, y la que evita cambiar una mentira por otra: lo que NADIE ha clasificado no
   * se convierte en «fallo de configuración». `respuestaDeConfiguracion` devuelve `null` y
   * quien llama relanza, así que un fallo desconocido se ve como lo que es.
   */
  it('no se traga lo que no es de configuración', () => {
    expect(respuestaDeConfiguracion('login', new TypeError('cualquier otra cosa'))).toBeNull();
    expect(respuestaDeConfiguracion('login', new Error('la base se cayó'))).toBeNull();
    expect(respuestaDeConfiguracion('login', 'ni siquiera es un Error')).toBeNull();
  });

  /** Y un fallo del visitante sigue diciendo que reintentar es lo que hay que hacer. */
  it('un fallo del visitante sí es reintentable', () => {
    expect(falloDeDominio('Correo o contraseña incorrectos')).toEqual({
      ok: false,
      error: 'Correo o contraseña incorrectos',
      reintentable: true,
    });
  });

  /**
   * Y las dos pantallas lo USAN.
   *
   * El campo podía llegar perfectamente clasificado y quedarse sin leer: es exactamente el
   * defecto que este repositorio acaba de pagar en el registro de capacidades AI —consultar el
   * mapa y no usar su respuesta—. Aquí lo que hay que sujetar es que el botón que ofrece el
   * reintento imposible se apague, así que se mira que la decisión esté escrita.
   */
  it('el botón de las dos pantallas se apaga cuando reintentar no puede servir', async () => {
    const raiz = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
    for (const ruta of ['src/routes/login.tsx', 'src/routes/invitacion.$token.tsx']) {
      const codigo = await readFile(`${raiz}/${ruta}`, 'utf8');
      // Que esté mirando el fichero de verdad y no una cadena vacía por un renombrado.
      expect(codigo.length, `${ruta} vacío`).toBeGreaterThan(1000);
      expect(codigo, `${ruta} no lee el desenlace`).toContain('setReintentable(r.reintentable)');
      expect(codigo, `${ruta} no apaga el botón`).toMatch(/disabled=\{enviando \|\| !reintentable\}/);
    }
  });
});
