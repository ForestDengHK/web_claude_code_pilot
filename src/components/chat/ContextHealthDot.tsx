'use client';

import { memo, useState } from 'react';
import type { HealthAlert } from '@/lib/context-health';

interface Props {
  alerts: HealthAlert[];
}

export const ContextHealthDot = memo(function ContextHealthDot({ alerts }: Props) {
  const [showTooltip, setShowTooltip] = useState(false);
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
      onBlur={() => setShowTooltip(false)}
      tabIndex={0}
      role="button"
      aria-label="Context health details"
      aria-expanded={showTooltip}
    >
      <span className={`block h-2 w-2 rounded-full ${color} ring-1 ring-background/80`} />
      {showTooltip && (
        <span className="absolute bottom-full left-1/2 z-50 mb-1 w-max max-w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 rounded border bg-popover px-2 py-1 text-left text-xs leading-4 text-popover-foreground shadow-md whitespace-normal break-words sm:max-w-xs">
          {tooltipText}
        </span>
      )}
    </span>
  );
});
