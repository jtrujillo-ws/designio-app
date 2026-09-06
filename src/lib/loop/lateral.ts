import { etiquetaDePendientes } from '@/lib/aprobaciones/aprobaciones.schemas';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import { ROLES_AUDITORIA } from '@/lib/portal/portal.schemas';
import { ROLES_OBSERVABILIDAD_AI } from '@/lib/ai/ai.schemas';
import { ROLES_DISPOSICION } from '@/lib/disposicion/disposicion.schemas';

/**
 * Cómo se agrupan los destinos del workspace en el lateral de la pantalla Loop (handoff
 * «Loop · impacto visual», turno 4a). Trece destinos bajo una sola etiqueta «Workspace» eran
 * trece filas sin jerarquía que competían con el árbol; ahora se ordenan por QUÉ CLASE de
 * cosa es cada destino, y lo pendiente se promueve arriba:
 *
 * - «Te espera»: exactamente los destinos con contador > 0, y nada más. Si no hay ninguno,
 *   el bloque no existe y esas filas vuelven a su estante.
 * - «Material y razonamiento» y «Diseño y entrega»: consulta diaria, siempre visibles.
 * - «Gobierno del workspace»: lo archivístico, plegado en una sola fila; se abre cuando se
 *   busca, no cada día.
 *
 * Módulo compartido client/server: solo tipos y funciones puras, para que la regla se pueda
 * comprobar sin pintar nada.
 */

/** Las rutas sin parámetros a las que lleva el lateral. */
export type RutaDelWorkspace =
  | '/importacion'
  | '/aprobaciones'
  | '/evidencia'
  | '/insights'
  | '/oportunidades'
  | '/biblioteca'
  | '/journeys'
  | '/design-versions'
  | '/propuestas'
  | '/personas'
  | '/segmentos'
  | '/exportacion'
  | '/disposicion'
  | '/auditoria'
  | '/observabilidad-ai';

export type ContadorDelLateral = {
  n: number;
  /** Importación en `--accent`, aprobaciones en `--warn`: el mismo color en el estante y arriba. */
  color: 'accent' | 'warn';
  /** El número siempre va acompañado de palabras: un «1» aislado no dice de qué. */
  titulo: string;
};

export type DestinoDelLateral = {
  to: RutaDelWorkspace;
  etiqueta: string;
  /** La etiqueta mono de tres letras del riel estrecho. */
  abrev: string;
  /** Solo los dos destinos con estado pendiente lo llevan, y solo cuando es > 0. */
  contador?: ContadorDelLateral;
  /** Recordatorio en mono a la derecha («propone»: la AI propone, el humano aprueba). */
  sufijo?: string;
};

export type EstanteDelLateral = { etiqueta: string; destinos: DestinoDelLateral[] };

export type LateralAgrupado = {
  /** Vacío cuando nada espera: entonces el bloque entero no se pinta. */
  teEspera: DestinoDelLateral[];
  /** Los dos estantes de consulta, en orden vertical. */
  estantes: EstanteDelLateral[];
  /** Lo que el rol ve dentro de «Gobierno del workspace» (3 o 4 destinos). */
  gobierno: DestinoDelLateral[];
};

export const ETIQUETA_TE_ESPERA = 'Te espera';
export const ETIQUETA_MATERIAL = 'Material y razonamiento';
export const ETIQUETA_DISENO = 'Diseño y entrega';
export const ETIQUETA_GOBIERNO = 'Gobierno del workspace';

/** Cómo nombra la nota al pie a cada destino de gobierno, en minúscula y sin apellidos. */
const NOMBRE_CORTO_DE_GOBIERNO: Partial<Record<RutaDelWorkspace, string>> = {
  '/personas': 'personas',
  '/auditoria': 'auditoría',
  '/observabilidad-ai': 'operación AI',
  '/exportacion': 'exportación',
  '/disposicion': 'disposición',
};

/**
 * La nota bajo «Gobierno del workspace» plegado. Se compone de lo que el rol VE, no de una
 * lista fija: a un sponsor no se le promete una auditoría que el grupo no contiene.
 */
export function notaDeGobierno(gobierno: readonly DestinoDelLateral[]): string {
  const nombres = gobierno.map((d) => NOMBRE_CORTO_DE_GOBIERNO[d.to] ?? d.etiqueta.toLowerCase());
  const lista =
    nombres.length <= 1
      ? (nombres[0] ?? '')
      : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
  const conMayuscula = lista.charAt(0).toUpperCase() + lista.slice(1);
  return `${conMayuscula}: se abren cuando se buscan, no cada día.`;
}

export function agruparLateral({
  rol,
  pendientesDelRol,
  importacionPendientes,
}: {
  rol: string;
  /** Lo que el rol de quien mira puede decidir ahora (`resumen.pendientesDelRol.total`). */
  pendientesDelRol: number;
  /** Ítems sin curar de la bandeja (`resumen.importacionPendientes`), para cualquier rol. */
  importacionPendientes: number;
}): LateralAgrupado {
  // La bandeja la curan la boutique (RF-03.4): para los demás no es tarea, así que su
  // contador no existe y la fila no sube a «Te espera». La puerta vive aquí, con el resto
  // de reglas por rol, y no en quien llama.
  const bandejaSinCurar = (ROLES_CURADORES as readonly string[]).includes(rol)
    ? importacionPendientes
    : 0;
  const aprobaciones: DestinoDelLateral = {
    to: '/aprobaciones',
    etiqueta: 'Aprobaciones',
    abrev: 'APR',
    ...(pendientesDelRol > 0
      ? {
          contador: {
            n: pendientesDelRol,
            color: 'warn' as const,
            titulo: `${etiquetaDePendientes(pendientesDelRol)} de tu rol`,
          },
        }
      : {}),
  };
  const importacion: DestinoDelLateral = {
    to: '/importacion',
    etiqueta: 'Bandeja de importación',
    abrev: 'IMP',
    ...(bandejaSinCurar > 0
      ? {
          contador: {
            n: bandejaSinCurar,
            color: 'accent' as const,
            titulo: `${bandejaSinCurar} sin curar`,
          },
        }
      : {}),
  };
  // Arriba, lo que tiene pendientes; lo que no, vuelve a su estante (aprobaciones como
  // primera fila, la bandeja detrás), para que ningún destino desaparezca del lateral.
  const teEspera = [aprobaciones, importacion].filter((d) => d.contador !== undefined);
  const devueltos = [aprobaciones, importacion].filter((d) => d.contador === undefined);

  const estantes: EstanteDelLateral[] = [
    {
      etiqueta: ETIQUETA_MATERIAL,
      destinos: [
        ...devueltos,
        { to: '/evidencia', etiqueta: 'Evidencia y derechos de uso', abrev: 'EVI' },
        { to: '/insights', etiqueta: 'Insights y citas', abrev: 'INS' },
        // El portafolio de HMW (etapa 3) sale de los insights: es razonamiento, no diseño.
        { to: '/oportunidades', etiqueta: 'Oportunidades HMW', abrev: 'HMW' },
        { to: '/segmentos', etiqueta: 'Segmentos', abrev: 'SEG' },
      ],
    },
    {
      etiqueta: ETIQUETA_DISENO,
      destinos: [
        { to: '/journeys', etiqueta: 'Journeys y blueprints', abrev: 'JOU' },
        { to: '/design-versions', etiqueta: 'Versions y releases', abrev: 'DVR' },
        // ADR-0012: la AI propone, el humano aprueba. El sufijo lo recuerda desde el menú.
        { to: '/propuestas', etiqueta: 'Propuestas AI', abrev: 'AI', sufijo: 'propone' },
        { to: '/biblioteca', etiqueta: 'Biblioteca del cliente', abrev: 'BIB' },
      ],
    },
  ];

  // El filtrado por rol es el mismo de siempre: la auditoría es de quienes rinden cuentas
  // (RF-01.6) y no aparece para los demás; la puerta de disposición NO se condiciona al rol
  // —detrás están las constancias que cada quien conserva—, solo cambia el rótulo.
  const gobierno: DestinoDelLateral[] = [
    { to: '/personas', etiqueta: 'Personas y permisos', abrev: 'PER' },
    ...((ROLES_AUDITORIA as readonly string[]).includes(rol)
      ? [{ to: '/auditoria', etiqueta: 'Auditoría', abrev: 'AUD' } as DestinoDelLateral]
      : []),
    /*
     * Y el cuadro de operación de la capa AI (RF-08.9), con la MISMA puerta: §14 pone la
     * observabilidad de costos, latencia, errores y calidad en la fila «Auditoría y
     * operación», junto a la auditoría, y `ROLES_OBSERVABILIDAD_AI` se deriva de la de
     * arriba justamente para que no puedan separarse por descuido.
     *
     * Sin esta entrada la pantalla existía y no se podía abrir salvo tecleando la URL. Lo
     * dijo una revisión, y tenía razón dos veces: yo había buscado enlaces en el JSX y
     * concluido que en este producto no hay navegación. La hay, y es este fichero — la
     * lista vive como DATOS, no como `<Link>`, así que mi grep miraba donde no estaba.
     */
    ...((ROLES_OBSERVABILIDAD_AI as readonly string[]).includes(rol)
      ? [
          {
            to: '/observabilidad-ai',
            etiqueta: 'Operación de la capa AI',
            abrev: 'OPS',
          } as DestinoDelLateral,
        ]
      : []),
    { to: '/exportacion', etiqueta: 'Exportación del workspace', abrev: 'EXP' },
    {
      to: '/disposicion',
      etiqueta: (ROLES_DISPOSICION as readonly string[]).includes(rol)
        ? 'Disposición del workspace'
        : 'Constancias que conservas',
      abrev: 'DIS',
    },
  ];

  return { teEspera, estantes, gobierno };
}

/** Clave del navegador donde se recuerda si «Gobierno del workspace» está desplegado. */
export function claveDeGobierno(usuarioId: string, workspaceId: string): string {
  return `designio.loop.gobierno.${usuarioId}.${workspaceId}`;
}
