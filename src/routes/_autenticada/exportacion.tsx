import { useState } from 'react';
import type { CSSProperties } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Wordmark } from '@/components/ui/Wordmark';
import { exportarWorkspaceFn } from '@/lib/exportacion/exportacion.functions';
import {
  AMBITOS_EXPORT,
  ETIQUETA_AMBITO_EXPORT,
  nombreDeArchivoExport,
  type AmbitoExport,
  type Manifiesto,
} from '@/lib/exportacion/exportacion.schemas';

/**
 * Exportación del workspace (SPEC-01, RF-01.8 / SYS-04) y del paquete entregable
 * (SPEC-03, RF-03.10). Dos ámbitos con dos reglas distintas y ambas correctas:
 * el archivo del propietario lo lleva TODO; el entregable solo lo que tiene derechos
 * vigentes, y lista lo que dejó fuera con el motivo.
 *
 * Sin loader: exportar deja auditoría, así que es una acción explícita del usuario
 * (POST), no algo que ocurra al navegar.
 */
export const Route = createFileRoute('/_autenticada/exportacion')({
  component: PantallaExportacion,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const ROLES_EXPORT = ['lead-boutique', 'admin-cliente'];

function PantallaExportacion() {
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const [ambito, setAmbito] = useState<AmbitoExport>('archivo');
  const [error, setError] = useState<string | null>(null);
  const [manifiesto, setManifiesto] = useState<Manifiesto | null>(null);
  // Se conserva el evidenciaId que ya manda el backend: dos evidencias pueden llamarse
  // igual, y una clave compuesta por título y motivo colisionaría justo en ese caso.
  const [bloqueadas, setBloqueadas] = useState<
    { evidenciaId: string; titulo: string; motivo: string }[]
  >([]);
  const [exportando, setExportando] = useState(false);

  const workspaceId = membresiaActiva?.workspaceId;
  const puedeExportar = ROLES_EXPORT.includes(membresiaActiva?.rol ?? '');

  async function exportar() {
    if (!workspaceId) return;
    setExportando(true);
    setError(null);
    // El recibo anterior se descarta ANTES de pedir nada. Si el intento nuevo falla, dejar
    // en pantalla el manifiesto y las bloqueadas de la vez anterior hace creer que ese
    // recibo es de esta operación — y un manifiesto que no acredita la operación que se
    // está mirando es exactamente lo que SYS-04 no puede permitir. La misma tesis que
    // obliga a que el paquete salga de una sola foto obliga a que la pantalla no cosa dos.
    setManifiesto(null);
    setBloqueadas([]);
    try {
      const r = await exportarWorkspaceFn({ data: { workspaceId, ambito } });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setManifiesto(r.exportacion.manifiesto);
      setBloqueadas(
        r.exportacion.bloqueadas.map((b) => ({
          evidenciaId: b.evidenciaId,
          titulo: b.titulo,
          motivo: b.motivo,
        })),
      );
      const blob = new Blob([JSON.stringify(r.exportacion, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nombreDeArchivoExport(
        r.exportacion.manifiesto.workspaceNombre,
        ambito,
        r.exportacion.manifiesto.generadoEn,
      );
      a.click();
      // El revoke va al siguiente tick: revocar justo después del click cancela o trunca
      // la descarga en navegadores que aún no han empezado a leer el blob (Safari).
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError('No se pudo generar la exportación; intenta de nuevo');
    } finally {
      setExportando(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-app)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 28px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Wordmark />
          <span style={{ font: '600 13px var(--font-sans)', color: 'var(--text-body)' }}>
            Exportación del workspace
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main
        style={{
          maxWidth: 860,
          margin: '0 auto',
          padding: '28px 24px 60px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        {!workspaceId && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}

        {workspaceId && (
          <>
            <Card style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
                Formatos abiertos, ejecución registrada
              </span>
              <span style={{ font: '400 13px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
                La organización cliente es dueña de su workspace: el archivo completo
                incluye todos sus objetos, sus derivados y la auditoría, con un manifiesto
                que declara cuántas filas salieron por tabla y el sha256 de cada adjunto.
                Cada ejecución queda auditada en el propio workspace.
              </span>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={etiqueta}>Ámbito</span>
                <Select
                  value={ambito}
                  onChange={(e) => setAmbito(e.target.value as AmbitoExport)}
                >
                  {AMBITOS_EXPORT.map((a) => (
                    <option key={a} value={a}>
                      {ETIQUETA_AMBITO_EXPORT[a]}
                    </option>
                  ))}
                </Select>
              </label>
              {!puedeExportar && (
                <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
                  La exportación la ejecuta el admin del cliente o el lead de la boutique.
                </span>
              )}
              <div>
                <Button disabled={exportando || !puedeExportar} onClick={() => void exportar()}>
                  {exportando ? 'Generando…' : 'Exportar y descargar'}
                </Button>
              </div>
            </Card>

            {error && (
              <span
                role="alert"
                style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}
              >
                {error}
              </span>
            )}

            {manifiesto && (
              <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span style={{ font: '700 14px var(--font-sans)', color: 'var(--ink)' }}>
                  Manifiesto — {manifiesto.workspaceNombre} · {manifiesto.ambito}
                </span>
                <span style={{ font: '400 12px var(--font-mono)', color: 'var(--text-muted)' }}>
                  {manifiesto.generadoEn} · rol {manifiesto.generadoPorRol}
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px' }}>
                  {Object.entries(manifiesto.conteos).map(([tabla, n]) => (
                    <span
                      key={tabla}
                      style={{ font: '400 12px var(--font-mono)', color: 'var(--text-body)' }}
                    >
                      {tabla} <strong>{n}</strong>
                    </span>
                  ))}
                </div>
                {/* La otra mitad del recibo: cuántas filas EXISTÍAN y se quedaron fuera
                    por derechos. Solo aparecen las tablas con algo podado — una tabla que
                    no viaja por diseño no tiene «filas podadas», y anotarle un cero
                    insinuaría una restricción que no existe. */}
                {Object.entries(manifiesto.podadasPorDerechos).some(([, n]) => n > 0) && (
                  <span
                    style={{ font: '400 12px var(--font-mono)', color: 'var(--warn)' }}
                  >
                    podadas por derechos:{' '}
                    {Object.entries(manifiesto.podadasPorDerechos)
                      .filter(([, n]) => n > 0)
                      .map(([tabla, n]) => `${tabla} ${n}`)
                      .join(' · ')}
                  </span>
                )}
                <span style={{ font: '400 12px var(--font-mono)', color: 'var(--text-body)' }}>
                  adjuntos: {manifiesto.adjuntos.incluidos}/{manifiesto.adjuntos.total} incluidos
                  ({(manifiesto.adjuntos.bytesIncluidos / 1024).toFixed(0)} KB
                  {manifiesto.adjuntos.omitidos > 0
                    ? ` · ${manifiesto.adjuntos.omitidos} omitidos por presupuesto, con su sha256 en el inventario`
                    : ''}
                  )
                </span>
              </Card>
            )}

            {/* Lo excluido por derechos JAMÁS desaparece en silencio (SYS-14/SYS-17). */}
            {bloqueadas.length > 0 && (
              <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ font: '700 14px var(--font-sans)', color: 'var(--warn)' }}>
                  {bloqueadas.length} evidencia(s) fuera del entregable por derechos
                </span>
                {bloqueadas.map((b) => (
                  <span
                    key={b.evidenciaId}
                    style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}
                  >
                    <strong>{b.titulo}</strong> — {b.motivo}
                  </span>
                ))}
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  );
}
