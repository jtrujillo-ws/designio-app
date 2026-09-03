-- El puesto del intento dentro de su generación (RF-09.14, y la señal de salud del panel).
--
-- Una generación degradada escribe DOS filas —primario y respaldo— en la misma transacción,
-- así que su `creado_en` es idéntico: `now()` es la hora de INICIO de la transacción, no la
-- de cada sentencia. Para saber cuál fue el último intento hacía falta un desempate, y el
-- que había era `id desc`.
--
-- `id` es un uuid v4: ALEATORIO. Desempatar por él da un orden TOTAL —determinista para unos
-- datos dados— pero no CRONOLÓGICO, que es lo que la pregunta necesita. El efecto medible:
-- tras una degradación en la que el primario cae y el respaldo responde bien, el panel
-- elegía como «último intento» al primario fallido aproximadamente la mitad de las veces y
-- avisaba de que el proveedor no responde justo después de una generación correcta. Un orden
-- total no es un orden verdadero, y el comentario que lo justificaba prometía lo segundo
-- diciendo lo primero.
--
-- Se persiste lo que el adaptador ya sabe y estaba tirando: la posición del intento en la
-- operación (0 = primario, 1 = respaldo).
-- El techo es 1 porque una generación son como mucho INTENTOS_POR_GENERACION llamadas
-- —primario y respaldo—, así que los puestos posibles son 0 y 1. Con `intento >= 0` a secas,
-- el comentario de la columna decía «0 primario, 1 respaldo» y la base aceptaba un 7: otra
-- afirmación que nadie ataba, y de las que hacen daño en silencio, porque un puesto fuera de
-- rango escrito por error sesga el orden del «último intento» sin que nada chille.
--
-- La base no puede importar la constante, así que el vínculo es el mismo que el del techo del
-- lote y el del cupo mínimo: una prueba escribe el último puesto válido y el primero
-- inválido, los dos derivados de INTENTOS_POR_GENERACION.
alter table llamada_ai
  add column intento smallint not null default 0
    check (intento >= 0 and intento <= 1);

comment on column llamada_ai.intento is
  'Puesto de este intento dentro de su generación: 0 primario, 1 respaldo (el CHECK lo acota '
  'a INTENTOS_POR_GENERACION - 1). Es el desempate CRONOLÓGICO entre filas que comparten '
  'creado_en por venir de la misma transacción.';

-- Las filas anteriores se quedan todas en 0 y no se pueden desambiguar a posteriori: nada
-- guardado dice cuál fue primero. No hace falta, y conviene decir por qué en vez de dejar la
-- duda: la señal de salud solo mira la ventana de los últimos minutos, así que las filas
-- escritas antes de esta migración salen de su alcance casi de inmediato. Para el libro de
-- costos —el otro consumidor de esta tabla— el puesto nunca importó: suma todas las llamadas.

-- Lo escribe la aplicación al anotar cada intento, así que entra en el grant de INSERT. En
-- ninguno de UPDATE: el puesto de un intento es un hecho del momento en que se despachó, y
-- reordenarlo después solo serviría para cambiar qué fila parece la última — es decir, para
-- mentirle a la señal de salud.
grant insert (intento) on llamada_ai to designio_app;
