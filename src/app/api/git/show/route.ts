import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const TIMEOUT    = 15_000;           // 15s per git command
const MAX_BUFFER = 5 * 1024 * 1024; // 5 MB

const COMMIT_RE = /^[0-9a-f]{4,40}$/;

/** A single changed file in a commit. */
export interface CommitFileChange {
  path: string;
  status: string;       // A=added, M=modified, D=deleted, R=renamed, C=copied, …
  insertions: number;   // -1 for binary files
  deletions: number;    // -1 for binary files
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const dir    = searchParams.get('dir');
  const commit = searchParams.get('commit');

  if (!dir) {
    return NextResponse.json({ error: 'dir parameter required' }, { status: 400 });
  }
  if (!commit) {
    return NextResponse.json({ error: 'commit parameter required' }, { status: 400 });
  }
  if (!COMMIT_RE.test(commit)) {
    return NextResponse.json({ error: 'Invalid commit hash' }, { status: 400 });
  }

  try {
    // ── 1. Commit metadata ──────────────────────────────────────────────────
    // Format: hash NL shortHash NL subject NL author NL isoDate NL body...
    const { stdout: metaOut } = await execFileAsync(
      'git',
      ['-C', dir, 'show', '--format=%H%n%h%n%s%n%an%n%aI%n%B', '--no-patch', commit],
      { timeout: TIMEOUT, maxBuffer: MAX_BUFFER },
    );

    const metaLines = metaOut.split('\n');
    const hash      = metaLines[0]?.trim() ?? '';
    const shortHash = metaLines[1]?.trim() ?? '';
    const subject   = metaLines[2]?.trim() ?? '';
    const author    = metaLines[3]?.trim() ?? '';
    const date      = metaLines[4]?.trim() ?? '';
    // Everything from line 5 onward is the full message body (including subject).
    const message   = metaLines.slice(5).join('\n').trim();

    if (!hash) {
      return NextResponse.json({ error: 'Commit not found' }, { status: 404 });
    }

    // ── 2. Numstat (insertions / deletions) ─────────────────────────────────
    // Each line: <insertions>\t<deletions>\t<path>
    // Binary files use "-" instead of numbers.
    const { stdout: numstatOut } = await execFileAsync(
      'git',
      ['-C', dir, 'show', '--numstat', '--format=', commit],
      { timeout: TIMEOUT, maxBuffer: MAX_BUFFER },
    );

    // Map from path → { insertions, deletions }
    const numstatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const line of numstatOut.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      if (parts.length < 3) continue;
      const ins  = parts[0] === '-' ? -1 : parseInt(parts[0], 10);
      const del  = parts[1] === '-' ? -1 : parseInt(parts[1], 10);
      // For renames numstat uses "old => new" inside braces or just "new".
      // The canonical path is whatever name-status reports, so we store both
      // the raw path and, if it's a rename notation, the destination path.
      const rawPath = parts.slice(2).join('\t');
      numstatMap.set(rawPath, { insertions: ins, deletions: del });
    }

    // ── 3. Name-status (status codes + canonical paths) ─────────────────────
    // Each line: <STATUS>\t<path>  (renames: <STATUS>\t<old>\t<new>)
    const { stdout: nameStatusOut } = await execFileAsync(
      'git',
      ['-C', dir, 'show', '--name-status', '--format=', commit],
      { timeout: TIMEOUT, maxBuffer: MAX_BUFFER },
    );

    const files: CommitFileChange[] = [];

    for (const line of nameStatusOut.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      if (parts.length < 2) continue;

      // Status letter may have a score suffix (e.g. "R100", "C85") — strip it.
      const statusRaw = parts[0];
      const status    = statusRaw[0];   // First character is the status letter

      let path: string;
      let numstatKey: string;

      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        // Rename / copy: parts[1]=old, parts[2]=new
        path = parts[2];
        // numstat for renames uses "{old => new}" or just "new" depending on git version.
        // Try the destination path first, then fall back to the full rename notation.
        numstatKey = path;
      } else {
        path       = parts[1];
        numstatKey = path;
      }

      const stat = numstatMap.get(numstatKey);
      files.push({
        path,
        status,
        insertions: stat?.insertions ?? 0,
        deletions:  stat?.deletions  ?? 0,
      });
    }

    return NextResponse.json({ hash, shortHash, subject, message, author, date, files });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to retrieve commit details';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
