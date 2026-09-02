import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import {
  aprobarDecision,
  definirArquetipo,
  enlazarEvidenciaArquetipo,
  reabrirEtapaDelProyecto,
  revalidarDecisionRevisada,
  veredictoDeArquetipo,
} from '@/lib/metodo/gobernanza.functions';
import {
  ETIQUETA_ALCANCE,
  ETIQUETA_TIPO_DECISION,
  TIPOS_DECISION,
  type GobernanzaDeProyecto,
  type TipoDecision,
} from '@/lib/metodo/gobernanza.schemas';
import type { ProyectoMetodo } from '@/lib/metodo/metodo.schemas';

/**
 * Gobernanza del proyecto (SPEC-04): decisiones con su cadena a insights, arquetipos
 * del reto con veredicto y evidencia, y reaperturas de etapa.
 *
 * Los controles se muestran solo a quien el servidor aceptaría: el lead opera el método
 * (decide y reabre) y los curadores definen arquetipos. Ver un tablero completo es de
 * todo miembro — es el punto del portal.
 */

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const COLOR_ARQUETIPO: Record<string, string> = {
  hipotesis: 'var(--warn)',
  confirmado: 'var(--accent)',
  refutado: 'var(--text-faint)',
};

export function SeccionGobernanza({
  workspaceId,
  proyecto,
  gobernanza,
  insightsValidados,
  hayMasInsights,
  evidencias,
  hayMasEvidencias,
  rol,
  onCambio,
  onError,
}: {
  workspaceId: string;
  proyecto: ProyectoMetodo;
  gobernanza: GobernanzaDeProyecto;
  insightsValidados: { id: string; titulo: string }[];
  hayMasInsights: boolean;
  evidencias: { id: string; titulo: string }[];
  hayMasEvidencias: boolean;
  rol: string;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const esLead = rol === 'lead-boutique';
  const esCurador = esLead || rol === 'disenador';

  return (
    <>
      <BloqueDecisiones
        workspaceId={workspaceId}
        proyecto={proyecto}
        decisiones={gobernanza.decisiones}
        insightsValidados={insightsValidados}
        hayMasInsights={hayMasInsights}
        esLead={esLead}
        onCambio={onCambio}
        onError={onError}
      />
      <BloqueArquetipos
        workspaceId={workspaceId}
        retoId={proyecto.reto.id}
        arquetipos={gobernanza.arquetipos}
        segmentos={gobernanza.segmentosDisponibles}
        evidencias={evidencias}
        hayMasEvidencias={hayMasEvidencias}
        esCurador={esCurador}
        onCambio={onCambio}
        onError={onError}
      />
      <BloqueReaperturas
        workspaceId={workspaceId}
        proyecto={proyecto}
        reaperturas={gobernanza.reaperturas}
        insightsValidados={insightsValidados}
        hayMasInsights={hayMasInsights}
        esLead={esLead}
        onCambio={onCambio}
        onError={onError}
      />
    </>
  );
}

function BloqueDecisiones({
  workspaceId,
  proyecto,
  decisiones,
  insightsValidados,
  hayMasInsights,
  esLead,
  onCambio,
  onError,
}: {
  workspaceId: string;
  proyecto: ProyectoMetodo;
  decisiones: GobernanzaDeProyecto['decisiones'];
  insightsValidados: { id: string; titulo: string }[];
  hayMasInsights: boolean;
  esLead: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [gateId, setGateId] = useState('');
  const [tipo, setTipo] = useState<TipoDecision>('pasa-muere');
  const [titulo, setTitulo] = useState('');
  const [fundamento, setFundamento] = useState('');
  const [insightIds, setInsightIds] = useState<string[]>([]);
  const [ocupado, setOcupado] = useState(false);

  async function registrar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await aprobarDecision({
        data: { workspaceId, gateId, tipo, titulo, fundamento, insightIds },
      });
      if (r.ok) {
        setAbierto(false);
        setTitulo('');
        setFundamento('');
        setInsightIds([]);
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo registrar la decisión; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  async function revalidar(decisionId: string) {
    setOcupado(true);
    onError(null);
    try {
      const r = await revalidarDecisionRevisada({ data: { workspaceId, decisionId } });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo revalidar la decisión; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ font: '700 14.5px var(--font-sans)', color: 'var(--ink)', flex: 1 }}>
          Decisiones del proyecto
        </span>
        <span style={micro}>{decisiones.length} registradas</span>
      </div>
      <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
        Toda decisión cita el gate en que se tomó y los insights que la sostienen (RF-04.10).
      </span>

      {decisiones.length === 0 && (
        <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
          Sin decisiones registradas todavía.
        </span>
      )}
      {decisiones.map((d) => (
        <div
          key={d.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '10px 12px',
            background: 'var(--surface-sunken)',
            borderRadius: 'var(--r-sm)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Tag>G{d.gateNumero}</Tag>
            <span style={{ font: '600 13px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 180 }}>
              {d.titulo}
            </span>
            <span style={micro}>{ETIQUETA_TIPO_DECISION[d.tipo]}</span>
            {d.estado === 'en-revision' && (
              <span style={{ font: '600 11.5px var(--font-sans)', color: 'var(--warn)' }}>
                en revisión
              </span>
            )}
          </div>
          {d.fundamento && (
            <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
              {d.fundamento}
            </span>
          )}
          <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
            Sostenida por: {d.insights.map((i) => i.titulo).join(' · ') || '—'} · {d.decididoEn}
          </span>
          {esLead && d.estado === 'en-revision' && (
            <div>
              <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => void revalidar(d.id)}>
                Sigue en pie tras la reapertura
              </Button>
            </div>
          )}
        </div>
      ))}

      {esLead && !abierto && insightsValidados.length > 0 && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setAbierto(true)}>
            Registrar decisión
          </Button>
        </div>
      )}
      {esLead && !abierto && insightsValidados.length === 0 && (
        <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--warn)' }}>
          Sin insights validados no hay decisión trazable: valida primero un insight.
        </span>
      )}
      {abierto && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Select value={gateId} onChange={(e) => setGateId(e.target.value)}>
            <option value="">Gate en que se toma…</option>
            {proyecto.gates.map((g) => (
              <option key={g.id} value={g.id}>
                G{g.numero}
              </option>
            ))}
          </Select>
          <Select value={tipo} onChange={(e) => setTipo(e.target.value as TipoDecision)}>
            {TIPOS_DECISION.map((t) => (
              <option key={t} value={t}>
                {ETIQUETA_TIPO_DECISION[t]}
              </option>
            ))}
          </Select>
          <Input
            placeholder="Qué se decidió"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
          />
          <Input
            placeholder="Fundamento (opcional)"
            value={fundamento}
            onChange={(e) => setFundamento(e.target.value)}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={micro}>Insights que la sostienen (al menos uno)</span>
            {hayMasInsights && (
              <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--warn)' }}>
                Solo se listan los 200 validados más recientes: si el que sostiene esta
                decisión no aparece, búscalo en Insights y valídalo o vuelve a citarlo.
              </span>
            )}
            {insightsValidados.map((i) => (
              <label
                key={i.id}
                style={{ display: 'flex', gap: 8, alignItems: 'center', font: '400 12.5px var(--font-sans)' }}
              >
                <input
                  type="checkbox"
                  checked={insightIds.includes(i.id)}
                  onChange={(e) =>
                    setInsightIds((prev) =>
                      e.target.checked ? [...prev, i.id] : prev.filter((x) => x !== i.id),
                    )
                  }
                />
                {i.titulo}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              size="sm"
              disabled={ocupado || gateId === '' || titulo.trim() === '' || insightIds.length === 0}
              onClick={() => void registrar()}
            >
              Registrar
            </Button>
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setAbierto(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function BloqueArquetipos({
  workspaceId,
  retoId,
  arquetipos,
  segmentos,
  evidencias,
  hayMasEvidencias,
  esCurador,
  onCambio,
  onError,
}: {
  workspaceId: string;
  retoId: string;
  arquetipos: GobernanzaDeProyecto['arquetipos'];
  segmentos: { id: string; nombre: string }[];
  evidencias: { id: string; titulo: string }[];
  hayMasEvidencias: boolean;
  esCurador: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState('');
  const [definicion, setDefinicion] = useState('');
  const [segmentoIds, setSegmentoIds] = useState<string[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [veredictoDe, setVeredictoDe] = useState<string | null>(null);
  const [razon, setRazon] = useState('');
  const [apoyoDe, setApoyoDe] = useState<string | null>(null);
  const [evidenciaId, setEvidenciaId] = useState('');

  async function crear() {
    setOcupado(true);
    onError(null);
    try {
      const r = await definirArquetipo({
        data: { workspaceId, retoId, nombre, definicion, segmentoIds },
      });
      if (r.ok) {
        setAbierto(false);
        setNombre('');
        setDefinicion('');
        setSegmentoIds([]);
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo definir el arquetipo; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  async function apoyar(arquetipoId: string) {
    setOcupado(true);
    onError(null);
    try {
      const r = await enlazarEvidenciaArquetipo({ data: { workspaceId, arquetipoId, evidenciaId } });
      if (r.ok) {
        setApoyoDe(null);
        setEvidenciaId('');
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo enlazar la evidencia; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  async function darVeredicto(arquetipoId: string, estado: 'confirmado' | 'refutado') {
    setOcupado(true);
    onError(null);
    try {
      const r = await veredictoDeArquetipo({ data: { workspaceId, arquetipoId, estado, razon } });
      if (r.ok) {
        setVeredictoDe(null);
        setRazon('');
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo registrar el veredicto; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  const hipotesis = arquetipos.filter((a) => a.estado === 'hipotesis').length;

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ font: '700 14.5px var(--font-sans)', color: 'var(--ink)', flex: 1 }}>
          Arquetipos del reto
        </span>
        <span style={micro}>
          {hipotesis > 0 ? `${hipotesis} sin veredicto` : 'todos resueltos'}
        </span>
      </div>
      <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
        Nacen como hipótesis; confirmar exige evidencia enlazada. G2 no aprueba con
        hipótesis pendientes (RF-04.11).
      </span>

      {arquetipos.map((a) => (
        <div
          key={a.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '10px 12px',
            background: 'var(--surface-sunken)',
            borderRadius: 'var(--r-sm)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ font: '600 13px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 160 }}>
              {a.nombre}
            </span>
            <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ARQUETIPO[a.estado] }}>
              {a.estado}
            </span>
          </div>
          {a.definicion && (
            <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
              {a.definicion}
            </span>
          )}
          <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
            Segmentos: {a.segmentos.map((s) => s.nombre).join(', ') || '—'} · Evidencia:{' '}
            {a.evidencias.length > 0 ? a.evidencias.map((e) => e.titulo).join(', ') : 'sin enlazar'}
          </span>
          {a.veredictoRazon && (
            <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
              {a.veredictoRazon}
            </span>
          )}
          {esCurador && a.estado === 'hipotesis' && apoyoDe !== a.id && veredictoDe !== a.id && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button size="sm" variant="secondary" disabled={ocupado} onClick={() => setApoyoDe(a.id)}>
                Enlazar evidencia
              </Button>
              <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setVeredictoDe(a.id)}>
                Dar veredicto
              </Button>
            </div>
          )}
          {apoyoDe === a.id && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Select value={evidenciaId} onChange={(e) => setEvidenciaId(e.target.value)} style={{ minWidth: 240 }}>
                <option value="">Evidencia que lo sostiene…</option>
                {evidencias.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.titulo}
                  </option>
                ))}
                {/* Confirmar un arquetipo EXIGE evidencia enlazada: si la lista viene
                    recortada y la que hace falta no está, el usuario tiene que saber
                    que le faltan opciones y no que le falta evidencia. */}
                {hayMasEvidencias && (
                  <option value="" disabled>
                    … hay más evidencias (solo se listan las 200 más recientes)
                  </option>
                )}
              </Select>
              <Button size="sm" disabled={ocupado || evidenciaId === ''} onClick={() => void apoyar(a.id)}>
                Enlazar
              </Button>
              <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setApoyoDe(null)}>
                Cancelar
              </Button>
            </div>
          )}
          {veredictoDe === a.id && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Input
                placeholder="Razón del veredicto (obligatoria)"
                value={razon}
                onChange={(e) => setRazon(e.target.value)}
                style={{ minWidth: 240 }}
              />
              <Button
                size="sm"
                disabled={ocupado || razon.trim() === ''}
                onClick={() => void darVeredicto(a.id, 'confirmado')}
              >
                Confirmar
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={ocupado || razon.trim() === ''}
                onClick={() => void darVeredicto(a.id, 'refutado')}
              >
                Refutar
              </Button>
              <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setVeredictoDe(null)}>
                Cancelar
              </Button>
            </div>
          )}
        </div>
      ))}

      {esCurador && !abierto && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setAbierto(true)}>
            Definir arquetipo
          </Button>
        </div>
      )}
      {abierto && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input placeholder="Nombre del arquetipo" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          <Input
            placeholder="Definición (conducta y actitud observadas)"
            value={definicion}
            onChange={(e) => setDefinicion(e.target.value)}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={micro}>Segmentos que cubre</span>
            {segmentos.map((s) => (
              <label
                key={s.id}
                style={{ display: 'flex', gap: 8, alignItems: 'center', font: '400 12.5px var(--font-sans)' }}
              >
                <input
                  type="checkbox"
                  checked={segmentoIds.includes(s.id)}
                  onChange={(e) =>
                    setSegmentoIds((prev) =>
                      e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                    )
                  }
                />
                {s.nombre}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" disabled={ocupado || nombre.trim() === ''} onClick={() => void crear()}>
              Definir
            </Button>
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setAbierto(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function BloqueReaperturas({
  workspaceId,
  proyecto,
  reaperturas,
  insightsValidados,
  hayMasInsights,
  esLead,
  onCambio,
  onError,
}: {
  workspaceId: string;
  proyecto: ProyectoMetodo;
  reaperturas: GobernanzaDeProyecto['reaperturas'];
  insightsValidados: { id: string; titulo: string }[];
  hayMasInsights: boolean;
  esLead: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [etapaNumero, setEtapaNumero] = useState(0);
  const [motivo, setMotivo] = useState('');
  const [declarados, setDeclarados] = useState<string[]>([]);
  const [ocupado, setOcupado] = useState(false);

  async function reabrir() {
    setOcupado(true);
    onError(null);
    try {
      const r = await reabrirEtapaDelProyecto({
        data: {
          workspaceId,
          proyectoId: proyecto.id,
          etapaNumero,
          motivo,
          insightIds: declarados,
        },
      });
      if (r.ok) {
        setAbierto(false);
        setMotivo('');
        setDeclarados([]);
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo reabrir la etapa; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={{ font: '700 14.5px var(--font-sans)', color: 'var(--ink)' }}>
        Reaperturas de etapa
      </span>
      <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-muted)' }}>
        Reabrir no borra la aprobación del gate — es historia con firma y fecha. Marca para
        revisión las decisiones AFECTADAS (RF-04.9, SYS-10): si declaras qué insights
        cambiaron, solo se marcan las que se apoyan en ellos; si no declaras ninguno, se
        marca la etapa entera hacia adelante y así queda registrado.
      </span>

      {reaperturas.length === 0 && (
        <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
          Ninguna etapa se ha reabierto.
        </span>
      )}
      {reaperturas.map((r) => (
        <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ font: '600 12.5px var(--font-sans)', color: 'var(--ink)' }}>
            Etapa {r.etapaNumero} · {r.reabiertoEn} · {r.decisionesMarcadas} decisiones marcadas
            {' · '}
            {ETIQUETA_ALCANCE[r.alcance]}
          </span>
          <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
            {r.motivo}
          </span>
          {r.insights.length > 0 && (
            <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
              Cambió: {r.insights.map((i) => i.titulo).join(', ')}
            </span>
          )}
        </div>
      ))}

      {esLead && !abierto && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setAbierto(true)}>
            Reabrir una etapa
          </Button>
        </div>
      )}
      {abierto && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Select value={String(etapaNumero)} onChange={(e) => setEtapaNumero(Number(e.target.value))}>
            {proyecto.etapas.map((e) => (
              <option key={e.id} value={e.numero}>
                {e.numero} · {e.nombre}
              </option>
            ))}
          </Select>
          <Input
            placeholder="Motivo de la reapertura (obligatorio)"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
          {insightsValidados.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
                Qué insights cambiaron (opcional; acota qué decisiones entran en revisión)
              </span>
              {hayMasInsights && (
                <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--warn)' }}>
                  Solo se listan los 200 validados más recientes: si el que cambió no está
                  aquí, la reapertura marcará la etapa completa en vez de acotarla.
                </span>
              )}
              {insightsValidados.map((i) => (
                <label
                  key={i.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    font: '400 12.5px var(--font-sans)',
                    color: 'var(--text-body)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={declarados.includes(i.id)}
                    onChange={(e) =>
                      setDeclarados((previos) =>
                        e.target.checked
                          ? [...previos, i.id]
                          : previos.filter((id) => id !== i.id),
                      )
                    }
                  />
                  {i.titulo}
                </label>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" disabled={ocupado || motivo.trim() === ''} onClick={() => void reabrir()}>
              Reabrir
            </Button>
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setAbierto(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
