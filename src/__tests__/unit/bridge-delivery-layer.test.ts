/**
 * Unit tests for src/lib/bridge/delivery-layer.ts
 * Uses node:assert (no Jest/Vitest). Runs with `npx tsx`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DB at a temp directory before any imports touch getDb()
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-delivery-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

import type { ChannelAddress, InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import { deliver, deliverChunks } from '../../lib/bridge/delivery-layer';
import { checkDedup, insertDedup } from '../../lib/bridge/bridge-db';
import { getDb, closeDb } from '../../lib/db';

// ==========================================
// Mock Adapter
// ==========================================

class MockAdapter extends BaseChannelAdapter {
  readonly channelType = 'mock';
  private _running = false;

  /** Track send calls */
  sendCalls: OutboundMessage[] = [];

  /** Queue of results to return from send(). Falls back to { ok: true, messageId: 'msg-N' }. */
  sendResults: SendResult[] = [];

  async start(): Promise<void> { this._running = true; }
  async stop(): Promise<void> { this._running = false; }
  isRunning(): boolean { return this._running; }
  async consumeOne(): Promise<InboundMessage | null> { return null; }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sendCalls.push(message);
    if (this.sendResults.length > 0) {
      return this.sendResults.shift()!;
    }
    return { ok: true, messageId: `msg-${this.sendCalls.length}` };
  }

  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }
}

// ==========================================
// Helpers
// ==========================================

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${name}\n        ${msg}`);
  }
}

function makeAddress(chatId = 'chat-1'): ChannelAddress {
  return { channelType: 'mock', chatId };
}

// ==========================================
// Tests
// ==========================================

async function main() {

console.log('\nbridge-delivery-layer tests\n');

// 1. deliver calls adapter.send() and returns ok result
await test('deliver calls adapter.send() and returns ok result', async () => {
  const adapter = new MockAdapter();
  const result = await deliver(adapter, {
    address: makeAddress(),
    text: 'Hello world',
  });

  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'msg-1');
  assert.equal(adapter.sendCalls.length, 1);
  assert.equal(adapter.sendCalls[0].text, 'Hello world');
});

// 2. deliver skips send when dedupKey already exists
await test('deliver skips send when dedupKey already exists', async () => {
  // Pre-insert a dedup key
  insertDedup('already-seen', 60_000);

  const adapter = new MockAdapter();
  const result = await deliver(adapter, {
    address: makeAddress(),
    text: 'Should be skipped',
  }, { dedupKey: 'already-seen' });

  assert.equal(result.ok, true);
  assert.equal(adapter.sendCalls.length, 0); // send was never called
});

// 3. deliver retries on 5xx errors with backoff
await test('deliver retries on 5xx errors with backoff', async () => {
  const adapter = new MockAdapter();
  adapter.sendResults = [
    { ok: false, error: 'Server error', httpStatus: 500 },
    { ok: false, error: 'Server error', httpStatus: 502 },
    { ok: true, messageId: 'msg-retry-ok' },
  ];

  const result = await deliver(adapter, {
    address: makeAddress('chat-retry'),
    text: 'Retry me',
  }, { maxRetries: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'msg-retry-ok');
  assert.equal(adapter.sendCalls.length, 3); // 1 initial + 2 retries before success
});

// 4. deliver does NOT retry on 4xx errors
await test('deliver does NOT retry on 4xx errors', async () => {
  const adapter = new MockAdapter();
  adapter.sendResults = [
    { ok: false, error: 'Bad request', httpStatus: 400 },
  ];

  const result = await deliver(adapter, {
    address: makeAddress('chat-4xx'),
    text: 'Bad request',
  }, { maxRetries: 3 });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Bad request');
  assert.equal(adapter.sendCalls.length, 1); // Only one attempt, no retry
});

// 5. deliver records audit log on success
await test('deliver records audit log on success', async () => {
  const adapter = new MockAdapter();
  const result = await deliver(adapter, {
    address: makeAddress('chat-audit-ok'),
    text: 'Audit this',
  }, { sessionId: 'sess-1' });

  assert.equal(result.ok, true);

  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM channel_audit_logs WHERE chat_id = ? AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1"
  ).get('chat-audit-ok') as Record<string, unknown> | undefined;

  assert.ok(row);
  assert.equal(row!.channel_type, 'mock');
  assert.ok((row!.summary as string).includes('Delivered'));
  assert.ok((row!.summary as string).includes('10 chars'));
});

// 6. deliver records audit log on failure
await test('deliver records audit log on failure', async () => {
  const adapter = new MockAdapter();
  adapter.sendResults = [
    { ok: false, error: 'Forbidden', httpStatus: 403 },
  ];

  const result = await deliver(adapter, {
    address: makeAddress('chat-audit-fail'),
    text: 'Will fail',
  });

  assert.equal(result.ok, false);

  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM channel_audit_logs WHERE chat_id = ? AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1"
  ).get('chat-audit-fail') as Record<string, unknown> | undefined;

  assert.ok(row);
  assert.ok((row!.summary as string).includes('Failed'));
  assert.ok((row!.summary as string).includes('Forbidden'));
});

// 7. deliverChunks sends all chunks sequentially
await test('deliverChunks sends all chunks sequentially', async () => {
  const adapter = new MockAdapter();

  const result = await deliverChunks(
    adapter,
    makeAddress('chat-chunks'),
    ['Chunk 1', 'Chunk 2', 'Chunk 3'],
    { sessionId: 'sess-chunks' },
  );

  assert.equal(result.ok, true);
  assert.equal(adapter.sendCalls.length, 3);
  assert.equal(adapter.sendCalls[0].text, 'Chunk 1');
  assert.equal(adapter.sendCalls[1].text, 'Chunk 2');
  assert.equal(adapter.sendCalls[2].text, 'Chunk 3');
});

// 8. deliverChunks stops on first error
await test('deliverChunks stops on first error', async () => {
  const adapter = new MockAdapter();
  adapter.sendResults = [
    { ok: true, messageId: 'c1' },
    { ok: false, error: 'Rate limited', httpStatus: 429 },
    // Third chunk should never be reached
  ];

  const result = await deliverChunks(
    adapter,
    makeAddress('chat-chunks-err'),
    ['Chunk A', 'Chunk B', 'Chunk C'],
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Rate limited');
  assert.equal(adapter.sendCalls.length, 2); // Only 2 attempts, stopped after error
});

// ==========================================
// Cleanup
// ==========================================

closeDb();

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // ignore cleanup errors
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}

} // end main

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
