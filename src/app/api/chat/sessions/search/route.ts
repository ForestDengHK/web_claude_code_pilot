import { NextRequest } from 'next/server';
import { searchMessages } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams.get('q');
    const limitParam = request.nextUrl.searchParams.get('limit');

    if (!q || !q.trim()) {
      return Response.json({ results: [], total: 0 });
    }

    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 100) : 50;
    const result = searchMessages(q.trim(), limit);

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Search failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
