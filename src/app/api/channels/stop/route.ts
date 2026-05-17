/**
 * POST /api/channels/stop
 * Body: { sessionId: string }
 *
 * Channels-session TEARDOWN — kills the channel's long-lived claude PTY
 * subprocess. This is NOT the per-turn Stop button: a turn stop should use
 * /api/chat/stop (aborts the active stream but keeps the reusable session
 * process alive).
 *
 * Called by the frontend's delete-session action (ChatListPanel's
 * `handleDeleteSession`) for backend:'channels' sessions, so the subprocess
 * is reaped immediately on delete instead of lingering until idle-reaping.
 */
import { NextRequest, NextResponse } from 'next/server';
import { killSession } from '@/lib/channels/session-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId: string };
  killSession(sessionId);
  return NextResponse.json({ ok: true });
}
