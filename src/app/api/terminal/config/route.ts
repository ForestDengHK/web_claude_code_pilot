import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const wsPort = process.env.TERMINAL_WS_PORT ?? '4002';

  // Derive hostname from the request so this works for Tailscale, localhost, HTTPS, etc.
  const requestHost = request.headers.get('host') ?? 'localhost';
  const hostname = requestHost.split(':')[0];

  // Use wss:// if request came over HTTPS (set by reverse proxy, e.g. Caddy)
  const proto = request.headers.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';

  return NextResponse.json({ wsUrl: `${proto}://${hostname}:${wsPort}` });
}
