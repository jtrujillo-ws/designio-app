-- RF-03.2 / RF-09.8 / SYS-16 — DOS AGUJEROS QUE SON EL MISMO ERROR: CAMBIAR UNA REGLA SIN
-- MIRAR SU RADIO DE ALCANCE.
--
-- ═══ 1. El predicado bidi existía y no se aplicaba al NOMBRE ═══
-- `normalizarNombreArchivo` quitaba controles C0/C1 y comillas, y `archivo_nombre_seguro`
-- miraba `[[:cntrl:]]` y las barras. Los overrides bidireccionales —U+200E/200F,
-- U+202A-202E, U+2066-2069— pasaban enteros.
--
-- No faltaba el predicado: está escrito rango a rango desde 20260902140000 para el material
-- importado, y este mismo repositorio lo justifica diciendo que su único efecto es que el
-- curador LEA algo distinto de lo que quedó guardado. Lo que falló fue el razonamiento que
-- lo dejó fuera del nombre, y estaba escrito: «el nombre se usa como identificador al
-- descargar, donde una RUTA o un CONTROL sí serían un problema real». Se pensó en rutas y
-- en controles, no en bidi.
--
-- Y en un nombre de fichero el bidi es PEOR que en el cuerpo del texto: el nombre es lo que
-- el curador lee para decidir y lo que el sistema operativo enseña tras la descarga, así
-- que un `.txt` que se muestra como otra cosa es el mismo ataque, en la superficie donde
-- más engaña. El nombre SÍ se normaliza (no lleva offsets de citas, a diferencia del
-- contenido), así que aquí se limpia en vez de rechazar.
--
-- El rango vive ahora en UNA función y no copiado dos veces: `texto_importado_limpio` la
-- usa y el CHECK del nombre también. Es la misma lección de los espejos escritos a mano.
create function sin_overrides_bidi(t text) returns boolean
language sql immutable parallel safe as
$$ select t !~ '[\u200e\u200f\u202a-\u202e\u2066-\u2069]' $$;
comment on function sin_overrides_bidi(text) is
'Overrides bidireccionales de Unicode: su único efecto es que se LEA algo distinto de lo guardado. Un solo sitio para el rango, usado por el predicado del material importado y por el del nombre de archivo.';

create or replace function texto_importado_limpio(t text) returns boolean
language sql immutable parallel safe as
$$ select t !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\u007f-\u009f]' and sin_overrides_bidi(t) $$;
comment on function texto_importado_limpio(text) is
'RF-03.2: el material importado se guarda crudo; lo que se rechaza son controles C0/C1 (bloque C1 completo: U+0080-U+009F) y overrides bidi (vector de spoofing), nunca se "limpian" en silencio porque eso correría los offsets de las citas.';

-- ── La limpieza del nombre, ENTERA y en un solo sitio ──
-- Espejo de `normalizarNombreArchivo`, paso por paso y en el mismo orden. Existe porque la
-- primera versión de esta migración escribió una limpieza REDUCIDA al lado de la buena —
-- solo quitaba el bidi— y eso reprodujo, dentro del mismo fichero, el defecto que este PR
-- lleva toda la revisión cerrando: dos redacciones de la misma regla, una con su caso de
-- reserva y otra sin él.
--
-- El caso que lo destapa: un adjunto llamado `<RLO>.pdf` es perfectamente legal con las
-- restricciones viejas. Quitarle solo el bidi deja `.pdf`, que NO es un nombre —es un
-- fichero oculto sin base— y que además el `archivo_nombre_seguro` de entonces rechaza por
-- empezar con punto. La app ya resolvía esto (quita los puntos iniciales y cae a `adjunto`
-- si no queda nada); la migración tenía que salir de la misma limpieza, no de una versión
-- corta escrita aparte.
create function nombre_archivo_saneado(t text) returns text
language sql immutable parallel safe as
$$
  select coalesce(nullif(
    left(btrim(
      regexp_replace(                                    -- 5) puntos iniciales
        regexp_replace(                                  -- 4) espacios colapsados
          regexp_replace(                                -- 3) overrides bidi
            regexp_replace(                              -- 2) controles y comilla doble
              regexp_replace(t, '^.*[/\\]', ''),       -- 1) solo el nombre base
            '[\u0000-\u001f\u007f-\u009f"]', '', 'g'),
          '[\u200e\u200f\u202a-\u202e\u2066-\u2069]', '', 'g'),
        '\s+', ' ', 'g'),
      '^\.+', '')
    ), 200), ''), 'adjunto')
$$;
comment on function nombre_archivo_saneado(text) is
'Espejo de normalizarNombreArchivo: base sin ruta, sin controles ni comilla doble, sin overrides bidi, espacios colapsados, sin puntos iniciales, recortado a 200 y con «adjunto» de reserva si no queda nada.';

-- ── Y la extensión canónica, que es el TERCER predicado en juego ──
-- Sanear el nombre no basta: `<RLO>.pdf` queda `pdf`, que ya no casa con
-- `archivo_extension_del_formato` (20260902150000) y aborta igual, una restricción más
-- allá. La app nunca tuvo ese problema porque su camino completo es
-- `nombreSeguroParaFormato(normalizarNombreArchivo(...), mime)`: sanea y DESPUÉS reapenda
-- la extensión canónica. La reparación tenía que recorrer el camino entero, no su primera
-- mitad — que es, otra vez, la misma lección: no se reescribe media regla al lado de la
-- buena. La lógica de apendar sale de la que 20260902150000 ya usó para su propia
-- reparación, factorizada aquí para que deje de estar suelta en un `update`.
create function nombre_con_extension_del_formato(p_nombre text, p_mime text) returns text
language sql immutable parallel safe as
$$
  select case
    when patrones_extension_formato(p_mime) is null then p_nombre
    when lower(p_nombre) like any (patrones_extension_formato(p_mime)) then p_nombre
    else left(p_nombre, 200 - length(substr((patrones_extension_formato(p_mime))[1], 2)))
         || substr((patrones_extension_formato(p_mime))[1], 2)
  end
$$;
comment on function nombre_con_extension_del_formato(text, text) is
'Apenda la extensión canónica del formato si la final no casa (nunca sustituye: el nombre original es trazabilidad). Espejo de nombreSeguroParaFormato.';

-- ── Reparar antes de restringir, y contra NINGUNA de las tres restricciones ──
-- «Reparar antes de restringir» estaba aplicado a medias: se reparaba antes de poner la
-- restricción NUEVA, pero contra la VIEJA, que seguía en pie mientras tanto y rechazaba
-- justo los nombres que la limpieza produce. La restricción se quita PRIMERO; entre medias
-- no hay ventana de riesgo real, porque esto corre dentro de la transacción de la migración.
alter table archivo_importado drop constraint archivo_nombre_seguro;

-- Y no en silencio: cada nombre corregido deja su rastro con el nombre previo y el sha256.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select a.workspace_id, 'AdjuntoNombreConBidiCorregido',
       jsonb_build_object('archivoId', a.id, 'sha256', a.sha256,
                          'nombrePrevio', a.nombre,
                          'nombreNuevo', nombre_con_extension_del_formato(
                                           nombre_archivo_saneado(a.nombre), a.tipo_mime)),
       null, null
from archivo_importado a
where not sin_overrides_bidi(a.nombre);

update archivo_importado a
set nombre = nombre_con_extension_del_formato(nombre_archivo_saneado(a.nombre), a.tipo_mime)
where not sin_overrides_bidi(a.nombre);

alter table archivo_importado add constraint archivo_nombre_seguro check (
  length(nombre) between 1 and 200
  and nombre !~ '[[:cntrl:]]'
  and nombre !~ '[/\\"]'
  and nombre not like '.%'
  and sin_overrides_bidi(nombre)
);

-- ═══ 2. Dar salida a lo heredado sucio abrió una puerta de BLANQUEO ═══
-- 20260902280000 cambió los tres CHECK por un trigger que solo se impone cuando el texto
-- entra o cambia, para que un item heredado sucio pudiera despacharse. La salida hacía
-- falta y sigue haciendo falta. Lo que no se miró es QUIÉN COPIA ese texto después:
-- `aprobarItem` escribe `item.titulo` en `fuente.titulo` y en `evidencia.titulo`, y ahí no
-- hay guard equivalente. Aprobar un heredado sucio metía el metadato falsificado en dos
-- registros permanentes y visibles para todo miembro del workspace — con el bidi haciendo
-- exactamente lo que el predicado existe para impedir.
--
-- El arreglo no deshace el anterior, lo afina: RECHAZAR sigue permitido —que es la salida
-- que se buscaba, y la que un curador necesita para despachar material que no debió
-- entrar— y APROBAR se bloquea hasta que el metadato se remedie o se reimporte. La salida
-- de la bandeja existe; lo que no puede es ser la que blanquea texto sucio convirtiéndolo
-- en evidencia.
create or replace function item_texto_importado_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- INSERT: el texto entra entero, se comprueba entero. UPDATE: solo lo que cambia de
  -- verdad, comparado aquí y no en la cláusula del trigger — `update of columna` dispara
  -- cuando la columna aparece en el SET, no cuando cambia.
  if tg_op = 'INSERT' or new.contenido is distinct from old.contenido then
    if not texto_importado_limpio(new.contenido) then
      raise exception 'el contenido importado lleva controles C0/C1 u overrides bidi'
        using errcode = '23514', constraint = 'item_contenido_limpio';
    end if;
  end if;
  if tg_op = 'INSERT' or new.titulo is distinct from old.titulo then
    if not texto_importado_limpio(new.titulo) then
      raise exception 'el título importado lleva controles C0/C1 u overrides bidi'
        using errcode = '23514', constraint = 'item_titulo_limpio';
    end if;
  end if;
  if tg_op = 'INSERT' or new.referencia is distinct from old.referencia then
    if not texto_importado_limpio(new.referencia) then
      raise exception 'la referencia importada lleva controles C0/C1 u overrides bidi'
        using errcode = '23514', constraint = 'item_referencia_limpia';
    end if;
  end if;
  -- APROBAR es lo que COPIA el metadato a `fuente` y a `evidencia`, que no tienen este
  -- guard. Rechazar sigue abierto: la salida de la bandeja no se toca.
  if tg_op = 'UPDATE' and new.estado = 'aprobado' and old.estado <> 'aprobado'
     and not (texto_importado_limpio(new.titulo) and texto_importado_limpio(new.referencia)
              and texto_importado_limpio(new.contenido)) then
    raise exception 'no se puede aprobar este material: su texto lleva controles o marcas bidi heredados, y aprobarlo los copiaría al título de la fuente y de la evidencia. Recházalo y vuelve a importarlo limpio (el original no se reescribe: alterarlo correría las posiciones de las citas)'
      using errcode = 'AD003';
  end if;
  return new;
end $$;

-- Los items heredados sucios que siguen PENDIENTES quedan nombrados: ahora se sabe que su
-- única salida es el rechazo, y conviene que el operador lo vea antes de intentarlo.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select i.workspace_id, 'MaterialSucioNoAprobable',
       jsonb_build_object('itemId', i.id), null, null
from item_importacion i
where i.estado = 'pendiente'
  and not (texto_importado_limpio(i.titulo) and texto_importado_limpio(i.referencia)
           and texto_importado_limpio(i.contenido));
