import { NextRequest } from 'next/server';
import { getSession } from '@/lib/db';
import { runCodexReview } from '@/lib/codex-client';
import { getOrCreatePendingCodexReview } from '@/lib/codex-review-registry';
import type { CodexReviewResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

    const review = await getOrCreatePendingCodexReview(sessionId, () =>
      runCodexReview({
        sessionId,
        workingDirectory: session.working_directory,
        model: session.model || undefined,
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
