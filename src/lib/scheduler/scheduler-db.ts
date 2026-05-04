import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import type {
  ScheduledTask,
  CreateTaskInput,
  UpdateTaskInput,
  TaskRun,
  RunStatus,
  TriggerSpec,
} from './types';

interface TaskRow {
  id: string;
  name: string;
  description: string | null;
  working_directory: string;
  backend: string;
  model: string | null;
  effort: string | null;
  mode: string;
  trigger_kind: string;
  trigger_cron: string | null;
  trigger_run_at: number | null;
  trigger_every_ms: number | null;
  timezone: string;
  prompt: string;
  system_prompt: string | null;
  skip_permissions: number;
  max_turns: number;
  tool_timeout_seconds: number;
  wall_clock_timeout_seconds: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  session_id: string | null;
  status: string;
  trigger_source: string;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

function rowToTask(r: TaskRow): ScheduledTask {
  let trigger: TriggerSpec;
  if (r.trigger_kind === 'cron') {
    trigger = { kind: 'cron', cron: r.trigger_cron!, timezone: r.timezone };
  } else if (r.trigger_kind === 'once') {
    trigger = { kind: 'once', runAt: r.trigger_run_at!, timezone: r.timezone };
  } else {
    trigger = { kind: 'interval', everyMs: r.trigger_every_ms!, timezone: r.timezone };
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    workingDirectory: r.working_directory,
    backend: r.backend as 'claude' | 'codex',
    model: r.model,
    effort: r.effort,
    mode: r.mode,
    trigger,
    prompt: r.prompt,
    systemPrompt: r.system_prompt,
    skipPermissions: r.skip_permissions === 1,
    maxTurns: r.max_turns,
    toolTimeoutSeconds: r.tool_timeout_seconds,
    wallClockTimeoutSeconds: r.wall_clock_timeout_seconds,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
  };
}

function rowToRun(r: RunRow): TaskRun {
  const hasUsage =
    r.input_tokens !== null || r.output_tokens !== null ||
    r.cache_read_tokens !== null || r.cache_creation_tokens !== null;
  return {
    id: r.id,
    taskId: r.task_id,
    sessionId: r.session_id,
    status: r.status as RunStatus,
    triggerSource: r.trigger_source as 'cron' | 'manual' | 'once',
    scheduledAt: r.scheduled_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    tokenUsage: hasUsage
      ? {
          input_tokens: r.input_tokens ?? 0,
          output_tokens: r.output_tokens ?? 0,
          cache_read_input_tokens: r.cache_read_tokens ?? 0,
          cache_creation_input_tokens: r.cache_creation_tokens ?? 0,
        }
      : null,
  };
}

export function createTask(input: CreateTaskInput): ScheduledTask {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const t = input.trigger;
  db.prepare(`
    INSERT INTO scheduled_tasks (
      id, name, description, working_directory, backend, model, effort, mode,
      trigger_kind, trigger_cron, trigger_run_at, trigger_every_ms, timezone,
      prompt, system_prompt, skip_permissions, max_turns, tool_timeout_seconds,
      wall_clock_timeout_seconds, enabled, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, input.name, input.description, input.workingDirectory, input.backend,
    input.model, input.effort, input.mode,
    t.kind,
    t.kind === 'cron' ? t.cron : null,
    t.kind === 'once' ? t.runAt : null,
    t.kind === 'interval' ? t.everyMs : null,
    t.timezone,
    input.prompt, input.systemPrompt,
    input.skipPermissions ? 1 : 0,
    input.maxTurns, input.toolTimeoutSeconds, input.wallClockTimeoutSeconds,
    input.enabled ? 1 : 0,
    now, now,
  );
  return getTask(id)!;
}

export function getTask(id: string): ScheduledTask | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(opts?: { enabled?: boolean; workingDirectory?: string }): ScheduledTask[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.enabled !== undefined) { where.push("enabled = ?"); params.push(opts.enabled ? 1 : 0); }
  if (opts?.workingDirectory) { where.push("working_directory = ?"); params.push(opts.workingDirectory); }
  const sql = `SELECT * FROM scheduled_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  const rows = db.prepare(sql).all(...params) as TaskRow[];
  return rows.map(rowToTask);
}

export function updateTask(id: string, patch: UpdateTaskInput): ScheduledTask | null {
  const existing = getTask(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  const t = merged.trigger;
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    UPDATE scheduled_tasks SET
      name = ?, description = ?, working_directory = ?, backend = ?, model = ?, effort = ?, mode = ?,
      trigger_kind = ?, trigger_cron = ?, trigger_run_at = ?, trigger_every_ms = ?, timezone = ?,
      prompt = ?, system_prompt = ?, skip_permissions = ?, max_turns = ?, tool_timeout_seconds = ?,
      wall_clock_timeout_seconds = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(
    merged.name, merged.description, merged.workingDirectory, merged.backend,
    merged.model, merged.effort, merged.mode,
    t.kind,
    t.kind === 'cron' ? t.cron : null,
    t.kind === 'once' ? t.runAt : null,
    t.kind === 'interval' ? t.everyMs : null,
    t.timezone,
    merged.prompt, merged.systemPrompt,
    merged.skipPermissions ? 1 : 0,
    merged.maxTurns, merged.toolTimeoutSeconds, merged.wallClockTimeoutSeconds,
    merged.enabled ? 1 : 0,
    now,
    id,
  );
  return getTask(id);
}

export function setEnabled(id: string, enabled: boolean): void {
  const db = getDb();
  db.prepare("UPDATE scheduled_tasks SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
}

export function setLastRunAt(id: string, ts: string | null): void {
  getDb().prepare("UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?").run(ts, id);
}

export function setNextRunAt(id: string, ts: string | null): void {
  getDb().prepare("UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?").run(ts, id);
}

export function deleteTask(id: string): void {
  getDb().prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
}

export function insertRun(input: {
  taskId: string;
  triggerSource: 'cron' | 'manual' | 'once';
  scheduledAt: number;
}): TaskRun {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO task_runs (id, task_id, status, trigger_source, scheduled_at)
    VALUES (?, ?, 'pending', ?, ?)
  `).run(id, input.taskId, input.triggerSource, input.scheduledAt);
  return getRun(id)!;
}

export function getRun(id: string): TaskRun | null {
  const row = getDb().prepare("SELECT * FROM task_runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listRuns(taskId: string, limit = 50): TaskRun[] {
  const rows = getDb().prepare(
    "SELECT * FROM task_runs WHERE task_id = ? ORDER BY scheduled_at DESC LIMIT ?"
  ).all(taskId, limit) as RunRow[];
  return rows.map(rowToRun);
}

export function updateRunStatus(
  id: string,
  patch: Partial<{
    status: RunStatus;
    sessionId: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    tokenUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null;
  }>,
): void {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) { fields.push("status = ?"); params.push(patch.status); }
  if (patch.sessionId !== undefined) { fields.push("session_id = ?"); params.push(patch.sessionId); }
  if (patch.startedAt !== undefined) { fields.push("started_at = ?"); params.push(patch.startedAt); }
  if (patch.finishedAt !== undefined) { fields.push("finished_at = ?"); params.push(patch.finishedAt); }
  if (patch.error !== undefined) { fields.push("error = ?"); params.push(patch.error); }
  if (patch.tokenUsage !== undefined) {
    fields.push("input_tokens = ?", "output_tokens = ?", "cache_read_tokens = ?", "cache_creation_tokens = ?");
    params.push(
      patch.tokenUsage?.input_tokens ?? null,
      patch.tokenUsage?.output_tokens ?? null,
      patch.tokenUsage?.cache_read_input_tokens ?? null,
      patch.tokenUsage?.cache_creation_input_tokens ?? null,
    );
  }
  if (fields.length === 0) return;
  params.push(id);
  getDb().prepare(`UPDATE task_runs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

export function listRunningRuns(): TaskRun[] {
  const rows = getDb().prepare("SELECT * FROM task_runs WHERE status IN ('pending','running')").all() as RunRow[];
  return rows.map(rowToRun);
}
