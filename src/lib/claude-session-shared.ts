/**
 * Browser-safe portion of the Claude Code CLI session parser — types,
 * path encoding/decoding, and pure JSONL parsing functions that take
 * string content (no Node-only deps).
 *
 * The fs-backed entry points (listClaudeSessions, parseClaudeSession,
 * getClaudeProjectsDir) live in `claude-session-parser.ts` which also
 * re-exports everything here.
 */

import { SESSION_ACTIVE_THRESHOLD_MS } from '@/lib/config';
import type { MessageContentBlock } from '@/types';

/** Default threshold (ms) for considering a session "active" based on file modification time. */
export const DEFAULT_ACTIVE_THRESHOLD_MS = SESSION_ACTIVE_THRESHOLD_MS;

// ==========================================
// Types for Claude Code JSONL entries
// ==========================================

export interface ClaudeSessionInfo {
  /** Session UUID (filename without .jsonl) */
  sessionId: string;
  /** Decoded project directory path (best-effort from folder name) */
  projectPath: string;
  /** Project folder name */
  projectName: string;
  /** Working directory from the first user message (authoritative) */
  cwd: string;
  /** Git branch from the first user message */
  gitBranch: string;
  /** Claude Code version used */
  version: string;
  /** First user message preview (truncated) */
  preview: string;
  /** Number of user messages */
  userMessageCount: number;
  /** Number of assistant messages */
  assistantMessageCount: number;
  /** Session start timestamp */
  createdAt: string;
  /** Last message timestamp */
  updatedAt: string;
  /** File size in bytes */
  fileSize: number;
  /** Whether the session appears to be currently active (recently modified) */
  isActive: boolean;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  /** Plain text content for display */
  content: string;
  /** Structured content blocks (for assistant messages with tool usage) */
  contentBlocks: MessageContentBlock[];
  /** Whether this message contains tool calls */
  hasToolBlocks: boolean;
  /** Original timestamp from the JSONL entry */
  timestamp: string;
}

export interface ParsedSession {
  info: ClaudeSessionInfo;
  messages: ParsedMessage[];
}

// Raw JSONL entry types
interface JournalEntry {
  type: string;
  timestamp?: string;
  sessionId?: string;
  [key: string]: unknown;
}

interface UserEntry extends JournalEntry {
  type: 'user';
  parentUuid: string | null;
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  uuid: string;
  timestamp: string;
}

interface AssistantEntry extends JournalEntry {
  type: 'assistant';
  parentUuid: string;
  cwd: string;
  sessionId: string;
  message: {
    content: ContentBlock[];
    id?: string;
    model?: string;
    role: 'assistant';
    stop_reason?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  uuid: string;
  timestamp: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

// ==========================================
// Path encoding / decoding (pure)
// ==========================================

/**
 * Decode a Claude Code project directory name back to a filesystem path.
 *
 * Claude Code encodes absolute paths by replacing path separators with '-'.
 * Unix:    "/root/clawd"    → "-root-clawd"
 * Windows: "C:\Users\foo"   → "C-Users-foo"
 *
 * NOTE: This is lossy — directory names containing hyphens are ambiguous.
 * The `cwd` field inside JSONL entries is the authoritative working directory;
 * this function is only used as a fallback for display purposes.
 */
export function decodeProjectPath(encodedName: string): string {
  // Windows-style: starts with a drive letter followed by '-', e.g., "C-Users-foo"
  if (/^[A-Za-z]-/.test(encodedName)) {
    const drive = encodedName[0].toUpperCase();
    const rest = encodedName.slice(1).replace(/-/g, '\\');
    return `${drive}:${rest}`;
  }
  // Unix-style: starts with '-', e.g., "-root-clawd"
  if (encodedName.startsWith('-')) {
    return encodedName.replace(/^-/, '/').replace(/-/g, '/');
  }
  return encodedName;
}

/**
 * Encode a filesystem path into a Claude Code project directory name.
 *
 * Inverse of {@link decodeProjectPath}.
 * Unix:    "/root/clawd"     → "-root-clawd"
 * Windows: "C:\Users\foo"    → "C-Users-foo"
 */
export function encodeProjectPath(absolutePath: string): string {
  // Windows: "C:\Users\foo" → "C-Users-foo"
  const winMatch = absolutePath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (winMatch) {
    const drive = winMatch[1].toUpperCase();
    const rest = winMatch[2].replace(/[\\/]/g, '-');
    return rest ? `${drive}-${rest}` : drive;
  }
  // Unix: "/root/clawd" → "-root-clawd"
  if (absolutePath.startsWith('/')) {
    return absolutePath.replace(/\//g, '-');
  }
  return absolutePath;
}

/**
 * Cross-platform basename — works for both Unix and Windows paths in the browser
 * and on Node. Strips trailing slashes/backslashes.
 */
function pathBasename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// ==========================================
// Pure JSONL parsing
// ==========================================

/**
 * Pure single-pass parser shared by every code path. Takes pre-split lines so
 * fs-backed callers don't pay for double-splitting; takes a metadata struct
 * so it works from a Node `fs.Stats` or a browser `File` (which has size and
 * `lastModified` but no birthtime).
 */
export function parseLinesIntoSession(
  lines: string[],
  sessionId: string,
  projectPath: string,
  meta: { fileSize: number; mtimeMs: number; birthtimeMs?: number },
  activeThresholdMs: number,
  collectMessages: boolean,
): ParsedSession | null {
  if (lines.length === 0) return null;

  const messages: ParsedMessage[] = [];
  let cwd = '';
  let gitBranch = '';
  let version = '';
  let preview = '';
  let createdAt = '';
  let updatedAt = '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JournalEntry;

      if (entry.timestamp) {
        if (!createdAt) createdAt = entry.timestamp as string;
        updatedAt = entry.timestamp as string;
      }

      if (entry.type === 'user') {
        const userEntry = entry as UserEntry;
        userMessageCount++;

        if (!cwd && userEntry.cwd) cwd = userEntry.cwd;
        if (!gitBranch && userEntry.gitBranch) gitBranch = userEntry.gitBranch;
        if (!version && userEntry.version) version = userEntry.version;

        if (!preview && userEntry.message?.content) {
          const msgContent = userEntry.message.content;
          if (typeof msgContent === 'string') {
            preview = msgContent.slice(0, 120);
          } else if (Array.isArray(msgContent)) {
            const textBlock = msgContent.find(b => b.type === 'text');
            if (textBlock?.text) {
              preview = textBlock.text.slice(0, 120);
            }
          }
        }

        if (collectMessages) {
          const parsed = parseUserMessage(userEntry);
          if (parsed) messages.push(parsed);
        }
      } else if (entry.type === 'assistant') {
        assistantMessageCount++;

        if (collectMessages) {
          const parsed = parseAssistantMessage(entry as AssistantEntry);
          if (parsed) messages.push(parsed);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Skip empty sessions (only queue-operation entries, no actual messages)
  if (userMessageCount === 0 && assistantMessageCount === 0) {
    return null;
  }

  // Use cwd from JSONL (authoritative) for projectName; fall back to decoded folder name
  const effectivePath = cwd || projectPath;
  const isActive = Date.now() - meta.mtimeMs < activeThresholdMs;
  const fallbackCreatedMs = meta.birthtimeMs ?? meta.mtimeMs;

  const info: ClaudeSessionInfo = {
    sessionId,
    projectPath: effectivePath,
    projectName: pathBasename(effectivePath),
    cwd: effectivePath,
    gitBranch: gitBranch || '',
    version: version || '',
    preview: preview || '(no preview)',
    userMessageCount,
    assistantMessageCount,
    createdAt: createdAt || new Date(fallbackCreatedMs).toISOString(),
    updatedAt: updatedAt || new Date(meta.mtimeMs).toISOString(),
    fileSize: meta.fileSize,
    isActive,
  };

  return { info, messages };
}

/**
 * Extract session metadata from raw JSONL content (no fs / Node-only deps).
 *
 * Use from the browser by passing the contents of a `File` (read via FileReader
 * or `file.text()`) plus its `size` and `lastModified` timestamp.
 */
export function extractSessionInfoFromContent(
  content: string,
  sessionId: string,
  projectPath: string,
  meta: { fileSize: number; mtimeMs: number; birthtimeMs?: number },
  activeThresholdMs: number = DEFAULT_ACTIVE_THRESHOLD_MS,
): ClaudeSessionInfo | null {
  const lines = content.split('\n').filter(l => l.trim());
  return parseLinesIntoSession(lines, sessionId, projectPath, meta, activeThresholdMs, false)?.info ?? null;
}

/**
 * Fully parse JSONL content into a {@link ParsedSession} (no fs).
 */
export function parseSessionFromContent(
  content: string,
  sessionId: string,
  projectPath: string,
  meta: { fileSize: number; mtimeMs: number; birthtimeMs?: number },
  activeThresholdMs: number = DEFAULT_ACTIVE_THRESHOLD_MS,
): ParsedSession | null {
  const lines = content.split('\n').filter(l => l.trim());
  return parseLinesIntoSession(lines, sessionId, projectPath, meta, activeThresholdMs, true);
}

/**
 * Parse a user message entry into a ParsedMessage.
 */
function parseUserMessage(entry: UserEntry): ParsedMessage | null {
  const msgContent = entry.message?.content;
  if (!msgContent) return null;

  let text: string;
  if (typeof msgContent === 'string') {
    text = msgContent;
  } else if (Array.isArray(msgContent)) {
    text = msgContent
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  } else {
    return null;
  }

  if (!text.trim()) return null;

  return {
    role: 'user',
    content: text,
    contentBlocks: [{ type: 'text', text }],
    hasToolBlocks: false,
    timestamp: entry.timestamp || new Date().toISOString(),
  };
}

/**
 * Parse an assistant message entry into a ParsedMessage.
 * Handles text, tool_use, and tool_result content blocks.
 */
function parseAssistantMessage(entry: AssistantEntry): ParsedMessage | null {
  const msgContent = entry.message?.content;
  if (!msgContent || !Array.isArray(msgContent)) return null;

  const contentBlocks: MessageContentBlock[] = [];
  const textParts: string[] = [];
  let hasToolBlocks = false;

  for (const block of msgContent) {
    switch (block.type) {
      case 'text': {
        if (block.text) {
          contentBlocks.push({ type: 'text', text: block.text });
          textParts.push(block.text);
        }
        break;
      }
      case 'tool_use': {
        hasToolBlocks = true;
        contentBlocks.push({
          type: 'tool_use',
          id: block.id || '',
          name: block.name || '',
          input: block.input,
        });
        break;
      }
      case 'tool_result': {
        hasToolBlocks = true;
        const resultContent = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter(c => c.type === 'text')
                .map(c => c.text || '')
                .join('\n')
            : '';
        contentBlocks.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id || '',
          content: resultContent,
          is_error: block.is_error || false,
        });
        break;
      }
    }
  }

  if (contentBlocks.length === 0) return null;

  const plainText = textParts.join('\n');

  return {
    role: 'assistant',
    content: plainText,
    contentBlocks,
    hasToolBlocks,
    timestamp: entry.timestamp || new Date().toISOString(),
  };
}
