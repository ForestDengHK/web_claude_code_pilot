import { NextRequest, NextResponse } from 'next/server';
import { isSessionActive } from '@/lib/abort-registry';
import { getPendingPermissionForSession } from '@/lib/permission-registry';
import { getPendingInputRequestForSession } from '@/lib/input-request-registry';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;

  return NextResponse.json({
    isProcessing: isSessionActive(sessionId),
    pendingPermission: getPendingPermissionForSession(sessionId),
    pendingInputRequest: getPendingInputRequestForSession(sessionId),
  });
}
