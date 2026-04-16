'use client';

import { useEffect, useState } from 'react';
import type { HealthAlert, HealthAction } from '@/lib/context-health';

interface Props {
  alerts: HealthAlert[];
  onDismiss: (ruleId: string) => void;
  onAction: (action: HealthAction) => void;
}

export function ContextHealthToast({ alerts, onDismiss, onAction }: Props) {
  const [visible, setVisible] = useState(false);

  // Only show warning/critical alerts as toast
  const toastAlerts = alerts.filter(a => a.severity !== 'info');

  // Show highest severity alert only
  const alert = toastAlerts.sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  })[0];

  useEffect(() => {
    if (alert) {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), 15000);
      return () => clearTimeout(timer);
    } else {
      setVisible(false);
    }
  }, [alert?.ruleId, alert?.message]);

  if (!visible || !alert) return null;

  const borderColor = alert.severity === 'critical'
    ? 'border-red-500/50'
    : 'border-yellow-500/50';
  const icon = alert.severity === 'critical' ? '\u{1F534}' : '\u26A0\uFE0F';

  return (
    <div className={`mx-2 mb-2 px-3 py-2 rounded-lg border ${borderColor} bg-popover/95 backdrop-blur-sm text-sm shadow-md animate-in fade-in slide-in-from-top-2 duration-200`}>
      <div className="flex items-start justify-between gap-2">
        <span className="flex-1">
          <span className="mr-1">{icon}</span>
          {alert.message}
        </span>
        <button
          onClick={() => { setVisible(false); onDismiss(alert.ruleId); }}
          className="text-muted-foreground hover:text-foreground text-xs px-1"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      <div className="flex gap-2 mt-1.5">
        {alert.actions
          .filter(a => a.type !== 'dismiss')
          .map(action => (
            <button
              key={action.type}
              onClick={() => { setVisible(false); onAction(action); }}
              className="text-xs px-2 py-0.5 rounded bg-muted hover:bg-muted/80 text-foreground transition-colors"
            >
              {action.type === 'compact' ? 'Compact' : 'New Session'}
            </button>
          ))}
      </div>
    </div>
  );
}
