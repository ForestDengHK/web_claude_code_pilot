import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';

/* eslint-disable @typescript-eslint/no-require-imports */
const { transcriptEntriesToEvents, transcriptPath } = require('../../lib/channels/transcript-tailer') as typeof import('../../lib/channels/transcript-tailer');

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

test('user-entry text blocks are ignored (CodePilot-side prompt echoes)', () => {
  const entry = { type: 'user', message: { content: [{ type: 'text', text: 'x' }] } };
  assert.deepEqual(transcriptEntriesToEvents([entry]), []);
});

test('user-entry tool_result block becomes a tool_result SSEEvent', () => {
  const entry = { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'done' },
  ] } };
  const events = transcriptEntriesToEvents([entry]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_result');
  assert.match(events[0].data, /t1/);
});

test('transcriptPath builds ~/.claude/projects/<encoded>/<id>.jsonl', () => {
  const result = transcriptPath('/root/clawd', 'sess-1');
  const expected = path.join(
    os.homedir(), '.claude', 'projects', '-root-clawd', 'sess-1.jsonl',
  );
  assert.equal(result, expected);
});
