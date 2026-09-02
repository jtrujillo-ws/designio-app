import type { SelectHTMLAttributes } from 'react';

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        color: 'var(--ink)',
        background: 'var(--surface)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-sm)',
        padding: '8px 12px',
        ...props.style,
      }}
    />
  );
}
