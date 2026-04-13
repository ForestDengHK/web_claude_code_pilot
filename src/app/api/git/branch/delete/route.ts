import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  try {
    const { dir, branch, force } = await request.json();

    if (!dir || !branch) {
      return NextResponse.json({ error: 'dir and branch are required' }, { status: 400 });
    }

    // Never allow deleting the current branch
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
      if (stdout.trim() === branch) {
        return NextResponse.json({
          error: 'Cannot delete the current branch. Switch to another branch first.',
          code: 'IS_CURRENT_BRANCH',
        }, { status: 409 });
      }
    } catch {
      // Detached HEAD — safe to proceed
    }

    // Delete the branch (-d for safe delete, -D for force)
    const flag = force ? '-D' : '-d';
    await execFileAsync('git', ['-C', dir, 'branch', flag, branch], { timeout: 15000 });

    return NextResponse.json({ success: true, deleted: branch });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete branch';

    if (message.includes('not fully merged')) {
      return NextResponse.json({
        error: `Branch '${String((await request.clone().json().catch(() => ({}))).branch || '')}' has unmerged changes. Use force delete to remove it anyway.`,
        code: 'NOT_FULLY_MERGED',
      }, { status: 409 });
    }
    if (message.includes('not found')) {
      return NextResponse.json({ error: 'Branch not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
