/**
 * Manages the lifecycle of `codex app-server` subprocesses.
 *
 * Each CodePilot session gets its own Codex process. Processes are stored in a
 * globalThis-backed Map so they survive Next.js module reloads in dev mode.
 *
 * Lifecycle:
 *   1. spawn('codex', ['app-server']) with stdio pipes
 *   2. readline on stdout for newline-delimited JSON-RPC parsing
 *   3. Send `initialize` request + `initialized` notification
 *   4. Wait for initialize response (10s timeout)
 *   5. On exit: clean up from Map
 */

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import {
  formatJsonRpcRequest,
  getLastRequestId,
  parseJsonRpcLine,
  type JsonRpcMessage,
} from './codex-jsonrpc';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodexProcess {
  proc: ChildProcess;
  send(message: string): void;
  onMessage(handler: (msg: JsonRpcMessage) => void): void;
  offMessage(handler: (msg: JsonRpcMessage) => void): void;
  onExit(handler: (error?: Error) => void): void;
  offExit(handler: (error?: Error) => void): void;
  threadId: string | null;
  currentTurnId: string | null;
  interruptRequested: boolean;
  initialized: boolean;
}

// ---------------------------------------------------------------------------
// globalThis-backed Map (same pattern as abort-registry.ts)
// ---------------------------------------------------------------------------

const globalKey = '__codexProcesses__' as const;

function getProcessMap(): Map<string, CodexProcess> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, CodexProcess>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, CodexProcess>;
}

// ---------------------------------------------------------------------------
// CodexProcessManager
// ---------------------------------------------------------------------------

export class CodexProcessManager {
  /**
   * Return an existing CodexProcess for the session, or spawn a new one
   * and perform the initialize handshake.
   */
  static async getOrCreate(sessionId: string): Promise<CodexProcess> {
    const map = getProcessMap();
    const existing = map.get(sessionId);
    if (existing && existing.proc.exitCode === null) {
      return existing;
    }

    // Clean up stale entry if the process already exited
    if (existing) {
      map.delete(sessionId);
    }

    return CodexProcessManager.spawnAndInitialize(sessionId);
  }

  /**
   * Kill the process for a session. SIGTERM first, SIGKILL after 2s.
   */
  static async kill(sessionId: string): Promise<void> {
    const map = getProcessMap();
    const entry = map.get(sessionId);
    if (!entry) return;

    map.delete(sessionId);
    entry.currentTurnId = null;
    entry.interruptRequested = false;
    await CodexProcessManager.gracefulKill(entry.proc);
  }

  /**
   * Gracefully interrupt the active turn for a session.
   *
   * If the turn ID is not known yet, we keep the request pending and flush it
   * as soon as `turn/started` arrives.
   */
  static interrupt(sessionId: string): boolean {
    const entry = getProcessMap().get(sessionId);
    if (!entry || entry.proc.exitCode !== null) {
      return false;
    }

    entry.interruptRequested = true;
    CodexProcessManager.flushPendingInterrupt(entry);
    return true;
  }

  /**
   * Send a pending interrupt once both thread and turn IDs are known.
   */
  static flushPendingInterrupt(entry: CodexProcess): void {
    if (!entry.interruptRequested || !entry.threadId || !entry.currentTurnId) {
      return;
    }

    entry.interruptRequested = false;
    entry.send(formatJsonRpcRequest('turn/interrupt', {
      threadId: entry.threadId,
      turnId: entry.currentTurnId,
    }));
  }

  /**
   * Kill all managed processes.
   */
  static async killAll(): Promise<void> {
    const map = getProcessMap();
    const kills: Promise<void>[] = [];

    for (const [sessionId, entry] of map) {
      map.delete(sessionId);
      kills.push(CodexProcessManager.gracefulKill(entry.proc));
    }

    await Promise.all(kills);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private static async spawnAndInitialize(sessionId: string): Promise<CodexProcess> {
    const proc = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const messageHandlers = new Set<(msg: JsonRpcMessage) => void>();
    const exitHandlers = new Set<(error?: Error) => void>();

    const codexProcess: CodexProcess = {
      proc,
      threadId: null,
      currentTurnId: null,
      interruptRequested: false,
      initialized: false,

      send(message: string) {
        // Guard against three distinct EPIPE scenarios:
        //  1. No stdin stream (spawn failed upstream)
        //  2. Process exited but stdin.destroyed is still false
        //     (race window between exit event and pipe teardown)
        //  3. Write throws synchronously (broken pipe discovered mid-write)
        // Any of these should be a silent no-op — the exit handler already
        // removes the process from the map, so the next getOrCreate() spawns
        // fresh. Letting EPIPE bubble up turns into an unhandled exception
        // that can crash the whole dev server.
        if (!proc.stdin || proc.stdin.destroyed) return;
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        try {
          proc.stdin.write(message);
        } catch (err) {
          console.log(
            `[codex:send] write failed (process likely exited): ${(err as Error).message}`,
          );
        }
      },

      onMessage(handler: (msg: JsonRpcMessage) => void) {
        messageHandlers.add(handler);
      },

      offMessage(handler: (msg: JsonRpcMessage) => void) {
        messageHandlers.delete(handler);
      },

      onExit(handler: (error?: Error) => void) {
        exitHandlers.add(handler);
      },

      offExit(handler: (error?: Error) => void) {
        exitHandlers.delete(handler);
      },
    };

    // Parse stdout line-by-line as JSON-RPC
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line: string) => {
        const msg = parseJsonRpcLine(line);
        if (msg) {
          for (const handler of messageHandlers) {
            handler(msg);
          }
        }
      });
    }

    // Pipe stderr to console for debugging
    if (proc.stderr) {
      const stderrRl = createInterface({ input: proc.stderr });
      stderrRl.on('line', (line: string) => {
        console.log(`[codex:${sessionId}:stderr] ${line}`);
      });
    }

    // Clean up on exit
    proc.on('exit', (code, signal) => {
      console.log(
        `[codex:${sessionId}] process exited (code=${code}, signal=${signal})`,
      );
      codexProcess.currentTurnId = null;
      codexProcess.interruptRequested = false;
      for (const handler of exitHandlers) {
        handler();
      }
      getProcessMap().delete(sessionId);
    });

    proc.on('error', (err) => {
      console.log(`[codex:${sessionId}] process error: ${err.message}`);
      codexProcess.currentTurnId = null;
      codexProcess.interruptRequested = false;
      for (const handler of exitHandlers) {
        handler(err);
      }
      getProcessMap().delete(sessionId);
    });

    // Store in map before handshake so kill() can find it
    getProcessMap().set(sessionId, codexProcess);

    // Perform initialize handshake
    try {
      await CodexProcessManager.performHandshake(codexProcess, sessionId);
    } catch (err) {
      // Handshake failed — clean up
      getProcessMap().delete(sessionId);
      await CodexProcessManager.gracefulKill(proc);
      throw err;
    }

    return codexProcess;
  }

  private static performHandshake(
    codexProcess: CodexProcess,
    sessionId: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const initRequest = formatJsonRpcRequest('initialize', {
        clientInfo: { name: 'codepilot', title: 'CodePilot', version: '1.0.0' },
        // experimentalApi unlocks `thread/goal/*` (requires [features].goals = true
        // in ~/.codex/config.toml). Other Codex methods we use are unaffected.
        capabilities: { experimentalApi: true },
      });
      const initRequestId = getLastRequestId();

      const timeout = setTimeout(() => {
        codexProcess.offMessage(handler);
        reject(new Error(`[codex:${sessionId}] initialize handshake timed out after 10s`));
      }, 10_000);

      const handler = (msg: JsonRpcMessage) => {
        if (msg.type === 'response' && msg.id === initRequestId) {
          clearTimeout(timeout);
          codexProcess.offMessage(handler);

          if (msg.error) {
            reject(
              new Error(
                `[codex:${sessionId}] initialize failed: ${msg.error.message}`,
              ),
            );
            return;
          }

          codexProcess.initialized = true;

          // Send `initialized` notification (no id — it's a notification)
          codexProcess.send(
            JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n',
          );

          resolve();
        }
      };

      codexProcess.onMessage(handler);
      codexProcess.send(initRequest);
    });
  }

  private static gracefulKill(proc: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (proc.exitCode !== null) {
        resolve();
        return;
      }

      const forceKillTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process may already be dead
        }
      }, 2_000);

      proc.once('exit', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });

      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be dead
        clearTimeout(forceKillTimer);
        resolve();
      }
    });
  }
}
