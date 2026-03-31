import { NextRequest, NextResponse } from 'next/server';
import { isSessionActive } from '@/lib/abort-registry';
import { getPendingPermissionForSession } from '@/lib/permission-registry';
import { getPendingInputRequestForSession } from '@/lib/input-request-registry';
import { getStreamBuffer } from '@/lib/streaming-buffer-registry';
import { getLastMessageInfo } from '@/lib/db';

// Capture process start time once at module load.
// Used to distinguish messages sent before vs. after a server restart:
// if the last user message was sent before the server started, the DB hint
// must not fire (processing was lost when the server restarted).
const SERVER_START_TIME = Date.now();

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;

  // Check multiple signals for active processing:
  // 1. Abort registry (primary — set by chat route, cleared when stream ends)
  // 2. Streaming buffer (secondary — exists while collectStreamResponse runs)
  // 3. DB last message role (fallback — if last message is 'user' and recent,
  //    a response may still be pending).  This handles Turbopack dev-mode
  //    scenarios where globalThis-backed registries might not be shared across
  //    API route modules.
  const abortActive = isSessionActive(sessionId);
  const streamBuffer = getStreamBuffer(sessionId);

  // If in-memory registries don't show active, check DB as a hint.
  // Only use the hint if the last user message was sent AFTER this server
  // process started AND within 5 minutes.
  // Requiring msgTime > SERVER_START_TIME prevents a permanently stuck
  // "Reconnecting" state after a dev-server restart: on restart the
  // in-memory registries are empty and the DB still shows a bare 'user'
  // message from the previous run, but that message pre-dates this process
  // so we know the processing was lost.
  let dbHint = false;
  if (!abortActive && !streamBuffer) {
    const lastMsg = getLastMessageInfo(sessionId);
    if (lastMsg?.role === 'user') {
      const msgTime = new Date(lastMsg.created_at.replace(' ', 'T') + 'Z').getTime();
      const ageMs = Date.now() - msgTime;
      dbHint = ageMs < 5 * 60 * 1000 && msgTime > SERVER_START_TIME;
    }
  }

  const isProcessing = abortActive || streamBuffer !== null || dbHint;

  return NextResponse.json({
    isProcessing,
    pendingPermission: getPendingPermissionForSession(sessionId),
    pendingInputRequest: getPendingInputRequestForSession(sessionId),
    streamingContent: streamBuffer,
  });
}
