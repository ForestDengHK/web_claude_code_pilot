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
import { updateCodexThreadId } from '@/lib/db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodexStreamOptions {
  prompt: string;
  sessionId: string;
  codexThreadId?: string;
  model?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  files?: FileAttachment[];
  contextBridgePrompt?: string;
}

interface CodexUserInput {
  type: 'text';
  text: string;
  text_elements?: unknown[];
}

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
 * Build UserInput[] from prompt, optional context bridge prompt, and file refs.
 */
function buildUserInputs(
  prompt: string,
  contextBridgePrompt?: string,
  files?: FileAttachment[],
): CodexUserInput[] {
  const inputs: CodexUserInput[] = [];

  // Context bridge prompt first (provides Claude conversation context)
  if (contextBridgePrompt) {
    inputs.push({ type: 'text', text: contextBridgePrompt });
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
          threadId = await startThread(codexProcess, sessionId, model, workingDirectory);
        } else if (isResumedThread && threadId) {
          // Resume an existing thread on a new process
          await resumeThread(codexProcess, threadId);
          codexProcess.threadId = threadId;
        }

        if (!threadId) {
          throw new Error('Failed to obtain Codex thread ID');
        }

        // 3. Build user inputs
        const userInputs = buildUserInputs(prompt, contextBridgePrompt, files);

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

          codexProcess.send(
            formatJsonRpcRequest('turn/start', turnStartParams),
          );

          // Message handler for all events during this turn
          messageHandler = (msg: JsonRpcMessage) => {
            try {
              handleCodexMessage(msg, controller, codexProcess!, sessionId, threadId!, resolve, reject, abortController?.signal);
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

    const params: Record<string, unknown> = {
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };
    if (model) params.model = model;
    if (cwd) params.cwd = cwd;

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

      // Reasoning summary — render as regular text
      case 'item/reasoning/summaryTextDelta': {
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'text', data: delta }));
        }
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
