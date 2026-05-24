/**
 * Context Bridge — smart context handoff when switching between Claude and Codex backends.
 *
 * When a user switches backends mid-conversation, this module builds a prompt
 * that gives the new backend enough context to continue seamlessly.
 *
 * Strategy: recent N turns verbatim + heuristic summary of older turns.
 * No LLM call — purely text extraction for speed and cost.
 */

import { getAllMessages, getMessagesSince, getSession, getLastAssistantBackend, updateLastBridgedMsgId } from '@/lib/db';
import { parseMessageContent } from '@/types';
import type { Message } from '@/types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A simplified message for formatting (decoupled from DB shape for testability). */
export interface SimpleMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_MESSAGE_LENGTH = 2000;

/** Truncate text at a word boundary, respecting maxLength. */
function truncate(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const cutPoint = lastSpace > maxLength * 0.5 ? lastSpace : maxLength;
  return truncated.slice(0, cutPoint) + '...';
}

/**
 * Extract readable plain text from a message content string.
 * Uses parseMessageContent() to handle both plain text and JSON content blocks.
 * - text blocks: include text verbatim
 * - tool_use blocks: show `[Used tool: name]`
 * - tool_result blocks: skipped
 * - code blocks: include code verbatim
 */
function extractPlainText(content: string): string {
  const blocks = parseMessageContent(content);
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'tool_use':
        parts.push(`[Used tool: ${block.name}]`);
        break;
      case 'code':
        parts.push(block.code);
        break;
      case 'tool_result':
        // Skip tool results — they are noisy and duplicative
        break;
    }
  }

  return parts.join('\n').trim();
}

/**
 * Extract file paths from text using a simple regex heuristic.
 * Matches Unix-style paths with at least one directory separator and a file extension.
 */
function extractFilePaths(text: string): string[] {
  const regex = /(?:\/[\w.-]+)+\.\w+/g;
  const matches = text.match(regex);
  if (!matches) return [];
  // Deduplicate while preserving order
  return Array.from(new Set(matches));
}

/**
 * Build a heuristic summary of older messages (no LLM call).
 * Extracts: topics (first line of each user message) and referenced file paths.
 */
function summarizeOlderMessages(messages: SimpleMessage[]): {
  topics: string[];
  filePaths: string[];
} {
  const topics: string[] = [];
  const allText: string[] = [];

  for (const msg of messages) {
    const text = extractPlainText(msg.content);
    if (!text) continue;
    allText.push(text);

    if (msg.role === 'user') {
      const firstLine = text.split('\n')[0].trim();
      if (firstLine) {
        topics.push(truncate(firstLine, 120));
      }
    }
  }

  const filePaths = extractFilePaths(allText.join('\n'));

  return { topics, filePaths };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format an array of SimpleMessage objects as readable User/Assistant turns.
 * Each turn is separated by `---`.
 */
export function formatMessagesForContext(messages: SimpleMessage[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];

  for (const msg of messages) {
    const text = extractPlainText(msg.content);
    if (!text) continue;
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${label}: ${truncate(text)}`);
  }

  return lines.join('\n---\n');
}

/**
 * Build a full context bridge prompt for handing off a conversation
 * from one backend to another.
 */
export async function buildContextBridge(
  sessionId: string,
  sourceBackend: 'claude' | 'codex' | 'channels',
  options?: { maxRecentTurns?: number }
): Promise<string> {
  const maxRecentTurns = options?.maxRecentTurns ?? 10;
  const messages = getAllMessages(sessionId);

  if (messages.length === 0) {
    return '';
  }

  // Convert DB messages to SimpleMessage
  const simple: SimpleMessage[] = messages.map((m: Message) => ({
    role: m.role,
    content: m.content,
  }));

  // Split into old and recent. A "turn" = 2 messages (1 user + 1 assistant).
  const recentCount = maxRecentTurns * 2;
  const splitIndex = Math.max(0, simple.length - recentCount);
  const oldMessages = simple.slice(0, splitIndex);
  const recentMessages = simple.slice(splitIndex);

  // 'channels' is Claude-family (T1), so it gets labelled "Claude" — not "Codex".
  const sourceName = sourceBackend === 'codex' ? 'Codex' : 'Claude';
  const parts: string[] = [];

  parts.push(`[Continuing from a previous conversation with ${sourceName}]`);

  // Summary of older messages (if any)
  if (oldMessages.length > 0) {
    const { topics, filePaths } = summarizeOlderMessages(oldMessages);

    parts.push('');
    parts.push('Summary of earlier discussion:');

    if (topics.length > 0) {
      parts.push(`Topics discussed: ${topics.join('; ')}`);
    }

    if (filePaths.length > 0) {
      parts.push(`Files referenced: ${filePaths.join(', ')}`);
    }
  }

  // Recent conversation
  if (recentMessages.length > 0) {
    const formatted = formatMessagesForContext(recentMessages);
    if (formatted) {
      parts.push('');
      parts.push(`Recent conversation (last ${maxRecentTurns} turns):`);
      parts.push('---');
      parts.push(formatted);
      parts.push('---');
    }
  }

  parts.push('');
  parts.push('Please continue from where the previous assistant left off.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Incremental Context Bridge
// ---------------------------------------------------------------------------

/**
 * Determine whether a cross-vendor backend switch is happening.
 * Returns the source backend if a switch is detected, null otherwise.
 *
 * Rules:
 * - Only Claude↔Codex switches need a bridge (cross-vendor).
 * - Same-vendor switches need no bridge. That includes both the obvious
 *   case (Sonnet→Opus within one backend) and T1↔T2 — Channels and the
 *   SDK are both Claude-family and already share the same `.jsonl`
 *   transcript via sdk_session_id reuse (`seedSdkResumeFromChannel`), so
 *   the model has the full history from `--resume` and a bridge prompt
 *   would duplicate it AND label it "Codex".
 * - If there are no previous assistant messages, no bridge needed.
 */
export function detectBackendSwitch(
  sessionId: string,
  targetBackend: 'claude' | 'codex',
): 'claude' | 'codex' | 'channels' | null {
  const lastBackend = getLastAssistantBackend(sessionId);
  if (!lastBackend) return null; // No previous assistant messages
  if (isSameVendor(lastBackend, targetBackend)) return null;
  return lastBackend; // Cross-vendor switch detected
}

/** Channels(T1) and Claude SDK(T2) are both Claude-family; Codex stands alone. */
function isSameVendor(
  a: 'claude' | 'codex' | 'channels',
  b: 'claude' | 'codex' | 'channels',
): boolean {
  const family = (x: string) => (x === 'channels' ? 'claude' : x);
  return family(a) === family(b);
}

/**
 * Build an incremental context bridge prompt.
 *
 * Only includes messages the target backend hasn't seen yet — the "gap"
 * between the last time it received context and the current conversation head.
 *
 * After building, updates the session's bridged marker so subsequent switches
 * won't re-send these messages.
 *
 * @returns The bridge prompt string, or empty string if no gap exists.
 */
export function buildIncrementalBridge(
  sessionId: string,
  targetBackend: 'claude' | 'codex',
  sourceBackend: 'claude' | 'codex' | 'channels',
  options?: { maxRecentTurns?: number },
): string {
  const maxRecentTurns = options?.maxRecentTurns ?? 10;
  const session = getSession(sessionId);
  if (!session) return '';

  // Determine the marker: where did this target backend's context window end?
  const lastBridgedMsgId = targetBackend === 'claude'
    ? session.last_claude_bridged_msg_id
    : session.last_codex_bridged_msg_id;

  // Get only the gap messages (after the last bridged point)
  const gapMessages = getMessagesSince(sessionId, lastBridgedMsgId || null);

  if (gapMessages.length === 0) return '';

  // Exclude the current user message (just saved, will be sent as the prompt)
  // The last message should be the user's current message
  const lastMsg = gapMessages[gapMessages.length - 1];
  const messagesForBridge = (lastMsg.role === 'user')
    ? gapMessages.slice(0, -1)
    : gapMessages;

  if (messagesForBridge.length === 0) return '';

  // Convert to SimpleMessage
  const simple: SimpleMessage[] = messagesForBridge.map((m: Message) => ({
    role: m.role,
    content: m.content,
  }));

  // Split into summary + recent verbatim
  const recentCount = maxRecentTurns * 2;
  const splitIndex = Math.max(0, simple.length - recentCount);
  const oldMessages = simple.slice(0, splitIndex);
  const recentMessages = simple.slice(splitIndex);

  // 'channels' is Claude-family (T1), so when the bridge legitimately fires
  // (T1 → Codex), label the source "Claude" — not "Codex".
  const sourceName = sourceBackend === 'codex' ? 'Codex' : 'Claude';
  const parts: string[] = [];

  parts.push(`[Context from recent conversation with ${sourceName} that you haven't seen]`);

  // Summary of older gap messages (if any)
  if (oldMessages.length > 0) {
    const { topics, filePaths } = summarizeOlderMessages(oldMessages);

    parts.push('');
    parts.push('Summary of earlier gap messages:');

    if (topics.length > 0) {
      parts.push(`Topics discussed: ${topics.join('; ')}`);
    }

    if (filePaths.length > 0) {
      parts.push(`Files referenced: ${filePaths.join(', ')}`);
    }
  }

  // Recent gap messages verbatim
  if (recentMessages.length > 0) {
    const formatted = formatMessagesForContext(recentMessages);
    if (formatted) {
      parts.push('');
      parts.push(`Recent messages you missed (${recentMessages.length} messages):`);
      parts.push('---');
      parts.push(formatted);
      parts.push('---');
    }
  }

  parts.push('');
  parts.push('Please continue the conversation with this context in mind.');

  // Update the bridged marker to the last gap message
  // so this context won't be re-sent on subsequent switches
  const lastGapMsg = messagesForBridge[messagesForBridge.length - 1];
  updateLastBridgedMsgId(sessionId, targetBackend, lastGapMsg.id);

  return parts.join('\n');
}
