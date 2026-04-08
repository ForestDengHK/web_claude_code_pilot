import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GIT_PULL_TIMEOUT_MS } from '@/lib/config';
import { parseGitPullOutput, classifyGitPullError } from '@/lib/git-pull';

const execFileAsync = promisify(execFile);

/** Run a git command in the given directory with the pull timeout. */
async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_PULL_TIMEOUT_MS });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path } = body;

    if (!path || typeof path !== 'string') {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }

    // 1. Verify this is a git repo
    try {
      await runGit(path, ['rev-parse', '--git-dir']);
    } catch {
      return NextResponse.json({ status: 'not-git' });
    }

    // 2. Pull (fast-forward only — never auto-creates merge commits)
    // Let git decide: if local changes don't overlap with incoming changes, pull succeeds.
    // Only report a conflict when git itself says local files would be overwritten.
    try {
      const { stdout } = await runGit(path, ['pull', '--ff-only']);
      const result = parseGitPullOutput(stdout);
      return NextResponse.json({ status: result, output: stdout.trim() });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr?.trim()
        || (err instanceof Error ? err.message : String(err));
      // Local changes clash with incoming remote changes
      if (stderr.includes('would be overwritten')) {
        return NextResponse.json({ status: 'dirty', message: 'Local changes conflict with remote changes' });
      }
      return NextResponse.json({
        status: 'error',
        message: classifyGitPullError(stderr),
      });
    }
  } catch {
    return NextResponse.json({ status: 'error', message: 'Request failed' }, { status: 500 });
  }
}
