import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-switch-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

// Use require to avoid top-level await issues with CJS output (matches channels-db.test.ts style)
/* eslint-disable @typescript-eslint/no-require-imports */
const { getDb, createSession, getSession, addMessage } = require('../../lib/db') as typeof import('../../lib/db');
const { applyTierSwitch, discardExhaustedTurn } = require('../../lib/channels/switch-tier') as typeof import('../../lib/channels/switch-tier');

test('applyTierSwitch moves channels -> claude', () => {
  getDb();
  const s = createSession('t', undefined, undefined, tmpDir, undefined, 'channels');
  const result = applyTierSwitch(s.id, 'channels');
  assert.equal(result.newTier, 'claude');
  assert.equal(getSession(s.id)?.backend, 'claude');
});

test('applyTierSwitch from codex throws (no further tier)', () => {
  const s = createSession('t2', undefined, undefined, tmpDir, undefined, 'codex');
  assert.throws(() => applyTierSwitch(s.id, 'codex'), /no further tier/i);
});

test('discardExhaustedTurn drops the trailing user message and everything after it', () => {
  const s = createSession('t3', undefined, undefined, tmpDir, undefined, 'channels');
  addMessage(s.id, 'user', 'q1', null, 'channels');
  addMessage(s.id, 'assistant', 'a1', null, 'channels');
  addMessage(s.id, 'user', 'q2', null, 'channels');
  addMessage(s.id, 'assistant', 'a2-dead', null, 'channels');
  discardExhaustedTurn(s.id);
  const rows = getDb()
    .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid')
    .all(s.id) as Array<{ role: string; content: string }>;
  assert.deepEqual(rows, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
  ]);
});

test('discardExhaustedTurn is a no-op when there are no messages', () => {
  const s = createSession('t4', undefined, undefined, tmpDir, undefined, 'channels');
  assert.doesNotThrow(() => discardExhaustedTurn(s.id));
});
