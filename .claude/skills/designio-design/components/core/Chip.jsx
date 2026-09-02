import React from 'react';
const MAP = {
  'hecho':       { color: 'var(--ok)', background: 'var(--ok-soft)' },
  'en curso':    { color: '#fff', background: 'var(--grad-arco)' },
  'próximo':     { color: 'var(--text-muted)', background: 'var(--surface-sunken)' },
  'candidato':   { color: 'var(--warn)', background: 'var(--warn-soft)' },
  'en medición': { color: 'var(--accent)', background: 'var(--accent-soft)' },
};
export function Chip({ estado = 'próximo', children }) {
  return <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 11, borderRadius: 'var(--r-pill)', padding: '4px 10px', ...MAP[estado] }}>{children ?? estado.charAt(0).toUpperCase() + estado.slice(1)}</span>;
}