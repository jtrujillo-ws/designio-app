import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { AFIRMACIONES_DEL_CONTENIDO } from './ai.contenido';
import type { AfirmacionDelContenido, ContenidoPropuesta } from './ai.contenido';
import { PROMPT_VERSION } from './ai.prompts';
import {
  CAPACIDADES,
  CAPACIDADES_ACTIVAS,
  CAPACIDAD_AGREGADA,
  METRICAS_DE_GROUNDING,
  ROLES_CORREN_EVAL,
  ROLES_INFORME_GROUNDING,
  type CorridaDeGrounding,
  type InformeDeGrounding,
  type MedicionDeGrounding,
  type Destino,
  type MetricaDeGrounding,
  type CapacidadActiva,
} from './ai.schemas';
import { ErrorAI, citasConPresencia, proyeccionDelPanel } from './ai.servicio';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * RF-08.7 — LA CORRIDA DE EVALS DE GROUNDING
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * SPEC-08 RF-08.7 pide medir periódicamente las propuestas ACEPTADAS y su criterio 4 exige
 * que las cifras vayan «comparadas contra la corrida anterior». §17 convierte esa comparación
 * en LA métrica al nombrar la alarma: «fidelidad que no mejora entre releases del producto».
 *
 * Las cuatro salen de la BASE y no de preguntárselas a un modelo. Tres razones, y ninguna es
 * el coste: son deterministas (dos corridas sobre los mismos datos dan lo mismo), se pueden
 * correr en CI, y sobre todo NO SON CIRCULARES — evaluar el grounding con el mismo componente
 * que lo produce mide la coherencia del modelo consigo mismo, no si la cita sostiene.
 *
 * Lo que eso cuesta, dicho antes de que nadie lea un verde de más: la primera métrica es un
 * SUELO y no la fidelidad que §9 define. Ver `METRICAS_DE_GROUNDING`.
 */

/** Las tres cifras que se cuentan por métrica y capacidad, antes de dividir. */
type Recuento = { numerador: number; denominador: number; sinVeredicto: number };

/** «No hay universo»: esta métrica no tiene nada que contar en esta capacidad. */
const SIN_UNIVERSO = null;

/**
 * Y el de «la exigencia existe y no la sabemos medir», que NO es el de arriba.
 *
 * Las dos escriben null —lo guardado es idéntico y así debe ser: no hay cifra— pero significan lo
 * contrario, y con un solo centinela la pantalla pintaba «no aplica» sobre una fila cuyo propio
 * título dice «exigida y NO medida». Cuál es cuál lo declara el contrato en `METRICAS_SIN_MEDIR`,
 * que es lo que lee la pantalla; aquí sólo se nombra para que quien edite este Record vea que hay
 * dos razones distintas para no traer cifras, y elija.
 */
const NO_SE_MIDE = () => null;

function medicion(
  metrica: MetricaDeGrounding,
  capacidad: string,
  r: Recuento | null,
): MedicionDeGrounding {
  return {
    metrica,
    capacidad,
    numerador: r === null ? SIN_UNIVERSO : r.numerador,
    denominador: r === null ? SIN_UNIVERSO : r.denominador,
    sinVeredicto: r === null ? SIN_UNIVERSO : r.sinVeredicto,
    // Sin universo y con universo VACÍO son cosas distintas, y las dos dan `null` aquí a
    // propósito: dividir entre cero no es una tasa. Lo que las distingue en la pantalla son
    // las otras tres cifras, que por eso viajan además de la división.
    tasa: r === null || r.denominador === 0 ? null : r.numerador / r.denominador,
  };
}

/** Suma de los recuentos que SÍ tienen universo; null si ninguno lo tiene. */
function agregado(rs: (Recuento | null)[]): Recuento | null {
  const conUniverso = rs.filter((r): r is Recuento => r !== null);
  if (conUniverso.length === 0) return null;
  return conUniverso.reduce(
    (a, b) => ({
      numerador: a.numerador + b.numerador,
      denominador: a.denominador + b.denominador,
      sinVeredicto: a.sinVeredicto + b.sinVeredicto,
    }),
    { numerador: 0, denominador: 0, sinVeredicto: 0 },
  );
}

/**
 * QUÉ DESTINOS MATERIALIZAN UN INSIGHT, que es el objeto donde viven las afirmaciones con sus
 * citas y las contradicciones registradas — o sea, el universo de dos de las cuatro métricas.
 *
 * Un `Record<Destino, …>` INDEXADO, no un `destino === 'insight'`. La diferencia no es de
 * estilo: con la comparación, un destino nuevo que también materializara afirmaciones se habría
 * quedado fuera de la medida en silencio, y una métrica de grounding que mide menos de lo que
 * hay sin decirlo es peor que no tenerla. Indexado, el compilador no deja añadir un destino sin
 * que alguien conteste esta pregunta — que es la misma disciplina que `COLUMNA_DE_DESTINO`, y
 * lo que el censo de ramas binarias por capacidad exige.
 */
const DESTINO_MATERIALIZA_INSIGHT: Record<Destino, boolean> = {
  evidencia: false,
  'criterio-exito': false,
  insight: true,
  'entrada-kpi': false,
  oportunidad: false,
  'outcome-review': false,
  'revision-simulada': false,
};

/**
 * Y las capacidades que lo hacen, derivadas del registro.
 *
 * Hoy es C2 y solo C2. Las demás no tienen dónde contar una afirmación no soportada —no existe
 * el objeto—, así que su fila se escribe SIN UNIVERSO en vez de con un cero, que diría «medido
 * y salió limpio».
 */
export const CAPACIDADES_CON_AFIRMACIONES: readonly string[] = CAPACIDADES_ACTIVAS.filter((k) => {
  const destino = CAPACIDADES[k].destino;
  // Sin destino no se materializa nada, así que tampoco hay afirmaciones que contar. No es un
  // caso hipotético: CT es informativa —aconseja sobre un gate y no escribe ningún objeto—, y
  // su universo aquí no está vacío, no existe. Que la ausencia sea representable en el registro
  // es lo que deja decirlo en vez de tratarla como un destino más.
  return destino !== null && DESTINO_MATERIALIZA_INSIGHT[destino];
});

/**
 * Las capacidades sobre las que se escribe fila: las ACTIVAS más las que aparezcan en los
 * datos sin estar en el registro.
 *
 * El CHECK de `propuesta_ai.capacidad` admite diez valores y el registro cubre las activas, así
 * que una fila puede nombrar una capacidad que este código no conoce —escrita por una versión
 * más nueva del servidor, o por una que volvió a apagarse—. Callarla sería medir menos de lo
 * que hay y no decirlo; es la misma degradación que la ficha del panel, con la misma respuesta:
 * aparece, con lo que se sepa de ella.
 */
function capacidadesDeLaCorrida(vistas: Iterable<string>): string[] {
  const todas = new Set<string>(CAPACIDADES_ACTIVAS as readonly string[]);
  for (const c of vistas) todas.add(c);
  return [...todas].sort();
}

/**
 * ── EL SUELO DE PRESENCIA LITERAL ──
 *
 * Se calcula en TypeScript y no en SQL porque el pajar de cada cita lo decide la CAPACIDAD:
 * recompone su material desde las filas de hoy, y en C2 y C4 lo estrecha al documento que la
 * cita nombra. `citasConPresencia` es la misma función que usa la ficha del panel, así que la
 * medida y lo que la pantalla enseña no pueden divergir.
 *
 * Y se mide sobre el `contenido_original` CRUDO, no sobre el recortado que proyecta el panel.
 * Medido, porque lo primero que escribí aquí era una suposición: hoy la diferencia NO se puede
 * observar desde esta función, porque `material_evidencia_visible` deja pasar el material a
 * `lead-boutique`, `disenador` y `admin-cliente` siempre, y correr una eval es de los dos
 * primeros — quien mide nunca ve un pasaje recortado. Se pasa el crudo igualmente, y por una
 * razón que sí se sostiene sola: una medida que dependiera del rol de quien la toma daría
 * cifras distintas para el mismo workspace según quién apretara el botón, y ese día llegaría el
 * primero que ampliara `ROLES_CORREN_EVAL` sin que nada fallara.
 *
 * Lo que sí sale del denominador son las citas SIN VEREDICTO: cuando el material que se
 * recompone hoy ya no es el que vio el modelo, medir contra el estado de hoy pinta en verde lo
 * que una edición ajena añadió y en rojo la cita legítima que borró. Se cuentan aparte porque
 * un denominador que excluye en silencio no se puede comparar con el de la corrida anterior.
 *
 * Y ésa es además la puerta por la que sale una revocación de derechos, que es lo que de verdad
 * protege al modelo de cargar con ella: al revocar, la evidencia deja de entrar en el material,
 * la huella guardada deja de coincidir y la cita se queda SIN VEREDICTO en vez de marcarse
 * ausente. Un `0/1` y un `0/0 con una sin veredicto` se parecen en la primera cifra y dicen
 * cosas opuestas; hay una sonda que fija exactamente eso.
 */
async function sueloDePresencia(
  tx: TransactionSql,
  workspaceId: string,
): Promise<Map<string, Recuento>> {
  const proyeccion = proyeccionDelPanel(tx);
  /*
   * La MISMA proyección de material que el panel —`proyeccion.materiales` es el repertorio de
   * columnas de cada tabla de ancla, del que cada capacidad toma lo suyo— porque `material(f)`
   * y `pajarDeLaCita(f, c)` leen de ahí. Lo que no se pide es lo que solo sirve para pintar:
   * el título del ancla, el motivo del CASE y la lista de documentos vetados, que además es la
   * parte cara y la que este cálculo NO debe aplicar.
   *
   * `huella_material` y `prompt_version` sí, porque son lo que `materialVigente` compara.
   */
  const filas = await tx`
    select p.id, p.capacidad, p.destino, p.contenido_original, p.contenido,
           p.prompt_version, p.huella_material, p.alcance_resumen,
           ${proyeccion.columnas}, ${proyeccion.materiales}
    from propuesta_ai p
    ${proyeccion.joins}
    where p.workspace_id = ${workspaceId}
      and p.estado in ('aceptada', 'corregida')
      and p.prompt_version = ${PROMPT_VERSION}`;

  const por = new Map<string, Recuento>();
  for (const f of filas) {
    const capacidad = f.capacidad as string;
    const r = por.get(capacidad) ?? { numerador: 0, denominador: 0, sinVeredicto: 0 };
    const { presencias } = citasConPresencia(
      f as Record<string, unknown>,
      f.contenido_original as ContenidoPropuesta,
    );
    for (const p of presencias) {
      if (p === null) r.sinVeredicto += 1;
      else {
        r.denominador += 1;
        if (p) r.numerador += 1;
      }
    }
    por.set(capacidad, r);
  }
  return por;
}

/**
 * ── LA TASA DE CORRECCIÓN HUMANA ──
 *
 * Es la única de las cuatro que ya estaba guardada como dato y no hay que derivarla: el CHECK
 * de `propuesta_ai` obliga a que 'aceptada' signifique `contenido = contenido_original`, así
 * que 'corregida' ES «alguien tuvo que enmendar lo que el modelo dijo» (SYS-17). No hay caso
 * sin veredicto: toda propuesta materializada está en uno de los dos estados.
 *
 * Y el denominador son las MATERIALIZADAS, no las decididas. Rechazar no es corregir: mide
 * otra cosa —cuánto se tira— y mezclarlas haría que un workspace que rechaza mucho pareciera
 * corregir poco.
 */
async function correccionHumana(
  tx: TransactionSql,
  workspaceId: string,
): Promise<Map<string, Recuento>> {
  const filas = await tx`
    select capacidad,
           count(*)::int as materializadas,
           count(*) filter (where estado = 'corregida')::int as corregidas
    from propuesta_ai
    where workspace_id = ${workspaceId}
      and estado in ('aceptada', 'corregida')
      and prompt_version = ${PROMPT_VERSION}
    group by capacidad`;
  return new Map(
    filas.map((f) => [
      f.capacidad as string,
      {
        numerador: f.corregidas as number,
        denominador: f.materializadas as number,
        sinVeredicto: 0,
      },
    ]),
  );
}

/**
 * ── LAS AFIRMACIONES NO SOPORTADAS ──
 *
 * Una afirmación QUE EL MODELO PROPUSO, que no declaró hipótesis y que hoy no tiene ninguna cita
 * viva. «Viva» es `evidencia_usable(…, 'cliente')`: el derecho de uso caduca por fecha y se puede
 * revocar, así que una afirmación que nació sostenida deja de estarlo sin que nadie la toque — y
 * eso es precisamente lo que esta métrica existe para ver.
 *
 * **Se lee del PAYLOAD, no de la tabla `afirmacion`, y ese fue un hallazgo.** Al aceptar una
 * propuesta de C2 el insight nace en `propuesto`, y la política de INSERT de `afirmacion` deja
 * añadir más mientras siga ahí: contando desde la tabla, una afirmación escrita a mano y sin
 * citas empeoraba el grounding de la versión de prompt vigente sin que el modelo hubiera
 * producido nada distinto. Y como `afirmacion` no guarda de dónde vino cada fila —no hay
 * `propuesta_id` ni `creado_por`—, tampoco se podían separar después: la comparación entre
 * versiones quedaba contaminada de forma irreversible.
 *
 * Las otras tres métricas ya se anclaban al payload; ésta era la única que leía filas vivas como
 * si fueran del modelo. `AFIRMACIONES_DEL_CONTENIDO` cierra la asimetría.
 *
 * Lo que SÍ sigue siendo una lectura viva, porque es la pregunta: los derechos. Se resuelven
 * contra `evidencia_usable` HOY, sobre los `evidenciaId` que la propuesta citó.
 *
 * `esHipotesis` se excluye porque el esquema lo declara así donde se define: «la extrapolación
 * honesta — no exige cita, pero queda etiquetada como tal para siempre». Contarla como no
 * soportada castigaría al modelo por hacer lo correcto.
 *
 * Se agrupa por CAPACIDAD y el universo lo decide `CAPACIDADES_CON_AFIRMACIONES` —derivado del
 * destino— en vez de `capacidad = 'C2'`: el día que otra materialice insights, entra sin que
 * nadie tenga que acordarse de venir aquí.
 */
async function afirmacionesNoSoportadas(
  tx: TransactionSql,
  workspaceId: string,
): Promise<Map<string, Recuento>> {
  const filas = await tx`
    select p.capacidad, p.contenido_original
    from propuesta_ai p
    where p.workspace_id = ${workspaceId}
      and p.estado in ('aceptada', 'corregida')
      and p.prompt_version = ${PROMPT_VERSION}
      and p.insight_id is not null`;

  const propuestas: { capacidad: string; afirmaciones: AfirmacionDelContenido[] }[] = filas.map((f) => ({
    capacidad: f.capacidad as string,
    afirmaciones:
      AFIRMACIONES_DEL_CONTENIDO[f.capacidad as CapacidadActiva]?.(
        f.contenido_original as ContenidoPropuesta,
      ) ?? [],
  }));

  /*
   * Los derechos, de una vez y solo sobre lo citado. Preguntarlo por afirmación habría sido una
   * consulta por fila; preguntarlo por todo el workspace habría traído documentos que nadie
   * citó. El conjunto es el de los ids que aparecen en los payloads medidos.
   */
  const citados = [...new Set(propuestas.flatMap((p) => p.afirmaciones.flatMap((a) => a.evidenciaIds)))];
  const usables = new Set<string>();
  if (citados.length > 0) {
    const vivas = await tx`
      select e.id::text as id
      from evidencia e
      where e.workspace_id = ${workspaceId}
        and e.id = any(${citados}::uuid[])
        and evidencia_usable(e.id, e.workspace_id, 'cliente')`;
    for (const v of vivas) usables.add((v.id as string).toLowerCase());
  }

  const por = new Map<string, Recuento>();
  for (const { capacidad, afirmaciones } of propuestas) {
    const r = por.get(capacidad) ?? { numerador: 0, denominador: 0, sinVeredicto: 0 };
    for (const a of afirmaciones) {
      if (a.esHipotesis) continue;
      r.denominador += 1;
      if (!a.evidenciaIds.some((id) => usables.has(id))) r.numerador += 1;
    }
    por.set(capacidad, r);
  }
  return por;
}

/**
 * ── LAS CONTRADICCIONES ──
 *
 * Y ésta se MIDE, contra lo que yo mismo escribí al planear esta fase. Di por hecho que
 * «contradicciones» no tenía definición operativa en el repositorio y no había mirado la
 * tabla: `contradiccion` existe desde el segundo día del esquema —«evidencia que CONTRADICE al
 * insight; se registra y se muestra siempre, jamás bloquea ni se oculta» (RF-03.9)—, el
 * contenido de C2 la lleva como campo obligatorio y `materializarInsight` la escribe al
 * aceptar. Si se afirma, se mide.
 *
 * Qué cuenta: de los insights nacidos de una propuesta aceptada, cuántos llevan al menos una
 * contradicción registrada. Es la señal que el prompt de C2 pide con estas palabras —«un
 * insight que solo trae lo que lo confirma no sirve para decidir»—, así que una tasa que BAJA
 * es la mala: significa que la capa está entregando conclusiones sin su contraevidencia.
 *
 * Lo que este número NO distingue, y por eso se dice en la pantalla: quién señaló la
 * contradicción. La fila lleva `creado_por`, pero al materializar una propuesta ese campo es la
 * persona que aceptó, no el modelo que la propuso; y una contradicción añadida a mano meses
 * después vive en la misma tabla. La métrica dice «este insight tiene contraevidencia
 * registrada», que es lo que gobierna, no «el modelo la encontró».
 */
async function contradiccionesRegistradas(
  tx: TransactionSql,
  workspaceId: string,
): Promise<Map<string, Recuento>> {
  const filas = await tx`
    select p.capacidad,
           count(*)::int as insights,
           count(*) filter (where exists (
             select 1 from contradiccion k
             where k.insight_id = p.insight_id and k.workspace_id = p.workspace_id
           ))::int as con_contradiccion
    from propuesta_ai p
    where p.workspace_id = ${workspaceId}
      and p.estado in ('aceptada', 'corregida')
      and p.prompt_version = ${PROMPT_VERSION}
      and p.insight_id is not null
    group by p.capacidad`;
  return new Map(
    filas.map((f) => [
      f.capacidad as string,
      {
        numerador: f.con_contradiccion as number,
        denominador: f.insights as number,
        sinVeredicto: 0,
      },
    ]),
  );
}

/**
 * ¿Tiene universo esta métrica en esta capacidad?
 *
 * Dos vías, y hacen falta las dos. La declarada —el registro dice que esta capacidad
 * materializa insights— cubre el caso de una capacidad que aún no ha aceptado nada: su
 * respuesta correcta es `0/0` («medido, no hay casos»), no «no hay universo». La medida —la
 * consulta devolvió fila para ella— cubre el contrario: una capacidad que el registro ya no
 * cubre pero que dejó insights escritos.
 */
function universoDeAfirmaciones(capacidad: string, medido: Map<string, Recuento>): boolean {
  return CAPACIDADES_CON_AFIRMACIONES.includes(capacidad) || medido.has(capacidad);
}

function ceroSiDeclarado(
  capacidad: string,
  medido: Map<string, Recuento>,
): Recuento | null {
  if (!universoDeAfirmaciones(capacidad, medido)) return SIN_UNIVERSO;
  return medido.get(capacidad) ?? { numerador: 0, denominador: 0, sinVeredicto: 0 };
}

/**
 * CORRE UNA EVAL Y LA GUARDA.
 *
 * ── Por qué DOS transacciones ──
 *
 * Las lecturas van en REPEATABLE READ: son cinco consultas que componen UNA medida, y bajo
 * READ COMMITTED cada una abriría su propia instantánea — una aceptación commiteada entre la
 * primera y la última dejaría el numerador de una métrica y el denominador de otra en
 * instantes distintos. La escritura va aparte y en READ COMMITTED porque la base LO EXIGE
 * (`IS001`): los guards de congelación toman candado y releen, y esa relectura solo dice la
 * verdad si cada sentencia abre instantánea nueva.
 *
 * Lo que eso cuesta, dicho en vez de escondido: entre leer y escribir cabe un cambio, así que
 * `corrida_en` es «cuándo se guardó» y no «el instante exacto de la foto». Para una medida que
 * se compara entre versiones de prompt, unos milisegundos no mueven nada; mezclar dos
 * instantes DENTRO de una misma medida sí.
 */
/**
 * QUIÉN LA DISPARA HOY, Y QUÉ FALTA PARA QUE SE DISPARE SOLA.
 *
 * Hoy: una persona, desde la pantalla. El diseño técnico pide además una corrida PROGRAMADA
 * («evals de grounding programadas», §Cadencias; «evals de grounding en CI + corrida
 * programada», §Cuotas), y esa mitad no está — no por olvido de esta función, sino porque el
 * planificador que describe ese documento NO EXISTE en el repositorio: la tabla
 * `scheduled_jobs`, el tick enganchado al middleware, el latch de claim y el hook con
 * `x-cron-secret` están todos por construir.
 *
 * No es una ausencia de esta fase: `medicion.servicio.ts` la tiene escrita igual para los
 * recordatorios de RF-07.4 —«no hay canal de correo ni planificador… así que el recordatorio
 * EFECTIVO depende de una cadencia que todavía no existe»—. Construirlo es una pieza de
 * infraestructura entera, no un añadido a un lector de métricas, y hacerlo aquí lo dejaría
 * escrito para un solo consumidor cuando lo van a usar tres.
 *
 * Lo que esta función SÍ hace para no estorbar ese día: es una función normal de `(actor,
 * workspace)` sin nada de HTTP ni de sesión, así que el job que llegue la llama tal cual. Y
 * mientras tanto la pantalla no finge estar al día: enseña la fecha de la última corrida y avisa
 * cuando midió una versión de la capa AI distinta de la que corre hoy, que es la forma en que
 * una corrida vieja se delata.
 */
export async function correrEvalDeGrounding(
  actorId: string,
  workspaceId: string,
): Promise<InformeDeGrounding> {
  const mediciones = await conUsuario(
    actorId,
    async (tx) => {
      await exigirCuentaActiva(tx, actorId);
      await exigirRol(tx, actorId, workspaceId, ROLES_CORREN_EVAL, TEXTO_ROL_CORRE);

      const [suelo, correccion, afirmaciones, contradicciones] = await Promise.all([
        sueloDePresencia(tx, workspaceId),
        correccionHumana(tx, workspaceId),
        afirmacionesNoSoportadas(tx, workspaceId),
        contradiccionesRegistradas(tx, workspaceId),
      ]);

      const capacidades = capacidadesDeLaCorrida([
        ...suelo.keys(),
        ...correccion.keys(),
        ...afirmaciones.keys(),
        ...contradicciones.keys(),
      ]);

      /*
       * Una fila por métrica y capacidad, MÁS la del agregado. Se escriben todas —incluidas las
       * que no tienen universo y las que salen a cero— porque una tabla de la que faltan filas
       * no dice si la métrica no aplicaba o si nadie la midió, y el informe se lee meses
       * después. El agregado se guarda en vez de sumarse al leer para que dos corridas se
       * comparen fila contra fila sin volver a derivar nada.
       */
      const porMetrica: Record<MetricaDeGrounding, (c: string) => Recuento | null> = {
        /*
         * DECLARADA Y NO MEDIDA, en todas las capacidades y a propósito.
         *
         * RF-08.7 exige «fidelidad de citas» —«la cita dice lo que el objeto afirma»— y eso es un
         * JUICIO SEMÁNTICO: una cita puede aparecer palabra por palabra en el material y no
         * sostener lo que se afirma con ella, así que el suelo de presencia puede marcar 100 %
         * sobre una cita infiel. No se calcula desde la base, y no se inventa.
         *
         * Su fila se escribe igualmente, con las tres cifras en null, para que la exigencia
         * aparezca EN EL INFORME junto a las que sí se miden. Con sólo el suelo publicado, un
         * informe de cuatro métricas parecía completo y el hueco vivía en un comentario; así,
         * quien lo lee ve que falta. Las dos salidas honestas para medirla —modelo como juez, con
         * el problema de que la evaluación pasaría a depender del componente que evalúa y a
         * costar por corrida, o nombrar un proxy COMO proxy— son decisión de producto.
         */
        'fidelidad-de-citas': NO_SE_MIDE,
        // El suelo tiene universo en toda capacidad: la que no declara citas mide cero de cero,
        // que es verdad —no citó nada—, y no «aquí no se puede medir».
        'suelo-presencia-literal': (c) =>
          suelo.get(c) ?? { numerador: 0, denominador: 0, sinVeredicto: 0 },
        'correccion-humana': (c) =>
          correccion.get(c) ?? { numerador: 0, denominador: 0, sinVeredicto: 0 },
        'afirmaciones-no-soportadas': (c) => ceroSiDeclarado(c, afirmaciones),
        contradicciones: (c) => ceroSiDeclarado(c, contradicciones),
      };

      return METRICAS_DE_GROUNDING.flatMap((metrica) => {
        const porCapacidad = capacidades.map((c) => medicion(metrica, c, porMetrica[metrica](c)));
        return [
          ...porCapacidad,
          medicion(metrica, CAPACIDAD_AGREGADA, agregado(capacidades.map(porMetrica[metrica]))),
        ];
      });
    },
    { aislamiento: 'repeatable read' },
  );

  await conUsuario(actorId, async (tx) => {
    const [corrida] = await tx`insert into corrida_eval
      (workspace_id, prompt_version, creado_por)
      values (${workspaceId}, ${PROMPT_VERSION}, ${actorId})
      returning id`;
    const corridaId = corrida!.id as string;
    for (const m of mediciones) {
      await tx`insert into medicion_eval
        (corrida_id, workspace_id, metrica, capacidad, numerador, denominador, sin_veredicto)
        values (${corridaId}, ${workspaceId}, ${m.metrica}, ${m.capacidad},
                ${m.numerador}, ${m.denominador}, ${m.sinVeredicto})`;
    }
  });

  return informeDeGrounding(actorId, workspaceId);
}

const TEXTO_ROL_CORRE =
  'Correr una eval de grounding escribe un hecho fechado en el workspace: la corren lead-boutique o diseñador';
const TEXTO_ROL_INFORME =
  'El informe de grounding lo consultan el admin del cliente y quienes llevan el workspace en la boutique';

async function exigirRol(
  tx: TransactionSql,
  actorId: string,
  workspaceId: string,
  admitidos: readonly string[],
  texto: string,
): Promise<string> {
  const [fila] = await tx`select workspace_role(${actorId}, ${workspaceId}) as rol`;
  const rol = (fila?.rol ?? null) as string | null;
  // Capa 2 CON MOTIVO: la RLS ya devolvería cero filas, pero una tabla vacía y «no te
  // corresponde» no son lo mismo para quien mira la pantalla.
  if (!rol || !admitidos.includes(rol)) throw new ErrorAI(texto);
  return rol;
}

/**
 * EL INFORME: la última corrida CONTRA LA ANTERIOR.
 *
 * Las dos, y no solo la última, porque el criterio 4 de SPEC-08 pide las cifras «comparadas
 * contra la corrida anterior» y §17 nombra la alarma sobre esa comparación. Se leen las dos
 * enteras y la resta se hace al pintar: guardar el delta habría fijado una comparación —y
 * cambiar de par a comparar es justo lo que se hace al mirar un informe.
 */
export async function informeDeGrounding(
  actorId: string,
  workspaceId: string,
): Promise<InformeDeGrounding> {
  return conUsuario(
    actorId,
    async (tx) => {
      await exigirCuentaActiva(tx, actorId);
      const rol = await exigirRol(
        tx,
        actorId,
        workspaceId,
        ROLES_INFORME_GROUNDING,
        TEXTO_ROL_INFORME,
      );

      /*
       * TRES corridas, y la tercera es la que salva la métrica de §17.
       *
       * Con «las dos últimas» a secas, la segunda corrida de una misma versión desplazaba a la
       * última de la versión ANTERIOR — y ésa es justo contra la que §17 quiere comparar
       * («fidelidad que no mejora entre releases»). Desde la segunda corrida de cada versión,
       * el informe dejaba de poder responder la pregunta para la que existe, teniendo el dato
       * guardado. La pantalla lo demostraba sola: ya avisaba de que un delta entre corridas de
       * la misma versión dice cuánto creció la muestra, no si la capa mejoró.
       *
       * Así que viajan las dos comparaciones, porque son dos preguntas:
       *  · `anterior` — la corrida inmediatamente previa, sea de la versión que sea. Es la
       *    literalidad del criterio 4 de SPEC-08 y responde «¿se movió algo desde la última
       *    medición?».
       *  · `anteriorDeOtraVersion` — la última de una versión DISTINTA. Es la alarma de §17.
       *
       * Todo en una consulta: pedirlas por separado bajo instantáneas distintas podía devolver
       * la misma corrida dos veces si una tercera entraba en medio.
       *
       * Y ACOTADA: como mucho tres filas, sea cual sea el historial. La primera versión de esto
       * usaba `distinct on (prompt_version)`, que trae una fila por versión histórica, y el
       * `Promise.all` de abajo pedía después las mediciones de todas para quedarse con tres:
       * el informe se encarecía cada vez que el producto publicaba una versión. La unión es de
       * dos consultas acotadas —las dos últimas, y la última de otra versión— porque lo que hay
       * que traer son exactamente las tres que se devuelven.
       */
      const corridas = await tx`
        with ultimas as (
          select id, prompt_version, corrida_en
          from corrida_eval
          where workspace_id = ${workspaceId}
          order by corrida_en desc, id desc
          limit 2
        ), otra_version as (
          /*
           * La más reciente de una versión DISTINTA de la que mide la última. Se busca con su
           * propio limit 1 y no recorriendo todas las versiones: con distinct on (prompt_version) la unión traía UNA FILA POR VERSIÓN HISTÓRICA y el Promise.all
           * de abajo pedía las mediciones de todas ellas para quedarse con tres — el informe se
           * volvía más caro cada vez que el producto publicaba una versión. Y mi propio
           * comentario decía «con el límite en tres», que era justo lo que la consulta no hacía.
           */
          select id, prompt_version, corrida_en
          from corrida_eval
          where workspace_id = ${workspaceId}
            and prompt_version is distinct from (select prompt_version from ultimas limit 1)
          order by corrida_en desc, id desc
          limit 1
        )
        select id, prompt_version, corrida_en::text as corrida_en
        from (select * from ultimas union select * from otra_version) as todas
        order by corrida_en desc, id desc`;

      const conMediciones = await Promise.all(
        corridas.map(async (c) => {
          const filas = await tx`
            select metrica, capacidad, numerador, denominador, sin_veredicto
            from medicion_eval
            where workspace_id = ${workspaceId} and corrida_id = ${c.id as string}
            order by metrica asc, capacidad asc`;
          return {
            id: c.id as string,
            promptVersion: c.prompt_version as string,
            corridaEn: c.corrida_en as string,
            mediciones: filas.map((f) => {
              const numerador = f.numerador as number | null;
              const denominador = f.denominador as number | null;
              return {
                metrica: f.metrica as MetricaDeGrounding,
                capacidad: f.capacidad as string,
                numerador,
                denominador,
                sinVeredicto: f.sin_veredicto as number | null,
                // La división vive en UN sitio, aquí, porque lo que se guarda es el par. Un
                // denominador cero no da cero: da «sin datos».
                tasa:
                  numerador === null || denominador === null || denominador === 0
                    ? null
                    : numerador / denominador,
              };
            }),
          } satisfies CorridaDeGrounding;
        }),
      );

      const ultima = conMediciones[0] ?? null;
      return {
        workspaceId,
        ultima,
        anterior: conMediciones[1] ?? null,
        /*
         * La más reciente de una versión DISTINTA de la que mide `ultima`. Se busca sobre la
         * lista ya ordenada por fecha, así que la primera que no coincide es la que toca; y es
         * `null` cuando todavía no hay más de una versión medida, que es el caso normal el
         * primer día y se dice en la pantalla en vez de pintar un delta de la nada.
         */
        anteriorDeOtraVersion:
          conMediciones.find((c) => c.promptVersion !== ultima?.promptVersion) ?? null,
        promptVersionActual: PROMPT_VERSION,
        puedeCorrer: (ROLES_CORREN_EVAL as readonly string[]).includes(rol),
      };
    },
    // Solo lectura, varias sentencias: la misma doctrina que el resumen del loop. No choca con
    // la exigencia de READ COMMITTED del esquema, que habla de las que ESCRIBEN.
    { aislamiento: 'repeatable read' },
  );
}
