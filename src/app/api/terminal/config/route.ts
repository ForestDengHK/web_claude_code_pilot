import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Allow a full WS URL override (e.g. for non-default reverse-proxy paths or hostnames).
  if (process.env.TERMINAL_WS_URL) {
    return NextResponse.json({ wsUrl: process.env.TERMINAL_WS_URL });
  }

  // Derive hostname from the request so this works for Tailscale, localhost, etc.
  const requestHost = request.headers.get('host') ?? 'localhost';
  const hostname = requestHost.split(':')[0];
  const isHttps = request.headers.get('x-forwarded-proto') === 'https';

  // HTTPS: route through the reverse proxy via a fixed path. The proxy must
  // strip the prefix and forward to the WS port (terminal-ws-server.ts checks
  // that req.url starts with `/terminal`).
  //   Caddy example:  handle_path /terminal-ws/* { reverse_proxy localhost:4002 }
  if (isHttps) {
    return NextResponse.json({ wsUrl: `wss://${hostname}/terminal-ws` });
  }

  // Plain HTTP (LAN / Tailscale direct): connect straight to the WS port.
  const wsPort = process.env.TERMINAL_WS_PORT ?? '4002';
  return NextResponse.json({ wsUrl: `ws://${hostname}:${wsPort}` });
}
