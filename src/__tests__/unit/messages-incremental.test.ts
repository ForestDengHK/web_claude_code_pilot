/**
 * Unit tests for incremental message fetching (getMessages `afterRowId`).
 *
 * Run with: npx tsx --test src/__tests__/unit/messages-incremental.test.ts
 *
 * Recovery polling must NOT re-read the full conversation (which can be several
 * MB of content) on every poll — synchronous better-sqlite3 reads of that size
 * block the Node event loop for tens of seconds and wedge the live stream.
 * `afterRowId` lets recovery fetch only messages newer than what the client
 * already has.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-messages-incremental-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

/* eslint-disable @typescript-eslint/no-require-imports */
const { getDb, closeDb, createSession, addMessage, getMessages } =
  require('../../lib/db') as typeof import('../../lib/db');

test('afterRowId returns only messages newer than the cursor, in chronological order', () => {
  getDb();
  const s = createSession('inc', '', '', tmpDir, 'acceptEdits', 'claude');
  addMessage(s.id, 'user', 'first');
  addMessage(s.id, 'assistant', 'reply-1');
  addMessage(s.id, 'user', 'second');

  const all = getMessages(s.id).messages;
  assert.equal(all.length, 3);

  // Cursor at the 2nd message → only the 3rd ("second") should come back.
  const cursor = all[1]._rowid;
  assert.ok(typeof cursor === 'number');

  const incremental = getMessages(s.id, { afterRowId: cursor }).messages;
  assert.equal(incremental.length, 1);
  assert.equal(incremental[0].content, 'second');
  assert.equal(incremental[0].role, 'user');
});

test('afterRowId at the latest rowid returns an empty list', () => {
  const s = createSession('inc2', '', '', tmpDir, 'acceptEdits', 'claude');
  addMessage(s.id, 'user', 'only');
  const all = getMessages(s.id).messages;
  const latest = all[all.length - 1]._rowid as number;

  const incremental = getMessages(s.id, { afterRowId: latest }).messages;
  assert.equal(incremental.length, 0);
});

test('afterRowId scopes to the session (does not leak other sessions)', () => {
  const a = createSession('inc3a', '', '', tmpDir, 'acceptEdits', 'claude');
  const b = createSession('inc3b', '', '', tmpDir, 'acceptEdits', 'claude');
  addMessage(a.id, 'user', 'a-old');
  const aCursor = getMessages(a.id).messages[0]._rowid as number;
  // Interleave a newer message in a *different* session.
  addMessage(b.id, 'user', 'b-new');
  addMessage(a.id, 'assistant', 'a-new');

  const incremental = getMessages(a.id, { afterRowId: aCursor }).messages;
  assert.equal(incremental.length, 1);
  assert.equal(incremental[0].content, 'a-new');
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
