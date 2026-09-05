import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { EnlaceA, navegarA } from '@/components/ui/EnlaceA';
import { Input } from '@/components/ui/Input';
import { buscarEnElWorkspace } from '@/lib/busqueda/busqueda.functions';
import {
  ETIQUETA_CLASE,
  MAX_CARACTERES,
  MIN_CARACTERES,
  codigoDelDestino,
  type ResultadoBusqueda,
} from '@/lib/busqueda/busqueda.schemas';
import { etiquetaDeDestino } from '@/lib/destinos';

/** Cuánto se espera tras la última tecla antes de consultar: una ida por palabra, no por letra. */
const ESPERA_MS = 250;

type Estado =
  | { fase: 'inactivo' }
  | { fase: 'corto' }
  | { fase: 'buscando' }
  | { fase: 'listo'; resultados: ResultadoBusqueda[]; hayMas: boolean; texto: string }
  | { fase: 'error'; mensaje: string };

/**
 * El buscador de la barra superior. Consulta el workspace activo bajo RLS y enseña, por
 * clase, lo que casa con el texto: cada resultado es un enlace a la pantalla que lo abre.
 * Teclado: «/» desde cualquier sitio lo enfoca, flechas recorren, Enter abre, Esc cierra.
 */
export function Buscador({ workspaceId }: { workspaceId: string | null }) {
  const navigate = useNavigate();
  const idLista = useId();
  const input = useRef<HTMLInputElement>(null);
  const [texto, setTexto] = useState('');
  const [abierto, setAbierto] = useState(false);
  const [activo, setActivo] = useState(0);
  const [estado, setEstado] = useState<Estado>({ fase: 'inactivo' });
  // Mientras se consulta se sigue enseñando la lista anterior: sustituirla por «Buscando…»
  // a cada tecla hacía parpadear el panel y perdía la fila elegida con las flechas.
  const [cargando, setCargando] = useState(false);
  // Cada consulta lleva su número: una respuesta que llega tarde no pisa a la del texto
  // actual. Se avanza en TODOS los caminos, también cuando el texto se queda corto o vacío:
  // si no, la respuesta de «ab» aterrizaba sobre un campo que ya decía «a».
  const consulta = useRef(0);
  // Enter con una consulta en vuelo no elige nada de la lista anterior: se anota y se abre
  // el primer resultado de la consulta ACTUAL cuando llegue. Teclear otra letra lo olvida.
  const enterPendiente = useRef(false);

  // «/» enfoca el buscador desde cualquier sitio de la pantalla, salvo cuando ya se escribe
  // en otro campo: ahí la barra es un carácter más. «⌘K» (Ctrl+K fuera de Mac) también lo
  // enfoca, desde cualquier sitio: es el atajo que el lateral anuncia junto a la marca, y
  // hoy la paleta de comandos ES el buscador — no se anuncia nada que no exista.
  useEffect(() => {
    function alTeclear(e: globalThis.KeyboardEvent) {
      const paleta = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k';
      if (!paleta) {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        const objetivo = e.target as HTMLElement | null;
        const escribiendo =
          objetivo instanceof HTMLInputElement ||
          objetivo instanceof HTMLTextAreaElement ||
          objetivo instanceof HTMLSelectElement ||
          objetivo?.isContentEditable === true;
        if (escribiendo) return;
      }
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    }
    document.addEventListener('keydown', alTeclear);
    return () => document.removeEventListener('keydown', alTeclear);
  }, []);

  useEffect(() => {
    const numero = ++consulta.current;
    enterPendiente.current = false;
    const limpio = texto.trim();
    if (!workspaceId || limpio === '') {
      setEstado({ fase: 'inactivo' });
      setCargando(false);
      return;
    }
    if (limpio.length < MIN_CARACTERES) {
      setEstado({ fase: 'corto' });
      setCargando(false);
      return;
    }
    setCargando(true);
    setEstado((previo) => (previo.fase === 'listo' ? previo : { fase: 'buscando' }));
    // Una petición ya lanzada no se puede cancelar al desmontar (salir de /app, cambiar de
    // workspace), pero sí invalidar: con `vigente` en false su respuesta se descarta entera,
    // Enter anotado incluido, en vez de navegar desde una instancia que ya no existe.
    let vigente = true;
    const temporizador = setTimeout(async () => {
      try {
        const r = await buscarEnElWorkspace({ data: { workspaceId, texto: limpio } });
        if (!vigente || numero !== consulta.current) return;
        setEstado({ fase: 'listo', resultados: r.resultados, hayMas: r.hayMas, texto: limpio });
        setActivo(0);
        if (enterPendiente.current) {
          enterPendiente.current = false;
          const primero = r.resultados[0];
          if (primero) {
            setAbierto(false);
            setTexto('');
            setEstado({ fase: 'inactivo' });
            input.current?.blur();
            void navegarA(navigate, primero.destino);
          }
        }
      } catch (e) {
        if (!vigente || numero !== consulta.current) return;
        setEstado({
          fase: 'error',
          mensaje: e instanceof Error ? e.message : 'No se pudo buscar en este momento.',
        });
      } finally {
        if (vigente && numero === consulta.current) setCargando(false);
      }
    }, ESPERA_MS);
    return () => {
      clearTimeout(temporizador);
      vigente = false;
    };
  }, [texto, workspaceId, navigate]);

  const resultados = estado.fase === 'listo' ? estado.resultados : [];
  const desplegado = abierto && texto.trim() !== '' && workspaceId !== null;
  const idDeOpcion = (r: ResultadoBusqueda) => `${idLista}-${r.clase}-${r.id}`;

  // El foco no se mueve de la caja (aria-activedescendant), así que el navegador no
  // desplaza solo la opción activa: con más filas de las que caben, las flechas la dejaban
  // fuera de la vista y Enter abría algo que no se veía.
  useEffect(() => {
    const activa = desplegado ? resultados[activo] : undefined;
    if (activa) document.getElementById(idDeOpcion(activa))?.scrollIntoView({ block: 'nearest' });
    // idDeOpcion solo depende de idLista, que es estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, desplegado, resultados]);
  // La lista es de la consulta ACTUAL solo cuando no hay nada en vuelo y su texto es el del
  // campo. Mientras tanto se sigue viendo (evita el parpadeo), pero no se puede abrir: ni con
  // Enter, ni con clic, ni tabulando hasta ella. Abrir algo de la consulta anterior con el
  // campo diciendo otra cosa es el error que este guardia cierra en los tres caminos.
  const frescos = estado.fase === 'listo' && !cargando && estado.texto === texto.trim();

  function cerrar() {
    setAbierto(false);
    setTexto('');
    setEstado({ fase: 'inactivo' });
    enterPendiente.current = false;
  }

  async function abrir(resultado: ResultadoBusqueda) {
    cerrar();
    input.current?.blur();
    await navegarA(navigate, resultado.destino);
  }

  // El panel se cierra cuando el foco SALE del buscador entero, no cuando sale del campo:
  // así un clic lento sobre un resultado no lo desmonta antes de completarse, y tabular
  // hacia los resultados no los hace desaparecer bajo el foco.
  function alPerderFoco(e: FocusEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setAbierto(false);
    // Irse del buscador (clic fuera, Tab) con un Enter anotado lo cancela: el usuario ya
    // está en otra cosa y la respuesta que llegue no debe cambiarle de página.
    enterPendiente.current = false;
  }

  function alTeclearEnElCampo(e: KeyboardEvent<HTMLInputElement>) {
    // El Enter que confirma una composición (IME, acentos muertos) no elige nada.
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (texto === '') input.current?.blur();
      else cerrar();
      return;
    }
    if (e.key === 'ArrowDown' && resultados.length > 0) {
      e.preventDefault();
      setAbierto(true);
      setActivo((a) => (a + 1) % resultados.length);
      return;
    }
    if (e.key === 'ArrowUp' && resultados.length > 0) {
      e.preventDefault();
      setActivo((a) => (a - 1 + resultados.length) % resultados.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // La lista en pantalla puede ser la de la consulta anterior mientras llega la nueva.
      if (!frescos) {
        enterPendiente.current = texto.trim().length >= MIN_CARACTERES;
        return;
      }
      const elegido = resultados[activo] ?? resultados[0];
      if (elegido) void abrir(elegido);
    }
  }

  return (
    <div style={{ position: 'relative', width: 260 }} onBlur={alPerderFoco}>
      <Input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Buscar en el workspace"
        aria-expanded={desplegado}
        aria-controls={idLista}
        aria-autocomplete="list"
        aria-activedescendant={
          desplegado && frescos && resultados[activo] ? idDeOpcion(resultados[activo]) : undefined
        }
        autoComplete="off"
        maxLength={MAX_CARACTERES}
        placeholder={workspaceId ? 'Buscar en el workspace…  /' : 'Sin workspace donde buscar'}
        disabled={!workspaceId}
        title={workspaceId ? 'Atajos: / y ⌘K (Ctrl+K)' : 'Únete a un workspace para buscar en él'}
        value={texto}
        onChange={(e) => {
          setTexto(e.target.value);
          setAbierto(true);
        }}
        onFocus={() => setAbierto(true)}
        onKeyDown={alTeclearEnElCampo}
        style={{ background: 'var(--bg-app)', border: '1px solid var(--border)', width: '100%' }}
      />
      {desplegado && (
        <div
          id={idLista}
          role="listbox"
          aria-label="Resultados de la búsqueda"
          aria-busy={cargando}
          // Un clic dentro del panel no le quita el foco al campo: así una fila en espera no
          // cierra la lista al pulsarla, y el enlace de una fila viva sigue navegando (el clic
          // llega igual; lo que se evita es el blur).
          onMouseDown={(e) => e.preventDefault()}
          style={{ ...panel, opacity: cargando ? 0.7 : 1 }}
        >
          {estado.fase === 'corto' && <Aviso>Escribe al menos {MIN_CARACTERES} caracteres.</Aviso>}
          {estado.fase === 'buscando' && <Aviso>Buscando…</Aviso>}
          {estado.fase === 'error' && (
            <Aviso role="alert" color="var(--danger)">
              {estado.mensaje}
            </Aviso>
          )}
          {estado.fase === 'listo' && resultados.length === 0 && (
            <Aviso>Nada casa con «{estado.texto}» en este workspace.</Aviso>
          )}
          {estado.fase === 'listo' &&
            resultados.map((r, i) => {
              const nuevaClase = i === 0 || resultados[i - 1]!.clase !== r.clase;
              const pantalla = etiquetaDeDestino(r.destino, codigoDelDestino(r));
              // Las cabeceras de clase son presentación: el listbox posee directamente a
              // sus opciones, que son los propios enlaces.
              return (
                <div key={idDeOpcion(r)} role="presentation">
                  {nuevaClase && (
                    <div role="presentation" style={cabeceraClase}>
                      {ETIQUETA_CLASE[r.clase]}
                    </div>
                  )}
                  {frescos ? (
                    <EnlaceA
                      destino={r.destino}
                      id={idDeOpcion(r)}
                      role="option"
                      aria-selected={i === activo}
                      onMouseEnter={() => setActivo(i)}
                      // El enlace navega solo; esto cierra y suelta el campo también cuando el
                      // destino es esta misma ruta (/app), donde el Buscador sigue montado y,
                      // sin esto, la lista se quedaba abierta con el texto puesto.
                      onClick={() => {
                        cerrar();
                        input.current?.blur();
                      }}
                      title={`Abrir ${pantalla}`}
                      style={{
                        ...opcion,
                        background: i === activo ? 'var(--accent-soft)' : undefined,
                      }}
                    >
                      <ContenidoDeFila r={r} pantalla={pantalla} />
                    </EnlaceA>
                  ) : (
                    <div
                      id={idDeOpcion(r)}
                      role="option"
                      aria-selected={false}
                      aria-disabled
                      style={{ ...opcion, cursor: 'progress' }}
                    >
                      <ContenidoDeFila r={r} pantalla={pantalla} />
                    </div>
                  )}
                </div>
              );
            })}
          {estado.fase === 'listo' && estado.hayMas && (
            <Aviso>Hay más resultados de los que caben aquí: afina la búsqueda.</Aviso>
          )}
        </div>
      )}
    </div>
  );
}

const panel: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  // Más ancho que el campo y anclado a su derecha: los títulos se leen enteros y el panel
  // crece hacia el centro de la pantalla, donde hay sitio.
  right: 0,
  width: 440,
  zIndex: 20,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  boxShadow: 'var(--shadow-sm)',
  padding: 6,
  maxHeight: 420,
  overflowY: 'auto',
};

const cabeceraClase: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  fontSize: 10,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  padding: '8px 10px 4px',
};

const opcion: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
  padding: '7px 10px',
  borderRadius: 'var(--r-sm)',
  textDecoration: 'none',
  color: 'inherit',
};

/** Lo que se lee en una fila, sea enlace vivo o fila en espera. */
function ContenidoDeFila({ r, pantalla }: { r: ResultadoBusqueda; pantalla: string }) {
  return (
    <>
      <span style={{ font: '600 13px var(--font-sans)', color: 'var(--ink)', ...truncado }}>
        {r.codigo ? `${r.codigo} ` : ''}
        {r.titulo}
      </span>
      <span style={{ font: '400 11px var(--font-sans)', color: 'var(--text-muted)', ...truncado }}>
        {r.detalle ? `${r.detalle} · ` : ''}
        {pantalla}
      </span>
    </>
  );
}

const truncado: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function Aviso({ children, role, color }: { children: ReactNode; role?: 'alert'; color?: string }) {
  return (
    <div
      role={role}
      style={{
        font: '400 12.5px var(--font-sans)',
        color: color ?? 'var(--text-muted)',
        padding: '8px 10px',
      }}
    >
      {children}
    </div>
  );
}
