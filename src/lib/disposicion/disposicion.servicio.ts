import '@/lib/server-only';
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import {
  cargaCanonicaConstancia,
  type AcuerdoDisposicion,
  type ConstanciaDisposicion,
  type EjecutarDisposicion,
  type ModalidadDisposicion,
  type PanelDisposicion,
  type RegistrarAcuerdo,
} from './disposicion.schemas';

/**
 * Disposición acordada del workspace (RF-01.9 + RF-09.4).
 *
 * Casi todo el mecanismo vive en la base —`20260903200000`— y no aquí, y es deliberado: el
 * conjunto de tablas que el borrado alcanza se DERIVA del catálogo de Postgres en vez de
 * escribirse a mano, el vaciado corre con los triggers de dominio apagados y recuenta al
 * final, y el motivo por el que una disposición no se puede ejecutar lo da UNA función que
 * invocan los dos lados. Esta capa no reimplementa nada de eso: lo invoca y traduce.
 *
 * Que el predicado sea uno solo es lo que evita el defecto que más caro sale en una pantalla
 * así — ofrecer un botón que destruye un workspace y que la base va a rechazar, o peor,
 * esconder una disposición que sí correspondía.
 */

export class ErrorDisposicion extends Error {}

/** El mismo candado consultivo que toma `ejecutar_disposicion`, tomado ANTES de leer. Sin
 * esto, entre comprobar la modalidad esperada y ejecutar cabría un acuerdo nuevo: la
 * comprobación pasaría sobre el acuerdo viejo y la base ejecutaría el nuevo, que es
 * exactamente la confusión que esa comprobación existe para impedir. */
async function bloquearWorkspace(tx: TransactionSql, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:workspace:' || ${workspaceId}::text, 42))`;
}

function acuerdoDeFila(f: Record<string, unknown>): AcuerdoDisposicion {
  return {
    id: f.id as string,
    version: Number(f.version),
    modalidad: f.modalidad as ModalidadDisposicion,
    base: f.base as string,
    acordadoRol: f.acordado_rol as string,
    efectivoDesde: f.efectivo_desde as string,
    acordadoPor: f.acordado_por as string,
    acordadoEn: (f.acordado_en as Date).toISOString(),
  };
}

/** Las columnas de la constancia con los DOS instantes como texto. Es lo que hace verificable
 * el sello fuera de esta base: `Date` de JavaScript redondea a milisegundos y `timestamptz`
 * guarda microsegundos, así que reconstruir el epoch desde una fecha daría otro hash. Se
 * transporta lo que Postgres imprime. */
const COLUMNAS_CONSTANCIA = `id::text, workspace_id::text, modalidad, acuerdo_version,
  acuerdo_base, acuerdo_efectivo_desde, acuerdo_por::text, acuerdo_rol,
  extract(epoch from timezone('UTC', ejecutado_en))::text as ejecutado_epoch,
  ejecutado_por::text, ejecutado_rol,
  extract(epoch from timezone('UTC', exportado_en))::text as exportado_epoch,
  conteos, remediacion, remediacion_items, remediacion_con_consentimiento, alcance, sello`;

function constanciaDeFila(f: Record<string, unknown>): ConstanciaDisposicion {
  return {
    id: f.id as string,
    workspaceId: f.workspace_id as string,
    modalidad: f.modalidad as ModalidadDisposicion,
    acuerdoVersion: Number(f.acuerdo_version),
    acuerdoBase: f.acuerdo_base as string,
    // Ya es texto en la base: `acuerdo_efectivo_desde` se guarda formateado para que lo que
    // entra en el sello sean bytes fijos. Aquí no se reformatea nada, que es el punto.
    acuerdoEfectivoDesde: f.acuerdo_efectivo_desde as string,
    acuerdoPor: f.acuerdo_por as string,
    acuerdoRol: f.acuerdo_rol as string,
    ejecutadoEpoch: f.ejecutado_epoch as string,
    ejecutadoPor: f.ejecutado_por as string,
    ejecutadoRol: f.ejecutado_rol as string,
    exportadoEpoch: f.exportado_epoch as string,
    conteos: (f.conteos ?? {}) as Record<string, number>,
    remediacion: (f.remediacion ?? {}) as Record<string, number>,
    remediacionItems: Number(f.remediacion_items),
    remediacionConConsentimiento: Number(f.remediacion_con_consentimiento),
    alcance: f.alcance as string,
    sello: f.sello as string,
  };
}

/** Recomputa el sello sobre la carga canónica. No sirve para «detectar una fila falsa» —quien
 * puede insertar filas puede insertar una coherente— sino para comprobar que ESTA capa y la
 * columna generada siguen calculando lo mismo: si divergieran, la constancia que se entrega
 * dejaría de verificar en manos del cliente y nadie se enteraría aquí. */
export function selloRecomputado(c: ConstanciaDisposicion): string {
  return createHash('sha256').update(cargaCanonicaConstancia(c), 'utf8').digest('hex');
}

/**
 * Las constancias que esta persona conserva, en TODOS los workspaces, sea o no miembro.
 *
 * Existe porque sin ella la política que las conserva sería una promesa que nadie puede
 * ejercer — el mismo defecto que aquella política vino a arreglar, una capa más arriba. Tras
 * un borrado no queda membresía, y el resto de la aplicación resuelve el workspace activo a
 * partir de las membresías: por ahí no se llega nunca a una constancia de un workspace
 * borrado, ni siquiera con su id en la URL. Quien firmó no recibe la respuesta inmediata —la
 * recibe quien ejecuta— y quien ejecutó la pierde en cuanto recarga.
 *
 * No lleva `workspaceId`: es la lista de lo que te pertenece, y filtrarla es trabajo de la RLS
 * —membresía, haber ejecutado, o haber firmado el acuerdo que se ejecutó—. Pedir un workspace
 * concreto sería volver a exigir saber a cuál pertenece, que es justo lo que ya no se sabe.
 */
export async function misConstancias(actorId: string): Promise<ConstanciaDisposicion[]> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Sin el nombre del workspace, y no por descuido: tras un borrado la RLS de `workspace` le
    // niega la fila a quien ya no es miembro, así que vendría VACÍO justo en el caso para el
    // que esta lista existe. Y aunque se viera, sería la lápida —constante para todos— que no
    // identifica nada. Lo que identifica una constancia es su `workspaceId` y su sello.
    const filas = await tx.unsafe(
      `select ${COLUMNAS_CONSTANCIA} from constancia_disposicion order by ejecutado_en desc`,
      [],
    );
    return filas.map(constanciaDeFila);
  });
}

export async function panelDisposicion(
  actorId: string,
  workspaceId: string,
): Promise<PanelDisposicion> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);

    const [ac] = await tx`select id, version, modalidad, base, acordado_rol,
        to_char(efectivo_desde, 'YYYY-MM-DD') as efectivo_desde, acordado_por, acordado_en
      from acuerdo_disposicion where workspace_id = ${workspaceId}
      order by version desc limit 1`;

    const [co] = await tx.unsafe(
      `select ${COLUMNAS_CONSTANCIA} from constancia_disposicion
       where workspace_id = $1 order by acuerdo_version desc limit 1`,
      [workspaceId],
    );

    // El motivo lo da la función de la base, no un espejo escrito aquí. Un espejo se queda
    // corto en cuanto alguien toca aquella, y quedarse corto significa ofrecer un botón que
    // destruye un workspace.
    const [estado] = await tx`select
        disposicion_motivo_no_ejecutable(${workspaceId}) as motivo,
        workspace_role(app_user_id(), ${workspaceId}) as rol,
        (select max(r.completado_en) from exportacion_registro r
          where r.workspace_id = ${workspaceId} and r.ambito = 'archivo'
            and r.completado_en is not null) as exportado`;

    return {
      workspaceId,
      acuerdoVigente: ac ? acuerdoDeFila(ac) : null,
      constanciaVigente: co ? constanciaDeFila(co) : null,
      motivoNoEjecutable: (estado?.motivo ?? null) as string | null,
      rol: (estado?.rol ?? null) as string | null,
      ultimaExportacion: estado?.exportado ? (estado.exportado as Date).toISOString() : null,
    };
  });
}

/**
 * Registra un acuerdo NUEVO. Nunca un UPDATE: la bitácora es append-only y cambiar de opinión
 * es una fila más, que es lo que hace que cuente la historia entera.
 *
 * `version`, `acordado_rol` y `acordado_en` no viajan en el insert y no es un olvido: están
 * fuera del grant y los pone el guard. Con ellos dentro, un acuerdo podría nacer con versión
 * alta —convirtiéndose en «vigente» sin serlo— o fechado hacia atrás.
 */
export async function registrarAcuerdo(
  actorId: string,
  entrada: RegistrarAcuerdo,
): Promise<AcuerdoDisposicion> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // El candado que serializa esto NO se toma aquí: lo toma el guard del registro, que es el
    // camino por el que pasa TODO insert. Tomarlo también aquí sería escribir la misma regla
    // dos veces, y la de aquí es la que se puede rodear — el grant permite insertar por SQL
    // directo sin pasar por esta función.
    try {
      const [fila] = await tx`insert into acuerdo_disposicion
          (workspace_id, modalidad, base, efectivo_desde, acordado_por)
        values (${entrada.workspaceId}, ${entrada.modalidad}, ${entrada.base},
                ${entrada.efectivoDesde}::date, ${actorId})
        returning id, version, modalidad, base, acordado_rol,
          to_char(efectivo_desde, 'YYYY-MM-DD') as efectivo_desde, acordado_por, acordado_en`;
      return acuerdoDeFila(fila!);
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === '42501') {
        throw new ErrorDisposicion(
          'Solo el admin del cliente o el lead de la boutique registran el acuerdo de disposición',
        );
      }
      if (err.code === '23514') {
        throw new ErrorDisposicion(
          'La referencia del acuerdo no puede ir vacía, pasar de 300 caracteres ni llevar caracteres de control o de cambio de dirección de texto',
        );
      }
      throw e;
    }
  });
}

/**
 * Ejecuta la disposición vigente y devuelve la constancia.
 *
 * La constancia se DEVUELVE, y ése es su camino principal: tras un borrado se destruyen los
 * `miembro`, así que `is_workspace_member` es falso y RLS le niega al cliente hasta la lápida.
 * Lo único que le queda es este documento y su `sello`, que puede recomputar fuera de estas
 * paredes. Por eso viaja entero y con los instantes en el formato que hace verificable el
 * hash, en vez de una vista resumida.
 */
export async function ejecutarDisposicion(
  actorId: string,
  entrada: EjecutarDisposicion,
): Promise<ConstanciaDisposicion> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Candado ANTES de mirar. `ejecutar_disposicion` toma el mismo, y tomarlo aquí hace que
    // la modalidad que se comprueba sea la que se va a ejecutar y no una foto anterior.
    await bloquearWorkspace(tx, entrada.workspaceId);

    const [ac] = await tx`select modalidad, version from acuerdo_disposicion
      where workspace_id = ${entrada.workspaceId} order by version desc limit 1`;
    if (!ac) {
      throw new ErrorDisposicion(
        'No hay acuerdo de disposición registrado: el acuerdo se registra antes de ejecutarlo, y es él quien dice si corresponde archivo o borrado (RF-01.9)',
      );
    }
    // La pantalla mostró UN acuerdo concreto; si el vigente ya no es ése, no se ejecuta. Se
    // compara la VERSIÓN y no solo la modalidad: con dos borrados seguidos la etiqueta
    // coincide y se destruiría el workspace conforme a una base contractual y una retención
    // que quien ejecuta nunca vio.
    const version = Number(ac.version);
    if (ac.modalidad !== entrada.modalidadEsperada || version !== entrada.acuerdoVersionEsperada) {
      throw new ErrorDisposicion(
        `El acuerdo vigente pasó a ser el #${version} («${ac.modalidad}») mientras mirabas la pantalla, y tú confirmaste el #${entrada.acuerdoVersionEsperada} («${entrada.modalidadEsperada}»). No se ejecuta lo que no viste: vuelve a mirarlo y confírmalo.`,
      );
    }

    let constanciaId: string;
    try {
      const [r] = await tx`select ejecutar_disposicion(${entrada.workspaceId}) as c`;
      constanciaId = (r!.c as { id: string }).id;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // DS002 es el motivo del predicado único, ya redactado para que lo lea una persona;
      // DS003 es la dependencia de runtime (el dueño de las funciones tiene que ser
      // superusuario para apagar los triggers durante el vaciado).
      if ((err.code === 'DS002' || err.code === 'DS003') && err.message) {
        throw new ErrorDisposicion(err.message);
      }
      if (err.code === '42501') {
        throw new ErrorDisposicion('El workspace no existe o no eres miembro');
      }
      throw e;
    }

    const [fila] = await tx.unsafe(
      `select ${COLUMNAS_CONSTANCIA} from constancia_disposicion where id = $1`,
      [constanciaId],
    );
    const constancia = constanciaDeFila(fila!);

    // La constancia se entrega para que se verifique FUERA, así que antes de entregarla se
    // comprueba que esta capa y la columna generada siguen calculando el mismo hash. Si
    // divergieran, el cliente se llevaría un documento que no verifica y aquí no se sabría.
    //
    // Y lanzar aquí ABORTA la disposición entera —el vaciado, la constancia y su evento van en
    // esta misma transacción—, que es la respuesta correcta y no un efecto colateral: lo que
    // RF-01.9 promete no es destruir, es destruir DEJANDO CONSTANCIA VERIFICABLE. Sin la
    // segunda mitad no se hace la primera, porque un workspace destruido no se puede
    // reconstruir para volver a intentarlo y un recibo que no verifica no acredita nada.
    if (selloRecomputado(constancia) !== constancia.sello) {
      throw new ErrorDisposicion(
        'La constancia emitida no verifica contra su carga canónica, así que la disposición se ha DESHECHO entera: no se ha borrado ni archivado nada. No se destruye lo que no se puede acreditar. Es un fallo del sistema, no del acuerdo: avísalo antes de volver a intentarlo.',
      );
    }
    return constancia;
  });
}
