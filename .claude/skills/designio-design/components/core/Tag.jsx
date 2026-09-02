import React from 'react';
export function Tag({ children, mono = true }) {
  return <span style={{ fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', fontWeight: 500, fontSize: 11.5, color: 'var(--text-muted)', background: 'var(--surface-sunken)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px' }}>{children}</span>;
}