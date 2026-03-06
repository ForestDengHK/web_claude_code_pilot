/**
 * Unit tests for src/lib/bridge/permission-broker.ts
 * Uses node:assert (no Jest/Vitest). Runs with `npx tsx`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DB at a temp directory before any imports touch getDb()
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-perm-broker-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

import type { ChannelAddress, InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import {
  parsePermissionCallback,
  forwardPermissionRequest,
  handlePermissionCallback,
} from '../../lib/bridge/permission-broker';
import { insertPermissionLink, getPermissionLink, markPermissionLinkResolved } from '../../lib/bridge/bridge-db';
import { closeDb } from '../../lib/db';

// ==========================================
// Mock Adapter
// ==========================================

class MockAdapter extends BaseChannelAdapter {
  readonly channelType = 'mock';
  private _running = false;

  sendCalls: OutboundMessage[] = [];
  sendResults: SendResult[] = [];
  answerCallbackCalls: { callbackQueryId: string; text?: string }[] = [];

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

  override async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    this.answerCallbackCalls.push({ callbackQueryId, text });
  }
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
  console.log('\nbridge-permission-broker tests\n');

  // 1. parsePermissionCallback parses valid allow callback
  await test('parsePermissionCallback parses valid allow callback', () => {
    const result = parsePermissionCallback('perm:allow:a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    assert.deepEqual(result, { action: 'allow', permissionRequestId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
  });

  // 2. parsePermissionCallback parses valid deny callback
  await test('parsePermissionCallback parses valid deny callback', () => {
    const result = parsePermissionCallback('perm:deny:b2c3d4e5-f6a7-8901-bcde-f12345678901');
    assert.deepEqual(result, { action: 'deny', permissionRequestId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901' });
  });

  // 3. parsePermissionCallback returns null for non-permission callback
  await test('parsePermissionCallback returns null for non-permission callback', () => {
    assert.equal(parsePermissionCallback('something:else'), null);
    assert.equal(parsePermissionCallback('perm:invalid:a1b2c3d4e5f6789012345678901234567890'), null);
    assert.equal(parsePermissionCallback(''), null);
  });

  // 4. forwardPermissionRequest calls adapter.send with inline buttons
  await test('forwardPermissionRequest calls adapter.send with inline buttons', async () => {
    const adapter = new MockAdapter();
    await forwardPermissionRequest(adapter, makeAddress(), {
      permissionRequestId: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      toolName: 'Bash',
      description: 'Run ls -la',
    });

    assert.equal(adapter.sendCalls.length, 1);
    const sent = adapter.sendCalls[0];
    assert.equal(sent.parseMode, 'HTML');
    assert.ok(sent.text.includes('Permission Request'));
    assert.ok(sent.text.includes('Bash'));
    assert.ok(sent.text.includes('Run ls -la'));

    // Should have one row of 3 buttons
    assert.ok(sent.inlineButtons);
    assert.equal(sent.inlineButtons!.length, 1); // 1 row
    assert.equal(sent.inlineButtons![0].length, 3); // 3 buttons
    assert.equal(sent.inlineButtons![0][0].callbackData, 'perm:allow:c3d4e5f6-a7b8-9012-cdef-123456789012');
    assert.equal(sent.inlineButtons![0][1].callbackData, 'perm:deny:c3d4e5f6-a7b8-9012-cdef-123456789012');
    assert.equal(sent.inlineButtons![0][2].callbackData, 'perm:always:c3d4e5f6-a7b8-9012-cdef-123456789012');
  });

  // 5. forwardPermissionRequest inserts permission link on success
  await test('forwardPermissionRequest inserts permission link on success', async () => {
    const adapter = new MockAdapter();
    await forwardPermissionRequest(adapter, makeAddress('chat-link'), {
      permissionRequestId: 'd4e5f6a7-b8c9-0123-defa-234567890123',
      toolName: 'Read',
    });

    const link = getPermissionLink('d4e5f6a7-b8c9-0123-defa-234567890123');
    assert.ok(link, 'Permission link should exist');
    assert.equal(link!.permissionRequestId, 'd4e5f6a7-b8c9-0123-defa-234567890123');
    assert.equal(link!.channelType, 'mock');
    assert.equal(link!.chatId, 'chat-link');
    assert.equal(link!.toolName, 'Read');
    assert.equal(link!.resolved, false);
  });

  // 6. handlePermissionCallback resolves and answers callback
  await test('handlePermissionCallback resolves and answers callback', async () => {
    // Pre-insert a permission link
    insertPermissionLink({
      permissionRequestId: 'e5f6a7b8-c9d0-1234-efab-345678901234',
      channelType: 'mock',
      chatId: 'chat-handle',
      messageId: 'msg-handle-1',
      toolName: 'Bash',
    });

    const adapter = new MockAdapter();
    const result = await handlePermissionCallback(adapter, 'perm:allow:e5f6a7b8-c9d0-1234-efab-345678901234', 'cb-query-1');

    assert.ok(result);
    assert.equal(result!.action, 'allow');
    assert.equal(result!.permissionRequestId, 'e5f6a7b8-c9d0-1234-efab-345678901234');

    // Should have answered the callback
    assert.equal(adapter.answerCallbackCalls.length, 1);
    assert.equal(adapter.answerCallbackCalls[0].callbackQueryId, 'cb-query-1');
    assert.ok(adapter.answerCallbackCalls[0].text!.includes('Allowed'));

    // Permission link should be marked resolved
    const link = getPermissionLink('e5f6a7b8-c9d0-1234-efab-345678901234');
    assert.equal(link!.resolved, true);
  });

  // 7. handlePermissionCallback returns null for already resolved
  await test('handlePermissionCallback returns null for already resolved', async () => {
    // Insert and immediately resolve
    insertPermissionLink({
      permissionRequestId: 'f6a7b8c9-d0e1-2345-fabc-456789012345',
      channelType: 'mock',
      chatId: 'chat-resolved',
      messageId: 'msg-resolved-1',
      toolName: 'Bash',
    });
    markPermissionLinkResolved('f6a7b8c9-d0e1-2345-fabc-456789012345');

    const adapter = new MockAdapter();
    const result = await handlePermissionCallback(adapter, 'perm:allow:f6a7b8c9-d0e1-2345-fabc-456789012345', 'cb-query-2');

    assert.equal(result, null);
    assert.equal(adapter.answerCallbackCalls.length, 1);
    assert.ok(adapter.answerCallbackCalls[0].text!.includes('Already resolved'));
  });

  // 8. handlePermissionCallback returns null for invalid callback data
  await test('handlePermissionCallback returns null for invalid callback data', async () => {
    const adapter = new MockAdapter();
    const result = await handlePermissionCallback(adapter, 'not-a-permission-callback', 'cb-query-3');

    assert.equal(result, null);
    // Should NOT have called answerCallback since it wasn't even a permission callback
    assert.equal(adapter.answerCallbackCalls.length, 0);
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

main();
