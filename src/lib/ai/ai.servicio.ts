import '@/lib/server-only';
import { createHash } from 'node:crypto';
import type { PendingQuery, Row, TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { patronDeBusqueda } from '@/lib/busqueda/busqueda.schemas';
import { DimensionesEvidenciaSchema, ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import { bloquearReto } from '@/lib/metodo/metodo.servicio';
import {
  evaluarCapacidadAI,
  INTENTOS_POR_GENERACION,
  LIMITE_LLAMADAS_DIA,
} from './ai.degradacion';
import { validarJourney } from '@/lib/journey/journey.mermaid';
import type { JourneyCompleto } from '@/lib/journey/journey.schemas';
import { leerJourneyCompleto, leerJourneysCompletos } from '@/lib/journey/journey.servicio';
import {
  presenciaLiteralPorCita,
  materialDeGate,
  evidenciaQueLlegoAlModelo,
  materialDeInsights,
  promptInsights,
  SISTEMA_INSIGHTS,
  type EvidenciaDelReto,
  materialDeItem,
  materialDeReto,
  MAX_MATERIAL,
  PROMPT_VERSION,
  promptAsistenteGate,
  promptCriterios,
  promptExtraccion,
  materialDeJourney,
  nucleoDeRemediacion,
  promptRemediacionJourney,
  SISTEMA_ASISTENTE_GATES,
  SISTEMA_CRITERIOS,
  SISTEMA_EXTRACCION,
  SISTEMA_REMEDIACION_JOURNEY,
  type ChecklistDelGate,
  materialDeUnaEvidencia,
  criteriosQueLlegaronAlModelo,
  materialDeRegistry,
  materialDeUnCriterio,
  promptRegistry,
  SISTEMA_REGISTRY,
  type CriteriosDelReto,
  type GrafoDelJourney,
} from './ai.prompts';
import {
  CONFIANZA_PROPUESTA_NUMERICA,
  MAX_ENTRADAS_KPI_POR_LOTE,
  MAX_INSIGHTS_POR_LOTE,
  CAPACIDADES,
  CAPACIDADES_ACTIVAS,
  COLUMNAS_DE_ANCLA,
  MAX_REMEDIACIONES,
  COLUMNA_DE_DESTINO,
  type AnclaCapacidad,
  type CandidatoAncla,
  type Destino,
  type CapacidadActiva,
  type ContenidoCriterio,
  type ContenidoEntradaKpi,
  type ContenidoExtraccion,
  type ContenidoInsight,
  type ContenidoRemediacionJourney,
  type ContenidoPropuesta,
  type EstadoAncla,
  type GenerarPropuestas,
  type OrigenKey,
  type PanelPropuestas,
  type PropuestaEnPanel,
  type RegistrarConsentimiento,
  type RevisarPropuesta,
} from './ai.schemas';
import {
  CITAS_DEL_CONTENIDO,
  ESQUEMA_DE_CONTENIDO,
  parsearContenido,
  TESTIMONIO_ADICIONAL,
  type CitaDelContenido,
} from './ai.contenido';
import {
  credencialesAI,
  generarConProveedor,
  type ApunteDespacho,
  type IntentoProveedor,
} from './proveedor.server';

/**
 * Pipeline único PropuestaAI (SPEC-08, ADR-0012/I4). La AI **propone**; el objeto real
 * del dominio nace solo cuando un humano acepta, en la MISMA transacción y firmado por
 * él (SYS-19). Capa 1: RLS —atribución en la política, transición exigida por WITH CHECK,
 * decidida = inmutable, materialización verificada por constraint diferido—. Capa 2: este
 * módulo (estado de la cuenta, rol curador, presupuesto, validación del contenido).
 *
 * Degradación segura (SYS-21): ninguna función de aquí lanza por culpa del proveedor. Sin
 * credencial, con el presupuesto agotado o con el proveedor caído, generar devuelve un
 * error de dominio con su motivo y **todo lo demás sigue en pie** — listar y revisar
 * propuestas ya existentes funciona con la AI apagada, y la curaduría manual de la
 * bandeja y la definición manual de criterios nunca dependieron de ella.
 */

export class ErrorAI extends Error {}

/**
 * Lo que el modelo DIJO no cumple el contrato de su capacidad.
 *
 * Se distingue del resto de `ErrorAI` por lo que hay que anotar en el libro. `resultado`
 * describe LO QUE DEVOLVIÓ EL PROVEEDOR, así que solo esto se reetiqueta como
 * `fuera-de-contrato`: un informe que se salta una señal o repite otra es culpa suya.
 *
 * Lo que NO es esto: que el mundo se moviera entre preparar y escribir —el journey borrado, el
 * grafo editado por otro curador—. Ahí el proveedor devolvió lo que se le pidió y la respuesta
 * se descarta por algo que pasó fuera; anotarlo como fuera de contrato corrompería la medida
 * de calidad del proveedor y emitiría `LlamadaAISinPropuesta` culpando al modelo de algo que
 * hizo bien.
 */
export class ErrorContratoAI extends ErrorAI {}

const PAGINA_PENDIENTES = 100;
const DECIDIDAS_RECIENTES = 50;
/** Cuántas anclas se ofrecen a la vez en el formulario de generación. El corte es
 * inevitable (un `select` no es una superficie de paginación); lo que no puede pasar es que
 * deje algo permanentemente inalcanzable, y de eso se encarga el orden FIFO más el aviso. */
const PAGINA_ANCLAS = 50;
/** Cuántos criterios se le piden a C0 de una vez: revisión por elemento, lote pequeño. */
const CRITERIOS_POR_GENERACION = 3;

/** Cuántas LLAMADAS al proveedor puede llegar a hacer una generación: la del modelo
 * primario y, si cae por indisponibilidad, la del respaldo. Es lo que se aparta del
 * presupuesto antes de llamar, porque el tope cuenta llamadas atendidas y no propuestas —
 * el techo de propuestas de cada capacidad ya no dice nada sobre lo que se paga. */

/** Capa 2: re-check explícito del rol curador (la política RLS es la capa 1). Los mismos
 * que curan la bandeja (RF-03.4) piden y revisan propuestas; `agente-ai` no aparece por
 * ningún lado — no es un actor que cure ni apruebe (SYS-18). */
async function rolCurador(tx: TransactionSql, actorId: string, workspaceId: string): Promise<void> {
  const [fila] = await tx`select workspace_role(${actorId}, ${workspaceId}) as rol`;
  const rol = (fila?.rol ?? null) as string | null;
  if (!rol || !(ROLES_CURADORES as readonly string[]).includes(rol)) {
    throw new ErrorAI('Solo lead-boutique o diseñador pueden pedir y revisar propuestas AI');
  }
}

/**
 * Presupuesto AI del workspace (RF-08.5): llamadas al proveedor ATENDIDAS hoy. Es un corte
 * SUAVE, con el día del servidor, y se cuenta sobre `llamada_ai` —el mismo libro que suma
 * el reporte de costos— porque el tope acota lo que se PAGA, no lo que se produce.
 *
 * Contando propuestas persistidas, el gasto que no producía objeto era invisible para el
 * tope: una negativa del proveedor o una salida fuera de contrato se facturan, liberan la
 * reserva y no dejan propuesta, así que un material que el modelo rechaza siempre se podía
 * reintentar sin fin. El número que frena y el número que informa tienen que ser el mismo.
 *
 * `sin-respuesta` NO cuenta: ahí no hubo respuesta y no sabemos si el proveedor llegó a
 * cobrar — «no se sabe» no es «se pagó», la misma distinción que hace `costo_usd = null`.
 * Y cobrar por una caída convertiría un incidente del proveedor en un workspace sin
 * capacidad AI por el resto del día, justo lo contrario de la degradación segura (SYS-21).
 *
 * `reservadas` son las generaciones EN CURSO (huecos apartados antes de llamar): cuentan
 * para admitir una nueva, porque si no, N curadores simultáneos leen todos el mismo «quedan
 * sitios» y todos llaman. Mientras una generación anota sus llamadas y aún no ha soltado su
 * reserva se cuenta dos veces; el error es conservador —nunca deja pasar de más— y dura lo
 * que tarda en terminar.
 */
async function presupuestoDeHoy(
  tx: TransactionSql,
  workspaceId: string,
): Promise<{
  atendidas: number;
  reservadas: number;
  limiteDiario: number;
  ultimaCaidaHaceMs: number | null;
}> {
  // El cupo viaja en la MISMA consulta que el gasto, y no en una aparte, porque los dos
  // números deciden juntos: leerlos en dos sentencias es leerlos en dos snapshots, y en el
  // hueco cabe un cupo que cambia entre el «cuánto llevas» y el «cuánto puedes».
  //
  // Los tres son SUBCONSULTAS ESCALARES, no un join, y la diferencia es la que importa bajo
  // RLS: un join contra `workspace` no devolvería fila ninguna cuando el workspace no se ve
  // —y este código leería esa ausencia como «0 atendidas», es decir, como presupuesto entero
  // disponible—. Así, en cambio, el gasto se sigue contando y el cupo invisible llega como
  // null, que cae al respaldo. Una lectura ciega no se convierte en una autorización.
  const [fila] = await tx`select
      (select count(*) from llamada_ai
        where workspace_id = ${workspaceId} and creado_en >= inicio_del_dia_de_la_base()
          and resultado <> 'sin-respuesta'
          -- Una línea EN VUELO no se cuenta dos veces. Con el libro anticipado la fila nace
          -- antes de llamar, así que durante la llamada coexiste con la reserva que ya apartó
          -- su hueco: sumar las dos cobraba el doble por la misma generación durante hasta dos
          -- timeouts, y con un cupo pequeño eso echaba fuera al siguiente curador.
          --
          -- La exclusión mira si sigue viva LA RESERVA QUE PAGÓ ESTA LLAMADA, por su id. Ni el
          -- tiempo transcurrido ni el ancla sirven, y las dos formas de equivocarse dejan el
          -- mismo agujero por caminos distintos:
          --
          --  · por TIEMPO: cuando el cierre falla, la limpieza retira la reserva en el acto,
          --    pero la fila seguía sin contar el resto de la ventana. En ese hueco no contaba
          --    ni la reserva ni la llamada pagada.
          --  · por ANCLA: retirada la reserva, la línea huérfana cuenta — hasta que el
          --    reintento crea una reserva NUEVA sobre la misma ancla y vuelve a esconderla.
          --    Esa reserva presupuesta la generación nueva, no la vieja, así que con fallos
          --    repetidos se acumulaban líneas huérfanas invisibles bajo una sola reserva.
          --
          -- Las dos dejaban reintentar por encima del cupo, que es justo el fallo posterior al
          -- despacho que este cambio existe para contener. Por identidad no hay ambigüedad: en
          -- cuanto la reserva desaparece —por limpieza, por revocación o por caducidad— su
          -- línea cuenta, y ninguna otra reserva la cubre. Es la dirección segura para una
          -- llamada cuyo cierre se perdió, porque ante la duda de si el proveedor cobró se
          -- asume que sí; una fila sin reserva anotada cuenta por lo mismo.
          and (resultado <> 'despachada' or not exists (
            select 1 from reserva_ai r
            where r.id = llamada_ai.reserva_id
              and r.workspace_id = llamada_ai.workspace_id
              and r.creado_en > now() - reserva_ai_ventana()
          )))::int as atendidas,
      (select coalesce(sum(unidades), 0) from reserva_ai
        where workspace_id = ${workspaceId} and creado_en > now() - reserva_ai_ventana())::int
        as reservadas,
      (select w.limite_llamadas_ai_dia from workspace w where w.id = ${workspaceId})::int
        as limite_pactado,
      -- La salud del proveedor NO se cachea en el proceso: se lee del libro que la propia
      -- base escribe. La tabla llamada_ai ya anota cada intento con su resultado, su
      -- workspace y su reloj, así que el aislamiento por inquilino y la caducidad vienen
      -- dados y no hay interruptor que se pueda quedar pegado en caido.
      --
      -- Se mira la OBSERVACION mas reciente, no "hubo alguna caida": una llamada buena
      -- posterior tiene que borrar la caida al instante, porque la ultima observacion es la
      -- unica que habla del presente.
      --
      -- Y "mas reciente" se mide por cerrado_en, no por creado_en. Con el libro
      -- anticipado la fila nace al DESPACHAR, asi que creado_en dejo de ser el momento en
      -- que se supo el desenlace: entre dos llamadas concurrentes, la que salio primero puede
      -- ser la ultima en volver, y ordenar por el despacho elegiria la equivocada. Ademas la
      -- antiguedad de una caida salia inflada por todo el timeout, y la ventana de salud
      -- caducaba antes de tiempo.
      --
      -- Las lineas todavia EN VUELO (despachada) se excluyen: no son una observacion, son
      -- una pregunta sin responder. Contarlas como la mas reciente borraba un aviso de caida
      -- de verdad en cuanto alguien pedia otra generacion, que es justo cuando el aviso hace
      -- falta.
      --
      -- El desempate sigue siendo el PUESTO del intento y luego el id: clock_timestamp()
      -- separa a los hermanos de una misma transaccion, pero el puesto es lo que da el orden
      -- verdadero si dos sellos empataran, y el id lo deja total para las filas anteriores a
      -- la columna.
      --
      -- Solo sin-respuesta: un rechazo del proveedor o una salida fuera de contrato son
      -- llamadas ATENDIDAS, el tercero contesto y de hecho cobro. Contarlas como caida
      -- pintaria el proveedor de rojo por un material que el modelo se niega a procesar,
      -- que es un problema del material y no de la disponibilidad.
      (select case when u.resultado = 'sin-respuesta'
                then (extract(epoch from (now() - coalesce(u.cerrado_en, u.creado_en)))
                       * 1000)::bigint end
         from llamada_ai u
        where u.workspace_id = ${workspaceId} and u.resultado <> 'despachada'
        order by coalesce(u.cerrado_en, u.creado_en) desc, u.intento desc, u.id desc
        limit 1) as caida_hace_ms`;
  // El cupo pactado del workspace manda; la constante del código es el RESPALDO para
  // «no hay cupo pactado» (NULL) y para cualquier valor que no sea un entero positivo, no
  // el valor por defecto de todos. `evaluarCapacidadAI` vuelve a filtrarlo —es función pura
  // y no puede fiarse de su llamante—, así que pasar el nulo tal cual también sería
  // correcto; se resuelve aquí para que el número que se decide y el que se muestra en el
  // panel sean el mismo, leído una sola vez.
  const pactado = (fila?.limite_pactado ?? null) as number | null;
  // `bigint` llega como texto por el driver: se normaliza aquí, y lo que no sea un número
  // finito viaja como `null` —«no se sabe»— en vez de como un cero, que la ventana leería
  // como una caída ocurrida hace un instante.
  const caidaCruda = fila?.caida_hace_ms ?? null;
  const caida = caidaCruda === null ? null : Number(caidaCruda);
  return {
    atendidas: (fila?.atendidas ?? 0) as number,
    reservadas: (fila?.reservadas ?? 0) as number,
    limiteDiario:
      Number.isInteger(pactado) && (pactado as number) > 0
        ? (pactado as number)
        : LIMITE_LLAMADAS_DIA,
    ultimaCaidaHaceMs: caida !== null && Number.isFinite(caida) ? caida : null,
  };
}

/**
 * Estado de la capacidad para la BANDERA del panel. Dos números con dos propósitos, y
 * fusionarlos sería el error:
 *
 *  · la DECISIÓN («¿puedo pedir una propuesta ahora?») se toma con lo que costaría la
 *    próxima generación —hasta `INTENTOS_POR_GENERACION` llamadas— y contando las reservas
 *    en vuelo, porque si no la pantalla anuncia «AI disponible» con 59/60, la persona pulsa
 *    y se lleva un rechazo del servicio. Prometer lo que la admisión va a negar es el mismo
 *    desajuste, una capa más arriba, que el del contador que frena y el que informa;
 *  · el NÚMERO que se muestra sigue siendo lo realmente atendido hoy, que es lo que suma el
 *    reporte de costos. Las reservas no son gasto: son gasto probable de otros en curso.
 */
async function estadoCapacidad(tx: TransactionSql, workspaceId: string) {
  const { keyWorkspace, keyEntorno } = credencialesAI();
  const { atendidas, reservadas, limiteDiario, ultimaCaidaHaceMs } = await presupuestoDeHoy(
    tx,
    workspaceId,
  );
  // Los dos números viajan SEPARADOS y ya no se re-escribe el resultado: antes se pasaba la
  // suma y luego se pisaba `llamadasHoy` con las atendidas, así que el motivo hablaba del
  // total y la tarjeta del gasto —y con reservas en vuelo la tarjeta decía «59/60» encima de
  // un motivo que decía «61/60»—. Una sola verdad, construida en un solo sitio.
  return evaluarCapacidadAI({
    keyWorkspace,
    keyEntorno,
    llamadasHoy: atendidas,
    reservadas,
    limiteDiario,
    unidades: INTENTOS_POR_GENERACION,
    ultimaCaidaHaceMs,
  });
}

/**
 * ORDEN DE ADQUISICIÓN DE CANDADOS DE ESTE SLICE, en un solo sitio y para todas sus rutas:
 *
 *     designio:consentimiento:<item>  →  designio:presupuesto-ai:<workspace>
 *     designio:reto:<reto>            (ver `bloquearReto`, que documenta reto → gate)
 *
 * Las dos primeras coexisten en dos rutas y las dos las toman en ese orden: `prepararAlcance`
 * (consentimiento del ancla, luego el hueco de presupuesto) y `registrarConsentimiento` (el
 * item, y el presupuesto solo cuando la revocación retira una reserva). Con una sola regla no
 * hay ciclo posible.
 *
 * El candado de RETO no se cruza con los otros dos, y conviene decir por qué en vez de
 * ordenarlo por si acaso: lo toma la materialización de C0, que crea un criterio, y el de
 * consentimiento lo toma la de CI, que crea evidencia. Las dos ramas son excluyentes —las
 * elige el `destino` de la propuesta—, así que ninguna transacción de este módulo llega a
 * tener los dos en la mano. Si algún día una ruta necesitara ambos, su sitio en la cadena es
 * el primero (reto → consentimiento → presupuesto), porque `bloquearReto` ya encabeza su
 * propia cadena hacia el gate y así las dos reglas siguen siendo una.
 *
 * Y el contrato que comparten los tres, que es lo que los hace necesarios: una consulta es un
 * predicado sobre un snapshot, no un candado. Comprobar algo que otro camino muta, sin
 * compartir candado con ese camino, no cierra la ventana — la estrecha.
 */

/** Candado del presupuesto AI de un workspace. Apartar el hueco y consumirlo ocurren en
 * transacciones DISTINTAS (la llamada al proveedor va entre medias, fuera de toda
 * transacción), así que los dos lados lo toman. Orden: ver el bloque de arriba. */
async function bloquearPresupuesto(tx: TransactionSql, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:presupuesto-ai:' || ${workspaceId}, 42))`;
}


/**
 * El grafo tal como lo ve el modelo, con sus señales YA calculadas.
 *
 * Una definición y tres usos: la arma `PREPARAR.C5` para el prompt, la vuelve a armar el
 * panel para medir la presencia literal de las citas, y de ella salen las señales contra las
 * que el servicio comprueba las remediaciones que devuelve el modelo. Si esos tres tuvieran
 * cada uno su copia, bastaría una diferencia de orden para que la medición del grounding
 * marcara como ausentes citas que están, o para que una remediación legítima se rechazara
 * por señalar una señal que la otra copia no emitió.
 *
 * Las señales las pone `validarJourney`, que es DETERMINISTA (RF-05.6). No se le pide al
 * modelo que las encuentre: se le dan hechas y se le pide qué hacer con ellas.
 */
/**
 * Si el grafo que el panel puede leer HOY es el que el modelo tuvo delante, según la huella
 * que la propuesta guardó al nacer.
 *
 * `null` cuando no se puede saber —una propuesta anterior a la columna—, y no se resuelve a
 * ninguno de los dos lados aquí: quien lo lee decide qué hacer con no saber, y las dos
 * respuestas son distintas. Para el ESTADO de la fila, no saber no puede volverse «cambiado»:
 * sería inventarse una alarma. Para la presencia literal, no saber se resuelve como vigente,
 * que es exactamente lo que hacían todas las capacidades cuando ninguna guardaba huella.
 */
/*
 * Los dos techos de C5, redactados UNA vez y leídos por los dos lados: el selector, que marca
 * el journey como no generable, y la admisión, que lo rechaza si alguien lo fuerza igual.
 *
 * Escribirlos dos veces era la manera de que divergieran, y esconder el journey en vez de
 * marcarlo dejaba el mensaje —lo único que dice QUÉ hacer— sin ningún camino del producto que
 * llegara a él.
 */
function motivoDemasiadasSenales(cuantas: number): string {
  return `Ese journey tiene ${cuantas} señales abiertas y un informe puede llevar ${MAX_REMEDIACIONES}: cierra las más claras a mano y vuelve a pedirlo. (La validación las lista todas, y es exacta.)`;
}

function motivoConectividadQueNoCabe(caracteres: number): string {
  return `Las señales de ese journey y su grafo de transiciones ocupan ${caracteres} caracteres y al modelo le caben ${MAX_MATERIAL}: tendría que responder sin ver la conectividad que se le pide remediar. Cierra a mano las señales de los tramos más cargados, o parte el journey, y vuelve a pedirlo.`;
}

/**
 * Si el material que el panel puede recomponer HOY es el que el modelo tuvo delante, según la
 * huella que la propuesta guardó al nacer.
 *
 * `null` cuando NO SE PUEDE SABER, y no se resuelve a ninguno de los dos lados aquí: quien lo
 * lee decide qué hacer con no saber, y las dos respuestas son OPUESTAS, cada una por lo que
 * está en juego.
 *
 * Para el ESTADO de la fila, no saber no puede volverse «cambiado»: ese estado NOMBRA UNA
 * CAUSA —«el grafo de ese journey cambió»— y afirmarla sin saberlo es inventarse una alarma
 * que además culpa a quien no fue.
 *
 * Para la PRESENCIA LITERAL es al revés, y entenderlo costó una ronda. Aquí no se nombra
 * ninguna causa: se contesta «¿puedo medir esto?», y la respuesta honesta a no saber es que
 * no. Estaba resuelto como vigente apelando a que era lo que hacían todas las capacidades
 * antes de que ninguna guardara huella, y el precedente no es un argumento: el día de un
 * despliegue que cambie el renderizador del material, resolverlo como vigente pinta verdes y
 * rojos calculados contra un texto que el modelo no vio, que es justo lo que toda esta
 * maquinaria existe para no hacer. La pantalla ya sabe decir «no se puede comprobar».
 *
 * Y no cuesta nada donde antes valía: el CHECK exige la huella a las capacidades que la leen,
 * así que «sin huella» ya no es alcanzable para ellas y el único `null` que queda es el de la
 * versión — que es exactamente el caso en que no se puede medir.
 *
 * Y son DOS los casos en que no se sabe. El primero es no tener huella: una propuesta anterior
 * a la columna. El segundo es tenerla de OTRO RENDER: desde que la huella se calcula sobre el
 * material —el texto ya recortado, no el grafo crudo—, un cambio del prompt la mueve sin que
 * el grafo se haya tocado, y `prompt_version` es justo el dato que dice si son comparables.
 * Sin esta segunda mitad, el día de un despliegue toda propuesta viva de C5 se habría marcado
 * «journey cambiado» a la vez, culpando al grafo de un cambio del renderizador.
 */
function materialDelPanelEsElDelModelo(f: Record<string, unknown>): boolean | null {
  const guardada = f.huella_material as string | null;
  if (!guardada) return null;
  if ((f.prompt_version as string | null) !== PROMPT_VERSION) return null;
  /*
   * Contra el material de SU capacidad, no contra el de una escrita aquí. Esto nació mirando
   * el journey de C5 porque C5 era la única que guardaba huella; C2 guarda la suya desde que
   * la revalidación previa al despacho la necesitó, y con la comparación escrita para C5 su
   * huella se habría contrastado contra un grafo inexistente —`journeyDesdeElPanel` sobre una
   * fila de C2 devuelve un journey vacío— y toda propuesta de C2 se habría leído como material
   * cambiado. Es la misma trampa que las anclas y los destinos: la parte que varía indexada
   * por lo que varía.
   *
   * `material(f)` es exactamente el texto que se hasheó al preparar la llamada, porque las dos
   * mitades salen de la misma función por capacidad. Una capacidad que guarde huella y no
   * declare `material` no existe: `material` es obligatorio en el registro.
   */
  const definicion = CAPACIDAD_EN_EL_PANEL[f.capacidad as CapacidadActiva];
  if (!definicion) return null;
  return huellaDelMaterial(definicion.material(f)) === guardada;
}

function grafoParaElModelo(journey: JourneyCompleto): GrafoDelJourney {
  const fase = new Map(
    journey.nodos.filter((n) => n.tipo === 'fase').map((n) => [n.id, n.etiqueta]),
  );
  return {
    nodos: journey.nodos.map((n) => ({
      id: n.id,
      tipo: n.tipo,
      etiqueta: n.etiqueta,
      fase: n.faseId ? (fase.get(n.faseId) ?? '') : '',
      // El id de la fase, además del rótulo: dos fases pueden llamarse igual, y entonces ni el
      // modelo puede decir a cuál mover un nodo ni la huella distingue un traslado entre ellas.
      faseId: n.faseId ?? '',
      responsable: n.responsable ?? '',
      evidencias: n.evidencias.length,
    })),
    aristas: journey.aristas.map((a) => ({
      origen: a.origenId,
      destino: a.destinoId,
      tipo: a.tipo,
      condicion: a.condicion ?? '',
    })),
    senales: validarJourney(journey).map((x) => ({
      codigo: x.codigo,
      severidad: x.severidad,
      nodoId: x.nodoId,
      mensaje: x.mensaje,
    })),
  };
}

/**
 * Lo que el panel sabe de una columna de ancla: de dónde sale la fila y cómo se titula.
 *
 * Esto va POR COLUMNA porque es lo único que de verdad depende de ella: el join es a la
 * tabla del ancla y el título es de esa fila, con capacidad o sin ella. Todo lo demás —qué
 * bloquea la propuesta, qué material leyó el modelo, qué anclas se ofrecen— NO depende de la
 * columna sino de la CAPACIDAD, y está abajo.
 *
 * La distinción la trajo una revisión y corrige un arreglo mío anterior: había puesto aquí
 * también el motivo y el material, y eso hacía el registro exhaustivo por COLUMNA. Dos
 * capacidades pueden anclar en el mismo sitio —C2 y C3 cuelgan del reto igual que C0— y no
 * comparten ni sus puertas ni su material: C0 se congela con el G0 (SYS-22) y cita la
 * formulación del reto; una capacidad posterior puede generarse después del G0 y citar la
 * evidencia codificada. Indexado por columna, la capacidad nueva heredaba las reglas de C0
 * sin que nada lo pidiera, y sin que faltara ninguna entrada que el compilador echara de
 * menos. La costura tiene que exigir lo que varía DONDE varía.
 */
type AnclaEnElPanel = {
  /** De dónde sale la fila del ancla. */
  join: (tx: TransactionSql) => PendingQuery<Row[]>;
  /** Cómo se titula en el panel. */
  titulo: (tx: TransactionSql) => PendingQuery<Row[]>;
  /**
   * Las columnas de esa fila que el panel proyecta. Es el repertorio COMPLETO de esa tabla,
   * no el de una capacidad: varias pueden anclar aquí y componer su material con partes
   * distintas, así que se proyecta una vez y cada una toma lo suyo.
   */
  columnas: (tx: TransactionSql) => PendingQuery<Row[]>;
};

const ANCLA_EN_EL_PANEL: Record<AnclaCapacidad['columna'], AnclaEnElPanel> = {
  item_id: {
    join: (tx) => tx`left join item_importacion i
      on i.id = p.item_id and i.workspace_id = p.workspace_id`,
    titulo: (tx) => tx`i.titulo`,
    columnas: (tx) => tx`i.titulo as item_titulo, i.tipo_fuente as item_tipo_fuente,
      i.referencia as item_referencia, i.estado as item_estado,
      left(coalesce(i.contenido, ''), ${MAX_MATERIAL}) as item_contenido`,
  },
  reto_id: {
    join: (tx) => tx`left join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id`,
    titulo: (tx) => tx`r.codigo || ' ' || r.titulo`,
    /*
     * El repertorio COMPLETO del ancla, no el de una capacidad: C0 compone su material con la
     * formulación y C2 con la formulación MÁS la evidencia. La evidencia llega al reto por sus
     * ARQUETIPOS, que es el único camino que este esquema tiene —`evidencia` no cuelga de un
     * reto— y por eso la consulta va por ahí y no por el workspace.
     */
    columnas: (tx) => tx`r.codigo as reto_codigo, r.titulo as reto_titulo,
      r.descripcion as reto_descripcion, r.metrica_objetivo as reto_metrica,
      case when p.capacidad = 'C2' then
        (select coalesce(json_agg(json_build_object(
                  'id', x.id, 'titulo', x.titulo, 'resumen', x.resumen)
                  order by x.titulo, x.id), '[]'::json)
         from (
           -- DISTINCT, y el mismo orden que arma el prompt. La misma evidencia puede colgar de
           -- DOS arquetipos del mismo reto —la clave de arquetipo_evidencia es
           -- (arquetipo_id, evidencia_id), así que nada lo impide y es lo normal cuando dos
           -- arquetipos comparten una entrevista—, y el join la devolvía repetida: el documento
           -- salía dos veces en el material, el recuento del alcance mentía, y el presupuesto de
           -- caracteres se gastaba en copias hasta truncar evidencia que sí era única.
           select distinct e.id, e.titulo, e.resumen
           from arquetipo a
           join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
           join evidencia e on e.id = ae.evidencia_id and e.workspace_id = ae.workspace_id
           where a.reto_id = r.id and a.workspace_id = r.workspace_id
             and evidencia_usable(e.id, e.workspace_id, 'cliente')) x)
      else '[]'::json end as reto_evidencia,
      -- Y los NOMBRES, que son otra pregunta y no admiten el mismo filtro.
      --
      -- Las etiquetas salían de la lista de arriba, que es la del MATERIAL y por eso está
      -- filtrada por «evidencia_usable(…, 'cliente')». Para las citas cuadra de casualidad;
      -- para las CONTRADICCIONES no, y ahí decía algo falso: «evidencia_citable_guard» cuelga
      -- de «cita» y no de «contradiccion» —a propósito, porque una cita REPRODUCE un fragmento
      -- para el cliente y una contradicción solo señala que ese documento va en contra—, así
      -- que a una evidencia contradicha se le pueden retirar los derechos de cita y la
      -- contradicción se sigue pudiendo materializar. Medido: la propuesta seguía
      -- «disponible», aceptar FUNCIONABA, y la pantalla decía «ya no está» del documento que
      -- quien revisa tenía delante y estaba a punto de sellar.
      --
      -- Identidad y permiso de cita son cosas distintas, así que se preguntan por separado. El
      -- alcance sigue siendo el mismo —la evidencia de ESTE reto por sus arquetipos, dentro del
      -- workspace y bajo las mismas políticas—: lo único que se cae es el filtro de derechos,
      -- que aquí no pinta nada.
      case when p.capacidad = 'C2' then
        (select coalesce(json_agg(json_build_object('id', y.id, 'titulo', y.titulo)
                  order by y.titulo, y.id), '[]'::json)
         from (
           select distinct e.id, e.titulo
           from arquetipo a
           join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
           join evidencia e on e.id = ae.evidencia_id and e.workspace_id = ae.workspace_id
           where a.reto_id = r.id and a.workspace_id = r.workspace_id) y)
      else '[]'::json end as reto_evidencia_nombres`,
  },
  registry_id: {
    // DOS joins, como el gate: el registry y su RETO. El reto no es adorno — el material de
    // C6 son sus criterios, y el título del panel sale de él porque un uuid de registry no le
    // dice nada a quien revisa.
    join: (tx) => tx`left join metric_registry mr
        on mr.id = p.registry_id and mr.workspace_id = p.workspace_id
      left join reto rr on rr.id = mr.reto_id and rr.workspace_id = mr.workspace_id`,
    titulo: (tx) => tx`rr.codigo || ' ' || rr.titulo`,
    columnas: (tx) => tx`mr.estado as registry_estado,
      rr.codigo as registry_reto_codigo, rr.titulo as registry_reto_titulo,
      rr.descripcion as registry_reto_descripcion, rr.estado as registry_reto_estado,
      (select coalesce(json_agg(json_build_object(
                'id', c.id, 'kpi', c.kpi, 'definicion', c.definicion,
                'objetivo', c.objetivo, 'ventanaDias', c.ventana_dias,
                'lineaBasePlan', c.linea_base_plan)
                order by c.kpi, c.id), '[]'::json)
       from criterio_exito c
       where c.reto_id = rr.id and c.workspace_id = rr.workspace_id) as registry_criterios`,
  },
  gate_id: {
    // DOS joins: el gate y su proyecto. El proyecto no es adorno — es lo que distingue
    // «G3» de «el G3 de cuál», y un workspace tiene varios proyectos a la vez.
    join: (tx) => tx`left join gate_instancia g
        on g.id = p.gate_id and g.workspace_id = p.workspace_id
      left join proyecto pr on pr.id = g.proyecto_id and pr.workspace_id = g.workspace_id`,
    titulo: (tx) => tx`pr.codigo || ' · G' || g.numero`,
    /*
     * El checklist ENTERO, agregado a json en la misma proyección. No es una comodidad: el
     * material contra el que se mide la presencia literal de las citas tiene que ser el
     * MISMO texto que leyó el modelo, y ese texto son los requisitos. Traerlos con otra
     * consulta abriría la puerta a que las dos listas difirieran —en orden, en filtro, en el
     * momento— y la medición del grounding empezaría a marcar como ausentes citas que están.
     *
     * `order by c.orden` dentro del agregado, y no fuera: es el mismo orden con el que se
     * armó el prompt, y si el checklist no cupo entero, lo que se truncó fue la cola.
     */
    columnas: (tx) => tx`g.numero as gate_numero, g.rol_aprobador as gate_rol,
      g.estado as gate_estado, pr.titulo as gate_proyecto,
      case when p.gate_id is null then '[]'::json else
        (select coalesce(json_agg(json_build_object(
                  'id', c.id, 'texto', c.texto, 'estado', c.estado,
                  'conObjeto', num_nonnulls(c.evidencia_id, c.insight_id, c.decision_id) = 1)
                order by c.orden), '[]'::json)
         from checklist_item c
         where c.gate_id = g.id and c.workspace_id = g.workspace_id)
      end as gate_checklist`,
  },
  journey_id: {
    join: (tx) => tx`left join journey jr
        on jr.id = p.journey_id and jr.workspace_id = p.workspace_id
      left join servicio sjr on sjr.id = jr.servicio_id and sjr.workspace_id = jr.workspace_id`,
    titulo: (tx) => tx`jr.nombre`,
    /*
     * El GRAFO entero, con la forma que `JourneyCompleto` declara. Pesa, y no hay otra: las
     * señales de la validación no son una tabla —son una función pura del grafo— así que el
     * único modo de recomponer el material que el modelo leyó es traer los nodos y las
     * aristas y volver a evaluar la misma función. Traer un resumen dejaría la medición de la
     * presencia literal midiendo otro texto.
     */
    columnas: (tx) => tx`jr.nombre as journey_nombre, jr.tipo as journey_tipo,
      sjr.nombre as journey_servicio,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', n.id, 'tipo', n.tipo, 'etiqueta', n.etiqueta, 'faseId', n.fase_id,
          'orden', n.orden, 'responsable', n.responsable,
          'arquetipoEstado', (select a.estado from arquetipo a
            where a.id = n.arquetipo_id and a.workspace_id = n.workspace_id),
          'evidencias', coalesce((
            select jsonb_agg(jsonb_build_object('id', e.id) order by e.id)
            from journey_nodo_evidencia ne
            join evidencia e on e.id = ne.evidencia_id and e.workspace_id = ne.workspace_id
            where ne.nodo_id = n.id and ne.workspace_id = n.workspace_id), '[]'::jsonb))
          -- El MISMO orden total que leerJourneyCompleto, y eso es el requisito entero: las
          -- dos proyecciones alimentan huellaDelGrafo, así que si ordenan distinto la huella
          -- guardada al generar y la recalculada al pintar difieren sobre un grafo idéntico —y
          -- el panel declararía obsoleto un informe que está al día.
          order by n.tipo, n.orden, n.id)
        from journey_nodo n
        where n.journey_id = jr.id and n.workspace_id = jr.workspace_id), '[]'::jsonb)
        as journey_nodos,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', a.id, 'origenId', a.origen_id, 'destinoId', a.destino_id,
          'tipo', a.tipo, 'condicion', a.condicion) order by a.creado_en, a.id)
        from journey_arista a
        where a.journey_id = jr.id and a.workspace_id = jr.workspace_id), '[]'::jsonb)
        as journey_aristas`,
  },
};

/**
 * Un `JourneyCompleto` mínimo desde las columnas que proyectó el panel: lo justo que
 * `validarJourney` y `grafoParaElModelo` leen, que está comprobado y son los nodos y las
 * aristas. Los campos que ninguno de los dos mira se rellenan con lo neutro en vez de
 * proyectarse: traerlos costaría y no cambiaría ni una señal.
 */
function journeyDesdeElPanel(f: Record<string, unknown>): JourneyCompleto {
  return {
    id: '',
    servicioId: '',
    servicioNombre: (f.journey_servicio as string | null) ?? '',
    retoId: null,
    proyectoId: null,
    tipo: (f.journey_tipo as JourneyCompleto['tipo'] | null) ?? 'as-is',
    nombre: (f.journey_nombre as string | null) ?? '',
    descripcion: '',
    nodos: (f.journey_nodos as JourneyCompleto['nodos'] | null) ?? [],
    aristas: (f.journey_aristas as JourneyCompleto['aristas'] | null) ?? [],
    snapshots: [],
    arquetipos: [],
  };
}

/**
 * Y lo que el panel sabe de una CAPACIDAD: qué la deja obsoleta, contra qué material se mide
 * el grounding de sus citas, y qué anclas se le ofrecen a la generación.
 *
 * Las tres varían con la capacidad y no con la columna donde cuelga, y las tres tienen su
 * modo de fallar en silencio si se indexan mal: el motivo manda al revisor a un trámite que
 * no desbloquea nada, el material equivocado marca como ausentes citas que están, y la lista
 * de candidatas esconde el ancla de una generación perfectamente válida.
 */
/**
 * Y las dos van JUNTAS, impuesto por el tipo: quien recorta el pajar por documento tiene que
 * poder decir si ese recorte sigue siendo el del modelo.
 *
 * `pajarDeLaCita` estrecha el pajar a UN documento, y ese documento sale de las filas de HOY.
 * Sin huella no hay forma de saber que las de hoy son las que el modelo leyó, así que el
 * recorte se calcularía sobre un conjunto que puede haberse movido —y el verde de una cita es
 * lo único contrastable que tiene quien revisa—. Declararlo en el tipo y no en una prueba es
 * lo que hace que la capacidad que venga no pueda declarar solo la mitad.
 */
type CapacidadEnElPanel = BaseDelPanel &
  ({ pajarDeLaCita?: undefined } | Required<Pick<BaseDelPanel, 'pajarDeLaCita' | 'materialVigente'>>);

type BaseDelPanel = {
  /**
   * Qué deja la propuesta obsoleta, DADO que su capacidad es esta. Sin `case … end`: el CASE
   * exterior lo cierra con `else null`, que es lo que dice «este panel no sabe juzgar esto».
   */
  estado: (tx: TransactionSql) => PendingQuery<Row[]>;
  /**
   * Y el estado que el SQL NO puede calcular, sobre la fila ya proyectada.
   *
   * Existe por C5: lo que deja obsoleto un informe de remediación es que sus señales dejen de
   * estar abiertas, y las señales son una función pura de los nodos y las aristas, no una
   * tabla. Con solo el CASE, la única respuesta honesta para C5 era «disponible» siempre — o
   * sea, la pantalla no avisaba nunca de que un informe había dejado de describir el grafo,
   * mientras CT sí avisa de su equivalente. Que la comprobación exista al ESCRIBIR no cubre
   * esto: entre escribir y revisar cabe la edición, y es justo cuando conviene avisar.
   *
   * Devuelve `null` para dejar el veredicto del CASE, que es lo que hacen las tres que sí se
   * pueden juzgar en SQL. Se evalúa sobre `f`, la misma fila que ya trae el grafo entero: no
   * abre ninguna consulta nueva.
   */
  estadoDeLaFila?: (f: Record<string, unknown>) => EstadoAncla | null;
  /**
   * Cómo se llaman, en cristiano, los ids que el contenido nombra.
   *
   * El modelo copia ids del material —es lo único verificable, por eso se le piden así— y la
   * pantalla los recibe tal cual. Un uuid no le dice nada a quien revisa: en C5 varias
   * remediaciones pueden traer el MISMO código de señal sobre nodos distintos (media docena de
   * `paso-sin-evidencia` es lo normal), y sin el nombre del nodo las tarjetas son
   * indistinguibles — `comoCerrarlo` no está obligado a repetirlo.
   * pantalla los recibe tal cual. Un uuid no le dice nada a quien revisa, y las dos
   * capacidades que nombran ids lo necesitan por motivos distintos: en C2 una cita declara de
   * qué evidencia sale, y sin el nombre del documento la señal de grounding queda a medias —se
   * ve el verde, no contra qué—; en C5 varias remediaciones pueden traer el MISMO código sobre
   * nodos distintos, y sin el nombre del nodo las tarjetas son indistinguibles.
   *
   * Sale de la MISMA fila que ya trae el material proyectado: no abre ninguna consulta nueva.
   */
  etiquetasDelContenido?: (f: Record<string, unknown>) => Record<string, string>;
  /**
   * El material que el modelo leyó, recompuesto desde las columnas que proyectó su ancla. Se
   * compone IGUAL que al construir el prompt —ficha incluida y con el delimitador
   * neutralizado—: la presencia literal se mide contra lo que el modelo leyó, no contra el
   * texto crudo de la base. Una sola definición, dos usos.
   */
  material: (f: Record<string, unknown>) => string;
  /**
   * Y contra QUÉ TROZO de ese material se mide una cita concreta, para las capacidades cuyo
   * material son varios documentos.
   *
   * CI, C0 y CT citan contra uno solo —el item, el reto, el checklist—, así que «aparece en
   * el material» es la pregunta entera y no declaran esto. C2 cita contra la evidencia de un
   * reto, que son varios, y cada cita nombra el suyo: midiendo contra todos juntos, una cita
   * que dice «esto está en la evidencia B» sale PRESENTE porque su texto está en la A. Y no
   * es un verde cualquiera: la presencia literal es la única señal contrastable que tiene
   * quien revisa, así que un verde prestado le dice que confíe en una cita que le manda a
   * otro documento.
   *
   * Devuelve `null` cuando la cita nombra algo que no está en el material — que es distinto
   * de «no aparece» y se resuelve igual (ausente), porque una cita a un documento que el
   * modelo no vio no está sostenida por nada.
   */
  pajarDeLaCita?: (f: Record<string, unknown>, cita: CitaDelContenido) => string | null;
  /**
   * Si el material que `material` recompone es TODAVÍA el que vio el modelo.
   *
   * El panel lo rearma a partir del estado de HOY, y contra ese texto se mide la presencia
   * literal de las citas. Mientras nada cambie es el mismo texto; después de una edición
   * ajena no lo es, y entonces el veredicto no es ni «aparece» ni «no aparece» — un fragmento
   * que la edición acaba de añadir saldría en verde y una cita legítima que la edición borró
   * saldría en rojo.
   *
   * Solo lo puede contestar quien GUARDÓ algo con qué comparar, y por eso es opcional: sin
   * entrada se asume vigente, que es lo que hoy hacen todas —es la respuesta que ya daban en
   * silencio— y lo que la capacidad que guarde una huella puede mejorar. C5 la guarda.
   */
  materialVigente?: (f: Record<string, unknown>) => boolean;
  /**
   * Las anclas que se le pueden ofrecer a esta capacidad, con su propia elegibilidad, y SI
   * DEJÓ ALGO FUERA.
   *
   * Lo segundo lo devuelve la cola y no lo deduce quien llama, que es lo que hacía: pedía una
   * fila de más y miraba si venía. Eso vale mientras el corte lo haga el `limit` del SQL, y
   * deja de valer en cuanto la cola filtra por algo que el SQL no sabe —C5 filtra por «tiene
   * señales abiertas», que es una función pura del grafo—: ahí una lista corta puede
   * significar «no hay más» o «no he llegado a mirar», y la primera es una respuesta que no se
   * puede dar sin haber mirado. La cola es la única que sabe cuál de las dos es.
   */
  candidatas: (
    tx: TransactionSql,
    workspaceId: string,
    patron: string | null,
    limite: number,
  ) => Promise<{ lista: CandidatoAncla[]; hayMas: boolean }>;
};

/**
 * Cómo se barre la cola de C5, que no se puede resolver entera en SQL: «tiene señales
 * abiertas» es una función pura del grafo, así que el SQL trae candidatos baratos y el bucle
 * descarta los que vienen limpios.
 *
 * `LOTE` es cuántos se piden por vuelta y `TOPE` cuántos se llegan a mirar como mucho. El tope
 * existe para que un workspace enorme no convierta cada pintado del selector en una lectura de
 * todos sus grafos; y cuando se alcanza, la cola lo DICE en vez de devolver «no hay», que es
 * la única respuesta que no se puede dar sin haber mirado.
 */
const LOTE_DE_BARRIDO_C5 = 60;
const TOPE_DE_BARRIDO_C5 = 300;

const CAPACIDAD_EN_EL_PANEL: Record<CapacidadActiva, CapacidadEnElPanel> = {
  CI: {
    estado: (tx) => tx`case
        when i.estado is distinct from 'pendiente' then 'item-curado'
        when tipo_fuente_exige_consentimiento(i.tipo_fuente)
          and not consentimiento_externo_vigente(i.id, i.workspace_id)
          then 'consentimiento-revocado'
        else 'disponible'
      end`,
    material: (f) =>
      materialDeItem({
        titulo: (f.item_titulo as string | null) ?? '',
        tipoFuente: (f.item_tipo_fuente as string | null) ?? '',
        referencia: (f.item_referencia as string | null) ?? '',
        contenido: (f.item_contenido as string | null) ?? '',
      }).texto,
    /*
     * Los items que exigen consentimiento o no traen material se ofrecen igual, MARCADOS: la
     * pantalla explica qué falta, que es más útil que esconderlos sin decir por qué.
     */
    candidatas: async (tx, workspaceId, patron, limite) => {
      const filas = await tx`
        select i.id, i.titulo,
               tipo_fuente_exige_consentimiento(i.tipo_fuente)
                 and not consentimiento_externo_vigente(i.id, i.workspace_id)
                 as consentimiento_pendiente,
               not item_tiene_material_extraible(i.contenido) as sin_material
        from item_importacion i
        where i.workspace_id = ${workspaceId} and i.estado = 'pendiente'
          and not exists (select 1 from propuesta_ai p
            where p.item_id = i.id and p.workspace_id = i.workspace_id and p.estado = 'propuesta')
          and (${patron}::text is null or i.titulo ilike ${patron})
        order by i.creado_en asc, i.id asc
        limit ${limite}`;
      return {
        lista: filas.map((i) => ({
          id: i.id as string,
          titulo: i.titulo as string,
          consentimientoPendiente: i.consentimiento_pendiente as boolean,
          sinMaterial: i.sin_material as boolean,
        })),
        hayMas: false,
      };
    },
  },
  C0: {
    /*
     * El ORDEN de los TRES motivos importa cuando se cumplen varios a la vez, que es lo
     * normal en un reto cerrado (avanzó de etapa Y su G0 se aprobó Y firmó su registry). Se
     * ordenan de la puerta más cerrada a la menos: primero el ciclo de vida del reto, que no
     * se revierte nunca; después el registry firmado, que tampoco (la firma es de ida); y
     * solo al final el G0, que es el ÚNICO con salida real —reabrir la etapa 0 (RF-04.9)
     * descongela—. Sugerirle esa salida a quien tiene el reto archivado o el contrato firmado
     * sería mandarlo a un trámite que no va a desbloquear nada. Entre motivos ciertos gana
     * siempre el que describe la puerta que ya no se abre.
     *
     * Es el mismo orden con el que `criterio_g0_pendiente_guard` elige su `raise`, y por la
     * misma razón: quien fuerza la escritura por SQL directo lee el motivo que le sirve.
     */
    estado: (tx) => tx`case
        when not reto_admite_criterios(p.reto_id, p.workspace_id) then 'reto-no-admite'
        when reto_registry_firmado(p.reto_id, p.workspace_id) then 'registry-firmado'
        when reto_g0_congela_criterios(p.reto_id, p.workspace_id) then 'criterios-congelados'
        else 'disponible'
      end`,
    /*
     * C0 cita la formulación del reto igual que CI cita el material del item, así que la
     * presencia se mide con la misma regla. Cuando C0 no citaba, sus propuestas no salían mal
     * en la medición de grounding (RF-09.10): salían excluidas, que es peor — una capacidad
     * que no puede salir mal es la que más falta hace medir.
     */
    material: (f) =>
      materialDeReto({
        codigo: (f.reto_codigo as string | null) ?? '',
        titulo: (f.reto_titulo as string | null) ?? '',
        descripcion: (f.reto_descripcion as string | null) ?? '',
        metricaObjetivo: (f.reto_metrica as string | null) ?? '',
      }).texto,
    /*
     * Retos con criterios aún abiertos, que son DOS condiciones y no una: que el ciclo de vida
     * del reto siga admitiéndolos (RF-04.12) y que nada los haya congelado (SYS-22: ni un G0
     * aprobado ni un registry de medición firmado). Las dos las impone el guard del INSERT de
     * propuestas, así que ofrecer un reto al que le falte cualquiera sería ofrecer una acción
     * que la base va a rechazar — y las dos se preguntan por la MISMA función que la impone.
     * Aquí basta el predicado COMPUESTO porque la lista solo decide si el reto se ofrece;
     * distinguir la causa es cosa del panel, que sí tiene que explicarla.
     */
    candidatas: async (tx, workspaceId, patron, limite) => {
      const filas = await tx`
        select r.id, r.codigo || ' ' || r.titulo as titulo from reto r
        where r.workspace_id = ${workspaceId}
          and reto_admite_criterios(r.id, r.workspace_id)
          and not reto_criterios_congelados(r.id, r.workspace_id)
          -- Y el trabajo pendiente que excluye a un reto es EL DE C0, no cualquiera. C2
          -- cuelga del mismo reto y es otro pipeline: la admisión ya lo scopea por capacidad
          -- —eso se corrigió del otro lado—, así que sin este filtro la independencia valía
          -- en una sola dirección: con un insight esperando revisión, pedir criterios habría
          -- funcionado si se enviaba a mano, pero el reto desaparecía del selector de C0.
          and not exists (select 1 from propuesta_ai p
            where p.reto_id = r.id and p.workspace_id = r.workspace_id
              and p.capacidad = 'C0' and p.estado = 'propuesta')
          and (${patron}::text is null or r.codigo || ' ' || r.titulo ilike ${patron})
        order by r.codigo asc, r.id asc
        limit ${limite}`;
      return { lista: filas.map((r) => ({ id: r.id as string, titulo: r.titulo as string })), hayMas: false };
    },
  },
  CT: {
    /*
     * Lo que deja obsoleto un informe de gate es que el gate DEJE DE ESTAR PENDIENTE. No hay
     * más motivos y no hace falta ordenarlos: un gate aprobado ya no tiene «qué le falta»,
     * y `gate_instancia` no admite volver atrás desde aprobado sin pasar por el método.
     *
     * Aquí «obsoleto» pesa menos que en las otras dos, y conviene decirlo para que nadie
     * lea de más: un informe de CT no se acepta nunca —no hay objeto que crear—, así que
     * este estado no cierra ninguna puerta de escritura. Lo que hace es DECIRLE al revisor
     * que lo que está leyendo ya no describe la realidad, que es lo único que un informe
     * puede quedarse sin.
     */
    estado: (tx) => tx`case
        when g.estado is distinct from 'pendiente' then 'gate-decidido'
        when exists (
          select 1
          from jsonb_array_elements(
                 case when jsonb_typeof(p.contenido->'huecos') = 'array'
                      then p.contenido->'huecos' else '[]'::jsonb end) h
          join checklist_item c
            on c.id::text = lower(h->>'checklistItemId') and c.workspace_id = p.workspace_id
          where c.estado <> 'pendiente')
          then 'checklist-avanzado'
        else 'disponible'
      end`,
    /*
     * Recompuesto con la MISMA función que armó el prompt, desde las columnas que proyectó
     * el ancla. El checklist llega ya parseado —es `json`—, así que se pasa tal cual.
     */
    material: (f) =>
      materialDeGate({
        proyecto: (f.gate_proyecto as string | null) ?? '',
        numero: (f.gate_numero as number | null) ?? 0,
        rolAprobador: (f.gate_rol as string | null) ?? '',
        checklist: (f.gate_checklist as ChecklistDelGate | null) ?? [],
      }).texto,
    /*
     * Gates PENDIENTES sin informe sin leer. Las dos condiciones son la misma que en las
     * otras dos capacidades con otra ropa: que el ancla siga admitiendo la acción, y que no
     * tenga ya trabajo esperando — lo segundo lo impone además el índice parcial
     * `propuesta_ai_gate_pendiente_idx`, así que ofrecer un gate con informe sin leer sería
     * ofrecer algo que la base va a rechazar.
     */
    candidatas: async (tx, workspaceId, patron, limite) => {
      const filas = await tx`
        select g.id, pr.codigo || ' · G' || g.numero as titulo
        from gate_instancia g
        join proyecto pr on pr.id = g.proyecto_id and pr.workspace_id = g.workspace_id
        where g.workspace_id = ${workspaceId} and g.estado = 'pendiente'
          and not exists (select 1 from propuesta_ai p
            where p.gate_id = g.id and p.workspace_id = g.workspace_id and p.estado = 'propuesta')
          and (${patron}::text is null or pr.codigo || ' · G' || g.numero ilike ${patron}
               or pr.titulo ilike ${patron})
        order by g.creado_en asc, g.id asc
        limit ${limite}`;
      return { lista: filas.map((g) => ({ id: g.id as string, titulo: g.titulo as string })), hayMas: false };
    },
  },
  C5: {
    /*
     * NADA en SQL cierra un journey, y ese es el dato. Aquí había un `journey-congelado` para
     * los que tienen snapshot, y era un error de lectura de RF-05.8: lo inmutable es CADA
     * SNAPSHOT, no el journey. Su migración lo dice con todas las letras —«el journey de
     * trabajo sigue editable para el ciclo siguiente», «el grafo de trabajo no se cierra
     * nunca»—, así que aquel predicado sacaba para siempre de C5 a todo journey que hubiera
     * pasado una design version: justo los que llevan más ciclos y más señales acumulan.
     *
     * Lo que SÍ deja obsoleto un informe es que sus señales dejen de estar abiertas —porque
     * alguien las cerró, que es el desenlace bueno—, y eso no se puede preguntar en SQL: las
     * señales son una función pura de los nodos y las aristas. Se comprueba donde se puede
     * calcular, en `COMPROBAR.C5`, contra las que el modelo tuvo delante.
     */
    estado: (tx) => tx`'disponible'`,
    /*
     * Lo que sí deja obsoleto un informe, calculado donde se puede: que las señales que
     * remedia ya no sean las del grafo. Si alguien las cerró —que es el desenlace bueno— o
     * editó el grafo por su cuenta, lo que el informe dice ya no describe lo que hay, y quien
     * lo lee tiene que saberlo antes de aplicarlo.
     *
     * Se compara contra el ORIGINAL, no contra el contenido vigente: es el testimonio del
     * modelo, y para un informe los dos son el mismo mientras no se corrija (C5 no se acepta,
     * así que nunca se corrige).
     */
    /** El nombre de cada nodo, para que una remediación diga a CUÁL aplica. */
    etiquetasDelContenido: (f) =>
      Object.fromEntries(
        journeyDesdeElPanel(f).nodos.map((n) => [n.id, n.etiqueta || '(sin etiqueta)']),
      ),
    estadoDeLaFila: (f) => {
      /*
       * Contra la HUELLA guardada, no contra las claves de las señales que remedia.
       *
       * Comparar las claves era la mitad —y la misma mitad que ya se corrigió del otro lado,
       * en la comprobación de la escritura—: renombrar un nodo, cambiar la condición de una
       * transición o rehacer la topología de alrededor deja las señales iguales y cambia todo
       * lo que el consejo describe. El material es lo que hay que comparar, y por eso se
       * guardó al nacer la propuesta.
       *
       * Sin huella —una propuesta anterior a la columna— no se afirma nada: `null` deja el
       * veredicto del CASE. Decir «cambiado» sin poder saberlo sería inventarse una alarma,
       * y decir «al día» sería inventarse una tranquilidad.
       */
      return materialDelPanelEsElDelModelo(f) === false ? 'journey-cambiado' : null;
    },
    // La misma comparación, leída para lo otro que depende de ella, y resuelta AL REVÉS. Ver
    // `materialDelPanelEsElDelModelo`: para el estado de la fila, no saber no puede volverse
    // una alarma; para la presencia literal, no saber no puede volverse un veredicto.
    materialVigente: (f) => materialDelPanelEsElDelModelo(f) === true,
    material: (f) => materialDeJourney({
      nombre: (f.journey_nombre as string | null) ?? '',
      servicio: (f.journey_servicio as string | null) ?? '',
      tipo: (f.journey_tipo as string | null) ?? '',
      grafo: grafoParaElModelo(journeyDesdeElPanel(f)),
    }).texto,
    /*
     * El selector promete «journeys con señales abiertas», y ahora lo cumple.
     *
     * Antes no filtraba por señales —«exigiría evaluar `validarJourney` sobre cada grafo»— y
     * ofrecía journeys que `PREPARAR.C5` rechazaba a continuación por no tener ninguna: una
     * opción que no puede llevar a ninguna parte, con un rótulo que decía lo contrario. Lo
     * señalaron las dos revisiones, y las dos tienen razón: la promesa del rótulo y lo que la
     * cola devuelve tienen que ser lo mismo, o el rótulo es una decoración.
     *
     * El coste es real y por eso está acotado, pero el corte NO puede ser un `limit` fijo: con
     * uno, un workspace cuyos journeys recientes estén todos limpios devolvía la lista vacía y
     * el panel decía «no hay journeys con señales abiertas» —con `hayMas` en falso— aunque
     * hubiera uno más viejo que sí. Se PAGINA el prefiltro hasta llenar las plazas o agotar la
     * fuente, con un tope de barrido para que un workspace enorme no convierta el selector en
     * una lectura de todos sus grafos.
     *
     * Y cuando el tope se alcanza sin agotar la fuente, la lista se devuelve con una plaza de
     * más aunque no la haya: es lo que hace que `hayMas` salga cierto, que es la verdad —hay
     * más journeys sin mirar— y le dice a quien busca que use el buscador. Decir «no hay» sin
     * haber mirado es la única respuesta que no se puede dar.
     */
    candidatas: async (tx, workspaceId, patron, limite) => {
      const conSenales: CandidatoAncla[] = [];
      let vistos = 0;
      let agotado = false;
      while (conSenales.length < limite && vistos < TOPE_DE_BARRIDO_C5 && !agotado) {
        const lote = await tx`
          select jr.id, jr.nombre || ' · ' || s.nombre as titulo
          from journey jr
          join servicio s on s.id = jr.servicio_id and s.workspace_id = jr.workspace_id
          where jr.workspace_id = ${workspaceId}
            and not exists (select 1 from propuesta_ai p
              where p.journey_id = jr.id and p.workspace_id = jr.workspace_id
                and p.estado = 'propuesta')
            and (${patron}::text is null or jr.nombre ilike ${patron} or s.nombre ilike ${patron})
          order by jr.creado_en desc, jr.id asc
          limit ${LOTE_DE_BARRIDO_C5} offset ${vistos}`;
        agotado = lote.length < LOTE_DE_BARRIDO_C5;
        vistos += lote.length;
        /*
         * Los grafos del lote se leen DE UNA VEZ, no uno por journey mirado.
         *
         * `validarJourney` es una función pura del grafo, así que el barrido tiene que leerlos
         * todos; lo que no tiene que hacer es una ida y vuelta por cada uno. Con el tope de
         * barrido puesto en trescientos, un workspace con muchos journeys limpios convertía
         * cada carga de la pantalla de propuestas en trescientas consultas —cada una con sus
         * agregados anidados de nodos y aristas— antes de pintar nada.
         *
         * El orden del lote manda, no el que devuelva la base: el `order by` de la lista es lo
         * que hace que dos cargas ofrezcan lo mismo, y un `any(...)` no promete ninguno.
         */
        const grafos = new Map(
          (await leerJourneysCompletos(tx, workspaceId, lote.map((j) => j.id as string))).map(
            (g) => [g.id, g],
          ),
        );
        for (const j of lote) {
          if (conSenales.length >= limite) break;
          const journey = grafos.get(j.id as string);
          if (!journey) continue;
          const senales = validarJourney(journey);
          // Un journey LIMPIO no se ofrece, y ésa es la promesa del rótulo: no le falta nada
          // que remediar. No es lo mismo que los dos de abajo, a los que sí les falta algo.
          if (senales.length === 0) continue;
          /*
           * Y los que no se pueden generar se MARCAN, no se esconden. Esconderlos era peor que
           * no ofrecerlos: el selector se quedaba vacío y la pantalla afirmaba «no hay journeys
           * con señales abiertas» sobre un workspace lleno de ellos, mientras el motivo
           * accionable vivía en un mensaje de `PREPARAR.C5` que ningún camino del producto
           * podía alcanzar. Es lo que la casa ya hace con los items sin consentimiento y sin
           * material: se marca en vez de esconderse.
           *
           * El núcleo se mide sobre las señales y sus transiciones, no sobre el material
           * entero: así el barrido no se convierte en armar el prompt de trescientos journeys.
           */
          const nucleo = nucleoDeRemediacion(grafoParaElModelo(journey));
          const bloqueo =
            senales.length > MAX_REMEDIACIONES
              ? motivoDemasiadasSenales(senales.length)
              : !nucleo.cabe
                ? motivoConectividadQueNoCabe(nucleo.texto.length)
                : undefined;
          conSenales.push({ id: j.id as string, titulo: j.titulo as string, bloqueo });
        }
      }
      // Hay más por ofrecer si se llenaron las plazas, o si el barrido se cortó por el tope
      // sin agotar la fuente. Lo segundo es lo que el `limit` fijo no podía decir: la lista
      // sale corta y NO es porque no haya, es porque no se ha mirado.
      return { lista: conSenales, hayMas: conSenales.length >= limite || !agotado };
    },
  },
  C2: {
    /*
     * Lo que deja obsoleto un insight propuesto es que su reto se ARCHIVE: ahí el trabajo se
     * cerró y proponerle insights nuevos no lleva a ninguna parte.
     *
     * Y NADA de lo que congela a C0 aplica aquí, que es justamente lo que este registro
     * existe para permitir: C0 y C2 cuelgan del MISMO reto y no comparten sus puertas. Un G0
     * aprobado congela los criterios (SYS-22) y no tiene nada que decir sobre los insights;
     * indexado por columna de ancla, C2 habría heredado sus tres motivos y su cola.
     */
    estado: (tx) => tx`case
        when r.estado = 'archivado' then 'reto-archivado'
        /*
         * Y que la evidencia que el insight CITA siga pudiendo citarse al cliente.
         *
         * El derecho de uso es temporal: se retira, caduca, o el documento se va. Cuando eso
         * pasa DESPUÉS de nacer la propuesta —el guard del insert cubre lo de antes—, el panel
         * decía disponible y ofrecía aceptar, y aceptar falla siempre: materializarInsight
         * inserta la cita y evidencia_citable_guard la rechaza con DR001. Quien revisa se
         * encontraba una tarjeta aceptable que no se deja aceptar, con un código por toda
         * explicación. Es el equivalente exacto del consentimiento-revocado de CI, con lo que
         * C2 lee en vez de lo que lee CI.
         *
         * Se pregunta por la AUSENCIA de una evidencia usable y no por la presencia de una
         * bloqueada: así el documento borrado —que también hace fallar la aceptación, por la
         * FK— cae en la misma rama en vez de pasar por disponible.
         *
         * Y se compara por texto en vez de castear a uuid: el contenido es jsonb, y un
         * evidenciaId que no parsee reventaría la consulta del panel entero en vez de marcar
         * una fila. Mismo criterio que el estado de CT con su checklistItemId.
         */
        when exists (
          select 1
          from jsonb_path_query(
                 p.contenido, '$.afirmaciones[*].citas[*].evidenciaId') c
          where not exists (
            select 1 from evidencia e
            where e.id::text = lower(c #>> '{}') and e.workspace_id = p.workspace_id
              and evidencia_usable(e.id, e.workspace_id, 'cliente')))
          then 'evidencia-no-citable'
        /*
         * Y que el reto no haya ganado evidencia que estos insights no llegaron a ver.
         *
         * Es la misma clase de defecto que la rama de arriba, con la otra mitad del sello: el
         * guard diferido rechaza la aceptación cuando el reto tiene evidencia usable que no
         * está en «alcance_evidencia» —porque se enlazó después, o porque el recorte del
         * material no la dejó llegar—, y sin esta rama el panel seguía diciendo «disponible» y
         * ofreciendo un botón que siempre vuelve. Una tarjeta aceptable que no se deja aceptar
         * es peor que una marcada: la marcada dice qué hacer.
         *
         * La condición es LA MISMA que la del guard, escrita igual, porque una discrepancia
         * entre las dos devuelve exactamente el problema que esta rama quita.
         */
        when p.reto_id is not null and p.alcance_evidencia is not null and exists (
          select 1
          from arquetipo a
          join arquetipo_evidencia ae on ae.arquetipo_id = a.id
            and ae.workspace_id = a.workspace_id
          where a.reto_id = p.reto_id and a.workspace_id = p.workspace_id
            and evidencia_usable(ae.evidencia_id, ae.workspace_id, 'cliente')
            and not (ae.evidencia_id = any (p.alcance_evidencia)))
          then 'alcance-incompleto'
        else 'disponible'
      end`,
    material: (f) =>
      materialDeInsights({
        codigo: (f.reto_codigo as string | null) ?? '',
        titulo: (f.reto_titulo as string | null) ?? '',
        descripcion: (f.reto_descripcion as string | null) ?? '',
        evidencia: (f.reto_evidencia as EvidenciaDelReto | null) ?? [],
      }).texto,
    /*
     * Y si ese material sigue siendo el que vio el modelo, contra la huella que la propuesta
     * guardó al nacer. C2 la guarda desde que la revalidación previa al despacho la necesitó,
     * y aquí sirve para lo otro que depende de ella.
     *
     * Lo que se rompe sin esto no es la aceptación —las citas siguen apuntando a evidencia
     * real y el guard las valida—, es la SEÑAL DE GROUNDING, que es lo único contrastable que
     * tiene quien revisa. El material de C2 son varios documentos concatenados y el recorte de
     * `MAX_MATERIAL` es global y depende del orden: basta con que a un documento NO CITADO que
     * ordenaba antes le caduquen los derechos, o con que se enlace uno nuevo que ordena antes,
     * para que el trozo del documento citado que el panel recompone hoy no sea el que el
     * modelo leyó. Y entonces el verde miente en los dos sentidos: un fragmento que el recorte
     * de hoy acaba de dejar visible sale PRESENTE aunque el modelo no lo tuviera delante, y
     * una cita legítima cuyo trozo el recorte de hoy esconde sale AUSENTE.
     *
     * Y no saber NO se resuelve como vigente: solo se mide cuando la huella dice que sí. Ver
     * `materialDelPanelEsElDelModelo` para por qué las dos lecturas de ese mismo `null` van en
     * direcciones opuestas.
     */
    materialVigente: (f) => materialDelPanelEsElDelModelo(f) === true,
    /*
     * Una cita de C2 se mide contra LA EVIDENCIA QUE NOMBRA, no contra todas juntas.
     *
     * El material de C2 son varios documentos y cada cita dice de cuál sale. Con el pajar
     * completo, «el 71% de los abandonos, en la evidencia B» salía presente porque ese texto
     * está en la A: un verde que le dice a quien revisa que confíe en una cita que le manda a
     * otro documento, y la presencia literal es justo lo único que puede contrastar.
     *
     * Se compone con la MISMA función que arma el prompt, sobre esa sola evidencia: lo que se
     * compara tiene que ser el texto que el modelo leyó de ella, con su ficha y su delimitador
     * neutralizado, no el crudo de la base.
     *
     * Y si la cita nombra una evidencia que no está en el material, `null`: no es lo mismo que
     * «no aparece», pero se resuelve igual —ausente—, porque una cita a un documento que el
     * modelo no vio no la sostiene nada.
     */
    /**
     * El título de cada evidencia, para que una cita —o una contradicción— diga de QUÉ
     * documento habla. Sale de la lista de NOMBRES, no de la del material: los derechos de
     * cita no gobiernan la identidad de un documento, y una contradicción no los necesita.
     */
    etiquetasDelContenido: (f) =>
      Object.fromEntries(
        ((f.reto_evidencia_nombres as { id: string; titulo: string }[] | null) ?? []).map((e) => [
          e.id,
          e.titulo,
        ]),
      ),
    pajarDeLaCita: (f, cita) => {
      const evidencia = (f.reto_evidencia as EvidenciaDelReto | null) ?? [];
      if (cita.alcanceId === undefined) return null;
      // SOLO ese documento, y el trozo de él que SOBREVIVIÓ al recorte del cuerpo entero. Las
      // dos mitades importan y las dos costaron una ronda: componerlo con `materialDeInsights`
      // metía delante la formulación del reto, y recomponer la línea aparte reiniciaba el
      // presupuesto de caracteres y devolvía texto que el modelo nunca vio.
      const tramo = materialDeUnaEvidencia(
        {
          codigo: (f.reto_codigo as string | null) ?? '',
          titulo: (f.reto_titulo as string | null) ?? '',
          descripcion: (f.reto_descripcion as string | null) ?? '',
          evidencia,
        },
        cita.alcanceId,
      );
      // Tramo vacío es «esa evidencia no está en el material» —le retiraron los derechos, se
      // desenlazó, o el recorte no llegó a ella—, y eso es `null` y no `''`: son las dos
      // respuestas que este contrato distingue, y quien lo lee las trata distinto. Devolver
      // `''` funcionaba por accidente —buscar en la cadena vacía da ausente— y dejaba viva la
      // única forma de perderlo: que alguien resuelva el `null` con el material entero.
      return tramo === '' ? null : tramo;
    },
    /*
     * Retos CON EVIDENCIA y sin insights esperando revisión. Lo primero no es un filtro de
     * comodidad: sin evidencia, la única salida que cumple el contrato —afirmaciones con
     * citas literales— sale de la formulación del reto, o sea inventada. Es el mismo caso que
     * el item importado solo con su referencia, y la respuesta es la misma: no ofrecerlo.
     */
    candidatas: async (tx, workspaceId, patron, limite) => {
      const filas = await tx`
        select r.id, r.codigo || ' ' || r.titulo as titulo from reto r
        where r.workspace_id = ${workspaceId}
          and r.estado <> 'archivado'
          and exists (
            select 1 from arquetipo a
            join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
            join evidencia e on e.id = ae.evidencia_id and e.workspace_id = ae.workspace_id
            where a.reto_id = r.id and a.workspace_id = r.workspace_id
              and evidencia_usable(e.id, e.workspace_id, 'cliente'))
          and not exists (select 1 from propuesta_ai p
            where p.reto_id = r.id and p.workspace_id = r.workspace_id
              and p.capacidad = 'C2' and p.estado = 'propuesta')
          and (${patron}::text is null or r.codigo || ' ' || r.titulo ilike ${patron})
        order by r.codigo asc, r.id asc
        limit ${limite}`;
      return {
        lista: filas.map((r) => ({ id: r.id as string, titulo: r.titulo as string })),
        hayMas: false,
      };
    },
  },
  C6: {
    /*
     * Lo que deja obsoleta una entrada propuesta es que su registry se FIRME —ahí el contrato
     * de medición se congela y no admite entradas nuevas— o que el trabajo del reto se cierre.
     * Las dos preguntas están en «registry_admite_entradas», que es la MISMA función que miran
     * el guard del insert y el guard diferido: escribir aquí el predicado a mano habría dejado
     * tres redacciones del mismo juicio, y este repositorio ya ha pagado por dos.
     */
    estado: (tx) => tx`case
        when not registry_admite_entradas(p.registry_id, p.workspace_id)
          then 'registry-cerrado'
        /*
         * Y que el criterio al que responde SIGA existiendo. «criterio_exito» no tiene
         * borrado por la app, pero sí lo tiene el reto entero por cascada de administración,
         * y —lo que de verdad pasa— el criterio pudo no existir nunca: el contenido lo dice
         * por id y el suelo lo comprueba al aceptar. Sin esta rama el panel decía disponible
         * y aceptar fallaba siempre, que es la tarjeta aceptable que no se deja aceptar.
         *
         * Por texto y no casteando a uuid, como C2 y CT: el contenido es jsonb y un id que no
         * parsee reventaría la consulta del panel ENTERO en vez de marcar una fila.
         */
        when not exists (
          select 1 from criterio_exito c
          where c.id::text = lower(p.contenido ->> 'criterioId')
            and c.workspace_id = p.workspace_id
            and c.reto_id = (select mr2.reto_id from metric_registry mr2
                             where mr2.id = p.registry_id and mr2.workspace_id = p.workspace_id))
          then 'criterio-ausente'
        /*
         * Y que el registry no tenga ya una entrada con ese NOMBRE. «unique (registry_id, nombre)» es el suelo, y sin esta rama la colisión se descubría al aceptar —con un
         * 23505 traducido— después de que quien revisa hubiera leído la tarjeta entera. Pasa
         * solo: la entrada se escribe a mano mientras el lote espera, o dos propuestas del
         * mismo lote traen el mismo nombre y se acepta la primera.
         */
        when exists (
          select 1 from entrada_kpi e
          where e.registry_id = p.registry_id and e.workspace_id = p.workspace_id
            and e.nombre = p.contenido ->> 'nombre'
            and e.id is distinct from p.entrada_kpi_id)
          then 'nombre-ocupado'
        else 'disponible'
      end`,
    material: (f) =>
      materialDeRegistry({
        codigo: (f.registry_reto_codigo as string | null) ?? '',
        titulo: (f.registry_reto_titulo as string | null) ?? '',
        descripcion: (f.registry_reto_descripcion as string | null) ?? '',
        criterios: (f.registry_criterios as CriteriosDelReto | null) ?? [],
      }).texto,
    /* La huella se guarda al nacer (el CHECK de la tabla la exige para C6), así que el panel
     * puede decir si el texto que recompone hoy es el que el modelo leyó. Un criterio editado
     * o añadido mueve el recorte global igual que una evidencia en C2, y entonces el verde de
     * la presencia literal mentiría en las dos direcciones. */
    materialVigente: (f) => materialDelPanelEsElDelModelo(f) === true,
    /** El KPI de cada criterio, para que una cita diga a QUÉ promesa responde. */
    etiquetasDelContenido: (f) =>
      Object.fromEntries(
        ((f.registry_criterios as CriteriosDelReto | null) ?? []).map((c) => [c.id, c.kpi]),
      ),
    /* Una cita de C6 se mide contra EL CRITERIO QUE LA ENTRADA NOMBRA, no contra todos juntos:
     * mismo argumento que en C2, con criterios en vez de documentos. Un objetivo copiado del
     * criterio de al lado saldría presente y el verde le diría a quien revisa que confíe. */
    pajarDeLaCita: (f, cita) => {
      if (cita.alcanceId === undefined) return null;
      const tramo = materialDeUnCriterio(
        {
          codigo: (f.registry_reto_codigo as string | null) ?? '',
          titulo: (f.registry_reto_titulo as string | null) ?? '',
          descripcion: (f.registry_reto_descripcion as string | null) ?? '',
          criterios: (f.registry_criterios as CriteriosDelReto | null) ?? [],
        },
        cita.alcanceId,
      );
      return tramo === '' ? null : tramo;
    },
    /*
     * Registries EN BORRADOR, de retos que siguen admitiendo trabajo, CON criterios y sin
     * entradas esperando revisión. Lo de los criterios no es comodidad: sin ellos la única
     * salida que cumple el contrato —una entrada que responde a un criterio por su id— sale
     * de la nada. Mismo caso que el item con solo su referencia, misma respuesta.
     */
    candidatas: async (tx, workspaceId, patron, limite) => {
      const filas = await tx`
        select mr.id, rr.codigo || ' ' || rr.titulo as titulo
        from metric_registry mr
        join reto rr on rr.id = mr.reto_id and rr.workspace_id = mr.workspace_id
        where mr.workspace_id = ${workspaceId}
          and registry_admite_entradas(mr.id, mr.workspace_id)
          and exists (select 1 from criterio_exito c
            where c.reto_id = rr.id and c.workspace_id = rr.workspace_id)
          and not exists (select 1 from propuesta_ai p
            where p.registry_id = mr.id and p.workspace_id = mr.workspace_id
              and p.capacidad = 'C6' and p.estado = 'propuesta')
          and (${patron}::text is null or rr.codigo || ' ' || rr.titulo ilike ${patron})
        order by rr.codigo asc, mr.id asc
        limit ${limite}`;
      return {
        lista: filas.map((r) => ({ id: r.id as string, titulo: r.titulo as string })),
        hayMas: false,
      };
    },
  },
};

/**
 * La proyección del panel, compuesta desde los DOS registros: lo que depende del ancla, por
 * columna; lo que depende de la capacidad, por capacidad.
 *
 * Se exporta porque la prueba que la sujeta tiene que medir ESTA composición y no una copia
 * suya: lo que hay que demostrar es que ninguna capacidad hereda el juicio de otra, y eso
 * solo lo demuestra evaluar el mismo CASE que corre en producción.
 */
export function proyeccionDelPanel(tx: TransactionSql): {
  /** `p.<columna>` por cada ancla declarada. */
  columnas: PendingQuery<Row[]>;
  /** Los títulos de cada ancla, para un `coalesce`. */
  titulos: PendingQuery<Row[]>;
  /** El repertorio de columnas de cada tabla de ancla, del que cada capacidad toma lo suyo. */
  materiales: PendingQuery<Row[]>;
  /**
   * Las ramas del CASE, una POR CAPACIDAD y preguntando por su nombre. Sin `case … end`:
   * quien lo usa cierra con `else null`, que es lo que dice «este panel no sabe juzgar esta
   * propuesta» —y `filaDePanel` lo lee como «ancla-ausente», que es solo rechazable—.
   *
   * Por capacidad y no por columna, que es la corrección de fondo de esta ronda: preguntando
   * `when p.reto_id is not null`, la segunda capacidad anclada en un reto habría recibido las
   * puertas de C0 —el congelado del G0 entre ellas— sin que faltara ninguna entrada que el
   * compilador echara de menos.
   */
  motivo: PendingQuery<Row[]>;
  joins: PendingQuery<Row[]>;
} {
  const conComas = (fs: PendingQuery<Row[]>[]) => fs.reduce((a, b) => tx`${a}, ${b}`);
  const anclas = COLUMNAS_DE_ANCLA.map((c) => ({ c, a: ANCLA_EN_EL_PANEL[c] }));
  const capacidades = CAPACIDADES_ACTIVAS.map((k) => ({ k, d: CAPACIDAD_EN_EL_PANEL[k] }));
  return {
    columnas: conComas(anclas.map(({ c }) => tx`p.${tx(c)}`)),
    titulos: conComas(anclas.map(({ a }) => a.titulo(tx))),
    materiales: conComas(anclas.map(({ a }) => a.columnas(tx))),
    motivo: capacidades
      .map(({ k, d }) => tx`when p.capacidad = ${k} then ${d.estado(tx)}`)
      .reduce((a, b) => tx`${a} ${b}`),
    joins: anclas.map(({ a }) => a.join(tx)).reduce((a, b) => tx`${a} ${b}`),
  };
}

/**
 * La definición de la capacidad de ESTA fila, o `undefined` si el panel no la conoce.
 *
 * `propuesta_ai.capacidad` admite las diez del catálogo y solo dos están activas, así que una
 * fila puede nombrar una capacidad que este código no sabe pintar. No se esconde —una
 * propuesta invisible es una que nadie puede rechazar— pero tampoco se le presta el juicio de
 * otra: sale sin material y sin motivo, y `filaDePanel` lee eso como «ancla-ausente», que es
 * solo rechazable.
 */
function definicionDeFila(f: Record<string, unknown>): CapacidadEnElPanel | undefined {
  return CAPACIDAD_EN_EL_PANEL[f.capacidad as CapacidadActiva];
}

/**
 * La columna por la que cuelga ESTA fila.
 *
 * Sale de lo que la CAPACIDAD declara —no de buscar cuál de las columnas trae valor—, porque
 * eso es lo que dice de dónde cuelga de verdad; el barrido queda de reserva para una fila
 * cuya capacidad este panel no conoce, donde adivinar por el valor es lo único que hay.
 */
function columnaDelAncla(f: Record<string, unknown>): AnclaCapacidad['columna'] | undefined {
  const declarada = CAPACIDADES[f.capacidad as CapacidadActiva]?.ancla.columna;
  if (declarada) return declarada;
  return COLUMNAS_DE_ANCLA.find((c) => f[c] != null);
}

function filaDePanel(f: Record<string, unknown>): PropuestaEnPanel {
  const contenido = f.contenido as ContenidoPropuesta;
  const original = f.contenido_original as ContenidoPropuesta;
  // El material lo recompone la CAPACIDAD, que es lo que decide qué leyó el modelo. Con la
  // columna del ancla no bastaba: dos capacidades pueden colgar del mismo reto y citar cosas
  // distintas —C0 la formulación, una posterior la evidencia codificada—, así que indexarlo
  // por columna le habría dado a la segunda el pajar de la primera y sus citas habrían salido
  // ausentes estando presentes.
  const material = definicionDeFila(f)?.material(f) ?? '';
  const columna = columnaDelAncla(f);
  // Las citas se leen del ORIGINAL: son el testimonio del modelo sobre lo que leyó, no del
  // humano que corrige. Hoy son siempre las mismas —corregirlas está prohibido en el
  // servicio y en el guard— y leerlas de aquí lo deja dicho en la proyección también.
  // Por CAPACIDAD, no por la forma del objeto: las de C2 viven dentro de cada afirmación, y
  // con `'citas' in original` su grounding se habría medido sobre una lista vacía — o sea, no
  // se habría medido, que es el peor resultado posible para una medida de grounding.
  /*
   * Y degradando si la capacidad no está en el registro. `f.capacidad` son las diez de
   * SPEC-08 y el registro cubre las ACTIVAS, así que la indexación puede devolver `undefined`
   * de verdad: una fila escrita por una versión más nueva del servidor, o una capacidad que
   * vuelve a apagarse dejando propuestas pendientes. Llamar a `undefined` aquí no degradaba la
   * fila, tiraba el panel entero — y con él las filas de todas las demás capacidades.
   *
   * Sin citas es lo correcto y no un apaño: si nadie sabe dónde las guarda esa capacidad, no
   * hay nada que medir, y decir «cero citas» es más honesto que inventarse dónde buscarlas.
   */
  const definicion = CAPACIDAD_EN_EL_PANEL[f.capacidad as CapacidadActiva] as
    | CapacidadEnElPanel
    | undefined;
  const citas = CITAS_DEL_CONTENIDO[f.capacidad as CapacidadActiva]?.(original) ?? [];
  /*
   * La presencia, CITA A CITA, contra el trozo de material que cada una nombra cuando su
   * capacidad lo declara. Antes se resolvía de una vez para toda la fila porque «el pajar es
   * el mismo para todas sus citas», y eso dejó de ser cierto con C2: su material son varios
   * documentos y cada cita dice de cuál sale.
   */
  /*
   * Y si el material que se acaba de recomponer YA NO es el que vio el modelo, no hay
   * veredicto que dar. Medir contra el estado de hoy pinta en verde un fragmento que una
   * edición ajena acaba de añadir y en rojo una cita legítima que esa edición borró: las dos
   * mentiras caben en un booleano, y la única respuesta honesta es que no se puede comprobar.
   *
   * Lo contesta la CAPACIDAD, porque solo ella sabe si guardó algo con qué comparar. Las que
   * no lo declaran siguen midiendo como siempre.
   */
  const vigente = definicion?.materialVigente?.(f) ?? true;
  /*
   * La presencia, CITA A CITA, contra el trozo de material que cada una nombra cuando su
   * capacidad lo declara. Antes se resolvía de una vez para toda la fila porque «el pajar es
   * el mismo para todas sus citas», y eso dejó de ser cierto con C2: su material son varios
   * documentos y cada cita dice de cuál sale.
   */
  const presencias = citas.map((c) => {
    if (!vigente) return null;
    /*
     * `undefined` y `null` NO son lo mismo aquí, y colapsarlos con un `??` devolvía el verde
     * prestado que `pajarDeLaCita` existe para quitar. `undefined` es «esta capacidad no
     * declara pajar», y su respuesta es el material entero —CI, C0 y CT citan contra uno
     * solo—. `null` es «la cita nombra un trozo que no está en el material», y su respuesta
     * es la cadena vacía: ausente. Con `?? material`, esa cita a un documento que el modelo
     * no vio se medía contra TODOS los demás y salía presente si el texto estaba en
     * cualquiera de ellos.
     */
    if (!definicion?.pajarDeLaCita) return presenciaLiteralPorCita(material ?? '', [c])[0]!;
    return presenciaLiteralPorCita(definicion.pajarDeLaCita(f, c) ?? '', [c])[0]!;
  });
  return {
    id: f.id as string,
    capacidad: f.capacidad as PropuestaEnPanel['capacidad'],
    destino: f.destino as PropuestaEnPanel['destino'],
    estado: f.estado as PropuestaEnPanel['estado'],
    esSimulacion: f.es_simulacion as boolean,
    confianza: f.confianza === null ? null : Number(f.confianza),
    contenido,
    // El original solo viaja cuando difiere: una corrección nunca oculta lo que la AI
    // había dicho de verdad (SYS-17).
    contenidoOriginal: JSON.stringify(contenido) === JSON.stringify(original) ? null : original,
    citas: citas.map((c, i) => ({
      fragmento: c.fragmento,
      localizacion: c.localizacion,
      // A qué documento dice señalar, cuando su capacidad lo dice. Sin esto, quien revisa ve
      // el fragmento y su verde pero no CONTRA QUÉ se midió, que es la mitad de la señal.
      alcanceId: c.alcanceId ?? null,
      presenteLiteral: presencias[i]!,
    })),
    anclaTitulo: (f.ancla_titulo as string | null) ?? '',
    // Cómo se llaman los ids que el contenido nombra, cuando su capacidad lo sabe. Vacío es la
    // respuesta correcta de las que no nombran ninguno, no un hueco.
    etiquetas: definicion?.etiquetasDelContenido?.(f) ?? {},
    /*
     * El ancla sale de TODAS las columnas declaradas, no de una pareja escrita aquí. Con
     * `f.item_id ?? f.reto_id`, una capacidad anclada en otra cosa aparecía en el panel con
     * el ancla vacía — y por tanto como no disponible, así que nadie podía aceptarla.
     * `COLUMNAS_DE_ANCLA` es exhaustiva por el tipo: ampliar el ancla rompe la compilación
     * donde se declara, no aquí en silencio.
     */
    anclaId: columna ? (f[columna] as string) : '',
    // Si no se pudo determinar, se trata como NO disponible: habilitar dos botones que la
    // base va a rechazar es peor que pedir un refresco. Y el SQL devuelve NULL justamente
    // cuando ninguna columna declarada trae el ancla, en vez de dejar que la fila caiga en
    // la rama de otra: un motivo prestado es peor que ninguno, porque propone una salida
    // que no existe.
    /*
     * El veredicto de la capacidad va POR DELANTE del CASE cuando lo hay, y no al revés: el
     * CASE dice lo que el SQL puede juzgar, y `estadoDeLaFila` lo que solo se puede calcular
     * fuera. Hoy solo C5 lo declara, y su CASE es la constante «disponible», así que el orden
     * no cambia ninguna respuesta viva — pero lo correcto es que la respuesta más informada
     * gane, no la que llegó antes.
     */
    anclaEstado:
      CAPACIDAD_EN_EL_PANEL[f.capacidad as CapacidadActiva]?.estadoDeLaFila?.(f) ??
      (f.ancla_estado as EstadoAncla | null) ??
      'ancla-ausente',
    modelo: f.modelo as string,
    promptVersion: f.prompt_version as string,
    origenKey: f.origen_key as OrigenKey,
    alcanceResumen: f.alcance_resumen as string,
    latenciaMs: f.latencia_ms === null ? null : Number(f.latencia_ms),
    costoUsd: f.costo_usd === null || f.costo_usd === undefined ? null : Number(f.costo_usd),
    creadoEn: (f.creado_en as Date).toISOString(),
    revisadaEn: f.revisada_en ? (f.revisada_en as Date).toISOString() : null,
  };
}

/**
 * Proyección del panel de revisión. El `material` que viaja para medir la presencia literal de
 * las citas está acotado EXACTAMENTE al que entró al prompt (MAX_MATERIAL): medir contra
 * más texto del que el modelo vio daría un grounding falsamente bueno.
 *
 * Pendientes y decididas se consultan por SEPARADO, cada una con su corte. Con un único
 * límite antes de partir por estado, 150 decisiones nuevas dejaban fuera una propuesta
 * pendiente antigua: invisible en el panel y, como la generación excluye su item por el
 * `not exists`, imposible de revisar o rechazar por ningún camino. Y las pendientes van
 * de la MÁS ANTIGUA a la más nueva: una cola de revisión se drena por el frente, así que
 * el recorte cae siempre sobre lo recién llegado, que se ve en la siguiente pasada.
 */
  /*
   * REPEATABLE READ: es una proyección de SOLO LECTURA con varias sentencias, y desde que
   * existe la disposición acordada los datos de un workspace pueden desaparecer entre una y
   * otra. Bajo READ COMMITTED cada sentencia toma su instantánea, así que la respuesta podía
   * mezclar dos momentos —y con la membresía ya borrada, la mitad tardía vuelve VACÍA por RLS,
   * no corta—. Lo que llega a la pantalla no es entonces un estado incompleto: es uno que no
   * ha existido nunca.
   *
   * No choca con la doctrina de aislamiento del esquema, que exige READ COMMITTED a las
   * transacciones que ESCRIBEN y releen tras un candado: aquí no se escribe nada.
   */
export async function panelPropuestas(
  actorId: string,
  workspaceId: string,
  /** Filtro por texto de las anclas ofrecidas (título del item, código o título del reto).
   * Vacío = las primeras de la cola. Es lo que hace alcanzable un ancla que cae fuera del
   * corte: el orden decide QUÉ se ve primero, la búsqueda decide que todo se pueda ver. */
  busqueda = '',
): Promise<PanelPropuestas> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const ai = await estadoCapacidad(tx, workspaceId);

    // Fragmentos compartidos: dos consultas con la MISMA proyección no pueden divergir.
    //
    // `ancla_estado` dice si la propuesta se puede materializar y, si no, POR QUÉ. Se
    // deriva de lo que bloquea a cada destino: el item deja de estar pendiente (lo curó
    // alguien a mano), su consentimiento deja de autorizar el procesamiento externo, el G0
    // del reto congela sus criterios (SYS-22) o el reto avanza en su ciclo de vida y deja de
    // admitirlos (RF-04.12). Un booleano no basta porque las cuatro salidas del revisor son
    // distintas, y un `coalesce` que caía en «disponible» era el fallo original — dejaba
    // habilitados dos botones que la base rechaza siempre.
    //
    // Cada motivo pregunta por la MISMA función que lo impone al aceptar: el día que el
    // predicado cambie, el panel no se queda con la versión vieja (que es exactamente cómo
    // nació `reto_criterios_congelados`).
    // (El orden de los motivos de cada ancla vive con el ancla, en `ANCLA_EN_EL_PANEL`.)
    //
    // Y las cuatro piezas que dependen del TIPO de ancla —la columna proyectada, el join, el
    // título y el motivo— se escriben desde `ANCLA_EN_EL_PANEL`, una entrada por columna
    // declarada. Antes estaban tecleadas para item y reto, y el CASE terminaba en las ramas
    // del reto sin preguntar por `p.reto_id`: cualquier ancla que no fuese un item heredaba
    // su motivo. Ahora cada rama declara de QUÉ columna habla y el fondo del CASE es NULL,
    // que `filaDePanel` lee como «ancla-ausente» — no aceptable, que es la única respuesta
    // honesta cuando el panel no sabe juzgar el ancla.
    const proyeccion = proyeccionDelPanel(tx);

    const columnas = tx`p.id, p.capacidad, p.destino, p.estado, p.es_simulacion, p.confianza,
             p.contenido, p.contenido_original, ${proyeccion.columnas},
             p.modelo, p.prompt_version, p.origen_key, p.alcance_resumen, p.huella_material,
             l.latencia_ms, l.costo_usd, p.creado_en, p.revisada_en,
             coalesce(${proyeccion.titulos}) as ancla_titulo,
             case ${proyeccion.motivo} else null end as ancla_estado,
             ${proyeccion.materiales}`;
    // La llamada que pagó cada propuesta: el uso, el coste y la latencia viven allí (una
    // fila por llamada, aunque devuelva un lote), no repetidos en cada propuesta.
    const origen = tx`from propuesta_ai p
      join llamada_ai l on l.id = p.llamada_id and l.workspace_id = p.workspace_id
      ${proyeccion.joins}`;

    // Se pide una fila de más para saber si el corte dejó algo fuera (mismo truco que la
    // bandeja): el panel lo dice en vez de fingir que eso es todo.
    //
    // Y el orden es por CONFIANZA ASCENDENTE: lo más dudoso primero. Persistir `confianza`
    // argumentando que «ordena la revisión humana» y después no ordenar por ella no entrega esa
    // conducta —con FIFO puro, una propuesta nueva y endeble se quedaba detrás de cien viejas y
    // sólidas—, pero la DIRECCIÓN importa tanto como el hecho de ordenar.
    //
    // Va ascendente porque la revisión humana es el recurso escaso del pipeline, y lo escaso se
    // gasta donde más rinde. Una propuesta que el modelo declara muy segura es la que menos
    // probablemente cambie al mirarla; una que declara dudosa es donde el ojo humano decide de
    // verdad. Con el orden descendente, la persona empezaba por lo que casi seguro iba a
    // aceptar tal cual y llegaba cansada —o no llegaba— a lo que había que corregir.
    //
    // La antigüedad sigue siendo el desempate, así que entre iguales manda la cola de siempre y
    // el drenaje no se rompe.
    //
    // `nulls last` NO se invierte, y conviene decir por qué en vez de dejarlo raro: «sin
    // confianza declarada» no es «confianza cero». Son las sembradas o las escritas por SQL
    // crudo. Moverlas al frente al invertir el orden sería tratar la ausencia del dato como el
    // valor más dudoso posible, que es justo la mentira que `nulls last` existe para no contar.
    const pendientes = await tx`select ${columnas} ${origen}
      where p.workspace_id = ${workspaceId} and p.estado = 'propuesta'
      order by p.confianza asc nulls last, p.creado_en asc, p.id asc
      limit ${PAGINA_PENDIENTES + 1}`;
    // Cuántas hay en total, para que el recorte diga un número y no «hay más». Con el orden
    // ascendente, lo que queda detrás del corte son las que el modelo dio por MÁS fiables —lo
    // contrario que antes—, así que el número importa por otra razón: lo escondido ya no es lo
    // que más urge mirar, pero sigue siendo trabajo pendiente, y decir cuánto es lo que
    // convierte el corte en algo que se puede drenar en vez de en un final falso.
    const [conteo] = await tx`select count(*)::int as n from propuesta_ai
      where workspace_id = ${workspaceId} and estado = 'propuesta'`;

    // ── El grounding que alguien SOSTIENE ──
    //
    // La presencia literal de las citas mide una subcadena, y ninguna subcadena verifica que
    // una cita sostenga su afirmación. El único verificador de confianza del pipeline es la
    // persona que materializa y firma (SYS-19), así que «con respaldo» es propiedad del ACTO
    // HUMANO y se cuenta aquí: cuántas propuestas pasó alguien a objeto real del dominio,
    // poniendo su nombre en `revisada_por`.
    //
    // Se cuenta sobre TODO el workspace y no sobre la página de decididas recientes: un
    // recuento por página no es un recuento, y este número se va a leer como medida.
    //
    // Y se cuentan los tres estados por separado en vez de derivar «rechazadas» restando,
    // porque `propuesta` —lo que aún no ha decidido nadie— no es ninguno de los tres y una
    // resta lo repartiría en silencio entre ellos.
    const [respaldo] = await tx`select
        count(*) filter (where estado = 'aceptada')::int as aceptadas,
        count(*) filter (where estado = 'corregida')::int as corregidas,
        count(*) filter (where estado = 'rechazada')::int as rechazadas
      from propuesta_ai where workspace_id = ${workspaceId} and revisada_por is not null`;

    // Por `revisada_en`, que es lo que la lista promete: recencia de la DECISIÓN. Con el
    // orden por `creado_en`, decidir una propuesta antigua no la hacía aparecer —quedaba
    // detrás de cincuenta decisiones de propuestas más nuevas— y el revisor no veía lo que
    // acababa de hacer. El sello lo pone el guard, así que es dato de la base y no del
    // caller.
    const decididas = await tx`select ${columnas} ${origen}
      where p.workspace_id = ${workspaceId} and p.estado <> 'propuesta'
      order by p.revisada_en desc, p.id desc
      limit ${DECIDIDAS_RECIENTES + 1}`;

    // Anclas ofrecibles a la generación. Un ancla que ya tiene propuesta pendiente no se
    // vuelve a ofrecer —da igual que sea item o reto—: pedir otra quemaría presupuesto sobre
    // algo que ya espera revisión humana. Los items que exigen consentimiento o no traen
    // material se ofrecen igual, MARCADOS: la pantalla explica qué falta, que es más útil
    // que esconderlos sin decir por qué.
    //
    // Orden FIFO y una fila de más para saber si se recortó. Pero el orden por sí solo no
    // basta: lo que hace que la ventana AVANCE es que las anclas salgan del conjunto
    // elegible al trabajarlas. En los items eso ocurre al curarlos; un reto, en cambio, no
    // cambia de estado por generarle criterios, así que sin la exclusión por propuesta
    // pendiente los mismos 50 primeros se quedaban ahí para siempre y los demás no había
    // forma de alcanzarlos. Y como ningún orden alcanza cuando hay más anclas que ventana,
    // la búsqueda por texto es lo que vuelve la promesa incondicional: cualquier ancla se
    // alcanza por su nombre sin depender de dónde caiga el corte.
    const patron = busqueda ? patronDeBusqueda(busqueda) : null;

    // Y las candidatas las pide CADA CAPACIDAD con SU consulta de elegibilidad, no la columna
    // donde cuelgan. Indexado por columna, una segunda capacidad anclada en un reto recibía la
    // lista de C0 —que excluye los retos con criterios congelados—, así que una generación
    // suya perfectamente válida después del G0 se quedaba sin ancla que ofrecer, y sin que
    // faltara ninguna entrada que el compilador echara de menos.
    //
    // Se pide una plaza de más para saber si el corte dejó algo fuera, y el corte se DICE. La
    // cola puede además decirlo ELLA —C5 lo hace, porque filtra por algo que su `limit` no
    // sabe—, así que los dos se suman: la de más que sobra, o el aviso de la cola.
    const candidatas = Object.fromEntries(
      await Promise.all(
        CAPACIDADES_ACTIVAS.map(async (k) => {
          const { lista, hayMas } = await CAPACIDAD_EN_EL_PANEL[k].candidatas(
            tx,
            workspaceId,
            patron,
            PAGINA_ANCLAS + 1,
          );
          return [
            k,
            {
              lista: lista.slice(0, PAGINA_ANCLAS),
              hayMas: hayMas || lista.length > PAGINA_ANCLAS,
            },
          ] as const;
        }),
      ),
    ) as PanelPropuestas['candidatas'];

    // Material de personas del workspace, con el estado de su consentimiento VIGENTE. Es
    // una lista aparte de las anclas ofrecibles a propósito: el consentimiento no es un
    // paso de la generación sino un hecho de la investigación que se registra cuando
    // ocurre. Colgado del selector de generación, un item con permiso vigente no mostraba
    // formulario (no le falta nada) y uno con propuesta pendiente ni siquiera aparecía en
    // el selector — así que la revocación, que el servicio y la bitácora admiten, no tenía
    // por dónde entrar en el producto.
    const personas = await tx`
      select i.id, i.titulo, i.estado,
             consentimiento_externo_vigente(i.id, i.workspace_id) as autoriza_externo,
             (select c.version from consentimiento_item c
               where c.item_id = i.id and c.workspace_id = i.workspace_id
               order by c.version desc limit 1) as version
      from item_importacion i
      where i.workspace_id = ${workspaceId}
        and tipo_fuente_exige_consentimiento(i.tipo_fuente)
        and (${patron}::text is null or i.titulo ilike ${patron})
      order by i.creado_en asc, i.id asc
      limit ${PAGINA_ANCLAS + 1}`;
    return {
      workspaceId,
      ai: {
        disponible: ai.disponible,
        motivo: ai.motivo,
        modelo: ai.modelo,
        llamadasHoy: ai.llamadasHoy,
        limiteDiario: ai.limiteDiario,
        proveedorResponde: ai.proveedorResponde,
        advertencia: ai.advertencia,
      },
      pendientes: pendientes.slice(0, PAGINA_PENDIENTES).map(filaDePanel),
      decididas: decididas.slice(0, DECIDIDAS_RECIENTES).map(filaDePanel),
      hayMasPendientes: pendientes.length > PAGINA_PENDIENTES,
      totalPendientes: Number(conteo!.n),
      respaldo: {
        aceptadas: (respaldo?.aceptadas ?? 0) as number,
        corregidas: (respaldo?.corregidas ?? 0) as number,
        rechazadas: (respaldo?.rechazadas ?? 0) as number,
      },
      hayMasDecididas: decididas.length > DECIDIDAS_RECIENTES,
      candidatas,
      materialDePersonas: personas.slice(0, PAGINA_ANCLAS).map((p) => ({
        id: p.id as string,
        titulo: p.titulo as string,
        curado: (p.estado as string) !== 'pendiente',
        autorizaExterno: p.autoriza_externo as boolean,
        version: p.version === null ? null : Number(p.version),
      })),
      hayMasMaterial: personas.length > PAGINA_ANCLAS,
      busqueda,
    };
  }, { aislamiento: 'repeatable read' });
}

type Alcance = {
  sistema: string;
  usuario: string;
  alcanceResumen: string;
  origenKey: OrigenKey;
  key: string;
  /** Hueco del presupuesto apartado para esta generación: se consume al persistir y se
   * libera si la generación no llega a nacer. */
  reservaId: string;
  unidades: number;
  /** La huella del material que `PREPARAR` le enseñó al modelo. Ver `Preparacion`. */
  huellaMaterial?: string;
  /** Los ids de la evidencia de ese material. Ver `Preparacion`. */
  evidenciaDelMaterial?: string[];
};

/**
 * Lee el alcance delimitado del ancla, comprueba que se PUEDA procesar (capacidad
 * encendida, consentimiento registrado si el material es de personas) y aparta el hueco
 * del presupuesto.
 *
 * Deliberadamente en su propia transacción, corta: la llamada al proveedor ocurre FUERA
 * de cualquier transacción — un tercero lento no puede retener una conexión de la base.
 * Justo por eso el chequeo del presupuesto no bastaba: entre este commit y el insert
 * final pasa la llamada entera, y sin dejar nada apartado todos los curadores que miran
 * a la vez ven el mismo hueco libre.
 */
async function prepararAlcance(actorId: string, entrada: GenerarPropuestas): Promise<Alcance> {
  const unidades = INTENTOS_POR_GENERACION;
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId);

    const { keyWorkspace, keyEntorno } = credencialesAI();
    /*
     * La puerta del consentimiento la abre la DECLARACIÓN, no la entrada de cada capacidad. Y
     * se parte en dos porque el orden de los CANDADOS y el orden de los MENSAJES responden a
     * preguntas distintas:
     *
     * - El CANDADO va primero, siempre. Leer el consentimiento y apartar la reserva tienen que
     *   ser atómicos respecto a `registrarConsentimiento`, o una revocación se cuela entre
     *   ambos. Y antes del candado del presupuesto, que es el orden de la casa.
     * - El MENSAJE va donde el usuario pueda ACTUAR. Con la comprobación delante de `PREPARAR`
     *   —como la puse al centralizar la puerta—, una petición rancia contra un item ya curado
     *   recibía «registra el consentimiento»: una instrucción que no lleva a ninguna parte,
     *   porque después de registrarlo el item sigue curado y la generación falla igual. Lo
     *   cazó una revisión. La elegibilidad del ancla es lo primero que hay que poder arreglar,
     *   así que habla primero.
     *
     * Lo que NO cambia: el material no sale hacia el proveedor. `prepararAlcance` solo
     * construye el prompt en memoria dentro de esta transacción, y si el consentimiento falta
     * se aborta antes de que exista una reserva, una llamada o una propuesta.
     */
    const exigeConsentimiento = CAPACIDADES[entrada.capacidad].exigeConsentimiento;
    const consentimiento = exigeConsentimiento
      ? await leerConsentimientoBajoCandado(tx, entrada)
      : null;
    const { sistema, prompt, huellaMaterial, evidenciaDelMaterial } =
      await PREPARAR[entrada.capacidad](tx, entrada);
    if (consentimiento?.falta) {
      throw new ErrorAI(MOTIVO_SIN_CONSENTIMIENTO['antes-de-preparar']);
    }

    // ── Reserva del hueco, bajo candado del workspace ──
    await bloquearPresupuesto(tx, entrada.workspaceId);
    // Recolección de basura de reservas caducadas (proceso muerto a mitad de llamada):
    // bajo el mismo candado, así que limpiar y apartar son atómicos entre sí.
    await tx`delete from reserva_ai
      where workspace_id = ${entrada.workspaceId}
        and creado_en <= now() - reserva_ai_ventana()`;

    // Exclusión por (CAPACIDAD, ANCLA): dos curadores no pueden tener a la vez una generación
    // en vuelo sobre el mismo trabajo. Para C0 esto faltaba —la reserva no guardaba el reto,
    // así que no excluía nada— y dos lotes podían despacharse a la vez sobre el mismo reto: se
    // pagaba dos veces y quedaban dos lotes pendientes sobre un ancla que la pantalla ofrece
    // una sola vez. Los dos caminos toman el MISMO candado (el del presupuesto del workspace)
    // antes de mirar, que es lo que hace que mirar sirva.
    //
    // Y la capacidad entra en la clave desde que dos de ellas comparten el reto: sin ella, una
    // generación de C0 en vuelo impedía pedir insights del mismo reto —y al revés—, que es
    // decir que pedir criterios y pedir insights son el mismo trabajo. No lo son: son
    // pipelines independientes con sus propias puertas, y la cola del panel ya los ofrece por
    // separado. La misma corrección va en los índices que lo imponen.
    const ancla = CAPACIDADES[entrada.capacidad].ancla;
    const [enCurso] = await tx`select 1 as hay from reserva_ai
      where workspace_id = ${entrada.workspaceId} and capacidad = ${entrada.capacidad}
        and ${tx(ancla.columna)} = ${entrada.anclaId}`;
    if (enCurso) throw new ErrorAI(ancla.enCurso);

    // «Este ancla ya tiene trabajo esperando revisión» se pregunta AQUÍ, bajo el mismo
    // candado, y no antes de tomarlo. Fuera del candado la respuesta caduca al instante: la
    // generación anterior persiste su lote en otra transacción, así que una segunda podía
    // leer «no hay nada pendiente», esperar a que la primera terminara —soltando su
    // reserva— y colar un segundo lote sobre la misma ancla. Dentro del candado las dos
    // señales se leen juntas: o está la reserva viva de la otra, o están sus propuestas.
    // Para CI el índice único parcial de `propuesta_ai` es además el suelo; para C0 no puede
    // haberlo (un lote son varias propuestas pendientes del mismo reto), así que aquí es
    // donde se decide.
    const [pendiente] = await tx`select 1 as hay from propuesta_ai
      where ${tx(ancla.columna)} = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
        and capacidad = ${entrada.capacidad} and estado = 'propuesta' limit 1`;
    if (pendiente) throw new ErrorAI(ancla.pendiente);

    const { atendidas, reservadas, limiteDiario, ultimaCaidaHaceMs } = await presupuestoDeHoy(
      tx,
      entrada.workspaceId,
    );
    const ai = evaluarCapacidadAI({
      keyWorkspace,
      keyEntorno,
      llamadasHoy: atendidas,
      reservadas,
      limiteDiario,
      unidades,
      ultimaCaidaHaceMs,
    });
    // La admisión mira `disponible` —credencial y presupuesto—, y NO `proveedorResponde`, a
    // propósito y no por descuido. Una caída observada es pasado: lo único que averigua si
    // el tercero volvió es llamarlo otra vez, así que cerrar la puerta aquí dejaría al
    // workspace sin forma de comprobarlo hasta que venciera la ventana —el interruptor
    // pegado, otra vez, con otra cara—. El panel avisa; quien insiste, prueba.
    if (!ai.disponible || !ai.origenKey) throw new ErrorAI(ai.motivo);
    const key = (ai.origenKey === 'workspace' ? keyWorkspace : keyEntorno)!;

    let reserva;
    const anclas = anclasDelInsert(tx, entrada);
    try {
      [reserva] = await tx`insert into reserva_ai
        (workspace_id, capacidad, ${anclas.columnas}, unidades, creado_por)
        values (${entrada.workspaceId}, ${entrada.capacidad}, ${anclas.valores},
                ${unidades}, ${actorId})
        returning id`;
    } catch (e) {
      // Los índices únicos parciales de la reserva (uno por item, otro por reto): el candado
      // ya serializa a los curadores, así que aquí solo se llega por un camino que no pasara
      // por él. Son el suelo de la exclusión, no su mecanismo.
      if ((e as { code?: string }).code === '23505') {
        throw new ErrorAI(
          'Ese ancla ya tiene una generación AI en curso: espera a que termine',
        );
      }
      throw e;
    }

    return {
      sistema,
      usuario: prompt.usuario,
      alcanceResumen: prompt.alcanceResumen,
      origenKey: ai.origenKey,
      key,
      reservaId: reserva!.id as string,
      unidades,
      huellaMaterial,
      evidenciaDelMaterial,
    };
  });
}

/** Retira la reserva cuando la generación no llegó a persistir. Ojo con lo que esto ES y
 * lo que ya NO es: no devuelve presupuesto —lo que se llegó a pagar quedó anotado en
 * `llamada_ai` y cuenta para todos—, solo declara que esa ancla ya no tiene una generación
 * en vuelo, para no obligar a esperar a que caduque antes de reintentar. Idempotente. */
async function liberarReserva(
  actorId: string,
  workspaceId: string,
  reservaId: string,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    // Tampoco exige cuenta activa, por lo mismo: soltar el hueco de una generación que ya
    // terminó no es actuar, y dejarlo colgado hasta que caduque bloquearía el ancla y
    // abultaría el presupuesto en vuelo por una desactivación a destiempo. La política de
    // DELETE sigue exigiendo rol curador y que la reserva sea suya.
    await bloquearPresupuesto(tx, workspaceId);
    await tx`delete from reserva_ai where id = ${reservaId} and workspace_id = ${workspaceId}`;
  });
}

/**
 * INVENTARIO DE PRECONDICIONES. `prepararAlcance` comprueba y commitea; la llamada al
 * proveedor ocurre después y fuera de transacción (a propósito: un tercero lento no puede
 * retener una conexión). Por tanto TODO lo que comprueba queda obsoleto en cuanto commitea,
 * y cada precondición necesita decir dónde se vuelve a exigir. Hay tres momentos y no son
 * intercambiables: antes de llamar evita el gasto; al persistir evita que nazca el objeto;
 * el guard es el suelo, para que el SQL directo tampoco pueda.
 *
 * Y una propuesta tiene DOS recorridos, no uno; por eso hay DOS tablas. El primero
 * —generar, despachar, persistir— termina en una fila pendiente y es el de aquí abajo. El
 * segundo —revisar, aceptar, materializar— empieza cuando un humano la mira, puede tardar
 * días y en ese hueco, mucho más ancho que el del despacho, las mismas precondiciones
 * vuelven a caducar: tiene su propia tabla al final, porque no basta con repetirla. Cambian
 * los momentos (ya no hay gasto que evitar, y en su lugar está el PANEL) y cambia lo que
 * está en juego: lo que nace ya no es una propuesta, es evidencia o son criterios.
 *
 * Y una cuarta columna que responde otra pregunta sobre la misma fila: **quién más escribe
 * ese dato y si comparte mecanismo de serialización**. Exigir un predicado en tres momentos
 * no lo vuelve un cerrojo — sigue siendo una foto—, así que hay que mirar las dos cosas.
 *
 *  | Precondición                  | Antes de llamar | Al persistir      | Suelo (base)        | Quién más lo escribe → cómo se serializa                    |
 *  |-------------------------------|-----------------|-------------------|---------------------|-------------------------------------------------------------|
 *  | Cuenta activa                 | sí              | sí                | — (es capa 2)       | auth/gobernanza → no hace falta⁶                             |
 *  | Rol curador                   | —¹              | —¹                | política de INSERT  | gobernanza → la política se evalúa EN la sentencia: sin ventana |
 *  | Credencial del proveedor      | resuelta ya²    | n/a               | n/a                 | el entorno → no es dato transaccional                        |
 *  | CI · item aún pendiente       | sí              | guard             | guard de INSERT     | curaduría manual y materialización → la fila⁷                |
 *  | CI · consentimiento vigente   | sí (con candado)| guard             | guard de INSERT     | `registrarConsentimiento` → candado por item, en los dos lados |
 *  | CI · material extraíble       | inmutable³      | guard             | guard de INSERT     | nadie: sin grant de UPDATE, no es carreable                  |
 *  | C0 · reto admite criterios    | sí              | guard             | guard de INSERT     | activación/cierre del reto → la fila⁷                        |
 *  | C0 · criterios no congelados  | sí              | guard             | guard de INSERT     | `aprobarGate` → la fila del gate⁷ (y `bloquearReto` en el lado que escribe criterios) |
 *  | Ancla sin generación en vuelo | sí (reserva)    | consume la reserva| índice único parcial| solo este módulo → candado del presupuesto, en los dos lados |
 *  | Ancla sin propuesta pendiente | —⁴              | CI: índice único  | CI: índice único    | solo este módulo → candado del presupuesto + índice único    |
 *  | Presupuesto                   | sí (reserva)    | no⁵               | —                   | solo este módulo → candado del presupuesto                   |
 *
 *  ¹ La política de INSERT de `propuesta_ai` lo exige en cada escritura: no hay ventana.
 *  ² La key viaja en el alcance; revocarla en el entorno solo afecta a generaciones futuras.
 *  ³ `contenido` no está en el grant de UPDATE de la bandeja: no puede cambiar bajo los pies.
 *  ⁴ Lo cubre la reserva, que es exclusiva por ancla y viva durante toda la llamada.
 *  ⁵ Deliberado: al persistir la llamada ya está pagada y negarse a guardar su salida solo
 *    tiraría lo comprado. El tope frena en la admisión y en el despacho.
 *  ⁶ Leer una cuenta recién desactivada solo permite terminar la operación en curso, y la
 *    doctrina ya está fijada: anotar un hecho consumado no pregunta por el permiso, actuar sí.
 *  ⁷ Estas tres no necesitan candado propio, y conviene decir por qué en vez de añadir uno:
 *    quien las escribe lo hace con un `update … where <estado esperado>`, que toma el candado
 *    de la fila, y en READ COMMITTED cada sentencia del guard ve lo ya commiteado. De ahí que
 *    solo queden dos desenlaces y los dos sean equivalentes a un orden serial: o la decisión
 *    ajena commitea antes y el guard la ve y rechaza la propuesta, o commitea después y la
 *    propuesta nació cuando el ancla todavía la admitía. Lo segundo NO es una violación —es
 *    «alguien decidió el ancla justo después», que puede pasar un segundo más tarde igual— y
 *    el panel ya lo reporta como obsoleta y solo rechazable. Un candado no eliminaría ese
 *    desenlace: solo elegiría cuál de los dos órdenes ocurre. El día que la promesa pase a
 *    ser de otro tipo («ninguna propuesta pendiente sobrevive al congelado»), el mecanismo
 *    ya está identificado: `for update` sobre los G0 en el mismo orden estable que usa
 *    `criterio_g0_pendiente_guard`, y el candado de reto que ese módulo documenta.
 *
 * SEGUNDO RECORRIDO (revisar → aceptar → materializar). Las mismas precondiciones con otro
 * reloj. El momento «antes de llamar» no existe aquí —no hay gasto que evitar— y lo ocupa
 * el PANEL, que es donde se decide si la acción llega a ofrecerse; «al materializar» es el
 * servicio, y el suelo sigue siendo la base:
 *
 *  | Precondición                  | En el panel (`anclaEstado`)  | Al materializar             | Suelo (base)                 |
 *  |-------------------------------|------------------------------|-----------------------------|------------------------------|
 *  | Cuenta activa                 | sin ella no hay panel        | sí                          | — (es capa 2)                |
 *  | Rol curador                   | sí, por `puedeRevisar`       | sí (`rolCurador`)           | política de UPDATE           |
 *  | Propuesta aún pendiente       | la separa de las decididas   | sí⁸                         | USING + guard de revisión    |
 *  | CI · item aún pendiente       | `item-curado`                | sí⁹                         | guard de materialización¹⁰   |
 *  | CI · consentimiento vigente   | `consentimiento-revocado`    | sí, con candado por item    | los DOS guards¹⁵             |
 *  | CI · citas intactas           | no aplica: es la corrección  | sí, contra el original      | guard de revisión            |
 *  | C0 · criterios no congelados  | `criterios-congelados`¹⁶     | sí, al insertar¹¹           | política de `criterio_exito` |
 *  | C0 · reto admite criterios    | `reto-no-admite`             | sí (`materializarCriterio`) | guard de materialización¹⁰   |
 *
 * ¹⁶ Dos valores, no uno: el congelado tiene dos causas con salidas distintas —el G0, que
 * la reapertura de la etapa 0 revierte, y el registry firmado, que no se revierte— así que
 * el panel las nombra por separado (`criterios-congelados` y `registry-firmado`). La fila es
 * una porque la precondición es una: la política de `criterio_exito` las junta en
 * `reto_criterios_congelados`.
 *
 * La columna del panel no es cosmética y tampoco es un cuarto sitio donde repetir lo mismo:
 * los valores de `anclaEstado` distintos de `disponible` SON exactamente las filas de esta
 * tabla que pueden caducar sin que el revisor haga nada. Por eso es un enum y no un
 * booleano —un botón apagado sin decir por qué es la mitad del arreglo—, y por eso añadir
 * una precondición de este bloque obliga a añadirle su motivo: si la base la rechaza y el
 * panel la sigue ofreciendo, el revisor descubre el problema con el error.
 *
 * La ASIMETRÍA que sostiene la tabla entera: **rechazar sigue abierto siempre**. Ninguna de
 * estas filas alcanza al rechazo — ni en el servicio, que no materializa nada, ni en los
 * guards, que salen temprano cuando el estado nuevo no es `aceptada`/`corregida`. Rechazar
 * ES la salida de una propuesta obsoleta: si el bloqueo la alcanzara, la fila quedaría
 * muerta —ni materializable ni cerrable— y encima reteniendo su ancla, que no se vuelve a
 * ofrecer mientras tenga una propuesta pendiente. El ancla quedaría inutilizable para
 * siempre por una precondición que solo pretendía proteger lo que nace.
 *
 * Las CINCO filas del primer recorrido que NO reaparecen en esta tabla, una por una y con
 * su razón — un inventario que pierde filas al cambiar de tabla deja de servir para
 * comprobar nada, y «no la puse» y «no aplica» se leen igual desde fuera:
 *
 *  · **Presupuesto** y **credencial del proveedor**: aceptar no gasta nada en el proveedor
 *    —el dinero se fue en el primer recorrido—, así que atarlo al tope cobraría dos veces
 *    la misma llamada y dejaría propuestas ya pagadas sin poder materializarse por una
 *    cuota que su generación ya respetó.
 *  · **CI · material extraíble**: no puede caducar. `contenido` no está en el grant de
 *    UPDATE de la bandeja (nota ³), así que el material que el modelo leyó sigue ahí
 *    palabra por palabra — y es justo contra él contra lo que se miden las citas al
 *    aceptar, así que re-exigirlo sería preguntar dos veces lo mismo.
 *  · **Ancla sin generación en vuelo**: la reserva es el token que autoriza DESPACHAR, y
 *    aquí no se despacha nada. Tampoco puede haber una viva: un ancla con propuesta
 *    pendiente no se vuelve a ofrecer para generar, así que ninguna reserva nueva nace
 *    sobre ella mientras esta propuesta espera revisión.
 *  · **Ancla sin propuesta pendiente**: no es precondición de aceptar, es su CONSECUENCIA
 *    —la propuesta deja de estar pendiente en cuanto se decide— y es lo que devuelve el
 *    ancla a la circulación. De ahí que bloquear el rechazo saliera tan caro: es la única
 *    salida que queda cuando aceptar ya no puede, y sin ella el ancla no vuelve nunca.
 *
 * Y las dos filas que solo existen aquí —**propuesta aún pendiente** y **citas intactas**—
 * no tienen contrapartida arriba por la razón simétrica: en el primer recorrido la
 * propuesta todavía no existe y las citas se están escribiendo, no comprobando.
 *
 *  ⁸ Dos veces y a propósito: `leerParaRevisar` para dar un error con nombre, y el
 *    `where estado = 'propuesta'` del UPDATE que sella, que es el que decide de verdad
 *    cuando dos revisores llegan a la vez.
 *  ⁹ Igual que arriba: la lectura da el mensaje y el `where estado = 'pendiente'` del
 *    update que sella el item es el que arbitra; si otro lo curó a mano, 0 filas y la
 *    transacción entera se revierte, evidencia incluida.
 * ¹⁰ Constraint trigger DIFERIDO al commit, no inmediato: el servicio materializa y sella
 *    en sentencias posteriores de la misma transacción, así que un guard inmediato vería un
 *    estado a medias. Que corra al commit es además lo que lo vuelve suelo real para este
 *    recorrido: comprueba el estado del ancla en el ÚLTIMO instante posible.
 * ¹⁵ Hacen falta los dos y no es redundancia. El de revisión es BEFORE UPDATE: su snapshot
 *    es el de la sentencia que sella, así que no ve una revocación que commitee después de
 *    ella y antes del commit de la aceptación — la evidencia entraba con la revocación ya
 *    vigente. El de materialización corre en el COMMIT y sí la ve. Y el servicio toma además
 *    el mismo candado por item que `registrarConsentimiento`, que no es lo que cierra la
 *    ventana (el SQL directo no lo pide) sino lo que hace el orden determinista y deja que el
 *    revisor reciba el error con nombre en vez del rechazo del suelo.
 * ¹¹ No se lee antes de insertar, y es deliberado: la política y `criterio_g0_pendiente_guard`
 *    ya lo dicen en la propia sentencia, sin ventana. El servicio solo traduce el 42501 y el
 *    P0001 a un mensaje que el revisor entiende. El estado del reto, en cambio, SÍ se lee
 *    antes: ninguna política de `criterio_exito` lo mira, así que sin esa lectura no habría
 *    quien lo dijera.
 *
 * PROCEDENCIA DE LO QUE NACE AL ACEPTAR. Las dos tablas de arriba responden «¿sigue
 * valiendo la precondición?». Esta responde otra que no se deduce de aquella: de cada cosa
 * que la aceptación produce, **qué demuestra que nació de ESTA propuesta** — y no que existe
 * algo con la forma correcta. La diferencia no es retórica: un PREDICADO lo satisface
 * cualquier objeto que dé la talla, incluido uno hecho a mano antes; una PROCEDENCIA solo la
 * satisface el que salió de aquí. Lo que se protege es la atribución, de la que viven el
 * rastro de quién produjo qué (SPEC-08) y la tasa de corrección humana (SPEC-09):
 *
 *  | Lo que nace al aceptar        | Cómo queda atado a la propuesta      | Qué lo DEMUESTRA                          |
 *  |-------------------------------|--------------------------------------|-------------------------------------------|
 *  | `evidencia` (CI)              | `evidencia_id`, FK compuesta         | `xmin` = la transacción que acepta¹², único|
 *  |                               |                                      | por workspace, y el item sellado con ESA   |
 *  |                               |                                      | evidencia y por quien aceptó (SYS-16)      |
 *  | `criterio_exito` (C0)         | `criterio_id`, FK compuesta          | lo mismo: `xmin`, único, y cuelga del reto |
 *  |                               |                                      | de la propuesta firmado por quien aceptó   |
 *  | sello de `item_importacion`   | `evidencia_id` + `decidido_por`      | el guard los compara con los de la fila    |
 *  | `fuente` (CI)                 | ninguna, y no hace falta             | cuelga de la evidencia, que sí está atada¹³|
 *  | evento `PropuestaAIAceptada`  | —                                    | lo emite el GUARD: no se puede aceptar sin |
 *  | / `Corregida` / `Rechazada`   |                                      | emitirlo ni emitirlo sin aceptar           |
 *  | evento `CriterioDefinido`     | —                                    | igual, desde `criterio_g0_pendiente_guard` |
 *  | evento `EvidenciaCurada`      | `payload.origen = 'propuesta-ai'`    | **nada: lo escribe el servicio**¹⁴         |
 *
 * ¹² `xmin` es la transacción que insertó la fila, y el guard de materialización corre
 *    DIFERIDO — todavía dentro de la transacción que acepta—, así que `pg_current_xact_id()`
 *    es la suya. Coincidir es la prueba; no coincidir significa que ese objeto lo creó otro y
 *    esta propuesta se lo está apropiando. Vale como prueba porque aquí no hay subtransacciones
 *    (`conUsuario` abre una sola y nadie usa savepoints): con ellas, `xmin` sería el subxid.
 * ¹³ Atribuir la fuente sería atribuir dos veces el mismo hecho, y además no hay nada que
 *    proteger: una fuente no es una afirmación sobre el mundo, es de dónde salió la evidencia
 *    que sí lo es.
 * ¹⁴ Hueco conocido y acotado a propósito. `EvidenciaCurada` lo emiten los DOS caminos de
 *    curaduría —este y el manual de SPEC-06—, así que moverlo a un guard es cirugía en el
 *    slice de evidencia, no en este. Lo que hoy limita el daño: nadie LEE ese `origen` (es
 *    rastro de auditoría, no entrada de ningún cálculo), y la tasa de corrección humana no se
 *    computa de los eventos sino del reparto `aceptada`/`corregida` de `propuesta_ai`, que es
 *    justo lo que las filas de arriba acaban de atar. Si algún día alguien calcula sobre el
 *    evento, esta fila pasa a ser un defecto de verdad y hay que emitirlo desde un trigger.
 *
 * Última comprobación antes de que el material salga hacia el proveedor (RF-09.5).
 *
 * `prepararAlcance` commitea y solo DESPUÉS se despacha la llamada; en ese hueco cabe una
 * revocación de consentimiento, y el prompt ya construido viajaba igual. La bitácora
 * versionada es justo lo que hace ese caso alcanzable: un registro con
 * `procesamiento_externo = false` puede pasar a vigente ahí en medio.
 *
 * Recibe la TRANSACCIÓN en vez de abrir la suya, y ahí está la mitad que faltaba. Antes esto
 * commiteaba y después `abrirLlamada` abría otra transacción para anotar la línea: entre las
 * dos volvía a caber la misma revocación, y ni la FK del consentimiento ni el guard la
 * atrapaban —la versión citada sigue existiendo, solo ha dejado de ser la vigente, y el guard
 * únicamente exige que se cite alguna—. Así que el permiso se lee en la MISMA transacción que
 * abre el libro, que es la última que toca la base antes del despacho. Un candado no puede
 * llegar más cerca que eso.
 *
 * Y por eso lo invoca UNA sola vía. El respaldo de una degradación ya se re-autorizaba —«el
 * segundo despacho se autoriza otra vez, o no sale»—, pero el primario no: la misma regla
 * escrita para un intento y no para el otro. Con la comprobación dentro del apunte, y el
 * apunte antes de cada despacho, los dos intentos pasan por ella sin que nadie tenga que
 * acordarse.
 *
 * Qué se puede garantizar y qué no, dicho sin rodeos:
 *
 *  · **Sí**: que en el INSTANTE DEL DESPACHO el consentimiento vigente autoriza el
 *    procesamiento externo, y que el hueco de presupuesto sigue vivo. La lectura se hace
 *    bajo el MISMO candado por item que toma `registrarConsentimiento`, así que una
 *    revocación a medio commit no se lee a medias: o se espera a que termine y se ve, o
 *    todavía no había empezado. Y como la línea del libro nace en esa misma transacción, lo
 *    leído no puede quedarse viejo entre la comprobación y el apunte.
 *  · **No**: que una revocación que llegue mientras los bytes viajan alcance a la llamada.
 *    Ningún candado puede abarcar una petición HTTP fuera de transacción, y eso es
 *    deliberado — un tercero lento no puede retener una conexión de la base. Lo que sí
 *    ocurre en ese caso: la propia revocación retira la reserva, el guard de `propuesta_ai`
 *    lee el vigente y ninguna propuesta llega a nacer, y la llamada queda en el libro con
 *    su coste. El material que ya salió no se puede des-enviar, y la UI lo dice.
 */
async function comprobarDespacho(
  tx: TransactionSql,
  actorId: string,
  entrada: GenerarPropuestas,
  alcance: Alcance,
): Promise<number | null> {
  let versionConsentimiento: number | null = null;
  {
    await exigirCuentaActiva(tx, actorId);
    // La cuenta Y el rol. Comprobar solo la cuenta era media autorización: `prepararAlcance`
    // exige rol curador y commitea, así que entre aquel commit y este despacho cabe una
    // degradación a stakeholder — y quien deja de poder pedir propuestas deja de poder
    // despachar material a un tercero. La política de inserción lo rechazaría de todos modos
    // (es el suelo, y sigue estando), pero un 42501 llega aquí sin nada que decirle a la
    // persona salvo «vuelve a intentarlo», que además es falso: reintentar no devuelve un rol.
    await rolCurador(tx, actorId, entrada.workspaceId);
    if (CAPACIDADES[entrada.capacidad].exigeConsentimiento) {
      versionConsentimiento = await exigirConsentimientoVigente(tx, entrada, 'antes-de-despachar');
    }
    await REVALIDAR[entrada.capacidad](tx, entrada, alcance.huellaMaterial);

    // El token de despacho: la reserva sigue existiendo y NO ha caducado. Una revocación la
    // retira, y una caducada dejó de contar para admitir a los demás — despachar con ella
    // sería gastar un hueco que otro ya tiene.
    const [reserva] = await tx`select 1 as hay from reserva_ai
      where id = ${alcance.reservaId} and workspace_id = ${entrada.workspaceId}
        and creado_en > now() - reserva_ai_ventana()`;
    if (!reserva) {
      throw new ErrorAI(
        'La reserva de presupuesto de esta generación ya no está vigente (se retiró o caducó): no se llamó al proveedor. Vuelve a pedirla.',
      );
    }
  }
  return versionConsentimiento;
}

/**
 * Forma canónica de un valor JSON: claves ordenadas en todo nivel. Compara por CONTENIDO dos
 * objetos que llegaron por caminos distintos —uno parseado por Zod, otro leído de `jsonb`—
 * sin heredar el orden de claves de ninguno de los dos. `JSON.stringify` a secas conserva el
 * orden de inserción, así que comparar así era comparar también por cómo se construyó cada
 * lado, que no es lo que se quiere saber.
 */
function canonico(valor: unknown): string {
  const ordenar = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordenar);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, ordenar(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(ordenar(valor));
}

/** Valida la salida cruda del proveedor contra el esquema de la capacidad. Una salida
 * fuera de contrato se descarta ENTERA: media propuesta no es revisable. */
function contenidosValidos(capacidad: CapacidadActiva, datos: unknown): ContenidoPropuesta[] {
  const contenido = ESQUEMA_DE_CONTENIDO[capacidad];
  const { lote } = CAPACIDADES[capacidad];
  // Sin lote, el objeto viene en la RAÍZ de la respuesta; con lote, dentro de su campo. No
  // es lo mismo que un lote de uno, y por eso se declara en vez de deducirse de la forma.
  if (lote === null) return [contenido.parse(datos)];
  const sobre = (datos ?? {}) as Record<string, unknown>;
  return contenido.array().min(lote.minimo).max(lote.maximo).parse(sobre[lote.campo]);
}

/**
 * Abre la línea del libro de costos para UN intento, ANTES de despacharlo (RF-09.14).
 *
 * Nace en `despachada`, que es el estado que significa «salió y su desenlace no consta». Si
 * este insert falla, `generarConProveedor` no despacha: no se gasta lo que no se puede
 * anotar.
 */
async function abrirLlamada(
  actorId: string,
  entrada: GenerarPropuestas,
  alcance: Alcance,
  modelo: string,
  puesto: number,
): Promise<ApunteDespacho> {
  try {
    const [fila] = await conUsuario(actorId, async (tx) => {
      // El permiso, en la MISMA transacción que abre la línea. La versión que se anota es la
      // que se acaba de leer bajo el candado, no una que llegó de fuera: entre leerla y
      // escribirla no hay commit por medio en el que pueda dejar de ser la vigente.
      const consentimientoVersion = await comprobarDespacho(tx, actorId, entrada, alcance);
      const anclas = anclasDelInsert(tx, entrada);
      return tx`insert into llamada_ai
        (workspace_id, capacidad, ${anclas.columnas}, modelo, origen_key, resultado,
         consentimiento_version, reserva_id, intento, creado_por)
        values (${entrada.workspaceId}, ${entrada.capacidad}, ${anclas.valores},
                ${modelo}, ${alcance.origenKey}, 'despachada',
                ${consentimientoVersion}, ${alcance.reservaId}, ${puesto}, ${actorId})
        returning id`;
    });
    return { ok: true, registroId: fila!.id as string };
  } catch (e) {
    // No se lanza: el adaptador no lanza nunca (SYS-21) y quien llama necesita el motivo, no
    // una excepción. Y sobre todo, el despacho NO ocurre — que es el punto entero.
    //
    // Pero un `catch` a secas mandaba «vuelve a intentarlo» para TODO, y no todo se arregla
    // reintentando: el permiso retirado, el guard con su P0001, y una FK o un CHECK rotos no
    // van a dejar de estarlo por insistir. Decirle a alguien que reintente lo que no puede
    // funcionar es peor que no decir nada, porque se lo cree. Mismo criterio que usa la
    // persistencia del lote.
    //
    // El primero es el motivo por el que NO se despacha casi siempre: el permiso se retiró, el
    // ancla se curó o la reserva caducó entre que se preparó la llamada y el momento de
    // sacarla. `comprobarDespacho` ya lo dice con las palabras que la persona necesita leer.
    if (e instanceof ErrorAI) return { ok: false, motivo: e.message };
    const err = e as { code?: string; message?: string };
    if (err.code === 'P0001' && typeof err.message === 'string' && err.message.length > 0) {
      return {
        ok: false,
        motivo: `${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}`,
      };
    }
    if (err.code === '23503' || err.code === '23514') {
      return {
        ok: false,
        motivo:
          'La línea del libro de costos de esta llamada no cumple las reglas del pipeline AI, así que no se despachó. No se arregla reintentando: revisa el consentimiento del material y el estado del ancla.',
      };
    }
    return {
      ok: false,
      motivo:
        'No se pudo abrir la línea del libro de costos para esta llamada, así que no se despachó. Vuelve a intentarlo; todo el flujo sigue disponible a mano.',
    };
  }
}

/**
 * Cierra las líneas que `abrirLlamada` dejó en `despachada`, cada una con su desenlace.
 *
 * Aquí es donde se escriben el uso y el coste, que es el único momento en que ese dato
 * existe: una negativa del proveedor y un JSON ilegible son respuestas completas y
 * facturadas, y antes de esto se perdían enteras porque el uso solo se guardaba colgado de
 * una propuesta que en esos casos no existe. Y son TODOS los intentos, no el último: una
 * degradación de modelo son dos llamadas, las dos ocurrieron y la del primario también falló
 * por algo. Con una sola fila, la tasa de error por modelo decía que el primario nunca falla
 * y su latencia acababa sumada a la del respaldo.
 *
 * Transacción propia —todas las líneas se cierran o no se cierra ninguna— y ANTES de
 * persistir el lote: si el guardado falla después, el gasto ya consta. Devuelve el id de la
 * salida válida, que es el que las propuestas referencian, así que ninguna puede existir sin
 * su línea de gasto.
 *
 * Si ESTO falla, ya no se pierde nada esencial: las filas se quedan en `despachada`, siguen
 * contando para el tope y conservan ancla, modelo, credencial y consentimiento. Lo único que
 * se pierde es el detalle del desenlace — que es exactamente el cambio de esta migración: el
 * fallo pasó de «desaparece una llamada pagada» a «una llamada pagada consta con menos
 * detalle».
 */
async function cerrarLlamadas(
  actorId: string,
  intentos: IntentoProveedor[],
): Promise<{ idSalidaValida: string | null }> {
  if (intentos.length === 0) return { idSalidaValida: null };
  return conUsuario(actorId, async (tx) => {
    // SIN `exigirCuentaActiva`, y es la única función del módulo que se lo salta a
    // propósito. Anotar lo que pasó y autorizar lo que viene son dos preguntas distintas: la
    // cuenta activa responde a la segunda —«¿puede esta persona actuar ahora?»— y aquí no se
    // actúa, se cierra un hecho consumado. Si la cuenta se desactiva con la llamada en vuelo,
    // el proveedor ya respondió y quizá ya facturó.
    //
    // Lo que la política de completar exige es AUTORÍA y MEMBRESÍA, no rol — y no es un
    // descuido suyo sino el mismo razonamiento llevado hasta el final: pedir rol convertía una
    // degradación a mitad de llamada en una línea `despachada` para siempre, sin desenlace ni
    // coste. Lo que queda ata lo que hay que atar: la línea la cierra quien la abrió, y solo
    // dentro del workspace al que pertenece.
    let idSalidaValida: string | null = null;
    for (const intento of intentos) {
      const cerradas = await tx`update llamada_ai set
          resultado = ${intento.resultado},
          motivo = ${intento.motivo.slice(0, 500)},
          tokens_entrada = ${intento.uso?.entrada ?? null},
          tokens_salida = ${intento.uso?.salida ?? null},
          costo_usd = ${intento.uso?.costoUsd ?? null},
          latencia_ms = ${intento.latenciaMs}
        where id = ${intento.registroId}
        returning id`;
      // La política de completar FILTRA en vez de rechazar, así que un cierre que no alcanza
      // su fila sale sin error y con cero filas tocadas. Sin esta comprobación, eso pasaba
      // por un cierre bueno: la propuesta se persistía apuntando a una línea que seguía
      // `despachada`, sin coste ni latencia, y el panel la mostraba así para siempre.
      if (cerradas.length !== 1) {
        throw new ErrorAI(
          'No se pudo cerrar la línea del libro de costos de esta llamada, así que la generación se descarta. La llamada queda anotada como despachada y cuenta para el presupuesto.',
        );
      }
      // El id que las propuestas referencian se busca por su RESULTADO, no por su posición:
      // como mucho hay un intento con salida válida (el bucle del adaptador para en el
      // primero que la da).
      if (intento.resultado === 'salida-valida') idSalidaValida = intento.registroId;
    }
    return { idSalidaValida };
  });
}

/**
 * Cierra las líneas de una generación que acabó SIN propuesta, sin dejar que un fallo del
 * cierre tape el motivo del proveedor — que es el que la persona necesita leer— y sin
 * tragárselo.
 *
 * Un `catch` vacío costaba la única señal de que algo quedó a medias: la fila se queda en
 * `despachada` indefinidamente, el trigger no llega a emitir `LlamadaAISinPropuesta` y en el
 * repositorio no hay ninguna ruta de reconciliación que las recoja después. O sea que el
 * momento en que el fallo se conoce era el único, y se descartaba.
 *
 * No se le añade al mensaje de la persona: el motivo del proveedor es lo que explica lo que
 * pasó, y un detalle de la base no la ayuda a decidir. Va al registro del servidor, con el
 * workspace y los ids de las líneas, que es lo que hace falta para encontrarlas.
 */
async function cerrarSinTaparElMotivo(
  actorId: string,
  entrada: GenerarPropuestas,
  intentos: IntentoProveedor[],
): Promise<void> {
  try {
    await cerrarLlamadas(actorId, intentos);
  } catch (e) {
    console.error(
      '[ai] no se pudieron cerrar las líneas del libro de costos de una generación sin ' +
        `propuesta (workspace ${entrada.workspaceId}, líneas ` +
        `${intentos.map((i) => i.registroId).join(', ')}): quedan en «despachada», cuentan ` +
        `para el tope y no llevan su desenlace. Causa: ${(e as Error).message}`,
    );
  }
}

/**
 * El ancla de esta generación, o `null`, para la columna que se está escribiendo.
 *
 * Las tres tablas del pipeline —`reserva_ai`, `llamada_ai` y `propuesta_ai`— guardan el
 * ancla en una columna POR TIPO de ancla, así que cada insert escribe una y anula la otra.
 * Escrito a mano eso eran ocho ternarios sobre el nombre de la capacidad, y cada uno de
 * ellos una oportunidad de que la tercera capacidad colgara del sitio equivocado. Aquí se
 * pregunta por la columna que el registro DECLARA.
 */
function anclaEnColumna(
  entrada: GenerarPropuestas,
  columna: AnclaCapacidad['columna'],
): string | null {
  return CAPACIDADES[entrada.capacidad].ancla.columna === columna ? entrada.anclaId : null;
}

/**
 * Las columnas de ancla de los tres inserts del pipeline —`reserva_ai`, `llamada_ai` y
 * `propuesta_ai`— y sus valores, EN EL MISMO ORDEN, generados desde `COLUMNAS_DE_ANCLA`.
 *
 * Aquí hubo un guardián que no guardaba. Los tres inserts nombraban `item_id, reto_id` a
 * mano, y para que una tercera columna no se quedara fuera se declaró un
 * `Record<AnclaCapacidad['columna'], 'escrita'>`… derivado de `COLUMNAS_DE_ANCLA` con un
 * `Object.fromEntries`. Un Record construido a partir de las claves del propio tipo lo
 * satisface SIEMPRE: ampliar el ancla seguía compilando, el guardián seguía verde y los tres
 * inserts seguían escribiendo dos columnas de tres. Costaba una línea de tipo y no sujetaba
 * nada — un testigo que firma lo que sea.
 *
 * Un guardián sobre una sentencia escrita a mano solo puede avisar; la sentencia GENERADA no
 * necesita aviso porque no puede quedarse atrás. Añadir una columna al ancla la mete en los
 * tres inserts sin tocarlos, que es lo que el guardián pedía por favor.
 */
function anclasDelInsert(
  tx: TransactionSql,
  entrada: GenerarPropuestas,
): { columnas: PendingQuery<Row[]>; valores: PendingQuery<Row[]> } {
  return {
    columnas: COLUMNAS_DE_ANCLA.map((c) => tx`${tx(c)}`).reduce((a, b) => tx`${a}, ${b}`),
    valores: COLUMNAS_DE_ANCLA.map((c) => tx`${anclaEnColumna(entrada, c)}`).reduce(
      (a, b) => tx`${a}, ${b}`,
    ),
  };
}

/**
 * Lo que cada capacidad vuelve a comprobar JUSTO ANTES de despachar, bajo el candado y en la
 * misma transacción que aprueba la llamada. Devuelve la versión de consentimiento que ampara
 * la salida, o `null` cuando no aplica.
 *
 * Esto era un `if/else` sobre `exigeConsentimiento`, y eso es la misma rama binaria de antes
 * con otro sombrero: toda capacidad que exigiera consentimiento se buscaba como
 * `item_importacion` y toda la que no, como `reto` — con sus reglas de congelado encima. Una
 * capacidad nueva podía declararse entera en `CAPACIDADES` y en `PREPARAR` y aun así ver su
 * llamada rechazada aquí, porque su ancla se buscaba en la tabla equivocada. Lo encontró una
 * revisión sobre este mismo PR, y es justo el defecto que el PR viene a quitar: quitar la
 * SINTAXIS de la rama binaria no basta si su SEMÁNTICA sobrevive en un booleano.
 *
 * `Record<CapacidadActiva, …>` hace que el compilador exija la entrada de toda capacidad
 * nueva, que es la diferencia entre declarar y ramificar.
 */
/**
 * El material de C2, leído y resumido en su huella, con los CANDADOS que hacen de eso una
 * garantía y no una foto. Una sola redacción porque la miran TRES sitios —preparar, revalidar
 * antes de despachar y comprobar antes de persistir— y este PR ya lleva varias rondas cuyo
 * hallazgo era «dos redacciones hermanas del mismo protocolo divergieron».
 *
 * Los candados, en el orden del sistema:
 *   · `designio:workspace:` en compartido, que es el que toma el guard de congelación en toda
 *     escritura y por tanto el primero del par. Aquí no hace falta para nada más: va delante
 *     para no crear un segundo orden.
 *   · `designio:reto:` por CLAVE, que es lo único que cubre una evidencia enlazada EN VUELO —
 *     `for share` bloquea filas que existen, y un enlace sin commitear no está en ninguna—.
 *   · `for share` sobre la fila del reto y sobre los `derecho_uso` de su evidencia, que es lo
 *     que ordena las revocaciones y los archivados ya commiteados.
 */
async function huellaDelMaterialDeInsights(
  tx: TransactionSql,
  entrada: GenerarPropuestas,
): Promise<{
  huella: string;
  reto: { codigo: string; titulo: string; descripcion: string } | null;
  /** El título del primer documento del reto cuyo derecho de cita NO aguanta hasta el sello —vence
   * hoy o antes—, o `null` si ninguno. Ver la nota del calendario. */
  caducada: string | null;
}> {
  await tx`select pg_advisory_xact_lock_shared(
    hashtextextended('designio:workspace:' || ${entrada.workspaceId}, 42))`;
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:reto:' || ${entrada.anclaId}, 42))`;
  await tx`select 1 from reto
    where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
    for share`;
  const [reto] = await tx`select estado = 'archivado' as archivado, codigo, titulo, descripcion
    from reto where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}`;
  if (!reto || (reto.archivado as boolean)) return { huella: '', reto: null, caducada: null };
  await tx`select du.evidencia_id
    from derecho_uso du
    where du.workspace_id = ${entrada.workspaceId}
      and du.evidencia_id in (
        select ae.evidencia_id
        from arquetipo a
        join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
        where a.reto_id = ${entrada.anclaId} and a.workspace_id = ${entrada.workspaceId})
    order by du.evidencia_id
    for share`;
  const evidencia = await tx`select distinct e.id, e.titulo, e.resumen
    from arquetipo a
    join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
    join evidencia e on e.id = ae.evidencia_id and e.workspace_id = ae.workspace_id
    where a.reto_id = ${entrada.anclaId} and a.workspace_id = ${entrada.workspaceId}
      and evidencia_usable(e.id, e.workspace_id, 'cliente')
    order by e.titulo asc, e.id asc`;
  /*
   * Y el CALENDARIO, que es lo único de aquí que avanza SIN TOMAR NINGÚN CANDADO.
   *
   * Todo lo demás que puede invalidar el material —una revocación, un desenlace, un archivado—
   * lo escribe alguien, y por eso los candados de arriba lo ordenan. La caducidad llega sola.
   * `evidencia_usable` la mide con `current_date`, que es la fecha de INICIO de la transacción
   * y no avanza aunque la transacción espere (medido: tras dos segundos, `now()` y
   * `current_date` intactos, `clock_timestamp()` movido). Una transacción que empieza a las
   * 23:59 y despacha pasada la medianoche manda un documento cuyo permiso ya expiró.
   *
   * El margen NO es de medianoche: se pregunta por el día ENTERO. Un permiso que vence HOY no
   * llega vivo al final del camino —entre esta llamada y el sello hay un commit, la respuesta
   * del proveedor y una revisión humana, que no ocurre en el mismo minuto—, así que mañana la
   * aceptación fallaría con DR001 y quedaría una propuesta pagada, revisada y solo tirable. Con
   * el último día ya fuera, además, no queda medianoche que cruzar.
   *
   * La pregunta la contesta la BASE y no esta plantilla: el calendario de las garantías lo fija
   * ella (20260904220000), y preguntarlo desde aquí lo dejaría dependiendo del huso de quien
   * llama. Hay un censo que lo vigila, y cazó la primera versión de esto.
   *
   * `evidencia_usable` no se toca: es LA definición de «se puede usar», es STABLE a propósito
   * —las políticas de RLS la usan así— y para leer o citar hoy sigue siendo la correcta. Esto
   * es una pregunta distinta y más estricta, y solo puede errar en la dirección de no gastar.
   */
  const [caducada] = await tx`select derecho_del_reto_que_vence_ya(
    ${entrada.anclaId}, ${entrada.workspaceId}) as titulo`;
  return {
    caducada: (caducada?.titulo as string | undefined) ?? null,
    huella: huellaDelMaterial(
      materialDeInsights({
        codigo: reto.codigo as string,
        titulo: reto.titulo as string,
        descripcion: reto.descripcion as string,
        evidencia: evidencia.map((e) => ({
          id: e.id as string,
          titulo: e.titulo as string,
          resumen: e.resumen as string,
        })),
      }).texto,
    ),
    reto: {
      codigo: reto.codigo as string,
      titulo: reto.titulo as string,
      descripcion: reto.descripcion as string,
    },
  };
}

/**
 * El material de C6, leído y resumido en su huella, con los CANDADOS que hacen de eso una
 * garantía y no una foto. Una sola redacción porque la miran TRES sitios —preparar, revalidar
 * antes de despachar y comprobar antes de persistir—, que es la lección que su hermano de C2
 * dejó pagada.
 *
 * Los candados, en el orden del sistema y con el registry AÑADIDO al final:
 *   · `designio:workspace:` en compartido, el que toma el guard de congelación en toda
 *     escritura y por tanto el primero del par.
 *   · `designio:reto:` por CLAVE, que es lo que toma `agregarCriterio`: un criterio nuevo es un
 *     FANTASMA —`for share` bloquea filas que existen, y una fila sin commitear no está en
 *     ninguna—, y un criterio nuevo cambia el material.
 *   · `designio:registry:` por clave, que es lo que toma `firmarRegistry`. Va DETRÁS del reto,
 *     y ese orden es el mismo que toma el guard diferido de la materialización: dos órdenes
 *     distintos para el mismo par de claves es un abrazo mortal esperando contención, que es
 *     como se manifestó la última vez en este mismo pipeline.
 *   · `for share` sobre las dos filas, que ordena las transiciones ya commiteadas.
 *
 * `metric_registry.reto_id` es inmutable —1:1 por unique, y sin grant de UPDATE—, así que
 * leerlo antes de tomar la clave del reto no abre carrera: es el mismo argumento por el que
 * `reabrirEtapa` lee `proyecto.reto_id` antes de su candado.
 */
async function huellaDelMaterialDelRegistry(
  tx: TransactionSql,
  entrada: GenerarPropuestas,
): Promise<{
  huella: string;
  registry: {
    codigo: string;
    titulo: string;
    descripcion: string;
    criterios: CriteriosDelReto;
  } | null;
}> {
  await tx`select pg_advisory_xact_lock_shared(
    hashtextextended('designio:workspace:' || ${entrada.workspaceId}, 42))`;
  const [dueno] = await tx`select reto_id from metric_registry
    where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}`;
  if (!dueno) return { huella: '', registry: null };
  const retoId = dueno.reto_id as string;
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`;
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:registry:' || ${entrada.anclaId}, 42))`;
  await tx`select 1 from reto where id = ${retoId} and workspace_id = ${entrada.workspaceId}
    for share`;
  await tx`select 1 from metric_registry
    where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId} for share`;
  const [fila] = await tx`select
      registry_admite_entradas(${entrada.anclaId}, ${entrada.workspaceId}) as admite,
      r.codigo, r.titulo, r.descripcion
    from reto r where r.id = ${retoId} and r.workspace_id = ${entrada.workspaceId}`;
  if (!fila || !(fila.admite as boolean)) return { huella: '', registry: null };
  // Los criterios, con el MISMO orden y las mismas columnas que proyecta el panel: el material
  // contra el que se mide la presencia literal tiene que ser el que el modelo leyó, y dos
  // consultas para el mismo conjunto es cómo empiezan las discrepancias.
  const criterios = await tx`select c.id, c.kpi, c.definicion, c.objetivo,
      c.ventana_dias, c.linea_base_plan
    from criterio_exito c
    where c.reto_id = ${retoId} and c.workspace_id = ${entrada.workspaceId}
    order by c.kpi asc, c.id asc`;
  const registry = {
    codigo: fila.codigo as string,
    titulo: fila.titulo as string,
    descripcion: fila.descripcion as string,
    criterios: criterios.map((c) => ({
      id: c.id as string,
      kpi: c.kpi as string,
      definicion: c.definicion as string,
      objetivo: c.objetivo as string,
      ventanaDias: c.ventana_dias as number | null,
      lineaBasePlan: c.linea_base_plan as string,
    })),
  };
  return { huella: huellaDelMaterial(materialDeRegistry(registry).texto), registry };
}

const REVALIDAR: Record<
  CapacidadActiva,
  (
    tx: TransactionSql,
    entrada: GenerarPropuestas,
    huellaMaterial: string | undefined,
  ) => Promise<void>
> = {
  CI: async (tx, entrada) => {
    // El consentimiento NO se comprueba aquí: lo hace `exigirConsentimientoVigente`, que corre
    // justo antes gobernado por `exigeConsentimiento`. Estaba escrito a mano en esta entrada,
    // y por eso la bandera no servía para nada.
    const [item] = await tx`select estado <> 'pendiente' as ya_decidido
      from item_importacion
      where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}`;
    // Otro curador pudo decidir el item a mano mientras tanto: su material ya no espera
    // nada de la AI y la propuesta nacería obsoleta. Gastar la llamada para eso es tirar
    // dinero, y es el mismo caso que el consentimiento — algo que `prepararAlcance` vio
    // cierto y dejó de serlo al commitear.
    if (!item || item.ya_decidido) {
      throw new ErrorAI(
        'Ese item de la bandeja ya fue curado mientras se preparaba la llamada: no se llamó al proveedor',
      );
    }
  },
  C0: async (tx, entrada) => {
    const [reto] = await tx`select
        reto_admite_criterios(id, workspace_id) as admite,
        reto_criterios_congelados(id, workspace_id) as congelado
      from reto where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}`;
    if (!reto || !reto.admite || reto.congelado) {
      throw new ErrorAI(
        'Ese reto dejó de admitir criterios mientras se preparaba la llamada (G0 aprobado, registry firmado o reto cerrado): no se llamó al proveedor',
      );
    }
  },
  CT: async (tx, entrada) => {
    // El gate pudo aprobarse a mano mientras se preparaba la llamada, y entonces el informe
    // nacería describiendo un estado que ya pasó. Es el mismo caso que el item curado: algo
    // que `prepararAlcance` vio cierto y dejó de serlo antes de commitear.
    const [gate] = await tx`select estado <> 'pendiente' as ya_decidido
      from gate_instancia
      where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}`;
    if (!gate || gate.ya_decidido) {
      throw new ErrorAI(
        'Ese gate ya se decidió mientras se preparaba la llamada: no se llamó al proveedor',
      );
    }
  },
  C2: async (tx, entrada, huellaMaterial) => {
    /*
     * Dos preguntas, y las dos con la lectura que hace `huellaDelMaterialDeInsights`: bajo los
     * candados del sistema (workspace, reto por clave, y `for share` sobre el reto y sus
     * derechos), porque cada una de ellas la puso aquí un caso medido y no una precaución.
     *
     * 1. Que el reto NO se haya archivado: el insight nacería sobre un trabajo cerrado, y se
     *    pagaría el análisis de algo que este mismo camino declara terminado.
     * 2. Que el MATERIAL siga siendo el que se armó — no «que quede alguna evidencia
     *    utilizable». Aquí hubo un `exists (… evidencia_usable …)`, y esa pregunta pasa aunque
     *    la evidencia a la que acaban de revocarle los derechos sea justo una de las que el
     *    prompt YA LLEVA DENTRO. Preguntar por el conjunto entero es lo que corresponde a lo
     *    que se va a mandar, y de paso cubre lo demás que puede haber cambiado: una evidencia
     *    desenlazada, otra nueva, un resumen editado, la formulación del reto.
     */
    const { huella, reto, caducada } = await huellaDelMaterialDeInsights(tx, entrada);
    if (!reto) {
      throw new ErrorAI(
        'Ese reto se archivó mientras se preparaba la llamada: no se llamó al proveedor',
      );
    }
    // Con su propio mensaje y no dentro del de la huella: la caducidad no la provocó nadie, así
    // que «se revocaron derechos, se desenlazó o se editó» mandaría a buscar a un culpable que
    // no existe. Y la salida es otra: renovar el permiso, no volver a pedirlo tal cual.
    if (caducada !== null) {
      throw new ErrorAI(
        `El derecho de cita de «${caducada}» vence hoy: no se llamó al proveedor, porque unos insights que se revisan mañana ya no se podrían aceptar. Renueva el permiso —o desenlaza ese documento del reto— y vuelve a pedirlo.`,
      );
    }
    if (huella !== (huellaMaterial ?? '')) {
      throw new ErrorAI(
        'La evidencia de ese reto cambió mientras se preparaba la llamada —se revocaron derechos, se desenlazó o se editó—, así que el material ya no es el que se iba a mandar: no se llamó al proveedor. Vuelve a pedirlo.',
      );
    }
  },
  C6: async (tx, entrada, huellaMaterial) => {
    /*
     * Dos preguntas, las dos bajo los candados de `huellaDelMaterialDelRegistry`:
     *
     * 1. Que el registry SIGA admitiendo entradas. Firmarlo es un acto humano que ocurre
     *    justo en el rato que va de preparar a despachar —es lo que G6 hace—, y una entrada
     *    propuesta contra un contrato ya firmado solo se puede tirar, con la llamada pagada.
     * 2. Que el MATERIAL siga siendo el que se armó, no «que quede algún criterio». Un
     *    criterio editado o añadido cambia el texto que el prompt YA LLEVA DENTRO, y la
     *    pregunta por el conjunto entero es la que corresponde a lo que se va a mandar.
     */
    const { huella, registry } = await huellaDelMaterialDelRegistry(tx, entrada);
    if (!registry) {
      throw new ErrorAI(
        'Ese Metric Registry dejó de admitir entradas mientras se preparaba la llamada —se firmó, o el trabajo de su reto se cerró—: no se llamó al proveedor',
      );
    }
    if (huella !== (huellaMaterial ?? '')) {
      throw new ErrorAI(
        'Los criterios de ese reto cambiaron mientras se preparaba la llamada —se añadió uno, o se editó—, así que el material ya no es el que se iba a mandar: no se llamó al proveedor. Vuelve a pedirlo.',
      );
    }
  },
  C5: async (tx, entrada, huellaMaterial) => {
    /*
     * Lo que puede haber pasado mientras se preparaba la llamada es que ALGUIEN CIERRE las
     * señales — que es el desenlace bueno, y precisamente por eso no hay que pagar por
     * remediarlas. Un grafo que llega aquí ya sin nada abierto no se despacha.
     *
     * Aquí había un corte por SNAPSHOT, y estaba mal leído: lo inmutable es cada snapshot, no
     * el journey («el grafo de trabajo no se cierra nunca», RF-05.8). Un journey que ha pasado
     * una design version se sigue editando, y era justo el que más señales acumula.
     */
    const journey = await leerJourneyCompleto(tx, entrada.workspaceId, entrada.anclaId);
    if (!journey) {
      throw new ErrorAI('Ese journey dejó de existir mientras se preparaba la llamada');
    }
    if (validarJourney(journey).length === 0) {
      throw new ErrorAI(
        'Las señales de ese journey se cerraron mientras se preparaba la llamada: no había nada que remediar y no se llamó al proveedor',
      );
    }
    /*
     * Y que el grafo siga siendo EL QUE SE ARMÓ EN EL PROMPT, no solo que le queden señales.
     *
     * Esta misma comparación existía en `COMPROBAR.C5`, y allí llega tarde: para entonces la
     * llamada ya salió, ya se pagó y ya está en el libro. Una edición ajena en el hueco entre
     * preparar y despachar —renombrar un nodo, mover una transición— dejaba pasar el despacho
     * mientras quedara alguna señal abierta, y el informe se descartaba después, con el coste
     * hecho. Es determinista, no una carrera improbable: basta con que alguien edite el grafo.
     *
     * Se compara aquí, que es el último punto donde no cuesta nada, y sigue comparándose allí,
     * que es el único donde se puede afirmar sobre lo que el modelo YA dijo. Las dos no sobran:
     * entre este chequeo y la escritura sigue pasando la llamada entera.
     */
    if (huellaDelMaterialDeC5(journey) !== (huellaMaterial ?? '')) {
      throw new ErrorAI(
        'El grafo de ese journey cambió mientras se preparaba la llamada: lo que se iba a enviar ya no lo describe, así que no se llamó al proveedor. Vuelve a pedirlo.',
      );
    }
  },
};

/**
 * Cómo prepara cada capacidad su generación: lee su ancla, comprueba lo que impide gastar
 * presupuesto en algo que nadie podría aceptar, y arma el prompt.
 *
 * Es lo más específico que tiene una capacidad y por eso vivía en un `if/else`. Con dos
 * ramas un `else` es «la otra»; con diez, «la otra» es una capacidad concreta elegida por
 * orden de escritura. Aquí cada una se declara por su nombre, y `Record<CapacidadActiva, …>`
 * hace que el compilador exija la entrada de toda capacidad que alguien añada al catálogo.
 *
 * Vive en el servicio y no en el registro de `ai.schemas` a propósito: necesita la
 * transacción y los prompts, y el registro lo importa la PANTALLA — meterlo allí arrastraría
 * los prompts al bundle del cliente, que es justo lo que `check:bundle` vigila.
 */
type Preparacion = {
  sistema: string;
  prompt: { usuario: string; alcanceResumen: string };
  /**
   * La HUELLA del material que se le enseñó al modelo, para las capacidades que la declaran.
   *
   * Lo que sostiene, y no es poco: la llamada al proveedor pasa FUERA de toda transacción, así
   * que entre preparar y persistir el workspace puede haber cambiado. Comparar contra una
   * lectura nueva dice si algo cambió DESDE ESA LECTURA; comparar contra esto dice si el
   * contenido habla del estado que el modelo tuvo delante, que es otra pregunta y la que
   * importa.
   *
   * Y ya antes del despacho: entre `PREPARAR` y `comprobarDespacho` hay un commit, y lo que
   * hay que comprobar allí es que el material SIGA SIENDO EL QUE SE ARMÓ. Eso no lo dice
   * ningún `exists`: preguntar «¿queda alguna evidencia utilizable?» pasa aunque la que se
   * revocó sea justo una de las que ya están dentro del prompt construido.
   */
  huellaMaterial?: string;
  /**
   * Los ids de la evidencia que compuso ese material, para las capacidades que la tienen.
   *
   * Es la MISMA pregunta que la huella, escrita de una forma que la BASE puede volver a
   * hacerse. La huella es de un texto —con su formato y su recorte— y no hay SQL que lo
   * reconstruya; el conjunto de ids sí, y es justo lo que hace falta en el último instante:
   * si al aceptar hay evidencia del reto que NO estaba aquí, el insight se selló sin haberla
   * visto, y en C2 esa evidencia puede ser la que lo contradice. Por eso viaja hasta la fila
   * y se guarda: el guard diferido no puede llamar a TypeScript.
   */
  evidenciaDelMaterial?: string[];
};
const PREPARAR: Record<
  CapacidadActiva,
  (tx: TransactionSql, entrada: GenerarPropuestas) => Promise<Preparacion>
> = {
  CI: async (tx, entrada) => {
    // El consentimiento ya está comprobado —y su candado tomado— por
    // `exigirConsentimientoVigente`, que corre justo antes gobernado por la declaración de la
    // capacidad. Estaba escrito a mano AQUÍ, y por eso `exigeConsentimiento` no servía para
    // nada: una capacidad futura podía declararlo y mandar material de personas sin puerta.
    const [item] = await tx`select titulo, tipo_fuente, referencia, contenido,
        item_tiene_material_extraible(contenido) as tiene_material
      from item_importacion
      where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
        and estado = 'pendiente'`;
    if (!item) throw new ErrorAI('El item no existe en este workspace o ya fue curado');
    // Un item importado SOLO con la referencia al original no tiene nada que citar, y el
    // contrato de CI obliga al modelo a devolver una evidencia fechada con al menos una
    // cita literal. Sin cuerpo, la única salida que cumple el contrato es inventada a
    // partir de la ficha: una propuesta con apariencia de fundamentada, pagada, que
    // además contamina la métrica de presencia literal. Y no hay recuperación posible — no hay
    // herramienta que lea la fuente referenciada — así que la respuesta correcta es no
    // ofrecer la generación, no intentarla peor.
    if (!(item.tiene_material as boolean)) {
      throw new ErrorAI(
        'Ese item se importó solo con la referencia al original: no hay material que citar, así que no se puede extraer evidencia de él. Cúralo a mano en la bandeja o vuelve a importarlo con el texto pegado.',
      );
    }
    return {
      sistema: SISTEMA_EXTRACCION,
      prompt: promptExtraccion({
      titulo: item.titulo as string,
      tipoFuente: item.tipo_fuente as string,
      referencia: item.referencia as string,
        contenido: item.contenido as string,
      }),
    };
  },
  C0: async (tx, entrada) => {
    const [reto] = await tx`select codigo, titulo, descripcion, metrica_objetivo
      from reto where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
        and reto_admite_criterios(id, workspace_id)`;
    if (!reto) throw new ErrorAI('El reto no existe en este workspace o ya no admite criterios');
    // El congelado de criterios lo impone la política de criterio_exito; anticiparlo aquí
    // evita quemar presupuesto en una propuesta que nadie podría aceptar. Los DOS
    // predicados del reto —admite criterios, y no están congelados— se preguntan por la
    // función que los impone, nunca copiados a mano: es lo que hace que ampliar uno llegue
    // de golpe a las políticas, a los guards, al panel y a estas lecturas, en vez de
    // dejar la versión vieja escondida en la que nadie tocó.
    const [congelado] = await tx`select
      reto_registry_firmado(${entrada.anclaId}, ${entrada.workspaceId}) as registry,
      reto_g0_congela_criterios(${entrada.anclaId}, ${entrada.workspaceId}) as g0`;
    if (congelado?.registry) {
      throw new ErrorAI(
        'El registry de medición de ese reto ya está firmado: sus criterios son el contrato acordado y no admiten cambios (SYS-22)',
      );
    }
    if (congelado?.g0) {
      throw new ErrorAI('El G0 de ese reto ya fue aprobado: sus criterios están congelados');
    }
    return {
      sistema: SISTEMA_CRITERIOS,
      prompt: promptCriterios({
      codigo: reto.codigo as string,
      titulo: reto.titulo as string,
      descripcion: reto.descripcion as string,
      metricaObjetivo: reto.metrica_objetivo as string,
        cuantos: CRITERIOS_POR_GENERACION,
      }),
    };
  },
  CT: async (tx, entrada) => {
    const [gate] = await tx`select g.numero, g.rol_aprobador, pr.titulo as proyecto
      from gate_instancia g
      join proyecto pr on pr.id = g.proyecto_id and pr.workspace_id = g.workspace_id
      where g.id = ${entrada.anclaId} and g.workspace_id = ${entrada.workspaceId}
        and g.estado = 'pendiente'`;
    if (!gate) throw new ErrorAI('El gate no existe en este workspace o ya se decidió');
    /*
     * El checklist, con el MISMO orden y las MISMAS columnas que proyecta el panel. Que las
     * dos consultas coincidan no es casualidad ni disciplina: es lo que hace que el material
     * contra el que se mide la presencia literal de las citas sea el que el modelo leyó. Si
     * divergieran, el grounding empezaría a marcar como ausentes citas que están.
     */
    const requisitos = await tx`select id, texto, estado,
        num_nonnulls(evidencia_id, insight_id, decision_id) = 1 as con_objeto
      from checklist_item
      where gate_id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
      order by orden asc`;
    /*
     * Un gate SIN checklist no tiene nada sobre lo que informar, y el contrato de CT obliga
     * al modelo a devolver al menos una cita literal del material. Sin requisitos, la única
     * salida que cumple el contrato sale de la ficha —el nombre del proyecto y el número del
     * gate—, o sea inventada. Es el mismo caso que un item importado sin cuerpo, y la
     * respuesta correcta es la misma: no ofrecer la generación, no intentarla peor.
     */
    if (requisitos.length === 0) {
      throw new ErrorAI(
        'Ese gate no tiene checklist todavía: no hay requisitos que revisar, así que no hay nada que informar',
      );
    }
    return {
      sistema: SISTEMA_ASISTENTE_GATES,
      prompt: promptAsistenteGate({
        proyecto: gate.proyecto as string,
        numero: gate.numero as number,
        rolAprobador: gate.rol_aprobador as string,
        checklist: requisitos.map((c) => ({
          id: c.id as string,
          texto: c.texto as string,
          estado: c.estado as string,
          conObjeto: c.con_objeto as boolean,
        })),
      }),
    };
  },
  C2: async (tx, entrada) => {
    const [reto] = await tx`select codigo, titulo, descripcion, estado
      from reto where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}`;
    if (!reto) throw new ErrorAI('El reto no existe en este workspace');
    if ((reto.estado as string) === 'archivado') {
      throw new ErrorAI('Ese reto está archivado: su trabajo se cerró y no admite insights nuevos');
    }
    /*
     * La evidencia del reto, por el ÚNICO camino que este esquema tiene: `evidencia` no cuelga
     * de un reto, cuelga del workspace, y lo que la ata a uno son sus ARQUETIPOS. Y solo la
     * CITABLE: `evidencia_citable_guard` exige derechos vigentes de ámbito cliente para
     * escribir una `cita`, así que enseñarle al modelo un documento sin ellos es pedirle que
     * cite lo que la aceptación va a rechazar — después de pagar la llamada Y de que alguien
     * la revise, dejando una propuesta que solo se puede tirar. El mismo predicado que impone
     * la escritura, aplicado antes de gastar. Va en los CUATRO sitios que miran esa evidencia
     * (la cola, la revalidación, este prompt y la proyección del panel), porque una lista que
     * discrepe de otra es exactamente lo que reabre el hueco.
     *
     * La misma consulta que proyecta el panel, para que el material contra el que se mide la presencia
     * literal sea el que el modelo leyó. «La misma» incluye el DISTINCT y el desempate del
     * orden: una evidencia puede colgar de dos arquetipos del mismo reto, y si una de las dos
     * consultas la trae repetida y la otra no, el pajar contra el que se mide una cita deja de
     * ser el texto que el modelo tuvo delante.
     */
    const evidencia = await tx`select distinct e.id, e.titulo, e.resumen
      from arquetipo a
      join arquetipo_evidencia ae on ae.arquetipo_id = a.id and ae.workspace_id = a.workspace_id
      join evidencia e on e.id = ae.evidencia_id and e.workspace_id = ae.workspace_id
      where a.reto_id = ${entrada.anclaId} and a.workspace_id = ${entrada.workspaceId}
        and evidencia_usable(e.id, e.workspace_id, 'cliente')
      order by e.titulo asc, e.id asc`;
    /*
     * Sin evidencia no se llama. El contrato de C2 obliga a que cada afirmación cite un
     * fragmento literal, y sin evidencia la única salida que lo cumple sale de la formulación
     * del reto —o sea inventada, con aspecto de fundamentada y pagada—. Es el mismo caso que
     * el item importado solo con su referencia, y la respuesta es la misma.
     *
     * Y el mensaje dice DÓNDE se enlaza, porque el camino no es obvio: la evidencia llega a un
     * reto por sus arquetipos, no directamente.
     */
    if (evidencia.length === 0) {
      throw new ErrorAI(
        'Ese reto no tiene evidencia CITABLE: no hay nada que citar. La evidencia llega a un reto por sus ARQUETIPOS, y además tiene que tener derechos de uso vigentes para ámbito cliente (SPEC-03) — comprueba las dos cosas y vuelve a pedirlo.',
      );
    }
    const material = {
      codigo: reto.codigo as string,
      titulo: reto.titulo as string,
      descripcion: reto.descripcion as string,
      evidencia: evidencia.map((e) => ({
        id: e.id as string,
        titulo: e.titulo as string,
        resumen: e.resumen as string,
      })),
    };
    /*
     * Y qué evidencia LLEGÓ, que no es la misma pregunta que cuál se consultó para armarla. El
     * cuerpo es la concatenación de todos los documentos y se recorta ENTERO a `MAX_MATERIAL`,
     * así que con bastante evidencia enlazada la cola se queda fuera —el documento donde cae el
     * corte, a medias; los siguientes, del todo—.
     *
     * El recorte NO es un error: el prompt se lo dice al modelo («no afirmes nada sobre lo que
     * no ves») y el panel mide cada cita contra el trozo que sobrevivió. Lo que no puede pasar
     * es que el ALCANCE mienta: `alcance_evidencia` es lo que el guard diferido compara al
     * aceptar con la evidencia que el reto tiene, y apuntar ahí todo lo consultado da por
     * vistos documentos que nadie enseñó — sellando unos insights que no pudieron encontrar la
     * contradicción que estaba justo en el trozo cortado. Con el alcance honesto, la propuesta
     * se genera y se revisa igual, y lo que el suelo impide es SELLARLA mientras el reto siga
     * teniendo evidencia que ella no vio.
     */
    const llegado = evidenciaQueLlegoAlModelo(material);
    return {
      sistema: SISTEMA_INSIGHTS,
      prompt: promptInsights({ ...material, cuantos: MAX_INSIGHTS_POR_LOTE }),
      /*
       * La huella de ESTE material, para volver a mirarla justo antes de despachar. Entre esta
       * transacción y aquella hay un commit, y lo que puede pasar en medio no es solo que el
       * reto se archive: que a UNA de las evidencias que el prompt ya lleva dentro le revoquen
       * los derechos, y el bloque está armado y saldría igual hacia el proveedor.
       */
      huellaMaterial: huellaDelMaterial(materialDeInsights(material).texto),
      // Lo que el modelo tuvo delante, para que el suelo pueda volver a preguntarlo. Sale de
      // `material` y no de otra lectura: dos consultas para el mismo conjunto es cómo
      // empiezan las discrepancias que este PR ya ha corregido varias veces.
      evidenciaDelMaterial: llegado.ids,
    };
  },
  C6: async (tx, entrada) => {
    // El MISMO lector que la revalidación, no una consulta paralela: el material que se manda
    // y el que se vuelve a mirar antes de despachar tienen que salir de la misma lectura, o la
    // huella compara dos textos que nadie compuso igual.
    const { registry } = await huellaDelMaterialDelRegistry(tx, entrada);
    if (!registry) {
      throw new ErrorAI(
        'Ese Metric Registry no existe aquí, ya está firmado, o el trabajo de su reto se cerró: no admite entradas nuevas',
      );
    }
    /*
     * Sin criterios no se llama. El contrato de C6 obliga a que cada entrada responda a un
     * criterio del material POR SU ID, y sin criterios la única salida que lo cumple es un id
     * inventado. Es el mismo caso que el item importado solo con su referencia y que el reto
     * sin evidencia de C2, y la respuesta es la misma: no ofrecerlo y decir dónde se arregla.
     */
    if (registry.criterios.length === 0) {
      throw new ErrorAI(
        'Ese reto no tiene criterios de éxito: no hay ninguna promesa a la que un KPI pueda responder. Los criterios se definen en la etapa 0 y los congela el G0 (SYS-22) — defínelos y vuelve a pedirlo.',
      );
    }
    /*
     * Y «tener criterios» no es lo mismo que «que llegue alguno». El cuerpo es la
     * concatenación de la formulación del reto y de todos los criterios, y se recorta ENTERO a
     * `MAX_MATERIAL`: con una descripción larga por delante, la cola se queda fuera —el
     * criterio donde cae el corte, a medias; los siguientes, del todo—. Si NINGUNO llega
     * completo, la única salida que cumple el contrato —una entrada que responde a un criterio
     * por su id, citando un fragmento literal suyo— sale de un criterio que el modelo no vio
     * entero: o sea inventada, con aspecto de fundamentada y pagada.
     *
     * Es la misma regla que niega CI sobre un item sin material y C2 sobre un reto sin
     * evidencia citable, con el recorte como causa en vez de la ausencia. Y el mensaje dice
     * qué hacer, que es lo único que puede hacer quien lo lee.
     */
    const llegados = criteriosQueLlegaronAlModelo(registry);
    if (llegados.ids.length === 0) {
      throw new ErrorAI(
        `Ninguno de los ${registry.criterios.length} criterios de ese reto cabe entero en el material (el techo son ${MAX_MATERIAL} caracteres, y la formulación del reto va delante): no se llamó al proveedor, porque cualquier entrada saldría de un criterio que el modelo no habría visto completo. Acorta la descripción del reto o la definición de sus criterios y vuelve a pedirlo.`,
      );
    }
    return {
      sistema: SISTEMA_REGISTRY,
      prompt: promptRegistry({ ...registry, cuantas: MAX_ENTRADAS_KPI_POR_LOTE }),
      /*
       * La huella de ESTE material, para volver a mirarla justo antes de despachar. Entre esta
       * transacción y aquella hay un commit, y lo que puede pasar en medio no es solo que el
       * registry se firme: que a UNO de los criterios que el prompt ya lleva dentro lo editen,
       * y el bloque está armado y saldría igual hacia el proveedor.
       */
      huellaMaterial: huellaDelMaterial(materialDeRegistry(registry).texto),
    };
  },
  C5: async (tx, entrada) => {
    // El MISMO lector que usa la pantalla del journey, no una consulta paralela: lo que se
    // le enseña al modelo y lo que la validación evalúa tienen que salir de la misma
    // lectura, o las señales del prompt y las de la comprobación pueden discrepar.
    const journey = await leerJourneyCompleto(tx, entrada.workspaceId, entrada.anclaId);
    if (!journey) throw new ErrorAI('El journey no existe en este workspace');
    const grafo = grafoParaElModelo(journey);
    /*
     * Un grafo SIN señales no se manda al proveedor, y no por ahorrar: la respuesta ya se
     * sabe. `validarJourney` es determinista y acaba de decir que no hay nada que cerrar;
     * pagar una llamada para que un modelo lo repita es comprar una opinión sobre un hecho.
     *
     * Es la misma regla que niega CI sobre un item sin material: cuando la única salida que
     * cumple el contrato es la que ya tenemos, la respuesta correcta es no llamar.
     */
    if (grafo.senales.length === 0) {
      throw new ErrorAI(
        'La validación de ese journey no encontró ninguna señal abierta: no hay nada que remediar. (Eso ya lo dice la validación del grafo, que es exacta; no hace falta preguntárselo a la AI.)',
      );
    }
    /*
     * Y por arriba, el techo del contrato. El esquema admite `MAX_REMEDIACIONES`, así que a un
     * grafo con más señales se le estaría pidiendo algo que su respuesta no puede llevar: o
     * viene corta —y la comprobación de abajo la descarta, DESPUÉS de pagarla— o viene
     * recortada por el propio modelo, eligiendo él qué señales callar. Se dice antes de gastar
     * y se dice qué hacer, que es lo que puede hacer quien lo lee.
     */
    if (grafo.senales.length > MAX_REMEDIACIONES) {
      throw new ErrorAI(motivoDemasiadasSenales(grafo.senales.length));
    }
    const prompt = promptRemediacionJourney({
      nombre: journey.nombre,
      servicio: journey.servicioNombre,
      tipo: journey.tipo,
      grafo,
    });
    /*
     * Y el otro techo, el del MATERIAL. El cuerpo se recorta a `MAX_MATERIAL`, y aunque las
     * señales van delante —y por eso ya no se pierden—, en un grafo grande lo que caía fuera
     * era su TOPOLOGÍA: el modelo leía «el paso X no tiene salida» sin ver el paso X ni una
     * sola transición. Y el contrato le exige una remediación por señal igual, así que la
     * única salida que le quedaba era inventarla — y `COMPROBAR.C5` no la puede distinguir de
     * una buena, porque cubre exactamente la señal que se le pidió.
     *
     * `nucleoDeRemediacion` pone delante las señales, sus nodos y el grafo ENTERO de
     * transiciones, así que todo eso sobrevive al recorte salvo que ello solo ya no quepa. Ese
     * caso se dice aquí, antes de gastar, y se dice qué hacer: sin la conectividad completa,
     * media docena de los códigos que emite la validación —los que preguntan por el grafo y no
     * por un nodo— no tienen respuesta fiable.
     */
    if (!prompt.nucleo.cabe) {
      throw new ErrorAI(motivoConectividadQueNoCabe(prompt.nucleo.caracteres));
    }
    return {
      sistema: SISTEMA_REMEDIACION_JOURNEY,
      prompt,
      /*
       * Lo que el modelo TUVO DELANTE, para volver a mirarlo cuando haya que escribir. Sin
       * esto, `COMPROBAR` solo podía comparar contra una lectura NUEVA del grafo, y entre las
       * dos cabe la llamada entera: otro curador edita el journey, la señal que el informe
       * remedia sigue existiendo por casualidad, y el consejo —que nombra nodos que ya no
       * están— se acepta como si fuera de este grafo.
       *
       * Y es el GRAFO ENTERO, no solo sus señales. Guardar las claves `(nodoId, codigo)` era
       * la mitad: renombrar un nodo, cambiar la condición de una transición o rehacer la
       * topología de alrededor deja las mismas señales y cambia todo lo que el consejo
       * describe. Lo que hay que fijar es el material, y el material son los nodos, las
       * aristas y las señales juntos.
       */
      huellaMaterial: huellaDelMaterialDeC5(journey),
    };
  },
};

/** La huella de un material, para comparar si sigue siendo el mismo entre dos transacciones.
 * No hace falta que sea criptográfica —solo se compara consigo misma dentro de una
 * generación— pero sale gratis y ahorra razonar sobre colisiones. */
function huellaDelMaterial(texto: string): string {
  return createHash('sha256').update(texto).digest('hex');
}

/**
 * Lo que cada capacidad comprueba de la salida DEL MODELO contra el estado del workspace,
 * ya dentro de la transacción que la va a persistir.
 *
 * No es lo mismo que el esquema de contenido —que es forma— ni que `REVALIDAR` —que mira el
 * ancla ANTES de gastar—: esto mira lo que el modelo DIJO, y solo se puede hacer con la fila
 * delante. Hoy lo necesita una sola capacidad, y por eso conviene decir por qué no vive en la
 * base como el guard de los huecos de CT: los ids de un checklist son una TABLA, y un trigger
 * puede consultarlos; las señales de un grafo son una FUNCIÓN PURA de sus nodos y aristas, y
 * no hay SQL que las recalcule. Se comprueban donde se pueden calcular.
 *
 * `Record<CapacidadActiva, …>` para que una capacidad nueva tenga que decir explícitamente
 * que no comprueba nada, en vez de heredarlo por omisión.
 */
const COMPROBAR: Record<
  CapacidadActiva,
  (
    tx: TransactionSql,
    entrada: GenerarPropuestas,
    contenidos: ContenidoPropuesta[],
    huellaMaterial: string | undefined,
  ) => Promise<void>
> = {
  // El contenido de CI se sujeta entero con su esquema y con los CHECK de `evidencia`: no hay
  // nada que contrastar contra el workspace que no esté ya contrastado.
  CI: async () => {},
  C0: async () => {},
  // Los huecos de CT los comprueba un trigger, que es un suelo más bajo que éste.
  CT: async () => {},
  /*
   * C2 SÍ, y lo que estaba escrito aquí antes era falso donde más importa. Decía que no había
   * nada que contrastar porque «la evidencia citada es del reto, sus derechos siguen vigentes,
   * y la materialización compara la descendencia entera contra lo propuesto». Las tres cosas
   * son ciertas y ninguna cubre esto: todas miran lo que la respuesta SÍ citó. Lo que no se
   * miraba es lo que la respuesta NO PUDO citar.
   *
   * La llamada al proveedor ocurre fuera de toda transacción —a propósito: un tercero lento no
   * retiene una conexión—, y el candado previo al despacho se suelta al commitear el apunte.
   * En ese hueco se puede enlazar evidencia nueva al reto. La propuesta vuelve, se persiste y
   * se acepta sin haber visto ese documento — y en C2 el documento que llega tarde puede ser
   * justo el que CONTRADICE el insight, que es lo que I4 existe para no dejar esconder.
   *
   * Es exactamente lo que C5 hace dos entradas más abajo con su grafo, y con el mismo canal:
   * `huellaMaterial` se construyó compartido en este PR para esto. Que una de las dos lo usara
   * y la otra no era la divergencia entre hermanos que este PR ya ha corregido varias veces.
   *
   * La comparación va bajo los mismos candados que la de antes del despacho —`huellaDelMaterialDeInsights`—
   * y dentro de la transacción que escribe, que es lo que la hace atómica con la fila.
   */
  C2: async (tx, entrada, _contenidos, huellaMaterial) => {
    const { huella, reto, caducada } = await huellaDelMaterialDeInsights(tx, entrada);
    if (!reto) {
      throw new ErrorAI(
        'Ese reto se archivó mientras el proveedor respondía: la propuesta no se guarda',
      );
    }
    if (caducada !== null) {
      throw new ErrorAI(
        `El derecho de cita de «${caducada}» vence hoy: la propuesta no se guarda, porque sus citas ya no se podrían aceptar al revisarla. Renueva el permiso —o desenlaza ese documento del reto— y vuelve a pedirla.`,
      );
    }
    if (huella !== (huellaMaterial ?? '')) {
      throw new ErrorAI(
        'La evidencia de ese reto cambió mientras el proveedor respondía —se enlazó, se desenlazó, se revocaron derechos o se editó—, así que estos insights se armaron sin verla: la propuesta no se guarda. Vuelve a pedirla.',
      );
    }
  },
  /*
   * C6, por lo mismo que C2 y con su material: la llamada al proveedor ocurre fuera de toda
   * transacción y el candado previo al despacho se suelta al commitear el apunte. En ese hueco
   * caben las dos cosas que invalidan estas entradas —firmar el registry, y añadir o editar un
   * criterio—, y las dos dejan una propuesta que solo se puede tirar después de que alguien la
   * haya leído entera.
   *
   * Y una tercera que es de C6 y de nadie más: el NOMBRE es la clave de la entrada dentro del
   * registry (`unique (registry_id, nombre)`), así que un lote con dos entradas homónimas trae
   * una que no se va a poder materializar nunca. Se descarta el lote entero al persistir en vez
   * de dejar que lo descubra quien acepta la segunda: media respuesta no es revisable, y el
   * suelo no puede decir cuál de las dos sobra.
   */
  C6: async (tx, entrada, contenidos, huellaMaterial) => {
    const { huella, registry } = await huellaDelMaterialDelRegistry(tx, entrada);
    if (!registry) {
      throw new ErrorAI(
        'Ese Metric Registry dejó de admitir entradas mientras el proveedor respondía —se firmó, o el trabajo de su reto se cerró—: la propuesta no se guarda',
      );
    }
    if (huella !== (huellaMaterial ?? '')) {
      throw new ErrorAI(
        'Los criterios de ese reto cambiaron mientras el proveedor respondía —se añadió uno, o se editó—, así que estas entradas se armaron sin verlos: la propuesta no se guarda. Vuelve a pedirla.',
      );
    }
    const nombres = (contenidos as ContenidoEntradaKpi[]).map((c) => c.nombre);
    if (new Set(nombres).size !== nombres.length) {
      throw new ErrorContratoAI(
        'El lote trae dos entradas con el mismo nombre, y el registry no admite nombres repetidos: se descarta entero. Vuelve a pedirlo.',
      );
    }
    /*
     * Y cada entrada responde a un criterio que el modelo VIO ENTERO, que no es lo mismo que
     * uno que exista. La huella de arriba dice que el material no cambió; esto dice otra cosa:
     * que lo que la respuesta señala estaba DENTRO de lo que se mandó. Un `criterioId` de un
     * criterio recortado a medias —o del todo— pasa el suelo de la base, porque ahí lo que se
     * comprueba es que el criterio sea del reto del registry, y eso sigue siendo cierto.
     *
     * Lo que no es cierto es que el KPI mida esa promesa: de ese criterio el modelo pudo no
     * ver el objetivo, o la ventana, o nada. Y sus citas saldrían AUSENTES en el panel contra
     * un tramo vacío, que es la señal correcta pero llega tarde — con la llamada pagada y la
     * propuesta en la bandeja de alguien.
     *
     * Vive AQUÍ y no en la base por lo mismo que las señales de C5: «qué llegó entero» es una
     * función del recorte del texto, no una tabla, y no hay SQL que lo recalcule. Se descarta
     * el lote entero, como C5: media respuesta no es revisable.
     */
    const visibles = new Set(criteriosQueLlegaronAlModelo(registry).ids);
    const fuera = (contenidos as ContenidoEntradaKpi[])
      .map((c) => c.criterioId)
      .filter((id) => !visibles.has(id));
    if (fuera.length > 0) {
      throw new ErrorContratoAI(
        `El lote responde a ${fuera.length} criterio(s) que no llegaron enteros al material —el recorte los dejó a medias o fuera—, así que esas entradas no pudieron leer la promesa que dicen medir: se descarta entero. Acorta la descripción del reto o la definición de sus criterios y vuelve a pedirlo.`,
      );
    }
  },
  C5: async (tx, entrada, contenidos, huellaMaterial) => {
    const journey = await leerJourneyCompleto(tx, entrada.workspaceId, entrada.anclaId);
    if (!journey) throw new ErrorAI('El journey dejó de existir mientras se generaba el informe');
    const grafoAhora = grafoParaElModelo(journey);
    const ahora = clavesDeSenales(grafoAhora.senales);
    const huellaMostrada = huellaMaterial ?? '';

    /*
     * ── Primero: que el grafo siga siendo EL QUE VIO EL MODELO ──
     *
     * La llamada al proveedor ocurre fuera de toda transacción —a propósito: un tercero lento
     * no retiene una conexión—, así que entre armar el prompt y escribir la fila cabe la
     * edición de otro curador. Comparar solo contra una lectura nueva no bastaba: si la señal
     * que el informe remedia sobrevive al cambio, el consejo se acepta aunque nombre nodos que
     * ya no existen. Se compara contra la HUELLA del grafo que el modelo tuvo delante, que es
     * lo único que hace de ese informe un informe sobre ESTE grafo — y es el grafo ENTERO y no
     * sus señales, porque renombrar un nodo o cambiar una transición las deja iguales y cambia
     * todo lo que el consejo describe.
     *
     * Y se descarta ENTERO, no la parte afectada: media respuesta no es revisable.
     */
    if (huellaDelMaterialDeC5(journey) !== huellaMostrada) {
      // `ErrorAI` a secas, no de contrato: el proveedor devolvió lo que se le pidió y lo que
      // cambió fue el grafo. Ver `ErrorContratoAI`.
      throw new ErrorAI(
        'El grafo de ese journey cambió mientras se generaba el informe: lo que dice ya no describe el grafo que hay, así que se descarta. Vuelve a pedirlo.',
      );
    }

    /*
     * ── Y después: UNA remediación por señal, ni de más ni de menos ──
     *
     * El prompt pide cómo cerrar CADA señal, así que el informe completo es el que las cubre
     * todas exactamente una vez. Comprobar solo que ninguna sea inventada dejaba pasar tres
     * cosas distintas, y las tres se pagan igual: la lista vacía, la que se salta señales
     * —quien la lee cree que el grafo tiene menos averías de las que tiene— y la que repite
     * una señal con dos consejos, que es una contradicción sin criterio para resolverla.
     *
     * Una señal inventada sigue siendo lo más grave —manda a alguien a arreglar un grafo que
     * estaba bien— y se nombra aparte, porque el motivo cambia lo que hay que hacer.
     */
    const propuestas = clavesDeSenales(
      contenidos.flatMap((c) => (c as ContenidoRemediacionJourney).remediaciones),
    );
    const reales = new Set(ahora);
    const inventadas = propuestas.filter((c) => !reales.has(c));
    if (inventadas.length > 0) {
      throw new ErrorContratoAI(
        `El informe señala ${inventadas.length} señal(es) que la validación de este journey no emitió: se descarta. Si el grafo cambió mientras se generaba, vuelve a pedirlo.`,
      );
    }
    if (propuestas.join('\n') !== ahora.join('\n')) {
      const faltan = reales.size - new Set(propuestas).size;
      throw new ErrorContratoAI(
        faltan > 0
          ? `El informe deja ${faltan} señal(es) sin remediar y el contrato pide una por señal: se descarta, porque leerlo haría creer que el grafo tiene menos averías de las que tiene. Vuelve a pedirlo.`
          : 'El informe propone dos remediaciones para la misma señal: se descarta, porque no hay criterio para elegir entre ellas. Vuelve a pedirlo.',
      );
    }
  },
};

/**
 * La huella del MATERIAL que se le enseñó al modelo. El texto exacto, no el grafo del que
 * salió.
 *
 * La diferencia empieza a importar en cuanto el cuerpo se recorta. Sobre el grafo crudo, un
 * journey grande cuya conectividad cabe pero cuyas etiquetas de cola no —el caso normal en
 * cuanto crece— cambiaba de huella al editar la etiqueta de un nodo que el modelo NUNCA vio:
 * el prompt era idéntico byte a byte y la respuesta pagada se descartaba igual, y un informe
 * ya escrito se marcaba «journey cambiado» por una edición que no le afectaba.
 *
 * Se calcula sobre `materialDeJourney(...).texto`, que es la ficha y el cuerpo YA recortados y
 * neutralizados: exactamente lo que viajó dentro del delimitador. Es la misma definición que
 * usa C2 con su material, y por la misma razón.
 *
 * No hace falta que sea criptográfica —nadie la ataca, solo se compara consigo misma—, pero
 * sale gratis y ahorra razonar sobre colisiones.
 */
function huellaDelMaterialDeC5(journey: JourneyCompleto): string {
  return huellaDelMaterial(
    materialDeJourney({
      nombre: journey.nombre,
      servicio: journey.servicioNombre,
      tipo: journey.tipo,
      grafo: grafoParaElModelo(journey),
    }).texto,
  );
}

/** La clave de una señal —su nodo y su código— en orden estable, para poder comparar dos
 * listas por igualdad. El `\u0000` separa porque no puede aparecer en un uuid ni en un
 * código: concatenar sin separador dejaría pares distintos con la misma clave. */
function clavesDeSenales(xs: { nodoId: string; codigo: string }[]): string[] {
  return xs.map((x) => `${x.nodoId}\u0000${x.codigo}`).sort();
}

/**
 * Genera propuestas para un ancla (RF-08.1). Nada del dominio cambia aquí: solo nacen
 * filas de `propuesta_ai` en estado `propuesta`, con su lineage completo (SYS-19).
 * Devuelve cuántas quedaron pendientes de revisión humana.
 */
export async function generarPropuestas(
  actorId: string,
  entrada: GenerarPropuestas,
): Promise<{ generadas: number }> {
  const alcance = await prepararAlcance(actorId, entrada);
  try {
    const respuesta = await generarConProveedor({
      key: alcance.key,
      capacidad: entrada.capacidad,
      sistema: alcance.sistema,
      usuario: alcance.usuario,
      // Abrir la línea del libro es AHORA también pedir permiso, y por eso el adaptador ya no
      // lleva ni la versión del consentimiento ni una revalidación aparte para el respaldo.
      // Antes había dos comprobaciones distintas: una antes del bucle que amparaba al
      // primario y otra dentro que amparaba al respaldo. Dos escrituras de la misma regla, y
      // la del primario commiteaba una transacción antes del apunte — el hueco por el que una
      // revocación dejaba salir el material igual. Con una sola, invocada dentro del apunte,
      // los dos intentos pasan por la misma puerta y ninguno la cruza con permiso viejo.
      //
      // El puesto lo pasa el ADAPTADOR, que es quien recorre los intentos y por tanto quien
      // lo sabe. Aquí vivía un contador propio que no podía diferir de su índice —el bucle
      // devuelve en cuanto un apunte falla— y que solo servía para duplicarlo.
      anotarDespacho: (modelo, puesto) => abrirLlamada(actorId, entrada, alcance, modelo, puesto),
    });

    // El proveedor no dio contenido utilizable. Los intentos se cierran igual —con su uso,
    // si la respuesta llegó a existir— y solo DESPUÉS se corta: registrar el gasto no puede
    // depender de que el resultado nos guste. Si el propio cierre falla, manda el motivo del
    // proveedor: es lo que la persona necesita leer.
    if (!respuesta.ok) {
      await cerrarSinTaparElMotivo(actorId, entrada, respuesta.intentos);
      throw new ErrorAI(respuesta.motivo);
    }

    let contenidos: ContenidoPropuesta[];
    try {
      contenidos = contenidosValidos(entrada.capacidad, respuesta.datos);
    } catch {
      // Respondió, se pagó, y no cumple el esquema de la capacidad: el peor caso para la
      // observabilidad si no se anotara, porque no deja ni propuesta que lo delate. El
      // intento que el adaptador daba por bueno se reetiqueta —el JSON era legible, pero el
      // contenido no cumple el contrato de la capacidad—: el libro registra lo que de
      // verdad salió de esa llamada, no lo que parecía a mitad de camino.
      const motivo =
        'La respuesta del proveedor AI no cumplió el esquema de la capacidad y se descartó. Todo el flujo sigue disponible a mano.';
      const intentos = respuesta.intentos.map((i, indice) =>
        indice === respuesta.intentos.length - 1
          ? { ...i, resultado: 'fuera-de-contrato' as const, motivo }
          : i,
      );
      await cerrarSinTaparElMotivo(actorId, entrada, intentos);
      throw new ErrorAI(motivo);
    }

    /*
     * LA COMPROBACIÓN SEMÁNTICA, ANTES DE CERRAR LA LÍNEA.
     *
     * El esquema ya se comprobó arriba, y su fallo reetiqueta el intento como
     * `fuera-de-contrato`. Lo que el esquema no puede ver —que un informe de C5 cubra cada
     * señal exactamente una vez, y que hable del grafo que el modelo tuvo delante— se
     * comprobaba solo DENTRO de la transacción que persiste, o sea después de que
     * `cerrarLlamadas` hubiera anotado la línea como `salida-valida`. El resultado: el libro
     * decía que esa llamada produjo una salida válida, no nacía ninguna propuesta, y el evento
     * `LlamadaAISinPropuesta` no salía —su trigger mira el tránsito DESDE `despachada`—. Las
     * respuestas de C5 fuera de contrato quedaban sistemáticamente sin contar.
     *
     * Y no se puede arreglar después: la política `llamada_completar` lleva
     * `using (resultado = 'despachada')`, así que una línea cerrada no la puede tocar la
     * aplicación — a propósito, es lo que la hace un hecho consumado. La única manera de que
     * el libro diga la verdad es preguntar antes de cerrar.
     *
     * La comprobación se queda TAMBIÉN dentro de la transacción que persiste, y no sobra:
     * entre esta lectura y la escritura cabe la edición de otro curador, y solo la de dentro
     * es atómica con la fila. Lo que queda sin cubrir es exactamente esa ventana —una edición
     * ajena entre las dos—, y ahí el desenlace no es «fuera de contrato» sino «el mundo se
     * movió», que es otra cosa y no tiene valor propio en el vocabulario.
     */
    try {
      await conUsuario(actorId, (tx) =>
        COMPROBAR[entrada.capacidad](tx, entrada, contenidos, alcance.huellaMaterial),
      );
    } catch (e) {
      if (!(e instanceof ErrorAI)) throw e;
      /*
       * Se reetiqueta SOLO lo que es culpa del modelo. `resultado` describe lo que devolvió el
       * proveedor, así que un informe que se salta una señal o repite otra es
       * `fuera-de-contrato`; un journey borrado o editado por otro curador NO lo es —el
       * proveedor devolvió lo que se le pidió— y anotarlo así corrompería la medida de calidad
       * y emitiría `LlamadaAISinPropuesta` culpando al modelo de algo que hizo bien.
       *
       * En los dos casos la línea SE CIERRA antes de relanzar: dejarla en `despachada` la deja
       * contando para el tope, sin desenlace y sin coste anotado, que es peor que cualquiera
       * de las dos etiquetas.
       */
      const intentos =
        e instanceof ErrorContratoAI
          ? respuesta.intentos.map((i, indice) =>
              indice === respuesta.intentos.length - 1
                ? { ...i, resultado: 'fuera-de-contrato' as const, motivo: e.message }
                : i,
            )
          : respuesta.intentos;
      await cerrarSinTaparElMotivo(actorId, entrada, intentos);
      throw e;
    }

    const { idSalidaValida } = await cerrarLlamadas(actorId, respuesta.intentos);
    const exitoso = respuesta.intentos[respuesta.intentos.length - 1]!;
    // Sin línea de gasto no hay propuesta: la FK lo impone y aquí se dice con un mensaje
    // legible en vez de dejar que reviente el insert.
    if (!idSalidaValida) {
      throw new ErrorAI('No se pudo registrar la llamada al proveedor: la generación se descarta');
    }
    return await persistirPropuestas(actorId, entrada, alcance, contenidos, {
      id: idSalidaValida,
      modelo: exitoso.modelo,
    });
  } catch (e) {
    // Nada nació: el hueco vuelve al presupuesto en el acto. Si la transacción de arriba
    // ya lo había consumido y luego falló, su rollback lo repuso — y este delete lo
    // vuelve a quitar, que es lo correcto: sigue sin haber propuestas.
    await liberarReserva(actorId, entrada.workspaceId, alcance.reservaId).catch(() => {});
    throw e;
  }
}

/** Persiste el lote consumiendo la reserva EN LA MISMA transacción (RF-09.12): el hueco
 * apartado y las filas que lo ocupan nacen o no nacen juntos. `llamadaId` es la línea del
 * libro de costos que ya quedó escrita: las propuestas de un lote cuelgan de ella. */
async function persistirPropuestas(
  actorId: string,
  entrada: GenerarPropuestas,
  alcance: Alcance,
  contenidos: ContenidoPropuesta[],
  llamada: { id: string; modelo: string },
): Promise<{ generadas: number }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    /*
     * Lo que la capacidad comprueba de la salida del modelo, AQUÍ y no antes: hace falta la
     * transacción que va a escribir, para que lo comprobado sea el mismo estado sobre el que
     * se escribe. Va delante del candado del presupuesto porque no lo necesita y porque
     * fallar aquí no debe tener a nadie esperando.
     */
    await COMPROBAR[entrada.capacidad](tx, entrada, contenidos, alcance.huellaMaterial);
    await bloquearPresupuesto(tx, entrada.workspaceId);

    // Retirar la reserva ya no «devuelve» presupuesto: desde que el tope cuenta llamadas
    // atendidas, lo que esta generación gastó está anotado en `llamada_ai` y contado para
    // todo el mundo desde antes de llegar aquí. La reserva solo decía «hay una generación
    // en vuelo sobre esta ancla», y eso deja de ser cierto ahora.
    //
    // Por eso tampoco se re-comprueba el presupuesto antes de escribir: la llamada ya se
    // pagó, y negarse a guardar su salida no des-gasta nada — solo tira lo comprado. El
    // tope frena donde puede frenar el gasto, que es la admisión (y el despacho, que exige
    // la reserva viva). Una reserva caducada no concede capacidad en ninguno de los dos.
    //
    // Y el borrado es el FENCING de este arrendamiento, no una limpieza: solo retira la
    // reserva si SEGUÍA siendo suya, o sea si no había caducado. Un proceso que se duerme
    // más de la ventana entre registrar la respuesta y llegar aquí ya no tiene la
    // exclusividad que creía tener: para entonces otra petición pudo recolectar la reserva
    // caducada, no ver propuestas pendientes y persistir su propio lote sobre la misma
    // ancla. Con un borrado incondicional, el dormido insertaba igual y quedaban los dos.
    //
    // Se comprueba en vez de estructurarse, y conviene decir por qué, porque en este repo
    // la estructura gana casi siempre: un índice único parcial de «pendientes por reto»
    // —el equivalente C0 de `propuesta_ai_item_pendiente_idx`— es IMPOSIBLE, porque C0
    // persiste un LOTE y sus propias filas hermanas lo violarían. El invariante no es «una
    // propuesta pendiente por reto» sino «un lote pendiente por reto», y eso no es una fila
    // que Postgres pueda rechazar. El token de exclusividad es la reserva, así que la
    // exclusividad se comprueba donde vive el token.
    const retirada = await tx`delete from reserva_ai
      where id = ${alcance.reservaId} and workspace_id = ${entrada.workspaceId}
        and creado_en > now() - reserva_ai_ventana()
      returning id`;
    if (retirada.length === 0) {
      // Cero filas tiene DOS causas y no la misma explicación. La reserva sigue ahí y solo
      // caducó, o ya no está porque alguien la retiró — y la retirada más frecuente, con
      // diferencia, es una revocación de consentimiento, que tiene su propio motivo y su
      // propia salida. Decir «caducó» en ese caso sería FALSO, así que se pregunta antes de
      // hablar. Se pregunta por las mismas funciones que lo imponen, para no acabar con una
      // tercera redacción de la regla.
      const [causa] = await tx`select
        exists (select 1 from reserva_ai
          where id = ${alcance.reservaId} and workspace_id = ${entrada.workspaceId}) as sigue,
        ${anclaEnColumna(entrada, 'item_id')}::uuid is not null
          and exists (select 1 from item_importacion i
            where i.id = ${anclaEnColumna(entrada, 'item_id')}::uuid
              and i.workspace_id = ${entrada.workspaceId}
              and tipo_fuente_exige_consentimiento(i.tipo_fuente)
              and not consentimiento_externo_vigente(i.id, i.workspace_id)) as sin_consentimiento`;
      if (causa?.sin_consentimiento) {
        throw new ErrorAI(
          'El consentimiento de ese material dejó de autorizar el procesamiento externo mientras la llamada estaba en curso: no se guarda ninguna propuesta (RF-09.5)',
        );
      }
      throw new ErrorAI(
        causa?.sigue
          ? 'La reserva de esta generación caducó antes de guardar sus propuestas: otra generación pudo tomar el relevo sobre la misma ancla, así que este lote se descarta. La llamada al proveedor ya está anotada en el libro de costos. Vuelve a pedirla.'
          : 'La reserva de esta generación se retiró mientras la llamada estaba en curso, así que este lote se descarta. La llamada al proveedor ya está anotada en el libro de costos.',
      );
    }

    const destino = CAPACIDADES[entrada.capacidad].destino;
    const anclas = anclasDelInsert(tx, entrada);
    // UNA sentencia para el lote entero: el evento PropuestaAIGenerada de cada fila lo
    // emite el guard DENTRO de este insert, así que el rol auditado es exactamente el que
    // autorizó la escritura (mismo snapshot).
    try {
      const filas = await tx`
      insert into propuesta_ai
        (workspace_id, capacidad, destino, ${anclas.columnas}, contenido, contenido_original,
         confianza, modelo, prompt_version, alcance_resumen, huella_material,
         alcance_evidencia, origen_key,
         llamada_id, orden, es_simulacion, creado_por)
      select ${entrada.workspaceId}, ${entrada.capacidad}, ${destino}, ${anclas.valores},
             c.contenido, c.contenido,
             -- La confianza que el modelo declara sobre CADA propuesta, traducida a la escala
             -- de la columna por una sola tabla. La columna existía y NADIE la escribía:
             -- toda propuesta no sembrada nacía en nulo, así que el panel presentaba todas
             -- como si mereciesen la misma atención — lo contrario de lo que una capacidad
             -- con revisión humana necesita. Se saca del contenido y no de un campo aparte
             -- para que viaje también en contenido_original y la corrección no la pueda
             -- maquillar sin que se vea.
             (${tx.json(CONFIANZA_PROPUESTA_NUMERICA)}::jsonb ->> (c.contenido ->> 'confianzaPropuesta'))::numeric,
             ${llamada.modelo}, ${PROMPT_VERSION}, ${alcance.alcanceResumen},
             -- La huella del material que el modelo tuvo delante, para las capacidades que la
             -- declaran. Se escribe al nacer y no se toca: un valor reescribible después no
             -- diría nada sobre lo que se leyó.
             ${alcance.huellaMaterial ?? null},
             -- Y el CONJUNTO de evidencia de ese material, que es la misma pregunta escrita
             -- de una forma que el suelo puede volver a hacerse: la huella es de un texto
             -- con formato y recorte, y no hay SQL que lo reconstruya. Ver «Preparacion».
             ${alcance.evidenciaDelMaterial ?? null},
             ${alcance.origenKey}, ${llamada.id},
             -- El puesto en el lote sale de la MISMA sentencia que inserta (with
             -- ordinality, que numera desde 1, de ahi el -1) y no de un contador aparte
             -- aparte: un contador en la aplicación sería otra redacción de la regla, y
             -- dos generaciones simultáneas lo empezarían las dos en cero. Aquí el puesto
             -- es una propiedad de la fila dentro de su propio lote, así que el índice
             -- único puede imponer el techo sin preguntar cuántas hay ya.
             (c.puesto - 1)::smallint,
             /*
              * SYS-20: la marca de SIMULACIÓN sale del registro y viaja al insert. La columna tiene
              * «default false», así que omitirla no dejaba un hueco visible: dejaba un false.
              * O sea que declarar esSimulacion: true en una capacidad futura habría PARECIDO
              * suficiente y sus hallazgos habrían llegado a la revisión sin la etiqueta que SYS-20
              * exige imborrable, presentables como propuestas ordinarias. Un valor declarado que no
              * llega a ninguna parte es peor que no declararlo: parece que está puesto.
              * (Sin comillas invertidas: esto vive en una template literal y las terminaría.)
              */
             ${CAPACIDADES[entrada.capacidad].esSimulacion},
             ${actorId}
      from jsonb_array_elements(${tx.json(contenidos)}) with ordinality as c(contenido, puesto)
      returning id`;
      return { generadas: filas.length };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // El índice único parcial: otra generación se adelantó con este item. Es el suelo
      // que garantiza UNA sola propuesta pendiente aunque nadie viera a nadie.
      if (err.code === '23505') {
        throw new ErrorAI(
          'Ese item ya tiene una propuesta pendiente: otra generación se adelantó y esta se descarta',
        );
      }
      // El guard del consentimiento (RF-09.5): el servicio ya lo comprobó antes de
      // construir el prompt, así que aquí solo llega por carrera o por SQL crudo.
      if (err.code === 'P0001' && err.message?.includes('consentimiento')) {
        throw new ErrorAI(
          'Ese material exige consentimiento registrado para procesamiento externo (RF-09.5)',
        );
      }
      // Y CUALQUIER otro `raise` del guard, que es lo que faltaba: el guard tiene más motivos
      // que el consentimiento —«ese item ya fue decidido», «ese reto ya no admite criterios
      // nuevos», «la propuesta debe colgar de la llamada que la produjo»— y todos salían de
      // aquí como PostgresError crudo. `mensajeDe` no traduce P0001, así que devolvía null y
      // la pantalla enseñaba «No se pudo pedir la propuesta; intenta de nuevo» en lugar del
      // motivo, que es justo el dato que dice qué hacer. La aceptación ya lo hacía así; era
      // la generación la mitad que se quedó fuera.
      if (err.code === 'P0001' && typeof err.message === 'string' && err.message.length > 0) {
        throw new ErrorAI(`${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}`);
      }
      throw e;
    }
  });
}

/** Candado del consentimiento de un item: la versión del registro nuevo se calcula
 * leyendo la máxima actual, y una consulta es un predicado sobre un snapshot — dos
 * curadores registrando a la vez leerían el mismo máximo. El índice único de la bitácora es
 * el suelo (uno de los dos fallaría); esto es lo que hace que ninguno tenga que fallar. */
/**
 * La puerta del CONSENTIMIENTO, gobernada por lo que la capacidad DECLARA.
 *
 * `exigeConsentimiento` estaba declarado y no lo leía nadie: el candado y la comprobación
 * vivían escritos a mano dentro de las entradas de CI en `PREPARAR` y `REVALIDAR`. Una
 * capacidad futura podía declarar `true` y mandar material de personas al proveedor sin
 * candado ni comprobación — el compilador no echaría nada de menos, porque no faltaba
 * ninguna entrada: faltaba que la bandera SIRVIERA para algo. Es el mismo defecto que este PR
 * quita en todos lados, y aquí con la peor consecuencia posible (RF-09.5).
 *
 * Ahora declararla ES encender la puerta. Y el orden de candados de la casa se conserva:
 * consentimiento (por item) primero, presupuesto (por workspace) después — este sigue siendo
 * el único camino que toma los dos, así que no hay ciclo posible.
 *
 * Devuelve la versión VIGENTE del consentimiento, que es lo que se anota en la llamada: el
 * dato es de la puerta, no de la capacidad, así que sale de aquí y no de `REVALIDAR`.
 *
 * PRECONDICIÓN, y la sujeta una prueba: una capacidad que exige consentimiento ancla en
 * `item_id`. El consentimiento es de material de PERSONAS y ese material vive en
 * `item_importacion` —allí están `tipo_fuente` y `consentimiento_item`—, así que la puerta
 * pregunta ahí. Si algún día el consentimiento alcanza a otra ancla, esa prueba enrojece en
 * vez de dejar la puerta abierta en silencio.
 */
async function exigirConsentimientoVigente(
  tx: TransactionSql,
  entrada: GenerarPropuestas,
  momento: 'antes-de-preparar' | 'antes-de-despachar',
): Promise<number | null> {
  const estado = await leerConsentimientoBajoCandado(tx, entrada);
  if (estado.falta) throw new ErrorAI(MOTIVO_SIN_CONSENTIMIENTO[momento]);
  return estado.version;
}

/** Los dos mensajes, que dependen del momento y no son cosméticos: antes de preparar, el
 * camino es registrar el consentimiento; al despachar, lo que importa es que el material NO
 * salió. */
const MOTIVO_SIN_CONSENTIMIENTO: Record<'antes-de-preparar' | 'antes-de-despachar', string> = {
  'antes-de-preparar':
    'Ese material es de personas: registra el consentimiento para procesarlo con un proveedor externo antes de pedir una propuesta (RF-09.5)',
  'antes-de-despachar':
    'El consentimiento de ese material dejó de autorizar el procesamiento externo antes de despachar la llamada: el material no salió hacia el proveedor (RF-09.5)',
};

/**
 * Toma el candado y LEE; no decide.
 *
 * La separación la pidió una revisión y corrige una precedencia que rompí al centralizar la
 * puerta: con la comprobación delante de `PREPARAR`, una petición rancia contra un item YA
 * CURADO recibía «registra el consentimiento» — una instrucción que no lleva a ninguna parte,
 * porque después de registrarlo el item sigue curado y la generación falla igual. El orden de
 * los CANDADOS y el orden de los MENSAJES no son la misma pregunta: el candado va primero
 * porque leer y reservar tienen que ser atómicos; el mensaje va donde el usuario pueda actuar.
 */
async function leerConsentimientoBajoCandado(
  tx: TransactionSql,
  entrada: GenerarPropuestas,
): Promise<{ falta: boolean; version: number | null }> {
  // Candado por item ANTES de leer: leer el consentimiento y apartar la reserva tienen que ser
  // atómicos respecto a `registrarConsentimiento`, o una revocación podría colarse entre ambos
  // y quedarse sin nada que retirar.
  await bloquearConsentimiento(tx, entrada.anclaId);
  const [item] = await tx`select
      tipo_fuente_exige_consentimiento(tipo_fuente)
        and not consentimiento_externo_vigente(id, workspace_id) as falta,
      case when tipo_fuente_exige_consentimiento(tipo_fuente) then
        (select c.version from consentimiento_item c
          where c.item_id = item_importacion.id
            and c.workspace_id = item_importacion.workspace_id
          order by c.version desc limit 1)
      end as version_vigente
    from item_importacion
    where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}`;
  /*
   * La versión que ampara ESTA salida, leída bajo el candado y en la misma transacción que la
   * aprueba. Viaja al libro de llamadas para que «bajo qué permiso salió» sea un hecho
   * consultable y no una reconstrucción por fechas.
   *
   * `null` EXACTAMENTE cuando el tipo de fuente no exige consentimiento, que es lo que la base
   * impone en los dos sentidos: con material de personas es obligatorio citar uno, sin él está
   * prohibido. Si se leyera «la última versión que haya», un item de tipo `nota` con un
   * consentimiento registrado por si acaso citaría uno y el guard lo rechazaría — y con razón,
   * porque ese `null` es el que significa «no aplicaba».
   */
  return {
    falta: Boolean(item?.falta),
    version:
      item?.version_vigente === null || item?.version_vigente === undefined
        ? null
        : Number(item.version_vigente),
  };
}

async function bloquearConsentimiento(tx: TransactionSql, itemId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:consentimiento:' || ${itemId}, 42))`;
}

/**
 * Registra el consentimiento de las personas sobre el material de un item (RF-09.5),
 * ANTES de procesarlo. No lo propone ni lo infiere la AI: lo declara la persona que
 * condujo la investigación, y queda atribuido por la política.
 *
 * Es una BITÁCORA append-only: cada registro es una fila nueva —sin grant de UPDATE ni de
 * DELETE, así que ninguno se reescribe ni se borra— y el que manda es el VIGENTE. Con un
 * único registro por item, quien anotaba honestamente «autorizó solo el uso interno»
 * (`procesamientoExterno: false`) dejaba el item bloqueado para siempre: el append-only
 * impedía corregirlo y la clave impedía añadir el permiso que la persona diera después. El
 * consentimiento no es un estado que se fija una vez, es una sucesión de hechos fechados —
 * y por eso mismo una revocación futura (RF-09.4) encaja aquí sin tocar nada: es otro
 * registro, y al ser el vigente vuelve a bloquear.
 */
export async function registrarConsentimiento(
  actorId: string,
  entrada: RegistrarConsentimiento,
): Promise<{ version: number; autorizaExterno: boolean }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId);
    const [item] = await tx`select
        tipo_fuente_exige_consentimiento(tipo_fuente) as de_personas
      from item_importacion
      where id = ${entrada.itemId} and workspace_id = ${entrada.workspaceId}`;
    if (!item) throw new ErrorAI('El item no existe en este workspace');
    // Un consentimiento sobre una nota o un documento no significa nada: no hay personas
    // que autoricen nada, ninguna lectura del pipeline lo consulta y la bitácora del panel
    // ni siquiera lo ofrece. Aceptarlo era dejar el endpoint como palanca para otra cosa
    // —de hecho lo fue: hizo general una excepción de la política de `reserva_ai` que solo
    // debía aplicar al material de personas—.
    if (!(item.de_personas as boolean)) {
      throw new ErrorAI(
        'Ese item no es material de personas: no hay consentimiento que registrar sobre él',
      );
    }
    await bloquearConsentimiento(tx, entrada.itemId);
    try {
      // `version` no viaja: la asigna el guard (y no está en el grant de insert), porque
      // quien pudiera escribirla podría colar un registro «vigente» que no es el último.
      const [fila] = await tx`insert into consentimiento_item
        (item_id, workspace_id, alcance, procesamiento_externo, registrado_por)
        values (${entrada.itemId}, ${entrada.workspaceId}, ${entrada.alcance},
                ${entrada.procesamientoExterno}, ${actorId})
        returning version, procesamiento_externo`;
      // El registro nuevo NO autoriza el procesamiento externo (una revocación, o un
      // permiso solo interno que sustituye a uno más amplio): se retira el token de
      // despacho de cualquier generación en vuelo sobre este item, en la MISMA transacción
      // que lo hace vigente. Sin esto, registrar la revocación no tenía ningún efecto sobre
      // la llamada que estaba a punto de salir — el permiso cambiaba y el material se iba
      // igual. La reserva se retira, así que el despacho se detiene al comprobarla.
      if (!entrada.procesamientoExterno) {
        await bloquearPresupuesto(tx, entrada.workspaceId);
        await tx`delete from reserva_ai
          where workspace_id = ${entrada.workspaceId} and item_id = ${entrada.itemId}`;
      }
      return {
        version: Number(fila!.version),
        autorizaExterno: fila!.procesamiento_externo as boolean,
      };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ErrorAI(
          'Otro registro de consentimiento sobre este item se adelantó: vuelve a intentarlo',
        );
      }
      throw e;
    }
  });
}

/** Datos mínimos de la propuesta que se está revisando. */
type PropuestaEnRevision = {
  capacidad: CapacidadActiva;
  /**
   * `Destino | null`, y ese `null` es lo que hace que el compilador pida una decisión.
   *
   * Estaba escrito como la unión de los dos literales A MANO, y por eso volver `destino`
   * anulable en el registro no rompió aquí NADA: una propuesta informativa se leía con su
   * `null` disfrazado de destino y llegaba entera hasta `MATERIALIZAR[p.destino]`, que
   * devolvía `undefined` y reventaba al llamarlo — sin decir por qué, y después de haber
   * pasado por la corrección y las citas. El mismo defecto que este pipeline ya conoce: un
   * tipo que copia a mano lo que otro declara deja de comprobar el día que aquél cambia.
   *
   * Escrito como el registro lo declara, `aceptarPropuesta` no compila hasta que alguien
   * diga qué pasa cuando no hay destino. Y lo que pasa está abajo: no se acepta.
   */
  destino: Destino | null;
  /**
   * El id del ancla, el de la columna que SU capacidad declara.
   *
   * Aquí había `itemId` y `retoId`, y los materializadores tomaban el suyo con un `!`. Eso
   * dejaba fuera del alcance a toda ancla nueva: la proyección seleccionaba dos columnas, así
   * que un materializador de un ancla distinta no recibía ningún id —y uno de los de ahora,
   * si le tocaba una fila con el ancla en otra columna, recibía `null` y reventaba contra su
   * FK—. Preguntando por la columna declarada no hay `!` que justificar ni columna que
   * adivinar: la propuesta cuelga de donde su capacidad dice.
   */
  anclaId: string;
  /** Y todas las declaradas, tal cual vienen, para quien necesite mirar más de una. */
  anclas: Record<AnclaCapacidad['columna'], string | null>;
  contenido: ContenidoPropuesta;
  /** Lo que dijo el modelo, intacto (SYS-17). Es contra esto —y no contra el contenido
   * vigente— contra lo que se comprueba que una corrección no toque las citas. */
  contenidoOriginal: ContenidoPropuesta;
  modelo: string;
  promptVersion: string;
};

async function leerParaRevisar(
  tx: TransactionSql,
  workspaceId: string,
  propuestaId: string,
): Promise<PropuestaEnRevision> {
  // Las columnas de ancla salen del registro, como en los tres inserts: escritas a mano,
  // esta proyección se quedaba en dos y el materializador de la tercera no recibía su id.
  const columnasDeAncla = COLUMNAS_DE_ANCLA.map((c) => tx`${tx(c)}`).reduce(
    (a, b) => tx`${a}, ${b}`,
  );
  const [p] = await tx`select capacidad, destino, ${columnasDeAncla}, contenido,
      contenido_original, modelo, prompt_version, estado
    from propuesta_ai where id = ${propuestaId} and workspace_id = ${workspaceId}`;
  if (!p) throw new ErrorAI('La propuesta no existe en este workspace');
  if ((p.estado as string) !== 'propuesta') {
    throw new ErrorAI('Esa propuesta ya fue revisada: las decisiones son inmutables');
  }
  const capacidad = p.capacidad as CapacidadActiva;
  const anclas = Object.fromEntries(
    COLUMNAS_DE_ANCLA.map((c) => [c, (p[c] ?? null) as string | null]),
  ) as PropuestaEnRevision['anclas'];
  const anclaId = anclas[CAPACIDADES[capacidad].ancla.columna];
  // El CHECK de `propuesta_ai` ata destino y ancla, así que llegar aquí sin ella significa que
  // alguien escribió por SQL directo saltándose la restricción. Se dice en vez de seguir con
  // un `null` que reventaría más adelante contra una FK, sin decir por qué.
  if (!anclaId) {
    throw new ErrorAI('Esa propuesta no tiene ancla en la columna que su capacidad declara');
  }
  return {
    capacidad,
    destino: p.destino as PropuestaEnRevision['destino'],
    anclaId,
    anclas,
    contenido: p.contenido as ContenidoPropuesta,
    contenidoOriginal: p.contenido_original as ContenidoPropuesta,
    modelo: p.modelo as string,
    promptVersion: p.prompt_version as string,
  };
}

/**
 * Aceptar (o corregir y aceptar) una propuesta: **la materialización y el sello de la
 * propuesta ocurren en la misma transacción**, y el objeto queda firmado por quien acepta
 * — la política exige `creado_por = app_user_id()` y el constraint diferido comprueba que
 * el objeto materializado sea el del ancla y lleve esa firma (SYS-19).
 *
 * Corregir conserva siempre el original (SYS-17) y deja su propio evento; una corrección
 * idéntica al original no es una corrección y se registra como aceptación literal.
 */
export async function aceptarPropuesta(
  actorId: string,
  entrada: RevisarPropuesta,
): Promise<{ estado: 'aceptada' | 'corregida'; objetoId: string }> {
  // El guard de materialización es un constraint trigger DIFERIDO: habla en el COMMIT, o sea
  // FUERA del callback de la transacción, así que ningún `try` de dentro lo alcanza. Sin
  // esta traducción su rechazo sale como PostgresError crudo, y `mensajeDe` devuelve null
  // para P0001 — la server function relanza y el revisor se encuentra el error boundary del
  // router en vez de un motivo. Es el mismo fallo que el `catch` de `materializarCriterio`
  // tenía con el registry firmado, un nivel más arriba.
  //
  // Casi todas sus reglas son inalcanzables desde el servicio (él sella el item, firma el
  // criterio y crea el objeto en esta misma transacción), pero una no lo es: entre que
  // `materializarCriterio` lee `reto_admite_criterios` y que su INSERT toma la fila del
  // reto cabe un `update reto` crudo, y entonces el guard lo ve en el commit. Se traduce el
  // conjunto y no solo esa: son mensajes escritos para una persona, y dejar caer los otros
  // por «no deberían pasar» es exactamente cómo se descubren con una pantalla rota.
  //
  // El mensaje se pasa TAL CUAL, sin añadirle una salida. La tentación era rematarlo con
  // «esta propuesta quedó obsoleta y solo puede rechazarse», pero por aquí pasan también
  // los `raise` del guard de revisión —«una corrección debe cambiar el contenido propuesto»,
  // «las citas no se corrigen»—, donde esa coletilla sería falsa: la propuesta está
  // perfectamente viva y lo que hay que arreglar es el envío. Cada guard ya dice lo suyo;
  // esto solo lo convierte en un error de dominio en vez de en una pantalla rota.
  try {
    return await aceptarPropuestaEnTransaccion(actorId, entrada);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'P0001' && typeof err.message === 'string' && err.message.length > 0) {
      throw new ErrorAI(`${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}`);
    }
    throw e;
  }
}

async function aceptarPropuestaEnTransaccion(
  actorId: string,
  entrada: RevisarPropuesta,
): Promise<{ estado: 'aceptada' | 'corregida'; objetoId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId);
    const p = await leerParaRevisar(tx, entrada.workspaceId, entrada.propuestaId);

    let contenido = p.contenido;
    // PRESENTE, no verdadera: la frontera transporta la corrección sin juzgarla (`unknown`),
    // así que un `null` enviado como corrección es una corrección con forma inválida —y muere
    // abajo con su mensaje—, no una aceptación de lo propuesto.
    if (entrada.correccion !== undefined) {
      try {
        contenido = parsearContenido(p.capacidad, entrada.correccion);
      } catch {
        throw new ErrorAI('La corrección no cumple el formato de la capacidad');
      }
      // Las citas NO se corrigen. Son el testimonio del modelo sobre lo que dijo haber
      // leído y la entrada de la medida de grounding: reescribir una cita inventada por
      // otra literal deja una propuesta con aspecto impecable y borra justo la señal que
      // hay que ver. Corregir el resto —título, resumen, fechas, dimensiones— es la razón
      // de ser de la corrección; esto no.
      //
      // El formulario del panel ya reenvía las originales, pero eso era una convención de
      // una pantalla: cualquier cliente que hable con la server function podía mandar otras.
      // Se compara contra el ORIGINAL y no contra el contenido vigente, que es lo mismo
      // mientras la propuesta esté pendiente pero dice mejor de dónde sale la verdad.
      // Vale para las DOS capacidades desde que C0 también cita: la regla es de las citas,
      // no del destino, y atarla a `evidencia` habría dejado las de C0 editables el día que
      // existieron.
      // Se comparan CANÓNICAMENTE y no con `JSON.stringify` a secas: un lado viene de Zod
      // (orden de la forma declarada) y el otro de `jsonb` (orden por longitud y luego
      // bytes). Hoy coinciden por casualidad, con dos claves; el día que se añada una
      // tercera que ordene distinto —`pagina`, por ejemplo— toda corrección se rechazaría con
      // «las citas no se corrigen» aunque fueran idénticas. El guard de la base compara
      // `jsonb`, que es insensible al orden, así que el suelo y el servicio discreparían.
      // DÓNDE están las citas lo dice la capacidad, no la forma del objeto. Leerlas como
      // `contenido.citas` funcionaba con tres capacidades que las tenían al final; con las de
      // C2 dentro de cada afirmación, esa lectura habría dado `undefined` en los dos lados y
      // la regla habría pasado EN VACÍO, dejando editables justo las citas que no se tocan.
      if (
        canonico(CITAS_DEL_CONTENIDO[p.capacidad](contenido)) !==
        canonico(CITAS_DEL_CONTENIDO[p.capacidad](p.contenidoOriginal))
      ) {
        throw new ErrorAI(
          'Las citas de una propuesta no se corrigen: son el rastro de lo que el modelo dijo haber leído. Corrige el resto, o rechaza la propuesta si sus citas no se sostienen.',
        );
      }
      /*
       * Y lo que cada capacidad declare intocable ADEMÁS de sus citas, por registro y no por
       * un `if` sobre la capacidad: el guardián de ramas binarias de este pipeline existe
       * justo para eso, y lo cazó cuando esto era un `if`.
       *
       * Hoy solo C2, con sus contradicciones; el motivo lo escribe la capacidad, porque quien
       * lo lee necesita saber QUÉ no se toca y no «algo». Cerraba además un agujero de
       * alcance: `parsearContenido` admite cambiarlas y nada comprobaba que la evidencia nueva
       * fuera del reto —`contradiccion` solo lleva la FK del tenant—, así que una corrección
       * podía apuntar a cualquiera del workspace y la aceptación la materializaba.
       */
      const adicional = TESTIMONIO_ADICIONAL[p.capacidad];
      if (
        adicional &&
        canonico(adicional.parte(contenido)) !== canonico(adicional.parte(p.contenidoOriginal))
      ) {
        throw new ErrorAI(adicional.motivo);
      }
    }
    /*
     * Una propuesta INFORMATIVA no se acepta, y aquí es donde se dice.
     *
     * RF-08.4: CT «reporta huecos citando objetos; carece de acción aprobar». No hay objeto
     * que crear, así que «aceptar» no significaría nada — y el CHECK
     * `(estado in ('aceptada','corregida')) = (coalesce(evidencia_id, criterio_id) is not null)`
     * de la base lo rechazaría de todas formas, pero con un error de restricción en vez de
     * con un motivo. Quien lo lea merece saber que no es un fallo suyo: ese informe se lee y
     * se descarta, y el gate lo aprueba una persona con su rol (SYS-18).
     *
     * Es también el narrowing que `MATERIALIZAR[p.destino]` necesita: sin este corte, el
     * compilador se niega a indexar un `Record<Destino, …>` con `Destino | null`. Esa
     * negativa es la costura funcionando — pide una decisión antes de dejar pasar.
     */
    if (p.destino === null) {
      throw new ErrorAI(
        `${CAPACIDADES[p.capacidad].etiqueta} es una capacidad INFORMATIVA: su propuesta no crea ningún objeto, así que no se acepta. Léela y descártala; lo que decida sobre el objeto de origen lo decide una persona con su rol.`,
      );
    }
    // El destino y la forma del contenido van atados por el CHECK de la tabla y por el
    // esquema de la capacidad; el narrowing lo hace explícito para el compilador.
    /*
     * La materialización se despacha por el DESTINO declarado, no con un ternario. Con
     * `p.destino === 'evidencia' ? … : …`, todo destino que no fuera evidencia caía en
     * `materializarCriterio` — así que un destino nuevo se materializaba como criterio y
     * fallaba contra su propio guard, en vez de usar su objeto de dominio.
     * `Record<Destino, …>` hace que el compilador exija la entrada de cada uno.
     */
    const MATERIALIZAR: Record<
      Destino,
      () => Promise<string>
    > = {
      evidencia: () =>
        materializarEvidencia(
          tx,
          actorId,
          entrada.workspaceId,
          p,
          contenido as ContenidoExtraccion,
        ),
      'criterio-exito': () =>
        materializarCriterio(tx, actorId, entrada.workspaceId, p, contenido as ContenidoCriterio),
      insight: () =>
        materializarInsight(tx, actorId, entrada.workspaceId, p, contenido as ContenidoInsight),
      'entrada-kpi': () =>
        materializarEntradaKpi(
          tx,
          actorId,
          entrada.workspaceId,
          p,
          contenido as ContenidoEntradaKpi,
        ),
    };
    const objetoId = await MATERIALIZAR[p.destino]();

    // Corregida o aceptada lo decide la BASE comparando jsonb con jsonb: normaliza claves
    // y espacios, así que un reordenamiento del round-trip por Zod no se contabiliza como
    // corrección humana (y el guard, que compara igual, no ve una contradicción).
    const [sellada] = await tx`
      update propuesta_ai
      set estado = case when contenido is distinct from ${tx.json(contenido)}::jsonb
                        then 'corregida' else 'aceptada' end,
          contenido = ${tx.json(contenido)}::jsonb,
          revisada_por = ${actorId},
          -- El enlace se escribe EN la columna que el destino nombra: el nombre viaja como
          -- identificador, no como una etiqueta contra la que comparar.
          --
          -- (Sin comillas invertidas: esto vive en una template literal y las terminaría.)
          --
          -- Antes esto eran dos asignaciones fijas gobernadas por dos ternarios sobre
          -- «COLUMNA_DE_DESTINO». Consultar el mapa parecía cerrar el caso y no cerraba nada:
          -- lo que decidía dónde iba el id seguían siendo los dos nombres escritos en el SQL,
          -- así que un destino nuevo hacía fallar los dos ternarios, dejaba las dos columnas
          -- en null y sellaba una propuesta aceptada sin objeto. Preguntarle el nombre a un
          -- mapa y luego no usarlo para nada es exactamente el binario de antes con un
          -- testigo delante.
          --
          -- Las demás columnas de destino no se tocan porque no hay nada que borrar: solo se
          -- llega aquí con «estado = 'propuesta'» (el WHERE lo exige) y solo este UPDATE las
          -- escribe, así que están todas en null. El CHECK de «propuesta_ai» que ata
          -- «estado in (aceptada, corregida)» a tener enlace es el respaldo en la base: un
          -- destino cuya columna nueva no entre en ese CHECK no se sella a medias, revienta.
          ${tx(COLUMNA_DE_DESTINO[p.destino])} = ${objetoId}
      where id = ${entrada.propuestaId} and workspace_id = ${entrada.workspaceId}
        and estado = 'propuesta'
      returning estado`;
    if (!sellada) {
      throw new ErrorAI('Esa propuesta ya fue revisada por otra persona');
    }
    return { estado: sellada.estado as 'aceptada' | 'corregida', objetoId };
  });
}

/** CI: la aceptación ES la curaduría (SYS-16). Crea fuente + evidencia con las cinco
 * dimensiones y sella el item de la bandeja con esa evidencia; si otro curador lo decidió
 * a mano mientras tanto, el update afecta 0 filas y toda la transacción se revierte. */
async function materializarEvidencia(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  p: PropuestaEnRevision,
  c: ContenidoExtraccion,
): Promise<string> {
  // El MISMO candado que toma `registrarConsentimiento`, y por el mismo motivo que lo toma
  // `prepararAlcance` antes de despachar: lo que se va a leer aquí es exactamente lo que ese
  // camino muta. Sin compartirlo, la lectura de abajo es un predicado sobre un snapshot y una
  // revocación que commitea justo después entra por la rendija — el guard diferido la para en
  // el commit, pero con un error del suelo en vez del que dice cómo salir. El candado no es lo
  // que cierra la ventana: es lo que hace que el orden sea determinista y el mensaje, el bueno.
  await bloquearConsentimiento(tx, p.anclaId);
  const [item] = await tx`select titulo, tipo_fuente, referencia,
      tipo_fuente_exige_consentimiento(tipo_fuente)
        and not consentimiento_externo_vigente(id, workspace_id) as consentimiento_retirado
    from item_importacion
    where id = ${p.anclaId} and workspace_id = ${workspaceId} and estado = 'pendiente'`;
  if (!item) throw new ErrorAI('El item de la bandeja ya fue curado o no existe');
  // La otra mitad del permiso, y una ventana distinta de la del despacho: la propuesta se
  // generó con consentimiento vigente y la persona lo retiró DESPUÉS. Aceptar crearía un
  // objeto de dominio nuevo derivado de material que ya no está autorizado. Rechazarla
  // sigue disponible, y curar el item a mano en la bandeja también: eso no manda nada a
  // ningún tercero. El guard de `propuesta_ai` es el suelo; esto lo dice con nombre.
  if (item.consentimiento_retirado as boolean) {
    throw new ErrorAI(
      'El consentimiento de ese material ya no autoriza el procesamiento externo: esta propuesta quedó obsoleta y solo puede rechazarse (RF-09.5)',
    );
  }
  // El consentimiento se registró ANTES de procesar (RF-09.5) o no se registró: la
  // evidencia dice cuál de las dos, y no lo decide ni lo propone la AI. Aquí la pregunta es
  // si LLEGÓ A CAPTURARSE el consentimiento de las personas —por eso basta con que exista
  // algún registro en la bitácora—, no si cubre al proveedor externo: esa segunda pregunta
  // es la que decide si el material puede salir, y se hace sobre el registro vigente donde
  // toca, antes de construir el prompt y en el guard de la propuesta.
  const [consentimiento] = await tx`select 1 as hay from consentimiento_item
    where item_id = ${p.anclaId} and workspace_id = ${workspaceId} limit 1`;

  // Sin fecha no hay proveniencia, y la proveniencia es obligatoria en una evidencia
  // (`DimensionesEvidenciaSchema` la exige, y con razón: una evidencia sin fecha no se puede
  // situar en el tiempo). Que el modelo pueda decir «el material no la trae» es lo que evita
  // que se la invente; ponerla es entonces trabajo del humano, y aprobar incluye enmendar
  // (I4). Se dice con el motivo que dio el modelo, para que la curadora sepa qué buscar.
  if (c.fecha === null) {
    throw new ErrorAI(
      `Esa propuesta no trae fecha del material${
        c.fechaSinDatoMotivo ? ` (${c.fechaSinDatoMotivo})` : ''
      }: una evidencia se sitúa en el tiempo, así que corrígela añadiendo la fecha antes de aceptarla`,
    );
  }
  const dimensiones = DimensionesEvidenciaSchema.parse({
    proveniencia: {
      tipoFuente: item.tipo_fuente as string,
      fecha: c.fecha,
      localizacion: item.referencia as string,
    },
    metodo: { recoleccion: c.recoleccion, derivada: c.derivada, segmentoIds: [] },
    calidad: { confianza: c.confianza, corroboraIds: [], contradiceIds: [] },
    // Los DERECHOS no los propone la AI: el consentimiento se captura antes de procesar
    // (RF-09.5) y jamás se infiere de un texto. Aquí solo se COPIA lo que quedó
    // registrado sobre el item — antes nacía siempre en falso, lo que obligaba a
    // reparar a mano una evidencia cuyo consentimiento sí constaba.
    derechos: {
      consentimiento: Boolean(consentimiento),
      confidencialidad: c.confidencialidad,
    },
    // SYS-19: esta evidencia SÍ pasó por una transformación AI y lo dice para siempre.
    // Las citas literales viven en la propuesta aceptada, que queda enlazada a esta fila.
    lineage: { modelo: p.modelo, promptVersion: p.promptVersion },
  });

  const [fuente] = await tx`insert into fuente (workspace_id, tipo, titulo, referencia, creado_por)
    values (${workspaceId}, ${item.tipo_fuente as string}, ${item.titulo as string},
            ${item.referencia as string}, ${actorId})
    returning id`;
  const [evidencia] = await tx`insert into evidencia
    (workspace_id, fuente_id, titulo, resumen, dimensiones, es_estado_actual, creado_por)
    values (${workspaceId}, ${fuente!.id as string}, ${c.titulo}, ${c.resumen},
            ${tx.json(dimensiones)}, ${c.esEstadoActual}, ${actorId})
    returning id`;
  const evidenciaId = evidencia!.id as string;

  // Toda evidencia nace CON su registro de derechos, en la MISMA transacción: es lo que
  // exige el constraint trigger diferido de SPEC-03, y sin esta línea aceptar una propuesta
  // de extracción fallaba SIEMPRE al commit — la capacidad entera quedaba inservible.
  //
  // Nacen PENDIENTES, exactamente como en la curaduría a mano, y esa paridad es el punto.
  // La tentación es la contraria: quien acepta ya está firmando, así que «que declare los
  // derechos de paso». Pero conceder el uso es OTRO acto, con su propia base documental y su
  // propio responsable —lo dice el mismo comentario que gobierna `aprobarItem`—, y hacer que
  // el camino AI lo resuelva de un plumazo convertiría la aceptación de una propuesta en un
  // atajo alrededor de un control que la ruta manual sí impone. La tesis de este slice es
  // justo la contraria: aceptar una propuesta ES la escritura humana, con las MISMAS reglas.
  //
  // Y menos aún se puede derivar «concedido» de lo que dijera el modelo o de los metadatos
  // del item: eso sería fabricar consentimiento a partir de un texto, que es la clase de
  // falsificación que este slice existe para impedir. El `derechos.consentimiento` de las
  // dimensiones es la FOTO de lo que constaba al curar; el permiso de uso es esta tabla, y
  // la escribe una persona.
  await tx`insert into derecho_uso (workspace_id, evidencia_id, creado_por)
    values (${workspaceId}, ${evidenciaId}, ${actorId})`;

  const selladas = await tx`update item_importacion
    set estado = 'aprobado', decidido_por = ${actorId}, decidido_en = now(),
        evidencia_id = ${evidenciaId}
    where id = ${p.anclaId} and workspace_id = ${workspaceId} and estado = 'pendiente'
    returning workspace_role(${actorId}, ${workspaceId}) as rol`;
  if (selladas.length === 0) throw new ErrorAI('El item ya fue decidido por otra persona');
  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (${workspaceId}, 'EvidenciaCurada',
      ${tx.json({ itemId: p.anclaId, evidenciaId, origen: 'propuesta-ai' })},
      ${actorId}, ${selladas[0]!.rol as string})`;
  return evidenciaId;
}

/** C0: el criterio nace bajo el reto de la propuesta, firmado por quien acepta y SIN
 * línea base inventada (solo el plan para obtenerla — SYS-22 exige valor+fecha o plan). */
/**
 * C2: la aceptación crea el insight ENTERO — sus afirmaciones y las citas de cada una, y las
 * contradicciones si las señaló.
 *
 * Es el primer objeto COMPUESTO que materializa el pipeline, y por eso el orden importa: las
 * políticas de `afirmacion` y `cita` exigen que su insight esté en `propuesto`, así que se
 * crea primero y todo cuelga dentro de la MISMA transacción. Si algo falla —una evidencia
 * citada que ya no está, por ejemplo— no queda un insight a medias: no queda nada.
 *
 * El `orden` de cada afirmación sale de su posición en el contenido, que es el que el modelo
 * propuso y el revisor leyó. No se reordena por nada: `afirmacion` tiene único
 * `(insight_id, orden)` y lo que se acepta es LO QUE SE VIO.
 *
 * Las citas apuntan a la EVIDENCIA por su id. Que ese id sea de una evidencia real y del
 * tenant lo sujeta su FK compuesta; que sea de las que se le enseñaron al modelo lo sujeta el
 * trigger de la migración de C2. Aquí no se vuelve a comprobar: repetir una regla en un
 * tercer sitio es cómo las tres empiezan a divergir.
 */
async function materializarInsight(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  p: PropuestaEnRevision,
  c: ContenidoInsight,
): Promise<string> {
  // El reto tiene que SEGUIR sin archivar. Entre generar y aceptar hay una segunda vida
  // entera y el ciclo de vida del reto avanza solo; aceptar después colgaría un insight de un
  // trabajo ya cerrado. Mismo razonamiento que `materializarCriterio`, con su propio
  // predicado: lo que congela criterios (G0, registry) no dice nada sobre insights.
  await bloquearReto(tx, p.anclaId);
  const [reto] = await tx`select estado from reto
    where id = ${p.anclaId} and workspace_id = ${workspaceId}`;
  if ((reto?.estado as string | undefined) === 'archivado') {
    throw new ErrorAI(
      'Ese reto se archivó: su trabajo se cerró y esta propuesta quedó obsoleta, así que solo puede rechazarse',
    );
  }
  const [insight] = await tx`insert into insight
    (workspace_id, titulo, resumen, estado, creado_por)
    values (${workspaceId}, ${c.titulo}, ${c.resumen}, 'propuesto', ${actorId})
    returning id`;
  const insightId = insight!.id as string;
  for (const [orden, a] of c.afirmaciones.entries()) {
    const [afirmacion] = await tx`insert into afirmacion
      (workspace_id, insight_id, orden, texto, es_hipotesis)
      values (${workspaceId}, ${insightId}, ${orden}, ${a.texto}, ${a.esHipotesis})
      returning id`;
    for (const cita of a.citas) {
      try {
        await tx`insert into cita
          (workspace_id, afirmacion_id, evidencia_id, fragmento, localizacion, creado_por)
          values (${workspaceId}, ${afirmacion!.id as string}, ${cita.evidenciaId},
                  ${cita.fragmento}, ${cita.localizacion}, ${actorId})`;
      } catch (e) {
        /*
         * DR001 es el código de los DERECHOS: citar una evidencia exige que siga siendo
         * usable (SPEC-03/SYS-14), y entre generar y aceptar cabe una revocación entera —es
         * el mismo hueco que el consentimiento retirado, con otro registro—. Sin traducirlo,
         * el rechazo sale como error crudo del driver a una pantalla de revisión, y quien
         * revisa no puede saber que lo que falta son derechos ni de qué evidencia.
         *
         * El motivo del guard ya nombra la evidencia y la causa; se antepone lo que hay que
         * hacer con la propuesta, que es lo que el guard no puede saber. Ninguna otra causa
         * se disfraza: cualquier otro error se relanza tal cual.
         */
        const err = e as { code?: string; message?: string };
        if (err.code === 'DR001') {
          throw new ErrorAI(
            `Este insight cita evidencia que ya no se puede citar. ${err.message ?? ''} ` +
              'Los derechos no los propone la AI: repón los de esa evidencia, o rechaza la propuesta.',
          );
        }
        throw e;
      }
    }
  }
  for (const contra of c.contradicciones) {
    await tx`insert into contradiccion
      (workspace_id, insight_id, evidencia_id, descripcion, creado_por)
      values (${workspaceId}, ${insightId}, ${contra.evidenciaId}, ${contra.descripcion},
              ${actorId})`;
  }
  return insightId;
}

/**
 * Materializa una entrada del Metric Registry: UNA fila, y solo los seis campos que la
 * propuesta dicta.
 *
 * El resto de columnas nace vacío A PROPÓSITO —el dueño del dato, la línea base, el inicio de
 * la ventana, el dashboard y la fecha del post mortem—, y eso no deja la entrada rota: la
 * tabla admite entradas incompletas porque el registry se redacta iterando, y la completitud
 * la exige la FIRMA. Lo que sí quedaría roto es lo contrario: rellenar un compromiso que nadie
 * adquirió y que aceptar la propuesta firmaría.
 *
 * `creado_en` no se escribe, y esa ausencia es una prueba, no un descuido: la pone la base, no
 * está en el grant de columnas, y el guard diferido exige `creado_en = now()` para distinguir
 * «nació en esta aceptación» de «alguien la actualizó aquí» —que es lo que `xmin` solo no
 * distingue—.
 */
async function materializarEntradaKpi(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  p: PropuestaEnRevision,
  c: ContenidoEntradaKpi,
): Promise<string> {
  // El MISMO candado que toma `agregarEntrada`, y el mismo que toma la firma: sin él, este
  // insert y una firma concurrente pueden commitear juntos y congelar un contrato con una
  // entrada que nadie revisó dentro.
  await tx`select pg_advisory_xact_lock(
    hashtextextended('designio:registry:' || ${p.anclaId}, 42))`;
  // Y el registry tiene que SEGUIR admitiendo entradas, que entre generar y aceptar hay una
  // segunda vida entera. El guard diferido lo vuelve a preguntar en el commit —ése es el
  // suelo—; esto es para que el motivo llegue con nombre a quien revisa en vez de como un
  // rechazo del suelo.
  const [registry] = await tx`select
    registry_admite_entradas(${p.anclaId}::uuid, ${workspaceId}::uuid) as admite`;
  if (!registry?.admite) {
    throw new ErrorAI(
      'Ese Metric Registry ya no admite entradas: o se firmó —y firmarlo congela el contrato—, o el trabajo de su reto se cerró. Esta propuesta quedó obsoleta y solo puede rechazarse',
    );
  }
  try {
    const [entrada] = await tx`insert into entrada_kpi
      (workspace_id, registry_id, criterio_id, nombre, definicion, fuente, dimensiones,
       propietario_miembro_id, frecuencia, dashboard_url, linea_base_valor, linea_base_fecha,
       ventana_inicio, fecha_post_mortem, creado_por)
      values (${workspaceId}, ${p.anclaId}, ${c.criterioId}, ${c.nombre}, ${c.definicion},
              ${c.fuente}, ${c.dimensiones}, null, ${c.frecuencia}, '', null, null, null, null,
              ${actorId})
      returning id`;
    return entrada!.id as string;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    // Cada causa con su salida, como en `materializarCriterio`: el nombre ocupado se arregla
    // corrigiendo la propuesta y el criterio ajeno reapuntándola, mientras que el registry
    // firmado no se arregla — solo se rechaza.
    if (err.code === '23505') {
      throw new ErrorAI(
        'Ya hay una entrada con ese nombre en el registry: corrige el nombre de la propuesta antes de aceptarla',
      );
    }
    if (err.code === '23503') {
      throw new ErrorAI(
        'El criterio al que responde esta entrada ya no existe en este workspace: la propuesta quedó obsoleta y solo puede rechazarse',
      );
    }
    if (err.code === '42501') {
      throw new ErrorAI(
        'El registry está firmado, o el criterio al que responde esta entrada no es de su reto: la propuesta no se puede materializar',
      );
    }
    if (err.code === 'P0001' && err.message) throw new ErrorAI(err.message);
    throw e;
  }
}

async function materializarCriterio(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  p: PropuestaEnRevision,
  c: ContenidoCriterio,
): Promise<string> {
  // Mismo candado que agregarCriterio: mutar criterios y decidir un G0 no pueden
  // entrecruzarse (contrato documentado en metodo.servicio.ts).
  await bloquearReto(tx, p.anclaId);
  // El reto tiene que SEGUIR admitiendo criterios, y eso no lo cubre el congelado por G0:
  // son dos predicados distintos. La generación exigió los dos y el guard del INSERT
  // también, pero entre generar y aceptar hay una segunda vida entera y el ciclo de vida del
  // reto avanza solo (`candidato → archivado` es una transición legal, igual que
  // `activo → en-medicion → cerrado`). Aceptar después colgaría un criterio de un reto que
  // ya no lo admite — un contrato de medición para algo que nadie va a medir— y ninguna
  // política de `criterio_exito` lo mira, así que sin esta lectura nadie lo diría. Mismo
  // razonamiento que el consentimiento retirado antes de aceptar, con más consecuencias:
  // aquí lo que nace no es una propuesta, es el criterio. Se lee DENTRO de `bloquearReto`,
  // el mismo candado que toma la aprobación del G0.
  const [reto] = await tx`select
    reto_admite_criterios(${p.anclaId}::uuid, ${workspaceId}::uuid) as admite`;
  if (!reto?.admite) {
    throw new ErrorAI(
      'Ese reto ya no admite criterios nuevos: solo los admite mientras es candidato o está activo. Esta propuesta quedó obsoleta y solo puede rechazarse',
    );
  }
  try {
    const [criterio] = await tx`insert into criterio_exito
      (workspace_id, reto_id, kpi, definicion, linea_base_valor, linea_base_fecha,
       linea_base_plan, objetivo, ventana_dias, fecha_post_mortem, creado_por)
      values (${workspaceId}, ${p.anclaId}, ${c.kpi}, ${c.definicion}, null, null,
              ${c.lineaBasePlan}, ${c.objetivo}, ${c.ventanaDias}, null, ${actorId})
      returning id`;
    return criterio!.id as string;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    // El guard de criterio_exito habla antes que el WITH CHECK (P0001); la política
    // responde 42501, que no trae motivo. Traducir es obligatorio: sin esto sale el error
    // crudo del driver a una pantalla de revisión.
    //
    // Y hay que traducir CADA causa de congelado por separado, porque cada una tiene su
    // salida: reabrir la etapa 0 (RF-04.9) descongela el G0 y no descongela una firma. La
    // primera versión de esto miraba solo la palabra «congelados», que es la del mensaje del
    // G0; cuando SPEC-07 añadió el registry —cuyo `raise` no la lleva— este `catch` dejó de
    // reconocerlo y el error crudo pasaba de largo. No se puede volver a preguntar a la base
    // cuál fue: la transacción ya está abortada. Se decide por el mensaje, que es lo único
    // que queda en la mano.
    if (err.code === 'P0001' && err.message?.includes('registry del reto está firmado')) {
      throw new ErrorAI(
        'El registry de medición de ese reto ya está firmado: sus criterios son el contrato acordado y no admiten cambios (SYS-22). Esta propuesta quedó obsoleta y solo puede rechazarse',
      );
    }
    if (err.code === 'P0001' && err.message?.includes('congelados')) {
      throw new ErrorAI('El G0 del reto ya fue aprobado: los criterios están congelados');
    }
    // 42501 es la política, que rechaza sin decir por qué. Nombrar una sola causa sería
    // inventarse cuál: el mensaje enumera las que hay y deja al revisor mirar el reto.
    if (err.code === '42501') {
      throw new ErrorAI(
        'La base no admite criterios nuevos en ese reto: o su G0 los congeló, o su registry de medición está firmado. Esta propuesta quedó obsoleta y solo puede rechazarse',
      );
    }
    throw e;
  }
}

/** Rechazar no toca el dominio: el item de la bandeja sigue pendiente de curaduría manual
 * y el reto sigue admitiendo criterios a mano (paridad manual, SYS-21). La propuesta se
 * conserva íntegra como insumo de las métricas de grounding (SYS-17). */
export async function rechazarPropuesta(
  actorId: string,
  entrada: { workspaceId: string; propuestaId: string },
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await rolCurador(tx, actorId, entrada.workspaceId);
    const filas = await tx`update propuesta_ai
      set estado = 'rechazada', revisada_por = ${actorId}
      where id = ${entrada.propuestaId} and workspace_id = ${entrada.workspaceId}
        and estado = 'propuesta'`;
    if (filas.count === 0) {
      throw new ErrorAI('La propuesta no existe o ya fue revisada');
    }
  });
}
