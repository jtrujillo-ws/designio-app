/**
 * Sanitización del material importado (RF-03.2, RF-09.7/09.8). Módulo PURO: lo comparten
 * el servidor (validación bloqueante) y la UI (avisar antes de subir); sin imports de
 * servidor.
 *
 * La decisión de fondo: **el contenido de terceros se guarda crudo, byte a byte**.
 * La cita verificable (RF-03.7, I3) localiza un fragmento por su posición en el original;
 * normalizar Unicode, recortar espacios o "limpiar" caracteres correría esos offsets y
 * la fidelidad de citas —que SYS-17 obliga a medir— dejaría de ser comprobable. Por eso
 * aquí no hay un sanitizador que reescriba: hay un VALIDADOR que rechaza, y el curador
 * decide qué hacer con el material que rechaza.
 *
 * Lo que se rechaza no es contenido, es vector:
 *  · Controles C0/C1 salvo tab, LF y CR. NUL además ni siquiera cabe en un `text` de
 *    Postgres, y el resto no aparece en prosa: aparece en payloads.
 *  · Overrides bidireccionales de Unicode (U+202A-202E, U+2066-2069, U+200E/200F): su
 *    único efecto es que el curador LEA algo distinto de lo que quedó guardado — es
 *    decir, atacan justo el acto humano en el que se apoya SYS-16.
 *
 * Lo que NO se hace, y por qué:
 *  · No hay sanitizador de HTML. El contenido importado jamás se interpreta como markup:
 *    se pinta como texto (React escapa por defecto y el bloque usa `white-space:
 *    pre-wrap`), no existe `dangerouslySetInnerHTML` en el repo y hay un test que lo
 *    verifica. Escribir un sanitizador de HTML a mano añadiría un parser propio —y sus
 *    bypasses— para un riesgo que el renderizado ya no tiene.
 *  · No se normaliza a NFC ni se recorta: ver arriba (offsets de citas).
 *  · No hay escaneo de malware (no hay motor en el MVP). Se compensa con allowlist
 *    cerrada de formatos, verificación de firma, y descarga forzada como
 *    application/octet-stream: los bytes nunca se ejecutan ni se renderizan inline
 *    salvo los tres formatos ráster, que no ejecutan nada.
 */

/** Controles C0/C1 (sin tab/LF/CR) y overrides bidi. Mismo predicado que el CHECK
 * `texto_importado_limpio` de la base: la app explica, el esquema garantiza. */
// eslint-disable-next-line no-control-regex
const PROHIBIDOS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

export type Veredicto = { ok: true } | { ok: false; motivo: string };

/** Valida texto importado. No lo modifica: o entra tal cual, o no entra. */
export function validarTextoImportado(texto: string): Veredicto {
  const m = PROHIBIDOS.exec(texto);
  if (!m) return { ok: true };
  const punto = m[0]!.codePointAt(0)!;
  const nombre =
    punto === 0
      ? 'un carácter NUL'
      : punto >= 0x200e && punto <= 0x2069
        ? 'un control bidireccional de Unicode (puede hacer que leas algo distinto de lo guardado)'
        : 'un carácter de control';
  return {
    ok: false,
    motivo: `El material contiene ${nombre} (U+${punto.toString(16).toUpperCase().padStart(4, '0')}) en la posición ${m.index}. No se elimina automáticamente: alterarlo correría las posiciones de las citas. Limpia el original y vuelve a pegarlo.`,
  };
}

// ── Archivos adjuntos ──

/** 5 MiB por archivo: mismo tope que el CHECK del esquema. El adjunto viaja base64
 * dentro del payload JSON de la server function (~6,7 MiB) y se guarda entero en una
 * fila `bytea`. Es el límite explícito del MVP, no un accidente. */
export const MAX_ARCHIVO_BYTES = 5 * 1024 * 1024;

/** Tope de adjuntos por item: la bandeja es curaduría humana, no un repositorio. */
export const MAX_ARCHIVOS_POR_ITEM = 10;

type Formato = { etiqueta: string; extensiones: readonly string[]; firma?: readonly number[] };

/** Allowlist CERRADA (RF-09.8), espejo del CHECK `archivo_tipo_permitido`.
 * Fuera a propósito: SVG y HTML (ejecutan script en un navegador) y todo formato con
 * macros heredadas (.doc/.xls binarios). */
export const FORMATOS_PERMITIDOS: Record<string, Formato> = {
  'application/pdf': { etiqueta: 'PDF', extensiones: ['.pdf'], firma: [0x25, 0x50, 0x44, 0x46] },
  'text/plain': { etiqueta: 'Texto', extensiones: ['.txt'] },
  'text/csv': { etiqueta: 'CSV', extensiones: ['.csv'] },
  'text/markdown': { etiqueta: 'Markdown', extensiones: ['.md'] },
  'image/png': {
    etiqueta: 'PNG',
    extensiones: ['.png'],
    firma: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  'image/jpeg': { etiqueta: 'JPEG', extensiones: ['.jpg', '.jpeg'], firma: [0xff, 0xd8, 0xff] },
  'image/webp': { etiqueta: 'WebP', extensiones: ['.webp'], firma: [0x52, 0x49, 0x46, 0x46] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    etiqueta: 'Word (docx)',
    extensiones: ['.docx'],
    firma: [0x50, 0x4b],
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    etiqueta: 'Excel (xlsx)',
    extensiones: ['.xlsx'],
    firma: [0x50, 0x4b],
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    etiqueta: 'PowerPoint (pptx)',
    extensiones: ['.pptx'],
    firma: [0x50, 0x4b],
  },
};

export const TIPOS_MIME_PERMITIDOS = Object.keys(FORMATOS_PERMITIDOS) as [string, ...string[]];

/** Extensiones para el `accept` del input de archivo (conveniencia, no seguridad). */
export const EXTENSIONES_PERMITIDAS = Object.values(FORMATOS_PERMITIDOS)
  .flatMap((f) => f.extensiones)
  .join(',');

const TEXTUALES = new Set(['text/plain', 'text/csv', 'text/markdown']);

/**
 * Nombre de archivo seguro. Aquí SÍ se normaliza (a diferencia del contenido): el nombre
 * no es material citable —no lleva offsets— y se usa como identificador al descargar,
 * donde una ruta o un control sí serían un problema real. Espejo del CHECK
 * `archivo_nombre_seguro`.
 */
export function normalizarNombreArchivo(nombre: string): string {
  const soloBase = nombre.split(/[/\\]/).pop() ?? '';
  const limpio = soloBase
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return limpio.length > 0 ? limpio : 'adjunto';
}

/** Extensión efectiva de un nombre ya normalizado: la ÚLTIMA, que es la que el sistema
 * operativo mira para decidir con qué se abre el archivo. En `informe.txt.html` es
 * `.html`, no `.txt`. */
function extensionFinal(nombre: string): string {
  const punto = nombre.lastIndexOf('.');
  return punto > 0 ? nombre.slice(punto).toLowerCase() : '';
}

/**
 * Nombre seguro Y COHERENTE con el formato validado (RF-09.8). El nombre y los bytes se
 * validan por caminos separados —`verificarArchivo` mira los bytes, `normalizarNombreArchivo`
 * mira el nombre— y esa separación dejaba una rendija: un `.html` declarado `text/plain`
 * con HTML en UTF-8 pasa AMBAS pruebas (el HTML es texto legítimo: ni controles ni bidi),
 * y el adjunto quedaba guardado con un nombre EJECUTABLE. El `download` del navegador lo
 * escribe en disco con ese nombre, y abrirlo desde ahí —origen `file://`, ya fuera del
 * `application/octet-stream` que protege la descarga— interpreta exactamente el formato que
 * la allowlist excluye a propósito.
 *
 * Se APENDA la extensión canónica del formato, en vez de sustituirla o de rechazar:
 *  · rechazar no daría seguridad —quien manda bytes HTML solo tendría que llamarlos
 *    `.txt`— y sí rompería subidas legítimas (`notas.text`, `informe.v2`);
 *  · sustituir destruiría el nombre que puso quien aportó el material, que es trazabilidad;
 *  · apendar conserva el nombre íntegro y garantiza que la extensión FINAL —la única que el
 *    sistema operativo mira— esté en la allowlist del formato que sí se verificó por bytes.
 * `payload.html` declarado `text/plain` queda `payload.html.txt`: inerte al abrirlo y con el
 * nombre original a la vista del curador. Es idempotente: aplicarlo dos veces no cambia nada.
 *
 * La base repite la regla en un CHECK: la app explica, el esquema garantiza.
 */
export function nombreSeguroParaFormato(nombre: string, tipoMime: string): string {
  const base = normalizarNombreArchivo(nombre);
  const formato = FORMATOS_PERMITIDOS[tipoMime];
  // MIME fuera de la allowlist: `verificarArchivo` ya lo rechaza antes de llegar aquí.
  if (!formato) return base;
  if (formato.extensiones.includes(extensionFinal(base))) return base;
  const canonica = formato.extensiones[0]!;
  return `${base.slice(0, 200 - canonica.length)}${canonica}`;
}

/**
 * Validación de FORMATO (RF-09.8): el tipo declarado tiene que coincidir con los bytes.
 * Un .pdf que empieza por `PK` no es un PDF; un "texto" con controles no es texto.
 * No se confía en la extensión ni en el `type` que reporta el navegador.
 */
export function verificarArchivo(bytes: Uint8Array, tipoMime: string): Veredicto {
  const formato = FORMATOS_PERMITIDOS[tipoMime];
  if (!formato) {
    return { ok: false, motivo: `Formato no permitido: ${tipoMime}` };
  }
  if (bytes.length === 0) return { ok: false, motivo: 'El archivo está vacío' };
  if (bytes.length > MAX_ARCHIVO_BYTES) {
    return {
      ok: false,
      motivo: `El archivo pesa ${(bytes.length / 1024 / 1024).toFixed(1)} MB y el máximo es ${MAX_ARCHIVO_BYTES / 1024 / 1024} MB`,
    };
  }
  if (formato.firma) {
    const coincide = formato.firma.every((b, i) => bytes[i] === b);
    if (!coincide) {
      return {
        ok: false,
        motivo: `El contenido no corresponde a un ${formato.etiqueta}: la firma del archivo no coincide con el tipo declarado`,
      };
    }
    // WebP es un contenedor RIFF: la firma corta también la comparten WAV y AVI.
    if (tipoMime === 'image/webp') {
      const marca = String.fromCharCode(...bytes.slice(8, 12));
      if (marca !== 'WEBP') {
        return { ok: false, motivo: 'El contenedor RIFF no es WebP' };
      }
    }
  }
  if (TEXTUALES.has(tipoMime)) {
    // Los formatos textuales no tienen firma: su "firma" es ser texto legítimo, con el
    // MISMO criterio que el contenido pegado (un .txt es material importado igual).
    let texto: string;
    try {
      texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, motivo: 'El archivo declarado como texto no es UTF-8 válido' };
    }
    const v = validarTextoImportado(texto);
    if (!v.ok) return v;
  }
  return { ok: true };
}

/**
 * Tipo con el que se DECLARA un archivo del navegador. El `type` que reporta el
 * navegador es una pista, no una prueba (lo deduce de la extensión y a veces lo deja
 * vacío), así que solo se acepta si está en la allowlist; si no, se deduce de la
 * extensión. En ambos casos la palabra final la tiene `verificarArchivo`, que mira los
 * bytes — y el servidor la repite.
 */
export function tipoDeclaradoDeArchivo(nombre: string, tipoNavegador: string): string | null {
  if (tipoNavegador in FORMATOS_PERMITIDOS) return tipoNavegador;
  const punto = nombre.lastIndexOf('.');
  if (punto < 0) return null;
  const ext = nombre.slice(punto).toLowerCase();
  const entrada = Object.entries(FORMATOS_PERMITIDOS).find(([, f]) =>
    f.extensiones.includes(ext),
  );
  return entrada ? entrada[0] : null;
}

// ── base64 (transporte del adjunto por la server function) ──
// atob/btoa existen en el navegador y en Bun/Node; se procesa por trozos porque el
// spread de un array de megabytes revienta el límite de argumentos.

const TROZO = 0x8000;

export function bytesABase64(bytes: Uint8Array): string {
  let binario = '';
  for (let i = 0; i < bytes.length; i += TROZO) {
    binario += String.fromCharCode(...bytes.subarray(i, i + TROZO));
  }
  return btoa(binario);
}

export function base64ABytes(base64: string): Uint8Array {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

/** Tamaño en bytes que representa una cadena base64, sin decodificarla (para cortar
 * temprano un payload gigante). */
export function bytesDeBase64(base64: string): number {
  const relleno = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - relleno;
}
