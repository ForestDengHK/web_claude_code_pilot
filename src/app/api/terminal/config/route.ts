import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Allow a full WS URL override (e.g. when Caddy proxies the WS port at a custom path or hostname).
  // Set TERMINAL_WS_URL=wss://ccpilot.swifttools.eu/terminal-ws for HTTPS reverse-proxy setups.
  if (process.env.TERMINAL_WS_URL) {
    return NextResponse.json({ wsUrl: process.env.TERMINAL_WS_URL });
  }

  const wsPort = process.env.TERMINAL_WS_PORT ?? '4002';

  // Derive hostname from the request so this works for Tailscale, localhost, etc.
  const requestHost = request.headers.get('host') ?? 'localhost';
  const hostname = requestHost.split(':')[0];

  // Use wss:// if request came over HTTPS (set by reverse proxy, e.g. Caddy).
  // NOTE: wss://<hostname>:<port> requires Caddy to also proxy port <wsPort>.
  // If that's not configured, set TERMINAL_WS_URL to a working wss URL instead.
  const proto = request.headers.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';

  return NextResponse.json({ wsUrl: `${proto}://${hostname}:${wsPort}` });
}
