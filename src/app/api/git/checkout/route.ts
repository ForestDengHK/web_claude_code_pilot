import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  let requestedBranch = '';
  try {
    const { dir, branch } = await request.json();
    requestedBranch = branch || '';

    if (!dir || !branch) {
      return NextResponse.json({ error: 'dir and branch are required' }, { status: 400 });
    }

    // Validate branch name (basic safety check — execFile prevents injection,
    // but reject obviously invalid names early)
    if (/[;\s&|`$(){}]/.test(branch)) {
      return NextResponse.json({ error: 'Invalid branch name' }, { status: 400 });
    }

    // Check current branch first
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
      if (stdout.trim() === branch) {
        return NextResponse.json({ success: true, branch, message: 'Already on this branch' });
      }
    } catch {
      // Detached HEAD, proceed with checkout
    }

    // Perform checkout
    await execFileAsync('git', ['-C', dir, 'checkout', branch], { timeout: 30000 });

    // Verify the switch
    const { stdout: newBranch } = await execFileAsync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);

    return NextResponse.json({
      success: true,
      branch: newBranch.trim(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to checkout branch';

    // Detect common failure modes
    if (message.includes('Your local changes')) {
      return NextResponse.json({
        error: 'Uncommitted changes would be overwritten. Commit or stash your changes first.',
        code: 'DIRTY_WORKING_TREE',
      }, { status: 409 });
    }
    if (message.includes('did not match any')) {
      return NextResponse.json({
        error: `Branch '${requestedBranch}' not found`,
        code: 'BRANCH_NOT_FOUND',
      }, { status: 404 });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
