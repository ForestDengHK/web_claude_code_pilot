// src/__tests__/unit/provider-bridge.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
/* eslint-disable @typescript-eslint/no-require-imports */
process.env.CLAUDE_GUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-pbridge-'));
const db = require('../../lib/db') as typeof import('../../lib/db');
const { buildProviderBridge } = require('../../lib/context-bridge') as typeof import('../../lib/context-bridge');

let sid = '';
before(() => {
  // createSession is POSITIONAL: (title?, model?, systemPrompt?, workingDirectory?, ...); workingDirectory is required.
  const s = db.createSession('t', 'opus', undefined, '/tmp');
  sid = s.id;
  // addMessage(sessionId, role, content, tokenUsage?, backend?) — returns a Message with an `id`.
  db.addMessage(sid, 'user', 'Refactor /app/server.ts please');
  db.addMessage(sid, 'assistant', 'Done, updated /app/server.ts');
});

test('first touch of a provider lane bridges the whole conversation', () => {
  const bridge = buildProviderBridge(sid, 'provNEW');
  assert.match(bridge, /previous conversation|context/i);
  assert.match(bridge, /server\.ts/);
});

test('second call with no new messages returns empty (cursor advanced)', () => {
  assert.strictEqual(buildProviderBridge(sid, 'provNEW'), '');
});
