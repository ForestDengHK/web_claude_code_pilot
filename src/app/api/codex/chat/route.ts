import { NextRequest } from 'next/server';
import { streamCodex, streamCodexGoalAction, type CodexSkillRef } from '@/lib/codex-client';
import { buildCodexArtifactPrompt, defaultArtifactOutputPath, parseCodexArtifactCommand, buildCodexDashboardPrompt, defaultDashboardEntryPath, parseCodexDashboardCommand, type CodexArtifactRequest, type CodexDashboardRequest } from '@/lib/codex-artifacts';
import { detectBackendSwitch, buildIncrementalBridge } from '@/lib/context-bridge';
import { addMessage, getSession, updateSessionTitle, isMemoryEnabled, buildMemoryContext, hasSessionInjectedMemory, markSessionMemoryInjected } from '@/lib/db';
import { normalizeCodexMode } from '@/lib/permission-modes';
import { sendPushNotification } from '@/lib/push-notifications';
import { getCodePilotDataDir } from '@/lib/data-dir';
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
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body: SendMessageRequest & { files?: FileAttachment[]; toolTimeout?: number; effort?: string; codexSkills?: CodexSkillRef[] } = await request.json();
    const { session_id, content, prompt, model, mode, files, effort, codexSkills } = body;

    console.log('[codex/chat] Received effort:', JSON.stringify(effort), 'model:', model, 'mode:', mode);

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

    // Stream Codex response. Branch on Codex `/goal` slash forms:
    //   `/goal` / `/goal status` / `/goal clear` → no model turn, just
    //     `thread/goal/{get,clear}` JSON-RPC; synthetic SSE response.
    //   `/goal <objective>`                      → set goal AND start a turn.
    //   anything else                            → regular turn.
    let stream: ReadableStream<string>;
    const trimmedContent = (typeof content === 'string' ? content : '').trim();

    if (trimmedContent === '/goal' || trimmedContent === '/goal status' || trimmedContent === '/goal clear') {
      const action: 'status' | 'clear' = trimmedContent === '/goal clear' ? 'clear' : 'status';
      stream = streamCodexGoalAction({
        sessionId: session_id,
        codexThreadId: session.codex_thread_id || undefined,
        action,
      });
    } else {
      let effectivePrompt = prompt || content;
      let artifactRequest: CodexArtifactRequest | undefined;
      let dashboardRequest: CodexDashboardRequest | undefined;
      const artifactCommand = parseCodexArtifactCommand(trimmedContent);
      const dashboardCommand = artifactCommand ? null : parseCodexDashboardCommand(trimmedContent);
      if (artifactCommand) {
        const filePath = defaultArtifactOutputPath();
        effectivePrompt = buildCodexArtifactPrompt(artifactCommand.userContext, artifactCommand.artifactId, filePath);
        artifactRequest = {
          filePath,
          title: 'Codex Artifact',
          favicon: '📊',
          label: artifactCommand.artifactId ? 'update' : 'initial',
          ...(artifactCommand.artifactId ? { artifactId: artifactCommand.artifactId } : {}),
        };
      } else if (dashboardCommand) {
        const filePath = defaultDashboardEntryPath();
        effectivePrompt = buildCodexDashboardPrompt(dashboardCommand.userContext, filePath);
        dashboardRequest = { filePath };
      }
      let goalObjective: string | undefined;
      const goalMatch = trimmedContent.match(/^\/goal\s+([\s\S]+)$/);
      if (goalMatch) {
        const objective = goalMatch[1]?.trim();
        if (objective) {
          goalObjective = objective;
          effectivePrompt = objective;
        }
      }

      // Inject branch summary on the first turn of a branched session.
      if (session.branch_summary && !session.codex_thread_id) {
        effectivePrompt = `[Context from previous conversation]\n---\n${session.branch_summary}\n---\n\n${effectivePrompt}`;
      }

      if (contextBridgePrompt) {
        effectivePrompt = `${contextBridgePrompt}\n\n---\n\n${effectivePrompt}`;
      }

      // Inject memory context at most once per session, regardless of backend switches.
      if (!hasSessionInjectedMemory(session_id) && isMemoryEnabled(session_id) && session.working_directory) {
        const memoryContext = buildMemoryContext(session.working_directory);
        if (memoryContext) {
          effectivePrompt = `${memoryContext}\n\n---\n\n${effectivePrompt}`;
          markSessionMemoryInjected(session_id);
        }
      }

      // Working mode maps to Codex's approval_policy. Shield (skip_permissions)
      // still wins and overrides to 'never' inside codex-client. We normalize
      // here so any stale Claude-vocabulary value (e.g. leftover 'acceptEdits'
      // after a backend switch) falls back to the Codex default rather than
      // silently reaching the SDK.
      const approvalPolicy = normalizeCodexMode(mode || session.mode);

      stream = streamCodex({
        prompt: effectivePrompt,
        sessionId: session_id,
        codexThreadId: session.codex_thread_id || undefined,
        model: effectiveModel,
        workingDirectory: session.working_directory || undefined,
        abortController,
        files: fileAttachments,
        contextBridgePrompt: undefined,
        effort: effort || undefined,
        skills: codexSkills,
        artifactRequest,
        dashboardRequest,
        skipPermissions: session.skip_permissions === 1,
        approvalPolicy,
        goalObjective,
      });
    }

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

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.heif', '.avif']);

async function persistCodexImage(imagePath: string, sessionId: string): Promise<string> {
  try {
    const session = getSession(sessionId);
    const resolvedPath = path.isAbsolute(imagePath)
      ? path.resolve(imagePath)
      : path.resolve(session?.working_directory || process.cwd(), imagePath);
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return imagePath;

    const dataDir = getCodePilotDataDir();
    const cacheRoot = path.join(dataDir, 'codex-images');
    if (resolvedPath === cacheRoot || resolvedPath.startsWith(cacheRoot + path.sep)) {
      return resolvedPath;
    }

    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) return imagePath;

    const hash = crypto
      .createHash('sha256')
      .update(`${resolvedPath}\0${stat.size}\0${stat.mtimeMs}`)
      .digest('hex')
      .slice(0, 16);
    const safeName = path.basename(resolvedPath).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destDir = path.join(cacheRoot, sessionId);
    const destPath = path.join(destDir, `${hash}-${safeName}`);

    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(resolvedPath, destPath);
    return destPath;
  } catch {
    return imagePath;
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

  function hasToolUseBlock(toolId: string): boolean {
    return contentBlocks.some(
      (block) => block.type === 'tool_use' && block.id === toolId,
    );
  }

  function hasToolResultBlock(toolUseId: string): boolean {
    return contentBlocks.some(
      (block) => block.type === 'tool_result' && block.tool_use_id === toolUseId,
    );
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
                if (!hasToolUseBlock(toolData.id)) {
                  contentBlocks.push({
                    type: 'tool_use',
                    id: toolData.id,
                    name: toolData.name,
                    input: toolData.input,
                  });
                }
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
                if (!hasToolResultBlock(resultData.tool_use_id)) {
                  contentBlocks.push({
                    type: 'tool_result',
                    tool_use_id: resultData.tool_use_id,
                    content: resultData.content,
                    is_error: resultData.is_error || false,
                  });
                }
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
            } else if (event.type === 'image') {
              try {
                const imgData = JSON.parse(event.data);
                if (typeof imgData.path === 'string') {
                  const persistedPath = await persistCodexImage(imgData.path, sessionId);
                  // Flush accumulated text first so the image renders after it.
                  if (currentText.trim()) {
                    contentBlocks.push({ type: 'text', text: currentText });
                    currentText = '';
                  }
                  contentBlocks.push({ type: 'image', path: persistedPath, ...(imgData.alt ? { alt: imgData.alt } : {}) });
                }
              } catch {
                // skip malformed image data
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
        (b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking' || b.type === 'image'
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
    // Stream reading error - best effort save
    if (currentThinking.trim()) {
      contentBlocks.unshift({ type: 'thinking', text: currentThinking });
    }
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasStructuredBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking' || b.type === 'image'
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
