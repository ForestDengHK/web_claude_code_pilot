import { getDb, getSession } from '../db';
import { nextTier, type Tier } from './tiers';

export interface TierSwitchResult { newTier: Tier; }

/**
 * Move a conversation to the next tier. Tier1->2 keeps the same Claude session
 * id (channel_session_id), seeded into sdk_session_id so the Agent SDK resumes
 * the same transcript. Tier2->3 relies on the existing Claude/Codex context-bridge.
 */
export function applyTierSwitch(sessionId: string, currentTier: Tier): TierSwitchResult {
  const next = nextTier(currentTier);
  if (!next) throw new Error('no further tier available');
  if (currentTier === 'channels') seedSdkResumeFromChannel(sessionId);
  getDb().prepare(`UPDATE chat_sessions SET backend = ? WHERE id = ?`).run(next, sessionId);
  return { newTier: next };
}

/** Seed sdk_session_id from channel_session_id so the Agent SDK resumes the same transcript. */
export function seedSdkResumeFromChannel(sessionId: string): void {
  const s = getSession(sessionId);
  if (s?.channel_session_id && !s.sdk_session_id) {
    getDb().prepare(`UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?`)
      .run(s.channel_session_id, sessionId);
  }
}
