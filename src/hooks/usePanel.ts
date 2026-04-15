"use client";

import { createContext, useContext } from "react";

export type PanelContent = "files" | "tasks" | "history";

export type PreviewViewMode = "source" | "rendered";

export interface DiffTarget {
  file: string;
  commit?: string;
}

export interface StreamingSessionInfo {
  sessionId: string;
  sessionTitle: string;
  status: 'streaming' | 'waiting_permission' | 'waiting_input';
  statusText: string;
  startedAt: number;
}

export interface PanelContextValue {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  panelContent: PanelContent;
  setPanelContent: (content: PanelContent) => void;
  workingDirectory: string;
  setWorkingDirectory: (dir: string) => void;
  sessionId: string;
  setSessionId: (id: string) => void;
  sessionTitle: string;
  setSessionTitle: (title: string) => void;
  streamingSessionId: string;
  setStreamingSessionId: (id: string) => void;
  pendingApprovalSessionId: string;
  setPendingApprovalSessionId: (id: string) => void;
  previewFile: string | null;
  setPreviewFile: (path: string | null) => void;
  previewLine: number | null;
  setPreviewLine: (line: number | null) => void;
  previewViewMode: PreviewViewMode;
  setPreviewViewMode: (mode: PreviewViewMode) => void;
  diffTarget: DiffTarget | null;
  setDiffTarget: (target: DiffTarget | null) => void;
  streamingSessions: Map<string, StreamingSessionInfo>;
  addStreamingSession: (info: StreamingSessionInfo) => void;
  updateStreamingSession: (sessionId: string, updates: Partial<Omit<StreamingSessionInfo, 'sessionId'>>) => void;
  removeStreamingSession: (sessionId: string) => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within a PanelProvider");
  }
  return ctx;
}
