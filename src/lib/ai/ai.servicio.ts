import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { DimensionesEvidenciaSchema, ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import { bloquearReto } from '@/lib/metodo/metodo.servicio';
import { evaluarCapacidadAI, LIMITE_LLAMADAS_DIA } from './ai.degradacion';
import {
  fidelidadDeCitas,
  materialDeItem,
  materialDeReto,
  MAX_MATERIAL,
  PROMPT_VERSION,
  promptCriterios,
  promptExtraccion,
  SISTEMA_CRITERIOS,
  SISTEMA_EXTRACCION,
} from './ai.prompts';
import {
  CONFIANZA_PROPUESTA_NUMERICA,
  ContenidoCriterioSchema,
  ContenidoExtraccionSchema,
  DESTINO_DE_CAPACIDAD,
  parsearContenido,
  type CapacidadActiva,
  type ContenidoCriterio,
  type ContenidoExtraccion,
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
  credencialesAI,
  generarConProveedor,
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
const INTENTOS_POR_GENERACION = 2;

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
  // El `left join` es deliberado: bajo RLS el workspace de otro no existe, y un `join` a
  // secas devolvería CERO filas —que este código leería como «0 atendidas», es decir, como
  // presupuesto entero disponible—. Con `left join`, si la fila del workspace no se ve, el
  // gasto se sigue contando y el cupo cae al respaldo; una lectura ciega nunca se convierte
  // en una autorización.
  const [fila] = await tx`select
      (select count(*) from llamada_ai
        where workspace_id = ${workspaceId} and creado_en >= date_trunc('day', now())
          and resultado <> 'sin-respuesta')::int as atendidas,
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
      -- Se mira el intento MAS RECIENTE, no "hubo alguna caida": una llamada buena posterior
      -- tiene que borrar la caida al instante, porque la ultima observacion es la unica que
      -- habla del presente. El order by baja por creado_en y desempata por id para que el
      -- orden sea TOTAL: dos intentos de la misma generacion comparten el reloj de la
      -- transaccion, y con orden parcial el "ultimo" lo elegiria el planificador.
      --
      -- Solo sin-respuesta: un rechazo del proveedor o una salida fuera de contrato son
      -- llamadas ATENDIDAS, el tercero contesto y de hecho cobro. Contarlas como caida
      -- pintaria el proveedor de rojo por un material que el modelo se niega a procesar,
      -- que es un problema del material y no de la disponibilidad.
      (select case when u.resultado = 'sin-respuesta'
                then (extract(epoch from (now() - u.creado_en)) * 1000)::bigint end
         from llamada_ai u
        where u.workspace_id = ${workspaceId}
        order by u.creado_en desc, u.id desc
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
  const ai = evaluarCapacidadAI({
    keyWorkspace,
    keyEntorno,
    llamadasHoy: atendidas + reservadas,
    limiteDiario,
    unidades: INTENTOS_POR_GENERACION,
    ultimaCaidaHaceMs,
  });
  return { ...ai, llamadasHoy: atendidas };
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

function filaDePanel(f: Record<string, unknown>): PropuestaEnPanel {
  const contenido = f.contenido as ContenidoPropuesta;
  const original = f.contenido_original as ContenidoPropuesta;
  // El material se compone IGUAL que al construir el prompt —ficha incluida y con el
  // delimitador neutralizado—: la fidelidad se mide contra lo que el modelo leyó, no
  // contra el texto crudo de la base. Una sola definición, dos usos.
  //
  // Y se compone para las DOS capacidades: C0 cita la formulación del reto igual que CI cita
  // el material del item, así que la fidelidad se mide con la misma función. Cuando C0 no
  // citaba, sus propuestas no salían mal en la medición de grounding (RF-09.10): salían
  // excluidas, que es peor — una capacidad que no puede salir mal es la que más falta hace
  // medir.
  const material =
    f.item_id !== null
      ? materialDeItem({
          titulo: (f.item_titulo as string | null) ?? '',
          tipoFuente: (f.item_tipo_fuente as string | null) ?? '',
          referencia: (f.item_referencia as string | null) ?? '',
          contenido: (f.item_contenido as string | null) ?? '',
        }).texto
      : f.reto_codigo
        ? materialDeReto({
            codigo: f.reto_codigo as string,
            titulo: (f.reto_titulo as string | null) ?? '',
            descripcion: (f.reto_descripcion as string | null) ?? '',
            metricaObjetivo: (f.reto_metrica as string | null) ?? '',
          }).texto
        : '';
  // Las citas se leen del ORIGINAL: son el testimonio del modelo sobre lo que leyó, no del
  // humano que corrige. Hoy son siempre las mismas —corregirlas está prohibido en el
  // servicio y en el guard— y leerlas de aquí lo deja dicho en la proyección también.
  const citas = 'citas' in original ? original.citas : [];
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
    citas: citas.map((c) => ({
      fragmento: c.fragmento,
      localizacion: c.localizacion,
      fiel: fidelidadDeCitas(material, [c]).fieles === 1,
    })),
    anclaTitulo: (f.ancla_titulo as string | null) ?? '',
    anclaId: ((f.item_id ?? f.reto_id) as string | null) ?? '',
    // Si no se pudo determinar, se trata como NO disponible: habilitar dos botones que la
    // base va a rechazar es peor que pedir un refresco.
    anclaEstado: (f.ancla_estado as EstadoAncla | null) ?? 'ancla-ausente',
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
 * Proyección del panel de revisión. El `material` que viaja para medir la fidelidad de
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
    //
    // El ORDEN de los TRES motivos de C0 importa cuando se cumplen varios a la vez, que es
    // lo normal en un reto cerrado (avanzó de etapa Y su G0 se aprobó Y firmó su registry).
    // Se ordenan de la puerta más cerrada a la menos: primero el ciclo de vida del reto, que
    // no se revierte nunca; después el registry firmado, que tampoco (la firma es de ida); y
    // solo al final el G0, que es el ÚNICO con salida real —reabrir la etapa 0 (RF-04.9)
    // descongela—. Sugerirle esa salida a quien tiene el reto archivado o el contrato
    // firmado sería mandarlo a un trámite que no va a desbloquear nada. Entre motivos
    // ciertos gana siempre el que describe la puerta que ya no se abre.
    //
    // Es el mismo orden con el que `criterio_g0_pendiente_guard` elige su `raise`, y por la
    // misma razón: quien fuerza la escritura por SQL directo lee el motivo que le sirve.
    const columnas = tx`p.id, p.capacidad, p.destino, p.estado, p.es_simulacion, p.confianza,
             p.contenido, p.contenido_original, p.item_id, p.reto_id,
             p.modelo, p.prompt_version, p.origen_key, p.alcance_resumen,
             l.latencia_ms, l.costo_usd, p.creado_en, p.revisada_en,
             coalesce(i.titulo, r.codigo || ' ' || r.titulo) as ancla_titulo,
             r.codigo as reto_codigo, r.titulo as reto_titulo,
             r.descripcion as reto_descripcion, r.metrica_objetivo as reto_metrica,
             case
               when p.item_id is not null then
                 case
                   when i.estado is distinct from 'pendiente' then 'item-curado'
                   when tipo_fuente_exige_consentimiento(i.tipo_fuente)
                     and not consentimiento_externo_vigente(i.id, i.workspace_id)
                     then 'consentimiento-revocado'
                   else 'disponible'
                 end
               when not reto_admite_criterios(p.reto_id, p.workspace_id)
                 then 'reto-no-admite'
               when reto_registry_firmado(p.reto_id, p.workspace_id)
                 then 'registry-firmado'
               when reto_g0_congela_criterios(p.reto_id, p.workspace_id)
                 then 'criterios-congelados'
               else 'disponible'
             end as ancla_estado,
             i.titulo as item_titulo, i.tipo_fuente as item_tipo_fuente,
             i.referencia as item_referencia,
             left(coalesce(i.contenido, ''), ${MAX_MATERIAL}) as item_contenido`;
    // La llamada que pagó cada propuesta: el uso, el coste y la latencia viven allí (una
    // fila por llamada, aunque devuelva un lote), no repetidos en cada propuesta.
    const origen = tx`from propuesta_ai p
      join llamada_ai l on l.id = p.llamada_id and l.workspace_id = p.workspace_id
      left join item_importacion i
        on i.id = p.item_id and i.workspace_id = p.workspace_id
      left join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id`;

    // Se pide una fila de más para saber si el corte dejó algo fuera (mismo truco que la
    // bandeja): el panel lo dice en vez de fingir que eso es todo.
    //
    // Y el orden es por CONFIANZA, no por antigüedad. Persistir `confianza` argumentando que
    // «ordena la revisión humana» y después no ordenar por ella no entrega esa conducta: con
    // FIFO puro, una propuesta nueva y sólida se quedaba detrás de cien viejas y flojas, y el
    // dato no servía para nada. La antigüedad sigue siendo el desempate, así que entre iguales
    // manda la cola de siempre y el drenaje no se rompe.
    //
    // `nulls last` porque «sin confianza declarada» no es «confianza cero»: son las sembradas
    // o las escritas por SQL crudo, y van al final sin fingir un valor que nadie dijo.
    const pendientes = await tx`select ${columnas} ${origen}
      where p.workspace_id = ${workspaceId} and p.estado = 'propuesta'
      order by p.confianza desc nulls last, p.creado_en asc, p.id asc
      limit ${PAGINA_PENDIENTES + 1}`;
    // Cuántas hay en total, para que el recorte diga un número y no «hay más». Con el orden
    // por confianza, lo que queda detrás del corte son las MENOS fiables: saber cuántas son
    // es lo que convierte el corte en algo que se puede drenar en vez de en un final falso.
    const [conteo] = await tx`select count(*)::int as n from propuesta_ai
      where workspace_id = ${workspaceId} and estado = 'propuesta'`;

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
    const patron = busqueda ? `%${busqueda.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const items = await tx`
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
      limit ${PAGINA_ANCLAS + 1}`;
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
    // Retos con criterios aún abiertos, que son DOS condiciones y no una: que el ciclo de
    // vida del reto siga admitiéndolos (RF-04.12) y que nada los haya congelado (SYS-22:
    // ni un G0 aprobado ni un registry de medición firmado). Las dos las impone el guard del
    // INSERT de propuestas, así que ofrecer un reto al que le falte cualquiera de ellas sería
    // ofrecer una acción que la base va a rechazar — y las dos se preguntan por la MISMA
    // función que la impone, para que no vuelvan a divergir. Aquí basta el predicado
    // COMPUESTO porque la lista solo decide si el reto se ofrece; distinguir la causa es
    // cosa del panel, que sí tiene que explicarla.
    const retos = await tx`
      select r.id, r.codigo || ' ' || r.titulo as titulo from reto r
      where r.workspace_id = ${workspaceId}
        and reto_admite_criterios(r.id, r.workspace_id)
        and not reto_criterios_congelados(r.id, r.workspace_id)
        and not exists (select 1 from propuesta_ai p
          where p.reto_id = r.id and p.workspace_id = r.workspace_id and p.estado = 'propuesta')
        and (${patron}::text is null or r.codigo || ' ' || r.titulo ilike ${patron})
      order by r.codigo asc, r.id asc
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
      hayMasDecididas: decididas.length > DECIDIDAS_RECIENTES,
      itemsPendientes: items.slice(0, PAGINA_ANCLAS).map((i) => ({
        id: i.id as string,
        titulo: i.titulo as string,
        consentimientoPendiente: i.consentimiento_pendiente as boolean,
        sinMaterial: i.sin_material as boolean,
      })),
      retosAbiertos: retos
        .slice(0, PAGINA_ANCLAS)
        .map((r) => ({ id: r.id as string, titulo: r.titulo as string })),
      hayMasItems: items.length > PAGINA_ANCLAS,
      hayMasRetos: retos.length > PAGINA_ANCLAS,
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
  });
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
    let sistema: string;
    let prompt: { usuario: string; alcanceResumen: string };

    if (entrada.capacidad === 'CI') {
      // Candado por item ANTES de leer el consentimiento: leerlo y apartar la reserva tienen
      // que ser atómicos respecto a `registrarConsentimiento`, o una revocación podría
      // colarse entre ambos y quedarse sin nada que retirar. Orden de candados en toda la
      // casa: consentimiento (por item) y DESPUÉS presupuesto (por workspace) — este es el
      // único camino que toma los dos, así que no hay ciclo posible.
      await bloquearConsentimiento(tx, entrada.anclaId);
      const [item] = await tx`select titulo, tipo_fuente, referencia, contenido,
          tipo_fuente_exige_consentimiento(tipo_fuente)
            and not consentimiento_externo_vigente(id, workspace_id) as falta_consentimiento,
          item_tiene_material_extraible(contenido) as tiene_material
        from item_importacion
        where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
          and estado = 'pendiente'`;
      if (!item) throw new ErrorAI('El item no existe en este workspace o ya fue curado');
      // RF-09.5: ANTES de construir el prompt, no al aceptar la propuesta. Aquí es donde
      // se evita de verdad que el material de una persona salga hacia el proveedor; el
      // guard de `propuesta_ai` es el suelo que impide que exista una propuesta así.
      if (item.falta_consentimiento as boolean) {
        throw new ErrorAI(
          'Ese material es de personas: registra el consentimiento para procesarlo con un proveedor externo antes de pedir una propuesta (RF-09.5)',
        );
      }
      // Un item importado SOLO con la referencia al original no tiene nada que citar, y el
      // contrato de CI obliga al modelo a devolver una evidencia fechada con al menos una
      // cita literal. Sin cuerpo, la única salida que cumple el contrato es inventada a
      // partir de la ficha: una propuesta con apariencia de fundamentada, pagada, que
      // además contamina la métrica de fidelidad. Y no hay recuperación posible — no hay
      // herramienta que lea la fuente referenciada — así que la respuesta correcta es no
      // ofrecer la generación, no intentarla peor.
      if (!(item.tiene_material as boolean)) {
        throw new ErrorAI(
          'Ese item se importó solo con la referencia al original: no hay material que citar, así que no se puede extraer evidencia de él. Cúralo a mano en la bandeja o vuelve a importarlo con el texto pegado.',
        );
      }
      sistema = SISTEMA_EXTRACCION;
      prompt = promptExtraccion({
        titulo: item.titulo as string,
        tipoFuente: item.tipo_fuente as string,
        referencia: item.referencia as string,
        contenido: item.contenido as string,
      });
    } else {
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
      sistema = SISTEMA_CRITERIOS;
      prompt = promptCriterios({
        codigo: reto.codigo as string,
        titulo: reto.titulo as string,
        descripcion: reto.descripcion as string,
        metricaObjetivo: reto.metrica_objetivo as string,
        cuantos: CRITERIOS_POR_GENERACION,
      });
    }

    // ── Reserva del hueco, bajo candado del workspace ──
    await bloquearPresupuesto(tx, entrada.workspaceId);
    // Recolección de basura de reservas caducadas (proceso muerto a mitad de llamada):
    // bajo el mismo candado, así que limpiar y apartar son atómicos entre sí.
    await tx`delete from reserva_ai
      where workspace_id = ${entrada.workspaceId}
        and creado_en <= now() - reserva_ai_ventana()`;

    // Exclusión por ANCLA, no solo por item: dos curadores no pueden tener a la vez una
    // generación en vuelo sobre el mismo objeto. Para C0 esto faltaba —la reserva no
    // guardaba el reto, así que no excluía nada— y dos lotes podían despacharse a la vez
    // sobre el mismo reto: se pagaba dos veces y quedaban dos lotes pendientes sobre un
    // ancla que la pantalla ofrece una sola vez. Los dos caminos toman el MISMO candado
    // (el del presupuesto del workspace) antes de mirar, que es lo que hace que mirar sirva.
    const [enCurso] =
      entrada.capacidad === 'CI'
        ? await tx`select 1 as hay from reserva_ai
            where workspace_id = ${entrada.workspaceId} and item_id = ${entrada.anclaId}`
        : await tx`select 1 as hay from reserva_ai
            where workspace_id = ${entrada.workspaceId} and reto_id = ${entrada.anclaId}`;
    if (enCurso) {
      throw new ErrorAI(
        entrada.capacidad === 'CI'
          ? 'Ese item ya tiene una generación AI en curso: espera a que termine antes de pedir otra'
          : 'Ese reto ya tiene una generación AI en curso: espera a que termine antes de pedir otra',
      );
    }

    // «Este ancla ya tiene trabajo esperando revisión» se pregunta AQUÍ, bajo el mismo
    // candado, y no antes de tomarlo. Fuera del candado la respuesta caduca al instante: la
    // generación anterior persiste su lote en otra transacción, así que una segunda podía
    // leer «no hay nada pendiente», esperar a que la primera terminara —soltando su
    // reserva— y colar un segundo lote sobre la misma ancla. Dentro del candado las dos
    // señales se leen juntas: o está la reserva viva de la otra, o están sus propuestas.
    // Para CI el índice único parcial de `propuesta_ai` es además el suelo; para C0 no puede
    // haberlo (un lote son varias propuestas pendientes del mismo reto), así que aquí es
    // donde se decide.
    const [pendiente] =
      entrada.capacidad === 'CI'
        ? await tx`select 1 as hay from propuesta_ai
            where item_id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
              and estado = 'propuesta' limit 1`
        : await tx`select 1 as hay from propuesta_ai
            where reto_id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}
              and estado = 'propuesta' limit 1`;
    if (pendiente) {
      throw new ErrorAI(
        entrada.capacidad === 'CI'
          ? 'Ese item ya tiene una propuesta pendiente: revísala antes de pedir otra'
          : 'Ese reto ya tiene criterios propuestos esperando revisión: decídelos antes de pedir otros',
      );
    }

    const { atendidas, reservadas, limiteDiario, ultimaCaidaHaceMs } = await presupuestoDeHoy(
      tx,
      entrada.workspaceId,
    );
    const ai = evaluarCapacidadAI({
      keyWorkspace,
      keyEntorno,
      llamadasHoy: atendidas + reservadas,
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
    try {
      [reserva] = await tx`insert into reserva_ai
        (workspace_id, capacidad, item_id, reto_id, unidades, creado_por)
        values (${entrada.workspaceId}, ${entrada.capacidad},
                ${entrada.capacidad === 'CI' ? entrada.anclaId : null},
                ${entrada.capacidad === 'C0' ? entrada.anclaId : null},
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
 * Qué se puede garantizar y qué no, dicho sin rodeos:
 *
 *  · **Sí**: que en el INSTANTE DEL DESPACHO el consentimiento vigente autoriza el
 *    procesamiento externo, y que el hueco de presupuesto sigue vivo. La lectura se hace
 *    bajo el MISMO candado por item que toma `registrarConsentimiento`, así que una
 *    revocación a medio commit no se lee a medias: o se espera a que termine y se ve, o
 *    todavía no había empezado.
 *  · **No**: que una revocación que llegue mientras los bytes viajan alcance a la llamada.
 *    Ningún candado puede abarcar una petición HTTP fuera de transacción, y eso es
 *    deliberado — un tercero lento no puede retener una conexión de la base. Lo que sí
 *    ocurre en ese caso: la propia revocación retira la reserva, el guard de `propuesta_ai`
 *    lee el vigente y ninguna propuesta llega a nacer, y la llamada queda en el libro con
 *    su coste. El material que ya salió no se puede des-enviar, y la UI lo dice.
 */
async function confirmarDespacho(
  actorId: string,
  entrada: GenerarPropuestas,
  alcance: Alcance,
): Promise<number | null> {
  let versionConsentimiento: number | null = null;
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    if (entrada.capacidad === 'CI') {
      await bloquearConsentimiento(tx, entrada.anclaId);
      const [item] = await tx`select
          estado <> 'pendiente' as ya_decidido,
          tipo_fuente_exige_consentimiento(tipo_fuente)
            and not consentimiento_externo_vigente(id, workspace_id) as falta_consentimiento,
          case when tipo_fuente_exige_consentimiento(tipo_fuente) then
            (select c.version from consentimiento_item c
              where c.item_id = item_importacion.id
                and c.workspace_id = item_importacion.workspace_id
              order by c.version desc limit 1)
          end as version_vigente
        from item_importacion
        where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}`;
      if (item?.falta_consentimiento) {
        throw new ErrorAI(
          'El consentimiento de ese material dejó de autorizar el procesamiento externo antes de despachar la llamada: el material no salió hacia el proveedor (RF-09.5)',
        );
      }
      // Otro curador pudo decidir el item a mano mientras tanto: su material ya no espera
      // nada de la AI y la propuesta nacería obsoleta. Gastar la llamada para eso es tirar
      // dinero, y es el mismo caso que el consentimiento — algo que `prepararAlcance` vio
      // cierto y dejó de serlo al commitear.
      if (!item || item.ya_decidido) {
        throw new ErrorAI(
          'Ese item de la bandeja ya fue curado mientras se preparaba la llamada: no se llamó al proveedor',
        );
      }
      // La versión que ampara ESTA salida, leída bajo el candado y en la misma transacción
      // que la aprueba. Viaja al libro de llamadas para que «bajo qué permiso salió» sea un
      // hecho consultable y no una reconstrucción por fechas.
      //
      // `null` EXACTAMENTE cuando el tipo de fuente no exige consentimiento, que es lo que
      // la base impone en los dos sentidos: con material de personas es obligatorio citar
      // uno, sin él está prohibido. Si se leyera «la última versión que haya», un item de
      // tipo `nota` con un consentimiento registrado por si acaso citaría uno y el guard lo
      // rechazaría — y con razón, porque ese `null` es el que significa «no aplicaba».
      versionConsentimiento =
        item.version_vigente === null || item.version_vigente === undefined
          ? null
          : Number(item.version_vigente);
    } else {
      const [reto] = await tx`select
          reto_admite_criterios(id, workspace_id) as admite,
          reto_criterios_congelados(id, workspace_id) as congelado
        from reto where id = ${entrada.anclaId} and workspace_id = ${entrada.workspaceId}`;
      if (!reto || !reto.admite || reto.congelado) {
        throw new ErrorAI(
          'Ese reto dejó de admitir criterios mientras se preparaba la llamada (G0 aprobado, registry firmado o reto cerrado): no se llamó al proveedor',
        );
      }
    }
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
  });
  return versionConsentimiento;
}

/** Valida la salida cruda del proveedor contra el esquema de la capacidad. Una salida
 * fuera de contrato se descarta ENTERA: media propuesta no es revisable. */
function contenidosValidos(capacidad: CapacidadActiva, datos: unknown): ContenidoPropuesta[] {
  if (capacidad === 'CI') return [ContenidoExtraccionSchema.parse(datos)];
  const lote = (datos ?? {}) as { criterios?: unknown };
  return ContenidoCriterioSchema.array().min(1).max(4).parse(lote.criterios);
}

/**
 * Anota en el libro de costos (RF-09.14) TODOS los intentos contra el proveedor, haya
 * nacido o no una propuesta. Era la mitad que faltaba: una negativa del proveedor o una
 * salida fuera de contrato son llamadas atendidas y FACTURADAS, con su `usage` dentro, y se
 * perdían enteras porque el uso solo se guardaba colgado de una propuesta que en esos casos
 * no existe.
 *
 * Y son TODOS los intentos, no el último: una degradación de modelo son dos llamadas, las
 * dos ocurrieron y la del primario también falló por algo. Con una sola fila, la tasa de
 * error por modelo decía que el primario nunca falla y su latencia acababa sumada a la del
 * respaldo. Una fila por llamada, que es lo que la tabla promete.
 *
 * Transacción propia —todos los intentos entran o no entra ninguno— y ANTES de persistir el
 * lote: si el guardado falla después (una carrera por el item, un esquema que no cuadra),
 * las llamadas siguen anotadas porque el dinero se gastó igual. Devuelve los ids en el mismo
 * orden; el de la salida válida es el que las propuestas referencian, así que ninguna puede
 * existir sin su línea de gasto.
 */
async function registrarLlamadas(
  actorId: string,
  entrada: GenerarPropuestas,
  alcance: Alcance,
  intentos: IntentoProveedor[],
): Promise<{ ids: string[]; idSalidaValida: string | null }> {
  if (intentos.length === 0) return { ids: [], idSalidaValida: null };
  return conUsuario(actorId, async (tx) => {
    // SIN `exigirCuentaActiva`, y es la única función del módulo que se lo salta a
    // propósito. Anotar lo que pasó y autorizar lo que viene son dos preguntas distintas:
    // la cuenta activa responde a la segunda —«¿puede esta persona actuar ahora?»— y aquí
    // no se actúa, se registra un hecho consumado. Si la cuenta se desactiva con la llamada
    // en vuelo, el proveedor ya respondió y quizá ya facturó; dejar caer la anotación
    // borraría gasto real del libro y del tope, que es la misma doctrina que ya rige para
    // `sin-respuesta` («no se sabe» no es «salió gratis») aplicada a un caso donde sí se
    // sabe. La autorización de verdad no desaparece: la RLS sigue exigiendo que quien
    // firma sea miembro con rol curador del workspace, y persistir propuestas —que sí es
    // actuar— conserva su chequeo.
    const ids: string[] = [];
    let idSalidaValida: string | null = null;
    for (const intento of intentos) {
      const [fila] = await tx`insert into llamada_ai
        (workspace_id, capacidad, item_id, reto_id, modelo, origen_key, resultado, motivo,
         tokens_entrada, tokens_salida, costo_usd, latencia_ms, consentimiento_version,
         creado_por)
        values (${entrada.workspaceId}, ${entrada.capacidad},
                ${entrada.capacidad === 'CI' ? entrada.anclaId : null},
                ${entrada.capacidad === 'C0' ? entrada.anclaId : null},
                ${intento.modelo}, ${alcance.origenKey}, ${intento.resultado},
                ${intento.motivo.slice(0, 500)},
                ${intento.uso?.entrada ?? null}, ${intento.uso?.salida ?? null},
                ${intento.uso?.costoUsd ?? null}, ${intento.latenciaMs},
                ${intento.consentimientoVersion},
                ${actorId})
        returning id`;
      const id = fila!.id as string;
      ids.push(id);
      // El id que las propuestas referencian se busca por su RESULTADO, no por su posición:
      // como mucho hay un intento con salida válida (el bucle del adaptador para en el
      // primero que la da), y depender del orden de un `returning` sería depender de algo
      // que Postgres no promete.
      if (intento.resultado === 'salida-valida') idSalidaValida = id;
    }
    return { ids, idSalidaValida };
  });
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
    // Última parada antes de que el material salga del sistema. Todo lo anterior está
    // commiteado desde hace una transacción entera.
    const versionConsentimiento = await confirmarDespacho(actorId, entrada, alcance);

    const respuesta = await generarConProveedor({
      key: alcance.key,
      capacidad: entrada.capacidad,
      sistema: alcance.sistema,
      usuario: alcance.usuario,
      consentimientoVersion: versionConsentimiento,
      // Degradar de modelo es un despacho NUEVO, no la misma llamada otra vez: ocurre con la
      // primera ya terminada, el control de vuelta aquí y ni un byte en el aire. Así que se
      // vuelve a pedir permiso con EXACTAMENTE la misma comprobación que autorizó el
      // primario —consentimiento vigente bajo el candado por item, item aún pendiente, reto
      // que sigue admitiendo criterios y reserva viva— y la versión que devuelve es la que
      // ampara al respaldo. `confirmarDespacho` lanza `ErrorAI` al rechazar; aquí se traduce
      // a un `ok:false` porque el adaptador no lanza nunca (SYS-21) y el motivo tiene que
      // llegar al libro y a la pantalla como cualquier otro.
      revalidar: async () => {
        try {
          return { ok: true, consentimientoVersion: await confirmarDespacho(actorId, entrada, alcance) };
        } catch (e) {
          return {
            ok: false,
            motivo:
              e instanceof ErrorAI
                ? e.message
                : 'La autorización de esta generación dejó de ser válida antes de reintentar con el modelo de respaldo',
          };
        }
      },
    });

    // El proveedor no dio contenido utilizable. Los intentos se anotan igual —con su uso,
    // si la respuesta llegó a existir— y solo DESPUÉS se corta: registrar el gasto no puede
    // depender de que el resultado nos guste. Si el propio registro falla, manda el motivo
    // del proveedor: es lo que la persona necesita leer.
    if (!respuesta.ok) {
      await registrarLlamadas(actorId, entrada, alcance, respuesta.intentos).catch(() => {});
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
      await registrarLlamadas(actorId, entrada, alcance, intentos).catch(() => {});
      throw new ErrorAI(motivo);
    }

    const { idSalidaValida } = await registrarLlamadas(
      actorId,
      entrada,
      alcance,
      respuesta.intentos,
    );
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
        ${entrada.capacidad === 'CI' ? entrada.anclaId : null}::uuid is not null
          and exists (select 1 from item_importacion i
            where i.id = ${entrada.capacidad === 'CI' ? entrada.anclaId : null}::uuid
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

    const destino = DESTINO_DE_CAPACIDAD[entrada.capacidad];
    // UNA sentencia para el lote entero: el evento PropuestaAIGenerada de cada fila lo
    // emite el guard DENTRO de este insert, así que el rol auditado es exactamente el que
    // autorizó la escritura (mismo snapshot).
    try {
      const filas = await tx`
      insert into propuesta_ai
        (workspace_id, capacidad, destino, item_id, reto_id, contenido, contenido_original,
         confianza, modelo, prompt_version, alcance_resumen, origen_key, llamada_id,
         creado_por)
      select ${entrada.workspaceId}, ${entrada.capacidad}, ${destino},
             ${entrada.capacidad === 'CI' ? entrada.anclaId : null},
             ${entrada.capacidad === 'C0' ? entrada.anclaId : null},
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
             ${alcance.origenKey}, ${llamada.id}, ${actorId}
      from jsonb_array_elements(${tx.json(contenidos)}) as c(contenido)
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
      throw e;
    }
  });
}

/** Candado del consentimiento de un item: la versión del registro nuevo se calcula
 * leyendo la máxima actual, y una consulta es un predicado sobre un snapshot — dos
 * curadores registrando a la vez leerían el mismo máximo. El índice único de la bitácora es
 * el suelo (uno de los dos fallaría); esto es lo que hace que ninguno tenga que fallar. */
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
  destino: 'evidencia' | 'criterio-exito';
  itemId: string | null;
  retoId: string | null;
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
  const [p] = await tx`select capacidad, destino, item_id, reto_id, contenido,
      contenido_original, modelo, prompt_version, estado
    from propuesta_ai where id = ${propuestaId} and workspace_id = ${workspaceId}`;
  if (!p) throw new ErrorAI('La propuesta no existe en este workspace');
  if ((p.estado as string) !== 'propuesta') {
    throw new ErrorAI('Esa propuesta ya fue revisada: las decisiones son inmutables');
  }
  return {
    capacidad: p.capacidad as CapacidadActiva,
    destino: p.destino as PropuestaEnRevision['destino'],
    itemId: p.item_id as string | null,
    retoId: p.reto_id as string | null,
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
    if (entrada.correccion) {
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
      if (
        JSON.stringify((contenido as ContenidoPropuesta).citas) !==
        JSON.stringify((p.contenidoOriginal as ContenidoPropuesta).citas)
      ) {
        throw new ErrorAI(
          'Las citas de una propuesta no se corrigen: son el rastro de lo que el modelo dijo haber leído. Corrige el resto, o rechaza la propuesta si sus citas no se sostienen.',
        );
      }
    }
    // El destino y la forma del contenido van atados por el CHECK de la tabla y por el
    // esquema de la capacidad; el narrowing lo hace explícito para el compilador.
    const objetoId =
      p.destino === 'evidencia'
        ? await materializarEvidencia(
            tx,
            actorId,
            entrada.workspaceId,
            p,
            contenido as ContenidoExtraccion,
          )
        : await materializarCriterio(
            tx,
            actorId,
            entrada.workspaceId,
            p,
            contenido as ContenidoCriterio,
          );

    // Corregida o aceptada lo decide la BASE comparando jsonb con jsonb: normaliza claves
    // y espacios, así que un reordenamiento del round-trip por Zod no se contabiliza como
    // corrección humana (y el guard, que compara igual, no ve una contradicción).
    const [sellada] = await tx`
      update propuesta_ai
      set estado = case when contenido is distinct from ${tx.json(contenido)}::jsonb
                        then 'corregida' else 'aceptada' end,
          contenido = ${tx.json(contenido)}::jsonb,
          revisada_por = ${actorId},
          evidencia_id = ${p.destino === 'evidencia' ? objetoId : null},
          criterio_id = ${p.destino === 'criterio-exito' ? objetoId : null}
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
  await bloquearConsentimiento(tx, p.itemId!);
  const [item] = await tx`select titulo, tipo_fuente, referencia,
      tipo_fuente_exige_consentimiento(tipo_fuente)
        and not consentimiento_externo_vigente(id, workspace_id) as consentimiento_retirado
    from item_importacion
    where id = ${p.itemId} and workspace_id = ${workspaceId} and estado = 'pendiente'`;
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
    where item_id = ${p.itemId} and workspace_id = ${workspaceId} limit 1`;

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
    where id = ${p.itemId} and workspace_id = ${workspaceId} and estado = 'pendiente'
    returning workspace_role(${actorId}, ${workspaceId}) as rol`;
  if (selladas.length === 0) throw new ErrorAI('El item ya fue decidido por otra persona');
  await tx`insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
    values (${workspaceId}, 'EvidenciaCurada',
      ${tx.json({ itemId: p.itemId, evidenciaId, origen: 'propuesta-ai' })},
      ${actorId}, ${selladas[0]!.rol as string})`;
  return evidenciaId;
}

/** C0: el criterio nace bajo el reto de la propuesta, firmado por quien acepta y SIN
 * línea base inventada (solo el plan para obtenerla — SYS-22 exige valor+fecha o plan). */
async function materializarCriterio(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  p: PropuestaEnRevision,
  c: ContenidoCriterio,
): Promise<string> {
  // Mismo candado que agregarCriterio: mutar criterios y decidir un G0 no pueden
  // entrecruzarse (contrato documentado en metodo.servicio.ts).
  await bloquearReto(tx, p.retoId!);
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
    reto_admite_criterios(${p.retoId}::uuid, ${workspaceId}::uuid) as admite`;
  if (!reto?.admite) {
    throw new ErrorAI(
      'Ese reto ya no admite criterios nuevos: solo los admite mientras es candidato o está activo. Esta propuesta quedó obsoleta y solo puede rechazarse',
    );
  }
  try {
    const [criterio] = await tx`insert into criterio_exito
      (workspace_id, reto_id, kpi, definicion, linea_base_valor, linea_base_fecha,
       linea_base_plan, objetivo, ventana_dias, fecha_post_mortem, creado_por)
      values (${workspaceId}, ${p.retoId}, ${c.kpi}, ${c.definicion}, null, null,
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
