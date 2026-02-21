import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { InputRequestEvent } from '@/types';

interface PendingInputRequest {
  resolve: (result: PermissionResult) => void;
  createdAt: number;
  abortSignal?: AbortSignal;
  toolInput: Record<string, unknown>; // Original AskUserQuestion input
  sessionId?: string;
  inputEvent?: InputRequestEvent;
}

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Use globalThis to ensure the Map is shared across all module instances.
// In Next.js dev mode (Turbopack), different API routes may load separate
// module instances, so a module-level variable would NOT be shared.
const globalKey = '__pendingInputRequests__' as const;
const sessionMapKey = '__sessionInputRequests__' as const;

function getMap(): Map<string, PendingInputRequest> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, PendingInputRequest>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, PendingInputRequest>;
}

/** Maps sessionId → inputRequestId for quick lookup by session */
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
      entry.resolve({ behavior: 'deny', message: 'Input request timed out' });
      map.delete(id);
      if (entry.sessionId) {
        sessionMap.delete(entry.sessionId);
      }
    }
  }
}

/**
 * Register a pending input request (AskUserQuestion).
 * Returns a Promise that resolves when the user responds.
 */
export function registerPendingInputRequest(
  id: string,
  toolInput: Record<string, unknown>,
  abortSignal?: AbortSignal,
  sessionId?: string,
  inputEvent?: InputRequestEvent,
): Promise<PermissionResult> {
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
      inputEvent,
    });

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
 * Resolve a pending input request with the user's answers.
 * Merges answers into the original tool input and resolves with allow + updatedInput.
 */
export function resolvePendingInputRequest(
  id: string,
  answers: Record<string, string>,
): boolean {
  const map = getMap();
  const sessionMap = getSessionMap();
  const entry = map.get(id);
  if (!entry) return false;

  // Merge user answers into the original AskUserQuestion input
  const updatedInput = { ...entry.toolInput, answers };
  entry.resolve({ behavior: 'allow', updatedInput });
  map.delete(id);
  if (entry.sessionId) {
    sessionMap.delete(entry.sessionId);
  }
  return true;
}

/**
 * Look up a pending input request by session ID.
 * Returns the InputRequestEvent if one is pending, or null.
 */
export function getPendingInputRequestForSession(sessionId: string): InputRequestEvent | null {
  const sessionMap = getSessionMap();
  const inputId = sessionMap.get(sessionId);
  if (!inputId) return null;

  const map = getMap();
  const entry = map.get(inputId);
  if (!entry || !entry.inputEvent) return null;

  return entry.inputEvent;
}
