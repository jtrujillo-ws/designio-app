import { useState } from 'react';
import type { CSSProperties } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { evidenciasDelWorkspace } from '@/lib/evidencia/evidencia.functions';
import { ROLES_CURADORES, type EvidenciaCitable } from '@/lib/evidencia/evidencia.schemas';
import {
  afirmarEnInsight,
  anotarContradiccion,
  citarEvidencia,
  insightsDelEspacio,
  proponerInsight,
  validarInsightPropuesto,
} from '@/lib/insight/insight.functions';
import type { InsightCompleto } from '@/lib/insight/insight.schemas';

/**
 * Insights (SPEC-03, RF-03.9): afirmaciones sostenidas por citas verificables.
 *
 * La pantalla hace visible lo que el método exige: qué se afirma, con qué cita se
 * sostiene cada afirmación, qué es hipótesis declarada, y qué evidencia CONTRADICE al
 * insight. La contradicción se muestra igual de grande que el apoyo — ocultarla sería
 * exactamente el sesgo que el grounding existe para combatir.
 */
export const Route = createFileRoute('/_autenticada/insights')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    if (!workspaceId) return null;
    const [insights, evidencias] = await Promise.all([
      insightsDelEspacio({ data: { workspaceId } }),
      evidenciasDelWorkspace({ data: { workspaceId } }),
    ]);
    return {
      workspaceId,
      insights: insights.insights,
      // Cursor keyset de la primera página: «cargar más» sigue desde aquí sin saltar
      // ni repetir. Sin esto, un insight viejo quedaba fuera de alcance para siempre.
      siguiente: insights.siguiente,
      evidencias: evidencias?.evidencias ?? [],
      hayMasEvidencias: evidencias?.hayMas ?? false,
    };
  },
  component: PantallaInsights,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

function PantallaInsights() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  const [titulo, setTitulo] = useState('');
  const [resumen, setResumen] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const rol = membresiaActiva?.rol ?? '';
  const puedeCurar = (ROLES_CURADORES as readonly string[]).includes(rol);

  async function crear() {
    if (!datos) return;
    setOcupado(true);
    setError(null);
    try {
      const r = await proponerInsight({ data: { workspaceId: datos.workspaceId, titulo, resumen } });
      if (r.ok) {
        setCreando(false);
        setTitulo('');
        setResumen('');
        await router.invalidate();
      } else setError(r.error);
    } catch {
      setError('No se pudo proponer el insight; intenta de nuevo');
    } finally {
      setOcupado(false);
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
            Insights · afirmaciones con citas
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
        {error && (
          <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
            {error}
          </span>
        )}
        {datos && (
          <>
            <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
                Interpretación con respaldo
              </span>
              <span style={{ font: '400 12.5px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
                Un insight se valida cuando toda afirmación que no está marcada como
                hipótesis tiene al menos una cita a evidencia curada. Validado es
                inmutable: sostiene decisiones e ítems de gate.
              </span>
              {puedeCurar && !creando && (
                <div>
                  <Button size="sm" variant="secondary" onClick={() => setCreando(true)}>
                    Proponer insight
                  </Button>
                </div>
              )}
              {creando && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Input
                    placeholder="Qué se aprendió (título)"
                    value={titulo}
                    onChange={(e) => setTitulo(e.target.value)}
                  />
                  <Input
                    placeholder="Resumen (opcional)"
                    value={resumen}
                    onChange={(e) => setResumen(e.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button size="sm" disabled={ocupado || titulo.trim() === ''} onClick={() => void crear()}>
                      Proponer
                    </Button>
                    <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setCreando(false)}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              )}
            </Card>

            {/* La `key` es el BORDE de la primera página del loader. Proponer un insight
                invalida la ruta y el loader devuelve otra primera página: el insight que
                estaba al final se desplaza a la segunda, y el cursor acumulado —que apunta
                más allá de él— lo saltaría para siempre; un `null` terminal, además, se
                quedaría terminal aunque llegaran páginas nuevas.

                Al cambiar la key, React desmonta y vuelve a montar: la acumulación se
                reinicia con el cursor nuevo sin efecto que la sincronice (un efecto llega
                tarde y deja pintar una vez la lista incoherente) y sin ajustar estado
                durante el render (correcto, pero sutil de leer y de mantener). */}
            <ListaDeInsights
              key={`${datos.siguiente?.creadoEn ?? ''}|${datos.siguiente?.id ?? ''}`}
              datos={datos}
              puedeCurar={puedeCurar}
              onCambio={() => router.invalidate()}
              onError={setError}
            />
          </>
        )}
      </main>
    </div>
  );
}

/**
 * La lista paginada. Vive aparte del formulario de alta porque su estado —las páginas
 * acumuladas y el cursor— pertenece a UNA primera página concreta: cuando el loader trae
 * otra, lo correcto es empezar de cero, y eso se expresa remontando con una `key`.
 *
 * El cursor se inicializa CON el del loader y no cae a él por defecto: si el fallback
 * fuera `cursor ?? datos.siguiente`, al agotar las páginas `setCursor(null)` volvería al
 * cursor original y el botón pediría la segunda página para siempre, duplicando insights
 * y claves de React. Un null terminal tiene que seguir siendo terminal.
 */
function ListaDeInsights({
  datos,
  puedeCurar,
  onCambio,
  onError,
}: {
  datos: NonNullable<ReturnType<typeof Route.useLoaderData>>;
  puedeCurar: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  // Páginas cargadas DESPUÉS de la del loader. Se guardan aquí y no en la URL porque son
  // acumulativas: volver atrás no debería reconstruir seis páginas.
  const [masPaginas, setMasPaginas] = useState<InsightCompleto[]>([]);
  const [cursor, setCursor] = useState<{ creadoEn: string; id: string } | null>(
    datos.siguiente ?? null,
  );
  const [cargando, setCargando] = useState(false);
  const listados = [...datos.insights, ...masPaginas];

  async function cargarMas() {
    if (!cursor) return;
    setCargando(true);
    onError(null);
    try {
      const r = await insightsDelEspacio({ data: { workspaceId: datos.workspaceId, cursor } });
      setMasPaginas((previas) => [...previas, ...r.insights]);
      setCursor(r.siguiente);
    } catch {
      onError('No se pudieron cargar más insights; intenta de nuevo');
    } finally {
      setCargando(false);
    }
  }

  return (
    <>
      {listados.length === 0 && (
        <Card style={{ padding: 24 }}>
          <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
            Todavía no hay insights. La investigación de la etapa 1 aterriza aquí.
          </span>
        </Card>
      )}
      {listados.map((insight) => (
        <FichaInsight
          key={insight.id}
          workspaceId={datos.workspaceId}
          insight={insight}
          evidencias={datos.evidencias}
          hayMasEvidencias={datos.hayMasEvidencias}
          puedeCurar={puedeCurar}
          onCambio={onCambio}
          onError={onError}
        />
      ))}
      {cursor && (
        <div>
          <Button size="sm" variant="secondary" disabled={cargando} onClick={() => void cargarMas()}>
            {cargando ? 'Cargando…' : 'Cargar más insights'}
          </Button>
        </div>
      )}
    </>
  );
}

function FichaInsight({
  workspaceId,
  insight,
  evidencias,
  hayMasEvidencias,
  puedeCurar,
  onCambio,
  onError,
}: {
  workspaceId: string;
  /** Con su `citable` y su motivo: citar exige derechos vigentes para el ámbito cliente
   * (RF-03.10) y la opción bloqueada se muestra deshabilitada CON la razón, nunca
   * oculta — el bloqueo real lo impone el guard de la base; esto lo hace legible. */
  insight: InsightCompleto;
  evidencias: EvidenciaCitable[];
  hayMasEvidencias: boolean;
  puedeCurar: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [ocupado, setOcupado] = useState(false);
  const [textoAfirmacion, setTextoAfirmacion] = useState('');
  const [esHipotesis, setEsHipotesis] = useState(false);
  const [citandoDe, setCitandoDe] = useState<string | null>(null);
  const [evidenciaId, setEvidenciaId] = useState('');
  const [fragmento, setFragmento] = useState('');
  const [localizacion, setLocalizacion] = useState('');
  const [contradiciendo, setContradiciendo] = useState(false);
  const [contraEvidenciaId, setContraEvidenciaId] = useState('');
  const [descripcion, setDescripcion] = useState('');

  const editable = insight.estado === 'propuesto';
  // Espejo del guard: solo informa el botón; la exigencia real vive en la base.
  const listoParaValidar =
    insight.afirmaciones.length > 0 &&
    insight.afirmaciones.every((a) => a.esHipotesis || a.citas.length > 0);

  async function ejecutar(accion: () => Promise<{ ok: boolean; error?: string }>, fallo: string) {
    setOcupado(true);
    onError(null);
    try {
      const r = await accion();
      if (r.ok) await onCambio();
      else onError(r.error ?? fallo);
      return r.ok;
    } catch {
      onError(fallo);
      return false;
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '700 14.5px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 200 }}>
          {insight.titulo}
        </span>
        <Tag>{insight.estado}</Tag>
        {insight.validadoEn && <span style={micro}>{insight.validadoEn}</span>}
      </div>
      {insight.resumen && (
        <span style={{ font: '400 12.5px/1.6 var(--font-sans)', color: 'var(--text-body)' }}>
          {insight.resumen}
        </span>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={micro}>Afirmaciones</span>
        {insight.afirmaciones.length === 0 && (
          <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
            Sin afirmaciones todavía.
          </span>
        )}
        {insight.afirmaciones.map((a) => (
          <div
            key={a.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '8px 10px',
              background: 'var(--surface-sunken)',
              borderRadius: 'var(--r-sm)',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-body)', flex: 1, minWidth: 180 }}>
                {a.texto}
              </span>
              {a.esHipotesis ? (
                <span style={{ font: '600 11.5px var(--font-sans)', color: 'var(--warn)' }}>
                  hipótesis declarada
                </span>
              ) : (
                <span
                  style={{
                    font: '600 11.5px var(--font-sans)',
                    color: a.citas.length > 0 ? 'var(--accent)' : 'var(--danger)',
                  }}
                >
                  {a.citas.length > 0 ? `${a.citas.length} cita(s)` : 'sin cita'}
                </span>
              )}
            </div>
            {a.citas.map((c) => (
              <span key={c.id} style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--text-muted)' }}>
                «{c.fragmento}» — {c.evidenciaTitulo}
                {` · ${c.localizacion}`}
              </span>
            ))}
            {editable && puedeCurar && citandoDe !== a.id && (
              <div>
                <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setCitandoDe(a.id)}>
                  Citar evidencia
                </Button>
              </div>
            )}
            {citandoDe === a.id && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Select value={evidenciaId} onChange={(e) => setEvidenciaId(e.target.value)}>
                  <option value="">Evidencia citada…</option>
                  {/* La cita COPIA el fragmento del original y es lo que después valida
                      el insight: sin derechos vigentes para el ámbito cliente no se
                      crea. Deshabilitada CON su motivo, nunca oculta (SYS-14). */}
                  {evidencias.map((e) => (
                    <option key={e.id} value={e.id} disabled={!e.citable}>
                      {e.citable
                        ? e.titulo
                        : `${e.titulo} — sin derechos: ${
                            e.motivoBloqueo ?? 'faltan derechos de uso para el ámbito cliente'
                          }`}
                    </option>
                  ))}
                  {hayMasEvidencias && (
                    <option value="" disabled>
                      … hay más evidencias (solo se listan las 200 más recientes)
                    </option>
                  )}
                </Select>
                <Input
                  placeholder="Fragmento exacto que se cita"
                  value={fragmento}
                  onChange={(e) => setFragmento(e.target.value)}
                />
                {/* Obligatoria: la cita tiene que devolver al PUNTO. Sin esto vuelve a
                    ser una referencia al documento, que es lo que no sirve al auditar. */}
                <Input
                  placeholder="Dónde está (página, párrafo o marca de tiempo) — obligatorio"
                  value={localizacion}
                  onChange={(e) => setLocalizacion(e.target.value)}
                  required
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    size="sm"
                    disabled={
                      ocupado ||
                      evidenciaId === '' ||
                      fragmento.trim() === '' ||
                      localizacion.trim() === ''
                    }
                    onClick={() =>
                      void ejecutar(
                        () =>
                          citarEvidencia({
                            data: {
                              workspaceId,
                              afirmacionId: a.id,
                              evidenciaId,
                              fragmento,
                              localizacion,
                            },
                          }),
                        'No se pudo agregar la cita',
                      ).then((ok) => {
                        if (ok) {
                          setCitandoDe(null);
                          setEvidenciaId('');
                          setFragmento('');
                          setLocalizacion('');
                        }
                      })
                    }
                  >
                    Citar
                  </Button>
                  <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setCitandoDe(null)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
        {editable && puedeCurar && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              placeholder="Nueva afirmación"
              value={textoAfirmacion}
              onChange={(e) => setTextoAfirmacion(e.target.value)}
              style={{ minWidth: 240, flex: 1 }}
            />
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', font: '400 12px var(--font-sans)' }}>
              <input
                type="checkbox"
                checked={esHipotesis}
                onChange={(e) => setEsHipotesis(e.target.checked)}
              />
              es hipótesis
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={ocupado || textoAfirmacion.trim() === ''}
              onClick={() =>
                void ejecutar(
                  () =>
                    afirmarEnInsight({
                      data: { workspaceId, insightId: insight.id, texto: textoAfirmacion, esHipotesis },
                    }),
                  'No se pudo agregar la afirmación',
                ).then((ok) => {
                  if (ok) {
                    setTextoAfirmacion('');
                    setEsHipotesis(false);
                  }
                })
              }
            >
              Agregar
            </Button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={micro}>Contradicciones registradas</span>
        {insight.contradicciones.length === 0 && (
          <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
            Ninguna registrada.
          </span>
        )}
        {insight.contradicciones.map((c) => (
          <span key={c.id} style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--danger)' }}>
            {c.evidenciaTitulo}: {c.descripcion}
          </span>
        ))}
        {!contradiciendo && (
          <div>
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setContradiciendo(true)}>
              Registrar contradicción
            </Button>
          </div>
        )}
        {contradiciendo && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Select value={contraEvidenciaId} onChange={(e) => setContraEvidenciaId(e.target.value)}>
              <option value="">Evidencia que lo contradice…</option>
              {/* SIN filtro de derechos, y es deliberado: RF-03.9 dice que la
                  contradicción se registra y se muestra SIEMPRE, jamás bloquea ni se
                  oculta, y la puede levantar cualquier miembro. Impedir señalar que una
                  evidencia contradice un insight porque le faltan derechos de PUBLICACIÓN
                  suprimiría justo el descubrimiento incómodo que la spec protege. Lo que
                  no puede es salir en el entregable: de eso se encarga la poda. */}
              {evidencias.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.titulo}
                </option>
              ))}
            </Select>
            <Input
              placeholder="En qué contradice"
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="sm"
                disabled={ocupado || contraEvidenciaId === '' || descripcion.trim() === ''}
                onClick={() =>
                  void ejecutar(
                    () =>
                      anotarContradiccion({
                        data: {
                          workspaceId,
                          insightId: insight.id,
                          evidenciaId: contraEvidenciaId,
                          descripcion,
                        },
                      }),
                    'No se pudo registrar la contradicción',
                  ).then((ok) => {
                    if (ok) {
                      setContradiciendo(false);
                      setContraEvidenciaId('');
                      setDescripcion('');
                    }
                  })
                }
              >
                Registrar
              </Button>
              <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setContradiciendo(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </div>

      {editable && puedeCurar && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            disabled={ocupado || !listoParaValidar}
            onClick={() =>
              void ejecutar(
                () => validarInsightPropuesto({ data: { workspaceId, insightId: insight.id } }),
                'No se pudo validar el insight',
              )
            }
          >
            Validar insight
          </Button>
          {!listoParaValidar && (
            <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
              Falta al menos una cita en las afirmaciones que no son hipótesis.
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
