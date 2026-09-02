import { useEffect, useRef, useState } from 'react';

/**
 * Render del diagrama Mermaid (RF-05.3: «exportable — imagen y código»).
 *
 * La librería se carga con `import()` dinámico y solo cuando esta pestaña se abre:
 * mermaid pesa, y el 90% de las visitas a un journey van al modelo o al blueprint. El
 * resultado es un SVG en el DOM — de ahí salen las dos exportaciones sin volver a
 * renderizar nada.
 *
 * El código que entra ya viene neutralizado por `mermaidDeJourney`, que sustituye
 * comillas, corchetes y saltos del texto del usuario; aun así el SVG se inserta con
 * `securityLevel: 'strict'`, que desactiva el HTML incrustado y los scripts de mermaid.
 */
export function DiagramaMermaid({ codigo }: { codigo: string }) {
  const contenedor = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    setError(null);
    setSvg(null);
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          // 'strict' desinfecta el SVG y prohíbe HTML dentro de las etiquetas: el texto
          // del diagrama viene del usuario, así que se trata como texto y punto.
          securityLevel: 'strict',
          theme: 'neutral',
          flowchart: { htmlLabels: false, useMaxWidth: true },
        });
        const id = `dg${Math.random().toString(36).slice(2, 10)}`;
        const { svg: generado } = await mermaid.render(id, codigo);
        if (vigente) setSvg(generado);
      } catch (e) {
        // Que el render falle no puede tumbar la pantalla: el código sigue abajo y el
        // modelo —que es lo que gobierna— está intacto en su pestaña.
        if (vigente) setError(e instanceof Error ? e.message : 'No se pudo dibujar el diagrama');
      }
    })();
    return () => {
      vigente = false;
    };
  }, [codigo]);

  function descargarSvg() {
    if (!svg) return;
    descargar(new Blob([svg], { type: 'image/svg+xml' }), 'journey.svg');
  }

  /** PNG desde el SVG ya renderizado: se pinta en un canvas al doble de tamaño para que
   * la imagen sirva en una presentación y no solo en pantalla.
   *
   * El SVG llega a la imagen por un Blob URL y no por un `data:` en base64: `btoa` solo
   * acepta latin-1, así que el camino clásico necesita `unescape(encodeURIComponent(…))`
   * —deprecado— y aun así revienta con etiquetas fuera del BMP (un emoji en el nombre de
   * un paso) o con un diagrama grande, porque base64 crece un tercio y la cadena tiene
   * techo. El Blob va en bytes y no tiene ninguno de los dos problemas. */
  function descargarPng() {
    const nodo = contenedor.current?.querySelector('svg');
    if (!svg || !nodo) return;
    const caja = nodo.getBoundingClientRect();
    const escala = 2;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const imagen = new Image();
    imagen.onload = () => {
      try {
        const lienzo = document.createElement('canvas');
        lienzo.width = Math.max(1, Math.round(caja.width * escala));
        lienzo.height = Math.max(1, Math.round(caja.height * escala));
        const ctx = lienzo.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, lienzo.width, lienzo.height);
        ctx.drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
        lienzo.toBlob((b) => b && descargar(b, 'journey.png'), 'image/png');
      } finally {
        // Aquí sí se revoca en el acto: el consumidor es esta imagen, ya terminó de
        // leerla, y nada más va a pedir el URL (a diferencia de la descarga, donde el
        // que lee es el navegador y todavía no ha empezado).
        URL.revokeObjectURL(url);
      }
    };
    imagen.onerror = () => {
      URL.revokeObjectURL(url);
      setError('No se pudo convertir el diagrama a PNG');
    };
    imagen.src = url;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={descargarSvg} disabled={!svg} style={boton}>
          Descargar SVG
        </button>
        <button type="button" onClick={descargarPng} disabled={!svg} style={boton}>
          Descargar PNG
        </button>
      </div>
      {error && (
        <span role="alert" style={{ font: '500 12.5px var(--font-sans)', color: 'var(--danger)' }}>
          {error} · el código de abajo sigue siendo válido y copiable.
        </span>
      )}
      {!svg && !error && (
        <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
          Dibujando el diagrama…
        </span>
      )}
      <div
        ref={contenedor}
        // El SVG lo produce mermaid con securityLevel 'strict', que lo desinfecta antes
        // de devolverlo; el texto de origen ya venía neutralizado por mermaidDeJourney.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
        style={{
          overflowX: 'auto',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)',
          padding: 14,
          minHeight: svg ? undefined : 0,
        }}
      />
    </div>
  );
}

const boton = {
  fontFamily: 'var(--font-sans)',
  fontWeight: 600,
  fontSize: 12.5,
  color: 'var(--ink)',
  background: 'var(--surface)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 12px',
  cursor: 'pointer',
} as const;

function descargar(blob: Blob, nombre: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  // El revoke va al siguiente tick: revocar justo después del click cancela o trunca la
  // descarga en navegadores que aún no han empezado a leer el blob (Safari).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
