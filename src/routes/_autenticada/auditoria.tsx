import { useState } from 'react';
import type { CSSProperties } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { ETIQUETA_ROL } from '@/lib/auth/auth.schemas';
import { auditoriaDelWorkspace } from '@/lib/portal/portal.functions';
import { ROLES_AUDITORIA, type EventoAuditoria } from '@/lib/portal/portal.schemas';

/**
 * Auditoría del workspace (SPEC-01, RF-01.6): el flujo append-only de evento_dominio con
 * su actor y su rol, filtrable por tipo y paginado por keyset. La consultan el admin del
 * cliente y el lead de la boutique; para los demás roles no existe — y no por esconder el
 * enlace: la política RLS de evento_dominio les devuelve cero filas.
 */
export const Route = createFileRoute('/_autenticada/auditoria')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    return workspaceId ? auditoriaDelWorkspace({ data: { workspaceId } }) : null;
  },
  component: PantallaAuditoria,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

function PantallaAuditoria() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const rol = membresiaActiva?.rol ?? '';
  const puedeVer = (ROLES_AUDITORIA as readonly string[]).includes(rol);
  const [tipo, setTipo] = useState('');
  // Página en curso: null = la del loader (primera, sin filtro). El filtro y el «cargar
  // más» toman el relevo en el cliente, como la bandeja de importación.
  const [pagina, setPagina] = useState<{ eventos: EventoAuditoria[]; hayMas: boolean } | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eventos = pagina ? pagina.eventos : (datos?.eventos ?? []);
  const hayMas = pagina ? pagina.hayMas : (datos?.hayMas ?? false);

  async function cambiarTipo(nuevo: string) {
    setTipo(nuevo);
    setError(null);
    if (!datos || nuevo === '') {
      setPagina(null);
      return;
    }
    setCargando(true);
    try {
      const r = await auditoriaDelWorkspace({ data: { workspaceId: datos.workspaceId, tipo: nuevo } });
      if (r) setPagina({ eventos: r.eventos, hayMas: r.hayMas });
    } catch {
      setError('No se pudo filtrar la auditoría; intenta de nuevo');
    } finally {
      setCargando(false);
    }
  }

  async function cargarMas() {
    const ultimo = eventos[eventos.length - 1];
    if (!datos || !ultimo) return;
    setCargando(true);
    setError(null);
    try {
      const r = await auditoriaDelWorkspace({
        data: { workspaceId: datos.workspaceId, tipo: tipo || undefined, antesDe: ultimo.id },
      });
      if (r) setPagina({ eventos: [...eventos, ...r.eventos], hayMas: r.hayMas });
    } catch {
      setError('No se pudieron cargar más eventos; intenta de nuevo');
    } finally {
      setCargando(false);
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
            Auditoría del workspace
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
          gap: 16,
        }}
      >
        {!membresiaActiva && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}
        {membresiaActiva && !puedeVer && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              La auditoría del workspace la consultan el admin del cliente y el lead de la
              boutique. Tu rol ({ETIQUETA_ROL[rol] ?? rol}) participa en el portal, no en el
              registro de auditoría.
            </span>
          </Card>
        )}
        {membresiaActiva && puedeVer && !datos && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Tu sesión ya no tiene acceso a este workspace; vuelve a entrar.
            </span>
          </Card>
        )}
        {datos && puedeVer && (
          <>
            <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ font: '400 13px/1.55 var(--font-sans)', color: 'var(--text-muted)' }}>
                Registro append-only de lo que pasó en el workspace: quién, con qué rol y
                cuándo. Ni la aplicación puede editarlo o borrarlo (RF-01.6).
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={micro}>Tipo de evento</span>
                <Select
                  value={tipo}
                  disabled={cargando}
                  onChange={(e) => void cambiarTipo(e.target.value)}
                  style={{ minWidth: 240 }}
                >
                  <option value="">Todos los tipos</option>
                  {datos.tipos.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </label>
            </Card>

            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}

            <div style={micro}>
              {eventos.length === 0
                ? 'Sin eventos para este filtro'
                : `${eventos.length}${hayMas ? '+' : ''} eventos${tipo ? ` de tipo ${tipo}` : ''}`}
            </div>

            {eventos.map((evento) => (
              <FilaEvento key={evento.id} evento={evento} />
            ))}

            {hayMas && (
              <div>
                <Button size="sm" variant="secondary" disabled={cargando} onClick={() => void cargarMas()}>
                  {cargando ? 'Cargando…' : 'Cargar eventos más antiguos'}
                </Button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function FilaEvento({ evento }: { evento: EventoAuditoria }) {
  return (
    <Card style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Tag>{evento.tipo}</Tag>
        <span style={{ font: '400 12px var(--font-mono)', color: 'var(--text-muted)' }}>
          {/* El instante viaja como texto de la base: se muestra hasta el minuto. */}
          {evento.creadoEn.slice(0, 16)}
        </span>
        <span
          style={{
            font: '500 12.5px var(--font-sans)',
            color: 'var(--text-body)',
            flex: 1,
            minWidth: 160,
          }}
        >
          {/* El actor puede no ser miembro hoy (o ser el sistema): el rol CONGELADO del
              evento sigue diciendo con qué autoridad se hizo. */}
          {evento.actorNombre ?? (evento.actorId ? 'Miembro retirado' : 'Sistema')}
          {evento.actorRol ? ` · ${ETIQUETA_ROL[evento.actorRol] ?? evento.actorRol}` : ''}
        </span>
      </div>
      {evento.payload !== '{}' && (
        <span
          style={{
            font: '400 11.5px/1.5 var(--font-mono)',
            color: 'var(--text-faint)',
            overflowWrap: 'anywhere',
          }}
        >
          {evento.payload}
        </span>
      )}
    </Card>
  );
}
