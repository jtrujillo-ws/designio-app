import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { invitarMiembro, miembrosDelWorkspace } from '@/lib/auth/auth.functions';
import {
  ETIQUETA_ROL,
  ROLES_INVITABLES,
  type MiembroDeLista,
  type RolInvitable,
} from '@/lib/auth/auth.schemas';

/**
 * Personas y permisos (RF-01.2/01.4): la lista de miembros del workspace y el alta por
 * invitación. Sin correo saliente en el MVP, el enlace de activación se muestra aquí
 * para compartirlo; re-invitar al mismo email re-emite el enlace (invalida el anterior).
 */
export const Route = createFileRoute('/_autenticada/personas')({
  loader: ({ context }) => {
    const workspaceId = context.usuario.membresias[0]?.workspaceId;
    return workspaceId
      ? miembrosDelWorkspace({ data: { workspaceId } }).then((miembros) => ({ workspaceId, miembros }))
      : null;
  },
  component: PantallaPersonas,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const COLOR_ESTADO: Record<string, string> = {
  activo: 'var(--accent)',
  invitado: 'var(--warn)',
  inactivo: 'var(--text-faint)',
};

const TEXTO_ESTADO: Record<string, string> = {
  activo: 'activa',
  invitado: 'pendiente de activar',
  inactivo: 'inactiva',
};

function PantallaPersonas() {
  const datos = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
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
            Personas y permisos
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main style={{ maxWidth: 860, margin: '0 auto', padding: '28px 24px 60px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {!datos && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}
        {datos && (
          <>
            <FormularioInvitar
              workspaceId={datos.workspaceId}
              onCambio={() => router.invalidate()}
              onError={setError}
            />
            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}
            <div style={{ ...etiqueta, paddingTop: 6 }}>
              {(datos.miembros ?? []).length} miembros del workspace
            </div>
            {(datos.miembros ?? []).map((m) => (
              <FilaMiembro key={m.email} miembro={m} />
            ))}
          </>
        )}
      </main>
    </div>
  );
}

function FilaMiembro({ miembro }: { miembro: MiembroDeLista }) {
  return (
    <Card style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ font: '700 13.5px var(--font-sans)', color: 'var(--ink)', minWidth: 160 }}>
        {miembro.nombre}
      </span>
      <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)', flex: 1, minWidth: 180, overflowWrap: 'anywhere' }}>
        {miembro.email}
      </span>
      <Tag mono={false}>{ETIQUETA_ROL[miembro.rol] ?? miembro.rol}</Tag>
      <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ESTADO[miembro.estado] ?? 'var(--text-muted)' }}>
        cuenta {TEXTO_ESTADO[miembro.estado] ?? miembro.estado}
      </span>
    </Card>
  );
}

function FormularioInvitar({
  workspaceId,
  onCambio,
  onError,
}: {
  workspaceId: string;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [email, setEmail] = useState('');
  const [nombre, setNombre] = useState('');
  const [rol, setRol] = useState<RolInvitable>('stakeholder');
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<{ detalle: string; enlace: string | null } | null>(null);
  const [copiado, setCopiado] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    onError(null);
    setResultado(null);
    setCopiado(false);
    try {
      const r = await invitarMiembro({ data: { workspaceId, email, nombre, rol } });
      if (r.ok) {
        setResultado({ detalle: r.detalle, enlace: r.enlace });
        setEmail('');
        setNombre('');
        await onCambio();
      } else {
        onError(r.error);
      }
    } catch {
      onError('No se pudo invitar; intenta de nuevo');
    } finally {
      setEnviando(false);
    }
  }

  async function copiarEnlace(enlace: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${enlace}`);
      setCopiado(true);
    } catch {
      onError('No se pudo copiar; selecciona el enlace manualmente');
    }
  }

  return (
    <Card style={{ padding: 24 }}>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>Invitar a una persona</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.2fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Correo</span>
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@organizacion.com" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Nombre</span>
            <Input required maxLength={200} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre y apellido" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Rol</span>
            <Select value={rol} onChange={(e) => setRol(e.target.value as RolInvitable)}>
              {ROLES_INVITABLES.map((r) => (
                <option key={r} value={r}>
                  {ETIQUETA_ROL[r]}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div>
          <Button type="submit" disabled={enviando}>
            {enviando ? 'Invitando…' : 'Invitar'}
          </Button>
        </div>
        {resultado && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 14,
              background: 'var(--surface-sunken)',
              borderRadius: 'var(--r-sm)',
            }}
          >
            <span style={{ font: '500 13px var(--font-sans)', color: 'var(--text-body)' }}>{resultado.detalle}</span>
            {resultado.enlace && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Input
                  readOnly
                  value={resultado.enlace}
                  onFocus={(e) => e.target.select()}
                  style={{ flex: 1, minWidth: 240, fontFamily: 'var(--font-mono)', fontSize: 12 }}
                />
                <Button size="sm" variant="secondary" onClick={() => void copiarEnlace(resultado.enlace!)}>
                  {copiado ? 'Copiado ✓' : 'Copiar enlace'}
                </Button>
              </div>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}
