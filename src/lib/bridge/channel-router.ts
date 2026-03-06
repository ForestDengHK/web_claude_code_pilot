/**
 * Channel Router — maps IM addresses (channelType + chatId) to CodePilot sessions
 * via the channel_bindings DB table.
 *
 * Also provides per-session locking to serialize message processing.
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types';
import {
  getChannelBinding,
  upsertChannelBinding,
  updateChannelBinding,
  listChannelBindings,
  deleteChannelBinding,
} from './bridge-db';
import { validateSessionId, validateWorkingDirectory } from './security/validators';

// ==========================================
// Per-session lock (in-memory serialization)
// ==========================================

const SESSION_LOCKS_KEY = '__bridge_session_locks__';
function getSessionLocks(): Map<string, Promise<void>> {
  const g = globalThis as Record<string, unknown>;
  if (!g[SESSION_LOCKS_KEY]) {
    g[SESSION_LOCKS_KEY] = new Map<string, Promise<void>>();
  }
  return g[SESSION_LOCKS_KEY] as Map<string, Promise<void>>;
}

/**
 * Ensures only one message processes per session at a time.
 * Different sessions run concurrently; same session waits for previous to complete.
 */
export async function processWithSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = getSessionLocks();
  const prev = locks.get(sessionId) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  locks.set(sessionId, next);
  await prev;
  try {
    return await fn();
  } finally {
    resolve();
    if (locks.get(sessionId) === next) {
      locks.delete(sessionId);
    }
  }
}

// ==========================================
// Channel routing
// ==========================================

/**
 * Look up a channel binding by channelType + chatId.
 * Returns the ChannelBinding or null if not found.
 */
export function resolve(address: ChannelAddress): ChannelBinding | null {
  const binding = getChannelBinding(address.channelType, address.chatId);
  if (!binding || !binding.active) return null;
  return binding;
}

/**
 * Create or update a channel binding for the given address + session.
 * Validates sessionId format and workingDirectory (if provided).
 * Throws on invalid input.
 */
export function bindSession(
  address: ChannelAddress,
  sessionId: string,
  opts?: { workingDirectory?: string; model?: string },
): ChannelBinding {
  if (!validateSessionId(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }

  if (opts?.workingDirectory) {
    const normalized = validateWorkingDirectory(opts.workingDirectory);
    if (normalized === null) {
      throw new Error(`Invalid working directory: ${opts.workingDirectory}`);
    }
    opts = { ...opts, workingDirectory: normalized };
  }

  return upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: sessionId,
    workingDirectory: opts?.workingDirectory,
    model: opts?.model,
  });
}

/**
 * Update fields on an existing binding.
 * Validates workingDirectory if provided.
 */
export function updateSession(
  bindingId: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  if (updates.workingDirectory !== undefined) {
    const normalized = validateWorkingDirectory(updates.workingDirectory);
    if (normalized === null) {
      throw new Error(`Invalid working directory: ${updates.workingDirectory}`);
    }
    updates = { ...updates, workingDirectory: normalized };
  }

  updateChannelBinding(bindingId, updates);
}

/**
 * List all channel bindings, optionally filtered by channel type.
 */
export function listSessions(channelType?: ChannelType): ChannelBinding[] {
  return listChannelBindings(channelType);
}

/**
 * Remove a channel binding entirely.
 */
export function removeSession(bindingId: string): boolean {
  return deleteChannelBinding(bindingId);
}
