import type { CSSProperties } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { JourneyBadge } from '@/components/ui/JourneyBadge';
import { Tabs } from '@/components/ui/Tabs';
import { Wordmark } from '@/components/ui/Wordmark';
import { ETIQUETA_ROL } from '@/lib/auth/auth.schemas';
import { cerrarSesion } from '@/lib/auth/auth.functions';
import type { ArbolWorkspace } from '@/lib/arbol/arbol.schemas';
import { LOOP_BANCO_ANDINO, type JourneyLoop } from '@/lib/loop/loop-data';
import { ROLES_AUDITORIA } from '@/lib/portal/portal.schemas';

/** Pantalla Loop J1–J7 — recreación de la referencia hifi del design system (ui_kits/designio). */

/** Lo que la pantalla necesita del usuario autenticado (lo publica el guard de /_autenticada). */
export type MembresiaLoop = { workspaceId: string; workspaceNombre: string; rol: string };
export type UsuarioLoop = {
  nombre: string;
  membresias: MembresiaLoop[];
};

const TABS = [
  'Loop J1–J7',
  'Servicio',
  'Reto R-01',
  'Proyecto P-01',
  'Journey / Blueprint',
  'Portal · Aprobación G5',
  'Importación',
];

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
};

export function LoopScreen({
  usuario,
  membresiaActiva,
  arbol,
}: {
  usuario: UsuarioLoop;
  membresiaActiva: MembresiaLoop | undefined;
  arbol: ArbolWorkspace | null;
}) {
  const servicio = arbol?.servicios[0] ?? null;
  return (
    <div>
      <Topbar usuario={usuario} membresiaActiva={membresiaActiva} />
      <div style={{ display: 'flex', minHeight: 780 }}>
        <Sidebar arbol={arbol} rol={membresiaActiva?.rol ?? ''} />
        <main style={{ flex: 1, padding: '28px 32px', minWidth: 0 }}>
          <div style={{ ...micro, color: 'var(--text-muted)' }}>
            {arbol?.workspaceNombre ?? '—'} / Servicios /{' '}
            <span style={{ color: 'var(--ink)' }}>{servicio?.nombre ?? 'Sin servicios aún'}</span>
          </div>
          <div style={{ margin: '16px 0 24px' }}>
            <Tabs items={TABS} value="Loop J1–J7" label="Vistas del servicio" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
            <h1 style={{ font: '800 30px/1.12 var(--font-sans)', margin: 0 }}>
              El loop del método · journeys J1–J7
            </h1>
            <span
              style={{
                font: '700 11px var(--font-sans)',
                color: 'var(--accent)',
                background: 'var(--accent-soft)',
                borderRadius: 'var(--r-pill)',
                padding: '4px 12px',
              }}
            >
              vista de recorrido
            </span>
          </div>
          <p style={{ font: '400 14px/1.5 var(--font-sans)', color: 'var(--text-muted)', maxWidth: 760, margin: '0 0 24px' }}>
            Los siete recorridos de la plataforma, de la importación al post mortem, con su estado en el
            ejemplo Banco Andino. El arco de color marca la posición de cada journey en el método.
          </p>
          <div style={{ height: 6, borderRadius: 'var(--r-pill)', background: 'var(--grad-arco)', marginBottom: 16 }} />
          <div style={{ overflowX: 'auto', marginBottom: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(158px, 1fr))', gap: 12, minWidth: 1178 }}>
              {LOOP_BANCO_ANDINO.map((jl) => (
                <JourneyCard key={jl.j} jl={jl} />
              ))}
            </div>
          </div>
          <Card style={{ padding: '16px 20px', borderRadius: 14 }}>
            <span style={{ font: '400 13.5px/1.55 var(--font-sans)', color: 'var(--text-body)' }}>
              <strong>El loop cierra:</strong> los retos candidatos del post mortem (J7) pre-pueblan la etapa 0
              del siguiente reto (J2) con la memoria del propio workspace
              {(() => {
                // La narrativa es J7→J2 sobre el servicio ACTUAL (el del breadcrumb):
                // solo candidatos de este servicio nacidos del post mortem.
                const candidatos =
                  servicio?.retos.filter((r) => r.estado === 'candidato' && r.origen === 'post-mortem') ?? [];
                if (candidatos.length === 0) return ' — el backlog del servicio espera su primer candidato.';
                return (
                  <>
                    {' — '}
                    {candidatos.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 && (i === candidatos.length - 1 ? ' y ' : ', ')}
                        <a href="#retos">{r.codigo}</a>
                      </span>
                    ))}
                    {candidatos.length === 1 ? ' ya espera' : ' ya esperan'} en el backlog del servicio.
                  </>
                );
              })()}
            </span>
          </Card>
        </main>
      </div>
    </div>
  );
}

function JourneyCard({ jl }: { jl: JourneyLoop }) {
  const active = jl.estado === 'en curso';
  const pending = jl.estado === 'próximo';
  return (
    <Card
      j={jl.j}
      active={active}
      pending={pending}
      style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: active ? 15 : '16px 16px 13px' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <JourneyBadge j={jl.j} />
        <Chip estado={jl.estado} />
      </div>
      <div style={{ font: '700 14.5px/1.25 var(--font-sans)', color: 'var(--ink)' }}>{jl.titulo}</div>
      <div style={{ font: '400 11.5px/1.5 var(--font-mono)', color: 'var(--text-muted)' }}>{jl.meta}</div>
      <div style={{ font: '600 12px var(--font-sans)', color: 'var(--text-body)', marginTop: 'auto' }}>{jl.rol}</div>
    </Card>
  );
}

function inicialesDe(nombre: string): string {
  const partes = nombre.trim().split(/\s+/);
  return (
    partes
      .slice(0, 2)
      .map((p) => (p[0] ?? '').toUpperCase())
      .join('') || '?'
  );
}

function Topbar({
  usuario,
  membresiaActiva,
}: {
  usuario: UsuarioLoop;
  membresiaActiva: MembresiaLoop | undefined;
}) {
  const navigate = useNavigate();
  const membresia = membresiaActiva ?? usuario.membresias[0];

  async function salir() {
    await cerrarSesion();
    await navigate({ to: '/login' });
  }

  function cambiarWorkspace(ws: string) {
    // `ws` viaja pegado a la navegación (retainSearchParams): basta con fijarlo aquí
    // y los loaders de la pantalla actual reaccionan (loaderDeps sobre ws).
    void navigate({ to: '.', search: (prev) => ({ ...prev, ws }) });
  }

  return (
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
        {usuario.membresias.length > 1 ? (
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              font: '600 13px var(--font-sans)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--r-pill)',
              padding: '5px 14px',
            }}
          >
            <span aria-hidden>●</span>
            <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
              Workspace activo
            </span>
            <select
              value={membresia?.workspaceId ?? ''}
              onChange={(e) => cambiarWorkspace(e.target.value)}
              style={{
                font: 'inherit',
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                outlineOffset: 4,
              }}
            >
              {usuario.membresias.map((m) => (
                <option key={m.workspaceId} value={m.workspaceId}>
                  {m.workspaceNombre}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span
            style={{
              font: '600 13px var(--font-sans)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--r-pill)',
              padding: '5px 14px',
            }}
          >
            ● {membresia?.workspaceNombre ?? 'Sin workspace'}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Input placeholder="Buscar en el workspace…  /" style={{ background: 'var(--bg-app)', border: '1px solid var(--border)', width: 280 }} />
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'var(--grad-arco)',
            color: '#fff',
            font: '700 12px/32px var(--font-sans)',
            textAlign: 'center',
          }}
        >
          {inicialesDe(usuario.nombre)}
        </span>
        <span style={{ font: '500 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
          {usuario.nombre}
          {membresia ? ` · ${ETIQUETA_ROL[membresia.rol] ?? membresia.rol}` : ''}
        </span>
        <Button variant="ghost" size="sm" onClick={salir}>
          Salir
        </Button>
      </div>
    </div>
  );
}

const filaArbol: CSSProperties = {
  font: '400 12.5px var(--font-sans)',
  color: 'var(--text-muted)',
  padding: '5px 10px 5px 34px',
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
};

const truncado: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

function Sidebar({ arbol, rol }: { arbol: ArbolWorkspace | null; rol: string }) {
  const item: CSSProperties = {
    font: '500 13px var(--font-sans)',
    color: 'var(--text-body)',
    padding: '7px 10px',
    borderRadius: 'var(--r-sm)',
    display: 'flex',
    justifyContent: 'space-between',
  };
  return (
    <aside
      style={{
        width: 250,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        padding: '20px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ ...micro, fontSize: 10, color: 'var(--text-faint)', padding: '0 10px 6px' }}>Cliente</div>
      <div style={{ font: '700 13.5px var(--font-sans)', padding: '7px 10px' }}>
        {arbol?.workspaceNombre ?? '—'}
      </div>
      {(arbol?.servicios.length ?? 0) === 0 && (
        <div style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)', padding: '5px 10px 5px 22px' }}>
          Sin servicios aún
        </div>
      )}
      {arbol?.servicios.map((servicio, indice) => (
        <div key={servicio.id}>
          <div
            style={{
              font: '600 13px var(--font-sans)',
              color: 'var(--text-body)',
              padding: '6px 10px 6px 22px',
              // Resaltado solo el servicio "actual" (el primero, el que muestra el
              // breadcrumb); el selector de servicio llegará con más de uno.
              background: indice === 0 ? 'var(--accent-soft)' : undefined,
              borderRadius: 'var(--r-sm)',
              ...truncado,
            }}
          >
            {servicio.nombre}
          </div>
          {/* Lo que el servicio hace HOY (RF-06.10). Va bajo su nombre y no dentro de un
              reto porque el estado efectivo es del SERVICIO: lo dejan ahí los releases
              verificados de cualquiera de sus design versions, sea cual sea el proyecto que
              las llevó. Sin esto, el dato que este árbol existe para ubicar solo se veía
              entrando en una design version concreta — o sea, sabiendo ya la respuesta. */}
          {servicio.estadoEfectivo && (
            <div
              style={{
                font: '400 11px var(--font-sans)',
                color: 'var(--text-faint)',
                padding: '0 10px 5px 22px',
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
              }}
            >
              <span style={{ font: '500 10.5px var(--font-mono)', color: 'var(--accent)', flexShrink: 0 }}>
                {servicio.estadoEfectivo.codigo}
              </span>
              <span style={truncado}>
                {servicio.estadoEfectivo.resumen !== ''
                  ? servicio.estadoEfectivo.resumen
                  : `constatado el ${servicio.estadoEfectivo.constatadoEn} sobre ${servicio.estadoEfectivo.designVersionCodigo}`}
              </span>
            </div>
          )}
          {servicio.retos.map((reto) => (
            <div key={reto.id}>
              <div style={filaArbol}>
                <span style={truncado}>
                  {reto.codigo} {reto.titulo}
                </span>
                {reto.metricaObjetivo && (
                  <span style={{ font: '500 10.5px var(--font-mono)', color: 'var(--accent)', flexShrink: 0 }}>
                    {reto.metricaObjetivo}
                  </span>
                )}
              </div>
              {reto.proyectos.map((proyecto) => (
                <Link
                  key={proyecto.id}
                  to="/proyecto/$proyectoId"
                  params={{ proyectoId: proyecto.id }}
                  style={{ ...filaArbol, paddingLeft: 46, textDecoration: 'none' }}
                >
                  <span style={truncado}>
                    {proyecto.codigo} {proyecto.titulo}
                  </span>
                </Link>
              ))}
            </div>
          ))}
          {servicio.retosQueAfectan.map((reto) => (
            <div key={reto.id} style={filaArbol}>
              <span style={truncado}>
                {reto.codigo} {reto.titulo}
              </span>
              <span style={{ font: '500 9.5px var(--font-mono)', color: 'var(--text-faint)', flexShrink: 0 }}>
                afecta
              </span>
            </div>
          ))}
        </div>
      ))}

      <div style={{ ...micro, fontSize: 10, color: 'var(--text-faint)', padding: '18px 10px 6px' }}>Workspace</div>
      <div style={{ ...item, font: '700 13px var(--font-sans)', color: 'var(--ink)', background: 'var(--surface-sunken)' }}>
        <span>Loop del método (J1–J7)</span>
      </div>
      <Link to="/importacion" style={{ ...item, textDecoration: 'none' }}>
        <span>Bandeja de importación</span>
      </Link>
      <Link to="/insights" style={{ ...item, textDecoration: 'none' }}>
        <span>Insights y citas</span>
      </Link>
      <Link to="/journeys" style={{ ...item, textDecoration: 'none' }}>
        <span>Journeys y blueprints</span>
      </Link>
      <Link to="/design-versions" style={{ ...item, textDecoration: 'none' }}>
        <span>Design versions y releases</span>
      </Link>
      <div style={item}>
        <span>Aprobaciones pendientes</span>
        <span style={{ font: '600 11px var(--font-mono)', color: 'var(--warn)' }}>1</span>
      </div>
      <div style={item}>
        <span>Biblioteca del cliente</span>
      </div>
      <div style={item}>
        <span>Segmentos</span>
      </div>
      <Link to="/personas" style={{ ...item, textDecoration: 'none' }}>
        <span>Personas y permisos</span>
      </Link>
      {/* La auditoría es de quienes rinden cuentas (RF-01.6): el enlace no aparece para
          los demás roles y, si lo teclean, la RLS de evento_dominio no les da filas. */}
      {(ROLES_AUDITORIA as readonly string[]).includes(rol) && (
        <Link to="/auditoria" style={{ ...item, textDecoration: 'none' }}>
          <span>Auditoría</span>
        </Link>
      )}
      <div style={{ marginTop: 'auto', font: '400 11.5px/1.5 var(--font-sans)', color: 'var(--text-faint)', padding: 10 }}>
        La organización cliente es propietaria del workspace; la boutique opera como autorizada.
      </div>
    </aside>
  );
}
