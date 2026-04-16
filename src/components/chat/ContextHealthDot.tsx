'use client';

import { useState } from 'react';
import type { HealthAlert } from '@/lib/context-health';

interface Props {
  alerts: HealthAlert[];
}

export function ContextHealthDot({ alerts }: Props) {
  const [showTooltip, setShowTooltip] = useState(false);
  if (alerts.length === 0) return null;

  const hasCritical = alerts.some(a => a.severity === 'critical');
  const hasWarning = alerts.some(a => a.severity === 'warning');
  const color = hasCritical
    ? 'bg-red-500'
    : hasWarning
      ? 'bg-yellow-500'
      : 'bg-blue-400';

  return (
    <span
      className="relative inline-flex ml-1 cursor-pointer"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={() => setShowTooltip(prev => !prev)}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {showTooltip && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs rounded bg-popover text-popover-foreground border shadow-md whitespace-nowrap z-50 max-w-xs">
          {alerts.map(a => a.message).join(' · ')}
        </span>
      )}
    </span>
  );
}
