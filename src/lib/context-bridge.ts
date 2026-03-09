/**
 * Context Bridge — smart context handoff when switching between Claude and Codex backends.
 *
 * When a user switches backends mid-conversation, this module builds a prompt
 * that gives the new backend enough context to continue seamlessly.
 *
 * Strategy: recent N turns verbatim + heuristic summary of older turns.
 * No LLM call — purely text extraction for speed and cost.
 */

import { getAllMessages } from '@/lib/db';
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
  sourceBackend: 'claude' | 'codex',
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

  const sourceName = sourceBackend === 'claude' ? 'Claude' : 'Codex';
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
