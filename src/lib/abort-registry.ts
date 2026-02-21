/**
 * Server-side registry of AbortControllers for active Claude sessions.
 *
 * This decouples the Claude Code subprocess lifecycle from the HTTP connection:
 * - The Claude process runs until completion even if the mobile browser drops
 *   the SSE socket (e.g. when switching apps).
 * - The user can still explicitly stop generation via POST /api/chat/stop,
 *   which looks up the controller here and calls abort().
 */

// Use globalThis to ensure the Map is shared across all module instances.
// In Next.js dev mode (Turbopack), different API routes may load separate
// module instances, so a module-level variable would NOT be shared.
const globalKey = '__abortRegistry__' as const;

function getRegistry(): Map<string, AbortController> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, AbortController>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, AbortController>;
}

export function registerAbort(sessionId: string, controller: AbortController): void {
  getRegistry().set(sessionId, controller);
}

export function abortSession(sessionId: string): boolean {
  const registry = getRegistry();
  const controller = registry.get(sessionId);
  if (!controller) return false;
  controller.abort();
  registry.delete(sessionId);
  return true;
}

export function unregisterAbort(sessionId: string): void {
  getRegistry().delete(sessionId);
}

export function isSessionActive(sessionId: string): boolean {
  return getRegistry().has(sessionId);
}
