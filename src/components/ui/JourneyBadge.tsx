export type JourneyN = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Badge del arco: un color por journey (posición en el método, nunca decorativo). */
export function JourneyBadge({ j, soft = false }: { j: JourneyN; soft?: boolean }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        fontSize: 12,
        borderRadius: 6,
        padding: '3px 8px',
        color: soft ? `var(--j${j})` : '#fff',
        background: soft ? `var(--j${j}-soft)` : `var(--j${j})`,
      }}
    >
      J{j}
    </span>
  );
}
