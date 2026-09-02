import type { ReactNode } from 'react';

/** Códigos del dominio (R-01, DV-1, G5…) en mono sobre fondo sunken. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        fontSize: 11.5,
        color: 'var(--text-body)',
        background: 'var(--surface-sunken)',
        borderRadius: 6,
        padding: '3px 8px',
      }}
    >
      {children}
    </span>
  );
}
