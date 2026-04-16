import { describe, it, expect } from 'vitest';
import { evaluate } from '../../lib/context-health/evaluator';
import { rules } from '../../lib/context-health/rules';
import type { TurnMetrics, SessionMetrics } from '../../lib/context-health/types';

function makeTurn(overrides: Partial<TurnMetrics> = {}): TurnMetrics {
  return {
    inputTokens: 50000, outputTokens: 5000, cacheReadTokens: 40000,
    cacheCreationTokens: 5000, costUsd: 0.05, model: 'claude-opus-4-6',
    contextWindow: 200000, turnIndex: 5, ...overrides,
  };
}
function makeSession(turns: TurnMetrics[], overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    turns, totalCost: turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0),
    lastActivityAt: Date.now(), lastCompactAt: null, lastCompactPreTokens: null, ...overrides,
  };
}

describe('built-in rules', () => {
  it('context-70pct fires at 75% utilization', () => {
    const turn = makeTurn({ inputTokens: 150000, contextWindow: 200000 });
    const alerts = evaluate(turn, makeSession([turn]), rules, new Map());
    expect(alerts.find(a => a.ruleId === 'context-70pct')).toBeDefined();
  });
  it('context-70pct does NOT fire at 60%', () => {
    const turn = makeTurn({ inputTokens: 120000, contextWindow: 200000 });
    const alerts = evaluate(turn, makeSession([turn]), rules, new Map());
    expect(alerts.find(a => a.ruleId === 'context-70pct')).toBeUndefined();
  });
  it('context-90pct fires at 95% utilization', () => {
    const turn = makeTurn({ inputTokens: 190000, contextWindow: 200000 });
    const alerts = evaluate(turn, makeSession([turn]), rules, new Map());
    const match = alerts.find(a => a.ruleId === 'context-90pct');
    expect(match).toBeDefined();
    expect(match!.severity).toBe('critical');
  });
  it('cache-miss fires when cache read ratio is low after 3 turns', () => {
    const prevTurns = [makeTurn({ turnIndex: 0 }), makeTurn({ turnIndex: 1 }), makeTurn({ turnIndex: 2 })];
    const turn = makeTurn({ cacheReadTokens: 1000, cacheCreationTokens: 9000, turnIndex: 3 });
    const alerts = evaluate(turn, makeSession([...prevTurns, turn]), rules, new Map());
    expect(alerts.find(a => a.ruleId === 'cache-miss')).toBeDefined();
  });
  it('cache-miss does NOT fire on first 2 turns', () => {
    const turn = makeTurn({ cacheReadTokens: 1000, cacheCreationTokens: 9000, turnIndex: 1 });
    const alerts = evaluate(turn, makeSession([makeTurn({ turnIndex: 0 }), turn]), rules, new Map());
    expect(alerts.find(a => a.ruleId === 'cache-miss')).toBeUndefined();
  });
  it('cost-spike fires when turn cost is 3x average', () => {
    const prevTurns = Array.from({ length: 5 }, (_, i) => makeTurn({ costUsd: 0.05, turnIndex: i }));
    const turn = makeTurn({ costUsd: 0.50, turnIndex: 5 });
    const alerts = evaluate(turn, makeSession([...prevTurns, turn]), rules, new Map());
    expect(alerts.find(a => a.ruleId === 'cost-spike')).toBeDefined();
  });
  it('auto-compact-fired fires when compact just happened', () => {
    const turn = makeTurn();
    const session = makeSession([turn], { lastCompactAt: Date.now() - 1000, lastCompactPreTokens: 180000 });
    const alerts = evaluate(turn, session, rules, new Map());
    expect(alerts.find(a => a.ruleId === 'auto-compact-fired')).toBeDefined();
  });
  it('all rules have required fields', () => {
    for (const rule of rules) {
      expect(rule.id).toBeTruthy();
      expect(rule.name).toBeTruthy();
      expect(rule.description).toBeTruthy();
      expect(typeof rule.condition).toBe('function');
      expect(typeof rule.message).toBe('function');
      expect(['info', 'warning', 'critical']).toContain(rule.severity);
    }
  });
});
