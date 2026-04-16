'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { evaluate, rules } from '@/lib/context-health';
import type { TurnMetrics, SessionMetrics, HealthAlert, RuleConfig } from '@/lib/context-health';
import type { TokenUsage } from '@/types';

function createEmptySession(): SessionMetrics {
  return {
    turns: [],
    totalCost: 0,
    lastActivityAt: Date.now(),
    lastCompactAt: null,
    lastCompactPreTokens: null,
  };
}

function usageToTurnMetrics(usage: TokenUsage, turnIndex: number): TurnMetrics {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;

  // Anthropic reports only non-cached prompt tokens in input_tokens.
  // For context saturation we care about the full prompt sent to the model.
  return {
    inputTokens: usage.input_tokens + cacheRead + cacheCreation,
    outputTokens: usage.output_tokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    costUsd: usage.cost_usd ?? null,
    model: usage.model ?? '',
    contextWindow: usage.contextWindow ?? 200000,
    turnIndex,
  };
}

/**
 * Aggregates SSE turn data and evaluates context health rules.
 * Only active for Claude backend. Loads rule config from app settings.
 */
export function useContextHealth(backend: 'claude' | 'codex') {
  const [alerts, setAlerts] = useState<HealthAlert[]>([]);
  const [turnAlerts, setTurnAlerts] = useState<Map<number, HealthAlert[]>>(new Map());
  const sessionRef = useRef<SessionMetrics>(createEmptySession());
  const firedHistoryRef = useRef<Map<string, number>>(new Map());
  const configRef = useRef<RuleConfig>({});
  const enabledRef = useRef(true);
  const settingsLoadedRef = useRef(false);
  const pendingUsagesRef = useRef<TokenUsage[]>([]);

  const appendTurn = useCallback((usage: TokenUsage) => {
    const session = sessionRef.current;
    const turnIndex = session.turns.length;
    const turn = usageToTurnMetrics(usage, turnIndex);

    session.turns.push(turn);
    session.totalCost += turn.costUsd ?? 0;
    session.lastActivityAt = Date.now();

    const newAlerts = evaluate(turn, session, rules, firedHistoryRef.current, configRef.current);
    for (const alert of newAlerts) {
      firedHistoryRef.current.set(alert.ruleId, turnIndex);
    }

    return { turnIndex, newAlerts };
  }, []);

  // Stable: no dependency on `turnAlerts`. Uses functional setState so we
  // always merge into the latest state, never an outdated closure snapshot.
  // Also short-circuits when there's nothing pending so we never replace state
  // with a recreated empty Map (which would wipe out alerts already added by
  // `recordTurn` from SSE).
  const flushPendingUsages = useCallback(() => {
    if (!settingsLoadedRef.current) return;
    if (!enabledRef.current) {
      pendingUsagesRef.current = [];
      return;
    }
    if (pendingUsagesRef.current.length === 0) return;

    const pending = pendingUsagesRef.current;
    pendingUsagesRef.current = [];

    let latestAlerts: HealthAlert[] = [];
    const additions: Array<[number, HealthAlert[]]> = [];
    for (const usage of pending) {
      const { turnIndex, newAlerts } = appendTurn(usage);
      latestAlerts = newAlerts;
      if (newAlerts.length > 0) {
        additions.push([turnIndex, newAlerts]);
      }
    }

    if (additions.length > 0) {
      setTurnAlerts(prev => {
        const next = new Map(prev);
        for (const [idx, alerts] of additions) next.set(idx, alerts);
        return next;
      });
    }
    if (latestAlerts.length > 0) {
      setAlerts(latestAlerts);
    }
  }, [appendTurn]);

  // Keep a ref to the latest flushPendingUsages so the mount-effect can call
  // it without listing it as a dependency (which would cause the effect to
  // re-fire — and re-fetch settings — every time the callback ref changes).
  const flushPendingUsagesRef = useRef(flushPendingUsages);
  useEffect(() => {
    flushPendingUsagesRef.current = flushPendingUsages;
  }, [flushPendingUsages]);

  // Load rule config from app settings on mount. Runs ONCE per backend change.
  useEffect(() => {
    if (backend !== 'claude') return;
    fetch('/api/settings/app')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.settings) return;

        enabledRef.current = data.settings.context_health_enabled !== 'false';

        if (data.settings.context_health_config) {
          try {
            configRef.current = JSON.parse(data.settings.context_health_config);
          } catch {
            configRef.current = {};
          }
        } else {
          configRef.current = {};
        }
        settingsLoadedRef.current = true;
        flushPendingUsagesRef.current();
      })
      .catch(() => { /* ignore fetch errors */ });
  }, [backend]);

  const recordTurn = useCallback((usage: TokenUsage | null) => {
    if (backend !== 'claude' || !usage) return;
    if (!settingsLoadedRef.current) {
      pendingUsagesRef.current.push(usage);
      return;
    }
    if (!enabledRef.current) return;

    const { turnIndex, newAlerts } = appendTurn(usage);
    setAlerts(newAlerts);
    if (newAlerts.length > 0) {
      setTurnAlerts(prev => new Map(prev).set(turnIndex, newAlerts));
    }
  }, [appendTurn, backend]);

  const recordCompact = useCallback((trigger: string, preTokens: number) => {
    if (backend !== 'claude' || !enabledRef.current) return;
    const session = sessionRef.current;
    session.lastCompactAt = Date.now();
    session.lastCompactPreTokens = preTokens;

    // Evaluate compact notification rule immediately
    const turn = session.turns[session.turns.length - 1];
    if (turn) {
      const compactAlerts = evaluate(turn, session, rules, firedHistoryRef.current, configRef.current);
      const compactAlert = compactAlerts.find(a => a.ruleId === 'auto-compact-fired');
      if (compactAlert) {
        setAlerts(prev => [...prev.filter(a => a.ruleId !== 'auto-compact-fired'), compactAlert]);
      }
    }
  }, [backend]);

  const resetSession = useCallback(() => {
    sessionRef.current = createEmptySession();
    firedHistoryRef.current.clear();
    pendingUsagesRef.current = [];
    setAlerts([]);
    setTurnAlerts(new Map());
  }, []);

  const dismissAlert = useCallback((ruleId: string) => {
    setAlerts(prev => prev.filter(a => a.ruleId !== ruleId));
  }, []);

  /**
   * Rebuild state from persisted assistant messages.
   * This keeps turn indexes aligned after reload/recovery without replaying toasts.
   */
  const hydrateHistory = useCallback((usages: TokenUsage[]) => {
    if (backend !== 'claude') return;

    if (!enabledRef.current) {
      sessionRef.current = createEmptySession();
      firedHistoryRef.current = new Map();
      setTurnAlerts(new Map());
      setAlerts([]);
      return;
    }

    const session = createEmptySession();
    const firedHistory = new Map<string, number>();
    const hydratedTurnAlerts = new Map<number, HealthAlert[]>();

    for (const usage of usages) {
      const turn = usageToTurnMetrics(usage, session.turns.length);
      session.turns.push(turn);
      session.totalCost += turn.costUsd ?? 0;
      session.lastActivityAt = Date.now();

      const newAlerts = evaluate(turn, session, rules, firedHistory, configRef.current);
      for (const alert of newAlerts) {
        firedHistory.set(alert.ruleId, turn.turnIndex);
      }
      if (newAlerts.length > 0) {
        hydratedTurnAlerts.set(turn.turnIndex, newAlerts);
      }
    }

    sessionRef.current = session;
    firedHistoryRef.current = firedHistory;
    setTurnAlerts(hydratedTurnAlerts);
  }, [backend]);

  /**
   * Reload settings from app settings (called after settings load/change).
   * Stable callback — uses the ref to flush so we don't churn dependent
   * effects in consumers (which would cause extra fetch + state-write loops).
   */
  const reloadSettings = useCallback((config: RuleConfig, enabled: boolean) => {
    configRef.current = config;
    enabledRef.current = enabled;
    settingsLoadedRef.current = true;
    if (!enabled) {
      setAlerts([]);
      setTurnAlerts(new Map());
      pendingUsagesRef.current = [];
      return;
    }
    flushPendingUsagesRef.current();
  }, []);

  return {
    alerts,
    turnAlerts,
    recordTurn,
    recordCompact,
    resetSession,
    dismissAlert,
    hydrateHistory,
    reloadSettings,
  };
}
