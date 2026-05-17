import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-switch-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

// Use require to avoid top-level await issues with CJS output (matches channels-db.test.ts style)
/* eslint-disable @typescript-eslint/no-require-imports */
const { getDb, createSession, getSession } = require('../../lib/db') as typeof import('../../lib/db');
const { applyTierSwitch } = require('../../lib/channels/switch-tier') as typeof import('../../lib/channels/switch-tier');

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
