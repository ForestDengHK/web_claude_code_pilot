/**
 * Unit tests for src/lib/bridge/bridge-db.ts
 * Uses node:assert (no Jest/Vitest). Runs with `npx tsx`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DB at a temp directory before any imports touch getDb()
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-db-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

import {
  upsertChannelBinding,
  getChannelBinding,
  updateChannelBinding,
  listChannelBindings,
  getChannelOffset,
  setChannelOffset,
  checkDedup,
  insertDedup,
  cleanupExpiredDedup,
  insertAuditLog,
  insertOutboundRef,
  insertPermissionLink,
  getPermissionLink,
  markPermissionLinkResolved,
  _resetMigrationFlag,
} from '../../lib/bridge/bridge-db';

import { getDb, closeDb } from '../../lib/db';

// ==========================================
// Helpers
// ==========================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
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

// ==========================================
// Tests
// ==========================================

console.log('\nbridge-db tests\n');

// 1. upsertChannelBinding — insert
test('upsertChannelBinding creates a new binding', () => {
  const b = upsertChannelBinding({
    channelType: 'telegram',
    chatId: '111',
    codepilotSessionId: 'sess-1',
    workingDirectory: '/tmp/project',
    model: 'opus',
  });
  assert.equal(b.channelType, 'telegram');
  assert.equal(b.chatId, '111');
  assert.equal(b.codepilotSessionId, 'sess-1');
  assert.equal(b.workingDirectory, '/tmp/project');
  assert.equal(b.model, 'opus');
  assert.equal(b.mode, 'code');
  assert.equal(b.active, true);
  assert.ok(b.id);
  assert.ok(b.createdAt);
  assert.ok(b.updatedAt);
});

// 1b. upsertChannelBinding — upsert (same channelType + chatId)
test('upsertChannelBinding updates existing binding on conflict', () => {
  const b = upsertChannelBinding({
    channelType: 'telegram',
    chatId: '111',
    codepilotSessionId: 'sess-2',
    workingDirectory: '/tmp/other',
  });
  assert.equal(b.codepilotSessionId, 'sess-2');
  assert.equal(b.workingDirectory, '/tmp/other');
  // model should remain from first insert (COALESCE keeps non-empty)
  assert.equal(b.channelType, 'telegram');
  assert.equal(b.chatId, '111');
});

// 2. getChannelBinding
test('getChannelBinding returns binding by composite key', () => {
  const b = getChannelBinding('telegram', '111');
  assert.ok(b);
  assert.equal(b!.codepilotSessionId, 'sess-2');
});

test('getChannelBinding returns undefined for missing', () => {
  const b = getChannelBinding('telegram', '999');
  assert.equal(b, undefined);
});

// 3. updateChannelBinding
test('updateChannelBinding updates selected fields', () => {
  const b = getChannelBinding('telegram', '111')!;
  updateChannelBinding(b.id, {
    sdkSessionId: 'sdk-abc',
    mode: 'plan',
    active: false,
  });
  const updated = getChannelBinding('telegram', '111')!;
  assert.equal(updated.sdkSessionId, 'sdk-abc');
  assert.equal(updated.mode, 'plan');
  assert.equal(updated.active, false);
});

test('updateChannelBinding with empty updates is a no-op', () => {
  const b = getChannelBinding('telegram', '111')!;
  updateChannelBinding(b.id, {});
  const after = getChannelBinding('telegram', '111')!;
  assert.equal(after.sdkSessionId, 'sdk-abc');
});

// 4. listChannelBindings
test('listChannelBindings returns all bindings', () => {
  upsertChannelBinding({ channelType: 'discord', chatId: '222', codepilotSessionId: 'sess-3' });
  const all = listChannelBindings();
  assert.ok(all.length >= 2);
});

test('listChannelBindings filters by channelType', () => {
  const tg = listChannelBindings('telegram');
  assert.ok(tg.every(b => b.channelType === 'telegram'));
  const dc = listChannelBindings('discord');
  assert.ok(dc.every(b => b.channelType === 'discord'));
});

// 5. getChannelOffset
test('getChannelOffset returns 0 for missing key', () => {
  assert.equal(getChannelOffset('tg:offset'), '0');
});

// 6. setChannelOffset
test('setChannelOffset stores and retrieves value', () => {
  setChannelOffset('tg:offset', '12345');
  assert.equal(getChannelOffset('tg:offset'), '12345');
});

test('setChannelOffset overwrites existing', () => {
  setChannelOffset('tg:offset', '99999');
  assert.equal(getChannelOffset('tg:offset'), '99999');
});

// 7. checkDedup
test('checkDedup returns false for missing key', () => {
  assert.equal(checkDedup('msg-abc'), false);
});

// 8. insertDedup
test('insertDedup + checkDedup returns true for valid key', () => {
  insertDedup('msg-abc', 60_000);
  assert.equal(checkDedup('msg-abc'), true);
});

test('checkDedup returns false for expired key', () => {
  insertDedup('msg-expired', 0); // TTL = 0ms → already expired
  assert.equal(checkDedup('msg-expired'), false);
});

// 9. cleanupExpiredDedup
test('cleanupExpiredDedup removes expired entries', () => {
  insertDedup('msg-cleanup-1', 0);
  insertDedup('msg-cleanup-2', 0);
  insertDedup('msg-cleanup-live', 60_000);
  const removed = cleanupExpiredDedup();
  // Should have removed at least msg-expired, msg-cleanup-1, msg-cleanup-2
  assert.ok(removed >= 2, `expected >= 2 removed, got ${removed}`);
  // Live one should still exist
  assert.equal(checkDedup('msg-cleanup-live'), true);
});

// 10. insertAuditLog
test('insertAuditLog inserts without error', () => {
  insertAuditLog({
    channelType: 'telegram',
    chatId: '111',
    direction: 'inbound',
    messageId: 'tg-msg-1',
    summary: 'User sent hello',
  });
  // Verify via raw query
  const db = getDb();
  const row = db.prepare('SELECT * FROM channel_audit_logs WHERE message_id = ?').get('tg-msg-1') as Record<string, unknown> | undefined;
  assert.ok(row);
  assert.equal(row!.direction, 'inbound');
  assert.equal(row!.summary, 'User sent hello');
});

// 11. insertOutboundRef
test('insertOutboundRef inserts without error', () => {
  insertOutboundRef({
    channelType: 'telegram',
    chatId: '111',
    codepilotSessionId: 'sess-2',
    platformMessageId: 'tg-out-1',
    purpose: 'response',
  });
  const db = getDb();
  const row = db.prepare('SELECT * FROM channel_outbound_refs WHERE platform_message_id = ?').get('tg-out-1') as Record<string, unknown> | undefined;
  assert.ok(row);
  assert.equal(row!.purpose, 'response');
});

// 12. insertPermissionLink
test('insertPermissionLink inserts a permission link', () => {
  insertPermissionLink({
    permissionRequestId: 'perm-req-1',
    channelType: 'telegram',
    chatId: '111',
    messageId: 'tg-perm-msg-1',
    toolName: 'Bash',
    suggestions: 'allow,deny',
  });
  const link = getPermissionLink('perm-req-1');
  assert.ok(link);
  assert.equal(link!.permissionRequestId, 'perm-req-1');
  assert.equal(link!.toolName, 'Bash');
  assert.equal(link!.suggestions, 'allow,deny');
  assert.equal(link!.resolved, false);
});

// 13. getPermissionLink
test('getPermissionLink returns null for missing', () => {
  const link = getPermissionLink('nonexistent');
  assert.equal(link, null);
});

test('getPermissionLink returns resolved as boolean', () => {
  const link = getPermissionLink('perm-req-1');
  assert.ok(link);
  assert.equal(typeof link!.resolved, 'boolean');
});

// 14. markPermissionLinkResolved
test('markPermissionLinkResolved returns true and resolves', () => {
  const changed = markPermissionLinkResolved('perm-req-1');
  assert.equal(changed, true);
  const link = getPermissionLink('perm-req-1');
  assert.ok(link);
  assert.equal(link!.resolved, true);
});

test('markPermissionLinkResolved returns false for already resolved', () => {
  const changed = markPermissionLinkResolved('perm-req-1');
  assert.equal(changed, false);
});

test('markPermissionLinkResolved returns false for nonexistent', () => {
  const changed = markPermissionLinkResolved('nope');
  assert.equal(changed, false);
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
