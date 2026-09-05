import { describe, expect, it } from 'vitest';
import {
  CLASES_PENDIENTES,
  ROLES_POR_CLASE,
  checklistDecidido,
  clasesDelRol,
  comoAprobacionPendiente,
  contarPendientes,
  destinoDeDerecho,
  destinoDeDesignVersion,
  destinoDeGate,
  destinoDeInsight,
  etiquetaDePendientes,
  type DerechoPendiente,
  type DesignVersionPendiente,
  type GateAbierto,
  type GatePendiente,
  type InsightPendiente,
} from '@/lib/aprobaciones/aprobaciones.schemas';
import { ROLES_DERECHOS } from '@/lib/evidencia/evidencia.schemas';
import { etiquetaDeDestino } from '@/lib/destinos';
import type { ItemDeGate } from '@/lib/metodo/metodo.schemas';

/**
 * La pantalla de aprobaciones decide qué clases enseñar SIN consultar nada: por rol. Y el
 * conteo que da la cabecera es el mismo que el contador del lateral, así que se comprueba
 * que sume solo lo decidible y que cada fila lleve a la pantalla donde se decide.
 */
describe('qué clases decide cada rol', () => {
  it('el lead boutique decide en las cuatro clases, en el orden de la pantalla', () => {
    expect(clasesDelRol('lead-boutique')).toEqual([...CLASES_PENDIENTES]);
  });

  it('el sponsor solo aprueba gates: no concede derechos ni valida insights ni congela versiones', () => {
    expect(clasesDelRol('sponsor')).toEqual(['gate']);
  });

  it('el admin del cliente concede derechos y nada más', () => {
    expect(clasesDelRol('admin-cliente')).toEqual(['derecho']);
  });

  it('el diseñador valida insights pero no aprueba gates ni design versions', () => {
    expect(clasesDelRol('disenador')).toEqual(['insight']);
  });

  it('un stakeholder (o un rol desconocido) no decide nada', () => {
    expect(clasesDelRol('stakeholder')).toEqual([]);
    expect(clasesDelRol('')).toEqual([]);
    expect(clasesDelRol('agente-ai')).toEqual([]);
  });

  it('los derechos los deciden los mismos roles que la pantalla de evidencia ya conoce', () => {
    expect(ROLES_POR_CLASE.derecho).toBe(ROLES_DERECHOS);
  });
});

function item(estado: ItemDeGate['estado'], decisionEnRevision = false): ItemDeGate {
  return {
    id: `i-${estado}`,
    orden: 0,
    texto: 'Ítem',
    estado,
    objetoClase: null,
    objetoId: null,
    objetoTitulo: null,
    decisionEnRevision,
    naJustificacion: '',
  };
}

describe('el checklist decidido (lo que «Te toca a ti» llama aprobación pendiente)', () => {
  const base = {
    id: 'g1',
    numero: 1,
    rolAprobador: 'lead-boutique',
    estado: 'pendiente',
    aprobadoEn: null,
  } as const;

  it('cuenta con todo decidido: cumplidos o N/A, nada pendiente', () => {
    expect(checklistDecidido({ ...base, items: [item('cumplido'), item('na')] })).toBe(true);
  });

  it('no cuenta con un ítem pendiente, ni con el checklist vacío (no es suficiencia)', () => {
    expect(checklistDecidido({ ...base, items: [item('cumplido'), item('pendiente')] })).toBe(
      false,
    );
    expect(checklistDecidido({ ...base, items: [] })).toBe(false);
  });

  it('se proyecta a la fila del resumen del loop con la marca de si es de quien mira', () => {
    const abierto: GateAbierto = {
      gate: { ...base, items: [item('cumplido')] },
      esMia: false,
      proyectoId: 'p1',
      proyectoCodigo: 'P-01',
      retoCodigo: 'R-01',
      contexto: {
        anterioresAprobados: true,
        criteriosListosG0: true,
        registryFirmadoG6: true,
        arquetiposSinVeredicto: 0,
        proyectoEstado: 'activo',
      },
    };
    expect(comoAprobacionPendiente(abierto)).toEqual({
      gateId: 'g1',
      numero: 1,
      rolAprobador: 'lead-boutique',
      esMia: false,
      proyectoId: 'p1',
      proyectoCodigo: 'P-01',
      retoCodigo: 'R-01',
    });
  });
});

describe('el conteo de la cabecera', () => {
  const gate: GatePendiente = {
    gateId: 'g1',
    numero: 1,
    rolAprobador: 'lead-boutique',
    proyectoId: 'p1',
    proyectoCodigo: 'P-01',
    retoCodigo: 'R-01',
    falta: [],
  };
  const derecho: DerechoPendiente = {
    evidenciaId: 'e1',
    titulo: 'Entrevista',
    fuenteTitulo: 'Estudio',
    creadoEn: '2026-09-01T00:00:00.000Z',
  };
  const insight: InsightPendiente = {
    insightId: 'i1',
    titulo: 'Hallazgo',
    afirmaciones: 2,
    afirmacionesSinRespaldo: 1,
    creadoEn: '2026-09-01T00:00:00.000Z',
  };
  const dv: DesignVersionPendiente = {
    designVersionId: 'dv1',
    codigo: 'DV-1',
    titulo: 'Versión',
    proyectoCodigo: 'P-01',
    journeyEnlazado: true,
    conElementos: false,
    creadoEn: '2026-09-01T00:00:00.000Z',
  };

  it('suma las cuatro clases y las reparte', () => {
    const conteo = contarPendientes({
      gates: [gate, { ...gate, gateId: 'g2', numero: 2 }],
      derechos: [derecho],
      insights: [insight],
      designVersions: [dv],
    });
    expect(conteo.total).toBe(5);
    expect(conteo.porClase).toEqual({ gate: 2, derecho: 1, insight: 1, 'design-version': 1 });
  });

  it('un gate al que le falta algo se lista pero NO cuenta: no es decidible ahora', () => {
    const conteo = contarPendientes({
      gates: [gate, { ...gate, gateId: 'g2', falta: ['2 pendientes'] }],
      derechos: [],
      insights: [],
      designVersions: [],
    });
    expect(conteo.total).toBe(1);
    expect(conteo.porClase.gate).toBe(1);
  });

  it('sin nada, el total es cero y cada clase también', () => {
    const conteo = contarPendientes({ gates: [], derechos: [], insights: [], designVersions: [] });
    expect(conteo.total).toBe(0);
    expect(Object.values(conteo.porClase)).toEqual([0, 0, 0, 0]);
  });

  it('cada fila lleva a la pantalla donde se decide, y el pie la nombra', () => {
    expect(destinoDeGate(gate)).toEqual({
      to: '/proyecto/$proyectoId',
      params: { proyectoId: 'p1' },
    });
    expect(etiquetaDeDestino(destinoDeGate(gate), gate.proyectoCodigo)).toBe('Proyecto P-01');
    expect(destinoDeDerecho(derecho)).toEqual({ to: '/evidencia', search: { destacar: 'e1' } });
    expect(destinoDeInsight(insight)).toEqual({ to: '/insights', search: { destacar: 'i1' } });
    expect(destinoDeDesignVersion(dv)).toEqual({
      to: '/design-version/$designVersionId',
      params: { designVersionId: 'dv1' },
    });
    expect(etiquetaDeDestino(destinoDeDesignVersion(dv), dv.codigo)).toBe('Design version DV-1');
  });

  it('concuerda el número con la palabra', () => {
    expect(etiquetaDePendientes(1)).toBe('1 pendiente');
    expect(etiquetaDePendientes(3)).toBe('3 pendientes');
    expect(etiquetaDePendientes(0)).toBe('0 pendientes');
  });
});
