import { useEffect, useState } from 'react';
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
  borrarEntradaKpi,
  guardarBorradorDelReview,
  pausarProyectoDelReto,
  retomarProyectoDelReto,
  guardarResultadoDeCriterio,
} from '@/lib/medicion/medicion.functions';
import {
  CamposEntradaSchema,
  CargarCsvSchema,
  ETIQUETA_ESTADO_SNAPSHOT,
  ETIQUETA_FRECUENCIA,
  COLOR_VEREDICTO,
  ETIQUETA_VEREDICTO,
  etiquetaVentana,
  FRECUENCIAS,
  RegistrarSnapshotSchema,
  ResultadoCriterioSchema,
  arranqueDelResultado,
  faltaParaCompletar,
  BorradorReviewSchema,
  medicionPorAbrir,
  TOPE_JUSTIFICACION,
  TOPE_NARRATIVA,
  destinoAlRetomar,
  proyectoPorPausar,
  proyectoPorRetomar,
  narrativaDelBorrador,
  registryPorAbrir,
  reparosDelEsquema,
  VEREDICTOS,
  ventanaAbierta,
  postMortemPorAbrir,
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
  //
  // Y es propiedad del CONJUNTO, no del proyecto que se está mirando: `abrirMedicion` mueve
  // todos los proyectos del reto y el guard rechaza al hermano que no pueda seguirlo, así
  // que mirar solo este gate anunciaba lista una acción que la base iba a negar. La lista
  // la define la MISMA función de base que usan el guard y el diagnóstico del servicio, con
  // su motivo, porque decir «falta algo» sin decir qué manda a buscarlo a mano.
  const frenan = seguimiento.proyectosFrenan;
  const comunes = { workspaceId, seguimiento, onCambio, onError };

  return (
    <>
      <BloqueRegistry
        proyectoId={proyecto.id}
        {...comunes}
        criterios={proyecto.reto.criterios}
        esCurador={esCurador}
        esLead={esLead}
        puedeFirmar={rol === firmaG6}
        frenan={frenan}
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

/** Cómo se dice cada destino de la reanudación, en UN sitio. */
const ETIQUETA_DESTINO: Record<string, string> = {
  activo: 'vuelve a activo',
  'en-implementacion': 'vuelve a implementación',
  'en-medicion': 'entra en medición',
};

function BloqueRegistry({
  workspaceId,
  seguimiento,
  proyectoId,
  criterios,
  esCurador,
  esLead,
  puedeFirmar,
  frenan,
  onCambio,
  onError,
}: Comunes & {
  proyectoId: string;
  criterios: ProyectoMetodo['reto']['criterios'];
  esCurador: boolean;
  esLead: boolean;
  puedeFirmar: boolean;
  frenan: { codigo: string; motivo: string }[];
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

      {/* Espejo de `registry_insert`, que además del rol exige un reto VIVO: un reto
          cerrado bajo el esquema anterior puede no tener contrato, y el botón se ofrecía
          para que la política lo rechazara. */}
      {registryPorAbrir(seguimiento) && esCurador && (
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
            onQuitar={() =>
              void accion(
                () => borrarEntradaKpi({ data: { workspaceId, entradaId: entrada.id } }),
                'No se pudo quitar el KPI; intenta de nuevo',
              )
            }
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Lo que falta se DICE y con la fila nombrada, no se deja descubrir por un error
              del servidor. Apagar el botón sin decir qué falta cambiaría un error confuso
              por un callejón mudo, que es peor: la firma es el acto que congela el contrato
              delante del cliente. La lista la calcula `reparos_de_firma` en la base, la
              MISMA función que aplica el guard — un espejo copiado a mano aquí se quedaría
              corto en cuanto alguien tocara el guard. */}
          {seguimiento.reparosFirma.length > 0 && (
            <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
              Falta para poder firmarlo: {seguimiento.reparosFirma.join(' · ')}
            </span>
          )}
          <div>
            <Button
              size="sm"
              disabled={ocupado || seguimiento.reparosFirma.length > 0}
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
        </div>
      )}
      {registry && !firmado && !puedeFirmar && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Lo firma el sponsor en G6: es el compromiso del cliente con el dato.
        </span>
      )}

      {/* PARAR y RETOMAR: las dos rutas que le faltaban a la tabla de pares. Este slice
          declaró la máquina entera del proyecto y cuatro de sus ocho pares no los recorría
          ningún camino del producto —los dos de pausar y los dos de retomar antes de que el
          reto mida—, así que un reto activo con todos sus proyectos parados no tenía ni cómo
          abrir la medición ni cómo volver. Un par legal sin ruta es una promesa que la
          máquina hace y el producto no cumple. */}
      {esLead && proyectoPorPausar(seguimiento) && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            disabled={ocupado}
            onClick={() =>
              void accion(
                () => pausarProyectoDelReto({ data: { workspaceId, proyectoId } }),
                'No se pudo pausar el proyecto; intenta de nuevo',
              )
            }
          >
            Pausar el proyecto
          </Button>
        </div>
      )}
      {esLead && proyectoPorRetomar(seguimiento) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* El destino se ANUNCIA, no se elige: es una regla del método —manda dónde está el
              reto y, si aún no mide, si el plan estaba aprobado— y ofrecerlo como menú la
              habría convertido en una pantalla. */}
          <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-muted)' }}>
            {seguimiento.retoEstado === 'en-medicion'
              ? 'Su reto ya mide: al retomarlo el proyecto entra en medición con él, no por detrás. Hasta entonces el post mortem no puede cerrar el reto.'
              : seguimiento.proyectoG6Aprobado
                ? 'Se paró con su plan ya aprobado, así que vuelve a implementación.'
                : 'Se paró antes de aprobar el plan, así que vuelve a activo.'}
          </span>
          <div>
            <Button
              size="sm"
              disabled={ocupado}
              onClick={() =>
                void accion(
                  () => retomarProyectoDelReto({ data: { workspaceId, proyectoId } }),
                  'No se pudo retomar el proyecto; intenta de nuevo',
                )
              }
            >
              Retomar el proyecto ({ETIQUETA_DESTINO[destinoAlRetomar(seguimiento)]})
            </Button>
          </div>
        </div>
      )}

      {firmado && porAbrir && esLead && frenan.length === 0 && (
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
      {firmado && porAbrir && esLead && frenan.length > 0 && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          La medición mueve a todos los proyectos del reto a la vez, y estos no pueden
          entrar todavía: {frenan.map((p) => `${p.codigo} — ${p.motivo}`).join(' · ')}.
        </span>
      )}
    </Card>
  );
}

function FichaEntrada({
  entrada,
  editable,
  onEditar,
  onQuitar,
}: {
  entrada: EntradaDeRegistry;
  editable: boolean;
  onEditar: () => void;
  onQuitar: () => void;
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
          <>
            <Button size="sm" variant="ghost" onClick={onEditar}>
              Editar
            </Button>
            {/* Una entrada que SOBRA no se arregla editándola: el problema no es su contenido
                sino su presencia, y además bloquea la firma, que exige toda entrada completa.
                Solo mientras el contrato es borrador — firmar es lo que congela. */}
            <Button size="sm" variant="ghost" onClick={onQuitar}>
              Quitar
            </Button>
          </>
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
  // El botón lo decide el ESQUEMA sobre lo que se va a enviar, no una lista de condiciones
  // copiada a mano: el enlace del dashboard tiene que ser una URL y la línea base un
  // número, y las dos se dejaban pulsar para que el rechazo llegara del servidor.
  const reparos = reparosDelEsquema(CamposEntradaSchema, datos);

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
      {reparos.length > 0 && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
          {reparos.join(' · ')}
        </span>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          size="sm"
          disabled={ocupado || reparos.length > 0 || datos.criterioId === ''}
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
function maxFechaDeSnapshot(entrada: EntradaDeRegistry, hoy: string): string {
  // El «hoy» viene de la BASE, que es quien juzga: `snapshot_insert` acota la fecha con
  // `current_date`. Calcularlo en el navegador —da igual si en UTC o en el huso local— crea
  // un SEGUNDO calendario y no hay huso por petición que los concilie: al este de UTC la
  // pantalla ofrecía un día que el servicio rechaza por futuro, y al oeste escondía uno que
  // la base sí acepta. El espejo lee la regla; no la reproduce.
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
  // Espejo de `snapshot_insert`, y son TRES condiciones y no dos: quién escribe, el reto
  // MIDIENDO y el registry FIRMADO (SYS-22). La tercera faltaba y no era inalcanzable: el
  // reto HEREDADO ya está 'en-medicion' mientras su contrato sigue en borrador, así que
  // añadidas sus entradas el formulario se ofrecía entero para que la política rechazara
  // cada carga. Solo se mide lo firmado.
  const puedeCargar =
    (esCurador || entrada.soyPropietario) &&
    seguimiento.retoEstado === 'en-medicion' &&
    seguimiento.registry?.estado === 'firmado';
  // Un payload por escritura, armado una vez y leído por los dos: el espejo que decide si
  // el botón se ofrece y el envío. El valor métrico tiene FORMA —el schema y la columna
  // exigen un decimal con punto— y el botón solo miraba que no estuviera vacío: «cuarenta»
  // se dejaba pulsar para que el rechazo llegara del servidor.
  const snapshot = { workspaceId, entradaId: entrada.id, valor, fecha, nota };
  const reparosSnapshot = reparosDelEsquema(RegistrarSnapshotSchema, snapshot);
  const pegado = { workspaceId, entradaId: entrada.id, csv };
  const reparosCsv = reparosDelEsquema(CargarCsvSchema, pegado);

  async function enviarFormulario() {
    setOcupado(true);
    onError(null);
    try {
      const r = await cargarSnapshotDeFormulario({ data: snapshot });
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
      const r = await cargarSnapshotsPegados({ data: pegado });
      if (r.ok) {
        setRechazadas(r.rechazadas);
        // En el textarea queda SOLO lo que hay que reintentar (cabecera incluida, para que
        // se lea igual). Dejarlo entero invitaba a corregir la fila mala y volver a pulsar,
        // reenviando las que ya habían entrado — y un snapshot duplicado es permanente,
        // porque la serie es append-only y no hay borrado. La base lo impide igual (una
        // carga no corrige); esto es que la pantalla no lo proponga.
        setCsv(r.csvRestante);
        if (r.rechazadas.length === 0) setPegando(false);
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
      {/* El recorte se DICE. La serie viene con las más recientes (más las que un resultado
          ya referencia), y lo que se queda fuera es el arranque — justo el tramo contra el
          que se lee si el rediseño movió la aguja. Callarlo convertiría un gráfico incompleto
          en uno que parece completo y dice otra cosa. */}
      {entrada.totalSnapshots > entrada.snapshots.length && (
        <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--warn)' }}>
          Serie recortada: se muestran las {entrada.snapshots.length} lecturas más recientes
          de {entrada.totalSnapshots}. Las más antiguas —el arranque de la serie— no están en
          esta vista.
        </span>
      )}
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
            max={maxFechaDeSnapshot(entrada, seguimiento.hoy)}
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
            disabled={ocupado || reparosSnapshot.length > 0}
            onClick={() => void enviarFormulario()}
          >
            Registrar
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setPegando((p) => !p)}>
            {pegando ? 'Cerrar CSV' : 'Pegar CSV'}
          </Button>
        </div>
      )}
      {/* Y se dice POR QUÉ no se puede registrar, en cuanto hay algo escrito: con el botón
          apagado y sin motivo, «no puedo guardar» es tan opaco como el error del servidor
          que esto evita. En blanco no se dice nada — un formulario que riñe antes de que
          nadie escriba es ruido. */}
      {puedeCargar && reparosSnapshot.length > 0 && (valor !== '' || fecha !== '' || nota !== '') && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
          {reparosSnapshot.join(' · ')}
        </span>
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
            <Button
              size="sm"
              disabled={ocupado || csv.trim() === '' || reparosCsv.length > 0}
              onClick={() => void enviarCsv()}
            >
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
  // Espejo EXACTO de lo que `review_insert` acepta, y son DOS condiciones y no una: las
  // ventanas del contrato cerradas Y el reto MIDIENDO. Con solo la primera, un reto cuyas
  // ventanas ya vencieron pero que todavía no abrió su medición —el caso del reto heredado
  // mientras se repara, y el de cualquiera que firme con ventanas ya pasadas— dibujaba el
  // botón y la política lo rechazaba en cada clic. Media condición es un botón que miente.
  const midiendo = seguimiento.retoEstado === 'en-medicion';
  const ventanasListas = ventanasCerradas(seguimiento.entradas);
  const habilitado = postMortemPorAbrir(seguimiento);
  const [ocupado, setOcupado] = useState(false);
  // NULL de arranque, y no es un detalle de formulario: el veredicto es un DICTAMEN. Con el
  // selector prerrelleno, «Guardar borrador» persistía un veredicto que el lead nunca eligió
  // —y desde que el borrador se guarda de verdad, eso convierte en silencio una redacción a
  // medias en un dictamen auditado—. La columna se hizo nullable precisamente para que un
  // borrador no tenga que elegir; que la pantalla elija por él deshace ese contrato. Elegir
  // es del CIERRE: sin veredicto, `CompletarReviewSchema` no valida y el botón de completar
  // no se ofrece — lo dice ya el espejo, sin condición nueva.
  const [veredicto, setVeredicto] = useState<VeredictoSlug | null>(null);
  const [contribucion, setContribucion] = useState('');
  const [factores, setFactores] = useState('');
  const [hipotesis, setHipotesis] = useState('');
  const [aprendizajes, setAprendizajes] = useState('');
  const [experimental, setExperimental] = useState(false);
  const [justificacion, setJustificacion] = useState('');
  // El BORRADOR se arma UNA vez y lo leen los dos: el espejo que decide si el botón se
  // ofrece y el envío que lo manda. Con dos objetos distintos —uno para preguntar y otro
  // para escribir— la pregunta se responde sobre algo que no es lo que se envía, que es
  // como el «diseño experimental suficiente» sin justificar llegaba a pulsarse.
  const borrador = {
    workspaceId,
    reviewId: review?.id ?? '',
    veredicto,
    contribucion,
    factoresExternos: factores,
    hipotesisAbiertas: hipotesis,
    aprendizajes,
    disenoExperimentalSuficiente: experimental,
    disenoExperimentalJustificacion: justificacion,
  };
  // Qué le falta al post mortem para poder completarse: lo que le reprocha el ESQUEMA
  // —contribución escrita, justificación si se declara diseño experimental— y lo que le
  // reprocharía el guard del cierre —todo criterio con su resultado, y un «logrado» sin
  // criterios sin dato final—. Las dos superficies que pueden rechazar la escritura.
  const falta = faltaParaCompletar(seguimiento, borrador);
  // Y lo que le reprocha el esquema del BORRADOR, que es otra escritura y otro botón. Guardar
  // existe justamente para no perder texto, así que un guardado que el validador rechaza
  // —por pasarse de los topes— pierde el borrador entero: la ironía exacta que el botón vino
  // a evitar. Mismo `reparosDelEsquema` que el resto de los controles del slice, aplicado al
  // control nuevo; los `maxLength` de los textareas impiden llegar ahí, y esto lo dice si se
  // llega por pegado.
  const reparosBorrador = reparosDelEsquema(BorradorReviewSchema, borrador);

  // El formulario se HIDRATA del borrador guardado, y no es comodidad: completar escribe
  // las cinco columnas de la narrativa a la vez, así que arrancando en vacío bastaba abrir
  // la pantalla y elegir veredicto para BORRAR la contribución, los factores, las hipótesis
  // y los aprendizajes que ya se habían redactado — y el review completado es inmutable,
  // así que lo que se pierde ahí no vuelve. Se sincroniza por `id` para recoger también el
  // review recién abierto sin pisar lo que se esté escribiendo entre tanto.
  const reviewId = review?.id ?? null;
  useEffect(() => {
    if (!review) return;
    const borrador = narrativaDelBorrador(review);
    setVeredicto(borrador.veredicto);
    setContribucion(borrador.contribucion);
    setFactores(borrador.factoresExternos);
    setHipotesis(borrador.hipotesisAbiertas);
    setAprendizajes(borrador.aprendizajes);
    setExperimental(borrador.disenoExperimentalSuficiente);
    setJustificacion(borrador.disenoExperimentalJustificacion);
    // Deliberadamente por `id` y no por el contenido: recargar la proyección tras cada
    // escritura no debe reescribir el campo que el lead tiene a medias delante.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);

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

  /** Guardar sin completar: misma forma que `completar`, sin la parte irreversible. */
  async function guardarBorrador() {
    if (!review) return;
    setOcupado(true);
    onError(null);
    try {
      const r = await guardarBorradorDelReview({ data: borrador });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo guardar el borrador; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  async function completar() {
    // El veredicto se estrecha aquí y no en el tipo del borrador: completar EXIGE dictamen
    // —lo dice `CompletarReviewSchema` y por eso el botón está apagado sin él— y guardar no.
    if (!review || borrador.veredicto === null) return;
    const payload = { ...borrador, veredicto: borrador.veredicto };
    setOcupado(true);
    onError(null);
    try {
      const r = await completarReviewDelReto({ data: payload });
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

      {/* Y el motivo que se enseña es el que toca: decirle «faltan 0 días de ventana» a
          quien todavía no ha abierto la medición es mandarlo a mirar donde no está. */}
      {!review && !midiendo && (
        <span style={{ font: '400 12.5px/1.55 var(--font-sans)', color: 'var(--text-muted)' }}>
          El post-mortem se abre sobre un reto que ya mide: este todavía no ha abierto su
          medición.
        </span>
      )}
      {!review && midiendo && !ventanasListas && (
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
                  maxLength={TOPE_NARRATIVA}
                  rows={3}
                  placeholder="Contribución del rediseño: qué cambió, con qué evidencia de la serie (lenguaje de contribución, no causal)"
                  onChange={(e) => setContribucion(e.target.value)}
                />
                <Textarea
                  value={factores}
                  maxLength={TOPE_NARRATIVA}
                  rows={2}
                  placeholder="Factores externos conocidos que pudieron mover el KPI"
                  onChange={(e) => setFactores(e.target.value)}
                />
                <Textarea
                  value={hipotesis}
                  maxLength={TOPE_NARRATIVA}
                  rows={2}
                  placeholder="Hipótesis abiertas que quedan para el próximo reto"
                  onChange={(e) => setHipotesis(e.target.value)}
                />
                <Textarea
                  value={aprendizajes}
                  maxLength={TOPE_NARRATIVA}
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
                    maxLength={TOPE_JUSTIFICACION}
                    rows={2}
                    placeholder="Justificación del diseño experimental (grupo de control, aleatorización, corte temporal…)"
                    onChange={(e) => setJustificacion(e.target.value)}
                  />
                )}
                <Select
                  value={veredicto ?? ''}
                  onChange={(e) =>
                    setVeredicto(e.target.value === '' ? null : (e.target.value as VeredictoSlug))
                  }
                >
                  {/* La opción vacía existe para poder NO haber elegido: es el estado en el
                      que nace un post mortem y en el que se guarda mientras se redacta. */}
                  <option value="">Veredicto: sin elegir todavía</option>
                  {VEREDICTOS.map((v) => (
                    <option key={v} value={v}>
                      Veredicto: {ETIQUETA_VEREDICTO[v]}
                    </option>
                  ))}
                </Select>
                {/* Lo que falta se DICE, no se deja descubrir por un error: el resultado
                    de algún criterio, un «logrado» con criterios sin dato final, la
                    contribución en blanco o el diseño experimental declarado sin
                    justificar. Las dos superficies que rechazan la escritura —el esquema y
                    el guard del cierre— salen de un solo predicado, que vive con sus
                    hermanos en `medicion.schemas` porque es donde los tests lo alcanzan. */}
                {reparosBorrador.length > 0 && (
                  <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
                    No se puede guardar todavía: {reparosBorrador.join(' · ')}
                  </span>
                )}
                {falta.length > 0 && (
                  <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
                    Falta para poder completarlo: {falta.join(' · ')}
                  </span>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {/* GUARDAR sin completar. Completar es irreversible, así que sin esto la
                      única forma de conservar los cinco campos narrativos era cerrar el reto:
                      navegar, recargar o toparse con una validación tiraba texto redactado a
                      mano, que es lo caro de un post mortem — y el review completado es
                      inmutable, así que no vuelve. La base ya admitía y auditaba el borrador
                      y la pantalla ya lo hidrataba: faltaba lo del medio. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={ocupado || reparosBorrador.length > 0}
                    onClick={() => void guardarBorrador()}
                  >
                    Guardar borrador
                  </Button>
                  <Button
                    size="sm"
                    disabled={ocupado || falta.length > 0}
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
  // Arranca del resultado YA GUARDADO, no en vacío: guardar es un UPSERT de las tres
  // columnas, así que un formulario en blanco convertía «cambio el snapshot final» en
  // «borro la lectura» y obligaba a reteclear el motivo al editar un resultado sin dato.
  // No hace falta efecto: este bloque se REMONTA con el criterio (ver el `key` de arriba),
  // así que el inicializador corre una vez por cada criterio elegido.
  const previo = arranqueDelResultado(seguimiento.review, criterioId);
  const [snapshotId, setSnapshotId] = useState(previo.snapshotFinalId);
  const [lectura, setLectura] = useState(previo.lectura);
  const [motivo, setMotivo] = useState(previo.sinDatosMotivo);
  const [ocupado, setOcupado] = useState(false);
  // Solo snapshots del criterio elegido: la política rechaza cualquier otro.
  const disponibles = seguimiento.entradas
    .filter((e) => e.criterioId === criterioId)
    .flatMap((e) => e.snapshots.map((s) => ({ ...s, kpi: e.nombre })));

  // Mismo objeto para preguntar y para escribir. El esquema exige EXACTAMENTE una de las
  // dos —snapshot final o motivo de la falta de datos—, y el botón solo miraba la mitad
  // «ninguna de las dos»: con las dos puestas se dejaba pulsar.
  const resultado = {
    workspaceId,
    reviewId,
    criterioId,
    snapshotFinalId: snapshotId === '' ? null : snapshotId,
    lectura,
    sinDatosMotivo: motivo,
  };
  const reparos = reparosDelEsquema(ResultadoCriterioSchema, resultado);

  async function guardar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await guardarResultadoDeCriterio({ data: resultado });
      if (r.ok) {
        // Y NO se vacían los campos al guardar: la fila existe ahora con esos valores, así
        // que dejarlos en blanco haría que el siguiente guardado del mismo criterio —el
        // bloque no se remonta porque el criterio no cambió— los borrara.
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
      {reparos.length > 0 && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--warn)' }}>
          {reparos.join(' · ')}
        </span>
      )}
      <div>
        <Button
          size="sm"
          disabled={ocupado || criterioId === '' || reparos.length > 0}
          onClick={() => void guardar()}
        >
          Guardar resultado
        </Button>
      </div>
    </>
  );
}
