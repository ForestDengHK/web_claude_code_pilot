import { NextRequest, NextResponse } from 'next/server';
import { createCanvas, listCanvases } from '@/lib/canvas-store';

// GET /api/canvas?sessionId=...   -> list diagrams (optionally scoped to a session)
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId') || undefined;
  return NextResponse.json({ diagrams: listCanvases(sessionId) });
}

// POST /api/canvas  { sessionId?, engine?, title?, scene? }  -> { id, version }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const res = createCanvas({
    sessionId: body.sessionId,
    id: body.id,
    engine: body.engine,
    title: body.title,
    scene: body.scene,
    author: body.author ?? 'user',
  });
  return NextResponse.json(res);
}
