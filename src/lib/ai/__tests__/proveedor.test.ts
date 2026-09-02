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

function llamar() {
  return generarConProveedor({
    key: 'sk-de-prueba',
    capacidad: 'CI',
    sistema: 'sistema',
    usuario: 'material',
  });
}

describe('adaptador del proveedor AI', () => {
  beforeEach(() => {
    sdk.respuestas = [];
    sdk.modelosLlamados = [];
  });

  it('una negativa del proveedor conserva el uso: la llamada ocurrió y se pagó', async () => {
    sdk.respuestas = [{ stop_reason: 'refusal', content: [], usage: USO_CRUDO }];
    const r = await llamar();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Lo que se perdía: el `usage` de una respuesta que no produce propuesta.
    expect(r.uso?.entrada).toBe(1000);
    expect(r.uso?.salida).toBe(40);
    expect(r.uso?.costoUsd).toBeCloseTo(costoDeUso(MODELO_PRIMARIO, USO_ESPERADO)!, 6);
    expect(r.modelo).toBe(MODELO_PRIMARIO);
    expect(r.causa).toBe('rechazo-proveedor');
    // Y se llama por su nombre: no es «el proveedor rechazó la petición (422)», que suena a
    // error nuestro y a algo que se arregla reintentando (reintentar solo gasta otra vez).
    expect(r.motivo).toMatch(/se negó a procesar/i);
    // Una negativa no es indisponibilidad: no se degrada al modelo de respaldo.
    expect(sdk.modelosLlamados).toEqual([MODELO_PRIMARIO]);
  });

  it('un JSON ilegible también conserva el uso: respondió, se pagó y no sirve', async () => {
    sdk.respuestas = [
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'esto no es json' }], usage: USO_CRUDO },
    ];
    const r = await llamar();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.causa).toBe('fuera-de-contrato');
    expect(r.uso?.entrada).toBe(1000);
    expect(r.motivo).toMatch(/formato esperado/i);
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
    if (r.ok) return;
    expect(r.uso).toBeNull();
    expect(r.causa).toBe('sin-respuesta');
    // Degradación de modelo UNA vez: primario y respaldo, y ahí termina.
    expect(sdk.modelosLlamados).toEqual([MODELO_PRIMARIO, MODELO_FALLBACK]);
    expect(r.modelo).toBe(MODELO_FALLBACK);
  });

  it('la salida buena viaja con el uso del modelo que respondió de verdad', async () => {
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
    expect(r.modelo).toBe(MODELO_FALLBACK);
    // La tarifa es la del modelo que respondió, no la del que se intentó primero.
    expect(r.uso?.costoUsd).toBeCloseTo(costoDeUso(MODELO_FALLBACK, USO_ESPERADO)!, 6);
  });
});
