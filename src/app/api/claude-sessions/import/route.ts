import { NextRequest } from 'next/server';
import { importClaudeSessionById } from '@/lib/claude-session-import';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return Response.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const result = importClaudeSessionById(sessionId);

    if (!result.ok) {
      switch (result.reason) {
        case 'already-imported':
          return Response.json(
            {
              error: 'This session has already been imported',
              existingSessionId: result.existingCodepilotSessionId,
            },
            { status: 409 },
          );
        case 'not-found':
          return Response.json(
            { error: `Session "${sessionId}" not found or could not be parsed` },
            { status: 404 },
          );
        case 'empty':
          return Response.json({ error: 'Session has no messages to import' }, { status: 400 });
        case 'no-cwd':
          return Response.json(
            { error: 'Cannot import session: no working directory (cwd) found in session data' },
            { status: 400 },
          );
      }
    }

    return Response.json({
      session: {
        id: result.codepilotSessionId,
        title: result.title,
        messageCount: result.messageCount,
        projectPath: result.projectPath,
        sdkSessionId: sessionId,
      },
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[POST /api/claude-sessions/import] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
