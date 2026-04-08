// src/components/terminal/TerminalGrid.tsx
'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { TerminalPane } from './TerminalPane';

export type PaneLayout = 1 | 2 | 4;

export interface PaneState {
  id: string;
  sessionId: string | null;  // null until 'ready' received from WS server
  title: string;
  hostId: string;
}

interface TerminalGridProps {
  panes: PaneState[];
  layout: PaneLayout;
  focusedPaneId: string | null;
  wsBaseUrl: string;
  onPaneReady: (paneId: string, sessionId: string) => void;
  onPaneClose: (paneId: string) => void;
  onToggleFocus: (paneId: string) => void;
  onPaneRename: (paneId: string, title: string) => void;
}

const gridClass: Record<PaneLayout, string> = {
  1: 'grid-cols-1 grid-rows-1',
  2: 'grid-cols-2 grid-rows-1',
  4: 'grid-cols-2 grid-rows-2',
};

export function TerminalGrid({
  panes, layout, focusedPaneId, wsBaseUrl,
  onPaneReady, onPaneClose, onToggleFocus, onPaneRename,
}: TerminalGridProps) {
  // Escape key exits focus mode
  useEffect(() => {
    if (!focusedPaneId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggleFocus(focusedPaneId);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focusedPaneId, onToggleFocus]);

  const hasFocus = focusedPaneId !== null;

  return (
    <div className={cn('relative grid h-full gap-1 p-1', gridClass[layout])}>
      {panes.slice(0, layout).map((pane) => {
        const isFocused = pane.id === focusedPaneId;
        const isVisible = !hasFocus || isFocused;

        return (
          <div
            key={pane.id}
            className={cn(
              'min-h-0 min-w-0 overflow-hidden',
              isFocused && 'absolute inset-0 z-10',
              !isVisible && 'invisible'
            )}
          >
            <TerminalPane
              paneId={pane.id}
              sessionId={pane.sessionId}
              wsBaseUrl={wsBaseUrl}
              hostId={pane.hostId}
              title={pane.title}
              isFocused={isFocused}
              isVisible={isVisible}
              onReady={(sid) => onPaneReady(pane.id, sid)}
              onClose={() => onPaneClose(pane.id)}
              onToggleFocus={() => onToggleFocus(pane.id)}
              onRename={(t) => onPaneRename(pane.id, t)}
            />
          </div>
        );
      })}
    </div>
  );
}
