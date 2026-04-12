// src/app/api/chat/sessions/organize/execute/route.ts
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ExecuteRequest, ExecuteSSEEvent } from '@/types/organize';
import { deleteSession, updateSessionTitle, getSession } from '@/lib/db';

function formatSSE(event: ExecuteSSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Derive the Claude CLI session file path from a session's working_directory and sdk_session_id.
 * Claude stores sessions at: ~/.claude/projects/<mangled-path>/<uuid>.jsonl
 */
function getCliSessionPath(workingDirectory: string, sdkSessionId: string): string | null {
  if (!workingDirectory || !sdkSessionId) return null;
  const mangled = workingDirectory.replace(/\//g, '-');
  const base = path.join(os.homedir(), '.claude', 'projects', mangled);
  const jsonlPath = path.join(base, `${sdkSessionId}.jsonl`);
  return jsonlPath;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as ExecuteRequest;
  const { actions, cleanupCli } = body;

  let heartbeatInterval: ReturnType<typeof setInterval>;

  const stream = new ReadableStream<string>({
    async start(controller) {
      heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(formatSSE({ type: 'heartbeat' }));
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 10_000);

      let success = 0;
      let failed = 0;
      const failures: Array<{ sessionId: string; error: string }> = [];

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        try {
          if (action.action === 'delete') {
            const session = getSession(action.sessionId);

            const deleted = deleteSession(action.sessionId);
            if (!deleted) {
              throw new Error('Session not found or already deleted');
            }

            if (cleanupCli && session?.sdk_session_id) {
              const cliPath = getCliSessionPath(session.working_directory, session.sdk_session_id);
              if (cliPath) {
                try {
                  if (fs.existsSync(cliPath)) fs.unlinkSync(cliPath);
                  const dirPath = cliPath.replace('.jsonl', '');
                  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
                    fs.rmSync(dirPath, { recursive: true });
                  }
                } catch {
                  // CLI cleanup is best-effort
                }
              }
            }

            success++;
          } else if (action.action === 'rename' && action.newTitle) {
            updateSessionTitle(action.sessionId, action.newTitle);
            success++;
          } else {
            throw new Error(`Invalid action: ${action.action}`);
          }

          controller.enqueue(formatSSE({
            type: 'progress',
            completed: i + 1,
            total: actions.length,
            sessionId: action.sessionId,
            action: action.action,
            success: true,
          }));
        } catch (error) {
          failed++;
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          failures.push({ sessionId: action.sessionId, error: errorMsg });

          controller.enqueue(formatSSE({
            type: 'progress',
            completed: i + 1,
            total: actions.length,
            sessionId: action.sessionId,
            action: action.action,
            success: false,
            error: errorMsg,
          }));
        }
      }

      controller.enqueue(formatSSE({
        type: 'done',
        summary: { success, failed, failures },
      }));

      clearInterval(heartbeatInterval);
      controller.close();
    },
    cancel() {
      clearInterval(heartbeatInterval);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
