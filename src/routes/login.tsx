import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Wordmark } from '@/components/ui/Wordmark';
import { iniciarSesion, usuarioActual } from '@/lib/auth/auth.functions';

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    if (await usuarioActual()) throw redirect({ to: '/app' });
  },
  component: PantallaLogin,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

function PantallaLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      const r = await iniciarSesion({ data: { email, password } });
      if (r.ok) {
        await navigate({ to: '/app' });
        return;
      }
      setError(r.error);
    } catch {
      setError('No se pudo iniciar sesión; intenta de nuevo');
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
              Entra a tu workspace de service design.
            </span>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Correo</span>
            <Input
              type="email"
              name="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@organizacion.com"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Contraseña</span>
            <Input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
              {error}
            </span>
          )}
          <Button type="submit" disabled={enviando} style={{ justifyContent: 'center' }}>
            {enviando ? 'Entrando…' : 'Entrar'}
          </Button>
          <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-faint)' }}>
            ¿Sin cuenta? El acceso llega por invitación de tu workspace.
          </span>
        </form>
      </Card>
    </div>
  );
}
