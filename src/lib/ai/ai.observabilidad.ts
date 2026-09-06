import '@/lib/server-only';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { reservaSigueViva } from './ai.servicio';
import { CAPACIDADES, CAPACIDADES_ACTIVAS, type CapacidadActiva } from './ai.schemas';
import type { ObservabilidadAI, ObservabilidadDeCapacidad } from './ai.schemas';

/**
 * RF-08.9 — coste, latencia, tasa de error y tasa de aceptación POR CAPACIDAD (y del
 * workspace, que es el alcance de toda esta lectura).
 *
 * El libro ya estaba escrito y no lo leía nadie: `llamada_ai` guarda una línea por INTENTO
 * desde RF-09.14 —modelo, credencial que lo pagó, desenlace, tokens medidos, coste a la tarifa
 * vigente y latencia— y el único sitio que la consultaba era el tope diario del panel. Esto es
 * el lector que faltaba, no un registro nuevo: inventar una segunda contabilidad al lado de la
 * que ya frena el gasto sería tener dos números para lo mismo, que es la avería que este
 * repositorio lleva pagando desde el principio.
 *
 * Todo sale de la base y sin llamar a ningún modelo: son cuentas sobre filas que ya existen,
 * así que la medición es determinista, reproducible y gratis.
 */

/**
 * Lo que NO se hace aquí, y por qué, porque las tres son tentaciones baratas que mienten:
 *
 * 1. **`coalesce(costo_usd, 0)`.** `null` en esa columna es «el modelo no tenía tarifa
 *    registrada cuando se llamó», y sumarlo como cero declara un gasto menor que el real sin
 *    decirlo. Se suma lo que SÍ se sabe y se cuenta aparte cuántas líneas no lo saben, que es
 *    la única forma de que quien lee sepa si el total es el total.
 * 2. **Contar las líneas EN VUELO como error.** Una línea nace `despachada` y se cierra
 *    después; mientras espera no es un fallo, es una llamada en curso. `ESTADOS_LLAMADA` existe
 *    para esto y su propia nota lo dice: «olvidar las líneas en vuelo al leer» es una de las
 *    dos mitades del error. La tasa se calcula sobre las CERRADAS.
 *
 *    Y «despachada» son DOS cosas, que es lo que se me escapó en la primera versión: la que
 *    espera con su reserva viva, y la HUÉRFANA — aquella cuyo cierre falló después de que el
 *    proveedor respondiera, y que la limpieza deja `despachada` a propósito mientras retira su
 *    reserva. El presupuesto ya las distinguía y las cuenta como pagadas —«ante la duda de si
 *    el proveedor cobró se asume que sí»—; este cuadro las daba a las dos por en vuelo, así
 *    que una llamada probablemente pagada y de coste desconocido se quedaba fuera del aviso de
 *    abajo. El predicado es el MISMO —`reservaSigueViva`, que salió de allí para no escribirse
 *    dos veces—, y la huérfana viaja con su propio número: no es un desenlace, así que meterla
 *    en las cerradas inventaría un `resultado` que la fila no tiene.
 * 3. **Contar las propuestas pendientes como rechazos.** Una propuesta que nadie ha mirado no
 *    es una que alguien rechazó, y meterla en el denominador hace que la tasa de aceptación
 *    baje sola cuando se genera más — o sea, que el número empeore cuando el producto se usa.
 *    El denominador son las DECIDIDAS.
 */
const NINGUNA: Omit<ObservabilidadDeCapacidad, 'capacidad' | 'etiqueta'> = {
  llamadasCerradas: 0,
  llamadasEnVuelo: 0,
  llamadasHuerfanas: 0,
  llamadasValidas: 0,
  costoUsd: 0,
  llamadasSinTarifa: 0,
  latenciaP50Ms: null,
  latenciaP95Ms: null,
  tasaError: null,
  propuestas: 0,
  pendientes: 0,
  aceptadas: 0,
  corregidas: 0,
  rechazadas: 0,
  tasaAceptacion: null,
  tasaCorreccion: null,
};

export async function observabilidadAI(
  actorId: string,
  workspaceId: string,
): Promise<ObservabilidadAI> {
  return conUsuario(
    actorId,
    async (tx) => {
      await exigirCuentaActiva(tx, actorId);
      /*
       * Las dos mitades se leen por SEPARADO y se cruzan por capacidad, en vez de con un join.
       * No es estilo: una llamada puede no haber producido ninguna propuesta —es justo el caso
       * que interesa contar, la llamada pagada de la que no nació nada— y una propuesta cuelga
       * de su llamada, así que un join las perdería o las duplicaría según el lado. Contar por
       * separado y sumar es lo que hace que los dos números signifiquen lo que dicen.
       */
      const llamadas = await tx`
        select l.capacidad,
               count(*) filter (where l.resultado <> 'despachada')::int as cerradas,
               count(*) filter (
                 where l.resultado = 'despachada' and ${reservaSigueViva(tx, 'l')}
               )::int as en_vuelo,
               count(*) filter (
                 where l.resultado = 'despachada' and not ${reservaSigueViva(tx, 'l')}
               )::int as huerfanas,
               count(*) filter (where l.resultado = 'salida-valida')::int as validas,
               coalesce(sum(l.costo_usd), 0) as costo_usd,
               -- Las cerradas Y las huérfanas: las dos pueden haberse pagado, así que si no
               -- tienen coste conocido el total de arriba es un mínimo y hay que decirlo.
               count(*) filter (
                 where l.costo_usd is null
                   and (l.resultado <> 'despachada' or not ${reservaSigueViva(tx, 'l')})
               )::int as sin_tarifa,
               percentile_cont(0.5) within group (order by l.latencia_ms) as p50,
               percentile_cont(0.95) within group (order by l.latencia_ms) as p95
          from llamada_ai l
         where l.workspace_id = ${workspaceId}
         group by l.capacidad`;
      const propuestas = await tx`
        select p.capacidad,
               count(*)::int as total,
               count(*) filter (where p.estado = 'propuesta')::int as pendientes,
               count(*) filter (where p.estado = 'aceptada')::int as aceptadas,
               count(*) filter (where p.estado = 'corregida')::int as corregidas,
               count(*) filter (where p.estado = 'rechazada')::int as rechazadas
          from propuesta_ai p
         where p.workspace_id = ${workspaceId}
         group by p.capacidad`;

      const porLlamada = new Map(llamadas.map((f) => [f.capacidad as string, f]));
      const porPropuesta = new Map(propuestas.map((f) => [f.capacidad as string, f]));
      /*
       * Las capacidades que se pintan salen del REGISTRO, no de lo que las filas traigan: una
       * capacidad activa sin una sola llamada tiene que aparecer en cero, porque «cero» es una
       * respuesta —nadie la ha usado— y su ausencia se leería como que no existe.
       *
       * Y al revés: una fila de una capacidad que el registro NO cubre —el CHECK de la base
       * admite las diez de SPEC-08 y el registro cubre las activas— no se descarta. Lo que se
       * descartaría es GASTO, que es exactamente lo que este lector existe para no perder de
       * vista. Se añade al final con su código por rótulo.
       */
      const desconocidas = [...new Set([...porLlamada.keys(), ...porPropuesta.keys()])]
        .filter((c) => !(CAPACIDADES_ACTIVAS as readonly string[]).includes(c))
        .sort();
      const filas = [...CAPACIDADES_ACTIVAS, ...desconocidas].map((capacidad) => {
        const l = porLlamada.get(capacidad);
        const p = porPropuesta.get(capacidad);
        const cerradas = l ? (l.cerradas as number) : 0;
        const validas = l ? (l.validas as number) : 0;
        const aceptadas = p ? (p.aceptadas as number) : 0;
        const corregidas = p ? (p.corregidas as number) : 0;
        const rechazadas = p ? (p.rechazadas as number) : 0;
        const decididas = aceptadas + corregidas + rechazadas;
        const materializadas = aceptadas + corregidas;
        return {
          ...NINGUNA,
          capacidad,
          /* El nombre largo cuando el registro lo conoce, y el código a secas cuando no: una
           * etiqueta inventada para una capacidad que esta versión no conoce diría más de lo
           * que sabe, y lo que hace falta de esa fila es que su gasto se vea. */
          etiqueta: CAPACIDADES[capacidad as CapacidadActiva]?.etiqueta ?? capacidad,
          llamadasCerradas: cerradas,
          llamadasEnVuelo: l ? (l.en_vuelo as number) : 0,
          llamadasHuerfanas: l ? (l.huerfanas as number) : 0,
          llamadasValidas: validas,
          costoUsd: l ? Number(l.costo_usd) : 0,
          llamadasSinTarifa: l ? (l.sin_tarifa as number) : 0,
          latenciaP50Ms: l && l.p50 !== null ? Math.round(Number(l.p50)) : null,
          latenciaP95Ms: l && l.p95 !== null ? Math.round(Number(l.p95)) : null,
          // `null` y no cero cuando no hay ninguna cerrada: un 0 % de error sobre cero llamadas
          // es un verde que nadie se ha ganado.
          tasaError: cerradas === 0 ? null : (cerradas - validas) / cerradas,
          propuestas: p ? (p.total as number) : 0,
          pendientes: p ? (p.pendientes as number) : 0,
          aceptadas,
          corregidas,
          rechazadas,
          tasaAceptacion: decididas === 0 ? null : materializadas / decididas,
          /*
           * Y la de corrección, que es una de las cuatro de RF-08.7 y sale del MISMO recuento:
           * la base garantiza que una propuesta `aceptada` tiene el contenido idéntico a su
           * original (`propuesta_ai_check10`), así que «se corrigió» no hay que deducirlo
           * comparando dos jsonb — es el estado. Su denominador son las que se materializaron,
           * porque corregir es una forma de aceptar y una rechazada no se corrigió: se descartó.
           */
          tasaCorreccion: materializadas === 0 ? null : corregidas / materializadas,
        } satisfies ObservabilidadDeCapacidad;
      });

      return {
        workspaceId,
        capacidades: filas,
        total: {
          llamadasCerradas: filas.reduce((n, f) => n + f.llamadasCerradas, 0),
          llamadasEnVuelo: filas.reduce((n, f) => n + f.llamadasEnVuelo, 0),
          llamadasHuerfanas: filas.reduce((n, f) => n + f.llamadasHuerfanas, 0),
          costoUsd: filas.reduce((n, f) => n + f.costoUsd, 0),
          llamadasSinTarifa: filas.reduce((n, f) => n + f.llamadasSinTarifa, 0),
          propuestas: filas.reduce((n, f) => n + f.propuestas, 0),
        },
      };
    },
    /*
     * REPEATABLE READ, y lo cazó el censo que ya existe para esto: son DOS sentencias de sólo
     * lectura y bajo READ COMMITTED cada una toma su propia instantánea, así que una
     * generación que commitee entre medias deja un recuento de llamadas de un momento y uno de
     * propuestas de otro. Lo que llegaría a la pantalla no sería un estado incompleto: sería
     * uno que no ha existido nunca — y de una MÉTRICA eso es peor que de una lista, porque un
     * número no enseña la costura por la que se partió.
     *
     * No choca con la doctrina de aislamiento del esquema, que exige READ COMMITTED a las
     * transacciones que ESCRIBEN y releen tras un candado: aquí no se escribe nada.
     */
    { aislamiento: 'repeatable read' },
  );
}
