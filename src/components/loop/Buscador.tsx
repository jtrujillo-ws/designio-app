import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { EnlaceA, navegarA } from '@/components/ui/EnlaceA';
import { Input } from '@/components/ui/Input';
import { buscarEnElWorkspace } from '@/lib/busqueda/busqueda.functions';
import {
  ETIQUETA_CLASE,
  MAX_CARACTERES,
  MIN_CARACTERES,
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
  // Cada consulta lleva su número: una respuesta que llega tarde no pisa a la del texto actual.
  const consulta = useRef(0);

  // «/» enfoca el buscador desde cualquier sitio de la pantalla, salvo cuando ya se escribe
  // en otro campo: ahí la barra es un carácter más.
  useEffect(() => {
    function alTeclear(e: globalThis.KeyboardEvent) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const objetivo = e.target as HTMLElement | null;
      const escribiendo =
        objetivo instanceof HTMLInputElement ||
        objetivo instanceof HTMLTextAreaElement ||
        objetivo instanceof HTMLSelectElement ||
        objetivo?.isContentEditable === true;
      if (escribiendo) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    }
    document.addEventListener('keydown', alTeclear);
    return () => document.removeEventListener('keydown', alTeclear);
  }, []);

  useEffect(() => {
    const limpio = texto.trim();
    if (!workspaceId || limpio === '') {
      setEstado({ fase: 'inactivo' });
      return;
    }
    if (limpio.length < MIN_CARACTERES) {
      setEstado({ fase: 'corto' });
      return;
    }
    const numero = ++consulta.current;
    setEstado({ fase: 'buscando' });
    const temporizador = setTimeout(async () => {
      try {
        const r = await buscarEnElWorkspace({ data: { workspaceId, texto: limpio } });
        if (numero !== consulta.current) return;
        setEstado({ fase: 'listo', resultados: r.resultados, hayMas: r.hayMas, texto: limpio });
        setActivo(0);
      } catch (e) {
        if (numero !== consulta.current) return;
        setEstado({
          fase: 'error',
          mensaje: e instanceof Error ? e.message : 'No se pudo buscar en este momento.',
        });
      }
    }, ESPERA_MS);
    return () => clearTimeout(temporizador);
  }, [texto, workspaceId]);

  const resultados = estado.fase === 'listo' ? estado.resultados : [];
  const desplegado = abierto && texto.trim() !== '' && workspaceId !== null;

  function cerrar() {
    setAbierto(false);
    setTexto('');
    setEstado({ fase: 'inactivo' });
  }

  async function abrir(resultado: ResultadoBusqueda) {
    cerrar();
    input.current?.blur();
    await navegarA(navigate, resultado.destino);
  }

  function alTeclearEnElCampo(e: KeyboardEvent<HTMLInputElement>) {
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
      const elegido = resultados[activo] ?? resultados[0];
      if (elegido) void abrir(elegido);
    }
  }

  return (
    <div style={{ position: 'relative', width: 280 }}>
      <Input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Buscar en el workspace"
        aria-expanded={desplegado}
        aria-controls={idLista}
        aria-autocomplete="list"
        aria-activedescendant={
          desplegado && resultados[activo] ? `${idLista}-${resultados[activo].id}` : undefined
        }
        autoComplete="off"
        maxLength={MAX_CARACTERES}
        placeholder={workspaceId ? 'Buscar en el workspace…  /' : 'Sin workspace donde buscar'}
        disabled={!workspaceId}
        title={workspaceId ? 'Atajo: /' : 'Únete a un workspace para buscar en él'}
        value={texto}
        onChange={(e) => {
          setTexto(e.target.value);
          setAbierto(true);
        }}
        onFocus={() => setAbierto(true)}
        // El cierre por blur espera al clic sobre un resultado (que es un enlace y navega solo).
        onBlur={() => setTimeout(() => setAbierto(false), 150)}
        onKeyDown={alTeclearEnElCampo}
        style={{ background: 'var(--bg-app)', border: '1px solid var(--border)', width: '100%' }}
      />
      {desplegado && (
        <div id={idLista} role="listbox" aria-label="Resultados de la búsqueda" style={panel}>
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
              return (
                <div key={`${r.clase}-${r.id}`}>
                  {nuevaClase && <div style={cabeceraClase}>{ETIQUETA_CLASE[r.clase]}</div>}
                  <EnlaceA
                    destino={r.destino}
                    style={{
                      ...opcion,
                      background: i === activo ? 'var(--accent-soft)' : undefined,
                    }}
                    title={`Abrir ${etiquetaDeDestino(r.destino, r.codigo ?? undefined)}`}
                  >
                    <span
                      id={`${idLista}-${r.id}`}
                      role="option"
                      aria-selected={i === activo}
                      onMouseEnter={() => setActivo(i)}
                      style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
                    >
                      <span
                        style={{
                          font: '600 13px var(--font-sans)',
                          color: 'var(--ink)',
                          ...truncado,
                        }}
                      >
                        {r.codigo ? `${r.codigo} ` : ''}
                        {r.titulo}
                      </span>
                      <span
                        style={{
                          font: '400 11px var(--font-sans)',
                          color: 'var(--text-muted)',
                          ...truncado,
                        }}
                      >
                        {r.detalle ? `${r.detalle} · ` : ''}
                        {etiquetaDeDestino(r.destino, r.codigo ?? undefined)}
                      </span>
                    </span>
                  </EnlaceA>
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
  display: 'block',
  padding: '7px 10px',
  borderRadius: 'var(--r-sm)',
  textDecoration: 'none',
  color: 'inherit',
};

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
