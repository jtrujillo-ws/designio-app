-- ── El vocabulario de capacidades es UNO, y las tres tablas del pipeline lo dicen igual ──
--
-- `propuesta_ai` declaraba las DIEZ capacidades de SPEC-08 §30 —C0..C7, CT, CI, que es el
-- alcance MVP cerrado que RF-08.1 nombra una por una—; `reserva_ai` y `llamada_ai`
-- declaraban dos. La asimetría no está defendida en ningún comentario de aquella migración
-- y va al revés de como tendría que ir: la tabla de SALIDA es la permisiva y las de entrada
-- las estrictas.
--
-- Lo que la vuelve urgente es la Fase 1, que entra por CUATRO ramas a la vez (CT, C1-D, C2,
-- C5). Con el vocabulario enumerado en cada tabla, cada rama escribe su propia migración
-- «suelta la restricción y vuélvela a poner con mi capacidad dentro», y ninguna sabe de las
-- otras. Medido contra la base real, aplicando dos de esas migraciones en el orden en que se
-- fusionarían:
--
--   tras fusionar CT:  check (capacidad in ('C0','CI','CT'))
--   tras fusionar C2:  check (capacidad in ('C0','CI','C2'))
--
-- CT desaparece. Y desaparece EN VERDE: las dos migraciones aplican sin error, git no ve
-- conflicto porque son ficheros distintos, CI pasa, y la capacidad se revoca en silencio —
-- se descubre el día que alguien intenta generar con ella y la reserva la rechaza. El modo
-- de fallo que este repositorio ya conoce: nadie echa de menos lo que no falta.
--
-- Así que el vocabulario se declara una vez, aquí, con las diez, y las tres tablas quedan
-- de acuerdo. A partir de ahora una capacidad nueva NO trae migración de vocabulario: trae
-- su declaración en `CAPACIDADES` y su entrada en `PREPARAR`, que es donde se decide de
-- verdad cuáles están vivas.
--
-- Lo que esto NO afloja, dicho para que nadie lo lea de más: qué capacidades se pueden
-- despachar. Eso no lo sujetaba este CHECK ni cuando decía dos — lo sujeta
-- `CAPACIDADES_ACTIVAS` en la aplicación, que es lo único que llama al proveedor. El CHECK
-- sujeta el VOCABULARIO: que nadie escriba 'C9' ni 'ci' en minúsculas. Eso sigue igual de
-- sujeto con diez valores que con dos, y ahora lo dice el mismo texto en los tres sitios.

alter table reserva_ai drop constraint reserva_ai_capacidad_check;
alter table reserva_ai add constraint reserva_ai_capacidad_check
  check (capacidad in ('C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'CT', 'CI'));

alter table llamada_ai drop constraint llamada_ai_capacidad_check;
alter table llamada_ai add constraint llamada_ai_capacidad_check
  check (capacidad in ('C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'CT', 'CI'));
