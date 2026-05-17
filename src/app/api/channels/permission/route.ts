import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/channels/session-manager';
import { formatVerdict } from '@/lib/channels/verdict';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { sessionId, requestId, allow } = await req.json() as {
    sessionId: string; requestId: string; allow: boolean;
  };
  const session = getSession(sessionId);
  if (!session || session.state === 'exited') {
    return NextResponse.json({ error: 'no live channel session' }, { status: 409 });
  }
  try {
    const res = await fetch(`http://127.0.0.1:${session.channelPort}/verdict`, {
      method: 'POST', body: formatVerdict(requestId, allow),
    });
    return NextResponse.json({ ok: res.ok });
  } catch {
    return NextResponse.json({ ok: false, error: 'verdict delivery failed' }, { status: 502 });
  }
}
