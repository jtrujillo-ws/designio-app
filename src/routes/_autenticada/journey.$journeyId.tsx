import { useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tabs } from '@/components/ui/Tabs';
import { Tag } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import { Wordmark } from '@/components/ui/Wordmark';
import { DiagramaMermaid } from '@/components/journey/DiagramaMermaid';
import { evidenciasDelWorkspace } from '@/lib/evidencia/evidencia.functions';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import {
  agregarAristaAlJourney,
  agregarNodoAlJourney,
  borrarAristaDelJourney,
  editarAristaDelJourney,
  borrarNodoDelJourney,
  congelarSnapshotDelJourney,
  desenlazarEvidenciaDelNodo,
  editarNodoDelJourney,
  enlazarEvidenciaAlNodo,
  journeyDelWorkspace,
} from '@/lib/journey/journey.functions';
import { carrilesDeJourney, mermaidDeJourney, validarJourney } from '@/lib/journey/journey.mermaid';
import {
  ETIQUETA_TIPO_ARISTA,
  ETIQUETA_TIPO_NODO,
  EXTREMOS_ARISTA,
  TIPOS_ARISTA,
  TIPOS_NODO,
  type AristaDeJourney,
  type JourneyCompleto,
  type NodoDeJourney,
  type SenalValidacion,
  type TipoArista,
  type TipoNodo,
} from '@/lib/journey/journey.schemas';

/**
 * El journey por dentro (SPEC-05): la tabla de elementos ES el modelo; el diagrama, los
 * carriles y el informe de validación son tres lecturas de la MISMA proyección, así que
 * no pueden discrepar entre ellas.
 */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute('/_autenticada/journey/$journeyId')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ context, params }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    if (!workspaceId || !ES_UUID.test(params.journeyId)) return null;
    const [journey, evidencias] = await Promise.all([
      journeyDelWorkspace({ data: { workspaceId, journeyId: params.journeyId } }),
      evidenciasDelWorkspace({ data: { workspaceId } }),
    ]);
    if (!journey) return null;
    return {
      workspaceId,
      journey,
      evidencias: evidencias?.evidencias ?? [],
      hayMasEvidencias: evidencias?.hayMas ?? false,
    };
  },
  component: PantallaJourney,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

/** Las cuatro lecturas del mismo grafo. La etiqueta ES el valor: Tabs trabaja con
 * cadenas, y una lista fija evita que el estado apunte a una pestaña que ya no existe. */
const VISTAS = ['Modelo', 'Diagrama', 'Blueprint', 'Validación'];

const COLOR_SEVERIDAD: Record<SenalValidacion['severidad'], string> = {
  alta: 'var(--danger)',
  media: 'var(--warn)',
};

function PantallaJourney() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState(VISTAS[0]!);
  const rol = membresiaActiva?.rol ?? '';
  const esCurador = (ROLES_CURADORES as readonly string[]).includes(rol);

  // Las tres vistas derivan del MISMO objeto: el diagrama nunca muestra un paso que la
  // validación ya no ve, porque no hay dos lecturas del grafo.
  const journey = datos?.journey;
  const senales = useMemo(() => (journey ? validarJourney(journey) : []), [journey]);
  const mermaid = useMemo(() => (journey ? mermaidDeJourney(journey) : ''), [journey]);
  const carriles = useMemo(() => (journey ? carrilesDeJourney(journey) : null), [journey]);

  // El grafo de trabajo no se cierra nunca (RF-05.8): quien cura, edita. Lo inmutable
  // es cada snapshot congelado, que se lista aparte.
  const editable = esCurador;

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
            {journey ? journey.nombre : 'Journey'}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/journeys' })}>
          ← Volver a journeys
        </Button>
      </div>

      <main
        style={{
          maxWidth: 1000,
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
              El journey no existe en tu workspace.
            </span>
          </Card>
        )}
        {datos && journey && carriles && (
          <>
            <Encabezado
              workspaceId={datos.workspaceId}
              journey={journey}
              esCurador={esCurador}
              senalesAltas={senales.filter((s) => s.severidad === 'alta').length}
              onCambio={() => router.invalidate()}
              onError={setError}
            />

            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}

            <Tabs value={vista} onChange={setVista} items={VISTAS} label="Vistas del journey" />

            {vista === 'Modelo' && (
              <BloqueModelo
                workspaceId={datos.workspaceId}
                journey={journey}
                arquetipos={datos.journey.arquetipos}
                evidencias={datos.evidencias}
                hayMasEvidencias={datos.hayMasEvidencias}
                editable={editable}
                onCambio={() => router.invalidate()}
                onError={setError}
              />
            )}
            {vista === 'Diagrama' && <BloqueDiagrama codigo={mermaid} />}
            {vista === 'Blueprint' && <BloqueBlueprint carriles={carriles} />}
            {vista === 'Validación' && <BloqueValidacion senales={senales} />}
          </>
        )}
      </main>
    </div>
  );
}

function Encabezado({
  workspaceId,
  journey,
  esCurador,
  senalesAltas,
  onCambio,
  onError,
}: {
  workspaceId: string;
  journey: JourneyCompleto;
  esCurador: boolean;
  senalesAltas: number;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [congelando, setCongelando] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  async function congelar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await congelarSnapshotDelJourney({
        data: { workspaceId, journeyId: journey.id, motivo },
      });
      if (r.ok) {
        setCongelando(false);
        setMotivo('');
        await onCambio();
      } else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '600 16px var(--font-sans)', color: 'var(--ink)' }}>
          {journey.nombre}
        </span>
        <Tag>{journey.tipo}</Tag>
      </div>
      <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
        {journey.servicioNombre}
        {journey.descripcion ? ` · ${journey.descripcion}` : ''}
      </span>

      {journey.snapshots.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={micro}>Snapshots congelados ({journey.snapshots.length})</span>
          {journey.snapshots.map((s) => (
            <span key={s.id} style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
              {s.congeladoEn}
              {s.motivo ? ` · ${s.motivo}` : ''}
            </span>
          ))}
        </div>
      )}

      {esCurador && !congelando && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setCongelando(true)}>
            Congelar snapshot
          </Button>
        </div>
      )}
      {congelando && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ font: '400 12.5px/1.6 var(--font-sans)', color: 'var(--text-body)' }}>
            Congelar guarda el grafo entero —nodos, aristas y su evidencia— como registro
            inmutable de lo que se aprobó. El grafo de trabajo <strong>sigue editable</strong>:
            el snapshot es la foto, no un candado.
            {senalesAltas > 0 && (
              <>
                {' '}
                <strong style={{ color: 'var(--warn)' }}>
                  Quedan {senalesAltas} {senalesAltas === 1 ? 'señal alta' : 'señales altas'} sin
                  resolver
                </strong>{' '}
                — no lo impide, pero queda registrado así.
              </>
            )}
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Input
              placeholder="Motivo (por ejemplo: aprobado en G4)"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              style={{ minWidth: 280 }}
            />
            <Button size="sm" disabled={ocupado} onClick={() => void congelar()}>
              Congelar
            </Button>
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setCongelando(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function BloqueModelo({
  workspaceId,
  journey,
  arquetipos,
  evidencias,
  hayMasEvidencias,
  editable,
  onCambio,
  onError,
}: {
  workspaceId: string;
  journey: JourneyCompleto;
  arquetipos: JourneyCompleto['arquetipos'];
  evidencias: { id: string; titulo: string }[];
  hayMasEvidencias: boolean;
  editable: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const fases = journey.nodos.filter((n) => n.tipo === 'fase');
  const porId = new Map(journey.nodos.map((n) => [n.id, n]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {editable && (
        <FormularioNodo
          workspaceId={workspaceId}
          journeyId={journey.id}
          fases={fases}
          arquetipos={arquetipos}
          onCambio={onCambio}
          onError={onError}
        />
      )}

      <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={micro}>Elementos ({journey.nodos.length})</span>
        {journey.nodos.length === 0 && (
          <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
            El grafo está vacío. Empieza por las fases, luego los pasos.
          </span>
        )}
        {journey.nodos.map((n) => (
          <FilaNodo
            key={n.id}
            workspaceId={workspaceId}
            nodo={n}
            fases={fases}
            evidencias={evidencias}
            hayMasEvidencias={hayMasEvidencias}
            editable={editable}
            onCambio={onCambio}
            onError={onError}
          />
        ))}
      </Card>

      <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={micro}>Relaciones ({journey.aristas.length})</span>
        {editable && journey.nodos.length >= 2 && (
          <FormularioArista
            workspaceId={workspaceId}
            journeyId={journey.id}
            nodos={journey.nodos}
            onCambio={onCambio}
            onError={onError}
          />
        )}
        {journey.aristas.length === 0 && (
          <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
            Sin relaciones: el grafo todavía no dice en qué orden ocurren las cosas.
          </span>
        )}
        {journey.aristas.map((a) => (
          <FilaArista
            key={a.id}
            workspaceId={workspaceId}
            arista={a}
            origen={porId.get(a.origenId) ?? null}
            destino={porId.get(a.destinoId) ?? null}
            editable={editable}
            onCambio={onCambio}
            onError={onError}
          />
        ))}
      </Card>
    </div>
  );
}

function FormularioNodo({
  workspaceId,
  journeyId,
  fases,
  arquetipos,
  onCambio,
  onError,
}: {
  workspaceId: string;
  journeyId: string;
  fases: NodoDeJourney[];
  arquetipos: JourneyCompleto['arquetipos'];
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [tipo, setTipo] = useState<TipoNodo>('paso');
  const [etiqueta, setEtiqueta] = useState('');
  const [detalle, setDetalle] = useState('');
  const [faseId, setFaseId] = useState('');
  const [responsable, setResponsable] = useState('');
  const [arquetipoId, setArquetipoId] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const esArquetipo = tipo === 'arquetipo';
  // Un arquetipo REFUTADO no entra al grafo: el veredicto dice que ese perfil no describe
  // a nadie, y dibujarlo lo resucitaría. El guard lo rechaza igual; esto ahorra el viaje.
  const disponibles = arquetipos.filter((a) => a.estado !== 'refutado');

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true);
    onError(null);
    try {
      const elegido = arquetipos.find((a) => a.id === arquetipoId);
      const r = await agregarNodoAlJourney({
        data: {
          workspaceId,
          journeyId,
          tipo,
          // El nodo de arquetipo toma el NOMBRE del arquetipo curado: la etiqueta no es
          // suya, es de él, y así el grafo no puede llamarlo de otra manera.
          etiqueta: esArquetipo ? (elegido?.nombre ?? '') : etiqueta,
          arquetipoId: esArquetipo ? arquetipoId : null,
          detalle,
          // Una fase no cuelga de otra fase (el CHECK de la base lo impone).
          faseId: tipo === 'fase' || faseId === '' ? null : faseId,
          responsable,
        },
      });
      if (r.ok) {
        setEtiqueta('');
        setDetalle('');
        setResponsable('');
        await onCambio();
      } else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20 }}>
      <form onSubmit={(e) => void enviar(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={micro}>Agregar elemento</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Select value={tipo} onChange={(e) => setTipo(e.target.value as TipoNodo)} style={{ minWidth: 190 }}>
            {TIPOS_NODO.map((t) => (
              <option key={t} value={t}>
                {ETIQUETA_TIPO_NODO[t]}
              </option>
            ))}
          </Select>
          <Select
            value={faseId}
            onChange={(e) => setFaseId(e.target.value)}
            disabled={tipo === 'fase' || fases.length === 0}
            style={{ minWidth: 190 }}
          >
            <option value="">{tipo === 'fase' ? 'Las fases no se anidan' : 'Sin fase'}</option>
            {fases.map((f) => (
              <option key={f.id} value={f.id}>
                {f.etiqueta}
              </option>
            ))}
          </Select>
        </div>
        {esArquetipo ? (
          <>
            {/* Un arquetipo del grafo REFERENCIA al arquetipo curado del reto: no se
                teclea. Si se pudiera escribir a mano, el journey podría mostrar un
                perfil que el modelo curado refutó. */}
            <Select value={arquetipoId} onChange={(e) => setArquetipoId(e.target.value)} required>
              <option value="">Arquetipo del reto…</option>
              {disponibles.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nombre}
                  {a.estado === 'hipotesis' ? ' (hipótesis)' : ''}
                </option>
              ))}
            </Select>
            {disponibles.length === 0 && (
              <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
                {arquetipos.length === 0
                  ? 'Este journey no tiene arquetipos que referenciar: defínelos primero en el reto (o asocia el journey a uno).'
                  : 'Los arquetipos de este reto están todos refutados: un perfil descartado no entra al journey.'}
              </span>
            )}
          </>
        ) : (
          <Input
            placeholder="Etiqueta (lo que se lee en el diagrama)"
            value={etiqueta}
            onChange={(e) => setEtiqueta(e.target.value)}
            required
          />
        )}
        <Input
          placeholder="Responsable (quién lo ejecuta; obligatorio en acciones y sistemas para la validación)"
          value={responsable}
          onChange={(e) => setResponsable(e.target.value)}
        />
        <Textarea
          placeholder="Detalle (opcional)"
          value={detalle}
          onChange={(e) => setDetalle(e.target.value)}
          rows={2}
        />
        <div>
          <Button
            size="sm"
            type="submit"
            disabled={ocupado || (esArquetipo ? arquetipoId === '' : etiqueta.trim() === '')}
          >
            Agregar
          </Button>
        </div>
      </form>
    </Card>
  );
}

function FilaNodo({
  workspaceId,
  nodo,
  fases,
  evidencias,
  hayMasEvidencias,
  editable,
  onCambio,
  onError,
}: {
  workspaceId: string;
  nodo: NodoDeJourney;
  fases: NodoDeJourney[];
  evidencias: { id: string; titulo: string }[];
  hayMasEvidencias: boolean;
  editable: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [enlazando, setEnlazando] = useState(false);
  const [evidenciaId, setEvidenciaId] = useState('');
  const [etiqueta, setEtiqueta] = useState(nodo.etiqueta);
  const [detalle, setDetalle] = useState(nodo.detalle);
  const [responsable, setResponsable] = useState(nodo.responsable);
  const [faseId, setFaseId] = useState(nodo.faseId ?? '');
  const [orden, setOrden] = useState(String(nodo.orden));
  const [ocupado, setOcupado] = useState(false);
  const fase = fases.find((f) => f.id === nodo.faseId);

  async function guardar() {
    setOcupado(true);
    onError(null);
    try {
      const numero = Number.parseInt(orden, 10);
      const r = await editarNodoDelJourney({
        data: {
          workspaceId,
          nodoId: nodo.id,
          etiqueta,
          detalle,
          responsable,
          faseId: nodo.tipo === 'fase' || faseId === '' ? null : faseId,
          orden: Number.isNaN(numero) ? nodo.orden : numero,
        },
      });
      if (r.ok) {
        setEditando(false);
        await onCambio();
      } else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  async function quitarEvidencia(evidenciaId: string) {
    setOcupado(true);
    onError(null);
    try {
      const r = await desenlazarEvidenciaDelNodo({
        data: { workspaceId, nodoId: nodo.id, evidenciaId },
      });
      if (r.ok) await onCambio();
      else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  async function enlazar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await enlazarEvidenciaAlNodo({
        data: { workspaceId, nodoId: nodo.id, evidenciaId },
      });
      if (r.ok) {
        setEnlazando(false);
        setEvidenciaId('');
        await onCambio();
      } else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingBottom: 10,
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag>{ETIQUETA_TIPO_NODO[nodo.tipo]}</Tag>
        <span style={{ font: '600 13.5px var(--font-sans)', color: 'var(--ink)' }}>
          {nodo.etiqueta}
        </span>
        {fase && (
          <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--text-faint)' }}>
            en {fase.etiqueta}
          </span>
        )}
        <span style={{ font: '500 10.5px var(--font-mono)', color: 'var(--text-faint)' }}>
          #{nodo.orden}
        </span>
      </div>
      {nodo.detalle && (
        <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
          {nodo.detalle}
        </span>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
          Responsable: {nodo.responsable || '—'} · Evidencia:
        </span>
        {nodo.evidencias.length === 0 && (
          <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
            sin enlazar
          </span>
        )}
        {nodo.evidencias.map((e) => (
          <span
            key={e.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              font: '400 12px var(--font-sans)',
              color: 'var(--text-body)',
              background: 'var(--surface-sunken)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-pill)',
              padding: '2px 4px 2px 10px',
            }}
          >
            {e.titulo}
            {editable && (
              // Enlazar mal es un error corriente: sin esta salida había que borrar el
              // nodo entero —y sus aristas— para corregir un enlace.
              <button
                type="button"
                aria-label={`Quitar la evidencia ${e.titulo}`}
                disabled={ocupado}
                onClick={() => void quitarEvidencia(e.id)}
                style={{
                  font: '600 12px var(--font-sans)',
                  color: 'var(--text-muted)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '0 6px',
                }}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>

      {editable && !editando && !enlazando && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size="sm" variant="ghost" onClick={() => setEditando(true)}>
            Editar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEnlazando(true)}>
            Enlazar evidencia
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={ocupado}
            onClick={async () => {
              onError(null);
              setOcupado(true);
              try {
                const r = await borrarNodoDelJourney({ data: { workspaceId, nodoId: nodo.id } });
                if (r.ok) await onCambio();
                else onError(r.error);
              } finally {
                setOcupado(false);
              }
            }}
          >
            Borrar
          </Button>
        </div>
      )}

      {editando && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* La etiqueta de un nodo arquetipo NO se teclea: es el nombre del arquetipo
              curado. Poder reescribirla haría que el diagrama, el blueprint y los
              snapshots congelados mostraran un nombre inventado para un arquetipo real —
              justo la identidad que referenciarlo viene a garantizar. El guard la deriva
              de todas formas; aquí se muestra para que se entienda por qué no se edita. */}
          {nodo.tipo === 'arquetipo' ? (
            <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              La etiqueta la pone el arquetipo curado del reto ({nodo.etiqueta}) y no se
              edita aquí: se cambia renombrando el arquetipo.
            </span>
          ) : (
            <Input value={etiqueta} onChange={(e) => setEtiqueta(e.target.value)} />
          )}
          <Input
            placeholder="Responsable"
            value={responsable}
            onChange={(e) => setResponsable(e.target.value)}
          />
          <Textarea value={detalle} onChange={(e) => setDetalle(e.target.value)} rows={2} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Select
              value={faseId}
              onChange={(e) => setFaseId(e.target.value)}
              disabled={nodo.tipo === 'fase'}
              style={{ minWidth: 180 }}
            >
              <option value="">{nodo.tipo === 'fase' ? 'Las fases no se anidan' : 'Sin fase'}</option>
              {fases
                .filter((f) => f.id !== nodo.id)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.etiqueta}
                  </option>
                ))}
            </Select>
            <Input
              type="number"
              min={0}
              max={9999}
              value={orden}
              onChange={(e) => setOrden(e.target.value)}
              style={{ width: 100 }}
            />
            <Button
              size="sm"
              disabled={ocupado || (nodo.tipo !== 'arquetipo' && etiqueta.trim() === '')}
              onClick={() => void guardar()}
            >
              Guardar
            </Button>
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setEditando(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {enlazando && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Select
            value={evidenciaId}
            onChange={(e) => setEvidenciaId(e.target.value)}
            style={{ minWidth: 260 }}
          >
            <option value="">Evidencia que lo sostiene…</option>
            {evidencias.map((e) => (
              <option key={e.id} value={e.id}>
                {e.titulo}
              </option>
            ))}
            {hayMasEvidencias && (
              <option value="" disabled>
                … hay más evidencias (solo se listan las 200 más recientes)
              </option>
            )}
          </Select>
          <Button size="sm" disabled={ocupado || evidenciaId === ''} onClick={() => void enlazar()}>
            Enlazar
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setEnlazando(false)}>
            Cancelar
          </Button>
        </div>
      )}
    </div>
  );
}

/** Una relación con su edición en sitio. Solo el tipo y la condición: cambiar los
 * extremos es OTRA relación —para eso está el borrado—, y así la identidad de una
 * arista significa siempre lo mismo. */
function FilaArista({
  workspaceId,
  arista,
  origen,
  destino,
  editable,
  onCambio,
  onError,
}: {
  workspaceId: string;
  arista: AristaDeJourney;
  origen: NodoDeJourney | null;
  destino: NodoDeJourney | null;
  editable: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [tipo, setTipo] = useState<TipoArista>(arista.tipo);
  const [condicion, setCondicion] = useState(arista.condicion);
  const [ocupado, setOcupado] = useState(false);

  async function guardar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await editarAristaDelJourney({
        data: { workspaceId, aristaId: arista.id, tipo, condicion },
      });
      if (r.ok) {
        setEditando(false);
        await onCambio();
      } else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-body)' }}>
        {origen?.etiqueta ?? '—'}
      </span>
      {!editando && (
        <span style={{ font: '500 11px var(--font-mono)', color: 'var(--accent)' }}>
          —{ETIQUETA_TIPO_ARISTA[arista.tipo]}
          {arista.condicion ? ` (${arista.condicion})` : ''}→
        </span>
      )}
      {editando && (
        <>
          <Select
            value={tipo}
            onChange={(e) => setTipo(e.target.value as TipoArista)}
            style={{ minWidth: 150 }}
          >
            {TIPOS_ARISTA.map((t) => (
              <option key={t} value={t}>
                {ETIQUETA_TIPO_ARISTA[t]}
              </option>
            ))}
          </Select>
          <Input
            placeholder="Condición"
            value={condicion}
            onChange={(e) => setCondicion(e.target.value)}
            style={{ minWidth: 180 }}
          />
        </>
      )}
      <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-body)' }}>
        {destino?.etiqueta ?? '—'}
      </span>
      {editable && !editando && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setEditando(true)}>
            Editar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={ocupado}
            onClick={async () => {
              onError(null);
              setOcupado(true);
              try {
                const r = await borrarAristaDelJourney({ data: { workspaceId, aristaId: arista.id } });
                if (r.ok) await onCambio();
                else onError(r.error);
              } finally {
                setOcupado(false);
              }
            }}
          >
            Quitar
          </Button>
        </>
      )}
      {editando && (
        <>
          <Button size="sm" disabled={ocupado} onClick={() => void guardar()}>
            Guardar
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setEditando(false)}>
            Cancelar
          </Button>
        </>
      )}
    </div>
  );
}

function FormularioArista({
  workspaceId,
  journeyId,
  nodos,
  onCambio,
  onError,
}: {
  workspaceId: string;
  journeyId: string;
  nodos: NodoDeJourney[];
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [origenId, setOrigenId] = useState('');
  const [destinoId, setDestinoId] = useState('');
  const [tipo, setTipo] = useState<TipoArista>('transicion');
  const [condicion, setCondicion] = useState('');
  const [ocupado, setOcupado] = useState(false);

  // El tipo de arista decide qué puede ir en cada extremo (lo impone un guard de la
  // base). Aquí solo se filtra el picker para no ofrecer pares que el servidor va a
  // rechazar: la autoridad sigue siendo el guard, esto ahorra el viaje.
  const permitidos = EXTREMOS_ARISTA[tipo];
  const origenes = nodos.filter((n) => permitidos.origen.includes(n.tipo));
  const destinos = nodos.filter((n) => permitidos.destino.includes(n.tipo) && n.id !== origenId);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true);
    onError(null);
    try {
      const r = await agregarAristaAlJourney({
        data: { workspaceId, journeyId, origenId, destinoId, tipo, condicion },
      });
      if (r.ok) {
        setCondicion('');
        await onCambio();
      } else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form onSubmit={(e) => void enviar(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <Select value={origenId} onChange={(e) => setOrigenId(e.target.value)} required style={{ minWidth: 180 }}>
        <option value="">Origen…</option>
        {origenes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.etiqueta} · {ETIQUETA_TIPO_NODO[n.tipo]}
          </option>
        ))}
      </Select>
      <Select
        value={tipo}
        onChange={(e) => {
          // Cambiar el tipo puede invalidar lo ya elegido: se limpia en vez de mandar
          // al servidor un par que su guard va a rechazar.
          setTipo(e.target.value as TipoArista);
          setOrigenId('');
          setDestinoId('');
        }}
        style={{ minWidth: 150 }}
      >
        {TIPOS_ARISTA.map((t) => (
          <option key={t} value={t}>
            {ETIQUETA_TIPO_ARISTA[t]}
          </option>
        ))}
      </Select>
      <Select
        value={destinoId}
        onChange={(e) => setDestinoId(e.target.value)}
        required
        style={{ minWidth: 180 }}
      >
        <option value="">Destino…</option>
        {destinos.map((n) => (
          <option key={n.id} value={n.id}>
            {n.etiqueta} · {ETIQUETA_TIPO_NODO[n.tipo]}
          </option>
        ))}
      </Select>
      <Input
        placeholder="Condición (para bifurcaciones)"
        value={condicion}
        onChange={(e) => setCondicion(e.target.value)}
        style={{ minWidth: 200 }}
      />
      <Button
        size="sm"
        type="submit"
        disabled={ocupado || origenId === '' || destinoId === '' || origenId === destinoId}
      >
        Conectar
      </Button>
    </form>
  );
}

/**
 * El código Mermaid es el artefacto exportable, no un editor: se muestra tal cual para
 * copiarlo a donde haga falta. No se monta un renderer aquí a propósito — el grafo
 * canónico está arriba, y un render es intercambiable.
 */
function BloqueDiagrama({ codigo }: { codigo: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={micro}>Mermaid (derivado)</span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(codigo).then(
              () => setCopiado(true),
              () => setCopiado(false),
            );
          }}
        >
          {copiado ? 'Copiado' : 'Copiar código'}
        </Button>
      </div>
      <span style={{ font: '400 12.5px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
        El diagrama y su código se generan desde el grafo cada vez que se lee. Editar el
        código no cambia el journey: lo que gobierna es el modelo, no el dibujo.
      </span>
      <DiagramaMermaid codigo={codigo} />
      <pre
        style={{
          font: '400 12px/1.65 var(--font-mono)',
          color: 'var(--ink)',
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)',
          padding: 14,
          margin: 0,
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {codigo}
      </pre>
    </Card>
  );
}

/** Blueprint (RF-05.4): el MISMO grafo por carriles. Los pasos ordenan las columnas. */
function BloqueBlueprint({ carriles }: { carriles: ReturnType<typeof carrilesDeJourney> }) {
  if (carriles.pasos.length === 0) {
    return (
      <Card style={{ padding: 24 }}>
        <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
          El blueprint se ordena por pasos: agrega pasos al journey para verlo.
        </span>
      </Card>
    );
  }
  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={micro}>Blueprint por carriles</span>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
          <thead>
            <tr>
              <th
                style={{
                  ...micro,
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderBottom: '1px solid var(--border-strong)',
                  whiteSpace: 'nowrap',
                }}
              >
                Carril
              </th>
              {carriles.pasos.map((p) => (
                <th
                  key={p.id}
                  style={{
                    font: '600 12px var(--font-sans)',
                    color: 'var(--ink)',
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderBottom: '1px solid var(--border-strong)',
                    minWidth: 150,
                  }}
                >
                  {p.etiqueta}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {carriles.carriles.map((c) => (
              <tr key={c.nombre}>
                <td
                  style={{
                    font: '500 12px var(--font-sans)',
                    color: 'var(--text-muted)',
                    padding: '8px 10px',
                    borderBottom: '1px solid var(--border)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.nombre}
                </td>
                {carriles.pasos.map((p) => (
                  <td
                    key={p.id}
                    style={{
                      font: '400 12px/1.5 var(--font-sans)',
                      color: 'var(--text-body)',
                      padding: '8px 10px',
                      borderBottom: '1px solid var(--border)',
                      verticalAlign: 'top',
                    }}
                  >
                    {(c.porPaso[p.id] ?? []).map((n) => n.etiqueta).join(' · ') || '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Informe accionable (RF-05.6): señala huecos, no bloquea. El gate decide (I2). */
function BloqueValidacion({ senales }: { senales: SenalValidacion[] }) {
  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={micro}>Validación del grafo</span>
      <span style={{ font: '400 12.5px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
        Ninguna señal bloquea por sí sola: quien decide si el journey es suficiente es el
        gate de la etapa, no esta pantalla.
      </span>
      {senales.length === 0 && (
        <span style={{ font: '400 13px var(--font-sans)', color: 'var(--accent)' }}>
          Sin señales: cada paso tiene evidencia, entrada, salida, fase y responsable donde
          corresponde.
        </span>
      )}
      {senales.map((s, i) => (
        <div
          key={`${s.codigo}-${s.nodoId}-${i}`}
          style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}
        >
          <span
            style={{
              font: '500 10.5px var(--font-mono)',
              color: COLOR_SEVERIDAD[s.severidad],
              textTransform: 'uppercase',
              letterSpacing: '.06em',
            }}
          >
            {s.severidad}
          </span>
          <span style={{ font: '600 12.5px var(--font-sans)', color: 'var(--ink)' }}>
            {s.etiqueta}
          </span>
          <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-body)' }}>
            {s.mensaje}
          </span>
        </div>
      ))}
    </Card>
  );
}
