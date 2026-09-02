import { useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import { Wordmark } from '@/components/ui/Wordmark';
import {
  aceptarPropuestaAI,
  generarPropuestasAI,
  propuestasDelWorkspace,
  rechazarPropuestaAI,
  registrarConsentimientoAI,
} from '@/lib/ai/ai.functions';
import {
  CAPACIDADES_ACTIVAS,
  ETIQUETA_CAPACIDAD,
  type CandidatoAncla,
  type CapacidadActiva,
  type ConsentimientoDeItem,
  type EstadoAncla,
  type ContenidoCriterio,
  type ContenidoExtraccion,
  type ContenidoPropuesta,
  type PropuestaEnPanel,
} from '@/lib/ai/ai.schemas';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';

/**
 * Panel de propuestas AI (SPEC-08): lo que la AI propuso, con qué citas y con qué
 * lineage, esperando que una persona acepte, corrija o rechace. Ningún objeto del dominio
 * existe hasta esa decisión (I4/SYS-19).
 *
 * La pantalla se pinta IGUAL con la AI apagada (SYS-21): la bandera dice por qué, los
 * botones de generar se desactivan y todo lo demás —revisar lo ya propuesto, y los
 * caminos manuales de la bandeja y del método— sigue disponible.
 */
export const Route = createFileRoute('/_autenticada/propuestas')({
  // `q` filtra las anclas que el formulario de generación puede ofrecer. Vive en la URL y
  // no en un estado local porque es lo que decide QUÉ pide el loader: sin viajar al
  // servidor, buscar solo filtraría las 50 que ya bajaron, que es justo lo que no sirve
  // cuando el problema es que hay más anclas elegibles que sitio en la lista.
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = typeof search.q === 'string' ? search.q.trim().slice(0, 100) : '';
    return q ? { q } : {};
  },
  loaderDeps: ({ search }) => ({ ws: search.ws, q: search.q ?? '' }),
  loader: ({ context, deps }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    return workspaceId
      ? propuestasDelWorkspace({ data: { workspaceId, busqueda: deps.q } })
      : null;
  },
  component: PantallaPropuestas,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const campo: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };

const COLOR_ESTADO: Record<PropuestaEnPanel['estado'], string> = {
  propuesta: 'var(--warn)',
  aceptada: 'var(--accent)',
  corregida: 'var(--accent)',
  rechazada: 'var(--text-faint)',
};

/** Por qué una propuesta pendiente dejó de poder aceptarse. Cada motivo dice además cuál
 * es la salida, que no es la misma: un item curado a mano ya tiene su evidencia, un
 * consentimiento retirado deja el material fuera de la AI (pero la bandeja sigue abierta) y
 * unos criterios congelados esperan a la reapertura de su etapa. */
const MOTIVO_ANCLA: Record<EstadoAncla, string> = {
  disponible: '',
  'item-curado': 'El item ya se curó a mano: esta propuesta quedó obsoleta y solo puede rechazarse.',
  'consentimiento-revocado':
    'El consentimiento de ese material ya no autoriza el procesamiento externo: esta propuesta quedó obsoleta y solo puede rechazarse. El item sigue pudiendo curarse a mano en la bandeja.',
  'criterios-congelados':
    'El G0 del reto se aprobó y sus criterios quedaron congelados: esta propuesta quedó obsoleta y solo puede rechazarse.',
  'reto-no-admite':
    'Ese reto ya no admite criterios nuevos: solo los admite mientras es candidato o está activo, y este ya avanzó a medición, cierre o archivo. La propuesta quedó obsoleta y solo puede rechazarse.',
  'ancla-ausente': 'No se pudo comprobar el estado del objeto de origen: refresca la pantalla antes de decidir.',
};

const TEXTO_ESTADO: Record<PropuestaEnPanel['estado'], string> = {
  propuesta: 'pendiente de revisión humana',
  aceptada: 'aceptada tal cual',
  corregida: 'corregida y aceptada',
  rechazada: 'rechazada',
};

function PantallaPropuestas() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const rol = membresiaActiva?.rol ?? '';
  const puedeRevisar = (ROLES_CURADORES as readonly string[]).includes(rol);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function refrescar() {
    setError(null);
    await router.invalidate();
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
            Propuestas AI
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
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}
        {datos && (
          <>
            <BanderaAI ai={datos.ai} />
            {puedeRevisar ? (
              <FormularioGeneracion
                workspaceId={datos.workspaceId}
                habilitada={datos.ai.disponible}
                items={datos.itemsPendientes}
                retos={datos.retosAbiertos}
                hayMasItems={datos.hayMasItems}
                hayMasRetos={datos.hayMasRetos}
                busqueda={datos.busqueda}
                onBuscar={(texto) =>
                  navigate({
                    to: '/propuestas',
                    search: (prev) => ({ ...prev, q: texto || undefined }),
                  })
                }
                onGenerado={async (n) => {
                  setAviso(`${n} propuesta${n === 1 ? '' : 's'} en espera de revisión humana`);
                  await refrescar();
                }}
                onConsentimiento={async (r) => {
                  setAviso(
                    r.autorizaExterno
                      ? `Consentimiento registrado (nº ${r.version}): ya puedes pedir la propuesta`
                      : `Consentimiento registrado (nº ${r.version}). No cubre el procesamiento externo, así que la generación sigue bloqueada; si la persona lo autoriza después, registra un consentimiento nuevo y ese pasará a ser el vigente.`,
                  );
                  await refrescar();
                }}
                onError={(e) => {
                  setAviso(null);
                  setError(e);
                }}
              />
            ) : null}
            {puedeRevisar && datos.materialDePersonas.length > 0 && (
              <BitacoraConsentimientos
                workspaceId={datos.workspaceId}
                items={datos.materialDePersonas}
                hayMas={datos.hayMasMaterial}
                onRegistrado={async (r) => {
                  setError(null);
                  setAviso(
                    r.autorizaExterno
                      ? `Consentimiento registrado (nº ${r.version}): ese material ya puede procesarse con el proveedor AI`
                      : `Consentimiento registrado (nº ${r.version}): ese material deja de poder procesarse con el proveedor AI. Las propuestas pendientes sobre él solo pueden rechazarse.`,
                  );
                  await refrescar();
                }}
                onError={(e) => {
                  setAviso(null);
                  setError(e);
                }}
              />
            )}
            {!puedeRevisar && (
              <Card style={{ padding: 20 }}>
                <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
                  Las propuestas AI las piden y deciden lead-boutique o diseñador. Aquí puedes
                  ver qué se propuso, con qué citas y quién lo decidió.
                </span>
              </Card>
            )}
            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}
            {aviso && !error && (
              <span style={{ font: '500 13px var(--font-sans)', color: 'var(--accent)' }}>{aviso}</span>
            )}

            <div style={{ ...etiqueta, paddingTop: 6 }}>
              {datos.pendientes.length === 0
                ? 'Sin propuestas pendientes de revisión'
                : `${datos.pendientes.length} pendientes de revisión humana, de la más antigua a la más reciente`}
            </div>
            {datos.hayMasPendientes && (
              <Aviso>
                Hay más pendientes de las que caben aquí: se muestran las {datos.pendientes.length}{' '}
                más antiguas. Decide estas y las siguientes aparecerán.
              </Aviso>
            )}
            {datos.pendientes.map((p) => (
              <TarjetaPropuesta
                key={p.id}
                propuesta={p}
                workspaceId={datos.workspaceId}
                puedeRevisar={puedeRevisar}
                onCambio={refrescar}
                onError={setError}
              />
            ))}

            {datos.decididas.length > 0 && (
              <>
                <div style={{ ...etiqueta, paddingTop: 14 }}>Decididas recientes</div>
                {datos.hayMasDecididas && (
                  <Aviso>
                    Solo las {datos.decididas.length} decisiones más recientes; el historial
                    completo vive en la auditoría del workspace.
                  </Aviso>
                )}
                {datos.decididas.map((p) => (
                  <TarjetaPropuesta
                    key={p.id}
                    propuesta={p}
                    workspaceId={datos.workspaceId}
                    puedeRevisar={false}
                    onCambio={refrescar}
                    onError={setError}
                  />
                ))}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** Un recorte de lista se DICE. Callarlo es lo que dejaba creer que no quedaba trabajo
 * pendiente cuando sí quedaba. */
function Aviso({ children }: { children: ReactNode }) {
  return (
    <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
      {children}
    </span>
  );
}

/** SYS-21 en una línea: el estado de la capacidad AI es visible SIEMPRE, encendida o no,
 * y cuando está apagada dice por dónde sigue el trabajo a mano. */
function BanderaAI({
  ai,
}: {
  ai: { disponible: boolean; motivo: string; modelo: string; llamadasHoy: number; limiteDiario: number };
}) {
  return (
    <Card
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        borderLeft: `3px solid ${ai.disponible ? 'var(--accent)' : 'var(--warn)'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
          {ai.disponible ? 'Capacidad AI disponible' : 'Capacidad AI apagada'}
        </span>
        <Tag>{ai.modelo}</Tag>
        <span style={{ font: '500 11.5px var(--font-mono)', color: 'var(--text-muted)' }}>
          {ai.llamadasHoy}/{ai.limiteDiario} llamadas al proveedor hoy
        </span>
      </div>
      <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
        {ai.disponible
          ? 'La AI propone y cita; el objeto real del dominio solo nace cuando una persona acepta.'
          : ai.motivo}
      </span>
      {!ai.disponible && (
        <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
          Caminos manuales equivalentes: curar la bandeja de importación a mano y definir los
          criterios del reto en la pantalla del proyecto. Ningún gate depende de la AI.
        </span>
      )}
    </Card>
  );
}

function FormularioGeneracion({
  workspaceId,
  habilitada,
  items,
  retos,
  hayMasItems,
  hayMasRetos,
  busqueda,
  onBuscar,
  onGenerado,
  onConsentimiento,
  onError,
}: {
  workspaceId: string;
  habilitada: boolean;
  items: CandidatoAncla[];
  retos: CandidatoAncla[];
  hayMasItems: boolean;
  hayMasRetos: boolean;
  busqueda: string;
  onBuscar: (texto: string) => void;
  onGenerado: (generadas: number) => Promise<void>;
  onConsentimiento: (r: { version: number; autorizaExterno: boolean }) => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [capacidad, setCapacidad] = useState<CapacidadActiva>('CI');
  const [anclaId, setAnclaId] = useState('');
  const [texto, setTexto] = useState(busqueda);
  const [enviando, setEnviando] = useState(false);
  const anclas = capacidad === 'CI' ? items : retos;
  const hayMas = capacidad === 'CI' ? hayMasItems : hayMasRetos;
  const elegida = anclas.find((a) => a.id === anclaId);
  // RF-09.5: si el material es de personas y el consentimiento vigente no cubre el
  // procesamiento externo, el paso que toca no es generar — es registrarlo. La pantalla lo
  // dice y lo ofrece aquí mismo en vez de dejar que el intento falle contra el servidor.
  const faltaConsentimiento = Boolean(elegida?.consentimientoPendiente);
  // Y un item importado solo con la referencia no tiene material que citar: la extracción
  // se apaga con su explicación, porque aquí no hay nada que arreglar (el contenido de un
  // item importado es inmutable) — el camino es la bandeja.
  const sinMaterial = Boolean(elegida?.sinMaterial);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!anclaId) {
      onError('Elige el objeto del que quieres una propuesta');
      return;
    }
    setEnviando(true);
    onError(null);
    try {
      const r = await generarPropuestasAI({ data: { workspaceId, capacidad, anclaId } });
      if (r.ok) {
        setAnclaId('');
        await onGenerado(r.generadas);
      } else {
        onError(r.error);
      }
    } catch {
      onError('No se pudo pedir la propuesta; intenta de nuevo');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card style={{ padding: 24 }}>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
          Pedir una propuesta
        </span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={campo}>
            <span style={etiqueta}>Capacidad</span>
            <Select
              value={capacidad}
              onChange={(e) => {
                setCapacidad(e.target.value as CapacidadActiva);
                setAnclaId('');
              }}
            >
              {CAPACIDADES_ACTIVAS.map((c) => (
                <option key={c} value={c}>
                  {c} · {ETIQUETA_CAPACIDAD[c]}
                </option>
              ))}
            </Select>
          </label>
          <label style={campo}>
            <span style={etiqueta}>
              {capacidad === 'CI' ? 'Item de la bandeja' : 'Reto con criterios abiertos'}
            </span>
            {/* Buscar VIAJA al servidor (la búsqueda vive en la URL): filtrar en el cliente
                solo tocaría las anclas que ya bajaron, que es exactamente el conjunto del
                que un ancla puede haberse caído. */}
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                value={texto}
                maxLength={100}
                placeholder={capacidad === 'CI' ? 'Buscar por título…' : 'Buscar por código o título…'}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onBuscar(texto.trim());
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onBuscar(texto.trim())}
              >
                Buscar
              </Button>
              {busqueda && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTexto('');
                    onBuscar('');
                  }}
                >
                  Limpiar
                </Button>
              )}
            </div>
            <Select value={anclaId} onChange={(e) => setAnclaId(e.target.value)}>
              <option value="">Elige el alcance…</option>
              {anclas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.titulo}
                  {a.consentimientoPendiente ? ' · falta consentimiento' : ''}
                  {a.sinMaterial ? ' · sin material que citar' : ''}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {anclas.length === 0 && (
          <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
            {capacidad === 'CI'
              ? 'No hay items pendientes sin propuesta en la bandeja.'
              : 'No hay retos con criterios abiertos (un G0 aprobado los congela).'}
          </span>
        )}
        {/* El recorte de la lista se dice: es la ÚNICA puerta a la generación, así que
            callarlo hacía creer que no había más anclas que ofrecer. Y se dice CON la
            salida: buscar por nombre alcanza cualquier ancla, caiga donde caiga el corte. */}
        {hayMas && (
          <Aviso>
            {capacidad === 'CI'
              ? `Hay más items pendientes de los que caben aquí: se listan los ${anclas.length} más antiguos. Decide o cura estos y los siguientes aparecerán; para uno concreto, búscalo por su título.`
              : `Hay más retos con criterios abiertos de los que caben aquí: se listan los ${anclas.length} primeros por código. Un reto sale de la lista mientras sus criterios propuestos esperan revisión; para uno concreto, búscalo por su código o su título.`}
          </Aviso>
        )}
        {busqueda && anclas.length === 0 && (
          <Aviso>
            Ningún {capacidad === 'CI' ? 'item pendiente' : 'reto con criterios abiertos'} coincide
            con «{busqueda}». Vacía la búsqueda para volver a la cola completa.
          </Aviso>
        )}
        {sinMaterial && (
          <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
            «{elegida!.titulo}» se importó solo con la referencia al original: no hay texto que
            citar, y una extracción sobre pura ficha sería inventada. Cúralo a mano en la bandeja
            de importación, o vuelve a importarlo con el contenido pegado.
          </span>
        )}
        {!faltaConsentimiento && (
          <div>
            <Button
              type="submit"
              disabled={enviando || !habilitada || anclas.length === 0 || sinMaterial}
            >
              {enviando ? 'Proponiendo…' : 'Proponer con AI'}
            </Button>
          </div>
        )}
        {!habilitada && (
          <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
            Generar está desactivado mientras la capacidad AI esté apagada; revisar y aceptar lo
            ya propuesto sigue funcionando.
          </span>
        )}
      </form>
      {faltaConsentimiento && (
        <FormularioConsentimiento
          workspaceId={workspaceId}
          itemId={anclaId}
          titulo={elegida!.titulo}
          onRegistrado={onConsentimiento}
          onError={onError}
        />
      )}
    </Card>
  );
}

/**
 * Bitácora de consentimientos del material de personas: qué autoriza HOY cada item y la
 * puerta para registrar un hecho nuevo — incluida la revocación.
 *
 * Existe porque colgar el formulario del selector de generación lo hacía inalcanzable justo
 * cuando hace falta: un item con permiso vigente no «necesita» nada, así que el formulario
 * no aparecía, y uno con propuesta pendiente ni siquiera se lista como ancla. El servicio y
 * la bitácora admiten registros posteriores desde el primer día; sin esta lista, RF-09.4 no
 * tenía por dónde entrar en el producto.
 */
function BitacoraConsentimientos({
  workspaceId,
  items,
  hayMas,
  onRegistrado,
  onError,
}: {
  workspaceId: string;
  items: ConsentimientoDeItem[];
  hayMas: boolean;
  onRegistrado: (r: { version: number; autorizaExterno: boolean }) => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const elegido = items.find((i) => i.id === abierto);

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
        Consentimiento del material de personas
      </span>
      <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
        Entrevistas y observaciones de la bandeja, con lo que autoriza su registro VIGENTE. Cada
        registro nuevo manda sobre los anteriores y ninguno se edita ni se borra (RF-09.4/09.5):
        así se recoge una autorización posterior y así se recoge una revocación. Los items ya
        curados se listan igual — cuando la evidencia existe, una revocación tiene más
        consecuencias, no menos.
      </span>
      {hayMas && (
        <Aviso>
          Hay más material de personas del que cabe aquí: se listan los {items.length} más
          antiguos. Busca por título para llegar a uno concreto.
        </Aviso>
      )}
      {items.map((i) => (
        <div
          key={i.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '8px 0',
            borderTop: '1px solid var(--border)',
          }}
        >
          <span style={{ font: '500 13px var(--font-sans)', color: 'var(--text-body)', flex: 1, minWidth: 200 }}>
            {i.titulo}
            {i.curado && (
              <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--text-faint)' }}>
                {' '}· ya curado
              </span>
            )}
          </span>
          <span
            style={{
              font: '600 11.5px var(--font-sans)',
              color: i.autorizaExterno ? 'var(--accent)' : 'var(--warn)',
            }}
          >
            {i.version === null
              ? 'sin consentimiento registrado'
              : i.autorizaExterno
                ? `autoriza el procesamiento externo · registro nº ${i.version}`
                : `NO autoriza el procesamiento externo · registro nº ${i.version}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAbierto(abierto === i.id ? null : i.id)}
          >
            {abierto === i.id ? 'Cancelar' : 'Registrar consentimiento'}
          </Button>
        </div>
      ))}
      {elegido && (
        <FormularioConsentimiento
          workspaceId={workspaceId}
          itemId={elegido.id}
          titulo={elegido.titulo}
          onRegistrado={async (r) => {
            setAbierto(null);
            await onRegistrado(r);
          }}
          onError={onError}
        />
      )}
    </Card>
  );
}

/**
 * Captura del consentimiento ANTES de procesar (RF-09.5). Aparece delante del botón de
 * generar —ese es el momento en que importa: hasta que no consta qué autorizó la persona, el
 * material no sale hacia ningún proveedor— y también en la bitácora de arriba, que es lo que
 * permite registrar un hecho posterior sobre un item que ya tiene permiso. Ningún registro se
 * edita ni se borra: lo que cambia el permiso es un registro NUEVO, y el vigente es el que
 * manda.
 *
 * Por eso el botón ya no exige marcar la casilla. Anotar «autorizó solo el uso interno» es
 * un hecho legítimo y útil —queda en la bitácora, con su autor y su fecha— y ya no condena
 * al item: cuando la persona autorice el procesamiento externo, ese consentimiento nuevo
 * pasa a ser el vigente y desbloquea la generación.
 */
function FormularioConsentimiento({
  workspaceId,
  itemId,
  titulo,
  onRegistrado,
  onError,
}: {
  workspaceId: string;
  itemId: string;
  titulo: string;
  onRegistrado: (r: { version: number; autorizaExterno: boolean }) => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [alcance, setAlcance] = useState('');
  const [procesamientoExterno, setProcesamientoExterno] = useState(false);
  const [enviando, setEnviando] = useState(false);

  return (
    <form
      style={{ ...CAJA_CORRECCION, marginTop: 14 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setEnviando(true);
        onError(null);
        try {
          const r = await registrarConsentimientoAI({
            data: { workspaceId, itemId, alcance, procesamientoExterno },
          });
          if (r.ok) await onRegistrado({ version: r.version, autorizaExterno: r.autorizaExterno });
          else onError(r.error);
        } catch {
          onError('No se pudo registrar el consentimiento; intenta de nuevo');
        } finally {
          setEnviando(false);
        }
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        «{titulo}» es material de personas: registra el consentimiento antes de procesarlo
      </span>
      <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
        Sin un consentimiento vigente que cubra el procesamiento externo, el material no sale
        hacia el proveedor AI (RF-09.5). El item sigue pudiendo curarse a mano en la bandeja,
        como siempre. Un registro posterior manda sobre los anteriores: si retira el permiso,
        detiene las generaciones que aún no hayan salido y ninguna propuesta podrá nacer de
        ese material — lo que ya viajó al proveedor no se puede des-enviar.
      </span>
      <label style={campo}>
        <span style={etiqueta}>Qué autorizó la persona</span>
        <Textarea
          required
          rows={2}
          maxLength={1000}
          value={alcance}
          onChange={(e) => setAlcance(e.target.value)}
          placeholder="Grabación y transcripción de la entrevista del 12/06, autorizadas por escrito"
        />
      </label>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          font: '400 12.5px var(--font-sans)',
          color: 'var(--text-body)',
        }}
      >
        <Checkbox
          checked={procesamientoExterno}
          onChange={(e) => setProcesamientoExterno(e.target.checked)}
        />
        El consentimiento cubre el procesamiento por un proveedor externo
      </label>
      <div>
        <Button type="submit" size="sm" disabled={enviando}>
          {enviando ? 'Registrando…' : 'Registrar consentimiento'}
        </Button>
      </div>
      {!procesamientoExterno && (
        <span style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--text-faint)' }}>
          Autorizar la grabación no es autorizar mandarla a un tercero: sin esa casilla, la AI
          sigue sin poder procesar este material. El registro se guarda igual —es un hecho de la
          investigación— y no cierra la puerta: si la persona lo autoriza más adelante, se
          registra un consentimiento nuevo y ese pasa a ser el vigente.
        </span>
      )}
    </form>
  );
}

function TarjetaPropuesta({
  propuesta,
  workspaceId,
  puedeRevisar,
  onCambio,
  onError,
}: {
  propuesta: PropuestaEnPanel;
  workspaceId: string;
  puedeRevisar: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [corrigiendo, setCorrigiendo] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const esExtraccion = propuesta.destino === 'evidencia';
  const anclaDisponible = propuesta.anclaEstado === 'disponible';
  const citasFieles = propuesta.citas.filter((c) => c.fiel).length;

  async function decidir(correccion?: ContenidoPropuesta) {
    setOcupado(true);
    onError(null);
    try {
      const r = await aceptarPropuestaAI({
        data: { workspaceId, propuestaId: propuesta.id, correccion },
      });
      if (r.ok) {
        setCorrigiendo(false);
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo aceptar la propuesta; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  async function rechazar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await rechazarPropuestaAI({ data: { workspaceId, propuestaId: propuesta.id } });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo rechazar la propuesta; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Tag>{propuesta.capacidad}</Tag>
        <span
          style={{
            font: '700 14px var(--font-sans)',
            color: 'var(--ink)',
            flex: 1,
            minWidth: 200,
          }}
        >
          {esExtraccion ? 'Evidencia propuesta' : 'Criterio de éxito propuesto'}
        </span>
        {propuesta.esSimulacion && <Tag mono={false}>simulación AI</Tag>}
        <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ESTADO[propuesta.estado] }}>
          {TEXTO_ESTADO[propuesta.estado]}
        </span>
      </div>
      <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
        Alcance: {propuesta.anclaTitulo}
      </span>

      {esExtraccion ? (
        <FichaExtraccion contenido={propuesta.contenido as ContenidoExtraccion} />
      ) : (
        <FichaCriterio contenido={propuesta.contenido as ContenidoCriterio} />
      )}

      {propuesta.citas.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={etiqueta}>
            Citas · {citasFieles}/{propuesta.citas.length} verificadas literales en el material
          </span>
          {propuesta.citas.map((c, i) => (
            <div
              key={i}
              style={{
                font: '400 12px/1.5 var(--font-mono)',
                color: c.fiel ? 'var(--text-body)' : 'var(--danger)',
                overflowWrap: 'anywhere',
              }}
            >
              {c.fiel ? '· ' : '⚠ '}«{c.fragmento}» — {c.localizacion}
              {!c.fiel && ' (no aparece literal en el material)'}
            </div>
          ))}
        </div>
      )}

      {propuesta.contenidoOriginal && (
        <details>
          <summary style={{ ...etiqueta, cursor: 'pointer' }}>
            Propuesta original (antes de la corrección humana)
          </summary>
          <pre
            style={{
              font: '400 11.5px/1.5 var(--font-mono)',
              color: 'var(--text-muted)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              margin: '6px 0 0',
            }}
          >
            {JSON.stringify(propuesta.contenidoOriginal, null, 2)}
          </pre>
        </details>
      )}

      <span style={{ font: '400 11px var(--font-mono)', color: 'var(--text-faint)' }}>
        lineage: {propuesta.modelo} · prompt {propuesta.promptVersion} · key {propuesta.origenKey}
        {propuesta.latenciaMs !== null ? ` · ${propuesta.latenciaMs} ms` : ''}
        {/* Coste MEDIDO de la llamada que la produjo, no estimado. Sin dato se dice, no
            se rellena con un cero que parecería gratis. */}
        {propuesta.costoUsd !== null
          ? ` · $${propuesta.costoUsd.toFixed(4)}`
          : ' · coste sin registrar'}{' '}
        · {propuesta.alcanceResumen}
      </span>

      {propuesta.estado === 'propuesta' && !puedeRevisar && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          La decisión la toma la boutique (lead o diseñador).
        </span>
      )}
      {/* El ancla dejó de admitir la materialización, y cada motivo tiene su salida: el
          item se curó a mano, la persona retiró el consentimiento (RF-09.4/09.5), el G0 del
          reto congeló los criterios (SYS-22) o el reto avanzó en su ciclo de vida y ya no
          admite criterios nuevos (RF-04.12). En los cuatro casos la propuesta quedó obsoleta
          y aceptarla solo produciría un rechazo de la base — pero RECHAZAR sigue habilitado
          abajo, porque es justamente la salida que cierra la fila. */}
      {propuesta.estado === 'propuesta' && puedeRevisar && !anclaDisponible && (
        <span style={{ font: '500 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
          {MOTIVO_ANCLA[propuesta.anclaEstado]}
        </span>
      )}
      {propuesta.estado === 'propuesta' && puedeRevisar && !corrigiendo && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button size="sm" disabled={ocupado || !anclaDisponible} onClick={() => void decidir()}>
            Aceptar tal cual
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={ocupado || !anclaDisponible}
            onClick={() => setCorrigiendo(true)}
          >
            Corregir y aceptar
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => void rechazar()}>
            Rechazar
          </Button>
        </div>
      )}
      {propuesta.estado === 'propuesta' && puedeRevisar && corrigiendo && esExtraccion && (
        <FormularioExtraccion
          inicial={propuesta.contenido as ContenidoExtraccion}
          ocupado={ocupado}
          onEnviar={decidir}
          onCancelar={() => setCorrigiendo(false)}
        />
      )}
      {propuesta.estado === 'propuesta' && puedeRevisar && corrigiendo && !esExtraccion && (
        <FormularioCriterio
          inicial={propuesta.contenido as ContenidoCriterio}
          ocupado={ocupado}
          onEnviar={decidir}
          onCancelar={() => setCorrigiendo(false)}
        />
      )}
    </Card>
  );
}

function Dato({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, font: '400 12.5px/1.6 var(--font-sans)' }}>
      <span style={{ color: 'var(--text-faint)', minWidth: 120 }}>{rotulo}</span>
      <span style={{ color: 'var(--text-body)', flex: 1, overflowWrap: 'anywhere' }}>{valor}</span>
    </div>
  );
}

function FichaExtraccion({ contenido }: { contenido: ContenidoExtraccion }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: 12,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <Dato rotulo="Título" valor={contenido.titulo} />
      {contenido.resumen && <Dato rotulo="Resumen" valor={contenido.resumen} />}
      <Dato rotulo="Recolección" valor={contenido.recoleccion} />
      <Dato rotulo="Fecha del material" valor={contenido.fecha} />
      <Dato
        rotulo="Dimensiones"
        valor={`confianza ${contenido.confianza} · ${contenido.derivada ? 'derivada' : 'primaria'} · confidencialidad ${contenido.confidencialidad}${contenido.esEstadoActual ? ' · describe el estado actual' : ''}`}
      />
      <Dato
        rotulo="Consentimiento"
        valor="el que se registró sobre el item ANTES de procesarlo (RF-09.5); la AI no lo propone ni lo infiere"
      />
    </div>
  );
}

function FichaCriterio({ contenido }: { contenido: ContenidoCriterio }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: 12,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <Dato rotulo="KPI" valor={contenido.kpi} />
      <Dato rotulo="Definición" valor={contenido.definicion} />
      <Dato rotulo="Objetivo" valor={contenido.objetivo} />
      <Dato rotulo="Ventana" valor={`${contenido.ventanaDias} días`} />
      <Dato rotulo="Plan de línea base" valor={contenido.lineaBasePlan} />
      {contenido.razonamiento && <Dato rotulo="Razonamiento" valor={contenido.razonamiento} />}
    </div>
  );
}

const CAJA_CORRECCION: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 16,
  background: 'var(--surface-sunken)',
  borderRadius: 'var(--r-sm)',
};

function FormularioExtraccion({
  inicial,
  ocupado,
  onEnviar,
  onCancelar,
}: {
  inicial: ContenidoExtraccion;
  ocupado: boolean;
  onEnviar: (c: ContenidoExtraccion) => Promise<void>;
  onCancelar: () => void;
}) {
  const [titulo, setTitulo] = useState(inicial.titulo);
  const [resumen, setResumen] = useState(inicial.resumen);
  const [recoleccion, setRecoleccion] = useState(inicial.recoleccion);
  const [fecha, setFecha] = useState(inicial.fecha);
  const [confianza, setConfianza] = useState(inicial.confianza);
  const [confidencialidad, setConfidencialidad] = useState(inicial.confidencialidad);
  const [derivada, setDerivada] = useState(inicial.derivada);
  const [esEstadoActual, setEsEstadoActual] = useState(inicial.esEstadoActual);

  return (
    <form
      style={CAJA_CORRECCION}
      onSubmit={(e) => {
        e.preventDefault();
        void onEnviar({
          titulo,
          resumen,
          recoleccion,
          fecha,
          confianza,
          confidencialidad,
          derivada,
          esEstadoActual,
          // Las citas NO se editan: son el rastro verificable de lo que el modelo dijo
          // haber leído; corregirlas a mano borraría la señal de grounding.
          citas: inicial.citas,
        });
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        Corregir antes de aceptar (la propuesta original se conserva)
      </span>
      <label style={campo}>
        <span style={etiqueta}>Título</span>
        <Input required maxLength={300} value={titulo} onChange={(e) => setTitulo(e.target.value)} />
      </label>
      <label style={campo}>
        <span style={etiqueta}>Resumen</span>
        <Textarea rows={2} maxLength={2000} value={resumen} onChange={(e) => setResumen(e.target.value)} />
      </label>
      <label style={campo}>
        <span style={etiqueta}>Método de recolección</span>
        <Input
          required
          maxLength={300}
          value={recoleccion}
          onChange={(e) => setRecoleccion(e.target.value)}
        />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <label style={campo}>
          <span style={etiqueta}>Fecha del material</span>
          <Input type="date" required value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </label>
        <label style={campo}>
          <span style={etiqueta}>Confianza</span>
          <Select value={confianza} onChange={(e) => setConfianza(e.target.value as typeof confianza)}>
            <option value="alta">Alta</option>
            <option value="media">Media</option>
            <option value="baja">Baja</option>
          </Select>
        </label>
        <label style={campo}>
          <span style={etiqueta}>Confidencialidad</span>
          <Select
            value={confidencialidad}
            onChange={(e) => setConfidencialidad(e.target.value as typeof confidencialidad)}
          >
            <option value="interna">Interna</option>
            <option value="cliente">Cliente</option>
            <option value="restringida">Restringida</option>
          </Select>
        </label>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 20,
          flexWrap: 'wrap',
          font: '400 12.5px var(--font-sans)',
          color: 'var(--text-body)',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox checked={derivada} onChange={(e) => setDerivada(e.target.checked)} />
          Evidencia derivada (no primaria)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox checked={esEstadoActual} onChange={(e) => setEsEstadoActual(e.target.checked)} />
          Describe el estado ACTUAL del servicio
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button type="submit" size="sm" disabled={ocupado}>
          {ocupado ? 'Aceptando…' : 'Aceptar con estas correcciones'}
        </Button>
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function FormularioCriterio({
  inicial,
  ocupado,
  onEnviar,
  onCancelar,
}: {
  inicial: ContenidoCriterio;
  ocupado: boolean;
  onEnviar: (c: ContenidoCriterio) => Promise<void>;
  onCancelar: () => void;
}) {
  const [kpi, setKpi] = useState(inicial.kpi);
  const [definicion, setDefinicion] = useState(inicial.definicion);
  const [objetivo, setObjetivo] = useState(inicial.objetivo);
  const [ventanaDias, setVentanaDias] = useState(String(inicial.ventanaDias));
  const [lineaBasePlan, setLineaBasePlan] = useState(inicial.lineaBasePlan);

  return (
    <form
      style={CAJA_CORRECCION}
      onSubmit={(e) => {
        e.preventDefault();
        void onEnviar({
          kpi,
          definicion,
          objetivo,
          ventanaDias: Number.parseInt(ventanaDias, 10),
          lineaBasePlan,
          razonamiento: inicial.razonamiento,
        });
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        Corregir antes de aceptar (la propuesta original se conserva)
      </span>
      <label style={campo}>
        <span style={etiqueta}>KPI</span>
        <Input required maxLength={200} value={kpi} onChange={(e) => setKpi(e.target.value)} />
      </label>
      <label style={campo}>
        <span style={etiqueta}>Definición del cálculo</span>
        <Textarea
          required
          rows={2}
          maxLength={2000}
          value={definicion}
          onChange={(e) => setDefinicion(e.target.value)}
        />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <label style={campo}>
          <span style={etiqueta}>Objetivo</span>
          <Input required maxLength={200} value={objetivo} onChange={(e) => setObjetivo(e.target.value)} />
        </label>
        <label style={campo}>
          <span style={etiqueta}>Ventana (días)</span>
          <Input
            required
            type="number"
            min={1}
            max={3650}
            value={ventanaDias}
            onChange={(e) => setVentanaDias(e.target.value)}
          />
        </label>
      </div>
      <label style={campo}>
        <span style={etiqueta}>Plan para obtener la línea base</span>
        <Textarea
          required
          rows={2}
          maxLength={1000}
          value={lineaBasePlan}
          onChange={(e) => setLineaBasePlan(e.target.value)}
        />
      </label>
      <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
        El valor y la fecha de la línea base los registra una persona editando el criterio: la AI
        no inventa mediciones.
      </span>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button type="submit" size="sm" disabled={ocupado}>
          {ocupado ? 'Aceptando…' : 'Aceptar con estas correcciones'}
        </Button>
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
