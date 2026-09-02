import type { InputHTMLAttributes } from 'react';

export function Checkbox(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <input
      type="checkbox"
      {...props}
      style={{ accentColor: 'var(--accent)', width: 16, height: 16, ...props.style }}
    />
  );
}
