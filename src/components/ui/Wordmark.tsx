/** Marca tipográfica «designio.»: sin logo; el punto lleva el gradiente del arco. */
export function Wordmark({ size = 21 }: { size?: number }) {
  return (
    <span style={{ font: `800 ${size}px var(--font-sans)`, color: 'var(--ink)' }}>
      designio
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
