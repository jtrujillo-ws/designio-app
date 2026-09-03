-- RF-03.2 / RF-09.7 — el predicado de sanitización cumple por fin lo que su comentario
-- prometía: C0 **y C1**.
--
-- `texto_importado_limpio` decía rechazar «controles C0/C1 salvo tab, LF y CR», pero la
-- clase se paraba en U+007F y omitía el bloque C1 entero (U+0080-U+009F). Por ahí pasaban
-- U+0085 (NEL, que varios editores tratan como salto de línea) y U+009B (CSI, la forma de
-- un solo byte del introductor de secuencias ANSI), tanto por el camino normal de la app
-- como por SQL crudo: el respaldo del esquema tenía el mismo agujero que la app porque
-- eran espejo el uno del otro. La promesa estaba escrita; el predicado no la cumplía.
--
-- Va en una migración NUEVA y no editando 20260902140000 porque una instalación que ya la
-- aplicó se quedaría con el predicado corto para siempre: `create or replace` es lo único
-- que alcanza a las bases ya migradas.

create or replace function texto_importado_limpio(t text) returns boolean
language sql immutable parallel safe as
$$ select t !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]' $$;
comment on function texto_importado_limpio(text) is
  'RF-03.2: el material importado se guarda crudo; lo que se rechaza son controles C0/C1 (bloque C1 completo: U+0080-U+009F) y overrides bidi (vector de spoofing), nunca se "limpian" en silencio porque eso correría los offsets de las citas.';

-- ── Las restricciones dejan de afirmar lo que ya no verificaron ──
-- Un CHECK evalúa la función en CADA escritura, así que ensanchar el predicado basta para
-- que las escrituras nuevas queden cubiertas de inmediato. Lo que NO se recalcula es el
-- flag `convalidated`: una base que validó estas restricciones con el predicado corto
-- seguiría declarando `t` mientras esconde material con C1 — un invariante que afirma más
-- de lo que comprobó es peor que no tenerlo, porque nadie vuelve a mirarlo.
--
-- Se re-declaran NOT VALID (drop + add, sin escaneo de tabla) y se revalidan con el mismo
-- criterio condicional de 20260902140000: una base limpia vuelve a `convalidated = t` bajo
-- el predicado NUEVO, y una con deuda —que ahora puede incluir filas que ayer eran
-- legítimas, justo el caso que el NOT VALID existe para no convertir en caída— queda
-- marcada, con aviso y evento, en vez de tumbar el despliegue.
alter table item_importacion
  drop constraint item_contenido_limpio,
  drop constraint item_titulo_limpio,
  drop constraint item_referencia_limpia;

alter table item_importacion
  add constraint item_contenido_limpio check (texto_importado_limpio(contenido)) not valid,
  add constraint item_titulo_limpio check (texto_importado_limpio(titulo)) not valid,
  add constraint item_referencia_limpia check (texto_importado_limpio(referencia)) not valid;

do $$
declare
  r record;
  v_sucias bigint;
begin
  for r in select * from (values
      ('item_contenido_limpio', 'contenido'),
      ('item_titulo_limpio', 'titulo'),
      ('item_referencia_limpia', 'referencia')) as t(restriccion, columna)
  loop
    execute format(
      'select count(*) from item_importacion where not texto_importado_limpio(%I)', r.columna)
      into v_sucias;
    if v_sucias = 0 then
      execute format('alter table item_importacion validate constraint %I', r.restriccion);
    else
      raise notice
        'RF-03.2: % item(s) heredados incumplen % con el predicado ampliado (C1); la restricción rige para escrituras nuevas y queda NOT VALID. Revisa los eventos MaterialImportadoSucioDetectado y limpia el ORIGINAL (no se normaliza aquí: correría los offsets de las citas).',
        v_sucias, r.restriccion;
    end if;
  end loop;
end $$;

-- Material que el predicado ampliado deja fuera y el anterior no veía. No se reescribe
-- —los offsets de las citas dependen de que el original se guarde crudo— y no se repite
-- lo ya registrado: el evento anterior sobre el mismo item sigue siendo válido.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select i.workspace_id, 'MaterialImportadoSucioDetectado',
       jsonb_build_object('itemId', i.id, 'estado', i.estado, 'motivo', 'controles C1',
                          'campos', (select jsonb_agg(campo) from unnest(array[
                            case when not texto_importado_limpio(i.contenido) then 'contenido' end,
                            case when not texto_importado_limpio(i.titulo) then 'titulo' end,
                            case when not texto_importado_limpio(i.referencia) then 'referencia' end
                          ]) as campo where campo is not null)),
       null, null
from item_importacion i
where not (texto_importado_limpio(i.contenido)
           and texto_importado_limpio(i.titulo)
           and texto_importado_limpio(i.referencia))
  and not exists (select 1 from evento_dominio e
    where e.tipo = 'MaterialImportadoSucioDetectado'
      and e.payload->>'itemId' = i.id::text);
