/**
 * Core streaming client for the Codex App Server integration.
 *
 * Mirrors `streamClaude()` — returns a `ReadableStream<string>` of SSE-formatted
 * lines. Internally communicates with a `codex app-server` subprocess via JSON-RPC
 * over stdio, translating Codex events into the same SSE event format the frontend
 * already understands.
 */

import type {
  SSEEvent,
  FileAttachment,
  PermissionRequestEvent,
} from '@/types';
import {
  formatJsonRpcRequest,
  formatJsonRpcResponse,
  getLastRequestId,
  type JsonRpcMessage,
} from '@/lib/codex-jsonrpc';
import { CodexProcessManager, type CodexProcess } from '@/lib/codex-process-manager';
import { registerPendingCodexApproval } from '@/lib/codex-approval-registry';
import { updateCodexThreadId, getSession } from '@/lib/db';
import { sendPushNotification } from './push-notifications';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Skill reference resolved by the frontend from `$skill-name` in user input. */
export interface CodexSkillRef {
  name: string;
  path: string;
}

export interface CodexStreamOptions {
  prompt: string;
  sessionId: string;
  codexThreadId?: string;
  model?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  files?: FileAttachment[];
  contextBridgePrompt?: string;
  /** Reasoning effort override (e.g. "low", "medium", "high", "xhigh"). */
  effort?: string;
  /** Reasoning summary style: "auto", "concise", "detailed", "none". */
  summary?: string;
  /** Codex skills resolved from `$skill-name` references in the prompt. */
  skills?: CodexSkillRef[];
}

// Codex app-server UserInput union (v2 protocol)
type CodexUserInput =
  | { type: 'text'; text: string; text_elements?: unknown[] }
  | { type: 'skill'; name: string; path: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function generateApprovalId(): string {
  return `codex-approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build UserInput[] from prompt, optional context bridge prompt, file refs,
 * and Codex skill references.
 *
 * Skill refs (`$skill-name`) are extracted and sent as structured
 * `{ type: 'skill', name, path }` items so the Codex app-server loads
 * the skill's SKILL.md content into the agent's context.
 */
function buildUserInputs(
  prompt: string,
  contextBridgePrompt?: string,
  files?: FileAttachment[],
  skills?: CodexSkillRef[],
): CodexUserInput[] {
  const inputs: CodexUserInput[] = [];

  // Context bridge prompt first (provides Claude conversation context)
  if (contextBridgePrompt) {
    inputs.push({ type: 'text', text: contextBridgePrompt });
  }

  // Codex skill references — emitted before the text prompt so the
  // app-server injects skill instructions into context first.
  if (skills && skills.length > 0) {
    for (const skill of skills) {
      inputs.push({ type: 'skill', name: skill.name, path: skill.path });
    }
  }

  // File references
  if (files && files.length > 0) {
    const PATH_REF_TYPES = new Set(['text/x-directory-ref', 'text/x-file-ref']);
    const references: string[] = [];

    for (const file of files) {
      if (PATH_REF_TYPES.has(file.type)) {
        const originalPath = file.filePath || '';
        if (file.type === 'text/x-directory-ref') {
          references.push(`Directory: ${originalPath}`);
        } else {
          references.push(`File: ${originalPath}`);
        }
      } else if (file.filePath) {
        references.push(`File: ${file.filePath} (${file.name})`);
      }
    }

    if (references.length > 0) {
      inputs.push({
        type: 'text',
        text: `The user has attached the following files/directories for context:\n\n${references.join('\n')}`,
      });
    }
  }

  // Main user prompt
  inputs.push({ type: 'text', text: prompt });

  return inputs;
}

// ---------------------------------------------------------------------------
// Main streaming function
// ---------------------------------------------------------------------------

export function streamCodex(options: CodexStreamOptions): ReadableStream<string> {
  const {
    prompt,
    sessionId,
    codexThreadId,
    model,
    workingDirectory,
    abortController,
    files,
    contextBridgePrompt,
    effort,
    summary,
    skills,
  } = options;

  let heartbeatInterval: ReturnType<typeof setInterval>;

  return new ReadableStream<string>({
    async start(controller) {
      let codexProcess: CodexProcess | null = null;
      let messageHandler: ((msg: JsonRpcMessage) => void) | null = null;

      // Heartbeat: send periodic keepalive so the client can detect dead connections
      heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(formatSSE({ type: 'heartbeat', data: '' }));
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 10_000);

      try {
        // 1. Get or spawn the app-server process
        codexProcess = await CodexProcessManager.getOrCreate(sessionId);

        // Determine the thread ID to use
        let threadId = codexProcess.threadId || codexThreadId || null;
        const isNewThread = !threadId;
        const isResumedThread = !!threadId && !codexProcess.threadId;

        // 2. Thread lifecycle: start or resume
        if (isNewThread) {
          // Start a new thread
          threadId = await startThread(codexProcess, sessionId, model, workingDirectory, effort);
        } else if (isResumedThread && threadId) {
          // Resume an existing thread on a new process
          await resumeThread(codexProcess, threadId);
          codexProcess.threadId = threadId;
        }

        if (!threadId) {
          throw new Error('Failed to obtain Codex thread ID');
        }

        // 3. Build user inputs
        const userInputs = buildUserInputs(prompt, contextBridgePrompt, files, skills);

        // 4. Set up abort handling
        if (abortController) {
          const onAbort = () => {
            if (codexProcess && threadId) {
              codexProcess.send(
                formatJsonRpcRequest('turn/interrupt', { threadId }),
              );
            }
          };
          abortController.signal.addEventListener('abort', onAbort, { once: true });
        }

        // 5. Send turn/start and listen for events
        await new Promise<void>((resolve, reject) => {
          if (!codexProcess || !threadId) {
            reject(new Error('No Codex process or thread ID'));
            return;
          }

          // Send turn/start
          const turnStartParams: Record<string, unknown> = {
            threadId,
            input: userInputs,
          };
          if (workingDirectory) turnStartParams.cwd = workingDirectory;
          if (model) turnStartParams.model = model;
          // Always send reasoning effort to override ~/.codex/config.toml global default.
          // Schema field name is "effort" (NOT "modelReasoningEffort" — that was wrong).
          {
            const requestedEffort = effort || 'high';
            const isMini = model && /mini/i.test(model);
            // Mini models only support low/medium/high (not xhigh)
            const validEffort = isMini && requestedEffort === 'xhigh' ? 'high' : requestedEffort;
            turnStartParams.effort = validEffort;
          }
          // Reasoning summary: mini only supports 'detailed'; others default to 'concise'
          {
            const isMini = model && /mini/i.test(model);
            turnStartParams.summary = isMini ? 'detailed' : (summary || 'concise');
          }

          console.log('[codex-client] turn/start params:', JSON.stringify({ model: turnStartParams.model, effort: turnStartParams.effort, summary: turnStartParams.summary }));
          codexProcess.send(
            formatJsonRpcRequest('turn/start', turnStartParams),
          );

          // Track whether the new codex/event/* protocol is active for this turn.
          // When active, skip old item/reasoning/summaryTextDelta to avoid duplicate thinking.
          // Per-turn flag (not module-level) so switching models works correctly.
          const turnCtx = { useNewReasoningProtocol: false };

          // Message handler for all events during this turn
          messageHandler = (msg: JsonRpcMessage) => {
            try {
              handleCodexMessage(msg, controller, codexProcess!, sessionId, threadId!, resolve, reject, abortController?.signal, turnCtx);
            } catch (err) {
              reject(err);
            }
          };

          codexProcess.onMessage(messageHandler);
        });

        // Turn completed successfully
        clearInterval(heartbeatInterval);
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } catch (error) {
        clearInterval(heartbeatInterval);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        controller.enqueue(formatSSE({ type: 'error', data: errorMessage }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } finally {
        // Clean up message handler
        if (codexProcess && messageHandler) {
          codexProcess.offMessage(messageHandler);
        }
      }
    },

    cancel() {
      clearInterval(heartbeatInterval);
      abortController?.abort();
    },
  });
}

// ---------------------------------------------------------------------------
// Thread lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Start a new Codex thread. Sends `thread/start` and waits for the
 * `thread/started` notification. Returns the new thread ID.
 */
function startThread(
  codexProcess: CodexProcess,
  sessionId: string,
  model?: string,
  cwd?: string,
  effort?: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      codexProcess.offMessage(handler);
      reject(new Error('thread/start timed out after 30s'));
    }, 30_000);

    const handler = (msg: JsonRpcMessage) => {
      if (
        msg.type === 'notification' &&
        msg.method === 'thread/started'
      ) {
        clearTimeout(timeout);
        codexProcess.offMessage(handler);

        const thread = msg.params.thread as { id: string } | undefined;
        if (!thread?.id) {
          reject(new Error('thread/started notification missing thread.id'));
          return;
        }

        const threadId = thread.id;
        codexProcess.threadId = threadId;
        updateCodexThreadId(sessionId, threadId);
        resolve(threadId);
      }
    };

    codexProcess.onMessage(handler);

    const params: Record<string, unknown> = {};
    if (model) params.model = model;
    if (cwd) params.cwd = cwd;
    // Pass effort via config to override config.toml default at thread creation
    if (effort) {
      params.config = { model_reasoning_effort: effort };
    }

    codexProcess.send(formatJsonRpcRequest('thread/start', params));
  });
}

/**
 * Resume an existing thread on a (possibly new) process.
 * Sends `thread/resume` and waits for the response.
 */
function resumeThread(
  codexProcess: CodexProcess,
  threadId: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // IMPORTANT: These two calls must stay adjacent — getLastRequestId()
    // returns the id from the most recent formatJsonRpcRequest call.
    // Any intervening formatJsonRpcRequest call would corrupt the id.
    const resumeReq = formatJsonRpcRequest('thread/resume', {
      threadId,
      persistExtendedHistory: false,
    });
    const resumeId = getLastRequestId();

    const timeout = setTimeout(() => {
      codexProcess.offMessage(handler);
      reject(new Error('thread/resume timed out after 30s'));
    }, 30_000);

    const handler = (msg: JsonRpcMessage) => {
      if (msg.type === 'response' && msg.id === resumeId) {
        clearTimeout(timeout);
        codexProcess.offMessage(handler);

        if (msg.error) {
          reject(new Error(`thread/resume failed: ${msg.error.message}`));
          return;
        }

        resolve();
      }
    };

    codexProcess.onMessage(handler);
    codexProcess.send(resumeReq);
  });
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

/**
 * Handle a single JSON-RPC message from the Codex app-server.
 * Translates to SSE events and enqueues them on the controller.
 */
function handleCodexMessage(
  msg: JsonRpcMessage,
  controller: ReadableStreamDefaultController<string>,
  codexProcess: CodexProcess,
  sessionId: string,
  threadId: string,
  onTurnComplete: () => void,
  onError: (err: Error) => void,
  abortSignal?: AbortSignal,
  turnCtx: { useNewReasoningProtocol: boolean } = { useNewReasoningProtocol: false },
): void {
  // --- Notifications (server push) ---
  if (msg.type === 'notification') {
    switch (msg.method) {
      // Text delta from agent message
      case 'item/agentMessage/delta': {
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'text', data: delta }));
        }
        break;
      }

      // Plan delta — render as regular text
      case 'item/plan/delta': {
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'text', data: delta }));
        }
        break;
      }

      // Raw reasoning delta — show as status so the user sees thinking progress
      case 'item/reasoning/textDelta': {
        const delta = msg.params.delta as string;
        if (delta) {
          // Extract a brief snippet for the status bar (last ~60 chars)
          const snippet = delta.replace(/\n/g, ' ').trim();
          if (snippet) {
            controller.enqueue(formatSSE({
              type: 'status',
              data: JSON.stringify({ notification: true, message: `Thinking: ${snippet.slice(0, 80)}${snippet.length > 80 ? '…' : ''}` }),
            }));
          }
        }
        break;
      }

      // Reasoning summary — stream as thinking block, separate from response
      // Skip if new codex/event/reasoning_content_delta is active (avoids duplicates)
      case 'item/reasoning/summaryTextDelta': {
        if (turnCtx.useNewReasoningProtocol) break;
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'thinking', data: delta }));
        }
        break;
      }

      // Reasoning summary part added — signal thinking phase completed
      case 'item/reasoning/summaryPartAdded': {
        // No-op: the summary text has already been streamed via summaryTextDelta
        break;
      }

      // Item started — could be commandExecution or fileChange
      case 'item/started': {
        const item = msg.params.item as Record<string, unknown>;
        if (!item) break;

        if (item.type === 'commandExecution') {
          controller.enqueue(formatSSE({
            type: 'tool_use',
            data: JSON.stringify({
              id: item.id,
              name: 'command',
              input: {
                command: item.command,
                cwd: item.cwd,
              },
            }),
          }));
        } else if (item.type === 'fileChange') {
          controller.enqueue(formatSSE({
            type: 'tool_use',
            data: JSON.stringify({
              id: item.id,
              name: 'file_edit',
              input: {
                changes: item.changes,
              },
            }),
          }));
        }
        break;
      }

      // Command execution output delta
      case 'item/commandExecution/outputDelta': {
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'tool_output', data: delta }));
        }
        break;
      }

      // File change output delta
      case 'item/fileChange/outputDelta': {
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'tool_output', data: delta }));
        }
        break;
      }

      // Item completed — could be commandExecution or fileChange
      case 'item/completed': {
        const item = msg.params.item as Record<string, unknown>;
        if (!item) break;

        if (item.type === 'commandExecution') {
          controller.enqueue(formatSSE({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: item.id,
              content: item.aggregatedOutput || '',
              is_error: (item.exitCode as number) !== 0,
              exit_code: item.exitCode,
              duration_ms: item.durationMs,
            }),
          }));
        } else if (item.type === 'fileChange') {
          controller.enqueue(formatSSE({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: item.id,
              content: JSON.stringify(item.changes || []),
              is_error: item.status === 'failed',
            }),
          }));
        }
        break;
      }

      // Turn completed — extract usage and signal done
      case 'turn/completed': {
        const turn = msg.params.turn as Record<string, unknown> | undefined;
        const turnError = turn?.error as { message?: string } | null;
        const resultPayload: Record<string, unknown> = {
          subtype: turnError ? 'error' : 'success',
        };

        if (turnError) {
          resultPayload.is_error = true;
          resultPayload.errors = [turnError.message || 'Unknown turn error'];
        }

        if (turn) {
          // Extract token usage if available
          const usage = turn.usage as Record<string, unknown> | undefined;
          if (usage) {
            resultPayload.usage = {
              input_tokens: usage.input_tokens ?? 0,
              output_tokens: usage.output_tokens ?? 0,
              cache_read_input_tokens: usage.cached_input_tokens ?? 0,
              cache_creation_input_tokens: 0,
            };
          }
        }

        controller.enqueue(formatSSE({
          type: 'result',
          data: JSON.stringify(resultPayload),
        }));

        // If the turn had an error, route to the error path so the outer
        // catch block handles cleanup correctly (no false-success 'done').
        if (turnError) {
          onError(new Error(turnError.message || 'Turn completed with error'));
        } else {
          onTurnComplete();
        }
        break;
      }

      // Error notification
      case 'error': {
        const error = msg.params.error as { message?: string } | undefined;
        const willRetry = msg.params.willRetry as boolean;
        const errorMsg = error?.message || 'Unknown Codex error';

        if (!willRetry) {
          controller.enqueue(formatSSE({
            type: 'error',
            data: errorMsg,
          }));
          onError(new Error(errorMsg));
        } else {
          // Transient error — log as status, Codex will retry
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({ message: `Codex error (retrying): ${errorMsg}` }),
          }));
        }
        break;
      }

      // ---------------------------------------------------------------
      // New codex/event/* protocol (gpt-5.4+, supplementary to item/*)
      // These carry richer data and are the primary source for reasoning
      // content on newer models. The payload is in msg.params.msg.
      // ---------------------------------------------------------------

      // Reasoning content delta — stream as thinking block (primary source on 5.4+)
      case 'codex/event/reasoning_content_delta': {
        turnCtx.useNewReasoningProtocol = true; // Flag to skip old summaryTextDelta duplicates
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const delta = inner?.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'thinking', data: delta }));
        }
        break;
      }

      // Agent reasoning delta — show as status snippet
      case 'codex/event/agent_reasoning_delta': {
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const delta = inner?.delta as string;
        if (delta) {
          const snippet = delta.replace(/\n/g, ' ').trim();
          if (snippet) {
            controller.enqueue(formatSSE({
              type: 'status',
              data: JSON.stringify({ notification: true, message: `Thinking: ${snippet.slice(0, 80)}${snippet.length > 80 ? '…' : ''}` }),
            }));
          }
        }
        break;
      }

      // Agent reasoning complete — full reasoning text (no-op, already streamed via deltas)
      case 'codex/event/agent_reasoning':
      // Section break between reasoning blocks
      case 'codex/event/agent_reasoning_section_break':
        break;

      // Item lifecycle events (v2) — map to tool_use/tool_result like old item/* events
      case 'codex/event/item_started': {
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const item = inner?.item as Record<string, unknown> | undefined;
        if (!item) break;

        if (item.type === 'CommandExecution' || item.type === 'commandExecution') {
          controller.enqueue(formatSSE({
            type: 'tool_use',
            data: JSON.stringify({
              id: item.id,
              name: 'command',
              input: { command: item.command, cwd: item.cwd },
            }),
          }));
        } else if (item.type === 'FileChange' || item.type === 'fileChange') {
          controller.enqueue(formatSSE({
            type: 'tool_use',
            data: JSON.stringify({
              id: item.id,
              name: 'file_edit',
              input: { changes: item.changes },
            }),
          }));
        } else if (item.type === 'WebSearch' || item.type === 'webSearch') {
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({ message: 'Searching the web...' }),
          }));
        }
        break;
      }

      case 'codex/event/item_completed': {
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const item = inner?.item as Record<string, unknown> | undefined;
        if (!item) break;

        if (item.type === 'CommandExecution' || item.type === 'commandExecution') {
          controller.enqueue(formatSSE({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: item.id,
              content: item.aggregatedOutput || item.output || '',
              is_error: (item.exitCode as number) !== 0,
              exit_code: item.exitCode,
            }),
          }));
        } else if (item.type === 'FileChange' || item.type === 'fileChange') {
          controller.enqueue(formatSSE({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: item.id,
              content: JSON.stringify(item.changes || []),
              is_error: item.status === 'failed',
            }),
          }));
        }
        // WebSearch completion — no specific tool_result needed
        break;
      }

      // Web search lifecycle events — show as status
      case 'codex/event/web_search_begin': {
        controller.enqueue(formatSSE({
          type: 'status',
          data: JSON.stringify({ message: 'Searching the web...' }),
        }));
        break;
      }

      case 'codex/event/web_search_end': {
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const query = inner?.query as string;
        if (query) {
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({ message: `Web search: ${query.slice(0, 80)}` }),
          }));
        }
        break;
      }

      default:
        // Unknown notification — ignore silently
        break;
    }
    return;
  }

  // --- Server requests (approval flow) ---
  if (msg.type === 'request') {
    if (
      msg.method === 'item/commandExecution/requestApproval' ||
      msg.method === 'item/fileChange/requestApproval'
    ) {
      handleApprovalRequest(msg, controller, codexProcess, sessionId, threadId, abortSignal);
    }
    return;
  }

  // --- Responses to our requests (usually ignored, handled by specific listeners) ---
  // No action needed for generic responses
}

/**
 * Handle an approval request from the Codex app-server.
 * Non-blocking: registers in the approval registry and sends back the
 * JSON-RPC response asynchronously when the user decides.
 */
function handleApprovalRequest(
  msg: JsonRpcMessage & { type: 'request' },
  controller: ReadableStreamDefaultController<string>,
  codexProcess: CodexProcess,
  sessionId: string,
  threadId: string,
  abortSignal?: AbortSignal,
): void {
  const approvalId = generateApprovalId();
  const isCommand = msg.method === 'item/commandExecution/requestApproval';
  const params = msg.params;

  // Build the permission request event for the UI
  const permEvent: PermissionRequestEvent = {
    permissionRequestId: approvalId,
    toolName: isCommand ? 'command' : 'file_edit',
    toolInput: isCommand
      ? {
          command: params.command ?? params.commandActions,
          cwd: params.cwd,
        }
      : {
          grantRoot: params.grantRoot,
          itemId: params.itemId,
        },
    decisionReason: params.reason as string | undefined,
    toolUseId: (params.itemId as string) || '',
  };

  // Send the permission_request SSE event to the client
  controller.enqueue(formatSSE({
    type: 'permission_request',
    data: JSON.stringify(permEvent),
  }));

  // Register in approval registry and handle response asynchronously
  // This does NOT block the message handler
  const approvalInfo = {
    type: (isCommand ? 'command' : 'file_change') as 'command' | 'file_change',
    callId: (params.itemId as string) || '',
    turnId: (params.turnId as string) || '',
    command: isCommand ? (params.command as string[] | undefined) : undefined,
    cwd: isCommand ? (params.cwd as string | undefined) : undefined,
    reason: (params.reason as string) || null,
    jsonRpcId: msg.id,
    changes: !isCommand ? { grantRoot: params.grantRoot } as Record<string, unknown> : undefined,
  };

  // Push notification for codex approval request
  const sessionForPush = getSession(sessionId);
  sendPushNotification({
    type: 'permission_request',
    sessionId,
    sessionTitle: sessionForPush?.title || 'CodePilot',
    message: `${approvalInfo.type}: ${approvalInfo.reason || 'Approval needed'}`,
    requestId: approvalId,
  }).catch(() => {});

  registerPendingCodexApproval(approvalId, sessionId, approvalInfo, abortSignal)
    .then((decision) => {
      // Send JSON-RPC response back to the app-server with the user's decision
      codexProcess.send(
        formatJsonRpcResponse(msg.id, { decision }),
      );
    })
    .catch(() => {
      // On error (e.g. timeout), cancel the approval
      codexProcess.send(
        formatJsonRpcResponse(msg.id, { decision: 'cancel' }),
      );
    });
}
