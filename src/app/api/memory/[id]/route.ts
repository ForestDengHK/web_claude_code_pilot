import { NextRequest } from 'next/server';
import { getMemory, updateMemory, deleteMemory } from '@/lib/db';
import type { UpdateMemoryRequest, MemoryResponse } from '@/types';

/**
 * GET /api/memory/:id — Get a single memory entry.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const memory = getMemory(id);
    if (!memory) {
      return Response.json({ error: 'Memory not found' }, { status: 404 });
    }
    const response: MemoryResponse = { memory };
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch memory';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/memory/:id — Update a memory entry.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body: UpdateMemoryRequest = await request.json();

    const updated = updateMemory(id, {
      content: body.content?.trim(),
      description: body.description?.trim(),
      pinned: body.pinned,
      type: body.type,
    });

    if (!updated) {
      return Response.json({ error: 'Memory not found' }, { status: 404 });
    }

    const response: MemoryResponse = { memory: updated };
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update memory';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/memory/:id — Delete a memory entry.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const deleted = deleteMemory(id);
    if (!deleted) {
      return Response.json({ error: 'Memory not found' }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete memory';
    return Response.json({ error: message }, { status: 500 });
  }
}
