import { NextRequest } from 'next/server';
import { CodexProcessManager } from '@/lib/codex-process-manager';
import { formatJsonRpcRequest, getLastRequestId, type JsonRpcMessage } from '@/lib/codex-jsonrpc';
import { getSession, deleteMessagesFromMessageInclusive, getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Roll a Codex thread back so the conversation continues from before
 * `message_id`. Used by the chat UI's edit-message flow: the client
 * deletes the old user turn (and everything after) from the visible
 * history, then re-sends the edited prompt as a fresh turn.
 *
 * NOTE: Codex's rollback only modifies in-memory turn history; it does
 * not undo file/edit side effects. We surface this same caveat in the UI.
 */
export async function POST(request: NextRequest) {
  let body: { session_id?: string; message_id?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { session_id, message_id } = body;
  if (!session_id || !message_id) {
    return Response.json({ error: 'session_id and message_id are required' }, { status: 400 });
  }

  const session = getSession(session_id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }
  if (session.backend !== 'codex') {
    return Response.json({ error: 'Rollback is only supported on Codex sessions' }, { status: 400 });
  }
  const threadId = session.codex_thread_id;
  if (!threadId) {
    return Response.json({ error: 'Session has no Codex thread (no turns yet)' }, { status: 400 });
  }

  // Count how many user turns will be dropped by erasing this message
  // and everything after it. We must call thread/rollback BEFORE deleting
  // from the DB so a failure doesn't leave history desynced.
  const peek = peekUserTurnsToDrop(session_id, message_id);
  if (peek === 0) {
    return Response.json({ error: 'Message not found in session' }, { status: 404 });
  }

  let codexProcess;
  try {
    codexProcess = await CodexProcessManager.getOrCreate(session_id);
  } catch (error) {
    return Response.json(
      { error: `Failed to attach Codex process: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const rpc = formatJsonRpcRequest('thread/rollback', { threadId, numTurns: peek });
      const requestId = getLastRequestId();
      const timeout = setTimeout(() => {
        codexProcess.offMessage(handler);
        reject(new Error('thread/rollback timed out after 15s'));
      }, 15_000);
      const handler = (msg: JsonRpcMessage) => {
        if (msg.type === 'response' && msg.id === requestId) {
          clearTimeout(timeout);
          codexProcess.offMessage(handler);
          if (msg.error) {
            reject(new Error(msg.error.message || 'thread/rollback failed'));
          } else {
            resolve();
          }
        }
      };
      codexProcess.onMessage(handler);
      codexProcess.send(rpc);
    });
  } catch (error) {
    return Response.json(
      { error: `Codex rollback failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }

  // Codex rollback succeeded — now wipe the corresponding messages from
  // the local DB so the UI matches the thread state.
  deleteMessagesFromMessageInclusive(session_id, message_id);
  return Response.json({ ok: true, droppedTurns: peek });
}

function peekUserTurnsToDrop(sessionId: string, messageId: string): number {
  const db = getDb();
  const marker = db.prepare(
    'SELECT rowid FROM messages WHERE id = ? AND session_id = ?'
  ).get(messageId, sessionId) as { rowid: number } | undefined;
  if (!marker) return 0;
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND rowid >= ? AND role = 'user'"
  ).get(sessionId, marker.rowid) as { c: number };
  return row.c;
}
