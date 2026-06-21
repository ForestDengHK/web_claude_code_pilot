import { NextRequest } from 'next/server';
import { streamChannels } from '@/lib/channels-client';
import {
  parseCodexDashboardCommand as parseDashboardCommand,
  buildCodexDashboardPrompt as buildDashboardEntryPrompt,
  defaultDashboardEntryPath,
  type CodexDashboardRequest as DashboardEntryRequest,
} from '@/lib/codex-artifacts';
import { addMessage, addDraftMessage, updateDraftMessage, finalizeDraftMessage, getDb, getSession, updateSessionTitle, updateSdkSessionId, getSetting, isMemoryEnabled, buildMemoryContext, hasSessionInjectedMemory, markSessionMemoryInjected } from '@/lib/db';
import { sendPushNotification } from '@/lib/push-notifications';
import { registerAbort, unregisterAbort } from '@/lib/abort-registry';
import { killSession as killChannelSession } from '@/lib/channels/session-manager';
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
    const body: SendMessageRequest & { files?: FileAttachment[]; effort?: string; fastMode?: boolean } = await request.json();
    const { session_id, content, prompt, model, files, effort, fastMode } = body;

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
    addMessage(session_id, 'user', savedContent, null, 'channels');

    // Auto-generate title from first message if still default.
    // CJK characters are visually wider so we cap at 10 chars,
    // pure ASCII gets up to 15 chars. This keeps sidebar titles readable on mobile.
    if (session.title === 'New Chat') {
      const firstLine = content.split('\n')[0].trim();
      const hasCJK = /[　-鿿가-힯豈-﫿]/.test(firstLine);
      const limit = hasCJK ? 10 : 15;
      const title = firstLine.length > limit
        ? firstLine.slice(0, limit) + '…'
        : firstLine || content.slice(0, limit);
      updateSessionTitle(session_id, title);
    }

    // Determine model: request override > session model > default setting
    const effectiveModel = model || session.model || getSetting('default_model') || undefined;

    // Phase 2: tier-switch bridging handled by the tier orchestrator

    const abortController = new AbortController();

    // Register this controller so the user's Stop button (POST /api/chat/stop)
    // can abort the Claude process explicitly.
    // We intentionally do NOT bind request.signal here: mobile browsers drop the
    // SSE socket when the app is backgrounded, and we don't want that to kill
    // the Claude Code subprocess — it should keep running so that when the user
    // returns and recovery polling kicks in, the full response is already in the DB.
    registerAbort(session_id, abortController);

    // Wire the AbortController to actually terminate the channel turn. The T1
    // (channels) protocol has no turn-level interrupt primitive — `claude
    // --channels` exposes no "cancel current turn" command — so the only way
    // to stop an in-flight turn is to SIGKILL the underlying PTY process.
    //
    // Two layers cooperate here:
    //  1. The signal is forwarded into `streamChannels` (below) so the
    //     streaming side fails fast and closes the SSE stream immediately
    //     (otherwise we'd wait ~150s for the stall watchdog).
    //  2. This belt-and-braces listener ensures the PTY is actually reaped
    //     even if the stream-side fail path somehow misses (e.g. abort fires
    //     before ensureSession resolves, or `failAndKill` early-returns).
    //
    // Session state is preserved on disk so the conversation survives:
    //  - `channel_session_id` lives in SQLite
    //  - the transcript .jsonl keeps full history
    //  - the next user message respawns the PTY via `--resume`
    //
    // Consequences for T1:
    //  - Stop and Force Stop are equivalent (no graceful half-step).
    //  - Next message has ~10s respawn latency.
    //  - A partial tool_use may remain in the transcript; the resumed model
    //    handles it as it would any abrupt termination.
    //
    // T2 (Claude SDK) is unaffected: it goes through `interruptSession()` →
    // `q.interrupt()` for graceful stop and never touches this signal.
    abortController.signal.addEventListener('abort', () => {
      try { killChannelSession(session_id); } catch { /* best effort */ }
    }, { once: true });

    // Stream Channels response.
    // Use `prompt` (skill-injected content) if provided, otherwise plain `content`.
    let effectivePrompt = prompt || content;

    // `/dashboard`: T1 has no in-process MCP tool, so (like Codex) we ask the
    // model to write ONE JSON entry file and scan + publish it after the turn.
    let dashboardRequest: DashboardEntryRequest | undefined;
    const dashboardCommand = parseDashboardCommand(content.trim());
    if (dashboardCommand) {
      const filePath = defaultDashboardEntryPath();
      effectivePrompt = buildDashboardEntryPrompt(dashboardCommand.userContext, filePath);
      dashboardRequest = { filePath };
    }

    // Inject branch summary as context prefix on the first message of a branched session.
    // Only inject when there is no sdk_session_id yet (first turn — subsequent turns use resume).
    if (session.branch_summary && !session.sdk_session_id) {
      effectivePrompt = `[Context from previous conversation]\n---\n${session.branch_summary}\n---\n\n${effectivePrompt}`;
    }

    // Inject memory context at most once per session, regardless of backend switches.
    // Mirrors the T2 (claude SDK) route — T1 has no built-in memory, so without this
    // toggling Memory ON in the UI would be a no-op when the channels backend is active.
    if (!hasSessionInjectedMemory(session_id) && isMemoryEnabled(session_id) && session.working_directory) {
      const memoryContext = buildMemoryContext(session.working_directory);
      if (memoryContext) {
        effectivePrompt = `${memoryContext}\n\n---\n\n${effectivePrompt}`;
        markSessionMemoryInjected(session_id);
      }
    }

    // Forward attached files to the Channels turn. The channel transport is
    // text-only (no image/binary blocks), so instead we list the on-disk paths
    // and let the model open them with the Read tool — Read handles images too.
    // Uploads live in .codepilot-uploads/; path-refs point at tree-picked files.
    const attachedPaths = [
      ...(fileMeta?.map(f => ({ name: f.name, path: f.filePath })) ?? []),
      ...pathRefs.map(r => ({ name: r.name, path: r.originalPath })),
    ];
    if (attachedPaths.length > 0) {
      const list = attachedPaths.map(f => `- ${f.name}: ${f.path}`).join('\n');
      effectivePrompt = `${effectivePrompt}\n\n[Attached files — use the Read tool to open them:\n${list}\n]`;
    }

    const internalUrl = new URL(request.url).origin;

    const stream = streamChannels({
      prompt: effectivePrompt,
      sessionId: session_id,
      workingDirectory: session.working_directory,
      model: effectiveModel,
      internalUrl,
      mode: session.mode || undefined,
      systemPrompt: session.system_prompt || undefined,
      effort,
      fastMode,
      skipPermissions: session.skip_permissions === 1,
      abortSignal: abortController.signal,
      dashboardRequest,
    });

    // Tee the stream: one for client, one for collecting the response
    const [streamForClient, streamForCollect] = stream.tee();

    // Save assistant message in background; clean up abort registry when done
    collectStreamResponse(streamForCollect, session_id).finally(() => {
      unregisterAbort(session_id);
    });

    // Pipe client stream through a transform that injects a synthetic
    // tier_exhausted event immediately after the first rate_limit event.
    let rateLimitSeen = false;
    const tierExhaustedLine =
      'data: ' +
      JSON.stringify({
        type: 'tier_exhausted',
        data: JSON.stringify({ from: 'channels', to: 'claude' }),
      }) +
      '\n\n';
    const transform = new TransformStream<string, string>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (!rateLimitSeen) {
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === 'rate_limit') {
                  rateLimitSeen = true;
                  controller.enqueue(tierExhaustedLine);
                  break;
                }
              } catch {
                // skip malformed line
              }
            }
          }
        }
      },
    });

    return new Response(streamForClient.pipeThrough(transform), {
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
  // Adaptive-thinking summary text streamed from Claude when the user has
  // `show_thinking_text` enabled (SDK ≥ 0.2.112, Opus 4.7 / Sonnet 4.6+).
  // Mirrors the Codex route's handling so the rendered message shape — a
  // leading `{ type: 'thinking', text }` block — is identical across backends.
  let currentThinking = '';
  let tokenUsage: TokenUsage | null = null;
  let draftMessageId: string | null = null;
  let lastCheckpointTime = 0;
  const CHECKPOINT_INTERVAL_MS = 10_000; // Save draft every 10s

  // Initialise the in-memory streaming buffer so the recovery-polling
  // status endpoint can return intermediate output to the client.
  initStreamBuffer(sessionId);

  /**
   * Predicate matching the serialization rule shared with the Codex route:
   * any non-text block (tool_use / tool_result / thinking) forces JSON
   * storage so block structure survives the round-trip, otherwise we fall
   * back to plain concatenated text for backward compatibility.
   */
  function isStructuredBlock(b: MessageContentBlock): boolean {
    return b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'thinking';
  }

  /** Build the content string from current accumulated blocks. */
  function buildContent(): string {
    const blocks = [...contentBlocks];
    if (currentText.trim()) {
      blocks.push({ type: 'text', text: currentText });
    }
    if (blocks.length === 0) return '';
    const hasStructuredBlocks = blocks.some(isStructuredBlock);
    if (hasStructuredBlocks) return JSON.stringify(blocks);
    return blocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
  }

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

  /** Save or update draft in DB. */
  function checkpoint(): void {
    const content = buildContent();
    if (!content) return;
    if (!draftMessageId) {
      const draft = addDraftMessage(sessionId, content, 'channels');
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
            } else if (event.type === 'thinking') {
              // Accumulate summarized reasoning deltas. Persisted as a leading
              // `{ type: 'thinking', text }` content block when the message is
              // finalized — matches the Codex route exactly so MessageItem's
              // parser renders both backends identically.
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
            } else if (event.type === 'error') {
              // A failed turn (stall / timeout / transport error) must still
              // leave an assistant message in the DB. Otherwise the last row
              // stays a bare 'user' message and the /status `dbHint` keeps
              // reporting the session as busy for 5 minutes, trapping recovery
              // polling so the composer never resets.
              currentText += (currentText ? '\n\n' : '') + '⚠️ ' + event.data;
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    }

    // Flush any accumulated adaptive-thinking summary as a leading block so
    // it renders above the text in MessageItem (same shape Codex uses).
    if (currentThinking.trim()) {
      contentBlocks.unshift({ type: 'thinking', text: currentThinking });
    }

    // Flush any remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    if (contentBlocks.length > 0) {
      const hasStructuredBlocks = contentBlocks.some(isStructuredBlock);

      const content = hasStructuredBlocks
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
            'channels',
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
    if (currentThinking.trim()) {
      contentBlocks.unshift({ type: 'thinking', text: currentThinking });
    }
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasStructuredBlocks = contentBlocks.some(isStructuredBlock);
      const content = hasStructuredBlocks
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
          addMessage(sessionId, 'assistant', content, null, 'channels');
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
