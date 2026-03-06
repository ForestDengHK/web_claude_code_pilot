/**
 * Unit tests for src/lib/bridge/channel-router.ts
 * Uses node:assert (no Jest/Vitest). Runs with `npx tsx`.
 *
 * Run with: npx tsx src/__tests__/unit/bridge-channel-router.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DB at a temp directory before any imports touch getDb()
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-router-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

import {
  resolve,
  bindSession,
  updateSession,
  listSessions,
  processWithSessionLock,
} from '../../lib/bridge/channel-router';
import { closeDb } from '../../lib/db';

import type { ChannelAddress } from '../../lib/bridge/types';

// ==========================================
// Helpers
// ==========================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const result = fn();
  if (result instanceof Promise) {
    // Async tests handled in main()
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

// Valid UUID-format session ID for tests
const VALID_SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_SESSION_ID_2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

const addr: ChannelAddress = {
  channelType: 'telegram',
  chatId: '12345',
};

const addr2: ChannelAddress = {
  channelType: 'discord',
  chatId: '67890',
};

// ==========================================
// Tests
// ==========================================

async function main() {
  console.log('\nchannel-router tests\n');

  // 1. resolve() returns null for unknown address
  syncTest('resolve returns null for unknown address', () => {
    const result = resolve({ channelType: 'telegram', chatId: 'nonexistent' });
    assert.equal(result, null);
  });

  // 2. bindSession() creates binding and resolve() finds it
  syncTest('bindSession creates binding and resolve finds it', () => {
    const binding = bindSession(addr, VALID_SESSION_ID, {
      workingDirectory: '/tmp/project',
      model: 'opus',
    });
    assert.equal(binding.channelType, 'telegram');
    assert.equal(binding.chatId, '12345');
    assert.equal(binding.codepilotSessionId, VALID_SESSION_ID);
    assert.equal(binding.workingDirectory, '/tmp/project');
    assert.equal(binding.model, 'opus');
    assert.ok(binding.id);

    // resolve should find it
    const found = resolve(addr);
    assert.ok(found);
    assert.equal(found!.codepilotSessionId, VALID_SESSION_ID);
  });

  // 3. bindSession() rejects invalid session ID
  syncTest('bindSession rejects invalid session ID', () => {
    assert.throws(
      () => bindSession(addr2, 'not-a-valid-id!!!'),
      /Invalid session ID/,
    );
  });

  // 4. bindSession() rejects invalid working directory
  syncTest('bindSession rejects invalid working directory', () => {
    assert.throws(
      () => bindSession(addr2, VALID_SESSION_ID, { workingDirectory: '../traversal' }),
      /Invalid working directory/,
    );
    assert.throws(
      () => bindSession(addr2, VALID_SESSION_ID, { workingDirectory: 'relative/path' }),
      /Invalid working directory/,
    );
  });

  // 5. updateSession() updates fields
  syncTest('updateSession updates fields', () => {
    const binding = resolve(addr)!;
    assert.ok(binding);

    updateSession(binding.id, {
      mode: 'plan',
      sdkSessionId: 'sdk-session-123',
    });

    const updated = resolve(addr)!;
    assert.equal(updated.mode, 'plan');
    assert.equal(updated.sdkSessionId, 'sdk-session-123');
  });

  // 6. listSessions() returns all bindings
  syncTest('listSessions returns all bindings', () => {
    // Create a second binding on discord
    bindSession(addr2, VALID_SESSION_ID_2, { workingDirectory: '/tmp/other' });

    const all = listSessions();
    assert.ok(all.length >= 2, `expected >= 2, got ${all.length}`);
  });

  // 7. listSessions(channelType) filters
  syncTest('listSessions filters by channelType', () => {
    const tg = listSessions('telegram');
    assert.ok(tg.every(b => b.channelType === 'telegram'));
    assert.ok(tg.length >= 1);

    const dc = listSessions('discord');
    assert.ok(dc.every(b => b.channelType === 'discord'));
    assert.ok(dc.length >= 1);

    const slack = listSessions('slack');
    assert.equal(slack.length, 0);
  });

  // 8. processWithSessionLock — same session serializes
  await test('processWithSessionLock serializes same session', async () => {
    const order: number[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      // Simulate async work
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-A', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepEqual(order, [1, 2], `Expected [1,2] but got [${order}]`);
  });

  // 9. processWithSessionLock — different sessions run concurrently
  await test('processWithSessionLock runs different sessions concurrently', async () => {
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    const p1 = processWithSessionLock('session-X', async () => {
      startTimes['X'] = Date.now();
      await new Promise(r => setTimeout(r, 80));
      endTimes['X'] = Date.now();
    });

    const p2 = processWithSessionLock('session-Y', async () => {
      startTimes['Y'] = Date.now();
      await new Promise(r => setTimeout(r, 80));
      endTimes['Y'] = Date.now();
    });

    await Promise.all([p1, p2]);

    // Both should have started within a short window of each other (concurrently)
    const startDiff = Math.abs(startTimes['X'] - startTimes['Y']);
    assert.ok(startDiff < 40, `Expected concurrent start (diff < 40ms), got ${startDiff}ms`);
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
