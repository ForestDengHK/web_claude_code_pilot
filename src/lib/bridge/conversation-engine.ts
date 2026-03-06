/**
 * Conversation engine -- processes IM messages through Claude.
 *
 * This is the bridge between inbound IM messages and Claude's streaming API.
 * It consumes the SSE stream server-side and dispatches events to callbacks.
 *
 * Key design:
 * - Wraps streamClaude() from claude-client.ts for server-side consumption
 * - The stream emits SSE-formatted strings (ReadableStream<string>)
 * - Session locking serializes per-session via processWithSessionLock
 * - Callbacks decouple stream events from delivery (bridge-manager wires them)
 */

import type { ChannelBinding } from './types';
import type { FileAttachment, SSEEvent, ClaudeStreamOptions } from '@/types';
import { processWithSessionLock } from './channel-router';
import { insertAuditLog } from './bridge-db';

// ==========================================
// Callback interface
// ==========================================

export interface ConversationCallbacks {
  /** Called with the final assembled response text */
  onResponse: (text: string) => Promise<void>;
  /** Called when a permission request arrives during streaming */
  onPermissionRequest?: (params: {
    permissionRequestId: string;
    toolName: string;
    description?: string;
  }) => Promise<void>;
  /** Called with partial text for streaming preview */
  onPartialText?: (text: string) => void;
  /** Called on error */
  onError?: (error: Error) => void;
  /** Called with the SDK session ID from the init status event */
  onSessionInit?: (sdkSessionId: string) => void;
}

// ==========================================
// Main entry point
// ==========================================

/**
 * Process an inbound message through Claude's streaming API.
 * Uses session locking to serialize per-session.
 */
export async function processMessage(
  binding: ChannelBinding,
  messageText: string,
  callbacks: ConversationCallbacks,
  opts?: {
    attachments?: FileAttachment[];
    mode?: string;
  },
): Promise<void> {
  return processWithSessionLock(binding.codepilotSessionId, async () => {
    // Audit the inbound message
    insertAuditLog({
      channelType: binding.channelType,
      chatId: binding.chatId,
      direction: 'inbound',
      messageId: `bridge-${Date.now()}`,
      summary: messageText.slice(0, 200),
    });

    try {
      // Call the streaming API
      const stream = await callStreamingAPI(binding, messageText, opts);

      // Process the stream events
      await consumeStream(stream, callbacks);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      callbacks.onError?.(error);

      insertAuditLog({
        channelType: binding.channelType,
        chatId: binding.chatId,
        direction: 'outbound',
        messageId: `error-${Date.now()}`,
        summary: `Error: ${error.message.slice(0, 200)}`,
      });
    }
  });
}

// ==========================================
// Streaming API call
// ==========================================

/**
 * Call the streaming Claude API.
 * Dynamically imports claude-client to avoid hard dependency at module load time.
 */
async function callStreamingAPI(
  binding: ChannelBinding,
  messageText: string,
  opts?: { attachments?: FileAttachment[]; mode?: string },
): Promise<ReadableStream<string>> {
  try {
    const { streamClaude } = await import('../claude-client');

    // Build options matching ClaudeStreamOptions
    const streamOpts: ClaudeStreamOptions = {
      prompt: messageText,
      sessionId: binding.codepilotSessionId,
      sdkSessionId: binding.sdkSessionId || undefined,
      workingDirectory: binding.workingDirectory,
      model: binding.model || undefined,
      files: opts?.attachments,
      permissionMode: 'default',
    };

    // Use binding mode or override from opts
    // mode is not directly in ClaudeStreamOptions but can inform systemPrompt etc.
    // For now, the binding's mode is informational to the adapter layer.

    return streamClaude(streamOpts);
  } catch (err) {
    throw new Error(
      `Failed to call streaming API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ==========================================
// Stream consumption
// ==========================================

/**
 * Consume a ReadableStream<string> of SSE-formatted lines and dispatch events.
 *
 * The stream from streamClaude() emits strings in the format:
 *   "data: {\"type\":\"text\",\"data\":\"hello\"}\n\n"
 *
 * We parse these into SSEEvent objects and handle each type.
 */
export async function consumeStream(
  stream: ReadableStream<string>,
  callbacks: ConversationCallbacks,
): Promise<void> {
  const reader = stream.getReader();
  let buffer = '';
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;

      // Parse SSE events from buffer
      // Each event is: "data: <json>\n\n"
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || ''; // Keep incomplete trailing part

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // Extract lines - SSE can have multiple lines per event
        for (const line of trimmed.split('\n')) {
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as SSEEvent;
            fullText = handleStreamEvent(event, callbacks, fullText);
          } catch {
            // Skip unparseable lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Final assembled response
  if (fullText) {
    await callbacks.onResponse(fullText);
  }
}

// ==========================================
// Event handling
// ==========================================

/**
 * Handle a single parsed SSE event.
 * Returns the updated full text accumulator.
 */
export function handleStreamEvent(
  event: SSEEvent,
  callbacks: ConversationCallbacks,
  currentText: string,
): string {
  let fullText = currentText;

  switch (event.type) {
    case 'text': {
      // Text content delta - accumulate
      fullText += event.data;
      callbacks.onPartialText?.(fullText);
      break;
    }

    case 'permission_request': {
      // Permission request - parse the JSON data
      try {
        const permData = JSON.parse(event.data) as {
          permissionRequestId: string;
          toolName: string;
          description?: string;
        };
        // Fire and forget - permission handling is async
        callbacks.onPermissionRequest?.(permData).catch((err: unknown) => {
          console.error('[conversation-engine] Failed to forward permission request:', err);
          callbacks.onError?.(new Error(`Failed to forward permission request: ${err instanceof Error ? err.message : String(err)}`));
        });
      } catch {
        // Skip malformed permission data
      }
      break;
    }

    case 'status': {
      // Status events may include session init info
      try {
        const statusData = JSON.parse(event.data) as Record<string, unknown>;
        if (statusData.session_id && typeof statusData.session_id === 'string') {
          callbacks.onSessionInit?.(statusData.session_id);
        }
      } catch {
        // Skip malformed status data
      }
      break;
    }

    case 'error': {
      callbacks.onError?.(new Error(event.data || 'Stream error'));
      break;
    }

    case 'result': {
      // Result event signals end of conversation turn
      // We don't need to do anything special here;
      // the stream will end after this and fullText will be delivered.
      break;
    }

    case 'done': {
      // Stream complete - no action needed, loop will exit
      break;
    }

    // Other event types (tool_use, tool_result, tool_output, heartbeat, etc.)
    // are informational for the bridge and don't need special handling.
    default:
      break;
  }

  return fullText;
}

// ==========================================
// Testable internal — dependency injection for processMessage
// ==========================================

/**
 * Injectable dependencies for processMessage.
 * Allows unit testing without module-level mocking.
 * @internal
 */
export interface ProcessMessageDeps {
  lockFn: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>;
  auditFn: (params: {
    channelType: string;
    chatId: string;
    direction: string;
    messageId: string;
    summary: string;
  }) => void;
  streamFn: (binding: ChannelBinding, text: string, opts?: {
    attachments?: FileAttachment[];
    mode?: string;
  }) => Promise<ReadableStream<string>>;
}

/**
 * Internal implementation with injected deps — used by tests.
 * @internal
 */
export async function _processMessageWithDeps(
  binding: ChannelBinding,
  messageText: string,
  callbacks: ConversationCallbacks,
  deps: ProcessMessageDeps,
  opts?: {
    attachments?: FileAttachment[];
    mode?: string;
  },
): Promise<void> {
  return deps.lockFn(binding.codepilotSessionId, async () => {
    deps.auditFn({
      channelType: binding.channelType,
      chatId: binding.chatId,
      direction: 'inbound',
      messageId: `bridge-${Date.now()}`,
      summary: messageText.slice(0, 200),
    });

    try {
      const stream = await deps.streamFn(binding, messageText, opts);
      await consumeStream(stream, callbacks);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      callbacks.onError?.(error);

      deps.auditFn({
        channelType: binding.channelType,
        chatId: binding.chatId,
        direction: 'outbound',
        messageId: `error-${Date.now()}`,
        summary: `Error: ${error.message.slice(0, 200)}`,
      });
    }
  });
}

// ==========================================
// Simple (non-streaming) wrapper
// ==========================================

/**
 * Process a message and return the final response text.
 * Useful for testing or when streaming preview is not needed.
 */
export async function processMessageSimple(
  binding: ChannelBinding,
  messageText: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let result = '';
    processMessage(binding, messageText, {
      onResponse: async (text) => {
        result = text;
      },
      onError: (err) => reject(err),
    })
      .then(() => resolve(result))
      .catch(reject);
  });
}
