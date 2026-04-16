'use client';

import { useState, useRef, useCallback } from 'react';
import { evaluate, rules } from '@/lib/context-health';
import type { TurnMetrics, SessionMetrics, HealthAlert } from '@/lib/context-health';
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

/**
 * Aggregates SSE turn data and evaluates context health rules.
 * Only active for Claude backend.
 */
export function useContextHealth(backend: 'claude' | 'codex') {
  const [alerts, setAlerts] = useState<HealthAlert[]>([]);
  const [turnAlerts, setTurnAlerts] = useState<Map<number, HealthAlert[]>>(new Map());
  const sessionRef = useRef<SessionMetrics>(createEmptySession());
  const firedHistoryRef = useRef<Map<string, number>>(new Map());

  const recordTurn = useCallback((usage: TokenUsage | null) => {
    if (backend !== 'claude' || !usage) return;

    const session = sessionRef.current;
    const turnIndex = session.turns.length;

    // input_tokens from Anthropic API = only non-cached tokens.
    // Total context size = input_tokens + cache_read + cache_creation.
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const totalInput = usage.input_tokens + cacheRead + cacheCreation;

    const turn: TurnMetrics = {
      inputTokens: totalInput, // total context sent to model
      outputTokens: usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      costUsd: usage.cost_usd ?? null,
      model: usage.model ?? '',
      contextWindow: usage.contextWindow ?? 200000,
      turnIndex,
    };

    session.turns.push(turn);
    session.totalCost += turn.costUsd ?? 0;
    session.lastActivityAt = Date.now();

    const newAlerts = evaluate(turn, session, rules, firedHistoryRef.current);
    for (const a of newAlerts) {
      firedHistoryRef.current.set(a.ruleId, turnIndex);
    }

    setAlerts(newAlerts);
    if (newAlerts.length > 0) {
      setTurnAlerts(prev => new Map(prev).set(turnIndex, newAlerts));
    }
  }, [backend]);

  const recordCompact = useCallback((trigger: string, preTokens: number) => {
    if (backend !== 'claude') return;
    const session = sessionRef.current;
    session.lastCompactAt = Date.now();
    session.lastCompactPreTokens = preTokens;

    // Evaluate compact notification rule immediately
    const turn = session.turns[session.turns.length - 1];
    if (turn) {
      const compactAlerts = evaluate(turn, session, rules, firedHistoryRef.current);
      const compactAlert = compactAlerts.find(a => a.ruleId === 'auto-compact-fired');
      if (compactAlert) {
        setAlerts(prev => [...prev.filter(a => a.ruleId !== 'auto-compact-fired'), compactAlert]);
      }
    }
  }, [backend]);

  const resetSession = useCallback(() => {
    sessionRef.current = createEmptySession();
    firedHistoryRef.current.clear();
    setAlerts([]);
    setTurnAlerts(new Map());
  }, []);

  const dismissAlert = useCallback((ruleId: string) => {
    setAlerts(prev => prev.filter(a => a.ruleId !== ruleId));
  }, []);

  return {
    alerts,
    turnAlerts,
    recordTurn,
    recordCompact,
    resetSession,
    dismissAlert,
  };
}
