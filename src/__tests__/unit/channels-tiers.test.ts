import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { nextTier, tierLabel, isExhaustionEvent } = require('../../lib/channels/tiers') as typeof import('../../lib/channels/tiers');

test('nextTier walks channels -> claude -> codex -> null', () => {
  assert.equal(nextTier('channels'), 'claude');
  assert.equal(nextTier('claude'), 'codex');
  assert.equal(nextTier('codex'), null);
});

test('tierLabel is human readable', () => {
  assert.equal(tierLabel('channels'), 'Tier 1 · Channels (subscription)');
  assert.equal(tierLabel('claude'), 'Tier 2 · Agent SDK (credit)');
  assert.equal(tierLabel('codex'), 'Tier 3 · Codex');
});

test('isExhaustionEvent detects a rate_limit SSEEvent', () => {
  assert.equal(isExhaustionEvent({ type: 'rate_limit', data: '{}' }), true);
  assert.equal(isExhaustionEvent({ type: 'text', data: 'hi' }), false);
});
