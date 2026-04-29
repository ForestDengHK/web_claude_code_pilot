'use client';

import type { HealthAlert, HealthAction } from '@/lib/context-health';

interface Props {
  alerts: HealthAlert[];
  /**
   * Session-level dismiss — hook-side impl adds the rule to a dismissed Set
   * so future turns don't re-fire the same rule, and clears it from the
   * message-level dots too. See `useContextHealth.dismissAlert`.
   */
  onDismiss: (ruleId: string) => void;
  onAction: (action: HealthAction) => void;
}

export function ContextHealthToast({ alerts, onDismiss, onAction }: Props) {
  // Only show warning/critical alerts as toast — info stays on the dot.
  const toastAlerts = alerts.filter(a => a.severity !== 'info');

  // Show highest severity alert only.
  const alert = [...toastAlerts].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  })[0];

  if (!alert) return null;

  const borderColor = alert.severity === 'critical'
    ? 'border-red-500/50'
    : 'border-yellow-500/50';
  const icon = alert.severity === 'critical' ? '\u{1F534}' : '\u26A0\uFE0F';

  return (
    <div
      className={`ml-2 mr-12 mb-2 rounded-lg border ${borderColor} bg-popover/95 px-3 py-2 text-sm shadow-md backdrop-blur-sm`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 break-words leading-5">
          <span className="mr-1">{icon}</span>
          {alert.message}
        </span>
        <button
          onClick={() => onDismiss(alert.ruleId)}
          className="shrink-0 -mr-1 -mt-1 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/60 text-base leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Dismiss for this session"
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
                // Dismiss before taking the action so the toast disappears
                // immediately even if the action is async (compact takes a
                // turn to finalize). Hook's dismissAlert is idempotent.
                onDismiss(alert.ruleId);
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
