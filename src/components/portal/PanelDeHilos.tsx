import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { ETIQUETA_ROL } from '@/lib/auth/auth.schemas';
import { ROLES_CURADORES } from '@/lib/evidencia/evidencia.schemas';
import {
  abrirHiloDelPortal,
  comentarEnHilo,
  resolverHiloDelPortal,
} from '@/lib/portal/portal.functions';
import { CUERPO_MAX, type HiloDeObjeto, type ReferenciaObjeto } from '@/lib/portal/portal.schemas';

/**
 * Portal de comentarios sobre un objeto presentable (SPEC-01, RF-01.5): hilos con
 * identidad, rol y timestamp, comentables por cualquier miembro —el portal es el canal
 * del cliente, sponsor y stakeholder incluidos— y resolubles por curadores. Los controles
 * que un rol no tiene ni se dibujan; la autoridad es la RLS, esto es cortesía de UI.
 */

const micro: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 10.5,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

/** El instante llega como texto de la base (AAAA-MM-DD HH:MM:SS+00): se muestra hasta el
 * minuto, sin re-parsear a Date (que lo movería de día en husos extremos). */
function sello(instante: string): string {
  return instante.slice(0, 16);
}

export function PanelDeHilos({
  workspaceId,
  objeto,
  hilos,
  rol,
  onCambio,
}: {
  workspaceId: string;
  objeto: ReferenciaObjeto;
  /** Hilos YA filtrados para este objeto (la pantalla los pide todos de una vez). */
  hilos: HiloDeObjeto[];
  rol: string;
  onCambio: () => Promise<void>;
}) {
  const [abriendo, setAbriendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // agente-ai es actor de plataforma: no publica en el portal (I4/SYS-18).
  const puedeComentar = rol !== '' && rol !== 'agente-ai';
  const puedeResolver = (ROLES_CURADORES as readonly string[]).includes(rol);
  const abiertos = hilos.filter((h) => h.estado === 'abierto').length;

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        paddingTop: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={micro}>
          Portal ·{' '}
          {hilos.length === 0
            ? 'sin hilos'
            : `${hilos.length} ${hilos.length === 1 ? 'hilo' : 'hilos'} · ${abiertos} abiertos`}
        </span>
        {puedeComentar && !abriendo && (
          <Button size="sm" variant="ghost" onClick={() => setAbriendo(true)}>
            Abrir hilo
          </Button>
        )}
      </div>

      {error && (
        <span role="alert" style={{ font: '500 12.5px var(--font-sans)', color: 'var(--danger)' }}>
          {error}
        </span>
      )}

      {abriendo && (
        <FormularioCuerpo
          etiqueta="Abrir hilo"
          placeholder="Qué quieres discutir sobre este objeto…"
          onEnviar={async (cuerpo) => {
            const r = await abrirHiloDelPortal({ data: { workspaceId, objeto, cuerpo } });
            if (!r.ok) return r.error;
            setAbriendo(false);
            await onCambio();
            return null;
          }}
          onCancelar={() => setAbriendo(false)}
          onError={setError}
        />
      )}

      {hilos.map((hilo) => (
        <Hilo
          key={hilo.id}
          workspaceId={workspaceId}
          hilo={hilo}
          puedeComentar={puedeComentar}
          puedeResolver={puedeResolver}
          onCambio={onCambio}
          onError={setError}
        />
      ))}
    </div>
  );
}

function Hilo({
  workspaceId,
  hilo,
  puedeComentar,
  puedeResolver,
  onCambio,
  onError,
}: {
  workspaceId: string;
  hilo: HiloDeObjeto;
  puedeComentar: boolean;
  puedeResolver: boolean;
  onCambio: () => Promise<void>;
  onError: (e: string | null) => void;
}) {
  const [comentando, setComentando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const resuelto = hilo.estado === 'resuelto';

  async function cambiarEstado(accion: 'resolver' | 'reabrir') {
    setOcupado(true);
    onError(null);
    try {
      const r = await resolverHiloDelPortal({ data: { workspaceId, hiloId: hilo.id, accion } });
      if (r.ok) await onCambio();
      else onError(r.error);
    } catch {
      onError('No se pudo actualizar el hilo; intenta de nuevo');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--r-sm)',
        opacity: resuelto ? 0.75 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            font: '600 11.5px var(--font-sans)',
            color: resuelto ? 'var(--accent)' : 'var(--warn)',
          }}
        >
          {resuelto
            ? `resuelto${hilo.resueltoPorNombre ? ` · ${hilo.resueltoPorNombre}` : ''}${hilo.resueltoEn ? ` · ${sello(hilo.resueltoEn)}` : ''}`
            : 'abierto'}
        </span>
        <span style={{ ...micro, flex: 1, minWidth: 120 }}>
          abrió {hilo.abiertoPorNombre} · {sello(hilo.creadoEn)}
        </span>
        {puedeResolver && (
          <Button
            size="sm"
            variant="ghost"
            disabled={ocupado}
            onClick={() => void cambiarEstado(resuelto ? 'reabrir' : 'resolver')}
          >
            {resuelto ? 'Reabrir' : 'Resolver'}
          </Button>
        )}
      </div>

      {hilo.comentarios.map((c) => (
        <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ font: '600 11.5px var(--font-sans)', color: 'var(--text-muted)' }}>
            {c.autorNombre} · {ETIQUETA_ROL[c.autorRol] ?? c.autorRol} · {sello(c.creadoEn)}
          </span>
          <span
            style={{
              font: '400 13px/1.5 var(--font-sans)',
              color: 'var(--text-body)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {c.cuerpo}
          </span>
        </div>
      ))}
      {hilo.hayMasComentarios && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          … el hilo tiene más comentarios de los que caben en esta vista.
        </span>
      )}

      {resuelto && (
        <span style={{ font: '400 12px var(--font-sans)', color: 'var(--text-faint)' }}>
          Hilo resuelto: la boutique debe reabrirlo para seguir la conversación.
        </span>
      )}
      {!resuelto && puedeComentar && !comentando && (
        <div>
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setComentando(true)}>
            Comentar
          </Button>
        </div>
      )}
      {!resuelto && comentando && (
        <FormularioCuerpo
          etiqueta="Comentar"
          placeholder="Tu comentario…"
          onEnviar={async (cuerpo) => {
            const r = await comentarEnHilo({ data: { workspaceId, hiloId: hilo.id, cuerpo } });
            if (!r.ok) return r.error;
            setComentando(false);
            await onCambio();
            return null;
          }}
          onCancelar={() => setComentando(false)}
          onError={onError}
        />
      )}
    </div>
  );
}

/** Caja de texto compartida por «abrir hilo» y «comentar»: onEnviar devuelve el mensaje
 * de error del servidor o null si salió bien. */
function FormularioCuerpo({
  etiqueta,
  placeholder,
  onEnviar,
  onCancelar,
  onError,
}: {
  etiqueta: string;
  placeholder: string;
  onEnviar: (cuerpo: string) => Promise<string | null>;
  onCancelar: () => void;
  onError: (e: string | null) => void;
}) {
  const [cuerpo, setCuerpo] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function enviar() {
    setEnviando(true);
    onError(null);
    try {
      const error = await onEnviar(cuerpo.trim());
      if (error) onError(error);
      else setCuerpo('');
    } catch {
      onError('No se pudo publicar; intenta de nuevo');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Textarea
        rows={3}
        maxLength={CUERPO_MAX}
        value={cuerpo}
        placeholder={placeholder}
        onChange={(e) => setCuerpo(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" disabled={enviando || cuerpo.trim() === ''} onClick={() => void enviar()}>
          {enviando ? 'Publicando…' : etiqueta}
        </Button>
        <Button size="sm" variant="ghost" disabled={enviando} onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
