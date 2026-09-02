import React from 'react';
export function Switch({ on = false, onToggle, label }) {
  return <label style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text-body)', display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
    <span onClick={onToggle} style={{ width: 36, height: 20, borderRadius: 'var(--r-pill)', background: on ? 'var(--grad-arco)' : 'var(--border-strong)', position: 'relative', transition: 'background 150ms ease-out', display: 'inline-block' }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 150ms ease-out', boxShadow: 'var(--shadow-sm)' }} />
    </span>{label}
  </label>;
}