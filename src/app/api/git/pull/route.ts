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

    // 2. Check for dirty state (uncommitted changes)
    const { stdout: statusOut } = await runGit(path, ['status', '--porcelain']);
    if (statusOut.trim()) {
      return NextResponse.json({ status: 'dirty', message: 'Uncommitted changes detected' });
    }

    // 3. Pull (fast-forward only — never auto-creates merge commits)
    try {
      const { stdout } = await runGit(path, ['pull', '--ff-only']);
      const result = parseGitPullOutput(stdout);
      return NextResponse.json({ status: result, output: stdout.trim() });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr ?? String(err);
      return NextResponse.json({
        status: 'error',
        message: classifyGitPullError(stderr),
      });
    }
  } catch {
    return NextResponse.json({ status: 'error', message: 'Request failed' }, { status: 500 });
  }
}
