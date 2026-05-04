import { streamClaude } from '@/lib/claude-client';
import { streamCodex } from '@/lib/codex-client';
import type { Backend, CreateTaskInput, TriggerSpec } from './types';
import {
  DEFAULT_MAX_TURNS, DEFAULT_TOOL_TIMEOUT_SECONDS, DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS,
} from './types';
import { randomUUID } from 'crypto';

const SYSTEM_PROMPT = `You convert a user's free-form description of a recurring or one-off task into a JSON ScheduledTask draft. Return ONLY valid JSON matching this schema:
{
  "name": string,
  "description": string,
  "workingDirectory": string | null,
  "backend": "claude" | "codex" | null,
  "trigger": { "kind": "cron"|"once"|"interval", "cron"?: string, "runAt"?: number_ms_epoch, "everyMs"?: number, "timezone": string },
  "prompt": string,
  "systemPrompt": string | null
}
Rules:
- If user mentions a recurring time, use cron. If a single future time, use once with epoch ms. If "every N minutes/hours", use interval.
- Default timezone to "UTC" unless user specifies.
- "description" is a concise human-readable summary for the scheduler list.
- "prompt" is what the agent should do during the run, NOT the user's request to you.
- Output JSON only, no commentary, no code fences.`;

interface ExtractInput {
  backend: Backend;
  text: string;
  workingDirectory?: string;
}

interface ExtractDraft {
  name: string;
  description: string;
  workingDirectory: string | null;
  backend: Backend | null;
  trigger: Partial<TriggerSpec> & { kind: TriggerSpec['kind']; timezone: string };
  prompt: string;
  systemPrompt: string | null;
}

export async function extractTaskDraft(input: ExtractInput): Promise<ExtractDraft> {
  const sessionId = `scheduler-extract-${randomUUID()}`;
  const wd = input.workingDirectory ?? process.cwd();

  let chunks = '';
  const stream =
    input.backend === 'claude'
      ? streamClaude({
          prompt: input.text,
          sessionId,
          systemPrompt: SYSTEM_PROMPT,
          workingDirectory: wd,
          permissionMode: 'plan',
          skipPermissions: false,
          maxTurns: 1,
          disableTools: true,
        })
      : streamCodex({
          prompt: input.text,
          sessionId,
          workingDirectory: wd,
          skipPermissions: false,
        });

  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += value;
  }

  const json = extractFirstJson(chunks);
  if (!json) throw new Error('extraction returned no JSON');
  return validateDraft(JSON.parse(json));
}

function extractFirstJson(stream: string): string | null {
  // streamClaude/streamCodex emit SSE events shaped as { type: 'text', data: string }
  // alongside other event types (init, usage, permission_request, etc.). Concatenate
  // only the assistant text deltas, then locate the first balanced { ... } block.
  let assistantText = '';
  for (const line of stream.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt?.type === 'text' && typeof evt.data === 'string') {
        assistantText += evt.data;
      }
    } catch {
      // Non-JSON keepalive — ignore.
    }
  }

  // Walk braces to find a balanced object (model may emit prose before/after).
  let depth = 0;
  let start = -1;
  for (let i = 0; i < assistantText.length; i++) {
    const c = assistantText[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return assistantText.slice(start, i + 1);
      }
    }
  }
  return null;
}

function validateDraft(o: unknown): ExtractDraft {
  if (!o || typeof o !== 'object') throw new Error('draft is not an object');
  const r = o as Record<string, unknown>;
  if (typeof r.prompt !== 'string' || !r.prompt) throw new Error('draft missing prompt');
  if (!r.trigger || typeof r.trigger !== 'object') throw new Error('draft missing trigger');
  return {
    name: typeof r.name === 'string' ? r.name : 'Untitled task',
    description: typeof r.description === 'string' && r.description.trim() ? r.description : 'Scheduled agent task',
    workingDirectory: typeof r.workingDirectory === 'string' ? r.workingDirectory : null,
    backend: r.backend === 'claude' || r.backend === 'codex' ? r.backend : null,
    trigger: r.trigger as ExtractDraft['trigger'],
    prompt: r.prompt,
    systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt : null,
  };
}

export function applyDraftDefaults(draft: ExtractDraft): CreateTaskInput {
  return {
    name: draft.name,
    description: draft.description,
    workingDirectory: draft.workingDirectory ?? '',
    backend: draft.backend ?? 'claude',
    model: null,
    effort: null,
    mode: 'acceptEdits',
    trigger: draft.trigger as TriggerSpec,
    prompt: draft.prompt,
    systemPrompt: draft.systemPrompt,
    skipPermissions: true,
    maxTurns: DEFAULT_MAX_TURNS,
    toolTimeoutSeconds: DEFAULT_TOOL_TIMEOUT_SECONDS,
    wallClockTimeoutSeconds: DEFAULT_WALL_CLOCK_TIMEOUT_SECONDS,
    enabled: true,
  };
}
