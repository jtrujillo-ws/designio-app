import { z } from 'zod';

/**
 * CTX-01 Disposición acordada — RF-01.9 (borrado o archivo posterior a la exportación, según
 * el acuerdo, con constancia verificable) y RF-09.4 (alcanza también a los objetos derivados).
 *
 * Este módulo NO importa nada de servidor a propósito: la carga canónica de la constancia se
 * construye igual en el navegador que en el proceso, que es lo que permite que la pantalla
 * enseñe exactamente el texto que hay que hashear.
 */

/** Qué se acordó hacer con el workspace. `archivo` es reversible registrando un acuerdo
 * nuevo; `borrado` no tiene vuelta, y por eso exige la firma de las dos partes. */
export const ModalidadDisposicionSchema = z.enum(['archivo', 'borrado']);
export type ModalidadDisposicion = z.infer<typeof ModalidadDisposicionSchema>;

/** Las dos partes que pueden acordar y ejecutar: la organización cliente (RF-01.4) y la
 * boutique que opera (RF-01.1). Un borrado exige que quien registra y quien ejecuta sean
 * partes DISTINTAS, y roles distintos implica personas distintas —una persona tiene
 * exactamente una membresía por workspace—. La base lo impone; esto solo lo nombra. */
export const ROLES_DISPOSICION = ['lead-boutique', 'admin-cliente'] as const;

export const RegistrarAcuerdoSchema = z.object({
  workspaceId: z.string().uuid(),
  modalidad: ModalidadDisposicionSchema,
  /**
   * La REFERENCIA al acuerdo —cláusula, número de contrato, acta— en las palabras de quien
   * lo registró. El tope corto no es cosmético: esta columna SOBREVIVE al borrado (es lo
   * único que nombra a las partes después, porque un contrato nombra a quien lo firma), así
   * que sin tope sería una puerta por la que colar texto libre que el borrado no alcanza.
   * El mismo límite que la base, para que el rechazo llegue antes y con palabras.
   */
  base: z.string().trim().min(1).max(300),
  /** La retención de RF-09.4: antes de esta fecha la disposición no se ejecuta. Es lo que
   * impide que un borrado irreversible sea un clic. */
  efectivoDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va en formato AAAA-MM-DD'),
});
export type RegistrarAcuerdo = z.infer<typeof RegistrarAcuerdoSchema>;

export const EjecutarDisposicionSchema = z.object({
  workspaceId: z.string().uuid(),
  /** La modalidad que la persona CREE estar ejecutando. No decide nada —manda el acuerdo
   * vigente— pero si no coincide se rechaza: un borrado irreversible no se dispara desde una
   * pantalla que mostraba otra cosa porque alguien registró un acuerdo nuevo entre medias. */
  modalidadEsperada: ModalidadDisposicionSchema,
});
export type EjecutarDisposicion = z.infer<typeof EjecutarDisposicionSchema>;

export type AcuerdoDisposicion = {
  id: string;
  version: number;
  modalidad: ModalidadDisposicion;
  base: string;
  acordadoRol: string;
  efectivoDesde: string;
  acordadoPor: string;
  acordadoEn: string;
};

/**
 * La constancia, tal como se le ENTREGA a quien la pide.
 *
 * Los dos instantes viajan como TEXTO y no como fecha, y es la decisión que hace verificable
 * el sello fuera de esta base: `timestamptz` tiene precisión de microsegundos y `Date` de
 * JavaScript solo de milisegundos, así que una constancia ejecutada en un microsegundo no
 * redondo daría otro hash al recomputarla desde una fecha. Se transporta lo que Postgres
 * imprime —`extract(epoch …)::text`, siempre con seis decimales— y no una interpretación.
 */
export type ConstanciaDisposicion = {
  id: string;
  workspaceId: string;
  modalidad: ModalidadDisposicion;
  acuerdoVersion: number;
  ejecutadoEpoch: string;
  ejecutadoPor: string;
  ejecutadoRol: string;
  exportadoEpoch: string;
  conteos: Record<string, number>;
  remediacion: Record<string, number>;
  remediacionItems: number;
  remediacionConConsentimiento: number;
  alcance: string;
  sello: string;
};

/** La versión del contrato de la carga. Viaja DENTRO del texto sellado: un sello solo
 * significa algo si dice bajo qué reglas se calculó. */
export const CONTRATO_CONSTANCIA = 'whitespace-constancia/1';

/**
 * Reproduce `jsonb::text` de Postgres, que es la forma en que los inventarios entran en la
 * carga sellada. Las reglas están MEDIDAS contra la base, no supuestas, porque cualquiera de
 * ellas cambia el hash:
 *
 *  · las claves se ordenan por su longitud EN BYTES y, a igual longitud, byte a byte. No es
 *    el orden alfabético de JavaScript: con `localeCompare` o `<` una clave acentuada cae en
 *    otro sitio, y una tabla con eñe bastaría para que la constancia no verificara;
 *  · hay un espacio tras los dos puntos y tras cada coma;
 *  · un objeto vacío es `{}`.
 *
 * Solo admite lo que la constancia guarda —objetos, enteros, cadenas, null y arrays de eso—
 * y lanza ante un decimal en vez de arriesgar un hash distinto: en `jsonb` un número conserva
 * la forma léxica con que se escribió (`1.50` sigue siendo `1.50`), y eso no se puede derivar
 * de un `number` de JavaScript. Los inventarios son conteos enteros, así que el caso no
 * aparece; si algún día aparece, esto se entera en vez de mentir.
 */
export function jsonbTexto(valor: unknown): string {
  if (valor === null) return 'null';
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  if (typeof valor === 'number') {
    if (!Number.isInteger(valor)) {
      throw new Error(
        'La carga de una constancia solo reproduce enteros: en jsonb un decimal conserva la forma con que se escribió y no se puede derivar de un number',
      );
    }
    return String(valor);
  }
  if (typeof valor === 'string') return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(jsonbTexto).join(', ')}]`;
  if (typeof valor === 'object') {
    const bytes = new TextEncoder();
    const claves = Object.keys(valor as Record<string, unknown>).sort((a, b) => {
      const ba = bytes.encode(a);
      const bb = bytes.encode(b);
      if (ba.length !== bb.length) return ba.length - bb.length;
      for (let i = 0; i < ba.length; i += 1) {
        if (ba[i] !== bb[i]) return ba[i]! - bb[i]!;
      }
      return 0;
    });
    const pares = claves.map(
      (k) => `${JSON.stringify(k)}: ${jsonbTexto((valor as Record<string, unknown>)[k])}`,
    );
    return `{${pares.join(', ')}}`;
  }
  throw new Error('La carga de una constancia no sabe representar ese valor');
}

/**
 * El texto exacto cuyo sha256 es el `sello`, en el mismo orden que la columna generada de
 * `20260903200000`. Es lo que se le enseña a quien quiera comprobarlo por su cuenta: con esto
 * y un `sha256sum` se verifica una constancia sin esta base delante, que es justamente para
 * lo que existe —tras un borrado ya no queda membresía con la que consultarla—.
 *
 * Si esta función y la expresión de la columna dejaran de coincidir, el sello dejaría de
 * verificar y la promesa se caería en silencio. Por eso hay un test que compara ESTE texto
 * con el sello que calculó Postgres sobre una constancia real, en las dos modalidades.
 */
export function cargaCanonicaConstancia(c: ConstanciaDisposicion): string {
  return [
    CONTRATO_CONSTANCIA,
    c.id,
    c.workspaceId,
    c.modalidad,
    String(c.acuerdoVersion),
    c.ejecutadoEpoch,
    c.ejecutadoPor,
    c.ejecutadoRol,
    c.exportadoEpoch,
    jsonbTexto(c.conteos),
    jsonbTexto(c.remediacion),
    String(c.remediacionItems),
    String(c.remediacionConConsentimiento),
    c.alcance,
  ].join('\n');
}

/** Lo que la pantalla necesita para decidir qué ofrecer, y para no ofrecer lo que la base va
 * a rechazar: el motivo lo da la MISMA función que usa el guard, así que no hay dos criterios
 * que puedan discrepar. `null` en `motivoNoEjecutable` significa que se puede ejecutar. */
export type PanelDisposicion = {
  workspaceId: string;
  acuerdoVigente: AcuerdoDisposicion | null;
  constanciaVigente: ConstanciaDisposicion | null;
  motivoNoEjecutable: string | null;
  /** El rol de quien mira, para explicarle su parte de la doble firma sin que la pantalla lo
   * deduzca por su cuenta. */
  rol: string | null;
  ultimaExportacion: string | null;
};
