import React from 'react';
export function Input({ mono = false, style, ...rest }) {
  return <input {...rest} style={{ fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', fontSize: 14, color: 'var(--ink)', background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', padding: '8px 12px', outline: 'none', ...style }} />;
}