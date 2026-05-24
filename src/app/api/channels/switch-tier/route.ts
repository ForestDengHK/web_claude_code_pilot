import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/db';
import { applyTierSwitch, discardExhaustedTurn, switchToTier } from '@/lib/channels/switch-tier';
import { killSession } from '@/lib/channels/session-manager';
import type { Tier } from '@/lib/channels/tiers';

export async function POST(req: NextRequest) {
  const { sessionId, targetTier } = await req.json() as {
    sessionId: string;
    targetTier?: Tier;
  };
  const s = getSession(sessionId);
  if (!s) return NextResponse.json({ error: 'no session' }, { status: 404 });
  const current = s.backend as Tier;

  // Manual switch: the user picked a specific tier. Just change the backend —
  // no turn is discarded, nothing is resent.
  if (targetTier) {
    if (targetTier !== current) {
      switchToTier(sessionId, targetTier);
      if (current === 'channels') killSession(sessionId);
    }
    return NextResponse.json({ ok: true, newTier: targetTier });
  }

  // Exhaustion switch: advance to the next tier and discard the failed turn
  // (the client resends it on the new tier).
  const result = applyTierSwitch(sessionId, current);
  discardExhaustedTurn(sessionId);
  if (current === 'channels') killSession(sessionId);
  return NextResponse.json({ ok: true, newTier: result.newTier });
}
