import { NextRequest } from 'next/server';
import { getMessages, getSession } from '@/lib/db';
import type { MessagesResponse } from '@/types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const searchParams = request.nextUrl.searchParams;
    const limitParam = searchParams.get('limit');
    const beforeParam = searchParams.get('before');
    const bookmarkedOnly = searchParams.get('bookmarked') === 'true';

    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500) : 100;
    const beforeRowId = beforeParam ? parseInt(beforeParam, 10) || undefined : undefined;

    const { messages, hasMore } = getMessages(id, { limit, beforeRowId });
    let result: MessagesResponse = { messages, hasMore };

    if (bookmarkedOnly) {
      result = {
        ...result,
        messages: result.messages.filter((m: { bookmarked?: number }) => m.bookmarked === 1),
      };
    }

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch messages';
    return Response.json({ error: message }, { status: 500 });
  }
}
