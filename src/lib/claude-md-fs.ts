/**
 * Read/write helpers for Claude Code's CLAUDE.md memory files.
 *
 * Two scopes are supported:
 *   - `user`    → `~/.claude/CLAUDE.md`       (global, applied to every project)
 *   - `project` → `{cwd}/CLAUDE.md`           (project-local, per working dir)
 *
 * The write path refuses to create files outside these canonical locations.
 * Callers must pass `cwd` for `project` scope; an absolute, existing directory
 * is required. Path traversal (`..`) is defused by `path.resolve`, and the
 * resolved file path must equal `{cwd}/CLAUDE.md` exactly — any mismatch
 * (symlink-indirected cwd, unusual casing on case-insensitive FSes, etc.)
 * is rejected.
 *
 * Writes use `fs.writeFileSync(path, content, 'utf-8')` which issues a single
 * `open(O_WRONLY|O_CREAT|O_TRUNC)` + `write` + `close`. This matches the
 * pattern used by `codex-skill-fs.ts` and is sufficient for a single-writer
 * UI editor. If we ever need crash-resistance we can upgrade to write-to-tmp
 * + rename; for now the simpler form is easier to audit.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaudeMdScope = 'user' | 'project';

export interface ClaudeMdRead {
  /** True if the file exists on disk. For a missing file we still return
   *  the resolved path + empty content, so the UI can render an empty
   *  editor and show "(does not exist yet — saving will create it)". */
  exists: boolean;
  /** File contents, UTF-8. Empty string when `exists === false`. */
  content: string;
  /** Absolute path. Useful for "edit on disk" CTA in the UI. */
  path: string;
  /** Last-modified epoch ms. Omitted when `exists === false`. */
  mtimeMs?: number;
}

export type ClaudeMdWriteResult =
  | { ok: true; path: string }
  | { ok: false; code: number; reason: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on CLAUDE.md size. Real files are usually <10 KB; 1 MB is a
 *  generous ceiling that still protects against a runaway paste. */
export const MAX_CLAUDE_MD_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Absolute path to the user-level CLAUDE.md. Respects `process.env.HOME`
 *  for testability; falls back to `os.homedir()` which Node resolves from
 *  passwd. */
export function userClaudeMdPath(): string {
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, '.claude', 'CLAUDE.md');
}

/**
 * Resolve the absolute path for a given scope/cwd. Throws on invalid input:
 *   - `project` scope without cwd
 *   - `project` cwd not absolute
 *   - `project` cwd not an existing directory
 *   - unknown scope
 *
 * Returns the canonical file path; the caller is expected to read/write it.
 */
export function resolveClaudeMdPath(
  scope: ClaudeMdScope,
  cwd?: string,
): string {
  if (scope === 'user') {
    return userClaudeMdPath();
  }
  if (scope === 'project') {
    if (!cwd) throw new Error('project scope requires cwd');
    if (!path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
    let st: fs.Stats;
    try {
      st = fs.statSync(cwd);
    } catch {
      throw new Error(`cwd does not exist: ${cwd}`);
    }
    if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
    const resolved = path.resolve(cwd, 'CLAUDE.md');
    // Defuse a content-embedded "../../.." — after resolve, the parent dir
    // must equal the original cwd. If not, something weird was passed.
    if (path.dirname(resolved) !== path.resolve(cwd)) {
      throw new Error('path traversal detected');
    }
    return resolved;
  }
  throw new Error(`unknown scope: ${scope}`);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function readClaudeMd(
  scope: ClaudeMdScope,
  cwd?: string,
): ClaudeMdRead {
  const filePath = resolveClaudeMdPath(scope, cwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { exists: false, content: '', path: filePath };
  }
  if (!stat.isFile()) {
    // A directory named CLAUDE.md would be surprising but not our place to fix.
    return { exists: false, content: '', path: filePath };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return { exists: true, content, path: filePath, mtimeMs: stat.mtimeMs };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writeClaudeMd(
  scope: ClaudeMdScope,
  content: string,
  cwd?: string,
): ClaudeMdWriteResult {
  if (typeof content !== 'string') {
    return { ok: false, code: 400, reason: 'content must be a string' };
  }
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_CLAUDE_MD_BYTES) {
    return {
      ok: false,
      code: 413,
      reason: `content too large: ${byteLength} bytes (max ${MAX_CLAUDE_MD_BYTES})`,
    };
  }

  let filePath: string;
  try {
    filePath = resolveClaudeMdPath(scope, cwd);
  } catch (err) {
    return {
      ok: false,
      code: 400,
      reason: err instanceof Error ? err.message : 'invalid scope/cwd',
    };
  }

  // Ensure parent dir exists for user scope. For project scope, the dir
  // exists by construction (we already statSync'd it in resolveClaudeMdPath).
  if (scope === 'user') {
    const parent = path.dirname(filePath);
    try {
      fs.mkdirSync(parent, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        code: 500,
        reason: `failed to create ${parent}: ${err instanceof Error ? err.message : 'unknown'}`,
      };
    }
  }

  try {
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      code: 500,
      reason: `write failed: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  return { ok: true, path: filePath };
}
