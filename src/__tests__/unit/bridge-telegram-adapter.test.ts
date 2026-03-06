/**
 * Unit tests for src/lib/bridge/adapters/telegram-adapter.ts
 * Uses node:assert (no Jest/Vitest). Runs with `npx tsx`.
 *
 * Tests the pure/synchronous parts only — no actual Telegram API calls.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DB at a temp directory before any imports touch getDb()
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tg-adapter-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

import { getSetting, setSetting, closeDb } from '../../lib/db';
import { createAdapter, getRegisteredTypes } from '../../lib/bridge/channel-adapter';
import type { DeliverFn } from '../../lib/bridge/channel-adapter';
import type { ChannelAddress, OutboundMessage, SendResult } from '../../lib/bridge/types';

// Side-effect import triggers self-registration
import '../../lib/bridge/adapters/telegram-adapter';
import { TelegramAdapter } from '../../lib/bridge/adapters/telegram-adapter';

// ==========================================
// Helpers
// ==========================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const result = fn();
  if (result instanceof Promise) {
    // handled in async runner below
    return result
      .then(() => {
        passed++;
        console.log(`  PASS  ${name}`);
      })
      .catch((err: unknown) => {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  FAIL  ${name}\n        ${msg}`);
      });
  }
  try {
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: unknown) {
    // This path is for sync errors that already threw above
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${name}\n        ${msg}`);
  }
}

function syncTest(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${name}\n        ${msg}`);
  }
}

async function asyncTest(name: string, fn: () => Promise<void>) {
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

// ==========================================
// Tests
// ==========================================

async function runTests() {
  console.log('\nbridge-telegram-adapter tests\n');

  // ── Self-registration ───────────────────────────────────────

  syncTest('self-registration: telegram is in registered types', () => {
    const types = getRegisteredTypes();
    assert.ok(types.includes('telegram'), `Expected 'telegram' in ${JSON.stringify(types)}`);
  });

  syncTest('createAdapter("telegram") returns a TelegramAdapter instance', () => {
    const adapter = createAdapter('telegram');
    assert.ok(adapter !== null);
    assert.equal(adapter!.channelType, 'telegram');
    assert.ok(adapter instanceof TelegramAdapter);
  });

  syncTest('createAdapter("nonexistent") returns null', () => {
    const adapter = createAdapter('nonexistent');
    assert.equal(adapter, null);
  });

  // ── channelType and limits ──────────────────────────────────

  syncTest('channelType is "telegram"', () => {
    const adapter = new TelegramAdapter();
    assert.equal(adapter.channelType, 'telegram');
  });

  syncTest('messageLimit is 4096', () => {
    const adapter = new TelegramAdapter();
    assert.equal(adapter.messageLimit, 4096);
  });

  syncTest('streamDefaults has expected shape', () => {
    const adapter = new TelegramAdapter();
    const sd = adapter.streamDefaults;
    assert.equal(sd.intervalMs, 700);
    assert.equal(sd.minDeltaChars, 20);
    assert.equal(sd.maxChars, 3900);
  });

  // ── validateConfig ──────────────────────────────────────────

  syncTest('validateConfig returns error when token is missing', () => {
    // Ensure no token is set
    setSetting('telegram_bot_token', '');
    const adapter = new TelegramAdapter();
    const err = adapter.validateConfig();
    assert.ok(err !== null, 'Expected an error string');
    assert.ok(err!.includes('telegram_bot_token'));
  });

  syncTest('validateConfig returns null when token is present', () => {
    setSetting('telegram_bot_token', '123456:ABC-DEF');
    const adapter = new TelegramAdapter();
    const err = adapter.validateConfig();
    assert.equal(err, null);
  });

  syncTest('validateConfig returns error for whitespace-only token', () => {
    setSetting('telegram_bot_token', '   ');
    const adapter = new TelegramAdapter();
    const err = adapter.validateConfig();
    assert.ok(err !== null);
  });

  // ── isAuthorized ────────────────────────────────────────────

  syncTest('isAuthorized returns false when no allowed users configured', () => {
    setSetting('telegram_bridge_allowed_users', '');
    const adapter = new TelegramAdapter();
    assert.equal(adapter.isAuthorized('12345', '67890'), false);
  });

  syncTest('isAuthorized returns true for allowed user', () => {
    setSetting('telegram_bridge_allowed_users', '111,222,333');
    const adapter = new TelegramAdapter();
    assert.equal(adapter.isAuthorized('222', '67890'), true);
  });

  syncTest('isAuthorized returns false for disallowed user', () => {
    setSetting('telegram_bridge_allowed_users', '111,222,333');
    const adapter = new TelegramAdapter();
    assert.equal(adapter.isAuthorized('444', '67890'), false);
  });

  syncTest('isAuthorized handles whitespace in user list', () => {
    setSetting('telegram_bridge_allowed_users', ' 111 , 222 , 333 ');
    const adapter = new TelegramAdapter();
    assert.equal(adapter.isAuthorized('222', '67890'), true);
  });

  syncTest('isAuthorized returns false for single allowed user that does not match', () => {
    setSetting('telegram_bridge_allowed_users', '111');
    const adapter = new TelegramAdapter();
    assert.equal(adapter.isAuthorized('999', 'chat1'), false);
  });

  syncTest('isAuthorized returns true for single allowed user that matches', () => {
    setSetting('telegram_bridge_allowed_users', '111');
    const adapter = new TelegramAdapter();
    assert.equal(adapter.isAuthorized('111', 'chat1'), true);
  });

  // ── Lifecycle ───────────────────────────────────────────────

  syncTest('isRunning returns false initially', () => {
    const adapter = new TelegramAdapter();
    assert.equal(adapter.isRunning(), false);
  });

  await asyncTest('start sets running to true', async () => {
    const adapter = new TelegramAdapter();
    await adapter.start();
    assert.equal(adapter.isRunning(), true);
  });

  await asyncTest('stop sets running to false', async () => {
    const adapter = new TelegramAdapter();
    await adapter.start();
    await adapter.stop();
    assert.equal(adapter.isRunning(), false);
  });

  // ── deliverResponse ─────────────────────────────────────────

  await asyncTest('deliverResponse calls deliverFn with HTML parse mode', async () => {
    const adapter = new TelegramAdapter();
    const calls: Array<{ message: OutboundMessage; opts?: { sessionId?: string } }> = [];

    const mockDeliverFn: DeliverFn = async (_adapter, message, opts) => {
      calls.push({ message, opts });
      return { ok: true, messageId: '100' };
    };

    const address: ChannelAddress = {
      channelType: 'telegram',
      chatId: '12345',
    };

    const result = await adapter.deliverResponse(address, 'Hello world', mockDeliverFn, { sessionId: 'sess-1' });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message.parseMode, 'HTML');
    assert.equal(calls[0].message.address.chatId, '12345');
    assert.ok(calls[0].opts?.sessionId === 'sess-1');
  });

  await asyncTest('deliverResponse escapes HTML in text', async () => {
    const adapter = new TelegramAdapter();
    const calls: Array<{ message: OutboundMessage }> = [];

    const mockDeliverFn: DeliverFn = async (_adapter, message) => {
      calls.push({ message });
      return { ok: true };
    };

    const address: ChannelAddress = { channelType: 'telegram', chatId: '1' };
    await adapter.deliverResponse(address, '<script>alert("xss")</script>', mockDeliverFn);

    assert.equal(calls.length, 1);
    assert.ok(!calls[0].message.text.includes('<script>'));
    assert.ok(calls[0].message.text.includes('&lt;script&gt;'));
  });

  await asyncTest('deliverResponse splits long messages into chunks', async () => {
    const adapter = new TelegramAdapter();
    const calls: Array<{ message: OutboundMessage }> = [];

    const mockDeliverFn: DeliverFn = async (_adapter, message) => {
      calls.push({ message });
      return { ok: true };
    };

    const address: ChannelAddress = { channelType: 'telegram', chatId: '1' };
    // Create a message longer than 4096 chars
    const longText = 'A'.repeat(5000);
    await adapter.deliverResponse(address, longText, mockDeliverFn);

    assert.ok(calls.length >= 2, `Expected >= 2 chunks, got ${calls.length}`);
    // All chunks should be HTML mode
    for (const call of calls) {
      assert.equal(call.message.parseMode, 'HTML');
    }
  });

  await asyncTest('deliverResponse stops on first deliverFn error', async () => {
    const adapter = new TelegramAdapter();
    let callCount = 0;

    const mockDeliverFn: DeliverFn = async () => {
      callCount++;
      return { ok: false, error: 'Rate limited' };
    };

    const address: ChannelAddress = { channelType: 'telegram', chatId: '1' };
    const longText = 'B'.repeat(9000);
    const result = await adapter.deliverResponse(address, longText, mockDeliverFn);

    assert.equal(result.ok, false);
    assert.equal(callCount, 1, 'Should stop after first failure');
  });

  await asyncTest('deliverResponse returns ok for empty text', async () => {
    const adapter = new TelegramAdapter();
    const calls: Array<{ message: OutboundMessage }> = [];

    const mockDeliverFn: DeliverFn = async (_adapter, message) => {
      calls.push({ message });
      return { ok: true };
    };

    const address: ChannelAddress = { channelType: 'telegram', chatId: '1' };
    const result = await adapter.deliverResponse(address, '', mockDeliverFn);

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message.text, '');
  });

  // ── answerCallback ──────────────────────────────────────────

  // answerCallback makes a real API call so we just verify it doesn't throw
  // when token is missing (it short-circuits)
  await asyncTest('answerCallback returns without error when no token', async () => {
    setSetting('telegram_bot_token', '');
    const adapter = new TelegramAdapter();
    // Should not throw
    await adapter.answerCallback('callback-123', 'Done');
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
}

runTests().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
