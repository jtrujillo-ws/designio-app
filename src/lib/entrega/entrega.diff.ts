import {
  ESTADOS_CONOCIDOS,
  type ConstatacionDelServicio,
  type ElementoDeCambio,
  type ElementoVigente,
  type EstadoEfectivoVigente,
  type FilaConciliacion,
  type Operacion,
} from './entrega.schemas';

/**
 * El diff de primera clase (RF-06.2), COMO FUNCIÓN PURA. No hay tabla de diff: se
 * calcula contra el effective state vigente del servicio cada vez que se mira, porque
 * es una respuesta que caduca en cuanto cambia cualquiera de sus dos lados (la design
 * version se edita, o llega una constatación nueva).
 *
 * Lo interesante no es repetir lo que el autor declaró, sino CONTRASTARLO: un elemento
 * declarado como alta que el estado efectivo vigente ya tiene constatado es en realidad
 * una modificación, y eso es una granularidad mal puesta que el tablero de conciliación
 * haría visible tarde (riesgo nombrado en la spec). El veredicto sale del contraste; la
 * señal, de la discrepancia.
 *
 * Módulo compartido (sin imports de servidor): el servidor lo usa para el tablero y la
 * pantalla para explicarlo, sobre la MISMA proyección leída en una sentencia.
 */

/**
 * La IDENTIDAD LÓGICA de un elemento de cambio, y el único sitio donde está definida:
 * los dos lados del diff (lo que esta design version declara y lo que el estado efectivo
 * vigente dice) tienen que emparejarse con el mismo criterio o el contraste compara
 * cosas distintas.
 *
 * Por orden: el catálogo del servicio (SPEC-05) es identidad de verdad y sobrevive a un
 * journey nuevo y a un renombre; el nodo aguanta para los tipos sin catálogo mientras el
 * grafo de trabajo sea el mismo; el título normalizado es el apaño honesto de los
 * elementos sin nodo — comparar cadenas es exactamente lo que el catálogo vino a evitar,
 * y por eso el elemento sin nodo empareja peor.
 */
function clave(e: { titulo: string; nodoId: string | null; catalogoId: string | null }): string {
  if (e.catalogoId) return `catalogo:${e.catalogoId}`;
  if (e.nodoId) return `nodo:${e.nodoId}`;
  return `titulo:${normalizar(e.titulo)}`;
}

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export type VeredictoDiff = 'agrega' | 'modifica' | 'retira';

export type FilaDiff = {
  elementoId: string;
  titulo: string;
  operacionDeclarada: Operacion;
  /** Lo que el contraste con el estado efectivo vigente dice de verdad. */
  veredicto: VeredictoDiff;
  /** Si el elemento ya existe en el estado efectivo vigente, cómo quedó allí. */
  precedente: ElementoVigente | null;
  /** Discrepancia entre lo declarado y lo vigente. Nunca bloquea: la señala (I2). */
  senal: string | null;
};

export type Diff = {
  /** Contra qué se calculó. Null cuando el servicio no tiene estado efectivo todavía:
   * entonces TODO es alta, y decirlo importa más que ocultarlo. */
  contra: { codigo: string; constatadoEn: string; designVersionCodigo: string } | null;
  filas: FilaDiff[];
  /** Lo que el estado efectivo vigente tiene y esta design version no toca. Un diff que
   * solo enumera cambios no dice qué se mantiene, y «qué queda igual» es media respuesta. */
  seMantiene: ElementoVigente[];
  totales: { agrega: number; modifica: number; retira: number; senales: number };
};

/**
 * El estado efectivo vigente NO es la lista de constataciones del servicio: es su
 * PLIEGUE por identidad lógica, y esa diferencia es el bug que esto arregla. Cuando
 * varias design versions tocan el mismo elemento lógico, cada una crea su propio
 * `elemento_cambio` con id nuevo, así que la historia trae una fila por VERSIÓN del
 * elemento, no una por elemento. Quedarse con todas —o con una cualquiera— deja el diff
 * comparando contra un estado que nunca existió.
 *
 * Se pliega en orden cronológico aplicando la operación que cada constatación resolvió:
 *
 *  - `no-implementado` es un NO-OP: lo declarado no llegó a pasar, así que el estado se
 *    queda como estaba. Si un ciclo agregó algo y el siguiente intentó modificarlo sin
 *    conseguirlo, lo vigente sigue siendo lo primero — no «nada».
 *  - `retira` saca del estado SOLO cuando se constató como se aprobó. Un retiro desviado
 *    deja el elemento a la vista con su desviación: el estado vigente no puede afirmar
 *    una ausencia que nadie constató, y esconderlo haría que la design version siguiente
 *    leyera «no hay nada que modificar» sobre algo que sigue funcionando.
 *  - todo lo demás (agrega/modifica constatados) deja el elemento presente, descrito por
 *    la constatación MÁS RECIENTE, que es la que dice cómo quedó de verdad.
 */
export function plegarEstadoVigente(
  historia: ConstatacionDelServicio[],
): Map<string, ElementoVigente> {
  const estado = new Map<string, ElementoVigente>();
  for (const c of historia) {
    if (c.resultado === 'no-implementado') continue;
    const k = clave(c);
    if (c.operacion === 'retira' && c.resultado === 'como-aprobado') estado.delete(k);
    else estado.set(k, c);
  }
  return estado;
}

export function calcularDiff(
  elementos: ElementoDeCambio[],
  vigente: EstadoEfectivoVigente,
): Diff {
  const estadoVigente = plegarEstadoVigente(vigente?.constataciones ?? []);

  const tocados = new Set<string>();
  const filas = elementos.map((elemento) => {
    const k = clave(elemento);
    const precedente = estadoVigente.get(k) ?? null;
    if (precedente) tocados.add(k);

    const veredicto: VeredictoDiff =
      elemento.operacion === 'retira' ? 'retira' : precedente ? 'modifica' : 'agrega';

    let senal: string | null = null;
    if (elemento.operacion === 'agrega' && precedente) {
      senal = `El estado efectivo vigente ya lo tiene constatado (${precedente.titulo}): esto es una modificación, no un alta`;
    } else if (elemento.operacion === 'modifica' && !precedente) {
      senal = 'No hay nada vigente que modificar: contra el estado efectivo esto es un alta';
    } else if (elemento.operacion === 'retira' && !precedente) {
      senal = 'El estado efectivo vigente no tiene este elemento: no hay qué retirar';
    }

    return {
      elementoId: elemento.id,
      titulo: elemento.titulo,
      operacionDeclarada: elemento.operacion,
      veredicto,
      precedente,
      senal,
    };
  });

  return {
    contra: vigente
      ? {
          codigo: vigente.codigo,
          constatadoEn: vigente.constatadoEn,
          designVersionCodigo: vigente.designVersionCodigo,
        }
      : null,
    filas,
    // Uno por identidad lógica, no por fila histórica: antes, un elemento que tres
    // ciclos habían tocado aparecía tres veces en «se mantiene».
    seMantiene: [...estadoVigente]
      .filter(([k]) => !tocados.has(k))
      .map(([, elemento]) => elemento),
    totales: {
      agrega: filas.filter((f) => f.veredicto === 'agrega').length,
      modifica: filas.filter((f) => f.veredicto === 'modifica').length,
      retira: filas.filter((f) => f.veredicto === 'retira').length,
      senales: filas.filter((f) => f.senal !== null).length,
    },
  };
}

/** RF-06.7: G7 no pasa mientras alguna fila esté en estado desconocido. Es la misma
 * regla que impone `gate_aprobar_suficiencia_guard`; aquí sirve para explicarla ANTES
 * de intentar aprobar, no para sustituirla (la autoridad es la base). */
export function elementosEnEstadoDesconocido(filas: FilaConciliacion[]): FilaConciliacion[] {
  return filas.filter((f) => !ESTADOS_CONOCIDOS.includes(f.estado));
}

export function conciliacionCompleta(filas: FilaConciliacion[]): boolean {
  return filas.length > 0 && elementosEnEstadoDesconocido(filas).length === 0;
}
