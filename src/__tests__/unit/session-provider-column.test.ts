import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
/* eslint-disable @typescript-eslint/no-require-imports */
process.env.CLAUDE_GUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-spc-'));
const db = require('../../lib/db') as typeof import('../../lib/db');

test('setSessionProvider persists and getSession reads it back', () => {
  // createSession(title?, model?, systemPrompt?, workingDirectory?, mode?, backend?)
  const s = db.createSession('t', 'opus', undefined, '/tmp');
  db.setSessionProvider(s.id, 'prov-xyz');
  assert.strictEqual(db.getSession(s.id)?.provider_id, 'prov-xyz');
});
