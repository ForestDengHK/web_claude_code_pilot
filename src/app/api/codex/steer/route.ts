import { NextRequest } from 'next/server';
import { CodexProcessManager } from '@/lib/codex-process-manager';
import { addMessage, getSession } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Steer endpoint — injects additional user input into the Codex turn that is
 * currently running, without interrupting it (`turn/steer`).
 *
 * Codex-only: T1 (channels) and T2 (claude SDK) have no equivalent, so the UI
 * only surfaces this for the Codex backend.
 *
 * Returns 409 when there is no active turn to steer (the UI ignores that and
 * leaves the user's text in the input box).
 *
 * Body: { session_id: string, content: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session_id, content } = body;

    if (!session_id || !content) {
      return Response.json({ error: 'session_id and content are required' }, { status: 400 });
    }

    const session = getSession(session_id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const turnId = await CodexProcessManager.steer(session_id, content);
    if (!turnId) {
      return Response.json({ error: 'No active turn to steer' }, { status: 409 });
    }

    // Persist the steering message so the transcript reflects what was injected
    // mid-turn, consistent with normal user messages. Return the saved message
    // so the client can optimistically render it into the live conversation.
    const message = addMessage(session_id, 'user', content, null, 'codex');

    return Response.json({ steered: true, turnId, message });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return Response.json({ error: message }, { status: 500 });
  }
}
