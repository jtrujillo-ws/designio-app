import { describe, expect, it } from 'vitest';
import { laConstanciaSigueSiendoDeEsteAcuerdo } from '@/lib/disposicion/disposicion.schemas';

/**
 * Cuándo la pantalla de disposición tiene que soltar la constancia que enseña.
 *
 * El documento acredita el acuerdo que se ejecutó, así que pasar a OTRO acuerdo lo invalida
 * como recibo de lo que se está mirando. Lo que no lo invalida es que el acuerdo vigente
 * DESAPAREZCA — y eso es justo lo que ocurre tras un borrado: la ejecución destruye la
 * membresía, la recarga siguiente trae un panel vacío y la versión pasa de un número a nada.
 */
describe('la constancia en pantalla y el acuerdo al que pertenece', () => {
  it('se suelta al pasar de un acuerdo a otro, que es para lo que existe', () => {
    expect(laConstanciaSigueSiendoDeEsteAcuerdo(1, 2)).toBe(false);
    expect(laConstanciaSigueSiendoDeEsteAcuerdo(2, 1)).toBe(false);
  });

  it('NO se suelta cuando el acuerdo desaparece: es el recibo del borrado que acaba de correr', () => {
    // El caso que importa. Es la única copia en pantalla de una operación irreversible: la
    // lista plegada de `misConstancias` puede traerla, pero esa lectura es complementaria y su
    // error se ignora a propósito, así que no puede ser el único sitio donde vive.
    expect(laConstanciaSigueSiendoDeEsteAcuerdo(1, undefined)).toBe(true);
  });

  it('ni al aparecer el primero, ni cuando no se ha movido', () => {
    expect(laConstanciaSigueSiendoDeEsteAcuerdo(undefined, 1)).toBe(true);
    expect(laConstanciaSigueSiendoDeEsteAcuerdo(1, 1)).toBe(true);
    expect(laConstanciaSigueSiendoDeEsteAcuerdo(undefined, undefined)).toBe(true);
  });
});
