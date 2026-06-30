import { test, before } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
/* eslint-disable @typescript-eslint/no-require-imports */

process.env.CLAUDE_GUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-prov-enabled-'));
const db = require('../../lib/db') as typeof import('../../lib/db');

let id = '';
before(() => {
  const p = db.createProvider({ name: 'Toggle', base_url: 'https://gw', api_key: 'k' });
  id = p.id;
});

test('new providers default to enabled (1) so they show in the model menu', () => {
  assert.strictEqual(db.getProvider(id)!.enabled, 1);
});

test('updateProvider can disable a provider and preserves other fields', () => {
  const updated = db.updateProvider(id, { enabled: 0 })!;
  assert.strictEqual(updated.enabled, 0);
  assert.strictEqual(updated.name, 'Toggle'); // unrelated field untouched
});

test('updateProvider can re-enable a provider', () => {
  const updated = db.updateProvider(id, { enabled: 1 })!;
  assert.strictEqual(updated.enabled, 1);
});

test('updateProvider leaves enabled unchanged when not supplied', () => {
  db.updateProvider(id, { enabled: 0 });
  const updated = db.updateProvider(id, { notes: 'touched' })!;
  assert.strictEqual(updated.enabled, 0);
});
