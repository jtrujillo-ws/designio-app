import type { ComponentProps } from 'react';

/**
 * `ComponentProps<'input'>` y no `InputHTMLAttributes`: incluye `ref`, que el buscador necesita
 * para enfocar. Con React 19 `ref` es una prop más de un componente de función y llega al
 * `<input>` con el resto del spread: no hace falta `forwardRef` (y en 19 está desaconsejado).
 */
export function Input(props: ComponentProps<'input'>) {
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
