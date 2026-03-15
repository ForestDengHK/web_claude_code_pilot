/**
 * Low-level JSON-RPC transport layer for communicating with `codex app-server`
 * via newline-delimited JSON-RPC over stdio.
 *
 * Three message types on stdout:
 *   1. Notification: has `method`, NO `id`
 *   2. Response: has `id`, NO `method`
 *   3. Request: has BOTH `id` AND `method` (server asking for approval)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsonRpcNotification = {
  type: 'notification';
  method: string;
  params: Record<string, unknown>;
};

export type JsonRpcResponse = {
  type: 'response';
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcRequest = {
  type: 'request';
  id: number | string;
  method: string;
  params: Record<string, unknown>;
};

export type JsonRpcMessage = JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let nextRequestId = 1;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single newline-delimited JSON-RPC line from the Codex app-server.
 * Returns null for empty/whitespace-only lines or unparseable JSON.
 */
export function parseJsonRpcLine(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof obj !== 'object' || obj === null) return null;

  const hasId = 'id' in obj;
  const hasMethod = 'method' in obj && typeof obj.method === 'string';

  if (hasId && hasMethod) {
    // Server request (e.g. approval prompt)
    return {
      type: 'request',
      id: obj.id as number | string,
      method: obj.method as string,
      params: (obj.params as Record<string, unknown>) ?? {},
    };
  }

  if (hasMethod) {
    // Notification (server push)
    return {
      type: 'notification',
      method: obj.method as string,
      params: (obj.params as Record<string, unknown>) ?? {},
    };
  }

  if (hasId) {
    // Response to one of our requests
    const msg: JsonRpcResponse = {
      type: 'response',
      id: obj.id as number | string,
    };
    if ('result' in obj) msg.result = obj.result as Record<string, unknown>;
    if ('error' in obj) msg.error = obj.error as JsonRpcResponse['error'];
    return msg;
  }

  // Doesn't match any known shape
  return null;
}

// ---------------------------------------------------------------------------
// Formatting (client → server)
// ---------------------------------------------------------------------------

/**
 * Build a newline-terminated JSON-RPC request string with an auto-incrementing id.
 */
export function formatJsonRpcRequest(
  method: string,
  params: Record<string, unknown>,
): string {
  const id = nextRequestId++;
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

/**
 * Return the id that was assigned to the most recent `formatJsonRpcRequest` call.
 */
export function getLastRequestId(): number {
  return nextRequestId - 1;
}

/**
 * Build a newline-terminated JSON-RPC response string (for replying to server requests).
 */
export function formatJsonRpcResponse(
  id: number | string,
  result: Record<string, unknown>,
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

/**
 * Reset the auto-incrementing request id counter (useful in tests).
 */
export function resetRequestIdCounter(): void {
  nextRequestId = 1;
}
