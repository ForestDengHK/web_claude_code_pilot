import { NextRequest } from 'next/server';
import { summarize } from '@/lib/memory-summarizer';
import { getAllMessages, getSession } from '@/lib/db';
import type { SummarizeMode, SummarizeBackend, SummarizeAction } from '@/lib/memory-summarizer';

/**
 * Extract searchable plain text from a message content string.
 * Handles both plain text and JSON-encoded MessageContentBlock arrays.
 */
function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('\n');
    }
  } catch { /* plain text */ }
  return content;
}

/**
 * POST /api/memory/summarize
 *
 * Body:
 *   content    — text to summarize (for single-message mode)
 *   session_id — session to summarize (for session-level mode)
 *   mode       — 'memory' | 'skill' | 'session-memory' | 'session-skill'
 *   action     — 'extract' | 'generate'
 *   backend    — 'claude' | 'codex'
 *   model      — optional model override for the selected backend
 *   working_directory — optional cwd override
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const mode: SummarizeMode = body.mode || 'memory';
    const action: SummarizeAction = body.action === 'generate' ? 'generate' : 'extract';
    const backend: SummarizeBackend = body.backend === 'codex' ? 'codex' : 'claude';
    const model: string | undefined = typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : undefined;
    const effort: string | undefined = typeof body.effort === 'string' && body.effort.trim()
      ? body.effort.trim()
      : undefined;
    let content: string = body.content || '';
    let workingDirectory: string | undefined = typeof body.working_directory === 'string' && body.working_directory.trim()
      ? body.working_directory.trim()
      : undefined;

    // For session-level modes, build content from conversation history
    if (mode.startsWith('session-') && body.session_id) {
      const session = getSession(body.session_id);
      const messages = getAllMessages(body.session_id);
      if (messages.length === 0) {
        return Response.json({ error: 'No messages in session' }, { status: 400 });
      }
      if (!workingDirectory && session?.working_directory) {
        workingDirectory = session.working_directory;
      }
      // Build a condensed conversation transcript
      const lines: string[] = [];
      for (const msg of messages) {
        const text = extractText(msg.content).trim();
        if (!text) continue;
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        // Truncate individual messages to keep total reasonable
        lines.push(`[${role}]: ${text.slice(0, 1500)}`);
      }
      content = lines.join('\n\n');
    }

    if (!content.trim()) {
      return Response.json({ error: 'No content to summarize' }, { status: 400 });
    }

    const result = await summarize({
      content,
      mode,
      action,
      backend,
      model,
      effort,
      workingDirectory,
    });
    return Response.json({ summary: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to summarize';
    console.error('[memory/summarize] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
