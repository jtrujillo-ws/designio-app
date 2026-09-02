import { describe, expect, it } from 'vitest';
import { DesviacionSchema } from '@/lib/entrega/entrega.schemas';
import { EstadoRetoSchema, VeredictoSchema } from '@/lib/metodo/metodo.schemas';
import { OutcomeReviewSchema } from '@/lib/medicion/medicion.schemas';
import { InsightSchema } from '@/lib/evidencia/evidencia.schemas';

/** Invariantes codificadas en los esquemas (docs/03-invariantes). */
describe('esquemas del dominio', () => {
  it('el veredicto es un catálogo cerrado (SYS-24)', () => {
    expect(VeredictoSchema.safeParse('parcialmente logrado').success).toBe(true);
    expect(VeredictoSchema.safeParse('éxito rotundo').success).toBe(false);
  });

  it('los estados del reto son canónicos (I1)', () => {
    for (const e of ['candidato', 'activo', 'en medición', 'cerrado', 'archivado']) {
      expect(EstadoRetoSchema.safeParse(e).success).toBe(true);
    }
    expect(EstadoRetoSchema.safeParse('pausado').success).toBe(false);
  });

  it('toda desviación exige razón no vacía (SYS-07)', () => {
    const base = { elementoId: crypto.randomUUID(), queQuedoDistinto: 'paso adicional' };
    expect(DesviacionSchema.safeParse({ ...base, razon: 'exigido por cumplimiento' }).success).toBe(true);
    expect(DesviacionSchema.safeParse({ ...base, razon: '' }).success).toBe(false);
  });

  it('un insight validable exige al menos una cita (SYS-15)', () => {
    const base = {
      id: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      codigo: 'I-07',
      afirmacion: 'la verificación pide documentos que el usuario no tiene a mano',
      estado: 'propuesto',
    };
    expect(InsightSchema.safeParse({ ...base, citas: [] }).success).toBe(false);
    expect(
      InsightSchema.safeParse({
        ...base,
        citas: [{ evidenciaId: crypto.randomUUID(), fragmento: '…', localizacion: 'p. 41' }],
      }).success,
    ).toBe(true);
  });

  it('el outcome review no habilita causalidad por defecto (SYS-24)', () => {
    const or = OutcomeReviewSchema.parse({
      id: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      retoId: crypto.randomUUID(),
      veredicto: 'parcialmente logrado',
      contribucion: 'contribución del rediseño con factor externo simultáneo',
      completadoEn: new Date().toISOString(),
    });
    expect(or.disenoExperimentalSuficiente).toBe(false);
  });
});
