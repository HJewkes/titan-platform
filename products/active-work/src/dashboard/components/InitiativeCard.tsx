import React from 'react';
import { palette, radii, sp, typography } from '../tokens.js';
import { StateBadge } from './StateBadge.js';
import type { InitiativeItem } from '../types.js';

interface Props {
  item: InitiativeItem;
}

/** Read-only card primitive for a single initiative. */
export function InitiativeCard({ item }: Props): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: sp[3],
        padding: sp[8],
        background: palette.surface1,
        border: `1px solid ${palette.border}`,
        borderRadius: radii.md,
      }}
    >
      <CardHeader item={item} />
      <CardMeta item={item} />
    </div>
  );
}

function CardHeader({ item }: Props): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: sp[6],
        alignItems: 'flex-start',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: sp[2] }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: palette.textPrimary }}>{item.title}</span>
        <span style={{ fontFamily: typography.mono, fontSize: 11, color: palette.textTertiary }}>
          {item.slug}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: sp[2] }}>
        <StateBadge label={item.state} />
        {item.rank !== undefined && <RankChip rank={item.rank} />}
      </div>
    </div>
  );
}

function RankChip({ rank }: { rank: number }): React.JSX.Element {
  return (
    <span
      style={{
        fontFamily: typography.mono,
        fontSize: 11,
        color: palette.brand,
        background: `${palette.brand}1a`,
        padding: `${sp[1]}px ${sp[4]}px`,
        borderRadius: radii.sm,
      }}
    >
      rank {rank}
    </span>
  );
}

function CardMeta({ item }: Props): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: sp[8], fontSize: 12, color: palette.textSecondary }}>
      {item.ship_target && <MetaField label="ship" value={item.ship_target} />}
      {item.paused_since && <MetaField label="paused" value={item.paused_since} />}
      <MetaField label="updated" value={item.updated} />
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span>
      <span style={{ color: palette.textTertiary }}>{label} </span>
      {value}
    </span>
  );
}
