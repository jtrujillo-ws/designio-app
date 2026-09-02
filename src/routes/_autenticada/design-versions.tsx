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
import {
  crearDesignVersionDelProyecto,
  listaDeDesignVersions,
} from '@/lib/entrega/entrega.functions';
import { listaDeJourneys } from '@/lib/journey/journey.functions';

/**
 * Design versions del workspace (SPEC-06). Esta pantalla lista y abre; la cadena entera
 * —elementos, diff, releases, effective state y conciliación— vive dentro de cada una.
 */
export const Route = createFileRoute('/_autenticada/design-versions')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    if (!workspaceId) return null;
    const [versiones, arbol] = await Promise.all([
      listaDeDesignVersions({ data: { workspaceId } }),
      arbolDelWorkspace({ data: { workspaceId } }),
    ]);
    // Los proyectos cuelgan del RETO, y un reto que afecta a este servicio está anclado en
    // otro: el mapa se arma sobre el árbol entero para poder resolverlos desde cualquier
    // servicio. Mismo apaño que la pantalla de journeys, por el mismo motivo.
    const proyectosPorReto = new Map(
      (arbol?.servicios ?? []).flatMap((s) =>
        s.retos.map(
          (r) =>
            [r.id, r.proyectos.map((p) => ({ id: p.id, etiqueta: `${p.codigo} ${p.titulo}` }))] as const,
        ),
      ),
    );
    return {
      workspaceId,
      versiones,
      // Una design version cuelga de un proyecto y cambia UN servicio. Los proyectos
      // ofrecidos salen de los retos ANCLADOS en el servicio y de los que lo declaran
      // AFECTADO: un reto anclado en A que afecta a B es exactamente el que empuja el
      // rediseño de B, y ofrecer solo los anclados dejaba a B sin forma de crear la
      // design version que lo cambia.
      servicios: (arbol?.servicios ?? []).map((s) => {
        const vistos = new Set<string>();
        return {
          id: s.id,
          nombre: s.nombre,
          proyectos: [...s.retos, ...s.retosQueAfectan]
            .filter((r) => !vistos.has(r.id) && vistos.add(r.id))
            .flatMap((r) => proyectosPorReto.get(r.id) ?? []),
        };
      }),
      versionesAprobadas: versiones.filter((v) => v.estado === 'aprobada'),
    };
  },
  component: PantallaDesignVersions,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

function PantallaDesignVersions() {
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
            Design versions y releases
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
                La <strong>design version</strong> es qué se decidió cambiar, elemento por
                elemento. Aprobarla la vuelve <strong>inmutable</strong> y congela el
                snapshot del grafo to-be: a partir de ahí, cambiar algo es crear una
                versión nueva que supere a esta. Sus elementos se reparten en{' '}
                <strong>releases parciales</strong> —cada elemento en exactamente uno— y lo
                que quedó funcionando se constata en el <strong>effective state</strong>,
                con las desviaciones y su razón. El diff no se escribe: se calcula contra
                el estado efectivo vigente del servicio.
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
                  Nueva design version
                </Button>
              </div>
            )}
            {puedeCrear && abierto && (
              <FormularioDesignVersion
                workspaceId={datos.workspaceId}
                servicios={datos.servicios}
                aprobadas={datos.versionesAprobadas}
                onCerrar={() => setAbierto(false)}
                onError={setError}
                onCreada={async (designVersionId) => {
                  setAbierto(false);
                  await router.invalidate();
                  await navigate({ to: '/design-version/$designVersionId', params: { designVersionId } });
                }}
              />
            )}

            {datos.versiones.length === 0 && (
              <Card style={{ padding: 24 }}>
                <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
                  Todavía no hay design versions en este workspace.
                </span>
              </Card>
            )}

            {datos.versiones.map((v) => (
              <Card key={v.id} style={{ padding: 18 }}>
                <Link
                  to="/design-version/$designVersionId"
                  params={{ designVersionId: v.id }}
                  style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <Tag>{v.codigo}</Tag>
                    <span style={{ font: '600 14px var(--font-sans)', color: 'var(--ink)' }}>
                      {v.titulo}
                    </span>
                    <Tag mono={false}>{v.estado}</Tag>
                  </div>
                  <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
                    {v.servicioNombre} · {v.proyectoCodigo} · {v.elementos}{' '}
                    {v.elementos === 1 ? 'elemento' : 'elementos'} · {v.releases}{' '}
                    {v.releases === 1 ? 'release' : 'releases'}
                    {v.aprobadaEn ? ` · aprobada el ${v.aprobadaEn}` : ''}
                  </span>
                </Link>
              </Card>
            ))}
          </>
        )}
      </main>
    </div>
  );
}

function FormularioDesignVersion({
  workspaceId,
  servicios,
  aprobadas,
  onCerrar,
  onError,
  onCreada,
}: {
  workspaceId: string;
  servicios: { id: string; nombre: string; proyectos: { id: string; etiqueta: string }[] }[];
  aprobadas: { id: string; codigo: string; titulo: string; servicioId: string }[];
  onCerrar: () => void;
  onError: (e: string | null) => void;
  onCreada: (designVersionId: string) => Promise<void>;
}) {
  const [servicioId, setServicioId] = useState('');
  const [proyectoId, setProyectoId] = useState('');
  const [journeyId, setJourneyId] = useState('');
  const [superaA, setSuperaA] = useState('');
  const [titulo, setTitulo] = useState('');
  const [resumen, setResumen] = useState('');
  const [ocupado, setOcupado] = useState(false);
  // Los to-be del servicio elegido se piden BAJO DEMANDA, no en el loader. La lista de
  // journeys se pagina por keyset, así que traer «la primera página de los to-be del
  // workspace» y filtrar por servicio en el cliente deja fuera de alcance los de un
  // servicio que quede detrás del corte — el mismo agujero que la paginación vino a
  // cerrar, reintroducido en el selector. Filtrando por servicio en el servidor, lo que
  // se pide es siempre un conjunto pequeño y completo.
  const [journeys, setJourneys] = useState<{ id: string; nombre: string }[]>([]);
  const [hayMasJourneys, setHayMasJourneys] = useState(false);
  const [cargandoJourneys, setCargandoJourneys] = useState(false);
  const proyectos = servicios.find((s) => s.id === servicioId)?.proyectos ?? [];
  // Solo se supera a una versión del MISMO servicio (SYS-05, y ahora también el guard de
  // alta): ofrecer las de otros creaba un borrador que no se puede aprobar, ni corregir
  // —`supera_a` no está en el grant— ni borrar.
  const superables = aprobadas.filter((v) => v.servicioId === servicioId);

  async function elegirServicio(nuevo: string) {
    setServicioId(nuevo);
    // Proyecto, journey y «supera a» eran del servicio anterior: dejarlos puestos mandaría
    // al endpoint combinaciones que los guards rechazan.
    setProyectoId('');
    setJourneyId('');
    setSuperaA('');
    setJourneys([]);
    setHayMasJourneys(false);
    if (nuevo === '') return;
    setCargandoJourneys(true);
    try {
      const pagina = await listaDeJourneys({
        data: { workspaceId, servicioId: nuevo, tipo: 'to-be' },
      });
      setJourneys(pagina.journeys.map((j) => ({ id: j.id, nombre: j.nombre })));
      setHayMasJourneys(pagina.siguiente !== null);
    } finally {
      setCargandoJourneys(false);
    }
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true);
    onError(null);
    try {
      const r = await crearDesignVersionDelProyecto({
        data: {
          workspaceId,
          servicioId,
          proyectoId,
          journeyId: journeyId === '' ? null : journeyId,
          superaA: superaA === '' ? null : superaA,
          titulo,
          resumen,
        },
      });
      if (r.ok) await onCreada(r.designVersionId);
      else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20 }}>
      <form onSubmit={(e) => void enviar(e)} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={micro}>Nueva design version</span>
        <Select
          value={servicioId}
          onChange={(e) => void elegirServicio(e.target.value)}
          required
        >
          <option value="">Servicio que cambia…</option>
          {servicios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.nombre}
            </option>
          ))}
        </Select>
        <Select
          value={proyectoId}
          onChange={(e) => setProyectoId(e.target.value)}
          disabled={servicioId === ''}
          required
        >
          <option value="">Proyecto que la produce…</option>
          {proyectos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.etiqueta}
            </option>
          ))}
        </Select>
        <Select
          value={journeyId}
          onChange={(e) => setJourneyId(e.target.value)}
          disabled={servicioId === '' || cargandoJourneys}
        >
          <option value="">
            {cargandoJourneys
              ? 'Buscando los to-be del servicio…'
              : 'Journey to-be (se puede enlazar después)'}
          </option>
          {journeys.map((j) => (
            <option key={j.id} value={j.id}>
              {j.nombre}
            </option>
          ))}
        </Select>
        {hayMasJourneys && (
          <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
            Este servicio tiene más journeys to-be de los que caben aquí; si el que buscas
            no aparece, enlázalo después desde la design version.
          </span>
        )}
        <Select value={superaA} onChange={(e) => setSuperaA(e.target.value)} disabled={servicioId === ''}>
          <option value="">No supera a ninguna (primera del servicio)</option>
          {superables.map((v) => (
            <option key={v.id} value={v.id}>
              Supera a {v.codigo} · {v.titulo}
            </option>
          ))}
        </Select>
        <Input
          placeholder="Título de la design version"
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          required
        />
        <Textarea
          placeholder="Qué propone, en una frase (opcional)"
          value={resumen}
          onChange={(e) => setResumen(e.target.value)}
          rows={2}
        />
        <span style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
          Nace en borrador. Aprobar exige un journey to-be del servicio y al menos un
          elemento de cambio; si el servicio ya tiene una design version aprobada, esta
          debe declarar a cuál supera (SYS-05). El journey se puede enlazar o cambiar
          después desde la propia design version, mientras siga en borrador.
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            size="sm"
            type="submit"
            disabled={ocupado || servicioId === '' || proyectoId === '' || titulo.trim() === ''}
          >
            Crear borrador
          </Button>
          <Button size="sm" variant="ghost" type="button" disabled={ocupado} onClick={onCerrar}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}
