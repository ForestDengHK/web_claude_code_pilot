import { NextRequest } from 'next/server';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { getSession } from '@/lib/db';
import { runCodexReview } from '@/lib/codex-client';
import {
  getOrCreatePendingCodexReview,
  clearReviewEntry,
  updateReviewProgress,
  getCodexReviewStatus,
} from '@/lib/codex-review-registry';
import type { CodexReviewResponse } from '@/types';

const execFileAsync = promisify(execFileCb);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Check whether a working directory has uncommitted changes (staged, unstaged,
 * or untracked files).  Returns a summary string or null if clean.
 */
async function checkUncommittedChanges(dir: string): Promise<{
  hasChanges: boolean;
  summary: string;
  fileCount: number;
}> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
    const lines = stdout.split('\n').filter(l => {
      if (!l.trim()) return false;
      // Skip CodePilot-internal upload directory — it's not source code and
      // shouldn't trigger a review even if it's not in .gitignore.
      const filePath = l.slice(3);
      if (filePath === '.codepilot-uploads/' || filePath.startsWith('.codepilot-uploads/')) {
        return false;
      }
      return true;
    });
    if (lines.length === 0) {
      return { hasChanges: false, summary: '', fileCount: 0 };
    }

    let modified = 0;
    let added = 0;
    let untracked = 0;
    for (const line of lines) {
      const xy = line.slice(0, 2);
      if (xy === '??') untracked++;
      else if (xy[0] === 'A' || xy[1] === 'A') added++;
      else modified++;
    }

    const parts: string[] = [];
    if (modified) parts.push(`${modified} modified`);
    if (added) parts.push(`${added} added`);
    if (untracked) parts.push(`${untracked} untracked`);
    return {
      hasChanges: true,
      summary: parts.join(', ') || `${lines.length} changed`,
      fileCount: lines.length,
    };
  } catch {
    // If git fails (not a repo, git not installed, etc.), let the review
    // proceed — Codex will handle the error more gracefully.
    return { hasChanges: true, summary: 'unknown', fileCount: -1 };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sessionId = body.session_id as string | undefined;

    if (!sessionId) {
      return Response.json({ error: 'session_id is required' }, { status: 400 });
    }

    const session = getSession(sessionId);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    if (session.backend !== 'codex') {
      return Response.json({ error: 'Review is only available for Codex sessions' }, { status: 400 });
    }

    if (!session.working_directory) {
      return Response.json(
        { error: 'Session has no working directory. Please set a working directory before running review.' },
        { status: 400 },
      );
    }

    // force=true: clear any cached result so a fresh review starts
    const force = body.force === true;
    if (force) {
      clearReviewEntry(sessionId);
    }

    // Quick pre-check: skip review entirely if there are no uncommitted changes.
    // Only check when starting a NEW review (not joining an in-flight one or
    // returning a cached result).
    const existingStatus = getCodexReviewStatus(sessionId);
    if (existingStatus.status === 'idle') {
      const { hasChanges, summary, fileCount } = await checkUncommittedChanges(
        session.working_directory,
      );
      if (!hasChanges) {
        return Response.json({ noChanges: true });
      }
      // Pass change summary to the client so it can show "Reviewing N files..."
      // (the actual review hasn't started yet — this is informational)
      void summary; // used indirectly via fileCount
      void fileCount;
    }

    const review = await getOrCreatePendingCodexReview(sessionId, () =>
      runCodexReview({
        sessionId,
        workingDirectory: session.working_directory,
        model: session.model || undefined,
        onProgress: (update) => updateReviewProgress(sessionId, update),
      }),
    );

    const response: CodexReviewResponse = {
      review: review.review,
      reviewThreadId: review.reviewThreadId,
      delivery: review.delivery,
      findings: review.findings,
      overallCorrectness: review.overallCorrectness,
      overallExplanation: review.overallExplanation,
      overallConfidenceScore: review.overallConfidenceScore,
    };

    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run Codex review';
    return Response.json({ error: message }, { status: 500 });
  }
}
