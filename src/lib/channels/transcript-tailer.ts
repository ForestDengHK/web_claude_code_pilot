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
  error?: string;
  message?: { content?: Array<Record<string, unknown>> };
}

/** Pure: convert raw transcript entries into SSEEvents. Only assistant content. */
export function transcriptEntriesToEvents(entries: TranscriptEntry[]): SSEEvent[] {
  const out: SSEEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    if (entry.error && /rate.?limit|usage.?limit/i.test(entry.error)) {
      out.push({ type: 'rate_limit', data: JSON.stringify({ tier: 'channels' }) });
    }
    const content = entry.message?.content ?? [];
    for (const block of content) {
      const t = block.type as string;
      if (t === 'text') {
        out.push({ type: 'text', data: String(block.text ?? '') });
      } else if (t === 'thinking') {
        out.push({ type: 'thinking', data: String(block.thinking ?? '') });
      } else if (t === 'tool_use') {
        out.push({ type: 'tool_use', data: JSON.stringify({
          id: block.id, name: block.name, input: block.input,
        }) });
      } else if (t === 'tool_result') {
        out.push({ type: 'tool_result', data: JSON.stringify({
          tool_use_id: block.tool_use_id, content: block.content,
        }) });
      }
    }
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

  const readNew = () => {
    if (stopped) return;
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch { return; }
    if (size <= offset) return;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* partial line; ignored */ }
    }
    if (entries.length) onEvents(transcriptEntriesToEvents(entries));
  };

  const interval = setInterval(readNew, 250);
  return { stop: () => { stopped = true; clearInterval(interval); } };
}
