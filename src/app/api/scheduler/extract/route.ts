import { NextRequest } from 'next/server';
import { getDb, getSession } from '@/lib/db';
import { extractTaskDraft, applyDraftDefaults } from '@/lib/scheduler/extract';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { text, sessionId, lookback = 12, backend } = body as {
    text?: string;
    sessionId?: string;
    lookback?: number;
    backend?: 'claude' | 'codex';
  };

  let inputText = text ?? '';
  let wd: string | undefined;
  let inferredBackend: 'claude' | 'codex' | undefined = backend;

  if (sessionId) {
    const session = getSession(sessionId);
    if (!session) return Response.json({ error: 'session not found' }, { status: 404 });
    wd = session.working_directory;
    inferredBackend = inferredBackend ?? (session.backend as 'claude' | 'codex');
    if (!inputText) {
      const rows = getDb().prepare(
        "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
      ).all(sessionId, lookback) as { role: string; content: string }[];
      inputText = rows.reverse().map(r => `${r.role}: ${plainText(r.content)}`).join('\n\n');
    }
  }

  if (!inputText.trim()) return Response.json({ error: 'no input text' }, { status: 400 });

  try {
    const draft = await extractTaskDraft({
      backend: inferredBackend ?? 'claude',
      text: inputText,
      workingDirectory: wd,
    });
    return Response.json({ draft: applyDraftDefaults(draft) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

function plainText(content: string): string {
  try {
    const blocks = JSON.parse(content);
    if (Array.isArray(blocks)) {
      return blocks
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('\n');
    }
  } catch {
    // not JSON, fall through
  }
  return content;
}
