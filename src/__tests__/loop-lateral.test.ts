import { describe, expect, it } from 'vitest';
import {
  ETIQUETA_DISENO,
  ETIQUETA_MATERIAL,
  agruparLateral,
  claveDeGobierno,
  notaDeGobierno,
  type RutaDelWorkspace,
} from '@/lib/loop/lateral';

/**
 * El lateral dejó de ser una lista plana de trece destinos: se ordena por clase y lo
 * pendiente sube a «Te espera». Estas pruebas fijan las reglas del handoff (turno 4a) que
 * no se ven en un fotograma: qué sube, qué vuelve a su estante y qué ve cada rol.
 */
describe('agrupación del lateral (4a)', () => {
  const todos = (l: ReturnType<typeof agruparLateral>) => [
    ...l.teEspera,
    ...l.estantes.flatMap((e) => e.destinos),
    ...l.gobierno,
  ];

  it('con ambos contadores, «Te espera» lleva exactamente esos dos, aprobaciones primero', () => {
    const l = agruparLateral({
      rol: 'lead-boutique',
      pendientesDelRol: 1,
      importacionPendientes: 2,
    });
    expect(l.teEspera.map((d) => d.to)).toEqual(['/aprobaciones', '/importacion']);
    expect(l.teEspera[0]?.contador).toEqual({
      n: 1,
      color: 'warn',
      titulo: '1 pendiente de tu rol',
    });
    expect(l.teEspera[1]?.contador).toEqual({ n: 2, color: 'accent', titulo: '2 sin curar' });
    // Y no se repiten abajo.
    expect(l.estantes[0]?.destinos.map((d) => d.to)).toEqual([
      '/evidencia',
      '/insights',
      '/oportunidades',
      '/segmentos',
    ]);
  });

  it('a cero, el bloque no existe y las filas vuelven a «Material y razonamiento»', () => {
    const l = agruparLateral({
      rol: 'lead-boutique',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(l.teEspera).toEqual([]);
    expect(l.estantes[0]?.etiqueta).toBe(ETIQUETA_MATERIAL);
    expect(l.estantes[0]?.destinos.map((d) => d.to)).toEqual([
      '/aprobaciones',
      '/importacion',
      '/evidencia',
      '/insights',
      '/oportunidades',
      '/segmentos',
    ]);
    // Sin contador: nunca se pinta un «0».
    expect(l.estantes[0]?.destinos.every((d) => d.contador === undefined)).toBe(true);
  });

  it('con solo uno > 0, el bloque se pinta con una fila y la otra vuelve a su estante', () => {
    const l = agruparLateral({ rol: 'sponsor', pendientesDelRol: 3, importacionPendientes: 0 });
    expect(l.teEspera.map((d) => d.to)).toEqual(['/aprobaciones']);
    expect(l.teEspera[0]?.contador?.titulo).toBe('3 pendientes de tu rol');
    expect(l.estantes[0]?.destinos[0]?.to).toBe('/importacion');
  });

  it('la bandeja solo cuenta para quien la cura: a un sponsor no se le promueve', () => {
    const sponsor = agruparLateral({
      rol: 'sponsor',
      pendientesDelRol: 0,
      importacionPendientes: 2,
    });
    expect(sponsor.teEspera).toEqual([]);
    expect(sponsor.estantes[0]?.destinos.find((d) => d.to === '/importacion')?.contador).toBe(
      undefined,
    );
    const curador = agruparLateral({
      rol: 'disenador',
      pendientesDelRol: 0,
      importacionPendientes: 2,
    });
    expect(curador.teEspera.map((d) => d.to)).toEqual(['/importacion']);
  });

  it('«Diseño y entrega» recuerda que la AI propone', () => {
    const l = agruparLateral({ rol: 'disenador', pendientesDelRol: 0, importacionPendientes: 0 });
    expect(l.estantes[1]?.etiqueta).toBe(ETIQUETA_DISENO);
    expect(l.estantes[1]?.destinos.map((d) => d.to)).toEqual([
      '/journeys',
      '/design-versions',
      '/propuestas',
      '/biblioteca',
    ]);
    expect(l.estantes[1]?.destinos.find((d) => d.to === '/propuestas')?.sufijo).toBe('propone');
  });

  it('el gobierno se filtra por rol igual que antes: auditoría solo para quien rinde cuentas', () => {
    const lead = agruparLateral({
      rol: 'lead-boutique',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(lead.gobierno.map((d) => d.to)).toEqual([
      '/personas',
      '/auditoria',
      // §14 pone la observabilidad de la capa AI en la misma fila que la auditoría
      // —«Auditoría y operación»—, así que va con su misma puerta de rol.
      '/observabilidad-ai',
      '/exportacion',
      '/disposicion',
    ]);
    expect(lead.gobierno.at(-1)?.etiqueta).toBe('Disposición del workspace');

    const sponsor = agruparLateral({
      rol: 'sponsor',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(sponsor.gobierno.map((d) => d.to)).toEqual([
      '/personas',
      '/exportacion',
      '/disposicion',
    ]);
    // La puerta de disposición no se condiciona al rol: cambia el rótulo, no la fila.
    expect(sponsor.gobierno.at(-1)?.etiqueta).toBe('Constancias que conservas');
  });

  it('ningún destino se pierde ni se repite al agrupar', () => {
    for (const rol of ['lead-boutique', 'disenador', 'admin-cliente', 'sponsor', 'observador']) {
      for (const [p, b] of [
        [0, 0],
        [1, 0],
        [0, 2],
        [1, 2],
      ] as const) {
        const rutas = todos(
          agruparLateral({ rol, pendientesDelRol: p, importacionPendientes: b }),
        ).map((d) => d.to);
        expect(new Set(rutas).size).toBe(rutas.length);
        /*
         * Quince destinos, menos los dos que el rol puede no ver. Se cuentan por su PRESENCIA
         * y no con un número por rol, que es lo que hace que este censo siga valiendo cuando
         * se añade un destino con puerta: la auditoría y el cuadro de operación de la capa AI
         * comparten la misma lista de roles a propósito (§14 los pone en la misma fila), así
         * que o entran los dos o no entra ninguno — y si algún día se separan, este recuento
         * lo dice en vez de dejarlo pasar.
         */
        const conPuerta: RutaDelWorkspace[] = ['/auditoria', '/observabilidad-ai'];
        const esperadas = 15 - conPuerta.filter((r) => !rutas.includes(r)).length;
        expect(rutas).toHaveLength(esperadas);
      }
    }
  });

  it('la nota de gobierno nombra solo lo que el rol ve', () => {
    const lead = agruparLateral({
      rol: 'lead-boutique',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(notaDeGobierno(lead.gobierno)).toBe(
      'Personas, auditoría, operación AI, exportación y disposición: se abren cuando se buscan, no cada día.',
    );
    const sponsor = agruparLateral({
      rol: 'sponsor',
      pendientesDelRol: 0,
      importacionPendientes: 0,
    });
    expect(notaDeGobierno(sponsor.gobierno)).toBe(
      'Personas, exportación y disposición: se abren cuando se buscan, no cada día.',
    );
  });

  it('la preferencia de gobierno se guarda por usuario y workspace, como la expansión', () => {
    expect(claveDeGobierno('u-1', 'ws-9')).toBe('designio.loop.gobierno.u-1.ws-9');
  });
});
