/**
 * Server-side registry of streaming buffers for active Claude sessions.
 *
 * When the mobile browser drops the SSE connection (e.g. app switch),
 * the Claude subprocess keeps running and events keep flowing through
 * collectStreamResponse().  This registry captures those events so the
 * recovery-polling status endpoint can return intermediate output to
 * the client — instead of showing only "Reconnecting… Claude is still
 * running" until completion.
 *
 * Lifecycle:
 *   initStreamBuffer(sessionId)    – called when streaming starts
 *   appendText / pushToolUse / … – called as events arrive
 *   getStreamBuffer(sessionId)    – called by GET /api/chat/sessions/{id}/status
 *   clearStreamBuffer(sessionId)  – called when streaming ends (alongside unregisterAbort)
 */

// ── Types (local, lightweight — intentionally not importing frontend types) ──

interface BufferToolUse {
  id: string;
  name: string;
  input: unknown;
}

interface BufferToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface StreamingBuffer {
  text: string;
  toolUses: BufferToolUse[];
  toolResults: BufferToolResult[];
  statusText?: string;
}

// ── Registry (globalThis-backed, same pattern as abort-registry) ──

const globalKey = '__streamingBufferRegistry__' as const;

function getRegistry(): Map<string, StreamingBuffer> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, StreamingBuffer>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, StreamingBuffer>;
}

/** Create a fresh buffer when a new stream starts. */
export function initStreamBuffer(sessionId: string): void {
  getRegistry().set(sessionId, {
    text: '',
    toolUses: [],
    toolResults: [],
    statusText: undefined,
  });
}

/** Append a text delta. */
export function appendStreamText(sessionId: string, delta: string): void {
  const buf = getRegistry().get(sessionId);
  if (buf) buf.text += delta;
}

/** Record a tool_use event. */
export function pushStreamToolUse(sessionId: string, tool: BufferToolUse): void {
  const buf = getRegistry().get(sessionId);
  if (buf) buf.toolUses.push(tool);
}

/** Record a tool_result event. */
export function pushStreamToolResult(sessionId: string, result: BufferToolResult): void {
  const buf = getRegistry().get(sessionId);
  if (buf) buf.toolResults.push(result);
}

/** Update the human-readable status text (e.g. "Running bash…"). */
export function setStreamStatusText(sessionId: string, text: string | undefined): void {
  const buf = getRegistry().get(sessionId);
  if (buf) buf.statusText = text;
}

/** Read the current buffer (returns null if no active stream). */
export function getStreamBuffer(sessionId: string): StreamingBuffer | null {
  return getRegistry().get(sessionId) ?? null;
}

/** Remove the buffer when the stream is finished. */
export function clearStreamBuffer(sessionId: string): void {
  getRegistry().delete(sessionId);
}
