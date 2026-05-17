import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { formatVerdict } = require('../../lib/channels/verdict') as typeof import('../../lib/channels/verdict');

test('formatVerdict builds the channel verdict wire string', () => {
  assert.equal(formatVerdict('abcde', true), 'allow:abcde');
  assert.equal(formatVerdict('xyzkm', false), 'deny:xyzkm');
});
