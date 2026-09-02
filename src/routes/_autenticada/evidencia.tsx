import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { DescargaArchivo } from '@/components/evidencia/DescargaArchivo';
import {
  decidirDerechosDeEvidencia,
  evidenciaConDerechos,
} from '@/lib/evidencia/evidencia.functions';
import {
  AMBITOS_USO,
  ETIQUETA_AMBITO,
  ROLES_DERECHOS,
  type AmbitoUso,
  type EvidenciaConDerechos,
} from '@/lib/evidencia/evidencia.schemas';

/**
 * Evidencia curada y sus DERECHOS DE USO (SPEC-03, RF-03.10 / SYS-14). Los derechos
 * nacen pendientes: hasta que alguien los concede con una base documental, la evidencia
 * existe pero no se cita en un gate ni sale en un entregable. Esta pantalla es donde ese
 * acto ocurre — y donde el bloqueo se explica en lugar de esconderse.
 */
export const Route = createFileRoute('/_autenticada/evidencia')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    return workspaceId ? evidenciaConDerechos({ data: { workspaceId } }) : null;
  },
  component: PantallaEvidencia,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const COLOR_DERECHOS: Record<string, string> = {
  concedido: 'var(--accent)',
  pendiente: 'var(--warn)',
  denegado: 'var(--danger)',
};

function PantallaEvidencia() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const rol = membresiaActiva?.rol ?? '';
  // Conceder derechos es un acto contractual: lo hace quien opera el engagement o quien
  // administra los datos del cliente. El servidor lo re-valida (capa 2) y la política
  // RLS es la capa 1: aquí solo se evita ofrecer un control que sería rechazado.
  const puedeDecidir = (ROLES_DERECHOS as readonly string[]).includes(rol);
  const [error, setError] = useState<string | null>(null);

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
            Evidencia y derechos de uso
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '28px 24px 60px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        {!datos && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}
        {datos && (
          <>
            <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
                Los derechos restringen el uso aguas abajo
              </span>
              <span
                style={{ font: '400 13px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}
              >
                Una evidencia sin derechos vigentes para el ámbito «cliente» no puede citarse
                en el checklist de un gate ni salir en un paquete entregable. No es una regla
                de esta pantalla: la impone la base de datos, así que tampoco se la salta una
                consulta directa.
              </span>
            </Card>

            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}

            <div style={etiqueta}>
              {datos.evidencias.length === 0
                ? 'Todavía no hay evidencia curada'
                : `${datos.evidencias.length}${datos.hayMas ? '+' : ''} evidencias · ${datos.evidencias.filter((e) => e.citable).length} citables`}
            </div>

            {datos.evidencias.map((ev) => (
              <TarjetaEvidencia
                key={ev.id}
                evidencia={ev}
                workspaceId={datos.workspaceId}
                puedeDecidir={puedeDecidir}
                onCambio={() => router.invalidate()}
                onError={setError}
              />
            ))}
          </>
        )}
      </main>
    </div>
  );
}

function TarjetaEvidencia({
  evidencia,
  workspaceId,
  puedeDecidir,
  onCambio,
  onError,
}: {
  evidencia: EvidenciaConDerechos;
  workspaceId: string;
  puedeDecidir: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [decidiendo, setDecidiendo] = useState<'concedido' | 'denegado' | null>(null);

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            font: '700 14px var(--font-sans)',
            color: 'var(--ink)',
            flex: 1,
            minWidth: 200,
          }}
        >
          {evidencia.titulo}
        </span>
        {evidencia.esEstadoActual && <Tag>Estado actual</Tag>}
        <span
          style={{
            font: '600 11.5px var(--font-sans)',
            color: COLOR_DERECHOS[evidencia.derechos.estado] ?? 'var(--text-faint)',
          }}
        >
          derechos: {evidencia.derechos.estado}
          {evidencia.derechos.estado === 'concedido'
            ? ` · ${evidencia.derechos.ambito}`
            : ''}
        </span>
      </div>

      {evidencia.resumen && (
        <p
          style={{
            font: '400 13px/1.6 var(--font-sans)',
            color: 'var(--text-body)',
            margin: 0,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {evidencia.resumen}
        </p>
      )}

      {evidencia.derechos.base && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Base: {evidencia.derechos.base}
          {evidencia.derechos.venceEn ? ` · vence el ${evidencia.derechos.venceEn}` : ''}
        </span>
      )}

      {/* El bloqueo se explica (SYS-14): nunca un "no puedes" sin la dimensión que falta. */}
      {!evidencia.citable && (
        <span
          role="status"
          style={{ font: '500 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}
        >
          No citable ni exportable como entregable — {evidencia.motivoBloqueo}
        </span>
      )}

      {evidencia.archivos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Originales adjuntos</span>
          {evidencia.archivos.map((a) => (
            <DescargaArchivo key={a.id} archivo={a} workspaceId={workspaceId} onError={onError} />
          ))}
        </div>
      )}

      {puedeDecidir && decidiendo === null && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button size="sm" onClick={() => setDecidiendo('concedido')}>
            {evidencia.derechos.estado === 'concedido' ? 'Cambiar concesión' : 'Conceder derechos'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDecidiendo('denegado')}>
            {evidencia.derechos.estado === 'concedido' ? 'Revocar' : 'Denegar'}
          </Button>
        </div>
      )}
      {!puedeDecidir && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Los derechos los decide el lead de la boutique o el admin del cliente.
        </span>
      )}
      {puedeDecidir && decidiendo !== null && (
        <FormularioDerechos
          workspaceId={workspaceId}
          evidenciaId={evidencia.id}
          decision={decidiendo}
          ambitoActual={evidencia.derechos.ambito}
          onListo={async () => {
            setDecidiendo(null);
            await onCambio();
          }}
          onCancelar={() => setDecidiendo(null)}
          onError={onError}
        />
      )}
    </Card>
  );
}

function FormularioDerechos({
  workspaceId,
  evidenciaId,
  decision,
  ambitoActual,
  onListo,
  onCancelar,
  onError,
}: {
  workspaceId: string;
  evidenciaId: string;
  decision: 'concedido' | 'denegado';
  ambitoActual: AmbitoUso;
  onListo: () => Promise<void>;
  onCancelar: () => void;
  onError: (e: string | null) => void;
}) {
  const [ambito, setAmbito] = useState<AmbitoUso>(ambitoActual);
  const [base, setBase] = useState('');
  const [venceEn, setVenceEn] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    onError(null);
    try {
      const r = await decidirDerechosDeEvidencia({
        data: {
          workspaceId,
          evidenciaId,
          decision,
          // Denegar no lleva ámbito ni vigencia (lo exige también el schema).
          ambito: decision === 'concedido' ? ambito : 'interno',
          base,
          venceEn: decision === 'concedido' && venceEn !== '' ? venceEn : null,
        },
      });
      if (r.ok) await onListo();
      else onError(r.error);
    } catch {
      onError('No se pudo registrar la decisión; intenta de nuevo');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        {decision === 'concedido' ? 'Conceder derechos de uso' : 'Denegar o revocar derechos'}
      </span>
      {decision === 'concedido' && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Ámbito máximo</span>
            <Select value={ambito} onChange={(e) => setAmbito(e.target.value as AmbitoUso)}>
              {AMBITOS_USO.map((a) => (
                <option key={a} value={a}>
                  {ETIQUETA_AMBITO[a]}
                </option>
              ))}
            </Select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Vence (opcional)</span>
            <Input type="date" value={venceEn} onChange={(e) => setVenceEn(e.target.value)} />
          </label>
        </div>
      )}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={etiqueta}>
          {decision === 'concedido' ? 'Base documental' : 'Motivo de la denegación'}
        </span>
        <Input
          required
          maxLength={500}
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder={
            decision === 'concedido'
              ? 'p. ej. consentimiento firmado 2026-08-12 · cláusula 7 del contrato'
              : 'p. ej. la entrevista se grabó sin consentimiento de uso externo'
          }
        />
      </label>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button type="submit" disabled={enviando}>
          {enviando ? 'Registrando…' : 'Registrar decisión'}
        </Button>
        <Button variant="ghost" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
