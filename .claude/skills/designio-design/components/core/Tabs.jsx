import React from 'react';
export function Tabs({ items = [], value, onChange }) {
  return <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
    {items.map((it) => {
      const act = it === value;
      return <button key={it} onClick={() => onChange && onChange(it)} style={{ fontFamily: 'var(--font-sans)', fontWeight: act ? 700 : 500, fontSize: 14, color: act ? 'var(--ink)' : 'var(--text-muted)', background: 'transparent', border: 'none', borderBottom: act ? '2px solid var(--accent)' : '2px solid transparent', padding: '10px 14px', cursor: 'pointer', marginBottom: -1 }}>{it}</button>;
    })}
  </div>;
}