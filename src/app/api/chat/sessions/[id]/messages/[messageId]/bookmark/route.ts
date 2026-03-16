import { NextRequest, NextResponse } from 'next/server';
import { toggleBookmark } from '@/lib/db';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const { messageId } = await params;
    const body = await request.json();
    const { bookmarked } = body;

    if (typeof bookmarked !== 'boolean') {
      return NextResponse.json(
        { error: 'Missing required field: bookmarked (boolean)' },
        { status: 400 },
      );
    }

    toggleBookmark(messageId, bookmarked);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to toggle bookmark:', error);
    return NextResponse.json({ error: 'Failed to toggle bookmark' }, { status: 500 });
  }
}
