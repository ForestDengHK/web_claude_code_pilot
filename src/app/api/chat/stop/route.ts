import { NextRequest } from 'next/server';
import { abortSession, interruptSession } from '@/lib/abort-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chat/stop
 * Body: { session_id: string, force?: boolean }
 *
 * Two-tier stop for Claude sessions:
 * - Default (force=false): calls interrupt() — graceful stop, lets current tool finish.
 * - Force (force=true): calls abort() — hard kill, immediately terminates subprocess.
 *
 * Codex sessions don't have a Query object, so they always fall back to abort().
 */
export async function POST(request: NextRequest) {
  try {
    const { session_id, force } = await request.json();
    if (!session_id) {
      return Response.json({ error: 'session_id is required' }, { status: 400 });
    }

    if (force) {
      // Hard kill — Force Stop button
      const stopped = abortSession(session_id);
      return Response.json({ stopped, method: 'abort' });
    }

    // Graceful interrupt — normal Stop button
    const stopped = await interruptSession(session_id);
    return Response.json({ stopped, method: 'interrupt' });
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
}
