// src/lib/terminal/providers/local.ts
import * as pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import type { TerminalProvider, PtyHandle, ConnectOptions } from '../provider.js';
import { LOCAL_PROVIDER_ID } from '../constants.js';
export { LOCAL_PROVIDER_ID } from '../constants.js';

export class LocalProvider implements TerminalProvider {
  readonly id = LOCAL_PROVIDER_ID;
  readonly displayName = 'Local (this machine)';
  readonly type = 'local';

  async connect(sessionId: string, opts: ConnectOptions): Promise<PtyHandle> {
    // Validate tmux is available
    try {
      execFileSync('which', ['tmux'], { stdio: 'ignore' });
    } catch {
      throw new Error('tmux not found on PATH. Install tmux to use the terminal feature.');
    }

    // sessionId is the full tmux session name (e.g. "codepilot-abc123")
    // passed from the WS server via session.tmuxName from the DB.
    const tmuxSession = sessionId;

    // -A: attach if session exists, create if not. This handles both first-connect and reconnect.
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
    const exitListeners: Array<(code: number, signal?: number) => void> = [];

    ptyProcess.onData((data) => { for (const cb of dataListeners) cb(data); });
    ptyProcess.onExit(({ exitCode, signal }) => {
      for (const cb of exitListeners) cb(exitCode ?? 0, signal);
    });

    const handle: PtyHandle = {
      write(data) { ptyProcess.write(data); },
      resize(cols, rows) { ptyProcess.resize(cols, rows); },
      onData(cb) {
        dataListeners.push(cb);
        return () => { const i = dataListeners.indexOf(cb); if (i >= 0) dataListeners.splice(i, 1); };
      },
      onExit(cb) {
        exitListeners.push(cb);
        return () => { const i = exitListeners.indexOf(cb); if (i >= 0) exitListeners.splice(i, 1); };
      },
      disconnect() {
        // Close node-pty cleanly. tmux session stays alive in background by default.
        try { ptyProcess.kill(); } catch { /* already exited */ }
      },
      kill() {
        // Destroy tmux session first, then close node-pty.
        try {
          execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' });
        } catch { /* session may already be gone */ }
        try { ptyProcess.kill(); } catch { /* already exited */ }
      },
    };

    return handle;
  }
}
