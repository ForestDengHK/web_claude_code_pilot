import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  try {
    const { dir, name, base } = await request.json();

    if (!dir || !name) {
      return NextResponse.json({ error: 'dir and name are required' }, { status: 400 });
    }

    // Validate branch name
    const trimmed = name.trim();
    if (!trimmed) {
      return NextResponse.json({ error: 'Branch name cannot be empty' }, { status: 400 });
    }
    // Reject shell-dangerous characters (execFile is safe, but reject obviously bad names)
    if (/[\s~^:?*\[\\{}]/.test(trimmed)) {
      return NextResponse.json({ error: 'Branch name contains invalid characters' }, { status: 400 });
    }
    // Git validates further, but catch double dots and trailing dots/slashes early
    if (trimmed.includes('..') || trimmed.endsWith('.') || trimmed.endsWith('/') || trimmed.startsWith('-')) {
      return NextResponse.json({ error: 'Invalid branch name' }, { status: 400 });
    }

    // Check if branch already exists
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--verify', trimmed]);
      if (stdout.trim()) {
        return NextResponse.json({ error: `Branch '${trimmed}' already exists` }, { status: 409 });
      }
    } catch {
      // Branch doesn't exist — good, proceed
    }

    // Create and checkout new branch
    const args = ['-C', dir, 'checkout', '-b', trimmed];
    if (base) {
      args.push(base);
    }
    await execFileAsync('git', args, { timeout: 30000 });

    // Verify
    const { stdout: newBranch } = await execFileAsync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);

    return NextResponse.json({
      success: true,
      branch: newBranch.trim(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create branch';

    if (message.includes('not a valid branch name')) {
      return NextResponse.json({ error: 'Invalid branch name' }, { status: 400 });
    }
    if (message.includes('Your local changes')) {
      return NextResponse.json({
        error: 'Uncommitted changes conflict with the base branch. Commit or stash first.',
        code: 'DIRTY_WORKING_TREE',
      }, { status: 409 });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
