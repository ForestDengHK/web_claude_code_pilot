/**
 * Server-side parser for Claude Code CLI session files (.jsonl).
 *
 * Claude Code stores conversation history as JSONL files in:
 *   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
 *
 * Pure parsing logic + types live in `claude-session-shared.ts` so they can
 * also be used in the browser. This file adds the fs-backed entry points
 * (listClaudeSessions, parseClaudeSession, getClaudeProjectsDir) that walk
 * the on-disk projects directory.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { MAX_SESSION_FILE_SIZE as MAX_FILE_SIZE } from '@/lib/config';
import {
  decodeProjectPath,
  parseLinesIntoSession,
  DEFAULT_ACTIVE_THRESHOLD_MS,
  type ClaudeSessionInfo,
  type ParsedSession,
} from '@/lib/claude-session-shared';

// Re-export everything pure for callers who already import from this file.
export {
  decodeProjectPath,
  encodeProjectPath,
  parseLinesIntoSession,
  extractSessionInfoFromContent,
  parseSessionFromContent,
  DEFAULT_ACTIVE_THRESHOLD_MS,
} from '@/lib/claude-session-shared';
export type {
  ClaudeSessionInfo,
  ParsedMessage,
  ParsedSession,
} from '@/lib/claude-session-shared';

// ==========================================
// Session Discovery (fs-backed)
// ==========================================

/**
 * Get the Claude Code projects directory.
 */
export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * True if a Claude Code transcript (.jsonl) for this session id exists on disk.
 * Scans every project directory because session ids are globally-unique UUIDs.
 *
 * Used to guard `--resume <id>`: a turn that died before the CLI flushed its
 * transcript leaves a dangling id whose resume fails with "No conversation found",
 * wedging the lane permanently.
 */
export function claudeTranscriptExists(
  sessionId: string,
  projectsDir: string = getClaudeProjectsDir(),
): boolean {
  if (!sessionId) return false;
  if (!fs.existsSync(projectsDir)) return false;
  try {
    for (const projectDir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      if (fs.existsSync(path.join(projectsDir, projectDir.name, `${sessionId}.jsonl`))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * List all available Claude Code CLI sessions.
 * Scans ~/.claude/projects/ for .jsonl files and extracts metadata.
 */
export function listClaudeSessions(activeThresholdMs = DEFAULT_ACTIVE_THRESHOLD_MS): ClaudeSessionInfo[] {
  const projectsDir = getClaudeProjectsDir();

  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  const sessions: ClaudeSessionInfo[] = [];

  try {
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;

      const projectPath = path.join(projectsDir, projectDir.name);
      const decodedPath = decodeProjectPath(projectDir.name);

      try {
        const files = fs.readdirSync(projectPath);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

        for (const jsonlFile of jsonlFiles) {
          const filePath = path.join(projectPath, jsonlFile);
          const sessionId = jsonlFile.replace('.jsonl', '');

          try {
            const info = extractSessionInfo(filePath, sessionId, decodedPath, activeThresholdMs);
            if (info) {
              sessions.push(info);
            }
          } catch {
            // Skip files that can't be parsed
          }
        }
      } catch {
        // Skip directories that can't be read
      }
    }
  } catch {
    // Projects directory can't be read
  }

  // Sort by most recent first
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return sessions;
}

/**
 * Read and split a JSONL file into lines, with size guard.
 * Returns null if the file exceeds MAX_FILE_SIZE.
 */
function readJsonlLines(filePath: string): { lines: string[]; stat: fs.Stats } | null {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    console.warn(`[claude-session-parser] Skipping ${filePath}: file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  return { lines, stat };
}

/**
 * Extract metadata from a session JSONL file without fully parsing all messages.
 */
function extractSessionInfo(
  filePath: string,
  sessionId: string,
  projectPath: string,
  activeThresholdMs: number,
): ClaudeSessionInfo | null {
  const result = readJsonlLines(filePath);
  if (!result) return null;
  const { lines, stat } = result;

  return parseLinesIntoSession(
    lines,
    sessionId,
    projectPath,
    { fileSize: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs },
    activeThresholdMs,
    false,
  )?.info ?? null;
}

/**
 * Fully parse a Claude Code session JSONL file into messages.
 * Reads the file once and extracts both metadata and messages in a single pass.
 */
export function parseClaudeSession(sessionId: string): ParsedSession | null {
  const projectsDir = getClaudeProjectsDir();

  if (!fs.existsSync(projectsDir)) return null;

  // Find the session file across all project directories
  let filePath: string | null = null;
  let projectPath = '';

  try {
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;

      const candidate = path.join(projectsDir, projectDir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
        projectPath = decodeProjectPath(projectDir.name);
        break;
      }
    }
  } catch {
    return null;
  }

  if (!filePath) return null;

  const result = readJsonlLines(filePath);
  if (!result) return null;
  const { lines, stat } = result;

  return parseLinesIntoSession(
    lines,
    sessionId,
    projectPath,
    { fileSize: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs },
    DEFAULT_ACTIVE_THRESHOLD_MS,
    true,
  );
}
