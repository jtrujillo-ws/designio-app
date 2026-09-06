import { useState } from 'react';
import type { CSSProperties } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Tag } from '@/components/ui/Tag';
import { Wordmark } from '@/components/ui/Wordmark';
import { ETIQUETA_ROL } from '@/lib/auth/auth.schemas';
import {
  correrEvalDeGroundingDelWorkspace,
  informeDeGroundingDelWorkspace,
} from '@/lib/ai/ai.functions';
import {
  CAPACIDAD_AGREGADA,
  METRICAS_DE_GROUNDING,
  ROLES_INFORME_GROUNDING,
  type CorridaDeGrounding,
  type InformeDeGrounding,
  type MedicionDeGrounding,
  type MetricaDeGrounding,
} from '@/lib/ai/ai.schemas';

/**
 * RF-08.7 — el informe de grounding: la última corrida COMPARADA contra la anterior.
 *
 * La comparación no es un adorno de la pantalla: el criterio 4 de SPEC-08 pide las cifras
 * «comparadas contra la corrida anterior» y §17 nombra la alarma sobre esa comparación
 * —«fidelidad que no mejora entre releases del producto»—. Una tabla con la corrida de hoy y
 * sin la de antes no responde la pregunta para la que existe.
 */
export const Route = createFileRoute('/_autenticada/evals-grounding')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    const rol = context.membresiaActiva?.rol ?? '';
    // Solo se pide si el rol pasa. Pedirlo igual y descartar la respuesta habría gastado una
    // consulta por cada visita ajena y, peor, habría dejado el motivo del vacío en manos de un
    // `null` que también significa «tu sesión ya no tiene acceso»: dos cosas distintas.
    if (!workspaceId || !(ROLES_INFORME_GROUNDING as readonly string[]).includes(rol)) return null;
    return informeDeGroundingDelWorkspace({ data: { workspaceId } });
  },
  component: PantallaEvalsGrounding,
});

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const celda: CSSProperties = {
  padding: '7px 10px',
  borderBottom: '1px solid var(--border)',
  font: '400 13px var(--font-sans)',
  color: 'var(--text-body)',
  textAlign: 'left',
  verticalAlign: 'top',
};

const cifra: CSSProperties = { ...celda, fontFamily: 'var(--font-mono)', textAlign: 'right' };

/**
 * Cómo se presenta cada métrica, y QUÉ DIRECCIÓN es la buena.
 *
 * La dirección importa tanto como el número: en tres de las cuatro, subir es empeorar
 * —corregir más, sostener menos—, y en `contradicciones` es al revés. Sin decirlo, una flecha
 * roja al lado de la única métrica que mejora habría leído lo contrario de lo que pasa.
 */
const PRESENTACION: Record<
  MetricaDeGrounding,
  { titulo: string; explica: string; numerador: string; subirEsBueno: boolean }
> = {
  'suelo-presencia-literal': {
    titulo: 'Suelo de presencia literal',
    explica:
      'De las citas de lo aceptado, cuántas aparecen LITERALMENTE en el material que vio el modelo. Es un suelo, no la fidelidad: §9 de la fuente dice que «la presencia de una cita no equivale a grounding correcto». Una cita que ni siquiera aparece no puede ser fiel; una que aparece todavía puede no sostener lo que se afirma con ella.',
    numerador: 'citas presentes',
    subirEsBueno: true,
  },
  'afirmaciones-no-soportadas': {
    titulo: 'Afirmaciones no soportadas',
    explica:
      'Afirmaciones materializadas que NO se declararon hipótesis y hoy no tienen ninguna cita viva. «Viva» se mide con los derechos de uso, que caducan por fecha y se pueden revocar: una afirmación que nació sostenida deja de estarlo sin que nadie la toque.',
    numerador: 'sin sostén',
    subirEsBueno: false,
  },
  'correccion-humana': {
    titulo: 'Corrección humana',
    explica:
      'De lo que una persona materializó, cuánto tuvo que enmendar antes de firmarlo (SYS-17). El denominador son las materializadas y no las decididas: rechazar no es corregir.',
    numerador: 'corregidas',
    subirEsBueno: false,
  },
  contradicciones: {
    titulo: 'Contradicciones registradas',
    explica:
      'De los insights nacidos de una propuesta aceptada, cuántos llevan contraevidencia registrada (RF-03.9). Aquí SUBIR es lo bueno: el prompt lo pide con estas palabras, «un insight que solo trae lo que lo confirma no sirve para decidir». Lo que el número no distingue es quién la señaló: la del modelo y la que alguien añadió después viven en la misma tabla.',
    numerador: 'con contraevidencia',
    subirEsBueno: true,
  },
};

function porcentaje(t: number | null): string {
  if (t === null) return 'sin datos';
  // Deletreado, no «%»: el símbolo pegado a una cifra en una tabla de cuatro columnas se lee
  // como parte del número de al lado.
  return `${(t * 100).toFixed(1)} por ciento`;
}

function PantallaEvalsGrounding() {
  const inicial = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const rol = membresiaActiva?.rol ?? '';
  const puedeVer = (ROLES_INFORME_GROUNDING as readonly string[]).includes(rol);
  const [informe, setInforme] = useState<InformeDeGrounding | null>(inicial);
  const [corriendo, setCorriendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function correr() {
    if (!membresiaActiva) return;
    setCorriendo(true);
    setError(null);
    try {
      const r = await correrEvalDeGroundingDelWorkspace({
        data: { workspaceId: membresiaActiva.workspaceId },
      });
      if (r.ok) setInforme(r.informe);
      else setError(r.error);
    } catch {
      setError('No se pudo correr la eval; intenta de nuevo');
    } finally {
      setCorriendo(false);
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
            Grounding medido
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main
        style={{
          maxWidth: 980,
          margin: '0 auto',
          padding: '28px 24px 60px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Los tres vacíos son TRES mensajes distintos: sin workspace, sin permiso y sin
            sesión válida no se parecen en nada para quien mira, y un solo «no hay datos» los
            confundiría los tres. */}
        {!membresiaActiva && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}
        {membresiaActiva && !puedeVer && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              El informe de grounding lo consultan el admin del cliente y quienes llevan el
              workspace en la boutique. Tu rol ({ETIQUETA_ROL[rol] ?? rol}) participa en el
              método, no en la medición de la capa AI.
            </span>
          </Card>
        )}
        {membresiaActiva && puedeVer && !informe && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Tu sesión ya no tiene acceso a este workspace; vuelve a entrar.
            </span>
          </Card>
        )}

        {informe && puedeVer && (
          <>
            <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span style={{ font: '400 13px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
                Cuatro medidas sobre las propuestas ACEPTADAS, calculadas desde la base y sin
                llamar a ningún modelo: son deterministas, no cuestan nada por corrida y no son
                circulares —evaluar el grounding con el mismo componente que lo produce mide la
                coherencia del modelo consigo mismo, no si la cita sostiene—.
              </span>
              <span style={{ font: '400 13px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
                Cada corrida mide lo aceptado que se generó con SU versión de la capa AI, y ése
                es el filtro que hace comparables dos corridas. La primera después de un cambio
                de versión mide poco por construcción: el denominador lo dice.
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={micro}>Versión de la capa AI hoy</span>
                <Tag>{informe.promptVersionActual}</Tag>
                {informe.puedeCorrer && (
                  <Button size="sm" disabled={corriendo} onClick={() => void correr()}>
                    {corriendo ? 'Midiendo…' : 'Correr una eval ahora'}
                  </Button>
                )}
              </div>
              {!informe.puedeCorrer && (
                <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
                  Correr una eval escribe un hecho fechado en el workspace: lo hacen el lead de
                  la boutique y el diseñador. Lo que ves es lo que ellos midieron.
                </span>
              )}
              {error && (
                <span
                  role="alert"
                  style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}
                >
                  {error}
                </span>
              )}
            </Card>

            {!informe.ultima && (
              <Card style={{ padding: 24 }}>
                <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
                  Todavía no se ha corrido ninguna eval en este workspace. La primera no tendrá
                  contra qué compararse: la regresión aparece a partir de la segunda.
                </span>
              </Card>
            )}

            {informe.ultima && (
              <>
                <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <span style={micro}>Última corrida</span>
                    <span style={{ font: '400 13px var(--font-mono)', color: 'var(--text-body)' }}>
                      {informe.ultima.corridaEn.slice(0, 16)} · {informe.ultima.promptVersion}
                    </span>
                    <span style={micro}>Anterior</span>
                    <span style={{ font: '400 13px var(--font-mono)', color: 'var(--text-body)' }}>
                      {informe.anterior
                        ? `${informe.anterior.corridaEn.slice(0, 16)} · ${informe.anterior.promptVersion}`
                        : 'no hay'}
                    </span>
                  </div>
                  {informe.ultima.promptVersion !== informe.promptVersionActual && (
                    <span
                      role="alert"
                      style={{ font: '500 13px/1.55 var(--font-sans)', color: 'var(--warn)' }}
                    >
                      La última corrida midió la versión {informe.ultima.promptVersion} y hoy
                      corre la {informe.promptVersionActual}. Lo de abajo NO mide la capa que
                      está en producción: hace falta una corrida nueva.
                    </span>
                  )}
                  {informe.anterior &&
                    informe.anterior.promptVersion === informe.ultima.promptVersion && (
                      <span
                        style={{ font: '400 12.5px/1.55 var(--font-sans)', color: 'var(--text-muted)' }}
                      >
                        Las dos corridas midieron la misma versión de la capa AI, así que la
                        diferencia dice cuánto creció la muestra, no si la capa mejoró. La alarma
                        de §17 se lee comparando corridas de VERSIONES distintas.
                      </span>
                    )}
                </Card>

                {METRICAS_DE_GROUNDING.map((metrica) => (
                  <TablaDeMetrica
                    key={metrica}
                    metrica={metrica}
                    ultima={informe.ultima!}
                    anterior={informe.anterior}
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

function TablaDeMetrica({
  metrica,
  ultima,
  anterior,
}: {
  metrica: MetricaDeGrounding;
  ultima: CorridaDeGrounding;
  anterior: CorridaDeGrounding | null;
}) {
  const p = PRESENTACION[metrica];
  const filas = ultima.mediciones.filter((m) => m.metrica === metrica);
  // El agregado ARRIBA y las capacidades debajo: se lee primero el workspace y después dónde
  // se rompe. Y desagregado porque una media entre capacidades esconde justo lo que hay que
  // ver, que es una empeorando sola.
  const agregada = filas.find((m) => m.capacidad === CAPACIDAD_AGREGADA);
  const porCapacidad = filas.filter((m) => m.capacidad !== CAPACIDAD_AGREGADA);
  const antes = new Map(
    anterior?.mediciones.filter((m) => m.metrica === metrica).map((m) => [m.capacidad, m]) ?? [],
  );

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ font: '600 14px var(--font-sans)', color: 'var(--text-body)' }}>
          {p.titulo}
        </span>
        <span style={{ font: '400 12.5px/1.6 var(--font-sans)', color: 'var(--text-muted)' }}>
          {p.explica}
        </span>
      </div>
      {/* Ancho variable dentro de su propia caja: la tabla se desplaza sola en una pantalla
          estrecha en vez de arrastrar la página entera. */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
          <thead>
            <tr>
              <th scope="col" style={{ ...celda, ...micro }}>
                Capacidad
              </th>
              <th scope="col" style={{ ...cifra, ...micro }}>
                {p.numerador}
              </th>
              <th scope="col" style={{ ...cifra, ...micro }}>
                de
              </th>
              <th scope="col" style={{ ...cifra, ...micro }}>
                Tasa
              </th>
              <th scope="col" style={{ ...cifra, ...micro }}>
                vs. anterior
              </th>
              <th scope="col" style={{ ...cifra, ...micro }}>
                Sin veredicto
              </th>
            </tr>
          </thead>
          <tbody>
            {agregada && (
              <FilaDeMedicion
                m={agregada}
                previa={antes.get(agregada.capacidad) ?? null}
                subirEsBueno={p.subirEsBueno}
                destacada
              />
            )}
            {porCapacidad.map((m) => (
              <FilaDeMedicion
                key={m.capacidad}
                m={m}
                previa={antes.get(m.capacidad) ?? null}
                subirEsBueno={p.subirEsBueno}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function FilaDeMedicion({
  m,
  previa,
  subirEsBueno,
  destacada = false,
}: {
  m: MedicionDeGrounding;
  previa: MedicionDeGrounding | null;
  subirEsBueno: boolean;
  destacada?: boolean;
}) {
  /*
   * Las tres cifras en null son «esta métrica no tiene universo aquí», que NO es cero. Se dice
   * con palabras y no con un guion: un hueco mudo en una tabla de recuentos se lee como cero, y
   * un cero en «afirmaciones no soportadas» diría «medido y salió limpio».
   */
  const sinUniverso = m.numerador === null;
  const delta =
    m.tasa !== null && previa?.tasa != null && previa.tasa !== undefined
      ? m.tasa - previa.tasa
      : null;
  // El color lo decide la DIRECCIÓN que la métrica declara, no el signo. Un delta menor que la
  // resolución que se imprime se pinta neutro: teñir de rojo un cambio que la propia columna
  // muestra como «0.0 por ciento» sería una alarma que nadie puede ver de dónde sale.
  const relevante = delta !== null && Math.abs(delta) >= 0.0005;
  const mejora = relevante && delta !== null && delta > 0 === subirEsBueno;
  const color = !relevante ? 'var(--text-muted)' : mejora ? 'var(--ok)' : 'var(--danger)';

  const fondo = destacada ? 'var(--surface-sunken)' : undefined;
  return (
    <tr style={{ background: fondo }}>
      <th
        scope="row"
        style={{
          ...celda,
          fontWeight: destacada ? 600 : 400,
          fontFamily: 'var(--font-mono)',
        }}
      >
        {m.capacidad}
      </th>
      <td style={cifra}>{sinUniverso ? 'no aplica' : m.numerador}</td>
      <td style={cifra}>{sinUniverso ? '' : m.denominador}</td>
      <td style={cifra}>{sinUniverso ? '' : porcentaje(m.tasa)}</td>
      <td style={{ ...cifra, color }}>
        {delta === null
          ? sinUniverso
            ? ''
            : 'sin comparación'
          : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)} puntos`}
      </td>
      <td style={cifra}>{sinUniverso ? '' : m.sinVeredicto}</td>
    </tr>
  );
}
