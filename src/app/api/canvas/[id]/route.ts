import { NextRequest, NextResponse } from 'next/server';
import { getScene, saveScene, saveSource } from '@/lib/canvas-store';

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

// PUT /api/canvas/<id>  { elements } | { source }  -> { id, version }  (user-edit save path)
//   elements[] -> excalidraw scene replace; source (string) -> drawio/mermaid text.
export async function PUT(req: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  try {
    if (typeof body.source === 'string') {
      return NextResponse.json(saveSource(id, body.source, body.author ?? 'user'));
    }
    if (Array.isArray(body.elements)) {
      return NextResponse.json(saveScene(id, body.elements, body.author ?? 'user'));
    }
    return NextResponse.json({ error: 'elements[] or source required' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
  }
}
