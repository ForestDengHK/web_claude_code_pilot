import { NextRequest, NextResponse } from 'next/server';
import { killSession } from '@/lib/channels/session-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId: string };
  killSession(sessionId);
  return NextResponse.json({ ok: true });
}
