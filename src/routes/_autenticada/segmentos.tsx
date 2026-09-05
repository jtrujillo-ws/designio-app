import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EnlaceA } from '@/components/ui/EnlaceA';
import { Input } from '@/components/ui/Input';
import { Tag } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import { Wordmark } from '@/components/ui/Wordmark';
import {
  crearSegmentoDelWorkspace,
  editarSegmentoDelWorkspace,
  segmentosDelWorkspace,
} from '@/lib/segmento/segmento.functions';
import {
  ETIQUETA_ESTADO_ARQUETIPO,
  destinoDeArquetipo,
  nombreYaUsado,
  puedeEditarSegmentos,
  resumenDeCobertura,
  type ArquetipoDeSegmento,
  type SegmentoConCobertura,
} from '@/lib/segmento/segmento.schemas';

/**
 * Segmentos del cliente (RF-01.7, prediseño §4.1): la taxonomía transversal con la que se
 * planifica la cobertura de research y se leen las métricas. La pantalla lista cada
 * segmento con su definición y su cobertura en la forma mínima —qué arquetipos lo mapean,
 * en qué estado, y cuántas evidencias lo citan—, y deja darlos de alta y editarlos a quien
 * gobierna la taxonomía (lead o admin del cliente; el servidor lo re-valida).
 */
export const Route = createFileRoute('/_autenticada/segmentos')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    return workspaceId
      ? segmentosDelWorkspace({ data: { workspaceId } }).then((segmentos) => ({
          workspaceId,
          segmentos: segmentos ?? [],
        }))
      : null;
  },
  component: PantallaSegmentos,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

/** El estado del arquetipo con el mismo código de color que el resto de veredictos. */
const COLOR_ESTADO: Record<ArquetipoDeSegmento['estado'], string> = {
  hipotesis: 'var(--warn)',
  confirmado: 'var(--accent)',
  refutado: 'var(--text-faint)',
};

function PantallaSegmentos() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  // Reescribir la taxonomía es cosa de quien opera el engagement o administra los datos
  // del cliente. El servidor lo re-valida (capa 2): aquí solo se evita ofrecer un control
  // que sería rechazado.
  const puedeEditar = puedeEditarSegmentos(membresiaActiva?.rol ?? '');
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
            Segmentos
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
          gap: 20,
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
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              La clasificación estable de los usuarios del cliente: el eje por el que se planifica
              el research y se leen las métricas. Los arquetipos de cada reto se mapean a uno o más
              segmentos, y la evidencia los cita.
            </span>
            {puedeEditar && (
              <FormularioSegmento
                workspaceId={datos.workspaceId}
                existentes={datos.segmentos}
                onCambio={() => router.invalidate()}
                onError={setError}
              />
            )}
            {error && (
              <span
                role="alert"
                style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}
              >
                {error}
              </span>
            )}
            <div style={{ ...etiqueta, paddingTop: 6 }}>
              {datos.segmentos.length} segmentos del workspace
            </div>
            {datos.segmentos.length === 0 && (
              <Card pending style={{ padding: 24 }}>
                <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
                  {puedeEditar
                    ? 'Sin segmentos aún: define el primero arriba.'
                    : 'Sin segmentos aún: el lead o el admin del cliente los definen.'}
                </span>
              </Card>
            )}
            {datos.segmentos.map((s) => (
              <TarjetaSegmento
                key={s.id}
                workspaceId={datos.workspaceId}
                segmento={s}
                existentes={datos.segmentos}
                puedeEditar={puedeEditar}
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

function TarjetaSegmento({
  workspaceId,
  segmento,
  existentes,
  puedeEditar,
  onCambio,
  onError,
}: {
  workspaceId: string;
  segmento: SegmentoConCobertura;
  existentes: SegmentoConCobertura[];
  puedeEditar: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [editando, setEditando] = useState(false);

  if (editando) {
    return (
      <FormularioSegmento
        workspaceId={workspaceId}
        existentes={existentes}
        segmento={segmento}
        onCambio={async () => {
          setEditando(false);
          await onCambio();
        }}
        onCancelar={() => setEditando(false)}
        onError={onError}
      />
    );
  }

  return (
    <Card style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span
          style={{
            font: '700 14.5px var(--font-sans)',
            color: 'var(--ink)',
            flex: 1,
            minWidth: 160,
          }}
        >
          {segmento.nombre}
        </span>
        <span style={{ font: '500 12px var(--font-sans)', color: 'var(--text-muted)' }}>
          {resumenDeCobertura(segmento)}
        </span>
        {puedeEditar && (
          <Button size="sm" variant="secondary" onClick={() => setEditando(true)}>
            Editar
          </Button>
        )}
      </div>
      <span
        style={{
          font: '400 13px var(--font-sans)',
          color: segmento.definicion ? 'var(--text-body)' : 'var(--text-faint)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
        }}
      >
        {segmento.definicion || 'Sin definición todavía'}
      </span>
      {segmento.arquetipos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
          <span style={etiqueta}>Arquetipos que lo mapean</span>
          {segmento.arquetipos.map((a) => (
            <FilaArquetipo key={a.id} arquetipo={a} />
          ))}
        </div>
      )}
    </Card>
  );
}

/** Un arquetipo del segmento: enlaza al proyecto de su reto si lo hay; si no, lo dice. */
function FilaArquetipo({ arquetipo }: { arquetipo: ArquetipoDeSegmento }) {
  const destino = destinoDeArquetipo(arquetipo);
  const nombre = (
    <span style={{ font: '600 13px var(--font-sans)', color: 'var(--ink)' }}>
      {arquetipo.nombre}
    </span>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <Tag>{arquetipo.retoCodigo}</Tag>
      {destino ? (
        <EnlaceA
          destino={destino}
          title={`Abrir proyecto ${arquetipo.proyectoCodigo ?? ''}`.trim()}
          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {nombre}
          <span style={{ font: '500 11.5px var(--font-mono)', color: 'var(--text-muted)' }}>
            {arquetipo.proyectoCodigo} →
          </span>
        </EnlaceA>
      ) : (
        <>
          {nombre}
          <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--text-faint)' }}>
            sin proyecto aún
          </span>
        </>
      )}
      <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ESTADO[arquetipo.estado] }}>
        {ETIQUETA_ESTADO_ARQUETIPO[arquetipo.estado]}
      </span>
    </div>
  );
}

/**
 * Un solo formulario para alta y edición: son los mismos dos campos y la misma regla de
 * nombre único. Con `segmento` edita; sin él, da de alta.
 */
function FormularioSegmento({
  workspaceId,
  existentes,
  segmento,
  onCambio,
  onCancelar,
  onError,
}: {
  workspaceId: string;
  existentes: SegmentoConCobertura[];
  segmento?: SegmentoConCobertura;
  onCambio: () => Promise<void>;
  onCancelar?: () => void;
  onError: (e: string | null) => void;
}) {
  const [nombre, setNombre] = useState(segmento?.nombre ?? '');
  const [definicion, setDefinicion] = useState(segmento?.definicion ?? '');
  const [enviando, setEnviando] = useState(false);
  // La misma regla que aplica el servidor, dicha antes del viaje. El servidor sigue siendo
  // la autoridad: otra persona pudo crear el mismo nombre desde que se cargó la lista.
  const repetido = nombre.trim() !== '' && nombreYaUsado(nombre, existentes, segmento?.id);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (repetido) return;
    setEnviando(true);
    onError(null);
    try {
      const r = segmento
        ? await editarSegmentoDelWorkspace({
            data: { workspaceId, segmentoId: segmento.id, nombre, definicion },
          })
        : await crearSegmentoDelWorkspace({ data: { workspaceId, nombre, definicion } });
      if (r.ok) {
        if (!segmento) {
          setNombre('');
          setDefinicion('');
        }
        await onCambio();
      } else {
        onError(r.error);
      }
    } catch {
      onError(
        segmento ? 'No se pudo guardar; intenta de nuevo' : 'No se pudo crear; intenta de nuevo',
      );
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card style={{ padding: 24 }} active={Boolean(segmento)}>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
          {segmento ? `Editar «${segmento.nombre}»` : 'Definir un segmento'}
        </span>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Nombre</span>
          <Input
            required
            maxLength={120}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="pymes, independientes, empleados corporativos…"
          />
          {repetido && (
            <span
              role="alert"
              style={{ font: '500 12px var(--font-sans)', color: 'var(--danger)' }}
            >
              Ya hay un segmento con ese nombre en este workspace
            </span>
          )}
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Definición</span>
          <Textarea
            rows={3}
            maxLength={2000}
            value={definicion}
            onChange={(e) => setDefinicion(e.target.value)}
            placeholder="Quiénes entran en este segmento y qué los distingue"
          />
        </label>
        <div style={{ display: 'flex', gap: 10 }}>
          <Button type="submit" disabled={enviando || repetido}>
            {enviando ? 'Guardando…' : segmento ? 'Guardar cambios' : 'Definir segmento'}
          </Button>
          {onCancelar && (
            <Button variant="ghost" onClick={onCancelar} disabled={enviando}>
              Cancelar
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
