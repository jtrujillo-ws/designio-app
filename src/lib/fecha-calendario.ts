/**
 * El día de CALENDARIO de quien mira, en UN solo sitio.
 *
 * Una fecha de calendario no es un instante, y `toISOString()` sí lo es: convierte a UTC y
 * después recorta. Al oeste de UTC, por la tarde, eso ya es el día siguiente —el selector
 * dejaba elegir MAÑANA, que `snapshot_insert` rechaza por `fecha <= current_date`—; al este,
 * cerca de medianoche, esconde el día local en curso y el dato de la jornada se queda sin
 * poder cargarse. Los snapshots, la línea base y las ventanas de este producto son días
 * comparados como texto, sin husos de por medio, y por eso sus columnas son `date`.
 *
 * Vive aquí y no dentro de una pantalla porque ya estaba escrito dos veces —el formulario de
 * importación lo hacía bien y el de snapshots no—, y dos redacciones de «qué día es hoy» son
 * dos verdades: basta que una use el huso equivocado para que el sistema se contradiga
 * consigo mismo. Mismo argumento que `ventana_de_medicion_abierta` y `paso_de_cadencia`.
 */
export function hoyCalendario(ahora: Date = new Date()): string {
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const dia = String(ahora.getDate()).padStart(2, '0');
  return `${ahora.getFullYear()}-${mes}-${dia}`;
}
