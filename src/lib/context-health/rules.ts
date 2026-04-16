import type { HealthRule } from './types';

/**
 * Context health rules. Verified against official Anthropic documentation (April 2026).
 *
 * To add a rule: append a HealthRule object to this array.
 * No other files need to change (OCP).
 */
export const rules: HealthRule[] = [
  {
    id: 'context-70pct', name: 'Context getting full',
    description: 'Warn when context window utilization exceeds threshold.',
    models: '*', severity: 'warning',
    configSchema: {
      label: 'Utilization %',
      type: 'percentage',
      default: 70,
      min: 30, max: 95, step: 5,
      tip: 'Community data shows model performance degrades above 200K tokens (~20% of 1M). Claude auto-compacts at ~95%. Default 70% gives early warning. Lower to 50% for 1M-context models where cache-miss costs are high.',
    },
    condition: (t, _s, threshold) => t.contextWindow > 0 && t.inputTokens / t.contextWindow > threshold / 100,
    message: (t) => {
      const pct = Math.round((t.inputTokens / t.contextWindow) * 100);
      return `Context ${pct}% full. Consider compacting.`;
    },
    actions: [{ type: 'compact' }, { type: 'dismiss' }], cooldownTurns: 5,
  },
  {
    id: 'context-90pct', name: 'Context nearly full',
    description: 'Critical alert when context is almost at capacity.',
    models: '*', severity: 'critical',
    configSchema: {
      label: 'Utilization %',
      type: 'percentage',
      default: 90,
      min: 70, max: 99, step: 5,
      tip: 'Claude Code auto-compacts at ~95%. At this level, response quality suffers and the next message may trigger compaction. Compact now or start a new session to avoid losing context fidelity.',
    },
    condition: (t, _s, threshold) => t.contextWindow > 0 && t.inputTokens / t.contextWindow > threshold / 100,
    message: (t) => {
      const pct = Math.round((t.inputTokens / t.contextWindow) * 100);
      return `Context ${pct}% full! Compact or start a new session.`;
    },
    actions: [{ type: 'compact' }, { type: 'new-session' }], cooldownTurns: 2,
  },
  {
    id: 'cache-miss', name: 'Low cache hit rate',
    description: 'Warn when prompt cache hit rate drops below threshold.',
    models: '*', severity: 'warning',
    configSchema: {
      label: 'Min hit rate %',
      type: 'percentage',
      default: 30,
      min: 10, max: 80, step: 5,
      tip: 'Active sessions normally have 80%+ cache hit rate (cache read cost is 1/10 of full price). Below 30% usually means the cache expired — e.g. session idle > 1 hour, or you switched models mid-session. Starting a new session rebuilds the cache.',
    },
    condition: (t, s, threshold) => {
      if (s.turns.length < 3) return false;
      const total = t.cacheReadTokens + t.cacheCreationTokens;
      if (total === 0) return false;
      return t.cacheReadTokens / total < threshold / 100;
    },
    message: () => 'Cache hit rate is low — session cache may have expired. Consider a new session.',
    actions: [{ type: 'new-session' }, { type: 'dismiss' }], cooldownTurns: 3,
  },
  {
    id: 'cost-spike', name: 'Cost spike detected',
    description: 'Warn when a single turn costs much more than the session average.',
    models: '*', severity: 'warning',
    configSchema: {
      label: 'Cost multiplier',
      type: 'multiplier',
      default: 2.5,
      min: 1.5, max: 10, step: 0.5,
      tip: 'Flags when one turn costs more than N× the session average. Even simple operations like git commit send the full context — if it costs 2.5× more than usual, context has grown significantly. Lower = more sensitive, higher = fewer alerts.',
    },
    condition: (t, s, threshold) => {
      if (!t.costUsd || s.turns.length < 3) return false;
      const avgCost = s.totalCost / s.turns.length;
      return avgCost > 0 && t.costUsd > avgCost * threshold;
    },
    message: (t, s) => {
      const avgCost = s.totalCost / s.turns.length;
      return `This turn cost $${t.costUsd!.toFixed(4)} (avg $${avgCost.toFixed(4)}). Context may be too large.`;
    },
    actions: [{ type: 'compact' }, { type: 'dismiss' }], cooldownTurns: 3,
  },
  {
    id: 'idle-cache-expiry', name: 'Cache may have expired',
    description: 'Warn when session has been idle long enough for the prompt cache to expire.',
    models: '*', severity: 'info',
    configSchema: {
      label: 'Idle timeout (min)',
      type: 'minutes',
      default: 50,
      min: 3, max: 120, step: 5,
      tip: 'Prompt cache TTL: 1 hour for main agent (Claude Code), 5 minutes for sub-agents and API users. Default 50 min gives a 10-minute warning before the 1-hour expiry. API users should set this to 4 minutes. After expiry, the next message pays full price for the entire context.',
    },
    condition: (_t, s, threshold) => {
      if (s.turns.length < 2) return false;
      const idleMinutes = (Date.now() - s.lastActivityAt) / 60000;
      return idleMinutes > threshold;
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
    // No configSchema — no threshold, just a notification
    condition: (_t, s) => s.lastCompactAt !== null && Date.now() - s.lastCompactAt < 5000,
    message: (_t, s) => {
      const preK = s.lastCompactPreTokens ? Math.round(s.lastCompactPreTokens / 1000) : '?';
      return `Context auto-compacted (was ${preK}K tokens).`;
    },
    actions: [{ type: 'dismiss' }], cooldownTurns: 0,
  },
];
