'use client';

import type { Tier } from '@/lib/channels/tiers';
import { tierLabel } from '@/lib/channels/tiers';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

// The menu only switches between T1 (Channels) and T2 (Agent SDK). Codex (T3)
// is reached by picking a Codex model, not from this menu.
const SWITCHABLE_TIERS: Tier[] = ['channels', 'claude'];

interface TierIndicatorProps {
  tier: Tier;
  /** Called when the user picks a different tier from the menu. */
  onSelectTier: (target: Tier) => void;
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

export function TierIndicator({ tier, onSelectTier }: TierIndicatorProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`shrink-0 cursor-pointer text-[10px] px-1.5 py-1 rounded-full font-medium ${tierClass(tier)}`}
          title={`${tierLabel(tier)} — tap to switch tier`}
        >
          {shortLabel(tier)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {SWITCHABLE_TIERS.map((t) => (
          <DropdownMenuItem
            key={t}
            onSelect={() => { if (t !== tier) onSelectTier(t); }}
            className={t === tier ? 'font-semibold' : ''}
          >
            {tierLabel(t)}
            {t === tier && <span className="ml-auto pl-2 text-muted-foreground">●</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
