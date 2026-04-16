'use client';

import { memo, useState, useCallback } from 'react';
import type { HealthAlert } from '@/lib/context-health';

interface Props {
  alerts: HealthAlert[];
  /**
   * Optional callback that dismisses a rule for the rest of this session.
   * Shared with the top-level ContextHealthToast — dismissing from either
   * surface hides both, since the hook is the single source of truth.
   * If omitted, the tooltip renders read-only (backwards compatible).
   */
  onDismiss?: (ruleId: string) => void;
}

export const ContextHealthDot = memo(function ContextHealthDot({ alerts, onDismiss }: Props) {
  const [showTooltip, setShowTooltip] = useState(false);

  // Dismiss every rule currently shown in the tooltip. Typically this is 1
  // alert; worst case 2–3. Batch is simpler than per-row X and the tooltip
  // stays visually tight.
  const handleDismissAll = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onDismiss) return;
    for (const alert of alerts) onDismiss(alert.ruleId);
    setShowTooltip(false);
  }, [alerts, onDismiss]);

  if (alerts.length === 0) return null;

  const hasCritical = alerts.some(a => a.severity === 'critical');
  const hasWarning = alerts.some(a => a.severity === 'warning');
  const color = hasCritical
    ? 'bg-red-500'
    : hasWarning
      ? 'bg-yellow-500'
      : 'bg-blue-400';
  const tooltipText = alerts.map(a => a.message).join(' · ');

  return (
    <span
      className="relative ml-1 inline-flex h-2 w-2 shrink-0 cursor-pointer align-middle"
      onClick={() => setShowTooltip(prev => !prev)}
      onBlur={(e) => {
        // Keep the tooltip open while focus moves to the dismiss button
        // inside it — without this the blur closes it before the click fires.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setShowTooltip(false);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label="Context health details"
      aria-expanded={showTooltip}
    >
      <span className={`block h-2 w-2 rounded-full ${color} ring-1 ring-background/80`} />
      {showTooltip && (
        <span className="absolute bottom-full left-1/2 z-50 mb-1 flex w-max max-w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded border bg-popover px-2 py-1 text-left text-xs leading-4 text-popover-foreground shadow-md whitespace-normal break-words sm:max-w-xs">
          <span className="min-w-0 flex-1">{tooltipText}</span>
          {onDismiss && (
            <button
              type="button"
              onClick={handleDismissAll}
              className="shrink-0 self-start px-1 leading-4 text-muted-foreground hover:text-foreground"
              aria-label={alerts.length > 1 ? 'Dismiss all for this session' : 'Dismiss for this session'}
            >
              ✕
            </button>
          )}
        </span>
      )}
    </span>
  );
});
