import type { HealthRule } from './types';

export const rules: HealthRule[] = [
  {
    id: 'context-70pct', name: 'Context getting full',
    description: 'Context window over 70% — model performance may degrade.',
    models: '*', severity: 'warning',
    condition: (t) => t.contextWindow > 0 && t.inputTokens / t.contextWindow > 0.7,
    message: (t) => {
      const pct = Math.round((t.inputTokens / t.contextWindow) * 100);
      return `Context ${pct}% full. Consider compacting.`;
    },
    actions: [{ type: 'compact' }, { type: 'dismiss' }], cooldownTurns: 5,
  },
  {
    id: 'context-90pct', name: 'Context nearly full',
    description: 'Context nearly full — auto-compact will trigger soon, or quality degrades.',
    models: '*', severity: 'critical',
    condition: (t) => t.contextWindow > 0 && t.inputTokens / t.contextWindow > 0.9,
    message: (t) => {
      const pct = Math.round((t.inputTokens / t.contextWindow) * 100);
      return `Context ${pct}% full! Compact or start a new session.`;
    },
    actions: [{ type: 'compact' }, { type: 'new-session' }], cooldownTurns: 2,
  },
  {
    id: 'cache-miss', name: 'Low cache hit rate',
    description: 'Cache reads < 30% of cache activity. Prompt cache may have expired.',
    models: '*', severity: 'warning',
    condition: (t, s) => {
      if (s.turns.length < 3) return false;
      const total = t.cacheReadTokens + t.cacheCreationTokens;
      if (total === 0) return false;
      return t.cacheReadTokens / total < 0.3;
    },
    message: () => 'Cache hit rate is low — session cache may have expired. Consider a new session.',
    actions: [{ type: 'new-session' }, { type: 'dismiss' }], cooldownTurns: 3,
  },
  {
    id: 'cost-spike', name: 'Cost spike detected',
    description: 'Single turn cost > 2.5x session average.',
    models: '*', severity: 'warning',
    condition: (t, s) => {
      if (!t.costUsd || s.turns.length < 3) return false;
      const avgCost = s.totalCost / s.turns.length;
      return avgCost > 0 && t.costUsd > avgCost * 2.5;
    },
    message: (t, s) => {
      const avgCost = s.totalCost / s.turns.length;
      return `This turn cost $${t.costUsd!.toFixed(4)} (avg $${avgCost.toFixed(4)}). Context may be too large.`;
    },
    actions: [{ type: 'compact' }, { type: 'dismiss' }], cooldownTurns: 3,
  },
  {
    id: 'idle-cache-expiry', name: 'Cache may have expired',
    description: 'Session idle > 50 minutes. Prompt cache likely expired (TTL is 1h for main agent).',
    models: '*', severity: 'info',
    condition: (_t, s) => {
      if (s.turns.length < 2) return false;
      const idleMinutes = (Date.now() - s.lastActivityAt) / 60000;
      return idleMinutes > 50;
    },
    message: (_t, s) => {
      const idleMin = Math.round((Date.now() - s.lastActivityAt) / 60000);
      return `Session idle ${idleMin}min. Cache may have expired — next message will be full-price.`;
    },
    actions: [{ type: 'new-session' }, { type: 'dismiss' }], cooldownTurns: 1,
  },
  {
    id: 'auto-compact-fired', name: 'Auto-compact occurred',
    description: 'Claude Code auto-compacted the context. Informational only.',
    models: '*', severity: 'info',
    condition: (_t, s) => s.lastCompactAt !== null && Date.now() - s.lastCompactAt < 5000,
    message: (_t, s) => {
      const preK = s.lastCompactPreTokens ? Math.round(s.lastCompactPreTokens / 1000) : '?';
      return `Context auto-compacted (was ${preK}K tokens).`;
    },
    actions: [{ type: 'dismiss' }], cooldownTurns: 0,
  },
];
