// src/components/terminal/TerminalWorkspace.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { nanoid } from 'nanoid';
// Import from constants.ts (not providers/local.ts) to avoid pulling node-pty into the client bundle
import { LOCAL_PROVIDER_ID } from '@/lib/terminal/constants';
import { TerminalToolbar } from './TerminalToolbar';
import { TerminalGrid, type PaneLayout, type PaneState } from './TerminalGrid';

// TerminalWorkspaceLoader fetches the WS URL from the config API, then renders TerminalWorkspace.
export function TerminalWorkspaceLoader() {
  const [wsBaseUrl, setWsBaseUrl] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    fetch('/api/terminal/config')
      .then((r) => r.json())
      .then((d: { wsUrl: string }) => setWsBaseUrl(d.wsUrl))
      .catch(() => setFetchError(true));
  }, []);

  if (fetchError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-400">
        Failed to load terminal config
      </div>
    );
  }
  if (!wsBaseUrl) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  return <TerminalWorkspace wsBaseUrl={wsBaseUrl} />;
}

interface TerminalWorkspaceProps {
  wsBaseUrl: string;
}

function TerminalWorkspace({ wsBaseUrl }: TerminalWorkspaceProps) {
  const [panes, setPanes] = useState<PaneState[]>([
    { id: nanoid(), sessionId: null, title: 'Terminal 1', hostId: LOCAL_PROVIDER_ID },
  ]);
  const [layout, setLayout] = useState<PaneLayout>(1);
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);

  const addPane = useCallback(() => {
    if (panes.length >= 4) return;
    const n = panes.length + 1;
    setPanes((prev) => [
      ...prev,
      { id: nanoid(), sessionId: null, title: `Terminal ${n}`, hostId: LOCAL_PROVIDER_ID },
    ]);
    if (n === 2) setLayout(2);
    if (n > 2) setLayout(4);
  }, [panes.length]);

  const removePane = useCallback((paneId: string) => {
    setPanes((prev) => {
      const next = prev.filter((p) => p.id !== paneId);
      return next.length > 0
        ? next
        : [{ id: nanoid(), sessionId: null, title: 'Terminal 1', hostId: LOCAL_PROVIDER_ID }];
    });
    setFocusedPaneId((id) => (id === paneId ? null : id));
  }, []);

  const handlePaneReady = useCallback((paneId: string, sessionId: string) => {
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, sessionId } : p)));
  }, []);

  const toggleFocus = useCallback((paneId: string) => {
    setFocusedPaneId((id) => (id === paneId ? null : paneId));
  }, []);

  const renamePane = useCallback((paneId: string, title: string) => {
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, title } : p)));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TerminalToolbar
        layout={layout}
        paneCount={panes.length}
        onNewPane={addPane}
        onLayoutChange={setLayout}
      />
      <div className="relative min-h-0 flex-1">
        <TerminalGrid
          panes={panes}
          layout={layout}
          focusedPaneId={focusedPaneId}
          wsBaseUrl={wsBaseUrl}
          onPaneReady={handlePaneReady}
          onPaneClose={removePane}
          onToggleFocus={toggleFocus}
          onPaneRename={renamePane}
        />
      </div>
    </div>
  );
}
