import { NextRequest, NextResponse } from 'next/server';
import { isSessionActive } from '@/lib/abort-registry';
import { getPendingPermissionForSession } from '@/lib/permission-registry';
import { getPendingInputRequestForSession } from '@/lib/input-request-registry';
import { getStreamBuffer } from '@/lib/streaming-buffer-registry';
import { getLastMessageInfo } from '@/lib/db';

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
  // Only use the hint if the last user message was sent within 5 minutes
  // (prevents permanently stuck isProcessing if backend crashed).
  let dbHint = false;
  if (!abortActive && !streamBuffer) {
    const lastMsg = getLastMessageInfo(sessionId);
    if (lastMsg?.role === 'user') {
      const msgTime = new Date(lastMsg.created_at.replace(' ', 'T') + 'Z').getTime();
      const ageMs = Date.now() - msgTime;
      dbHint = ageMs < 5 * 60 * 1000; // 5 minutes
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
