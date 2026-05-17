import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { transcriptEntriesToEvents } = require('../../lib/channels/transcript-tailer') as typeof import('../../lib/channels/transcript-tailer');

test('assistant text entry becomes a text SSEEvent', () => {
  const entry = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
  assert.deepEqual(transcriptEntriesToEvents([entry]), [{ type: 'text', data: 'hello' }]);
});

test('assistant tool_use entry becomes a tool_use SSEEvent', () => {
  const entry = { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
  ] } };
  const events = transcriptEntriesToEvents([entry]);
  assert.equal(events[0].type, 'tool_use');
  assert.match(events[0].data, /Bash/);
});

test('thinking block becomes a thinking SSEEvent', () => {
  const entry = { type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'hmm' },
  ] } };
  assert.deepEqual(transcriptEntriesToEvents([entry]), [{ type: 'thinking', data: 'hmm' }]);
});

test('user-role entries are ignored (they are CodePilot-side echoes)', () => {
  const entry = { type: 'user', message: { content: [{ type: 'text', text: 'x' }] } };
  assert.deepEqual(transcriptEntriesToEvents([entry]), []);
});
