import type { InputHTMLAttributes } from 'react';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
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
