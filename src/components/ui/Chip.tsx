import type { CSSProperties, ReactNode } from 'react';

/** Estados canónicos del loop (I1: no se renombran). */
export type EstadoChip = 'hecho' | 'en curso' | 'próximo' | 'candidato' | 'en medición';

const MAPA: Record<EstadoChip, CSSProperties> = {
  hecho: { color: 'var(--ok)', background: 'var(--ok-soft)' },
  'en curso': { color: '#fff', background: 'var(--grad-arco)' },
  próximo: { color: 'var(--text-muted)', background: 'var(--surface-sunken)' },
  candidato: { color: 'var(--warn)', background: 'var(--warn-soft)' },
  'en medición': { color: 'var(--accent)', background: 'var(--accent-soft)' },
};

export function Chip({ estado = 'próximo', children }: { estado?: EstadoChip; children?: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-sans)',
        fontWeight: 700,
        fontSize: 11,
        borderRadius: 'var(--r-pill)',
        padding: '4px 10px',
        whiteSpace: 'nowrap',
        ...MAPA[estado],
      }}
    >
      {children ?? estado.charAt(0).toUpperCase() + estado.slice(1)}
    </span>
  );
}
