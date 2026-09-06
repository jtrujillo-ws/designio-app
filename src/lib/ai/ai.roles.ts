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
 * Y una asimetría que hay que decir en vez de dar por hecha: la nota de `ROLES_AUDITORIA`
 * presume que «la autoridad es la política RLS», y ahí es cierto —`evento_dominio` devuelve
 * cero filas a los demás roles—. Aquí NO: la política de `llamada_ai` pide membresía a secas,
 * porque el tope diario y el estado de la capacidad la leen para todo el que abre el panel.
 * Así que esta puerta es de PANTALLA y el suelo es más ancho. Cerrar el suelo por rol
 * repetiría la avería de la ronda 42 de #48 —cerrar una fila por rol y romper una lectura ya
 * declarada—, y queda como pregunta de producto: en BYOAI (RF-09.9) `origen_key = 'workspace'`
 * dice que paga el cliente, y quien paga probablemente deba ver la factura.
 */
export const ROLES_OBSERVABILIDAD_AI = ROLES_AUDITORIA;
