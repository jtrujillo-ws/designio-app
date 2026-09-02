import type { CSSProperties, ReactNode } from 'react';
import type { JourneyN } from '@/components/ui/JourneyBadge';

export function Card({
  j,
  active = false,
  pending = false,
  style,
  children,
}: {
  /** Variante journey: border-top 4px del hue correspondiente. */
  j?: JourneyN;
  /** Activa: borde gradiente (técnica padding-box/border-box) + shadow-arco. */
  active?: boolean;
  /** Pendiente/futura: bg-app, borde dashed, contenido atenuado. */
  pending?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const s: CSSProperties = {
    background: pending ? 'var(--bg-app)' : 'var(--surface)',
    border: pending ? '1px dashed var(--border-strong)' : '1px solid var(--border)',
    borderRadius: 14,
    padding: 16,
    boxShadow: pending ? 'none' : active ? 'var(--shadow-arco)' : 'var(--shadow-sm)',
    opacity: pending ? 0.55 : 1,
    ...(j && !active ? { borderTop: `4px solid var(--j${j})` } : {}),
    ...style,
  };
  if (active) {
    s.border = '2px solid transparent';
    s.background = 'linear-gradient(var(--surface), var(--surface)) padding-box, var(--grad-arco) border-box';
    s.padding = 15;
  }
  return <div style={s}>{children}</div>;
}
