/**
 * El día de CALENDARIO de quien mira, para los DEFAULTS de formulario.
 *
 * Una fecha de calendario no es un instante, y `toISOString()` sí lo es: convierte a UTC y
 * después recorta. Al oeste de UTC, por la tarde, eso ya es el día siguiente; al este, cerca
 * de medianoche, esconde el día local en curso. Para proponer «hoy» en un campo que la
 * persona va a revisar y puede cambiar, el día que quiere ver es el SUYO.
 *
 * Lo que NO se hace con esto es acotar lo que la base va a aceptar. Ahí el calendario que
 * manda es el de PostgreSQL —`snapshot_insert` juzga con `current_date` y no hay huso por
 * petición—, así que un «hoy» calculado aquí sería un segundo calendario que discrepa del que
 * decide: la pantalla ofrecería un día que el servicio rechaza por futuro, o escondería uno
 * que sí acepta. Esos límites se PROYECTAN desde el servidor (`seguimiento.hoy`) y el espejo
 * los lee. La regla de siempre: el espejo lee la regla, no la reproduce.
 */
export function hoyCalendario(ahora: Date = new Date()): string {
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const dia = String(ahora.getDate()).padStart(2, '0');
  return `${ahora.getFullYear()}-${mes}-${dia}`;
}
