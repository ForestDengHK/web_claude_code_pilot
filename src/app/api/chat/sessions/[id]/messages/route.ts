import { NextRequest } from 'next/server';
import { addMessage, getMessages, getSession } from '@/lib/db';
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

/**
 * Append a single message to a session WITHOUT triggering an LLM turn.
 * Used by client-side display commands (e.g. /img) so their output survives
 * a page refresh instead of living only in local React state.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const role = body?.role;
    const content = body?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) {
      return Response.json(
        { error: 'role must be "user" or "assistant" and content must be a non-empty string' },
        { status: 400 },
      );
    }

    const message = addMessage(id, role, content, null, session.backend ?? null);
    return Response.json({ message });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add message';
    return Response.json({ error: message }, { status: 500 });
  }
}
