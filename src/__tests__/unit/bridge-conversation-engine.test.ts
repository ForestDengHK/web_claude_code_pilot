/**
 * Unit tests for conversation-engine.ts
 *
 * Tests the server-side SSE stream consumption and callback dispatching.
 * Uses Node's built-in test runner (zero dependencies).
 *
 * Strategy:
 * - consumeStream and handleStreamEvent are pure functions with no external deps,
 *   so we test them directly.
 * - processMessage depends on bridge-db and channel-router, so we test it via
 *   the exported _processMessageWithDeps which accepts injected dependencies.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Import the pure/testable functions directly.
// These don't trigger side-effect imports of bridge-db or claude-client.
import {
  consumeStream,
  handleStreamEvent,
  _processMessageWithDeps,
} from '../../lib/bridge/conversation-engine';
import type {
  ConversationCallbacks,
  ProcessMessageDeps,
} from '../../lib/bridge/conversation-engine';
import type { ChannelBinding } from '../../lib/bridge/types';

// ==========================================
// Helpers
// ==========================================

function makeBinding(overrides?: Partial<ChannelBinding>): ChannelBinding {
  return {
    id: 'bind-1',
    channelType: 'telegram',
    chatId: '12345',
    codepilotSessionId: 'session-abc',
    sdkSessionId: 'sdk-123',
    workingDirectory: '/tmp/test',
    model: 'claude-sonnet-4-20250514',
    mode: 'code',
    active: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Create a ReadableStream<string> from an array of SSE event objects. */
function makeSSEStream(events: Array<{ type: string; data: string }>): ReadableStream<string> {
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
  let index = 0;
  return new ReadableStream<string>({
    pull(controller) {
      if (index < lines.length) {
        controller.enqueue(lines[index]);
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/** Create mock dependencies for _processMessageWithDeps. */
function makeMockDeps(overrides?: Partial<ProcessMessageDeps>) {
  const auditLogs: Array<Record<string, unknown>> = [];
  const lockCalls: Array<{ sessionId: string }> = [];

  const deps: ProcessMessageDeps = {
    lockFn: async <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
      lockCalls.push({ sessionId });
      return fn();
    },
    auditFn: (params) => {
      auditLogs.push(params);
    },
    streamFn: async () => {
      throw new Error('No stream configured');
    },
    ...overrides,
  };

  return { deps, auditLogs, lockCalls };
}

// ==========================================
// Tests: handleStreamEvent
// ==========================================

describe('handleStreamEvent', () => {
  it('dispatches text content to onPartialText and accumulates text', () => {
    const partialTexts: string[] = [];
    const callbacks: ConversationCallbacks = {
      onResponse: async () => {},
      onPartialText: (text: string) => { partialTexts.push(text); },
    };

    let text = handleStreamEvent({ type: 'text', data: 'Hello' }, callbacks, '');
    assert.equal(text, 'Hello');
    assert.deepEqual(partialTexts, ['Hello']);

    text = handleStreamEvent({ type: 'text', data: ' world' }, callbacks, text);
    assert.equal(text, 'Hello world');
    assert.deepEqual(partialTexts, ['Hello', 'Hello world']);
  });

  it('dispatches permission_request to onPermissionRequest', () => {
    const permRequests: Array<Record<string, unknown>> = [];
    const callbacks: ConversationCallbacks = {
      onResponse: async () => {},
      onPermissionRequest: async (params) => {
        permRequests.push(params);
      },
    };

    const permData = {
      permissionRequestId: 'perm-123',
      toolName: 'Bash',
      description: 'Run a command',
    };

    handleStreamEvent(
      { type: 'permission_request', data: JSON.stringify(permData) },
      callbacks,
      '',
    );

    assert.equal(permRequests.length, 1);
    assert.equal(permRequests[0].permissionRequestId, 'perm-123');
    assert.equal(permRequests[0].toolName, 'Bash');
    assert.equal(permRequests[0].description, 'Run a command');
  });

  it('dispatches error event to onError', () => {
    const errors: Error[] = [];
    const callbacks: ConversationCallbacks = {
      onResponse: async () => {},
      onError: (err: Error) => { errors.push(err); },
    };

    handleStreamEvent({ type: 'error', data: 'Something broke' }, callbacks, '');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Something broke');
  });

  it('extracts session_id from status event and calls onSessionInit', () => {
    const sessionIds: string[] = [];
    const callbacks: ConversationCallbacks = {
      onResponse: async () => {},
      onSessionInit: (id: string) => { sessionIds.push(id); },
    };

    handleStreamEvent(
      { type: 'status', data: JSON.stringify({ session_id: 'sdk-new-456', model: 'test' }) },
      callbacks,
      '',
    );
    assert.equal(sessionIds.length, 1);
    assert.equal(sessionIds[0], 'sdk-new-456');
  });

  it('returns unchanged text for unrelated event types', () => {
    const callbacks: ConversationCallbacks = { onResponse: async () => {} };
    const result = handleStreamEvent({ type: 'heartbeat', data: '' }, callbacks, 'existing');
    assert.equal(result, 'existing');
  });

  it('handles malformed permission_request data gracefully', () => {
    const permRequests: Array<Record<string, unknown>> = [];
    const callbacks: ConversationCallbacks = {
      onResponse: async () => {},
      onPermissionRequest: async (params) => { permRequests.push(params); },
    };

    // Malformed JSON in data field
    handleStreamEvent(
      { type: 'permission_request', data: '{invalid json' },
      callbacks,
      '',
    );
    assert.equal(permRequests.length, 0);
  });
});

// ==========================================
// Tests: consumeStream
// ==========================================

describe('consumeStream', () => {
  it('assembles text deltas and calls onResponse with full text', async () => {
    const stream = makeSSEStream([
      { type: 'text', data: 'Hello' },
      { type: 'text', data: ' world' },
      { type: 'done', data: '' },
    ]);

    let responseText = '';
    const partials: string[] = [];

    await consumeStream(stream, {
      onResponse: async (text) => { responseText = text; },
      onPartialText: (text) => { partials.push(text); },
    });

    assert.equal(responseText, 'Hello world');
    assert.equal(partials.length, 2);
    assert.equal(partials[0], 'Hello');
    assert.equal(partials[1], 'Hello world');
  });

  it('calls onError when error event is in stream', async () => {
    const stream = makeSSEStream([
      { type: 'text', data: 'partial' },
      { type: 'error', data: 'API rate limited' },
      { type: 'done', data: '' },
    ]);

    const errors: Error[] = [];
    let responseText = '';

    await consumeStream(stream, {
      onResponse: async (text) => { responseText = text; },
      onError: (err) => { errors.push(err); },
    });

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'API rate limited');
    // Partial text still gets delivered as response
    assert.equal(responseText, 'partial');
  });

  it('handles permission_request events in stream', async () => {
    const permData = {
      permissionRequestId: 'perm-abc',
      toolName: 'Write',
      description: 'Write to file',
    };
    const stream = makeSSEStream([
      { type: 'text', data: 'thinking...' },
      { type: 'permission_request', data: JSON.stringify(permData) },
      { type: 'text', data: ' done' },
      { type: 'done', data: '' },
    ]);

    const perms: Array<Record<string, unknown>> = [];
    let responseText = '';

    await consumeStream(stream, {
      onResponse: async (text) => { responseText = text; },
      onPermissionRequest: async (params) => { perms.push(params); },
    });

    assert.equal(perms.length, 1);
    assert.equal(perms[0].permissionRequestId, 'perm-abc');
    assert.equal(responseText, 'thinking... done');
  });

  it('does not call onResponse when no text events arrive', async () => {
    const stream = makeSSEStream([
      { type: 'heartbeat', data: '' },
      { type: 'done', data: '' },
    ]);

    let responseCalled = false;

    await consumeStream(stream, {
      onResponse: async () => { responseCalled = true; },
    });

    assert.equal(responseCalled, false);
  });

  it('handles chunked SSE data (split across multiple reads)', async () => {
    const event1 = `data: {"type":"text","data":"Hello"}\n\n`;
    const event2 = `data: {"type":"text","data":" world"}\n\n`;
    const combined = event1 + event2;
    const splitPoint = Math.floor(combined.length / 2);
    const chunk1 = combined.slice(0, splitPoint);
    const chunk2 = combined.slice(splitPoint);

    let index = 0;
    const chunks = [chunk1, chunk2];
    const stream = new ReadableStream<string>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index]);
          index++;
        } else {
          controller.close();
        }
      },
    });

    let responseText = '';

    await consumeStream(stream, {
      onResponse: async (text) => { responseText = text; },
    });

    assert.equal(responseText, 'Hello world');
  });

  it('handles empty stream gracefully', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.close();
      },
    });

    let responseCalled = false;

    await consumeStream(stream, {
      onResponse: async () => { responseCalled = true; },
    });

    assert.equal(responseCalled, false);
  });
});

// ==========================================
// Tests: processMessage (via _processMessageWithDeps)
// ==========================================

describe('processMessage (via _processMessageWithDeps)', () => {
  it('wraps execution in session lock', async () => {
    const { deps, lockCalls } = makeMockDeps({
      streamFn: async () => makeSSEStream([
        { type: 'text', data: 'response' },
        { type: 'done', data: '' },
      ]),
    });
    const binding = makeBinding();

    await _processMessageWithDeps(binding, 'hello', {
      onResponse: async () => {},
    }, deps);

    assert.equal(lockCalls.length, 1);
    assert.equal(lockCalls[0].sessionId, 'session-abc');
  });

  it('logs audit entry for inbound message', async () => {
    const { deps, auditLogs } = makeMockDeps({
      streamFn: async () => makeSSEStream([
        { type: 'text', data: 'ok' },
        { type: 'done', data: '' },
      ]),
    });
    const binding = makeBinding();

    await _processMessageWithDeps(binding, 'test message', {
      onResponse: async () => {},
    }, deps);

    const inboundLogs = auditLogs.filter((l) => l.direction === 'inbound');
    assert.equal(inboundLogs.length, 1);
    assert.equal(inboundLogs[0].channelType, 'telegram');
    assert.equal(inboundLogs[0].chatId, '12345');
    assert.equal(inboundLogs[0].summary, 'test message');
  });

  it('calls onResponse with assembled text', async () => {
    const { deps } = makeMockDeps({
      streamFn: async () => makeSSEStream([
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' from Claude' },
        { type: 'done', data: '' },
      ]),
    });
    const binding = makeBinding();

    let responseText = '';

    await _processMessageWithDeps(binding, 'hi', {
      onResponse: async (text) => { responseText = text; },
    }, deps);

    assert.equal(responseText, 'Hello from Claude');
  });

  it('calls onError on streaming failure and logs error audit', async () => {
    // Default streamFn throws
    const { deps, auditLogs } = makeMockDeps();
    const binding = makeBinding();

    const errors: Error[] = [];

    await _processMessageWithDeps(binding, 'hi', {
      onResponse: async () => {},
      onError: (err) => { errors.push(err); },
    }, deps);

    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('No stream configured'));

    // Should have error audit log
    const errorLogs = auditLogs.filter((l) => l.direction === 'outbound');
    assert.equal(errorLogs.length, 1);
    assert.ok((errorLogs[0].summary as string).startsWith('Error:'));
  });

  it('truncates long message text in audit summary', async () => {
    const { deps, auditLogs } = makeMockDeps({
      streamFn: async () => makeSSEStream([
        { type: 'text', data: 'ok' },
        { type: 'done', data: '' },
      ]),
    });
    const binding = makeBinding();

    const longMessage = 'x'.repeat(500);

    await _processMessageWithDeps(binding, longMessage, {
      onResponse: async () => {},
    }, deps);

    const inboundLogs = auditLogs.filter((l) => l.direction === 'inbound');
    assert.equal(inboundLogs.length, 1);
    assert.equal((inboundLogs[0].summary as string).length, 200);
  });

  it('uses correct session ID from binding for lock', async () => {
    const { deps, lockCalls } = makeMockDeps({
      streamFn: async () => makeSSEStream([
        { type: 'text', data: 'ok' },
        { type: 'done', data: '' },
      ]),
    });
    const binding = makeBinding({ codepilotSessionId: 'custom-session-xyz' });

    await _processMessageWithDeps(binding, 'hi', {
      onResponse: async () => {},
    }, deps);

    assert.equal(lockCalls.length, 1);
    assert.equal(lockCalls[0].sessionId, 'custom-session-xyz');
  });

  it('does not throw even when onError is not provided', async () => {
    const { deps } = makeMockDeps(); // streamFn throws by default
    const binding = makeBinding();

    // Should not throw — error is swallowed when no onError callback
    await _processMessageWithDeps(binding, 'hi', {
      onResponse: async () => {},
    }, deps);
  });
});
