# Web Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, interactive terminal to CodePilot — xterm.js frontend, node-pty + tmux backend, WebSocket transport, with an OCP-based multi-host provider abstraction.

**Architecture:** xterm.js in the browser connects via WebSocket to a TypeScript WS server that spawns PTY sessions via node-pty wrapped in named tmux windows. Closing the browser tab leaves the tmux session alive; reconnecting reattaches. A `TerminalProvider` interface and `ProviderRegistry` allow future SSH/WSL hosts to be added without touching existing code.

**Tech Stack:** TypeScript, node-pty, tmux (already installed at `/opt/homebrew/bin/tmux`), ws, @xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links, better-sqlite3 (existing), tsx (existing devDep), esbuild (new devDep)

**Spec:** `docs/superpowers/specs/2026-04-08-web-terminal-design.md`

**Security note:** All child process calls in this plan use `execFileSync` (not `execSync`/`exec`) so that tmux session names (nanoid strings) are passed as array arguments, not interpolated into a shell string.

---

## File Map

### Create
| File | Responsibility |
|------|----------------|
| `src/lib/terminal/provider.ts` | `TerminalProvider`, `PtyHandle`, `ConnectOptions`, protocol message types |
| `src/lib/terminal/registry.ts` | `ProviderRegistry` class + singleton export |
| `src/lib/terminal/index.ts` | Startup registration: creates LocalProvider, registers with singleton |
| `src/lib/terminal/constants.ts` | Shared constants (`LOCAL_PROVIDER_ID`) — no native imports, safe to import in client components |
| `src/lib/terminal/providers/local.ts` | `LocalProvider` — node-pty + tmux |
| `src/lib/terminal/session-store.ts` | SQLite CRUD for `terminal_sessions` table |
| `scripts/terminal-ws-server.ts` | WebSocket server — lifecycle, routing, protocol |
| `src/app/api/terminal/config/route.ts` | Returns `{ wsUrl }` to frontend |
| `src/app/terminal/page.tsx` | Next.js route entry (client page) |
| `src/components/terminal/TerminalWorkspace.tsx` | Top-level client component; manages pane list + layout + wsUrl fetch |
| `src/components/terminal/TerminalToolbar.tsx` | New-pane button, layout selector (1/2/4) |
| `src/components/terminal/TerminalGrid.tsx` | CSS grid layout + focus/maximize mode |
| `src/components/terminal/TerminalPane.tsx` | xterm.js instance + WebSocket connection per pane |
| `src/components/terminal/TerminalPaneHeader.tsx` | Per-pane header: title, rename, close, maximize |
| `src/__tests__/unit/terminal-registry.test.ts` | Unit tests for ProviderRegistry |
| `src/__tests__/unit/terminal-session-store.test.ts` | Unit tests for session store |

### Modify
| File | Change |
|------|--------|
| `src/lib/db.ts` | Add `terminal_sessions` table in `initDb` + `migrateDb` |
| `next.config.mjs` | Add `node-pty`, `ws` to `serverExternalPackages` |
| `package.json` | Add prod/dev deps + `terminal-ws` / `dev:all` scripts |
| `src/components/layout/NavRail.tsx` | Add Terminal nav item |
| `src/components/layout/BottomNav.tsx` | Add Terminal nav item |
| `codepilot-server.js` | Start WS server (`terminal-ws-server.js`) before `server.js` |
| `scripts/prepare-server.mjs` | Bundle WS server with esbuild; copy to standalone; symlink native deps |
| `scripts/rebuild-production.sh` | Change `npx next build` → `npm run build` so prepare-server.mjs runs |

---

## Task 1: Install dependencies and update config

**Files:**
- Modify: `package.json`
- Modify: `next.config.mjs`

- [ ] **Step 1: Install production dependencies**

```bash
cd /Users/party/working/CodePilot
npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links node-pty ws
```

- [ ] **Step 2: Install dev dependencies**

```bash
npm install --save-dev @types/ws concurrently esbuild
```

`node-pty` ships its own TypeScript types. `@types/ws` is needed for `ws`.

- [ ] **Step 3: Add scripts to package.json**

In `package.json`, add to the `"scripts"` object:

```json
"terminal-ws": "TERMINAL_WS_PORT=4003 tsx --watch scripts/terminal-ws-server.ts",
"dev:all": "concurrently \"npm run dev\" \"npm run terminal-ws\""
```

- [ ] **Step 4: Add node-pty and ws to serverExternalPackages in next.config.mjs**

Change:
```js
serverExternalPackages: ['better-sqlite3', 'playwright'],
```
to:
```js
serverExternalPackages: ['better-sqlite3', 'playwright', 'node-pty', 'ws'],
```

- [ ] **Step 5: Verify the dev server still starts**

```bash
npm run dev
```
Expected: Next.js starts on port 4000, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json next.config.mjs
git commit -m "feat: install terminal deps (xterm.js, node-pty, ws, esbuild)"
```

---

## Task 2: Provider interfaces

**Files:**
- Create: `src/lib/terminal/provider.ts`

- [ ] **Step 1: Create the interfaces file**

```typescript
// src/lib/terminal/provider.ts
// Core interfaces for the terminal provider system.
// Adding a new host type (SSH, WSL, etc.) = new class implementing TerminalProvider.
// No changes to this file or its consumers required.

export interface ConnectOptions {
  cols: number;
  rows: number;
}

export interface PtyHandle {
  /** Send keystrokes/data to the PTY stdin. */
  write(data: string): void;
  /** Inform the PTY of a terminal resize. */
  resize(cols: number, rows: number): void;
  /** Register a callback for PTY stdout data. */
  onData(cb: (data: string) => void): void;
  /** Register a callback for PTY process exit. */
  onExit(cb: (code: number) => void): void;
  /**
   * Disconnect from the PTY without destroying the tmux session.
   * The underlying tmux session stays alive in the background.
   */
  disconnect(): void;
  /**
   * Kill the tmux session and the underlying process.
   * Called when the user explicitly closes a terminal pane.
   */
  kill(): void;
}

export interface TerminalProvider {
  /** Unique stable identifier, e.g. 'local', 'ssh-myserver'. */
  readonly id: string;
  /** Human-readable name shown in the host selector UI. */
  readonly displayName: string;
  /** Provider category, for future serialisation, e.g. 'local', 'ssh'. */
  readonly type: string;
  /**
   * Attach to (or create) a tmux session for the given sessionId.
   * Throws if the connection cannot be established.
   */
  connect(sessionId: string, opts: ConnectOptions): Promise<PtyHandle>;
}

// ---------------------------------------------------------------------------
// WebSocket message protocol — shared between server and browser.
// Keep in sync with scripts/terminal-ws-server.ts.
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'ready'; sessionId: string }
  | { type: 'killed' }
  | { type: 'error'; message: string }
  | { type: 'pong' };
```

- [ ] **Step 2: Verify TypeScript parses it**

```bash
npx tsc --noEmit src/lib/terminal/provider.ts 2>&1 | head -10
```
Expected: no errors (module-not-found warnings from bare imports are OK; there are no imports here).

- [ ] **Step 3: Commit**

```bash
git add src/lib/terminal/provider.ts
git commit -m "feat: add TerminalProvider interfaces and WS message protocol types"
```

---

## Task 3: ProviderRegistry

**Files:**
- Create: `src/lib/terminal/registry.ts`
- Create: `src/__tests__/unit/terminal-registry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/unit/terminal-registry.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalProvider, ConnectOptions } from '../../lib/terminal/provider.js';

function makeStub(id: string): TerminalProvider {
  return {
    id,
    displayName: `Stub(${id})`,
    type: 'stub',
    connect: async (_sid: string, _opts: ConnectOptions) => { throw new Error('stub'); },
  };
}

describe('ProviderRegistry', async () => {
  // Fresh class instance per test — avoids singleton state bleed
  const { ProviderRegistry } = await import('../../lib/terminal/registry.js');

  it('starts empty', () => {
    const reg = new ProviderRegistry();
    assert.deepEqual(reg.list(), []);
  });

  it('registers and retrieves a provider', () => {
    const reg = new ProviderRegistry();
    const p = makeStub('local');
    reg.register(p);
    assert.strictEqual(reg.get('local'), p);
  });

  it('lists all registered providers', () => {
    const reg = new ProviderRegistry();
    reg.register(makeStub('local'));
    reg.register(makeStub('ssh-x'));
    assert.equal(reg.list().length, 2);
  });

  it('returns undefined for unknown id', () => {
    const reg = new ProviderRegistry();
    assert.strictEqual(reg.get('ghost'), undefined);
  });

  it('throws when registering duplicate id', () => {
    const reg = new ProviderRegistry();
    reg.register(makeStub('local'));
    assert.throws(() => reg.register(makeStub('local')), /already registered/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

```bash
npx tsx --test src/__tests__/unit/terminal-registry.test.ts
```
Expected: `Error: Cannot find module '../../lib/terminal/registry.js'`

- [ ] **Step 3: Implement ProviderRegistry**

```typescript
// src/lib/terminal/registry.ts
import type { TerminalProvider } from './provider.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, TerminalProvider>();

  register(provider: TerminalProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider '${provider.id}' already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): TerminalProvider | undefined {
    return this.providers.get(id);
  }

  list(): TerminalProvider[] {
    return Array.from(this.providers.values());
  }
}

/** Singleton registry — used by the WS server and the /api/terminal/config route. */
export const providerRegistry = new ProviderRegistry();
```

- [ ] **Step 4: Run — expect PASS**

```bash
npx tsx --test src/__tests__/unit/terminal-registry.test.ts
```
Expected: `5 passing`

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminal/registry.ts src/__tests__/unit/terminal-registry.test.ts
git commit -m "feat: add ProviderRegistry with unit tests"
```

---

## Task 4: Session store (SQLite)

**Files:**
- Modify: `src/lib/db.ts`
- Create: `src/lib/terminal/session-store.ts`
- Create: `src/__tests__/unit/terminal-session-store.test.ts`

- [ ] **Step 1: Add terminal_sessions table to db.ts**

In `src/lib/db.ts`, find `initDb` (the function that runs `CREATE TABLE IF NOT EXISTS` for all tables). Append the terminal_sessions table to the same `db.exec(...)` block:

```sql
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id          TEXT PRIMARY KEY,
  host_id     TEXT NOT NULL DEFAULT 'local',
  tmux_name   TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
```

Also add to `migrateDb` (at the very end, after all existing migrations):

```typescript
// Add terminal_sessions table for databases created before this feature
db.exec(`
  CREATE TABLE IF NOT EXISTS terminal_sessions (
    id          TEXT PRIMARY KEY,
    host_id     TEXT NOT NULL DEFAULT 'local',
    tmux_name   TEXT NOT NULL,
    title       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  )
`);
```

- [ ] **Step 2: Write failing tests**

```typescript
// src/__tests__/unit/terminal-session-store.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-test-'));
  // Override DB location so tests never touch ~/.codepilot/codepilot.db
  process.env.CLAUDE_GUI_DATA_DIR = tmpDir;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CLAUDE_GUI_DATA_DIR;
});

describe('TerminalSessionStore', async () => {
  const store = await import('../../lib/terminal/session-store.js');

  it('creates and retrieves a session', () => {
    const s = store.createSession('local', 'codepilot-abc123', 'Test shell');
    assert.ok(s.id);
    assert.equal(s.hostId, 'local');
    assert.equal(s.tmuxName, 'codepilot-abc123');
    assert.equal(s.title, 'Test shell');

    const fetched = store.getSession(s.id);
    assert.ok(fetched);
    assert.equal(fetched!.id, s.id);
  });

  it('lists all sessions', () => {
    store.createSession('local', 'codepilot-aaa', 'Shell A');
    store.createSession('local', 'codepilot-bbb', 'Shell B');
    const list = store.listSessions();
    assert.ok(list.length >= 2);
  });

  it('updates last_seen via touchSession', async () => {
    const s = store.createSession('local', 'codepilot-touch', 'Touch test');
    const before = s.lastSeen;
    await new Promise(r => setTimeout(r, 15));
    store.touchSession(s.id);
    const updated = store.getSession(s.id);
    assert.ok(updated!.lastSeen > before);
  });

  it('deletes a session', () => {
    const s = store.createSession('local', 'codepilot-del', 'Delete me');
    store.deleteSession(s.id);
    assert.strictEqual(store.getSession(s.id), undefined);
  });
});
```

- [ ] **Step 3: Run — expect FAIL (module not found)**

```bash
npx tsx --test src/__tests__/unit/terminal-session-store.test.ts
```
Expected: `Error: Cannot find module '../../lib/terminal/session-store.js'`

- [ ] **Step 4: Implement session store**

```typescript
// src/lib/terminal/session-store.ts
import { getDb } from '../db.js';
import { nanoid } from 'nanoid';

export interface TerminalSession {
  id: string;
  hostId: string;
  tmuxName: string;
  title: string;
  createdAt: number;
  lastSeen: number;
}

type Row = {
  id: string;
  host_id: string;
  tmux_name: string;
  title: string;
  created_at: number;
  last_seen: number;
};

function toSession(row: Row): TerminalSession {
  return {
    id: row.id,
    hostId: row.host_id,
    tmuxName: row.tmux_name,
    title: row.title,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

export function createSession(hostId: string, tmuxName: string, title: string): TerminalSession {
  const db = getDb();
  const id = nanoid(10);
  const now = Date.now();
  db.prepare(
    `INSERT INTO terminal_sessions (id, host_id, tmux_name, title, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, hostId, tmuxName, title, now, now);
  return { id, hostId, tmuxName, title, createdAt: now, lastSeen: now };
}

export function getSession(id: string): TerminalSession | undefined {
  const row = getDb()
    .prepare('SELECT * FROM terminal_sessions WHERE id = ?')
    .get(id) as Row | undefined;
  return row ? toSession(row) : undefined;
}

export function listSessions(): TerminalSession[] {
  const rows = getDb()
    .prepare('SELECT * FROM terminal_sessions ORDER BY last_seen DESC')
    .all() as Row[];
  return rows.map(toSession);
}

export function touchSession(id: string): void {
  getDb()
    .prepare('UPDATE terminal_sessions SET last_seen = ? WHERE id = ?')
    .run(Date.now(), id);
}

export function deleteSession(id: string): void {
  getDb()
    .prepare('DELETE FROM terminal_sessions WHERE id = ?')
    .run(id);
}
```

- [ ] **Step 5: Run — expect PASS**

```bash
npx tsx --test src/__tests__/unit/terminal-session-store.test.ts
```
Expected: `4 passing`

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts src/lib/terminal/session-store.ts src/__tests__/unit/terminal-session-store.test.ts
git commit -m "feat: add terminal_sessions DB table and session store with tests"
```

---

## Task 5: LocalProvider

**Files:**
- Create: `src/lib/terminal/providers/local.ts`
- Create: `src/lib/terminal/index.ts`

- [ ] **Step 1: Implement LocalProvider**

Uses `execFileSync` (not `execSync`) so tmux session names are passed as array arguments — no shell injection risk.

```typescript
// src/lib/terminal/providers/local.ts
import * as pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import type { TerminalProvider, PtyHandle, ConnectOptions } from '../provider.js';

/** Must match the DB schema DEFAULT for terminal_sessions.host_id. */
export const LOCAL_PROVIDER_ID = 'local';

export class LocalProvider implements TerminalProvider {
  readonly id = LOCAL_PROVIDER_ID;
  readonly displayName = 'Local (this machine)';
  readonly type = 'local';

  async connect(sessionId: string, opts: ConnectOptions): Promise<PtyHandle> {
    // Validate tmux is available before spawning
    try {
      execFileSync('which', ['tmux'], { stdio: 'ignore' });
    } catch {
      throw new Error('tmux not found on PATH. Install tmux to use the terminal feature.');
    }

    const tmuxSession = `codepilot-${sessionId}`;

    // tmux new-session -A: attach if the session already exists, create if not.
    // This single command handles both first-connect and reconnect.
    const ptyProcess = pty.spawn('tmux', [
      'new-session', '-A',
      '-s', tmuxSession,
      '-x', String(opts.cols),
      '-y', String(opts.rows),
    ], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: process.env.HOME ?? '/',
      env: process.env as Record<string, string>,
    });

    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(code: number) => void> = [];

    ptyProcess.onData((data) => { for (const cb of dataListeners) cb(data); });
    ptyProcess.onExit(({ exitCode }) => { for (const cb of exitListeners) cb(exitCode ?? 0); });

    const handle: PtyHandle = {
      write(data) { ptyProcess.write(data); },
      resize(cols, rows) { ptyProcess.resize(cols, rows); },
      onData(cb) { dataListeners.push(cb); },
      onExit(cb) { exitListeners.push(cb); },

      disconnect() {
        // Close node-pty cleanly. tmux session stays alive in the background
        // because tmux does not destroy sessions on client disconnect by default.
        try { ptyProcess.kill(); } catch { /* already exited */ }
      },

      kill() {
        // Destroy the tmux session first, then clean up node-pty.
        // execFileSync avoids shell injection: tmuxSession is a nanoid string.
        try {
          execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' });
        } catch { /* session may already be gone */ }
        try { ptyProcess.kill(); } catch { /* already exited */ }
      },
    };

    return handle;
  }
}
```

- [ ] **Step 2: Create the constants file**

```typescript
// src/lib/terminal/constants.ts
// Shared string constants with NO native module imports.
// Safe to import in client-side React components (avoids Turbopack bundling node-pty).

/** Stable ID for the local machine provider. Must match DB schema DEFAULT for host_id. */
export const LOCAL_PROVIDER_ID = 'local';
```

- [ ] **Step 3: Update local.ts to import from constants**

In `src/lib/terminal/providers/local.ts`, replace:
```typescript
export const LOCAL_PROVIDER_ID = 'local';
```
with:
```typescript
export { LOCAL_PROVIDER_ID } from '../constants.js';
```
(Re-export so existing imports of `LOCAL_PROVIDER_ID` from `local.ts` still work.)

- [ ] **Step 4: Create the registry index (startup registration)**

```typescript
// src/lib/terminal/index.ts
// Import this once at WS server startup to register all providers.

import { providerRegistry } from './registry.js';
import { LocalProvider } from './providers/local.js';

providerRegistry.register(new LocalProvider());

export { providerRegistry };
```

- [ ] **Step 3: node-pty smoke test (manual)**

```bash
node -e "
const pty = require('node-pty');
const p = pty.spawn('echo', ['hello from pty'], { name: 'xterm', cols: 80, rows: 24 });
p.onData(d => process.stdout.write(d));
p.onExit(() => { console.log('exit ok'); process.exit(0); });
"
```
Expected: prints `hello from pty` and `exit ok`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/terminal/providers/local.ts src/lib/terminal/index.ts
git commit -m "feat: add LocalProvider (node-pty + tmux) and provider registration"
```

---

## Task 6: WebSocket server

**Files:**
- Create: `scripts/terminal-ws-server.ts`

- [ ] **Step 1: Implement the WS server**

```typescript
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
  // pathParts[0] === 'terminal', pathParts[1] === sessionId | 'new'
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

  // Resolve sessionId: reuse existing or mint a new one
  let sessionId: string;
  if (sessionIdParam !== 'new' && getSession(sessionIdParam)) {
    sessionId = sessionIdParam;
  } else {
    sessionId = nanoid(10);
    createSession(hostId, `codepilot-${sessionId}`, 'Terminal');
  }

  let ptyHandle: PtyHandle;
  try {
    ptyHandle = await provider.connect(sessionId, { cols, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ws, { type: 'error', message });
    // If we just created a DB record, clean it up
    if (sessionIdParam === 'new') deleteSession(sessionId);
    ws.close();
    return;
  }

  connections.set(ws, { ws, ptyHandle, sessionId });

  // PTY stdout → WS binary frame (xterm.js reads raw bytes directly)
  ptyHandle.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(Buffer.from(data, 'binary'));
    }
  });

  ptyHandle.onExit(() => {
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
        ptyHandle.kill();
        deleteSession(sessionId);
        sendJson(ws, { type: 'killed' });
        ws.close();
        break;
    }
  });

  ws.on('close', () => {
    connections.delete(ws);
    ptyHandle.disconnect();
    touchSession(sessionId);
  });
}

export function startTerminalWS(port: number): void {
  reconcileSessions();

  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws, req) => {
    // Only accept paths starting with /terminal
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

// Allow direct execution: `tsx scripts/terminal-ws-server.ts`
const isMain = process.argv[1]?.includes('terminal-ws-server');
if (isMain) {
  startTerminalWS(parseInt(process.env.TERMINAL_WS_PORT ?? '4003', 10));
}
```

- [ ] **Step 2: Start WS server and verify**

In a new terminal (keep it running):
```bash
npm run terminal-ws
```
Expected: `[terminal-ws] Listening on port 4003`

- [ ] **Step 3: Connection smoke test**

In another terminal:
```bash
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:4003/terminal/new?hostId=local&cols=80&rows=24');
ws.on('message', d => {
  const m = JSON.parse(d.toString());
  console.log('server msg:', m.type, m.sessionId ?? '');
  if (m.type === 'ready') { ws.close(); }
});
ws.on('error', e => console.error('err:', e.message));
ws.on('close', () => process.exit(0));
"
```
Expected: `server msg: ready <sessionId>` then exits.

- [ ] **Step 4: Verify tmux session was created**

```bash
tmux list-sessions | grep codepilot
```
Expected: at least one `codepilot-<id>` session listed.

- [ ] **Step 5: Commit**

```bash
git add scripts/terminal-ws-server.ts
git commit -m "feat: add terminal WebSocket server"
```

---

## Task 7: API config route

**Files:**
- Create: `src/app/api/terminal/config/route.ts`

- [ ] **Step 1: Implement the config route**

```typescript
// src/app/api/terminal/config/route.ts
// Returns the WebSocket URL for the terminal WS server.
// The frontend fetches this once on mount instead of hardcoding hostname/port.

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
```

- [ ] **Step 2: Test the route**

With `npm run dev` running:
```bash
curl http://localhost:4000/api/terminal/config
```
Expected: `{"wsUrl":"ws://localhost:4003"}` (if `TERMINAL_WS_PORT=4003` is set) or `{"wsUrl":"ws://localhost:4002"}`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/terminal/config/route.ts
git commit -m "feat: add /api/terminal/config route"
```

---

## Task 8: Frontend — TerminalPaneHeader and TerminalPane

**Files:**
- Create: `src/components/terminal/TerminalPaneHeader.tsx`
- Create: `src/components/terminal/TerminalPane.tsx`

- [ ] **Step 1: Implement TerminalPaneHeader**

```tsx
// src/components/terminal/TerminalPaneHeader.tsx
'use client';

import { useState, useRef } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, Maximize01Icon, Minimize01Icon } from '@hugeicons/core-free-icons';

interface TerminalPaneHeaderProps {
  title: string;
  isFocused: boolean;
  onClose: () => void;
  onToggleFocus: () => void;
  onRename: (newTitle: string) => void;
}

export function TerminalPaneHeader({
  title, isFocused, onClose, onToggleFocus, onRename,
}: TerminalPaneHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(title);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commitEdit() {
    const t = draft.trim();
    if (t) onRename(t);
    setEditing(false);
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-3">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none"
          autoFocus
        />
      ) : (
        <span
          className="min-w-0 flex-1 cursor-pointer truncate text-xs text-zinc-400 hover:text-zinc-200"
          onDoubleClick={startEdit}
          title="Double-click to rename"
        >
          {title}
        </span>
      )}
      <button
        type="button"
        onClick={onToggleFocus}
        className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
        title={isFocused ? 'Restore grid' : 'Maximize'}
      >
        <HugeiconsIcon
          icon={isFocused ? Minimize01Icon : Maximize01Icon}
          className="h-3.5 w-3.5"
        />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded p-0.5 text-zinc-500 hover:text-red-400"
        title="Close terminal"
      >
        <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Implement TerminalPane**

```tsx
// src/components/terminal/TerminalPane.tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { ServerMessage, ClientMessage } from '@/lib/terminal/provider';
import { TerminalPaneHeader } from './TerminalPaneHeader';

interface TerminalPaneProps {
  paneId: string;
  sessionId: string | null;   // null → request a new session from WS server
  wsBaseUrl: string;
  hostId: string;
  title: string;
  isFocused: boolean;
  isVisible: boolean;          // false = visibility:hidden, but keep mounted
  onReady: (sessionId: string) => void;
  onClose: () => void;
  onToggleFocus: () => void;
  onRename: (title: string) => void;
}

export function TerminalPane({
  paneId, sessionId, wsBaseUrl, hostId,
  title, isFocused, isVisible,
  onReady, onClose, onToggleFocus, onRename,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');

  const sendJson = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Mount xterm.js, measure actual size, then open WebSocket with those dimensions
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: { background: '#09090b' },  // matches zinc-950
      fontFamily: 'var(--font-geist-mono), monospace',
      fontSize: 13,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    const linksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(linksAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    const { cols, rows } = term;
    const sid = sessionId ?? 'new';
    const url = `${wsBaseUrl}/terminal/${sid}?hostId=${encodeURIComponent(hostId)}&cols=${cols}&rows=${rows}`;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Raw PTY output — pass directly to xterm.js
        term.write(new Uint8Array(event.data));
      } else {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        if (msg.type === 'ready') {
          setStatus('ready');
          onReady(msg.sessionId);
        } else if (msg.type === 'error') {
          setStatus('error');
          setErrorMsg(msg.message);
        } else if (msg.type === 'killed') {
          ws.close();
        }
      }
    };

    ws.onerror = () => {
      setStatus('error');
      setErrorMsg('WebSocket connection failed. Is the terminal server running?');
    };

    term.onData((data) => sendJson({ type: 'input', data }));

    // Refit whenever the container resizes, then sync the PTY size
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      sendJson({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // Intentionally run only on mount — the WS URL is stable once constructed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When focus or visibility changes, the CSS layout shifts — refit xterm
  useEffect(() => {
    if (!isVisible) return;
    const t = setTimeout(() => {
      fitRef.current?.fit();
      if (termRef.current) {
        sendJson({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows });
      }
    }, 50);  // wait for CSS transition to settle
    return () => clearTimeout(t);
  }, [isVisible, isFocused, sendJson]);

  function handleClose() {
    sendJson({ type: 'kill' });
    onClose();
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      <TerminalPaneHeader
        title={title}
        isFocused={isFocused}
        onClose={handleClose}
        onToggleFocus={onToggleFocus}
        onRename={onRename}
      />
      <div className="relative min-h-0 flex-1">
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 p-4 text-center text-sm text-red-400">
            {errorMsg || 'Connection failed'}
          </div>
        )}
        {status === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 text-sm text-zinc-500">
            Connecting…
          </div>
        )}
        <div
          ref={containerRef}
          className="h-full w-full p-1"
          style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/terminal/TerminalPaneHeader.tsx src/components/terminal/TerminalPane.tsx
git commit -m "feat: add TerminalPane (xterm.js + WebSocket) and TerminalPaneHeader"
```

---

## Task 9: Frontend — TerminalGrid, TerminalToolbar, TerminalWorkspace, page

**Files:**
- Create: `src/components/terminal/TerminalGrid.tsx`
- Create: `src/components/terminal/TerminalToolbar.tsx`
- Create: `src/components/terminal/TerminalWorkspace.tsx`
- Create: `src/app/terminal/page.tsx`

- [ ] **Step 1: Implement TerminalGrid**

```tsx
// src/components/terminal/TerminalGrid.tsx
'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { TerminalPane } from './TerminalPane';

export type PaneLayout = 1 | 2 | 4;

export interface PaneState {
  id: string;
  sessionId: string | null;  // null until 'ready' received from WS server
  title: string;
  hostId: string;
}

interface TerminalGridProps {
  panes: PaneState[];
  layout: PaneLayout;
  focusedPaneId: string | null;
  wsBaseUrl: string;
  onPaneReady: (paneId: string, sessionId: string) => void;
  onPaneClose: (paneId: string) => void;
  onToggleFocus: (paneId: string) => void;
  onPaneRename: (paneId: string, title: string) => void;
}

const gridClass: Record<PaneLayout, string> = {
  1: 'grid-cols-1 grid-rows-1',
  2: 'grid-cols-2 grid-rows-1',
  4: 'grid-cols-2 grid-rows-2',
};

export function TerminalGrid({
  panes, layout, focusedPaneId, wsBaseUrl,
  onPaneReady, onPaneClose, onToggleFocus, onPaneRename,
}: TerminalGridProps) {
  // Escape key exits focus mode
  useEffect(() => {
    if (!focusedPaneId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggleFocus(focusedPaneId);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focusedPaneId, onToggleFocus]);

  const hasFocus = focusedPaneId !== null;

  return (
    <div className={cn('relative grid h-full gap-1 p-1', gridClass[layout])}>
      {panes.slice(0, layout).map((pane) => {
        const isFocused = pane.id === focusedPaneId;
        const isVisible = !hasFocus || isFocused;

        return (
          <div
            key={pane.id}
            className={cn(
              'min-h-0 min-w-0 overflow-hidden',
              isFocused && 'absolute inset-0 z-10',
              !isVisible && 'invisible'
            )}
          >
            <TerminalPane
              paneId={pane.id}
              sessionId={pane.sessionId}
              wsBaseUrl={wsBaseUrl}
              hostId={pane.hostId}
              title={pane.title}
              isFocused={isFocused}
              isVisible={isVisible}
              onReady={(sid) => onPaneReady(pane.id, sid)}
              onClose={() => onPaneClose(pane.id)}
              onToggleFocus={() => onToggleFocus(pane.id)}
              onRename={(t) => onPaneRename(pane.id, t)}
            />
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Implement TerminalToolbar**

```tsx
// src/components/terminal/TerminalToolbar.tsx
'use client';

import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import type { PaneLayout } from './TerminalGrid';

interface TerminalToolbarProps {
  layout: PaneLayout;
  paneCount: number;
  onNewPane: () => void;
  onLayoutChange: (layout: PaneLayout) => void;
}

const LAYOUTS: { value: PaneLayout; label: string }[] = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
];

export function TerminalToolbar({ layout, paneCount, onNewPane, onLayoutChange }: TerminalToolbarProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3">
      <span className="text-sm font-medium text-foreground">Terminal</span>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onNewPane}
        disabled={paneCount >= 4}
        className="h-7 gap-1 text-xs"
      >
        <HugeiconsIcon icon={Add01Icon} className="h-3.5 w-3.5" />
        New
      </Button>
      <div className="flex items-center gap-0.5 rounded border border-border/50 p-0.5">
        {LAYOUTS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => onLayoutChange(value)}
            className={`min-w-[24px] rounded px-2 py-0.5 text-xs transition-colors ${
              layout === value
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement TerminalWorkspace**

```tsx
// src/components/terminal/TerminalWorkspace.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { nanoid } from 'nanoid';
// Import from constants.ts (not providers/local.ts) to avoid pulling node-pty into the client bundle
import { LOCAL_PROVIDER_ID } from '@/lib/terminal/constants';
import { TerminalToolbar } from './TerminalToolbar';
import { TerminalGrid, type PaneLayout, type PaneState } from './TerminalGrid';

// TerminalWorkspaceLoader fetches the WS URL from the config API, then renders TerminalWorkspace.
// This avoids hardcoding the hostname in a server component.
export function TerminalWorkspaceLoader() {
  const [wsBaseUrl, setWsBaseUrl] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    fetch('/api/terminal/config')
      .then((r) => r.json())
      .then((d: { wsUrl: string }) => setWsBaseUrl(d.wsUrl))
      .catch(() => setFetchError(true));
  }, []);

  if (fetchError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-400">
        Failed to load terminal config
      </div>
    );
  }
  if (!wsBaseUrl) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  return <TerminalWorkspace wsBaseUrl={wsBaseUrl} />;
}

interface TerminalWorkspaceProps {
  wsBaseUrl: string;
}

function TerminalWorkspace({ wsBaseUrl }: TerminalWorkspaceProps) {
  const [panes, setPanes] = useState<PaneState[]>([
    { id: nanoid(), sessionId: null, title: 'Terminal 1', hostId: LOCAL_PROVIDER_ID },
  ]);
  const [layout, setLayout] = useState<PaneLayout>(1);
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);

  const addPane = useCallback(() => {
    if (panes.length >= 4) return;
    const n = panes.length + 1;
    setPanes((prev) => [
      ...prev,
      { id: nanoid(), sessionId: null, title: `Terminal ${n}`, hostId: LOCAL_PROVIDER_ID },
    ]);
    // Auto-pick a sensible layout for the new count
    if (n === 2) setLayout(2);
    if (n > 2) setLayout(4);
  }, [panes.length]);

  const removePane = useCallback((paneId: string) => {
    setPanes((prev) => {
      const next = prev.filter((p) => p.id !== paneId);
      // Always keep at least one pane
      return next.length > 0
        ? next
        : [{ id: nanoid(), sessionId: null, title: 'Terminal 1', hostId: LOCAL_PROVIDER_ID }];
    });
    setFocusedPaneId((id) => (id === paneId ? null : id));
  }, []);

  const handlePaneReady = useCallback((paneId: string, sessionId: string) => {
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, sessionId } : p)));
  }, []);

  const toggleFocus = useCallback((paneId: string) => {
    setFocusedPaneId((id) => (id === paneId ? null : paneId));
  }, []);

  const renamePane = useCallback((paneId: string, title: string) => {
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, title } : p)));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TerminalToolbar
        layout={layout}
        paneCount={panes.length}
        onNewPane={addPane}
        onLayoutChange={setLayout}
      />
      <div className="relative min-h-0 flex-1">
        <TerminalGrid
          panes={panes}
          layout={layout}
          focusedPaneId={focusedPaneId}
          wsBaseUrl={wsBaseUrl}
          onPaneReady={handlePaneReady}
          onPaneClose={removePane}
          onToggleFocus={toggleFocus}
          onPaneRename={renamePane}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the page**

```tsx
// src/app/terminal/page.tsx
'use client';
import { TerminalWorkspaceLoader } from '@/components/terminal/TerminalWorkspace';

export default function TerminalPage() {
  return <TerminalWorkspaceLoader />;
}
```

- [ ] **Step 5: Commit**

```bash
git add \
  src/components/terminal/TerminalGrid.tsx \
  src/components/terminal/TerminalToolbar.tsx \
  src/components/terminal/TerminalWorkspace.tsx \
  src/app/terminal/page.tsx
git commit -m "feat: add terminal grid, toolbar, workspace, and page route"
```

---

## Task 10: Nav integration

**Files:**
- Modify: `src/components/layout/NavRail.tsx`
- Modify: `src/components/layout/BottomNav.tsx`

- [ ] **Step 1: Find the correct terminal icon name**

```bash
node -e "
const icons = require('@hugeicons/core-free-icons');
const names = Object.keys(icons).filter(k => k.toLowerCase().includes('terminal'));
console.log(names.join('\n'));
"
```

Use the first result (likely `Terminal01Icon` or `Terminal02Icon`).

- [ ] **Step 2: Add Terminal to NavRail**

In `src/components/layout/NavRail.tsx`, add the icon import (use the name found above, e.g. `Terminal02Icon`):

```typescript
import { Terminal02Icon } from '@hugeicons/core-free-icons';
```

Add to `navItems` (between Bridge and Settings):

```typescript
{ href: "/terminal", label: "Terminal", icon: Terminal02Icon },
```

- [ ] **Step 3: Add Terminal to BottomNav**

Same icon import in `src/components/layout/BottomNav.tsx`, same entry in `navItems`.

- [ ] **Step 4: Verify in browser**

With `npm run dev:all` running, open http://localhost:4000. Check:
- Terminal icon visible in nav rail (desktop sidebar)
- Terminal icon visible in bottom nav (mobile, narrow viewport)
- Clicking navigates to `/terminal`
- Workspace loads, connects, and shows a shell prompt

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/NavRail.tsx src/components/layout/BottomNav.tsx
git commit -m "feat: add Terminal to nav rail and bottom nav"
```

---

## Task 11: Dev end-to-end test

Verify the full feature works in dev before building for production.

- [ ] **Step 1: Start the full dev environment**

```bash
npm run dev:all
```
Expected: `ready on http://localhost:4000` and `[terminal-ws] Listening on port 4003`

- [ ] **Step 2: Basic terminal usage**

Open http://localhost:4000/terminal. Verify:
- Pane loads with a shell prompt
- `echo hello world` → output visible

- [ ] **Step 3: Session persistence**

1. Run `sleep 120` in the terminal
2. Close the browser tab
3. Run `tmux list-sessions` in a local terminal  
   Expected: `codepilot-<id>: 1 windows (created ...)` — session still alive
4. Reopen http://localhost:4000/terminal  
   Expected: reconnects, `sleep 120` still visible/running

- [ ] **Step 4: Multi-pane and focus mode**

1. Click "New" → second pane appears, layout switches to 2
2. Click maximize on one pane → it fills the screen
3. Press Escape → grid restores
4. Double-click a pane title → rename it

- [ ] **Step 5: Close pane (kill)**

1. Click × on a pane
2. `tmux list-sessions` — that session no longer appears

---

## Task 12: Production build integration

**Files:**
- Modify: `scripts/prepare-server.mjs`
- Modify: `codepilot-server.js`
- Modify: `scripts/rebuild-production.sh`

- [ ] **Step 1: Update prepare-server.mjs**

At the top of `scripts/prepare-server.mjs`, add the esbuild import:

```javascript
import { buildSync } from 'esbuild';
```

After the existing symlink steps (after the `public` symlink), add:

```javascript
// 4. Bundle terminal-ws-server.ts → .next/standalone/terminal-ws-server.js
// native modules (node-pty, better-sqlite3) are marked external: loaded from
// .next/standalone/node_modules/ at runtime.
const wsServerSrc = join(projectRoot, 'scripts', 'terminal-ws-server.ts');
const wsServerDest = join(standaloneDir, 'terminal-ws-server.js');

if (existsSync(wsServerSrc)) {
  buildSync({
    entryPoints: [wsServerSrc],
    outfile: wsServerDest,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // External: native addons that cannot be bundled; loaded via node_modules symlinks below
    external: ['node-pty', 'ws', 'better-sqlite3', 'nanoid'],
  });
  console.log('[prepare-server] Bundled terminal-ws-server.ts -> .next/standalone/terminal-ws-server.js');
} else {
  console.warn('[prepare-server] terminal-ws-server.ts not found — skipping terminal bundle');
}

// 5. Symlink WS server's runtime deps into standalone/node_modules/
// (Next.js standalone traces only modules imported by Next.js code, not by the WS server)
const wsRuntimeDeps = ['node-pty', 'ws', 'nanoid'];
for (const dep of wsRuntimeDeps) {
  const depSrc = join(projectRoot, 'node_modules', dep);
  const depDest = join(standaloneDir, 'node_modules', dep);
  if (existsSync(depSrc)) {
    forceSymlink(depSrc, depDest, `node_modules/${dep}`);
  } else {
    console.warn(`[prepare-server] ${dep} not found in node_modules — run npm install`);
  }
}
```

- [ ] **Step 2: Update codepilot-server.js**

In `codepilot-server.js`, add after the env setup block (the block that sets `HOSTNAME`, `PORT`, `CLAUDE_GUI_DATA_DIR`) and before `require('./server.js')`:

```javascript
// --- Start Terminal WebSocket server ---
const wsServerPath = path.join(__dirname, 'terminal-ws-server.js');
if (require('fs').existsSync(wsServerPath)) {
  const wsPort = parseInt(process.env.TERMINAL_WS_PORT || '4002', 10);
  try {
    const { startTerminalWS } = require('./terminal-ws-server.js');
    startTerminalWS(wsPort);
    console.log(`[codepilot] Terminal WS server started on port ${wsPort}`);
  } catch (err) {
    // Non-fatal: app works without terminal feature
    console.warn('[codepilot] Failed to start terminal WS server:', err.message);
  }
} else {
  console.log('[codepilot] No terminal-ws-server.js found; terminal feature disabled');
}
```

- [ ] **Step 3: Fix rebuild-production.sh**

Change:
```bash
echo "Building production..."
cd "$BUILD_DIR"
npx next build
```
to:
```bash
echo "Building production..."
cd "$BUILD_DIR"
npm run build
```

This ensures `prepare-server.mjs` (which now bundles the WS server) runs after the Next.js build.

- [ ] **Step 4: Test the production build locally**

```bash
npm run build
```
Expected output includes:
```
[prepare-server] Bundled terminal-ws-server.ts -> .next/standalone/terminal-ws-server.js
[prepare-server] Symlinked node_modules/node-pty -> .next/standalone/node_modules/node-pty
```

Verify the files exist:
```bash
ls .next/standalone/terminal-ws-server.js
ls .next/standalone/node_modules/node-pty
```

- [ ] **Step 5: Add TERMINAL_WS_PORT to production launchd plist**

The production plist is at `~/Library/LaunchAgents/com.codepilot.production.plist`. Open it and add to the `EnvironmentVariables` dict:

```xml
<key>TERMINAL_WS_PORT</key>
<string>4002</string>
```

After editing the plist, reload (plist changes require full bootout + bootstrap — kickstart uses cached plist):

```bash
launchctl bootout gui/$(id -u)/com.codepilot.production
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codepilot.production.plist
```

- [ ] **Step 6: Run the rebuild script and verify production**

```bash
./scripts/rebuild-production.sh
```

Check logs for the terminal WS line:
```bash
grep terminal ~/.codepilot/production.log | tail -5
```
Expected: `[codepilot] Terminal WS server started on port 4002`

Verify terminal works at https://ccpilot.swifttools.eu/terminal.

**Note on HTTPS/WSS**: The existing Caddyfile (`docs/remote-access-setup.md`) only proxies the Next.js port (4001 via SSH tunnel). Port 4002 is **not** currently routed through Caddy. Therefore:

- **Tailscale (http://mac-mini-ip:4001)**: `ws://hostname:4002` works — plain TCP, no proxy needed. ✅
- **ccpilot.swifttools.eu (HTTPS)**: `wss://ccpilot.swifttools.eu:4002` will **fail** until Caddy is updated to proxy port 4002.

For this implementation, **Tailscale access is the supported path**. WSS over the public domain is a follow-up task requiring Caddy config changes. The `/api/terminal/config` route already returns `wss://` when `x-forwarded-proto: https`, so once Caddy is configured, it will work automatically.

- [ ] **Step 7: Commit**

```bash
git add scripts/prepare-server.mjs codepilot-server.js scripts/rebuild-production.sh
git commit -m "feat: integrate terminal WS server into production build pipeline"
```

---

## Task 13: Final verification

- [ ] **Step 1: Run all unit tests**

```bash
npx tsx --test src/__tests__/unit/terminal-registry.test.ts
npx tsx --test src/__tests__/unit/terminal-session-store.test.ts
```
Expected: all tests pass.

- [ ] **Step 2: Test on mobile via Tailscale**

On phone, connect via Tailscale and open CodePilot. Navigate to Terminal.  
Expected: terminal pane loads and shows a prompt.

**Known limitation**: xterm.js on mobile (non-HTTPS HTTP) does not render a software keyboard automatically. Basic input via on-screen keyboard should work but may be awkward. This is a known UX limitation for a future follow-up (e.g. adding a persistent input bar for mobile).

- [ ] **Step 3: Review what was built**

Run a quick self-review by checking the git log:
```bash
git log --oneline | head -15
```

- [ ] **Step 4: Final commit if any cleanup needed, then await user approval before pushing**

Per project rules (`CLAUDE.md` — Release Discipline), **do not push or tag** without explicit user confirmation.
