import { describe, it, expect } from 'vitest';
import { evaluate } from '../../lib/context-health/evaluator';
import type { TurnMetrics, SessionMetrics, HealthRule } from '../../lib/context-health/types';

const baseTurn: TurnMetrics = {
  inputTokens: 50000, outputTokens: 5000, cacheReadTokens: 40000,
  cacheCreationTokens: 5000, costUsd: 0.05, model: 'claude-opus-4-6',
  contextWindow: 200000, turnIndex: 5,
};
const baseSession: SessionMetrics = {
  turns: Array.from({ length: 5 }, (_, i) => ({ ...baseTurn, turnIndex: i })),
  totalCost: 0.25, lastActivityAt: Date.now(), lastCompactAt: null, lastCompactPreTokens: null,
};
const testRule: HealthRule = {
  id: 'test-rule', name: 'Test', description: 'Test rule', models: '*',
  severity: 'warning', condition: (t) => t.inputTokens > 100000,
  message: () => 'Too many tokens', actions: [{ type: 'compact' }], cooldownTurns: 3,
};

describe('evaluate', () => {
  it('returns empty array when no rules match', () => {
    expect(evaluate(baseTurn, baseSession, [testRule], new Map())).toEqual([]);
  });
  it('returns alert when rule condition is met', () => {
    const bigTurn = { ...baseTurn, inputTokens: 150000 };
    const alerts = evaluate(bigTurn, baseSession, [testRule], new Map());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].ruleId).toBe('test-rule');
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].message).toBe('Too many tokens');
  });
  it('filters by model when models is an array', () => {
    const haikuRule: HealthRule = { ...testRule, models: ['haiku'] };
    const bigTurn = { ...baseTurn, inputTokens: 150000 };
    expect(evaluate(bigTurn, baseSession, [haikuRule], new Map())).toEqual([]);
  });
  it('matches model by substring', () => {
    const opusRule: HealthRule = { ...testRule, models: ['opus'] };
    const bigTurn = { ...baseTurn, inputTokens: 150000 };
    expect(evaluate(bigTurn, baseSession, [opusRule], new Map())).toHaveLength(1);
  });
  it('respects cooldown', () => {
    const bigTurn = { ...baseTurn, inputTokens: 150000, turnIndex: 5 };
    const firedHistory = new Map([['test-rule', 4]]);
    expect(evaluate(bigTurn, baseSession, [testRule], firedHistory)).toEqual([]);
  });
  it('fires again after cooldown expires', () => {
    const bigTurn = { ...baseTurn, inputTokens: 150000, turnIndex: 8 };
    const firedHistory = new Map([['test-rule', 4]]);
    expect(evaluate(bigTurn, baseSession, [testRule], firedHistory)).toHaveLength(1);
  });
  it('provides default dismiss action when rule has no actions', () => {
    const noActionRule: HealthRule = { ...testRule, actions: undefined };
    const bigTurn = { ...baseTurn, inputTokens: 150000 };
    expect(evaluate(bigTurn, baseSession, [noActionRule], new Map())[0].actions).toEqual([{ type: 'dismiss' }]);
  });
});
