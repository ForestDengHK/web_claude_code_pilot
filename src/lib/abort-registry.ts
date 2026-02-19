/**
 * Server-side registry of AbortControllers for active Claude sessions.
 *
 * This decouples the Claude Code subprocess lifecycle from the HTTP connection:
 * - The Claude process runs until completion even if the mobile browser drops
 *   the SSE socket (e.g. when switching apps).
 * - The user can still explicitly stop generation via POST /api/chat/stop,
 *   which looks up the controller here and calls abort().
 */

const registry = new Map<string, AbortController>();

export function registerAbort(sessionId: string, controller: AbortController): void {
  registry.set(sessionId, controller);
}

export function abortSession(sessionId: string): boolean {
  const controller = registry.get(sessionId);
  if (!controller) return false;
  controller.abort();
  registry.delete(sessionId);
  return true;
}

export function unregisterAbort(sessionId: string): void {
  registry.delete(sessionId);
}

export function isSessionActive(sessionId: string): boolean {
  return registry.has(sessionId);
}
