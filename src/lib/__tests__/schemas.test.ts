import { describe, expect, it } from 'vitest';
import { DesviacionSchema } from '@/lib/entrega/entrega.schemas';
import { EstadoRetoSchema, VeredictoSchema } from '@/lib/metodo/metodo.schemas';
import {
  etiquetaVentana,
  motivoFechaDeSnapshot,
  OutcomeReviewSchema,
  ventanaAbierta,
  ventanasCerradas,
  type EntradaDeRegistry,
} from '@/lib/medicion/medicion.schemas';
import { etiquetaObjetoBloqueado, InsightSchema } from '@/lib/evidencia/evidencia.schemas';

/** Invariantes codificadas en los esquemas (docs/03-invariantes). */
describe('esquemas del dominio', () => {
  it('el veredicto es un catálogo cerrado (SYS-24)', () => {
    expect(VeredictoSchema.safeParse('parcialmente logrado').success).toBe(true);
    expect(VeredictoSchema.safeParse('éxito rotundo').success).toBe(false);
  });

  it('el snapshot cae dentro de la ventana firmada, extremos incluidos (I5)', () => {
    const ventana = { ventanaInicio: '2026-03-01', ventanaFin: '2026-05-30', hoy: '2026-09-02' };
    // Los dos extremos son días MEDIDOS: la ventana es cerrada, no semiabierta.
    expect(motivoFechaDeSnapshot('2026-03-01', ventana)).toBeNull();
    expect(motivoFechaDeSnapshot('2026-05-30', ventana)).toBeNull();
    expect(motivoFechaDeSnapshot('2026-02-28', ventana)).toMatch(/anterior a la ventana/);
    expect(motivoFechaDeSnapshot('2026-05-31', ventana)).toMatch(/posterior a la ventana/);
    // Hoy sí; mañana no: un valor fechado por delante sería la «última recepción» de la
    // proyección y el candidato a resultado final del review sin haber medido nada.
    const abierta = { ...ventana, ventanaFin: '2026-12-31' };
    expect(motivoFechaDeSnapshot('2026-09-02', abierta)).toBeNull();
    expect(motivoFechaDeSnapshot('2026-09-03', abierta)).toMatch(/en el futuro/);
  });

  it('el último día de la ventana todavía mide: el post-mortem se abre al siguiente (RF-07.7)', () => {
    // El corte tiene que ser el MISMO que el de `motivoFechaDeSnapshot` de arriba: allí el
    // día de cierre es un día medido, así que aquí no puede darse por cerrado. Con `<= 0`
    // el review se abría esa misma mañana, cerraba el reto de forma irreversible (SYS-08)
    // y los snapshots legítimos de esa tarde ya no tenían dónde entrar.
    expect(ventanaAbierta({ diasRestantes: 1 })).toBe(true);
    expect(ventanaAbierta({ diasRestantes: 0 })).toBe(true);
    expect(ventanaAbierta({ diasRestantes: -1 })).toBe(false);
    // Sin ventana declarada tampoco está cerrada: no hay nada que dar por terminado, y es
    // la rama que impide abrir el review sobre un registry al que le falta la ventana.
    expect(ventanaAbierta({ diasRestantes: null })).toBe(true);

    const entradas = (dias: (number | null)[]) =>
      dias.map((d) => ({ diasRestantes: d })) as EntradaDeRegistry[];
    expect(ventanasCerradas(entradas([-1, -20]))).toBe(true);
    expect(ventanasCerradas(entradas([-1, 0]))).toBe(false);
    expect(ventanasCerradas(entradas([-1, null]))).toBe(false);
    // Un registry sin entradas no tiene ninguna ventana cerrada que exhibir.
    expect(ventanasCerradas(entradas([]))).toBe(false);

    // Y la pantalla nombra los tres estados por separado: «cierra hoy» no es «cerrada».
    expect(etiquetaVentana(3)).toBe('faltan 3 días');
    expect(etiquetaVentana(0)).toBe('cierra hoy');
    expect(etiquetaVentana(-2)).toBe('ventana cerrada');
    expect(etiquetaVentana(null)).toBe('sin ventana');
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

  it('el rótulo de un objeto bloqueado nombra SU dimensión, no siempre los derechos', () => {
    // SYS-14 obliga a bloquear *explicando* y el criterio de aceptación 3 pide nombrar la
    // dimensión que FALTA. El picker del checklist ofrece tres clases y no todas se
    // bloquean por lo mismo: una decisión `en-revision` tras una reapertura (SYS-10) no
    // tiene nada que ver con los derechos de uso. Con el prefijo fijo salía «sin derechos:
    // está en revisión…», que manda a reparar donde no hay nada roto.
    const enRevision =
      'está en revisión tras una reapertura aguas arriba (SYS-10): revalídala antes de citarla';
    expect(etiquetaObjetoBloqueado('Atacar la verificación', enRevision)).toBe(
      `Atacar la verificación — ${enRevision}`,
    );
    expect(etiquetaObjetoBloqueado('Atacar la verificación', enRevision)).not.toContain(
      'sin derechos',
    );

    // El motivo de la base viaja tal cual: ya es una frase que se lee sola.
    const pendientes =
      'derechos pendientes: nadie ha registrado la base (consentimiento o cláusula) que autoriza este uso';
    expect(etiquetaObjetoBloqueado('Entrevistas', pendientes)).toBe(
      `Entrevistas — ${pendientes}`,
    );

    // Y solo cuando NO hay motivo se nombran los derechos: ese null es el pre-chequeo
    // anti-oráculo de `evidencia_motivo_bloqueo`, que solo se alcanza por esa vía.
    expect(etiquetaObjetoBloqueado('Entrevistas', null)).toBe(
      'Entrevistas — sin derechos: faltan derechos de uso para el ámbito cliente',
    );
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
