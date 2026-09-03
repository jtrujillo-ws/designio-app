-- El presupuesto AI es del WORKSPACE, no del despliegue (RF-08.5, diseño técnico ·
-- «cuota diaria de llamadas AI»).
--
-- El slice AI ya llevaba `evaluarCapacidadAI(limiteDiario)` y una constante global de 60
-- como respaldo, pero las dos llamadas vivas le pasaban la constante, así que el parámetro
-- existía y nadie lo usaba: todos los workspaces compartían el mismo tope y el presupuesto
-- por workspace era una promesa escrita que el código no establecía. Aquí nace el dato que
-- el parámetro esperaba.
--
-- NULL no es «sin tope»: es «este workspace no tiene cupo pactado», y entonces rige el
-- respaldo del código. Distinguir las dos cosas importa porque un tope AUSENTE y un tope
-- INFINITO se parecen en la columna y son opuestos en la factura; con NULL, el corte suave
-- de RF-09.11 sigue existiendo siempre y nadie puede apagarlo dejando el campo vacío.
-- El mínimo es 2 y no 1, y el 2 es INTENTOS_POR_GENERACION: una generación reserva el
-- intento primario y el de respaldo ANTES de llamar, así que un cupo de 1 no admite ninguna
-- —el hueco nunca alcanza— y el workspace se quedaría con la capacidad apagada para siempre
-- detrás de un mensaje que se lee como «vuelve mañana». Un tope que no deja pasar nada no es
-- un tope, es un interruptor; y para apagar la AI ya está no configurar credencial, que lo
-- dice con todas las letras.
--
-- La base no puede importar la constante, así que el vínculo es el mismo que el del techo del
-- lote: una prueba pacta el cupo mínimo, comprueba que con él SÍ se puede generar, e intenta
-- pactar uno por debajo y exige que la base lo rechace.
alter table workspace
  add column limite_llamadas_ai_dia integer
    check (limite_llamadas_ai_dia is null or limite_llamadas_ai_dia >= 2);

comment on column workspace.limite_llamadas_ai_dia is
  'Cuota diaria de llamadas AI atendidas de este workspace (RF-08.5). NULL = sin cupo '
  'pactado, rige LIMITE_LLAMADAS_DIA del código. El CHECK impide almacenar un cupo por '
  'debajo de INTENTOS_POR_GENERACION, que no admitiría ninguna generación.';

-- ── Por qué NO hay grant, y por qué eso es el arreglo y no un olvido ──
--
-- `designio_app` tiene sobre `workspace` únicamente `grant select` (20260902000100), y esta
-- columna se queda ahí dentro: se LEE para decidir, y no se escribe desde la aplicación por
-- ninguna ruta. Un cupo que el propio inquilino pudiera subir no es un cupo, es una
-- sugerencia — y como el rol de aplicación no tiene UPDATE sobre la tabla, la promesa es
-- ESTRUCTURAL y no una convención que la próxima pantalla pueda saltarse por descuido.
--
-- El cupo lo pacta la boutique fuera del producto (hoy: administración de la base). Si algún
-- día se le pone pantalla, el camino es un guard `security definer` con su puerta —jamás un
-- `grant update` sobre esta columna—, y este comentario es la razón por la que hay que
-- pararse a leerlo antes de abrirlo.
