import type { SSEEvent } from '@/types';

export type Tier = 'channels' | 'claude' | 'codex';

const ORDER: Tier[] = ['channels', 'claude', 'codex'];

export function nextTier(t: Tier): Tier | null {
  const i = ORDER.indexOf(t);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null;
}

export function tierLabel(t: Tier): string {
  switch (t) {
    case 'channels': return 'Tier 1 · Channels (subscription)';
    case 'claude': return 'Tier 2 · Agent SDK (credit)';
    case 'codex': return 'Tier 3 · Codex';
  }
}

/** A turn that hit a usage limit emits a rate_limit SSEEvent. */
export function isExhaustionEvent(e: SSEEvent): boolean {
  return e.type === 'rate_limit';
}
