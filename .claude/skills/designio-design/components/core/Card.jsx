import React from 'react';
export function Card({ j, active = false, pending = false, children, style }) {
  const s = { background: pending ? 'var(--bg-app)' : 'var(--surface)', border: pending ? '1px dashed var(--border-strong)' : '1px solid var(--border)', borderRadius: 14, padding: 16, boxShadow: pending ? 'none' : active ? 'var(--shadow-arco)' : 'var(--shadow-sm)', ...(j ? { borderTop: `4px solid var(--j${j})` } : {}), ...style };
  if (active) { s.border = '2px solid transparent'; s.background = `linear-gradient(${pending ? 'var(--bg-app)' : 'var(--surface)'}, var(--surface)) padding-box, var(--grad-arco) border-box`; s.padding = 15; }
  return <div style={s}>{children}</div>;
}