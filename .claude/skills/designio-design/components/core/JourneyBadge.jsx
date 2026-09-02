import React from 'react';
export function JourneyBadge({ j = 1, soft = false }) {
  return <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 12, borderRadius: 6, padding: '3px 8px', color: soft ? `var(--j${j})` : '#fff', background: soft ? `var(--j${j}-soft)` : `var(--j${j})` }}>J{j}</span>;
}