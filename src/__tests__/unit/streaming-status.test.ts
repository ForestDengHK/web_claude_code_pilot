import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { formatToolInput } = require('../../lib/streaming-status') as typeof import('../../lib/streaming-status');

test('formatToolInput returns the command when present', () => {
  assert.equal(formatToolInput({ command: 'ls -la' }), 'ls -la');
});

test('formatToolInput returns file_path when present', () => {
  assert.equal(formatToolInput({ file_path: '/tmp/x' }), '/tmp/x');
});

test('formatToolInput JSON-stringifies a plain object with no known keys', () => {
  assert.match(formatToolInput({ foo: 'bar' }), /foo/);
});

test('formatToolInput does not throw on undefined input', () => {
  // The Channels permission_request event omitted toolInput entirely, which
  // crashed StreamingMessage with "Cannot read properties of undefined".
  assert.doesNotThrow(() => formatToolInput(undefined));
  assert.equal(formatToolInput(undefined), '');
});

test('formatToolInput does not throw on null input', () => {
  assert.doesNotThrow(() => formatToolInput(null));
  assert.equal(formatToolInput(null), '');
});
