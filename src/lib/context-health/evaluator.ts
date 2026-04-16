import type { TurnMetrics, SessionMetrics, HealthRule, HealthAlert } from './types';

export function evaluate(
  current: TurnMetrics,
  session: SessionMetrics,
  rules: HealthRule[],
  firedHistory: Map<string, number>,
): HealthAlert[] {
  return rules
    .filter(rule => {
      if (rule.models !== '*') {
        if (!rule.models.some(m => current.model.includes(m))) return false;
      }
      const lastFired = firedHistory.get(rule.id);
      if (lastFired !== undefined && rule.cooldownTurns !== undefined) {
        if (current.turnIndex - lastFired < rule.cooldownTurns) return false;
      }
      return true;
    })
    .filter(rule => rule.condition(current, session))
    .map(rule => ({
      ruleId: rule.id,
      severity: rule.severity,
      message: rule.message(current, session),
      actions: rule.actions ?? [{ type: 'dismiss' as const }],
    }));
}
