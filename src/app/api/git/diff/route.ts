import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REPO_CHECK_TIMEOUT = 5_000;   // 5s
const DIFF_TIMEOUT       = 15_000;  // 15s
const MAX_BUFFER         = 10 * 1024 * 1024; // 10 MB

/** Validate a commit hash — 4-40 lowercase hex chars. */
function isValidCommit(hash: string): boolean {
  return /^[0-9a-f]{4,40}$/.test(hash);
}

/** Validate a relative file path — no `..`, no null bytes, not absolute. */
function isValidFilePath(file: string): boolean {
  if (!file) return false;
  if (file.startsWith('/')) return false;
  if (file.includes('\0')) return false;
  if (file.split('/').some(seg => seg === '..')) return false;
  return true;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const dir      = searchParams.get('dir');
  const file     = searchParams.get('file') ?? undefined;
  const commit   = searchParams.get('commit') ?? undefined;
  const listOnly = searchParams.get('listOnly') === 'true';

  if (!dir) {
    return NextResponse.json({ error: 'dir parameter required' }, { status: 400 });
  }

  if (commit !== undefined && !isValidCommit(commit)) {
    return NextResponse.json({ error: 'Invalid commit hash' }, { status: 400 });
  }

  if (file !== undefined && !isValidFilePath(file)) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
  }

  // Verify this is a git repository.
  try {
    await execFileAsync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      timeout: REPO_CHECK_TIMEOUT,
    });
  } catch {
    return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
  }

  try {
    // --- listOnly mode: return file list ---
    if (listOnly) {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', dir, 'diff', 'HEAD', '--name-status'],
        { timeout: DIFF_TIMEOUT, maxBuffer: MAX_BUFFER },
      );

      const files = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          // Format: <status>\t<path>  or  R<score>\t<old>\t<new>
          const parts = line.split('\t');
          const rawStatus = parts[0];
          const status = rawStatus[0]; // first char: A, M, D, R, C, …
          const path = parts[parts.length - 1]; // new path for renames, otherwise the only path
          return { path, status };
        });

      return NextResponse.json({ files });
    }

    // --- Diff mode ---
    let args: string[];

    if (commit !== undefined) {
      // Show a specific commit (optionally scoped to a file)
      args = ['show', '--format=', commit];
      if (file) args.push('--', file);
    } else if (file !== undefined) {
      // Diff a specific file against HEAD
      args = ['diff', 'HEAD', '--', file];
    } else {
      // Full working-tree diff against HEAD
      args = ['diff', 'HEAD'];
    }

    let diff: string;
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, ...args], {
        timeout: DIFF_TIMEOUT,
        maxBuffer: MAX_BUFFER,
      });
      diff = stdout;
    } catch (err) {
      // Edge case: empty repo with no HEAD — fall back to staged diff summary
      if (!commit && !file) {
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['-C', dir, 'diff', '--cached', '--name-status'],
            { timeout: DIFF_TIMEOUT, maxBuffer: MAX_BUFFER },
          );
          diff = stdout;
        } catch {
          throw err; // re-throw original error if fallback also fails
        }
      } else {
        throw err;
      }
    }

    return NextResponse.json({ diff });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get diff';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
