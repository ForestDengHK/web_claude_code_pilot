// src/types/organize.ts

export interface OrganizeSuggestion {
  sessionId: string;
  sessionTitle: string;
  projectName: string;
  messageCount: number;
  lastUpdated: string;
  action: 'delete' | 'rename' | 'keep';
  reason: string;
  suggestedTitle?: string;
  confidence: 'rule' | 'ai';
  analyzed: boolean;
}

export interface OrganizeConfig {
  model: string;
  backend: 'claude' | 'codex';
  effort: string;
  scope: string;
  forceRescanAll: boolean;
  trustMode: boolean;
  cleanupCli: boolean;
  headPairs: number;
  tailPairs: number;
  emptyMaxAgeDays: number;
  inactiveMaxAgeDays: number;
  inactiveMaxMessages: number;
  titleMaxLength: number;
}

export const DEFAULT_ORGANIZE_CONFIG: OrganizeConfig = {
  model: 'default',
  backend: 'claude',
  effort: '',
  scope: 'all',
  forceRescanAll: false,
  trustMode: false,
  cleanupCli: false,
  headPairs: 4,
  tailPairs: 4,
  emptyMaxAgeDays: 30,
  inactiveMaxAgeDays: 90,
  inactiveMaxMessages: 10,
  titleMaxLength: 15,
};

export interface OrganizeRequest {
  model?: string;
  backend?: 'claude' | 'codex';
  effort?: string;
  scope?: string;
  forceRescanAll?: boolean;
  trustMode?: boolean;
  cleanupCli?: boolean;
  headPairs?: number;
  tailPairs?: number;
  emptyMaxAgeDays?: number;
  inactiveMaxAgeDays?: number;
  inactiveMaxMessages?: number;
  titleMaxLength?: number;
}

export interface OrganizeTask {
  id: string;
  status: 'running' | 'done' | 'error';
  config: string;
  created_at: string;
  updated_at: string;
  results: string;
}

export type OrganizeSSEEvent =
  | { type: 'progress'; phase: 'rules' | 'ai'; completed: number; total: number }
  | { type: 'suggestion'; data: OrganizeSuggestion }
  | { type: 'done'; summary: { delete: number; rename: number; keep: number } }
  | { type: 'error'; message: string }
  | { type: 'heartbeat' };

export interface OrganizeStatusResponse {
  hasTask: boolean;
  taskId?: string;
  status?: 'running' | 'done' | 'error';
  config?: OrganizeConfig;
  results?: OrganizeSuggestion[];
  progress?: { phase: string; completed: number; total: number };
}

export interface ExecuteRequest {
  taskId: string;
  actions: Array<{
    sessionId: string;
    action: 'delete' | 'rename';
    newTitle?: string;
  }>;
  cleanupCli: boolean;
}

export type ExecuteSSEEvent =
  | { type: 'progress'; completed: number; total: number; sessionId: string; action: string; success: boolean; error?: string }
  | { type: 'done'; summary: { success: number; failed: number; failures: Array<{ sessionId: string; error: string }> } }
  | { type: 'heartbeat' };
