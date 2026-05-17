import { NextRequest, NextResponse } from 'next/server';
import { publishChannelEvent, type ChannelPermissionRequest } from '@/lib/channels/event-bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    sessionId: string; kind: string;
    chatId?: string; text?: string; request?: ChannelPermissionRequest;
  };
  if (!body.sessionId) return NextResponse.json({ error: 'no sessionId' }, { status: 400 });

  if (body.kind === 'reply') {
    publishChannelEvent(body.sessionId, { kind: 'reply', chatId: body.chatId ?? '', text: body.text ?? '' });
  } else if (body.kind === 'permission_request' && body.request) {
    publishChannelEvent(body.sessionId, { kind: 'permission_request', request: body.request });
  }
  return NextResponse.json({ ok: true });
}
