/**
 * Shared logic for importing a Claude Code CLI session (already on disk under
 * ~/.claude/projects/) into a CodePilot chat session.
 *
 * Used by:
 *   - POST /api/claude-sessions/import   (single existing CLI session)
 *   - POST /api/claude-sessions/upload   (after writing uploaded jsonl to disk)
 */

import { parseClaudeSession } from '@/lib/claude-session-parser';
import { createSession, addMessage, updateSdkSessionId, getAllSessions } from '@/lib/db';

export type ImportResult =
  | { ok: true; codepilotSessionId: string; title: string; messageCount: number; projectPath: string }
  | { ok: false; reason: 'already-imported'; existingCodepilotSessionId: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'no-cwd' };

export function importClaudeSessionById(sessionId: string): ImportResult {
  const alreadyImported = getAllSessions().find(s => s.sdk_session_id === sessionId);
  if (alreadyImported) {
    return { ok: false, reason: 'already-imported', existingCodepilotSessionId: alreadyImported.id };
  }

  const parsed = parseClaudeSession(sessionId);
  if (!parsed) return { ok: false, reason: 'not-found' };

  const { info, messages } = parsed;
  if (messages.length === 0) return { ok: false, reason: 'empty' };

  const workingDirectory = info.cwd || info.projectPath;
  if (!workingDirectory) return { ok: false, reason: 'no-cwd' };

  // Title from first user message; same CJK-aware truncation as chat/route.ts
  const firstUserMsg = messages.find(m => m.role === 'user');
  let title: string;
  if (firstUserMsg) {
    const firstLine = firstUserMsg.content.split('\n')[0].trim();
    const hasCJK = /[　-鿿가-힯豈-﫿]/.test(firstLine);
    const limit = hasCJK ? 10 : 15;
    title = firstLine.length > limit
      ? firstLine.slice(0, limit) + '…'
      : firstLine || firstUserMsg.content.slice(0, limit);
  } else {
    title = `Imported: ${info.projectName}`;
  }

  const session = createSession(title, undefined, undefined, workingDirectory, 'acceptEdits');
  updateSdkSessionId(session.id, sessionId);

  for (const msg of messages) {
    const content = msg.hasToolBlocks
      ? JSON.stringify(msg.contentBlocks)
      : msg.content;
    if (content.trim()) {
      addMessage(session.id, msg.role, content);
    }
  }

  return {
    ok: true,
    codepilotSessionId: session.id,
    title,
    messageCount: messages.length,
    projectPath: info.projectPath,
  };
}
