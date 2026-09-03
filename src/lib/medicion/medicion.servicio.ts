import '@/lib/server-only';
import type { TransactionSql } from 'postgres';
import { conUsuario } from '@/lib/db';
import { exigirCuentaActiva } from '@/lib/auth/auth.servicio';
import { FechaCalendarioSchema } from '@/lib/evidencia/evidencia.schemas';
import {
  etiquetaVentana,
  motivoFechaDeSnapshot,
  ValorMetricoSchema,
  type CargarCsv,
  type BorradorReview,
  type CompletarReview,
  type CrearEntrada,
  type EditarEntrada,
  type FilaRechazada,
  type ResultadoCriterioEntrada,
  type RegistrarSnapshot,
  type SeguimientoDeImpacto,
} from './medicion.schemas';

/**
 * Medición temporal de impacto (SPEC-07, ADR-0007): Metric Registry 1:1 con el reto que
 * se firma en G6 (SYS-22), snapshots append-only por formulario o CSV (SYS-23), lectura
 * por criterio contra la línea base, y outcome review con veredicto del catálogo cerrado
 * que cierra el reto y el proyecto (SYS-24, SYS-08).
 *
 * Capa 1: RLS — la firma es del rol aprobador de G6, el registry firmado queda congelado,
 * el snapshot solo entra con contrato firmado y reto en medición (y lo carga un curador o
 * el PROPIETARIO DEL DATO), y el review no se abre antes de cerrar la ventana. Capa 2:
 * estado de cuenta en toda operación, candados donde hay carrera, y el diagnóstico de por
 * qué NO se pudo firmar/completar, que es la mitad útil del producto.
 *
 * Lo que este slice NO hace, a propósito: redactar el post-mortem con AI (SPEC-08 — aquí
 * la narrativa es humana) y anclar la serie a fechas de release (SPEC-06).
 */

export class ErrorMedicion extends Error {}

/** Corte de la serie por entrada: una lectura no es un data warehouse. Se anuncia con
 * `totalSnapshots` —un tope que el usuario no ve es un recorte silencioso— y NUNCA se lleva
 * por delante un snapshot que un resultado del post mortem ya referencia: la proyección lo
 * vuelve a incluir aparte, porque si no el editor del review no podría representar lo que
 * hay guardado. Recorta por los MÁS ANTIGUOS, que en una serie de medición es el tramo
 * pegado a la línea base: por eso hace falta decirlo y no solo hacerlo. */
export const SNAPSHOTS_POR_ENTRADA = 500;

/** Tope de filas por carga CSV: la ingesta es manual y acotada (ADR-0007, decisión 4). */
export const MAX_FILAS_CSV = 500;

/** Fila de CSV que pasó el formato: sigue llevando su línea para poder rechazarla luego
 * por la ventana firmada sin perder de vista cuál era. */
type FilaCsv = { linea: number; contenido: string; fecha: string; valor: string; nota: string };

/** Candado por reto — MISMO espacio de nombres que el método (metodo.servicio). Serializa
 * todo lo que el cierre del post mortem vuelve historia: aceptar snapshots, escribir el
 * resultado por criterio y completar el review. Sin él, bajo READ COMMITTED cualquiera de
 * las dos escrituras pasa su política («reto en medición», «review en borrador») contra un
 * snapshot anterior al cierre y commitea DESPUÉS, escribiendo sobre un objeto ya cerrado
 * (SYS-08). Lo toma TODA operación de ese conjunto, antes de su sentencia decisora. */
async function bloquearReto(tx: TransactionSql, retoId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:reto:' || ${retoId}, 42))`;
}

/** Candado por registry: editar entradas y FIRMAR se excluyen igual que marcar checklist
 * y aprobar el gate — la firma congela exactamente lo que estaba escrito.
 *
 * ORDEN DE ADQUISICIÓN, para que ningún par de operaciones se abrace: primero el del RETO
 * y después el del registry (igual que el método toma reto y después gate). Ninguna ruta
 * toma este candado antes que el del reto, así que no hay ciclo posible entre los tres. */
async function bloquearRegistry(tx: TransactionSql, registryId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('designio:registry:' || ${registryId}, 42))`;
}

/** Traduce el raise de un guard (P0001) al contrato del módulo; deja pasar lo demás. */
function comoErrorDeDominio(e: unknown): never {
  const err = e as { code?: string; message?: string };
  if (err.code === 'P0001' && err.message) throw new ErrorMedicion(err.message);
  throw e;
}

/** Un INSERT que la política rechaza NO devuelve cero filas: aborta la transacción con
 * 42501. Por eso el diagnóstico rico de esos caminos corre en una transacción NUEVA de
 * solo lectura (dentro de la abortada, cualquier consulta ya fallaría con 25P02). */
function esRechazoDePolitica(e: unknown): boolean {
  return (e as { code?: string }).code === '42501';
}

/** Lo que hay que saber de una entrada KPI para aceptar un dato: de qué reto es, si está
 * midiendo y cuál es su ventana FIRMADA. La ventana no se puede mover una vez firmado el
 * registry (ni la entrada ni el criterio tienen política de update entonces), así que
 * leerla antes del candado no abre carrera; y `hoy` sale de la misma transacción que
 * evaluará la política, así que ambos ven el mismo `current_date`. */
type ContextoEntrada = {
  retoId: string;
  /** Registry firmado y reto en medición: las condiciones que hacen del dato un dato. */
  midiendo: boolean;
  ventanaInicio: string | null;
  ventanaFin: string | null;
  hoy: string;
};

async function contextoDeEntrada(
  tx: TransactionSql,
  workspaceId: string,
  entradaId: string,
): Promise<ContextoEntrada> {
  const [fila] = await tx`
    select r.reto_id,
      (r.estado = 'firmado' and rt.estado = 'en-medicion') as midiendo,
      e.ventana_inicio::text as ventana_inicio,
      (e.ventana_inicio + c.ventana_dias)::text as ventana_fin,
      current_date::text as hoy
    from entrada_kpi e
    join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
    join reto rt on rt.id = r.reto_id and rt.workspace_id = r.workspace_id
    join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
    where e.id = ${entradaId} and e.workspace_id = ${workspaceId}`;
  if (!fila) throw new ErrorMedicion('La entrada KPI no existe en este workspace');
  return {
    retoId: fila.reto_id as string,
    midiendo: fila.midiendo as boolean,
    ventanaInicio: fila.ventana_inicio as string | null,
    ventanaFin: fila.ventana_fin as string | null,
    hoy: fila.hoy as string,
  };
}

/** Abre el contrato de medición del reto (RF-07.1). 1:1 por unique: dos aperturas
 * concurrentes no crean dos registries — la segunda choca y se traduce. */
export async function abrirRegistry(
  actorId: string,
  entrada: { workspaceId: string; retoId: string },
): Promise<{ registryId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    let fila;
    try {
      // El evento `MetricRegistryAbierto` NO se emite aquí: lo emite el trigger de
      // auditoría de la base, para que también lo produzca el SQL directo. Un evento en el
      // servicio es una promesa; uno en el trigger es una propiedad.
      [fila] = await tx`
        insert into metric_registry (workspace_id, reto_id, creado_por)
        values (${entrada.workspaceId}, ${entrada.retoId}, ${actorId})
        returning id`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') throw new ErrorMedicion('Este reto ya tiene su Metric Registry');
      if (code === '23503') throw new ErrorMedicion('El reto no existe en este workspace');
      if (esRechazoDePolitica(e)) {
        throw new ErrorMedicion('El registry se abre sobre un reto activo y lo abren lead o diseñador');
      }
      throw e;
    }
    return { registryId: fila!.id as string };
  });
}

export async function agregarEntrada(
  actorId: string,
  entrada: CrearEntrada,
): Promise<{ entradaId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Serializa contra la firma: sin el candado, este insert y una firma concurrente
    // podrían commitear juntos y congelar una entrada que nadie revisó.
    await bloquearRegistry(tx, entrada.registryId);
    let fila;
    try {
      [fila] = await tx`
        insert into entrada_kpi (workspace_id, registry_id, criterio_id, nombre, definicion,
          fuente, dimensiones, propietario_miembro_id, frecuencia, dashboard_url,
          linea_base_valor, linea_base_fecha, ventana_inicio, fecha_post_mortem, creado_por)
        values (${entrada.workspaceId}, ${entrada.registryId}, ${entrada.criterioId},
          ${entrada.nombre}, ${entrada.definicion}, ${entrada.fuente}, ${entrada.dimensiones},
          ${entrada.propietarioMiembroId}, ${entrada.frecuencia}, ${entrada.dashboardUrl},
          ${entrada.lineaBaseValor}, ${entrada.lineaBaseFecha}, ${entrada.ventanaInicio},
          ${entrada.fechaPostMortem}, ${actorId})
        returning id`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') throw new ErrorMedicion('Ya hay un KPI con ese nombre en el registry');
      if (code === '23503') {
        throw new ErrorMedicion('El registry, el criterio o el propietario no existen aquí');
      }
      if (code === '42501') {
        throw new ErrorMedicion(
          'El registry está firmado, el criterio no es de este reto, el dueño del dato no es' +
            ' una persona del cliente o no puedes editarlo',
        );
      }
      comoErrorDeDominio(e);
    }
    if (!fila) throw new ErrorMedicion('El registry está firmado o no puedes editarlo');
    return { entradaId: fila.id as string };
  });
}

/** Corrige una entrada ENTERA mientras el registry es borrador —el criterio al que
 * responde incluido— y después la política la congela (0 filas). Es el camino de
 * reparación y el ÚNICO: la tabla no tiene borrado, así que si el criterio no se pudiera
 * corregir, elegir el equivocado obligaría a firmar el contrato con un KPI que mide una
 * promesa que nadie hizo. En borrador la entrada no puede tener snapshots (la política del
 * snapshot exige el registry firmado), así que reapuntarla no mueve ninguna serie. */
export async function editarEntrada(actorId: string, entrada: EditarEntrada): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [dueno] = await tx`select registry_id from entrada_kpi
      where id = ${entrada.entradaId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) throw new ErrorMedicion('La entrada KPI no existe en este workspace');
    await bloquearRegistry(tx, dueno.registry_id as string);
    let filas;
    try {
      filas = await tx`
        update entrada_kpi
        set nombre = ${entrada.nombre}, definicion = ${entrada.definicion},
            fuente = ${entrada.fuente}, dimensiones = ${entrada.dimensiones},
            criterio_id = ${entrada.criterioId},
            propietario_miembro_id = ${entrada.propietarioMiembroId},
            frecuencia = ${entrada.frecuencia}, dashboard_url = ${entrada.dashboardUrl},
            linea_base_valor = ${entrada.lineaBaseValor},
            linea_base_fecha = ${entrada.lineaBaseFecha},
            ventana_inicio = ${entrada.ventanaInicio},
            fecha_post_mortem = ${entrada.fechaPostMortem}
        where id = ${entrada.entradaId} and workspace_id = ${entrada.workspaceId}`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') throw new ErrorMedicion('Ya hay un KPI con ese nombre en el registry');
      if (code === '23503') {
        throw new ErrorMedicion('El criterio o el propietario del dato no existen aquí');
      }
      // El USING ya validó rol y registry en borrador, así que a estas alturas el WITH
      // CHECK solo puede fallar por las dos condiciones sobre el CONTENIDO de la fila
      // nueva. Van juntas en un mensaje, como el del snapshot: son las dos que el
      // formulario puede haber elegido mal.
      if (code === '42501') {
        throw new ErrorMedicion(
          'El criterio no es de este reto o el dueño del dato no es una persona del cliente' +
            ' (RF-07.1)',
        );
      }
      comoErrorDeDominio(e);
    }
    if (filas.count === 0) {
      throw new ErrorMedicion('El registry está firmado o no puedes editarlo');
    }
  });
}

/**
 * Firmar el registry (SYS-22): la política exige el rol aprobador de G6 con G0-G5
 * aprobados y G6 pendiente; el guard de la base exige el CONTENIDO (cada criterio con su
 * KPI, cada entrada completa y el post-mortem previsto tras el cierre de la ventana).
 * 0 filas = bloqueado por la política; el diagnóstico dice cuál de las dos razones fue.
 */
export async function firmarRegistry(
  actorId: string,
  entrada: { workspaceId: string; registryId: string },
): Promise<{ entradas: number }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // Firmar CONGELA los criterios del reto, así que tiene que serializarse con quien los
    // muta: `agregarCriterio` y `editarCriterio` toman el candado del RETO y este tomaba
    // solo el del registry, de modo que los dos caminos no se veían. Bajo READ COMMITTED
    // la firma validaba el criterio viejo y commiteaba, y la edición en vuelo commiteaba
    // después su `objetivo` o su `ventana_dias` nuevos: el contrato cambiaba justo después
    // de firmarse. Se toma el MISMO candado, y primero (orden reto → registry: ninguna
    // ruta los pide al revés, así que no hay abrazo posible). El guard de la base repite
    // la cita bloqueando la fila del G0, que es lo que cubre además el SQL directo.
    // `reto_id` es inmutable: leerlo antes de tomar el candado no abre carrera.
    const [dueno] = await tx`select reto_id from metric_registry
      where id = ${entrada.registryId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) throw new ErrorMedicion('El registry no existe en este workspace');
    await bloquearReto(tx, dueno.reto_id as string);
    await bloquearRegistry(tx, entrada.registryId);
    let firmado;
    try {
      // El sello temporal lo pone el guard (la base), no el caller: `firmado_en` ni
      // siquiera está en el grant del rol de app, así que aquí solo se pide la firma.
      firmado = await tx`
        update metric_registry
        set estado = 'firmado', firmado_por = ${actorId}
        where id = ${entrada.registryId} and workspace_id = ${entrada.workspaceId}
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (firmado!.length === 0) {
      throw new ErrorMedicion(await diagnosticoDeFirma(tx, entrada.workspaceId, entrada.registryId));
    }
    const [conteo] = await tx`select count(*)::int as n from entrada_kpi
      where registry_id = ${entrada.registryId} and workspace_id = ${entrada.workspaceId}`;
    return { entradas: conteo!.n as number };
  });
}

/** Por qué NO se pudo firmar: read-only, corre tras el update fallido (el guard habla
 * del contenido; esto, de la posición en el método y del rol). */
async function diagnosticoDeFirma(
  tx: TransactionSql,
  workspaceId: string,
  registryId: string,
): Promise<string> {
  const [registry] = await tx`
    select r.estado, r.reto_id from metric_registry r
    where r.id = ${registryId} and r.workspace_id = ${workspaceId}`;
  if (!registry) return 'El registry no existe en este workspace';
  if (registry.estado === 'firmado') return 'El Metric Registry ya está firmado';

  // La posición en el método la dice `reparos_de_posicion_de_firma`, la MISMA función que
  // lee la proyección para apagar el botón ANTES de que nadie pulse. Mientras estos tres
  // mensajes se compusieron aquí a mano, la pantalla no tenía de dónde sacarlos y el botón
  // se ofrecía encendido para que la política filtrara la fila — y una fila filtrada por
  // política no levanta excepción: son cero filas, y sin este diagnóstico el acto más
  // solemne de la pantalla habría fallado en silencio.
  const [posicion] = await tx`
    select reparo from reparos_de_posicion_de_firma(${registryId}::uuid,
      ${registry.reto_id as string}::uuid, ${workspaceId}::uuid)
    order by orden limit 1`;
  if (posicion) return posicion.reparo as string;

  // Y si la posición está bien, lo que queda es el ROL: es lo único de esta lista que
  // depende de QUIÉN mira, así que no vive en la proyección compartida —la pantalla lo
  // espeja con `puedeFirmar`— y se resuelve aquí, con el rol aprobador del propio G6.
  const [g6] = await tx`
    select g.rol_aprobador from gate_instancia g
    join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
    where p.reto_id = ${registry.reto_id as string} and p.workspace_id = ${workspaceId}
      and g.numero = 6`;
  return `Solo el rol ${g6!.rol_aprobador as string} firma el Metric Registry en G6`;
}

/**
 * Abrir la medición (RF-07.6): el reto pasa a «en medición» y su proyecto también. Los
 * guards de transición de la base exigen el registry FIRMADO (SYS-22) y el G7 APROBADO
 * (§5.2), y la política, el rol que opera el método. Los dos movimientos van en la misma
 * transacción: un reto midiendo con el proyecto todavía en implementación sería un tablero
 * que miente — y en una base con historia ese tablero YA existe, así que la operación
 * también sabe terminar el movimiento a medias que dejó el ciclo anterior.
 */
export async function abrirMedicion(
  actorId: string,
  entrada: { workspaceId: string; retoId: string },
): Promise<{ proyectos: number }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    await bloquearReto(tx, entrada.retoId);
    // Las dos condiciones del método, leídas ANTES de mover nada para que el mensaje sea
    // el del método y no el del rechazo. Si el reto no existe, no está activo o no se ve,
    // no hay fila y hablan los guards y la política, que es lo correcto: el diagnóstico no
    // debe contarle el estado del reto a quien no puede leerlo.
    const [listo] = await tx`
      select r.estado, r.medicion_sin_registry,
        -- ¿Queda algún proyecto DETRÁS del reto? Es lo que acota el perdón histórico de
        -- abajo: 'en-medicion' está con su reto y 'cerrado' ya terminó; cualquier otro
        -- estado es una fila que este movimiento todavía tiene que rematar.
        exists (select 1 from proyecto p2
          where p2.reto_id = r.id and p2.workspace_id = r.workspace_id
            and p2.estado not in ('en-medicion', 'cerrado')) as alguno_detras,
        exists (select 1 from metric_registry mr
          where mr.reto_id = r.id and mr.workspace_id = r.workspace_id
            and mr.estado = 'firmado') as firmado,
        exists (select 1 from gate_instancia g
          join proyecto p on p.id = g.proyecto_id and p.workspace_id = g.workspace_id
          where p.reto_id = r.id and p.workspace_id = r.workspace_id
            and g.numero = 7 and g.estado = 'aprobado') as g7
      from reto r
      where r.id = ${entrada.retoId} and r.workspace_id = ${entrada.workspaceId}
        and r.estado in ('activo', 'en-medicion')`;
    if (listo && !listo.firmado) {
      throw new ErrorMedicion('Abrir la medición exige el Metric Registry firmado en G6 (SYS-22)');
    }
    // El ciclo canónico (§5.2) asigna este paso a G7, no a G6: «releases conciliados
    // contra la design version; effective state constatado; medición operando. El proyecto
    // y el reto pasan a en medición». G6 acuerda el plan y firma el contrato; abrir ahí
    // admitiría snapshots de una implementación que nadie ha conciliado todavía.
    if (listo && !listo.g7) {
      throw new ErrorMedicion(
        'Abrir la medición exige el G7 aprobado: releases conciliados y effective state constatado',
      );
    }
    // Un reto que YA venía midiendo de antes de este esquema no tiene que moverse —ya está
    // donde toca—: lo que le falta es su proyecto, que bajo el ciclo anterior no tenía
    // siquiera grant para cambiar de estado y por eso se quedó atrás. Esta operación le
    // termina el movimiento en vez de negarse, que es lo que dejaba el tablero mintiendo
    // (reto midiendo, proyecto sin medir) sin ninguna forma de arreglarlo.
    //
    // Y ese perdón dura lo que dura su MOTIVO, igual que en los dos guards del par: vale
    // mientras quede algún proyecto detrás. La marca no se borra al reparar —la escribió la
    // migración y nadie la vuelve a escribir—, así que atada solo a ella esta rama seguía
    // abierta para siempre: con la reparación ya hecha, la operación no tenía nada que
    // mover y terminaba diciendo «ningún proyecto del reto puede pasar a medición», que
    // manda a buscar una avería inexistente en lugar de decir la verdad — que ya está
    // abierta.
    const yaMedia = listo?.estado === 'en-medicion';
    if (yaMedia && !(listo!.medicion_sin_registry && listo!.alguno_detras)) {
      throw new ErrorMedicion('La medición de este reto ya está abierta');
    }
    // Qué proyectos del reto NO van a estar midiendo después de esto, y por qué. Sale de
    // `proyectos_frenan_medicion`, la MISMA función que usan el guard del par y la
    // proyección de la pantalla: este predicado se había escrito tres veces a mano y las
    // tres se quedó un estado corto, así que ahora hay una sola redacción y tres lectores.
    //
    // Se dice ANTES de mover nada, que es lo único que deja salida: con el reto todavía
    // activo, retomar un proyecto y cerrar sus gates es el camino normal del método; en
    // cuanto el reto se mueve, esa salida desaparece.
    //
    // Con el reto HEREDADO solo cuentan los motivos que no son «al entrar»: allí el reto ya
    // mide y sus proyectos están detrás por definición —esa es la avería que se está
    // reparando—, así que exigirlos cerraría la única salida que esas filas tienen.
    if (listo) {
      const frenan = await tx`
        select codigo, motivo from proyectos_frenan_medicion(${entrada.retoId}::uuid,
                                                             ${entrada.workspaceId}::uuid)
        where not solo_al_entrar or not ${yaMedia}`;
      if (frenan.length > 0) {
        const lista = frenan
          .map((p) => `${p.codigo as string} (${p.motivo as string})`)
          .join(', ');
        throw new ErrorMedicion(
          `Estos proyectos del reto no pueden entrar en medición: ${lista}. La apertura los mueve a todos a la vez, así que resuélvelo antes`,
        );
      }
    }
    if (!yaMedia) {
      let abierto;
      try {
        abierto = await tx`
          update reto set estado = 'en-medicion'
          where id = ${entrada.retoId} and workspace_id = ${entrada.workspaceId}
            and estado = 'activo'
          returning id`;
      } catch (e) {
        comoErrorDeDominio(e);
      }
      if (abierto!.length === 0) {
        throw new ErrorMedicion('El reto no existe, no está activo o no puedes abrir su medición');
      }
    }
    let movidos;
    try {
      // Solo desde IMPLEMENTACIÓN: al método se entra en medición por G7 y a G7 se llega
      // por G6, que es el que mete el proyecto en implementación (§7). Un proyecto en
      // 'activo' con su G7 aprobado solo existía como historia previa a este esquema, y a
      // esa la mueve el relleno de la migración (donde el reto sigue vivo, que es donde el
      // proyecto puede avanzar); mover también los 'activo' aquí era el
      // atajo por el que un proyecto heredado se saltaba la fase entera.
      movidos = await tx`
        update proyecto set estado = 'en-medicion'
        where reto_id = ${entrada.retoId} and workspace_id = ${entrada.workspaceId}
          and estado = 'en-implementacion'`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    // Los dos movimientos son uno solo: si ningún proyecto entró en medición (todos
    // pausados, ya cerrados o todavía sin pasar por implementación), el reto tampoco — se
    // revierte la transacción completa.
    if (movidos!.count === 0) {
      throw new ErrorMedicion(
        'Ningún proyecto del reto puede pasar a medición (revisa si está pausado, cerrado o sin entrar en implementación)',
      );
    }
    return { proyectos: movidos!.count };
  });
}

/**
 * PAUSAR y RETOMAR el proyecto (RF-04.12, §7). Las dos rutas que le faltaban a la tabla.
 *
 * Este slice declaró la máquina de estados entera del proyecto —cada par legal con su
 * precondición al lado— y dejó CUATRO pares sin ninguna ruta de producto que los recorriera:
 * los dos de pausar y los dos de retomar antes de que el reto mida. Un par legal que ningún
 * camino recorre es una promesa que la máquina hace y el producto no cumple; y cuando el
 * estado de origen es alcanzable —lo es: `activo` y `en-implementacion` son el curso normal—
 * la promesa incumplida es un callejón. El caso que lo destapó: un reto ACTIVO con todos sus
 * proyectos pausados tras G6 no tenía ni cómo abrir la medición (no queda nadie en
 * implementación a quien mover) ni cómo retomar (la reanudación exigía el reto ya midiendo).
 *
 * Retomar es UNA operación y no tres porque el destino es DETERMINISTA, y eso ya estaba
 * escrito en el guard: manda dónde está el reto y, si todavía no mide, si el plan estaba
 * aprobado. Ofrecer el destino como opción del usuario habría convertido la regla en una
 * pantalla — justo el reparto que este slice bajó al dato.
 */
export async function pausarProyecto(
  actorId: string,
  entrada: { workspaceId: string; proyectoId: string },
): Promise<{ proyectoId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [proyecto] = await tx`select reto_id from proyecto
      where id = ${entrada.proyectoId} and workspace_id = ${entrada.workspaceId}`;
    if (!proyecto) throw new ErrorMedicion('El proyecto no existe en este workspace');
    await bloquearReto(tx, proyecto.reto_id as string);
    let movido;
    try {
      // Los DOS orígenes legales en una sentencia, y el estado en el WHERE: el UPDATE lo
      // reevalúa después del candado, que es lo único que ve un movimiento ajeno en vuelo.
      // Parar es del cliente y no tiene precondición; lo que no se para es lo que ya mide
      // —el par no existe— ni lo cerrado, que es inmutable (SYS-08).
      movido = await tx`
        update proyecto set estado = 'pausado'
        where id = ${entrada.proyectoId} and workspace_id = ${entrada.workspaceId}
          and estado in ('activo', 'en-implementacion')
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (movido!.length === 0) {
      throw new ErrorMedicion(
        'Solo se pausa un proyecto activo o en implementación: el que ya mide sigue con su reto y el cerrado es inmutable (SYS-08)',
      );
    }
    return { proyectoId: entrada.proyectoId };
  });
}

/**
 * Retomar el proyecto pausado, al ÚNICO destino que le corresponde.
 *
 * El destino sale de dos preguntas en este orden, que son las del guard: dónde está el RETO
 * y, si todavía no mide, si el plan ya estaba aprobado. Un proyecto pausado antes del plan
 * vuelve a 'activo'; uno pausado durante la implementación, a 'en-implementacion'; y
 * cualquiera de los dos entra en 'en-medicion' si mientras estaba parado su reto abrió la
 * medición — ahí no puede quedarse por detrás (§5.2).
 *
 * No repite ninguna precondición: las tres del par —legalidad, G6/G7 y estado del reto— viven
 * en `proyecto_estado_transicion_guard` y esta operación solo las invoca. Lo que hace es
 * tomar el candado del reto primero para no decidir sobre una instantánea, poner el estado en
 * el WHERE para que el UPDATE lo reevalúe DESPUÉS del candado, y convertir el cero filas en
 * un motivo: un update filtrado no levanta nada por sí solo.
 */
export async function retomarProyecto(
  actorId: string,
  entrada: { workspaceId: string; proyectoId: string },
): Promise<{ proyectoId: string; estado: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [proyecto] = await tx`select reto_id from proyecto
      where id = ${entrada.proyectoId} and workspace_id = ${entrada.workspaceId}`;
    if (!proyecto) throw new ErrorMedicion('El proyecto no existe en este workspace');
    await bloquearReto(tx, proyecto.reto_id as string);
    // El destino se lee DESPUÉS del candado, que es cuando el estado del reto deja de
    // moverse: decidirlo antes sería elegir contra una instantánea y escribir contra otra.
    const [ctx] = await tx`
      select r.estado as reto, r.medicion_sin_registry,
        exists (select 1 from gate_instancia g
          where g.proyecto_id = ${entrada.proyectoId} and g.workspace_id = r.workspace_id
            and g.numero = 6 and g.estado = 'aprobado') as g6,
        -- «Puede seguir a su reto» es el MISMO predicado que aplica el guard, y aquí decide
        -- el destino: el reto heredado cuyo proyecto todavía no puede seguirlo vuelve a su
        -- fase —el camino de reparación— y no a medición, donde el guard lo rechazaría.
        proyecto_puede_seguir_al_reto(${entrada.proyectoId}::uuid, r.id, r.workspace_id)
          as puede_seguir
      from reto r
      where r.id = ${proyecto.reto_id as string} and r.workspace_id = ${entrada.workspaceId}`;
    if (!ctx) throw new ErrorMedicion('El reto del proyecto no existe en este workspace');
    const sigueAlReto =
      ctx.reto === 'en-medicion' && (!ctx.medicion_sin_registry || ctx.puede_seguir);
    const destino = sigueAlReto ? 'en-medicion' : ctx.g6 ? 'en-implementacion' : 'activo';
    let movido;
    try {
      movido = await tx`
        update proyecto set estado = ${destino}
        where id = ${entrada.proyectoId} and workspace_id = ${entrada.workspaceId}
          and estado = 'pausado'
        returning id`;
    } catch (e) {
      comoErrorDeDominio(e);
    }
    if (movido!.length === 0) {
      throw new ErrorMedicion(
        'Este proyecto no está pausado o no puedes cambiar su estado: retomar es para un proyecto parado',
      );
    }
    return { proyectoId: entrada.proyectoId, estado: destino };
  });
}

/**
 * BORRAR una entrada KPI mientras el contrato sigue en borrador (RF-07.2).
 *
 * El motivo por el que este slice no tenía DELETE respondía a otra pregunta: decía que en
 * borrador la entrada se corrige entera y no puede tener snapshots, o sea que no hay estado
 * que solo el borrado pudiera deshacer. Eso contesta «¿hace falta borrar para DESHACER algo?».
 * La pregunta real es «¿hace falta borrar para que algo DEJE DE EXISTIR?»: una entrada creada
 * por error no se arregla editándola, porque el problema no es su contenido sino su presencia
 * — y además BLOQUEA, porque la firma exige toda entrada completa y el registry es 1:1 con el
 * reto. La única salida era inventarse un KPI para poder firmar, que es justo lo que este
 * slice existe para impedir.
 *
 * La política lo acota al registry en BORRADOR, igual que la edición y por lo mismo: firmar
 * es lo que congela. Y en borrador la entrada no puede tener snapshots, así que quitarla no
 * deja ninguna serie huérfana.
 */
export async function borrarEntrada(
  actorId: string,
  entrada: { workspaceId: string; entradaId: string },
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [dueno] = await tx`select r.reto_id from entrada_kpi e
      join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
      where e.id = ${entrada.entradaId} and e.workspace_id = ${entrada.workspaceId}`;
    if (!dueno) throw new ErrorMedicion('La entrada no existe en este workspace');
    // Mismo candado que el resto del slice: quitar una entrada y FIRMAR el contrato deciden
    // sobre lo mismo desde tablas distintas, así que sin cita la firma validaría un conjunto
    // de entradas y congelaría otro.
    await bloquearReto(tx, dueno.reto_id as string);
    const borrada = await tx`delete from entrada_kpi
      where id = ${entrada.entradaId} and workspace_id = ${entrada.workspaceId}
      returning id`;
    if (borrada.length === 0) {
      throw new ErrorMedicion(
        'No se puede quitar esta entrada: el contrato ya está firmado o no puedes editarlo',
      );
    }
  });
}

/**
 * GUARDAR el borrador del post mortem sin completarlo (RF-07.7).
 *
 * Había un lector sin escritor: la base ADMITE y AUDITA los updates del review en borrador
 * —la política los deja pasar en su WITH CHECK y el rastro tiene su propio evento— y la
 * pantalla HIDRATA el formulario desde el borrador guardado. Faltaba lo del medio, así que la
 * única acción era completar, que es irreversible: navegar, recargar o toparse con una
 * validación tiraba los cinco campos narrativos. Y lo que se pierde ahí es texto redactado a
 * mano, que es lo caro de un post mortem — y el review completado es inmutable, así que no
 * vuelve.
 *
 * No escribe `completado_por` ni `completado_en` ni mueve el estado: guardar no es firmar. Su
 * esquema tampoco es el del cierre, porque guardar existe para poder dejarlo a medias.
 */
export async function guardarBorradorReview(
  actorId: string,
  entrada: BorradorReview,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [dueno] = await tx`select estado, reto_id from outcome_review
      where id = ${entrada.reviewId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) throw new ErrorMedicion('El outcome review no existe en este workspace');
    if (dueno.estado === 'completado') {
      throw new ErrorMedicion('El outcome review ya está completado: es inmutable (SYS-08)');
    }
    await bloquearReto(tx, dueno.reto_id as string);
    const guardado = await tx`
      update outcome_review
      set veredicto = ${entrada.veredicto},
          contribucion = ${entrada.contribucion},
          factores_externos = ${entrada.factoresExternos},
          hipotesis_abiertas = ${entrada.hipotesisAbiertas},
          aprendizajes = ${entrada.aprendizajes},
          diseno_experimental_suficiente = ${entrada.disenoExperimentalSuficiente},
          diseno_experimental_justificacion = ${entrada.disenoExperimentalJustificacion}
      where id = ${entrada.reviewId} and workspace_id = ${entrada.workspaceId}
        and estado = 'borrador'
      returning id`;
    if (guardado.length === 0) {
      throw new ErrorMedicion('No puedes guardar este post mortem: lo redacta el lead');
    }
  });
}

/** Único mensaje de las tres condiciones que la política del snapshot exige a la vez
 * (SYS-22/23): decir cuál falló sería contar el estado del reto a quien no lo lee. */
const RECHAZO_SNAPSHOT =
  'No puedes cargar snapshots: exige registry firmado, reto en medición y ser curador o propietario del dato';

/** Snapshot por formulario (RF-07.3): append-only, con fecha CALENDÁRICA y origen. */
export async function registrarSnapshot(
  actorId: string,
  entrada: RegistrarSnapshot,
): Promise<{ snapshotId: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const ctx = await contextoDeEntrada(tx, entrada.workspaceId, entrada.entradaId);
    await bloquearReto(tx, ctx.retoId);
    // Solo se diagnostica la FECHA cuando lo demás está en su sitio: si el reto no está
    // midiendo, el motivo real es ese y lo dice la política, no la ventana.
    if (ctx.midiendo) {
      const motivo = motivoFechaDeSnapshot(entrada.fecha, ctx);
      if (motivo) throw new ErrorMedicion(motivo);
    }
    let fila;
    try {
      // `SnapshotRegistrado` lo emite el trigger de auditoría, igual que el resto: la
      // serie es el dato del que sale el veredicto y su rastro no puede depender de que
      // se entre por aquí.
      [fila] = await tx`
        insert into snapshot (workspace_id, entrada_kpi_id, valor, fecha, origen, nota, creado_por)
        values (${entrada.workspaceId}, ${entrada.entradaId}, ${entrada.valor}::numeric,
                ${entrada.fecha}::date, 'formulario', ${entrada.nota}, ${actorId})
        returning id`;
    } catch (e) {
      if (esRechazoDePolitica(e)) throw new ErrorMedicion(RECHAZO_SNAPSHOT);
      // El guard del punto de cita habla con su propio motivo (P0001) cuando el reto dejó
      // de estar en medición mientras esta inserción esperaba la fila.
      comoErrorDeDominio(e);
    }
    return { snapshotId: fila!.id as string };
  });
}

/**
 * Carga por CSV pegado (RF-07.3, criterio de aceptación 1): una fila inválida se rechaza
 * CON motivo accionable y las válidas entran; nada se sobreescribe jamás (SYS-23).
 * Formato por línea: `fecha,valor[,nota]` con separador `,`, `;` o tabulador; la fecha
 * es calendárica AAAA-MM-DD y el valor usa punto decimal. Una cabecera `fecha,...` se
 * ignora — es lo que exporta cualquier hoja de cálculo.
 */
export async function cargarSnapshotsCsv(
  actorId: string,
  entrada: CargarCsv,
): Promise<{ insertados: number; rechazadas: FilaRechazada[]; csvRestante: string }> {
  const { validas, rechazadas, cabecera, textoDeRegistro } = parsearCsv(entrada.csv);
  /** El texto que queda por reintentar: la cabecera —si la había— y las filas rechazadas,
   * en su orden original. Se construye AQUÍ y no en la pantalla porque las reglas del
   * parseo viven aquí: el delimitador sale del primer renglón con contenido y la cabecera
   * solo se salta si lo parece, así que un recorte hecho a ojo puede cambiar cómo se lee el
   * reintento — otra corrupción distinta en lugar de la que se está evitando. */
  const restante = (rechazadas: FilaRechazada[]): string => {
    if (rechazadas.length === 0) return '';
    const quedan = new Set(rechazadas.map((f) => f.linea));
    if (cabecera !== null) quedan.add(cabecera);
    return [...quedan]
      .sort((a, b) => a - b)
      .map((n) => textoDeRegistro.get(n) ?? '')
      .join('\n');
  };
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const ctx = await contextoDeEntrada(tx, entrada.workspaceId, entrada.entradaId);
    await bloquearReto(tx, ctx.retoId);
    // La ventana firmada se aplica FILA A FILA, como el formato: una fecha fuera de
    // ventana no debe tumbar la tanda entera (RF-07.3, criterio 1) — la política sí lo
    // haría, porque un solo rechazo aborta el INSERT completo. Solo cuando el reto está
    // midiendo: si no, el motivo real es otro y lo dice la política.
    const enVentana = ctx.midiendo
      ? validas.filter((f) => {
          const motivo = motivoFechaDeSnapshot(f.fecha, ctx);
          if (motivo === null) return true;
          rechazadas.push({ linea: f.linea, contenido: f.contenido, motivo });
          return false;
        })
      : validas;
    // Y una CARGA no corrige (ver el guard `snapshot_carga_no_corrige`): por CSV no se
    // escribe sobre una fecha que ya tiene dato de esta entrada. Es lo que hace que
    // reenviar un fichero ya cargado —un doble clic, un reintento, volver a pegarlo
    // mañana— no duplique una serie que después nadie puede limpiar, porque no hay
    // borrado. La base lo exige igual; aquí se hace FILA A FILA para que el rechazo diga
    // qué fecha es y qué hacer, en vez de tumbar la tanda entera con el motivo del guard.
    //
    // Incluye los repetidos DENTRO del propio fichero, que el guard no puede ver: su
    // consulta no incluye lo que la misma sentencia acaba de escribir.
    const yaCargadas = await tx`
      select fecha::text as fecha from snapshot
      where entrada_kpi_id = ${entrada.entradaId} and workspace_id = ${entrada.workspaceId}`;
    const ocupadas = new Set(yaCargadas.map((f) => f.fecha as string));
    const nuevas = enVentana.filter((f) => {
      if (!ocupadas.has(f.fecha)) {
        ocupadas.add(f.fecha);
        return true;
      }
      rechazadas.push({
        linea: f.linea,
        contenido: f.contenido,
        motivo: `Ya hay un dato de ${f.fecha}: una carga no corrige — corrige desde el formulario, con su nota`,
      });
      return false;
    });
    rechazadas.sort((a, b) => a.linea - b.linea);
    if (nuevas.length === 0) {
      // Sin filas válidas no hay escritura, pero el diagnóstico sí importa: la pantalla
      // muestra por qué se rechazó cada línea.
      return { insertados: 0, rechazadas, csvRestante: restante(rechazadas) };
    }
    let insertadas;
    try {
      // Todas las filas válidas en UNA sentencia: la carga es atómica (o entra la tanda
      // completa o ninguna), que es lo que «nada se sobreescribe» exige de una corrección.
      insertadas = await tx`
        insert into snapshot (workspace_id, entrada_kpi_id, valor, fecha, origen, nota, creado_por)
        select ${entrada.workspaceId}, ${entrada.entradaId}, f.valor::numeric, f.fecha::date,
               'csv', f.nota, ${actorId}
        from jsonb_to_recordset(${tx.json(nuevas)}) as f(fecha text, valor text, nota text)
        returning id`;
    } catch (e) {
      if (esRechazoDePolitica(e)) throw new ErrorMedicion(RECHAZO_SNAPSHOT);
      // El guard del punto de cita habla con su propio motivo (P0001) cuando el reto dejó
      // de estar en medición mientras esta inserción esperaba la fila.
      comoErrorDeDominio(e);
    }
    const [quien] = await tx`select workspace_role(${actorId}, ${entrada.workspaceId}) as rol`;
    // Un evento por CARGA, ADEMÁS del que el trigger emite por fila. Es la única
    // excepción honesta a «el rastro lo emite la base»: cuenta las filas RECHAZADAS, que
    // no llegan a ser filas de ninguna tabla, así que ningún trigger puede verlas.
    await tx`
      insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
      values (${entrada.workspaceId}, 'SnapshotsCargados',
        ${tx.json({
          entradaId: entrada.entradaId,
          origen: 'csv',
          insertados: insertadas.length,
          rechazadas: rechazadas.length,
        })},
        ${actorId}, ${quien!.rol as string})`;
    return { insertados: insertadas.length, rechazadas, csvRestante: restante(rechazadas) };
  });
}

/** Mismo límite que el formulario (`RegistrarSnapshotSchema.nota`): la vía por la que
 * entra un dato no puede cambiar lo que cabe en él. */
const MAX_NOTA_CSV = 500;

/** Delimitadores admitidos, en el ORDEN en que se prueban. Ver `delimitadorCsv`. */
const DELIMITADORES_CSV = [';', '\t', ','] as const;

/**
 * El delimitador es UNO por fichero y se decide UNA sola vez, aquí.
 *
 * Partir cada fila por «cualquiera de los admitidos» —que es lo que hacía antes— no es un
 * atajo sino un error de raíz: hace IMPOSIBLE distinguir un separador de un decimal,
 * porque la misma cadena es válida en las dos lecturas y la que gana la elige el orden del
 * código. `2026-08-01;55,2;nota` se partía en cuatro campos y guardaba 55 con la nota
 * «2 nota»: sin error, sin fila rechazada y sin nada en el rastro que permitiera notarlo
 * después. Un número plausible y distinto del que el fichero decía, alimentando el
 * resultado del criterio y, por ahí, el veredicto del outcome review — que es justo lo que
 * este slice existe para poder defender.
 *
 * Y no es un borde: `;` como delimitador y `,` como decimal son EL MISMO formato. Excel en
 * configuración regional española (y europea en general) exporta así precisamente porque la
 * coma está ocupada por el decimal, así que es lo que va a traer un cliente hispanohablante
 * que pegue sus métricas desde una hoja de cálculo — el caso de uso central de la pantalla.
 *
 * Cómo se decide: el primero de `;`, tab y `,` que aparezca en la primera línea con
 * contenido y deje una PRIMERA COLUMNA reconocible —una fecha, o la palabra «fecha» de la
 * cabecera—. El orden importa: `;` y el tabulador no aparecen nunca dentro de una fecha ni
 * de un número, así que su presencia es decisiva; la coma es el último recurso y, cuando le
 * toca serlo, ya no puede ser además decimal. Mirar la primera columna es lo que salva el
 * caso simétrico —un fichero de comas con un `;` dentro de una nota—: ahí `;` deja una
 * primera columna que no es fecha y se pasa al siguiente candidato.
 */
function delimitadorCsv(primera: string): string {
  for (const d of DELIMITADORES_CSV) {
    if (!primera.includes(d)) continue;
    const cabeza = (primera.split(d)[0] ?? '').trim();
    if (cabeza.toLowerCase() === 'fecha' || FechaCalendarioSchema.safeParse(cabeza).success) {
      return d;
    }
  }
  // Ninguno deja una primera columna reconocible: se elige por precedencia para que la
  // fila se rechace con su motivo en vez de partirse de una tercera forma.
  return DELIMITADORES_CSV.find((d) => primera.includes(d)) ?? ',';
}

/**
 * Un REGISTRO del pegado: una fila lógica, que no siempre es una línea física. Un campo
 * entrecomillado puede llevar saltos de línea dentro —una hoja de cálculo los exporta así
 * cuando la celda tiene varias líneas—, y partir a ciegas por `\n` rompía ese registro por
 * la mitad: la primera mitad entraba como snapshot con media nota y la segunda volvía como
 * fila inválida. Media fila insertada es la misma mentira silenciosa que el decimal y la
 * nota recortada, y aquí la peor de todas: la nota original ya no está entera en ningún
 * sitio y la serie es append-only, así que el fragmento no se puede sacar.
 *
 * Se agrupan las líneas físicas por BALANCE de comillas: mientras haya una comilla sin
 * cerrar, la línea siguiente pertenece al mismo registro. `linea` es la del COMIENZO, que
 * es la que hay que decirle a quien tiene que arreglarlo.
 */
function registrosCsv(lineas: string[]): { linea: number; texto: string }[] {
  const registros: { linea: number; texto: string }[] = [];
  let abierto: { linea: number; partes: string[] } | null = null;
  // El balance es ACUMULADO, no de la línea suelta: la que cierra la comilla también tiene
  // una cantidad impar, así que mirar solo su paridad dejaba el registro abierto y se
  // tragaba la fila siguiente —buena— dentro del rechazo.
  let dentroDeComillas = false;
  for (let i = 0; i < lineas.length; i++) {
    const fisica = lineas[i] ?? '';
    if (abierto === null) {
      abierto = { linea: i + 1, partes: [fisica] };
    } else {
      abierto.partes.push(fisica);
    }
    // `""` es una comilla escapada y cuenta dos: el estado solo cambia con una impar.
    if ((fisica.match(/"/g) ?? []).length % 2 === 1) dentroDeComillas = !dentroDeComillas;
    if (dentroDeComillas) continue;
    registros.push({ linea: abierto.linea, texto: abierto.partes.join('\n') });
    abierto = null;
  }
  if (abierto !== null) {
    registros.push({ linea: abierto.linea, texto: abierto.partes.join('\n') });
  }
  return registros;
}

/** Parseo puro del CSV pegado (sin base): separa filas válidas de rechazadas con motivo.
 * Las válidas conservan su línea y su contenido porque la ventana firmada todavía puede
 * rechazarlas, y ese rechazo también tiene que decir QUÉ línea fue. */
export function parsearCsv(csv: string): {
  validas: FilaCsv[];
  rechazadas: FilaRechazada[];
  /** Línea (1-based) que se saltó por ser cabecera, o null. La necesita quien reconstruya
   * el texto que queda por reintentar: sin ella, el recorte se comería el renglón que
   * decide el delimitador y el reintento se parsearía de otra forma. */
  cabecera: number | null;
  /** Texto ORIGINAL de cada registro, por su línea de comienzo. Un registro puede ocupar
   * varias líneas físicas, así que reconstruir el reintento a partir de las líneas sueltas
   * volvería a partirlo. */
  textoDeRegistro: Map<number, string>;
} {
  const validas: FilaCsv[] = [];
  const rechazadas: FilaRechazada[] = [];
  let cabecera: number | null = null;
  const lineas = csv.split(/\r?\n/);
  const delim = delimitadorCsv(lineas.find((l) => l.trim() !== '')?.trim() ?? '');
  const registros = registrosCsv(lineas);
  const textoDeRegistro = new Map(registros.map((r) => [r.linea, r.texto]));
  // Con el delimitador fijado, la coma solo puede ser una cosa. Si NO es el delimitador es
  // el decimal, y se normaliza a punto antes de validar: el objetivo del producto es que el
  // cliente pueda subir lo que su hoja de cálculo produce, y aceptar el `;` sin aceptar la
  // coma decimal sería aceptar medio formato. Si SÍ es el delimitador, entonces `55,2` son
  // dos campos y eso tampoco es una interpretación: es lo que el fichero declara.
  const comaDecimal = delim !== ',';
  // La cabecera se salta en la primera línea CON CONTENIDO, no en el índice 0: un fichero
  // que empieza con una línea en blanco tenía su cabecera rechazada como fecha inválida.
  let cabeceraPosible = true;
  for (const registro of registros) {
    const i = registro.linea - 1;
    const linea = registro.texto.trim();
    if (linea === '') continue;
    // Este parser NO interpreta comillas, así que se rechaza TODO registro que las lleve.
    //
    // La versión anterior de esta regla rechazaba solo el registro multilínea y el de la
    // comilla sin pareja, y era el mismo error a medias que ya cometió tres veces este
    // parseo: aplicar el principio a la mitad de los casos que condena. `2026-08-01,55,"a,
    // b"` tiene las comillas balanceadas y cabe en un renglón, así que pasaba el filtro; y
    // como aquí las comillas no significan nada, el `split` por el delimitador la partía en
    // cuatro campos y la nota entraba con las comillas y los escapes dobles como texto
    // literal. Se reportaba como INSERTADA, y la serie es append-only: esa nota no se
    // arregla después. Y no es un borde: la hoja de cálculo entrecomilla precisamente
    // cuando el campo lleva el delimitador dentro, así que ese es el caso corriente.
    //
    // Cubre también el multilínea sin nombrarlo: un registro solo ocupa varias líneas
    // físicas cuando `registrosCsv` encontró una comilla abierta, así que si lleva saltos,
    // lleva comillas.
    if (registro.texto.includes('"')) {
      rechazadas.push({
        linea: registro.linea,
        contenido: linea.slice(0, 120),
        motivo:
          'Este renglón lleva comillas y este cargador no las interpreta: quítalas. Si la nota contiene el separador o un salto de línea, exporta con «;» o tabulador, o carga ese dato desde el formulario',
      });
      continue;
    }
    const partes = linea.split(delim);
    const fecha = (partes[0] ?? '').trim();
    // Cabecera de hoja de cálculo: se salta sin contarla como rechazo.
    if (cabeceraPosible && fecha.toLowerCase() === 'fecha') {
      cabeceraPosible = false;
      cabecera = i + 1;
      continue;
    }
    cabeceraPosible = false;
    const crudo = (partes[1] ?? '').trim();
    // La nota se vuelve a unir con SU delimitador y no con un espacio: una nota que lo
    // contenga se conserva tal cual en vez de volver alterada, que es la misma clase de
    // mentira silenciosa aunque no toque el número. (Sin comillas: este parser no las
    // interpreta, y un campo entrecomillado con delimitadores dentro sigue partiéndose.)
    const nota = partes.slice(2).join(delim).trim();
    if (validas.length >= MAX_FILAS_CSV) {
      rechazadas.push({
        linea: i + 1,
        contenido: linea.slice(0, 120),
        motivo: `Se aceptan hasta ${MAX_FILAS_CSV} filas por carga`,
      });
      continue;
    }
    const fechaOk = FechaCalendarioSchema.safeParse(fecha);
    if (!fechaOk.success) {
      rechazadas.push({
        linea: i + 1,
        contenido: linea.slice(0, 120),
        motivo: fecha === '' ? 'Falta la fecha (AAAA-MM-DD)' : `Fecha inválida: «${fecha}»`,
      });
      continue;
    }
    // La nota se RECHAZA si no cabe, no se recorta. Recortarla era la misma mentira
    // silenciosa que el decimal, un tamaño más pequeña: la fila se reportaba como
    // insertada, el texto guardado no era el del fichero y `rechazadas` no decía nada. Y no
    // es un campo cualquiera: la nota explica una CORRECCIÓN (los snapshots son
    // append-only, así que corregir un número es una fila nueva con su porqué), o sea que
    // es justo el texto que alguien va a leer para entender por qué el dato cambió. El
    // formulario ya la rechaza con el mismo límite; aquí también, y con la línea a mano.
    if (nota.length > MAX_NOTA_CSV) {
      rechazadas.push({
        linea: i + 1,
        contenido: linea.slice(0, 120),
        motivo: `Nota de ${nota.length} caracteres: el máximo son ${MAX_NOTA_CSV} (recórtala antes de cargar)`,
      });
      continue;
    }
    // Más de un separador es un número AGRUPADO (`1.234,56`, `1,234.56`, `12,345,678`) y
    // eso no se adivina: se rechaza diciéndolo. Con uno solo, ese uno es el decimal — no se
    // admite separador de miles, que es además lo que exporta una hoja de cálculo.
    if ((crudo.match(/[.,]/g) ?? []).length > 1) {
      rechazadas.push({
        linea: i + 1,
        contenido: linea.slice(0, 120),
        motivo: `Valor con más de un separador decimal: «${crudo}» (no se admite separador de miles)`,
      });
      continue;
    }
    const valorOk = ValorMetricoSchema.safeParse(comaDecimal ? crudo.replace(',', '.') : crudo);
    if (!valorOk.success) {
      rechazadas.push({
        linea: i + 1,
        contenido: linea.slice(0, 120),
        motivo:
          crudo === ''
            ? 'Falta el valor'
            : `Valor no numérico: «${crudo}» (usa ${comaDecimal ? 'punto o coma decimal' : 'punto decimal'})`,
      });
      continue;
    }
    validas.push({
      linea: i + 1,
      contenido: linea.slice(0, 120),
      fecha: fechaOk.data,
      valor: valorOk.data,
      nota,
    });
  }
  return { validas, rechazadas, cabecera, textoDeRegistro };
}

/** Abrir el outcome review (RF-07.7): la política solo lo permite con la ventana del
 * ÚLTIMO criterio cerrada. 0 filas → el diagnóstico dice cuánto falta. */
export async function abrirOutcomeReview(
  actorId: string,
  entrada: { workspaceId: string; retoId: string },
): Promise<{ reviewId: string }> {
  try {
    return await conUsuario(actorId, async (tx) => {
      await exigirCuentaActiva(tx, actorId);
      const [fila] = await tx`
        insert into outcome_review (workspace_id, reto_id, creado_por)
        values (${entrada.workspaceId}, ${entrada.retoId}, ${actorId})
        returning id`;
      return { reviewId: fila!.id as string };
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23505') throw new ErrorMedicion('Este reto ya tiene su outcome review');
    if (code === '23503') throw new ErrorMedicion('El reto no existe en este workspace');
    if (!esRechazoDePolitica(e)) throw e;
    // Transacción NUEVA de solo lectura: la anterior quedó abortada por el rechazo, y
    // «cuánto falta para el post-mortem» es justo lo que el usuario necesita saber.
    throw new ErrorMedicion(
      await conUsuario(actorId, async (tx) => {
        await exigirCuentaActiva(tx, actorId);
        return diagnosticoDeReview(tx, entrada.workspaceId, entrada.retoId);
      }),
    );
  }
}

/** Por qué el review no se habilita todavía: ventanas abiertas, registry sin firmar o
 * medición sin abrir (RF-07.7 en lenguaje del usuario). */
async function diagnosticoDeReview(
  tx: TransactionSql,
  workspaceId: string,
  retoId: string,
): Promise<string> {
  const [reto] = await tx`select estado from reto
    where id = ${retoId} and workspace_id = ${workspaceId}`;
  if (!reto) return 'El reto no existe en este workspace';
  const [registry] = await tx`select estado from metric_registry
    where reto_id = ${retoId} and workspace_id = ${workspaceId}`;
  if (!registry) return 'El reto no tiene Metric Registry: no hay nada que revisar';
  if (registry.estado !== 'firmado') return 'El Metric Registry aún no está firmado (SYS-22)';
  if (reto.estado !== 'en-medicion') {
    return `El outcome review se abre con el reto en medición (ahora: ${reto.estado as string})`;
  }
  // MISMO predicado que la política y el guard, por la función de la base: un diagnóstico
  // que no coincidiera con quien autoriza dejaría al lead con un rechazo y un «no falta
  // nada» — precisamente el día del corte, que es cuando importa.
  const abiertas = await tx`
    select e.nombre, (e.ventana_inicio + c.ventana_dias) - current_date as faltan
    from entrada_kpi e
    join metric_registry r on r.id = e.registry_id and r.workspace_id = e.workspace_id
    join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
    where r.reto_id = ${retoId} and r.workspace_id = ${workspaceId}
      and ventana_de_medicion_abierta(e.ventana_inicio, c.ventana_dias)
    order by e.nombre`;
  if (abiertas.length > 0) {
    const lista = abiertas
      .map((a) => `«${a.nombre as string}» (${etiquetaVentana(a.faltan as number | null)})`)
      .join(', ');
    return `El outcome review se habilita al cerrar la ventana del último criterio: ${lista}`;
  }
  return 'Solo el lead-boutique abre el outcome review';
}

/** Resultado de un criterio dentro del review (RF-07.8): apunta a un snapshot REAL de la
 * serie de ese criterio o declara por qué no hay dato. Idempotente por criterio. */
const RECHAZO_RESULTADO =
  'El review ya está completado, el snapshot no es de este criterio o no puedes redactarlo';

export async function registrarResultado(
  actorId: string,
  entrada: ResultadoCriterioEntrada,
): Promise<void> {
  await conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    // MISMO candado que completarOutcomeReview, y por la razón de siempre: una política es
    // un predicado sobre un snapshot, no un candado. Este upsert y la completación tocan
    // FILAS DISTINTAS (resultado_criterio / outcome_review), así que ninguna bloquea a la
    // otra: bajo READ COMMITTED este upsert puede evaluar su «solo borrador» contra un
    // snapshot anterior a la completación y commitear DESPUÉS. El post mortem quedaría
    // cerrado, inmutable y firmado sobre una lectura —o un snapshot final— que su propio
    // trigger de cierre nunca vio: el caso peor es cambiar un resultado a «sin dato» justo
    // cuando el guard acaba de comprobar que no hay ninguno para admitir un «logrado».
    // El candado es del RETO (el review es 1:1 con él y lo que se cierra es el reto), y va
    // ANTES de la sentencia decisora en los dos lados: quien llegue segundo arranca su
    // snapshot con el resultado del primero ya confirmado y se rechaza limpiamente.
    // reto_id es inmutable, así que leerlo antes de tomar el candado no abre carrera.
    const [dueno] = await tx`select reto_id from outcome_review
      where id = ${entrada.reviewId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) throw new ErrorMedicion('El outcome review no existe en este workspace');
    await bloquearReto(tx, dueno.reto_id as string);
    // El upsert lo hace explícito el ON CONFLICT: escribir dos veces el resultado de un
    // criterio es corregir el borrador, no duplicarlo.
    let filas;
    try {
      filas = await tx`
        insert into resultado_criterio (workspace_id, review_id, criterio_id, snapshot_final_id,
                                        lectura, sin_datos_motivo)
        values (${entrada.workspaceId}, ${entrada.reviewId}, ${entrada.criterioId},
                ${entrada.snapshotFinalId}, ${entrada.lectura}, ${entrada.sinDatosMotivo})
        on conflict (review_id, criterio_id) do update
          set snapshot_final_id = excluded.snapshot_final_id,
              lectura = excluded.lectura,
              sin_datos_motivo = excluded.sin_datos_motivo
        returning id`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23503') throw new ErrorMedicion('El review, el criterio o el snapshot no existen aquí');
      if (code === '23514') {
        throw new ErrorMedicion('Sin snapshot final hay que escribir por qué no hay dato');
      }
      // El snapshot final de OTRO criterio, el review ya completado o el rol equivocado:
      // los tres los rechaza la política con el mismo código.
      if (esRechazoDePolitica(e)) throw new ErrorMedicion(RECHAZO_RESULTADO);
      comoErrorDeDominio(e);
    }
    if (filas.length === 0) throw new ErrorMedicion(RECHAZO_RESULTADO);
  });
}

/**
 * Completar el outcome review (RF-07.8/07.10): la MISMA sentencia registra el veredicto
 * del catálogo cerrado y la firma; el guard de la base exige resultado por criterio,
 * ventanas cerradas y coherencia del veredicto con los datos, y aplica los efectos
 * inseparables — reto cerrado CON veredicto y proyecto cerrado inmutable (SYS-08).
 */
export async function completarOutcomeReview(
  actorId: string,
  entrada: CompletarReview,
): Promise<{ veredicto: string }> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [dueno] = await tx`select reto_id, estado from outcome_review
      where id = ${entrada.reviewId} and workspace_id = ${entrada.workspaceId}`;
    if (!dueno) throw new ErrorMedicion('El outcome review no existe en este workspace');
    if (dueno.estado === 'completado') throw new ErrorMedicion('El outcome review ya está completado');
    // Mismo candado que los snapshots: cerrar el reto y aceptar datos no se entrecruzan.
    await bloquearReto(tx, dueno.reto_id as string);
    let completado;
    try {
      completado = await tx`
        update outcome_review
        set estado = 'completado', veredicto = ${entrada.veredicto},
            contribucion = ${entrada.contribucion},
            factores_externos = ${entrada.factoresExternos},
            hipotesis_abiertas = ${entrada.hipotesisAbiertas},
            aprendizajes = ${entrada.aprendizajes},
            diseno_experimental_suficiente = ${entrada.disenoExperimentalSuficiente},
            diseno_experimental_justificacion = ${entrada.disenoExperimentalJustificacion},
            completado_por = ${actorId}, completado_en = now()
        where id = ${entrada.reviewId} and workspace_id = ${entrada.workspaceId}
          and estado = 'borrador'
        returning veredicto`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23514') {
        throw new ErrorMedicion('Declarar diseño experimental suficiente exige justificarlo (SYS-24)');
      }
      if (esRechazoDePolitica(e)) {
        throw new ErrorMedicion('Solo el lead-boutique completa el outcome review');
      }
      comoErrorDeDominio(e);
    }
    if (completado!.length === 0) {
      throw new ErrorMedicion('El outcome review ya está completado o no puedes completarlo');
    }
    return { veredicto: completado![0]!.veredicto as string };
  });
}

/**
 * Seguimiento de impacto del proyecto (RF-07.5/07.6): registry con sus entradas, serie de
 * snapshots contra la línea base y el objetivo, días restantes de ventana y estado
 * «esperado / recibido / vencido» derivado de la frecuencia comprometida. Una sola
 * sentencia: un snapshot, orden estable, sin lecturas incoherentes entre bloques.
 *
 * ALCANCE de RF-07.4, dicho aquí y no solo en la descripción del PR, porque es aquí donde
 * alguien va a creer que está cubierto: RF-07.4 pide DOS cosas —«recordatorios al
 * propietario del dato según la frecuencia comprometida» y «el estado esperado / recibido
 * / vencido visible en el seguimiento»— y este slice entrega la SEGUNDA. El estado que se
 * calcula abajo es una señal de LECTURA: aparece cuando alguien abre el proyecto y no le
 * llega a nadie. No hay envío, y no por descuido: este repositorio no tiene todavía ni
 * canal de correo ni planificador (el diseño técnico los sitúa en SMTP + scheduler in-app
 * con hook de cron, §Cadencias), así que el recordatorio EFECTIVO depende de una
 * infraestructura que llega con otro slice.
 *
 * La condición que convierte esto en un defecto real, para que se reconozca cuando pase:
 * el día que exista ese canal, un `vencido` que se quede solo en la pantalla ya no es una
 * limitación declarada sino una promesa incumplida — la spec nombra los recordatorios como
 * LA mitigación del riesgo «el cliente no aporta snapshots» (§Riesgos), y sin envío la
 * mitigación depende de que alguien entre a mirar. Hasta entonces, lo honesto es que el
 * código lo diga: la señal existe, el aviso no.
 */
export async function seguimientoDeImpacto(
  actorId: string,
  workspaceId: string,
  proyectoId: string,
): Promise<SeguimientoDeImpacto | null> {
  return conUsuario(actorId, async (tx) => {
    await exigirCuentaActiva(tx, actorId);
    const [fila] = await tx`
      select r.id as reto_id, r.codigo as reto_codigo, r.estado as reto_estado,
        r.veredicto as reto_veredicto, p.estado as proyecto_estado,
        -- El perdón histórico también se PROYECTA: sin él la pantalla no puede distinguir
        -- un reto que mide con su contrato de uno que mide desde antes de que el contrato
        -- existiera, y esa distinción es la que decide si queda reparación por ofrecer.
        r.medicion_sin_registry,
        -- El día de calendario de la BASE, que es quien juzga. snapshot_insert acota la
        -- fecha con current_date y contextoDeEntrada diagnostica con el mismo, así que
        -- el máximo del selector tiene que salir de aquí y no de un new Date() del
        -- navegador: no hay huso por petición, de modo que un hoy calculado en el cliente
        -- discrepa del que decide — al este de UTC ofrecía un día que el servicio rechaza
        -- por futuro, y en el borde inverso escondía uno que la base sí acepta. El espejo
        -- LEE la regla; no la reproduce.
        current_date::text as hoy,
        -- El G7 del proyecto que se mira: lo necesita el espejo del botón de RETOMAR, cuya
        -- precondición en el guard es exactamente esa (a medición se entra por G7). Sin él
        -- el botón se ofrecería para que la base lo negara.
        exists (select 1 from gate_instancia g7
          where g7.proyecto_id = p.id and g7.workspace_id = p.workspace_id
            and g7.numero = 7 and g7.estado = 'aprobado') as proyecto_g7,
        -- Y su G6, que es lo que decide el destino de la reanudación cuando el reto todavía
        -- no mide: pausado antes del plan vuelve a 'activo'; pausado con el plan aprobado,
        -- a 'en-implementacion'. La pantalla lo ANUNCIA en vez de ofrecer un menú de
        -- destinos, porque el destino es una regla y no una decisión de quien pulsa.
        exists (select 1 from gate_instancia g6
          where g6.proyecto_id = p.id and g6.workspace_id = p.workspace_id
            and g6.numero = 6 and g6.estado = 'aprobado') as proyecto_g6,
        case when mr.id is null then null else jsonb_build_object(
          'id', mr.id, 'estado', mr.estado, 'firmadoEn', mr.firmado_en::text) end as registry,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', e.id, 'criterioId', e.criterio_id, 'criterioKpi', c.kpi,
            'criterioObjetivo', c.objetivo, 'criterioVentanaDias', c.ventana_dias,
            'nombre', e.nombre, 'definicion', e.definicion, 'fuente', e.fuente,
            'dimensiones', e.dimensiones,
            'propietarioMiembroId', e.propietario_miembro_id, 'propietarioNombre', m.nombre,
            'soyPropietario', coalesce(m.usuario_id = ${actorId}::uuid, false),
            'frecuencia', e.frecuencia, 'dashboardUrl', e.dashboard_url,
            'lineaBaseValor', e.linea_base_valor::text,
            'lineaBaseFecha', e.linea_base_fecha::text,
            'ventanaInicio', e.ventana_inicio::text,
            'ventanaFin', (e.ventana_inicio + c.ventana_dias)::text,
            'fechaPostMortem', e.fecha_post_mortem::text,
            'diasRestantes', (e.ventana_inicio + c.ventana_dias) - current_date,
            'ultimaFecha', ult.fecha::text,
            -- RF-07.4 sobre el DATO: el estado sale de la cadencia comprometida y de la
            -- última recepción, no de una marca que alguien pone a mano. La cadencia corre
            -- contra hoy solo MIENTRAS la ventana está abierta: una vez cerrada nadie puede
            -- aportar nada (la política del snapshot rechaza cualquier fecha posterior) y
            -- el review completado es inmutable, así que seguir avanzando con current_date
            -- convertiría en «vencido» —por el mero paso del tiempo, y para siempre— todo
            -- KPI recurrente que cumplió. Cerrada la ventana el estado es TERMINAL y se
            -- juzga contra su último día.
            'estadoSnapshot', case
              -- Sin ventana no hay cadencia que juzgar: la firma es quien la exige.
              when e.ventana_inicio is null or c.ventana_dias is null then 'esperado'
              -- «Ya no está abierta», con el MISMO predicado que autoriza el review: el
              -- último día de la ventana la medición sigue viva y su estado también.
              when not ventana_de_medicion_abierta(e.ventana_inicio, c.ventana_dias) then case
                -- La ventana entera pasó sin un solo dato: vencido, y ya sin remedio.
                when ult.fecha is null then 'vencido'
                -- ¿Llegó todo lo prometido DENTRO de la ventana? La pregunta es una sola y
                -- la responde cadencia_incumplida contra el calendario derivado del
                -- ANCLA: cada entrega prometida tiene que tener su dato en su periodo.
                --
                -- Antes eran dos comprobaciones encadenadas —«¿dejó de aportar antes del
                -- final?», con ult.fecha + paso, y «¿hubo algún hueco?», con
                -- previa + paso— y las dos encadenaban desde lo que pasó en vez de
                -- derivar del compromiso. Encadenar deja que cada entrega real redefina el
                -- calendario, y en fin de mes la deriva es de un solo sentido: 31-ene →
                -- 28-feb → 31-mar, entregado puntualmente, se leía como retrasado porque
                -- 28-feb + 1 mes es 28-mar. Con la ventana cerrada eso es vencido PARA
                -- SIEMPRE sobre un compromiso que SÍ se cumplió — y es lo que lee el
                -- outcome review al juzgar si se cumplió.
                --
                -- Las dos preguntas viejas son la misma cuando el calendario no se mueve:
                -- «dejó de aportar» es el hueco de la ÚLTIMA entrega prometida.
                when cadencia_incumplida(e.id, e.workspace_id, e.ventana_inicio,
                       e.frecuencia, (e.ventana_inicio + c.ventana_dias)::date)
                  then 'vencido'
                -- Llegó lo comprometido hasta el final: la medición terminó.
                else 'cerrado' end
              -- Ventana ABIERTA: la misma pregunta, juzgada hasta AYER. Hoy todavía no ha
              -- terminado, así que la entrega que vence HOY aún puede llegar — es el mismo
              -- corte inclusivo de la ventana, visto contra el calendario.
              when cadencia_incumplida(e.id, e.workspace_id, e.ventana_inicio,
                     e.frecuencia, current_date - 1) then 'vencido'
              -- Sin cadencia ('unica') no hay vencimientos que generar, así que estas dos
              -- ramas la cubren sin un caso aparte: lo que hay es lo que se dice.
              when ult.fecha is not null then 'recibido'
              else 'esperado' end,
            -- CUÁNTAS hay de verdad, para poder decir que la serie viene recortada. Un tope
            -- que el usuario no ve es el defecto; uno que se anuncia es una decisión.
            'totalSnapshots', (select count(*) from snapshot s4
              where s4.entrada_kpi_id = e.id and s4.workspace_id = e.workspace_id),
            -- La serie: las ÚLTIMAS del tope… más, siempre, las que un resultado del post
            -- mortem ya referencia. Recortar por «los más antiguos» tiene dos filos y el
            -- segundo es el peligroso: la fila de resultado_criterio existe y es correcta
            -- en la base, pero si su snapshot cae fuera del recorte el editor del review no
            -- puede representar lo que hay GUARDADO — la pantalla afirmando algo que no es
            -- cierto, sobre el dato que sostiene el veredicto. El union las trae de vuelta
            -- y es acotado: como mucho una por criterio.
            'snapshots', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', s.id, 'valor', s.valor::text, 'fecha', s.fecha::text,
                'origen', s.origen, 'nota', s.nota) order by s.fecha, s.creado_en)
              from ((select * from snapshot s2
                     where s2.entrada_kpi_id = e.id and s2.workspace_id = e.workspace_id
                     order by s2.fecha desc, s2.creado_en desc
                     limit ${SNAPSHOTS_POR_ENTRADA})
                    union
                    (select s3.* from snapshot s3
                     join resultado_criterio rc on rc.snapshot_final_id = s3.id
                       and rc.workspace_id = s3.workspace_id
                     where s3.entrada_kpi_id = e.id
                       and s3.workspace_id = e.workspace_id)) s), '[]'::jsonb))
            order by e.nombre)
          from entrada_kpi e
          join criterio_exito c on c.id = e.criterio_id and c.workspace_id = e.workspace_id
          left join miembro m on m.id = e.propietario_miembro_id and m.workspace_id = e.workspace_id
          left join lateral (select max(s.fecha) as fecha from snapshot s
            where s.entrada_kpi_id = e.id and s.workspace_id = e.workspace_id) ult on true
          where e.registry_id = mr.id and e.workspace_id = mr.workspace_id), '[]'::jsonb) as entradas,
        coalesce((
          select jsonb_agg(jsonb_build_object('id', c.id, 'kpi', c.kpi) order by c.creado_en, c.id)
          from criterio_exito c
          where c.reto_id = r.id and c.workspace_id = r.workspace_id
            and not exists (select 1 from entrada_kpi e
              where e.criterio_id = c.id and e.workspace_id = c.workspace_id)), '[]'::jsonb)
          as criterios_sin_entrada,
        -- Qué le falta al contrato para poder FIRMARSE, con la fila que hay que arreglar
        -- nombrada en cada reparo. Sale de reparos_de_firma, la MISMA función que usa el
        -- guard de la firma: escribir la lista otra vez aquí sería una segunda redacción
        -- del mismo contrato, y la de la pantalla se quedaría corta a la primera que
        -- alguien tocara el guard. Sin esto el botón de firmar se ofrecía SIEMPRE y el
        -- sponsor descubría por un error del servidor lo que ya se podía saber.
        --
        -- Solo mientras el registry sigue en BORRADOR: firmado no hay nada que reparar, y
        -- las reglas hablan de un contrato que todavía se puede corregir.
        -- Las DOS superficies que pueden negar la firma, en el orden en que importan: la
        -- POSICIÓN en el método primero —si el proyecto no ha llegado a G6 no se firma
        -- todavía, diga lo que diga el contenido— y después el CONTENIDO del contrato. Son
        -- dos funciones y no una a propósito: la primera es de la política y la segunda del
        -- guard, y juntarlas bajo un nombre pondría dos cosas distintas en la misma lista.
        -- Quien mira la pantalla no distingue las superficies —pulsa y falla—, así que el
        -- botón mira las dos; el rol es lo único que no está aquí, porque depende de QUIÉN
        -- mira y una proyección compartida no puede afirmar «tú no puedes».
        case when mr.estado = 'borrador' then
          coalesce((select jsonb_agg(rp.reparo order by rp.orden)
            from reparos_de_posicion_de_firma(mr.id, r.id, r.workspace_id) rp), '[]'::jsonb)
          || coalesce((select jsonb_agg(rf.reparo order by rf.orden)
            from reparos_de_firma(mr.id, r.id, r.workspace_id) rf), '[]'::jsonb)
          else '[]'::jsonb end as reparos_firma,
        -- Qué proyectos del RETO frenan la apertura de la medición, y por qué. La
        -- disponibilidad de esa operación es propiedad del CONJUNTO y no del proyecto que
        -- se está mirando, y el conjunto lo define UNA función que comparten el guard del
        -- par y el diagnóstico del servicio: escribirlo aquí a mano es lo que ya se quedó
        -- corto tres veces. Van con motivo porque decir «falta algo» sin decir qué manda a
        -- buscarlo a mano por los proyectos del reto.
        coalesce((
          select jsonb_agg(jsonb_build_object('codigo', f.codigo, 'motivo', f.motivo)
                           order by f.codigo)
          from proyectos_frenan_medicion(r.id, r.workspace_id) f
          where not f.solo_al_entrar or r.estado <> 'en-medicion'), '[]'::jsonb)
          as proyectos_frenan,
        -- Y quién frena el CIERRE, que es otra pregunta y otra función: la apertura PERMITE
        -- al pausado con G7 y el cierre no, así que el permiso de un extremo crea el bloqueo
        -- del otro. Misma función que aplica el guard del cierre, invocada y no recopiada.
        coalesce((
          select jsonb_agg(jsonb_build_object('codigo', fc.codigo, 'motivo', fc.motivo)
                           order by fc.codigo)
          from proyectos_frenan_cierre(r.id, r.workspace_id) fc), '[]'::jsonb)
          as proyectos_frenan_cierre,
        -- Candidatos a dueño del dato: SOLO el lado cliente (RF-07.1), con el mismo
        -- predicado que la política de la entrada y el guard de la firma. Ofrecer a un
        -- curador aquí sería ofrecer lo que la base rechaza, y ese rechazo llegaría —en el
        -- peor momento posible— como un «no se puede firmar» en G6, delante del cliente.
        coalesce((
          select jsonb_agg(jsonb_build_object('id', m2.id, 'nombre', m2.nombre, 'rol', m2.rol)
            order by m2.nombre)
          from miembro m2
          where m2.workspace_id = r.workspace_id and es_rol_cliente(m2.rol)), '[]'::jsonb)
          as propietarios_posibles,
        case when orv.id is null then null else jsonb_build_object(
          'id', orv.id, 'estado', orv.estado, 'veredicto', orv.veredicto,
          'contribucion', orv.contribucion, 'factoresExternos', orv.factores_externos,
          'hipotesisAbiertas', orv.hipotesis_abiertas, 'aprendizajes', orv.aprendizajes,
          'disenoExperimentalSuficiente', orv.diseno_experimental_suficiente,
          'disenoExperimentalJustificacion', orv.diseno_experimental_justificacion,
          'completadoEn', orv.completado_en::text,
          'resultados', coalesce((
            select jsonb_agg(jsonb_build_object(
              'criterioId', rc.criterio_id, 'criterioKpi', c2.kpi,
              'snapshotFinalId', rc.snapshot_final_id, 'valorFinal', s3.valor::text,
              'fechaFinal', s3.fecha::text, 'lectura', rc.lectura,
              'sinDatosMotivo', rc.sin_datos_motivo) order by c2.kpi)
            from resultado_criterio rc
            join criterio_exito c2 on c2.id = rc.criterio_id and c2.workspace_id = rc.workspace_id
            left join snapshot s3 on s3.id = rc.snapshot_final_id and s3.workspace_id = rc.workspace_id
            where rc.review_id = orv.id and rc.workspace_id = orv.workspace_id), '[]'::jsonb))
          end as review
      from proyecto p
      join reto r on r.id = p.reto_id and r.workspace_id = p.workspace_id
      left join metric_registry mr on mr.reto_id = r.id and mr.workspace_id = r.workspace_id
      left join outcome_review orv on orv.reto_id = r.id and orv.workspace_id = r.workspace_id
      where p.id = ${proyectoId} and p.workspace_id = ${workspaceId}`;
    if (!fila) return null;
    return {
      retoId: fila.reto_id as string,
      retoCodigo: fila.reto_codigo as string,
      hoy: fila.hoy as string,
      retoEstado: fila.reto_estado as string,
      retoVeredicto: fila.reto_veredicto as SeguimientoDeImpacto['retoVeredicto'],
      proyectoEstado: fila.proyecto_estado as string,
      medicionSinRegistry: fila.medicion_sin_registry as boolean,
      proyectoG7Aprobado: fila.proyecto_g7 as boolean,
      proyectoG6Aprobado: fila.proyecto_g6 as boolean,
      registry: fila.registry as SeguimientoDeImpacto['registry'],
      entradas: fila.entradas as SeguimientoDeImpacto['entradas'],
      criteriosSinEntrada: fila.criterios_sin_entrada as SeguimientoDeImpacto['criteriosSinEntrada'],
      reparosFirma: fila.reparos_firma as string[],
      proyectosFrenan: fila.proyectos_frenan as SeguimientoDeImpacto['proyectosFrenan'],
      proyectosFrenanCierre:
        fila.proyectos_frenan_cierre as SeguimientoDeImpacto['proyectosFrenanCierre'],
      propietariosPosibles:
        fila.propietarios_posibles as SeguimientoDeImpacto['propietariosPosibles'],
      review: fila.review as SeguimientoDeImpacto['review'],
    };
  });
}
