// src/lib/scheduler/types.ts
import type { TokenUsage } from '@/types';

export type Backend = 'claude' | 'codex';

export type TriggerSpec =
  | { kind: 'cron'; cron: string; timezone: string }
  | { kind: 'once'; runAt: number; timezone: string }
  | { kind: 'interval'; everyMs: number; timezone: string };

export interface ScheduledTask {
  id: string;
  name: string;
  description: string | null;
  workingDirectory: string;
  backend: Backend;
  model: string | null;
  effort: string | null;
  mode: string;
  trigger: TriggerSpec;
  prompt: string;
  systemPrompt: string | null;
  skipPermissions: boolean;
  maxTurns: number;
  toolTimeoutSeconds: number;
  wallClockTimeoutSeconds: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export type RunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'timed_out'
  | 'tool_timed_out'
  | 'max_turns_exceeded'
  | 'blocked_on_input'
  | 'interrupted'
  | 'cancelled';

export interface TaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: RunStatus;
  triggerSource: 'cron' | 'manual' | 'once';
  scheduledAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  tokenUsage: TokenUsage | null;
}

export type CreateTaskInput = Omit<
  ScheduledTask,
  'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'nextRunAt'
>;

export type UpdateTaskInput = Partial<CreateTaskInput>;

export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_TOOL_TIMEOUT_SECONDS = 300;
export const DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS = 1800;
export const LIVENESS_TIMEOUT_MS = 90_000;
export const ABORT_GRACE_MS = 5_000;

export const DISALLOWED_TOOLS = [
  'AskUserQuestion',
  'ExitPlanMode',
] as const;
