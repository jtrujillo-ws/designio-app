-- RF-09.8 (defensa en profundidad) — la EXTENSIÓN del adjunto queda atada al formato
-- que se verificó por bytes.
--
-- El agujero que cierra: el nombre y el contenido se validaban por caminos separados.
-- `verificarArchivo` mira los bytes (allowlist de MIME + firma mágica) y
-- `normalizarNombreArchivo` mira el nombre (basename, sin controles ni comillas, sin
-- punto inicial), pero nadie comprobaba que ambos hablaran del mismo formato. Un
-- llamador directo de la server function podía enviar `nombre: 'payload.html'`,
-- `tipoMime: 'text/plain'` y HTML en UTF-8: los bytes pasan —el HTML es texto legítimo,
-- sin controles ni overrides bidi— y el sufijo `.html` sobrevivía intacto. El adjunto
-- quedaba guardado con un nombre EJECUTABLE.
--
-- Por qué importa aunque la descarga ya fuerce `application/octet-stream`: ese
-- octet-stream protege el momento de la transferencia (el navegador no lo interpreta en
-- el origen de la aplicación), pero el `download` escribe el fichero en el disco con el
-- nombre guardado. Abrirlo desde ahí es un origen `file://` donde ya no hay
-- Content-Type que valga: el navegador decide por la extensión y ejecuta el script.
-- El mismo nombre viaja además dentro del paquete de exportación (RF-01.8), así que
-- quien desempaque el archivo escribe ese `.html` en su propio disco. La allowlist
-- cerrada excluye SVG y HTML A PROPÓSITO; almacenar un nombre `.html` hacía falsa esa
-- promesa justo en el artefacto que acaba en un disco ajeno.
--
-- Va en un CHECK y no solo en la app por el idioma de la casa: la app explica, el
-- esquema garantiza. Un INSERT crudo del rol de aplicación choca igual.

-- Extensiones canónicas por formato: espejo EXACTO de FORMATOS_PERMITIDOS en
-- src/lib/evidencia/sanitizacion.ts, igual que `archivo_tipo_permitido` es espejo de sus
-- claves. Devuelve patrones `like` («%.pdf») para poder usarse dentro de un CHECK, donde
-- no cabe una subconsulta pero sí `like any (array)`.
create function patrones_extension_formato(p_mime text) returns text[]
language sql immutable parallel safe as
$$
  select case p_mime
    when 'application/pdf' then array['%.pdf']
    when 'text/plain' then array['%.txt']
    when 'text/csv' then array['%.csv']
    when 'text/markdown' then array['%.md']
    when 'image/png' then array['%.png']
    when 'image/jpeg' then array['%.jpg', '%.jpeg']
    when 'image/webp' then array['%.webp']
    when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      then array['%.docx']
    when 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      then array['%.xlsx']
    when 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      then array['%.pptx']
  end
$$;
comment on function patrones_extension_formato(text) is
  'RF-09.8: extensiones válidas para cada formato de la allowlist. Un MIME desconocido devuelve NULL y el coalesce del CHECK lo convierte en «ninguna extensión sirve» (fail-closed).';

-- ── Reparación previa: el material ya subido no bloquea la migración ──
-- Una migración forward-only tiene que poder correr sobre una base con datos, y añadir el
-- CHECK sin más abortaría si existiera un adjunto con extensión incoherente — que es
-- justamente el caso que motiva esta migración. Se corrige con la MISMA regla que aplica
-- la app (apendar la extensión canónica, nunca sustituir: el nombre que puso quien aportó
-- el material es trazabilidad), y no en silencio: cada corrección deja evento. En una base
-- fresca ambas sentencias son no-ops.
insert into evento_dominio (workspace_id, tipo, payload, actor_id, actor_rol)
select a.workspace_id, 'AdjuntoExtensionCorregida',
       jsonb_build_object('archivoId', a.id, 'nombrePrevio', a.nombre,
                          'tipoMime', a.tipo_mime, 'sha256', a.sha256),
       null, null
from archivo_importado a
where patrones_extension_formato(a.tipo_mime) is not null
  and not (lower(a.nombre) like any (patrones_extension_formato(a.tipo_mime)));

update archivo_importado a
set nombre = left(a.nombre, 200 - length(substr((patrones_extension_formato(a.tipo_mime))[1], 2)))
             || substr((patrones_extension_formato(a.tipo_mime))[1], 2)
where patrones_extension_formato(a.tipo_mime) is not null
  and not (lower(a.nombre) like any (patrones_extension_formato(a.tipo_mime)));

-- `like any (array[])` sobre el array vacío es FALSE: un tipo_mime que no esté en la
-- allowlist no tiene extensión válida y la fila se rechaza (el CHECK
-- `archivo_tipo_permitido` ya lo impedía; esto no depende de él para ser fail-closed).
alter table archivo_importado
  add constraint archivo_extension_del_formato check (
    lower(nombre) like any (coalesce(patrones_extension_formato(tipo_mime), array[]::text[]))
  );

revoke execute on function patrones_extension_formato(text) from public;
grant execute on function patrones_extension_formato(text) to designio_app;
