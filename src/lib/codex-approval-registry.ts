import type { PermissionRequestEvent } from '@/types';

export type CodexApprovalType = 'command' | 'file_change';
export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CodexApprovalInfo {
  type: CodexApprovalType;
  callId: string;
  turnId: string;
  command?: string[];
  cwd?: string;
  reason: string | null;
  jsonRpcId?: number | string; // JSON-RPC request id we must respond to
  changes?: Record<string, unknown>; // file changes for file_change type
}

interface PendingApproval {
  resolve: (decision: CodexApprovalDecision) => void;
  createdAt: number;
  abortSignal?: AbortSignal;
  sessionId: string;
  info: CodexApprovalInfo;
  /** The original PermissionRequestEvent sent to the client via SSE.
   *  Stored so the status route can restore the permission dialog after
   *  an SSE reconnection (page refresh, mobile tab resume, etc.). */
  permissionEvent?: PermissionRequestEvent;
}

import { REGISTRY_TIMEOUT_MS as TIMEOUT_MS } from '@/lib/config';

// Use globalThis to ensure the Map is shared across all module instances.
// In Next.js dev mode (Turbopack), different API routes may load separate
// module instances, so a module-level variable would NOT be shared.
const globalKey = '__codexPendingApprovals__' as const;
const sessionMapKey = '__codexSessionApprovals__' as const;

function getMap(): Map<string, PendingApproval> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, PendingApproval>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, PendingApproval>;
}

/** Maps sessionId -> approvalId for quick lookup by session */
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
      entry.resolve('cancel');
      map.delete(id);
      sessionMap.delete(entry.sessionId);
    }
  }
}

/**
 * Register a pending Codex approval request.
 * Returns a Promise that resolves when the user responds with a decision.
 */
export function registerPendingCodexApproval(
  approvalId: string,
  sessionId: string,
  info: CodexApprovalInfo,
  abortSignal?: AbortSignal,
  permissionEvent?: PermissionRequestEvent,
): Promise<CodexApprovalDecision> {
  // Lazily clean up expired entries on each registration
  cleanupExpired();

  const map = getMap();
  const sessionMap = getSessionMap();

  return new Promise<CodexApprovalDecision>((resolve) => {
    map.set(approvalId, {
      resolve,
      createdAt: Date.now(),
      abortSignal,
      sessionId,
      info,
      permissionEvent,
    });

    // Track by session for status API lookup
    sessionMap.set(sessionId, approvalId);

    // Auto-cancel if the abort signal fires (client disconnect / stop button)
    if (abortSignal) {
      const onAbort = () => {
        if (map.has(approvalId)) {
          resolve('cancel');
          map.delete(approvalId);
          sessionMap.delete(sessionId);
        }
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Resolve a pending Codex approval request with the user's decision.
 * Returns true if the approval was found and resolved, false otherwise.
 */
export function resolvePendingCodexApproval(
  approvalId: string,
  decision: CodexApprovalDecision,
): boolean {
  const map = getMap();
  const sessionMap = getSessionMap();
  const entry = map.get(approvalId);
  if (!entry) return false;

  entry.resolve(decision);
  map.delete(approvalId);
  sessionMap.delete(entry.sessionId);
  return true;
}

/**
 * Look up a pending approval by session ID.
 * Returns the CodexApprovalInfo if one is pending, or null.
 */
export function getPendingCodexApprovalForSession(sessionId: string): CodexApprovalInfo | null {
  const sessionMap = getSessionMap();
  const approvalId = sessionMap.get(sessionId);
  if (!approvalId) return null;

  const map = getMap();
  const entry = map.get(approvalId);
  if (!entry) return null;

  return entry.info;
}

/**
 * Look up a pending Codex approval by session ID and return the original
 * PermissionRequestEvent that was sent to the client via SSE.
 * Used by the status route to restore the permission dialog after reconnection.
 */
export function getPendingCodexPermissionForSession(sessionId: string): PermissionRequestEvent | null {
  const sessionMap = getSessionMap();
  const approvalId = sessionMap.get(sessionId);
  if (!approvalId) return null;

  const map = getMap();
  const entry = map.get(approvalId);
  if (!entry) return null;

  return entry.permissionEvent ?? null;
}
