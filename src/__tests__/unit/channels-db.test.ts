import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-channels-db-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

// Use require to avoid top-level await issues with CJS output
/* eslint-disable @typescript-eslint/no-require-imports */
const { getDb, createSession, getSession, updateChannelSessionId } = require('../../lib/db') as typeof import('../../lib/db');

test('updateChannelSessionId persists and is readable', () => {
  getDb();
  // createSession takes positional args: title, model, systemPrompt, workingDirectory, mode, backend
  const s = createSession('ch', '', '', tmpDir, 'acceptEdits', 'channels' as 'claude');
  updateChannelSessionId(s.id, 'claude-uuid-1234');
  const reread = getSession(s.id);
  assert.equal(reread?.channel_session_id, 'claude-uuid-1234');
});

test('backend column accepts the string "channels"', () => {
  const s = createSession('ch2', '', '', tmpDir, 'acceptEdits', 'channels' as 'claude');
  assert.equal(getSession(s.id)?.backend, 'channels');
});
