'use client';

import type { Tier } from '@/lib/channels/tiers';
import { tierLabel } from '@/lib/channels/tiers';

interface TierIndicatorProps {
  tier: Tier;
}

function shortLabel(tier: Tier): string {
  switch (tier) {
    case 'channels': return 'T1 · Channels';
    case 'claude':   return 'T2 · SDK';
    case 'codex':    return 'T3 · Codex';
  }
}

function tierClass(tier: Tier): string {
  switch (tier) {
    case 'channels': return 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400';
    case 'claude':   return 'bg-amber-500/20 text-amber-600 dark:text-amber-400';
    case 'codex':    return 'bg-blue-500/20 text-blue-600 dark:text-blue-400';
  }
}

export function TierIndicator({ tier }: TierIndicatorProps) {
  return (
    <span
      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${tierClass(tier)}`}
      title={tierLabel(tier)}
    >
      {shortLabel(tier)}
    </span>
  );
}
