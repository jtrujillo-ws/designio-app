import React from 'react';
export function Checkbox({ label, checked, onChange }) {
  return <label style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text-body)', display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
    <input type="checkbox" checked={checked} onChange={onChange} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />{label}
  </label>;
}