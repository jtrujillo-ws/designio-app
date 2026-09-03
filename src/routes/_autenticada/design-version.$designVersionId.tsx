import { useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tabs } from '@/components/ui/Tabs';
import { Tag } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import { Wordmark } from '@/components/ui/Wordmark';
import { PanelDeHilos } from '@/components/portal/PanelDeHilos';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import { hilosDelPortal } from '@/lib/portal/portal.functions';
import type { HiloDeObjeto } from '@/lib/portal/portal.schemas';
import { calcularDiff, elementosEnEstadoDesconocido } from '@/lib/entrega/entrega.diff';
import {
  agregarElementoDeCambio,
  aprobarYCongelarDesignVersion,
  asignarElementoARelease,
  moverElementoDeRelease,
  borrarElementoDeCambio,
  cadenaDelRelease,
  conciliacionDeDesignVersion,
  constatarReleaseDesplegado,
  declararSuperaADeDesignVersion,
  designVersionDelWorkspace,
  editarElementoDeCambio,
  enlazarJourneyDeDesignVersion,
  planificarReleaseDeDesignVersion,
  quitarElementoDeRelease,
  registrarDespliegue,
} from '@/lib/entrega/entrega.functions';
import {
  ETIQUETA_CONCILIACION,
  ETIQUETA_RESULTADO,
  ETIQUETA_TIPO_ELEMENTO,
  OPERACIONES,
  RESULTADOS_CONSTATACION,
  TIPOS_ELEMENTO,
  type DesignVersionCompleta,
  type Operacion,
  type ReleaseDeDesignVersion,
  type ResultadoConstatacion,
  type TipoElemento,
} from '@/lib/entrega/entrega.schemas';

/**
 * La design version por dentro (SPEC-06): los elementos SON el modelo; el diff, el plan
 * de releases y el tablero de conciliación son tres lecturas de la MISMA proyección
 * —leída en una sentencia—, así que no pueden discrepar entre ellas.
 */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute('/_autenticada/design-version/$designVersionId')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ context, params }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    if (!workspaceId || !ES_UUID.test(params.designVersionId)) return null;
    const [dv, tablero, portal] = await Promise.all([
      designVersionDelWorkspace({ data: { workspaceId, designVersionId: params.designVersionId } }),
      conciliacionDeDesignVersion({
        data: { workspaceId, designVersionId: params.designVersionId },
      }),
      // El portal (RF-01.5) sobre la design version: es el objeto que el cliente discute
      // —qué se decidió cambiar—, y hasta ahora era el único de la cadena sin hilos. Va
      // en paralelo porque su id ya se conoce: no hace falta esperar a la proyección.
      hilosDelPortal({
        data: {
          workspaceId,
          objetos: [{ tipo: 'design_version', id: params.designVersionId }],
        },
      }),
    ]);
    if (!dv) return null;
    return {
      workspaceId,
      dv,
      tablero,
      hilos: portal?.hilos ?? [],
      hayMasHilos: portal?.hayMas ?? false,
    };
  },
  component: PantallaDesignVersion,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const cuerpo: CSSProperties = { font: '400 13px/1.6 var(--font-sans)', color: 'var(--text-body)' };
const apunte: CSSProperties = { font: '400 12px/1.5 var(--font-sans)', color: 'var(--text-muted)' };

const VISTAS = ['Elementos', 'Diff', 'Releases', 'Conciliación'];

/**
 * El día de hoy en el calendario DEL NAVEGADOR, no en UTC.
 *
 * `toISOString().slice(0, 10)` convierte a UTC antes de recortar, así que al este de UTC
 * poco después de medianoche propone AYER y al oeste a última hora propone MAÑANA. Con
 * cualquier otro campo sería una molestia; con estos tres no: la fecha real del despliegue
 * (RF-06.5) y la de la constatación (RF-06.6) son historia INMUTABLE en cuanto se envían
 * —no hay UPDATE que las corrija— y encima ordenan el effective state vigente del servicio
 * (RF-06.10), así que un día de más o de menos reordena lo que un ciclo cambió sobre otro.
 * Y `fecha_objetivo` es el compromiso que G6 firma.
 *
 * Se compone con los getters locales en vez de restar el offset: `getTimezoneOffset()`
 * cambia con el horario de verano y aplicarlo a mano es otra forma de equivocarse.
 */
const HOY = () => {
  const ahora = new Date();
  const dosCifras = (n: number) => String(n).padStart(2, '0');
  return `${ahora.getFullYear()}-${dosCifras(ahora.getMonth() + 1)}-${dosCifras(ahora.getDate())}`;
};

function PantallaDesignVersion() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [vista, setVista] = useState(VISTAS[0]!);
  const [error, setError] = useState<string | null>(null);
  const rol = membresiaActiva?.rol ?? '';
  const esCurador = (ROLES_CURADORES as readonly string[]).includes(rol);
  const esLead = rol === 'lead-boutique';

  // El diff se CALCULA aquí (RF-06.2) sobre la misma proyección que alimenta el resto:
  // no hay tabla de diff, y no puede haber dos versiones del mismo contraste.
  const diff = useMemo(
    () => (datos ? calcularDiff(datos.dv.elementos, datos.dv.vigente) : null),
    [datos],
  );
  const desconocidos = useMemo(
    () => (datos?.tablero ? elementosEnEstadoDesconocido(datos.tablero.filas) : []),
    [datos],
  );

  async function refrescar() {
    setError(null);
    await router.invalidate();
  }

  if (!datos) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-app)', padding: 40 }}>
        <Card style={{ padding: 24, maxWidth: 600, margin: '0 auto' }}>
          <span style={cuerpo}>Esta design version no existe o ya no puedes verla.</span>
        </Card>
      </div>
    );
  }

  const { dv } = datos;
  const enBorrador = dv.estado === 'borrador';

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
            {dv.codigo} · {dv.titulo}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/design-versions' })}>
          ← Design versions
        </Button>
      </div>

      <main
        style={{
          maxWidth: 980,
          margin: '0 auto',
          padding: '24px 24px 60px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <Cabecera
          dv={dv}
          workspaceId={datos.workspaceId}
          hilos={datos.hilos}
          hayMasHilos={datos.hayMasHilos}
          rol={rol}
          onCambio={refrescar}
        />

        {error && (
          <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
            {error}
          </span>
        )}

        {enBorrador && esCurador && (
          <EnlazarJourneyToBe
            workspaceId={datos.workspaceId}
            dv={dv}
            onError={setError}
            onHecho={refrescar}
          />
        )}

        {enBorrador && esCurador && (
          <DeclararSucesion
            workspaceId={datos.workspaceId}
            dv={dv}
            onError={setError}
            onHecho={refrescar}
          />
        )}

        {enBorrador && esLead && (
          <AprobarDesignVersion
            workspaceId={datos.workspaceId}
            dv={dv}
            onError={setError}
            onHecho={refrescar}
          />
        )}

        <Tabs items={VISTAS} value={vista} onChange={setVista} />

        {vista === 'Elementos' && (
          <VistaElementos
            workspaceId={datos.workspaceId}
            dv={dv}
            puedeEditar={esCurador && enBorrador}
            onError={setError}
            onHecho={refrescar}
          />
        )}

        {vista === 'Diff' && diff && <VistaDiff diff={diff} dv={dv} />}

        {vista === 'Releases' && (
          <VistaReleases
            workspaceId={datos.workspaceId}
            dv={dv}
            // Planificar sale de la RESPONSABILIDAD, no del estado: una versión que superó
            // OTRO proyecto sigue a cargo del suyo —y desde el arreglo de G7 el gate del que
            // la superó depende de que la termine—, así que la pantalla tiene que dejarle
            // completar el plan. Lo que se apaga es la que el propio proyecto reemplazó.
            // Completar lo que YA está en marcha no se apaga nunca — ver VistaReleases.
            puedePlanificar={esLead && dv.aCargoDelProyecto}
            puedeCompletar={esLead && dv.estado !== 'borrador'}
            onError={setError}
            onHecho={refrescar}
          />
        )}

        {vista === 'Conciliación' && (
          <VistaConciliacion
            tablero={datos.tablero}
            desconocidos={desconocidos}
            proyectoId={dv.proyectoId}
            aCargo={dv.aCargoDelProyecto}
            bloqueo={dv.bloqueoDeG7}
          />
        )}
      </main>
    </div>
  );
}

function Cabecera({
  dv,
  workspaceId,
  hilos,
  hayMasHilos,
  rol,
  onCambio,
}: {
  dv: DesignVersionCompleta;
  workspaceId: string;
  hilos: HiloDeObjeto[];
  hayMasHilos: boolean;
  rol: string;
  onCambio: () => Promise<void>;
}) {
  return (
    <Card style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Tag>{dv.codigo}</Tag>
        <Tag mono={false}>{dv.estado}</Tag>
        <span style={apunte}>
          {dv.servicioNombre} · {dv.proyectoCodigo}
          {dv.journeyNombre ? ` · to-be: ${dv.journeyNombre}` : ' · sin journey to-be enlazado'}
        </span>
      </div>
      {dv.resumen !== '' && <span style={cuerpo}>{dv.resumen}</span>}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', ...apunte }}>
        {dv.aprobadaEn && <span>Aprobada el {dv.aprobadaEn}, con snapshot del grafo congelado</span>}
        {dv.superaA && (
          <Link
            to="/design-version/$designVersionId"
            params={{ designVersionId: dv.superaA.id }}
            style={{ color: 'var(--accent)' }}
          >
            supera a {dv.superaA.codigo}
          </Link>
        )}
        {dv.superadaPor && (
          <Link
            to="/design-version/$designVersionId"
            params={{ designVersionId: dv.superadaPor.id }}
            style={{ color: 'var(--accent)' }}
          >
            superada por {dv.superadaPor.codigo}
          </Link>
        )}
      </div>
      {dv.estado === 'aprobada' && (
        <span style={apunte}>
          Inmutable (SYS-05): cambiar algo aquí exige crear una design version nueva que
          supere a esta.
        </span>
      )}
      {/* El portal es el canal del cliente (RF-01.5) y la design version es lo que discute:
          qué se decidió cambiar. Los hilos NO se congelan con la aprobación —la
          conversación sobre lo aprobado sigue siendo legítima, igual que en un gate ya
          aprobado—, así que el panel se dibuja en cualquier estado. */}
      <PanelDeHilos
        workspaceId={workspaceId}
        objeto={{ tipo: 'design_version', id: dv.id }}
        hilos={hilos}
        rol={rol}
        onCambio={onCambio}
      />
      {hayMasHilos && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Esta vista muestra los hilos más recientes de la design version; hay más en el
          portal.
        </span>
      )}
    </Card>
  );
}

/**
 * El enlace que el formulario de alta promete poder poner «después». Solo sobre
 * BORRADORES (la política no alcanza otra cosa) y solo con los to-be del servicio que el
 * guard acepta, que son los que trae la proyección: el selector no ofrece nada que el
 * endpoint vaya a rechazar.
 */
function EnlazarJourneyToBe({
  workspaceId,
  dv,
  onError,
  onHecho,
}: {
  workspaceId: string;
  dv: DesignVersionCompleta;
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [journeyId, setJourneyId] = useState(dv.journeyId ?? '');
  const [ocupado, setOcupado] = useState(false);
  const sinCandidatos = dv.journeysEnlazables.length === 0;

  return (
    <Card style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={micro}>Journey to-be</span>
      <span style={apunte}>
        {dv.journeyId === null
          ? 'Este borrador todavía no enlaza el grafo objetivo. Aprobar congela su snapshot (RF-06.3), así que sin journey no hay aprobación posible.'
          : 'Mientras la design version siga en borrador, el grafo objetivo se puede cambiar. Al aprobarla, su snapshot queda congelado y este enlace deja de moverse.'}
      </span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Select
          value={journeyId}
          onChange={(e) => setJourneyId(e.target.value)}
          disabled={sinCandidatos}
          style={{ flex: '1 1 280px' }}
        >
          <option value="">Journey to-be de {dv.servicioNombre}…</option>
          {dv.journeysEnlazables.map((j) => (
            <option key={j.id} value={j.id}>
              {j.nombre}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={ocupado || journeyId === '' || journeyId === dv.journeyId}
          onClick={async () => {
            setOcupado(true);
            onError(null);
            try {
              const r = await enlazarJourneyDeDesignVersion({
                data: { workspaceId, designVersionId: dv.id, journeyId },
              });
              if (r.ok) await onHecho();
              else onError(r.error);
            } finally {
              setOcupado(false);
            }
          }}
        >
          Enlazar
        </Button>
      </div>
      {sinCandidatos && (
        <span style={apunte}>
          {dv.servicioNombre} no tiene ningún journey to-be de este proyecto: créalo primero
          en la pantalla de journeys.
        </span>
      )}
    </Card>
  );
}

/**
 * A qué versión aprobada sucede este borrador (SYS-05). Mismo camino que el enlace del
 * journey y por el mismo motivo: la sucesión se declara al abrirlo, pero el servicio puede
 * aprobar otra versión mientras tanto —o la declarada puede perder su propia carrera de
 * sucesión, que el modelo admite expresamente—, y sin poder reapuntarla el borrador queda
 * inaprobable y, como no hay DELETE, muerto en la lista.
 */
function DeclararSucesion({
  workspaceId,
  dv,
  onError,
  onHecho,
}: {
  workspaceId: string;
  dv: DesignVersionCompleta;
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [superaA, setSuperaA] = useState(dv.superaA?.id ?? '');
  const [ocupado, setOcupado] = useState(false);
  // Sin ninguna aprobada del servicio no hay sucesión que declarar: la primera versión no
  // supera a nada, y el guard rechaza que diga lo contrario.
  if (dv.superables.length === 0 && dv.superaA === null) return null;

  return (
    <Card style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={micro}>A qué versión sucede</span>
      <span style={apunte}>
        Un servicio tiene como mucho una design version aprobada (SYS-05): para aprobar
        esta, tiene que declarar a cuál reemplaza. Se puede corregir mientras siga en
        borrador.
      </span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Select
          value={superaA}
          onChange={(e) => setSuperaA(e.target.value)}
          style={{ flex: '1 1 280px' }}
        >
          {/* «No supera a ninguna» solo cuando de verdad no hay a cuál: con una aprobada
              del servicio, `design_version_anclaje_guard` rechaza necesariamente el null
              (SYS-05 admite una sola aprobada). Ofrecerlo era ofrecer un error, el mismo
              que ya se quitó del formulario de alta. */}
          {dv.superables.length === 0 ? (
            <option value="">No supera a ninguna (primera del servicio)</option>
          ) : (
            // Con opciones reales el vacío sigue existiendo como estado inicial, pero se
            // ofrece deshabilitado: si no, el navegador pintaría la primera versión como
            // elegida mientras el estado sigue vacío y el botón no dejaría enviarla.
            <option value="" disabled>
              Elige a cuál supera…
            </option>
          )}
          {dv.superables.map((v) => (
            <option key={v.id} value={v.id}>
              {v.codigo} · {v.titulo}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={ocupado || superaA === (dv.superaA?.id ?? '')}
          onClick={async () => {
            setOcupado(true);
            onError(null);
            try {
              const r = await declararSuperaADeDesignVersion({
                data: {
                  workspaceId,
                  designVersionId: dv.id,
                  superaA: superaA === '' ? null : superaA,
                },
              });
              if (r.ok) await onHecho();
              else onError(r.error);
            } finally {
              setOcupado(false);
            }
          }}
        >
          Declarar
        </Button>
      </div>
    </Card>
  );
}

function AprobarDesignVersion({
  workspaceId,
  dv,
  onError,
  onHecho,
}: {
  workspaceId: string;
  dv: DesignVersionCompleta;
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function aprobar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await aprobarYCongelarDesignVersion({
        data: { workspaceId, designVersionId: dv.id, motivo },
      });
      if (r.ok) await onHecho();
      else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={micro}>Aprobar y congelar</span>
      <span style={apunte}>
        Aprobar vuelve inmutable la design version y congela un snapshot del grafo to-be en
        la misma transacción (RF-06.3). Si el servicio ya tenía una versión aprobada, esta
        la marca como superada.
      </span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Input
          placeholder="Motivo del snapshot (opcional)"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          style={{ flex: '1 1 280px' }}
        />
        <Button
          size="sm"
          disabled={
            ocupado ||
            dv.elementos.length === 0 ||
            dv.journeyId === null ||
            dv.proyectoCertificadoPor !== null
          }
          onClick={() => void aprobar()}
        >
          Aprobar (congela)
        </Button>
      </div>
      {dv.proyectoCertificadoPor !== null && (
        <span style={apunte}>
          Este proyecto ya certificó su G{dv.proyectoCertificadoPor}, y esa aprobación no se
          deshace (SPEC-04): aprobar aquí dejaría al gate afirmando algo que ya no es cierto.
          El ciclo siguiente de este servicio se abre en otro proyecto — y la cadena continúa
          igual, porque la sucesión va por servicio.
        </span>
      )}
      {dv.elementos.length === 0 && (
        <span style={apunte}>Falta al menos un elemento de cambio.</span>
      )}
      {dv.journeyId === null && (
        <span style={apunte}>
          Falta enlazar el journey to-be del servicio —arriba, en «Journey to-be»—: sin
          grafo no hay snapshot que congelar.
        </span>
      )}
    </Card>
  );
}

// ── Elementos de cambio (RF-06.1) ──

function VistaElementos({
  workspaceId,
  dv,
  puedeEditar,
  onError,
  onHecho,
}: {
  workspaceId: string;
  dv: DesignVersionCompleta;
  puedeEditar: boolean;
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {puedeEditar && !abierto && (
        <div>
          <Button size="sm" onClick={() => setAbierto(true)}>
            Añadir elemento de cambio
          </Button>
        </div>
      )}
      {puedeEditar && abierto && (
        <FormularioElemento
          workspaceId={workspaceId}
          dv={dv}
          onCerrar={() => setAbierto(false)}
          onError={onError}
          onHecho={async () => {
            setAbierto(false);
            await onHecho();
          }}
        />
      )}

      {dv.elementos.length === 0 && (
        <Card style={{ padding: 20 }}>
          <span style={apunte}>
            Todavía no hay elementos de cambio. Sin ellos no hay diff, ni plan de releases,
            ni nada que conciliar en G7.
          </span>
        </Card>
      )}

      {dv.elementos.map((el) => (
        <Card key={el.id} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Tag mono={false}>{ETIQUETA_TIPO_ELEMENTO[el.tipo]}</Tag>
            <Tag mono={false}>{el.operacion}</Tag>
            <span style={{ font: '600 13.5px var(--font-sans)', color: 'var(--ink)' }}>
              {el.titulo}
            </span>
          </div>
          {el.detalle !== '' && <span style={cuerpo}>{el.detalle}</span>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', ...apunte }}>
            {el.nodoEtiqueta && <span>Nodo del to-be: {el.nodoEtiqueta}</span>}
            {/* El grafo de trabajo se sigue editando mientras la versión es borrador
                (RF-05.8), así que el nodo enlazado puede haberse borrado por debajo.
                Aprobar con el enlace roto congelaría una promesa que el snapshot no
                puede cumplir, y el guard lo rechaza: aquí se ve antes, y se arregla. */}
            {el.nodoId && !el.nodoEtiqueta && (
              <span style={{ color: 'var(--danger)' }}>
                El nodo enlazado ya no está en el journey: desenlázalo o vuelve a
                enlazarlo antes de aprobar.
              </span>
            )}
            {el.decisiones.map((d) => (
              <span key={d.id}>decisión: {d.titulo}</span>
            ))}
            {el.insights.map((i) => (
              <span key={i.id}>insight: {i.titulo}</span>
            ))}
            {el.decisiones.length === 0 && el.insights.length === 0 && (
              <span>Sin decisión ni insight que lo motive: la cadena se corta aquí.</span>
            )}
          </div>
          {puedeEditar && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  onError(null);
                  const r = await borrarElementoDeCambio({
                    data: { workspaceId, elementoId: el.id },
                  });
                  if (r.ok) await onHecho();
                  else onError(r.error);
                }}
              >
                Quitar
              </Button>
              {el.nodoId && !el.nodoEtiqueta && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    onError(null);
                    const r = await editarElementoDeCambio({
                      data: {
                        workspaceId,
                        elementoId: el.id,
                        tipo: el.tipo,
                        operacion: el.operacion,
                        titulo: el.titulo,
                        detalle: el.detalle,
                        nodoId: null,
                      },
                    });
                    if (r.ok) await onHecho();
                    else onError(r.error);
                  }}
                >
                  Desenlazar el nodo
                </Button>
              )}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function FormularioElemento({
  workspaceId,
  dv,
  onCerrar,
  onError,
  onHecho,
}: {
  workspaceId: string;
  dv: DesignVersionCompleta;
  onCerrar: () => void;
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [tipo, setTipo] = useState<TipoElemento>('touchpoint');
  const [operacion, setOperacion] = useState<Operacion>('agrega');
  const [titulo, setTitulo] = useState('');
  const [detalle, setDetalle] = useState('');
  const [nodoId, setNodoId] = useState('');
  const [decisionId, setDecisionId] = useState('');
  const [insightId, setInsightId] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true);
    onError(null);
    try {
      const r = await agregarElementoDeCambio({
        data: {
          workspaceId,
          designVersionId: dv.id,
          tipo,
          operacion,
          titulo,
          detalle,
          nodoId: nodoId === '' ? null : nodoId,
          decisionIds: decisionId === '' ? [] : [decisionId],
          insightIds: insightId === '' ? [] : [insightId],
        },
      });
      if (r.ok) await onHecho();
      else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 18 }}>
      <form onSubmit={(e) => void enviar(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={micro}>Nuevo elemento de cambio</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Select
            value={tipo}
            onChange={(e) => setTipo(e.target.value as TipoElemento)}
            style={{ flex: '1 1 180px' }}
          >
            {TIPOS_ELEMENTO.map((t) => (
              <option key={t} value={t}>
                {ETIQUETA_TIPO_ELEMENTO[t]}
              </option>
            ))}
          </Select>
          <Select
            value={operacion}
            onChange={(e) => setOperacion(e.target.value as Operacion)}
            style={{ flex: '1 1 180px' }}
          >
            {OPERACIONES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </div>
        <Input
          placeholder="Qué cambia (una frase)"
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          required
        />
        <Textarea
          placeholder="Detalle (opcional)"
          value={detalle}
          onChange={(e) => setDetalle(e.target.value)}
          rows={2}
        />
        <Select value={nodoId} onChange={(e) => setNodoId(e.target.value)}>
          <option value="">Nodo del journey to-be (opcional)</option>
          {dv.nodosDelJourney.map((n) => (
            <option key={n.id} value={n.id}>
              {n.tipo} · {n.etiqueta}
            </option>
          ))}
        </Select>
        <Select value={decisionId} onChange={(e) => setDecisionId(e.target.value)}>
          <option value="">Decisión que lo motiva (opcional)</option>
          {dv.decisionesDelProyecto.map((d) => (
            <option key={d.id} value={d.id}>
              {d.titulo}
            </option>
          ))}
        </Select>
        <Select value={insightId} onChange={(e) => setInsightId(e.target.value)}>
          <option value="">Insight que lo motiva (opcional)</option>
          {dv.insightsValidados.map((i) => (
            <option key={i.id} value={i.id}>
              {i.titulo}
            </option>
          ))}
        </Select>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" type="submit" disabled={ocupado || titulo.trim() === ''}>
            Añadir
          </Button>
          <Button size="sm" variant="ghost" type="button" disabled={ocupado} onClick={onCerrar}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── Diff derivado (RF-06.2) ──

function VistaDiff({
  diff,
  dv,
}: {
  diff: ReturnType<typeof calcularDiff>;
  dv: DesignVersionCompleta;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={micro}>Diff contra el estado efectivo vigente</span>
        <span style={apunte}>
          {diff.contra
            ? `Calculado contra ${diff.contra.codigo} (${diff.contra.designVersionCodigo}, constatado el ${diff.contra.constatadoEn}) del servicio ${dv.servicioNombre}.`
            : `${dv.servicioNombre} todavía no tiene estado efectivo constatado: contra la nada, todo es alta.`}
        </span>
        <span style={apunte}>
          {diff.totales.agrega} agrega · {diff.totales.modifica} modifica ·{' '}
          {diff.totales.retira} retira
          {diff.totales.senales > 0 ? ` · ${diff.totales.senales} con señal` : ''}
        </span>
        <span style={apunte}>
          El diff no se escribe a mano: se deriva de estos dos lados cada vez que se mira.
        </span>
      </Card>

      {diff.filas.map((f) => (
        <Card key={f.elementoId} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Tag mono={false}>{f.veredicto}</Tag>
            <span style={{ font: '600 13.5px var(--font-sans)', color: 'var(--ink)' }}>
              {f.titulo}
            </span>
            {f.operacionDeclarada !== f.veredicto && (
              <span style={apunte}>declarado como «{f.operacionDeclarada}»</span>
            )}
          </div>
          {f.precedente && (
            <span style={apunte}>
              En el estado vigente: {f.precedente.titulo} ({ETIQUETA_RESULTADO[f.precedente.resultado]})
            </span>
          )}
          {f.senal && (
            <span style={{ font: '500 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
              {f.senal}
            </span>
          )}
        </Card>
      ))}

      {diff.seMantiene.length > 0 && (
        <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={micro}>Se mantiene</span>
          {diff.seMantiene.map((p) => (
            <span key={p.elementoId} style={apunte}>
              {p.titulo}
            </span>
          ))}
        </Card>
      )}
    </div>
  );
}

// ── Plan de releases, despliegue y constatación (RF-06.4/06.5/06.6) ──

/**
 * Dos permisos y no uno, porque son dos cosas distintas (RF-06.4/06.5/06.6):
 *
 *  · `puedePlanificar` — abrir un release nuevo y METER trabajo en uno planificado. Se
 *    apaga cuando la design version deja de estar A CARGO de su proyecto, o sea cuando el
 *    PROPIO proyecto la reemplazó: planificar bajo un diseño que uno mismo sustituyó es
 *    empezar algo que ya decidió no hacer. Si la superó otro proyecto sigue encendido, y
 *    tiene que estarlo: esa versión sigue contando para el G6 y el G7 de su proyecto —y
 *    para el G7 del que la superó—, así que negarle el plan la dejaría obligada a cubrir
 *    lo que no puede planificar.
 *  · `puedeCompletar` — cerrar lo que quedó abierto: desplegar lo ya planificado,
 *    constatar lo desplegado y RETIRAR de un release planificado lo que ya no va a salir.
 *    NO se apaga al superarse. Un release de DV-1 que ya salió cambió el servicio de
 *    verdad, y su constatación es la única forma de que eso entre en el effective state:
 *    el estado vigente de un servicio se arma con las constataciones de TODOS sus
 *    releases verificados, sea cual sea la design version de la que colgaban (RF-06.10).
 *    Apagar la sección entera al superarse dejaba ese release desplegado sin camino en la
 *    UI —la base y el servicio sí lo permiten— y el diff de cada versión futura quedaba
 *    ciego a lo que ese release cambió.
 *
 * Quitar alcance cayó del lado de COMPLETAR y no del de planificar, que es donde estaba:
 * es lo que cierra un release planificado de una versión superada que ya no va a salir, y
 * G7 espera por él (el guard cuenta los releases sin resolver de las superadas). Sin este
 * camino, el gate quedaba bloqueado sin nada que el lead pudiera hacer desde la pantalla
 * salvo registrar un despliegue que no ocurrió.
 */
function VistaReleases({
  workspaceId,
  dv,
  puedePlanificar,
  puedeCompletar,
  onError,
  onHecho,
}: {
  workspaceId: string;
  dv: DesignVersionCompleta;
  puedePlanificar: boolean;
  puedeCompletar: boolean;
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const asignados = new Set(dv.releases.flatMap((r) => r.elementos.map((e) => e.elementoId)));
  const pendientes = dv.elementos.filter((e) => !asignados.has(e.id));

  if (dv.estado === 'borrador') {
    return (
      <Card style={{ padding: 20 }}>
        <span style={apunte}>
          Los releases cuelgan de una design version APROBADA (SYS-06). Apruébala primero.
        </span>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {dv.estado === 'superada' && !puedePlanificar && (
        <Card style={{ padding: 16 }}>
          <span style={apunte}>
            Este proyecto reemplazó esta design version: no se planifican releases nuevos
            bajo ella, ni se le mete trabajo a los que había. Lo que quedó abierto sí se
            cierra desde aquí, y G7 lo espera: un release que salió cambió el servicio y su
            constatación es lo que mete ese cambio en el estado efectivo contra el que se
            calcula el diff de las versiones siguientes (RF-06.10); uno que ya no va a salir
            se cierra quitándole los elementos, y entonces deja de haber nada que constatar.
          </span>
        </Card>
      )}
      {dv.estado === 'superada' && puedePlanificar && (
        <Card style={{ padding: 16 }}>
          <span style={apunte}>
            Otro proyecto se llevó el servicio al ciclo siguiente, pero esta design version
            sigue siendo trabajo de ESTE: su G6 exige que cada elemento tenga release y su
            G7 que cada uno quede constatado, así que aquí se termina de planificar y de
            cerrar. Y no es solo asunto suyo: el G7 del proyecto que la superó también lo
            espera, porque lo que salga de aquí cambia el mismo servicio que aquel certifica.
            Lo que ya no vaya a construirse se cierra constatándolo como no implementado, con
            su razón — quitarle el alcance lo deja sin resolver, no lo resuelve.
          </span>
        </Card>
      )}
      {puedePlanificar && !abierto && (
        <div>
          <Button size="sm" onClick={() => setAbierto(true)}>
            Planificar release
          </Button>
        </div>
      )}
      {puedePlanificar && abierto && (
        <FormularioRelease
          workspaceId={workspaceId}
          dv={dv}
          pendientes={pendientes}
          onCerrar={() => setAbierto(false)}
          onError={onError}
          onHecho={async () => {
            setAbierto(false);
            await onHecho();
          }}
        />
      )}

      {/* Criterio de aceptación 2: los elementos no incluidos siguen VISIBLES como
          pendientes; no desaparecen porque el primer release no los cogió. */}
      <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={micro}>Elementos sin release ({pendientes.length})</span>
        {pendientes.length === 0 && (
          <span style={apunte}>Cada elemento de esta design version está en un release.</span>
        )}
        {pendientes.map((el) => (
          <div key={el.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={cuerpo}>{el.titulo}</span>
            {puedePlanificar && dv.releases.some((r) => r.estado === 'planificado') && (
              <AsignarAExistente
                workspaceId={workspaceId}
                elementoId={el.id}
                releases={dv.releases.filter((r) => r.estado === 'planificado')}
                onError={onError}
                onHecho={onHecho}
              />
            )}
          </div>
        ))}
      </Card>

      {dv.releases.map((r) => (
        <TarjetaRelease
          key={r.id}
          workspaceId={workspaceId}
          dv={dv}
          release={r}
          puedePlanificar={puedePlanificar}
          puedeCompletar={puedeCompletar}
          onError={onError}
          onHecho={onHecho}
        />
      ))}
    </div>
  );
}

function AsignarAExistente({
  workspaceId,
  elementoId,
  releases,
  verbo = 'Asignar',
  onError,
  onHecho,
}: {
  workspaceId: string;
  elementoId: string;
  releases: ReleaseDeDesignVersion[];
  /** «Asignar» cuando el elemento está pendiente; «Mover» cuando ya tiene release. Es la
   *  misma operación —el servicio la resuelve como un movimiento atómico— y decirlo así
   *  evita que el lead crea que tiene que quitarlo primero. */
  verbo?: 'Asignar' | 'Mover';
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [releaseId, setReleaseId] = useState('');
  const [razon, setRazon] = useState('');
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <Select value={releaseId} onChange={(e) => setReleaseId(e.target.value)} style={{ width: 160 }}>
        <option value="">{verbo} a…</option>
        {releases.map((r) => (
          <option key={r.id} value={r.id}>
            {r.codigo}
          </option>
        ))}
      </Select>
      <Input
        placeholder="Razón de que caiga ahí"
        value={razon}
        onChange={(e) => setRazon(e.target.value)}
        style={{ width: 220 }}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={releaseId === ''}
        onClick={async () => {
          onError(null);
          const r = await (verbo === 'Mover' ? moverElementoDeRelease : asignarElementoARelease)({
            data: { workspaceId, releaseId, elementoId, razon },
          });
          if (r.ok) await onHecho();
          else onError(r.error);
        }}
      >
        {verbo}
      </Button>
    </div>
  );
}

function TarjetaRelease({
  workspaceId,
  dv,
  release,
  puedePlanificar,
  puedeCompletar,
  onError,
  onHecho,
}: {
  workspaceId: string;
  dv: DesignVersionCompleta;
  release: ReleaseDeDesignVersion;
  puedePlanificar: boolean;
  puedeCompletar: boolean;
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [fecha, setFecha] = useState(HOY());
  const [constatando, setConstatando] = useState(false);
  const titulos = new Map(dv.elementos.map((e) => [e.id, e.titulo]));

  return (
    <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag>{release.codigo}</Tag>
        <span style={{ font: '600 13.5px var(--font-sans)', color: 'var(--ink)' }}>
          {release.titulo}
        </span>
        <Tag mono={false}>{release.estado}</Tag>
      </div>
      <span style={apunte}>
        Dueño: {release.responsable} · objetivo {release.fechaObjetivo}
        {release.desplegadoEn ? ` · desplegado el ${release.desplegadoEn}` : ''}
      </span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={micro}>Incluye ({release.elementos.length})</span>
        {release.elementos.map((e) => (
          <div key={e.elementoId} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={cuerpo}>{titulos.get(e.elementoId) ?? e.elementoId}</span>
            {e.razon !== '' && <span style={apunte}>— {e.razon}</span>}
            {puedeCompletar && release.estado === 'planificado' && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    onError(null);
                    const r = await quitarElementoDeRelease({
                      data: { workspaceId, elementoId: e.elementoId },
                    });
                    if (r.ok) await onHecho();
                    else onError(r.error);
                  }}
                >
                  Quitar
                </Button>
                {/* Mover, y no «quitar y volver a asignar»: con G6 aprobado, dejar el
                    elemento sin release aunque sea un instante es lo que el constraint de
                    cobertura rechaza —y como la aprobación de un gate no se deshace, no
                    habría vuelta atrás—. El servicio lo resuelve en una transacción.

                    Va con `puedePlanificar` y no con `puedeCompletar`, aunque esté al lado
                    de «Quitar»: mover REINSERTA el elemento, y `release_elemento_insert`
                    solo admite versiones que sigan a cargo de su proyecto. Sobre una que el
                    propio proyecto reemplazó, todo movimiento revierte — y el cartel de
                    arriba ya dice que ahí no entra trabajo nuevo. Quitar sí es cerrar, y se
                    queda donde estaba. */}
                {puedePlanificar &&
                  dv.releases.filter((o) => o.estado === 'planificado' && o.id !== release.id)
                    .length > 0 && (
                  <AsignarAExistente
                    workspaceId={workspaceId}
                    elementoId={e.elementoId}
                    releases={dv.releases.filter(
                      (o) => o.estado === 'planificado' && o.id !== release.id,
                    )}
                    verbo="Mover"
                    onError={onError}
                    onHecho={onHecho}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {release.effectiveState && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={micro}>
            {release.effectiveState.codigo} · constatado el {release.effectiveState.constatadoEn}
          </span>
          {release.effectiveState.resumen !== '' && (
            <span style={cuerpo}>{release.effectiveState.resumen}</span>
          )}
          {release.effectiveState.constataciones.map((c) => (
            <div key={c.elementoId} style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={cuerpo}>
                {titulos.get(c.elementoId) ?? c.elementoId} — {ETIQUETA_RESULTADO[c.resultado]}
              </span>
              {c.resultado !== 'como-aprobado' && (
                <span style={apunte}>
                  {c.queQuedoDistinto} · razón: {c.razon}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {puedeCompletar && release.estado === 'planificado' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            style={{ width: 170 }}
          />
          <Button
            size="sm"
            // La fecha también: `DesplegarReleaseSchema` la exige con formato, así que un
            // envío con el campo vacío lo rechaza el ESQUEMA antes del handler y este
            // callback sin captura acaba en fallo genérico. El espejo de una pantalla no es
            // solo el de los guards: la superficie del esquema es una puerta más, y esta se
            // ofrecía abierta.
            disabled={release.elementos.length === 0 || fecha === ''}
            onClick={async () => {
              onError(null);
              const r = await registrarDespliegue({
                data: { workspaceId, releaseId: release.id, desplegadoEn: fecha },
              });
              if (r.ok) await onHecho();
              else onError(r.error);
            }}
          >
            Registrar despliegue
          </Button>
          {release.elementos.length === 0 && (
            <span style={apunte}>Un release sin elementos declarados no sale (SYS-06).</span>
          )}
          {fecha === '' && release.elementos.length > 0 && (
            <span style={apunte}>
              Falta la fecha REAL del despliegue: es la que registra cuándo cambió el
              servicio (RF-06.5), y no se corrige después.
            </span>
          )}
        </div>
      )}

      {/* La `key` incluye el ALCANCE, no solo el id: la cadena expandida vive en estado
          local y sobrevive a la recarga del loader porque el release sigue siendo el mismo,
          así que tras asignar, mover o quitar un elemento seguía enseñando los pasos y las
          citas de antes — una vista de auditoría diciendo algo que ya no es cierto, y sin
          control para recargarla. Es la misma clase que el remonte al cambiar de workspace
          (#18): la pregunta no es «¿cambió el id?» sino «¿sigue siendo verdad lo que este
          estado afirma?». Cuando el alcance cambia, el componente se remonta y la cadena
          vuelve a pedirse cuando el lead la abra. */}
      <CadenaDelRelease
        key={`${release.id}:${release.elementos.map((e) => e.elementoId).join(',')}`}
        workspaceId={workspaceId}
        releaseId={release.id}
        codigo={release.codigo}
      />

      {puedeCompletar && release.estado === 'desplegado' && !constatando && (
        <div>
          <Button size="sm" onClick={() => setConstatando(true)}>
            Constatar effective state
          </Button>
        </div>
      )}
      {puedeCompletar && release.estado === 'desplegado' && constatando && (
        <FormularioConstatacion
          workspaceId={workspaceId}
          release={release}
          titulos={titulos}
          onCerrar={() => setConstatando(false)}
          onError={onError}
          onHecho={async () => {
            setConstatando(false);
            await onHecho();
          }}
        />
      )}
    </Card>
  );
}

/**
 * RF-06.9 / criterio de aceptación 5: «qué pasos del journey afectó RL-1» y, del otro
 * lado, hasta qué citas llega la cadena hacia atrás. Se pide bajo demanda: es la
 * pregunta que se hace al auditar, no en cada render de la pantalla.
 */
function CadenaDelRelease({
  workspaceId,
  releaseId,
  codigo,
}: {
  workspaceId: string;
  releaseId: string;
  codigo: string;
}) {
  const [cadena, setCadena] = useState<Awaited<ReturnType<typeof cadenaDelRelease>> | null>(null);
  const [ocupado, setOcupado] = useState(false);

  if (!cadena) {
    return (
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={ocupado}
          onClick={async () => {
            setOcupado(true);
            try {
              setCadena(await cadenaDelRelease({ data: { workspaceId, releaseId } }));
            } finally {
              setOcupado(false);
            }
          }}
        >
          Ver la cadena de {codigo}
        </Button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={micro}>Qué pasos del journey afectó {codigo}</span>
      {cadena.pasos.length === 0 && (
        <span style={apunte}>Ningún elemento de este release enlaza un nodo del grafo.</span>
      )}
      {cadena.pasos.map((p) => (
        <span key={`${p.nodoId}-${p.elementoTitulo}`} style={cuerpo}>
          {p.tipo} · {p.etiqueta} <span style={apunte}>— por «{p.elementoTitulo}»</span>
        </span>
      ))}
      <span style={{ ...micro, paddingTop: 6 }}>Hacia atrás, hasta las citas</span>
      {cadena.citas.length === 0 && (
        <span style={apunte}>
          Sus elementos no citan insights ni decisiones: la cadena se corta antes de la evidencia.
        </span>
      )}
      {cadena.citas.map((c) => (
        <span key={`${c.evidenciaId}-${c.localizacion}-${c.fragmento}`} style={apunte}>
          {c.insightTitulo} → {c.evidenciaTitulo} ({c.localizacion}): «{c.fragmento}»
        </span>
      ))}
    </div>
  );
}

function FormularioRelease({
  workspaceId,
  dv,
  pendientes,
  onCerrar,
  onError,
  onHecho,
}: {
  workspaceId: string;
  dv: DesignVersionCompleta;
  pendientes: DesignVersionCompleta['elementos'];
  onCerrar: () => void;
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [titulo, setTitulo] = useState('');
  const [responsable, setResponsable] = useState('');
  const [fechaObjetivo, setFechaObjetivo] = useState(HOY());
  const [seleccion, setSeleccion] = useState<Record<string, string | undefined>>({});
  const [ocupado, setOcupado] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true);
    onError(null);
    try {
      const r = await planificarReleaseDeDesignVersion({
        data: {
          workspaceId,
          designVersionId: dv.id,
          titulo,
          responsable,
          fechaObjetivo,
          elementos: Object.entries(seleccion)
            .filter(([, razon]) => razon !== undefined)
            .map(([elementoId, razon]) => ({ elementoId, razon: razon ?? '' })),
        },
      });
      if (r.ok) await onHecho();
      else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 18 }}>
      <form onSubmit={(e) => void enviar(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={micro}>Nuevo release</span>
        <Input
          placeholder="Título del release"
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          required
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Input
            placeholder="Dueño del release"
            value={responsable}
            onChange={(e) => setResponsable(e.target.value)}
            required
            style={{ flex: '1 1 220px' }}
          />
          <Input
            type="date"
            value={fechaObjetivo}
            onChange={(e) => setFechaObjetivo(e.target.value)}
            required
            style={{ width: 170 }}
          />
        </div>
        <span style={micro}>Qué incluye (parcialidad explícita)</span>
        {pendientes.length === 0 && (
          <span style={apunte}>No queda ningún elemento sin release.</span>
        )}
        {pendientes.map((el) => {
          const marcado = seleccion[el.id] !== undefined;
          return (
            <div key={el.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', ...cuerpo }}>
                <input
                  type="checkbox"
                  checked={marcado}
                  onChange={(e) =>
                    setSeleccion((s) => ({ ...s, [el.id]: e.target.checked ? '' : undefined }))
                  }
                />
                {el.titulo}
              </label>
              {marcado && (
                <Input
                  placeholder="Razón de que caiga en este release"
                  value={seleccion[el.id] ?? ''}
                  onChange={(e) => setSeleccion((s) => ({ ...s, [el.id]: e.target.value }))}
                  style={{ flex: '1 1 240px' }}
                />
              )}
            </div>
          );
        })}
        <span style={apunte}>
          Lo que no marques sigue visible como pendiente: la parcialidad se declara, no se
          esconde (SYS-06).
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            size="sm"
            type="submit"
            disabled={ocupado || titulo.trim() === '' || responsable.trim() === ''}
          >
            Planificar
          </Button>
          <Button size="sm" variant="ghost" type="button" disabled={ocupado} onClick={onCerrar}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}

function FormularioConstatacion({
  workspaceId,
  release,
  titulos,
  onCerrar,
  onError,
  onHecho,
}: {
  workspaceId: string;
  release: ReleaseDeDesignVersion;
  titulos: Map<string, string>;
  onCerrar: () => void;
  onError: (e: string | null) => void;
  onHecho: () => Promise<void>;
}) {
  const [constatadoEn, setConstatadoEn] = useState(HOY());
  const [resumen, setResumen] = useState('');
  const [filas, setFilas] = useState<
    Record<string, { resultado: ResultadoConstatacion; queQuedoDistinto: string; razon: string }>
  >(() =>
    Object.fromEntries(
      release.elementos.map((e) => [
        e.elementoId,
        { resultado: 'como-aprobado' as ResultadoConstatacion, queQuedoDistinto: '', razon: '' },
      ]),
    ),
  );
  const [ocupado, setOcupado] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true);
    onError(null);
    try {
      const r = await constatarReleaseDesplegado({
        data: {
          workspaceId,
          releaseId: release.id,
          constatadoEn,
          resumen,
          constataciones: release.elementos.map((el) => ({
            elementoId: el.elementoId,
            ...filas[el.elementoId]!,
          })),
        },
      });
      if (r.ok) await onHecho();
      else onError(r.error);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 18 }}>
      <form onSubmit={(e) => void enviar(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={micro}>Constatar cómo quedó</span>
        <span style={apunte}>
          Toda diferencia respecto de lo aprobado se registra como desviación con razón
          obligatoria (SYS-07): sin razón, la base rechaza el registro.
        </span>
        {/* `required` como los demás campos del formulario: `ConstatarSchema` exige la fecha
            con formato, así que vaciarla y enviar acaba en un rechazo del esquema y un
            fallo genérico. Aquí basta el atributo —el envío es un `submit`, no un onClick—,
            que es lo que ya hacen el título del release y los textos de la desviación. */}
        <Input
          type="date"
          value={constatadoEn}
          onChange={(e) => setConstatadoEn(e.target.value)}
          required
        />
        <Textarea
          placeholder="Resumen de la constatación (opcional)"
          value={resumen}
          onChange={(e) => setResumen(e.target.value)}
          rows={2}
        />
        {release.elementos.map((el) => {
          const fila = filas[el.elementoId]!;
          return (
            <div
              key={el.elementoId}
              style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6 }}
            >
              <span style={cuerpo}>{titulos.get(el.elementoId) ?? el.elementoId}</span>
              <Select
                value={fila.resultado}
                onChange={(e) => {
                  // Volver a «como aprobado» LIMPIA los dos textos. Ocultarlos no basta: el
                  // estado sobrevivía, se enviaba igual, y el CHECK lo rechaza —«como
                  // aprobado» con texto de desviación sería una desviación escondida—
                  // mientras el usuario no tiene ningún campo visible que borrar. Trampa sin
                  // salida desde la pantalla. La regla, en general: si esto se oculta, deja
                  // de mandarse.
                  const resultado = e.target.value as ResultadoConstatacion;
                  const limpio =
                    resultado === 'como-aprobado' ? { queQuedoDistinto: '', razon: '' } : {};
                  setFilas((f) => ({
                    ...f,
                    [el.elementoId]: { ...fila, ...limpio, resultado },
                  }));
                }}
              >
                {RESULTADOS_CONSTATACION.map((r) => (
                  <option key={r} value={r}>
                    {ETIQUETA_RESULTADO[r]}
                  </option>
                ))}
              </Select>
              {fila.resultado !== 'como-aprobado' && (
                <>
                  <Input
                    placeholder="Qué quedó distinto"
                    value={fila.queQuedoDistinto}
                    onChange={(e) =>
                      setFilas((f) => ({
                        ...f,
                        [el.elementoId]: { ...fila, queQuedoDistinto: e.target.value },
                      }))
                    }
                    required
                  />
                  <Input
                    placeholder="Razón (obligatoria)"
                    value={fila.razon}
                    onChange={(e) =>
                      setFilas((f) => ({ ...f, [el.elementoId]: { ...fila, razon: e.target.value } }))
                    }
                    required
                  />
                </>
              )}
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" type="submit" disabled={ocupado}>
            Constatar y verificar
          </Button>
          <Button size="sm" variant="ghost" type="button" disabled={ocupado} onClick={onCerrar}>
            Cancelar
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── Tablero de conciliación (RF-06.7) ──

function VistaConciliacion({
  tablero,
  desconocidos,
  proyectoId,
  aCargo,
  bloqueo,
}: {
  tablero: Awaited<ReturnType<typeof conciliacionDeDesignVersion>>;
  desconocidos: { elementoId: string; elementoTitulo: string }[];
  proyectoId: string;
  /** Si el proyecto sigue respondiendo por esta versión ante sus gates. Sustituye a
   * «está aprobada»: los huecos de una versión que superó otro proyecto también cuentan
   * para G7, y los de la que el propio proyecto reemplazó ya no. */
  aCargo: boolean;
  /** Por qué está bloqueado el G7 del proyecto, dicho por la misma función que lo rechaza.
   * No se recalcula aquí: el predicado tiene cuatro ramas y el tablero solo veía la de
   * esta design version, así que lo que arrastraba la cadena del servicio salía como que
   * no bloqueaba. */
  bloqueo: string | null;
}) {
  if (!tablero || tablero.filas.length === 0) {
    return (
      <Card style={{ padding: 20 }}>
        <span style={apunte}>
          Sin elementos de cambio no hay nada que conciliar. G7 exige que esta design
          version aprobada tenga su tablero completo.
        </span>
      </Card>
    );
  }

  // Lo que decide es lo que dice la base. Los huecos de ESTA versión solo se destacan
  // cuando el proyecto responde por ella; el aviso, en cambio, es el del gate entero,
  // porque lo que atranca G7 puede estar en otra versión del servicio.
  const huecosPropios = aCargo && desconocidos.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card
        style={{
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderColor: bloqueo !== null ? 'var(--warn)' : undefined,
        }}
      >
        <span style={micro}>Conciliación de la etapa 7</span>
        {bloqueo !== null ? (
          <span style={{ font: '600 13px/1.6 var(--font-sans)', color: 'var(--warn)' }}>
            G7 está bloqueado: {bloqueo}
            {huecosPropios
              ? ` En esta design version hay ${desconocidos.length} ${
                  desconocidos.length === 1 ? 'elemento' : 'elementos'
                } sin constatar; abajo, cuáles.`
              : ' El hueco no está en esta design version: mira las demás del servicio desde los gates del proyecto.'}
          </span>
        ) : (
          <span style={cuerpo}>
            {aCargo
              ? 'Todos los elementos tienen estado conocido y el gate no encuentra huecos: G7 puede aprobarse.'
              : 'Este proyecto ya reemplazó esta versión: su conciliación la cierra la que la sucede.'}
          </span>
        )}
        <Link
          to="/proyecto/$proyectoId"
          params={{ proyectoId }}
          style={{ ...apunte, color: 'var(--accent)' }}
        >
          Ir a los gates del proyecto →
        </Link>
      </Card>

      <Card style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              {['Elemento', 'Estado', 'Release', 'Razón / desviación'].map((h) => (
                <th
                  key={h}
                  style={{
                    ...micro,
                    textAlign: 'left',
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tablero.filas.map((f) => {
              const desconocido = desconocidos.some((d) => d.elementoId === f.elementoId);
              return (
                <tr key={f.elementoId}>
                  <td style={{ ...cuerpo, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                    {f.elementoTitulo}
                    <div style={apunte}>
                      {ETIQUETA_TIPO_ELEMENTO[f.tipo]} · {f.operacion}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      borderBottom: '1px solid var(--border)',
                      font: '600 12.5px var(--font-sans)',
                      color: desconocido ? 'var(--warn)' : 'var(--ok)',
                    }}
                  >
                    {ETIQUETA_CONCILIACION[f.estado]}
                  </td>
                  <td style={{ ...apunte, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                    {f.releaseCodigo
                      ? `${f.releaseCodigo} · ${f.releaseResponsable} · ${f.releaseFecha}`
                      : '—'}
                  </td>
                  <td style={{ ...apunte, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                    {f.razonDesviacion !== ''
                      ? `${f.queQuedoDistinto} · ${f.razonDesviacion}`
                      : f.razonAsignacion !== ''
                        ? f.razonAsignacion
                        : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
