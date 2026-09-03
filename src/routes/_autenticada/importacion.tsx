import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';
import { hoyCalendario } from '@/lib/fecha-calendario';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tag } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import { Wordmark } from '@/components/ui/Wordmark';
import { DescargaArchivo } from '@/components/evidencia/DescargaArchivo';
import {
  adjuntarArchivoAItem,
  aprobarItemImportacion,
  bandejaDeImportacion,
  contenidoDeItemImportacion,
  crearItemImportacion,
  rechazarItemImportacion,
  retirarArchivoDeItem,
} from '@/lib/evidencia/evidencia.functions';
import {
  ETIQUETA_TIPO_FUENTE,
  ROLES_CURADORES,
  TIPOS_FUENTE,
  type ItemBandeja,
  type TipoFuente,
} from '@/lib/evidencia/evidencia.schemas';
import {
  bytesABase64,
  EXTENSIONES_PERMITIDAS,
  MAX_ARCHIVO_BYTES,
  MAX_ARCHIVOS_POR_ITEM,
  tipoDeclaradoDeArchivo,
  validarTextoImportado,
  verificarArchivo,
} from '@/lib/evidencia/sanitizacion';

/**
 * Bandeja de importación (SPEC-03, J1 «arranque en frío», versión manual):
 * pegar texto o registrar referencias, y curar — aprobar con las cinco dimensiones
 * o rechazar. Nada entra como evidencia sin acción humana explícita (SYS-16).
 */
export const Route = createFileRoute('/_autenticada/importacion')({
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: ({ context }) => {
    const workspaceId = context.membresiaActiva?.workspaceId;
    return workspaceId ? bandejaDeImportacion({ data: { workspaceId } }) : null;
  },
  component: PantallaImportacion,
});

const etiqueta: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const COLOR_ESTADO: Record<ItemBandeja['estado'], string> = {
  pendiente: 'var(--warn)',
  aprobado: 'var(--accent)',
  rechazado: 'var(--text-faint)',
};

const TEXTO_ESTADO: Record<ItemBandeja['estado'], string> = {
  pendiente: 'pendiente de curaduría',
  aprobado: 'aprobado → evidencia',
  rechazado: 'rechazado',
};

function PantallaImportacion() {
  const datos = Route.useLoaderData();
  const { membresiaActiva } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  // Solo la boutique decide (RF-03.4): a los demás roles la tarjeta no les ofrece
  // controles que el server rechazaría de todos modos (capa 2 + RLS).
  const rol = membresiaActiva?.rol ?? '';
  const puedeCurar = (ROLES_CURADORES as readonly string[]).includes(rol);
  const [error, setError] = useState<string | null>(null);
  // Páginas siguientes de pendientes cargadas bajo demanda (el loader trae la primera).
  const [masPendientes, setMasPendientes] = useState<ItemBandeja[]>([]);
  const [hayMasLocal, setHayMasLocal] = useState<boolean | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);

  const pendientes = datos ? [...datos.pendientes, ...masPendientes] : [];
  const hayMas = hayMasLocal ?? datos?.hayMasPendientes ?? false;

  async function refrescar() {
    setMasPendientes([]);
    setHayMasLocal(null);
    await router.invalidate();
  }

  async function cargarMas() {
    if (!datos || pendientes.length === 0) return;
    setCargandoMas(true);
    setError(null);
    try {
      const ultimo = pendientes[pendientes.length - 1]!;
      const r = await bandejaDeImportacion({
        data: { workspaceId: datos.workspaceId, antesDe: ultimo.id },
      });
      if (r) {
        setMasPendientes((previos) => [...previos, ...r.pendientes]);
        setHayMasLocal(r.hayMasPendientes);
      }
    } catch {
      setError('No se pudo cargar más pendientes; intenta de nuevo');
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
            Bandeja de importación
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/app' })}>
          ← Volver al loop
        </Button>
      </div>

      <main style={{ maxWidth: 860, margin: '0 auto', padding: '28px 24px 60px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {!datos && (
          <Card style={{ padding: 24 }}>
            <span style={{ font: '400 13.5px var(--font-sans)', color: 'var(--text-muted)' }}>
              Aún no perteneces a ningún workspace.
            </span>
          </Card>
        )}
        {datos && (
          <>
            <FormularioNuevoItem
              workspaceId={datos.workspaceId}
              onCreado={refrescar}
              onError={setError}
            />
            {error && (
              <span role="alert" style={{ font: '500 13px var(--font-sans)', color: 'var(--danger)' }}>
                {error}
              </span>
            )}
            <div style={{ ...etiqueta, paddingTop: 6 }}>
              {pendientes.length === 0
                ? 'Sin pendientes de curaduría'
                : `${pendientes.length}${hayMas ? '+' : ''} pendientes de curaduría`}
            </div>
            {pendientes.map((item) => (
              <TarjetaItem
                key={item.id}
                item={item}
                workspaceId={datos.workspaceId}
                puedeCurar={puedeCurar}
                onCambio={refrescar}
                onError={setError}
              />
            ))}
            {hayMas && (
              <div>
                <Button size="sm" variant="secondary" disabled={cargandoMas} onClick={() => void cargarMas()}>
                  {cargandoMas ? 'Cargando…' : 'Cargar pendientes más antiguos'}
                </Button>
              </div>
            )}
            {datos.decididas.length > 0 && (
              <>
                <div style={{ ...etiqueta, paddingTop: 14 }}>Decididas recientes</div>
                {datos.decididas.map((item) => (
                  <TarjetaItem
                    key={item.id}
                    item={item}
                    workspaceId={datos.workspaceId}
                    puedeCurar={puedeCurar}
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

function FormularioNuevoItem({
  workspaceId,
  onCreado,
  onError,
}: {
  workspaceId: string;
  onCreado: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [titulo, setTitulo] = useState('');
  const [tipoFuente, setTipoFuente] = useState<TipoFuente>('documento');
  const [referencia, setReferencia] = useState('');
  const [contenido, setContenido] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Texto pegado, referencia al original, o ambos — pero al menos uno (mismo
    // criterio que valida el schema en el server).
    if (contenido.trim().length === 0 && referencia.trim().length === 0) {
      onError('Pega el contenido o indica al menos la referencia del original');
      return;
    }
    // Contenido no confiable (RF-03.2): el texto entra CRUDO —los offsets de las citas
    // dependen de que no lo toquemos— pero los controles y overrides bidi se rechazan.
    // El schema del server y un CHECK de la base repiten esta validación; aquí solo se
    // adelanta el mensaje.
    for (const campo of [titulo, referencia, contenido]) {
      const v = validarTextoImportado(campo);
      if (!v.ok) {
        onError(v.motivo);
        return;
      }
    }
    setEnviando(true);
    onError(null);
    try {
      const r = await crearItemImportacion({
        data: { workspaceId, titulo, tipoFuente, referencia, contenido },
      });
      if (r.ok) {
        setTitulo('');
        setReferencia('');
        setContenido('');
        await onCreado();
      } else {
        onError(r.error);
      }
    } catch {
      onError('No se pudo registrar el item; intenta de nuevo');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card style={{ padding: 24 }}>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span style={{ font: '700 15px var(--font-sans)', color: 'var(--ink)' }}>
          Importar material
        </span>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Título</span>
            <Input required maxLength={300} value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Estudio CX apertura de cuenta (PDF)" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={etiqueta}>Tipo de fuente</span>
            <Select value={tipoFuente} onChange={(e) => setTipoFuente(e.target.value as TipoFuente)}>
              {TIPOS_FUENTE.map((t) => (
                <option key={t} value={t}>
                  {ETIQUETA_TIPO_FUENTE[t]}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Referencia (URL o ubicación del original)</span>
          <Input maxLength={2000} value={referencia} onChange={(e) => setReferencia(e.target.value)} placeholder="https://… o «carpeta compartida / informe Q2»" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Contenido (texto pegado — opcional si registras la referencia)</span>
          <Textarea
            rows={5}
            maxLength={100000}
            value={contenido}
            onChange={(e) => setContenido(e.target.value)}
            placeholder="Pega aquí el texto relevante del material…"
          />
        </label>
        <div>
          <Button type="submit" disabled={enviando}>
            {enviando ? 'Registrando…' : 'Registrar en la bandeja'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TarjetaItem({
  item,
  workspaceId,
  puedeCurar,
  onCambio,
  onError,
}: {
  item: ItemBandeja;
  workspaceId: string;
  puedeCurar: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [curando, setCurando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  // Rechazar sella el item de forma INMUTABLE: nunca a un solo clic.
  const [confirmandoRechazo, setConfirmandoRechazo] = useState(false);
  const [contenidoCompleto, setContenidoCompleto] = useState<string | null>(null);
  const [expandido, setExpandido] = useState(false);
  const [cargandoContenido, setCargandoContenido] = useState(false);

  // El extracto es solo una vista previa: la decisión de curaduría exige poder
  // inspeccionar TODO lo importado, así que el contenido completo se trae bajo demanda.
  async function verCompleto() {
    if (contenidoCompleto !== null) {
      setExpandido(true);
      return;
    }
    setCargandoContenido(true);
    onError(null);
    try {
      const r = await contenidoDeItemImportacion({ data: { workspaceId, itemId: item.id } });
      if (r?.contenido != null) {
        setContenidoCompleto(r.contenido);
        setExpandido(true);
      } else {
        onError('No se pudo cargar el contenido completo');
      }
    } catch {
      onError('No se pudo cargar el contenido completo; intenta de nuevo');
    } finally {
      setCargandoContenido(false);
    }
  }

  async function rechazar() {
    setOcupado(true);
    onError(null);
    try {
      const r = await rechazarItemImportacion({ data: { workspaceId, itemId: item.id } });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo rechazar; intenta de nuevo');
    } finally {
      setOcupado(false);
      setConfirmandoRechazo(false);
    }
  }

  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: '700 14px var(--font-sans)', color: 'var(--ink)', flex: 1, minWidth: 200 }}>
          {item.titulo}
        </span>
        <Tag>{ETIQUETA_TIPO_FUENTE[item.tipoFuente]}</Tag>
        <span style={{ font: '600 11.5px var(--font-sans)', color: COLOR_ESTADO[item.estado] }}>
          {TEXTO_ESTADO[item.estado]}
        </span>
      </div>
      <p style={{ font: '400 12px/1.5 var(--font-mono)', color: 'var(--text-muted)', margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {expandido && contenidoCompleto !== null ? contenidoCompleto : item.extracto}
        {!expandido && item.truncado ? '…' : ''}
      </p>
      {item.truncado && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            disabled={cargandoContenido}
            onClick={() => (expandido ? setExpandido(false) : void verCompleto())}
          >
            {cargandoContenido ? 'Cargando…' : expandido ? 'Contraer' : 'Ver contenido completo'}
          </Button>
        </div>
      )}
      {item.referencia && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)', overflowWrap: 'anywhere' }}>
          Ref: {item.referencia}
        </span>
      )}
      {item.archivos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Originales adjuntos ({item.archivos.length})</span>
          {item.archivos.map((a) => (
            <DescargaArchivo
              key={a.id}
              archivo={a}
              workspaceId={workspaceId}
              onError={onError}
              // Un adjunto solo se retira mientras el material siga pendiente: lo curado
              // ya es evidencia y su original no se toca (la política RLS lo impone).
              onRetirar={
                item.estado === 'pendiente'
                  ? async () => {
                      const r = await retirarArchivoDeItem({
                        data: { workspaceId, archivoId: a.id },
                      });
                      if (r.ok) await onCambio();
                      else onError(r.error);
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
      {item.estado === 'pendiente' && item.archivos.length < MAX_ARCHIVOS_POR_ITEM && (
        <SubirAdjunto
          workspaceId={workspaceId}
          itemId={item.id}
          onSubido={onCambio}
          onError={onError}
        />
      )}
      {item.estado === 'pendiente' && !puedeCurar && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          La curaduría la decide la boutique (lead o diseñador).
        </span>
      )}
      {item.estado === 'pendiente' && puedeCurar && !curando && !confirmandoRechazo && (
        <div style={{ display: 'flex', gap: 10 }}>
          <Button size="sm" onClick={() => setCurando(true)}>
            Curar y aprobar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmandoRechazo(true)}>
            Rechazar
          </Button>
        </div>
      )}
      {item.estado === 'pendiente' && puedeCurar && !curando && confirmandoRechazo && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ font: '500 12.5px var(--font-sans)', color: 'var(--danger)' }}>
            El rechazo es definitivo: el item queda sellado y no podrá aprobarse.
          </span>
          <Button size="sm" disabled={ocupado} onClick={rechazar}>
            {ocupado ? 'Rechazando…' : 'Confirmar rechazo'}
          </Button>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setConfirmandoRechazo(false)}>
            Cancelar
          </Button>
        </div>
      )}
      {item.estado === 'pendiente' && puedeCurar && curando && (
        <FormularioCuraduria
          workspaceId={workspaceId}
          itemId={item.id}
          onListo={onCambio}
          onCancelar={() => setCurando(false)}
          onError={onError}
        />
      )}
    </Card>
  );
}

/**
 * Alta de un adjunto (RF-03.1). Tres capas de validación de formato, deliberadamente
 * repetidas: aquí (mensaje inmediato), en el servicio (allowlist + firma mágica sobre los
 * bytes reales) y en el esquema (CHECK de tipo, tamaño y nombre). El `accept` del input
 * es comodidad, nunca seguridad: se puede desactivar en el diálogo del sistema.
 */
function SubirAdjunto({
  workspaceId,
  itemId,
  onSubido,
  onError,
}: {
  workspaceId: string;
  itemId: string;
  onSubido: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [subiendo, setSubiendo] = useState(false);

  async function elegido(archivo: File | undefined) {
    if (!archivo) return;
    setSubiendo(true);
    onError(null);
    try {
      const tipoMime = tipoDeclaradoDeArchivo(archivo.name, archivo.type);
      if (!tipoMime) {
        onError(`Formato no permitido: ${archivo.name}`);
        return;
      }
      if (archivo.size > MAX_ARCHIVO_BYTES) {
        onError(`El archivo supera los ${MAX_ARCHIVO_BYTES / 1024 / 1024} MB permitidos`);
        return;
      }
      const bytes = new Uint8Array(await archivo.arrayBuffer());
      const veredicto = verificarArchivo(bytes, tipoMime);
      if (!veredicto.ok) {
        onError(veredicto.motivo);
        return;
      }
      const r = await adjuntarArchivoAItem({
        data: {
          workspaceId,
          itemId,
          nombre: archivo.name,
          tipoMime,
          contenidoBase64: bytesABase64(bytes),
        },
      });
      if (r.ok) await onSubido();
      else onError(r.error);
    } catch {
      onError('No se pudo adjuntar el archivo; intenta de nuevo');
    } finally {
      setSubiendo(false);
    }
  }

  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        font: '400 12px var(--font-sans)',
        color: 'var(--text-muted)',
      }}
    >
      <input
        type="file"
        accept={EXTENSIONES_PERMITIDAS}
        disabled={subiendo}
        onChange={(e) => {
          void elegido(e.target.files?.[0]);
          e.target.value = '';
        }}
        style={{ font: '400 12px var(--font-sans)' }}
      />
      {subiendo ? 'Subiendo…' : `Adjuntar el original (máx. ${MAX_ARCHIVO_BYTES / 1024 / 1024} MB)`}
    </label>
  );
}

function FormularioCuraduria({
  workspaceId,
  itemId,
  onListo,
  onCancelar,
  onError,
}: {
  workspaceId: string;
  itemId: string;
  onListo: () => Promise<void>;
  onCancelar: () => void;
  onError: (e: string | null) => void;
}) {
  // Fecha CALENDÁRICA local (no UTC): a las 8pm de Bogotá el default no debe ser «mañana».
  // La regla vive en `hoyCalendario` y no aquí: estaba escrita dos veces y la otra copia
  // —la del selector de snapshots— usaba UTC, que es exactamente el defecto que este
  // comentario describía.
  const hoy = hoyCalendario();
  const [fecha, setFecha] = useState(hoy);
  const [recoleccion, setRecoleccion] = useState('');
  const [confianza, setConfianza] = useState<'alta' | 'media' | 'baja'>('media');
  const [confidencialidad, setConfidencialidad] = useState<'interna' | 'cliente' | 'restringida'>('cliente');
  const [derivada, setDerivada] = useState(false);
  const [consentimiento, setConsentimiento] = useState(false);
  const [esEstadoActual, setEsEstadoActual] = useState(false);
  const [resumen, setResumen] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    onError(null);
    try {
      const r = await aprobarItemImportacion({
        data: {
          workspaceId,
          itemId,
          esEstadoActual,
          resumen,
          dimensiones: {
            // Calendárica pura (AAAA-MM-DD): viaja como texto — cualquier instante se
            // correría de día en algún huso al formatearla.
            fecha,
            recoleccion,
            derivada,
            confianza,
            consentimiento,
            confidencialidad,
            segmentoIds: [],
          },
        },
      });
      if (r.ok) await onListo();
      else onError(r.error);
    } catch {
      onError('No se pudo aprobar; intenta de nuevo');
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
        Dimensiones de la evidencia (RF-03.5)
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Fecha del material</span>
          <Input type="date" required value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Confianza</span>
          <Select value={confianza} onChange={(e) => setConfianza(e.target.value as typeof confianza)}>
            <option value="alta">Alta</option>
            <option value="media">Media</option>
            <option value="baja">Baja</option>
          </Select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={etiqueta}>Confidencialidad</span>
          <Select value={confidencialidad} onChange={(e) => setConfidencialidad(e.target.value as typeof confidencialidad)}>
            <option value="interna">Interna</option>
            <option value="cliente">Cliente</option>
            <option value="restringida">Restringida</option>
          </Select>
        </label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={etiqueta}>Método de recolección</span>
        <Input
          required
          maxLength={300}
          value={recoleccion}
          onChange={(e) => setRecoleccion(e.target.value)}
          placeholder="p. ej. estudio CX del proveedor, funnel de analítica, entrevista 1:1…"
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={etiqueta}>Resumen curado (opcional)</span>
        <Input maxLength={2000} value={resumen} onChange={(e) => setResumen(e.target.value)} placeholder="Qué aporta esta evidencia" />
      </label>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', font: '400 12.5px var(--font-sans)', color: 'var(--text-body)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox checked={derivada} onChange={(e) => setDerivada(e.target.checked)} />
          Evidencia derivada (no primaria)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox checked={consentimiento} onChange={(e) => setConsentimiento(e.target.checked)} />
          Consentimiento registrado
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox checked={esEstadoActual} onChange={(e) => setEsEstadoActual(e.target.checked)} />
          Describe el estado ACTUAL del servicio
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button type="submit" disabled={enviando}>
          {enviando ? 'Aprobando…' : 'Aprobar como evidencia'}
        </Button>
        <Button variant="ghost" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
