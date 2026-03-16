import { NextRequest, NextResponse } from 'next/server';
import { upsertPushSubscription, deletePushSubscription } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { endpoint, keys, userAgent } = body;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return NextResponse.json(
        { error: 'Missing required fields: endpoint, keys.p256dh, keys.auth' },
        { status: 400 },
      );
    }

    upsertPushSubscription(endpoint, keys.p256dh, keys.auth, userAgent);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to save push subscription:', error);
    return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { endpoint } = body;

    if (!endpoint) {
      return NextResponse.json({ error: 'Missing required field: endpoint' }, { status: 400 });
    }

    deletePushSubscription(endpoint);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete push subscription:', error);
    return NextResponse.json({ error: 'Failed to delete subscription' }, { status: 500 });
  }
}
