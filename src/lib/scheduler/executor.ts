// src/lib/scheduler/executor.ts
import type { ScheduledTask, RunStatus } from './types';
import { LIVENESS_TIMEOUT_MS, ABORT_GRACE_MS, DISALLOWED_TOOLS } from './types';
import { interruptSession, abortSession } from '@/lib/abort-registry';
import type { TokenUsage } from '@/types';

export interface ExecuteOptions {
  task: ScheduledTask;
  sessionId: string;
  metadataHeader: string;
  abortSignal: AbortSignal;
}

export interface ExecuteResult {
  status: RunStatus;
  error?: string;
  tokenUsage?: TokenUsage | null;
}

function getInternalBaseUrl(): string {
  const port = process.env.PORT ?? '4000';
  return `http://127.0.0.1:${port}`;
}

function endpointFor(backend: 'claude' | 'codex'): string {
  return backend === 'claude' ? '/api/chat' : '/api/codex/chat';
}

export async function executeTask(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { task, sessionId, metadataHeader, abortSignal } = opts;
  const url = getInternalBaseUrl() + endpointFor(task.backend);

  const content = `${metadataHeader}\n\n${task.prompt}`;

  const body: Record<string, unknown> = {
    session_id: sessionId,
    content,
    prompt: task.prompt,
    model: task.model ?? undefined,
    mode: task.mode,
    files: [],
    toolTimeout: task.toolTimeoutSeconds,
    effort: task.effort ?? undefined,
    max_turns: task.maxTurns,
    disable_tools: false,
    disallowed_tools: DISALLOWED_TOOLS,
  };

  let lastEventAt = Date.now();
  let livenessTimer: NodeJS.Timeout | null = null;
  let livenessFired = false;

  const livenessAbort = new AbortController();
  function armLiveness() {
    if (livenessTimer) clearTimeout(livenessTimer);
    livenessTimer = setTimeout(() => {
      const since = Date.now() - lastEventAt;
      if (since >= LIVENESS_TIMEOUT_MS) {
        livenessFired = true;
        livenessAbort.abort();
      } else {
        armLiveness();
      }
    }, LIVENESS_TIMEOUT_MS - (Date.now() - lastEventAt));
  }
  armLiveness();

  const combinedAbort = new AbortController();
  abortSignal.addEventListener('abort', () => combinedAbort.abort(), { once: true });
  livenessAbort.signal.addEventListener('abort', () => combinedAbort.abort(), { once: true });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: combinedAbort.signal,
    });
  } catch (err) {
    if (livenessTimer) clearTimeout(livenessTimer);
    if (combinedAbort.signal.aborted) {
      return { status: classifyAbort(abortSignal, livenessFired), error: errMsg(err) };
    }
    return { status: 'failed', error: errMsg(err) };
  }

  if (!response.ok || !response.body) {
    if (livenessTimer) clearTimeout(livenessTimer);
    return { status: 'failed', error: `HTTP ${response.status}: ${await response.text().catch(() => '')}` };
  }

  const reader = response.body.getReader();
  let totalUsage: TokenUsage | null = null;
  let blockedOnInput = false;
  let maxTurnsHit = false;
  let toolTimedOut = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastEventAt = Date.now();
      const chunk = new TextDecoder().decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt?.type === 'usage' && evt.usage) {
            totalUsage = evt.usage;
          }
          if (evt?.type === 'permission_request') {
            blockedOnInput = true;
          }
          if (evt?.type === 'input_request') {
            blockedOnInput = true;
          }
          if (evt?.type === 'error' && typeof evt.error === 'string') {
            if (evt.error.toLowerCase().includes('max_turns')) maxTurnsHit = true;
            if (evt.error.toLowerCase().includes('tool timed out')) toolTimedOut = true;
          }
        } catch {
          // Ignore non-JSON keepalive lines.
        }
      }
    }
  } catch (err) {
    if (combinedAbort.signal.aborted) {
      await gracefulInterrupt(sessionId);
      return {
        status: classifyAbort(abortSignal, livenessFired),
        error: errMsg(err),
        tokenUsage: totalUsage,
      };
    }
    return { status: 'failed', error: errMsg(err), tokenUsage: totalUsage };
  } finally {
    if (livenessTimer) clearTimeout(livenessTimer);
  }

  if (maxTurnsHit) return { status: 'max_turns_exceeded', tokenUsage: totalUsage };
  if (toolTimedOut) return { status: 'tool_timed_out', tokenUsage: totalUsage };
  if (blockedOnInput) return { status: 'blocked_on_input', tokenUsage: totalUsage };
  return { status: 'success', tokenUsage: totalUsage };
}

async function gracefulInterrupt(sessionId: string): Promise<void> {
  try {
    await interruptSession(sessionId);
    await sleep(ABORT_GRACE_MS);
    await abortSession(sessionId);
  } catch {
    // Already gone.
  }
}

function classifyAbort(externalSignal: AbortSignal, livenessFired: boolean): RunStatus {
  if (livenessFired) return 'timed_out';
  if (externalSignal.aborted) return 'cancelled';
  return 'interrupted';
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
