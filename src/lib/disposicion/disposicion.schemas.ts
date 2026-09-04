import { z } from 'zod';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';

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
  base: z
    .string()
    .trim()
    .min(1)
    /*
     * El tope se cuenta en PUNTOS DE CÓDIGO, que es lo que cuenta `length()` en Postgres, y
     * no con `.max(300)`: el `.length` de JavaScript cuenta unidades UTF-16, así que un
     * carácter astral —un emoji— vale dos. Medido: 151 emoji miden 151 para la base y 302
     * para `.max(300)`, de modo que el `CHECK` los aceptaba y el esquema los rechazaba. Las
     * dos capas declaraban «300 caracteres» y no era el mismo 300: por SQL crudo entraban
     * referencias contractuales que la ruta normal no podía registrar.
     *
     * Se elige el punto de código y no la unidad UTF-16 porque es lo que «300 caracteres»
     * significa para quien lo lee, y porque el tope existe para acotar el documento sellado:
     * 300 puntos de código son 1.200 bytes en el peor caso, que sigue acotado.
     *
     * El `maxLength={300}` del campo se queda como está y no es una tercera regla: el
     * navegador solo puede contar UTF-16, así que corta ANTES —150 emoji— y nunca deja
     * escribir algo que el esquema vaya a rechazar. Es más estricto, no distinto.
     */
    .refine((v) => [...v].length <= 300, {
      message: 'La referencia del acuerdo no puede pasar de 300 caracteres',
    })
    /*
     * Y en UNA sola línea. No es cosmética: esta referencia se COPIA dentro de la carga
     * canónica de la constancia, que es un campo por renglón, así que un salto de línea
     * dejaría el documento sellado ambiguo —los mismos bytes leídos como dos juegos de campos
     * distintos— y permitiría dibujar dentro del recibo una fecha efectiva u otro firmante
     * que nadie pactó.
     *
     * Incluye U+2028 y U+2029, que no son controles y por eso pasan el saneado de texto
     * importado: SON separadores de línea Unicode, así que un `<pre>` los pinta como un salto
     * y dibujan en pantalla lo que parecen campos de más mientras el sello sigue verificando
     * sobre los mismos bytes. La invariante rota por la VISTA es igual de grave en un
     * documento que una persona lee.
     *
     * La base lo impone con un CHECK; esto solo hace que el rechazo llegue antes y con
     * palabras, que es lo mismo que hace el tope de 300.
     */
    .refine((v) => !/[\n\r\u2028\u2029]/.test(v), {
      message:
        'La referencia del acuerdo va en una sola línea: viaja dentro del documento sellado, que lleva un campo por renglón',
    }),
  /**
   * La retención de RF-09.4: antes de esta fecha la disposición no se ejecuta. Es lo que
   * impide que un borrado irreversible sea un clic.
   *
   * `FechaCalendarioSchema` y no una expresión regular de forma: `2026-02-31` tiene la forma
   * correcta y no existe, así que pasaba el esquema y reventaba después en el `::date` con un
   * 22008 que nadie traduce — un 500 en vez de un mensaje. El repositorio ya tenía el
   * validador que mira el calendario de verdad.
   */
  efectivoDesde: FechaCalendarioSchema,
});
export type RegistrarAcuerdo = z.infer<typeof RegistrarAcuerdoSchema>;

export const EjecutarDisposicionSchema = z.object({
  workspaceId: z.string().uuid(),
  /** La modalidad que la persona CREE estar ejecutando. */
  modalidadEsperada: ModalidadDisposicionSchema,
  /**
   * Y la VERSIÓN del acuerdo que tenía delante. La modalidad sola no basta: si la pantalla
   * muestra el borrado v1 y la otra parte registra y exporta un v2 que también es borrado, la
   * modalidad sigue coincidiendo y se destruiría el workspace conforme a una base contractual
   * y una retención que quien ejecuta nunca vio. Lo que hay que confirmar es el acuerdo, no su
   * etiqueta.
   */
  acuerdoVersionEsperada: z.number().int().min(1),
  /**
   * La palabra que hay que teclear para un borrado. Viaja al SERVIDOR, y no se queda en el
   * `disabled` del botón, porque el `disabled` no es una comprobación: es una sugerencia que
   * el navegador puede no seguir. Cualquier llamada al transporte —una pestaña vieja, un
   * cliente mal cableado, un script— ejecutaba el borrado sin que nadie hubiera escrito nada.
   *
   * Lo que defiende es el ERROR HUMANO, no a un adversario: quien escribe SQL crudo teclea
   * «BORRAR» sin despeinarse, así que meterlo en la función de la base sería ceremonia sin
   * defensa. Por eso vive en la frontera donde está la persona —la petición— y no más abajo.
   */
  confirmacion: z.string().default(''),
});
/** Lo que hay que teclear para ejecutar un borrado. Vive en el esquema —no en la pantalla—
 * porque lo comprueban los dos lados y una constante en dos sitios es una constante que
 * puede discrepar. */
export const CONFIRMACION_BORRADO = 'BORRAR';
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
  /**
   * El acuerdo que se ejecutó, ENTERO y no solo su número. Un `acuerdoVersion = 2` no
   * significa nada fuera de esta base, y fuera de esta base es donde vive una constancia:
   * tras un borrado no queda membresía, así que lo único que le queda a cada parte es el
   * documento sellado que conserva. Con la versión sola acreditaba QUE hubo disposición y no
   * CUÁL, ni bajo qué base contractual, ni desde cuándo, ni quién puso la PRIMERA firma —que
   * en un borrado es la mitad de la garantía, porque quien registra y quien ejecuta tienen
   * que ser partes distintas—.
   *
   * La fecha viaja como texto ISO por lo mismo que los dos instantes: lo que entra en un
   * sello tiene que ser bytes fijos, y el renderizado de una fecha depende de `DateStyle`.
   */
  acuerdoVersion: number;
  acuerdoBase: string;
  acuerdoEfectivoDesde: string;
  acuerdoPor: string;
  acuerdoRol: string;
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
/**
 * ¿La pantalla tiene que soltar la constancia que está enseñando? Sí cuando se pasa de UN
 * acuerdo a OTRO: el documento acredita el acuerdo que se ejecutó, y dejarlo junto a uno
 * distinto es enseñar un recibo de otra cosa.
 *
 * Y NO cuando el acuerdo vigente simplemente DESAPARECE, que es lo que pasa justo después de
 * un borrado: la ejecución destruye la membresía, la recarga siguiente devuelve un panel vacío
 * y la versión pasa de un número a nada. Soltar ahí borraba de la pantalla el recibo recién
 * emitido de la operación IRREVERSIBLE, que es el único momento en que perderlo importa de
 * verdad. Reaparece en la lista plegada de constancias, pero esa lectura es complementaria y
 * su error se ignora a propósito: no puede ser el único sitio donde vive el documento.
 *
 * Vive aquí y no dentro del componente para poder comprobarla: la suite corre en `node` y no
 * monta React.
 */
export function laConstanciaSigueSiendoDeEsteAcuerdo(
  antes: number | undefined,
  ahora: number | undefined,
): boolean {
  return antes === undefined || ahora === undefined || antes === ahora;
}

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
 * Solo admite lo que la constancia guarda —objetos, enteros, cadenas, booleanos, null y
 * arrays de eso—
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
 *
 * La carga es UN CAMPO POR RENGLÓN, y eso solo es inequívoco si ningún campo lleva saltos de
 * línea. Los que vienen de la base los tiene prohibidos por CHECK —`acuerdo_base` y
 * `alcance`, los dos únicos de texto libre—; los inventarios pasan por `jsonbTexto`, que
 * escapa igual que `JSON.stringify`; y el resto son uuids, enteros, enums y epochs. Sin esa
 * invariante, una referencia contractual con un salto de línea dibujaría dentro del recibo
 * campos que nadie pactó.
 */
export function cargaCanonicaConstancia(c: ConstanciaDisposicion): string {
  return [
    CONTRATO_CONSTANCIA,
    c.id,
    c.workspaceId,
    c.modalidad,
    String(c.acuerdoVersion),
    c.acuerdoBase,
    c.acuerdoEfectivoDesde,
    c.acuerdoPor,
    c.acuerdoRol,
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
