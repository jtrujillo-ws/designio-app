import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import {
  abrirMedicionDelReto,
  abrirRegistryDeReto,
  abrirReviewDelReto,
  agregarEntradaKpi,
  cargarSnapshotDeFormulario,
  cargarSnapshotsPegados,
  completarReviewDelReto,
  editarEntradaKpi,
  firmarMetricRegistry,
  guardarResultadoDeCriterio,
} from '@/lib/medicion/medicion.functions';
import {
  ETIQUETA_ESTADO_SNAPSHOT,
  ETIQUETA_FRECUENCIA,
  ETIQUETA_VEREDICTO,
  etiquetaVentana,
  FRECUENCIAS,
  medicionPorAbrir,
  VEREDICTOS,
  ventanaAbierta,
  ventanasCerradas,
  type EntradaDeRegistry,
  type EstadoSnapshot,
  type Frecuencia,
  type SeguimientoDeImpacto,
  type VeredictoSlug,
} from '@/lib/medicion/medicion.schemas';
import { ETIQUETA_ROL } from '@/lib/auth/auth.schemas';
import type { ProyectoMetodo } from '@/lib/metodo/metodo.schemas';
import { ROLES_CLIENTE } from '@/lib/workspace/workspace.schemas';

/**
 * Seguimiento de impacto del reto (SPEC-07). Vive DENTRO del proyecto, no en un módulo
 * de «operación» aparte (RF-07.6): el contrato de medición, la serie contra la línea
 * base y el post-mortem con veredicto son la última etapa del mismo método.
 *
 * La pantalla solo ofrece lo que el servidor aceptaría: los curadores redactan el
 * registry, el rol aprobador de G6 lo FIRMA, el propietario del dato carga sus
 * snapshots, y el lead abre la medición y dicta el veredicto. Y distingue
 * TIPOGRÁFICAMENTE contribución de causalidad (RF-07.9): el lenguaje causal solo aparece
 * cuando alguien declaró —y justificó— diseño experimental suficiente.
 */

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

/** `cerrado` es terminal y BUENO —llegó lo comprometido y la ventana se acabó—, pero no
 * es una recepción de hoy: se pinta con el acento y no con el verde de «recibido», que
 * está reservado a la cadencia viva. */
const COLOR_ESTADO: Record<EstadoSnapshot, string> = {
  esperado: 'var(--text-muted)',
  recibido: 'var(--ok)',
  vencido: 'var(--danger)',
  cerrado: 'var(--accent)',
};

const COLOR_VEREDICTO: Record<VeredictoSlug, string> = {
  logrado: 'var(--ok)',
  'parcialmente-logrado': 'var(--warn)',
  'no-logrado': 'var(--danger)',
  'no-concluyente': 'var(--text-muted)',
};

type Comunes = {
  workspaceId: string;
  seguimiento: SeguimientoDeImpacto;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
};

export function SeccionMedicion({
  workspaceId,
  proyecto,
  seguimiento,
  rol,
  onCambio,
  onError,
}: {
  workspaceId: string;
  proyecto: ProyectoMetodo;
  seguimiento: SeguimientoDeImpacto;
  rol: string;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const esLead = rol === 'lead-boutique';
  const esCurador = esLead || rol === 'disenador';
  // El registry se firma en G6 y lo firma SU rol aprobador: se lee del gate, no de una
  // constante duplicada aquí.
  const firmaG6 = proyecto.gates.find((g) => g.numero === 6)?.rolAprobador;
  // Y la medición se ABRE en G7 (§5.2): el gate de seguimiento, con los releases
  // conciliados y el effective state constatado. Firmar el contrato no basta.
  const g7Aprobado = proyecto.gates.find((g) => g.numero === 7)?.estado === 'aprobado';
  const comunes = { workspaceId, seguimiento, onCambio, onError };

  return (
    <>
      <BloqueRegistry
        {...comunes}
        criterios={proyecto.reto.criterios}
        esCurador={esCurador}
        esLead={esLead}
        puedeFirmar={rol === firmaG6}
        g7Aprobado={g7Aprobado}
      />
      {seguimiento.registry?.estado === 'firmado' &&
        seguimiento.entradas.map((entrada) => (
          <BloqueSerie key={entrada.id} {...comunes} entrada={entrada} esCurador={esCurador} />
        ))}
      {seguimiento.registry?.estado === 'firmado' && (
        <BloqueReview {...comunes} esLead={esLead} />
      )}
    </>
  );
}

function BloqueRegistry({
  workspaceId,
  seguimiento,
  criterios,
  esCurador,
  esLead,
  puedeFirmar,
  g7Aprobado,
  onCambio,
  onError,
}: Comunes & {
  criterios: ProyectoMetodo['reto']['criterios'];
  esCurador: boolean;
  esLead: boolean;
  puedeFirmar: boolean;
  g7Aprobado: boolean;
}) {
  const [ocupado, setOcupado] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  const registry = seguimiento.registry;
  const firmado = registry?.estado === 'firmado';
  // Quién decide esto es la base; aquí solo se ofrece lo que allí se acepta —los dos
  // caminos, el normal y el del reto heredado—, en el mismo sitio que las demás mirillas.
  const porAbrir = medicionPorAbrir(seguimiento);

  async function accion(fn: () => Promise<{ ok: boolean; error?: string }>, fallo: string) {
    setOcupado(true);
    onError(null);
    try {
      const r = await fn();
      if (r.ok) {
        setCreando(false);
        setEditando(null);
        await onCambio();
      } else onError(r.error ?? fallo);
    } catch {
      onError(fallo);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '700 14.5px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 240 }}>
          Metric Registry · contrato de medición del reto
        </span>
        <Tag>{seguimiento.retoCodigo}</Tag>
        <Tag>{registry ? registry.estado : 'sin abrir'}</Tag>
        {firmado && registry?.firmadoEn && (
          <span style={{ font: '600 12px var(--font-sans)', color: 'var(--ok)' }}>
            Firmado en G6 · {registry.firmadoEn.slice(0, 10)}
          </span>
        )}
      </div>
      <span style={{ font: '400 12.5px/1.55 var(--font-sans)', color: 'var(--text-muted)' }}>
        Cada KPI responde a un criterio de éxito, tiene dueño del dato y frecuencia
        comprometida (SYS-22). Al firmarlo queda congelado: desde ahí solo entran
        snapshots, y son append-only (SYS-23).
      </span>

      {!registry && esCurador && (
        <div>
          <Button
            size="sm"
            disabled={ocupado}
            onClick={() =>
              void accion(
                () => abrirRegistryDeReto({ data: { workspaceId, retoId: seguimiento.retoId } }),
                'No se pudo abrir el registry; intenta de nuevo',
              )
            }
          >
            Abrir Metric Registry
          </Button>
        </div>
      )}
      {!registry && !esCurador && (
        <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
          El equipo de diseño aún no abrió el contrato de medición.
        </span>
      )}

      {seguimiento.criteriosSinEntrada.length > 0 && registry && !firmado && (
        <span style={{ font: '500 12.5px var(--font-sans)', color: 'var(--warn)' }}>
          Criterios sin KPI que los responda:{' '}
          {seguimiento.criteriosSinEntrada.map((c) => c.kpi).join(', ')} — la firma los exige.
        </span>
      )}

      {seguimiento.entradas.map((entrada) =>
        editando === entrada.id ? (
          <FormularioEntrada
            key={entrada.id}
            workspaceId={workspaceId}
            seguimiento={seguimiento}
            criterios={criterios}
            entrada={entrada}
            ocupado={ocupado}
            onCancelar={() => setEditando(null)}
            onEnviar={(datos) =>
              accion(
                () => editarEntradaKpi({ data: { ...datos, entradaId: entrada.id } }),
                'No se pudo editar el KPI; intenta de nuevo',
              )
            }
          />
        ) : (
          <FichaEntrada
            key={entrada.id}
            entrada={entrada}
            editable={esCurador && !firmado}
            onEditar={() => setEditando(entrada.id)}
          />
        ),
      )}

      {registry && !firmado && esCurador && !creando && editando === null && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size="sm" variant="secondary" disabled={ocupado} onClick={() => setCreando(true)}>
            Añadir KPI
          </Button>
        </div>
      )}
      {registry && creando && (
        <FormularioEntrada
          workspaceId={workspaceId}
          seguimiento={seguimiento}
          criterios={criterios}
          entrada={null}
          ocupado={ocupado}
          onCancelar={() => setCreando(false)}
          onEnviar={(datos) =>
            accion(
              () =>
                agregarEntradaKpi({
                  data: { ...datos, registryId: registry.id, criterioId: datos.criterioId },
                }),
              'No se pudo añadir el KPI; intenta de nuevo',
            )
          }
        />
      )}

      {registry && !firmado && puedeFirmar && (
        <div>
          <Button
            size="sm"
            disabled={ocupado}
            onClick={() =>
              void accion(
                () => firmarMetricRegistry({ data: { workspaceId, registryId: registry.id } }),
                'No se pudo firmar el registry; intenta de nuevo',
              )
            }
          >
            Firmar el registry (G6)
          </Button>
        </div>
      )}
      {registry && !firmado && !puedeFirmar && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Lo firma el sponsor en G6: es el compromiso del cliente con el dato.
        </span>
      )}

      {firmado && porAbrir && esLead && g7Aprobado && (
        <div>
          <Button
            size="sm"
            disabled={ocupado}
            onClick={() =>
              void accion(
                () => abrirMedicionDelReto({ data: { workspaceId, retoId: seguimiento.retoId } }),
                'No se pudo abrir la medición; intenta de nuevo',
              )
            }
          >
            {/* El reto heredado ya mide: lo que este botón abre es su PROYECTO, que se
                quedó atrás. Decirle «abrir la medición» a quien ve el reto midiendo desde
                hace meses sería ofrecerle algo que no reconoce como su problema. */}
            {seguimiento.retoEstado === 'en-medicion'
              ? 'Terminar de abrir la medición'
              : 'Abrir la medición'}
          </Button>
        </div>
      )}
      {firmado && porAbrir && esLead && !g7Aprobado && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          La medición se abre al aprobarse el G7: primero se concilian los releases contra
          la design version y se constata el effective state.
        </span>
      )}
    </Card>
  );
}

function FichaEntrada({
  entrada,
  editable,
  onEditar,
}: {
  entrada: EntradaDeRegistry;
  editable: boolean;
  onEditar: () => void;
}) {
  return (
    <div
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
        <span style={{ font: '700 13.5px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 180 }}>
          {entrada.nombre}
        </span>
        <Tag>{ETIQUETA_FRECUENCIA[entrada.frecuencia]}</Tag>
        <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ESTADO[entrada.estadoSnapshot] }}>
          {ETIQUETA_ESTADO_SNAPSHOT[entrada.estadoSnapshot]}
        </span>
        {editable && (
          <Button size="sm" variant="ghost" onClick={onEditar}>
            Editar
          </Button>
        )}
      </div>
      <span style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}>
        Criterio «{entrada.criterioKpi}»
        {entrada.criterioObjetivo ? ` · objetivo ${entrada.criterioObjetivo}` : ''}
        {entrada.lineaBaseValor
          ? ` · base ${entrada.lineaBaseValor}${entrada.lineaBaseFecha ? ` (${entrada.lineaBaseFecha})` : ''}`
          : ' · SIN LÍNEA BASE'}
      </span>
      {entrada.definicion && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
          {entrada.definicion}
        </span>
      )}
      <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
        Dueño del dato: {entrada.propietarioNombre ?? 'SIN ASIGNAR'}
        {entrada.fuente ? ` · fuente: ${entrada.fuente}` : ''}
        {entrada.dimensiones ? ` · cortes: ${entrada.dimensiones}` : ''}
      </span>
      <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
        Ventana: {entrada.ventanaInicio ?? '—'} → {entrada.ventanaFin ?? '—'}
        {entrada.diasRestantes !== null && ` · ${etiquetaVentana(entrada.diasRestantes)}`}
        {entrada.fechaPostMortem ? ` · post-mortem previsto ${entrada.fechaPostMortem}` : ''}
      </span>
      {entrada.dashboardUrl && (
        <a
          href={entrada.dashboardUrl}
          target="_blank"
          rel="noreferrer noopener"
          style={{ font: '500 12px var(--font-sans)', color: 'var(--accent)' }}
        >
          Dashboard externo del cliente ↗
        </a>
      )}
    </div>
  );
}

type DatosEntrada = {
  workspaceId: string;
  criterioId: string;
  nombre: string;
  definicion: string;
  fuente: string;
  dimensiones: string;
  propietarioMiembroId: string | null;
  frecuencia: Frecuencia;
  dashboardUrl: string;
  lineaBaseValor: string | null;
  lineaBaseFecha: string | null;
  ventanaInicio: string | null;
  fechaPostMortem: string | null;
};

function FormularioEntrada({
  workspaceId,
  seguimiento,
  criterios,
  entrada,
  ocupado,
  onCancelar,
  onEnviar,
}: {
  workspaceId: string;
  seguimiento: SeguimientoDeImpacto;
  criterios: ProyectoMetodo['reto']['criterios'];
  entrada: EntradaDeRegistry | null;
  ocupado: boolean;
  onCancelar: () => void;
  onEnviar: (datos: DatosEntrada) => Promise<void>;
}) {
  const [datos, setDatos] = useState<DatosEntrada>({
    workspaceId,
    criterioId: entrada?.criterioId ?? criterios[0]?.id ?? '',
    nombre: entrada?.nombre ?? '',
    definicion: entrada?.definicion ?? '',
    fuente: entrada?.fuente ?? '',
    dimensiones: entrada?.dimensiones ?? '',
    propietarioMiembroId: entrada?.propietarioMiembroId ?? null,
    frecuencia: entrada?.frecuencia ?? 'mensual',
    dashboardUrl: entrada?.dashboardUrl ?? '',
    lineaBaseValor: entrada?.lineaBaseValor ?? null,
    lineaBaseFecha: entrada?.lineaBaseFecha ?? null,
    ventanaInicio: entrada?.ventanaInicio ?? null,
    fechaPostMortem: entrada?.fechaPostMortem ?? null,
  });
  /** Campos de texto: el vacío es cadena vacía. */
  const texto =
    (k: 'nombre' | 'definicion' | 'fuente' | 'dimensiones' | 'dashboardUrl') => (v: string) =>
      setDatos((d) => ({ ...d, [k]: v }));
  /** Campos opcionales: el vacío es AUSENTE (null), no una cadena vacía — la firma
   * distingue «sin línea base» de «línea base en blanco». */
  const opcional =
    (k: 'lineaBaseValor' | 'lineaBaseFecha' | 'ventanaInicio' | 'fechaPostMortem') =>
    (v: string) =>
      setDatos((d) => ({ ...d, [k]: v === '' ? null : v }));

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <span style={micro}>{entrada ? 'Editar KPI' : 'Nuevo KPI del registry'}</span>
      {/* El criterio se corrige mientras el registry sea borrador: es el error fácil al
          crear el KPI y no hay borrado que lo deshaga. Además decide la VENTANA del KPI
          (`ventana_dias` vive en el criterio), así que dejarlo bloqueado no congelaba una
          identidad — condenaba a firmar midiendo una promesa que nadie hizo. */}
      <Select
        value={datos.criterioId}
        onChange={(e) => setDatos((d) => ({ ...d, criterioId: e.target.value }))}
      >
        {criterios.map((c) => (
          <option key={c.id} value={c.id}>
            Criterio: {c.kpi}
          </option>
        ))}
      </Select>
      <Input
        value={datos.nombre}
        placeholder="Nombre del KPI (p. ej. Abandono %)"
        maxLength={200}
        onChange={(e) => texto('nombre')(e.target.value)}
      />
      <Textarea
        value={datos.definicion}
        placeholder="Definición: cómo se calcula exactamente"
        rows={2}
        maxLength={2000}
        onChange={(e) => texto('definicion')(e.target.value)}
      />
      <Input
        value={datos.fuente}
        placeholder="Fuente del dato (sistema, panel, informe)"
        maxLength={300}
        onChange={(e) => texto('fuente')(e.target.value)}
      />
      <Input
        value={datos.dimensiones}
        placeholder="Cortes o dimensiones (opcional)"
        maxLength={300}
        onChange={(e) => texto('dimensiones')(e.target.value)}
      />
      {/* El dueño del dato es una persona del CLIENTE (RF-07.1) y el servidor solo manda
          esas: ofrecer a un curador sería ofrecer lo que la base rechaza — al escribir la
          entrada y otra vez al firmar el registry, que es el peor momento para enterarse. */}
      <Select
        value={datos.propietarioMiembroId ?? ''}
        onChange={(e) =>
          setDatos((d) => ({ ...d, propietarioMiembroId: e.target.value === '' ? null : e.target.value }))
        }
      >
        <option value="">Dueño del dato (persona del cliente)…</option>
        {seguimiento.propietariosPosibles.map((m) => (
          <option key={m.id} value={m.id}>
            {m.nombre} · {ETIQUETA_ROL[m.rol] ?? m.rol}
          </option>
        ))}
      </Select>
      {seguimiento.propietariosPosibles.length === 0 && (
        <span style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
          Todavía no hay nadie del cliente en el workspace (
          {ROLES_CLIENTE.map((r) => ETIQUETA_ROL[r] ?? r).join(', ')}): sin dueño del dato,
          el registry no se puede firmar en G6.
        </span>
      )}
      <Select
        value={datos.frecuencia}
        onChange={(e) => setDatos((d) => ({ ...d, frecuencia: e.target.value as Frecuencia }))}
      >
        {FRECUENCIAS.map((f) => (
          <option key={f} value={f}>
            Frecuencia {ETIQUETA_FRECUENCIA[f]}
          </option>
        ))}
      </Select>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Input
          value={datos.lineaBaseValor ?? ''}
          placeholder="Línea base (valor)"
          onChange={(e) => opcional('lineaBaseValor')(e.target.value)}
          style={{ flex: 1, minWidth: 140 }}
        />
        <Input
          type="date"
          value={datos.lineaBaseFecha ?? ''}
          onChange={(e) => opcional('lineaBaseFecha')(e.target.value)}
          style={{ flex: 1, minWidth: 140 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ ...micro, flex: 1, minWidth: 140 }}>
          Inicio de ventana
          <Input
            type="date"
            value={datos.ventanaInicio ?? ''}
            onChange={(e) => opcional('ventanaInicio')(e.target.value)}
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ ...micro, flex: 1, minWidth: 140 }}>
          Post-mortem previsto
          <Input
            type="date"
            value={datos.fechaPostMortem ?? ''}
            onChange={(e) => opcional('fechaPostMortem')(e.target.value)}
            style={{ width: '100%' }}
          />
        </label>
      </div>
      <Input
        value={datos.dashboardUrl}
        placeholder="Enlace a dashboard externo (opcional)"
        maxLength={2000}
        onChange={(e) => texto('dashboardUrl')(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          size="sm"
          disabled={ocupado || datos.nombre.trim() === '' || datos.criterioId === ''}
          onClick={() => void onEnviar(datos)}
        >
          Guardar
        </Button>
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/** Último día que la base aceptaría para un snapshot: el cierre de la ventana firmada o
 * hoy, lo que llegue antes. */
function maxFechaDeSnapshot(entrada: EntradaDeRegistry): string {
  const hoy = new Date().toISOString().slice(0, 10);
  return entrada.ventanaFin !== null && entrada.ventanaFin < hoy ? entrada.ventanaFin : hoy;
}

function BloqueSerie({
  workspaceId,
  seguimiento,
  entrada,
  esCurador,
  onCambio,
  onError,
}: Comunes & { entrada: EntradaDeRegistry; esCurador: boolean }) {
  const [valor, setValor] = useState('');
  const [fecha, setFecha] = useState('');
  const [nota, setNota] = useState('');
  const [csv, setCsv] = useState('');
  const [pegando, setPegando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [rechazadas, setRechazadas] = useState<{ linea: number; motivo: string }[]>([]);
  // La política acepta al curador o al PROPIETARIO del dato, y solo mientras el reto mide.
  const puedeCargar =
    (esCurador || entrada.soyPropietario) && seguimiento.retoEstado === 'en-medicion';

  async function enviarFormulario() {
    setOcupado(true);
    onError(null);
    try {
      const r = await cargarSnapshotDeFormulario({
        data: { workspaceId, entradaId: entrada.id, valor, fecha, nota },
      });
      if (r.ok) {
        setValor('');
        setFecha('');
        setNota('');
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo registrar el snapshot; revisa el valor y la fecha');
    } finally {
      setOcupado(false);
    }
  }

  async function enviarCsv() {
    setOcupado(true);
    onError(null);
    setRechazadas([]);
    try {
      const r = await cargarSnapshotsPegados({ data: { workspaceId, entradaId: entrada.id, csv } });
      if (r.ok) {
        setRechazadas(r.rechazadas);
        if (r.rechazadas.length === 0) {
          setCsv('');
          setPegando(false);
        }
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo cargar el CSV; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '700 14px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 200 }}>
          {entrada.nombre} · lectura del criterio «{entrada.criterioKpi}»
        </span>
        <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ESTADO[entrada.estadoSnapshot] }}>
          {ETIQUETA_ESTADO_SNAPSHOT[entrada.estadoSnapshot]}
        </span>
        <Tag>{etiquetaVentana(entrada.diasRestantes)}</Tag>
      </div>

      {/* Baseline → serie → objetivo: la lectura del criterio en una línea (RF-07.5). */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Punto etiqueta={`base ${entrada.lineaBaseFecha ?? ''}`} valor={entrada.lineaBaseValor ?? '—'} tono="var(--text-muted)" />
        {entrada.snapshots.map((s) => (
          <Punto
            key={s.id}
            etiqueta={`${s.fecha} · ${s.origen}`}
            valor={s.valor}
            tono="var(--accent)"
            titulo={s.nota}
          />
        ))}
        <Punto
          etiqueta="objetivo"
          valor={entrada.criterioObjetivo === '' ? '—' : entrada.criterioObjetivo}
          tono="var(--ok)"
        />
      </div>
      {entrada.snapshots.length === 0 && (
        <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--text-faint)' }}>
          Sin snapshots todavía. El dueño del dato es {entrada.propietarioNombre ?? '—'} y el
          compromiso es {ETIQUETA_FRECUENCIA[entrada.frecuencia].toLowerCase()}.
        </span>
      )}

      {puedeCargar && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input
            value={valor}
            placeholder="Valor"
            onChange={(e) => setValor(e.target.value)}
            style={{ width: 110 }}
          />
          {/* La ventana firmada acota qué mide el dato (I5) y el futuro no se ha medido:
              el calendario ofrece solo lo que la base aceptaría. */}
          <Input
            type="date"
            value={fecha}
            min={entrada.ventanaInicio ?? undefined}
            max={maxFechaDeSnapshot(entrada)}
            onChange={(e) => setFecha(e.target.value)}
          />
          <Input
            value={nota}
            placeholder="Nota (una corrección es un snapshot nuevo)"
            maxLength={500}
            onChange={(e) => setNota(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <Button
            size="sm"
            disabled={ocupado || valor.trim() === '' || fecha === ''}
            onClick={() => void enviarFormulario()}
          >
            Registrar
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setPegando((p) => !p)}>
            {pegando ? 'Cerrar CSV' : 'Pegar CSV'}
          </Button>
        </div>
      )}
      {puedeCargar && pegando && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Textarea
            value={csv}
            rows={4}
            placeholder={'fecha,valor,nota\n2026-08-01,55,corte mensual\n2026-09-01,49'}
            onChange={(e) => setCsv(e.target.value)}
          />
          <div>
            <Button size="sm" disabled={ocupado || csv.trim() === ''} onClick={() => void enviarCsv()}>
              Cargar filas válidas
            </Button>
          </div>
          {rechazadas.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ ...micro, color: 'var(--danger)' }}>Filas rechazadas</span>
              {rechazadas.map((f) => (
                <span
                  key={f.linea}
                  style={{ font: '400 12px var(--font-sans)', color: 'var(--danger)' }}
                >
                  Línea {f.linea}: {f.motivo}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Punto({
  etiqueta,
  valor,
  tono,
  titulo,
}: {
  etiqueta: string;
  valor: string;
  tono: string;
  titulo?: string;
}) {
  return (
    <div
      title={titulo}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 10px',
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
        minWidth: 76,
      }}
    >
      <span style={{ font: '700 15px var(--font-mono)', color: tono }}>{valor}</span>
      <span style={{ font: '400 10.5px var(--font-mono)', color: 'var(--text-faint)' }}>
        {etiqueta}
      </span>
    </div>
  );
}

function BloqueReview({
  workspaceId,
  seguimiento,
  esLead,
  onCambio,
  onError,
}: Comunes & { esLead: boolean }) {
  const review = seguimiento.review;
  const habilitado = ventanasCerradas(seguimiento.entradas);
  const [ocupado, setOcupado] = useState(false);
  const [veredicto, setVeredicto] = useState<VeredictoSlug>('no-concluyente');
  const [contribucion, setContribucion] = useState('');
  const [factores, setFactores] = useState('');
  const [hipotesis, setHipotesis] = useState('');
  const [aprendizajes, setAprendizajes] = useState('');
  const [experimental, setExperimental] = useState(false);
  const [justificacion, setJustificacion] = useState('');

  async function abrir() {
    setOcupado(true);
    onError(null);
    try {
      const r = await abrirReviewDelReto({ data: { workspaceId, retoId: seguimiento.retoId } });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo abrir el outcome review; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  async function completar() {
    if (!review) return;
    setOcupado(true);
    onError(null);
    try {
      const r = await completarReviewDelReto({
        data: {
          workspaceId,
          reviewId: review.id,
          veredicto,
          contribucion,
          factoresExternos: factores,
          hipotesisAbiertas: hipotesis,
          aprendizajes,
          disenoExperimentalSuficiente: experimental,
          disenoExperimentalJustificacion: justificacion,
        },
      });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo completar el outcome review; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '700 14.5px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 240 }}>
          Outcome review · el post-mortem que cierra el reto
        </span>
        {seguimiento.retoVeredicto && (
          <span
            style={{
              font: '700 12.5px var(--font-sans)',
              color: COLOR_VEREDICTO[seguimiento.retoVeredicto],
            }}
          >
            Veredicto: {ETIQUETA_VEREDICTO[seguimiento.retoVeredicto]}
          </span>
        )}
      </div>

      {!review && !habilitado && (
        <span style={{ font: '400 12.5px/1.55 var(--font-sans)', color: 'var(--text-muted)' }}>
          Se habilita al cerrar la ventana del último criterio (RF-07.7) — el último día de
          la ventana todavía se mide, así que el post-mortem se abre al día siguiente.{' '}
          {seguimiento.entradas
            .filter(ventanaAbierta)
            .map((e) => `${e.nombre}: ${etiquetaVentana(e.diasRestantes)}`)
            .join(' · ')}
        </span>
      )}
      {!review && habilitado && esLead && (
        <div>
          <Button size="sm" disabled={ocupado} onClick={() => void abrir()}>
            Abrir el outcome review
          </Button>
        </div>
      )}

      {review && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={micro}>Resultado por criterio (línea base vs. final)</span>
            {review.resultados.length === 0 && (
              <span style={{ font: '400 12.5px var(--font-sans)', color: 'var(--warn)' }}>
                Aún sin resultados: el review no se completa sin uno por criterio.
              </span>
            )}
            {review.resultados.map((r) => (
              <span
                key={r.criterioId}
                style={{ font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--text-body)' }}
              >
                <strong>{r.criterioKpi}</strong>:{' '}
                {r.valorFinal !== null
                  ? `final ${r.valorFinal} (${r.fechaFinal})`
                  : `sin dato — ${r.sinDatosMotivo}`}
                {r.lectura ? ` · ${r.lectura}` : ''}
              </span>
            ))}
          </div>

          {review.estado === 'borrador' && esLead && (
            <EditorResultados
              workspaceId={workspaceId}
              seguimiento={seguimiento}
              reviewId={review.id}
              onCambio={onCambio}
              onError={onError}
            />
          )}

          {review.estado === 'completado' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Narrativa titulo="Contribución del rediseño" texto={review.contribucion} />
              <Narrativa titulo="Factores externos conocidos" texto={review.factoresExternos} />
              <Narrativa titulo="Hipótesis abiertas" texto={review.hipotesisAbiertas} />
              <Narrativa titulo="Aprendizajes" texto={review.aprendizajes} />
              {/* RF-07.9: la distinción es estructural y visible, no una nota al pie. */}
              {review.disenoExperimentalSuficiente ? (
                <span style={{ font: '600 12px/1.5 var(--font-sans)', color: 'var(--warn)' }}>
                  Diseño experimental suficiente declarado — lenguaje causal habilitado:{' '}
                  {review.disenoExperimentalJustificacion}
                </span>
              ) : (
                <span style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--text-faint)' }}>
                  Sin diseño experimental suficiente: esto describe contribución y asociación,
                  no causalidad (SYS-24).
                </span>
              )}
              {review.completadoEn && (
                <span style={micro}>Completado el {review.completadoEn.slice(0, 10)}</span>
              )}
            </div>
          ) : (
            esLead && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Textarea
                  value={contribucion}
                  rows={3}
                  placeholder="Contribución del rediseño: qué cambió, con qué evidencia de la serie (lenguaje de contribución, no causal)"
                  onChange={(e) => setContribucion(e.target.value)}
                />
                <Textarea
                  value={factores}
                  rows={2}
                  placeholder="Factores externos conocidos que pudieron mover el KPI"
                  onChange={(e) => setFactores(e.target.value)}
                />
                <Textarea
                  value={hipotesis}
                  rows={2}
                  placeholder="Hipótesis abiertas que quedan para el próximo reto"
                  onChange={(e) => setHipotesis(e.target.value)}
                />
                <Textarea
                  value={aprendizajes}
                  rows={2}
                  placeholder="Aprendizajes del ciclo"
                  onChange={(e) => setAprendizajes(e.target.value)}
                />
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
                    checked={experimental}
                    onChange={(e) => setExperimental(e.target.checked)}
                  />
                  Diseño experimental suficiente (habilita lenguaje causal — exige justificarlo)
                </label>
                {experimental && (
                  <Textarea
                    value={justificacion}
                    rows={2}
                    placeholder="Justificación del diseño experimental (grupo de control, aleatorización, corte temporal…)"
                    onChange={(e) => setJustificacion(e.target.value)}
                  />
                )}
                <Select
                  value={veredicto}
                  onChange={(e) => setVeredicto(e.target.value as VeredictoSlug)}
                >
                  {VEREDICTOS.map((v) => (
                    <option key={v} value={v}>
                      Veredicto: {ETIQUETA_VEREDICTO[v]}
                    </option>
                  ))}
                </Select>
                <div>
                  <Button
                    size="sm"
                    disabled={ocupado || contribucion.trim() === ''}
                    onClick={() => void completar()}
                  >
                    Completar y cerrar el reto
                  </Button>
                </div>
                <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
                  Completarlo cierra el reto con veredicto y el proyecto queda inmutable (SYS-08).
                </span>
              </div>
            )
          )}
        </>
      )}
    </Card>
  );
}

function Narrativa({ titulo, texto }: { titulo: string; texto: string }) {
  if (texto.trim() === '') return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={micro}>{titulo}</span>
      <span style={{ font: '400 13px/1.6 var(--font-sans)', color: 'var(--text-body)', whiteSpace: 'pre-wrap' }}>
        {texto}
      </span>
    </div>
  );
}

/** Editor del resultado por criterio: el valor final se ELIGE de la serie (nunca se
 * teclea) o se declara por qué no hay dato — la honestidad del veredicto empieza aquí. */
function EditorResultados({
  workspaceId,
  seguimiento,
  reviewId,
  onCambio,
  onError,
}: {
  workspaceId: string;
  seguimiento: SeguimientoDeImpacto;
  reviewId: string;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [criterioId, setCriterioId] = useState(seguimiento.entradas[0]?.criterioId ?? '');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <span style={micro}>Registrar el resultado de un criterio</span>
      <Select value={criterioId} onChange={(e) => setCriterioId(e.target.value)}>
        {seguimiento.entradas.map((e) => (
          <option key={e.criterioId} value={e.criterioId}>
            {e.criterioKpi}
          </option>
        ))}
      </Select>
      {/* El `key` es el arreglo, y es estructural a propósito: TODO el borrador pertenece
          al criterio elegido, así que cambiar de criterio REMONTA el bloque y el estado no
          puede sobrevivir a la identidad de la que era. Limpiar campo por campo en el
          `onChange` funcionaba hasta que alguien añadiera el siguiente y se olvidara: la
          versión anterior limpiaba `snapshotId` y dejaba vivos `motivo` y `lectura`, con
          lo que el motivo viejo mantenía habilitado el botón y un clic grababa la
          explicación del criterio A como RESULTADO AUDITADO del criterio B — la fila que
          el post mortem existe para poder leer después. Una promesa que hay que acordarse
          de mantener no es una promesa; esta no hay que mantenerla. */}
      <CamposDelResultado
        key={criterioId}
        workspaceId={workspaceId}
        seguimiento={seguimiento}
        reviewId={reviewId}
        criterioId={criterioId}
        onCambio={onCambio}
        onError={onError}
      />
    </div>
  );
}

/** Los campos que pertenecen a UN criterio. Se remonta con él (ver el `key` de arriba),
 * así que nada de lo que hay aquí sobrevive a un cambio de criterio. */
function CamposDelResultado({
  workspaceId,
  seguimiento,
  reviewId,
  criterioId,
  onCambio,
  onError,
}: {
  workspaceId: string;
  seguimiento: SeguimientoDeImpacto;
  reviewId: string;
  criterioId: string;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [snapshotId, setSnapshotId] = useState('');
  const [lectura, setLectura] = useState('');
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  // Solo snapshots del criterio elegido: la política rechaza cualquier otro.
  const disponibles = seguimiento.entradas
    .filter((e) => e.criterioId === criterioId)
    .flatMap((e) => e.snapshots.map((s) => ({ ...s, kpi: e.nombre })));

  async function guardar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await guardarResultadoDeCriterio({
        data: {
          workspaceId,
          reviewId,
          criterioId,
          snapshotFinalId: snapshotId === '' ? null : snapshotId,
          lectura,
          sinDatosMotivo: motivo,
        },
      });
      if (r.ok) {
        setSnapshotId('');
        setLectura('');
        setMotivo('');
        await onCambio();
      } else onError(r.error);
    } catch {
      onError('No se pudo guardar el resultado; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      {/* Elegir un snapshot BORRA el motivo escrito antes: si no, el campo se ocultaba
          pero seguía viajando, y el resultado llegaba con valor final y con la explicación
          de que no hay dato. Ahora eso lo rechazan el schema y el CHECK de la tabla, así
          que dejarlo en el estado sería enviar a propósito algo que la base rechaza. */}
      <Select
        value={snapshotId}
        onChange={(e) => {
          setSnapshotId(e.target.value);
          if (e.target.value !== '') setMotivo('');
        }}
      >
        <option value="">Sin dato final (hay que decir por qué)…</option>
        {disponibles.map((s) => (
          <option key={s.id} value={s.id}>
            {s.fecha} · {s.valor} ({s.kpi})
          </option>
        ))}
      </Select>
      {snapshotId === '' && (
        <Input
          value={motivo}
          placeholder="Motivo de la falta de datos (queda registrado en el post-mortem)"
          maxLength={1000}
          onChange={(e) => setMotivo(e.target.value)}
        />
      )}
      <Textarea
        value={lectura}
        rows={2}
        placeholder="Lectura del criterio: base vs. final y qué se puede sostener con la serie"
        onChange={(e) => setLectura(e.target.value)}
      />
      <div>
        <Button
          size="sm"
          disabled={ocupado || criterioId === '' || (snapshotId === '' && motivo.trim() === '')}
          onClick={() => void guardar()}
        >
          Guardar resultado
        </Button>
      </div>
    </>
  );
}
