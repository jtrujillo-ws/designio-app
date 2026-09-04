import { expect, it, vi, beforeEach, describe } from 'vitest';
import { costoDeUso, MODELO_FALLBACK, MODELO_PRIMARIO } from '../ai.degradacion';

/**
 * El adaptador del proveedor, con el SDK simulado: aquí se prueba lo que NINGÚN test de
 * integración puede ver, porque la suite authz sustituye este módulo entero — qué pasa con
 * el `usage` de una respuesta que no produce contenido.
 *
 * La propiedad que se defiende: el uso de una llamada se lee ANTES de decidir si hay
 * propuesta. Una negativa del proveedor y un JSON ilegible son respuestas completas y
 * facturadas; leer el uso después de la rama que lanza las borraba del libro de costos.
 */

const sdk = vi.hoisted(() => ({
  respuestas: [] as unknown[],
  modelosLlamados: [] as string[],
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class ClienteSimulado {
    messages = {
      create: async (params: { model: string }) => {
        sdk.modelosLlamados.push(params.model);
        const siguiente = sdk.respuestas.shift();
        if (siguiente instanceof Error) throw siguiente;
        return siguiente;
      },
    };
  },
}));

const { generarConProveedor } = await import('../proveedor.server');

const USO_CRUDO = { input_tokens: 1000, output_tokens: 40 };
const USO_ESPERADO = { entrada: 1000, salida: 40 };

/** Los apuntes que el adaptador pidió abrir, en orden. Es lo que permite comprobar que el
 * libro se abre ANTES de cada despacho y no después. */
const apuntes: { modelo: string; puesto: number }[] = [];
/** Cuando se pone, el apunte de ESE puesto falla con este motivo: sin línea no hay despacho.
 * Por puesto y no global porque el apunte es también la puerta del permiso, y lo que hay que
 * poder representar es que el primario pase y el respaldo no. */
let apunteFalla: { puesto: number; motivo: string } | null = null;

function llamar() {
  return generarConProveedor({
    key: 'sk-de-prueba',
    capacidad: 'CI',
    sistema: 'sistema',
    usuario: 'material',
    anotarDespacho: async (modelo, puesto) => {
      if (apunteFalla?.puesto === puesto) return { ok: false, motivo: apunteFalla.motivo };
      apuntes.push({ modelo, puesto });
      return { ok: true, registroId: `linea-${apuntes.length}` };
    },
  });
}

describe('adaptador del proveedor AI', () => {
  beforeEach(() => {
    sdk.respuestas = [];
    sdk.modelosLlamados = [];
    // También aquí: desde que el apunte es la puerta del permiso, hay tests de ESTE bloque
    // que lo hacen fallar, y un `apunteFalla` que sobreviviera al test dejaría al siguiente
    // sin despachar por un motivo que no es el suyo.
    apuntes.length = 0;
    apunteFalla = null;
  });

  it('una negativa del proveedor conserva el uso: la llamada ocurrió y se pagó', async () => {
    sdk.respuestas = [{ stop_reason: 'refusal', content: [], usage: USO_CRUDO }];
    const r = await llamar();
    expect(r.ok).toBe(false);
    expect(r.intentos).toHaveLength(1);
    const intento = r.intentos[0]!;
    // Lo que se perdía: el `usage` de una respuesta que no produce propuesta.
    expect(intento.uso?.entrada).toBe(1000);
    expect(intento.uso?.salida).toBe(40);
    expect(intento.uso?.costoUsd).toBeCloseTo(costoDeUso(MODELO_PRIMARIO, USO_ESPERADO)!, 6);
    expect(intento.modelo).toBe(MODELO_PRIMARIO);
    expect(intento.resultado).toBe('rechazo-proveedor');
    // Y se llama por su nombre: no es «el proveedor rechazó la petición (422)», que suena a
    // error nuestro y a algo que se arregla reintentando (reintentar solo gasta otra vez).
    expect(intento.motivo).toMatch(/se negó a procesar/i);
    // Una negativa no es indisponibilidad: no se degrada al modelo de respaldo.
    expect(sdk.modelosLlamados).toEqual([MODELO_PRIMARIO]);
  });

  it('un JSON ilegible también conserva el uso: respondió, se pagó y no sirve', async () => {
    sdk.respuestas = [
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'esto no es json' }], usage: USO_CRUDO },
    ];
    const r = await llamar();
    expect(r.ok).toBe(false);
    expect(r.intentos).toHaveLength(1);
    expect(r.intentos[0]!.resultado).toBe('fuera-de-contrato');
    expect(r.intentos[0]!.uso?.entrada).toBe(1000);
    expect(r.intentos[0]!.motivo).toMatch(/formato esperado/i);
    // Tampoco se reintenta con otro modelo: no es indisponibilidad.
    expect(sdk.modelosLlamados).toEqual([MODELO_PRIMARIO]);
  });

  it('un fallo sin respuesta deja el uso en null: «no se sabe» no es «salió gratis»', async () => {
    sdk.respuestas = [
      Object.assign(new Error('boom'), { status: 500 }),
      Object.assign(new Error('boom'), { status: 500 }),
    ];
    const r = await llamar();
    expect(r.ok).toBe(false);
    // Degradación de modelo UNA vez: primario y respaldo, y ahí termina — y los DOS
    // intentos suben, porque los dos ocurrieron.
    expect(sdk.modelosLlamados).toEqual([MODELO_PRIMARIO, MODELO_FALLBACK]);
    expect(r.intentos.map((i) => i.modelo)).toEqual([MODELO_PRIMARIO, MODELO_FALLBACK]);
    expect(r.intentos.every((i) => i.resultado === 'sin-respuesta' && i.uso === null)).toBe(true);
  });

  it('el respaldo pide permiso otra vez: si lo revocaron, no sale un segundo despacho', async () => {
    // Degradar de modelo NO es la misma llamada otra vez: es una petición NUEVA, que sale
    // con la primera ya terminada, el control de vuelta aquí y ni un byte en el aire. El
    // argumento de que ningún candado alcanza a una llamada EN VUELO —cierto para el
    // material ya enviado— no dice nada de este caso: aquí no hay límite físico, hay una
    // comprobación que hacer. Y si el consentimiento se revocó mientras el primario viajaba,
    // la revocación ya retiró la reserva, así que el respaldo saldría sin el token que
    // debía impedirlo.
    //
    // El permiso ya no se pide por un canal aparte: lo pide el APUNTE del respaldo, que abre
    // su línea y comprueba en la misma transacción. Que la puerta sea una sola es lo que hace
    // que el primario esté igual de cubierto — antes tenía la suya, leída y commiteada una
    // transacción antes de despachar.
    sdk.respuestas = [
      Object.assign(new Error('no disponible'), { status: 503 }),
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"titulo":"ok"}' }], usage: USO_CRUDO },
    ];
    apunteFalla = {
      puesto: 1,
      motivo: 'El consentimiento de ese material dejó de autorizar el procesamiento externo',
    };
    const r = await llamar();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/consentimiento/i);
    // Solo UN intento: el segundo no llegó a salir. Y el del primario queda anotado con su
    // coste, que se pagó igual.
    expect(r.intentos).toHaveLength(1);
    expect(r.intentos[0]!.modelo).toBe(MODELO_PRIMARIO);
    expect(sdk.modelosLlamados).toEqual([MODELO_PRIMARIO]);
  });

  it('y si el permiso sigue vigente, el respaldo sale con su PROPIO apunte, no con el del primario', async () => {
    // La otra mitad: pedir permiso otra vez no es bloquear. Y cada intento abre su propia
    // línea, que es donde queda anotada la autorización bajo la que salió: compartir la del
    // primario haría que el libro afirmara en falso bajo qué permiso viajó el material.
    sdk.respuestas = [
      Object.assign(new Error('no disponible'), { status: 503 }),
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"titulo":"ok"}' }], usage: USO_CRUDO },
    ];
    const r = await llamar();
    expect(r.ok).toBe(true);
    expect(apuntes.map((a) => a.puesto)).toEqual([0, 1]);
    expect(r.intentos.map((i) => i.registroId)).toEqual(['linea-1', 'linea-2']);
    expect(sdk.modelosLlamados).toEqual([MODELO_PRIMARIO, MODELO_FALLBACK]);
  });

  it('el intento fallido del primario no se pierde cuando el respaldo sí responde', async () => {
    sdk.respuestas = [
      Object.assign(new Error('no disponible'), { status: 503 }),
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"titulo":"ok"}' }],
        usage: USO_CRUDO,
      },
    ];
    const r = await llamar();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.datos).toEqual({ titulo: 'ok' });
    // DOS intentos: el del primario que se cayó —que antes desaparecía con el `continue`,
    // dejando la tasa de error por modelo diciendo que el primario nunca falla— y el del
    // respaldo que respondió.
    expect(r.intentos.map((i) => [i.modelo, i.resultado])).toEqual([
      [MODELO_PRIMARIO, 'sin-respuesta'],
      [MODELO_FALLBACK, 'salida-valida'],
    ]);
    expect(r.intentos[0]!.motivo).toMatch(/no está disponible/i);
    // La tarifa es la del modelo que respondió, no la del que se intentó primero.
    expect(r.intentos[1]!.uso?.costoUsd).toBeCloseTo(
      costoDeUso(MODELO_FALLBACK, USO_ESPERADO)!,
      6,
    );
    // Y cada latencia es la de SU intento: la del respaldo no arrastra la espera del
    // primario, que era lo que hacía irreal la latencia por modelo.
    expect(r.intentos.every((i) => i.latenciaMs >= 0)).toBe(true);
  });
});

describe('el libro se abre antes de despachar (RF-09.14)', () => {
  // El estado del doble se reinicia AQUÍ y no al final de cada test: `apunteFalla` armado y
  // desarmado dentro del cuerpo se queda puesto si una aserción cae por el camino, y a partir
  // de ahí toda llamada devuelve `ok:false` sin tocar el SDK — una cascada de fallos que no
  // señalan a la causa.
  beforeEach(() => {
    apuntes.length = 0;
    apunteFalla = null;
    sdk.modelosLlamados = [];
    sdk.respuestas = [];
  });

  it('cada intento abre su línea ANTES de la llamada, y con su propio modelo', async () => {
    // Primario cae con 5xx → degrada; el respaldo tampoco responde. Dos despachos, dos
    // apuntes, en orden y cada uno con su modelo: la línea no se comparte entre intentos.
    sdk.respuestas = [
      Object.assign(new Error('boom'), { status: 500 }),
      Object.assign(new Error('boom'), { status: 500 }),
    ];
    const r = await llamar();
    expect(r.ok).toBe(false);
    expect(apuntes.map((a) => a.modelo)).toEqual([MODELO_PRIMARIO, MODELO_FALLBACK]);
    // Y cada uno con su puesto, que ahora lo pasa el adaptador en vez de un contador aparte.
    expect(apuntes.map((a) => a.puesto)).toEqual([0, 1]);
    // Y cada intento sube sellado con la línea que se abrió para él.
    expect(r.intentos.map((i) => i.registroId)).toEqual(['linea-1', 'linea-2']);
  });

  it('si la línea no se puede abrir, NO se despacha', async () => {
    // Éste es el arreglo entero. Antes, el gasto podía ocurrir y perderse: la fila se
    // escribía al VOLVER, y un fallo transitorio de esa transacción borraba del libro una
    // llamada que el proveedor ya había cobrado. Ahora, si no se puede anotar, sencillamente
    // no ocurre — y se comprueba mirando que el SDK ni siquiera se llamó.
    apunteFalla = { puesto: 0, motivo: 'el libro no admite la línea' };
    const r = await llamar();
    expect(r.ok).toBe(false);
    expect(sdk.modelosLlamados).toEqual([]);
    expect(r.intentos).toEqual([]);
    if (!r.ok) expect(r.motivo).toBe('el libro no admite la línea');
  });
});
