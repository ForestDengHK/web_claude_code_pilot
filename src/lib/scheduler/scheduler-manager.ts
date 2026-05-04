import { Cron } from 'croner';
import { createSession, updateSessionSkipPermissions, updateSessionSource } from '@/lib/db';
import {
  getTask, listTasks, setEnabled as dbSetEnabled, setLastRunAt, setNextRunAt,
  insertRun, updateRunStatus,
} from './scheduler-db';
import { executeTask } from './executor';
import { runWithWallClock } from './watchdog';
import type { ScheduledTask, TriggerSpec } from './types';
import fs from 'fs';

interface ActiveTimer {
  taskId: string;
  cron?: Cron;
  onceTimer?: NodeJS.Timeout;
  intervalTimer?: NodeJS.Timeout;
}

const timers = new Map<string, ActiveTimer>();
const inflight = new Set<string>();
let started = false;

export function computeNextFire(t: TriggerSpec, ref: Date): Date | null {
  if (t.kind === 'cron') {
    try {
      const c = new Cron(t.cron, { timezone: t.timezone, paused: true });
      return c.nextRun(ref);
    } catch {
      return null;
    }
  }
  if (t.kind === 'once') {
    return t.runAt > ref.getTime() ? new Date(t.runAt) : null;
  }
  return new Date(ref.getTime() + t.everyMs);
}

export function start(): void {
  if (started) return;
  started = true;
  const tasks = listTasks({ enabled: true });
  for (const task of tasks) {
    schedule(task);
  }
  console.log(`[scheduler] started with ${tasks.length} active task(s)`);
}

export function stop(): void {
  for (const t of timers.values()) {
    t.cron?.stop();
    if (t.onceTimer) clearTimeout(t.onceTimer);
    if (t.intervalTimer) clearInterval(t.intervalTimer);
  }
  timers.clear();
  started = false;
}

export function reschedule(taskId: string): void {
  unschedule(taskId);
  const task = getTask(taskId);
  if (task && task.enabled) schedule(task);
}

export function unschedule(taskId: string): void {
  const t = timers.get(taskId);
  if (!t) return;
  t.cron?.stop();
  if (t.onceTimer) clearTimeout(t.onceTimer);
  if (t.intervalTimer) clearInterval(t.intervalTimer);
  timers.delete(taskId);
}

function schedule(task: ScheduledTask): void {
  const now = new Date();
  const next = computeNextFire(task.trigger, now);
  setNextRunAt(task.id, next ? next.toISOString() : null);

  const timer: ActiveTimer = { taskId: task.id };
  const t = task.trigger;

  if (t.kind === 'cron') {
    timer.cron = new Cron(t.cron, { timezone: t.timezone }, () => {
      void runOnce(task.id, 'cron');
    });
  } else if (t.kind === 'once') {
    if (next) {
      timer.onceTimer = setTimeout(() => {
        void runOnce(task.id, 'once');
      }, Math.max(0, next.getTime() - now.getTime()));
    }
  } else {
    timer.intervalTimer = setInterval(() => {
      void runOnce(task.id, 'cron');
    }, t.everyMs);
  }
  timers.set(task.id, timer);
}

export function setEnabled(taskId: string, enabled: boolean): void {
  dbSetEnabled(taskId, enabled);
  if (enabled) reschedule(taskId);
  else unschedule(taskId);
}

export async function runOnce(
  taskId: string,
  triggerSource: 'cron' | 'manual' | 'once',
): Promise<void> {
  if (inflight.has(taskId)) {
    console.warn(`[scheduler] skip overlap for task ${taskId}`);
    return;
  }
  inflight.add(taskId);
  const task = getTask(taskId);
  if (!task) {
    inflight.delete(taskId);
    return;
  }
  const run = insertRun({
    taskId,
    triggerSource,
    scheduledAt: Date.now(),
  });

  try {
    if (!fs.existsSync(task.workingDirectory)) {
      updateRunStatus(run.id, {
        status: 'failed',
        finishedAt: Date.now(),
        error: `working directory does not exist: ${task.workingDirectory}`,
      });
      return;
    }

    const sessionTitle = formatSessionTitle(task, new Date());
    const session = createSession(
      sessionTitle,
      task.model ?? '',
      task.systemPrompt ?? '',
      task.workingDirectory,
      task.mode,
      task.backend,
      null,
      null,
    );
    updateSessionSkipPermissions(session.id, task.skipPermissions);
    updateSessionSource(session.id, 'scheduled', task.id);

    updateRunStatus(run.id, {
      status: 'running',
      sessionId: session.id,
      startedAt: Date.now(),
    });

    const metadataHeader = `[Scheduled run · ${new Date().toISOString()} · task "${task.name}"${
      task.skipPermissions ? ' · skip_permissions=true' : ''
    }]`;

    const wd = await runWithWallClock(task.wallClockTimeoutSeconds, (signal) =>
      executeTask({
        task,
        sessionId: session.id,
        metadataHeader,
        abortSignal: signal,
      }),
    );

    if (wd.kind === 'timed_out') {
      updateRunStatus(run.id, {
        status: 'timed_out',
        finishedAt: Date.now(),
        error: `wall-clock timeout after ${task.wallClockTimeoutSeconds}s`,
      });
    } else if (wd.kind === 'errored') {
      updateRunStatus(run.id, {
        status: 'failed',
        finishedAt: Date.now(),
        error: wd.error.message,
      });
    } else {
      const usage = wd.value.tokenUsage;
      updateRunStatus(run.id, {
        status: wd.value.status,
        finishedAt: Date.now(),
        error: wd.value.error ?? null,
        tokenUsage: usage
          ? {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            }
          : null,
      });
    }
  } catch (err) {
    updateRunStatus(run.id, {
      status: 'failed',
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    setLastRunAt(taskId, new Date().toISOString());
    const refreshed = getTask(taskId);
    if (refreshed) {
      const next = computeNextFire(refreshed.trigger, new Date());
      setNextRunAt(taskId, next ? next.toISOString() : null);
      if (refreshed.trigger.kind === 'once') {
        // One-shot tasks auto-disable after firing.
        dbSetEnabled(taskId, false);
        unschedule(taskId);
      }
    }
    inflight.delete(taskId);
  }
}

function formatSessionTitle(task: ScheduledTask, when: Date): string {
  const stamp = when.toISOString().replace('T', ' ').slice(0, 16);
  return `${task.name} · ${stamp}`;
}

export function isRunning(taskId: string): boolean {
  return inflight.has(taskId);
}
