import { NextRequest } from 'next/server';
import { abortSession, interruptSession } from '@/lib/abort-registry';
import { CodexProcessManager } from '@/lib/codex-process-manager';

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
 * Codex sessions use a two-tier strategy too:
 * - Default (force=false): send `turn/interrupt` to the active turn.
 * - Force (force=true): kill the `codex app-server` subprocess for the session.
 */
export async function POST(request: NextRequest) {
  try {
    const { session_id, force } = await request.json();
    if (!session_id) {
      return Response.json({ error: 'session_id is required' }, { status: 400 });
    }

    if (force) {
      // Prefer Codex hard-stop when a Codex process exists for this session.
      if (CodexProcessManager.interrupt(session_id)) {
        await CodexProcessManager.kill(session_id);
        return Response.json({ stopped: true, method: 'kill' });
      }

      // Hard kill — Force Stop button
      const stopped = abortSession(session_id);
      return Response.json({ stopped, method: 'abort' });
    }

    // Prefer Codex graceful stop when a Codex turn is active.
    if (CodexProcessManager.interrupt(session_id)) {
      return Response.json({ stopped: true, method: 'interrupt' });
    }

    // Graceful interrupt — normal Stop button
    const stopped = await interruptSession(session_id);
    return Response.json({ stopped, method: 'interrupt' });
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
}
