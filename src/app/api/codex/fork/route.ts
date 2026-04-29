import { NextRequest } from 'next/server';
import { CodexProcessManager } from '@/lib/codex-process-manager';
import { formatJsonRpcRequest, getLastRequestId, type JsonRpcMessage } from '@/lib/codex-jsonrpc';
import {
  getSession,
  createSession,
  copyMessagesToSession,
  updateCodexThreadId,
} from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Fork a Codex chat session: clones the underlying Codex thread (full
 * state, not an LLM summary) and creates a new ChatSession in the DB
 * pre-populated with every message from the source. The user can then
 * continue the new branch independently while the source stays intact.
 *
 * Differs from `/branch` (which re-prompts the model for a summary):
 * fork is exact and free.
 */
export async function POST(request: NextRequest) {
  let body: { session_id?: string; title?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { session_id } = body;
  if (!session_id) {
    return Response.json({ error: 'session_id is required' }, { status: 400 });
  }

  const source = getSession(session_id);
  if (!source) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }
  if (source.backend !== 'codex') {
    return Response.json({ error: 'Fork is only supported on Codex sessions' }, { status: 400 });
  }
  if (!source.codex_thread_id) {
    return Response.json({ error: 'Source session has no Codex thread (no turns yet)' }, { status: 400 });
  }
  if (!source.working_directory) {
    return Response.json({ error: 'Source session has no working directory' }, { status: 400 });
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

  let newThreadId: string;
  try {
    newThreadId = await new Promise<string>((resolve, reject) => {
      const rpc = formatJsonRpcRequest('thread/fork', {
        threadId: source.codex_thread_id,
        // Codex 0.125 gates `persistExtendedHistory: true` behind an
        // experimental capability. Stay on the default rollout so wrappers
        // work out of the box.
        persistExtendedHistory: false,
      });
      const requestId = getLastRequestId();
      const timeout = setTimeout(() => {
        codexProcess.offMessage(handler);
        reject(new Error('thread/fork timed out after 15s'));
      }, 15_000);
      const handler = (msg: JsonRpcMessage) => {
        if (msg.type === 'response' && msg.id === requestId) {
          clearTimeout(timeout);
          codexProcess.offMessage(handler);
          if (msg.error) {
            reject(new Error(msg.error.message || 'thread/fork failed'));
            return;
          }
          const result = msg.result as { thread?: { id?: string } } | undefined;
          const id = result?.thread?.id;
          if (typeof id === 'string' && id) {
            resolve(id);
          } else {
            reject(new Error('thread/fork returned no thread id'));
          }
        }
      };
      codexProcess.onMessage(handler);
      codexProcess.send(rpc);
    });
  } catch (error) {
    return Response.json(
      { error: `Codex fork failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }

  const sourceTitle = source.title || 'Chat';
  const newTitle = body.title?.trim() || `${sourceTitle} (fork)`;

  let newSession;
  try {
    newSession = createSession(
      newTitle,
      source.model || undefined,
      source.system_prompt || undefined,
      source.working_directory,
      source.mode || undefined,
      'codex',
      null,
      session_id,
    );
  } catch (error) {
    return Response.json(
      { error: `Failed to create forked session: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }

  updateCodexThreadId(newSession.id, newThreadId);
  const copied = copyMessagesToSession(session_id, newSession.id);

  return Response.json({
    ok: true,
    session: { ...newSession, codex_thread_id: newThreadId },
    copiedMessages: copied,
  });
}
