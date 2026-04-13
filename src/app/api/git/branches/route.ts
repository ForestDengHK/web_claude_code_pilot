import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function GET(request: NextRequest) {
  const dir = request.nextUrl.searchParams.get('dir');
  if (!dir) {
    return NextResponse.json({ error: 'dir parameter required' }, { status: 400 });
  }

  try {
    // Get current branch
    let current: string | null = null;
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
      current = stdout.trim() || null;
    } catch {
      // Detached HEAD or not a git repo
    }

    if (current === null) {
      // Not a git repo
      return NextResponse.json({ current: null, local: [], remote: [] });
    }

    // Get local branches
    const { stdout: localOut } = await execFileAsync('git', [
      '-C', dir, 'branch', '--format=%(refname:short)',
    ]);
    const local = localOut.trim().split('\n').filter(Boolean);

    // Get remote branches (excluding HEAD and bare remote names)
    let remote: string[] = [];
    try {
      const { stdout: remoteOut } = await execFileAsync('git', [
        '-C', dir, 'branch', '-r', '--format=%(refname:short)',
      ]);
      remote = remoteOut.trim().split('\n')
        .filter(b => {
          if (!b) return false;
          if (b.endsWith('/HEAD')) return false;
          // Filter out bare remote names like "origin" or "upstream"
          // Valid remote branches always contain a slash: "origin/main"
          if (!b.includes('/')) return false;
          return true;
        });
    } catch {
      // No remotes configured
    }

    // Check if working directory is dirty (for safe checkout warning)
    let dirty = false;
    try {
      const { stdout: statusOut } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
      dirty = statusOut.trim().length > 0;
    } catch {
      // Ignore
    }

    return NextResponse.json({ current, local, remote, dirty });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list branches';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
