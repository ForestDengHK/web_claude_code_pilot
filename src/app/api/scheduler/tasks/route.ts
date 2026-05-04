import { NextRequest } from 'next/server';
import { listTasks, createTask } from '@/lib/scheduler/scheduler-db';
import { reschedule } from '@/lib/scheduler/scheduler-manager';
import type { CreateTaskInput } from '@/lib/scheduler/types';
import {
  DEFAULT_MAX_TURNS, DEFAULT_TOOL_TIMEOUT_SECONDS, DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS,
} from '@/lib/scheduler/types';

export const runtime = 'nodejs';

export async function GET() {
  return Response.json({ tasks: listTasks() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const validation = validateInput(body);
  if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 });
  const created = createTask(validation.value);
  reschedule(created.id);
  return Response.json({ task: created }, { status: 201 });
}

function validateInput(b: unknown): { ok: true; value: CreateTaskInput } | { ok: false; error: string } {
  if (!b || typeof b !== 'object') return { ok: false, error: 'body must be an object' };
  const o = b as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) return { ok: false, error: 'name is required' };
  if (typeof o.workingDirectory !== 'string' || !o.workingDirectory) return { ok: false, error: 'workingDirectory is required' };
  if (o.backend !== 'claude' && o.backend !== 'codex') return { ok: false, error: 'backend must be claude or codex' };
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) return { ok: false, error: 'prompt is required' };
  const trigger = o.trigger as Record<string, unknown> | undefined;
  if (!trigger) return { ok: false, error: 'trigger is required' };
  if (trigger.kind === 'cron' && (typeof trigger.cron !== 'string' || !trigger.cron)) return { ok: false, error: 'cron expression is required' };
  if (trigger.kind === 'once' && typeof trigger.runAt !== 'number') return { ok: false, error: 'runAt is required for once trigger' };
  if (trigger.kind === 'interval' && (typeof trigger.everyMs !== 'number' || trigger.everyMs < 5000)) return { ok: false, error: 'everyMs must be >= 5000' };

  return {
    ok: true,
    value: {
      name: o.name,
      description: typeof o.description === 'string' ? o.description : null,
      workingDirectory: o.workingDirectory,
      backend: o.backend,
      model: typeof o.model === 'string' ? o.model : null,
      effort: typeof o.effort === 'string' ? o.effort : null,
      mode: typeof o.mode === 'string' ? o.mode : 'acceptEdits',
      trigger: {
        kind: trigger.kind as 'cron' | 'once' | 'interval',
        cron: trigger.cron as string,
        runAt: trigger.runAt as number,
        everyMs: trigger.everyMs as number,
        timezone: typeof trigger.timezone === 'string' ? trigger.timezone : 'UTC',
      } as CreateTaskInput['trigger'],
      prompt: o.prompt,
      systemPrompt: typeof o.systemPrompt === 'string' ? o.systemPrompt : null,
      skipPermissions: o.skipPermissions !== false,
      maxTurns: typeof o.maxTurns === 'number' ? o.maxTurns : DEFAULT_MAX_TURNS,
      toolTimeoutSeconds: typeof o.toolTimeoutSeconds === 'number' ? o.toolTimeoutSeconds : DEFAULT_TOOL_TIMEOUT_SECONDS,
      wallClockTimeoutSeconds: typeof o.wallClockTimeoutSeconds === 'number' ? o.wallClockTimeoutSeconds : DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS,
      enabled: o.enabled !== false,
    },
  };
}
