import type { Query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Server-side registry of AbortControllers and Query objects for active Claude sessions.
 *
 * This decouples the Claude Code subprocess lifecycle from the HTTP connection:
 * - The Claude process runs until completion even if the mobile browser drops
 *   the SSE socket (e.g. when switching apps).
 * - The user can still explicitly stop generation via POST /api/chat/stop,
 *   which looks up the controller here and calls interrupt() or abort().
 *
 * Two-tier stop strategy (Claude sessions only):
 * - interrupt(): graceful — lets current tool finish, then stops. Used by Stop button.
 * - abort(): hard kill — immediately terminates subprocess. Used by Force Stop fallback.
 */

// Use globalThis to ensure the Map is shared across all module instances.
// In Next.js dev mode (Turbopack), different API routes may load separate
// module instances, so a module-level variable would NOT be shared.
const globalKey = '__abortRegistry__' as const;
const queryKey = '__queryRegistry__' as const;
const interruptedKey = '__interruptedRegistry__' as const;

function getRegistry(): Map<string, AbortController> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, AbortController>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, AbortController>;
}

function getQueryRegistry(): Map<string, Query> {
  if (!(globalThis as Record<string, unknown>)[queryKey]) {
    (globalThis as Record<string, unknown>)[queryKey] = new Map<string, Query>();
  }
  return (globalThis as Record<string, unknown>)[queryKey] as Map<string, Query>;
}

function getInterruptedRegistry(): Set<string> {
  if (!(globalThis as Record<string, unknown>)[interruptedKey]) {
    (globalThis as Record<string, unknown>)[interruptedKey] = new Set<string>();
  }
  return (globalThis as Record<string, unknown>)[interruptedKey] as Set<string>;
}

export function registerAbort(sessionId: string, controller: AbortController): void {
  getRegistry().set(sessionId, controller);
}

export function registerQuery(sessionId: string, q: Query): void {
  getQueryRegistry().set(sessionId, q);
}

/**
 * Gracefully interrupt a Claude session. Lets the current tool finish,
 * then stops the conversation. Returns true if a Query was found and interrupted.
 * Falls back to abort() if no Query is registered (e.g. Codex sessions).
 */
export async function interruptSession(sessionId: string): Promise<boolean> {
  const queryRegistry = getQueryRegistry();
  const q = queryRegistry.get(sessionId);
  if (q) {
    getInterruptedRegistry().add(sessionId);
    await q.interrupt();
    return true;
  }
  // Fallback: no Query registered (Codex or legacy), use abort
  return abortSession(sessionId);
}

/**
 * Hard-kill a session. Immediately terminates the subprocess.
 * Used as Force Stop fallback when interrupt() doesn't respond.
 */
export function abortSession(sessionId: string): boolean {
  const registry = getRegistry();
  const controller = registry.get(sessionId);
  if (!controller) return false;
  controller.abort();
  registry.delete(sessionId);
  getQueryRegistry().delete(sessionId);
  return true;
}

export function unregisterAbort(sessionId: string): void {
  getRegistry().delete(sessionId);
  getQueryRegistry().delete(sessionId);
  getInterruptedRegistry().delete(sessionId);
}

export function isSessionActive(sessionId: string): boolean {
  return getRegistry().has(sessionId);
}

/**
 * Check whether a graceful interrupt was requested for a session.
 * Used by claude-client to suppress spurious error messages that the
 * SDK throws when an API request is mid-flight during interrupt().
 */
export function wasInterrupted(sessionId: string): boolean {
  return getInterruptedRegistry().has(sessionId);
}
