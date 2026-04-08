// src/components/terminal/TerminalToolbar.tsx
'use client';

import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import type { PaneLayout } from './TerminalGrid';

interface TerminalToolbarProps {
  layout: PaneLayout;
  paneCount: number;
  onNewPane: () => void;
  onLayoutChange: (layout: PaneLayout) => void;
}

const LAYOUTS: { value: PaneLayout; label: string }[] = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
];

export function TerminalToolbar({ layout, paneCount, onNewPane, onLayoutChange }: TerminalToolbarProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3">
      <span className="text-sm font-medium text-foreground">Terminal</span>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onNewPane}
        disabled={paneCount >= 4}
        className="h-7 gap-1 text-xs"
      >
        <HugeiconsIcon icon={Add01Icon} className="h-3.5 w-3.5" />
        New
      </Button>
      <div className="flex items-center gap-0.5 rounded border border-border/50 p-0.5">
        {LAYOUTS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => onLayoutChange(value)}
            className={`min-w-[24px] rounded px-2 py-0.5 text-xs transition-colors ${
              layout === value
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
