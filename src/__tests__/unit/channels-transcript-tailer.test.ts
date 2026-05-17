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

test('assistant entry with usage emits a result SSEEvent carrying token totals', () => {
  const entry = {
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 5, output_tokens: 12, cache_read_input_tokens: 100 },
    },
  };
  const events = transcriptEntriesToEvents([entry]);
  const result = events.find((e) => e.type === 'result');
  assert.ok(result, 'expected a result event');
  const usage = JSON.parse(result.data).usage;
  assert.equal(usage.output_tokens, 12);
  assert.equal(usage.input_tokens, 5);
  assert.equal(usage.model, 'claude-sonnet-4-6');
});

test('assistant entry with rate-limit error emits a rate_limit SSEEvent', () => {
  const entry = { type: 'assistant', error: 'rate_limit', message: { content: [] } };
  const events = transcriptEntriesToEvents([entry]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'rate_limit');
});

test('assistant entry with terminal stop_reason end_turn emits turn_complete', () => {
  // The channel protocol has no turn-end signal and the model does not
  // reliably call the reply tool after agentic turns — it just ends the turn.
  // A terminal stop_reason in the transcript is the only reliable signal.
  const entry = { type: 'assistant', message: {
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(events.some((e) => e.type === 'turn_complete'),
    'expected a turn_complete event');
});

test('assistant entry with stop_reason stop_sequence emits turn_complete', () => {
  const entry = { type: 'assistant', message: {
    stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'done' }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(events.some((e) => e.type === 'turn_complete'));
});

test('assistant entry with stop_reason tool_use does NOT emit turn_complete', () => {
  // tool_use means the turn continues (model paused to call a tool).
  const entry = { type: 'assistant', message: {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(!events.some((e) => e.type === 'turn_complete'),
    'tool_use is not a turn end');
});

test('assistant entry with no stop_reason does NOT emit turn_complete', () => {
  const entry = { type: 'assistant', message: {
    content: [{ type: 'text', text: 'partial' }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(!events.some((e) => e.type === 'turn_complete'));
});
