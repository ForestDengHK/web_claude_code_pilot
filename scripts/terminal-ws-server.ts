// scripts/terminal-ws-server.ts
// WebSocket server for terminal sessions.
// Dev:  npm run terminal-ws  (tsx --watch, TERMINAL_WS_PORT=4003)
// Prod: bundled by esbuild; required from codepilot-server.js (TERMINAL_WS_PORT=4002)

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { execFileSync } from 'node:child_process';
// Register providers — must be first
import '../src/lib/terminal/index.js';
import { providerRegistry } from '../src/lib/terminal/registry.js';
import {
  createSession,
  getSession,
  listSessions,
  touchSession,
  deleteSession,
} from '../src/lib/terminal/session-store.js';
import { LOCAL_PROVIDER_ID } from '../src/lib/terminal/providers/local.js';
import { nanoid } from 'nanoid';
import type { PtyHandle, ClientMessage, ServerMessage } from '../src/lib/terminal/provider.js';

interface Connection {
  ws: WebSocket;
  ptyHandle: PtyHandle;
  sessionId: string;
}

const connections = new Map<WebSocket, Connection>();

/** Remove DB records for tmux sessions that no longer exist. */
function reconcileSessions(): void {
  let liveSessions: string[] = [];
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    liveSessions = out.trim().split('\n').filter(Boolean);
  } catch {
    // No active tmux sessions or tmux not installed — all DB records are stale
  }
  for (const session of listSessions()) {
    if (!liveSessions.includes(session.tmuxName)) {
      deleteSession(session.id);
      console.log(`[terminal-ws] Reconciled stale session: ${session.id}`);
    }
  }
}

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  // URL: /terminal/<sessionId>?hostId=local&cols=220&rows=50
  //   OR /terminal/new?hostId=local&cols=220&rows=50  (create new session)
  const urlStr = `ws://localhost${req.url ?? '/'}`;
  const url = new URL(urlStr);
  const pathParts = url.pathname.split('/').filter(Boolean);
  const sessionIdParam = pathParts[1] ?? 'new';
  const hostId = url.searchParams.get('hostId') ?? LOCAL_PROVIDER_ID;
  const cols = Math.max(1, parseInt(url.searchParams.get('cols') ?? '80', 10));
  const rows = Math.max(1, parseInt(url.searchParams.get('rows') ?? '24', 10));

  const provider = providerRegistry.get(hostId);
  if (!provider) {
    sendJson(ws, { type: 'error', message: `Unknown host: ${hostId}` });
    ws.close();
    return;
  }

  // Resolve sessionId: reuse existing or mint a new one.
  // sessionId == the DB `id` field so getSession(sessionId) works on reconnect.
  // The tmux session name is `codepilot-<tmux-suffix>` (separate nanoid).
  let sessionId: string;
  if (sessionIdParam !== 'new' && getSession(sessionIdParam)) {
    sessionId = sessionIdParam;
  } else {
    const session = createSession(hostId, `codepilot-${nanoid(10)}`, 'Terminal');
    sessionId = session.id;
  }

  // Pass the tmux session name (from DB) to the provider, not the DB id.
  // LocalProvider uses this as the tmux -s name directly.
  const sessionRecord = getSession(sessionId)!;

  let ptyHandle: PtyHandle;
  try {
    ptyHandle = await provider.connect(sessionRecord.tmuxName, { cols, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ws, { type: 'error', message });
    if (sessionIdParam === 'new') deleteSession(sessionId);
    ws.close();
    return;
  }

  connections.set(ws, { ws, ptyHandle, sessionId });

  // PTY stdout → WS binary frame
  const unsubData = ptyHandle.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(Buffer.from(data, 'binary'));
    }
  });

  const unsubExit = ptyHandle.onExit(() => {
    sendJson(ws, { type: 'error', message: 'Process exited' });
  });

  sendJson(ws, { type: 'ready', sessionId });

  ws.on('message', (raw) => {
    if (!Buffer.isBuffer(raw) && typeof raw !== 'string') return;
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()) as ClientMessage; }
    catch { return; }

    switch (msg.type) {
      case 'input':   ptyHandle.write(msg.data); break;
      case 'resize':  ptyHandle.resize(msg.cols, msg.rows); break;
      case 'ping':    sendJson(ws, { type: 'pong' }); break;
      case 'kill':
        unsubData();
        unsubExit();
        ptyHandle.kill();
        deleteSession(sessionId);
        sendJson(ws, { type: 'killed' });
        ws.close();
        break;
    }
  });

  ws.on('close', () => {
    connections.delete(ws);
    unsubData();
    unsubExit();
    ptyHandle.disconnect();
    touchSession(sessionId);
  });
}

export function startTerminalWS(port: number): void {
  reconcileSessions();

  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws, req) => {
    if (!req.url?.startsWith('/terminal')) {
      ws.close();
      return;
    }
    handleConnection(ws, req).catch((err) => {
      console.error('[terminal-ws] Connection error:', err);
      ws.close();
    });
  });

  wss.on('listening', () =>
    console.log(`[terminal-ws] Listening on port ${port}`)
  );

  wss.on('error', (err) =>
    console.error('[terminal-ws] Server error:', err)
  );
}

// Allow direct execution
const isMain = process.argv[1]?.includes('terminal-ws-server');
if (isMain) {
  startTerminalWS(parseInt(process.env.TERMINAL_WS_PORT ?? '4003', 10));
}
