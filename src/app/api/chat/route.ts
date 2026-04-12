import { NextRequest } from 'next/server';
import { streamClaude } from '@/lib/claude-client';
import { addMessage, addDraftMessage, updateDraftMessage, finalizeDraftMessage, getDb, getSession, updateSessionTitle, updateSdkSessionId, getSetting } from '@/lib/db';
import { sendPushNotification } from '@/lib/push-notifications';
import { detectBackendSwitch, buildIncrementalBridge } from '@/lib/context-bridge';
import { registerAbort, registerQuery, unregisterAbort } from '@/lib/abort-registry';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import {
  initStreamBuffer,
  appendStreamText,
  pushStreamToolUse,
  pushStreamToolResult,
  setStreamStatusText,
  clearStreamBuffer,
} from '@/lib/streaming-buffer-registry';
import type { SendMessageRequest, SSEEvent, TokenUsage, MessageContentBlock, FileAttachment } from '@/types';
import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body: SendMessageRequest & { files?: FileAttachment[]; toolTimeout?: number; effort?: string; disable_tools?: boolean; max_turns?: number } = await request.json();
    const { session_id, content, prompt, model, mode, files, toolTimeout, effort, disable_tools, max_turns } = body;

    if (!session_id || !content) {
      return new Response(JSON.stringify({ error: 'session_id and content are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = getSession(session_id);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!session.working_directory) {
      return new Response(JSON.stringify({ error: 'Session has no working directory. Please set a working directory before sending messages.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Save user message — persist file metadata so attachments survive page reload
    let savedContent = content;

    // Separate path references (from file tree +) from real uploads
    const PATH_REF_TYPES = new Set(['text/x-directory-ref', 'text/x-file-ref']);
    const pathRefFiles = files?.filter(f => PATH_REF_TYPES.has(f.type)) || [];
    const uploadFiles = files?.filter(f => !PATH_REF_TYPES.has(f.type)) || [];

    // Decode original paths from path-ref files (content is the disk path)
    const pathRefs = pathRefFiles.map(f => ({
      id: f.id,
      name: f.name,
      type: f.type,
      originalPath: Buffer.from(f.data, 'base64').toString('utf-8'),
    }));

    let fileMeta: Array<{ id: string; name: string; type: string; size: number; filePath: string }> | undefined;
    if (uploadFiles.length > 0) {
      const workDir = session.working_directory;
      const uploadDir = path.join(workDir, '.codepilot-uploads');
      await fs.mkdir(uploadDir, { recursive: true });
      fileMeta = [];
      for (const f of uploadFiles) {
        const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
        const buffer = Buffer.from(f.data, 'base64');
        await fs.writeFile(filePath, buffer);
        fileMeta.push({ id: f.id, name: f.name, type: f.type, size: buffer.length, filePath });
      }
    }
    if ((fileMeta && fileMeta.length > 0) || pathRefs.length > 0) {
      const allMeta = [
        ...(fileMeta || []),
        ...pathRefs.map(r => ({ id: r.id, name: r.name, type: r.type, size: 0, filePath: r.originalPath })),
      ];
      savedContent = `<!--files:${JSON.stringify(allMeta)}-->${content}`;
    }
    addMessage(session_id, 'user', savedContent, null, 'claude');

    // Auto-generate title from first message if still default.
    // CJK characters are visually wider so we cap at 10 chars,
    // pure ASCII gets up to 15 chars. This keeps sidebar titles readable on mobile.
    if (session.title === 'New Chat') {
      const firstLine = content.split('\n')[0].trim();
      const hasCJK = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(firstLine);
      const limit = hasCJK ? 10 : 15;
      const title = firstLine.length > limit
        ? firstLine.slice(0, limit) + '…'
        : firstLine || content.slice(0, limit);
      updateSessionTitle(session_id, title);
    }

    // Determine model: request override > session model > default setting
    const effectiveModel = model || session.model || getSetting('default_model') || undefined;

    // Determine permission mode from chat mode: code → acceptEdits, plan → plan
    const effectiveMode = mode || session.mode || 'code';
    let permissionMode: string;
    switch (effectiveMode) {
      case 'plan':
        permissionMode = 'plan';
        break;
      default: // 'code'
        permissionMode = 'acceptEdits';
        break;
    }

    // Build incremental context bridge if switching from Codex → Claude
    let contextBridgePrompt: string | undefined;
    const switchSource = detectBackendSwitch(session_id, 'claude');
    if (switchSource) {
      const bridge = buildIncrementalBridge(session_id, 'claude', switchSource);
      if (bridge) {
        contextBridgePrompt = bridge;
      }
    }

    // Skill content is now injected directly into the user message as <command-name> blocks
    // (matching Claude Code CLI behavior). Only session-level system_prompt is used here.
    const systemPromptOverride = session.system_prompt || undefined;

    const abortController = new AbortController();

    // Register this controller so the user's Stop button (POST /api/chat/stop)
    // can abort the Claude process explicitly.
    // We intentionally do NOT bind request.signal here: mobile browsers drop the
    // SSE socket when the app is backgrounded, and we don't want that to kill
    // the Claude Code subprocess — it should keep running so that when the user
    // returns and recovery polling kicks in, the full response is already in the DB.
    registerAbort(session_id, abortController);

    // Convert file attachments to the format expected by streamClaude.
    // Include filePath from the already-saved files so claude-client can
    // reference the on-disk copies instead of writing them again.
    // Path references (from tree +) carry originalPath and need no disk copy.
    const allFiles = [
      ...uploadFiles.map((f, i) => {
        const meta = fileMeta?.find((m: { id: string }) => m.id === f.id);
        return {
          id: f.id || `file-${Date.now()}-${i}`,
          name: f.name,
          type: f.type,
          size: f.size,
          data: f.data,
          filePath: meta?.filePath,
        };
      }),
      ...pathRefs.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        size: 0,
        data: '',
        filePath: r.originalPath,
      })),
    ];
    const fileAttachments: FileAttachment[] | undefined = allFiles.length > 0
      ? allFiles
      : undefined;

    // Stream Claude response, using SDK session ID for resume if available.
    // Use `prompt` (skill-injected content) if provided, otherwise plain `content`.
    // If a context bridge is needed, prepend it to the prompt.
    let effectivePrompt = prompt || content;

    // Inject branch summary as context prefix on the first message of a branched session.
    // Only inject when there is no sdk_session_id yet (first turn — subsequent turns use resume).
    if (session.branch_summary && !session.sdk_session_id) {
      effectivePrompt = `[Context from previous conversation]\n---\n${session.branch_summary}\n---\n\n${effectivePrompt}`;
    }

    if (contextBridgePrompt) {
      effectivePrompt = `${contextBridgePrompt}\n\n---\n\n${effectivePrompt}`;
    }
    const stream = streamClaude({
      prompt: effectivePrompt,
      sessionId: session_id,
      sdkSessionId: session.sdk_session_id || undefined,
      model: effectiveModel,
      systemPrompt: systemPromptOverride,
      workingDirectory: session.working_directory || undefined,
      abortController,
      permissionMode,
      files: fileAttachments,
      toolTimeoutSeconds: toolTimeout || 120,
      skipPermissions: session.skip_permissions === 1,
      onQueryCreated: (q) => registerQuery(session_id, q as Query),
      effort,
      advisorModel: session.advisor_model || undefined,
      disableTools: disable_tools,
      maxTurns: max_turns,
    });

    // Tee the stream: one for client, one for collecting the response
    const [streamForClient, streamForCollect] = stream.tee();

    // Save assistant message in background; clean up abort registry when done
    collectStreamResponse(streamForCollect, session_id).finally(() => {
      unregisterAbort(session_id);
    });

    return new Response(streamForClient, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function collectStreamResponse(stream: ReadableStream<string>, sessionId: string) {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  let tokenUsage: TokenUsage | null = null;
  let draftMessageId: string | null = null;
  let lastCheckpointTime = 0;
  const CHECKPOINT_INTERVAL_MS = 10_000; // Save draft every 10s

  // Initialise the in-memory streaming buffer so the recovery-polling
  // status endpoint can return intermediate output to the client.
  initStreamBuffer(sessionId);

  /** Build the content string from current accumulated blocks. */
  function buildContent(): string {
    const blocks = [...contentBlocks];
    if (currentText.trim()) {
      blocks.push({ type: 'text', text: currentText });
    }
    if (blocks.length === 0) return '';
    const hasToolBlocks = blocks.some(b => b.type === 'tool_use' || b.type === 'tool_result');
    if (hasToolBlocks) return JSON.stringify(blocks);
    return blocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
  }

  /** Save or update draft in DB. */
  function checkpoint(): void {
    const content = buildContent();
    if (!content) return;
    if (!draftMessageId) {
      const draft = addDraftMessage(sessionId, content, 'claude');
      draftMessageId = draft.id;
    } else {
      updateDraftMessage(draftMessageId, content);
    }
    lastCheckpointTime = Date.now();
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event: SSEEvent = JSON.parse(line.slice(6));
            if (event.type === 'permission_request' || event.type === 'input_request') {
              // Skip permission_request and input_request events - not saved as message content
            } else if (event.type === 'session_reset') {
              // Server is retrying with a fresh session (e.g. stale thinking
              // block signatures after provider switch). Discard any error text
              // accumulated from the failed attempt so only the retry response
              // is saved to the database.
              currentText = '';
              contentBlocks.length = 0;
              // Delete the draft if one was already created for the error text
              if (draftMessageId) {
                try {
                  const db = getDb();
                  db.prepare('DELETE FROM messages WHERE id = ?').run(draftMessageId);
                } catch { /* best effort */ }
                draftMessageId = null;
              }
              // Re-init streaming buffer so recovery polling starts fresh
              clearStreamBuffer(sessionId);
              initStreamBuffer(sessionId);
            } else if (event.type === 'tool_output') {
              // Not saved as message content, but capture progress for the
              // streaming buffer so recovery can show "Running bash… (5s)".
              try {
                const parsed = JSON.parse(event.data);
                if (parsed._progress) {
                  setStreamStatusText(sessionId, `Running ${parsed.tool_name}... (${Math.round(parsed.elapsed_time_seconds)}s)`);
                }
              } catch {
                // raw stderr — ignore for buffer purposes
              }
            } else if (event.type === 'text') {
              currentText += event.data;
              appendStreamText(sessionId, event.data);
              // Create draft on first content, then checkpoint periodically
              if (!draftMessageId) {
                checkpoint();
              } else if (Date.now() - lastCheckpointTime > CHECKPOINT_INTERVAL_MS) {
                checkpoint();
              }
            } else if (event.type === 'tool_use') {
              // Flush any accumulated text before the tool use block
              if (currentText.trim()) {
                contentBlocks.push({ type: 'text', text: currentText });
                currentText = '';
              }
              try {
                const toolData = JSON.parse(event.data);
                contentBlocks.push({
                  type: 'tool_use',
                  id: toolData.id,
                  name: toolData.name,
                  input: toolData.input,
                });
                pushStreamToolUse(sessionId, {
                  id: toolData.id,
                  name: toolData.name,
                  input: toolData.input,
                });
              } catch {
                // skip malformed tool_use data
              }
            } else if (event.type === 'tool_result') {
              try {
                const resultData = JSON.parse(event.data);
                contentBlocks.push({
                  type: 'tool_result',
                  tool_use_id: resultData.tool_use_id,
                  content: resultData.content,
                  is_error: resultData.is_error || false,
                });
                pushStreamToolResult(sessionId, {
                  tool_use_id: resultData.tool_use_id,
                  content: resultData.content,
                  is_error: resultData.is_error || false,
                });
                // Always checkpoint after a tool result completes
                checkpoint();
              } catch {
                // skip malformed tool_result data
              }
            } else if (event.type === 'status') {
              // Capture SDK session_id from init event and persist it
              try {
                const statusData = JSON.parse(event.data);
                if (statusData.session_id) {
                  updateSdkSessionId(sessionId, statusData.session_id);
                  setStreamStatusText(sessionId, `Connected (${statusData.model || statusData.session_id || 'model'})`);
                } else if (statusData.notification) {
                  setStreamStatusText(sessionId, statusData.message || statusData.title || undefined);
                }
              } catch {
                // skip malformed status data
              }
            } else if (event.type === 'result') {
              try {
                const resultData = JSON.parse(event.data);
                if (resultData.usage) {
                  tokenUsage = resultData.usage;
                }
                // Also capture session_id from result if we missed it from init
                if (resultData.session_id) {
                  updateSdkSessionId(sessionId, resultData.session_id);
                }
              } catch {
                // skip malformed result data
              }
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    }

    // Flush any remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );

      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();

      if (content) {
        if (draftMessageId) {
          finalizeDraftMessage(
            draftMessageId,
            content,
            tokenUsage ? JSON.stringify(tokenUsage) : null,
          );
        } else {
          addMessage(
            sessionId,
            'assistant',
            content,
            tokenUsage ? JSON.stringify(tokenUsage) : null,
            'claude',
          );
        }

        // Send push notification for task completion
        const session = getSession(sessionId);
        sendPushNotification({
          type: 'task_complete',
          sessionId,
          sessionTitle: session?.title || 'CodePilot',
          message: (() => {
            try {
              const blocks = JSON.parse(content);
              if (Array.isArray(blocks)) {
                const textParts = blocks.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text);
                return textParts.join('').trim() || 'Task completed';
              }
            } catch { /* not JSON, use as-is */ }
            return content;
          })(),
        }).catch(() => {});
      }
    }
  } catch {
    // Stream reading error — best effort save
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
      if (content) {
        if (draftMessageId) {
          finalizeDraftMessage(draftMessageId, content);
        } else {
          addMessage(sessionId, 'assistant', content, null, 'claude');
        }
      }
    }
  } finally {
    // Always clean up the streaming buffer when the stream ends
    clearStreamBuffer(sessionId);

    // Safety net: if a draft was created but never finalized (e.g. abort before
    // any text arrived, or content was empty), finalize it now so it doesn't
    // remain stuck in 'streaming' status and trigger infinite recovery polling.
    if (draftMessageId) {
      try {
        // Only finalize if still in streaming status (avoid overwriting already-finalized content)
        const db = getDb();
        const row = db.prepare("SELECT status FROM messages WHERE id = ?").get(draftMessageId) as { status?: string } | undefined;
        if (row?.status === 'streaming') {
          finalizeDraftMessage(draftMessageId, '(interrupted)');
        }
      } catch {
        // Best effort — don't let cleanup errors propagate
      }
    }
  }
}
