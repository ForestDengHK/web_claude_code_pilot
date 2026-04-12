import { NextRequest } from 'next/server';
import { getCodexReviewStatus } from '@/lib/codex-review-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/codex/review/status?session_id=xxx
 *
 * Returns the current state of a Codex code review for the given session.
 * Used by the client to recover from mobile tab suspension — when iOS
 * backgrounds the tab the HTTP fetch drops, but the server-side review
 * keeps running.  The client polls this endpoint on visibilitychange to
 * retrieve the completed result (or learn that it's still running).
 *
 * Response shapes:
 *   { status: 'idle' }                                  – no review in progress or cached
 *   { status: 'running', startedAt: number }            – review is in progress
 *   { status: 'completed', result: CodexReviewResponse } – review finished, cached result
 *   { status: 'failed', error: string }                 – review failed
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session_id');
  if (!sessionId) {
    return Response.json({ error: 'session_id is required' }, { status: 400 });
  }

  const reviewStatus = getCodexReviewStatus(sessionId);
  return Response.json(reviewStatus);
}
