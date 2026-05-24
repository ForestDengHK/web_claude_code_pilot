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

/**
 * Manually switch a conversation to an explicit tier, any direction. Unlike
 * applyTierSwitch (driven by exhaustion, always the next tier, discards the
 * failed turn), this is driven by the user picking a tier and only changes
 * the backend — no turn is discarded and nothing is resent.
 */
export function switchToTier(sessionId: string, target: Tier): void {
  const s = getSession(sessionId);
  if (s?.backend === 'channels' && target !== 'channels') {
    seedSdkResumeFromChannel(sessionId);
  }
  getDb().prepare(`UPDATE chat_sessions SET backend = ? WHERE id = ?`).run(target, sessionId);
}

/**
 * Drop the rate-limited turn — the trailing user message and anything saved
 * after it (the dead/partial assistant message). The tier-switch caller
 * resends that message on the new tier, so leaving the old copy would show a
 * duplicate user message plus a dead assistant message in the conversation.
 */
export function discardExhaustedTurn(sessionId: string): void {
  const db = getDb();
  const lastUser = db.prepare(
    `SELECT rowid FROM messages WHERE session_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1`,
  ).get(sessionId) as { rowid: number } | undefined;
  if (!lastUser) return;
  db.prepare(`DELETE FROM messages WHERE session_id = ? AND rowid >= ?`)
    .run(sessionId, lastUser.rowid);
}
