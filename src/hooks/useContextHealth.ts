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

function usageToTurnMetrics(usage: TokenUsage, turnIndex: number, leaked = false): TurnMetrics {
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
    leakedToolCall: leaked,
  };
}

/**
 * Aggregates SSE turn data and evaluates context health rules.
 * Only active for Claude backend. Loads rule config from app settings.
 */
export function useContextHealth(backend: 'claude' | 'codex' | 'channels') {
  const [alerts, setAlerts] = useState<HealthAlert[]>([]);
  const [turnAlerts, setTurnAlerts] = useState<Map<number, HealthAlert[]>>(new Map());
  const sessionRef = useRef<SessionMetrics>(createEmptySession());
  const firedHistoryRef = useRef<Map<string, number>>(new Map());
  const configRef = useRef<RuleConfig>({});
  const enabledRef = useRef(true);
  const settingsLoadedRef = useRef(false);
  const pendingUsagesRef = useRef<Array<{ usage: TokenUsage; leaked: boolean }>>([]);
  // Rule ids the user explicitly dismissed this session. In-memory only:
  // cleared on `resetSession()` and on page reload (user would have a fresh
  // context then anyway). For permanent mute, Settings → Context Health lets
  // the user disable a rule outright — we don't duplicate that here.
  const dismissedRuleIdsRef = useRef<Set<string>>(new Set());

  const appendTurn = useCallback((usage: TokenUsage, leaked = false) => {
    const session = sessionRef.current;
    const turnIndex = session.turns.length;
    const turn = usageToTurnMetrics(usage, turnIndex, leaked);

    session.turns.push(turn);
    session.totalCost += turn.costUsd ?? 0;
    session.lastActivityAt = Date.now();

    // Evaluate rules, then filter out whatever the user has dismissed this
    // session so the same rule can't ping again via cooldown re-fire. We still
    // update `firedHistoryRef` for dismissed rules so the cooldown clock keeps
    // ticking — if the user later calls `resetSession()` the cooldowns are a
    // non-issue, and if we ever want "unmute" we have the data intact.
    const rawAlerts = evaluate(turn, session, rules, firedHistoryRef.current, configRef.current);
    for (const alert of rawAlerts) {
      firedHistoryRef.current.set(alert.ruleId, turnIndex);
    }
    const newAlerts = rawAlerts.filter(a => !dismissedRuleIdsRef.current.has(a.ruleId));

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
    for (const { usage, leaked } of pending) {
      const { turnIndex, newAlerts } = appendTurn(usage, leaked);
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

  const recordTurn = useCallback((usage: TokenUsage | null, leaked = false) => {
    if (backend !== 'claude' || !usage) return;
    if (!settingsLoadedRef.current) {
      pendingUsagesRef.current.push({ usage, leaked });
      return;
    }
    if (!enabledRef.current) return;

    const { turnIndex, newAlerts } = appendTurn(usage, leaked);
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
    dismissedRuleIdsRef.current.clear();
    setAlerts([]);
    setTurnAlerts(new Map());
  }, []);

  /**
   * "Not right now" for this session. Marks the rule as dismissed in the ref
   * so future turns skip it (see `appendTurn`), and also clears it from both
   * the top-level toast state and every per-turn entry so dots on historical
   * messages disappear too — single click, all surfaces consistent.
   */
  const dismissAlert = useCallback((ruleId: string) => {
    dismissedRuleIdsRef.current.add(ruleId);
    setAlerts(prev => prev.filter(a => a.ruleId !== ruleId));
    setTurnAlerts(prev => {
      let mutated = false;
      const next = new Map<number, HealthAlert[]>();
      for (const [turnIndex, list] of prev) {
        const filtered = list.filter(a => a.ruleId !== ruleId);
        if (filtered.length !== list.length) mutated = true;
        if (filtered.length > 0) next.set(turnIndex, filtered);
      }
      return mutated ? next : prev;
    });
  }, []);

  /**
   * Rebuild state from persisted assistant messages.
   * This keeps turn indexes aligned after reload/recovery without replaying toasts.
   */
  const hydrateHistory = useCallback((turns: Array<{ usage: TokenUsage; leaked: boolean }>) => {
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

    for (const { usage, leaked } of turns) {
      const turn = usageToTurnMetrics(usage, session.turns.length, leaked);
      session.turns.push(turn);
      session.totalCost += turn.costUsd ?? 0;
      session.lastActivityAt = Date.now();

      const rawAlerts = evaluate(turn, session, rules, firedHistory, configRef.current);
      for (const alert of rawAlerts) {
        firedHistory.set(alert.ruleId, turn.turnIndex);
      }
      // Respect session-level dismissals during history hydration too so a
      // page reload doesn't re-surface alerts the user silenced for rules the
      // user already knows about. (Dismissed ref is cleared by resetSession
      // but survives hydrations within the same session.)
      const visible = rawAlerts.filter(a => !dismissedRuleIdsRef.current.has(a.ruleId));
      if (visible.length > 0) {
        hydratedTurnAlerts.set(turn.turnIndex, visible);
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
