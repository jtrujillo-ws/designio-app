import { useState } from 'react';
import type { CSSProperties } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { ETIQUETA_ROL } from '@/lib/auth/auth.schemas';
import { evidenciasDelWorkspace } from '@/lib/evidencia/evidencia.functions';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import {
  aprobarGateDeProyecto,
  marcarItemDeChecklist,
  proyectoDelMetodo,
} from '@/lib/metodo/metodo.functions';
import { ETIQUETA_PERFIL } from '@/lib/metodo/metodo.plantillas';
import type { GateDeProyecto, ItemDeGate, ProyectoMetodo } from '@/lib/metodo/metodo.schemas';

/**
 * Pantalla del método (SPEC-04): las 8 etapas canónicas con su gate, checklist de
 * suficiencia y aprobación por rol. El estado que gobierna es el de los gates.
 */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute('/_autenticada/proyecto/$proyectoId')({
  loader: async ({ context, params }) => {
    const workspaceId = context.usuario.membresias[0]?.workspaceId;
    // Un id no-uuid en la URL (enlace editado/truncado) es "no existe", no un crash
    // del validador de la server function contra el error boundary por defecto.
    if (!workspaceId || !ES_UUID.test(params.proyectoId)) return null;
    const [proyecto, lista] = await Promise.all([
      proyectoDelMetodo({ data: { workspaceId, proyectoId: params.proyectoId } }),
      evidenciasDelWorkspace({ data: { workspaceId } }),
    ]);
    return proyecto
      ? {
          workspaceId,
          proyecto,
          evidencias: lista?.evidencias ?? [],
          hayMasEvidencias: lista?.hayMas ?? false,
        }
      : null;
  },
  component: PantallaProyecto,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const COLOR_ITEM: Record<ItemDeGate['estado'], string> = {
  pendiente: 'var(--warn)',
  cumplido: 'var(--accent)',
  na: 'var(--text-faint)',
};

function PantallaProyecto() {
  const datos = Route.useLoaderData();
  const { usuario } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const rol = usuario.membresias[0]?.rol ?? '';

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
            {datos ? `${datos.proyecto.codigo} · Método y gates` : 'Proyecto'}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main style={{ maxWidth: 900, margin: '0 auto', padding: '28px 24px 60px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {!datos && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              El proyecto no existe en tu workspace.
            </span>
          </Card>
        )}
        {datos && (
          <>
            <EncabezadoProyecto proyecto={datos.proyecto} />
            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}
            {datos.proyecto.etapas.map((etapa) => {
              const gate = datos.proyecto.gates.find((g) => g.numero === etapa.numero);
              return (
                <EtapaConGate
                  key={etapa.id}
                  workspaceId={datos.workspaceId}
                  nombreEtapa={`${etapa.numero} · ${etapa.nombre}`}
                  estadoEtapa={etapa.estado}
                  gate={gate}
                  evidencias={datos.evidencias}
                  hayMasEvidencias={datos.hayMasEvidencias}
                  rol={rol}
                  onCambio={() => router.invalidate()}
                  onError={setError}
                />
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}

function EncabezadoProyecto({ proyecto }: { proyecto: ProyectoMetodo }) {
  const gatesAprobados = proyecto.gates.filter((g) => g.estado === 'aprobado').length;
  return (
    <Card style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '800 20px var(--font-sans)', color: 'var(--ink)' }}>
          {proyecto.codigo} {proyecto.titulo}
        </span>
        <Tag>Perfil {ETIQUETA_PERFIL[proyecto.perfil]}</Tag>
        <Tag>{proyecto.estado}</Tag>
        <span style={{ font: '600 12px var(--font-mono)', color: 'var(--accent)' }}>
          {gatesAprobados}/8 gates
        </span>
      </div>
      <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
        Reto {proyecto.reto.codigo} · {proyecto.reto.titulo}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={micro}>Criterios de éxito (ventana por criterio, SYS-22)</span>
        {proyecto.reto.criterios.length === 0 && (
          <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--warn)' }}>
            Sin criterios definidos: G0 no podrá aprobarse.
          </span>
        )}
        {proyecto.reto.criterios.map((c) => (
          <div key={c.id} style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
            <strong>{c.kpi}</strong>
            {c.objetivo ? ` → ${c.objetivo}` : ''}
            {' · '}
            {c.lineaBaseValor
              ? `base ${c.lineaBaseValor}${c.lineaBaseFecha ? ` (${c.lineaBaseFecha})` : ''}`
              : c.lineaBasePlan
                ? 'base con plan'
                : 'sin línea base'}
            {' · '}
            {c.ventanaDias ? `ventana ${c.ventanaDias} días` : 'SIN VENTANA'}
          </div>
        ))}
      </div>
    </Card>
  );
}

function EtapaConGate({
  workspaceId,
  nombreEtapa,
  estadoEtapa,
  gate,
  evidencias,
  hayMasEvidencias,
  rol,
  onCambio,
  onError,
}: {
  workspaceId: string;
  nombreEtapa: string;
  estadoEtapa: string;
  gate: GateDeProyecto | undefined;
  evidencias: { id: string; titulo: string }[];
  hayMasEvidencias: boolean;
  rol: string;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [aprobando, setAprobando] = useState(false);
  if (!gate) return null;
  const puedeAprobar = rol === gate.rolAprobador;
  const pendientes = gate.items.filter((i) => i.estado === 'pendiente').length;

  async function aprobar() {
    if (!gate) return;
    setAprobando(true);
    onError(null);
    try {
      const r = await aprobarGateDeProyecto({ data: { workspaceId, gateId: gate.id } });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo aprobar el gate; intenta de nuevo');
    } finally {
      setAprobando(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '700 14.5px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 220 }}>
          {nombreEtapa}
        </span>
        <span style={{ ...micro, fontSize: 10 }}>{estadoEtapa}</span>
        <Tag>
          G{gate.numero} · {ETIQUETA_ROL[gate.rolAprobador] ?? gate.rolAprobador}
        </Tag>
        {gate.estado === 'aprobado' ? (
          <span style={{ font: '600 12px var(--font-sans)', color: 'var(--accent)' }}>
            Aprobado{gate.aprobadoEn ? ` · ${gate.aprobadoEn.slice(0, 10)}` : ''}
          </span>
        ) : (
          <span style={{ font: '600 12px var(--font-sans)', color: 'var(--warn)' }}>
            {pendientes === 0 ? 'Listo para aprobar' : `${pendientes} pendientes`}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {gate.items.map((item) => (
          <ItemChecklist
            key={item.id}
            workspaceId={workspaceId}
            item={item}
            evidencias={evidencias}
            hayMasEvidencias={hayMasEvidencias}
            editable={gate.estado === 'pendiente'}
            puedeCurar={(ROLES_CURADORES as readonly string[]).includes(rol)}
            puedeNa={rol === gate.rolAprobador}
            onCambio={onCambio}
            onError={onError}
          />
        ))}
      </div>

      {gate.estado === 'pendiente' && puedeAprobar && (
        <div>
          <Button size="sm" disabled={aprobando} onClick={() => void aprobar()}>
            {aprobando ? 'Aprobando…' : `Aprobar G${gate.numero}`}
          </Button>
        </div>
      )}
      {gate.estado === 'pendiente' && !puedeAprobar && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Aprueba {ETIQUETA_ROL[gate.rolAprobador] ?? gate.rolAprobador} en el portal.
        </span>
      )}
    </Card>
  );
}

function ItemChecklist({
  workspaceId,
  item,
  evidencias,
  hayMasEvidencias,
  editable,
  puedeCurar,
  puedeNa,
  onCambio,
  onError,
}: {
  workspaceId: string;
  item: ItemDeGate;
  evidencias: { id: string; titulo: string }[];
  hayMasEvidencias: boolean;
  editable: boolean;
  /** Cumplido/pendiente: curadores (lead/diseñador). N/A —y revertirlo— : el rol aprobador del gate. */
  puedeCurar: boolean;
  puedeNa: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [enlazando, setEnlazando] = useState(false);
  const [evidenciaId, setEvidenciaId] = useState('');
  const [naJustificacion, setNaJustificacion] = useState('');
  const [marcandoNa, setMarcandoNa] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  async function marcar(accion: Parameters<typeof marcarItemDeChecklist>[0]['data']['accion']) {
    setOcupado(true);
    onError(null);
    try {
      const r = await marcarItemDeChecklist({ data: { workspaceId, itemId: item.id, accion } });
      if (r.ok) {
        setEnlazando(false);
        setMarcandoNa(false);
        setNaJustificacion('');
        await onCambio();
      } else {
        onError(r.error);
      }
    } catch {
      onError('No se pudo marcar el ítem; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', background: 'var(--surface-sunken)', borderRadius: 'var(--r-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-body)', flex: 1, minWidth: 200 }}>
          {item.texto}
        </span>
        <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ITEM[item.estado] }}>
          {item.estado === 'cumplido'
            ? `cumplido · ${item.evidenciaTitulo ?? 'evidencia'}`
            : item.estado === 'na'
              ? 'N/A aprobado'
              : 'pendiente'}
        </span>
      </div>
      {item.estado === 'na' && item.naJustificacion && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          {item.naJustificacion}
        </span>
      )}
      {editable && item.estado === 'pendiente' && !enlazando && !marcandoNa && (puedeCurar || puedeNa) && (
        <div style={{ display: 'flex', gap: 8 }}>
          {puedeCurar && (
            <Button size="sm" variant="secondary" disabled={ocupado} onClick={() => setEnlazando(true)}>
              Enlazar evidencia
            </Button>
          )}
          {puedeNa && (
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setMarcandoNa(true)}>
              Marcar N/A
            </Button>
          )}
        </div>
      )}
      {editable && item.estado !== 'pendiente' && (item.estado === 'na' ? puedeNa : puedeCurar || puedeNa) && (
        <div>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => void marcar({ tipo: 'pendiente' })}>
            Volver a pendiente
          </Button>
        </div>
      )}
      {editable && enlazando && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Select value={evidenciaId} onChange={(e) => setEvidenciaId(e.target.value)} style={{ minWidth: 260 }}>
            <option value="">Elige una evidencia curada…</option>
            {evidencias.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.titulo}
              </option>
            ))}
            {hayMasEvidencias && (
              <option value="" disabled>
                … hay más evidencias (solo se listan las 200 más recientes)
              </option>
            )}
          </Select>
          <Button
            size="sm"
            disabled={ocupado || evidenciaId === ''}
            onClick={() => void marcar({ tipo: 'cumplido', evidenciaId })}
          >
            Cumplido
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setEnlazando(false)}>
            Cancelar
          </Button>
        </div>
      )}
      {editable && marcandoNa && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={naJustificacion}
            onChange={(e) => setNaJustificacion(e.target.value)}
            placeholder="Justificación del N/A (la aprueba el rol del gate)"
            maxLength={2000}
            style={{
              flex: 1,
              minWidth: 260,
              font: '400 13px var(--font-sans)',
              padding: '7px 10px',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--ink)',
            }}
          />
          <Button
            size="sm"
            disabled={ocupado || naJustificacion.trim() === ''}
            onClick={() => void marcar({ tipo: 'na', justificacion: naJustificacion.trim() })}
          >
            Confirmar N/A
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setMarcandoNa(false)}>
            Cancelar
          </Button>
        </div>
      )}
    </div>
  );
}
