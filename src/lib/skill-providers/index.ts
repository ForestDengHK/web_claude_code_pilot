'use client';

import { useEffect, useState } from 'react';
import { claudeSkillProvider } from './claude';
import { codexSkillProvider } from './codex';
import { resolveAvailableProviders } from './filter';
import type { SkillProvider } from './types';

/**
 * Registry of all skill providers. Order determines tab order in the UI.
 * Add new backends by appending a provider here — no other file needs to change.
 */
export const SKILL_PROVIDERS: readonly SkillProvider[] = [
  claudeSkillProvider,
  codexSkillProvider,
];

export type { SkillProvider, UnifiedSkill, SkillCapabilities } from './types';

/**
 * React hook: returns the subset of providers that reported available.
 * Re-probes once on mount; does not poll.
 */
export function useAvailableSkillProviders(): {
  providers: SkillProvider[];
  loading: boolean;
} {
  const [state, setState] = useState<{ providers: SkillProvider[]; loading: boolean }>(
    { providers: [], loading: true },
  );

  useEffect(() => {
    let cancelled = false;
    resolveAvailableProviders(SKILL_PROVIDERS).then((providers) => {
      if (!cancelled) setState({ providers, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
