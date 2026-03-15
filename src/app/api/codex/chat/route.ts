import { NextRequest } from 'next/server';
import { streamCodex, type CodexSkillRef } from '@/lib/codex-client';
import { detectBackendSwitch, buildIncrementalBridge } from '@/lib/context-bridge';
import { addMessage, getSession, updateSessionTitle } from '@/lib/db';
import { registerAbort, unregisterAbort } from '@/lib/abort-registry';
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
    const body: SendMessageRequest & { files?: FileAttachment[]; toolTimeout?: number; effort?: string; codexSkills?: CodexSkillRef[] } = await request.json();
    const { session_id, content, prompt, model, files, effort, codexSkills } = body;

    console.log('[codex/chat] Received effort:', JSON.stringify(effort), 'model:', model);

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
    addMessage(session_id, 'user', savedContent, null, 'codex');

    // Auto-generate title from first message if still default.
    if (session.title === 'New Chat') {
      const firstLine = content.split('\n')[0].trim();
      const hasCJK = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(firstLine);
      const limit = hasCJK ? 10 : 15;
      const title = firstLine.length > limit
        ? firstLine.slice(0, limit) + '\u2026'
        : firstLine || content.slice(0, limit);
      updateSessionTitle(session_id, title);
    }

    // Determine model: request override > session model
    const effectiveModel = model || session.model || undefined;

    // Build incremental context bridge if switching from Claude → Codex
    let contextBridgePrompt: string | undefined;
    const switchSource = detectBackendSwitch(session_id, 'codex');
    if (switchSource) {
      const bridge = buildIncrementalBridge(session_id, 'codex', switchSource);
      if (bridge) {
        contextBridgePrompt = bridge;
      }
    }

    const abortController = new AbortController();
    registerAbort(session_id, abortController);

    // Convert file attachments to the format expected by streamCodex.
    // Path references carry originalPath and need no disk copy.
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

    // Stream Codex response
    const stream = streamCodex({
      prompt: prompt || content,
      sessionId: session_id,
      codexThreadId: session.codex_thread_id || undefined,
      model: effectiveModel,
      workingDirectory: session.working_directory || undefined,
      abortController,
      files: fileAttachments,
      contextBridgePrompt,
      effort: effort || undefined,
      skills: codexSkills,
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
  let currentThinking = '';
  let tokenUsage: TokenUsage | null = null;

  // Initialise the in-memory streaming buffer so the recovery-polling
  // status endpoint can return intermediate output to the client.
  initStreamBuffer(sessionId);

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
            } else if (event.type === 'tool_output') {
              // Not saved as message content, but capture progress for the
              // streaming buffer so recovery can show "Running bash... (5s)".
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
            } else if (event.type === 'thinking') {
              currentThinking += event.data;
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
              } catch {
                // skip malformed tool_result data
              }
            } else if (event.type === 'status') {
              // Codex status events — no session_id tracking (that's Claude-specific)
              try {
                const statusData = JSON.parse(event.data);
                if (statusData.notification) {
                  setStreamStatusText(sessionId, statusData.message || statusData.title || undefined);
                } else if (statusData.message) {
                  setStreamStatusText(sessionId, statusData.message);
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

    // Flush any accumulated thinking
    if (currentThinking.trim()) {
      contentBlocks.unshift({ type: 'thinking', text: currentThinking });
    }

    // Flush any remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    if (contentBlocks.length > 0) {
      // If the message is text-only (no tool calls), store as plain text
      // for backward compatibility with existing message rendering.
      // If it contains tool calls, store as structured JSON.
      const hasStructuredBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking'
      );

      const content = hasStructuredBlocks
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
          'codex',
        );
      }
    }
  } catch {
    // Stream reading error - best effort save
    if (currentThinking.trim()) {
      contentBlocks.unshift({ type: 'thinking', text: currentThinking });
    }
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasStructuredBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking'
      );
      const content = hasStructuredBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
      if (content) {
        addMessage(sessionId, 'assistant', content, null, 'codex');
      }
    }
  } finally {
    // Always clean up the streaming buffer when the stream ends
    clearStreamBuffer(sessionId);
  }
}
