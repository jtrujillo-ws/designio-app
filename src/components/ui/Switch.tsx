export function Switch({
  on = false,
  onChange,
  label,
}: {
  on?: boolean;
  onChange?: (on: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange?.(!on)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 'var(--r-pill)',
        border: 'none',
        cursor: 'pointer',
        background: on ? 'var(--grad-arco)' : 'var(--border-strong)',
        position: 'relative',
        transition: 'background 150ms ease-out',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 150ms ease-out',
        }}
      />
    </button>
  );
}
