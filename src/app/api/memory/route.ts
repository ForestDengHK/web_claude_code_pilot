import { NextRequest } from 'next/server';
import { getMemories, createMemory } from '@/lib/db';
import type { CreateMemoryRequest, MemoriesResponse, MemoryResponse } from '@/types';

/**
 * GET /api/memory — List memories, optionally filtered by scope/type/project.
 *
 * Query params:
 *   scope     — 'user' | 'project'
 *   scope_key — working directory (for project-scoped memories)
 *   type      — 'memory' | 'skill'
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope') as 'user' | 'project' | null;
    const scopeKey = searchParams.get('scope_key') ?? undefined;
    const type = searchParams.get('type') as 'memory' | 'skill' | null;

    const memories = getMemories(
      scope ?? undefined,
      scopeKey,
      type ?? undefined,
    );

    const response: MemoriesResponse = { memories };
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch memories';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/memory — Create a new memory or skill entry.
 */
export async function POST(request: NextRequest) {
  try {
    const body: CreateMemoryRequest = await request.json();

    if (!body.scope || !body.content?.trim()) {
      return Response.json(
        { error: 'scope and content are required' },
        { status: 400 },
      );
    }

    if (body.scope === 'project' && !body.scope_key) {
      return Response.json(
        { error: 'scope_key (working directory) is required for project-scoped memories' },
        { status: 400 },
      );
    }

    const memory = createMemory(
      body.scope,
      body.type || 'memory',
      body.content.trim(),
      {
        scopeKey: body.scope_key,
        description: body.description?.trim(),
        sourceSessionId: body.source_session_id,
        pinned: body.pinned,
      },
    );

    const response: MemoryResponse = { memory };
    return Response.json(response, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create memory';
    return Response.json({ error: message }, { status: 500 });
  }
}
