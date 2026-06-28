// src/__tests__/unit/session-provider-lanes.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
/* eslint-disable @typescript-eslint/no-require-imports */
process.env.CLAUDE_GUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lane-'));
const db = require('../../lib/db') as typeof import('../../lib/db');

test('upsert + read a provider lane session id', () => {
  db.setProviderLaneSessionId('sess1', 'provA', 'uuid-A1');
  assert.strictEqual(db.getProviderLane('sess1', 'provA')?.claude_session_id, 'uuid-A1');
  db.setProviderLaneSessionId('sess1', 'provA', 'uuid-A2'); // upsert overwrites
  assert.strictEqual(db.getProviderLane('sess1', 'provA')?.claude_session_id, 'uuid-A2');
});

test('lanes are isolated per provider within a session', () => {
  db.setProviderLaneSessionId('sess1', 'provB', 'uuid-B1');
  assert.strictEqual(db.getProviderLane('sess1', 'provA')?.claude_session_id, 'uuid-A2');
  assert.strictEqual(db.getProviderLane('sess1', 'provB')?.claude_session_id, 'uuid-B1');
});

test('bridged msg id is tracked per lane; missing lane reads undefined', () => {
  db.setProviderLaneBridgedMsgId('sess1', 'provA', 'msg-42');
  assert.strictEqual(db.getProviderLane('sess1', 'provA')?.last_bridged_msg_id, 'msg-42');
  assert.strictEqual(db.getProviderLane('sess1', 'nope'), undefined);
});
