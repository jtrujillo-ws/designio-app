import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Wordmark } from '@/components/ui/Wordmark';
import { establecerPassword } from '@/lib/auth/auth.functions';

/** Aterrizaje del enlace de invitación: fija la contraseña y entra directo al workspace. */
export const Route = createFileRoute('/invitacion/$token')({
  component: PantallaInvitacion,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

function PantallaInvitacion() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmar, setConfirmar] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError('La contraseña necesita al menos 10 caracteres');
      return;
    }
    if (password !== confirmar) {
      setError('Las contraseñas no coinciden');
      return;
    }
    setEnviando(true);
    try {
      const r = await establecerPassword({ data: { token, password } });
      if (r.ok) {
        await navigate({ to: '/app' });
        return;
      }
      setError(r.error);
    } catch {
      setError('No se pudo activar la cuenta; intenta de nuevo');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-app)' }}>
      <Card style={{ width: 'min(400px, calc(100vw - 32px))', padding: 32, borderRadius: 14 }}>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Wordmark size={26} />
            <span style={{ font: '400 13.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
              Te invitaron a un workspace. Elige tu contraseña para activar la cuenta.
            </span>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Contraseña nueva</span>
            <Input
              type="password"
              name="password"
              autoComplete="new-password"
              required
              minLength={10}
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="mínimo 10 caracteres"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Confirma la contraseña</span>
            <Input
              type="password"
              name="confirmar"
              autoComplete="new-password"
              required
              minLength={10}
              value={confirmar}
              onChange={(e) => setConfirmar(e.target.value)}
            />
          </label>
          {error && (
            <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
              {error}
            </span>
          )}
          <Button type="submit" disabled={enviando} style={{ justifyContent: 'center' }}>
            {enviando ? 'Activando…' : 'Activar y entrar'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
