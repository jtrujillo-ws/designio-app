-- RF-03.10 / RF-04.11 — la tercera superficie de respaldo entra bajo la misma regla.
--
-- `20260902160000` dejó `arquetipo_evidencia` FUERA del guard de derechos con este
-- argumento escrito: «apoyo del razonamiento interno de la boutique: no copia contenido y
-- no se publica». Las dos mitades son falsas, y conviene dejar dicho por qué en vez de
-- borrar el comentario y seguir:
--
--  · NO ES INTERNO. `arquetipo_veredicto_guard` exige evidencia enlazada para confirmar un
--    arquetipo, y `gate_aprobar_suficiencia_guard` no deja aprobar G2 con arquetipos sin
--    confirmar ni refutar. O sea que este enlace es respaldo PROBATORIO en el camino
--    crítico de un gate que se aprueba con el cliente delante — exactamente el papel que
--    tiene una cita, aunque no se llame así.
--  · SÍ SE PUBLICA. La proyección de gobernanza emite `jsonb_build_object('id', e.id,
--    'titulo', e.titulo)` por cada evidencia del arquetipo, y `arquetipo_evidencia` se lee
--    con RLS de mera membresía. El tablero lo abre todo el workspace: sponsor y
--    stakeholder incluidos. Así que este era el peor de los tres casos, no el más leve:
--    los otros dos dejaban pasar una cita hacia un gate; éste publica el TÍTULO de una
--    evidencia denegada —texto que viene del material importado— a la audiencia entera.
--
-- Con esto, las tres superficies de respaldo (ítem de checklist, cita de insight y
-- evidencia de arquetipo) quedan bajo el mismo guard y el mismo ámbito «cliente», que es
-- lo que esta rama promete. La poda del entregable sigue haciendo su parte; lo que faltaba
-- era impedir que el enlace llegara a existir.
create trigger evidencia_citable
  before insert or update on arquetipo_evidencia
  for each row execute function evidencia_citable_guard();

-- Los enlaces que ya existan sobre evidencia sin derechos no se borran —reescribiría
-- juicio humano ya emitido, y un arquetipo confirmado perdería su respaldo en silencio—
-- pero quedan registrados para que el operador conceda los derechos o retire el enlace.
--
-- El predicado va INLINE y no llamando a `evidencia_usable`: desde 20260902190000 esa
-- función exige membresía, y una migración corre como propietario (`app_user_id()` null),
-- así que llamarla aquí marcaría TODOS los enlaces como bloqueados. Una migración no debe
-- depender de un predicado con ámbito de sesión; el suyo es el de la tabla.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select ae.workspace_id, 'ArquetipoConEvidenciaSinDerechos',
       jsonb_build_object('arquetipoId', ae.arquetipo_id, 'evidenciaId', ae.evidencia_id,
                          'estadoDerechos', coalesce(d.estado, 'sin registro')),
       null, null
from arquetipo_evidencia ae
left join derecho_uso d
  on d.evidencia_id = ae.evidencia_id and d.workspace_id = ae.workspace_id
where d.evidencia_id is null
   or d.estado <> 'concedido'
   or d.ambito not in ('cliente', 'publico')
   or (d.vence_en is not null and d.vence_en < current_date);
