import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/db';
import { applyTierSwitch } from '@/lib/channels/switch-tier';
import { killSession } from '@/lib/channels/session-manager';
import type { Tier } from '@/lib/channels/tiers';

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json() as { sessionId: string };
  const s = getSession(sessionId);
  if (!s) return NextResponse.json({ error: 'no session' }, { status: 404 });
  const current = s.backend as Tier;
  const result = applyTierSwitch(sessionId, current);
  if (current === 'channels') killSession(sessionId);
  return NextResponse.json({ ok: true, newTier: result.newTier });
}
