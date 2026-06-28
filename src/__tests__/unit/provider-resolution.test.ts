import { test, before } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
/* eslint-disable @typescript-eslint/no-require-imports */

process.env.CLAUDE_GUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-prov-'));
const db = require('../../lib/db') as typeof import('../../lib/db');
const { resolveProvider, DEFAULT_PROVIDER_KEY } = require('../../lib/provider-resolution') as typeof import('../../lib/provider-resolution');

let activeId = '';
let inactiveId = '';
before(() => {
  const active = db.createProvider({ name: 'Active', base_url: 'https://a', api_key: 'k-a' });
  db.activateProvider(active.id);
  activeId = active.id;
  inactiveId = db.createProvider({ name: 'Inactive', base_url: 'https://b', api_key: 'k-b' }).id;
});

test('explicit id wins over the active provider', () => {
  const r = resolveProvider(inactiveId);
  assert.strictEqual(r.provider?.id, inactiveId);
  assert.strictEqual(r.key, inactiveId);
});

test('no explicit id falls back to the active provider', () => {
  const r = resolveProvider(undefined);
  assert.strictEqual(r.provider?.id, activeId);
  assert.strictEqual(r.key, activeId);
});

test('unknown id yields null provider + default key', () => {
  const r = resolveProvider('does-not-exist');
  assert.strictEqual(r.provider, null);
  assert.strictEqual(r.key, DEFAULT_PROVIDER_KEY);
});
