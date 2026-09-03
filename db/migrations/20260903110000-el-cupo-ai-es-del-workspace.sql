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
alter table workspace
  add column limite_llamadas_ai_dia integer
    check (limite_llamadas_ai_dia is null or limite_llamadas_ai_dia > 0);

comment on column workspace.limite_llamadas_ai_dia is
  'Cuota diaria de llamadas AI atendidas de este workspace (RF-08.5). NULL = sin cupo '
  'pactado, rige LIMITE_LLAMADAS_DIA del código. El CHECK impide almacenar un valor no '
  'positivo, así que la validación de TS es la última línea y no la única.';

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
