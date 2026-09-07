import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  criteriosCompletos,
  faltaEnCriterio,
  motivoParaNoDefinirCriterios,
  ROLES_DEFINEN_CRITERIOS,
  type CriterioDeReto,
} from '@/lib/metodo/metodo.schemas';

const completo: CriterioDeReto = {
  id: 'c1',
  kpi: 'Tiempo de primera respuesta',
  definicion: 'Mediana de minutos entre el ticket y la primera respuesta humana',
  lineaBaseValor: '42',
  lineaBaseFecha: '2026-01-15',
  lineaBasePlan: '',
  objetivo: 'bajar a 20',
  ventanaDias: 90,
  fechaPostMortem: null,
};

/**
 * QUÉ LE FALTA A UN CRITERIO PARA QUE G0 PUEDA APROBARSE (SYS-22).
 *
 * Este predicado vivía dentro de la pantalla del proyecto, privado y devolviendo solo sí o
 * no. Ahí ningún test lo alcanzaba —que es justo lo que el propio fichero advierte sobre
 * `faltaParaAprobarGate`— y, sobre todo, no sabía decir POR QUÉ: quien rellena el formulario
 * necesita el motivo, no un booleano.
 */
describe('lo que le falta a un criterio de éxito', () => {
  it('no le falta nada cuando está completo', () => {
    expect(faltaEnCriterio(completo)).toEqual([]);
    expect(criteriosCompletos([completo])).toBe(true);
  });

  it('nombra cada campo que falta, y los nombra TODOS de una vez', () => {
    const vacio: CriterioDeReto = {
      ...completo,
      kpi: '   ',
      definicion: '',
      objetivo: '',
      ventanaDias: null,
      lineaBaseValor: null,
      lineaBaseFecha: null,
      lineaBasePlan: '',
    };
    // Uno por uno obligaría a enviar cinco veces para descubrir los cinco.
    expect(faltaEnCriterio(vacio)).toHaveLength(5);
    expect(faltaEnCriterio(vacio).join(' ')).toContain('KPI');
    expect(faltaEnCriterio(vacio).join(' ')).toContain('línea base');
  });

  it('la línea base se acredita de dos formas y basta una', () => {
    const conPlan: CriterioDeReto = {
      ...completo,
      lineaBaseValor: null,
      lineaBaseFecha: null,
      lineaBasePlan: 'Se instrumenta el evento en la release de marzo',
    };
    expect(faltaEnCriterio(conPlan)).toEqual([]);
  });

  it('pero un valor SIN su fecha no es ninguna de las dos', () => {
    // El caso que importa: el valor solo parece una línea base y no lo es. Sin la fecha no
    // se puede decir contra qué instante se compara la mejora.
    const suelto: CriterioDeReto = { ...completo, lineaBaseFecha: null, lineaBasePlan: '' };
    expect(faltaEnCriterio(suelto)).toHaveLength(1);
    expect(criteriosCompletos([suelto])).toBe(false);
  });

  it('y un reto SIN criterios tampoco aprueba G0: cero no es «todos completos»', () => {
    // `every` sobre la lista vacía da true, que es la trampa: sin criterios no hay nada que
    // certificar y SYS-22 exige al menos uno.
    expect(criteriosCompletos([])).toBe(false);
  });

  it('basta con que UNO esté incompleto', () => {
    expect(criteriosCompletos([completo, { ...completo, id: 'c2', ventanaDias: null }])).toBe(false);
  });
});

/**
 * Y CUÁNDO SE PUEDE ESCRIBIR UN CRITERIO A MANO.
 *
 * Espeja las dos superficies que rechazan la escritura: la política —que admite al lead de
 * boutique y a quien diseña— y `reto_criterios_congelados`. Ofrecer el formulario sin mirar
 * las dos sería prometer un envío que la base ya negó.
 */
describe('quién define un criterio, y hasta cuándo', () => {
  it('los dos roles que la política admite pueden, con el reto abierto', () => {
    for (const rol of ROLES_DEFINEN_CRITERIOS) {
      expect(motivoParaNoDefinirCriterios({ rol, criteriosCongelados: false })).toBeNull();
    }
  });

  it('los demás roles no, y se les dice por qué', () => {
    for (const rol of ['sponsor', 'cliente', 'observador', '']) {
      const motivo = motivoParaNoDefinirCriterios({ rol, criteriosCongelados: false });
      expect(motivo, `${rol} no debería poder definir criterios`).not.toBeNull();
      expect(motivo).toContain('lead de boutique');
    }
  });

  it('y con el reto congelado no puede nadie, ni siquiera quien tiene el rol', () => {
    for (const rol of ROLES_DEFINEN_CRITERIOS) {
      const motivo = motivoParaNoDefinirCriterios({ rol, criteriosCongelados: true });
      expect(motivo).not.toBeNull();
      // El motivo nombra las DOS puertas que congelan, porque `reto_criterios_congelados`
      // es una disyunción: decir solo «G0 aprobado» mentiría con el registry firmado.
      expect(motivo).toContain('G0');
      expect(motivo).toContain('Metric Registry');
    }
  });

  it('el rol se compara contra la lista, no contra un prefijo', () => {
    // `'lead-boutique-invitado'` no es el rol de la política. Una comparación por `startsWith`
    // habría abierto la puerta a un rol que la base rechaza.
    expect(
      motivoParaNoDefinirCriterios({ rol: 'lead-boutique-invitado', criteriosCongelados: false }),
    ).not.toBeNull();
  });
});

/**
 * Y LA PUERTA TIENE QUE ESTAR EN LA PANTALLA, que es el hueco que abrió todo esto.
 *
 * `definirCriterio` y `editarCriterioDeReto` existían, se exportaban y escribían en
 * `criterio_exito` desde que se escribió la capa del método — y no los llamaba ningún
 * componente. Con la AI apagada no había forma de crear un criterio de éxito, y SYS-22 los
 * exige para G0: la capacidad C0 declaraba su paridad manual apuntando a una función que
 * nadie podía disparar.
 *
 * Una prueba que solo mirase el servicio no habría visto nada: los dos adaptadores están
 * enteros. Lo que faltaba es el LLAMADOR, así que eso es lo que se mide — sobre el `.tsx`,
 * que es la capa donde vive la mano del usuario.
 */
describe('la puerta manual de los criterios existe en la pantalla', () => {
  const raiz = process.cwd();

  /** Todos los `.tsx` del repositorio: componentes y rutas. */
  const pantallas = (dir: string): string[] => {
    const salida: string[] = [];
    for (const nombre of readdirSync(dir)) {
      const ruta = join(dir, nombre);
      if (statSync(ruta).isDirectory()) salida.push(...pantallas(ruta));
      else if (ruta.endsWith('.tsx')) salida.push(ruta);
    }
    return salida;
  };

  /**
   * A quién LLAMA un fichero, leído con el parser y no con una expresión regular.
   *
   * Buscar `definirCriterio(` en el texto cuenta también lo que aparece dentro de un
   * comentario o de una cadena. Una sonda que se conforma con la MENCIÓN puede quedarse
   * verde con el hueco reabierto, que es exactamente el modo de fallo contra el que existe
   * — y el mismo que el censo de #54 tuvo que corregir tres veces, ahí con el SQL.
   *
   * Medido: quitando la llamada real y dejando su nombre en un comentario, la lectura del
   * árbol se pone ROJA y la expresión regular se queda VERDE.
   */
  const llamadasDe = (fichero: string): Set<string> => {
    const arbol = ts.createSourceFile(
      fichero,
      readFileSync(fichero, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const nombres = new Set<string>();
    const ver = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        if (ts.isIdentifier(n.expression)) nombres.add(n.expression.text);
        else if (ts.isPropertyAccessExpression(n.expression)) nombres.add(n.expression.name.text);
      }
      ts.forEachChild(n, ver);
    };
    ver(arbol);
    return nombres;
  };

  it('algún componente llama a definirCriterio y a editarCriterioDeReto', () => {
    const dir = join(raiz, 'src');
    expect(existsSync(dir), `no está el árbol de fuentes en ${dir}`).toBe(true);
    const ficheros = pantallas(dir);
    expect(ficheros.length, 'no se encontró ninguna pantalla que mirar').toBeGreaterThan(10);

    const porFichero = new Map(ficheros.map((f) => [f, llamadasDe(f)]));
    for (const adaptador of ['definirCriterio', 'editarCriterioDeReto']) {
      // La LLAMADA, no la mención: importarlo y no usarlo deja el hueco igual, y era la forma
      // exacta que tenía el fallo.
      const llaman = ficheros.filter((f) => porFichero.get(f)!.has(adaptador));
      expect(
        llaman.map((f) => f.slice(raiz.length + 1)),
        `${adaptador} no lo llama ninguna pantalla: sin AI no hay forma de hacerlo a mano (SYS-21/SYS-22)`,
      ).not.toEqual([]);
    }
  });
});
