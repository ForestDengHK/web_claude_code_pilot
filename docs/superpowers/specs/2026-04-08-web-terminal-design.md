# Web Terminal Feature — Design Spec

**Date:** 2026-04-08  
**Status:** Approved  
**Feature:** Embedded interactive terminal in CodePilot web UI

---

## Overview

Add a persistent, interactive web terminal to CodePilot, accessible via a new nav tab. The terminal connects to the Mac Mini (local host) via a WebSocket-backed PTY server. Sessions are managed with tmux so they survive browser disconnects. The architecture is designed for extensibility: adding new host types (SSH, WSL, etc.) requires only a new provider implementation, with no changes to existing code (OCP).

---

## Requirements

- **Interactive terminal** in the browser (xterm.js), supporting full PTY features: color, cursor control, Tab completion, Ctrl+C, vi, htop, etc.
- **tmux-backed persistence**: closing the browser tab does not kill the running process; reconnecting reattaches to the same tmux session
- **Split-screen layout**: up to 4 terminal panes on screen simultaneously; clicking a pane focuses/maximizes it (others hidden); clicking again or pressing Esc returns to grid
- **Multi-host ready**: provider abstraction allows future SSH/WSL hosts; only LocalProvider implemented now
- **No extra auth**: Tailscale is the security boundary
- **Nav integration**: new Terminal item in NavRail (desktop) and BottomNav (mobile)
- **Session persistence**: terminal sessions stored in SQLite; reconciled against live tmux sessions on startup

---

## Architecture

```
Browser (xterm.js)
    ↕ WebSocket  ws://host:TERMINAL_WS_PORT
Terminal WS Server  (scripts/terminal-ws-server.js)
    ↕ node-pty
tmux sessions  (survive server restarts)
```

The WS server and Next.js server run in the **same Node.js process** in production (both started from `codepilot-server.js`). In development, the WS server is started separately via `npm run terminal-ws`.

---

## Section 1: Provider Layer (OCP)

### TerminalProvider interface

```typescript
// src/lib/terminal/provider.ts

export interface ConnectOptions {
  cols: number;
  rows: number;
}

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  disconnect(): void;  // detach (keep tmux session alive)
  kill(): void;        // destroy tmux session
}

export interface TerminalProvider {
  readonly type: string;          // 'local' | 'ssh' | ...
  readonly id: string;
  readonly displayName: string;
  connect(sessionId: string, opts: ConnectOptions): Promise<PtyHandle>;
}
```

### ProviderRegistry

```typescript
// src/lib/terminal/registry.ts

class ProviderRegistry {
  register(provider: TerminalProvider): void;
  get(id: string): TerminalProvider | undefined;
  list(): TerminalProvider[];
}

export const providerRegistry = new ProviderRegistry();
```

### LocalProvider

```typescript
// src/lib/terminal/providers/local.ts

// Implements TerminalProvider for the local machine.
// Each session maps to a tmux session named "codepilot-<sessionId>".
// Uses: tmux new-session -A -s codepilot-<id>
//   -A: attach if exists, create if not — gives us persistence for free.
// node-pty spawns the tmux command and pipes I/O to the WS server.
```

**Adding a new host type in the future** (e.g., SSH):
1. Create `src/lib/terminal/providers/ssh.ts` implementing `TerminalProvider`
2. Call `providerRegistry.register(new SSHProvider(...))` at startup
3. No other code changes required

---

## Section 2: WebSocket Server

**File:** `scripts/terminal-ws-server.js`  
**Port:** `TERMINAL_WS_PORT` env var (default: `PORT + 1`, e.g., 4002 prod / 4001 dev)

### Message Protocol

WebSocket frames carry two types of data:

| Frame type | Direction | Content |
|------------|-----------|---------|
| Binary | Server → Browser | Raw PTY output (passed directly to xterm.js) |
| Text (JSON) | Browser → Server | Control messages |
| Text (JSON) | Server → Browser | Control messages |

```typescript
// Browser → Server (JSON text frames)
type ClientMessage =
  | { type: 'input'; data: string }        // keystroke(s)
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }

// Server → Browser (JSON text frames)
type ServerMessage =
  | { type: 'ready'; sessionId: string }
  | { type: 'error'; message: string }
  | { type: 'pong' }
```

Raw PTY output is sent as **binary frames** (not JSON) for performance. On the browser side, xterm.js writes binary data directly; JSON control messages are parsed separately by checking `typeof event.data`.

### Connection lifecycle

```
WS connect (URL: /terminal/<sessionId>?hostId=local)
  → look up session in SessionStore
  → if not found: create new session record
  → LocalProvider.connect(sessionId, { cols, rows })
      → spawn: tmux new-session -A -s codepilot-<sessionId>
  → send { type: 'ready', sessionId }
  → pipe: PTY stdout → ws.send(binary)
          ws.message (input) → pty.write()
          ws.message (resize) → pty.resize()

WS disconnect
  → ptyHandle.disconnect()   // closes node-pty, tmux session stays alive
  → update session last_seen in DB

Pane closed by user
  → WS message { type: 'kill' }
  → ptyHandle.kill()         // tmux kill-session
  → delete session from DB
```

### Connection map

```typescript
// In-memory map for active connections
const connections = new Map<string, {
  ws: WebSocket;
  ptyHandle: PtyHandle;
  sessionId: string;
}>();
```

---

## Section 3: Session Persistence (SQLite)

Uses the existing `better-sqlite3` database. New table added via migration:

```sql
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id          TEXT PRIMARY KEY,
  host_id     TEXT NOT NULL DEFAULT 'local',
  tmux_name   TEXT NOT NULL,      -- "codepilot-<id>"
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
```

**`src/lib/terminal/session-store.ts`** wraps CRUD operations.

**Startup reconciliation**: on WS server start, query all sessions from DB and check each against `tmux ls`. Remove DB records for sessions whose tmux session no longer exists. This prevents stale entries from accumulating.

---

## Section 4: Frontend

### Route & page

- Route: `/terminal`
- New file: `src/app/terminal/page.tsx` (server component wrapper)
- Client logic: `src/components/terminal/TerminalWorkspace.tsx`

### Component tree

```
TerminalWorkspace
├── TerminalToolbar
│   ├── [+ New pane] button
│   ├── Layout selector  [1 | 2 | 4]
│   └── Host selector dropdown  (lists providerRegistry entries)
└── TerminalGrid
    ├── TerminalPane  (xterm.js instance + WS connection)
    ├── TerminalPane
    └── ...
        └── TerminalPaneHeader  (title, rename, close, maximize button)
```

### TerminalGrid: layout and focus mode

Grid layouts (CSS grid):
- 1 pane: full area
- 2 panes: 50/50 horizontal split
- 4 panes: 2×2 grid

Focus mode state: `focusedPaneId: string | null`
- Normal: CSS grid with equal cells
- Focused: focused pane gets `position: absolute; inset: 0; z-index: 10`; others get `visibility: hidden` (kept mounted to preserve xterm.js state)
- Toggle: click pane header maximize button, or press `Escape`

### TerminalPane: xterm.js integration

Dependencies:
- `@xterm/xterm` — terminal emulator
- `@xterm/addon-fit` — auto-resize terminal to container
- `@xterm/addon-web-links` — clickable URLs in terminal output

Connection URL constructed from `/api/terminal/config` response:
```
GET /api/terminal/config → { wsUrl: "ws://hostname:4002" }
```
Then: `ws://hostname:4002/terminal/<sessionId>?hostId=local`

Resize handling: `ResizeObserver` on the pane container → `fitAddon.fit()` → send `{ type: 'resize', cols, rows }` to WS server.

Binary frames from WS → `terminal.write(new Uint8Array(data))`  
JSON frames from WS → parse and handle (ready, error, pong)  
xterm.js `onData` → `ws.send(JSON.stringify({ type: 'input', data }))`

---

## Section 5: Nav Integration

Add Terminal nav item to both nav components:

```typescript
// NavRail.tsx and BottomNav.tsx
{ href: "/terminal", label: "Terminal", icon: TerminalSquareIcon }
```

Icon: `Terminal02Icon` or similar from `@hugeicons/core-free-icons`.

---

## Section 6: Dev/Prod Startup

### Production

`codepilot-server.js` is modified to start the WS server before Next.js:

```javascript
// In codepilot-server.js, after env setup, before require('./server.js'):
const { startTerminalWS } = require('./terminal-ws-server.js');
startTerminalWS(parseInt(process.env.TERMINAL_WS_PORT || String(parseInt(process.env.PORT || '3000') + 1)));

require('./server.js');  // Next.js standalone server
```

Both servers run in the same process, managed by launchd `com.codepilot.production`.

### Development

New npm scripts:

```json
{
  "terminal-ws": "node --watch scripts/terminal-ws-server.js",
  "dev:all": "concurrently \"npm run dev\" \"npm run terminal-ws\""
}
```

`--watch` (Node 18+ built-in) restarts the WS server when its source changes. Next.js HMR is unaffected.

Normal dev workflow: `npm run dev` (no terminal feature). Terminal dev: `npm run dev:all`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TERMINAL_WS_PORT` | `PORT + 1` | Port for Terminal WebSocket server |

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/app/terminal/page.tsx` | Route entry point |
| `src/components/terminal/TerminalWorkspace.tsx` | Top-level client component |
| `src/components/terminal/TerminalGrid.tsx` | Grid layout + focus mode state |
| `src/components/terminal/TerminalPane.tsx` | xterm.js + WebSocket per pane |
| `src/components/terminal/TerminalToolbar.tsx` | New/layout/host controls |
| `src/components/terminal/TerminalPaneHeader.tsx` | Per-pane title bar |
| `src/lib/terminal/provider.ts` | TerminalProvider interface + PtyHandle |
| `src/lib/terminal/registry.ts` | ProviderRegistry singleton |
| `src/lib/terminal/providers/local.ts` | LocalProvider (node-pty + tmux) |
| `src/lib/terminal/session-store.ts` | SQLite CRUD for terminal_sessions |
| `src/app/api/terminal/config/route.ts` | Serve WS URL to frontend |
| `scripts/terminal-ws-server.js` | WebSocket server entry point |

## Files to Modify

| File | Change |
|------|--------|
| `src/components/layout/NavRail.tsx` | Add Terminal nav item |
| `src/components/layout/BottomNav.tsx` | Add Terminal nav item |
| `codepilot-server.js` | Start WS server before Next.js |
| `package.json` | Add deps + new scripts |

## New Dependencies

| Package | Role |
|---------|------|
| `@xterm/xterm` | Frontend terminal emulator |
| `@xterm/addon-fit` | Auto-resize xterm to container |
| `@xterm/addon-web-links` | Clickable URLs in terminal |
| `node-pty` | Native PTY on macOS/Linux |
| `ws` | WebSocket server |
| `concurrently` | Run dev + WS server in parallel (devDependency) |

---

## Design Patterns Applied

- **OCP (Open/Closed Principle)**: `TerminalProvider` interface is the extension point. Adding SSH/WSL support = new class, zero modification of existing code.
- **Registry Pattern**: `ProviderRegistry` decouples provider lookup from consumer code. Providers self-register at startup.
- **Adapter Pattern**: `LocalProvider` adapts `node-pty`'s API to the `PtyHandle` interface. Future providers adapt their respective transport (ssh2, etc.) to the same interface.
- **Separation of Concerns**: WS server handles transport and lifecycle; providers handle PTY creation; session-store handles persistence; frontend components handle rendering only.
