import { NextRequest, NextResponse } from 'next/server';
import { getScene, saveScene } from '@/lib/canvas-store';

interface RouteContext { params: Promise<{ id: string }>; }

// GET /api/canvas/<id>  -> full scene { id, engine, version, title, elements }
export async function GET(_req: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    return NextResponse.json(getScene(id));
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}

// PUT /api/canvas/<id>  { elements }  -> { id, version }  (user-draw save path)
export async function PUT(req: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body.elements)) {
    return NextResponse.json({ error: 'elements[] required' }, { status: 400 });
  }
  try {
    return NextResponse.json(saveScene(id, body.elements, body.author ?? 'user'));
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
  }
}
