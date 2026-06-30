import { test, before } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
/* eslint-disable @typescript-eslint/no-require-imports */

process.env.CLAUDE_GUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-prov-models-'));
const db = require('../../lib/db') as typeof import('../../lib/db');

let createdId = '';
before(() => {
  const p = db.createProvider({
    name: 'WithModels',
    base_url: 'https://gw',
    api_key: 'k',
    models: JSON.stringify(['openai/gpt-5', 'qwen3.6-plus']),
  });
  createdId = p.id;
});

test('createProvider persists models JSON and getProvider returns it', () => {
  const p = db.getProvider(createdId)!;
  assert.deepStrictEqual(JSON.parse(p.models), ['openai/gpt-5', 'qwen3.6-plus']);
});

test('createProvider defaults models to empty array when omitted', () => {
  const p = db.createProvider({ name: 'NoModels', base_url: 'https://x', api_key: 'k2' });
  assert.strictEqual(db.getProvider(p.id)!.models, '[]');
});

test('updateProvider changes models and preserves other fields', () => {
  const updated = db.updateProvider(createdId, { models: JSON.stringify(['deepseek-chat']) })!;
  assert.deepStrictEqual(JSON.parse(updated.models), ['deepseek-chat']);
  assert.strictEqual(updated.name, 'WithModels'); // unrelated field untouched
});

test('updateProvider leaves models unchanged when not supplied', () => {
  const before = db.getProvider(createdId)!.models;
  const updated = db.updateProvider(createdId, { notes: 'touched' })!;
  assert.strictEqual(updated.models, before);
});
