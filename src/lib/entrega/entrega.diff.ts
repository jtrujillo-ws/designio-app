import {
  ESTADOS_CONOCIDOS,
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

/** Emparejar por nodo del grafo cuando los dos lados lo tienen (identidad real), y por
 * título normalizado si no. El título es un apaño honesto: sin nodo no hay identidad, y
 * comparar cadenas es exactamente lo que el catálogo del journey vino a evitar. */
function clave(titulo: string, nodoId: string | null): string {
  return nodoId ? `nodo:${nodoId}` : `titulo:${normalizar(titulo)}`;
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

export function calcularDiff(
  elementos: ElementoDeCambio[],
  vigente: EstadoEfectivoVigente,
): Diff {
  // Lo «no implementado» del estado vigente no forma parte de él: constatarlo así fue
  // decir que no llegó a existir, así que no puede ser el precedente de nada.
  const previos = (vigente?.elementos ?? []).filter((e) => e.resultado !== 'no-implementado');
  const porClave = new Map<string, ElementoVigente>();
  for (const previo of previos) porClave.set(clave(previo.titulo, previo.nodoId), previo);

  const tocados = new Set<string>();
  const filas = elementos.map((elemento) => {
    const k = clave(elemento.titulo, elemento.nodoId);
    const precedente = porClave.get(k) ?? null;
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
    seMantiene: previos.filter((p) => !tocados.has(clave(p.titulo, p.nodoId))),
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
