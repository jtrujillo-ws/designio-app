import type { ReactNode } from 'react';

/** Códigos del dominio (R-01, DV-1, G5…): Plex Mono por defecto, sobre fondo sunken con borde. */
export function Tag({
  children,
  mono = true,
}: {
  children: ReactNode;
  /** Códigos en Plex Mono (default). */
  mono?: boolean;
}) {
  return (
    <span
      style={{
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontWeight: 500,
        fontSize: 11.5,
        color: 'var(--text-muted)',
        background: 'var(--surface-sunken)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '3px 8px',
      }}
    >
      {children}
    </span>
  );
}
