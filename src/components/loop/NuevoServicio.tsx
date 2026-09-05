import { useId, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { crearServicioDelWorkspace } from '@/lib/arbol/arbol.functions';
import { CrearServicioSchema } from '@/lib/arbol/arbol.schemas';

/** Blanco de la tinta inversa, a las opacidades del sistema sobre `--brand-ink`. */
const claro = (a: number) => `rgba(247,247,249,${a})`;

/**
 * La fila «+ Nuevo servicio» del lateral (handoff 3a) y el formulario que abre en el sitio:
 * nombre y descripción, sobre el mismo fondo oscuro. Al crear, avisa a quien lo monta para
 * que recargue el árbol y despliegue el servicio recién nacido; los errores de la server
 * function (permiso, nombre repetido, sesión) se dicen aquí mismo, debajo del campo.
 *
 * Solo se monta para los roles que pueden dar de alta (`ROLES_ALTA_SERVICIO`): a los demás
 * no se les ofrece una fila que la base rechazaría.
 */
export function NuevoServicio({
  workspaceId,
  onCreado,
}: {
  workspaceId: string;
  /** Recibe el id del servicio creado, para desplegarlo tras recargar el árbol. */
  onCreado: (servicioId: string) => void | Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const idError = useId();
  const campoNombre = useRef<HTMLInputElement>(null);

  function cerrar() {
    setAbierto(false);
    setNombre('');
    setDescripcion('');
    setError(null);
  }

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (enviando) return;
    // El mismo schema que valida la server function: lo que aquí se rechaza se rechazaría
    // allí, y así el mensaje llega antes de la ida al servidor.
    const parseado = CrearServicioSchema.safeParse({ workspaceId, nombre, descripcion });
    if (!parseado.success) {
      setError(parseado.error.issues[0]?.message ?? 'Revisa el formulario');
      campoNombre.current?.focus();
      return;
    }
    setEnviando(true);
    setError(null);
    try {
      const r = await crearServicioDelWorkspace({ data: parseado.data });
      if (!r.ok) {
        setError(r.error);
        campoNombre.current?.focus();
        return;
      }
      cerrar();
      await onCreado(r.servicioId);
    } catch {
      setError('No se pudo crear el servicio en este momento');
    } finally {
      setEnviando(false);
    }
  }

  if (!abierto) {
    return (
      <button
        type="button"
        className="loop-fila"
        onClick={() => setAbierto(true)}
        title="Dar de alta un servicio de la organización cliente"
        style={{
          ...filaPunteada,
          marginTop: 6,
        }}
      >
        <span className="loop-ancho">+ Nuevo servicio</span>
        <span className="loop-estrecho" aria-hidden style={{ font: '600 12.5px var(--font-sans)' }}>
          +
        </span>
      </button>
    );
  }

  return (
    <form
      onSubmit={enviar}
      aria-label="Nuevo servicio"
      className="loop-ancho"
      style={{
        ...filaPunteada,
        marginTop: 6,
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 8,
        cursor: 'default',
        padding: 10,
      }}
    >
      <label style={etiquetaCampo}>
        Nombre del servicio
        <input
          ref={campoNombre}
          autoFocus
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          maxLength={200}
          placeholder="Apertura de cuenta nómina"
          aria-invalid={error !== null}
          aria-describedby={error ? idError : undefined}
          disabled={enviando}
          style={campo}
        />
      </label>
      <label style={etiquetaCampo}>
        Descripción (opcional)
        <textarea
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Qué hace hoy este servicio"
          disabled={enviando}
          style={{ ...campo, resize: 'vertical', fontFamily: 'var(--font-sans)' }}
        />
      </label>
      {error && (
        <span
          id={idError}
          role="alert"
          style={{ font: '500 11.5px/1.4 var(--font-sans)', color: 'var(--danger-soft)' }}
        >
          {error}
        </span>
      )}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={cerrar}
          disabled={enviando}
          style={{ ...boton, background: 'transparent', color: claro(0.68) }}
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={enviando}
          style={{ ...boton, background: 'var(--grad-arco)', color: '#fff' }}
        >
          {enviando ? 'Creando…' : 'Crear servicio'}
        </button>
      </div>
    </form>
  );
}

const filaPunteada: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 10px',
  minHeight: 32,
  borderRadius: 9,
  border: `1px dashed ${claro(0.22)}`,
  // Sin `background` en línea: el fondo base y el hover los pinta `.loop-fila` en la hoja.
  color: claro(0.6),
  font: '600 12.5px var(--font-sans)',
  textAlign: 'left',
  cursor: 'pointer',
};

const etiquetaCampo: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 10,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  color: claro(0.45),
};

const campo: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: '#fff',
  background: claro(0.09),
  border: `1px solid ${claro(0.22)}`,
  borderRadius: 'var(--r-sm)',
  padding: '7px 10px',
  letterSpacing: 0,
  textTransform: 'none',
};

const boton: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontWeight: 700,
  fontSize: 12,
  border: 'none',
  borderRadius: 'var(--r-sm)',
  padding: '7px 12px',
  cursor: 'pointer',
};
