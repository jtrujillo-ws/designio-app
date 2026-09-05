import { useState } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EnlaceA } from '@/components/ui/EnlaceA';
import { Tag } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import { Wordmark } from '@/components/ui/Wordmark';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import {
  destrazarInsight,
  dictarVeredictoDeOportunidad,
  insightsParaTrazar,
  portafolioDelEspacio,
  proponerOportunidad,
  repriorizarOportunidad,
  trazarInsight,
} from '@/lib/servicio/oportunidad.functions';
import { MAX_PREGUNTA, MAX_RAZON } from '@/lib/servicio/oportunidad.schemas';
import type { OportunidadDelPortafolio } from '@/lib/servicio/oportunidad.schemas';

/**
 * El portafolio de oportunidades (CTX-04, etapa 3): las HMW del reto con su traza a insights.
 *
 * La pantalla existe por SYS-21 antes que por comodidad: la generación asistida de HMW puede
 * pausarse por presupuesto, y cuando eso pasa el flujo tiene que seguir disponible a mano. Y
 * enseña la TRAZA al lado de cada pregunta, no detrás de un clic: una HMW sin insights es
 * una ocurrencia con formato de pregunta, y G3 rechaza el portafolio por eso.
 */
export const Route = createFileRoute('/_autenticada/oportunidades')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    if (!workspaceId) return null;
    const [portafolio, insights] = await Promise.all([
      portafolioDelEspacio({ data: { workspaceId } }),
      insightsParaTrazar({ data: { workspaceId } }),
    ]);
    return { workspaceId, retos: portafolio.retos, insights: insights.insights };
  },
  component: PantallaOportunidades,
});

const ETIQUETA: Record<OportunidadDelPortafolio['estado'], string> = {
  propuesta: 'Por decidir',
  aprobada: 'Aprobada',
  descartada: 'Descartada',
};

function PantallaOportunidades() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [retoAbierto, setRetoAbierto] = useState<string | null>(null);
  const [pregunta, setPregunta] = useState('');
  const [prioridad, setPrioridad] = useState('0');
  const [prioridadRazon, setPrioridadRazon] = useState('');
  const [insightElegido, setInsightElegido] = useState<Record<string, string>>({});
  const [razonDeDescarte, setRazonDeDescarte] = useState<Record<string, string>>({});
  /** El borrador de una repriorización: número y razón viajan juntos, y se suelta solo
   * cuando el servidor lo aceptó. */
  const [repriorizando, setRepriorizando] = useState<
    Record<string, { prioridad: string; razon: string } | undefined>
  >({});
  const rol = membresiaActiva?.rol ?? '';
  const puedeCurar = (ROLES_CURADORES as readonly string[]).includes(rol);

  async function ejecutar(accion: () => Promise<{ ok: boolean; error?: string }>, fallback: string) {
    setOcupado(true);
    setError(null);
    try {
      const r = await accion();
      if (r.ok) await router.invalidate();
      else setError(r.error ?? fallback);
      return r.ok;
    } catch {
      setError(fallback);
      return false;
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
            Oportunidades · HMW trazables a insights
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
        {datos?.retos.length === 0 && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Este workspace todavía no tiene retos: el portafolio de la etapa 3 cuelga de uno.
            </span>
          </Card>
        )}

        {datos?.retos.map((reto) => (
          <Card key={reto.retoId} style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
                {reto.codigo} · {reto.titulo}
              </span>
              {puedeCurar && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={ocupado}
                  onClick={() => {
                    setRetoAbierto(retoAbierto === reto.retoId ? null : reto.retoId);
                    setPregunta('');
                    setPrioridad('0');
                    setPrioridadRazon('');
                  }}
                >
                  {retoAbierto === reto.retoId ? 'Cancelar' : '+ Nueva HMW'}
                </Button>
              )}
            </div>

            {retoAbierto === reto.retoId && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* El MISMO techo que el validador: sin él, pegar una pregunta más larga
                    dejaba el botón activo y el rechazo llegaba como «vuelve a intentarlo»,
                    que no dice lo único que hay que saber — que se acorte. */}
                <Input
                  placeholder="¿Cómo podríamos…?"
                  maxLength={MAX_PREGUNTA}
                  value={pregunta}
                  onChange={(e) => setPregunta(e.currentTarget.value)}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Input
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    style={{ width: 110 }}
                    value={prioridad}
                    onChange={(e) => setPrioridad(e.currentTarget.value)}
                    aria-label="Prioridad"
                  />
                  <Textarea
                    placeholder="Por qué esa prioridad (contra qué criterio del reto)"
                    maxLength={MAX_RAZON}
                    value={prioridadRazon}
                    onChange={(e) => setPrioridadRazon(e.currentTarget.value)}
                    style={{ flex: 1, minHeight: 40 }}
                  />
                </div>
                <div>
                  <Button
                    size="sm"
                    disabled={ocupado || pregunta.trim() === ''}
                    onClick={async () => {
                      const ok = await ejecutar(
                        () =>
                          proponerOportunidad({
                            data: {
                              workspaceId: datos.workspaceId,
                              retoId: reto.retoId,
                              pregunta: pregunta.trim(),
                              prioridad: Math.min(1000, Math.max(0, Math.round(Number(prioridad) || 0))),
                              prioridadRazon: prioridadRazon.trim(),
                            },
                          }),
                        'No se pudo proponer la oportunidad; intenta de nuevo',
                      );
                      if (ok) setRetoAbierto(null);
                    }}
                  >
                    Proponer
                  </Button>
                </div>
              </div>
            )}

            {reto.oportunidades.length === 0 && (
              <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
                Sin portafolio todavía. G3 no exige que lo haya —eso lo pide el checklist de
                la etapa, si su perfil lo pide—; lo que exige es que toda HMW viva se apoye en
                al menos un insight.
              </span>
            )}

            {reto.oportunidades.map((o) => (
              <div
                key={o.id}
                style={{
                  borderTop: '1px solid var(--border)',
                  paddingTop: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <Tag>{ETIQUETA[o.estado]}</Tag>
                  <span style={{ font: '600 14px var(--font-sans)', color: 'var(--ink)', flex: 1 }}>
                    {o.pregunta}
                  </span>
                  <span style={{ font: '500 12px var(--font-mono)', color: 'var(--text-muted)' }}>
                    prioridad {o.prioridad}
                  </span>
                </div>
                {o.prioridadRazon !== '' && (
                  <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-body)' }}>
                    {o.prioridadRazon}
                  </span>
                )}
                {o.estado === 'descartada' && o.veredictoRazon !== '' && (
                  <span style={{ font: '400 13px var(--font-sans)', color: 'var(--text-muted)' }}>
                    Descartada porque: {o.veredictoRazon}
                  </span>
                )}

                {/* La traza, siempre visible: es lo que G3 mira y lo que separa una HMW de
                    una ocurrencia. Cuando está vacía se dice, no se deja en blanco. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <span style={{ font: '500 12px var(--font-sans)', color: 'var(--text-muted)' }}>
                    Se apoya en:
                  </span>
                  {o.insights.length === 0 && (
                    <span style={{ font: '500 12px var(--font-sans)', color: 'var(--danger)' }}>
                      ningún insight todavía (SYS-15: no se puede aprobar así)
                    </span>
                  )}
                  {o.insights.map((i) => (
                    <span key={i.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {/*
                        La traza se puede SEGUIR, que es la mitad de para qué existe. Quien
                        decide una oportunidad —o firma el G3 que la certifica— tiene que
                        poder abrir el insight y leer sus afirmaciones y sus citas; con el
                        título pintado como etiqueta muerta, la cadena
                        oportunidad → insight → evidencia se enseña y no se recorre, y lo que
                        queda es un nombre en el que hay que creer.

                        `EnlaceA` con el destino que `/insights` ya entiende (`?destacar=<id>`),
                        que es el mismo que usan la bandeja de aprobaciones y el buscador: un
                        `<Link>` escrito aquí a mano sería una tercera redacción de la misma
                        navegación.
                      */}
                      <EnlaceA
                        destino={{ to: '/insights', search: { destacar: i.id } }}
                        title={`Abrir el insight «${i.titulo}»`}
                        style={{ textDecoration: 'none' }}
                      >
                        <Tag>{i.titulo}</Tag>
                      </EnlaceA>
                      {puedeCurar && o.estado === 'propuesta' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={ocupado}
                          aria-label={`Quitar ${i.titulo}`}
                          onClick={() =>
                            ejecutar(
                              () =>
                                destrazarInsight({
                                  data: {
                                    workspaceId: datos.workspaceId,
                                    oportunidadId: o.id,
                                    insightId: i.id,
                                  },
                                }),
                              'No se pudo quitar el insight; intenta de nuevo',
                            )
                          }
                        >
                          ×
                        </Button>
                      )}
                    </span>
                  ))}
                </div>

                {puedeCurar && o.estado === 'propuesta' && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <Select
                      value={insightElegido[o.id] ?? ''}
                      onChange={(e) =>
                        setInsightElegido({ ...insightElegido, [o.id]: e.currentTarget.value })
                      }
                      aria-label="Insight a enlazar"
                    >
                      {/* Solo los VALIDADOS: la política de la base no admite otros, así que
                          ofrecer un propuesto sería ofrecer un botón que siempre falla. */}
                      <option value="">Enlazar un insight validado…</option>
                      {datos.insights.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.titulo}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      disabled={ocupado || !insightElegido[o.id]}
                      onClick={async () => {
                        const ok = await ejecutar(
                          () =>
                            trazarInsight({
                              data: {
                                workspaceId: datos.workspaceId,
                                oportunidadId: o.id,
                                insightId: insightElegido[o.id]!,
                              },
                            }),
                          'No se pudo enlazar el insight; intenta de nuevo',
                        );
                        if (ok) setInsightElegido({ ...insightElegido, [o.id]: '' });
                      }}
                    >
                      Enlazar
                    </Button>
                    {/*
                      La prioridad y SU RAZÓN se cambian juntas, y por eso van en un
                      formulario y no en un campo suelto que guarda al perder el foco.
                      Reordenar el portafolio conservando la explicación vieja deja una
                      prioridad razonada que ya no dice por qué: el número nuevo con el
                      argumento del anterior. La razón se precarga con la que hay —lo normal
                      es matizarla, no escribirla de cero— y se manda con el número.
                    */}
                    <Input
                      type="number"
                      min={0}
                      max={1000}
                      step={1}
                      style={{ width: 90 }}
                      value={repriorizando[o.id]?.prioridad ?? String(o.prioridad)}
                      aria-label={`Prioridad de ${o.pregunta}`}
                      onChange={(e) =>
                        setRepriorizando({
                          ...repriorizando,
                          [o.id]: {
                            prioridad: e.currentTarget.value,
                            razon: repriorizando[o.id]?.razon ?? o.prioridadRazon,
                          },
                        })
                      }
                    />
                    {repriorizando[o.id] && (
                      <>
                        <Input
                          placeholder="Por qué esa prioridad"
                          style={{ width: 220 }}
                          maxLength={MAX_RAZON}
                          value={repriorizando[o.id]!.razon}
                          aria-label={`Razón de la prioridad de ${o.pregunta}`}
                          onChange={(e) =>
                            setRepriorizando({
                              ...repriorizando,
                              [o.id]: {
                                prioridad: repriorizando[o.id]!.prioridad,
                                razon: e.currentTarget.value,
                              },
                            })
                          }
                        />
                        <Button
                          size="sm"
                          disabled={ocupado}
                          onClick={async () => {
                            // El campo VACÍO va primero, y esto es una corrección de la
                            // ronda anterior: `Number('')` no da `NaN` —da 0, que es
                            // finito—, así que borrar la prioridad y guardar mandaba un 0
                            // silencioso en vez de conservar la que había. La rama de
                            // reposición existía y no se llegaba a ella nunca por el caso
                            // que la motivó.
                            //
                            // Lo que sí da `NaN` es el resto de lo que un `type="number"`
                            // deja escribir sin ser número («e», «-», «1e»), y para eso
                            // sigue el `isFinite`. Las dos mitades reponen lo que había:
                            // dejar el campo mostrando algo que el servidor no aceptó es la
                            // mitad fea del mismo problema.
                            const texto = repriorizando[o.id]!.prioridad.trim();
                            const crudo = texto === '' ? Number.NaN : Number(texto);
                            const valor = Number.isFinite(crudo)
                              ? Math.min(1000, Math.max(0, Math.round(crudo)))
                              : o.prioridad;
                            const ok = await ejecutar(
                              () =>
                                repriorizarOportunidad({
                                  data: {
                                    workspaceId: datos.workspaceId,
                                    oportunidadId: o.id,
                                    prioridad: valor,
                                    prioridadRazon: repriorizando[o.id]!.razon.trim(),
                                  },
                                }),
                              'No se pudo repriorizar; intenta de nuevo',
                            );
                            // Solo se suelta el borrador si SE GUARDÓ. Si el servidor lo
                            // rechazó —la oportunidad se decidió, G3 se cerró— el campo tiene
                            // que seguir mostrando lo que el usuario escribió y no un número
                            // que la base no tiene: eso es lo que convierte un error visible
                            // en un dato inventado.
                            if (ok) setRepriorizando({ ...repriorizando, [o.id]: undefined });
                          }}
                        >
                          Guardar prioridad
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      disabled={ocupado || o.insights.length === 0}
                      onClick={() =>
                        ejecutar(
                          () =>
                            dictarVeredictoDeOportunidad({
                              data: {
                                workspaceId: datos.workspaceId,
                                oportunidadId: o.id,
                                estado: 'aprobada',
                                veredictoRazon: '',
                              },
                            }),
                          'No se pudo aprobar; intenta de nuevo',
                        )
                      }
                    >
                      Aprobar
                    </Button>
                    <Input
                      placeholder="Razón para descartar"
                      style={{ width: 220 }}
                      maxLength={MAX_RAZON}
                      value={razonDeDescarte[o.id] ?? ''}
                      onChange={(e) =>
                        setRazonDeDescarte({ ...razonDeDescarte, [o.id]: e.currentTarget.value })
                      }
                      aria-label={`Razón para descartar ${o.pregunta}`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      // Descartar SIN razón no se ofrece: lo que se tira de la etapa 3 es justo
                      // lo que alguien va a volver a proponer en la 4 si no consta por qué.
                      disabled={ocupado || (razonDeDescarte[o.id] ?? '').trim() === ''}
                      onClick={async () => {
                        const ok = await ejecutar(
                          () =>
                            dictarVeredictoDeOportunidad({
                              data: {
                                workspaceId: datos.workspaceId,
                                oportunidadId: o.id,
                                estado: 'descartada',
                                veredictoRazon: (razonDeDescarte[o.id] ?? '').trim(),
                              },
                            }),
                          'No se pudo descartar; intenta de nuevo',
                        );
                        if (ok) setRazonDeDescarte({ ...razonDeDescarte, [o.id]: '' });
                      }}
                    >
                      Descartar
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        ))}
      </main>
    </div>
  );
}
