import { NextRequest, NextResponse } from 'next/server';
import type { ChannelType } from '@/lib/bridge/types';

// GET /api/bridge/channels — list channel bindings
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const channelType = searchParams.get('channelType') || undefined;

    const { listChannelBindings } = await import('@/lib/bridge/bridge-db');
    const bindings = listChannelBindings(channelType as ChannelType | undefined);
    return NextResponse.json({ bindings });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list channel bindings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
