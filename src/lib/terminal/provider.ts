// Core interfaces for the terminal provider system.
// Adding a new host type (SSH, WSL, etc.) = new class implementing TerminalProvider.
// No changes to this file or its consumers required.

/** Terminal dimensions in character cells, required for PTY spawn. */
export interface ConnectOptions {
  /** Number of columns. */
  cols: number;
  /** Number of rows. */
  rows: number;
}

export interface PtyHandle {
  /** Send keystrokes/data to the PTY stdin. */
  write(data: string): void;
  /** Inform the PTY of a terminal resize. */
  resize(cols: number, rows: number): void;
  /** Register a callback for PTY stdout data. Returns an unsubscribe function. */
  onData(cb: (data: string) => void): () => void;
  /** Register a callback for PTY process exit. Returns an unsubscribe function. */
  onExit(cb: (exitCode: number, signal?: number) => void): () => void;
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

// PTY stdout is sent as binary WebSocket frames (not JSON) — see terminal-ws-server.ts
export type ServerMessage =
  | { type: 'ready'; sessionId: string }
  | { type: 'killed' }
  | { type: 'error'; message: string }
  | { type: 'pong' };
