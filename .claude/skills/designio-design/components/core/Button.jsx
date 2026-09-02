import React from 'react';
export function Button({ variant = 'primary', size = 'md', disabled = false, children, onClick }) {
  const base = { fontFamily: 'var(--font-sans)', fontWeight: 700, border: '1px solid transparent', borderRadius: 'var(--r-sm)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, display: 'inline-flex', alignItems: 'center', gap: 8, padding: size === 'sm' ? '6px 12px' : '9px 16px', fontSize: size === 'sm' ? 12.5 : 14, transition: 'background 150ms ease-out' };
  const variants = {
    primary: { background: 'var(--ink)', color: 'var(--text-inverse)' },
    arco: { background: 'var(--grad-arco)', color: '#fff' },
    secondary: { background: 'var(--surface)', color: 'var(--ink)', borderColor: 'var(--border-strong)' },
    ghost: { background: 'transparent', color: 'var(--text-body)' },
    danger: { background: 'var(--danger)', color: '#fff' },
  };
  return <button style={{ ...base, ...variants[variant] }} disabled={disabled} onClick={onClick}>{children}</button>;
}