/** Marca tipográfica «designio.»: sin logo; el punto lleva el gradiente del arco. */
export function Wordmark({
  size = 21,
  color = 'var(--ink)',
  corto = false,
}: {
  size?: number;
  /** Sobre chrome oscuro (`--brand-ink`) la marca va en blanco. */
  color?: string;
  /** Solo la inicial y el punto: la forma que cabe en un riel estrecho. */
  corto?: boolean;
}) {
  return (
    <span style={{ font: `800 ${size}px var(--font-sans)`, color }}>
      {corto ? 'd' : 'designio'}
      <span
        style={{
          background: 'var(--grad-arco)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        .
      </span>
    </span>
  );
}
