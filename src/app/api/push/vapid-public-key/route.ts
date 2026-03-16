import { NextResponse } from 'next/server';
import { getVapidKeys } from '@/lib/push-notifications';

export async function GET() {
  try {
    const keys = getVapidKeys();
    return NextResponse.json({ publicKey: keys.publicKey });
  } catch (error) {
    console.error('Failed to get VAPID keys:', error);
    return NextResponse.json({ error: 'Failed to get VAPID public key' }, { status: 500 });
  }
}
