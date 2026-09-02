import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import { Wordmark } from '@/components/ui/Wordmark';
import { arbolDelWorkspace } from '@/lib/arbol/arbol.functions';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import { crearJourneyDeServicio, listaDeJourneys } from '@/lib/journey/journey.functions';
import { TIPOS_JOURNEY, type ResumenJourney, type TipoJourney } from '@/lib/journey/journey.schemas';

/**
 * Journeys del workspace (SPEC-05): el as-is y el to-be de cada servicio como grafo
 * tipado. Esta pantalla solo lista y crea; el grafo se edita dentro.
 */
export const Route = createFileRoute('/_autenticada/journeys')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    if (!workspaceId) return null;
    const [journeys, arbol] = await Promise.all([
      listaDeJourneys({ data: { workspaceId } }),
      arbolDelWorkspace({ data: { workspaceId } }),
    ]);
    // Los proyectos cuelgan del reto, y un reto que afecta a este servicio está anclado en
    // OTRO: el mapa se arma sobre el árbol entero para poder resolverlos desde cualquier
    // servicio sin volver a consultar.
    const proyectosPorReto = new Map(
      (arbol?.servicios ?? []).flatMap((s) =>
        s.retos.map(
          (r) => [r.id, r.proyectos.map((p) => ({ id: p.id, etiqueta: `${p.codigo} ${p.titulo}` }))] as const,
        ),
      ),
    );
    return {
      workspaceId,
      journeys: journeys.journeys,
      siguienteJourney: journeys.siguiente,
      servicios: (arbol?.servicios ?? []).map((s) => {
        // Un reto anclado en el servicio A que AFECTA al B es el que empuja el journey del
        // B: si el selector solo ofreciera los anclados, ese journey no podría asociarse al
        // reto que lo motiva. Se unen y se deduplican por id, que es lo que el árbol ya
        // separa para no repetir la relación.
        const vistos = new Set<string>();
        const retos = [...s.retos, ...s.retosQueAfectan]
          .filter((r) => !vistos.has(r.id) && vistos.add(r.id))
          .map((r) => ({
            id: r.id,
            etiqueta: `${r.codigo} ${r.titulo}`,
            proyectos: proyectosPorReto.get(r.id) ?? [],
          }));
        return { id: s.id, nombre: s.nombre, retos };
      }),
    };
  },
  component: PantallaJourneys,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const ETIQUETA_TIPO_JOURNEY: Record<TipoJourney, string> = {
  'as-is': 'as-is (cómo es hoy)',
  'to-be': 'to-be (cómo debería ser)',
};

function PantallaJourneys() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState(false);
  const rol = membresiaActiva?.rol ?? '';
  const puedeCrear = (ROLES_CURADORES as readonly string[]).includes(rol);

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
            Journeys y blueprints
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
              No hay workspace activo.
            </span>
          </Card>
        )}
        {datos && (
          <>
            <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={micro}>Qué es esto</span>
              <span style={{ font: '400 13.5px/1.65 var(--font-sans)', color: 'var(--text-body)' }}>
                El journey es un <strong>grafo tipado</strong>, no un lienzo: cada elemento
                tiene tipo (fase, paso, touchpoint, sistema, fricción…) y cada relación
                tiene semántica (transición, soporta, duele en…). El diagrama Mermaid y la
                vista de carriles del blueprint son <em>renders</em> de ese modelo — editar
                el código exportado no cambia nada, porque nada lo lee.
              </span>
            </Card>

            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}

            {puedeCrear && !abierto && (
              <div>
                <Button size="sm" onClick={() => setAbierto(true)}>
                  Nuevo journey
                </Button>
              </div>
            )}
            {puedeCrear && abierto && (
              <FormularioJourney
                workspaceId={datos.workspaceId}
                servicios={datos.servicios}
                onCerrar={() => setAbierto(false)}
                onError={setError}
                onCreado={async (journeyId) => {
                  setAbierto(false);
                  await router.invalidate();
                  await navigate({ to: '/journey/$journeyId', params: { journeyId } });
                }}
              />
            )}

            {/* Remontada por el borde de la primera página: crear un journey invalida la
                ruta y el loader devuelve otra, así que el cursor acumulado apuntaría más
                allá del que se desplazó. Misma forma que la lista de insights. */}
            <ListaDeJourneys
              key={datos.siguienteJourney ?? ''}
              workspaceId={datos.workspaceId}
              primeraPagina={datos.journeys}
              cursorInicial={datos.siguienteJourney}
              onError={setError}
            />
          </>
        )}
      </main>
    </div>
  );
}

/**
 * La lista paginada. El corte duro dejaba fuera para siempre a los journeys más
 * antiguos, y esta pantalla es la ÚNICA puerta al grafo: quedar fuera del corte
 * equivalía a desaparecer del producto.
 */
function ListaDeJourneys({
  workspaceId,
  primeraPagina,
  cursorInicial,
  onError,
}: {
  workspaceId: string;
  primeraPagina: ResumenJourney[];
  cursorInicial: string | null;
  onError: (e: string | null) => void;
}) {
  const [masPaginas, setMasPaginas] = useState<ResumenJourney[]>([]);
  const [cursor, setCursor] = useState<string | null>(cursorInicial);
  const [cargando, setCargando] = useState(false);
  const listados = [...primeraPagina, ...masPaginas];

  async function cargarMas() {
    if (!cursor) return;
    setCargando(true);
    onError(null);
    try {
      const r = await listaDeJourneys({ data: { workspaceId, cursor } });
      setMasPaginas((previas) => [...previas, ...r.journeys]);
      setCursor(r.siguiente);
    } catch {
      onError('No se pudieron cargar más journeys; intenta de nuevo');
    } finally {
      setCargando(false);
    }
  }

  if (listados.length === 0) {
    return (
      <Card style={{ padding: 24 }}>
        <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
          Todavía no hay journeys en este workspace.
        </span>
      </Card>
    );
  }

  return (
    <>
      {listados.map((j) => (
        <Card key={j.id} style={{ padding: 18 }}>
          <Link
            to="/journey/$journeyId"
            params={{ journeyId: j.id }}
            style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ font: '600 14px var(--font-sans)', color: 'var(--ink)' }}>
                {j.nombre}
              </span>
              <Tag>{j.tipo}</Tag>
              {j.snapshots > 0 && (
                <Tag mono={false}>
                  {j.snapshots} {j.snapshots === 1 ? 'snapshot' : 'snapshots'}
                </Tag>
              )}
            </div>
            <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              {j.servicioNombre} · {j.nodos} {j.nodos === 1 ? 'elemento' : 'elementos'}
            </span>
          </Link>
        </Card>
      ))}
      {cursor && (
        <div>
          <Button size="sm" variant="secondary" disabled={cargando} onClick={() => void cargarMas()}>
            {cargando ? 'Cargando…' : 'Cargar más journeys'}
          </Button>
        </div>
      )}
    </>
  );
}

function FormularioJourney({
  workspaceId,
  servicios,
  onCerrar,
  onError,
  onCreado,
}: {
  workspaceId: string;
  servicios: {
    id: string;
    nombre: string;
    retos: { id: string; etiqueta: string; proyectos: { id: string; etiqueta: string }[] }[];
  }[];
  onCerrar: () => void;
  onError: (e: string | null) => void;
  onCreado: (journeyId: string) => Promise<void>;
}) {
  const [servicioId, setServicioId] = useState('');
  const [retoId, setRetoId] = useState('');
  const [proyectoId, setProyectoId] = useState('');
  const [tipo, setTipo] = useState<TipoJourney>('as-is');
  const [nombre, setNombre] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const retos = servicios.find((s) => s.id === servicioId)?.retos ?? [];
  const proyectos = retos.find((r) => r.id === retoId)?.proyectos ?? [];

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true);
    onError(null);
    try {
      const r = await crearJourneyDeServicio({
        data: {
          workspaceId,
          servicioId,
          // El as-is puede existir antes de que haya reto; el to-be casi siempre nace
          // dentro de uno, pero no se exige aquí: lo exigiría el gate, no el formulario.
          retoId: retoId === '' ? null : retoId,
          // El proyecto cuelga del reto: sin reto no hay proyecto que asociar, y el
          // selector lo refleja deshabilitándose.
          proyectoId: proyectoId === '' ? null : proyectoId,
          tipo,
          nombre,
          descripcion,
        },
      });
      if (r.ok) await onCreado(r.journeyId);
      else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20 }}>
      <form onSubmit={(e) => void enviar(e)} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={micro}>Nuevo journey</span>
        <Select
          value={servicioId}
          onChange={(e) => {
            setServicioId(e.target.value);
            setRetoId('');
            setProyectoId('');
          }}
          required
        >
          <option value="">Servicio…</option>
          {servicios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.nombre}
            </option>
          ))}
        </Select>
        <Select value={tipo} onChange={(e) => setTipo(e.target.value as TipoJourney)}>
          {TIPOS_JOURNEY.map((t) => (
            <option key={t} value={t}>
              {ETIQUETA_TIPO_JOURNEY[t]}
            </option>
          ))}
        </Select>
        <Select
          value={retoId}
          onChange={(e) => {
            setRetoId(e.target.value);
            setProyectoId('');
          }}
          disabled={servicioId === ''}
        >
          <option value="">Sin reto asociado (opcional)</option>
          {retos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.etiqueta}
            </option>
          ))}
        </Select>
        <Select
          value={proyectoId}
          onChange={(e) => setProyectoId(e.target.value)}
          disabled={proyectos.length === 0}
        >
          <option value="">Sin proyecto asociado (opcional)</option>
          {proyectos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.etiqueta}
            </option>
          ))}
        </Select>
        <Input
          placeholder="Nombre del journey"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          required
        />
        <Textarea
          placeholder="Alcance: dónde empieza y dónde termina (opcional)"
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          rows={2}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" type="submit" disabled={ocupado || servicioId === '' || nombre.trim() === ''}>
            Crear
          </Button>
          <Button size="sm" variant="ghost" type="button" disabled={ocupado} onClick={onCerrar}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}
