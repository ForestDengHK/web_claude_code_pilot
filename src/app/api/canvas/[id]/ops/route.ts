import { NextRequest, NextResponse } from 'next/server';
import { applyCanvasOps } from '@/lib/canvas-store';

interface RouteContext { params: Promise<{ id: string }>; }

// POST /api/canvas/<id>/ops  { ops:{add,update,delete}, author?, messageId? }
// In-process incremental write path (also what an in-app tool bridge would call).
export async function POST(req: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(applyCanvasOps(id, body.ops ?? {}, body.author ?? 'claude', body.messageId));
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
  }
}
