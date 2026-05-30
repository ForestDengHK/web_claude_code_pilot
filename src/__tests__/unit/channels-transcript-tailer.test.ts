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

// Turn-end is NOT inferred from the transcript. In T1 every assistant entry —
// including tool_use ones — carries stop_reason='end_turn', so no single entry
// can signal the turn ended. streamChannels decides turn-end from the reply
// event + PTY quiet instead. The tailer must therefore NEVER emit turn_complete,
// regardless of stop_reason, so it can't prematurely close an agentic turn.
test('end_turn text entry does NOT emit turn_complete (T1 stop_reason is unreliable)', () => {
  const entry = { type: 'assistant', message: {
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(events.some((e) => e.type === 'text'), 'text is still surfaced');
  assert.ok(!events.some((e) => e.type === 'turn_complete'),
    'tailer must not infer turn-end');
});

test('end_turn tool_use entry does NOT emit turn_complete (the bug: T1 stamps tool_use as end_turn)', () => {
  // This is the exact entry shape that caused the truncation bug: a tool_use
  // block written with stop_reason='end_turn'. The tailer must surface the
  // tool_use for display but must NOT treat it as a turn end.
  const entry = { type: 'assistant', message: {
    stop_reason: 'end_turn',
    content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: {} }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(events.some((e) => e.type === 'tool_use'), 'tool_use is still surfaced');
  assert.ok(!events.some((e) => e.type === 'turn_complete'),
    'a tool_use entry is never a turn end, even with stop_reason=end_turn');
});

test('thinking-only end_turn entry does NOT emit turn_complete', () => {
  const entry = { type: 'assistant', message: {
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: 'reasoning…' }],
  } };
  const events = transcriptEntriesToEvents([entry]);
  assert.ok(!events.some((e) => e.type === 'turn_complete'));
});

test('synthetic assistant entry (model "<synthetic>") emits no events', () => {
  // `claude --resume` injects this when it classifies the prior turn as
  // interrupted. Without filtering, its synthetic "No response requested."
  // text would be surfaced as the turn's response.
  const entry = { type: 'assistant', message: {
    model: '<synthetic>',
    stop_reason: 'stop_sequence',
    content: [{ type: 'text', text: 'No response requested.' }],
    usage: { input_tokens: 0, output_tokens: 0 },
  } };
  assert.deepEqual(transcriptEntriesToEvents([entry]), []);
});

test('isMeta user entry ("Continue from where you left off.") emits no events', () => {
  // The other half of the synthetic recovery pair the SDK writes on resume.
  const entry = {
    type: 'user', isMeta: true,
    message: { content: [{ type: 'text', text: 'Continue from where you left off.' }] },
  };
  assert.deepEqual(transcriptEntriesToEvents([entry]), []);
});
