import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { publishChannelEvent, subscribeChannelEvents } = require('../../lib/channels/event-bus') as typeof import('../../lib/channels/event-bus');

test('subscriber receives published events for its session only', () => {
  const got: unknown[] = [];
  const unsub = subscribeChannelEvents('s1', (e) => got.push(e));
  publishChannelEvent('s1', { kind: 'reply', chatId: '1', text: 'hi' });
  publishChannelEvent('s2', { kind: 'reply', chatId: '1', text: 'other' });
  unsub();
  publishChannelEvent('s1', { kind: 'reply', chatId: '2', text: 'late' });
  assert.deepEqual(got, [{ kind: 'reply', chatId: '1', text: 'hi' }]);
});
