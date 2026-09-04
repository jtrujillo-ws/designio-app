import { describe, expect, it } from 'vitest';
import {
  elWorkspaceSeFueConLaEjecucion,
  laConstanciaSigueSiendoDeEsteAcuerdo,
} from '@/lib/disposicion/disposicion.schemas';

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

/**
 * Y de dónde viene el hueco cuando el panel no se puede leer.
 *
 * Tras un BORRADO la lectura falla por diseño: la ejecución destruye la membresía y RLS deja
 * de responder. El contexto de la ruta, en cambio, sigue trayendo el workspace de antes, así
 * que preguntar por `workspaceId` daba «sí» con el panel ya vacío y la pantalla enseñaba a la
 * vez el recibo, un error de acceso y un formulario para acordar sobre lo que se acaba de
 * borrar. Lo que distingue un caso del otro es QUÉ se acaba de ejecutar aquí.
 */
describe('el panel que ya no se puede leer', () => {
  it('tras un borrado no es un error: es lo que se acaba de pedir', () => {
    expect(elWorkspaceSeFueConLaEjecucion('borrado', false)).toBe(true);
  });

  it('un ARCHIVO no lo es: conserva la membresía y el panel vuelve', () => {
    // La mitad que hace que la otra sirva: sin ella bastaría con «se ejecutó algo» y un fallo
    // de lectura tras un archivo —que sí es un error— se pintaría como un adiós.
    expect(elWorkspaceSeFueConLaEjecucion('archivo', false)).toBe(false);
  });

  it('ni lo es un fallo de lectura cualquiera, sin ejecución de por medio', () => {
    expect(elWorkspaceSeFueConLaEjecucion(null, false)).toBe(false);
  });

  it('ni cuando el panel SÍ está, que es el borrado de otro workspace o una recarga que volvió', () => {
    expect(elWorkspaceSeFueConLaEjecucion('borrado', true)).toBe(false);
  });
});
