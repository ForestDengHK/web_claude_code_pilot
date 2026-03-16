import { NextResponse } from 'next/server';
import { getAllPushSubscriptions } from '@/lib/db';

export async function GET() {
  try {
    const subs = getAllPushSubscriptions();
    return NextResponse.json({
      subscriptions: subs.map((s) => ({
        endpoint: s.endpoint,
        userAgent: s.user_agent,
        createdAt: s.created_at,
      })),
    });
  } catch (error) {
    console.error('Failed to list push subscriptions:', error);
    return NextResponse.json({ error: 'Failed to list subscriptions' }, { status: 500 });
  }
}
