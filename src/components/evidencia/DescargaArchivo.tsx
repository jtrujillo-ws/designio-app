import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { contenidoDeArchivo } from '@/lib/evidencia/evidencia.functions';
import { base64ABytes } from '@/lib/evidencia/sanitizacion';
import type { ArchivoAdjunto } from '@/lib/evidencia/evidencia.schemas';

/**
 * Descarga de un adjunto (RF-03.1). Los bytes llegan base64 por la server function y el
 * navegador arma el Blob: no hay ruta HTTP de binarios, así que el acceso pasa por el
 * mismo camino (sesión → RLS) que el resto de los datos.
 *
 * El Blob se crea SIEMPRE como `application/octet-stream`, nunca con el MIME real: el
 * material importado es contenido de terceros y no queremos que el navegador lo abra ni
 * lo interprete en el contexto de la aplicación — se guarda y se abre fuera. Es el
 * equivalente en el cliente de servir con `Content-Disposition: attachment` + `nosniff`.
 */
export function DescargaArchivo({
  archivo,
  workspaceId,
  onError,
  onRetirar,
}: {
  archivo: ArchivoAdjunto;
  workspaceId: string;
  onError: (e: string | null) => void;
  onRetirar?: () => Promise<void>;
}) {
  const [bajando, setBajando] = useState(false);

  async function descargar() {
    setBajando(true);
    onError(null);
    try {
      const r = await contenidoDeArchivo({ data: { workspaceId, archivoId: archivo.id } });
      if (!r) {
        onError('El adjunto ya no está disponible');
        return;
      }
      const blob = new Blob([base64ABytes(r.contenidoBase64) as unknown as BlobPart], {
        type: 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.nombre;
      a.click();
      // El revoke va al siguiente tick: revocar justo después del click cancela o trunca
      // la descarga en navegadores que aún no han empezado a leer el blob (Safari).
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      onError('No se pudo descargar el adjunto; intenta de nuevo');
    } finally {
      setBajando(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span
        style={{
          font: '400 12px var(--font-mono)',
          color: 'var(--text-body)',
          overflowWrap: 'anywhere',
        }}
      >
        {archivo.nombre}
      </span>
      <span style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)' }}>
        {(archivo.bytes / 1024).toFixed(0)} KB · {archivo.tipoMime}
      </span>
      {/* El hash publica la integridad del original: el mismo que viaja en el manifiesto
          de exportación, para poder verificar que el archivo no cambió. */}
      <span
        title={`sha256: ${archivo.sha256}`}
        style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)' }}
      >
        sha256 {archivo.sha256.slice(0, 12)}…
      </span>
      <Button size="sm" variant="ghost" disabled={bajando} onClick={() => void descargar()}>
        {bajando ? 'Descargando…' : 'Descargar'}
      </Button>
      {onRetirar && (
        <Button size="sm" variant="ghost" onClick={() => void onRetirar()}>
          Retirar
        </Button>
      )}
    </div>
  );
}
