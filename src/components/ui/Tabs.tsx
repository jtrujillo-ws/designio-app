import type { KeyboardEvent } from 'react';

export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: string[];
  value: string;
  onChange?: (item: string) => void;
  /** Nombre accesible del tablist. */
  label?: string;
}) {
  // Foco itinerante (patrón tabs de WAI-ARIA): solo la pestaña activa entra con Tab, y las
  // flechas mueven el foco entre las demás; Enter o espacio la activan (es un botón). Sin
  // esto, con `tabIndex={-1}` las pestañas inactivas no se alcanzaban desde el teclado.
  function alTeclear(e: KeyboardEvent<HTMLDivElement>) {
    const pestañas = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const actual = pestañas.indexOf(document.activeElement as HTMLButtonElement);
    if (actual === -1 || pestañas.length === 0) return;
    const saltos: Record<string, number> = {
      ArrowRight: actual + 1,
      ArrowLeft: actual - 1,
      Home: 0,
      End: pestañas.length - 1,
    };
    const destino = saltos[e.key];
    if (destino === undefined) return;
    e.preventDefault();
    pestañas[(destino + pestañas.length) % pestañas.length]?.focus();
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={alTeclear}
      style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}
    >
      {items.map((it) => {
        const act = it === value;
        return (
          <button
            key={it}
            type="button"
            role="tab"
            aria-selected={act}
            tabIndex={act ? 0 : -1}
            onClick={() => onChange?.(it)}
            style={{
              fontFamily: 'var(--font-sans)',
              fontWeight: act ? 700 : 500,
              fontSize: 14,
              color: act ? 'var(--ink)' : 'var(--text-muted)',
              background: 'transparent',
              border: 'none',
              borderBottom: act ? '2px solid var(--accent)' : '2px solid transparent',
              padding: '10px 14px',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {it}
          </button>
        );
      })}
    </div>
  );
}
