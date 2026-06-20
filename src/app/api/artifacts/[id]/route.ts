import { NextRequest, NextResponse } from 'next/server';
import { getArtifact, getArtifactHtml, listVersions } from '@/lib/artifacts';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/artifacts/<id>            -> the current (or ?version=N) artifact HTML as text/plain
// GET /api/artifacts/<id>?meta=1     -> { meta, versions } for the version picker
//
// HTML is returned as text/plain so it can never execute same-origin if opened
// directly; the client renders it inside a sandboxed iframe via srcDoc.
export async function GET(req: NextRequest, context: RouteContext) {
  const { id } = await context.params;

  if (req.nextUrl.searchParams.get('meta') === '1') {
    const meta = getArtifact(id);
    if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ meta, versions: listVersions(id) });
  }

  const versionParam = req.nextUrl.searchParams.get('version');
  const version = versionParam ? parseInt(versionParam, 10) : undefined;
  const html = getArtifactHtml(id, version);
  if (html == null) return new NextResponse('not found', { status: 404 });
  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
