import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionRequestEvent } from '@/types';

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  createdAt: number;
  abortSignal?: AbortSignal;
  toolInput: Record<string, unknown>; // Original tool input for updatedInput in allow response
  sessionId?: string;
  permEvent?: PermissionRequestEvent;
}

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Use globalThis to ensure the Map is shared across all module instances.
// In Next.js dev mode (Turbopack), different API routes may load separate
// module instances, so a module-level variable would NOT be shared.
const globalKey = '__pendingPermissions__' as const;
const sessionMapKey = '__sessionPermissions__' as const;

function getMap(): Map<string, PendingPermission> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, PendingPermission>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, PendingPermission>;
}

/** Maps sessionId → permissionRequestId for quick lookup by session */
function getSessionMap(): Map<string, string> {
  if (!(globalThis as Record<string, unknown>)[sessionMapKey]) {
    (globalThis as Record<string, unknown>)[sessionMapKey] = new Map<string, string>();
  }
  return (globalThis as Record<string, unknown>)[sessionMapKey] as Map<string, string>;
}

/**
 * Lazily clean up expired entries (older than TIMEOUT_MS).
 */
function cleanupExpired() {
  const map = getMap();
  const sessionMap = getSessionMap();
  const now = Date.now();
  for (const [id, entry] of map) {
    if (now - entry.createdAt > TIMEOUT_MS) {
      entry.resolve({ behavior: 'deny', message: 'Permission request timed out' });
      map.delete(id);
      if (entry.sessionId) {
        sessionMap.delete(entry.sessionId);
      }
    }
  }
}

/**
 * Register a pending permission request.
 * Returns a Promise that resolves when the user responds.
 */
export function registerPendingPermission(
  id: string,
  toolInput: Record<string, unknown>,
  abortSignal?: AbortSignal,
  sessionId?: string,
  permEvent?: PermissionRequestEvent,
): Promise<PermissionResult> {
  // Lazily clean up expired entries on each registration
  cleanupExpired();

  const map = getMap();
  const sessionMap = getSessionMap();

  return new Promise<PermissionResult>((resolve) => {
    map.set(id, {
      resolve,
      createdAt: Date.now(),
      abortSignal,
      toolInput,
      sessionId,
      permEvent,
    });

    // Track by session for status API lookup
    if (sessionId) {
      sessionMap.set(sessionId, id);
    }

    // Auto-deny if the abort signal fires (client disconnect / stop button)
    if (abortSignal) {
      const onAbort = () => {
        if (map.has(id)) {
          resolve({ behavior: 'deny', message: 'Request aborted' });
          map.delete(id);
          if (sessionId) {
            sessionMap.delete(sessionId);
          }
        }
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Resolve a pending permission request with the user's decision.
 * Returns true if the permission was found and resolved, false otherwise.
 */
export function resolvePendingPermission(
  id: string,
  result: PermissionResult,
): boolean {
  const map = getMap();
  const sessionMap = getSessionMap();
  const entry = map.get(id);
  if (!entry) return false;

  // SDK requires updatedInput when allowing — inject the original tool input
  if (result.behavior === 'allow' && !result.updatedInput) {
    result = { ...result, updatedInput: entry.toolInput };
  }

  entry.resolve(result);
  map.delete(id);
  if (entry.sessionId) {
    sessionMap.delete(entry.sessionId);
  }
  return true;
}

/**
 * Look up a pending permission by session ID.
 * Returns the PermissionRequestEvent if one is pending, or null.
 */
export function getPendingPermissionForSession(sessionId: string): PermissionRequestEvent | null {
  const sessionMap = getSessionMap();
  const permId = sessionMap.get(sessionId);
  if (!permId) return null;

  const map = getMap();
  const entry = map.get(permId);
  if (!entry || !entry.permEvent) return null;

  return entry.permEvent;
}
