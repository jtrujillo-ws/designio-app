import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { AvisoDeDestacadoAusente, Destacado } from '@/components/ui/Destacado';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { DescargaArchivo } from '@/components/evidencia/DescargaArchivo';
import { wsDeBusqueda } from '@/lib/auth/workspace-activo';
import {
  decidirDerechosDeEvidencia,
  evidenciaConDerechos,
  evidenciaConDerechosDeUna,
} from '@/lib/evidencia/evidencia.functions';
import {
  AMBITOS_USO,
  ETIQUETA_AMBITO,
  ROLES_DERECHOS,
  type AmbitoUso,
  type EvidenciaConDerechos,
} from '@/lib/evidencia/evidencia.schemas';

/**
 * Evidencia curada y sus DERECHOS DE USO (SPEC-03, RF-03.10 / SYS-14). Los derechos
 * nacen pendientes: hasta que alguien los concede con una base documental, la evidencia
 * existe pero no se cita en un gate ni sale en un entregable. Esta pantalla es donde ese
 * acto ocurre — y donde el bloqueo se explica en lugar de esconderse.
 */
export const Route = createFileRoute('/_autenticada/evidencia')({
  // `destacar`: el id de la evidencia a la que se vino (desde el buscador o la bandeja de
  // aprobaciones). La lista sigue siendo la misma; si la pedida no cae en la primera página
  // —keyset de las más recientes, y lo que más espera es lo más antiguo— el loader la trae
  // aparte y la pantalla la fija arriba: un enlace que aterriza en «no está entre lo
  // cargado» no es un enlace.
  // Solo cuenta un uuid bien formado (misma regla que `ws` y `servicio`): el loader lo pide
  // por id con un schema uuid, y un `?destacar=foo` tecleado a mano no debe tumbar la ruta.
  validateSearch: (search: Record<string, unknown>): { destacar?: string } => {
    const destacar = wsDeBusqueda(search.destacar);
    return destacar ? { destacar } : {};
  },
  loaderDeps: ({ search }) => ({ ws: search.ws, destacar: search.destacar }),
  loader: async ({ context, deps }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    if (!workspaceId) return null;
    const lista = await evidenciaConDerechos({ data: { workspaceId } });
    if (!lista) return null;
    const fijada =
      deps.destacar && !lista.evidencias.some((e) => e.id === deps.destacar)
        ? await evidenciaConDerechosDeUna({ data: { workspaceId, evidenciaId: deps.destacar } })
        : null;
    return { ...lista, fijada };
  },
  component: PantallaEvidencia,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const COLOR_DERECHOS: Record<string, string> = {
  concedido: 'var(--accent)',
  pendiente: 'var(--warn)',
  denegado: 'var(--danger)',
};

function PantallaEvidencia() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const rol = membresiaActiva?.rol ?? '';
  // Conceder derechos es un acto contractual: lo hace quien opera el engagement o quien
  // administra los datos del cliente. El servidor lo re-valida (capa 2) y la política
  // RLS es la capa 1: aquí solo se evita ofrecer un control que sería rechazado.
  const puedeDecidir = (ROLES_DERECHOS as readonly string[]).includes(rol);
  const [error, setError] = useState<string | null>(null);
  const { destacar } = Route.useSearch();
  // Páginas siguientes cargadas bajo demanda (el loader trae la primera).
  const [masEvidencias, setMasEvidencias] = useState<EvidenciaConDerechos[]>([]);
  const [hayMasLocal, setHayMasLocal] = useState<boolean | null>(null);

  // El cursor con el que se pidieron las páginas siguientes es la ÚLTIMA fila de la
  // primera página. Si el loader se revalida y ese borde cambia —conceder un derecho
  // invalida la ruta, y también la cambia un workspace distinto o una evidencia nueva—,
  // lo acumulado colgaba de un cursor que ya no existe y al concatenarlo saltaría o
  // repetiría filas. Se descarta AQUÍ, durante el render: hacerlo en un efecto pintaría
  // primero un fotograma con la lista mal empalmada.
  const borde = datos?.evidencias.at(-1)?.id ?? null;
  const [bordeVisto, setBordeVisto] = useState(borde);
  if (bordeVisto !== borde) {
    setBordeVisto(borde);
    setMasEvidencias([]);
    setHayMasLocal(null);
  }

  // La fijada va aparte y no se repite si «cargar más» llega hasta ella.
  const fijada = datos?.fijada ?? null;
  const evidencias = datos
    ? [...datos.evidencias, ...masEvidencias].filter((e) => e.id !== fijada?.id)
    : [];
  const hayMas = hayMasLocal ?? datos?.hayMas ?? false;
  const [cargandoMas, setCargandoMas] = useState(false);

  // Tras una decisión, la acumulación se descarta explícitamente: las páginas ya
  // cargadas son copias con el estado de derechos VIEJO y el loader solo refresca la
  // primera. Volver a la página uno es honesto; mostrar «pendiente» sobre un derecho
  // recién concedido, no.
  async function refrescar() {
    setMasEvidencias([]);
    setHayMasLocal(null);
    await router.invalidate();
  }

  async function cargarMas() {
    if (!datos || evidencias.length === 0) return;
    setCargandoMas(true);
    setError(null);
    try {
      const ultima = evidencias[evidencias.length - 1]!;
      const r = await evidenciaConDerechos({
        data: { workspaceId: datos.workspaceId, antesDe: ultima.id },
      });
      if (r) {
        setMasEvidencias((previas) => [...previas, ...r.evidencias]);
        setHayMasLocal(r.hayMas);
      }
    } catch {
      setError('No se pudo cargar más evidencia; intenta de nuevo');
    } finally {
      setCargandoMas(false);
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
            Evidencia y derechos de uso
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
            <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
                Los derechos restringen el uso aguas abajo
              </span>
              <span
                style={{ font: '400 13px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}
              >
                Una evidencia sin derechos vigentes para el ámbito «cliente» no puede citarse
                en el checklist de un gate ni salir en un paquete entregable. No es una regla
                de esta pantalla: la impone la base de datos, así que tampoco se la salta una
                consulta directa.
              </span>
            </Card>

            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}

            <div style={etiqueta}>
              {evidencias.length === 0
                ? 'Todavía no hay evidencia curada'
                : `${evidencias.length}${hayMas ? '+' : ''} evidencias · ${evidencias.filter((e) => e.citable).length} citables`}
            </div>

            {destacar !== undefined &&
              fijada === null &&
              !evidencias.some((e) => e.id === destacar) && (
                <AvisoDeDestacadoAusente que="La evidencia" />
              )}
            {fijada && (
              <Destacado id={fijada.id} destacado={fijada.id === destacar}>
                <span role="status" style={{ ...etiqueta, display: 'block', marginBottom: 8 }}>
                  Traída aquí por el enlace; en la lista va más abajo
                </span>
                <TarjetaEvidencia
                  evidencia={fijada}
                  workspaceId={datos.workspaceId}
                  puedeDecidir={puedeDecidir}
                  onCambio={refrescar}
                  onError={setError}
                />
              </Destacado>
            )}
            {evidencias.map((ev) => (
              <Destacado key={ev.id} id={ev.id} destacado={ev.id === destacar}>
                <TarjetaEvidencia
                  evidencia={ev}
                  workspaceId={datos.workspaceId}
                  puedeDecidir={puedeDecidir}
                  onCambio={refrescar}
                  onError={setError}
                />
              </Destacado>
            ))}

            {/* Sin esto la evidencia más antigua no tiene camino: sus derechos no se
                pueden conceder, revocar ni siquiera consultar desde el producto. */}
            {hayMas && (
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={cargandoMas}
                  onClick={() => void cargarMas()}
                >
                  {cargandoMas ? 'Cargando…' : 'Cargar evidencia más antigua'}
                </Button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function TarjetaEvidencia({
  evidencia,
  workspaceId,
  puedeDecidir,
  onCambio,
  onError,
}: {
  evidencia: EvidenciaConDerechos;
  workspaceId: string;
  puedeDecidir: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [decidiendo, setDecidiendo] = useState<'concedido' | 'denegado' | null>(null);

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            font: '700 14px var(--font-sans)',
            color: 'var(--ink)',
            flex: 1,
            minWidth: 200,
          }}
        >
          {evidencia.titulo}
        </span>
        {evidencia.esEstadoActual && <Tag>Estado actual</Tag>}
        <span
          style={{
            font: '600 11.5px var(--font-sans)',
            color: COLOR_DERECHOS[evidencia.derechos.estado] ?? 'var(--text-faint)',
          }}
        >
          derechos: {evidencia.derechos.estado}
          {evidencia.derechos.estado === 'concedido'
            ? ` · ${evidencia.derechos.ambito}`
            : ''}
        </span>
      </div>

      {evidencia.resumen && (
        <p
          style={{
            font: '400 13px/1.6 var(--font-sans)',
            color: 'var(--text-body)',
            margin: 0,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {evidencia.resumen}
        </p>
      )}

      {evidencia.derechos.base && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Base: {evidencia.derechos.base}
          {evidencia.derechos.venceEn ? ` · vence el ${evidencia.derechos.venceEn}` : ''}
        </span>
      )}

      {/* El bloqueo se explica (SYS-14): nunca un "no puedes" sin la dimensión que falta. */}
      {!evidencia.citable && (
        <span
          role="status"
          style={{ font: '500 12.5px/1.5 var(--font-sans)', color: 'var(--warn)' }}
        >
          No citable ni exportable como entregable — {evidencia.motivoBloqueo}
        </span>
      )}

      {evidencia.archivos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Originales adjuntos</span>
          {evidencia.archivos.map((a) => (
            <DescargaArchivo key={a.id} archivo={a} workspaceId={workspaceId} onError={onError} />
          ))}
        </div>
      )}

      {puedeDecidir && decidiendo === null && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button size="sm" onClick={() => setDecidiendo('concedido')}>
            {evidencia.derechos.estado === 'concedido' ? 'Cambiar concesión' : 'Conceder derechos'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDecidiendo('denegado')}>
            {evidencia.derechos.estado === 'concedido' ? 'Revocar' : 'Denegar'}
          </Button>
        </div>
      )}
      {!puedeDecidir && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Los derechos los decide el lead de la boutique o el admin del cliente.
        </span>
      )}
      {puedeDecidir && decidiendo !== null && (
        <FormularioDerechos
          workspaceId={workspaceId}
          evidenciaId={evidencia.id}
          decision={decidiendo}
          ambitoActual={evidencia.derechos.ambito}
          onListo={async () => {
            setDecidiendo(null);
            await onCambio();
          }}
          onCancelar={() => setDecidiendo(null)}
          onError={onError}
        />
      )}
    </Card>
  );
}

function FormularioDerechos({
  workspaceId,
  evidenciaId,
  decision,
  ambitoActual,
  onListo,
  onCancelar,
  onError,
}: {
  workspaceId: string;
  evidenciaId: string;
  decision: 'concedido' | 'denegado';
  ambitoActual: AmbitoUso;
  onListo: () => Promise<void>;
  onCancelar: () => void;
  onError: (e: string | null) => void;
}) {
  const [ambito, setAmbito] = useState<AmbitoUso>(ambitoActual);
  const [base, setBase] = useState('');
  const [venceEn, setVenceEn] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    onError(null);
    try {
      const r = await decidirDerechosDeEvidencia({
        data: {
          workspaceId,
          evidenciaId,
          decision,
          // Denegar no lleva ámbito ni vigencia (lo exige también el schema).
          ambito: decision === 'concedido' ? ambito : 'interno',
          base,
          venceEn: decision === 'concedido' && venceEn !== '' ? venceEn : null,
        },
      });
      if (r.ok) await onListo();
      else onError(r.error);
    } catch {
      onError('No se pudo registrar la decisión; intenta de nuevo');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <span style={{ font: '700 13px var(--font-sans)', color: 'var(--ink)' }}>
        {decision === 'concedido' ? 'Conceder derechos de uso' : 'Denegar o revocar derechos'}
      </span>
      {decision === 'concedido' && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Ámbito máximo</span>
            <Select value={ambito} onChange={(e) => setAmbito(e.target.value as AmbitoUso)}>
              {AMBITOS_USO.map((a) => (
                <option key={a} value={a}>
                  {ETIQUETA_AMBITO[a]}
                </option>
              ))}
            </Select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Vence (opcional)</span>
            <Input type="date" value={venceEn} onChange={(e) => setVenceEn(e.target.value)} />
          </label>
        </div>
      )}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={etiqueta}>
          {decision === 'concedido' ? 'Base documental' : 'Motivo de la denegación'}
        </span>
        <Input
          required
          maxLength={500}
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder={
            decision === 'concedido'
              ? 'p. ej. consentimiento firmado 2026-08-12 · cláusula 7 del contrato'
              : 'p. ej. la entrevista se grabó sin consentimiento de uso externo'
          }
        />
      </label>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button type="submit" disabled={enviando}>
          {enviando ? 'Registrando…' : 'Registrar decisión'}
        </Button>
        <Button variant="ghost" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
