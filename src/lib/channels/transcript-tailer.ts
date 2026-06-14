import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encodeProjectPath } from '../claude-session-shared';
import type { SSEEvent } from '@/types';

/** Resolve the on-disk transcript path for a given cwd + claude session id. */
export function transcriptPath(cwd: string, claudeSessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects',
    encodeProjectPath(cwd), `${claudeSessionId}.jsonl`);
}

interface TranscriptEntry {
  type?: string;
  /** For type 'queue-operation': 'enqueue' | 'dequeue'. */
  operation?: string;
  isMeta?: boolean;
  error?: string;
  /** Set by the CLI on synthetic assistant entries that report an API failure
   * (model unavailable/not found, overloaded, rate limit, …). */
  isApiErrorMessage?: boolean;
  /** HTTP status on a synthetic api-error entry (e.g. 401 for an expired OAuth
   * token). Used to route auth failures to the self-healing retry path. */
  apiErrorStatus?: number;
  message?: {
    content?: Array<Record<string, unknown>>;
    usage?: Record<string, number>;
    model?: string;
    stop_reason?: string;
  };
}

/**
 * Pure: convert raw transcript entries into SSEEvents.
 * Assistant entries are processed fully (text / thinking / tool_use).
 * User entries are processed for tool_result blocks only — their text blocks
 * are CodePilot-side echoes of the prompt and are ignored.
 */
export function transcriptEntriesToEvents(entries: TranscriptEntry[]): SSEEvent[] {
  const out: SSEEvent[] = [];
  for (const entry of entries) {
    // Surface queue-operations as an internal signal (consumed by streamChannels
    // for wedge detection, never forwarded to the client). A `dequeue` means the
    // CLI accepted a pushed message and started the turn; an un-dequeued
    // `enqueue` left dangling is the wedge signature (see t1-session-wedged-no-reply).
    if (entry.type === 'queue-operation') {
      out.push({ type: 'channel_queue', data: JSON.stringify({ op: entry.operation }) });
      continue;
    }
    if (entry.type !== 'assistant' && entry.type !== 'user') continue;
    // Drop SDK-internal recovery messages. When `claude --resume` loads a
    // transcript whose last turn ended on a tool_result from a non-built-in
    // tool (the `mcp__codepilot__reply` we always use), it treats the turn as
    // interrupted and synthesises a pair: a `{user "Continue from where you
    // left off.", isMeta:true}` and an `{assistant model:"<synthetic>",
    // stop_reason:"stop_sequence", "No response requested."}`. The pair is
    // CLI bookkeeping — never sent to the model — so without this filter the
    // tailer would surface the synthetic "No response requested." text as the
    // turn's response.
    if (entry.isMeta) continue;
    // Surface API-error messages (model unavailable/not found, overloaded, rate
    // limit, …). The interactive CLI writes these as a synthetic assistant entry
    // (model:'<synthetic>', isApiErrorMessage:true) whose text block carries the
    // human-readable reason. They MUST be surfaced before the '<synthetic>' drop
    // below — otherwise the whole entry is swallowed and the turn ends with no
    // output (the fable-paused bug: no text, no error → PTY goes quiet → empty
    // finish), and the unanswered user row keeps the session stuck "reconnecting".
    // Rate/usage limits keep the dedicated rate_limit event; anything else
    // becomes a generic error carrying the CLI's own message. The recovery-pair
    // synthetic ("No response requested.") has no isApiErrorMessage, so it still
    // falls through to the '<synthetic>' drop untouched.
    if (entry.type === 'assistant' && entry.isApiErrorMessage) {
      const textBlock = (entry.message?.content ?? []).find(
        (b) => b.type === 'text' && typeof b.text === 'string',
      );
      const text = (textBlock?.text as string) || entry.error || 'API error';
      if (entry.error && /rate.?limit|usage.?limit/i.test(entry.error)) {
        out.push({ type: 'rate_limit', data: JSON.stringify({ tier: 'channels' }) });
      } else if (entry.apiErrorStatus === 401 || entry.error === 'authentication_failed') {
        // Expired/invalid auth token — emit a DISTINCT auth_error so streamChannels
        // respawns the session (a fresh `claude` re-mints the OAuth access token,
        // which a long-lived PTY can hold stale past its ~8h refresh boundary) and
        // retries once, instead of surfacing "Please run /login" to the user.
        out.push({ type: 'auth_error', data: text });
      } else {
        out.push({ type: 'error', data: text });
      }
      continue;
    }
    if (entry.type === 'assistant' && entry.message?.model === '<synthetic>') continue;
    const isAssistant = entry.type === 'assistant';
    if (isAssistant && entry.error && /rate.?limit|usage.?limit/i.test(entry.error)) {
      out.push({ type: 'rate_limit', data: JSON.stringify({ tier: 'channels' }) });
    }
    const content = entry.message?.content ?? [];
    for (const block of content) {
      const t = block.type as string;
      if (t === 'tool_result') {
        // tool_result blocks arrive on user-type entries in Claude Code's
        // transcript; emit them for both entry kinds.
        out.push({ type: 'tool_result', data: JSON.stringify({
          tool_use_id: block.tool_use_id, content: block.content,
        }) });
      } else if (!isAssistant) {
        // User entries: only tool_result blocks are relevant; skip text/etc.
        continue;
      } else if (t === 'text') {
        out.push({ type: 'text', data: String(block.text ?? '') });
      } else if (t === 'thinking') {
        out.push({ type: 'thinking', data: String(block.thinking ?? '') });
      } else if (t === 'tool_use') {
        out.push({ type: 'tool_use', data: JSON.stringify({
          id: block.id, name: block.name, input: block.input,
        }) });
      }
    }
    // Surface per-message token usage so the UI can show the same
    // `model · N tokens` badge it shows for the SDK backend. streamChannels
    // accumulates these across the turn into a single final result event.
    if (isAssistant && entry.message?.usage) {
      const u = entry.message.usage;
      out.push({ type: 'result', data: JSON.stringify({ usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        model: entry.message.model,
      } }) });
    }
    // NOTE: turn-end is intentionally NOT inferred here. In T1 (the interactive
    // `claude --channels` PTY) every assistant entry — including tool_use ones —
    // is stamped with stop_reason='end_turn', so the transcript carries no
    // reliable per-entry "the turn is over" signal (unlike T2's stream-json,
    // where tool_use entries report stop_reason='tool_use'). A single entry can
    // never tell us the turn ended. streamChannels decides turn-end instead,
    // from signals only it has: the model's `reply` channel event and the PTY
    // going quiet. See channels-client.ts.
  }
  return out;
}

export type TailHandle = { stop: () => void };

/**
 * Tail a transcript file, emitting SSEEvents for each newly-appended entry.
 * Starts from the current EOF (only new content). Caller stops it on turn end.
 */
export function tailTranscript(
  filePath: string,
  onEvents: (events: SSEEvent[]) => void,
): TailHandle {
  let offset = 0;
  try { offset = fs.statSync(filePath).size; } catch { offset = 0; }
  let stopped = false;
  // Carry-over for a JSON line split across two poll reads (no trailing \n yet).
  let leftover = '';

  const readNew = () => {
    if (stopped) return;
    let size = 0;
    // TOCTOU: the file may grow/shrink between statSync and openSync; an
    // accepted limitation of a polling tailer — the next tick reconciles.
    try { size = fs.statSync(filePath).size; } catch { return; }
    if (size <= offset) return;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const chunk = leftover + buf.toString('utf8');
    const lines = chunk.split('\n');
    // The last element is the unterminated tail (or '' if chunk ended in \n);
    // keep it for the next tick.
    leftover = lines.pop() ?? '';
    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch { /* malformed line; ignored */ }
    }
    if (entries.length) onEvents(transcriptEntriesToEvents(entries));
  };

  // Poll fairly tight so tool calls / thinking surface responsively. The
  // final answer still arrives in one piece via the reply tool — that part
  // is not incremental regardless of poll rate.
  const interval = setInterval(readNew, 120);
  return { stop: () => { stopped = true; clearInterval(interval); } };
}
