/** Metrics collected per turn, passed to rule conditions */
export interface TurnMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  model: string;
  contextWindow: number;
  turnIndex: number;
}

/** Aggregated session-level metrics */
export interface SessionMetrics {
  turns: TurnMetrics[];
  totalCost: number;
  lastActivityAt: number;
  lastCompactAt: number | null;
  lastCompactPreTokens: number | null;
}

/** Quick action offered with an alert */
export type HealthAction =
  | { type: 'compact' }
  | { type: 'new-session' }
  | { type: 'dismiss' };

/** A single health rule definition */
export interface HealthRule {
  id: string;
  name: string;
  description: string;
  models: string[] | '*';
  severity: 'info' | 'warning' | 'critical';
  condition: (current: TurnMetrics, session: SessionMetrics) => boolean;
  message: (current: TurnMetrics, session: SessionMetrics) => string;
  actions?: HealthAction[];
  cooldownTurns?: number;
}

/** Result of evaluating a rule */
export interface HealthAlert {
  ruleId: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  actions: HealthAction[];
}
