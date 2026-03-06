/**
 * Unit tests for src/lib/bridge/bridge-manager.ts
 * Uses node:assert (no Jest/Vitest). Runs with `npx tsx`.
 *
 * Since bridge-manager orchestrates many modules, we test the command handling
 * and dispatch logic using a real temp DB (for channel-router/bridge-db)
 * and a stub adapter + stub delivery.
 *
 * Run with: npx tsx src/__tests__/unit/bridge-manager.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DB at a temp directory before any imports touch getDb()
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-manager-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

import type {
  ChannelAddress,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../../lib/bridge/types';
import type { BaseChannelAdapter, DeliverFn } from '../../lib/bridge/channel-adapter';
import {
  getBridgeStatus,
  _handleCommand,
  _dispatchMessage,
  _routeToConversation,
  _getState,
} from '../../lib/bridge/bridge-manager';
import { resolve, bindSession } from '../../lib/bridge/channel-router';
import { closeDb, setSetting } from '../../lib/db';

// ==========================================
// Helpers
// ==========================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const result = fn();
  if (result instanceof Promise) {
    return result.then(() => {
      passed++;
      console.log(`  PASS  ${name}`);
    }).catch((err: unknown) => {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL  ${name}\n        ${msg}`);
    });
  }
  try {
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: unknown) {
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

// Valid UUID-format session ID
const VALID_SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const testAddr: ChannelAddress = {
  channelType: 'telegram',
  chatId: '99999',
  userId: 'user1',
};

/**
 * Stub adapter that captures sent messages for assertion.
 */
function createStubAdapter(): BaseChannelAdapter & { sentMessages: OutboundMessage[] } {
  const sentMessages: OutboundMessage[] = [];

  return {
    channelType: 'telegram',
    sentMessages,

    async start() {},
    async stop() {},
    isRunning() { return true; },
    async consumeOne() { return null; },

    async send(message: OutboundMessage): Promise<SendResult> {
      sentMessages.push(message);
      return { ok: true, messageId: `msg-${sentMessages.length}` };
    },

    validateConfig() { return null; },
    isAuthorized(_userId: string, _chatId: string) { return true; },

    async deliverResponse(
      address: ChannelAddress,
      markdownText: string,
      deliverFn: DeliverFn,
      opts?: { sessionId?: string },
    ): Promise<SendResult> {
      return deliverFn(this as unknown as BaseChannelAdapter, { address, text: markdownText, parseMode: 'plain' }, opts);
    },

    get messageLimit() { return 4096; },
    get streamDefaults() {
      return { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 };
    },

    async answerCallback(_callbackQueryId: string, _text?: string) {},
  } as unknown as BaseChannelAdapter & { sentMessages: OutboundMessage[] };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'test-msg-1',
    address: testAddr,
    text: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ==========================================
// Tests
// ==========================================

async function main() {
  console.log('\nbridge-manager tests\n');

  // Set default work dir for tests
  setSetting('bridge_default_work_dir', '/tmp');

  // ────────────────────────────────────────
  // 1. getBridgeStatus returns not running initially
  // ────────────────────────────────────────
  syncTest('getBridgeStatus returns not running initially', () => {
    const status = getBridgeStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });

  // ────────────────────────────────────────
  // 2. handleCommand — /help returns help text
  // ────────────────────────────────────────
  await test('handleCommand /help returns help text', async () => {
    const adapter = createStubAdapter();
    const msg = makeMessage({ text: '/help' });

    await _handleCommand(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1, 'Expected at least one sent message');
    const sent = adapter.sentMessages[0];
    assert.ok(sent.text.includes('/new'), 'Help should mention /new');
    assert.ok(sent.text.includes('/bind'), 'Help should mention /bind');
    assert.ok(sent.text.includes('/status'), 'Help should mention /status');
    assert.ok(sent.text.includes('/help'), 'Help should mention /help');
  });

  // ────────────────────────────────────────
  // 3. handleCommand — /status with no binding
  // ────────────────────────────────────────
  await test('handleCommand /status with no binding returns no session message', async () => {
    const adapter = createStubAdapter();
    // Use a unique chatId that has no binding
    const addr: ChannelAddress = { channelType: 'telegram', chatId: 'no-binding-chat' };
    const msg = makeMessage({ address: addr, text: '/status' });

    await _handleCommand(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    const sent = adapter.sentMessages[0];
    assert.ok(
      sent.text.includes('No active session') || sent.text.includes('/new'),
      `Expected no session message, got: ${sent.text}`,
    );
  });

  // ────────────────────────────────────────
  // 4. handleCommand — /new creates a binding
  // ────────────────────────────────────────
  await test('handleCommand /new creates a binding', async () => {
    const adapter = createStubAdapter();
    const addr: ChannelAddress = { channelType: 'telegram', chatId: 'new-chat-123', userId: 'u1' };
    const msg = makeMessage({ address: addr, text: '/new /tmp/test-project' });

    await _handleCommand(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    const sent = adapter.sentMessages[0];
    assert.ok(sent.text.includes('New session created'), `Expected creation message, got: ${sent.text}`);
    assert.ok(sent.text.includes('/tmp/test-project'), 'Should mention the work dir');

    // Verify binding was actually created
    const binding = resolve(addr);
    assert.ok(binding, 'Binding should exist after /new');
    assert.equal(binding!.workingDirectory, '/tmp/test-project');
  });

  // ────────────────────────────────────────
  // 5. handleCommand — /mode plan updates binding mode
  // ────────────────────────────────────────
  await test('handleCommand /mode plan updates binding mode', async () => {
    const adapter = createStubAdapter();
    // First create a binding
    const addr: ChannelAddress = { channelType: 'telegram', chatId: 'mode-test-chat', userId: 'u1' };
    bindSession(addr, VALID_SESSION_ID, { workingDirectory: '/tmp/mode-test' });

    const msg = makeMessage({ address: addr, text: '/mode plan' });
    await _handleCommand(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    const sent = adapter.sentMessages[0];
    assert.ok(sent.text.includes('plan'), `Expected mode update message, got: ${sent.text}`);

    // Verify the mode was actually updated
    const binding = resolve(addr);
    assert.ok(binding);
    assert.equal(binding!.mode, 'plan');
  });

  // ────────────────────────────────────────
  // 6. handleCommand — unknown command returns error
  // ────────────────────────────────────────
  await test('handleCommand unknown command returns error', async () => {
    const adapter = createStubAdapter();
    const msg = makeMessage({ text: '/foobar' });

    await _handleCommand(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    const sent = adapter.sentMessages[0];
    assert.ok(sent.text.includes('Unknown command'), `Expected unknown command message, got: ${sent.text}`);
    assert.ok(sent.text.includes('/help'), 'Should suggest /help');
  });

  // ────────────────────────────────────────
  // 7. dispatchMessage routes commands vs regular messages
  // ────────────────────────────────────────
  await test('dispatchMessage routes commands correctly', async () => {
    const adapter = createStubAdapter();

    // Command message — should trigger command handler
    const cmdMsg = makeMessage({ text: '/help' });
    await _dispatchMessage(adapter, cmdMsg);

    assert.ok(adapter.sentMessages.length >= 1, 'Command should produce a response');
    assert.ok(adapter.sentMessages[0].text.includes('Available commands'));
  });

  await test('dispatchMessage routes regular messages to conversation', async () => {
    const adapter = createStubAdapter();
    // Use address with no binding — should get "no session" message
    const addr: ChannelAddress = { channelType: 'telegram', chatId: 'dispatch-regular-chat', userId: 'u1' };
    const regularMsg = makeMessage({ address: addr, text: 'Hello world' });

    await _dispatchMessage(adapter, regularMsg);

    assert.ok(adapter.sentMessages.length >= 1, 'Regular message should produce a response');
    assert.ok(
      adapter.sentMessages[0].text.includes('No active session') || adapter.sentMessages[0].text.includes('/new'),
      `Expected no-session message, got: ${adapter.sentMessages[0].text}`,
    );
  });

  // ────────────────────────────────────────
  // 8. routeToConversation with no binding sends "use /new" message
  // ────────────────────────────────────────
  await test('routeToConversation with no binding sends use /new message', async () => {
    const adapter = createStubAdapter();
    const addr: ChannelAddress = { channelType: 'telegram', chatId: 'unbound-chat', userId: 'u1' };
    const msg = makeMessage({ address: addr, text: 'Some question' });

    await _routeToConversation(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    const sent = adapter.sentMessages[0];
    assert.ok(
      sent.text.includes('/new') || sent.text.includes('No active session'),
      `Expected prompt to use /new, got: ${sent.text}`,
    );
  });

  // ────────────────────────────────────────
  // 9. handleCommand — /new with default work dir (no args)
  // ────────────────────────────────────────
  await test('handleCommand /new with default work dir', async () => {
    const adapter = createStubAdapter();
    const addr: ChannelAddress = { channelType: 'telegram', chatId: 'default-wd-chat', userId: 'u1' };
    const msg = makeMessage({ address: addr, text: '/new' });

    await _handleCommand(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    const sent = adapter.sentMessages[0];
    assert.ok(sent.text.includes('New session created'), `Expected creation, got: ${sent.text}`);

    const binding = resolve(addr);
    assert.ok(binding);
    assert.equal(binding!.workingDirectory, '/tmp');
  });

  // ────────────────────────────────────────
  // 10. handleCommand — /mode with invalid mode
  // ────────────────────────────────────────
  await test('handleCommand /mode with invalid mode returns error', async () => {
    const adapter = createStubAdapter();
    const addr: ChannelAddress = { channelType: 'telegram', chatId: 'mode-test-chat', userId: 'u1' };
    const msg = makeMessage({ address: addr, text: '/mode invalid' });

    await _handleCommand(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    const sent = adapter.sentMessages[0];
    assert.ok(sent.text.includes('Invalid mode'), `Expected invalid mode message, got: ${sent.text}`);
  });

  // ────────────────────────────────────────
  // 11. handleCommand — /sessions lists sessions
  // ────────────────────────────────────────
  await test('handleCommand /sessions lists sessions', async () => {
    const adapter = createStubAdapter();
    const msg = makeMessage({ text: '/sessions' });

    await _handleCommand(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    const sent = adapter.sentMessages[0];
    // We created several telegram bindings above, so there should be listed sessions
    assert.ok(
      sent.text.includes('Sessions:') || sent.text.includes('No sessions'),
      `Expected sessions list, got: ${sent.text}`,
    );
  });

  // ────────────────────────────────────────
  // 12. handleCommand — /stop deactivates session
  // ────────────────────────────────────────
  await test('handleCommand /stop deactivates session', async () => {
    const adapter = createStubAdapter();
    const addr: ChannelAddress = { channelType: 'telegram', chatId: 'stop-test-chat', userId: 'u1' };
    // Create a binding first
    bindSession(addr, VALID_SESSION_ID, { workingDirectory: '/tmp/stop-test' });

    const msg = makeMessage({ address: addr, text: '/stop' });
    await _handleCommand(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    assert.ok(adapter.sentMessages[0].text.includes('deactivated'));

    const binding = resolve(addr);
    assert.ok(binding);
    assert.equal(binding!.active, false);
  });

  // ────────────────────────────────────────
  // 13. dispatchMessage ignores unauthorized users
  // ────────────────────────────────────────
  await test('dispatchMessage ignores unauthorized users', async () => {
    const adapter = createStubAdapter();
    // Override isAuthorized to return false
    (adapter as unknown as { isAuthorized: (u: string, c: string) => boolean }).isAuthorized = () => false;

    const msg = makeMessage({ text: '/help' });
    await _dispatchMessage(adapter, msg);

    assert.equal(adapter.sentMessages.length, 0, 'Unauthorized users should get no response');
  });

  // ────────────────────────────────────────
  // 14. dispatchMessage routes callback_query to permission handler
  // ────────────────────────────────────────
  await test('dispatchMessage routes permission callback', async () => {
    const adapter = createStubAdapter();
    const msg = makeMessage({
      text: '',
      callbackData: 'perm:allow:some-request-id',
    });

    // This should not crash even though the permission link doesn't exist
    await _dispatchMessage(adapter, msg);

    // Should have called answerCallback (which is a no-op in our stub)
    // Main assertion: no crash, no sent text messages for unknown permission
    // (answerCallback handles the response, not send)
  });

  // ────────────────────────────────────────
  // 15. routeToConversation with inactive session
  // ────────────────────────────────────────
  await test('routeToConversation with inactive session sends inactive message', async () => {
    const adapter = createStubAdapter();
    const addr: ChannelAddress = { channelType: 'telegram', chatId: 'stop-test-chat', userId: 'u1' };
    // stop-test-chat was deactivated in test 12
    const msg = makeMessage({ address: addr, text: 'Hello' });

    await _routeToConversation(adapter, msg);

    assert.ok(adapter.sentMessages.length >= 1);
    assert.ok(
      adapter.sentMessages[0].text.includes('inactive'),
      `Expected inactive message, got: ${adapter.sentMessages[0].text}`,
    );
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

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
