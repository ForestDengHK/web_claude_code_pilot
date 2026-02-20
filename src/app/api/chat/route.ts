import { NextRequest } from 'next/server';
import { streamClaude } from '@/lib/claude-client';
import { addMessage, getSession, updateSessionTitle, updateSdkSessionId, getSetting } from '@/lib/db';
import { registerAbort, unregisterAbort } from '@/lib/abort-registry';
import type { SendMessageRequest, SSEEvent, TokenUsage, MessageContentBlock, FileAttachment } from '@/types';
import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body: SendMessageRequest & { files?: FileAttachment[]; toolTimeout?: number } = await request.json();
    const { session_id, content, prompt, model, mode, files, toolTimeout } = body;

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
    addMessage(session_id, 'user', savedContent);

    // Auto-generate title from first message if still default.
    // Use a short limit: CJK characters are visually wider so we cap at 20 chars,
    // pure ASCII gets up to 40 chars. This keeps sidebar titles readable on mobile.
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
    const stream = streamClaude({
      prompt: prompt || content,
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event: SSEEvent = JSON.parse(line.slice(6));
            if (event.type === 'permission_request' || event.type === 'tool_output') {
              // Skip permission_request and tool_output events - not saved as message content
            } else if (event.type === 'text') {
              currentText += event.data;
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
              } catch {
                // skip malformed tool_result data
              }
            } else if (event.type === 'status') {
              // Capture SDK session_id from init event and persist it
              try {
                const statusData = JSON.parse(event.data);
                if (statusData.session_id) {
                  updateSdkSessionId(sessionId, statusData.session_id);
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
      // If the message is text-only (no tool calls), store as plain text
      // for backward compatibility with existing message rendering.
      // If it contains tool calls, store as structured JSON.
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
        addMessage(
          sessionId,
          'assistant',
          content,
          tokenUsage ? JSON.stringify(tokenUsage) : null,
        );
      }
    }
  } catch {
    // Stream reading error - best effort save
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
        addMessage(sessionId, 'assistant', content);
      }
    }
  }
}
