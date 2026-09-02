import { z } from 'zod';

/**
 * Exportación del workspace (RF-01.8, SYS-04) y del paquete entregable (RF-03.10).
 * Módulo compartido servidor/UI: sin imports de servidor.
 *
 * DOS ámbitos, porque la spec pide dos cosas incompatibles entre sí y ambas son
 * correctas en su contexto:
 *
 *  · `archivo` — el archivo del PROPIETARIO. SYS-04 exige que incluya *todos* sus
 *    objetos, derivados y auditoría: es su dato y su derecho. Aquí los derechos de uso
 *    NO filtran nada; viajan como un bloque más, para que el destino sepa qué puede
 *    hacer con cada evidencia.
 *  · `entregable` — el paquete que sale hacia un uso con el cliente. Aquí SÍ mandan los
 *    derechos (RF-03.10): la evidencia sin derechos vigentes para el ámbito «cliente»
 *    queda fuera, y aparece listada en `bloqueadas` con la dimensión que falta. Nunca se
 *    oculta en silencio (SYS-14 pide bloquear *explicando*).
 *
 * El filtro del entregable no es un WHERE de la aplicación: la evidencia se lee de la
 * vista `evidencia_entregable`, que aplica el predicado en la BASE.
 */

export const AMBITOS_EXPORT = ['archivo', 'entregable'] as const;
export type AmbitoExport = (typeof AMBITOS_EXPORT)[number];

export const ETIQUETA_AMBITO_EXPORT: Record<AmbitoExport, string> = {
  archivo: 'Archivo completo del workspace (todos los objetos y la auditoría)',
  entregable: 'Paquete entregable (solo evidencia con derechos vigentes para el cliente)',
};

export const ExportarSchema = z.object({
  workspaceId: z.string().uuid(),
  ambito: z.enum(AMBITOS_EXPORT),
});
export type Exportar = z.infer<typeof ExportarSchema>;

/**
 * Catálogo de objetos del workspace: la lista contra la que se verifica que la
 * exportación es COMPLETA (SYS-04 «checklist de export contra el catálogo de objetos»).
 * Un test estructural compara este catálogo con las tablas que realmente tienen
 * `workspace_id` en la base: si alguien añade una tabla de dominio y no la exporta, el
 * test lo detiene — que es exactamente cómo un invariante deja de ser un deseo.
 *
 * `workspace` no aparece aquí porque se filtra por `id`, no por `workspace_id`; se
 * exporta aparte, siempre.
 */
export const CATALOGO_EXPORT = [
  { tabla: 'miembro', orden: 'creado_en, id' },
  { tabla: 'segmento', orden: 'creado_en, id' },
  { tabla: 'servicio', orden: 'creado_en, id' },
  { tabla: 'reto', orden: 'creado_en, id' },
  { tabla: 'reto_servicio_afectado', orden: 'reto_id, servicio_id' },
  { tabla: 'proyecto', orden: 'creado_en, id' },
  { tabla: 'criterio_exito', orden: 'creado_en, id' },
  { tabla: 'etapa_instancia', orden: 'proyecto_id, numero' },
  { tabla: 'gate_instancia', orden: 'proyecto_id, numero' },
  { tabla: 'checklist_item', orden: 'gate_id, orden' },
  { tabla: 'fuente', orden: 'creado_en, id' },
  { tabla: 'evidencia', orden: 'creado_en, id' },
  { tabla: 'evidencia_segmento', orden: 'evidencia_id, segmento_id' },
  { tabla: 'derecho_uso', orden: 'creado_en, id' },
  { tabla: 'item_importacion', orden: 'creado_en, id' },
  // Los bytes NO salen por esta vía: archivo_importado se exporta aparte, sin la
  // columna `contenido` y con el binario en base64 sujeto al presupuesto de adjuntos.
  { tabla: 'archivo_importado', orden: 'creado_en, id' },
  { tabla: 'evento_dominio', orden: 'creado_en, id' },
] as const;

/** Tablas del catálogo cuyo contenido depende de una evidencia concreta: en el ámbito
 * `entregable` solo salen las filas de la evidencia con derechos vigentes. */
export const TABLAS_ENTREGABLE = [
  'fuente',
  'evidencia',
  'evidencia_segmento',
  'derecho_uso',
  'archivo_importado',
] as const;

/** 25 MiB de binarios por exportación: el paquete se arma en memoria y viaja como una
 * sola respuesta JSON. Pasado el tope, el archivo sale en el manifiesto con su sha256 y
 * su motivo de omisión (nunca desaparece del inventario) y se descarga por su ruta
 * normal. Es el límite explícito del MVP mientras el almacenamiento sea la base. */
export const PRESUPUESTO_ADJUNTOS_BYTES = 25 * 1024 * 1024;

export type ArchivoExportado = {
  id: string;
  itemId: string;
  nombre: string;
  tipoMime: string;
  bytes: number;
  sha256: string;
  /** base64 del original, o null si se omitió por presupuesto. */
  contenidoBase64: string | null;
  omitido: string | null;
};

export type EvidenciaBloqueada = {
  evidenciaId: string;
  titulo: string;
  motivo: string;
};

export type Manifiesto = {
  formato: 'whitespace-export/1';
  ambito: AmbitoExport;
  workspaceId: string;
  workspaceNombre: string;
  generadoEn: string;
  generadoPorRol: string;
  /** Filas exportadas por tabla del catálogo: es el recibo verificable de SYS-04. */
  conteos: Record<string, number>;
  adjuntos: {
    total: number;
    incluidos: number;
    omitidos: number;
    bytesIncluidos: number;
    presupuestoBytes: number;
  };
  evidenciaBloqueada: number;
};

/** Valor JSON puro: el paquete de exportación viaja por la frontera servidor→cliente y
 * el contrato de serialización exige tipos que sepan cruzarla (nada de Date ni Buffer:
 * las fechas salen ya como texto ISO y los binarios como base64). */
export type ValorJson =
  | string
  | number
  | boolean
  | null
  | ValorJson[]
  | { [clave: string]: ValorJson };
export type FilaExportada = Record<string, ValorJson>;

export type Exportacion = {
  manifiesto: Manifiesto;
  workspace: FilaExportada;
  datos: Record<string, FilaExportada[]>;
  archivos: ArchivoExportado[];
  bloqueadas: EvidenciaBloqueada[];
};

/** Nombre del archivo que se descarga. Solo caracteres seguros: el nombre del workspace
 * es dato de cliente y termina en un `download` del navegador. */
export function nombreDeArchivoExport(nombreWorkspace: string, ambito: AmbitoExport): string {
  const base = nombreWorkspace
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  const dia = new Date().toISOString().slice(0, 10);
  return `whitespace-${base || 'workspace'}-${ambito}-${dia}.json`;
}
