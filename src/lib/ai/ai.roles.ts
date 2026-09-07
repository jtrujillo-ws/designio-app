import { ROLES_AUDITORIA } from '@/lib/portal/portal.schemas';

/*
 * LAS PUERTAS DE ROL DE LA CAPA AI, en un módulo SIN esquemas.
 *
 * Existe por una propiedad de `ai.schemas.ts` que ese fichero ya declara en su cabecera: Rollup
 * no puede podar una construcción de Zod de nivel superior —no sabe demostrar que no tiene
 * efectos—, así que importar UNA cosa de allí arrastra el contrato entero. Una lista de tres
 * roles no vale eso, y menos desde el lateral del Loop, que se pinta en cada visita a `/app`.
 *
 * Aquí no hay nada más que constantes derivadas. Un censo comprueba que la pantalla del Loop no
 * alcanza `ai.schemas.ts` por ningún camino: sin él, el próximo que necesite una constante de la
 * capa AI en una pantalla del método volvería a tender la arista sin enterarse.
 */
/**
 * Quién puede leer el libro de costos AI del workspace, DERIVADO y no copiado.
 *
 * §14 pone «observabilidad de costos, latencia, errores y calidad» en la misma fila que la
 * auditoría —«Auditoría y operación»—, así que quien puede leer el registro operativo del
 * workspace puede leer esto. Se deriva de `ROLES_AUDITORIA` en vez de escribir los tres roles
 * otra vez: si algún día tienen que divergir, la divergencia será una edición deliberada en un
 * sitio y no dos listas que se separan solas.
 *
 * Y una asimetría que hay que decir en vez de dar por hecha, ya CORREGIDA una vez: la nota de
 * `ROLES_AUDITORIA` presume que «la autoridad es la política RLS», y ahí es cierto
 * —`evento_dominio` devuelve cero filas a los demás roles—. Aquí NO: la política de
 * `llamada_ai` pide membresía a secas, porque el tope diario y el estado de la capacidad la
 * leen para todo el que abre el panel de propuestas.
 *
 * De eso yo concluí que «esta puerta es de PANTALLA y el suelo es más ancho», y me salté una
 * capa entera. Que la RLS no deba cerrarse —cerrar una fila por rol y romper una lectura ya
 * declarada es la avería de la ronda 42 de #48— no dice nada sobre la CAPA 2: la proyección de
 * `observabilidadAI` sí se cierra por rol, como la auditoría, y hasta que se hizo cualquier
 * miembro podía pedirle a mano el cuadro con la factura de la boutique. La asimetría real es
 * entre el SUELO (ancho, y así se queda) y la PROYECCIÓN (cerrada), no entre la base y la
 * pantalla.
 *
 * Lo que sigue siendo pregunta de producto: en BYOAI (RF-09.9) `origen_key = 'workspace'` dice
 * que paga el cliente, y quien paga probablemente deba ver la factura.
 */
export const ROLES_OBSERVABILIDAD_AI = ROLES_AUDITORIA;

/**
 * Quién puede LEER el informe de grounding (RF-08.7), derivado de la misma raíz.
 *
 * El informe responde a la pregunta de la auditoría con otras cifras —«¿qué tan de fiar es lo
 * que esta capa produjo?»— y su respuesta interesa al cliente que administra tanto como a la
 * boutique: son recuentos sobre la calidad del trabajo que se le entrega, no la factura ni los
 * nombres de los modelos. Se deriva, y no se copia, por la razón de arriba: dos listas iguales
 * escritas a mano se separan el día que una cambie.
 *
 * Vive aquí y no en `ai.schemas.ts` por el motivo de la cabecera, y esa es la única razón: el
 * lateral la lee para decidir si pinta la fila, y `lateral.ts` no puede alcanzar el contrato.
 * Quién puede CORRERLA es otra puerta —escribe un hecho fechado— y se queda con el contrato,
 * porque solo la usa el servidor.
 *
 * La misma advertencia que arriba, y por escrito porque ya me costó una vez: que la RLS deje
 * leer `corrida_eval` y `medicion_eval` a todo miembro —y así se queda— no convierte esto en
 * «puerta de pantalla». La capa 2 cierra la proyección por rol igual que la auditoría.
 */
export const ROLES_INFORME_GROUNDING = ROLES_AUDITORIA;
