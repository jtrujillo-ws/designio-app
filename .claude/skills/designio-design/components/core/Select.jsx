import React from 'react';
export function Select({ options = [], style, ...rest }) {
  return <select {...rest} style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--ink)', background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', padding: '8px 12px', ...style }}>
    {options.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>;
}