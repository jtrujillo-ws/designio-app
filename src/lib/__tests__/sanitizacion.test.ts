import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CrearItemImportacionSchema } from '@/lib/evidencia/evidencia.schemas';
import {
  bytesABase64,
  base64ABytes,
  bytesDeBase64,
  nombreSeguroParaFormato,
  normalizarNombreArchivo,
  tipoDeclaradoDeArchivo,
  validarTextoImportado,
  verificarArchivo,
} from '@/lib/evidencia/sanitizacion';

/**
 * Sanitización del material importado (RF-03.2, RF-09.7/09.8). Estos tests fijan la
 * decisión de diseño, no solo el código: el texto entra CRUDO y lo que se rechaza es
 * vector, no contenido.
 */
describe('sanitización del material importado', () => {
  it('el texto de terceros se acepta tal cual: no se normaliza, no se recorta, no se escapa', () => {
    // Un payload clásico de inyección atraviesa el validador intacto — a propósito. La
    // defensa no es reescribirlo (eso correría los offsets de las citas, RF-03.7): es
    // que nunca se interpreta como markup.
    const payload = '<script>alert(1)</script> & "comillas" \u00f1 emoji 🙂\n\tsangría   ';
    expect(validarTextoImportado(payload).ok).toBe(true);
    const parsed = CrearItemImportacionSchema.parse({
      workspaceId: crypto.randomUUID(),
      titulo: 'Material con markup',
      contenido: payload,
      tipoFuente: 'documento',
      referencia: '',
    });
    expect(parsed.contenido).toBe(payload);
  });

  it('los controles C0 y los overrides bidi se rechazan, no se limpian', () => {
    for (const codigo of [0x00, 0x07, 0x1b, 0x7f]) {
      const v = validarTextoImportado(`hola${String.fromCharCode(codigo)}mundo`);
      expect(v.ok).toBe(false);
    }
    // Trojan source / spoofing visual: el curador leería algo distinto de lo guardado,
    // que es justo el acto humano en el que se apoya SYS-16.
    for (const codigo of [0x202e, 0x2066, 0x200f]) {
      expect(validarTextoImportado(`hola${String.fromCodePoint(codigo)}mundo`).ok).toBe(false);
    }
    // Tab, salto de línea y retorno SÍ son contenido de un texto pegado.
    expect(validarTextoImportado('linea1\nlinea2\r\n\tsangrada').ok).toBe(true);
  });

  it('el bloque C1 ENTERO se rechaza: la promesa decía C0/C1 y la clase se paraba en DEL', () => {
    // El comentario del módulo prometía «controles C0/C1» desde el primer día, pero la
    // clase iba de U+0000 a U+007F: todo U+0080-U+009F entraba como texto legítimo.
    // U+0085 (NEL) lo tratan como salto de línea varios editores y U+009B (CSI) es la
    // forma de un solo byte del introductor de secuencias ANSI: los dos hacen que el
    // curador LEA algo distinto de lo que quedó guardado, que es el acto humano sobre el
    // que se apoya SYS-16. Se recorre el bloque completo para que nadie lo estreche.
    for (let punto = 0x80; punto <= 0x9f; punto += 1) {
      const v = validarTextoImportado(`hola${String.fromCodePoint(punto)}mundo`);
      expect([punto, v.ok]).toEqual([punto, false]);
    }
    // Y el mensaje sigue localizando el carácter exacto, no un «texto inválido».
    const v = validarTextoImportado('inicio\u0085fin');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motivo).toContain('U+0085');
    // El vecindario inmediato NO se rechaza: U+00A0 y siguientes son texto real.
    expect(validarTextoImportado('espacio duro y ¡hola!').ok).toBe(true);
  });

  it('el nombre de archivo tampoco conserva controles C1 (el CHECK usa [[:cntrl:]])', () => {
    // `archivo_nombre_seguro` rechaza `[[:cntrl:]]`, que en UTF-8 SÍ incluye C1. Con el
    // rango corto la app generaba nombres que el esquema rechazaba: el curador veía un
    // 23514 opaco en vez de un nombre ya limpio. El backstop confirma lo que la app hace.
    expect(normalizarNombreArchivo('informe\u0085raro.pdf')).toBe('informeraro.pdf');
    expect(normalizarNombreArchivo('a\u009Bb.csv')).toBe('ab.csv');
  });

  it('el rechazo dice qué carácter y dónde (el curador limpia el original, no el sistema)', () => {
    const v = validarTextoImportado('inicio\u0007fin');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.motivo).toContain('U+0007');
      expect(v.motivo).toContain('posición 6');
    }
  });

  it('el schema de importación aplica el mismo criterio a título, referencia y contenido', () => {
    const base = {
      workspaceId: crypto.randomUUID(),
      tipoFuente: 'nota' as const,
      referencia: '',
    };
    expect(
      CrearItemImportacionSchema.safeParse({ ...base, titulo: 'ok\u0000', contenido: 'x' })
        .success,
    ).toBe(false);
    expect(
      CrearItemImportacionSchema.safeParse({ ...base, titulo: 'ok', contenido: 'x\u202e' })
        .success,
    ).toBe(false);
    expect(
      CrearItemImportacionSchema.safeParse({
        ...base,
        titulo: 'ok',
        contenido: 'x',
        referencia: 'ref\u001b',
      }).success,
    ).toBe(false);
  });

  it('el nombre de archivo SÍ se normaliza: no lleva offsets y termina en una descarga', () => {
    expect(normalizarNombreArchivo('../../etc/passwd')).toBe('passwd');
    expect(normalizarNombreArchivo('C:\\Users\\ana\\informe final.pdf')).toBe('informe final.pdf');
    expect(normalizarNombreArchivo('.bashrc')).toBe('bashrc');
    expect(normalizarNombreArchivo('re"port".csv')).toBe('report.csv');
    expect(normalizarNombreArchivo('   ')).toBe('adjunto');
    expect(normalizarNombreArchivo('informe año.pdf')).toBe('informe año.pdf');
    expect(normalizarNombreArchivo('a'.repeat(400)).length).toBe(200);
  });

  it('la extensión guardada corresponde al formato verificado, no a la que pidió el cliente', () => {
    // El agujero: bytes y nombre se validan por caminos separados. HTML en UTF-8 es
    // texto legítimo —ni controles ni bidi—, así que declarado `text/plain` pasa
    // `verificarArchivo`, y el sufijo `.html` sobrevivía a la normalización del nombre.
    // El adjunto quedaba guardado con un nombre EJECUTABLE: la descarga fuerza
    // octet-stream, pero el fichero acaba en el disco con ese nombre y abrirlo desde ahí
    // (origen file://) lo interpreta como HTML. La allowlist excluye HTML a propósito.
    expect(nombreSeguroParaFormato('payload.html', 'text/plain')).toBe('payload.html.txt');
    expect(nombreSeguroParaFormato('grafico.svg', 'text/plain')).toBe('grafico.svg.txt');
    // Se apenda, nunca se sustituye: el nombre que puso quien aportó el material es
    // trazabilidad, y lo que decide cómo se abre el fichero es la extensión FINAL.
    expect(nombreSeguroParaFormato('informe.v2', 'application/pdf')).toBe('informe.v2.pdf');
    expect(nombreSeguroParaFormato('sin-extension', 'text/csv')).toBe('sin-extension.csv');
    expect(nombreSeguroParaFormato('   ', 'application/pdf')).toBe('adjunto.pdf');
    // Un nombre ya coherente no se toca, y la comparación no distingue mayúsculas ni
    // se cierra a la única extensión canónica del formato.
    expect(nombreSeguroParaFormato('informe.pdf', 'application/pdf')).toBe('informe.pdf');
    expect(nombreSeguroParaFormato('foto.JPEG', 'image/jpeg')).toBe('foto.JPEG');
    expect(nombreSeguroParaFormato('../../etc/passwd', 'text/plain')).toBe('passwd.txt');
    // Idempotente: pasarlo dos veces no encadena extensiones.
    const una = nombreSeguroParaFormato('payload.html', 'text/plain');
    expect(nombreSeguroParaFormato(una, 'text/plain')).toBe(una);
    // El CHECK del esquema exige 200 caracteres como máximo, extensión incluida.
    expect(nombreSeguroParaFormato('a'.repeat(400), 'application/pdf').length).toBe(200);
    expect(nombreSeguroParaFormato('a'.repeat(400), 'application/pdf').endsWith('.pdf')).toBe(true);
  });

  it('la validación de formato mira los BYTES, no la extensión ni el type del navegador', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(verificarArchivo(pdf, 'application/pdf').ok).toBe(true);
    // Un zip disfrazado de PDF: la firma no coincide.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(verificarArchivo(zip, 'application/pdf').ok).toBe(false);
    // Un ZIP pelado ya NO pasa por XLSX: los tres OOXML comparten la firma `PK`, así que
    // sin mirar dentro un .zip cualquiera —o un DOCX declarado como hoja de cálculo—
    // entraba como si fuera lo que dice ser.
    expect(
      verificarArchivo(
        zip,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ).ok,
    ).toBe(false);
    const ooxml = (parte: string) =>
      new Uint8Array([
        0x50, 0x4b, 0x03, 0x04,
        ...new TextEncoder().encode(`[Content_Types].xml${parte}`),
      ]);
    expect(
      verificarArchivo(
        ooxml('xl/workbook.xml'),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ).ok,
    ).toBe(true);
    // Y cada formato exige SU parte: un DOCX no cuela como XLSX ni al revés.
    expect(
      verificarArchivo(
        ooxml('word/document.xml'),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ).ok,
    ).toBe(false);
    expect(
      verificarArchivo(
        ooxml('word/document.xml'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ).ok,
    ).toBe(true);
    // RIFF que no es WebP (un WAV, por ejemplo).
    const riffFalso = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(verificarArchivo(riffFalso, 'image/webp').ok).toBe(false);
    // Formatos ejecutables en navegador: fuera de la allowlist, sin excepción.
    expect(verificarArchivo(new Uint8Array([0x3c, 0x73]), 'image/svg+xml').ok).toBe(false);
    expect(verificarArchivo(new Uint8Array([0x3c, 0x73]), 'text/html').ok).toBe(false);
    expect(verificarArchivo(new Uint8Array(), 'text/plain').ok).toBe(false);
  });

  it('un "texto" con controles no es texto: los adjuntos textuales pasan el mismo filtro', () => {
    const limpio = new TextEncoder().encode('col1,col2\n1,2\n');
    expect(verificarArchivo(limpio, 'text/csv').ok).toBe(true);
    const sucio = new TextEncoder().encode('col1,col2\n1,\u0007\n');
    expect(verificarArchivo(sucio, 'text/csv').ok).toBe(false);
    // UTF-8 inválido tampoco pasa como texto.
    expect(verificarArchivo(new Uint8Array([0xff, 0xfe, 0x41]), 'text/plain').ok).toBe(false);
  });

  it('el tipo declarado sale de la allowlist o de la extensión, nunca de la confianza', () => {
    expect(tipoDeclaradoDeArchivo('informe.pdf', '')).toBe('application/pdf');
    expect(tipoDeclaradoDeArchivo('informe.PDF', 'application/octet-stream')).toBe(
      'application/pdf',
    );
    expect(tipoDeclaradoDeArchivo('script.svg', 'image/svg+xml')).toBeNull();
    expect(tipoDeclaradoDeArchivo('sin-extension', '')).toBeNull();
  });

  it('el transporte base64 conserva los bytes exactos', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66]);
    const b64 = bytesABase64(bytes);
    expect(bytesDeBase64(b64)).toBe(bytes.length);
    expect([...base64ABytes(b64)]).toEqual([...bytes]);
  });

  it('el material importado no llega a ninguna superficie que interprete markup', () => {
    // La razón por la que NO hay sanitizador de HTML: el contenido importado se pinta
    // como texto, nunca como markup. Este test es el que sostiene esa afirmación.
    //
    // Hay UNA excepción en el repo y conviene que esté nombrada en vez de que el test se
    // relaje a `[]` vacío o desaparezca: el visor de diagramas de SPEC-05 inyecta el SVG
    // que produce mermaid. No toca esta promesa, y la razón es concreta: el diagrama se
    // arma solo con `etiqueta` y `condicion` del journey —texto que escribe el equipo en
    // la propia herramienta— y las evidencias entran ahí como CONTEO («este paso no tiene
    // evidencia»), nunca como texto. Además ese texto pasa por el neutralizador de
    // `journey.mermaid.ts` (comillas, corchetes y saltos) y mermaid corre con
    // `securityLevel: 'strict'`. Es decir: por esa puerta no pasa material de terceros.
    //
    // La lista es EXACTA a propósito. Si aparece un segundo uso —o si el primero se mueve
    // de fichero— este test falla y obliga a repetir el razonamiento en vez de heredarlo.
    const raiz = join(import.meta.dirname, '..', '..');
    // Solo el USO real (atributo JSX o propiedad); las menciones en prosa de los
    // comentarios que documentan esta decisión no son una superficie.
    const uso = /dangerouslySetInnerHTML\s*[=:]/;
    const sospechosos: string[] = [];
    const recorrer = (dir: string) => {
      for (const entrada of readdirSync(dir)) {
        const ruta = join(dir, entrada);
        if (statSync(ruta).isDirectory()) {
          recorrer(ruta);
        } else if (/\.tsx?$/.test(entrada) && !ruta.endsWith('sanitizacion.test.ts')) {
          if (uso.test(readFileSync(ruta, 'utf-8'))) sospechosos.push(ruta);
        }
      }
    };
    recorrer(raiz);
    expect(sospechosos.map((r) => r.slice(raiz.length + 1))).toEqual([
      'components/journey/DiagramaMermaid.tsx',
    ]);
  });
});
