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
  /** True when this turn leaked a tool call as plain text (degradation signal). */
  leakedToolCall?: boolean;
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

/** Describes a configurable threshold for a rule */
export interface RuleConfigSchema {
  label: string;
  type: 'percentage' | 'multiplier' | 'minutes';
  default: number;
  min: number;
  max: number;
  step?: number;
  tip: string;
}

/** A single health rule definition */
export interface HealthRule {
  id: string;
  name: string;
  description: string;
  models: string[] | '*';
  severity: 'info' | 'warning' | 'critical';
  /** 3rd arg = threshold override (meaning depends on rule's configSchema) */
  condition: (current: TurnMetrics, session: SessionMetrics, threshold: number) => boolean;
  message: (current: TurnMetrics, session: SessionMetrics) => string;
  actions?: HealthAction[];
  cooldownTurns?: number;
  /** If present, this rule has a configurable threshold shown in Settings */
  configSchema?: RuleConfigSchema;
}

/** Per-rule overrides stored in settings */
export interface RuleOverride {
  enabled?: boolean;
  threshold?: number;
}

/** Full config stored as JSON in app settings key `context_health_config` */
export type RuleConfig = Record<string, RuleOverride>;

/** Result of evaluating a rule */
export interface HealthAlert {
  ruleId: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  actions: HealthAction[];
}
