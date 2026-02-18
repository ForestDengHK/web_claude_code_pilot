import { NextRequest } from 'next/server';
import { abortSession } from '@/lib/abort-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chat/stop
 * Body: { session_id: string }
 *
 * Explicitly stops a running Claude Code process for the given session.
 * This is called by the frontend Stop button so the backend process is
 * also killed, not just the client-side reader.
 */
export async function POST(request: NextRequest) {
  try {
    const { session_id } = await request.json();
    if (!session_id) {
      return Response.json({ error: 'session_id is required' }, { status: 400 });
    }
    const stopped = abortSession(session_id);
    return Response.json({ stopped });
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
}
