import { NextRequest } from 'next/server';
import { getSession } from '@/lib/db';
import { queryCodexGoal } from '@/lib/codex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/codex/goal?session_id=<id>
 *
 * Returns the current Codex goal state for a chat session, or `null` if no
 * goal is set (or if the thread has never been used / goals feature is
 * disabled in Codex config). Used by the ChatView mount effect to restore
 * the goal badge after a page reload — the in-memory state is otherwise
 * only seeded by `thread/goal/updated` SSE events during a live stream.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session_id');
  if (!sessionId) {
    return Response.json({ error: 'session_id is required' }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'session not found' }, { status: 404 });
  }

  if (!session.codex_thread_id) {
    return Response.json({ goal: null });
  }

  const goal = await queryCodexGoal(sessionId, session.codex_thread_id);
  return Response.json({ goal });
}
