import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonRpcLine,
  formatJsonRpcRequest,
  formatJsonRpcResponse,
  getLastRequestId,
  resetRequestIdCounter,
} from '../codex-jsonrpc';

beforeEach(() => {
  resetRequestIdCounter();
});

// ---------------------------------------------------------------------------
// parseJsonRpcLine
// ---------------------------------------------------------------------------

describe('parseJsonRpcLine', () => {
  it('parses a notification (method, no id)', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { delta: 'hello' },
    });

    const msg = parseJsonRpcLine(line);
    assert.deepEqual(msg, {
      type: 'notification',
      method: 'item/agentMessage/delta',
      params: { delta: 'hello' },
    });
  });

  it('parses a response (id, no method)', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      result: { status: 'ok' },
    });

    const msg = parseJsonRpcLine(line);
    assert.deepEqual(msg, {
      type: 'response',
      id: 42,
      result: { status: 'ok' },
    });
  });

  it('parses an error response', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32600, message: 'Invalid request' },
    });

    const msg = parseJsonRpcLine(line);
    assert.ok(msg !== null);
    assert.equal(msg.type, 'response');
    if (msg.type === 'response') {
      assert.deepEqual(msg.error, { code: -32600, message: 'Invalid request' });
      assert.equal(msg.result, undefined);
    }
  });

  it('parses a server request / approval (both id and method)', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'approval/request',
      params: { tool: 'bash', command: 'rm -rf /' },
    });

    const msg = parseJsonRpcLine(line);
    assert.deepEqual(msg, {
      type: 'request',
      id: 1,
      method: 'approval/request',
      params: { tool: 'bash', command: 'rm -rf /' },
    });
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseJsonRpcLine('not json at all'), null);
  });

  it('returns null for empty lines', () => {
    assert.equal(parseJsonRpcLine(''), null);
    assert.equal(parseJsonRpcLine('   '), null);
    assert.equal(parseJsonRpcLine('\n'), null);
  });

  it('returns null for JSON that has neither id nor method', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', params: {} });
    assert.equal(parseJsonRpcLine(line), null);
  });

  it('defaults params to empty object when missing', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'ping' });
    const msg = parseJsonRpcLine(line);
    assert.ok(msg !== null);
    assert.equal(msg.type, 'notification');
    if (msg.type === 'notification') {
      assert.deepEqual(msg.params, {});
    }
  });
});

// ---------------------------------------------------------------------------
// formatJsonRpcRequest
// ---------------------------------------------------------------------------

describe('formatJsonRpcRequest', () => {
  it('formats a request with auto-incrementing id', () => {
    const req1 = formatJsonRpcRequest('session/start', { model: 'o3' });
    const parsed1 = JSON.parse(req1);
    assert.deepEqual(parsed1, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/start',
      params: { model: 'o3' },
    });

    const req2 = formatJsonRpcRequest('session/stop', {});
    const parsed2 = JSON.parse(req2);
    assert.equal(parsed2.id, 2);
  });

  it('terminates with a newline', () => {
    const req = formatJsonRpcRequest('ping', {});
    assert.ok(req.endsWith('\n'));
    // Exactly one trailing newline
    assert.ok(!req.endsWith('\n\n'));
  });
});

// ---------------------------------------------------------------------------
// getLastRequestId
// ---------------------------------------------------------------------------

describe('getLastRequestId', () => {
  it('returns the id used in the most recent request', () => {
    formatJsonRpcRequest('a', {});
    assert.equal(getLastRequestId(), 1);
    formatJsonRpcRequest('b', {});
    assert.equal(getLastRequestId(), 2);
  });
});

// ---------------------------------------------------------------------------
// formatJsonRpcResponse
// ---------------------------------------------------------------------------

describe('formatJsonRpcResponse', () => {
  it('formats a response to a server request', () => {
    const res = formatJsonRpcResponse(5, { approved: true });
    const parsed = JSON.parse(res);
    assert.deepEqual(parsed, {
      jsonrpc: '2.0',
      id: 5,
      result: { approved: true },
    });
  });

  it('handles string ids', () => {
    const res = formatJsonRpcResponse('abc-123', { ok: true });
    const parsed = JSON.parse(res);
    assert.equal(parsed.id, 'abc-123');
  });

  it('terminates with a newline', () => {
    const res = formatJsonRpcResponse(1, {});
    assert.ok(res.endsWith('\n'));
    assert.ok(!res.endsWith('\n\n'));
  });
});
