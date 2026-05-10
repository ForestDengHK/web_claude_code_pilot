import { NextRequest } from 'next/server';
import { installFromUrl, removeUrlPlugin, listUrlPlugins } from '@/lib/url-plugins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ plugins: listUrlPlugins() });
}

export async function POST(request: NextRequest) {
  let url: string;
  try {
    const body = await request.json();
    url = body?.url;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof url !== 'string' || !url.trim()) {
    return Response.json({ error: 'Missing "url"' }, { status: 400 });
  }

  try {
    const entry = await installFromUrl(url.trim());
    return Response.json({ plugin: entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Install failed';
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  let url: string;
  try {
    const body = await request.json();
    url = body?.url;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof url !== 'string' || !url.trim()) {
    return Response.json({ error: 'Missing "url"' }, { status: 400 });
  }

  const removed = removeUrlPlugin(url.trim());
  return Response.json({ removed });
}
