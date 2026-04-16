'use client';

import { useState } from 'react';
import type { HealthAlert, HealthAction } from '@/lib/context-health';

interface Props {
  alerts: HealthAlert[];
  onDismiss: (ruleId: string) => void;
  onAction: (action: HealthAction) => void;
}

export function ContextHealthToast({ alerts, onDismiss, onAction }: Props) {
  const [hiddenAlertKeys, setHiddenAlertKeys] = useState<Set<string>>(new Set());

  // Only show warning/critical alerts as toast
  const toastAlerts = alerts.filter(a => a.severity !== 'info');

  // Show highest severity alert only
  const alert = [...toastAlerts].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  })[0];
  const alertKey = alert ? `${alert.ruleId}:${alert.message}` : null;

  if (!alert || !alertKey || hiddenAlertKeys.has(alertKey)) return null;

  const borderColor = alert.severity === 'critical'
    ? 'border-red-500/50'
    : 'border-yellow-500/50';
  const icon = alert.severity === 'critical' ? '\u{1F534}' : '\u26A0\uFE0F';

  return (
    <div
      className={`mx-2 mb-2 rounded-lg border ${borderColor} bg-popover/95 px-3 py-2 text-sm shadow-md backdrop-blur-sm`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 break-words leading-5">
          <span className="mr-1">{icon}</span>
          {alert.message}
        </span>
        <button
          onClick={() => {
            setHiddenAlertKeys(prev => {
              const next = new Set(prev);
              next.add(alertKey);
              return next;
            });
            onDismiss(alert.ruleId);
          }}
          className="shrink-0 px-1 text-xs text-muted-foreground hover:text-foreground"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {alert.actions
          .filter(a => a.type !== 'dismiss')
          .map(action => (
            <button
              key={action.type}
              onClick={() => {
                setHiddenAlertKeys(prev => {
                  const next = new Set(prev);
                  next.add(alertKey);
                  return next;
                });
                onAction(action);
              }}
              className="rounded bg-muted px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted/80"
            >
              {action.type === 'compact' ? 'Compact' : 'New Session'}
            </button>
          ))}
      </div>
    </div>
  );
}
