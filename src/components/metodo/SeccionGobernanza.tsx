import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import {
  etiquetaObjetoBloqueado,
  type EvidenciaCitable,
} from '@/lib/evidencia/evidencia.schemas';
import {
  aprobarDecision,
  definirArquetipo,
  enlazarEvidenciaArquetipo,
  borrarRevisionSimuladaAMano,
  escribirRevisionSimuladaAMano,
  reabrirEtapaDelProyecto,
  revalidarDecisionRevisada,
  veredictoDeArquetipo,
} from '@/lib/metodo/gobernanza.functions';
import {
  MAX_CITAS_POR_HALLAZGO,
  MAX_HALLAZGOS_POR_REVISION,
  MAX_PREGUNTAS_POR_REVISION,
} from '@/lib/ai/ai.schemas';
import type { RevisionSimuladaDeConcepto } from '@/lib/metodo/gobernanza.schemas';
import {
  COLOR_ARQUETIPO,
  ETIQUETA_ALCANCE,
  ETIQUETA_ESTADO_ARQUETIPO,
  ETIQUETA_ESTADO_CONCEPTO,
  ETIQUETA_TIPO_DECISION,
  TIPOS_DECISION,
  type ArquetipoDeReto,
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
  /** Con su `citable` y su motivo: enlazar evidencia a un arquetipo es respaldo
   * probatorio —confirmar exige enlace, y G2 no pasa con arquetipos sin confirmar— y
   * además su título se publica en el tablero de gobernanza, que lee todo el workspace.
   * El prop no puede estrechar el tipo o el bloqueo se pierde por el camino. */
  evidencias: EvidenciaCitable[];
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
        conceptos={gobernanza.conceptos}
        esLead={esLead}
        onCambio={onCambio}
        onError={onError}
      />
      {/*
        * Las revisiones simuladas ACEPTADAS, fuera del formulario del pasa/muere.
        *
        * Estaban dentro, y dentro no las lee nadie a tiempo: el formulario solo se abre desde
        * un control que se pinta para el lead, así que quien no es lead no las veía nunca, y el
        * lead las veía sólo mientras registraba la decisión — después de los tests que esas
        * preguntas existen para guiar. Lo que una simulación le entrega a la etapa 4 son
        * justamente sus preguntas (RF-08.2): tienen que estar donde el equipo prepara el test,
        * no detrás del acto de decidir.
        *
        * Sin puerta de rol PARA LEER: leer no es decidir. Escribir el pasa/muere sigue siendo
        * del lead, y ESCRIBIR O BORRAR una revisión a mano es de los curadores — que es lo que
        * la base exige y lo que este bloque tiene que dejar de ofrecer a quien no lo es.
        */}
      <BloqueRevisionesSimuladas
        workspaceId={workspaceId}
        conceptos={gobernanza.conceptos}
        arquetipos={gobernanza.arquetipos}
        esCurador={esCurador}
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
  conceptos,
  esLead,
  onCambio,
  onError,
}: {
  workspaceId: string;
  proyecto: ProyectoMetodo;
  decisiones: GobernanzaDeProyecto['decisiones'];
  insightsValidados: { id: string; titulo: string }[];
  hayMasInsights: boolean;
  conceptos: GobernanzaDeProyecto['conceptos'];
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
  /* Vacío = «ninguno elegido». Solo viaja cuando el tipo lo pide, que es lo que el contrato
   * exige en los dos sentidos: un pasa/muere decide un concepto, y solo él lo decide. */
  const [conceptoId, setConceptoId] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function registrar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await aprobarDecision({
        data: {
          workspaceId,
          gateId,
          tipo,
          titulo,
          fundamento,
          insightIds,
          /* `undefined` y no `''`: el esquema espera un uuid o la ausencia, y una cadena vacía
           * sería un tercer valor que ninguno de los dos lados sabe leer. */
          ...(tipo === 'pasa-muere' && conceptoId ? { conceptoId } : {}),
        },
      });
      if (r.ok) {
        setAbierto(false);
        setTitulo('');
        setFundamento('');
        setInsightIds([]);
        setConceptoId('');
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
          {/* El respaldo se cae por detrás sin que la decisión cambie de estado: los
              derechos de la evidencia citada se revocan y caducan por su cuenta. El guard
              de suficiencia lo comprueba al aprobar el gate, así que aquí se dice antes —y
              se nombra la afirmación exacta, que es lo que hay que reparar. */}
          {d.sinRespaldo && (
            <span style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
              No se puede citar: {d.sinRespaldo}
            </span>
          )}
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
          {tipo === 'pasa-muere' && (
            <Select value={conceptoId} onChange={(e) => setConceptoId(e.target.value)}>
              <option value="">Concepto que se decide…</option>
              {conceptos.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.titulo}
                  {c.estado === 'candidato' ? '' : ` · ${ETIQUETA_ESTADO_CONCEPTO[c.estado]}`}
                </option>
              ))}
            </Select>
          )}
          {/*
            Aquí NO van las revisiones simuladas, y su ausencia es la mitad que faltaba del
            arreglo que las sacó fuera. `BloqueRevisionesSimuladas` ya las pinta —todas, sin
            puerta de rol, arriba en la sección—, así que repetirlas aquí no añade nada: alarga
            el formulario con las sesiones, sus hallazgos, sus citas y sus preguntas, y empuja
            hacia abajo los campos con los que de verdad se registra la decisión.
          */}
          {tipo === 'pasa-muere' && conceptos.length === 0 && (
            <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--warn)' }}>
              Este reto no tiene conceptos todavía: un pasa/muere decide SOBRE uno (RF-04.10).
              Créalos en la etapa 4 antes de registrar la decisión.
            </span>
          )}
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
  /** Con su `citable` y su motivo: enlazar evidencia a un arquetipo es respaldo
   * probatorio —confirmar exige enlace, y G2 no pasa con arquetipos sin confirmar— y
   * además su título se publica en el tablero de gobernanza, que lee todo el workspace.
   * El prop no puede estrechar el tipo o el bloqueo se pierde por el camino. */
  evidencias: EvidenciaCitable[];
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
              {ETIQUETA_ESTADO_ARQUETIPO[a.estado]}
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
                {/* Sin derechos vigentes para «cliente» no se enlaza: el guard de la base
                    lo impide, y aquí se dice por qué antes de elegir (SYS-14). */}
                {evidencias.map((e) => (
                  <option key={e.id} value={e.id} disabled={!e.citable}>
                    {e.citable ? e.titulo : etiquetaObjetoBloqueado(e.titulo, e.motivoBloqueo)}
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

      {/* SYS-08: un proyecto CERRADO es inmutable, así que reabrir una etapa suya lo rechazan
          la política `reapertura_insert` y su guard. Ofrecer el control ahí era prometer una
          escritura que la base ya negó — la misma clase que el botón de firmar y el de
          aprobar el gate. Lo que falta se dice, no se deja descubrir por un error. */}
      {esLead && proyecto.estado === 'cerrado' && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          El proyecto está cerrado: reabrir una etapa no revive lo que ya es historia
          (SYS-08). Lo posterior al cierre es un reto nuevo.
        </span>
      )}
      {esLead && proyecto.estado !== 'cerrado' && !abierto && (
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

/**
 * Lo que las revisiones simuladas ya aceptadas dijeron sobre este concepto.
 *
 * Se pinta junto al selector del pasa/muere porque es ahí donde sirve: quien decide si el
 * concepto pasa o muere es quien tiene que haber leído lo que las lentes vieron y, sobre todo,
 * QUÉ IR A PROBAR — las preguntas de test son lo único que una simulación le entrega a la
 * etapa 4 (RF-08.2). Antes de esto la sesión se guardaba y desaparecía: el panel de propuestas
 * solo pinta lo pendiente.
 *
 * La etiqueta de SIMULACIÓN va arriba y en cada hallazgo que sea hipótesis, no como adorno:
 * SYS-20 pide que esto no se pueda confundir con investigación, y donde se LEE es donde esa
 * confusión ocurriría.
 */
function BloqueRevisionesSimuladas({
  workspaceId,
  conceptos,
  arquetipos,
  esCurador,
  onCambio,
  onError,
}: {
  workspaceId: string;
  conceptos: GobernanzaDeProyecto['conceptos'];
  arquetipos: ArquetipoDeReto[];
  esCurador: boolean;
  onCambio: () => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const [borrando, setBorrando] = useState('');
  const conRevisiones = conceptos.filter((c) => c.revisiones.length > 0);

  async function borrar(revisionId: string) {
    setBorrando(revisionId);
    onError(null);
    try {
      const r = await borrarRevisionSimuladaAMano({ data: { workspaceId, revisionId } });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo borrar la revisión; intenta de nuevo');
    } finally {
      setBorrando('');
    }
  }
  /*
   * Y ya NO se esconde cuando no hay ninguna: sin revisiones es justo cuando hace falta poder
   * escribir la primera. Lo que decide si hay algo que enseñar es si hay conceptos, no si la AI
   * ya produjo algo — que es la diferencia entre un lector y una capacidad.
   *
   * Pero eso vale para quien PUEDE escribirla. A quien no es curador, un bloque sin revisiones
   * es una tarjeta con un título y nada debajo, así que para él la puerta vuelve a ser si hay
   * algo escrito.
   */
  if (conceptos.length === 0) return null;
  if (conRevisiones.length === 0 && !esCurador) return null;
  return (
    <Card>
      <h3 style={{ font: '600 13px var(--font-sans)', margin: 0 }}>
        Revisiones simuladas de los conceptos
      </h3>
      <p style={{ font: '400 11.5px var(--font-sans)', color: 'var(--text-faint)', margin: 0 }}>
        No son evidencia y no cuentan en G4/G5 (SYS-20). Lo que sí entregan es qué ir a probar
        con personas reales.
      </p>
      {conRevisiones.map((c) => (
        <div key={c.id} style={{ display: 'grid', gap: 6 }}>
          <span style={{ font: '600 12.5px var(--font-sans)' }}>
            {c.titulo}
            {c.estado === 'candidato' ? '' : ` · ${ETIQUETA_ESTADO_CONCEPTO[c.estado]}`}
          </span>
          <RevisionesDelConcepto revisiones={c.revisiones} />
          {/*
            BORRAR Y REESCRIBIR, que es la única corrección que este diseño admite: las hojas de
            una revisión no se editan —no hay UPDATE concedido— así que una errata o una pregunta
            que sobra se arreglan rehaciéndola. Sin este control, la primera revisión escrita a
            mano era irreversible desde la aplicación, y la clave única por lente impedía además
            escribir la sustituta.

            Sólo mientras el concepto es CANDIDATO: firmado el pasa/muere, lo que se leyó para
            decidir se queda. Y sólo para un CURADOR, que es a quien la política concede el
            borrado — y la de escritura, igual. La base exige las dos cosas; esto es no ofrecer
            lo que va a fallar. Leer sigue siendo de todo el equipo: el bloque entero está fuera
            del formulario del pasa/muere justo por eso.
          */}
          {esCurador && c.estado === 'candidato' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {c.revisiones.map((r) => (
                <Button
                  key={r.id}
                  variant="secondary"
                  disabled={borrando !== ''}
                  onClick={() => void borrar(r.id)}
                >
                  Borrar la de «{r.arquetipoNombre}» y reescribirla
                </Button>
              ))}
            </div>
          )}
        </div>
      ))}
      {esCurador && (
        <FormularioRevisionAMano
          workspaceId={workspaceId}
          conceptos={conceptos}
          arquetipos={arquetipos}
          onCambio={onCambio}
          onError={onError}
        />
      )}
    </Card>
  );
}

/*
 * Las tres listas que una revisión tiene, con la forma que el contrato les da. El formulario
 * escribía UNA de cada —un hallazgo, una cita, una pregunta— y eso no era un recorte de la
 * pantalla sino un techo del producto: la clave única `(concepto_id, arquetipo_id)` deja una
 * sola revisión por lente y no hay ninguna ruta para añadirle hojas después, así que lo que no
 * cabía en el envío no cabía nunca. La única salida era borrarla y reescribirla, con el mismo
 * formulario de una, o —peor— marcar como hipótesis un hallazgo observado para que la cita
 * sobrante no estorbara. Los topes salen de donde los lee también el contrato.
 */
type CitaAMano = { evidenciaId: string; fragmento: string; localizacion: string };
type HallazgoAMano = {
  titulo: string;
  descripcion: string;
  esHipotesis: boolean;
  citas: CitaAMano[];
};
type PreguntaAMano = { pregunta: string; escenario: string; hallazgoIndice: number | null };

const CITA_VACIA: CitaAMano = { evidenciaId: '', fragmento: '', localizacion: '' };
const HALLAZGO_VACIO: HallazgoAMano = {
  titulo: '',
  descripcion: '',
  esHipotesis: false,
  citas: [CITA_VACIA],
};
const PREGUNTA_VACIA: PreguntaAMano = { pregunta: '', escenario: '', hallazgoIndice: null };

/*
 * Una fila de cita está VACÍA (no se manda) o COMPLETA (se manda entera). A medias no: el
 * contrato pide fragmento Y localización con al menos un carácter, y la tabla los pide `not
 * null` y no en blanco. Sin esto, la localización se quedaba fuera de la puerta del botón y el
 * envío moría en la frontera con todo lo escrito por delante.
 */
const citaVacia = (c: CitaAMano) =>
  c.evidenciaId === '' && c.fragmento.trim() === '' && c.localizacion.trim() === '';
const citaCompleta = (c: CitaAMano) =>
  c.evidenciaId !== '' && c.fragmento.trim() !== '' && c.localizacion.trim() !== '';

/**
 * ESCRIBIR UNA REVISIÓN A MANO — la paridad que SYS-21 exige (RF-08.6).
 *
 * «Caída del proveedor AI ⇒ los flujos manuales equivalentes están siempre presentes.» Las
 * concesiones y las políticas de la base estaban puestas para esto desde el principio —una
 * revisión escrita a mano lleva el sello de procedencia en null para siempre— pero no había
 * por dónde ejercerlas: las tablas de C4 sólo las escribía la aceptación de una propuesta.
 *
 * El formulario pide lo mismo que el contrato exige al modelo, ni más ni menos, porque es EL
 * MISMO esquema el que valida las dos: al menos un hallazgo y una pregunta; un hallazgo que no
 * se marca como hipótesis cita al menos un documento; y las citas sólo de la evidencia de su
 * lente. «Ni menos» incluye la CANTIDAD: hasta seis hallazgos, cuatro citas por hallazgo y seis
 * preguntas, que es lo que el contrato admite. Lo que la base rechace vuelve como mensaje, no
 * como pantalla rota.
 */
function FormularioRevisionAMano({
  workspaceId,
  conceptos,
  arquetipos,
  onCambio,
  onError,
}: {
  workspaceId: string;
  conceptos: GobernanzaDeProyecto['conceptos'];
  arquetipos: ArquetipoDeReto[];
  onCambio: () => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [conceptoId, setConceptoId] = useState('');
  const [arquetipoId, setArquetipoId] = useState('');
  const [sintesis, setSintesis] = useState('');
  const [hallazgos, setHallazgos] = useState<HallazgoAMano[]>([HALLAZGO_VACIO]);
  const [preguntas, setPreguntas] = useState<PreguntaAMano[]>([PREGUNTA_VACIA]);

  const parchearHallazgo = (i: number, patch: Partial<HallazgoAMano>) =>
    setHallazgos((xs) => xs.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const parchearCita = (i: number, k: number, patch: Partial<CitaAMano>) =>
    setHallazgos((xs) =>
      xs.map((h, j) =>
        j === i ? { ...h, citas: h.citas.map((c, l) => (l === k ? { ...c, ...patch } : c)) } : h,
      ),
    );
  const parchearPregunta = (i: number, patch: Partial<PreguntaAMano>) =>
    setPreguntas((xs) => xs.map((q, j) => (j === i ? { ...q, ...patch } : q)));

  /*
   * Marcar hipótesis BORRA las citas del hallazgo. Los campos se ocultaban, pero lo que ya
   * estaba seleccionado seguía en el estado y se mandaba igual: un hallazgo que se presenta a
   * la vez como extrapolación sin sostén y como lectura de un testimonio observado, que es lo
   * que las dos clases de RF-08.2 excluyen.
   */
  const marcarHipotesis = (i: number, v: boolean) =>
    parchearHallazgo(i, { esHipotesis: v, citas: v ? [] : [CITA_VACIA] });

  /*
   * Y quitar un hallazgo REENUMERA las preguntas que lo nombran. El índice apunta por posición
   * —los hallazgos todavía no son filas cuando esto se escribe—, así que borrar el primero
   * dejaría a su pregunta colgando del segundo, y a la última apuntando fuera de rango: lo
   * primero es una traza falsa que nadie ve, y lo segundo lo para el contrato con todo escrito.
   */
  const quitarHallazgo = (i: number) => {
    setHallazgos((xs) => xs.filter((_, j) => j !== i));
    setPreguntas((qs) =>
      qs.map((q) =>
        q.hallazgoIndice === null || q.hallazgoIndice < i
          ? q
          : { ...q, hallazgoIndice: q.hallazgoIndice === i ? null : q.hallazgoIndice - 1 },
      ),
    );
  };

  const limpiar = () => {
    setSintesis('');
    setHallazgos([HALLAZGO_VACIO]);
    setPreguntas([PREGUNTA_VACIA]);
  };

  // Sólo los conceptos que todavía admiten revisión, y sólo las lentes que pueden mirar: un
  // arquetipo REFUTADO no describe a nadie (SPEC-04.11) y la base lo rechaza igualmente.
  const candidatos = conceptos.filter((c) => c.estado === 'candidato');
  const lentes = arquetipos.filter((a) => a.estado !== 'refutado');
  /*
   * Lo citable sale de LA LENTE y no del selector general del workspace. Aquél se corta en las
   * 200 más recientes, así que una lente sostenida por documentos más antiguos dejaba la lista
   * vacía y el único camino aparente era marcar el hallazgo como hipótesis — mentir sobre su
   * clase para poder guardar. La proyección de la lente trae su evidencia entera y con su
   * permiso ya resuelto.
   */
  const citables = (lentes.find((a) => a.id === arquetipoId)?.evidencias ?? []).filter(
    (e) => e.citable,
  );

  /*
   * Cambiar de LENTE o de CONCEPTO reinicia la revisión entera, no sólo sus citas.
   *
   * Una revisión es lo que UNA lente ve en UN concepto: la lectura de conjunto, los hallazgos y
   * qué hay que ir a preguntar son de ese par y de ningún otro. Vaciar sólo las citas dejaba lo
   * escrito para uno guardado como lectura del otro —y una revisión de puras hipótesis, que no
   * lleva citas, se podía mandar tal cual—: la falsa atribución que el guard de corrección
   * impide en la ruta AI cuando el `arquetipoId` se mueve.
   *
   * Con el concepto es PEOR, y por eso también se reinicia aquí aunque no sea «de la lente»: el
   * contenido nombra su arquetipo —y hay un guard que lo comprueba contra el reto del concepto—
   * pero NO nombra su concepto, que viaja como columna. No hay nada dentro del texto que
   * contrastar, así que ninguna capa puede detectar una revisión escrita para otro concepto del
   * mismo reto: la lente sigue siendo del reto, su evidencia también, y todo pasa. Medido.
   *
   * Y se dice antes de que pase, junto a los selectores, porque perder lo escrito en silencio es
   * su propia avería.
   */
  const cambiarConcepto = (v: string) => {
    setConceptoId(v);
    limpiar();
  };
  const cambiarLente = (v: string) => {
    setArquetipoId(v);
    limpiar();
  };

  const hallazgoListo = (h: HallazgoAMano) =>
    h.titulo.trim() !== '' &&
    h.descripcion.trim() !== '' &&
    h.citas.every((c) => citaVacia(c) || citaCompleta(c)) &&
    (h.esHipotesis || h.citas.some(citaCompleta));
  const listo =
    conceptoId !== '' &&
    arquetipoId !== '' &&
    sintesis.trim() !== '' &&
    hallazgos.every(hallazgoListo) &&
    preguntas.every((q) => q.pregunta.trim() !== '');

  async function escribir() {
    setOcupado(true);
    onError(null);
    try {
      const r = await escribirRevisionSimuladaAMano({
        data: {
          workspaceId,
          conceptoId,
          contenido: {
            arquetipoId,
            sintesis,
            hallazgos: hallazgos.map((h) => ({
              titulo: h.titulo,
              descripcion: h.descripcion,
              esHipotesis: h.esHipotesis,
              // Sin citas si es hipótesis, y no por cortesía: mandar una con la marca puesta lo
              // rechaza el contrato. La casilla ya las limpia; esto es el cinturón.
              citas: h.esHipotesis ? [] : h.citas.filter((c) => !citaVacia(c)),
            })),
            preguntas: preguntas.map((q) =>
              q.hallazgoIndice === null
                ? { pregunta: q.pregunta, escenario: q.escenario }
                : {
                    pregunta: q.pregunta,
                    escenario: q.escenario,
                    hallazgoIndice: q.hallazgoIndice,
                  },
            ),
          },
        },
      });
      if (r.ok) {
        setAbierto(false);
        limpiar();
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo escribir la revisión; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  if (candidatos.length === 0 || lentes.length === 0) return null;
  if (!abierto) {
    return (
      <Button variant="secondary" onClick={() => setAbierto(true)}>
        Escribir una revisión a mano
      </Button>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={{ font: '600 11.5px var(--font-sans)', color: 'var(--text-muted)' }}>
        Revisión escrita a mano · queda marcada como simulación y sin procedencia AI
      </span>
      <Select value={conceptoId} onChange={(e) => cambiarConcepto(e.target.value)}>
        <option value="">Concepto que se revisa…</option>
        {candidatos.map((c) => (
          <option key={c.id} value={c.id}>
            {c.titulo}
          </option>
        ))}
      </Select>
      <Select value={arquetipoId} onChange={(e) => cambiarLente(e.target.value)}>
        <option value="">Lente desde la que se lee…</option>
        {lentes.map((a) => (
          <option key={a.id} value={a.id}>
            {a.nombre}
          </option>
        ))}
      </Select>
      <span style={{ font: '400 11px var(--font-sans)', color: 'var(--text-faint)' }}>
        Cambiar de concepto o de lente vacía lo escrito: una revisión es lo que ESA lente ve en
        ESE concepto.
      </span>
      <Input
        placeholder="Lectura de conjunto"
        value={sintesis}
        onChange={(e) => setSintesis(e.target.value)}
      />

      {hallazgos.map((h, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gap: 6,
            padding: 8,
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ font: '600 11.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Hallazgo {i + 1}
            </span>
            {hallazgos.length > 1 && (
              <Button variant="secondary" onClick={() => quitarHallazgo(i)} disabled={ocupado}>
                Quitar
              </Button>
            )}
          </div>
          <Input
            placeholder="Hallazgo"
            value={h.titulo}
            onChange={(e) => parchearHallazgo(i, { titulo: e.target.value })}
          />
          <Input
            placeholder="Qué se observa"
            value={h.descripcion}
            onChange={(e) => parchearHallazgo(i, { descripcion: e.target.value })}
          />
          <label style={{ font: '400 11.5px var(--font-sans)', display: 'flex', gap: 6 }}>
            <input
              type="checkbox"
              checked={h.esHipotesis}
              onChange={(ev) => marcarHipotesis(i, ev.currentTarget.checked)}
            />
            Es una hipótesis: lo extrapolo del perfil, no lo dice ningún testimonio
          </label>
          {!h.esHipotesis &&
            h.citas.map((c, k) => (
              <div key={k} style={{ display: 'grid', gap: 6 }}>
                <Select
                  value={c.evidenciaId}
                  /*
                   * Cambiar de documento VACÍA el pasaje, por lo mismo que cambiar de lente: un
                   * fragmento es texto literal de un documento concreto, y dejar el de A pegado
                   * a B lo atribuye a quien no lo dijo. Nadie lo para después — la ruta manual
                   * no comprueba presencia literal, y está medido: un pasaje que no aparece en
                   * el documento elegido se escribe y se muestra como sostén del hallazgo.
                   */
                  onChange={(e) =>
                    parchearCita(i, k, {
                      evidenciaId: e.target.value,
                      fragmento: '',
                      localizacion: '',
                    })
                  }
                >
                  <option value="">Documento que lo sostiene…</option>
                  {/*
                    Y sólo los que este hallazgo NO cita ya: el enlace guarda un pasaje por
                    documento, así que un segundo pasaje del mismo se perdía en el refresco. El
                    contrato de la ruta manual lo rechaza; esto es no ofrecerlo.
                  */}
                  {citables
                    .filter(
                      (e) =>
                        e.id === c.evidenciaId ||
                        !h.citas.some((otra, l) => l !== k && otra.evidenciaId === e.id),
                    )
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.titulo}
                      </option>
                    ))}
                </Select>
                <Input
                  placeholder="Fragmento literal"
                  value={c.fragmento}
                  onChange={(e) => parchearCita(i, k, { fragmento: e.target.value })}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <Input
                    placeholder="Dónde está (p. ej. resumen)"
                    value={c.localizacion}
                    onChange={(e) => parchearCita(i, k, { localizacion: e.target.value })}
                  />
                  {h.citas.length > 1 && (
                    <Button
                      variant="secondary"
                      disabled={ocupado}
                      onClick={() =>
                        parchearHallazgo(i, { citas: h.citas.filter((_, l) => l !== k) })
                      }
                    >
                      Quitar cita
                    </Button>
                  )}
                </div>
              </div>
            ))}
          {!h.esHipotesis &&
            h.citas.length < MAX_CITAS_POR_HALLAZGO &&
            h.citas.filter((c) => c.evidenciaId !== '').length < citables.length && (
            <Button
              variant="secondary"
              disabled={ocupado}
              onClick={() => parchearHallazgo(i, { citas: [...h.citas, CITA_VACIA] })}
            >
              Añadir otra cita
            </Button>
          )}
        </div>
      ))}
      {hallazgos.length < MAX_HALLAZGOS_POR_REVISION && (
        <Button
          variant="secondary"
          disabled={ocupado}
          onClick={() => setHallazgos((xs) => [...xs, HALLAZGO_VACIO])}
        >
          Añadir otro hallazgo
        </Button>
      )}

      {preguntas.map((q, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gap: 6,
            padding: 8,
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ font: '600 11.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Pregunta {i + 1}
            </span>
            {preguntas.length > 1 && (
              <Button
                variant="secondary"
                disabled={ocupado}
                onClick={() => setPreguntas((xs) => xs.filter((_, j) => j !== i))}
              >
                Quitar
              </Button>
            )}
          </div>
          <Input
            placeholder="Pregunta que hay que llevarle a una persona real"
            value={q.pregunta}
            onChange={(e) => parchearPregunta(i, { pregunta: e.target.value })}
          />
          <Input
            placeholder="En qué montaje preguntarla (opcional)"
            value={q.escenario}
            onChange={(e) => parchearPregunta(i, { escenario: e.target.value })}
          />
          {/*
            De qué hallazgo NACE, que es la traza simulación → test real y lo que el lector
            pinta al lado de cada pregunta. Puede no nacer de ninguno: la lista lo dice en vez
            de colgarla del primero por omisión, que es lo que hacía cuando sólo había uno.
          */}
          <Select
            value={q.hallazgoIndice === null ? '' : String(q.hallazgoIndice)}
            onChange={(e) =>
              parchearPregunta(i, {
                hallazgoIndice: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          >
            <option value="">No nace de un hallazgo concreto</option>
            {hallazgos.map((h, j) => (
              <option key={j} value={String(j)}>
                {h.titulo.trim() === '' ? `Hallazgo ${j + 1}` : h.titulo}
              </option>
            ))}
          </Select>
        </div>
      ))}
      {preguntas.length < MAX_PREGUNTAS_POR_REVISION && (
        <Button
          variant="secondary"
          disabled={ocupado}
          onClick={() => setPreguntas((xs) => [...xs, PREGUNTA_VACIA])}
        >
          Añadir otra pregunta
        </Button>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <Button onClick={escribir} disabled={ocupado || !listo}>
          Escribir revisión
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setAbierto(false);
            limpiar();
          }}
          disabled={ocupado}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function RevisionesDelConcepto({ revisiones }: { revisiones: RevisionSimuladaDeConcepto[] }) {
  if (revisiones.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: 10, gridColumn: '1 / -1' }}>
      <span style={{ font: '600 11.5px var(--font-sans)', color: 'var(--text-muted)' }}>
        Revisiones simuladas aceptadas · {revisiones.length}
      </span>
      {revisiones.map((r) => (
        <article
          key={r.id}
          style={{
            display: 'grid',
            gap: 6,
            padding: 10,
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ font: '600 12.5px var(--font-sans)' }}>{r.arquetipoNombre}</strong>
            <span style={{ font: '400 11px var(--font-sans)', color: 'var(--text-faint)' }}>
              {r.arquetipoEstado}
            </span>
            {/*
              * La etiqueta de SYS-20 va SIEMPRE —toda revisión de esta tabla es simulación, la
              * escriba quien la escriba— pero la AUTORÍA no: decía «simulación AI» encima de
              * una fila que dos palabras después se declaraba «escrita a mano», o sea las dos
              * cosas a la vez y una de ellas falsa. Quien lee esto está firmando un pasa/muere;
              * una procedencia contradictoria es de las que se resuelven creyendo la mitad
              * equivocada. La marca de simulación y de dónde salió son dos hechos distintos y
              * ahora se dicen por separado.
              */}
            <span
              style={{
                font: '600 10.5px var(--font-sans)',
                color: 'var(--warn)',
                border: '1px solid var(--warn)',
                borderRadius: 3,
                padding: '1px 5px',
              }}
            >
              simulación
            </span>
            <span style={{ font: '400 11px var(--font-sans)', color: 'var(--text-faint)' }}>
              {r.propuestaAiId === null ? 'escrita a mano' : 'propuesta por AI'}
            </span>
          </header>
          <p style={{ font: '400 12px var(--font-sans)', margin: 0 }}>{r.sintesis}</p>
          <ul style={{ display: 'grid', gap: 5, margin: 0, paddingLeft: 16 }}>
            {r.hallazgos.map((h) => (
              <li key={h.id} style={{ font: '400 12px var(--font-sans)' }}>
                <strong style={{ fontWeight: 600 }}>{h.titulo}</strong>
                {h.esHipotesis && (
                  <span style={{ color: 'var(--text-faint)' }}> · hipótesis, no observado</span>
                )}
                <br />
                {h.descripcion}
                {h.citas.map((c, j) => (
                  // El PASAJE, no solo el documento: quien firma el pasa/muere tiene que poder
                  // ver qué dijo alguien, no solo dónde. Cuando la revisión se escribió a mano
                  // no hay fragmento que enseñar y queda el título, que es todo lo que existe.
                  <span key={j} style={{ display: 'block', color: 'var(--text-faint)' }}>
                    {!c.citable
                      ? `· se apoyaba en ${c.evidenciaTitulo} · su permiso de cita ya no está, así que el pasaje no se muestra`
                      : c.fragmento === null
                        ? `· se apoya en ${c.evidenciaTitulo}`
                        : `· «${c.fragmento}» — ${c.evidenciaTitulo}${
                            c.localizacion === null || c.localizacion === ''
                              ? ''
                              : `, ${c.localizacion}`
                          }`}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {r.preguntas.length > 0 && (
            <div style={{ display: 'grid', gap: 3 }}>
              <span style={{ font: '600 11px var(--font-sans)', color: 'var(--text-muted)' }}>
                Qué ir a probar con personas
              </span>
              <ul style={{ display: 'grid', gap: 3, margin: 0, paddingLeft: 16 }}>
                {r.preguntas.map((q) => {
                  // Por TÍTULO, no por número. La tarjeta de la propuesta pendiente dice «Nace
                  // del hallazgo N» porque ahí lo único que hay es el índice del contenido;
                  // aquí el hallazgo ya es una fila con nombre, y un nombre no obliga a contar
                  // viñetas hacia arriba para saber de qué se está hablando.
                  const nace = r.hallazgos.find((h) => h.id === q.hallazgoId);
                  return (
                    <li key={q.id} style={{ font: '400 12px var(--font-sans)' }}>
                      {q.pregunta}
                      {q.escenario !== '' && (
                        <span style={{ color: 'var(--text-faint)' }}> · {q.escenario}</span>
                      )}
                      {nace !== undefined && (
                        <span style={{ color: 'var(--text-faint)' }}> · nace de «{nace.titulo}»</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
