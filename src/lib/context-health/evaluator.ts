import type { TurnMetrics, SessionMetrics, HealthRule, HealthAlert, RuleConfig } from './types';

/**
 * Evaluate all rules against current metrics. Returns triggered alerts.
 * Pure function — no side effects, no state.
 */
export function evaluate(
  current: TurnMetrics,
  session: SessionMetrics,
  rules: HealthRule[],
  firedHistory: Map<string, number>,
  config?: RuleConfig,
): HealthAlert[] {
  return rules
    .filter(rule => {
      // Enabled check (from settings override)
      const override = config?.[rule.id];
      if (override?.enabled === false) return false;
      // Model filter
      if (rule.models !== '*') {
        if (!rule.models.some(m => current.model.includes(m))) return false;
      }
      // Cooldown filter
      const lastFired = firedHistory.get(rule.id);
      if (lastFired !== undefined && rule.cooldownTurns !== undefined) {
        if (current.turnIndex - lastFired < rule.cooldownTurns) return false;
      }
      return true;
    })
    .filter(rule => {
      const threshold = config?.[rule.id]?.threshold ?? rule.configSchema?.default ?? 0;
      return rule.condition(current, session, threshold);
    })
    .map(rule => ({
      ruleId: rule.id,
      severity: rule.severity,
      message: rule.message(current, session),
      actions: rule.actions ?? [{ type: 'dismiss' as const }],
    }));
}
